import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvertedIndex } from "./invertedIndex.ts";

/**
 * Why this test exists: the index held every (term, document) pair as a Map
 * entry wrapping a {tf} object, measured at 408 bytes per pair. A real page
 * carries ~1,255 pairs, so each document cost ~500 KB of RAM to index 15 KB of
 * text — postings were 97% of the heap, and that is what stopped the crawl.
 */
const mkPage = (i: number, uniqueTerms = 2500) => {
  const words: string[] = [];
  for (let k = 0; k < uniqueTerms; k++) words.push(`t${(i * 31 + k * 7) % 9000}${k}`);
  return ("Gardening soil drainage watering pruning. " + words.join(" ")).slice(0, 15000);
};

const doc = (i: number, uniqueTerms?: number) => ({
  id: `d${i}`,
  url: `https://site${i}.com/p`,
  title: `Page ${i}`,
  text: mkPage(i, uniqueTerms),
  lang: "en",
  outlinks: [],
  fetchedAt: "2026-01-01T00:00:00.000Z",
  contentHash: `c${i}`,
  wordCount: 2000,
});

describe("postings are the memory cost, and they are counted correctly", () => {
  test("term frequencies are stored as plain numbers", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc(0, 50));
    const list = idx.index.get("gardening")!;
    expect(list.get("d0")).toBeGreaterThan(0);
    expect(typeof list.get("d0")).toBe("number");
  });

  test("the same term in two documents gets its own count", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc(0, 20));
    idx.addDocument(doc(1, 20));
    const list = idx.index.get("pruning")!;
    expect(list.size).toBe(2);
    expect(list.get("d0")).toBe(list.get("d1"));
  });

  test("removing a document removes its postings", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc(0, 20));
    expect(idx.index.get("pruning")!.size).toBe(1);
    expect(idx.remove("d0")).toBe(true);
    // Empty lists are cleaned up entirely, so the term is gone rather than
    // left behind with a zero-length posting list.
    expect(idx.index.has("pruning")).toBe(false);
  });

  test("a posting pair costs far less than the old wrapper object", () => {
    const N = 60;
    const idx = new InvertedIndex();
    (Bun as unknown as { gc: (f?: boolean) => void }).gc?.(true);
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < N; i++) idx.addDocument(doc(i));
    (Bun as unknown as { gc: (f?: boolean) => void }).gc?.(true);
    const used = process.memoryUsage().heapUsed - before;

    let pairs = 0;
    for (const [, list] of idx.index) pairs += list.size;
    const perPair = used / Math.max(1, pairs);
    // The old shape measured 408 bytes/pair on this engine. This is not a
    // target for the typed-array rewrite, just a floor to catch a regression
    // back to per-entry objects.
    expect(perPair).toBeLessThan(400);
  });
});

describe("posting format compatibility", () => {
  test("loads an index written with the old {tf} wrapper", () => {
    // Their live index.json still has [{"docId",{"tf":n}}] entries.
    const legacy = {
      docs: [
        {
          id: "d0",
          url: "https://site0.com/p",
          title: "Page 0",
          text: "gardening soil drainage ".repeat(20),
          lang: "en",
          outlinks: [],
          fetchedAt: "2026-01-01T00:00:00.000Z",
          contentHash: "c0",
          wordCount: 60,
        },
      ],
      index: [["gardening", [["d0", { tf: 20 }]]], ["soil", [["d0", { tf: 20 }]]]],
      docLens: [["d0", 60]],
      totalLen: 60,
    };
    const idx = InvertedIndex.fromJSON(legacy);
    expect(idx.docCount).toBe(1);
    expect(idx.index.get("gardening")!.get("d0")).toBe(20);
  });

  test("loads the current [docId, tf] shape", () => {
    const modern = {
      docs: [
        {
          id: "d0",
          url: "https://site0.com/p",
          title: "Page 0",
          text: "gardening soil drainage ".repeat(20),
          lang: "en",
          outlinks: [],
          fetchedAt: "2026-01-01T00:00:00.000Z",
          contentHash: "c0",
          wordCount: 60,
        },
      ],
      index: [["gardening", [["d0", 20]]]],
      docLens: [["d0", 60]],
      totalLen: 60,
    };
    expect(InvertedIndex.fromJSON(modern).index.get("gardening")!.get("d0")).toBe(20);
  });

  test("saves in the new shape and reads it back", async () => {
    const dir = mkdtempSync(join(tmpdir(), "minisearch-post-"));
    const path = join(dir, "index.json");
    const idx = new InvertedIndex();
    idx.addDocument(doc(0, 30));
    await idx.saveToFile(path);
    const raw = await Bun.file(path).text();
    expect(raw).toContain('"gardening"');
    expect(raw).not.toContain('"tf"');
    const back = await InvertedIndex.loadFromFile(path);
    expect(back.index.get("gardening")!.get("d0")).toBeGreaterThan(0);
    rmSync(dir, { recursive: true, force: true });
  });
});