import { loadEnvFile } from "./src/env.ts";
import { CONFIG } from "./src/config.ts";
import { loadIndex, startServer } from "./src/server.ts";

await loadEnvFile();

// Pterodactyl entry point: the panel runs `bun run ${MAIN_FILE}` with no way
// to pass CLI args, so the allocated port comes from the environment.
const raw = process.env.SERVER_PORT ?? process.env.PORT ?? String(CONFIG.server.port);
const parsed = Number.parseInt(raw, 10);
const port = Number.isFinite(parsed) ? parsed : CONFIG.server.port;

const index = await loadIndex();
const server = startServer(index, port);
const { hasApiKey } = await import("./src/provider.ts");

console.log(`${CONFIG.name} listening on port ${server.port} (docs=${index.docCount})`);
console.log(`  UI      /`);
console.log(`  search  /api/search?q=hello`);
console.log(`  stats   /api/stats`);
console.log(`  agent   POST /api/chat {"message":"..."} — ${hasApiKey() ? "ready" : "no credentials, index-only answers"}`);