export interface CrawledDoc {
  id: string; // stable hash of normalized URL
  url: string;
  title: string;
  text: string;
  outlinks: string[];
  fetchedAt: string; // ISO
  contentHash: string; // simhash-ish (sha256 of normalized text)
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
