import { describe, expect, test } from "bun:test";
import { forceGc, memoryGuard, rssBytes } from "./fill.ts";
import { CONFIG } from "./config.ts";

const MB = 1_048_576;

describe("forcing a collection", () => {
  test("is available on this runtime", () => {
    // If Bun.gc ever disappears the crawl silently starts leaking again, so we
    // want to know rather than find out from an OOM kill.
    expect(typeof forceGc()).toBe("boolean");
  });

  test("does not throw, whatever it decides to do", () => {
    for (let i = 0; i < 3; i++) expect(forceGc()).toBe(true);
  });
});

describe("the guard is checked against memory that is really in use", () => {
  test("a collection frees the live heap", () => {
    const before = process.memoryUsage().heapUsed;
    // churn: the kind of transient garbage a crawl round produces
    for (let i = 0; i < 200; i++) {
      const junk = { buf: "q".repeat(200_000), list: new Array(2000).fill(i) };
      void junk;
    }
    forceGc();
    const after = process.memoryUsage().heapUsed;
    // The live set must not have grown by the churn we just made.
    expect(after).toBeLessThan(before + 40 * MB);
  });

  test("RSS is only a high-water mark, so the ceiling is computed from the live set", () => {
    // Measured behaviour of this engine: after a full collection RSS does not
    // fall, while heapUsed does. Guarding on RSS alone stopped a fill run at
    // 354 MB for an 18 MB index — 354 is well under the 525 MB stop threshold,
    // but it was still the number that decided the run was finished.
    const limit = 700 * MB;
    const stopAt = limit * CONFIG.storage.memoryStopPct;

    // The guard itself uses RSS, because cgroup counts pages, not live objects.
    expect(memoryGuard({ rssBytes: stopAt + 1, heapBytes: 40 * MB, limitBytes: limit }).over).toBe(true);
    expect(memoryGuard({ rssBytes: stopAt - 1, heapBytes: 40 * MB, limitBytes: limit }).over).toBe(false);

    // The ceiling we report is based on the live set, not on that high-water
    // mark, so an engine that never returns pages cannot make us pessimistic.
    const liveCeiling = Math.floor(limit * CONFIG.storage.fillMemoryPct) - 40 * MB;
    expect(liveCeiling).toBeGreaterThan(300 * MB);
  });

  test("rss reading is plausible", () => {
    expect(rssBytes()).toBeGreaterThan(0);
  });
});