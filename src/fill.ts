// The fill plan: how to spend a disk budget, in the right order.
//
// "Fill 500 MB" sounds like one thing you turn on, but the order sources are
// tried in decides what the index is worth. Sitemaps of sites we chose are the
// best URLs on the web — real pages, no guessing. The Common Crawl index gives
// depth on the same hosts. The long tail (every topic pattern anyone ever
// published) is where NIH grant-spam link farms live, so it is opt-in.
//
// The loop is deliberately simple and resumable: work out what to do next,
// do it, look at the disk, repeat. Each step is small enough to survive a
// restart, and the budget check is arithmetic rather than a hope.
import { CONFIG } from "./config.ts";
import { docsRemaining, type IndexFootprint } from "./storage.ts";
import { describeLimit, memoryLimit, type MemoryLimit } from "./memory.ts";

export type FillPhase = "sitemaps" | "discover" | "longtail" | "done";

export interface FillPlanInput {
  footprint: IndexFootprint;
  budgetMb: number;
  /** Pages already harvested for the host currently being worked on. */
  triedHosts: number;
  /** Total hosts in the allowlist. */
  totalHosts: number;
  /** Allow the long tail. Off by default. */
  longTail: boolean;
  /** Wall-clock budget for the whole run. */
  deadline: number;
  /** Pages fetched so far this run. */
  fetched: number;
  /** Page cap for the whole run, as a backstop against a hung run. */
  maxPages: number;
  /** How many Common Crawl passes have run. Bounded, so phases can sequence. */
  discoverRounds: number;
}

export interface FillDecision {
  phase: FillPhase;
  /** Why we stopped, when phase is "done". */
  reason?: string;
  /** How many URLs to request in this step. */
  batch: number;
}

export function planFill(input: FillPlanInput, now = Date.now()): FillDecision {
  const { footprint, budgetMb, triedHosts, totalHosts, deadline, fetched, maxPages } = input;

  if (fetched >= maxPages) return { phase: "done", reason: `page cap reached (${maxPages})`, batch: 0 };
  if (now >= deadline) return { phase: "done", reason: "time budget reached", batch: 0 };

  const room = docsRemaining(footprint, budgetMb);
  if (room <= 0) {
    return { phase: "done", reason: `disk budget reached: ${footprint.mb} MB of ${budgetMb} MB`, batch: 0 };
  }
  // Stop while there is still room for a few more pages: the index file is
  // rewritten on every save, so the last batch must not be the one that fills
  // the disk past the headroom we reserved.
  if (room <= 50) return { phase: "done", reason: `only ${room} docs of headroom left`, batch: 0 };

  // Sitemaps first: the highest-quality URLs available, and the only source
  // that does not need a wildcard query.
  if (triedHosts < totalHosts) {
    return { phase: "sitemaps", batch: Math.min(CONFIG.storage.fillSitemapPerHost, Math.max(20, room)) };
  }
  // Then depth on the same allowlisted hosts via the Common Crawl index, for a
  // bounded number of rounds so the later phases are actually reachable.
  if (input.discoverRounds < CONFIG.storage.fillDiscoverRounds && room > 500) {
    return { phase: "discover", batch: Math.min(400, Math.max(50, room)) };
  }
  // The long tail only when asked for, and only with real room to spend.
  if (input.longTail && room > 2000) {
    return { phase: "longtail", batch: Math.min(2000, Math.max(200, room)) };
  }
  return { phase: "done", reason: "no more curated sources to harvest", batch: 0 };
}

/** Hosts to work through, in allowlist order, skipping the ones already done. */
export function hostQueue(seedHosts: string[], skip: Set<string>): string[] {
  return seedHosts.filter((h) => !skip.has(h));
}

/**
 * Stop before the kernel does.
 *
 * The first fill run on the VPS was killed by the OOM killer at round 8: the
 * whole index lives in memory, and one save stringifies all of it at once. A
 * silent kill loses the run and looks like a crash, so the loop checks its own
 * footprint between rounds and finishes cleanly, with the index saved.
 */
export function memoryGuard(input: {
  rssBytes: number;
  heapBytes: number;
  /** Ceiling for RSS, in bytes. */
  limitBytes: number;
}): { over: boolean; usedPct: number; rssMb: number } {
  const rssMb = Math.round((input.rssBytes / 1_048_576) * 10) / 10;
  const usedPct = Math.round((input.rssBytes / input.limitBytes) * 100);
  return { over: input.rssBytes >= input.limitBytes * CONFIG.storage.memoryStopPct, usedPct, rssMb };
}

/** Resident memory right now, in bytes. */
export function rssBytes(): number {
  return process.memoryUsage().rss;
}

/**
 * Collect garbage now, and report whether it worked.
 *
 * JavaScriptCore does not return freed pages to the OS, so RSS is a high-water
 * mark: measured here, RSS stayed at 56 MB after a full GC while the live heap
 * dropped from 6 MB to 0. Without an explicit collection between crawl rounds
 * the crawler keeps asking for fresh pages, RSS climbs, and the memory guard
 * stops the run even though there is plenty of free memory — which is how an
 * 18 MB index came to sit at 354 MB RSS. Collecting between rounds lets the
 * engine reuse the pages instead, and RSS plateaus.
 */
export function forceGc(): boolean {
  const gc = (Bun as unknown as { gc?: (force?: boolean) => void }).gc;
  if (typeof gc !== "function") return false;
  try {
    gc(true);
    return true;
  } catch {
    return false;
  }
}

/**
 * The ceiling we enforce, resolved once per run.
 *
 * CONFIG says how much we are willing to use; cgroup says how much we are
 * allowed. The smaller wins, because a guard set above the real limit never
 * fires and the kernel kills the process instead — which is what happened on
 * the first fill run at a mere 100 MB of steady-state usage.
 */
export function resolveLimit(configured = CONFIG.storage.memoryLimitBytes): MemoryLimit {
  return memoryLimit(configured);
}

/** A deadline the loop can check cheaply on every step. */
export function deadlineFromNow(minutes: number, now = Date.now()): number {
  return now + Math.max(1, minutes) * 60_000;
}