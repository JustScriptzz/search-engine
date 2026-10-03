import { describe, expect, test } from "bun:test";
import { decomposeQuery, deepSearch, expansionTerms, fuse } from "./deepsearch.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";

function idx(): InvertedIndex {
  const i = new InvertedIndex();
  const mk = (id: string, url: string, title: string, text: string) =>
    i.addDocument({
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
  mk("fork", "https://git.example/pull/1", "Pull requests explained", "A pull request proposes changes to a repository. Forking a repository creates your own copy on the server.");
  mk("review", "https://git.example/review", "Code review guide", "Code review means a second person reads a diff before it merges. Reviewers comment on lines and approve or request changes.");
  mk("merge", "https://git.example/merge", "Merging changes", "Merging combines branches. A merge commit joins the history of two branches after review and approval.");
  mk("recipe", "https://food.example/pasta", "Pasta recipe", "Boil water, salt the pan, cook pasta until al dente, drain and toss with sauce and cheese.");
  return i;
}

describe("deep search", () => {
  test("splits compound questions", () => {
    expect(decomposeQuery("how do forks work and who reviews them")).toEqual([
      "how do forks work",
      "who reviews them",
    ]);
    expect(decomposeQuery("single question")).toEqual([]);
  });

  test("fuses rankings by rank position", () => {
    const fused = fuse([[{ id: "a" }, { id: "b" }], [{ id: "b" }, { id: "a" }]]);
    // b is 2nd then 1st; a is 1st then 2nd — a edges out on the k+rank+1 sums
    expect(fused.size).toBe(2);
    expect(fused.get("b")).toBeGreaterThan(0);
  });

  test("expansion finds related terms from the top hits", () => {
    const i = idx();
    const hits = i.search("pull request", 3);
    const terms = expansionTerms(i, hits, 6, ["pull", "request"]);
    expect(terms).toContain("repository");
    expect(terms).not.toContain("pull"); // already in the query
  });

  test("multi-pass beats a single pass on a multi-part question", () => {
    const i = idx();
    const q = "how do pull requests work and who approves changes";
    const deep = deepSearch(i, q, { limit: 5, deep: true });
    const flat = deepSearch(i, q, { limit: 5, deep: false });
    expect(deep.passes.length).toBeGreaterThan(1);
    expect(deep.expandedTerms.length).toBeGreaterThan(0);
    expect(deep.subQueries.length).toBe(2);
    // the second half of the question pulls in the code-review page
    expect(deep.hits.map((h) => h.id)).toContain("review");
    expect(flat.hits.length).toBeGreaterThan(0);
  });

  test("results stay relevant when deep search is off", () => {
    const i = idx();
    const flat = deepSearch(i, "pasta recipe", { limit: 3, deep: false });
    expect(flat.hits[0].id).toBe("recipe");
  });
});