import { describe, expect, test } from "bun:test";
import { countryBoost, getClientIp, lookupCountry, tldOf } from "./geo.ts";

describe("geo", () => {
  test("tldOf extracts home TLD", () => {
    expect(tldOf("https://www.dw.com/en/x")).toBe("com");
    expect(tldOf("https://www.dw.de/x")).toBe("de");
    expect(tldOf("https://news.bbc.co.uk/y")).toBe("co.uk");
    expect(tldOf("not a url")).toBe("");
  });

  test("countryBoost prefers home TLD only", () => {
    expect(countryBoost("https://zeit.de/a", "DE")).toBe(1.35);
    expect(countryBoost("https://example.com/a", "DE")).toBe(1);
    expect(countryBoost("https://example.com/a", "XX")).toBe(1);
  });

  test("getClientIp prefers x-forwarded-for", () => {
    const req = new Request("http://x/", { headers: { "x-forwarded-for": "1.2.3.4, 5.6.7.8" } });
    expect(getClientIp(req)).toBe("1.2.3.4");
    expect(getClientIp(new Request("http://x/"))).toBe("local");
  });

  test("lookupCountry fails open on local IPs (no network)", async () => {
    const g = await lookupCountry("127.0.0.1");
    expect(g.countryCode).toBe("XX");
  });
});
