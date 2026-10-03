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

/** Short, stable id for a document: the first 16 hex chars of its URL's sha256. */
export function hash(s: string): string {
  const h = new Bun.CryptoHasher("sha256");
  h.update(s);
  return h.digest("hex").slice(0, 16);
}

/** Whitespace-collapsed lowercase text, used for content-hash dedup. */
export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}