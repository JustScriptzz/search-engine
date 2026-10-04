import { statSync } from "node:fs";
import { domainOf, round } from "./util.ts";
import { handleV1, isV1 } from "./apiv1.ts";
import { loadTls, tlsStatus } from "./tls.ts";
import { bytesPerDoc, describeBudget, docsRemaining, footprintOf } from "./storage.ts";
import { facetCounts } from "./facets.ts";
import { memoryLimit } from "./memory.ts";
import { CONFIG } from "./config.ts";
import { runAgent, type ChatTurn } from "./ai.ts";
import { authorityBoost, computeAuthority, isCuratedRoot } from "./authority.ts";
import { buildOverview } from "./overview.ts";
import { deepSearch } from "./deepsearch.ts";
import { verticalBoost, type Vertical } from "./media.ts";
import { countryBoost, getClientIp, languageBoost, languagesForCountry, lookupCountry } from "./geo.ts";
import { FAMOUS_SITES, isTrustedHost } from "./famous.ts";
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
  /** Results to skip before slicing, for the public API's pagination. */
  offset?: number;
}

/** Multi-pass deep search, then the country/authority re-ranking and the
 *  quality gate. Deep search is the retrieval half of a DeepSearcher-style
 *  loop; the reflection half would be the agent, which is optional. */
function runSearch(idx: InvertedIndex, opts: SearchOptions) {
  // Oversample so that paging past the first page still has candidates to score.
  const want = (opts.offset ?? 0) + opts.limit;
  const oversample = Math.min(Math.max(want * 6, 60), 400);
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
      // Trust tier: a seeded/allowlisted site outranks a page that merely turned
      // up in Common Crawl. Discovered pages are demoted, not hidden.
      const trust = isTrustedHost(host) ? CONFIG.trust.curatedBoost : CONFIG.trust.discoveredPenalty;
      // Vertical: promote the requested kind, demote the rest rather than hide.
      const vboost = verticalBoost(media.type, wanted);
      return {
        ...h,
        domain: host,
        trust,
        media,
        score: round(h.score * geo * pop * trust * vboost),
        authority: round(rank),
      };
    })
    .filter((h) => (wanted && wanted !== "text" ? h.media.type === wanted : true))
    .sort((a, b) => b.score - a.score);

  // Facets use the same trust weighting as the ranking, so the chips describe
  // what the user is actually being shown.
  const facets = facetCounts(scored.map((h) => ({ domain: h.domain, trust: h.trust })));

  const filtered = opts.domain ? scored.filter((h) => h.domain === opts.domain || h.domain.endsWith(`.${opts.domain}`)) : scored;

  const start = Math.max(0, opts.offset ?? 0);
  return {
    hits: filtered.slice(start, start + opts.limit).map(({ domain: _domain, authority: _a, trust: _t, ...h }) => h),
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
/**
 * Disk budget and how much room is left. The VPS has about 1 GB, and the index
 * file is rewritten on every save, so "fill the disk" has to be arithmetic.
 */
function budget(idx: InvertedIndex) {
  let bytes = 0;
  try {
    bytes = statSync(INDEX_PATH).size;
  } catch {
    // no index file yet
  }
  const f = footprintOf(idx.docCount, idx.index.size, bytes);
  const left = docsRemaining(f);
  return {
    ...f,
    budgetMb: CONFIG.storage.indexBudgetMb,
    minFreeMb: CONFIG.storage.minFreeMb,
    bytesPerDoc: bytesPerDoc(f),
    docsRemaining: Number.isFinite(left) ? left : null,
    summary: describeBudget(f),
  };
}

/**
 * What this process is allowed to use, and what it is using.
 *
 * A container's memory limit is enforced by cgroup and invisible to
 * `os.freemem()`, which is how a fill run once sat at 100 MB of steady-state
 * usage and still got OOM-killed. Exposed over HTTP so the real ceiling can be
 * read from a browser.
 */
function memoryReport() {
  const limit = memoryLimit(CONFIG.storage.memoryLimitBytes);
  const usage = process.memoryUsage();
  const mb = (n: number) => Math.round((n / 1_048_576) * 10) / 10;
  const rssMb = mb(usage.rss);
  return {
    limitMb: mb(limit.bytes),
    source: limit.source,
    rssMb,
    heapMb: mb(usage.heapUsed),
    usedPct: Math.round((usage.rss / limit.bytes) * 100),
    // What a full-text index can hold before the guard stops a fill run.
    indexCeilingMb: Math.round(mb(limit.bytes * CONFIG.storage.memoryStopPct - usage.rss)),
  };
}

/** Reachability probe cache for /api/doctor, so the UI can ask without
 *  re-fetching 40 hosts on every poll. */
const PROBE_TTL = 10 * 60 * 1000;
const probeCache = new Map<string, { at: number; value: any }>();

/** Which commit is actually running. Deploys happen by git pull on restart, so
 *  without this you cannot tell whether a fix is live or the server is still on
 *  the code it booted with. */
let buildCommitCache: Promise<string | null> | null = null;
function buildCommit(): Promise<string | null> {
  if (!buildCommitCache) {
    buildCommitCache = (async () => {
      try {
        const head = (await Bun.file(".git/HEAD").text()).trim();
        const m = /^ref:\s*(refs\/heads\/.+)$/.exec(head);
        if (!m) return /^[0-9a-f]{7,40}$/.test(head) ? head.slice(0, 7) : null;
        const ref = m[1].trim();
        try {
          const sha = (await Bun.file(`.git/${ref}`).text()).trim();
          if (/^[0-9a-f]{7,40}$/.test(sha)) return sha.slice(0, 7);
        } catch {
          // not a loose ref
        }
        // A shallow or packed clone keeps it in packed-refs instead.
        const packed = await Bun.file(".git/packed-refs").text().catch(() => "");
        const line = packed.split("\n").find((l) => l.trim().endsWith(` ${ref}`));
        const sha = (line ?? "").trim().split(/\s+/)[0] ?? "";
        return /^[0-9a-f]{7,40}$/.test(sha) ? sha.slice(0, 7) : null;
      } catch {
        return null;
      }
    })();
  }
  return buildCommitCache;
}

/** Hours since the index file was last written. Crawl-time behaviour (media
 *  cards, seed priority) only reaches the corpus when a crawl has run, so this
 *  is the difference between "the fix is broken" and "nothing has re-crawled". */
function indexAgeHours(): number | null {
  try {
    return Math.round(((Date.now() - statSync(INDEX_PATH).mtimeMs) / 3_600_000) * 10) / 10;
  } catch {
    return null;
  }
}

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
  // HTTPS when the certificate is on disk, plain HTTP when it is not. The
  // allocated port stays the same either way — the panel hands us SERVER_PORT
  // and the certificate decides the protocol on it.
  const tls = loadTls();
  const server = Bun.serve({
    port,
    hostname: CONFIG.server.host,
    idleTimeout: CONFIG.server.idleTimeoutSeconds,
    // Present only when a certificate was found; undefined means plain HTTP.
    // Bun defaults to TLSv1.2+ with modern ciphers, so there is nothing to tune.
    tls: tls ? { cert: Bun.file(tls.certPath), key: Bun.file(tls.keyPath) } : undefined,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = corsHeaders();

      if (req.method === "OPTIONS") return new Response(null, { headers: cors });

      // ---- Public API: /api/v1/* ----
      // Open (no key) and rate limited per IP. Everything it needs comes from
      // deps, so it stays independent of the internal routes below.
      if (isV1(url.pathname)) {
        const clientIp = getClientIp(req);
        const overrideCountry = (url.searchParams.get("country") ?? "").toUpperCase();
        const countryCode =
          /^[A-Z]{2}$/.test(overrideCountry)
            ? overrideCountry
            : (await lookupCountry(clientIp)).countryCode;
        return handleV1(url.pathname, url, {
          index: idx,
          curatedHosts: FAMOUS_HOST_SET,
          clientIp,
          countryCode,
          indexAgeHours,
          build: buildCommit,
        });
      }

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
            // Which commit is live, and how old the corpus is. A ranking fix is
            // live the moment the server restarts; a crawl-time fix is not, until
            // a crawl has actually run.
            build: await buildCommit(),
            indexAgeHours: indexAgeHours(),
            crawlStaleHours: CONFIG.crawl.staleHours,
            tls: tlsStatus(),
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

      // ---- API: crawl diagnostics ----
      // Answers "why is nothing indexed?" with facts instead of guesswork: what
      // is actually in the index, and whether we can still reach the hosts we
      // are supposed to be crawling (providers often block datacenter IPs).
      if (url.pathname === "/api/doctor") {
        const verticals: Record<string, number> = { text: 0, image: 0, video: 0, short: 0 };
        const perHost = new Map<string, number>();
        for (const doc of idx.docs.values()) {
          verticals[doc.media?.type ?? "text"] = (verticals[doc.media?.type ?? "text"] ?? 0) + 1;
          const host = domainOf(doc.url);
          perHost.set(host, (perHost.get(host) ?? 0) + 1);
        }
        const hosts = [...new Set(CONFIG.seeds.map((u) => {
          try {
            return new URL(u).hostname.replace(/^www\./, "");
          } catch {
            return "";
          }
        }).filter(Boolean))];
        // Bounded concurrency: a few dozen hosts, a handful at a time.
        const probe: any[] = [];
        for (let i = 0; i < hosts.length; i += 8) {
          probe.push(
            ...(await Promise.all(
              hosts.slice(i, i + 8).map(async (host) => {
                const cached = probeCache.get(host);
                if (cached && Date.now() - cached.at < PROBE_TTL) return cached.value;
                const started = Date.now();
                let status = 0;
                let error = "";
                try {
                  const res = await fetch(`https://${host}/`, {
                    redirect: "follow",
                    signal: AbortSignal.timeout(8000),
                    headers: { "user-agent": CONFIG.userAgent, accept: "text/html" },
                  });
                  status = res.status;
                  await res.body?.cancel();
                } catch (e: any) {
                  error = String(e?.name === "TimeoutError" ? "timeout" : e?.message ?? e).slice(0, 80);
                }
                const value = {
                  host,
                  status,
                  error,
                  indexed: idx.hosts.has(host),
                  ms: Date.now() - started,
                };
                probeCache.set(host, { at: Date.now(), value });
                return value;
              }),
            )),
          );
        }
        return Response.json(
          {
            docs: idx.docCount,
            terms: idx.index.size,
            indexAgeHours: indexAgeHours(),
            stale: (indexAgeHours() ?? 0) > CONFIG.crawl.staleHours,
            tls: tlsStatus(),
            // Whether there is still room to crawl, so "use the whole gigabyte"
            // is a measurable thing rather than a guess.
            storage: budget(idx),
            // Live memory: the container's real ceiling rather than the VPS's
            // total, so the crawl limit can be reasoned about from a browser
            // instead of a console.
            memory: memoryReport(),
            verticals,
            topHosts: [...perHost.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20),
            probes: probe,
            blocked: probe.filter((p) => p.error || p.status >= 400 || p.status === 0).map((p) => p.host),
            unindexed: probe.filter((p) => !p.indexed).map((p) => p.host),
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

  if (tls?.daysLeft !== undefined && tls.daysLeft <= 7) {
    console.warn(
      `warning: certificate ${tls.certPath} expires in ${tls.daysLeft} day(s) (${tls.notAfter}). Run: bash tls-cert.sh renew`,
    );
  }
  return server;
}