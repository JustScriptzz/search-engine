import { InvertedIndex } from "./index/invertedIndex.ts";

export const INDEX_PATH = "data/index.json";

export async function loadIndex(): Promise<InvertedIndex> {
  return InvertedIndex.loadFromFile(INDEX_PATH);
}

export async function saveIndex(idx: InvertedIndex): Promise<void> {
  await idx.saveToFile(INDEX_PATH);
}

export function startServer(idx: InvertedIndex, port = 3000) {
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") {
        return new Response(Bun.file("public/index.html"), { headers: { "content-type": "text/html" } });
      }
      if (url.pathname === "/app.js") {
        return new Response(Bun.file("public/app.js"), { headers: { "content-type": "text/javascript" } });
      }
      if (url.pathname === "/style.css") {
        return new Response(Bun.file("public/style.css"), { headers: { "content-type": "text/css" } });
      }
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10"), 50);
        const t0 = Date.now();
        const hits = idx.search(q, isNaN(limit) ? 10 : limit);
        return Response.json({ query: q, count: hits.length, tookMs: Date.now() - t0, hits });
      }
      if (url.pathname === "/api/stats") {
        return Response.json({ ...idx.stats(), indexPath: INDEX_PATH });
      }
      return new Response("Not found", { status: 404 });
    },
  });
}
