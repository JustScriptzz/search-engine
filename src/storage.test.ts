import { describe, expect, test } from "bun:test";
import {
  bytesPerDoc,
  canAfford,
  describeBudget,
  docsRemaining,
  estimateDocs,
  footprintOf,
  runAllowance,
} from "./storage.ts";
import { CONFIG } from "./config.ts";

const MB = 1_048_576;

describe("index footprint", () => {
  test("measures size in MB", () => {
    expect(footprintOf(10, 100, 2 * MB).mb).toBe(2);
    expect(bytesPerDoc(footprintOf(100, 1000, 10 * MB))).toBe(Math.round((10 * MB) / 100));
  });

  test("an empty index has no measured size per doc", () => {
    const empty = footprintOf(0, 0, 0);
    expect(bytesPerDoc(empty)).toBe(0);
    expect(docsRemaining(empty)).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("filling the gigabyte", () => {
  // A realistic measured index: ~44 KB per document with full text.
  const perDoc = 44 * 1024;
  const measured = footprintOf(2000, 500_000, 2000 * perDoc);

  test("room is computed from the measured rate", () => {
    const room = docsRemaining(measured, CONFIG.storage.indexBudgetMb);
    const expected = Math.floor((CONFIG.storage.indexBudgetMb * MB - measured.bytes) / perDoc);
    expect(room).toBe(expected);
    // Relative to the budget, not a magic number: at 500 MB the index holds ~11.6k
    // documents, at 620 MB ~14.4k. `room` is what is left *after* the 2000
    // already stored, so the check is that stored + room reaches capacity.
    const capacity = Math.floor((CONFIG.storage.indexBudgetMb * MB) / perDoc);
    expect(room + 2000).toBeGreaterThan(capacity - 10);
  });

  test("a full budget reports no room left", () => {
    const full = footprintOf(20_000, 5_000_000, CONFIG.storage.indexBudgetMb * MB);
    expect(docsRemaining(full)).toBe(0);
  });

  test("affordability stops the crawl before the disk fills", () => {
    expect(canAfford(measured, 1000)).toBe(true);
    expect(canAfford(measured, 100_000)).toBe(false);
  });

  test("one run is capped even when there is room", () => {
    const big = footprintOf(10, 100, 1 * MB);
    expect(runAllowance(big, 500)).toBe(500);
    expect(runAllowance(measured, 100_000)).toBeLessThan(100_000);
  });

  test("full text versus snippets is the real lever", () => {
    // Same 620 MB budget: full pages give far fewer documents than snippets.
    const full = estimateDocs({ budgetMb: CONFIG.storage.indexBudgetMb, fullText: true, bytesFullText: perDoc });
    const snip = estimateDocs({ budgetMb: CONFIG.storage.indexBudgetMb, fullText: false, bytesFullText: perDoc });
    expect(full).toBeLessThan(snip);
    expect(snip / full).toBeGreaterThan(8);
    expect(full).toBeGreaterThan(10_000);
  });

  test("the budget sentence names the numbers", () => {
    const s = describeBudget(measured);
    expect(s).toContain("KB/doc");
    expect(s).toContain(String(CONFIG.storage.indexBudgetMb));
  });

  test("the budget leaves headroom on a 1 GB disk", () => {
    // index file is rewritten on every save, so we need two copies plus runtime.
    expect(CONFIG.storage.indexBudgetMb + CONFIG.storage.minFreeMb).toBeLessThan(1024);
    expect(CONFIG.storage.minFreeMb).toBeGreaterThan(50);
  });
});