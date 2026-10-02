import { describe, expect, test } from "bun:test";
import { decodeHtml } from "./fetcher.ts";
import { parseHtml, normalizeUrl } from "./parser.ts";

const enc = new TextEncoder();

describe("fetcher charset", () => {
  // 0x63 0x61 0x66 0xE9 is "café" in latin1 / windows-1252.
  const latin1Cafe = new Uint8Array([0x3c, 0x70, 0x3e, 0x63, 0x61, 0x66, 0xe9, 0x3c, 0x2f, 0x70, 0x3e]);

  test("honors Content-Type charset instead of assuming UTF-8", () => {
    const out = decodeHtml(latin1Cafe.buffer, "text/html; charset=windows-1252");
    expect(out).toContain("café");
    expect(new TextDecoder("utf-8").decode(latin1Cafe)).not.toContain("café");
  });

  test("falls back to meta charset", () => {
    const html = '<html><head><meta charset="utf-8"><title>café</title></head></html>';
    expect(decodeHtml(enc.encode(html).buffer, "text/html")).toContain("café");
  });

  test("utf-8 default", () => {
    expect(decodeHtml(enc.encode("<p>naïve</p>").buffer, "")).toContain("naïve");
  });

  test("unknown charset label does not throw", () => {
    expect(decodeHtml(enc.encode("<p>ok</p>").buffer, "text/html; charset=bogus-9")).toContain("ok");
  });
});

describe("parser", () => {
  test("extracts title, text, lang and absolute links", () => {
    const html = `<html lang="en"><head><title>Hello World</title></head><body><p>Hi there search!</p><a href="/about">About</a><a href="https://other.test/x">X</a></body></html>`;
    const p = parseHtml(html, "https://example.com/page");
    expect(p.title).toBe("Hello World");
    expect(p.lang).toBe("en");
    expect(p.text).toContain("Hi there");
    expect(p.links).toContain("https://example.com/about");
    expect(p.links).toContain("https://other.test/x");
  });

  test("normalizeUrl strips hash and trailing slash", () => {
    expect(normalizeUrl("https://example.com/a/#frag")).toBe("https://example.com/a");
  });
});