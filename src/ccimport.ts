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

export interface CcRecord {
  url: string;
  mime: string;
  filename: string;
  offset: number;
  length: number;
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
  const mime = String(o.mime ?? "");
  if (!/text\/html|application\/xhtml/i.test(mime)) return null;
  if (typeof o.filename !== "string" || typeof o.offset !== "number" || typeof o.length !== "number") {
    return null;
  }
  return { url: String(o.url), mime, filename: o.filename, offset: o.offset, length: o.length };
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