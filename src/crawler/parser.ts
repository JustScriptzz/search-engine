import { CONFIG } from "../config.ts";

export interface ParsedPage {
  title: string;
  text: string;
  links: string[];
  lang: string;
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,500})<\/title>/i);
  const title = decodeEntities((titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200));

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

  const text = decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
      .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
      .replace(/<header[\s\S]*?<\/header>/gi, " ")
      .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
      .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
      .replace(/<form[\s\S]*?<\/form>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, CONFIG.crawl.maxTextChars);

  return {
    title,
    text,
    lang,
    links: [...new Set(links)].slice(0, CONFIG.crawl.maxLinksPerPage),
  };
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