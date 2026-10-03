// Storage budgeting: how many documents fit, and when to stop.
//
// The VPS has about 1 GB of disk. A crawl that fills it takes the panel down
// with it, so the budget has to be arithmetic we can check, not a hope. This
// module answers three questions: how big is the index now, how much room is
// left, and can we afford another document.
import { CONFIG } from "./config.ts";

export interface IndexFootprint {
  docs: number;
  terms: number;
  bytes: number;
  mb: number;
}

export function footprintOf(docs: number, terms: number, bytes: number): IndexFootprint {
  return { docs, terms, bytes, mb: Math.round((bytes / 1_048_576) * 10) / 10 };
}

/** Measured bytes per document, from the index we actually have. */
export function bytesPerDoc(f: IndexFootprint): number {
  return f.docs > 0 ? Math.round(f.bytes / f.docs) : 0;
}

/** How many more documents fit in the remaining budget. */
export function docsRemaining(f: IndexFootprint, budgetMb: number = CONFIG.storage.indexBudgetMb): number {
  const room = budgetMb * 1_048_576 - f.bytes;
  const per = bytesPerDoc(f);
  if (per <= 0) return Number.POSITIVE_INFINITY; // nothing measured yet
  return Math.max(0, Math.floor(room / per));
}

/**
 * Full-text or snippets? Full text is roughly an order of magnitude larger per
 * document, so this is the real lever on corpus size: on a 1 GB disk you choose
 * between a few thousand pages you can actually read, or tens of thousands you
 * can only match against.
 */
export function estimateDocs(opts: {
  budgetMb: number;
  fullText: boolean;
  /** Bytes a document costs with full text, from measurement. */
  bytesFullText: number;
}): number {
  const per = opts.fullText ? opts.bytesFullText : Math.max(400, Math.round(opts.bytesFullText / 12));
  return Math.max(0, Math.floor((opts.budgetMb * 1_048_576) / per));
}

/** True when there is room for `count` more documents at the measured rate. */
export function canAfford(f: IndexFootprint, count: number, budgetMb: number = CONFIG.storage.indexBudgetMb): boolean {
  const per = bytesPerDoc(f);
  if (per <= 0) return count <= 2000; // first fill: allow a normal run
  return f.bytes + per * count <= budgetMb * 1_048_576;
}

/** Documents we can still add before hitting the budget, capped for one run. */
export function runAllowance(f: IndexFootprint, cap = 5000, budgetMb: number = CONFIG.storage.indexBudgetMb): number {
  return Math.min(cap, docsRemaining(f, budgetMb));
}

export function mb(bytes: number): number {
  return Math.round((bytes / 1_048_576) * 10) / 10;
}

/** Human sentence for the CLI and /api/doctor. */
export function describeBudget(f: IndexFootprint): string {
  const budget = CONFIG.storage.indexBudgetMb;
  const per = bytesPerDoc(f);
  const left = docsRemaining(f, budget);
  const perText = per ? `${Math.round(per / 1024)} KB/doc` : "unknown size";
  if (!Number.isFinite(left)) return `${f.mb} MB / ${budget} MB budget (${perText})`;
  return `${f.mb} MB of ${budget} MB used (${perText}), room for ~${left.toLocaleString("en-US")} more docs`;
}