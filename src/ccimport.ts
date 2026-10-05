// Index pages we are not allowed to crawl, by reading them out of Common Crawl.
//
// Instagram, Reddit, X, Facebook and Pinterest all answer "Disallow: /" to every
// crawler in their robots.txt. Hitting them anyway would be the wrong move, and
// it mostly does not work: they answer datacenter IPs with login walls and 403s.
//
// Common Crawl is a different door. Those sites allow CC's crawler, so CC has
// already fetched the pages, and it publishes exactly where each page lives
// inside its WARC files. The index gives us {filename, offset, length}; a plain
// HTTP Range request against Common Crawl's storage returns that one gzipped
// record and nothing else. We never contact the origin, we honour the site's
// wishes as expressed to crawlers, and we get real page text.
//
//   GET https://index.commoncrawl.org/CC-MAIN-2026-30-index?url=instagram.com&output=json
//   -> {"url":…,"mime":"text/html","filename":"crawl-data/…/cc-….warc.gz",
//       "offset":123,"length":4567}
import { CONFIG } from "./config.ts";
import { latestCollection } from "./discovery.ts";
import { parseHtml, normalizeUrl } from "./crawler/parser.ts";
import { isAllowedLanguage } from "./lang.ts";
import { rejectDoc } from "./quality.ts";
import { hash } from "./util.ts";
import { normalizeText } from "./index/tokenizer.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";
import type { CrawledDoc } from "./types.ts";

/**
 * One Common Crawl capture record.
 *
 * The important part is that this is a *pointer*: `filename`, `offset` and
 * `length` say where inside a WARC file this capture lives. Extracting just the
 * URL — the obvious thing to do with `sed` — throws away the only way to get
 * the page text, leaving millions of addresses and nothing to search.
 */
export interface CcRecord {
  url: string;
  mime: string;
  filename: string;
  offset: number;
  length: number;
}

/** Keep only records we can actually turn into a document. */
export function usableRecord(o: any): boolean {
  const mime = String(o?.mime ?? "");
  if (!/text\/html|application\/xhtml/i.test(mime)) return false;
  if (typeof o?.filename !== "string" || !o.filename) return false;
  // CDX writes these as *strings* ("offset": "896"), and Number.isFinite does
  // not coerce, so they have to be converted before they are checked.
  const offset = Number(o?.offset);
  const length = Number(o?.length);
  if (!Number.isFinite(offset) || !Number.isFinite(length)) return false;
  if (offset < 0 || length < 200) return false; // stubs and redirects
  return true;
}

/** Bare IP hosts: a Common Crawl index shard starts with them and they are junk. */
export function isIpHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":");
  } catch {
    return true; // unparseable: skip
  }
}

/**
 * Parse one line of a CDX shard.
 *
 * Format is `SURTKEY TIMESTAMP {json}` — the JSON starts at the first brace, so
 * the key and timestamp are skipped rather than pattern-matched.
 */
export function parseCdxLine(line: string): CcRecord | null {
  const start = line.indexOf("{");
  if (start === -1) return null;
  let o: any;
  try {
    o = JSON.parse(line.slice(start));
  } catch {
    return null;
  }
  if (!usableRecord(o)) return null;
  const url = String(o.url ?? "");
  if (!url || isIpHost(url)) return null;
  return { url, mime: String(o.mime), filename: o.filename, offset: Number(o.offset), length: Number(o.length) };
}

/**
 * Spread a selection across a shard.
 *
 * Shards are sorted by SURT key, so the head of one file is a single alphabetical
 * cluster (`1.000.000.000`, `165.22.100.0`, …) rather than a sample of the web.
 * Taking the first N would give one narrow slice; a stride walks the whole file.
 */
export function sampleWithStride<T>(items: T[], wanted: number, totalLines: number): T[] {
  if (wanted <= 0 || items.length === 0) return [];
  if (items.length <= wanted) return items;
  const stride = Math.max(1, Math.floor(totalLines / wanted));
  const out: T[] = [];
  for (let i = 0; i < items.length && out.length < wanted; i += stride) out.push(items[i]);
  return out;
}

/** One index entry, parsed from the JSON-lines the index streams back. */
export function parseIndexLine(line: string): CcRecord | null {
  if (!line.trim()) return null;
  let o: any;
  try {
    o = JSON.parse(line);
  } catch {
    return null;
  }
  if (!usableRecord(o)) return null;
  // Coerced for the same reason as in parseCdxLine: these arrive as strings, and
  // a string offset silently turns the range request into string concatenation
  // ("896" + 2707 = "8962707"), which fetches the wrong bytes and imports nothing.
  return {
    url: String(o.url),
    mime: String(o.mime),
    filename: o.filename,
    offset: Number(o.offset),
    length: Number(o.length),
  };
}

/** A range request is only worth making if it stays inside the record. */
export function rangeFor(rec: CcRecord): string {
  const len = Math.min(rec.length, CONFIG.discovery.maxRecordBytes);
  return `bytes=${rec.offset}-${rec.offset + len - 1}`;
}

/** How many bytes a record will pull down, for budgeting. */
export function recordBytes(rec: CcRecord): number {
  return Math.min(rec.length, CONFIG.discovery.maxRecordBytes);
}

/**
 * Split a gzipped WARC record into the HTTP body: skip the WARC and HTTP
 * headers, keep everything up to the end of the payload.
 */
export function extractHtml(warcGz: Uint8Array): string | null {
  let text: string;
  try {
    // Copy into a plain ArrayBuffer: gunzip wants a concrete buffer, not a view
    // that might be backed by shared memory.
    const src = new Uint8Array(warcGz.byteLength);
    src.set(warcGz);
    text = new TextDecoder("utf-8", { fatal: false }).decode(Bun.gunzipSync(src));
  } catch {
    return null;
  }
  // WARC header, then HTTP header, then the body.
  const httpStart = text.search(/^HTTP\/1\.[01] /m);
  if (httpStart === -1) return null;
  const afterStatus = text.indexOf("\r\n\r\n", httpStart);
  if (afterStatus === -1) return null;
  const body = text.slice(afterStatus + 4);
  if (!/<html|<!doctype/i.test(body)) return null;
  return body;
}

/** Ask the index for records for one host pattern. */
export async function ccRecords(
  pattern: string,
  limit: number,
  opts: { collection?: string; timeoutMs?: number } = {},
): Promise<{ records: CcRecord[]; collection: string | null; error?: string }> {
  const collection = opts.collection ?? (await latestCollection());
  if (!collection) return { records: [], collection: null, error: "no Common Crawl collection available" };

  const url =
    `${CONFIG.discovery.indexUrl}/${collection}-index` +
    `?url=${encodeURIComponent(pattern)}&output=json&filter=status:200&collapse=urlkey`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? CONFIG.discovery.timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) return { records: [], collection, error: `index HTTP ${res.status}` };
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const records: CcRecord[] = [];
    const seen = new Set<string>();
    let buffer = "";

    outer: while (records.length < limit) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const rec = parseIndexLine(line);
        if (!rec || seen.has(rec.url)) continue;
        seen.add(rec.url);
        records.push(rec);
        if (records.length >= limit) {
          await reader.cancel().catch(() => {});
          break outer;
        }
      }
    }
    return { records, collection };
  } catch (e: any) {
    return { records: [], collection, error: String(e?.message ?? e).slice(0, 120) };
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch one record's bytes out of Common Crawl's WARC storage. */
export async function ccFetchHtml(rec: CcRecord, timeoutMs = 20_000): Promise<string | null> {
  const url = `${CONFIG.discovery.dataUrl}/${rec.filename}`;
  try {
    const res = await fetch(url, {
      headers: { range: rangeFor(rec) },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.length === 0) return null;
    return extractHtml(bytes);
  } catch {
    return null;
  }
}

/**
 * Pull pages for one host into the index. Returns what happened per host, so a
 * caller (or the CLI) can report honestly instead of pretending it worked.
 */
/**
 * Turn records from a local CDX shard into indexed documents.
 *
 * This is the version of "download a shard and index it" that actually works:
 * each record carries the WARC pointer, so the page text comes out of Common
 * Crawl's storage with one range request — no request to the origin at all.
 * Shard 0 begins with bare IP addresses because shards are sorted by SURT key,
 * so the selection is spread with a stride instead of taking the head.
 */
export async function importRecords(
  idx: InvertedIndex,
  records: CcRecord[],
  opts: {
    maxPages?: number;
    perHost?: number;
    shouldStop?: () => boolean;
    onDoc?: (url: string, title: string) => void;
    onProgress?: (done: number, added: number, skipped: number) => void;
  } = {},
): Promise<{ tried: number; added: number; skipped: number; stopped?: string }> {
  const maxPages = opts.maxPages ?? 500;
  const perHost = opts.perHost ?? 5;
  const fromHosts = new Map<string, number>();
  let tried = 0;
  let added = 0;
  let skipped = 0;
  let stopped: string | undefined;

  for (const rec of records) {
    if (tried >= maxPages) {
      stopped = `page cap (${maxPages})`;
      break;
    }
    if (opts.shouldStop?.()) {
      stopped = "caller asked to stop";
      break;
    }
    const norm = normalizeUrl(rec.url);
    if (!norm) {
      skipped++;
      continue;
    }
    let host = "";
    try {
      host = new URL(norm).hostname.replace(/^www\./, "");
    } catch {
      skipped++;
      continue;
    }
    // Politeness: a handful of pages per host, so one big site cannot take the
    // whole budget and we do not hammer anyone.
    const used = fromHosts.get(host) ?? 0;
    if (used >= perHost) {
      skipped++;
      continue;
    }
    fromHosts.set(host, used + 1);
    if (idx.docs.has(hash(norm))) {
      skipped++;
      continue;
    }

    tried++;
    const doc = await recordToDoc(norm, rec);
    if (!doc) {
      skipped++;
      continue;
    }
    if (idx.addDocument(doc)) {
      added++;
      opts.onDoc?.(doc.url, doc.title);
    } else {
      skipped++;
    }
    if (tried % 25 === 0) opts.onProgress?.(tried, added, skipped);
  }
  return { tried, added, skipped, stopped };
}

/** Fetch one capture and turn it into a document, or null if it is not worth it. */
async function recordToDoc(norm: string, rec: CcRecord): Promise<CrawledDoc | null> {
  const html = await ccFetchHtml(rec);
  if (!html) return null;
  const parsed = parseHtml(html, norm);
  const text = parsed.text.slice(0, CONFIG.crawl.maxTextChars);
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < CONFIG.quality.minWords || !isAllowedLanguage(text)) return null;
  if (rejectDoc({ url: norm, text, wordCount: words, linkDensity: parsed.linkDensity }).junk) return null;
  return {
    id: hash(norm),
    url: norm,
    title: parsed.title || norm,
    text,
    lang: parsed.lang,
    linkDensity: parsed.linkDensity,
    media: parsed.media,
    // Provenance: this text came from Common Crawl's storage, not from us
    // fetching the origin.
    viaCommonCrawl: true,
    outlinks: [],
    fetchedAt: new Date().toISOString(),
    contentHash: hash(normalizeText(text)),
    wordCount: words,
  };
}

export async function importHost(
  idx: InvertedIndex,
  host: string,
  opts: { perHost?: number; collection?: string; onDoc?: (url: string, title: string) => void } = {},
): Promise<{ host: string; found: number; added: number; skipped: number; error?: string }> {
  const perHost = opts.perHost ?? CONFIG.storage.bulkPerHost * 25;
  const pattern = host.includes("/") ? host : `${host.replace(/^\*\./, "")}/*`;
  const { records, error } = await ccRecords(pattern, perHost, { collection: opts.collection });
  if (error) return { host, found: 0, added: 0, skipped: 0, error };

  let added = 0;
  let skipped = 0;
  for (const rec of records) {
    const norm = normalizeUrl(rec.url);
    if (!norm || idx.docs.has(hash(norm))) {
      skipped++;
      continue;
    }
    const html = await ccFetchHtml(rec);
    if (!html) {
      skipped++;
      continue;
    }
    const parsed = parseHtml(html, norm);
    const text = parsed.text.slice(0, CONFIG.crawl.maxTextChars);
    const words = text.split(/\s+/).filter(Boolean).length;
    if (words < CONFIG.quality.minWords || !isAllowedLanguage(text)) {
      skipped++;
      continue;
    }
    if (rejectDoc({ url: norm, text, wordCount: words, linkDensity: parsed.linkDensity }).junk) {
      skipped++;
      continue;
    }
    const doc: CrawledDoc = {
      id: hash(norm),
      url: norm,
      title: parsed.title || norm,
      text,
      lang: parsed.lang,
      linkDensity: parsed.linkDensity,
      media: parsed.media,
      // Honest provenance: these sites disallow crawling, so this text came from
      // Common Crawl, not from us knocking on their door.
      viaCommonCrawl: true,
      outlinks: [],
      fetchedAt: new Date().toISOString(),
      contentHash: hash(normalizeText(text)),
      wordCount: words,
    };
    if (idx.addDocument(doc)) {
      added++;
      opts.onDoc?.(doc.url, doc.title);
    } else {
      skipped++;
    }
  }
  return { host, found: records.length, added, skipped };
}