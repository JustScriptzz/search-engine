import { crawl } from "./crawler/crawler.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { loadIndex, saveIndex, startServer } from "./server.ts";
import { tokenize } from "./index/tokenizer.ts";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

const cmd = process.argv[2];

if (cmd === "crawl") {
  const seedsFile = arg("--seeds", "seeds.txt")!;
  const max = parseInt(arg("--max", "100")!);
  const concurrency = parseInt(arg("--concurrency", "5")!);
  const sameHostOnly = process.argv.includes("--same-host-only");
  const seeds = (await Bun.file(seedsFile).text()).split("\n").map((s) => s.trim()).filter(Boolean);
  console.log(`Crawling ${seeds.length} seeds, max=${max}, concurrency=${concurrency}`);
  console.log(`Tokens demo:`, tokenize("Hello world, this is a search engine test"));
  const idx = await loadIndex();
  const { crawled, errors } = await crawl(seeds, idx, { maxPages: max, concurrency, sameHostOnly }, (doc, n) => {
    console.log(`[${n}] ${doc.title.slice(0, 60)} | ${doc.url}`);
  });
  await saveIndex(idx);
  console.log(`Done. crawled=${crawled} errors=${errors} docs=${idx.docCount} terms=${idx.stats().termCount}`);
} else if (cmd === "search") {
  const q = arg("--query", process.argv.slice(3).join(" "))!;
  if (!q) {
    console.error('Usage: bun src/cli.ts search --query "your keywords"');
    process.exit(1);
  }
  const idx = await loadIndex();
  const hits = idx.search(q, 10);
  console.log(`Query: "${q}" — ${hits.length} hits, index docs=${idx.docCount}`);
  for (const [i, h] of hits.entries()) {
    console.log(`\n${i + 1}. ${h.title}\n   ${h.url} (score ${h.score})\n   ${h.snippet.slice(0, 220)}`);
  }
} else if (cmd === "serve") {
  const port = parseInt(arg("--port", "3000")!);
  const idx = await loadIndex();
  const server = startServer(idx, port);
  console.log(`Search UI: http://localhost:${server.port}  (docs=${idx.docCount})`);
  console.log(`API: http://localhost:${server.port}/api/search?q=hello`);
} else {
  console.log(`Usage:
  bun src/cli.ts crawl [--seeds seeds.txt] [--max 100] [--concurrency 5] [--same-host-only]
  bun src/cli.ts search --query "keywords"
  bun src/cli.ts serve [--port 3000]`);
}
