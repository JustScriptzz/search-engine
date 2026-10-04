export interface CrawledDoc {
  id: string; // stable hash of normalized URL
  url: string;
  title: string;
  text: string;
  lang: string; // <html lang> when present, else ""
  linkDensity?: number; // share of text that was link labels (0..1)
  siteCard?: boolean; // minimal "site card" for an allowlisted famous homepage
  stub?: boolean; // allowlist entry whose page could not be fetched
  /** Video/image indexed from its metadata (title + description + thumbnail). */
  mediaCard?: boolean;
  /** Page text came from a Common Crawl WARC record, not from the origin. Those
   *  sites disallow crawling, so this flag keeps the distinction honest. */
  viaCommonCrawl?: boolean;
  /**
   * Semantic vector, stored quantised: base64 of one signed byte per dimension
   * plus the scale it was quantised with. 1 KB per page rather than 4 KB, which
   * is the difference between a semantic layer that fits and one that does not.
   */
  vec?: { v: string; s: number };
  /** Vertical classification from page metadata (article/image/video/short). */
  media?: {
    type: "text" | "image" | "video" | "short";
    image?: string;
    videoUrl?: string;
    provider?: string;
    duration?: number;
    width?: number;
    height?: number;
    shortPath?: string;
  };
  outlinks: string[];
  fetchedAt: string; // ISO
  contentHash: string; // sha256 of normalized text (near-duplicate guard)
  wordCount: number;
}

export interface SearchHit {
  id: string;
  url: string;
  title: string;
  snippet: string;
  score: number;
  wordCount: number;
  matchedTerms: number; // how many unique query terms this doc contains
  queryTerms: number; // how many unique terms the query had
  lang: string; // page language when the source declared one
}

export interface IndexStats {
  docCount: number;
  termCount: number;
  avgDocLen: number;
}