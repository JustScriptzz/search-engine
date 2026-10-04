import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvertedIndex } from "./invertedIndex.ts";

const dirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "minisearch-save-"));
  dirs.push(d);
  return d;
}

const mk = (n: number, words = 120) => {
  const idx = new InvertedIndex();
  const prose = "Soil drainage watering pruning mulch compost seedlings harvest.".repeat(words);
  for (let i = 0; i < n; i++) {
    idx.addDocument({
      id: `d${i}`,
      url: `https://site${i}.com/gardening/${i}`,
      title: `Gardening guide ${i}`,
      text: prose,
      lang: "en",
      outlinks: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
      contentHash: `h${i}`,
      wordCount: prose.split(/\s+/).length,
    });
  }
  return idx;
};

describe("saving the index", () => {
  test("round-trips documents, terms and stats", async () => {
    const path = join(tmp(), "index.json");
    const idx = mk(5);
    await idx.saveToFile(path);
    const back = await InvertedIndex.loadFromFile(path);
    expect(back.docCount).toBe(5);
    expect(back.index.size).toBe(idx.index.size);
    expect(back.totalLen).toBe(idx.totalLen);
    expect(back.search("soil drainage", 3).length).toBeGreaterThan(0);
  });

  test("writing a smaller index over a larger one fully replaces it", async () => {
    // This is the bug that mattered: Bun's writer does not truncate, so a
    // prune that shrank the index left the old tail in the file. The JSON then
    // failed to parse and loadFromFile — which swallows that — returned an
    // empty index, silently wiping the corpus.
    const path = join(tmp(), "index.json");
    const big = mk(60);
    await big.saveToFile(path);
    const bigSize = statSync(path).size;

    const small = mk(4);
    await small.saveToFile(path);
    const smallSize = statSync(path).size;

    expect(smallSize).toBeLessThan(bigSize);
    const back = await InvertedIndex.loadFromFile(path);
    expect(back.docCount).toBe(4);
    // and the file must be exactly the JSON, with nothing trailing it
    const raw = readFileSync(path, "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
    expect(raw.endsWith("}")).toBe(true);
  });

  test("an existing junk file is replaced, not appended to", async () => {
    const path = join(tmp(), "index.json");
    writeFileSync(path, "x".repeat(50_000));
    await mk(3).saveToFile(path);
    const back = await InvertedIndex.loadFromFile(path);
    expect(back.docCount).toBe(3);
  });

  test("no temp file is left behind", async () => {
    const dir = tmp();
    const path = join(dir, "index.json");
    await mk(3).saveToFile(path);
    expect(() => statSync(join(dir, "index.json.tmp"))).toThrow();
  });

  test("a corrupt file loads as an empty index rather than crashing", async () => {
    const path = join(tmp(), "index.json");
    writeFileSync(path, "{not json");
    const idx = await InvertedIndex.loadFromFile(path);
    expect(idx.docCount).toBe(0);
  });
});