import { InvertedIndex } from "./index/invertedIndex.ts";
import { countryBoost, getClientIp, lookupCountry } from "./geo.ts";

export const INDEX_PATH = "data/index.json";

export async function loadIndex(): Promise<InvertedIndex> {
  return InvertedIndex.loadFromFile(INDEX_PATH);
}

export async function saveIndex(idx: InvertedIndex): Promise<void> {
  await idx.saveToFile(INDEX_PATH);
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".json": "application/json",
};

async function staticResponse(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..") || rel.includes("\0")) return null;
  const dot = rel.lastIndexOf(".");
  const type = dot === -1 ? null : STATIC_TYPES[rel.slice(dot).toLowerCase()];
  if (!type) return null;
  const f = Bun.file("public" + rel);
  if (!(await f.exists())) return null;
  return new Response(f, { headers: { "content-type": type } });
}
export function startServer(idx: InvertedIndex, port = 3000) {
  return Bun.serve({
    port,
    hostname: "0.0.0.0",
    async fetch(req) {
      const url = new URL(req.url);
      const cors = { "access-control-allow-origin": "*", "access-control-allow-methods": "GET, OPTIONS" };
      if (req.method === "OPTIONS") return new Response(null, { headers: cors });
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "10"), 50);
        // ?country=DE overrides IP detection (useful for testing / privacy).
        const override = (url.searchParams.get("country") ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override, fromCache: false }
          : await lookupCountry(getClientIp(req));
        const t0 = Date.now();
        // Oversample so country-boosted docs can surface, then cut to limit.
        const hits = idx
          .search(q, isNaN(limit) ? 10 : 50)
          .map((h) => ({ ...h, score: Math.round(h.score * countryBoost(h.url, geo.countryCode) * 1000) / 1000 }))
          .sort((a, b) => b.score - a.score)
          .slice(0, isNaN(limit) ? 10 : limit);
        return Response.json(
          { query: q, count: hits.length, tookMs: Date.now() - t0, hits, country: geo.country, countryCode: geo.countryCode },
          { headers: cors },
        );
      }
      if (url.pathname === "/api/stats") {
        return Response.json({ ...idx.stats(), indexPath: INDEX_PATH }, { headers: cors });
      }
      const page = await staticResponse(url.pathname);
      if (page) return page;
      return new Response("Not found", { status: 404 });
    },
  });
}
