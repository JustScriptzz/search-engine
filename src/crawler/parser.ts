import { CONFIG } from "../config.ts";
import { classify, metaContent, type MediaInfo } from "../media.ts";

export interface ParsedPage {
  title: string;
  text: string;
  links: string[];
  lang: string;
  /** Share of the extracted text that sat inside <a> tags (0..1). */
  linkDensity: number;
  /** What this page is: article, image, video or short-form. */
  media: MediaInfo;
  /** og:description / meta description — the page's own summary. */
  description: string;
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,500})<\/title>/i);
  const title = stripTags(decodeEntities(titleMatch?.[1] ?? "")).replace(/\s+/g, " ").trim().slice(0, 200);

  const lang =
    /<html[^>]+lang\s*=\s*["']([a-zA-Z-]{2,5})/i.exec(html)?.[1]?.toLowerCase() ?? "";

  const links: string[] = [];
  const linkRe = /<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const abs = new URL(decodeEntities(m[1]), baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      links.push(abs.toString());
    } catch {
      // ignore malformed hrefs
    }
  }

  // Order matters: decode entities FIRST, then drop script/style blocks, then
  // strip tags. Doing it the other way round leaves escaped markup behind,
  // which decodes into visible junk (e.g. YouTube's ytInitialData JSON).
  const decoded = decodeEntities(html);

  const linkDensitySource = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<template[\s\S]*?<\/template>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<form[\s\S]*?<\/form>/gi, " ");

  let linkChars = 0;
  linkDensitySource.replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_m, inner: string) => {
    linkChars += stripTags(inner).length;
    return " ";
  });

  const fullText = stripTags(linkDensitySource)
    // leftovers that survive tag removal: arrows, pipes, bullets, quotes
    .replace(/->|=>|→/g, " ")
    .replace(/[|*_~#>]+/g, " ")
    .replace(/[{}[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Density is measured against the FULL text, before truncation, otherwise a
  // capped article would always read as 100% links.
  const linkDensity = fullText.length > 0 ? Math.min(linkChars / fullText.length, 1) : 0;
  const text = fullText.slice(0, CONFIG.crawl.maxTextChars);

  return {
    title,
    text,
    lang,
    linkDensity,
    media: classify(decoded, baseUrl),
    description: firstMatch(decoded, ["og:description", "twitter:description", "description"]),
    links: [...new Set(links)].slice(0, CONFIG.crawl.maxLinksPerPage),
  };
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, " ");
}

/** First non-empty meta description from a list of candidate keys. */
function firstMatch(html: string, props: string[]): string {
  for (const prop of props) {
    const raw = metaContent(html, prop);
    const value = stripTags(decodeEntities(raw)).replace(/\s+/g, " ").trim();
    if (value) return value.slice(0, 600);
  }
  return "";
}

export function normalizeUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    u.hash = "";
    if (u.pathname !== "/") u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}