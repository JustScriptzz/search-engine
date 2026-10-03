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

  while (queue.length > 0 && sitemaps < maxSitemaps && urls.length < maxUrls) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const xml = await fetchText(sm, { timeoutMs, maxBytes: 4_000_000 });
    if (!xml) {
      errors.push(sm);
      continue;
    }
    sitemaps++;
    const isIndex = SITEMAPINDEX_RE.test(xml);
    for (const m of xml.matchAll(LOC_RE)) {
      const loc = decodeXmlEntities(m[1]);
      if (isIndex) queue.push(loc);
      else if (!seen.has(loc)) urls.push(loc);
      if (urls.length >= maxUrls) break;
    }
  }
  return { urls: urls.slice(0, maxUrls), sitemaps, errors };
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