import { describe, expect, test } from "bun:test";
import { authorityBoost, computeAuthority, resetAuthorityCache } from "./authority.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import type { CrawledDoc } from "./types.ts";

function doc(id: string, url: string, outlinks: string[], text = "words ".repeat(60)): CrawledDoc {
  return {
    id,
    url,
    title: id,
    text,
    lang: "en",
    linkDensity: 0.2,
    outlinks,
    fetchedAt: new Date().toISOString(),
    contentHash: id,
    wordCount: text.split(/\s+/).length,
  };
}

describe("domain authority", () => {
  test("a heavily linked-to host outranks an isolated one", () => {
    resetAuthorityCache();
    const idx = new InvertedIndex();
    // five pages link to popular.test, one lonely page elsewhere
    for (let i = 0; i < 5; i++) idx.addDocument(doc(`a${i}`, `https://source${i}.test/`, ["https://popular.test/"]));
    idx.addDocument(doc("b0", "https://lonely.test/", []));
    const auth = computeAuthority(idx);
    expect(auth.score.get("popular.test")!).toBeGreaterThan(auth.score.get("lonely.test")!);
    expect(auth.inlinks.get("popular.test")).toBe(5);
    expect(authorityBoost("popular.test", auth)).toBeGreaterThan(authorityBoost("lonely.test", auth));
  });

  test("an unlinked host has no boost", () => {
    resetAuthorityCache();
    const idx = new InvertedIndex();
    idx.addDocument(doc("x", "https://solo.test/", []));
    const auth = computeAuthority(idx);
    expect(authorityBoost("solo.test", auth)).toBeGreaterThanOrEqual(1);
    expect(authorityBoost("absent.test", auth)).toBe(1);
  });

  test("empty index is handled", () => {
    resetAuthorityCache();
    const auth = computeAuthority(new InvertedIndex());
    expect(auth.hostCount).toBe(0);
  });

  test("scores stay in the 0..1 range", () => {
    resetAuthorityCache();
    const idx = new InvertedIndex();
    idx.addDocument(doc("a", "https://a.test/", ["https://b.test/", "https://c.test/"]));
    idx.addDocument(doc("b", "https://b.test/", ["https://c.test/"]));
    idx.addDocument(doc("c", "https://c.test/", []));
    const auth = computeAuthority(idx);
    for (const v of auth.score.values()) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });
});