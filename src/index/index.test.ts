import { describe, expect, test } from "bun:test";
import { tokenize } from "./tokenizer.ts";
import { InvertedIndex } from "./invertedIndex.ts";
import type { CrawledDoc } from "../types.ts";

function doc(partial: Partial<CrawledDoc> & { id: string; contentHash: string }): CrawledDoc {
  return {
    url: `https://a.test/${partial.id}`,
    title: "",
    text: "",
    lang: "en",
    outlinks: [],
    fetchedAt: new Date().toISOString(),
    wordCount: 0,
    ...partial,
  };
}

describe("tokenizer", () => {
  test("lowercases and removes stopwords", () => {
    expect(tokenize("The Quick, brown FOX!")).toContain("quick");
    expect(tokenize("the and of")).toEqual([]);
  });

  test("keeps domain-ish words: they are real query terms here", () => {
    const t = tokenize("https www example com html page");
    expect(t).toContain("html");
    expect(t).toContain("www");
  });

  test("a multi-word query keeps every content term", () => {
    expect(tokenize("html standards").sort()).toEqual(["html", "standards"]);
  });
});

describe("index + BM25", () => {
  test("ranks relevant doc first", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc({ id: "1", contentHash: "h1", title: "Cats", text: "cats cats cats dogs", wordCount: 4 }));
    idx.addDocument(doc({ id: "2", contentHash: "h2", title: "Dogs", text: "dogs dogs birds", wordCount: 3 }));
    const hits = idx.search("cats", 10);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe("1");
  });

  test("title matches outrank body matches", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc({ id: "title", contentHash: "a", title: "Rust ownership", text: "one two three four five six" }));
    idx.addDocument(doc({ id: "body", contentHash: "b", title: "Unrelated", text: "rust ownership one two three four five" }));
    expect(idx.search("ownership", 10)[0].id).toBe("title");
  });

  test("coordination beats a single repeated term", () => {
    const idx = new InvertedIndex();
    // spammy doc: repeats one query term many times, never mentions the other
    idx.addDocument(doc({ id: "spam", contentHash: "s", title: "Release", text: "standards ".repeat(40) + "autonomous vehicles law".split(" ").join(" ") }));
    idx.addDocument(doc({ id: "good", contentHash: "g", title: "Web standards", text: "The web standards group publishes guidance for developers building on the open web platform." }));
    const hits = idx.search("web standards", 5);
    expect(hits[0].id).toBe("good");
    expect(hits[0].matchedTerms).toBe(2);
  });

  test("a site whose domain matches the query outranks pages that mention it", () => {
    const idx = new InvertedIndex();
    // mentions youtube in the body only
    idx.addDocument(doc({ id: "mention", contentHash: "m", title: "Permissions & Licensing", text: "Share on YouTube or embed the player. ".repeat(12) }));
    // *is* youtube
    idx.addDocument(doc({ id: "site", contentHash: "y", url: "https://www.youtube.com/watch?v=abc", title: "YouTube", text: "Watch videos, share and create. ".repeat(12) }));
    const hits = idx.search("youtube", 5);
    expect(hits[0].id).toBe("site");
  });

  test("title matches outrank body mentions", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc({ id: "body", contentHash: "b", title: "Unrelated page", text: "rust ownership rules explained ".repeat(10) }));
    idx.addDocument(doc({ id: "title", contentHash: "t", title: "Rust ownership", text: "some other subject entirely ".repeat(10) }));
    expect(idx.search("rust ownership", 5)[0].id).toBe("title");
  });

  test("dedups identical content", () => {
    const idx = new InvertedIndex();
    const base = { url: "https://a.test/", title: "Hi", text: "unique content words here hello world", wordCount: 5 };
    expect(idx.addDocument(doc({ ...base, id: "1", contentHash: "same" }))).toBe(true);
    expect(idx.addDocument(doc({ ...base, id: "2", contentHash: "same" }))).toBe(false);
  });
});