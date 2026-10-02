import { describe, expect, test } from "bun:test";
import { parseHtml, normalizeUrl } from "./parser.ts";
import { Frontier } from "./frontier.ts";

describe("parser", () => {
  test("extracts title, text, absolute links", () => {
    const html = `<html><head><title>Hello World</title></head><body><p>Hi there search!</p><a href="/about">About</a><a href="https://other.test/x">X</a></body></html>`;
    const p = parseHtml(html, "https://example.com/page");
    expect(p.title).toBe("Hello World");
    expect(p.text).toContain("Hi there");
    expect(p.links).toContain("https://example.com/about");
    expect(p.links).toContain("https://other.test/x");
  });

  test("normalizeUrl strips hash", () => {
    expect(normalizeUrl("https://example.com/a#frag")).toBe("https://example.com/a");
  });
});

describe("frontier", () => {
  test("dedups and respects politeness", () => {
    const f = new Frontier(["https://example.com/a", "https://example.com/a"], 100_000);
    expect(f.seenCount).toBe(1);
    expect(f.pendingCount).toBe(1);
    expect(f.popReady()).toBe("https://example.com/a");
    expect(f.popReady()).toBe(null);
  });
});
