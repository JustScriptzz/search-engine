export interface CrawledDoc {
  id: string; // stable hash of normalized URL
  url: string;
  title: string;
  text: string;
  lang: string; // <html lang> when present, else ""
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
}

export interface IndexStats {
  docCount: number;
  termCount: number;
  avgDocLen: number;
}