import { describe, expect, test } from "bun:test";
import { deepSearch } from "./deepsearch.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

const doc = (id: string, url: string, title: string, text: string) => ({
  id,
  url,
  title,
  text,
  lang: "en",
  outlinks: [],
  fetchedAt: new Date().toISOString(),
  contentHash: id,
  wordCount: text.split(/\s+/).length,
});

/** Deep search fuses passes by reciprocal rank, which throws away how much
 *  better one hit was than another. A page carrying the exact phrase in its
 *  title must not lose to a long page that happens to mention one word. */
describe("deep search keeps score magnitude", () => {
  test("an exact title phrase beats a long page that mentions one word", () => {
    const idx = new InvertedIndex();
    idx.addDocument(
      doc(
        "vid",
        "https://www.youtube.com/watch?v=x",
        "Rick Astley - Never Gonna Give You Up (Official Video)",
        "Rick Astley Never Gonna Give You Up Official Video video youtube.com",
      ),
    );
    idx.addDocument(
      doc(
        "noise",
        "https://github.com/explore",
        "Explore GitHub",
        `${"never say never give the repository an update superpowers ".repeat(40)}`,
      ),
    );

    const single = idx.search("never gonna give you up", 5);
    expect(single[0].id).toBe("vid");

    // Multi-pass: the long page matches "give"/"never"/"up" in several passes,
    // which is exactly where rank-only fusion used to hand it the win.
    const deep = deepSearch(idx, "never gonna give you up", { limit: 5, deep: true });
    expect(deep.hits[0].id).toBe("vid");
    expect(deep.hits[0].score).toBeGreaterThan(deep.hits[1]?.score ?? 0);
  });

  test("a single weak match still returns a usable score", () => {
    const idx = new InvertedIndex();
    idx.addDocument(doc("a", "https://x.test/a", "Gardening", "Gardening is the practice of growing plants."));
    const hits = deepSearch(idx, "gardening", { limit: 5 }).hits;
    expect(hits.length).toBe(1);
    expect(hits[0].score).toBeGreaterThan(0);
  });
});