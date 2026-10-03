import { describe, expect, test } from "bun:test";
import { isJunkUrl, isLatinLanguageCode, isLowQualityText, rejectDoc } from "./quality.ts";

describe("quality gate", () => {
  test("drops login-walled social hosts and ad infrastructure", () => {
    expect(isJunkUrl("https://twitter.com/someone")).toBe(true);
    expect(isJunkUrl("https://www.instagram.com/pic")).toBe(true);
    expect(isJunkUrl("https://aboutads.info/")).toBe(true);
  });

  test("keeps crawlable video and docs sites", () => {
    // robots.txt allows / on these; they are legitimate search targets.
    expect(isJunkUrl("https://www.youtube.com/watch?v=abc")).toBe(false);
    expect(isJunkUrl("https://developer.mozilla.org/en-US/docs/Web")).toBe(false);
  });

  test("drops account, legal and listing pages", () => {
    expect(isJunkUrl("https://arstechnica.com/subscribe")).toBe(true);
    expect(isJunkUrl("https://example.com/privacy")).toBe(true);
    expect(isJunkUrl("https://news.ycombinator.com/user?id=alice")).toBe(true);
    expect(isJunkUrl("https://example.com/tag/rust/")).toBe(true);
    expect(isJunkUrl("https://example.com/u/alice")).toBe(true);
  });

  test("keeps real content pages", () => {
    expect(isJunkUrl("https://arstechnica.com/gadgets/2026/01/post/")).toBe(false);
  });

  test("language codes map to scripts", () => {
    expect(isLatinLanguageCode("en-GB")).toBe(true);
    expect(isLatinLanguageCode("de")).toBe(true);
    expect(isLatinLanguageCode("ar")).toBe(false);
  });

  test("rejects a Persian wikipedia page", () => {
    const doc = {
      url: "https://fa.wikipedia.org/wiki/جستجوگر",
      lang: "fa",
      text: "جستجوگر گوگل - ویکی‌پدیا، دانشنامهٔ آزاد یک موتور جستجو است که کاربران وب را میانگردد.",
    };
    expect(rejectDoc(doc).language).toBe(true);
  });

  test("rejects a Russian page even without a lang attribute", () => {
    expect(rejectDoc({ url: "https://example.com/ru", text: "Поисковая система Википедия это сайт".repeat(4) }).language).toBe(true);
  });

  test("accepts a real article but rejects a short index page", () => {
    const article = {
      url: "https://www.bbc.com/news/story",
      lang: "en",
      wordCount: 640,
      text: "Global markets moved through the session today while leaders met in Geneva to discuss a new energy agreement covering imports, tariffs and long term supply contracts across the region.",
    };
    expect(rejectDoc(article)).toEqual({});

    const indexPage = { url: "https://news.ycombinator.com/news", lang: "en", wordCount: 30, text: "News Ask Show Jobs Comments Saved Past" };
    expect(rejectDoc(indexPage).lowQuality).toBe(true);
  });

  test("rejects nav-only boilerplate and cookie walls", () => {
    expect(isLowQualityText("Home About Contact Privacy Terms Subscribe")).toBe(true);
    expect(isLowQualityText("Please enable JavaScript to continue.")).toBe(true);
    expect(isLowQualityText("A detailed article body with real prose about markets and policy, written for a reader who wants to understand what happened and why.")).toBe(false);
  });

  test("rejects a nav-only page even on an allowed host", () => {
    const doc = {
      url: "https://www.youtube.com/",
      text: "About Press Copyright Contact us Creators Advertise Developers Terms Privacy Policy & Safety".repeat(3),
    };
    expect(rejectDoc(doc).lowQuality).toBe(true);
  });

  test("a site card survives the gate even though it is link-heavy", () => {
    // Regression: a duplicated density check used to prune every site card,
    // which is why searching "google" found nothing.
    const card = { url: "https://www.google.com/", text: "Google — google.com. ", wordCount: 4, linkDensity: 0.9, siteCard: true };
    expect(rejectDoc(card)).toEqual({});
  });

  test("a stub entry survives too", () => {
    const stub = { url: "https://stackoverflow.com/", text: "Stack Overflow — stackoverflow.com. Listed in the MiniSearch allowlist.", wordCount: 10, linkDensity: 1, siteCard: true, stub: true };
    expect(rejectDoc(stub)).toEqual({});
  });
});