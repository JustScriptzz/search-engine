import { describe, expect, test } from "bun:test";
import { deadlineFromNow, hostQueue, planFill } from "./fill.ts";
import { footprintOf } from "./storage.ts";
import { CONFIG } from "./config.ts";

const budget = CONFIG.storage.indexBudgetMb;
const perDoc = 44 * 1024;

/** An index with `docs` full-text documents in it. */
const withDocs = (docs: number) => footprintOf(docs, docs * 50, docs * perDoc);
const T0 = 1_000_000_000;
const base = {
  budgetMb: budget,
  triedHosts: 0,
  totalHosts: 134,
  longTail: false,
  deadline: T0 + 60_000,
  fetched: 0,
  maxPages: 100_000,
  discoverRounds: 0,
};

describe("fill plan", () => {
  test("sitemaps come before anything else", () => {
    const d = planFill({ ...base, footprint: withDocs(10) }, T0);
    expect(d.phase).toBe("sitemaps");
  });

  test("Common Crawl discovery comes after every host has had its sitemap", () => {
    const d = planFill({ ...base, footprint: withDocs(10), triedHosts: 134 }, T0);
    expect(d.phase).toBe("discover");
  });

  test("the long tail is opt-in only", () => {
    const room = withDocs(1000);
    const done = { ...base, footprint: room, triedHosts: 999, discoverRounds: 99 };
    expect(planFill({ ...done, longTail: false }, T0).phase).not.toBe("longtail");
    expect(planFill({ ...done, longTail: true }, T0).phase).toBe("longtail");
  });

  test("phases sequence: sitemaps, then discovery, then the long tail", () => {
    const seen: string[] = [];
    let triedHosts = 0;
    let discoverRounds = 0;
    for (let i = 0; i < 20; i++) {
      const d = planFill(
        { ...base, footprint: withDocs(1000), triedHosts, discoverRounds, longTail: true },
        T0,
      );
      if (d.phase === "done") break;
      seen.push(d.phase);
      if (d.phase === "sitemaps") triedHosts = 134;
      if (d.phase === "discover") discoverRounds++;
    }
    const rounds = CONFIG.storage.fillDiscoverRounds;
    expect(seen[0]).toBe("sitemaps");
    expect(seen.slice(1, 1 + rounds)).toEqual(Array.from({ length: rounds }, () => "discover"));
    expect(seen[seen.length - 1]).toBe("longtail");
  });

  test("stops when the 500 MB budget is full", () => {
    // ~11,900 documents at 44 KB each is about 500 MB.
    const full = footprintOf(11_900, 600_000, budget * 1_048_576);
    const d = planFill({ ...base, footprint: full }, T0);
    expect(d.phase).toBe("done");
    expect(d.reason).toContain("budget reached");
  });

  test("stops before the disk is full, not after", () => {
    // 50 documents of headroom left: one more batch would overrun.
    const nearly = footprintOf(11_850, 600_000, (budget - 1) * 1_048_576);
    const d = planFill({ ...base, footprint: nearly }, T0);
    expect(d.phase).toBe("done");
  });

  test("a time-boxed run stops on its own", () => {
    const d = planFill({ ...base, footprint: withDocs(10) }, T0 + 120_000);
    expect(d.phase).toBe("done");
    expect(d.reason).toContain("time budget");
  });

  test("a page cap is a backstop against a runaway", () => {
    const d = planFill({ ...base, footprint: withDocs(10), fetched: 500, maxPages: 500 }, T0);
    expect(d.phase).toBe("done");
    expect(d.reason).toContain("page cap");
  });

  test("never asks for more URLs than the disk can hold", () => {
    const docs = 11_000; // close to the ceiling
    const f = withDocs(docs);
    const room = Math.floor((budget * 1_048_576 - f.bytes) / perDoc);
    const d = planFill({ ...base, footprint: f }, T0);
    expect(d.batch).toBeLessThanOrEqual(room);
  });

  test("the target is reachable: 500 MB holds real documents", () => {
    const docsIn500Mb = Math.floor((budget * 1_048_576) / perDoc);
    expect(docsIn500Mb).toBeGreaterThan(10_000);
    expect(docsIn500Mb).toBeLessThan(13_000);
  });
});

describe("host queue", () => {
  test("skips hosts already harvested", () => {
    expect(hostQueue(["a.com", "b.com", "c.com"], new Set(["b.com"]))).toEqual(["a.com", "c.com"]);
  });

  test("empties as hosts are consumed", () => {
    expect(hostQueue(["a.com"], new Set(["a.com"]))).toEqual([]);
  });
});

describe("deadline", () => {
  test("is a minute-based budget from now", () => {
    expect(deadlineFromNow(25, T0)).toBe(T0 + 25 * 60_000);
    // a nonsense value still yields a usable deadline
    expect(deadlineFromNow(0, T0)).toBe(T0 + 60_000);
  });

  test("the default fill window leaves room inside a boot", () => {
    expect(CONFIG.storage.fillMaxMinutes).toBeLessThanOrEqual(30);
  });
});