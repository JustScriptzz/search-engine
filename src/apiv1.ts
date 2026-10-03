// Public JSON API, versioned under /api/v1.
//
// This is a deliberately small, stable surface: search, the AI overview and
// index stats. Everything else (the AI agent chat, crawl diagnostics) stays on
// the internal /api/* routes, because those either spend model quota per caller
// or expose how the crawler is doing.
//
//   GET /api/v1                machine-readable index of this API
//   GET /api/v1/search?q=…     ranked results
//   GET /api/v1/overview?q=…   AI-written answer with citations
//   GET /api/v1/stats          index size and health
//
// Rate limited per IP with a fixed window; see CONFIG.api.
import { CONFIG } from "./config.ts";
import { buildOverview } from "./overview.ts";
import { countryBoost, languageBoost } from "./geo.ts";
import { isTrustedHost } from "./famous.ts";
import { rejectDoc } from "./quality.ts";
import { verticalBoost, type Vertical } from "./media.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";
import { deepSearch } from "./deepsearch.ts";
import { computeAuthority, isCuratedRoot } from "./authority.ts";
import { domainOf, round } from "./util.ts";
import { facetCounts } from "./facets.ts";

export interface V1Deps {
  index: InvertedIndex;
  curatedHosts: Set<string>;
  clientIp: string;
  countryCode: string;
  indexAgeHours: () => number | null;
  build: () => Promise<string | null>;
}

const VERTICALS: Vertical[] = ["text", "image", "video", "short"];

interface Bucket {
  count: number;
  resetAt: number;
}

/** Fixed-window limiter. A window is cheap to reason about and needs no timers;
 *  entries expire on their own so the map cannot grow without bound on a small
 *  box. */
const buckets = new Map<string, Bucket>();

export interface RateResult {
  ok: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
  retryAfter: number;
}

export function rateLimit(key: string, limit: number, windowMs = 60_000, now = Date.now()): RateResult {
  // Opportunistic sweep: nobody's window survives long, and this is only paid
  // when someone is actually calling.
  if (buckets.size > 5000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
  }
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count++;
  return {
    ok: b.count <= limit,
    limit,
    remaining: Math.max(0, limit - b.count),
    resetAt: b.resetAt,
    retryAfter: Math.max(1, Math.ceil((b.resetAt - now) / 1000)),
  };
}

/** Test seam: forget all counters. */
export function resetRateLimits(): void {
  buckets.clear();
}

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  // Lets a browser page read the limit headers it is subject to.
  "access-control-expose-headers": "x-ratelimit-limit, x-ratelimit-remaining, x-ratelimit-reset, retry-after",
};

export function v1Headers(rate: RateResult): Record<string, string> {
  return {
    ...CORS,
    "x-ratelimit-limit": String(rate.limit),
    "x-ratelimit-remaining": String(rate.remaining),
    "x-ratelimit-reset": String(Math.ceil(rate.resetAt / 1000)),
  };
}

export function json(body: unknown, headers: Record<string, string>, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

function fail(message: string, headers: Record<string, string>, status = 400, hint?: string): Response {
  return json({ error: message, ...(hint ? { hint } : {}) }, headers, status);
}

/** Path after /api/v1, e.g. "search". */
export function v1Path(pathname: string): string {
  return pathname.replace(/^\/api\/v1\/?/, "").replace(/\/+$/, "");
}

export function isV1(pathname: string): boolean {
  return pathname === "/api/v1" || pathname.startsWith("/api/v1/");
}

/**
 * Handle a /api/v1 request. Only call this when isV1(pathname) is true: every
 * path under /api/v1 answers with something, including unknown ones.
 */
export async function handleV1(pathname: string, url: URL, deps: V1Deps): Promise<Response> {
  const route = v1Path(pathname);
  const rate = rateLimit(deps.clientIp, CONFIG.api.rateLimitPerMinute);
  const headers = v1Headers(rate);

  if (url.pathname !== "/api/v1" && url.pathname !== "/api/v1/") {
    // Preflight and HEAD still need to be cheap, but they should not consume
    // the caller's quota.
    headers["allow"] = "GET, OPTIONS";
  }
  if (!rate.ok) {
    return json({ error: "rate limit exceeded", retryAfterSeconds: rate.retryAfter }, { ...headers, "retry-after": String(rate.retryAfter) }, 429);
  }

  switch (route) {
    case "":
      return json(apiIndex(await deps.build()), headers);
    case "search":
      return search(url, deps, headers);
    case "overview":
      return overview(url, deps, headers);
    case "stats":
      return stats(deps, headers);
    default:
      return fail(`unknown endpoint: /api/v1/${route}`, headers, 404, "see GET /api/v1 for the available endpoints");
  }
}

/** GET /api/v1 — the API describes itself. */
function apiIndex(build: string | null) {
  return {
    name: CONFIG.name,
    version: CONFIG.version,
    build,
    description: "MiniSearch public search API. Ranked web results built from our own crawl.",
    rateLimit: { requests: CONFIG.api.rateLimitPerMinute, windowSeconds: 60, scope: "per IP" },
    endpoints: [
      {
        path: "/api/v1/search",
        method: "GET",
        summary: "Ranked results for a query.",
        parameters: {
          q: { required: true, type: "string", description: "Search query." },
          limit: { required: false, type: "integer", default: 10, max: CONFIG.api.maxLimit, description: "Results per page." },
          offset: { required: false, type: "integer", default: 0, description: "Results to skip, for paging." },
          type: { required: false, type: "string", enum: VERTICALS, default: "text", description: "Restrict to a vertical." },
          domain: { required: false, type: "string", description: "Only results from this domain, e.g. bbc.com." },
          country: { required: false, type: "string", description: "Two-letter country code; boosts local results." },
          deep: { required: false, type: "boolean", default: true, description: "Multi-pass retrieval. false is faster, slightly worse." },
        },
        returns: "{ query, tookMs, total, limit, offset, nextOffset, results: [...], facets: [...] }",
      },
      {
        path: "/api/v1/overview",
        method: "GET",
        summary: "Short AI-written answer with citations, above the organic results.",
        parameters: {
          q: { required: true, type: "string" },
          country: { required: false, type: "string" },
        },
        returns: "{ query, answer, mode, sources: [{ title, url }] }",
      },
      {
        path: "/api/v1/stats",
        method: "GET",
        summary: "Index size and health.",
        returns: "{ docs, terms, verticals, hosts, version, build, indexAgeHours }",
      },
    ],
    example: "/api/v1/search?q=how+does+github+work&limit=5&type=text",
  };
}

function search(url: URL, deps: V1Deps, headers: Record<string, string>): Response {
  const q = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  if (!q) return fail("missing required parameter: q", headers, 400, "try /api/v1/search?q=github");

  const limit = clampInt(url.searchParams.get("limit"), 10, 1, CONFIG.api.maxLimit);
  const offset = clampInt(url.searchParams.get("offset"), 0, 0, 10_000);
  const domain = (url.searchParams.get("domain") ?? "").toLowerCase().replace(/^www\./, "");
  const country = resolveCountry(url, deps);
  const deep = parseBool(url.searchParams.get("deep"), true);
  const vParam = (url.searchParams.get("type") ?? url.searchParams.get("vertical") ?? "text").toLowerCase();
  const vertical = (VERTICALS as string[]).includes(vParam) ? (vParam as Vertical) : "text";

  const t0 = Date.now();
  const idx = deps.index;
  const want = offset + limit;
  const oversample = Math.min(Math.max(want * 6, 60), 400);
  const authority = computeAuthority(idx);
  const deep1 = deepSearch(idx, q, { limit: oversample, deep });

  const seen = new Set<string>();
  const scored = deep1.hits
    .filter((h) => {
      const doc = idx.docs.get(h.id);
      if (!doc || seen.has(doc.url)) return false;
      const bad = rejectDoc(doc);
      if (bad.junk || bad.language || bad.lowQuality) return false;
      seen.add(doc.url);
      return true;
    })
    .map((h) => {
      const doc = idx.docs.get(h.id)!;
      const host = domainOf(h.url);
      const media = doc.media ?? { type: "text" as const };
      const geo = countryBoost(h.url, country.countryCode) * languageBoost(h.lang, country.countryCode);
      const pageAuthority = authority.score.get(host) ?? 0;
      const rank = Math.max(pageAuthority, isCuratedRoot(host, deps.curatedHosts) ? CONFIG.authority.curatedFloor : 0);
      const pop = 1 + CONFIG.authority.weight * Math.sqrt(rank);
      const trust = isTrustedHost(host) ? CONFIG.trust.curatedBoost : CONFIG.trust.discoveredPenalty;
      return {
        h,
        doc,
        domain: host,
        trust,
        media,
        score: round(h.score * geo * pop * trust * verticalBoost(media.type, vertical === "text" ? null : vertical)),
        authority: round(rank),
      };
    })
    .filter((r) => (vertical === "text" ? true : r.media.type === vertical))
    .sort((a, b) => b.score - a.score);

  const filtered = domain ? scored.filter((r) => r.domain === domain || r.domain.endsWith(`.${domain}`)) : scored;

  const page = filtered.slice(offset, offset + limit);
  return json(
    {
      query: q,
      tookMs: Date.now() - t0,
      total: filtered.length,
      limit,
      offset,
      nextOffset: offset + page.length < filtered.length ? offset + page.length : null,
      country: country.countryCode,
      vertical,
      facets: facetCounts(filtered.map((r) => ({ domain: r.domain, trust: r.trust }))),
      results: page.map((r, i) => {
        const media = r.media;
        return {
          rank: offset + i + 1,
          url: r.h.url,
          title: r.h.title,
          snippet: r.h.snippet,
          domain: r.domain,
          score: r.score,
          type: media.type,
          ...(media.image ? { thumbnail: media.image } : {}),
          ...(media.videoUrl ? { mediaUrl: media.videoUrl } : {}),
          ...(media.provider ? { provider: media.provider } : {}),
          ...(media.duration ? { durationSeconds: media.duration } : {}),
          language: r.h.lang || undefined,
          wordCount: r.h.wordCount,
        };
      }),
    },
    headers,
  );
}

async function overview(url: URL, deps: V1Deps, headers: Record<string, string>): Promise<Response> {
  const q = (url.searchParams.get("q") ?? url.searchParams.get("query") ?? "").trim();
  if (!q) return fail("missing required parameter: q", headers, 400, "try /api/v1/overview?q=what+is+bm25");
  const country = resolveCountry(url, deps);
  const t0 = Date.now();
  const built = await buildOverview({ query: q, index: deps.index, countryCode: country.countryCode });
  return json(
    {
      query: q,
      tookMs: Date.now() - t0,
      // "model" when written by the assistant, "extractive" when we fell back to
      // stitching the best snippets. Callers can tell the difference.
      mode: built.mode,
      answer: built.text,
      sources: built.sources,
    },
    headers,
  );
}

function stats(deps: V1Deps, headers: Record<string, string>): Promise<Response> {
  const idx = deps.index;
  const verticals: Record<string, number> = { text: 0, image: 0, video: 0, short: 0 };
  const hosts = new Set<string>();
  for (const doc of idx.docs.values()) {
    const type = doc.media?.type ?? "text";
    verticals[type] = (verticals[type] ?? 0) + 1;
    hosts.add(domainOf(doc.url));
  }
  return deps.build().then((build) =>
    json(
      {
        docs: idx.docCount,
        terms: idx.index.size,
        hosts: hosts.size,
        verticals,
        version: CONFIG.version,
        build,
        indexAgeHours: deps.indexAgeHours(),
      },
      headers,
    ),
  );
}

/** Visitor country from the request, falling back to whatever the deps resolved. */
function resolveCountry(url: URL, deps: V1Deps): { countryCode: string } {
  const override = (url.searchParams.get("country") ?? "").toUpperCase();
  return { countryCode: /^[A-Z]{2}$/.test(override) ? override : deps.countryCode };
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

function parseBool(raw: string | null, fallback: boolean): boolean {
  if (raw === null) return fallback;
  return !["0", "false", "no", "off"].includes(raw.toLowerCase());
}

export { clampInt, parseBool };