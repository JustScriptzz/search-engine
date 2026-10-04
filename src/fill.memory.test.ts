import { describe, expect, test } from "bun:test";
import { memoryGuard, rssBytes } from "./fill.ts";
import { CONFIG } from "./config.ts";

const LIMIT = 700 * 1_048_576;

describe("memory guard", () => {
  test("well under the limit keeps going", () => {
    const g = memoryGuard({ rssBytes: 100 * 1_048_576, heapBytes: 0, limitBytes: LIMIT });
    expect(g.over).toBe(false);
    expect(g.rssMb).toBe(100);
  });

  test("stops before the kernel does", () => {
    // The OOM kill happened at ~80% of RAM; we must stop well before that.
    const pct = CONFIG.storage.memoryStopPct;
    expect(pct).toBeLessThanOrEqual(0.8);
    const g = memoryGuard({ rssBytes: LIMIT * pct, heapBytes: 0, limitBytes: LIMIT });
    expect(g.over).toBe(true);
  });

  test("just under the threshold is still allowed", () => {
    const g = memoryGuard({
      rssBytes: LIMIT * CONFIG.storage.memoryStopPct - 1,
      heapBytes: 0,
      limitBytes: LIMIT,
    });
    expect(g.over).toBe(false);
  });

  test("reports a usable percentage", () => {
    const g = memoryGuard({ rssBytes: LIMIT / 2, heapBytes: 0, limitBytes: LIMIT });
    expect(g.usedPct).toBe(50);
  });

  test("the default ceiling fits a 1 GB box with room for the server", () => {
    expect(CONFIG.storage.memoryLimitBytes).toBeLessThan(1024 * 1_048_576);
    expect(CONFIG.storage.memoryLimitBytes * CONFIG.storage.memoryStopPct).toBeLessThan(
      700 * 1_048_576,
    );
  });
});

describe("resident memory is readable", () => {
  test("rss is a plausible number for this process", () => {
    const rss = rssBytes();
    expect(rss).toBeGreaterThan(0);
    expect(rss).toBeLessThan(4 * 1_048_576 * 1_048_576);
  });
});