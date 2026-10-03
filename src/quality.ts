// Quality gate. Applied in two places, both matter:
//   1. the crawler, before a page enters the frontier or the index
//   2. every search, so a stale index can never surface junk
import { CONFIG } from "./config.ts";
import { isAllowedLanguage, scriptProfile } from "./lang.ts";

/** Social/video/ad hosts and account-or-legal pages. */
export function isJunkUrl(urlStr: string): boolean {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    return true;
  }
  const host = u.hostname.replace(/^www\./, "");
  if (CONFIG.crawl.blockedHosts.some((h) => host === h || host.endsWith(`.${h}`))) return true;
  const path = u.pathname.toLowerCase();
  if (CONFIG.crawl.blockedPathPatterns.some((p) => path.startsWith(p) || path.includes(p))) return true;
  // Segment-wise match: /user, /user/, /tag/foo are all listing pages.
  const segments = path.split("/").filter(Boolean);
  return segments.some((seg) => CONFIG.crawl.blockedPathSegments.includes(seg.replace(/\.(html?|php|aspx?)$/, "")));
}

/** Pages with no real prose (cookie walls, "enable JavaScript", nav-only stubs). */
export function isLowQualityText(text: string): boolean {
  const t = text.trim();
  if (t.length < CONFIG.quality.minDocChars) return true;
  if (/^(enable javascript|please enable|loading\.\.\.)/i.test(t)) return true;
  const words = t.split(/\s+/);
  if (words.length < 12) return false;
  // Tiny vocabulary repeated over and over = nav/boilerplate, not content.
  const unique = new Set(words.map((w) => w.toLowerCase()));
  if (unique.size / words.length < 0.12) return true;
  // The same phrase stamped several times (footer link lists, "Terms Privacy
  // Policy" blocks) also means there is no article here.
  return shingleDuplicateRatio(words) > CONFIG.quality.maxShingleDupRatio;
}

/** Share of 6-word shingles that are exact repeats of an earlier shingle. */
export function shingleDuplicateRatio(words: string[]): number {
  const size = 6;
  const seen = new Map<string, number>();
  for (let i = 0; i + size <= words.length; i++) {
    const key = words.slice(i, i + size).join(" ").toLowerCase();
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  if (seen.size === 0) return 0;
  let repeats = 0;
  for (const n of seen.values()) if (n > 1) repeats += n - 1;
  return repeats / seen.size;
}

export interface RejectReason {
  junk?: boolean;
  language?: boolean;
  lowQuality?: boolean;
}

/** Why a stored document must not be shown (empty object = keep it). */
export function rejectDoc(doc: { url: string; text: string; lang?: string; wordCount?: number; linkDensity?: number }): RejectReason {
  const reason: RejectReason = {};
  if (isJunkUrl(doc.url)) reason.junk = true;
  const words = doc.wordCount ?? doc.text.split(/\s+/).filter(Boolean).length;
  if (words < CONFIG.quality.minWords || isLowQualityText(doc.text)) reason.lowQuality = true;
  // Mostly link labels = a listing or index page, not an article.
  if ((doc.linkDensity ?? 0) > CONFIG.quality.maxLinkDensity) reason.lowQuality = true;
  // Cheap check first: a declared non-Latin <html lang> is decisive.
  const lang = (doc.lang ?? "").toLowerCase();
  if (lang && !isLatinLanguageCode(lang) && CONFIG.language.blockedScripts.includes(scriptOfLangCode(lang))) {
    reason.language = true;
  } else if (!isAllowedLanguage(doc.text)) {
    reason.language = true;
  }
  return reason;
}

export function isLatinLanguageCode(code: string): boolean {
  const c = code.split("-")[0];
  return LATIN_LANGS.has(c);
}

function scriptOfLangCode(code: string): string {
  const c = code.split("-")[0];
  if (["ar", "fa", "ur", "he", "iw", "ps", "sd", "ug", "yi"].includes(c)) return "arabic";
  if (["ru", "uk", "be", "bg", "sr", "mk", "mn", "kk", "ky"].includes(c)) return "cyrillic";
  if (["zh", "ja", "ko", "yue", "cmn"].includes(c)) return "cjk";
  if (["hi", "mr", "ne", "sa", "bn", "pa"].includes(c)) return "devanagari";
  if (["th", "lo", "my", "km"].includes(c)) return "thai";
  if (["el", "hy", "ka"].includes(c)) return "greek";
  return "latin";
}

// ISO-639-1 codes we treat as Latin-script and therefore indexable.
const LATIN_LANGS = new Set([
  "en", "de", "fr", "es", "it", "pt", "nl", "sv", "no", "nb", "nn", "da", "fi", "is",
  "et", "lv", "lt", "pl", "cs", "sk", "sl", "hr", "hu", "ro", "tr", "az", "ca", "eu",
  "gl", "id", "ms", "vi", "sw", "tl", "so", "af", "sq", "mt", "cy", "ga", "la", "eo",
  "ht", "jv", "nb",
]);

export { scriptProfile };