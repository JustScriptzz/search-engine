import { describe, expect, test } from "bun:test";
import { analyzeQuery, coordinationScore, coordinationWeights, detectIntent } from "./query.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

describe("query understanding", () => {
  test("detects intent from natural phrasing", () => {
    expect(detectIntent("how does github work")).toBe("how");
    expect(detectIntent("what is bm25")).toBe("what");
    expect(detectIntent("best python web framework")).toBe("best");
    expect(detectIntent("why is the sky blue")).toBe("why");
    expect(detectIntent("github")).toBe("lookup");
  });

  test("drops question noise but keeps the subject", () => {
    const plan = analyzeQuery("how does github work");
    expect(plan.focus).toContain("github");
    expect(plan.focus).not.toContain("how");
    expect(plan.focus).not.toContain("does");
  });

  test("terms that exist nowhere count less than real ones", () => {
    const plan = analyzeQuery("github zzzzqqq");
    const weights = coordinationWeights(plan, (t) => t === "github");
    expect(weights.get("github")).toBe(1);
    expect(weights.get("zzzzqqq")).toBeLessThan(1);
    // a doc that only matches the real term still scores well
    expect(coordinationScore(weights, new Set(["github"]))).toBeGreaterThan(0.7);
  });

  test("a question is not penalised for words no page contains", () => {
    const idx = new InvertedIndex();
    idx.addDocument({
      id: "a",
      url: "https://example.test/gh",
      title: "How GitHub works",
      text: "GitHub is a platform where developers host code, review changes and ship software together.",
      lang: "en",
      outlinks: [],
      fetchedAt: new Date().toISOString(),
      contentHash: "h",
      wordCount: 16,
    });
    idx.addDocument({
      id: "b",
      url: "https://example.test/other",
      title: "Unrelated",
      text: "Gardening tips for clay soil and seasonal planting schedules in the northern hemisphere.",
      lang: "en",
      outlinks: [],
      fetchedAt: new Date().toISOString(),
      contentHash: "h2",
      wordCount: 13,
    });
    const hits = idx.search("how does github work", 5);
    expect(hits[0].id).toBe("a");
  });
});