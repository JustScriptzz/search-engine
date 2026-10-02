export async function fetchHtml(url: string, timeoutMs = 12000, maxBytes = 2_000_000): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
      headers: {
        "user-agent": "MiniSearchBot/0.1 (+https://github.com/minisearch)",
        accept: "text/html,application/xhtml+xml",
      },
    });
    if (!res.ok) return null;
    const ct = res.headers.get("content-type") ?? "";
    if (ct && !ct.includes("html") && !ct.includes("text")) return null;
    const buf = await res.arrayBuffer();
    if (buf.byteLength > maxBytes) return null;
    return new TextDecoder("utf-8", { fatal: false }).decode(buf);
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}
