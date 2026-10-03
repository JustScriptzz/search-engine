import { tokenize } from "./tokenizer.ts";
import { CONFIG } from "../config.ts";
import type { CrawledDoc, IndexStats, SearchHit } from "../types.ts";

interface Posting {
  tf: number;
}

type InvertedList = Map<string, Map<string, Posting>>;

const { k1: K1, b: B, titleRepeat: TITLE_REPEAT, coordination: COORD, field: FIELD } = CONFIG.bm25;

/** Host label + public suffix, e.g. "www.bbc.co.uk" -> {bbc, uk}. */
function hostTokens(url: string): Set<string> {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, "");
    const parts = host.split(".").filter(Boolean);
    const tokens = new Set<string>(parts);
    if (parts.length > 1) tokens.add(parts[parts.length - 2]); // "bbc" from bbc.com
    return tokens;
  } catch {
    return new Set();
  }
}

export class InvertedIndex {
  docs = new Map<string, CrawledDoc>();
  index: InvertedList = new Map();
  docLens = new Map<string, number>();
  /** Title tokens per doc, for field weighting at query time. */
  titleTerms = new Map<string, Set<string>>();
  /** Host label + TLD tokens per doc, e.g. "youtube.com" -> {youtube}. */
  hostTerms = new Map<string, Set<string>>();
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
    this.titleTerms.set(doc.id, new Set(tokenize(doc.title)));
    this.hostTerms.set(doc.id, hostTokens(doc.url));

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
    const queryPhrase = query.toLowerCase().replace(/\s+/g, " ").trim();

    return [...scores.entries()]
      .map(([docId, score]) => {
        const doc = this.docs.get(docId)!;
        const m = matched.get(docId) ?? 0;
        const coord = Math.pow(m / total, COORD);

        // Field weighting: a term in the title matters more than in the body,
        // and matching the site's own domain matters most (searching "youtube"
        // should surface youtube.com, not pages that merely mention it).
        const title = this.titleTerms.get(docId) ?? new Set<string>();
        const host = this.hostTerms.get(docId) ?? new Set<string>();
        let titleHits = 0;
        let hostHits = 0;
        for (const t of unique) {
          if (title.has(t)) titleHits++;
          if (host.has(t)) hostHits++;
        }
        const titleFactor = 1 + (titleHits / total) * FIELD.title;
        const hostFactor = 1 + (hostHits / total) * FIELD.host;
        const phraseFactor =
          queryPhrase.length > 3 && doc.title.toLowerCase().includes(queryPhrase) ? FIELD.phrase : 1;

        return {
          docId,
          raw: score,
          score: score * coord * titleFactor * hostFactor * phraseFactor,
          matchedTerms: m,
        };
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
          lang: doc.lang ?? "",
        };
      });
  }

  /** Every host in the index, e.g. "youtube.com" -> true. Used to tell a user
   *  that the site they searched for simply isn't in our crawl. */
  hasHost(host: string): boolean {
    const needle = host.toLowerCase().replace(/^www\./, "");
    if (needle.includes(".")) {
      for (const tokens of this.hostTerms.values()) {
        if (tokens.has(needle.split(".")[0])) return true;
      }
      return false;
    }
    for (const tokens of this.hostTerms.values()) if (tokens.has(needle)) return true;
    return false;
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
    for (const d of data.docs ?? []) {
      idx.docs.set(d.id, d);
      // Derived field data is rebuilt on load, so old index files keep working.
      idx.titleTerms.set(d.id, new Set(tokenize(d.title ?? "")));
      idx.hostTerms.set(d.id, hostTokens(d.url ?? ""));
    }
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

/** Snippet = the densest window of words around query terms, not just the first hit. */
export function makeSnippet(text: string, queryTerms: string[], windowWords = 34): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const lower = words.map((w) => w.toLowerCase());
  const terms = [...new Set(queryTerms.map((t) => t.toLowerCase()))];
  if (terms.length === 0) {
    return joinSnippet(words.slice(0, windowWords), 0, words.length, windowWords);
  }

  const hits = lower.map((w) => (terms.some((t) => w.includes(t)) ? 1 : 0));
  let bestStart = 0;
  let bestScore = -1;
  for (let i = 0; i + windowWords <= words.length; i++) {
    let s = 0;
    for (let k = i; k < i + windowWords; k++) s += hits[k];
    if (s > bestScore) {
      bestScore = s;
      bestStart = i;
    }
  }
  if (bestScore === 0) {
    // No term inside any window: fall back to the opening of the document.
    bestStart = 0;
  }
  return joinSnippet(words.slice(bestStart, bestStart + windowWords), bestStart, words.length, windowWords);
}

function joinSnippet(slice: string[], start: number, total: number, windowWords: number): string {
  let s = slice.join(" ").replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (start + windowWords < total) s = s + "…";
  return s;
}