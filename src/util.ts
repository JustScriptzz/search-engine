// Small helpers shared by the server and the public API.

/** Hostname without "www.", lowercased. Used for domain facets and trust tiers. */
export function domainOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
}

/** Scores are floats; three decimals is plenty and keeps the JSON readable. */
export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}