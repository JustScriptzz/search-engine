import { rename } from "node:fs/promises";
import { tokenize } from "./tokenizer.ts";
import { analyzeQuery, coordinationScore, coordinationWeights } from "../query.ts";
import { CONFIG } from "../config.ts";
import type { CrawledDoc, IndexStats, SearchHit } from "../types.ts";

/**
 * docId -> term frequency.
 *
 * The value is a plain number rather than a `{tf}` wrapper because that wrapper
 * was the single biggest memory cost in the whole index: measured at 408 bytes
 * per (term, document) pair, a real page carries ~1,255 of them, so a document
 * cost ~500 KB of RAM to index 15 KB of text. The postings were 97% of the heap.
 */
type InvertedList = Map<string, Map<string, number>>;

const { k1: K1, b: B, titleRepeat: TITLE_REPEAT, coordination: COORD, field: FIELD } = CONFIG.bm25;

/** Normalised hostname, no "www.". */
function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** Host label + public suffix, e.g. "www.bbc.co.uk" -> {bbc, uk}. */
function hostTokens(url: string): Set<string> {
  const host = hostnameOf(url);
  if (!host) return new Set();
  const parts = host.split(".").filter(Boolean);
  const tokens = new Set<string>(parts);
  if (parts.length > 1) tokens.add(parts[parts.length - 2]); // "bbc" from bbc.com
  return tokens;
}

/** True when this page *is* the site the query names: "google" matches
 *  google.com but not issuetracker.google.com. */
function isExactHost(url: string, term: string): boolean {
  const host = hostnameOf(url);
  return host === term || host.startsWith(`${term}.`);
}

export class InvertedIndex {
  docs = new Map<string, CrawledDoc>();
  index: InvertedList = new Map();
  docLens = new Map<string, number>();
  /** Title tokens per doc, for field weighting at query time. */
  titleTerms = new Map<string, Set<string>>();
  /** Host label + TLD tokens per doc, e.g. "youtube.com" -> {youtube}. */
  hostTerms = new Map<string, Set<string>>();
  /** Normalised hostnames present in the index (no "www."), for exact checks. */
  hosts = new Set<string>();
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
    this.hosts.add(hostnameOf(doc.url));

    const tf = new Map<string, number>();
    for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [term, count] of tf) {
      let list = this.index.get(term);
      if (!list) {
        list = new Map();
        this.index.set(term, list);
      }
      list.set(doc.id, count);
    }
    return true;
  }

  /** Drop a document and every posting that referenced it (used by `prune`). */
  remove(docId: string): boolean {
    const doc = this.docs.get(docId);
    if (!doc) return false;
    this.docs.delete(docId);
    this.hosts.delete(hostnameOf(doc.url));
    const len = this.docLens.get(docId);
    if (len !== undefined) {
      this.docLens.delete(docId);
      this.totalLen -= len;
    }
    this.titleTerms.delete(docId);
    this.hostTerms.delete(docId);
    for (const [term, list] of this.index) {
      if (!list.delete(docId)) continue;
      if (list.size === 0) this.index.delete(term);
    }
    return true;
  }

  private idf(term: string): number {
    const df = this.index.get(term)?.size ?? 0;
    if (df === 0) return 0;
    const N = this.docCount;
    return Math.log(1 + (N - df + 0.5) / (df + 0.5));
  }

  /** True when any indexed document contains this token. */
  hasTerm(term: string): boolean {
    return this.index.has(term);
  }

  search(query: string, topK = 10): SearchHit[] {
    const plan = analyzeQuery(query);
    const terms = plan.terms;
    if (terms.length === 0 || this.docCount === 0) return [];

    const avgLen = this.avgDocLen || 1;
    const scores = new Map<string, number>();
    const matchedSets = new Map<string, Set<string>>();
    const unique = [...new Set(terms)];
    const weights = coordinationWeights(plan, (t) => this.index.has(t));

    for (const term of unique) {
      const list = this.index.get(term);
      if (!list) continue;
      const idf = this.idf(term);
      for (const [docId, tf] of list) {
        const dl = this.docLens.get(docId) ?? avgLen;
        const denom = tf + K1 * (1 - B + (B * dl) / avgLen);
        scores.set(docId, (scores.get(docId) ?? 0) + idf * ((tf * (K1 + 1)) / denom));
        let set = matchedSets.get(docId);
        if (!set) matchedSets.set(docId, (set = new Set()));
        set.add(term);
      }
    }

    const queryPhrase = normalizePhrase(plan.subject);

    return [...scores.entries()]
      .map(([docId, score]) => {
        const doc = this.docs.get(docId)!;
        const matched = matchedSets.get(docId) ?? new Set<string>();

        // Coordination: fraction of the query's weighted terms this doc covers.
        // Absent-from-corpus terms weigh less, so questions are not penalised.
        const coord = Math.pow(coordinationScore(weights, matched), COORD);

        // Field weighting: title and the site's own domain matter more than a
        // mention buried in the body.
        const title = this.titleTerms.get(docId) ?? new Set<string>();
        const host = this.hostTerms.get(docId) ?? new Set<string>();
        let titleHits = 0;
        let hostHits = 0;
        let exactHits = 0;
        for (const t of unique) {
          if (title.has(t)) titleHits++;
          if (host.has(t)) hostHits++;
          if (isExactHost(doc.url, t)) exactHits++;
        }
        const titleFactor = 1 + (titleHits / unique.length) * FIELD.title;
        const hostFactor = 1 + (exactHits / unique.length) * FIELD.host + (hostHits / unique.length) * FIELD.subdomainHost;
        // Exact phrase, punctuation-insensitive. A query that reproduces a title
        // verbatim should win outright — "never gonna give you up" has to find
        // the video, not pages that merely contain the word "up".
        const phraseInTitle = queryPhrase.length > 3 && normalizePhrase(doc.title).includes(queryPhrase);
        const phraseInBody = !phraseInTitle && queryPhrase.length > 3 && normalizePhrase(doc.text).includes(queryPhrase);
        const phraseFactor = phraseInTitle ? FIELD.phrase + 1 : phraseInBody ? 1 + FIELD.bodyPhrase : 1;

        return {
          docId,
          score: score * coord * titleFactor * hostFactor * phraseFactor,
          matchedTerms: matched.size,
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

  /** True when this exact hostname is indexed (no subdomain matching). */
  hasExactHost(hostname: string): boolean {
    return this.hosts.has(hostname.toLowerCase().replace(/^www\./, ""));
  }

  /** Any host token match, e.g. "youtube" matches youtube.com. */
  hasHost(host: string): boolean {
    const needle = host.toLowerCase().replace(/^www\./, "");
    if (needle.includes(".")) {
      const label = needle.split(".")[0];
      for (const tokens of this.hostTerms.values()) if (tokens.has(label)) return true;
      return false;
    }
    for (const tokens of this.hostTerms.values()) if (tokens.has(needle)) return true;
    return false;
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
      idx.hosts.add(hostnameOf(d.url ?? ""));
    }
    // The index is stored as [term, entries] pairs. Entries used to be
    // [docId, {tf}] and are now [docId, tf], so accept both when loading an index
    // written by an older build.
    const readList = (entries: any): Map<string, number> => {
      const list = new Map<string, number>();
      for (const [docId, value] of entries ?? []) {
        list.set(docId, typeof value === "number" ? value : Number(value?.tf ?? 1));
      }
      return list;
    };
    if (Array.isArray(data.index)) {
      for (const [term, entries] of data.index) idx.index.set(term, readList(entries));
    } else if (data.index && typeof data.index === "object") {
      for (const [term, entries] of Object.entries(data.index)) idx.index.set(term, readList(entries));
    }
    for (const [id, len] of data.docLens ?? []) idx.docLens.set(id, len);
    idx.totalLen = data.totalLen ?? 0;
    return idx;
  }

  /**
   * Serialise straight to the file, a chunk at a time.
   *
   * `Bun.write(path, JSON.stringify(...))` builds the entire index as one
   * JavaScript string first. Measured on this codebase, saving an 86 MB index
   * that way spiked RSS to 495 MB — a 5.7x amplification, which is what got
   * the fill run OOM-killed on a 1 GB VPS. Writing the parts as they are
   * produced keeps peak memory close to the size of the index itself.
   */
  async saveToFile(path: string): Promise<void> {
    // Write to a sibling temp file and rename it into place.
    //
    // Two reasons, both learned the hard way:
    //  1. Bun's file writer does not truncate. Saving a *smaller* index over a
    //     larger one leaves the old tail behind, the JSON stops parsing, and
    //     loadFromFile — which swallows the parse error — hands back an empty
    //     index. A prune that removes documents can therefore wipe the corpus.
    //  2. A rename is atomic, so a crash mid-save leaves the previous good
    //     index in place instead of a half-written file.
    const tmp = `${path}.tmp`;
    const out = Bun.file(tmp).writer();
    const put = (s: string) => out.write(s);
    try {
      await put('{"docs":[');
      let first = true;
      for (const doc of this.docs.values()) {
        await put((first ? "" : ",") + JSON.stringify(doc));
        first = false;
      }
      await put('],"index":[');
      first = true;
      for (const [term, list] of this.index) {
        const entries: string[] = [];
        for (const [id, tf] of list) entries.push(JSON.stringify([id, tf]));
        // Same shape as before (array of [term, entries] pairs) so an index
        // written here still loads in an older build, and vice versa.
        // Same shape as before (array of [term, entries] pairs) so an index
        // written here still loads in an older build, and vice versa.
        // `entries` holds pre-stringified ["id",{"tf":n}] pairs, so the inner
        // array is assembled by hand — wrapping it in JSON.stringify would
        // produce an array of strings instead of an array of pairs.
        await put((first ? "" : ",") + "[" + JSON.stringify(term) + ",[" + entries.join(",") + "]]");
        first = false;
      }
      await put('],"docLens":[');
      first = true;
      for (const [id, len] of this.docLens) {
        await put((first ? "" : ",") + JSON.stringify([id, len]));
        first = false;
      }
      await put('],"totalLen":' + this.totalLen + "}");
    } finally {
      await out.end();
    }
    await rename(tmp, path);
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

/** Lowercase, strip punctuation to single spaces, collapse runs — so phrase
 *  comparison ignores the punctuation a title happens to carry. */
export function normalizePhrase(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Does a word match a search term? Whole word always; a prefix only when the
 *  term is long enough that the match is meaningful. Without this, "up" matches
 *  "Updated" and every snippet is highlighted in the wrong places. */
export function wordMatches(word: string, term: string): boolean {
  const w = word.toLowerCase();
  const t = term.toLowerCase();
  if (w === t) return true;
  return t.length >= 4 && w.startsWith(t);
}

/** Snippet = the densest window of words around query terms, not just the first hit. */
export function makeSnippet(text: string, queryTerms: string[], windowWords = 34): string {
  const words = text.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z0-9à-ÿ]/g, ""));
  const terms = [...new Set(queryTerms.map((t) => t.toLowerCase()))];
  if (terms.length === 0) return joinSnippet(words.slice(0, windowWords), 0, words.length, windowWords);

  const hits = lower.map((w) => (terms.some((t) => wordMatches(w, t)) ? 1 : 0));
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
  if (bestScore === 0) bestStart = 0;
  return joinSnippet(words.slice(bestStart, bestStart + windowWords), bestStart, words.length, windowWords);
}

function joinSnippet(slice: string[], start: number, total: number, windowWords: number): string {
  let s = slice.join(" ").replace(/\s+/g, " ").trim();
  if (start > 0) s = "…" + s;
  if (start + windowWords < total) s = s + "…";
  return s;
}