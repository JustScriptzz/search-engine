import { loadIndex, startServer } from "./src/server.ts";

// Pterodactyl entry point: the panel runs `bun run ${MAIN_FILE}` with no way
// to pass CLI args reliably, so read the allocated port from the environment.
const port = parseInt(process.env.SERVER_PORT ?? process.env.PORT ?? "3000", 10);
const idx = await loadIndex();
const server = startServer(idx, Number.isNaN(port) ? 3000 : port);
console.log(`MiniSearch listening on port ${server.port} (docs=${idx.docCount})`);
console.log(`API: /api/search?q=hello  Stats: /api/stats`);
