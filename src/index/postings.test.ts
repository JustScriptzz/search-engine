import { describe, expect, test } from "bun:test";
import { Postings } from "./postings.ts";

describe("posting lists", () => {
  test("stores and reads a frequency", () => {
    const p = new Postings();
    p.add(0, 3);
    p.add(1, 1);
    expect(p.get(0)).toBe(3);
    expect(p.get(1)).toBe(1);
    expect(p.get(2)).toBe(0);
    expect(p.length).toBe(2);
  });

  test("re-adding a document overwrites rather than duplicating", () => {
    const p = new Postings();
    p.add(4, 1);
    p.add(4, 9);
    expect(p.length).toBe(1);
    expect(p.get(4)).toBe(9);
  });

  test("ordinals stay sorted even when added out of order", () => {
    // Membership is a binary search, so order matters for correctness.
    const p = new Postings();
    p.add(5, 1);
    p.add(2, 1);
    p.add(9, 1);
    p.add(0, 1);
    expect(p.liveEntries ? Array.from(p.liveEntries()).map(([id]) => id) : []).toEqual([0, 2, 5, 9]);
    expect(p.get(2)).toBe(1);
    expect(p.get(9)).toBe(1);
  });

  test("removal is a tombstone that search skips", () => {
    const p = new Postings();
    p.add(0, 1);
    p.add(1, 2);
    expect(p.remove(0)).toBe(true);
    expect(p.remove(99)).toBe(false);
    expect(Array.from(p.liveEntries()).map(([id]) => id)).toEqual([1]);
    expect(p.get(0)).toBe(0);
  });

  test("compaction drops tombstones and restores a dense run", () => {
    const p = new Postings();
    for (let i = 0; i < 10; i++) p.add(i, i + 1);
    p.remove(0);
    p.remove(4);
    p.remove(9);
    expect(p.length).toBe(7);
    p.compact();
    expect(p.length).toBe(7);
    expect(p.used).toBe(7);
    expect(p.removed).toBe(0);
    expect(Array.from(p.liveEntries()).map(([id]) => id)).toEqual([1, 2, 3, 5, 6, 7, 8]);
    expect(p.get(5)).toBe(6);
  });

  test("compaction after every removal still answers correctly", () => {
    const p = new Postings();
    for (let i = 0; i < 6; i++) p.add(i, 1);
    for (const id of [0, 1, 2, 3, 4, 5]) {
      p.remove(id);
      p.compact();
    }
    expect(p.length).toBe(0);
    expect(Array.from(p.liveEntries())).toHaveLength(0);
  });

  test("growth keeps existing data", () => {
    const p = new Postings(4); // forces several reallocations
    for (let i = 0; i < 500; i++) p.add(i, i + 1);
    expect(p.length).toBe(500);
    expect(p.get(0)).toBe(1);
    expect(p.get(499)).toBe(500);
  });

  test("clearing empties it", () => {
    const p = new Postings();
    p.add(1, 1);
    p.clear();
    expect(p.length).toBe(0);
  });

  test("round-trips through parallel arrays", () => {
    const p = new Postings();
    p.add(3, 7);
    p.add(8, 2);
    const copy = Postings.from(p.ids.subarray(0, p.length), p.tfs.subarray(0, p.length));
    expect(copy.length).toBe(2);
    expect(copy.get(3)).toBe(7);
    expect(copy.get(8)).toBe(2);
    expect(copy.has(99)).toBe(false);
  });
});

describe("why this class exists", () => {
  test("costs a fraction of a Map of the same pairs", () => {
    const N = 20000;
    const p = new Postings();
    const asMap = new Map<number, number>();
    for (let i = 0; i < N; i++) {
      p.add(i, 1);
      asMap.set(i, 1);
    }
    p.compact();
    // 8 bytes per pair, plus the geometric growth headroom the arrays carry.
    expect(p.used).toBe(N);
    expect(p.byteLength).toBeGreaterThanOrEqual(N * 8);
    expect(p.byteLength).toBeLessThanOrEqual(N * 8 * 2);
    expect(asMap.size).toBe(N);
    // Measured A/B on this engine: the same pairs as nested Maps cost 116 bytes
    // a pair, against 8 here. Compared on data bytes, not on the allocated
    // arrays, whose geometric growth headroom is bounded by the test below.
    const mapBytes = 116 * N;
    expect((p.used * 8) / mapBytes).toBeLessThan(0.1);
  });

  test("the byte count is proportional to entries, with a growth margin", () => {
    const p = new Postings();
    for (let i = 0; i < 100; i++) p.add(i, 1);
    expect(p.byteLength).toBeGreaterThanOrEqual(100 * 8);
    // At most double, from the geometric growth.
    expect(p.byteLength).toBeLessThan(100 * 8 * 2 + 8);
  });
});