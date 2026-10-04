import { loadEnvFile } from "./src/env.ts";
import { CONFIG } from "./src/config.ts";
import { loadIndex, startServer } from "./src/server.ts";
import { describeTls } from "./src/tls.ts";
import { runFill } from "./src/fillrun.ts";

await loadEnvFile();

// Pterodactyl entry point: the panel runs `bun run ${MAIN_FILE}` with no way
// to pass CLI args, so the allocated port comes from the environment.
const raw = process.env.SERVER_PORT ?? process.env.PORT ?? String(CONFIG.server.port);
const parsed = Number.parseInt(raw, 10);
const port = Number.isFinite(parsed) ? parsed : CONFIG.server.port;

const index = await loadIndex();
const server = startServer(index, port);
const { hasApiKey, keySource } = await import("./src/provider.ts");

console.log(`${CONFIG.name} listening on port ${server.port} — ${describeTls()} (docs=${index.docCount})`);
console.log(`  UI      /`);
console.log(`  api     /api/v1`);
console.log(`  search  /api/search?q=hello`);
console.log(`  stats   /api/stats`);
console.log(
  `  agent   POST /api/chat {"message":"..."} — ${hasApiKey() ? `ready (key from ${keySource()})` : "no credentials, index-only answers"}`,
);

// ---- background top-up -------------------------------------------------
// The site is already answering queries at this point. Growing the index used
// to be a build step, which meant the server did not exist until a 25-minute
// crawl finished — the site was simply unreachable. Now the crawl runs after
// boot, against this same in-memory index (no second copy of it in RAM), with a
// lower memory ceiling because the server is sharing the heap.
const autoFill = (process.env.AUTO_FILL ?? "1") !== "0";
if (autoFill) {
  const delayMs = Number.parseInt(process.env.FILL_DELAY_MS ?? "", 10) || CONFIG.storage.fillStartDelayMs;
  const minutes = Number.parseInt(process.env.FILL_MINUTES ?? "", 10) || CONFIG.storage.fillMaxMinutes;
  const budgetMb = Number.parseInt(process.env.FILL_BUDGET_MB ?? "", 10) || CONFIG.storage.indexBudgetMb;
  setTimeout(() => {
    // Never let a crawl bug take the server down with it.
    runFill(index, {
      maxMinutes: minutes,
      budgetMb,
      memoryPct: CONFIG.storage.fillMemoryPct,
      onProgress: (line) => console.log(line),
    })
      .then((r) => console.log(`auto-fill finished: +${r.docs} docs (${r.stoppedBecause})`))
      .catch((e) => console.error(`auto-fill failed, server unaffected: ${e?.message ?? e}`));
  }, delayMs);
  console.log(`  fill    background top-up in ${Math.round(delayMs / 1000)}s, up to ${minutes} min`);
}