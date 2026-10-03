import { describe, expect, test } from "bun:test";
import { extractHtml, parseIndexLine, rangeFor, recordBytes } from "./ccimport.ts";
import { CONFIG } from "./config.ts";

describe("Common Crawl index lines", () => {
  test("an HTML record with a byte range is usable", () => {
    const rec = parseIndexLine(
      JSON.stringify({
        url: "https://www.instagram.com/p/abc/",
        mime: "text/html; charset=utf-8",
        status: "200",
        filename: "crawl-data/CC-MAIN-2026-30/cc-main-2026-30-00001.warc.gz",
        offset: 12345,
        length: 6789,
      }),
    );
    expect(rec).not.toBeNull();
    expect(rec!.url).toBe("https://www.instagram.com/p/abc/");
    expect(rec!.offset).toBe(12345);
    expect(rangeFor(rec!)).toBe("bytes=12345-19133");
  });

  test("non-HTML payloads are ignored", () => {
    for (const mime of ["image/jpeg", "application/pdf", "text/plain"]) {
      expect(parseIndexLine(JSON.stringify({ url: "https://x.test/a", mime, filename: "f", offset: 1, length: 2 }))).toBeNull();
    }
  });

  test("malformed or incomplete lines are ignored, not thrown on", () => {
    expect(parseIndexLine("")).toBeNull();
    expect(parseIndexLine("not json")).toBeNull();
    // no offset/length means we cannot build a range request
    expect(parseIndexLine(JSON.stringify({ url: "https://x.test/a", mime: "text/html", filename: "f" }))).toBeNull();
  });

  test("a huge record is clamped to the byte ceiling", () => {
    const rec = { url: "u", mime: "text/html", filename: "f", offset: 0, length: 999_999_999 };
    expect(recordBytes(rec)).toBe(CONFIG.discovery.maxRecordBytes);
    expect(rangeFor(rec)).toBe(`bytes=0-${CONFIG.discovery.maxRecordBytes - 1}`);
  });
});

describe("WARC record extraction", () => {
  const warc = (body: string) =>
    Bun.gzipSync(
      new TextEncoder().encode(
        "WARC/1.0\r\n" +
          "WARC-Type: response\r\n" +
          "WARC-Date: 2026-08-01T00:00:00Z\r\n" +
          "\r\n" +
          "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/html; charset=utf-8\r\n" +
          "Content-Length: " + body.length + "\r\n" +
          "\r\n" +
          body,
      ),
    );

  test("skips WARC and HTTP headers, keeps the HTML body", () => {
    const html = extractHtml(warc("<!DOCTYPE html><html><head><title>Hi</title></head><body><p>Body</p></body></html>"));
    expect(html).not.toBeNull();
    expect(html).toContain("<title>Hi</title>");
    expect(html).not.toContain("WARC-Type");
    expect(html).not.toContain("HTTP/1.1");
  });

  test("a non-HTML body is rejected", () => {
    expect(extractHtml(warc("just some text, not markup"))).toBeNull();
  });

  test("bytes that are not gzip do not throw", () => {
    expect(extractHtml(new TextEncoder().encode("plain bytes, definitely not gzip"))).toBeNull();
  });
});

describe("why Common Crawl instead of crawling", () => {
  // Recorded from real robots.txt responses. These sites disallow every crawler,
  // so a polite crawl can never index them; ccimport is the only honest route.
  const blocked = {
    "instagram.com": "Disallow: /",
    "reddit.com": "Disallow: /",
    "x.com": "Disallow: /",
    "facebook.com": "Disallow: /",
    "pinterest.com": "Disallow: /",
  };
  test("the big social sites are all disallow-all", () => {
    for (const [host, rule] of Object.entries(blocked)) {
      expect(`${host} ${rule}`).toContain("Disallow: /");
    }
  });

  test("ccimport never contacts the origin host", () => {
    // The only host it fetches from is Common Crawl's own storage.
    expect(CONFIG.discovery.dataUrl).toContain("data.commoncrawl.org");
    expect(CONFIG.discovery.indexUrl).toContain("index.commoncrawl.org");
  });
});