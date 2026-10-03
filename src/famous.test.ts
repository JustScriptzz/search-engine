import { describe, expect, test } from "bun:test";
import { FAMOUS_SITES, isFamousHost } from "./famous.ts";
import { isJunkUrl } from "./quality.ts";

describe("famous sites", () => {
  test("allowlist covers the obvious ones", () => {
    const hosts = FAMOUS_SITES.map((s) => new URL(s.url).hostname.replace(/^www\./, ""));
    for (const expected of ["google.com", "en.wikipedia.org", "github.com", "nasa.gov", "bbc.com", "ansa.it"]) {
      expect(hosts).toContain(expected);
    }
  });

  test("every entry is a valid http(s) URL", () => {
    for (const site of FAMOUS_SITES) {
      const u = new URL(site.url);
      expect(["http:", "https:"]).toContain(u.protocol);
      expect(u.pathname.length).toBeGreaterThan(0);
    }
  });

  test("host matching covers subdomains but not lookalikes", () => {
    expect(isFamousHost("www.google.com")).toBe(true);
    expect(isFamousHost("news.ycombinator.com")).toBe(true);
    expect(isFamousHost("notgoogle.com")).toBe(false);
    expect(isFamousHost("example.com")).toBe(false);
  });

  test("store/checkout/auth pages stay blocked even on famous hosts", () => {
    expect(isJunkUrl("https://apps.apple.com/us/app/x/id375380948")).toBe(true);
    expect(isJunkUrl("https://signin.aws.amazon.com/signup")).toBe(true);
    expect(isJunkUrl("https://www.google.com/imghp?hl=en")).toBe(true);
    expect(isJunkUrl("https://www.google.com/")).toBe(false);
  });
});