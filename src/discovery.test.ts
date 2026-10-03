import { afterEach, describe, expect, test } from "bun:test";
import { discoverFromIndex, latestCollection } from "./discovery.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: () => Promise<Response>) {
  globalThis.fetch = impl as unknown as typeof fetch;
}

function ndjson(rows: unknown[]): Response {
  return new Response(rows.map((r) => JSON.stringify(r)).join("\n") + "\n", {
    headers: { "content-type": "application/x-ndjson" },
  });
}

describe("discovery (Common Crawl index)", () => {
  test("picks the newest MAIN collection", async () => {
    stubFetch(async () => Response.json([{ id: "CC-MAIN-2026-39" }, { id: "CC-MAIN-2026-33" }]));
    expect(await latestCollection()).toBe("CC-MAIN-2026-39");
  });

  test("keeps only crawlable 200 HTML URLs, drops assets", async () => {
    stubFetch(async () =>
      ndjson([
        { url: "https://www.nasa.gov/1952/03/", status: "200", mime: "text/html" },
        { url: "https://www.nasa.gov/logo.png", status: "200", mime: "image/png" },
        { url: "https://www.nasa.gov/gone/", status: "404", mime: "text/html" },
        { url: "https://www.nasa.gov/a", status: "200", mime: "text/html" },
        { url: "https://www.nasa.gov/a", status: "200", mime: "text/html" },
        { url: "javascript:void(0)", status: "200", mime: "text/html" },
      ]),
    );
    const res = await discoverFromIndex("*.nasa.gov/*", 10, { collection: "CC-MAIN-TEST" });
    expect(res.collection).toBe("CC-MAIN-TEST");
    expect(res.urls).toEqual(["https://www.nasa.gov/1952/03/", "https://www.nasa.gov/a"]);
  });

  test("honours the limit even when the index streams more", async () => {
    stubFetch(async () =>
      ndjson(Array.from({ length: 50 }, (_, i) => ({ url: `https://e.org/${i}`, status: "200", mime: "text/html" }))),
    );
    const res = await discoverFromIndex("*.e.org/*", 5, { collection: "CC-MAIN-TEST" });
    expect(res.urls).toHaveLength(5);
  });

  test("reports a failure instead of throwing", async () => {
    stubFetch(async () => new Response("nope", { status: 504 }));
    const res = await discoverFromIndex("*.x.org/*", 5, { collection: "CC-MAIN-TEST" });
    expect(res.urls).toEqual([]);
    expect(res.error).toContain("504");
  });
});