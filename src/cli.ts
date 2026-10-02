import { crawl } from "./crawler/crawler.ts";
import { CONFIG } from "./config.ts";
import { runAgent } from "./ai.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { loadIndex, saveIndex, startServer } from "./server.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

async function readSeeds(file: string | undefined): Promise<string[]> {
  if (!file) return [...CONFIG.seeds];
  const text = await Bun.file(file).text();
  const fromFile = text.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  return fromFile.length > 0 ? fromFile : [...CONFIG.seeds];
}

const cmd = process.argv[2];

if (cmd === "crawl") {
  const seeds = await readSeeds(arg("--seeds"));
  const max = parseInt(arg("--max", String(CONFIG.crawl.maxPages))!);
  const concurrency = parseInt(arg("--concurrency", String(CONFIG.crawl.concurrency))!);
  const sameHostOnly = process.argv.includes("--same-host-only") || CONFIG.crawl.sameHostOnly;
  console.log(`${CONFIG.name} ${CONFIG.version} — crawling ${seeds.length} seeds (max=${max}, concurrency=${concurrency})`);
  const idx = await loadIndex();
  const result = await crawl(
    seeds,
    idx,
    { maxPages: max, concurrency, sameHostOnly },
    (doc, n) => console.log(`[${n}] ${(doc.title || doc.url).slice(0, 70)} | ${doc.url}`),
  );
  await saveIndex(idx);
  const s = idx.stats();
  console.log(
    `Done. crawled=${result.crawled} errors=${result.errors} skippedLanguage=${result.skippedLanguage} ` +
      `skippedRobots=${result.skippedRobots} docs=${s.docCount} terms=${s.termCount}`,
  );
} else if (cmd === "search") {
  const q = arg("--query", process.argv.slice(3).join(" "))!;
  if (!q) {
    console.error('Usage: bun src/cli.ts search --query "your keywords"');
    process.exit(1);
  }
  const idx = await loadIndex();
  const hits = idx.search(q, CONFIG.ui.defaultLimit);
  console.log(`"${q}" — ${hits.length} hits from ${idx.docCount} docs\n`);
  for (const [i, h] of hits.entries()) {
    console.log(`${i + 1}. ${h.title}\n   ${h.url}  (score ${h.score})\n   ${h.snippet}\n`);
  }
} else if (cmd === "ask") {
  const question = arg("--query", process.argv.slice(3).join(" "))!;
  if (!question) {
    console.error('Usage: bun src/cli.ts ask "your question"');
    process.exit(1);
  }
  const idx = await loadIndex();
  const answer = await runAgent({
    message: question,
    index: idx,
    onEvent: (e) => {
      if (e.type === "status") console.error(`… ${e.text}`);
      if (e.type === "tool") console.error(`→ ${e.name} ${JSON.stringify(e.args)}`);
      if (e.type === "error") console.error(`! ${e.message}`);
    },
  });
  console.log(answer || "(no answer)");
} else if (cmd === "serve") {
  const port = Number(arg("--port", String(CONFIG.server.port))!);
  const idx = await loadIndex();
  const server = startServer(idx, port);
  console.log(`${CONFIG.name} on http://localhost:${server.port}  (docs=${idx.docCount})`);
  console.log(`  GET  /api/search?q=hello`);
  console.log(`  GET  /api/stats`);
  console.log(`  POST /api/chat  {"message":"..."}  (SSE, ${CONFIG.ai.model} @ ${CONFIG.ai.baseUrl})`);
} else {
  console.log(`${CONFIG.name} ${CONFIG.version}

  bun src/cli.ts crawl [--seeds file] [--max 2000] [--concurrency 3] [--same-host-only]
  bun src/cli.ts search --query "keywords"
  bun src/cli.ts ask "question"          # MiniSearch AI agent, uses the index
  bun src/cli.ts serve [--port 3000]
`);
}