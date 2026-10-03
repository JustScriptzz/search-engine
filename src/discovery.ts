// URL discovery at web scale, using the Common Crawl index.
//
// The index is a public catalogue of every URL anyone has ever crawled, so it
// is the honest way to "scan the internet for websites" without a seed list:
// you ask it for pages matching a pattern and it hands back real URLs.
//
//   GET https://index.commoncrawl.org/collinfo.json        -> collections
//   GET https://index.commoncrawl.org/CC-MAIN-2026-XX-index?url=*.nasa.gov&output=json
//
// Each line of the index response is {url, mime, status, ...}.
import { CONFIG } from "./config.ts";

export interface DiscoveredUrl {
  url: string;
  status: number;
  mime: string;
}

let collectionCache: { id: string; at: number } | null = null;

/** Newest available Common Crawl index id, cached. */
export async function latestCollection(timeoutMs = 15_000): Promise<string | null> {
  if (collectionCache && Date.now() - collectionCache.at < CONFIG.discovery.collectionCacheTtlMs) {
    return collectionCache.id;
  }
  try {
    const res = await fetch(CONFIG.discovery.collectionIndexUrl, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const list = (await res.json()) as Array<{ id?: string }>;
    const id = list.find((c) => typeof c.id === "string" && c.id.includes("MAIN"))?.id;
    if (id) collectionCache = { id, at: Date.now() };
    return id ?? null;
  } catch {
    return null;
  }
}

/**
 * Query the index for URLs matching `pattern` (supports `*.domain.com/*`
 * wildcards). Returns up to `limit` crawlable HTML URLs.
 */
export async function discoverFromIndex(
  pattern: string,
  limit = 40,
  opts: { collection?: string } = {},
): Promise<{ urls: string[]; collection: string | null; error?: string }> {
  const collection = opts.collection ?? (await latestCollection());
  if (!collection) return { urls: [], collection: null, error: "no Common Crawl collection available" };

  // Wildcards work; matchType=domain times out (504) on their index, and
  // pageSize is ignored — the response streams the whole match set, so we read
  // line by line and abort as soon as we have enough URLs.
  const url =
    `${CONFIG.discovery.indexUrl}/${collection}-index` +
    `?url=${encodeURIComponent(pattern)}&output=json&filter=status:200`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CONFIG.discovery.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return { urls: [], collection, error: `index HTTP ${res.status}` };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const urls: string[] = [];
    const seen = new Set<string>();
    let buffer = "";

    outer: while (urls.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const u = urlFromIndexLine(line);
        if (!u || seen.has(u)) continue;
        seen.add(u);
        urls.push(u);
        if (urls.length >= limit) break outer;
      }
    }
    ctrl.abort(); // stop the rest of a potentially huge response
    return { urls, collection };
  } catch (err) {
    return { urls: [], collection, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
  }
}

function urlFromIndexLine(line: string): string | null {
  if (!line.trim().startsWith("{")) return null;
  let rec: { url?: string; status?: string; mime?: string };
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec.url || rec.status !== "200") return null;
  if (rec.mime && !/html|text\/plain/.test(rec.mime)) return null;
  return normalize(rec.url);
}

/**
 * Build a URL list across several patterns: famous sites (whole domains),
 * topic wildcards and language editions. Deduped, capped.
 */
export async function discoverMany(
  patterns: string[],
  perPattern = 40,
): Promise<{ urls: string[]; collection: string | null; failures: string[] }> {
  const collection = (await latestCollection()) ?? undefined;
  const all: string[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];
  for (const pattern of patterns) {
    const res = await discoverFromIndex(pattern, perPattern, { collection });
    if (res.error) failures.push(`${pattern}: ${res.error}`);
    for (const u of res.urls) {
      if (seen.has(u)) continue;
      seen.add(u);
      all.push(u);
    }
  }
  return { urls: all, collection: collection ?? null, failures };
}

function normalize(raw: string): string | null {
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // skip deep assets and generated paths
    if (/\.(jpg|jpeg|png|gif|svg|webp|pdf|zip|mp4|mp3|css|js|json|xml)$/i.test(u.pathname)) return null;
    if (u.pathname.length > 120) return null;
    return u.toString();
  } catch {
    return null;
  }
}