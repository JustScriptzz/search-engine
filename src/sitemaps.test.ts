import { afterEach, describe, expect, test } from "bun:test";
import { collectSitemapUrls, robotsSitemaps } from "./sitemaps.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(impl: (url: string) => Promise<Response>) {
  globalThis.fetch = ((input: RequestInfo | URL) => impl(String(input))) as unknown as typeof fetch;
}

describe("sitemap discovery", () => {
  test("reads Sitemap: lines from robots.txt", async () => {
    stubFetch(async (url) => {
      if (!url.endsWith("robots.txt")) return new Response("", { status: 404 });
      return new Response(
        "User-agent: *\nDisallow: /admin\nSitemap: https://x.test/sitemap.xml\nsitemap: https://x.test/news.xml\n",
      );
    });
    expect(await robotsSitemaps("https://x.test")).toEqual([
      "https://x.test/sitemap.xml",
      "https://x.test/news.xml",
    ]);
  });

  test("follows sitemap indexes one level deep", async () => {
    stubFetch(async (url) => {
      if (url.endsWith("robots.txt")) return new Response("", { status: 404 });
      if (url.endsWith("/sitemap.xml"))
        return new Response(
          `<?xml version="1.0"?><sitemapindex><sitemap><loc>https://x.test/sitemap-1.xml</loc></sitemap></sitemapindex>`,
        );
      if (url.endsWith("sitemap-1.xml"))
        return new Response(
          `<?xml version="1.0"?><urlset><url><loc>https://x.test/a.html</loc></url><url><loc>https://x.test/b.html</loc></url></urlset>`,
        );
      return new Response("", { status: 404 });
    });
    const res = await collectSitemapUrls("https://x.test", { maxSitemaps: 5, maxUrls: 10 });
    expect(res.urls).toEqual(["https://x.test/a.html", "https://x.test/b.html"]);
    expect(res.sitemaps).toBe(2);
  });

  test("decodes XML entities and honours maxUrls", async () => {
    stubFetch(async (url) =>
      url.endsWith("robots.txt")
        ? new Response("", { status: 404 })
        : new Response(
            `<urlset><url><loc>https://x.test/a?x=1&amp;y=2</loc></url><url><loc>https://x.test/b</loc></url></urlset>`,
          ),
    );
    const res = await collectSitemapUrls("https://x.test", { maxUrls: 1 });
    expect(res.urls).toEqual(["https://x.test/a?x=1&y=2"]);
  });

  test("unreadable sitemaps are reported, not thrown", async () => {
    stubFetch(async (url) => (url.endsWith("robots.txt") ? new Response("", { status: 404 }) : new Response("", { status: 500 })));
    const res = await collectSitemapUrls("https://x.test", { maxSitemaps: 2 });
    expect(res.urls).toEqual([]);
    expect(res.errors.length).toBeGreaterThan(0);
  });
});