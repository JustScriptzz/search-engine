// The fill loop, as a function, so the *running server* can top itself up.
//
// This used to live in the CLI and be run by sync.sh as the build step, which
// meant the server could not start until a 25-minute crawl finished — the site
// was unreachable for the whole of it, every boot. So the loop lives here, the
// server calls it in the background against its own in-memory index (no second
// copy in RAM), and the build step only does the cheap prune.
//
// Everything here mutates the index that is serving traffic, so it saves after
// each round and never throws past the caller.
import { CONFIG } from "./config.ts";
import { statSync } from "node:fs";
import { crawl } from "./crawler/crawler.ts";
import { collectSitemapUrls } from "./sitemaps.ts";
import { discoverMany } from "./discovery.ts";
import { rejectDoc } from "./quality.ts";
import { deadlineFromNow, forceGc, hostQueue, memoryGuard, planFill, resolveLimit, rssBytes } from "./fill.ts";
import { describeLimit } from "./memory.ts";
import { describeBudget, footprintOf, type IndexFootprint } from "./storage.ts";
import { saveIndex } from "./server.ts";
import { embedAll, embeddingsEnabled, storeVector } from "./embed.ts";
import type { CrawledDoc } from "./types.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";

export interface FillOptions {
  budgetMb?: number;
  maxMinutes?: number;
  longTail?: boolean;
  perHost?: number;
  maxPages?: number;
  /**
   * Fraction of the memory ceiling this run may use. Lower than the CLI's,
   * because the server is sharing the box and must stay responsive.
   */
  memoryPct?: number;
  onProgress?: (line: string) => void;
  signal?: { stopped: boolean };
}

/**
 * Attach vectors to pages that do not have one yet.
 *
 * Done in the same pass as the crawl, on purpose: a backfill job would mean a
 * second full read of the corpus and a second set of requests. Returns how many
 * were embedded, and never throws — a semantic layer that is missing or slow
 * must not stop the crawl.
 */
export async function embedNewDocs(idx: InvertedIndex, sinceCount: number): Promise<number> {
  if (!CONFIG.embeddings.embedOnCrawl || !embeddingsEnabled()) return 0;
  const pending: CrawledDoc[] = [];
  for (const doc of idx.docs.values()) {
    if (!doc.vec && doc.text.trim().length > 0) pending.push(doc);
    // Bound the work per round so one pass cannot become a memory event.
    if (pending.length >= 200) break;
  }
  if (pending.length === 0) return 0;

  const vectors = await embedAll(pending.map((d) => `${d.title}. ${d.text}`));
  if (!vectors || vectors.length !== pending.length) return 0;
  let n = 0;
  for (let i = 0; i < pending.length; i++) {
    const vec = vectors[i];
    if (!vec || vec.length === 0) continue;
    pending[i].vec = storeVector(vec);
    n++;
  }
  return n;
}

export interface FillResult {
  rounds: number;
  fetched: number;
  added: number;
  docs: number;
  stoppedBecause: string;
}

/** Drop documents that today's filters reject. Used between rounds and at the end. */
export function pruneIndex(idx: InvertedIndex): number {
  const before = idx.docCount;
  for (const doc of [...idx.docs.values()]) {
    const bad = rejectDoc(doc);
    if (bad.junk || bad.language || bad.lowQuality) idx.remove(doc.id);
  }
  return before - idx.docCount;
}

function indexBytes(): number {
  try {
    return statSync(CONFIG.server.indexPath).size;
  } catch {
    return 0;
  }
}

function footprint(idx: InvertedIndex): IndexFootprint {
  return footprintOf(idx.docCount, idx.index.size, indexBytes());
}

function seedHostList(): string[] {
  return [
    ...new Set(
      CONFIG.seeds.map((u) => {
        try {
          return new URL(u).hostname.replace(/^www\./, "");
        } catch {
          return "";
        }
      }).filter(Boolean),
    ),
  ];
}

export async function runFill(idx: InvertedIndex, opts: FillOptions = {}): Promise<FillResult> {
  const budgetMb = opts.budgetMb ?? CONFIG.storage.indexBudgetMb;
  const maxMinutes = opts.maxMinutes ?? CONFIG.storage.fillMaxMinutes;
  const longTail = opts.longTail ?? false;
  const perHost = opts.perHost ?? CONFIG.storage.fillSitemapPerHost;
  const maxPages = opts.maxPages ?? 100_000;
  const log = opts.onProgress ?? ((l: string) => console.log(l));

  const limit = resolveLimit();
  // The server is running and answering queries from this same heap, so the
  // crawler gets a smaller slice than it would if it owned the machine.
  const ceiling = Math.floor(limit.bytes * (opts.memoryPct ?? CONFIG.storage.memoryStopPct));

  const seedHosts = seedHostList();
  const done = new Set<string>();
  const deadline = deadlineFromNow(maxMinutes);
  let discoverRounds = 0;
  let fetched = 0;
  let round = 0;
  let added = 0;
  let stoppedBecause = "unknown";

  log(
    `fill: budget ${budgetMb} MB, ${maxMinutes} min, ${seedHosts.length} curated hosts, ` +
      `memory ${describeLimit(limit)} (crawler ceiling ${Math.round((ceiling / 1_048_576) * 10) / 10} MB)` +
      `${longTail ? ", long tail" : ""}`,
  );

  const startDocs = idx.docCount;
  while (!opts.signal?.stopped) {
    const decision = planFill(
      {
        footprint: footprint(idx),
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
      stoppedBecause = decision.reason ?? "done";
      break;
    }

    const mem = memoryGuard({ rssBytes: rssBytes(), heapBytes: 0, limitBytes: ceiling });
    if (mem.over) {
      await saveIndex(idx);
      stoppedBecause = `memory at ${mem.usedPct}% of the crawler ceiling (${mem.rssMb} MB rss)`;
      break;
    }

    let urls: string[] = [];
    if (decision.phase === "sitemaps") {
      const host = hostQueue(seedHosts, done)[0];
      if (!host) {
        done.add("__none__");
        continue;
      }
      done.add(host);
      const res = await collectSitemapUrls(`https://${host}`, { maxUrls: perHost });
      urls = res.urls;
    } else if (decision.phase === "discover") {
      discoverRounds++;
      const hosts = seedHosts.filter((h) => !done.has(`cc:${h}`)).slice(0, 40);
      if (hosts.length === 0) {
        done.add("__none__");
        continue;
      }
      const patterns = hosts.map((h) => `*.${h}/*`);
      const res = await discoverMany(patterns, Math.ceil(decision.batch / patterns.length));
      urls = res.urls;
      for (const h of hosts) done.add(`cc:${h}`);
    } else {
      const patterns = CONFIG.discovery.topicPatterns;
      const res = await discoverMany(patterns, Math.ceil(decision.batch / Math.max(1, patterns.length)));
      urls = res.urls;
    }

    const batch = urls.slice(0, Math.max(20, decision.batch));
    if (batch.length === 0) continue;

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
    const embedded = await embedNewDocs(idx, before);
    const pruned = round % 3 === 0 || idx.docCount === before ? pruneIndex(idx) : 0;
    // Collect before measuring: RSS is a high-water mark in this engine, so the
    // guard below would otherwise stop the run on memory that is already free.
    forceGc();
    // Save every round: the index is the only thing worth keeping, and a save
    // is atomic now.
    if (pruned === 0) await saveIndex(idx);
    const net = idx.docCount - before;
    added += Math.max(0, net);
    log(`fill: round ${round} (${decision.phase}) ${net >= 0 ? "+" : ""}${net} docs${pruned ? `, ${pruned} pruned` : ""} — ${describeBudget(footprint(idx))}`);
  }

  pruneIndex(idx);
  await saveIndex(idx);
  log(`fill: done after ${round} rounds — ${stoppedBecause}. ${describeBudget(footprint(idx))}`);
  return { rounds: round, fetched, added, docs: idx.docCount - startDocs, stoppedBecause };
}