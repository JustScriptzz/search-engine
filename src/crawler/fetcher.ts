import { CONFIG } from "../config.ts";

export interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
  acceptLanguage?: string | null;
}

/** Fetch HTML with an English-language preference and correct charset decoding.
 *  Retries once on a timeout, because transient timeouts are what make a
 *  concurrent crawl look like it "skipped" well-known sites. */
export async function fetchHtml(url: string, opts: FetchOpts = {}, attempts = 1): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? CONFIG.crawl.timeoutMs;
  const maxBytes = opts.maxBytes ?? CONFIG.crawl.maxBytes;
  const acceptLanguage = opts.acceptLanguage === undefined ? CONFIG.acceptLanguage : opts.acceptLanguage;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const headers: Record<string, string> = {
      "user-agent": CONFIG.userAgent,
      accept: "text/html,application/xhtml+xml",
    };
    if (acceptLanguage) headers["accept-language"] = acceptLanguage;

    const res = await fetch(url, { signal: ctrl.signal, redirect: "follow", headers });
    if (!res.ok) return null;

    const ct = res.headers.get("content-type") ?? "";
    if (ct && !ct.includes("html") && !ct.includes("text")) return null;

    const buf = await res.arrayBuffer();
    // Truncate rather than reject: big pages (Wikipedia articles, W3C specs)
    // are usually the most valuable ones, and our extraction is regex-based so
    // a mid-tag cut is harmless. The hard ceiling still stops absurd payloads.
    const hardCap = maxBytes * 2;
    if (buf.byteLength > hardCap) return null;
    const usable = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return decodeHtml(usable, ct);
  } catch (err) {
    // One retry: transient timeouts are the main cause of a crawl that looks
    // like it "skipped" famous sites under load.
    if (!(err instanceof Error && /abort/i.test(err.name + err.message)) || attempts <= 0) return null;
    return fetchHtml(url, { ...opts, timeoutMs: Math.max(timeoutMs, 20_000) }, attempts - 1);
  } finally {
    clearTimeout(t);
  }
}

/** Fetch plain text (robots.txt, sitemaps.xml) with a byte cap. */
export async function fetchText(
  url: string,
  opts: { timeoutMs?: number; maxBytes?: number } = {},
): Promise<string | null> {
  const timeoutMs = opts.timeoutMs ?? CONFIG.crawl.timeoutMs;
  const maxBytes = opts.maxBytes ?? CONFIG.crawl.maxBytes;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: { "user-agent": CONFIG.userAgent, accept: "text/plain,application/xml,text/xml,*/*" },
    });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    const usable = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    return decodeHtml(usable, res.headers.get("content-type") ?? "");
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** Decode bytes using the Content-Type charset, then <meta charset>, then UTF-8. */
export function decodeHtml(buf: ArrayBuffer, contentType = ""): string {
  const bytes = new Uint8Array(buf);
  const headerCharset = /charset\s*=\s*"?([\w-]+)/i.exec(contentType)?.[1];
  const head = new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(0, 4096));
  const metaCharset =
    /<meta[^>]+charset\s*=\s*"?([\w-]+)/i.exec(head)?.[1] ??
    /<meta[^>]+content\s*=\s*"[^"]*charset\s*=\s*([\w-]+)/i.exec(head)?.[1];

  for (const cs of [headerCharset, metaCharset, "utf-8"]) {
    if (!cs) continue;
    try {
      const out = new TextDecoder(cs.toLowerCase(), { fatal: false }).decode(bytes);
      // A wrong guess shows up as replacement chars; prefer the next candidate.
      if (!out.includes("\uFFFD")) return out;
    } catch {
      // unknown label — try the next candidate
    }
  }
  return head + new TextDecoder("utf-8", { fatal: false }).decode(bytes.slice(4096));
}