import { CONFIG } from "./config.ts";
import { runAgent, type ChatTurn } from "./ai.ts";
import { authorityBoost, computeAuthority, isCuratedRoot } from "./authority.ts";
import { buildOverview } from "./overview.ts";
import { deepSearch } from "./deepsearch.ts";
import { verticalBoost, type Vertical } from "./media.ts";
import { countryBoost, getClientIp, languageBoost, languagesForCountry, lookupCountry } from "./geo.ts";
import { FAMOUS_SITES } from "./famous.ts";
import { rejectDoc } from "./quality.ts";
import { hasApiKey, keySource } from "./provider.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

export const INDEX_PATH = CONFIG.server.indexPath;

export async function loadIndex(): Promise<InvertedIndex> {
  return InvertedIndex.loadFromFile(INDEX_PATH);
}

export async function saveIndex(idx: InvertedIndex): Promise<void> {
  await idx.saveToFile(INDEX_PATH);
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function staticResponse(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..") || rel.includes("\0")) return null;
  const dot = rel.lastIndexOf(".");
  const type = dot === -1 ? null : STATIC_TYPES[rel.slice(dot).toLowerCase()];
  if (!type) return null;
  const f = Bun.file("public" + rel);
  if (!(await f.exists())) return null;
  return new Response(f, { headers: { "content-type": type, "cache-control": "no-cache" } });
}

function corsHeaders(): Record<string, string> {
  if (!CONFIG.server.cors) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

interface SearchOptions {
  query: string;
  limit: number;
  countryCode: string;
  /** Restrict results to one registrable-ish domain, e.g. "bbc.com". */
  domain?: string;
  /** Run multi-pass expansion; ?deep=0 forces a single BM25 pass. */
  deep?: boolean;
  /** Vertical filter: text | image | video | short. */
  vertical?: Vertical | null;
}

/** Multi-pass deep search, then the country/authority re-ranking and the
 *  quality gate. Deep search is the retrieval half of a DeepSearcher-style
 *  loop; the reflection half would be the agent, which is optional. */
function runSearch(idx: InvertedIndex, opts: SearchOptions) {
  const oversample = Math.min(Math.max(opts.limit * 6, 60), 400);
  const authority = computeAuthority(idx);
  const deep = deepSearch(idx, opts.query, { limit: oversample, deep: opts.deep });
  const seen = new Set<string>();
  const wanted = opts.vertical ?? null;
  const scored = deep.hits
    .filter((h) => {
      const doc = idx.docs.get(h.id);
      if (!doc) return false;
      if (seen.has(doc.url)) return false;
      const bad = rejectDoc(doc);
      if (bad.junk || bad.language || bad.lowQuality) return false;
      seen.add(doc.url);
      return true;
    })
    .map((h) => {
      const doc = idx.docs.get(h.id)!;
      const host = domainOf(h.url);
      const media = doc.media ?? { type: "text" as const };
      const geo = countryBoost(h.url, opts.countryCode) * languageBoost(h.lang, opts.countryCode);
      // Popularity: link-graph authority, with a floor for allowlisted roots so
      // github.com always outranks github.blog.
      const pageAuthority = authority.score.get(host) ?? 0;
      const rank = Math.max(pageAuthority, isCuratedRoot(host, FAMOUS_HOST_SET) ? CONFIG.authority.curatedFloor : 0);
      const pop = 1 + CONFIG.authority.weight * Math.sqrt(rank);
      // Vertical: promote the requested kind, demote the rest rather than hide.
      const vboost = verticalBoost(media.type, wanted);
      return {
        ...h,
        domain: host,
        media,
        score: round(h.score * geo * pop * vboost),
        authority: round(rank),
      };
    })
    .filter((h) => (wanted && wanted !== "text" ? h.media.type === wanted : true))
    .sort((a, b) => b.score - a.score);

  const counts = new Map<string, number>();
  for (const h of scored) counts.set(h.domain, (counts.get(h.domain) ?? 0) + 1);
  const facets = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 10)
    .map(([domain, count]) => ({ domain, count }));

  const filtered = opts.domain ? scored.filter((h) => h.domain === opts.domain || h.domain.endsWith(`.${opts.domain}`)) : scored;

  return {
    hits: filtered.slice(0, opts.limit).map(({ domain: _domain, authority: _a, ...h }) => h),
    vertical: wanted,
    facets,
    total: filtered.length,
    deep: {
      passes: deep.passes.map((p) => ({ label: p.label, query: p.query, results: p.results })),
      expandedTerms: deep.expandedTerms,
      subQueries: deep.subQueries,
    },
  };
}

/** "youtube" reads as a site, not a topic. If that site was never crawled we
 *  say so instead of quietly returning pages that merely mention it. */
function siteLookupNote(idx: InvertedIndex, query: string): string | null {
  const q = query.toLowerCase().trim();
  if (!q || /\s/.test(q)) return null;
  if (/^(the|a|an|how|what|why|when|who|best|free|news|weather)$/.test(q)) return null;
  if (idx.hasHost(q)) return null;
  return `${q}.com is not in this crawl — the results below are pages that mention "${q}". Add it to the seed list (src/config.ts) to index the site itself.`;
}

/** Allowlisted root domains, used for the authority floor. */
const FAMOUS_HOST_SET = new Set<string>(
  FAMOUS_SITES.map((s) => {
    try {
      return new URL(s.url).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }).filter(Boolean),
);

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return CONFIG.ui.defaultLimit;
  return Math.min(Math.max(n, 1), CONFIG.ui.maxLimit);
}

export function startServer(idx: InvertedIndex, port: number = CONFIG.server.port) {
  return Bun.serve({
    port,
    hostname: CONFIG.server.host,
    idleTimeout: CONFIG.server.idleTimeoutSeconds,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = corsHeaders();

      if (req.method === "OPTIONS") return new Response(null, { headers: cors });

      // ---- API: search ----
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseLimit(url.searchParams.get("limit"));
        const domain = (url.searchParams.get("domain") ?? "").trim().toLowerCase() || undefined;
        const override = (url.searchParams.get("country") ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override, fromCache: false }
          : await lookupCountry(getClientIp(req));
        const t0 = Date.now();
const deepParam = url.searchParams.get("deep");
        const vParam = (url.searchParams.get("type") ?? url.searchParams.get("vertical") ?? "").toLowerCase();
        const vertical = (["text", "image", "video", "short"] as const).find((v) => v === vParam) ?? null;
        const { hits, facets, total, deep } = runSearch(idx, {
          query: q,
          limit,
          countryCode: geo.countryCode,
          domain,
          deep: deepParam === null ? undefined : deepParam !== "0",
          vertical,
        });
        return Response.json(
          {
            query: q,
            count: hits.length,
            total,
            tookMs: Date.now() - t0,
            hits,
            facets,
            domain: domain ?? null,
            country: geo.country,
            countryCode: geo.countryCode,
            countryLanguages: languagesForCountry(geo.countryCode),
            deep,
            note: domain ? null : siteLookupNote(idx, q),
          },
          { headers: cors },
        );
      }

      // ---- API: AI overview (answer above the results) ----
      if (url.pathname === "/api/overview") {
        const q = (url.searchParams.get("q") ?? "").trim();
        if (!q) return Response.json({ error: "q required" }, { status: 400, headers: cors });
        const override = (url.searchParams.get("country") ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override }
          : await lookupCountry(getClientIp(req));
        const t0 = Date.now();
        const overview = await buildOverview({ query: q, index: idx, countryCode: geo.countryCode });
        return Response.json({ query: q, tookMs: Date.now() - t0, ...overview }, { headers: cors });
      }

      // ---- API: where the visitor appears to be ----
      if (url.pathname === "/api/geo") {
        const ip = getClientIp(req);
        const geo = await lookupCountry(ip);
        return Response.json(
          {
            ip,
            country: geo.country,
            countryCode: geo.countryCode,
            languages: languagesForCountry(geo.countryCode),
            cached: geo.fromCache,
          },
          { headers: cors },
        );
      }

      // ---- API: index stats ----
      if (url.pathname === "/api/stats") {
        return Response.json(
          {
            ...idx.stats(),
            name: CONFIG.name,
            version: CONFIG.version,
            indexPath: INDEX_PATH,
            ai: {
              // Deliberately opaque: the UI never advertises the model or vendor.
              ready: hasApiKey(),
              keySource: keySource(),
              tools: ["search_index", "read_page", "index_stats"],
            },
          },
          { headers: cors },
        );
      }

      // ---- API: MiniSearch AI agent (SSE) ----
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          message?: string;
          history?: ChatTurn[];
          country?: string;
        };
        const message = (body.message ?? "").trim();
        if (!message) return Response.json({ error: "message required" }, { status: 400, headers: cors });

        const override = (body.country ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override }
          : await lookupCountry(getClientIp(req));

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            let answered = false;
            const send = (e: any) => {
              if (e?.type === "answer") answered = true;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            };
            // SSE comment heartbeat: keeps proxies and idle timers from cutting
            // the stream while the model is thinking.
            const beat = setInterval(() => controller.enqueue(enc.encode(": hb\n\n")), CONFIG.server.sseHeartbeatMs);
            try {
              const answer = await runAgent({
                message,
                history: Array.isArray(body.history) ? body.history.slice(-8) : [],
                index: idx,
                country: geo.country,
                countryCode: geo.countryCode,
                onEvent: send,
              });
              if (answer && !answered) send({ type: "answer", text: answer });
            } catch (err) {
              send({ type: "error", message: err instanceof Error ? err.message : String(err) });
            } finally {
              clearInterval(beat);
              send({ type: "done" });
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...cors,
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      }

      // ---- static UI ----
      const page = await staticResponse(url.pathname);
      if (page) return page;
      return new Response("Not found", { status: 404, headers: cors });
    },
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}