// URL discovery from sitemap.xml and robots.txt "Sitemap:" directives.
//
// Sitemaps are how sites publish their URL inventory, and they are the single
// cheapest way to learn tens of thousands of real URLs per site — no crawling
// through link graphs, no guessing. Handles sitemap indexes recursively.
import { CONFIG } from "./config.ts";
import { fetchText } from "./crawler/fetcher.ts";

export interface SitemapResult {
  urls: string[];
  sitemaps: number; // sitemap documents read
  errors: string[];
}

const LOC_RE = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
const SITEMAPINDEX_RE = /<sitemapindex[\s>]/i;

/** Sitemap URLs declared in robots.txt for a host (often several). */
export async function robotsSitemaps(origin: string, timeoutMs = 15_000): Promise<string[]> {
  const found: string[] = [];
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(new URL("/robots.txt", origin), {
      signal: ctrl.signal,
      headers: { "user-agent": CONFIG.userAgent },
    });
    if (!res.ok) return found;
    const text = await res.text();
    for (const m of text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
      const u = m[1].trim();
      if (u.startsWith("http")) found.push(u);
    }
  } catch {
    // no robots.txt is fine; fall back to the conventional path
  } finally {
    clearTimeout(t);
  }
  return found;
}

export async function collectSitemapUrls(
  origin: string,
  opts: { maxSitemaps?: number; maxUrls?: number; timeoutMs?: number } = {},
): Promise<SitemapResult> {
  const maxSitemaps = opts.maxSitemaps ?? CONFIG.discovery.sitemapsPerHost;
  const maxUrls = opts.maxUrls ?? CONFIG.discovery.sitemapUrlLimit;
  const timeoutMs = opts.timeoutMs ?? CONFIG.discovery.timeoutMs;

  const queue: string[] = [];
  const declared = await robotsSitemaps(origin, timeoutMs);
  queue.push(...declared);
  queue.push(new URL("/sitemap.xml", origin).toString());

  const seen = new Set<string>();
  const urls: string[] = [];
  const errors: string[] = [];
  let sitemaps = 0;
  // A sitemap *index* lists every child sitemap, and the big ones list hundreds
  // of thousands. Pushing them all into the queue is how this filled 1 GB of
  // RAM and got the fill run OOM-killed, so the queue is bounded: we will never
  // read more than maxSitemaps documents, so there is no point holding more
  // candidates than that.
  const maxQueue = Math.max(maxSitemaps * 4, 32);

  while (queue.length > 0 && sitemaps < maxSitemaps && urls.length < maxUrls) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);

    const stream = await streamSitemap(sm, timeoutMs, (locs, isIndex) => {
      if (isIndex) {
        for (const loc of locs) {
          if (queue.length >= maxQueue) break;
          if (!seen.has(loc)) queue.push(loc);
        }
      } else {
        for (const loc of locs) {
          if (urls.length >= maxUrls) break;
          if (!seen.has(loc)) {
            seen.add(loc);
            urls.push(loc);
          }
        }
      }
      // Enough for now: stop reading the body instead of holding the rest.
      return urls.length >= maxUrls || queue.length >= maxQueue;
    });
    if (!stream) {
      errors.push(sm);
      continue;
    }
    sitemaps++;
  }
  return { urls: urls.slice(0, maxUrls), sitemaps, errors };
}

/**
 * Read one sitemap, extracting <loc> values chunk by chunk.
 *
 * The whole document is never held in memory: a 4 MB sitemap string per site,
 * times the number of sites, is what turned a fill run into an OOM. The
 * callback returns true to stop early, which also cancels the response body.
 */
async function streamSitemap(
  url: string,
  timeoutMs: number,
  onChunk: (locs: string[], isIndex: boolean) => boolean,
): Promise<boolean> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: ctrl.signal,
      headers: { "user-agent": CONFIG.userAgent, accept: "application/xml,text/xml,*/*" },
    });
    if (!res.ok || !res.body) return false;

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let isIndex = false;
    let read = 0;
    const hardCap = CONFIG.discovery.maxSitemapBytes;

    while (read < hardCap) {
      const { value, done } = await reader.read();
      if (done) break;
      read += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      // <loc> can straddle a chunk boundary, so keep a short tail back.
      const cut = buffer.lastIndexOf("<loc>");
      const head = cut > 0 ? buffer.slice(0, cut) : buffer;
      buffer = cut > 0 ? buffer.slice(cut) : "";
      if (!isIndex && SITEMAPINDEX_RE.test(head)) isIndex = true;
      const locs: string[] = [];
      for (const m of head.matchAll(LOC_RE)) locs.push(decodeXmlEntities(m[1]));
      if (locs.length && onChunk(locs, isIndex)) {
        await reader.cancel().catch(() => {});
        return true;
      }
    }
    // Trailing fragment, in case the document ended mid-element.
    if (buffer) {
      const locs: string[] = [];
      for (const m of buffer.matchAll(LOC_RE)) locs.push(decodeXmlEntities(m[1]));
      if (locs.length) onChunk(locs, isIndex);
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/** Certificate-transparency subdomain discovery (crt.sh, no API key). */
export async function subdomainsFromCrt(
  domain: string,
  limit = 50,
  timeoutMs = 30_000,
): Promise<{ urls: string[]; error?: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`https://crt.sh/?q=%25.${domain}&output=json`, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
    });
    if (!res.ok) return { urls: [], error: `crt.sh HTTP ${res.status}` };
    const rows = (await res.json()) as Array<{ name_value?: string }>;
    const hosts = new Set<string>();
    for (const row of rows) {
      for (const raw of (row.name_value ?? "").split("\n")) {
        const host = raw.trim().toLowerCase().replace(/^\*\./, "");
        if (!host || !host.endsWith(domain)) continue;
        if (host.startsWith("xn--") || host.includes(" ")) continue;
        hosts.add(host);
        if (hosts.size >= limit) break;
      }
      if (hosts.size >= limit) break;
    }
    return { urls: [...hosts].map((h) => `https://${h}/`) };
  } catch (err) {
    return { urls: [], error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(t);
  }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .trim();
}