import { describe, expect, test } from "bun:test";
import { isJunkUrl } from "./crawler.ts";
import { Frontier } from "./frontier.ts";

describe("junk link filter", () => {
  test("drops social, video and ad hosts", () => {
    expect(isJunkUrl("https://www.youtube.com/@arstechnica")).toBe(true);
    expect(isJunkUrl("https://twitter.com/someone")).toBe(true);
    expect(isJunkUrl("https://instagram.com/pic")).toBe(true);
    expect(isJunkUrl("https://pagead2.googlesyndication.com/pagead/js/ads.js")).toBe(true);
  });

  test("drops account and legal pages", () => {
    expect(isJunkUrl("https://arstechnica.com/subscribe")).toBe(true);
    expect(isJunkUrl("https://example.com/privacy-policy")).toBe(true);
    expect(isJunkUrl("https://example.com/user-agreement")).toBe(true);
  });

  test("keeps real content pages", () => {
    expect(isJunkUrl("https://arstechnica.com/gadgets/2026/01/some-post/")).toBe(false);
    expect(isJunkUrl("https://developer.mozilla.org/en-US/docs/Web/CSS")).toBe(false);
  });

  test("drops malformed urls", () => {
    expect(isJunkUrl("not a url")).toBe(true);
  });
});

describe("frontier", () => {
  test("dedups and respects per-host politeness", () => {
    const f = new Frontier(["https://example.com/a", "https://example.com/a"], 100_000);
    expect(f.seenCount).toBe(1);
    expect(f.pendingCount).toBe(1);
    expect(f.popReady()).toBe("https://example.com/a");
    expect(f.popReady()).toBe(null);
  });
});