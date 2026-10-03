import { describe, expect, test } from "bun:test";
import { isFamousHost, isTrustedHost } from "./famous.ts";
import { CONFIG } from "./config.ts";

describe("trust tiers", () => {
  test("allowlisted hosts are trusted", () => {
    expect(isTrustedHost("github.com")).toBe(true);
    expect(isTrustedHost("stackoverflow.com")).toBe(true);
  });

  test("seed hosts and their subdomains are trusted", () => {
    const seedHost = new URL(CONFIG.seeds[0]).hostname.replace(/^www\./, "");
    expect(isTrustedHost(seedHost)).toBe(true);
    expect(isTrustedHost(`blog.${seedHost}`)).toBe(true);
  });

  test("Common Crawl link-farm spam is not trusted", () => {
    // These are the hosts that turn up via certificate transparency and crowd
    // out the sites we actually seeded. (A subdomain of a seeded host inherits
    // its trust: 1cm.loc.gov is Library of Congress, so it stays trusted.)
    for (const junk of [
      "thepartnershipineducation.com",
      "ocw-openmatters.org",
      "recovercovid.org",
      "bencology.bearblog.dev",
      "offrun.dev",
    ]) {
      expect(isFamousHost(junk)).toBe(false);
      expect(isTrustedHost(junk)).toBe(false);
    }
  });

  test("a subdomain of a seeded host keeps its trust", () => {
    expect(isTrustedHost("1cm.loc.gov")).toBe(true);
  });

  test("trust configuration keeps discovered pages visible but demoted", () => {
    expect(CONFIG.trust.discoveredPenalty).toBeLessThan(1);
    expect(CONFIG.trust.discoveredPenalty).toBeGreaterThan(0);
    expect(CONFIG.trust.curatedBoost).toBeGreaterThan(1);
  });
});