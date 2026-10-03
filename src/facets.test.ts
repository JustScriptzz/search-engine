import { describe, expect, test } from "bun:test";
import { facetCounts } from "./facets.ts";
import { CONFIG } from "./config.ts";

const CURATED = CONFIG.trust.curatedBoost;
const DISCOVERED = CONFIG.trust.discoveredPenalty;

describe("domain facets", () => {
  test("a curated site outranks a link farm with more pages", () => {
    // The real case: whec.com had 4 pages and led the chips, while github.com
    // had 1 and sat below it, because the chips counted documents only.
    const facets = facetCounts([
      ...Array.from({ length: 4 }, () => ({ domain: "whec.com", trust: DISCOVERED })),
      { domain: "github.com", trust: CURATED },
    ]);
    expect(facets[0].domain).toBe("github.com");
    expect(facets[0].count).toBe(1);
    // The count still reports what people expect: documents on this page.
    expect(facets.find((f) => f.domain === "whec.com")!.count).toBe(4);
  });

  test("pure document count still decides between equally trusted domains", () => {
    const facets = facetCounts([
      { domain: "small.com", trust: CURATED },
      { domain: "big.com", trust: CURATED },
      { domain: "big.com", trust: CURATED },
      { domain: "big.com", trust: CURATED },
    ]);
    expect(facets[0]).toEqual({ domain: "big.com", count: 3 });
  });

  test("a link farm with many pages cannot out-score a curated domain", () => {
    // Regression: summing trust let volume win, because 4 × 0.3 exactly ties
    // 1 × 1.2. Averaging makes the tier the deciding factor.
    const spam = Array.from({ length: 40 }, () => ({ domain: "spam.test", trust: DISCOVERED }));
    const facets = facetCounts([...spam, { domain: "github.com", trust: CURATED }]);
    expect(facets[0].domain).toBe("github.com");
  });

  test("order is stable for identical domains", () => {
    const items = [
      { domain: "b.com", trust: CURATED },
      { domain: "a.com", trust: CURATED },
    ];
    expect(facetCounts(items).map((f) => f.domain)).toEqual(["a.com", "b.com"]);
    expect(facetCounts([...items].reverse()).map((f) => f.domain)).toEqual(["a.com", "b.com"]);
  });

  test("capped at the requested number of chips", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ domain: `site${i}.com`, trust: CURATED }));
    expect(facetCounts(many)).toHaveLength(10);
    expect(facetCounts(many, 3)).toHaveLength(3);
  });

  test("empty domains are dropped", () => {
    expect(facetCounts([{ domain: "", trust: CURATED }])).toEqual([]);
    expect(facetCounts([])).toEqual([]);
  });

  test("trust weighting has to be able to overcome a document lead", () => {
    // Sanity check on the configured numbers: this is the whole reason the
    // facets changed, so if someone retunes trust this should fail loudly.
    expect(CURATED / DISCOVERED).toBeGreaterThan(3);
  });
});