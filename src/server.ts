import { CONFIG } from "./config.ts";
import { runAgent, type ChatTurn } from "./ai.ts";
import { countryBoost, getClientIp, lookupCountry } from "./geo.ts";
import { hasApiKey } from "./provider.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

export const INDEX_PATH = CONFIG.server.indexPath;

export async function loadIndex(): Promise<InvertedIndex> {
  return InvertedIndex.loadFromFile(INDEX_PATH);
}

export async function saveIndex(idx: InvertedIndex): Promise<void> {
  await idx.saveToFile(INDEX_PATH);
}

const STATIC_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
};

async function staticResponse(pathname: string): Promise<Response | null> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  if (rel.includes("..") || rel.includes("\0")) return null;
  const dot = rel.lastIndexOf(".");
  const type = dot === -1 ? null : STATIC_TYPES[rel.slice(dot).toLowerCase()];
  if (!type) return null;
  const f = Bun.file("public" + rel);
  if (!(await f.exists())) return null;
  return new Response(f, { headers: { "content-type": type, "cache-control": "no-cache" } });
}

function corsHeaders(): Record<string, string> {
  if (!CONFIG.server.cors) return {};
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function searchHits(idx: InvertedIndex, query: string, limit: number, countryCode: string) {
  return idx
    .search(query, Math.min(limit * 3, CONFIG.ui.maxLimit * 3))
    .map((h) => ({ ...h, score: round(h.score * countryBoost(h.url, countryCode)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function parseLimit(raw: string | null): number {
  const n = parseInt(raw ?? "", 10);
  if (Number.isNaN(n)) return CONFIG.ui.defaultLimit;
  return Math.min(Math.max(n, 1), CONFIG.ui.maxLimit);
}

export function startServer(idx: InvertedIndex, port: number = CONFIG.server.port) {
  return Bun.serve({
    port,
    hostname: CONFIG.server.host,
    idleTimeout: CONFIG.server.idleTimeoutSeconds,
    async fetch(req) {
      const url = new URL(req.url);
      const cors = corsHeaders();

      if (req.method === "OPTIONS") return new Response(null, { headers: cors });

      // ---- API: search ----
      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q") ?? "";
        const limit = parseLimit(url.searchParams.get("limit"));
        const override = (url.searchParams.get("country") ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override, fromCache: false }
          : await lookupCountry(getClientIp(req));
        const t0 = Date.now();
        const hits = searchHits(idx, q, limit, geo.countryCode);
        return Response.json(
          {
            query: q,
            count: hits.length,
            tookMs: Date.now() - t0,
            hits,
            country: geo.country,
            countryCode: geo.countryCode,
          },
          { headers: cors },
        );
      }

      // ---- API: index stats ----
      if (url.pathname === "/api/stats") {
        return Response.json(
          {
            ...idx.stats(),
            name: CONFIG.name,
            version: CONFIG.version,
            indexPath: INDEX_PATH,
            ai: {
              provider: CONFIG.ai.provider,
              model: CONFIG.ai.model,
              baseUrl: CONFIG.ai.baseUrl,
              configured: hasApiKey(),
              nativeTools: CONFIG.ai.nativeTools,
            },
          },
          { headers: cors },
        );
      }

      // ---- API: MiniSearch AI agent (SSE) ----
      if (url.pathname === "/api/chat" && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as {
          message?: string;
          history?: ChatTurn[];
          country?: string;
        };
        const message = (body.message ?? "").trim();
        if (!message) return Response.json({ error: "message required" }, { status: 400, headers: cors });

        const override = (body.country ?? "").toUpperCase();
        const geo = override
          ? { country: override, countryCode: override }
          : await lookupCountry(getClientIp(req));

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            let answered = false;
            const send = (e: any) => {
              if (e?.type === "answer") answered = true;
              controller.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));
            };
            // SSE comment heartbeat: keeps proxies and idle timers from cutting
            // the stream while the model is thinking.
            const beat = setInterval(() => controller.enqueue(enc.encode(": hb\n\n")), CONFIG.server.sseHeartbeatMs);
            try {
              const answer = await runAgent({
                message,
                history: Array.isArray(body.history) ? body.history.slice(-8) : [],
                index: idx,
                country: geo.country,
                countryCode: geo.countryCode,
                onEvent: send,
              });
              if (answer && !answered) send({ type: "answer", text: answer });
            } catch (err) {
              send({ type: "error", message: err instanceof Error ? err.message : String(err) });
            } finally {
              clearInterval(beat);
              send({ type: "done" });
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            ...cors,
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "x-accel-buffering": "no",
          },
        });
      }

      // ---- static UI ----
      const page = await staticResponse(url.pathname);
      if (page) return page;
      return new Response("Not found", { status: 404, headers: cors });
    },
  });
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}