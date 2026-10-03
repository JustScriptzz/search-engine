export interface CrawledDoc {
  id: string; // stable hash of normalized URL
  url: string;
  title: string;
  text: string;
  lang: string; // <html lang> when present, else ""
  linkDensity?: number; // share of text that was link labels (0..1)
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