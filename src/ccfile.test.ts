import { describe, expect, test } from "bun:test";
import { isIpHost, parseCdxLine, parseIndexLine, sampleWithStride, usableRecord } from "./ccimport.ts";

/** A verbatim line from a CC-MAIN CDX shard, real domain, status 200. */
const REAL = `com,webuyanyhouseindfw)/ 20240804170014 {"url": "https://www.webuyanyhouseindfw.com/", "mime": "text/html", "mime-detected": "text/html", "status": "200", "digest": "IJV4VOD56LQ2UXTIMN3TWT4R7D26ZWL2", "length": "38912", "offset": "7123456", "filename": "crawl-data/CC-MAIN-2024-33/segments/1722640768597.52/CC-MAIN-20240804170014-20240804190000-00042.warc.gz"}`;

/** The head of shard 00000: bare IP addresses, as sorted. */
const IP_LINE = `0,0,0,1)/robots.txt 20240809191528 {"url": "http://1.000.000.000/robots.txt", "mime": "text/html", "mime-detected": "text/html", "status": "403", "digest": "CWTTSPWRXE4OJM3QXZEJHX5WPCNES5XC", "length": "2707", "offset": "896", "filename": "crawl-data/CC-MAIN-2024-33/segments/1722640768597.52/robotstxt/CC-MAIN-20240809173246-20240809203246-00532.warc.gz"}`;

describe("CDX lines", () => {
  test("a real record keeps the WARC pointer that carries the content", () => {
    const rec = parseCdxLine(REAL);
    expect(rec).not.toBeNull();
    expect(rec!.url).toBe("https://www.webuyanyhouseindfw.com/");
    expect(rec!.filename).toContain(".warc.gz");
    // These are the fields a naive `sed 's/.*"url".*/\1/'` throws away, and they
    // are the only way to get the page text.
    expect(rec!.offset).toBe(7123456);
    expect(rec!.length).toBe(38912);
  });

  test("offset and length are strings in CDX and still parse as numbers", () => {
    // Real lines carry "offset": "896" — a string. Number.isFinite does not
    // coerce, which silently rejected every record until it was fixed.
    expect(typeof JSON.parse(REAL.slice(REAL.indexOf("{"))).offset).toBe("string");
    expect(parseCdxLine(REAL)!.offset).toBeGreaterThan(0);
    expect(parseIndexLine(REAL.slice(REAL.indexOf("{")))!.length).toBeGreaterThan(0);
  });

  test("bare IP hosts are skipped", () => {
    // Shard 00000 is sorted by SURT key, so it starts with numeric addresses.
    expect(parseCdxLine(IP_LINE)).toBeNull();
    expect(isIpHost("http://1.0.0.0/")).toBe(true);
    expect(isIpHost("http://165.22.100.0")).toBe(true);
    expect(isIpHost("https://www.example.com/")).toBe(false);
  });

  test("non-HTML and stub captures are skipped", () => {
    expect(usableRecord({ mime: "image/jpeg", filename: "f", offset: 1, length: 9000 })).toBe(false);
    expect(usableRecord({ mime: "text/html", filename: "f", offset: 1, length: 12 })).toBe(false);
    expect(usableRecord({ mime: "text/html", filename: "", offset: 1, length: 9000 })).toBe(false);
    expect(usableRecord({ mime: "text/html", offset: 1, length: 9000 })).toBe(false);
    expect(usableRecord({ mime: "text/html", filename: "f", offset: "x", length: "y" })).toBe(false);
  });

  test("a line with no JSON is ignored", () => {
    expect(parseCdxLine("")).toBeNull();
    expect(parseCdxLine("not a record at all")).toBeNull();
    expect(parseCdxLine('key 2024 {broken json')).toBeNull();
  });
});

describe("sampling a shard", () => {
  test("takes the head when there is not much to choose from", () => {
    expect(sampleWithStride([1, 2, 3], 10, 3)).toEqual([1, 2, 3]);
  });

  test("spreads across the file instead of taking one alphabetical cluster", () => {
    const items = Array.from({ length: 1000 }, (_, i) => i);
    const picked = sampleWithStride(items, 10, 1000);
    expect(picked).toHaveLength(10);
    // Without a stride this would be [0..9], all from the same slice of the
    // SURT keyspace — one narrow alphabetical band of hosts.
    expect(picked[0]).toBe(0);
    expect(picked[picked.length - 1]).toBeGreaterThan(500);
  });

  test("handles being asked for nothing", () => {
    expect(sampleWithStride([1, 2, 3], 0, 3)).toEqual([]);
    expect(sampleWithStride([], 5, 0)).toEqual([]);
  });
});