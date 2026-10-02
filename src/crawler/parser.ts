export interface ParsedPage {
  title: string;
  text: string;
  links: string[];
}

export function parseHtml(html: string, baseUrl: string): ParsedPage {
  const titleMatch = html.match(/<title[^>]*>([\s\S]{0,500})<\/title>/i);
  const title = (titleMatch?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);

  const links: string[] = [];
  const linkRe = /<a[^>]+href\s*=\s*["']([^"'#]+)["']/gi;
  let m: RegExpExecArray | null;
  while ((m = linkRe.exec(html)) !== null) {
    try {
      const abs = new URL(m[1], baseUrl);
      if (abs.protocol !== "http:" && abs.protocol !== "https:") continue;
      abs.hash = "";
      links.push(abs.toString());
    } catch {
      // ignore bad URLs
    }
  }

  // strip scripts, styles, nav, footer noise
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

  return { title, text: text.slice(0, 20000), links: [...new Set(links)].slice(0, 200) };
}

export function normalizeUrl(urlStr: string): string | null {
  try {
    const u = new URL(urlStr);
    u.hash = "";
    if (u.pathname !== "/" ) u.pathname = u.pathname.replace(/\/+$/, "");
    return u.toString();
  } catch {
    return null;
  }
}
