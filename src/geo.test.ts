import { describe, expect, test } from "bun:test";
import { countryBoost, languageBoost, languagesForCountry, tldOf } from "./geo.ts";
import { CONFIG } from "./config.ts";

describe("geo ranking", () => {
  test("tld extraction", () => {
    expect(tldOf("https://www.dw.de/x")).toBe("de");
    expect(tldOf("https://news.bbc.co.uk/y")).toBe("co.uk");
    expect(tldOf("https://example.com/a")).toBe("com");
  });

  test("Italian visitors get Italian domains first", () => {
    expect(countryBoost("https://www.repubblica.it/x", "IT")).toBeGreaterThan(1);
    expect(countryBoost("https://www.bbc.com/x", "IT")).toBe(1);
    // .com counts as US-local, so an Italian visitor gets no boost there
    expect(countryBoost("https://www.bbc.com/x", "US")).toBeGreaterThan(1);
  });

  test("language boost follows the visitor's country", () => {
    expect(languagesForCountry("IT")).toContain("it");
    expect(languageBoost("it", "IT")).toBe(CONFIG.geo.langBoost);
    expect(languageBoost("it-CH", "IT")).toBe(CONFIG.geo.langBoost);
    expect(languageBoost("de", "IT")).toBe(1);
    // English is the secondary language everywhere we boost
    expect(languageBoost("en", "IT")).toBe(1 + (CONFIG.geo.langBoost - 1) / 2);
    expect(languageBoost("", "IT")).toBe(1);
  });

  test("unknown country boosts nothing", () => {
    expect(countryBoost("https://x.com/a", "XX")).toBe(1);
    expect(languageBoost("it", "XX")).toBe(1);
  });
});