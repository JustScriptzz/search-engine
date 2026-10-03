import { describe, expect, test } from "bun:test";
import { analyzeQuery } from "./query.ts";
import { InvertedIndex, makeSnippet, normalizePhrase, wordMatches } from "./index/invertedIndex.ts";

const doc = (id: string, url: string, title: string, text: string, extra: Record<string, unknown> = {}) => ({
  id,
  url,
  title,
  text,
  lang: "en",
  outlinks: [],
  fetchedAt: new Date().toISOString(),
  contentHash: id,
  wordCount: text.split(/\s+/).length,
  ...extra,
});

describe("lookup queries keep their content words", () => {
  test("a song title is not treated as a question", () => {
    const plan = analyzeQuery("never gonna give you up");
    // "give" and "you" are content words here, not filler
    expect(plan.focus).toContain("give");
    expect(plan.intent).toBe("lookup");
  });

  test("real questions still shed filler", () => {
    const plan = analyzeQuery("how does github work");
    expect(plan.focus).not.toContain("how");
    expect(plan.focus).not.toContain("does");
  });

  test("the phrase we match on is the user's own words", () => {
    expect(analyzeQuery("Never Gonna Give You Up!").subject).toBe("never gonna give you up");
  });
});

describe("phrase matching", () => {
  test("punctuation is normalised away", () => {
    expect(normalizePhrase("Rick Astley - Never Gonna Give You Up (Official)")).toBe(
      "rick astley never gonna give you up official",
    );
  });

  test("an exact title match outranks a page that merely says 'up'", () => {
    const idx = new InvertedIndex();
    idx.addDocument(
      doc("vid", "https://www.youtube.com/watch?v=x", "Rick Astley - Never Gonna Give You Up (Official Video)",
        "Rick Astley Never Gonna Give You Up Official Video. video youtube.com"),
    );
    // A link-farm-ish text page that happens to contain "up" in other words.
    idx.addDocument(
      doc(
        "noise",
        "https://github.com/explore",
        "Explore GitHub",
        `${"antigravity agent skills subagent powers updated tools ".repeat(8)} never a match here`,
      ),
    );
    const hits = idx.search("never gonna give you up", 5);
    expect(hits[0].id).toBe("vid");
    expect(hits[0].score).toBeGreaterThan(hits[1]?.score ?? 0);
  });
});

describe("snippets highlight whole words", () => {
  test("'up' does not match 'Updated'", () => {
    expect(wordMatches("updated", "up")).toBe(false);
    expect(wordMatches("superpowers", "up")).toBe(false);
    expect(wordMatches("up", "up")).toBe(true);
    expect(wordMatches("Up", "up")).toBe(true);
  });

  test("longer terms still match as prefixes", () => {
    expect(wordMatches("astronaut", "astro")).toBe(true);
    expect(wordMatches("repo", "repository")).toBe(false);
  });

  test("the window anchors on a real match, not a substring", () => {
    const text = `${"Updated superpowers upgrades ".repeat(40)}never gonna give you up`;
    const snip = makeSnippet(text, ["up"], 8);
    expect(snip).toContain("never gonna give you up");
  });

  test("a real term still anchors the window near the match", () => {
    const text = `${"filler ".repeat(40)}never gonna give you up${" filler".repeat(40)}`;
    const snip = makeSnippet(text, ["gonna"]);
    // The window is pulled to the match instead of the document start.
    expect(snip).toContain("never gonna");
    expect(snip.startsWith("filler")).toBe(false);
  });
});