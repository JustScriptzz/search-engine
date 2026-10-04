import { crawl, bootstrapFamousSites } from "./crawler/crawler.ts";
import { CONFIG } from "./config.ts";
import { loadEnvFile } from "./env.ts";
import { runAgent } from "./ai.ts";
import { hasApiKey } from "./provider.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { loadIndex, saveIndex, startServer } from "./server.ts";
import { rejectDoc } from "./quality.ts";
import { discoverMany } from "./discovery.ts";
import { collectSitemapUrls, subdomainsFromCrt } from "./sitemaps.ts";
import { statSync } from "node:fs";
import { importHost } from "./ccimport.ts";
import { describeBudget, footprintOf, runAllowance } from "./storage.ts";
import { deadlineFromNow, hostQueue, memoryGuard, planFill, rssBytes } from "./fill.ts";
import { FAMOUS_SITES } from "./famous.ts";

await loadEnvFile();

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i !== -1 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

/** Expand discovered hosts via their published sitemaps. */
async function sitemapPass(urls: string[], maxHosts: number): Promise<string[]> {
  const hosts = new Map<string, string>();
  for (const u of urls) {
    try {
      const h = new URL(u).hostname.replace(/^www\./, "");
      hosts.set(h, `https://${h}/`);
    } catch {
      // ignore
    }
  }
  const picked = [...hosts.values()].slice(0, maxHosts);
  const out: string[] = [];
  for (const origin of picked) {
    const res = await collectSitemapUrls(origin, { maxUrls: CONFIG.discovery.sitemapUrlLimit });
    if (res.urls.length) console.error(`${origin}: ${res.urls.length} sitemap urls`);
    out.push(...res.urls);
  }
  return out;
}

/** Drop documents that today's filters reject. Used by `prune` and by `fill`
 *  between rounds, so a long run does not fill the budget with junk. */
async function pruneIndex(idx: InvertedIndex): Promise<number> {
  const before = idx.docCount;
  for (const doc of [...idx.docs.values()]) {
    const bad = rejectDoc(doc);
    if (bad.junk || bad.language || bad.lowQuality) idx.remove(doc.id);
  }
  return before - idx.docCount;
}

async function readSeeds(file: string | undefined): Promise<string[]> {
  if (!file) return [...CONFIG.seeds];
  const text = await Bun.file(file).text();
  const fromFile = text.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
  return fromFile.length > 0 ? fromFile : [...CONFIG.seeds];
}

const cmd = process.argv[2];

if (cmd === "sitemap" || cmd === "crt") {
  // Two cheap URL sources that need no crawling: published sitemaps and
  // certificate-transparency logs.
  const hosts = (arg("--hosts") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  if (hosts.length === 0) {
    console.error(cmd === "sitemap" ? "Usage: sitemap --hosts bbc.com,nasa.gov [--per-host 5000]" : "Usage: crt --hosts bbc.com [--limit 50]");
    process.exit(1);
  }
  const out = arg("--out");
  const all: string[] = [];
  for (const host of hosts) {
    const origin = host.startsWith("http") ? host : `https://${host}`;
    if (cmd === "sitemap") {
      const res = await collectSitemapUrls(origin, { maxUrls: parseInt(arg("--per-host", "5000")!) });
      console.error(`${host}: ${res.urls.length} urls from ${res.sitemaps} sitemaps (${res.errors.length} unreadable)`);
      all.push(...res.urls);
    } else {
      const res = await subdomainsFromCrt(host, parseInt(arg("--limit", "50")!));
      if (res.error) console.error(`${host}: ${res.error}`);
      console.error(`${host}: ${res.urls.length} subdomains`);
      all.push(...res.urls);
    }
  }
  const unique = [...new Set(all)];
  console.error(`total unique urls: ${unique.length}`);
  if (out) {
    await Bun.write(out, unique.join("\n"));
    console.error(`wrote ${out} (${(unique.join("\n").length / 1e6).toFixed(1)} MB on disk)`);
  } else for (const u of unique) console.log(u);
} else if (cmd === "plan") {
  // Discovery only: build a URL frontier on disk without fetching a page.
  const perPattern = parseInt(arg("--per-pattern", String(CONFIG.discovery.perPattern))!);
  const patterns = (arg("--patterns") ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  const list = patterns.length ? patterns : CONFIG.discovery.topicPatterns;
  const res = await discoverMany(list, perPattern);
  if (res.collection) console.log(`collection: ${res.collection}`);
  for (const f of res.failures) console.error(`  ! ${f}`);
  const extra = await sitemapPass(res.urls, parseInt(arg("--sitemaps", "25")!));
  const all = [...new Set([...res.urls, ...extra])];
  const out = arg("--out", "data/discovered.txt")!;
  await Bun.write(out, all.join("\n"));
  const bytes = all.join("\n").length;
  console.log(
    `${all.length} urls -> ${out} (${(bytes / 1e6).toFixed(1)} MB). ` +
      `Fetched nothing yet; run: bun src/cli.ts crawl --seeds ${out}`,
  );
} else if (cmd === "discover") {
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
} else if (cmd === "ccimport") {
  // Index pages we may not crawl, from Common Crawl's WARC storage instead.
  // Instagram, Reddit, X, Facebook and Pinterest all answer "Disallow: /" to
  // every crawler; this gets their real page text without ever contacting them.
  const hosts = (arg("--hosts") ?? "").split(",").map((h) => h.trim()).filter(Boolean);
  const perHost = parseInt(arg("--per-host", String(CONFIG.storage.bulkPerHost * 25))!);
  if (hosts.length === 0) {
    console.error("Usage: ccimport --hosts instagram.com,tiktok.com [--per-host 50] [--collection CC-MAIN-...]");
    process.exit(1);
  }
  const collection = arg("--collection") ?? undefined;
  const idx = await loadIndex();
  let added = 0;
  let skipped = 0;
  for (const host of hosts) {
    const res = await importHost(idx, host, {
      perHost,
      collection,
      onDoc: (url, title) => console.log(`[cc] ${title.slice(0, 60)} | ${url}`),
    });
    if (res.error) console.error(`${host}: ${res.error}`);
    else console.error(`${host}: +${res.added} of ${res.found} records (${res.skipped} skipped)`);
    added += res.added;
    skipped += res.skipped;
  }
  await saveIndex(idx);
  const s = idx.stats();
  console.log(`ccimport done. added=${added} skipped=${skipped} docs=${s.docCount} terms=${s.termCount}`);
} else if (cmd === "fill") {
  // Fill the disk budget, in the order that makes an index worth having:
  // sitemaps of the hosts we chose, then Common Crawl depth on the same hosts,
  // and only then the long tail (which is opt-in, because that is where the
  // link-farm spam lives). Stops on its own when the budget or the clock is up.
  const budgetMb = parseInt(arg("--budget-mb", String(CONFIG.storage.indexBudgetMb))!);
  const maxMinutes = parseInt(arg("--max-minutes", String(CONFIG.storage.fillMaxMinutes))!);
  const longTail = process.argv.includes("--long-tail");
  const maxPages = parseInt(arg("--max-pages", "100000")!);
  const perHost = parseInt(arg("--per-host", String(CONFIG.storage.fillSitemapPerHost))!);
  const idx = await loadIndex();
  const deadline = deadlineFromNow(maxMinutes);
  const seedHosts = [...new Set(CONFIG.seeds.map((u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  }).filter(Boolean))];
  const done = new Set<string>();
  let discoverRounds = 0;
  let fetched = 0;
  let round = 0;

  console.log(
    `fill: budget ${budgetMb} MB, ${maxMinutes} min, ${seedHosts.length} curated hosts` +
      `${longTail ? ", long tail enabled" : ""}`,
  );

  while (true) {
    let bytes = 0;
    try {
      bytes = statSync(CONFIG.server.indexPath).size;
    } catch {
      // first run
    }
    const fp = footprintOf(idx.docCount, idx.index.size, bytes);
    const decision = planFill(
      {
        footprint: fp,
        budgetMb,
        triedHosts: done.size,
        totalHosts: seedHosts.length,
        longTail,
        deadline,
        fetched,
        maxPages,
        discoverRounds,
      },
      Date.now(),
    );
    round++;
    if (decision.phase === "done") {
      console.log(`fill: stopping — ${decision.reason}`);
      break;
    }

    // RAM check between rounds: finish cleanly and save, rather than being
    // OOM-killed halfway through a sitemap.
    const mem = memoryGuard({ rssBytes: rssBytes(), heapBytes: 0, limitBytes: CONFIG.storage.memoryLimitBytes });
    if (mem.over) {
      await saveIndex(idx);
      console.log(`fill: stopping — memory at ${mem.usedPct}% of ${CONFIG.storage.memoryLimitBytes / 1_048_576} MB (${mem.rssMb} MB rss)`);
      console.log(`fill: index saved with ${idx.docCount} docs; restart to continue filling`);
      break;
    }

    let urls: string[] = [];
    if (decision.phase === "sitemaps") {
      // One host per round keeps the loop resumable and the log readable.
      const host = hostQueue(seedHosts, done)[0];
      if (!host) {
        done.add("__none__");
        continue;
      }
      done.add(host);
      const res = await collectSitemapUrls(`https://${host}`, { maxUrls: perHost });
      urls = res.urls;
      if (res.errors.length) console.error(`  ${host}: ${res.errors.length} unreadable sitemaps`);
    } else if (decision.phase === "discover") {
      discoverRounds++;
      const patterns = seedHosts
        .filter((h) => !done.has(`cc:${h}`))
        .slice(0, 40)
        .map((h) => `*.${h}/*`);
      if (patterns.length === 0) {
        done.add("__none__");
        continue;
      }
      const res = await discoverMany(patterns, Math.ceil(decision.batch / patterns.length));
      urls = res.urls;
      for (const h of patterns) done.add(`cc:${h.replace(/^\*\./, "").replace(/\/\*$/, "")}`);
      if (res.collection) console.log(`  discovery round ${discoverRounds}: ${res.collection}`);
    } else {
      const res = await discoverMany(CONFIG.discovery.topicPatterns, Math.ceil(decision.batch / CONFIG.discovery.topicPatterns.length));
      urls = res.urls;
    }

    const room = Math.max(20, decision.batch);
    const batch = urls.slice(0, room);
    if (batch.length === 0) {
      console.log(`round ${round}: ${decision.phase} found nothing new`);
      continue;
    }
    const before = idx.docCount;
    const res = await crawl(
      batch,
      idx,
      {
        maxPages: batch.length,
        concurrency: CONFIG.crawl.concurrency,
        maxPagesPerHost: CONFIG.storage.bulkPerHost * 10,
        sameHostOnly: false,
      },
      () => {},
    );
    fetched += res.crawled + res.errors;
    // Save between rounds: a fill run is long, and losing it all to one bad boot
    // would be miserable. prune every few rounds keeps junk from accumulating.
    let pruned = 0;
    if (round % 3 === 0 || idx.docCount === before) pruned = await pruneIndex(idx);
    else await saveIndex(idx);
    const net = idx.docCount - before;
    const gained = `${net >= 0 ? "+" : ""}${net}`;
    console.log(
      `round ${round} (${decision.phase}): ${gained} docs` +
        `${pruned ? `, ${pruned} pruned` : ""}, ` +
        describeBudget(footprintOf(idx.docCount, idx.index.size, statSync(CONFIG.server.indexPath).size)),
    );
  }

  await pruneIndex(idx);
  await saveIndex(idx);
  const s = idx.stats();
  console.log(`fill done. rounds=${round} fetched=${fetched} docs=${s.docCount} terms=${s.termCount}`);
  console.log(describeBudget(footprintOf(idx.docCount, idx.index.size, statSync(CONFIG.server.indexPath).size)));
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
  // Stop before the disk fills: the index file is rewritten on every save, so
  // overrunning the budget takes the panel down, not just the crawl.
  let bytes = 0;
  try {
    bytes = statSync(CONFIG.server.indexPath).size;
  } catch {
    // first run, no file yet
  }
  const before = footprintOf(idx.docCount, idx.index.size, bytes);
  const affordable = process.argv.includes("--no-budget")
    ? max
    : Math.min(max, Math.max(50, runAllowance(before)));
  if (affordable < max) {
    console.log(describeBudget(before));
    console.log(`budget allows ${affordable} pages this run (--max was ${max})`);
  }

  const result = await crawl(
    seeds,
    idx,
    { maxPages: affordable, concurrency, sameHostOnly },
    (doc, n) => console.log(`[${n}] ${(doc.title || doc.url).slice(0, 70)} | ${doc.url}`),
  );
  await saveIndex(idx);
  const s = idx.stats();
  console.log(
    `Done. crawled=${result.crawled} errors=${result.errors} skippedLanguage=${result.skippedLanguage} ` +
      `skippedRobots=${result.skippedRobots} docs=${s.docCount} terms=${s.termCount}`,
  );
  console.log(describeBudget(footprintOf(idx.docCount, idx.index.size, statSync(CONFIG.server.indexPath).size)));
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