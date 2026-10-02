import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokenizer.ts";
import { InvertedIndex } from "./invertedIndex.ts";

describe("tokenizer", () => {
  test("lowercases and removes stopwords", () => {
    expect(tokenize("The Quick, brown FOX!")).toContain("quick");
    expect(tokenize("the and of")).toEqual([]);
  });
});

describe("index + BM25", () => {
  test("ranks relevant doc first", () => {
    const idx = new InvertedIndex();
    idx.addDocument({ id: "1", url: "https://a.test/1", title: "Cats", text: "cats cats cats dogs", outlinks: [], fetchedAt: new Date().toISOString(), contentHash: "h1", wordCount: 4 });
    idx.addDocument({ id: "2", url: "https://a.test/2", title: "Dogs", text: "dogs dogs birds", outlinks: [], fetchedAt: new Date().toISOString(), contentHash: "h2", wordCount: 3 });
    const hits = idx.search("cats", 10);
    expect(hits[0].id).toBe("1");
    expect(hits.length).toBe(1);
  });

  test("dedups identical content", () => {
    const idx = new InvertedIndex();
    const base = { url: "https://a.test/", title: "Hi", text: "unique content words here hello world", outlinks: [], fetchedAt: new Date().toISOString(), wordCount: 5 };
    expect(idx.addDocument({ ...base, id: "1", contentHash: "same" })).toBe(true);
    expect(idx.addDocument({ ...base, id: "2", contentHash: "same" })).toBe(false);
  });
});
