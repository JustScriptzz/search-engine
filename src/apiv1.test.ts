import { describe, expect, test } from "bun:test";
import { clampInt, handleV1, isV1, parseBool, rateLimit, resetRateLimits, v1Path } from "./apiv1.ts";
import { InvertedIndex } from "./index/invertedIndex.ts";
import { CONFIG } from "./config.ts";

function deps(overrides: Partial<Parameters<typeof handleV1>[2]> = {}) {
  return {
    index: new InvertedIndex(),
    curatedHosts: new Set<string>(),
    clientIp: "203.0.113.9",
    countryCode: "IT",
    indexAgeHours: () => 2,
    build: async () => "abc1234",
    ...overrides,
  } as Parameters<typeof handleV1>[2];
}

const url = (s: string) => new URL(`http://localhost${s}`);

describe("rate limiting", () => {
  test("allows up to the limit then rejects with 429", () => {
    resetRateLimits();
    const limit = 5;
    for (let i = 0; i < limit; i++) expect(rateLimit("ip-a", limit).ok).toBe(true);
    const over = rateLimit("ip-a", limit);
    expect(over.ok).toBe(false);
    expect(over.remaining).toBe(0);
    expect(over.retryAfter).toBeGreaterThan(0);
  });

  test("counters are per key", () => {
    resetRateLimits();
    for (let i = 0; i < 3; i++) rateLimit("ip-b", 3);
    expect(rateLimit("ip-b", 3).ok).toBe(false);
    expect(rateLimit("ip-c", 3).ok).toBe(true);
  });

  test("the window resets", () => {
    resetRateLimits();
    // The clock is injected so this does not depend on how fast the test runs.
    const t0 = 1_000_000;
    expect(rateLimit("ip-d", 2, 60_000, t0).ok).toBe(true);
    expect(rateLimit("ip-d", 2, 60_000, t0 + 1).ok).toBe(true);
    expect(rateLimit("ip-d", 2, 60_000, t0 + 2).ok).toBe(false);
    // Once the window has passed the caller is welcome again.
    expect(rateLimit("ip-d", 2, 60_000, t0 + 60_001).ok).toBe(true);
  });

  test("429 carries the standard headers and a retry hint", async () => {
    resetRateLimits();
    const lim = CONFIG.api.rateLimitPerMinute;
    const d = deps();
    let last: Response | null = null;
    for (let i = 0; i <= lim; i++) last = await handleV1("/api/v1/search", url("/api/v1/search?q=x"), d);
    expect(last!.status).toBe(429);
    expect(last!.headers.get("x-ratelimit-limit")).toBe(String(lim));
    expect(last!.headers.get("retry-after")).toBeTruthy();
    const body = (await last!.json()) as any;
    expect(body.error).toBe("rate limit exceeded");
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
  });
});

describe("routing", () => {
  test("recognises the v1 prefix only", () => {
    expect(isV1("/api/v1")).toBe(true);
    expect(isV1("/api/v1/search")).toBe(true);
    expect(isV1("/api/v1/")).toBe(true);
    expect(isV1("/api/search")).toBe(false);
    expect(isV1("/api/v10/search")).toBe(false);
    expect(isV1("/")).toBe(false);
  });

  test("normalises trailing slashes and nested paths", () => {
    expect(v1Path("/api/v1")).toBe("");
    expect(v1Path("/api/v1/")).toBe("");
    expect(v1Path("/api/v1/search/")).toBe("search");
    expect(v1Path("/api/v1/deep/nested")).toBe("deep/nested");
  });

  test("an unknown endpoint is a 404 that points at the index", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/nope", url("/api/v1/nope"), deps());
    expect(res.status).toBe(404);
    const body = (await res.json()) as any;
    expect(body.error).toContain("/api/v1/nope");
    expect(body.hint).toContain("/api/v1");
  });
});

describe("the API describes itself", () => {
  test("/api/v1 lists every endpoint with its parameters", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1", url("/api/v1"), deps());
    const body = (await res.json()) as any;
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(body.endpoints.map((e: any) => e.path).sort()).toEqual([
      "/api/v1/overview",
      "/api/v1/search",
      "/api/v1/stats",
    ]);
    const search = body.endpoints.find((e: any) => e.path === "/api/v1/search");
    expect(search.parameters.q.required).toBe(true);
    expect(search.parameters.type.enum).toContain("video");
    expect(body.rateLimit.requests).toBe(CONFIG.api.rateLimitPerMinute);
  });

  test("the internal routes are not part of the public API", async () => {
    const body = (await (await handleV1("/api/v1", url("/api/v1"), deps())).json()) as any;
    const paths = body.endpoints.map((e: any) => e.path).join(" ");
    // the agent chat spends model quota per caller, doctor exposes the crawler
    expect(paths).not.toContain("chat");
    expect(paths).not.toContain("doctor");
  });
});

describe("parameter handling", () => {
  test("q is required and the error suggests a working call", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/search", url("/api/v1/search"), deps());
    expect(res.status).toBe(400);
    const body = (await res.json()) as any;
    expect(body.error).toContain("q");
    expect(body.hint).toContain("q=");
  });

  test("limit is clamped instead of rejected", () => {
    expect(clampInt("5", 10, 1, 50)).toBe(5);
    expect(clampInt("9999", 10, 1, 50)).toBe(50);
    expect(clampInt("0", 10, 1, 50)).toBe(1);
    expect(clampInt("-3", 10, 1, 50)).toBe(1);
    expect(clampInt(null, 10, 1, 50)).toBe(10);
    expect(clampInt("abc", 10, 1, 50)).toBe(10);
  });

  test("deep accepts the usual spellings of false", () => {
    expect(parseBool(null, true)).toBe(true);
    expect(parseBool("0", true)).toBe(false);
    expect(parseBool("false", true)).toBe(false);
    expect(parseBool("no", true)).toBe(false);
    expect(parseBool("1", false)).toBe(true);
  });
});

describe("search responses", () => {
  const seeded = () => {
    const idx = new InvertedIndex();
    for (let i = 0; i < 7; i++) {
      // Real-looking hosts, enough prose to clear the quality gate (minWords is
      // 120), and no repeated sentences: the repetition check would rightly
      // call a paragraph pasted three times boilerplate.
      const body = [
        `Gardening is the practice of growing plants and maintaining a garden, which guide ${i} approaches from first principles.`,
        `Soil drainage in plot ${i} matters more than most beginners expect, because waterlogging kills roots faster than drought does.`,
        `Watering schedule ${i} should follow the season rather than a fixed timer, since evaporation doubles in midsummer here.`,
        `Pruning in late winter keeps the canopy of specimen ${i} open to light, and it is the only window that avoids sap loss.`,
        `Mulch applied too thickly will rot the stem collar of young plant ${i}, so two centimetres is plenty in this climate.`,
        `Composted bark finishes the bed around ${i} and returns nutrients slowly, which suits the clay soil described above.`,
        `Records of sowing dates for plot ${i} make next year's plan easier, because gaps in the rotation show up in the data.`,
        `A good pair of secateurs matters more than any gadget, and a sharp blade on plant ${i} halves the wasted stems.`,
      ].join(" ");
      idx.addDocument({
        id: `d${i}`,
        url: `https://garden${i}.com/guide`,
        title: `Gardening guide ${i}`,
        text: body,
        lang: "en",
        outlinks: [],
        fetchedAt: new Date().toISOString(),
        contentHash: `h${i}`,
        wordCount: body.split(/\s+/).length,
      });
    }
    return idx;
  };

  test("returns a documented shape with ranks and paging", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/search", url("/api/v1/search?q=gardening&limit=3"), deps({ index: seeded() }));
    const body = (await res.json()) as any;
    expect(body.query).toBe("gardening");
    expect(body.results).toHaveLength(3);
    expect(body.results[0].rank).toBe(1);
    expect(body.nextOffset).toBe(3);
    for (const key of ["url", "title", "snippet", "domain", "score", "type"]) {
      expect(body.results[0]).toHaveProperty(key);
    }
  });

  test("offset pages through without repeating results", async () => {
    resetRateLimits();
    const d = deps({ index: seeded() });
    const first = (await (await handleV1("/api/v1/search", url("/api/v1/search?q=gardening&limit=3"), d)).json()) as any;
    const second = (await (await handleV1("/api/v1/search", url("/api/v1/search?q=gardening&limit=3&offset=3"), d)).json()) as any;
    const overlap = first.results.map((r: any) => r.url).filter((u: string) => second.results.some((r: any) => r.url === u));
    expect(overlap).toHaveLength(0);
    expect(second.results[0].rank).toBe(4);
    expect(second.nextOffset).toBe(6);
  });

  test("the last page reports no next offset", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/search", url("/api/v1/search?q=gardening&limit=50"), deps({ index: seeded() }));
    const body = (await res.json()) as any;
    expect(body.nextOffset).toBeNull();
  });

  test("a domain filter narrows results", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/search", url("/api/v1/search?q=gardening&domain=garden3.com"), deps({ index: seeded() }));
    const body = (await res.json()) as any;
    expect(body.results.length).toBeGreaterThan(0);
    expect(body.results.every((r: any) => r.domain === "garden3.com")).toBe(true);
  });

  test("an empty result set is still a well-formed answer", async () => {
    resetRateLimits();
    const res = await handleV1("/api/v1/search", url("/api/v1/search?q=zzzznothinghere"), deps({ index: seeded() }));
    const body = (await res.json()) as any;
    expect(res.status).toBe(200);
    expect(body.results).toEqual([]);
    expect(body.total).toBe(0);
    expect(body.nextOffset).toBeNull();
  });
});