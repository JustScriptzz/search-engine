import { CONFIG } from "../config.ts";

export interface FetchOpts {
  timeoutMs?: number;
  maxBytes?: number;
  acceptLanguage?: string | null;
}

/** Fetch HTML with an English-language preference and correct charset decoding. */
export async function fetchHtml(url: string, opts: FetchOpts = {}): Promise<string | null> {
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
    if (buf.byteLength > maxBytes) return null;
    return decodeHtml(buf, ct);
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