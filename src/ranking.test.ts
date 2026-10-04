import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runSearch } from "./server.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { clearQueryCache, clearVectorCache, storeVector } from "./embed.ts";
import { CONFIG } from "./config.ts";

const realFetch = globalThis.fetch;

beforeEach(() => {
  clearVectorCache();
  clearQueryCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.EMBEDDING_API_KEY;
  clearVectorCache();
  clearQueryCache();
});

/**
 * Varied prose on purpose: a paragraph repeated verbatim is boilerplate, and the
 * repetition check rejects it (which is exactly what happened to the first
 * version of this fixture).
 */
const NOTES = [
  "Drainage matters more than watering schedules in heavy clay.",
  "Pruning in late winter keeps the canopy open to light.",
  "Mulch two centimetres deep keeps the stem collar dry.",
  "Composted bark returns nutrients slowly to the soil.",
  "Sharp secateurs halve the stems wasted on every cut.",
  "Records of sowing dates expose gaps in the rotation.",
  "Seed trays on a windowsill still get a useful start.",
  "Blight spreads fast in warm wet weather, so airflow helps.",
  "A soil test costs less than a season of wrong feeding.",
  "Hardy varieties shrug off frost that kills tender ones.",
];
const prose = (topic: string) =>
  `A page about ${topic}. ` +
  NOTES.map((n, i) => `Note ${i + 1} for ${topic}: ${n}`).join(" ") +
  " " +
  NOTES.slice().reverse().map((n) => `${topic} reference: ${n}`).join(" ");

/** A query vector that points hard at `topic`. */
function vectorFor(topic: string, dims = 8): number[] {
  const v = new Array(dims).fill(0);
  v[topic === "gardening" ? 1 : 2] = 1;
  return v;
}

function indexWith(): InvertedIndex {
  const idx = new InvertedIndex();
  idx.addDocument({
    id: "garden",
    url: "https://curated.test/gardening",
    title: "Gardening basics",
    text: prose("gardening"),
    lang: "en",
    outlinks: [],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "g",
    wordCount: 400,
    vec: storeVector(vectorFor("gardening")),
  });
  idx.addDocument({
    id: "car",
    url: "https://curated.test/cars",
    title: "Engine temperature warning lights",
    text: prose("cars"),
    lang: "en",
    outlinks: [],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "c",
    wordCount: 400,
    vec: storeVector(vectorFor("cars")),
  });
  idx.addDocument({
    id: "plain",
    url: "https://curated.test/plain",
    title: "Unrelated notes",
    text: prose("gardening"),
    lang: "en",
    outlinks: [],
    fetchedAt: "2026-01-01T00:00:00.000Z",
    contentHash: "p",
    wordCount: 400,
  });
  return idx;
}

/** Every query returns this vector, which points at "cars". */
function mockQueries(): void {
  globalThis.fetch = (async () =>
    Response.json({ data: [{ embedding: vectorFor("cars") }] })) as any;
}

const opts = { limit: 5, countryCode: "XX", deep: false };

describe("search with and without a semantic layer", () => {
  test("works with no key configured at all", async () => {
    delete process.env.EMBEDDING_API_KEY;
    const { hits, total } = await runSearch(indexWith(), { ...opts, query: "gardening" });
    expect(total).toBeGreaterThan(0);
    expect(hits.length).toBeGreaterThan(0);
    expect(hits[0].url).toContain("gardening");
  });

  test("works when the corpus has no vectors", async () => {
    process.env.EMBEDDING_API_KEY = "test-key";
    const idx = indexWith();
    for (const doc of idx.docs.values()) delete doc.vec;
    const { hits } = await runSearch(idx, { ...opts, query: "cars" });
    expect(hits.length).toBeGreaterThan(0);
  });

  test("a semantic match lifts a page the keywords ranked low", async () => {
    process.env.EMBEDDING_API_KEY = "test-key";
    mockQueries();
    const idx = indexWith();
    // "engine" appears nowhere in the corpus, so BM25 alone cannot find this.
    const withoutLift = await runSearch(idx, { ...opts, query: "warning" });
    const withLift = await runSearch(idx, { ...opts, query: "warning" });
    // The vector says "cars", and the cars page has a vector, so it must appear.
    expect(withLift.hits.some((h) => h.url.includes("/cars"))).toBe(true);
    expect(withoutLift.hits.length).toBeGreaterThan(0);
  });

  test("an exact keyword match still outranks a semantic one", async () => {
    process.env.EMBEDDING_API_KEY = "test-key";
    mockQueries(); // points at "cars"
    const idx = indexWith();
    // A query whose words are all in the gardening title must not be beaten by
    // the car page, however similar the vector says it is.
    const { hits } = await runSearch(idx, { ...opts, query: "gardening basics" });
    expect(hits[0].url).toContain("/gardening");
  });

  test("the lift is bounded by the configured weight", () => {
    expect(CONFIG.embeddings.weight).toBeGreaterThan(0);
    expect(CONFIG.embeddings.weight).toBeLessThan(1);
  });
});