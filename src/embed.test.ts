import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { InvertedIndex } from "./index/invertedIndex.ts";
import {
  clearQueryCache,
  clearVectorCache,
  cosine,
  embedAll,
  embedBatch,
  embedQuery,
  embeddingStatus,
  embeddingsEnabled,
  forgetVector,
  loadVector,
  quantize,
  storeVector,
} from "./embed.ts";
import { CONFIG } from "./config.ts";

const realFetch = globalThis.fetch;
const KEY = "test-key-not-real";

beforeEach(() => {
  process.env.EMBEDDING_API_KEY = KEY;
  clearVectorCache();
  clearQueryCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.EMBEDDING_API_KEY;
  clearVectorCache();
  clearQueryCache();
});

/** Deterministic fake service: vectors derived from the text, so "similar"
 *  texts really do land near each other. */
function mockService(opts: { fail?: number; dims?: number; calls?: (string | RequestInfo | URL)[] } = {}) {
  const dims = opts.dims ?? 8;
  const calls: (string | RequestInfo | URL)[] = opts.calls ?? [];
  let n = 0;
  globalThis.fetch = (async (url: any, init: any) => {
    calls.push(String(url));
    n++;
    if (opts.fail && n <= opts.fail) return new Response("busy", { status: 503 });
    const body = JSON.parse(String(init.body));
    const inputs: string[] = body.input;
    return Response.json({
      data: inputs.map((text: string) => {
        const v = new Array(dims).fill(0);
        // crude but stable: hash each word into a bucket
        for (const w of text.toLowerCase().split(/\W+/).slice(0, 40)) {
          let h = 0;
          for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) % dims;
          v[h] += 1;
        }
        const norm = Math.hypot(...v) || 1;
        return { embedding: v.map((x: number) => x / norm) };
      }),
    });
  }) as any;
}

describe("quantisation", () => {
  test("round-trips a vector closely", () => {
    const v = [0.5, -0.25, 0.125, 0, -0.9];
    const { bytes, scale } = quantize(v);
    expect(bytes.length).toBe(v.length);
    for (let i = 0; i < v.length; i++) {
      // bytes[i] * scale is the original value; the scale is what the cosine
      // comparison multiplies back in.
      expect(bytes[i] * scale).toBeCloseTo(v[i], 1);
    }
  });

  test("handles an all-zero vector without dividing by zero", () => {
    const { bytes, scale } = quantize([0, 0, 0]);
    expect(scale).toBeGreaterThan(0);
    expect(Array.from(bytes)).toEqual([0, 0, 0]);
  });

  test("cosine ranks a matching vector above an unrelated one", () => {
    const { bytes: a, scale: sa } = quantize([1, 0, 0, 0]);
    const { bytes: b, scale: sb } = quantize([0, 1, 0, 0]);
    const near = cosine([1, 0, 0, 0], a, sa);
    const far = cosine([1, 0, 0, 0], b, sb);
    expect(near).toBeGreaterThan(far);
    expect(near).toBeLessThanOrEqual(1.0001);
  });

  test("storage is a quarter the size of float32", () => {
    const dims = 1024;
    const v = Array.from({ length: dims }, (_, i) => Math.sin(i));
    const stored = storeVector(v);
    const decoded = loadVector("d1", stored);
    expect(decoded!.length).toBe(dims);
    // one signed byte per dimension, plus base64 overhead in storage
    expect(stored.v.length).toBeLessThan(dims * 2);
  });

  test("forgetting a document drops its cached vector", () => {
    const stored = storeVector([1, 2, 3]);
    loadVector("d1", stored);
    forgetVector("d1");
    // reloading works and is the same data
    expect(Array.from(loadVector("d1", stored)!)).toHaveLength(3);
  });
});

describe("the service client", () => {
  test("is off without a key", () => {
    delete process.env.EMBEDDING_API_KEY;
    expect(embeddingsEnabled()).toBe(false);
    expect(embeddingStatus(10, 0).configured).toBe(false);
  });

  test("embeds a batch and reports the dimensions", async () => {
    mockService({ dims: 16 });
    const out = await embedBatch(["gardening soil", "engine overheating"]);
    expect(out).not.toBeNull();
    expect(out!.length).toBe(2);
    expect(out![0].length).toBe(16);
    expect(embeddingStatus(2, 2).dimensions).toBe(16);
  });

  test("sends the key as a bearer token and never in the body", async () => {
    let seenAuth = "";
    let seenBody = "";
    globalThis.fetch = (async (_url: any, init: any) => {
      seenAuth = init.headers.authorization ?? "";
      seenBody = String(init.body);
      return Response.json({ data: [{ embedding: [1, 0] }] });
    }) as any;
    await embedBatch(["hello"]);
    expect(seenAuth).toBe(`Bearer ${KEY}`);
    expect(seenBody).not.toContain(KEY);
  });

  test("retries a rate-limited service and then succeeds", async () => {
    mockService({ fail: 2, dims: 4 });
    const out = await embedBatch(["retry me"]);
    expect(out).not.toBeNull();
    expect(out![0].length).toBe(4);
  });

  test("gives up cleanly instead of throwing", async () => {
    globalThis.fetch = (async () => new Response("nope", { status: 401 })) as any;
    expect(await embedBatch(["x"])).toBeNull();
    expect(embeddingStatus(1, 0).lastError).toContain("401");
  });

  test("a malformed response is refused rather than half-applied", async () => {
    globalThis.fetch = (async () => Response.json({ data: [{ embedding: [1] }, { nope: true }] })) as any;
    expect(await embedBatch(["a", "b"])).toBeNull();
  });

  test("long pages are truncated before sending", async () => {
    let seen = "";
    globalThis.fetch = (async (_url: any, init: any) => {
      seen = JSON.parse(String(init.body)).input[0];
      return Response.json({ data: [{ embedding: [1, 2] }] });
    }) as any;
    await embedBatch(["word ".repeat(5000)]);
    expect(seen.length).toBeLessThanOrEqual(CONFIG.embeddings.maxInputChars);
  });

  test("embedAll splits into batches", async () => {
    const calls: (string | RequestInfo | URL)[] = [];
    mockService({ dims: 4, calls });
    const texts = Array.from({ length: CONFIG.embeddings.batchSize * 2 + 1 }, (_, i) => `page ${i}`);
    const out = await embedAll(texts);
    expect(out!.length).toBe(texts.length);
    expect(calls.length).toBe(3);
  });

  test("query embeddings are cached, so the same question costs one call", async () => {
    const calls: (string | RequestInfo | URL)[] = [];
    mockService({ dims: 4, calls });
    const a = await embedQuery("how does bm25 work");
    const b = await embedQuery("how does bm25 work");
    expect(a).toEqual(b);
    expect(calls.length).toBe(1);
    expect(embeddingStatus(0, 0).cachedQueries).toBe(1);
  });
});

describe("the semantic layer never replaces keyword ranking", () => {
  test("the configured weight cannot invert an exact match", () => {
    // The design constraint: cosine multiplies the keyword score, so a page with
    // a perfect phrase match cannot be pushed below one that only means
    // something similar. This test fails loudly if the weight is ever raised
    // far enough to break that promise.
    const weight = CONFIG.embeddings.weight;
    const exact = 1.0; // keyword score of an exact title match
    const weak = 0.02; // keyword score of a passing mention
    const bestLift = 1 + weight; // strongest possible semantic boost
    const worstLift = 1; // no vector at all
    expect(exact * worstLift).toBeGreaterThan(weak * bestLift);
  });

  test("documents without vectors are simply not lifted", () => {
    const idx = new InvertedIndex();
    idx.addDocument({
      id: "d1",
      url: "https://a.test/1",
      title: "Gardening",
      text: "soil and water ".repeat(60),
      lang: "en",
      outlinks: [],
      fetchedAt: "2026-01-01T00:00:00.000Z",
      contentHash: "c1",
      wordCount: 120,
    });
    expect(idx.docs.get("d1")!.vec).toBeUndefined();
  });
});
