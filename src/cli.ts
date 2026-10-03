import { crawl, bootstrapFamousSites } from "./crawler/crawler.ts";
import { CONFIG } from "./config.ts";
import { loadEnvFile } from "./env.ts";
import { runAgent } from "./ai.ts";
import { hasApiKey } from "./provider.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { loadIndex, saveIndex, startServer } from "./server.ts";
import { rejectDoc } from "./quality.ts";
import { discoverMany } from "./discovery.ts";
import { FAMOUS_SITES } from "./famous.ts";

await loadEnvFile();

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

if (cmd === "discover") {
  // Ask the Common Crawl index for real URLs instead of relying on a seed list.
  const limit = parseInt(arg("--per-pattern", String(CONFIG.discovery.perPattern))!);
  const topics = arg("--patterns")?.split(",").map((t) => t.trim()).filter(Boolean);
  const patterns = topics?.length ? topics : [
    ...FAMOUS_SITES.slice(0, 20).map((s) => `*.${new URL(s.url).hostname.replace(/^www\./, "")}/*`),
    ...CONFIG.discovery.topicPatterns,
  ];
  console.log(`Discovering via Common Crawl across ${patterns.length} patterns...`);
  const res = await discoverMany(patterns, limit);
  if (res.collection) console.log(`collection: ${res.collection}`);
  for (const f of res.failures) console.error(`  ! ${f}`);
  console.log(`found ${res.urls.length} URLs`);
  const out = arg("--out");
  if (out) {
    await Bun.write(out, res.urls.join("\n"));
    console.log(`wrote ${out}`);
  } else {
    for (const u of res.urls) console.log(u);
  }
} else if (cmd === "prune") {
  // Clean an index built with older filters: junk URLs, non-Latin pages and
  // boilerplate stubs are dropped in place, no re-crawl needed.
  const idx = await loadIndex();
  const before = idx.docCount;
  const removed: Record<string, number> = { junk: 0, language: 0, lowQuality: 0 };
  for (const doc of [...idx.docs.values()]) {
    const bad = rejectDoc(doc);
    const key = bad.junk ? "junk" : bad.language ? "language" : bad.lowQuality ? "lowQuality" : null;
    if (key) {
      idx.remove(doc.id);
      removed[key]++;
    }
  }
  await saveIndex(idx);
  const s = idx.stats();
  console.log(
    `Pruned ${before - idx.docCount} of ${before} docs ` +
      `(junk=${removed.junk} language=${removed.language} lowQuality=${removed.lowQuality}). ` +
      `Left ${s.docCount} docs / ${s.termCount} terms.`,
  );
} else if (cmd === "crawl") {
  let seeds = await readSeeds(arg("--seeds"));
  // Optional web-scale discovery: pull real URLs from the Common Crawl index.
  if (process.argv.includes("--discover")) {
    const perPattern = parseInt(arg("--discover-limit", String(CONFIG.discovery.perPattern))!);
    console.log(`discovering URLs (per pattern: ${perPattern})...`);
    const found = await discoverMany(CONFIG.discovery.topicPatterns, perPattern);
    if (found.collection) console.log(`collection: ${found.collection}`);
    for (const f of found.failures) console.error(`  ! ${f}`);
    console.log(`discovered ${found.urls.length} URLs; adding to seeds`);
    seeds = [...new Set([...seeds, ...found.urls])];
  }
  const max = parseInt(arg("--max", String(CONFIG.crawl.maxPages))!);
  const concurrency = parseInt(arg("--concurrency", String(CONFIG.crawl.concurrency))!);
  const sameHostOnly = process.argv.includes("--same-host-only") || CONFIG.crawl.sameHostOnly;
  console.log(`${CONFIG.name} ${CONFIG.version} — crawling ${seeds.length} seeds (max=${max}, concurrency=${concurrency})`);
  const idx = await loadIndex();
  // Guaranteed pass for allowlisted site roots before the wide crawl.
  if (!process.argv.includes("--no-bootstrap")) {
    const boot = await bootstrapFamousSites(idx, {
      onPage: (doc) => console.log(`  [site] ${doc.title.slice(0, 50)} | ${doc.url}`),
    });
    if (boot.fetched || boot.failed) {
      console.log(`bootstrap: ${boot.fetched} site cards, ${boot.failed} unreachable/blocked`);
      await saveIndex(idx);
    }
  }
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
  console.log(`  POST /api/chat  {"message":"..."}  (SSE agent, ${hasApiKey() ? "ready" : "no credentials"})`);
} else {
  console.log(`${CONFIG.name} ${CONFIG.version}

  bun src/cli.ts crawl [--seeds file] [--max 2000] [--concurrency 3] [--same-host-only]
  bun src/cli.ts search --query "keywords"
  bun src/cli.ts ask "question"          # MiniSearch AI agent, uses the index
  bun src/cli.ts serve [--port 3000]
`);
}