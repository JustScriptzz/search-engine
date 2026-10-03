import { tokenize } from "./tokenizer.ts";
import { CONFIG } from "../config.ts";
import type { CrawledDoc, IndexStats, SearchHit } from "../types.ts";

interface Posting {
  tf: number;
}

type InvertedList = Map<string, Map<string, Posting>>;

const { k1: K1, b: B, titleRepeat: TITLE_REPEAT, coordination: COORD } = CONFIG.bm25;

export class InvertedIndex {
  docs = new Map<string, CrawledDoc>();
  index: InvertedList = new Map();
  docLens = new Map<string, number>();
  totalLen = 0;

  get docCount() {
    return this.docs.size;
  }

  get avgDocLen() {
    return this.docCount === 0 ? 0 : this.totalLen / this.docCount;
  }

  addDocument(doc: CrawledDoc): boolean {
    if (this.docs.has(doc.id)) return false;
    for (const existing of this.docs.values()) {
      if (existing.contentHash === doc.contentHash) return false;
    }
    // Repeat the title so matches in the title weigh more than body mentions.
    const tokens = tokenize(`${doc.title} `.repeat(TITLE_REPEAT) + doc.text);
    const len = tokens.length;
    if (len === 0) return false;

    this.docs.set(doc.id, doc);
    this.docLens.set(doc.id, len);
    this.totalLen += len;

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      let list = this.index.get(term);
      if (!list) {
        list = new Map();
        this.index.set(term, list);
      }
      list.set(doc.id, { tf: count });
    }
    return true;
  }

  private idf(term: string): number {
    const df = this.index.get(term)?.size ?? 0;
    if (df === 0) return 0;
    const N = this.docCount;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  search(query: string, topK = 10): SearchHit[] {
    const terms = tokenize(query);
    if (terms.length === 0 || this.docCount === 0) return [];
    const avgLen = this.avgDocLen || 1;
    const scores = new Map<string, number>();
    const matched = new Map<string, number>();
    const unique = [...new Set(terms)];

    for (const term of unique) {
      const list = this.index.get(term);
      if (!list) continue;
      const idf = this.idf(term);
      for (const [docId, posting] of list) {
        const dl = this.docLens.get(docId) ?? avgLen;
        const tf = posting.tf;
        const denom = tf + K1 * (1 - B + (B * dl) / avgLen);
        scores.set(docId, (scores.get(docId) ?? 0) + idf * ((tf * (K1 + 1)) / denom));
        matched.set(docId, (matched.get(docId) ?? 0) + 1);
      }
    }

    // Coordination factor: reward documents that cover more of the query.
    const total = unique.length || 1;
    return [...scores.entries()]
      .map(([docId, score]) => {
        const m = matched.get(docId) ?? 0;
        const coord = Math.pow(m / total, COORD);
        return { docId, raw: score, score: score * coord, matchedTerms: m };
      })
      .sort((a, b) => b.score - a.score || b.matchedTerms - a.matchedTerms)
      .slice(0, topK)
      .map(({ docId, score, matchedTerms }) => {
        const doc = this.docs.get(docId)!;
        return {
          id: doc.id,
          url: doc.url,
          title: doc.title || doc.url,
          snippet: makeSnippet(doc.text, terms),
          score: Math.round(score * 1000) / 1000,
          wordCount: doc.wordCount,
          matchedTerms,
          queryTerms: unique.length,
        };
      });
  }

  /** Drop a document and every posting that referenced it (used by `prune`). */
  remove(docId: string): boolean {
    const doc = this.docs.get(docId);
    if (!doc) return false;
    this.docs.delete(docId);
    const len = this.docLens.get(docId);
    if (len !== undefined) {
      this.docLens.delete(docId);
      this.totalLen -= len;
    }
    for (const [term, list] of this.index) {
      if (!list.delete(docId)) continue;
      if (list.size === 0) this.index.delete(term);
    }
    return true;
  }

  stats(): IndexStats {
    return { docCount: this.docCount, termCount: this.index.size, avgDocLen: Math.round(this.avgDocLen * 10) / 10 };
  }

  toJSON() {
    return {
      docs: [...this.docs.values()],
      index: [...this.index.entries()].map(([term, list]) => [term, [...list.entries()]]),
      docLens: [...this.docLens.entries()],
      totalLen: this.totalLen,
    };
  }

  static fromJSON(data: any): InvertedIndex {
    const idx = new InvertedIndex();
    for (const d of data.docs ?? []) idx.docs.set(d.id, d);
    for (const [term, entries] of data.index ?? []) idx.index.set(term, new Map(entries));
    for (const [id, len] of data.docLens ?? []) idx.docLens.set(id, len);
    idx.totalLen = data.totalLen ?? 0;
    return idx;
  }

  async saveToFile(path: string): Promise<void> {
    await Bun.write(path, JSON.stringify(this.toJSON()));
  }

  static async loadFromFile(path: string): Promise<InvertedIndex> {
    try {
      const raw = await Bun.file(path).json();
      return InvertedIndex.fromJSON(raw);
    } catch {
      return new InvertedIndex();
    }
  }
}

export function makeSnippet(text: string, queryTerms: string[], radius = 160): string {
  const lower = text.toLowerCase();
  let best = -1;
  for (const t of queryTerms) {
    const i = lower.indexOf(t);
    if (i !== -1 && (best === -1 || i < best)) best = i;
  }
  if (best === -1) return text.slice(0, radius * 2).trim() + (text.length > radius * 2 ? "…" : "");
  const start = Math.max(0, best - radius);
  const end = Math.min(text.length, best + radius);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (end < text.length) s = s + "…";
  return s;
}