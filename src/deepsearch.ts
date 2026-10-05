// Deep search: multi-pass retrieval without a model in the loop.
//
// DeepSearcher's loop is: decompose the question → retrieve → reflect on what
// came back → retrieve again. The LLM does the decomposition and reflection.
// Everything else is classical IR, and we can do all of it deterministically:
//
//   1. decompose the question into sub-queries (conjunctions, comparisons)
//   2. retrieve for each sub-query and for the whole query
//   3. expand the query from the top hits (pseudo-relevance feedback / Rocchio)
//   4. retrieve again with the expansion
//   5. fuse every pass with Reciprocal Rank Fusion
//
// No model call, no API key, no latency: just more passes over our own index.
import { CONFIG } from "./config.ts";
import { analyzeQuery, type QueryPlan } from "./query.ts";
import { tokenize } from "./index/tokenizer.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";
import type { SearchHit } from "./types.ts";

export interface DeepPass {
  label: string;
  query: string;
  results: number;
}

export interface DeepResult {
  hits: SearchHit[];
  passes: DeepPass[];
  expandedTerms: string[];
  subQueries: string[];
  terms: string[];
}

/** Split a compound question into independent sub-queries. */
export function decomposeQuery(raw: string): string[] {
  const cleaned = raw.replace(/[?!.]+$/g, "").trim();
  const parts = cleaned
    .split(/\s+(?:and|or|versus|vs\.?|as well as|plus|also)\s+|\s*;\s*|\s*,\s*/i)
    .map((p) => p.trim())
    .filter((p) => p.length > 2);
  if (parts.length < 2) return [];
  // Only keep parts that are actually searchable on their own.
  return parts.filter((p) => tokenize(p).length > 0).slice(0, 3);
}

/**
 * Expansion terms from the top hits: frequent in those documents, rare overall,
 * not already in the query, and not stopwords. This is Rocchio without vectors.
 */
export function expansionTerms(
  index: InvertedIndex,
  hits: SearchHit[],
  limit: number,
  queryTerms: string[] = [],
): string[] {
  const scores = new Map<string, number>();
  const already = new Set(queryTerms.map((t) => t.toLowerCase()));
  for (const h of hits.slice(0, 6)) {
    const doc = index.docs.get(h.id);
    if (!doc) continue;
    const counts = new Map<string, number>();
    for (const t of tokenize(doc.title)) counts.set(t, (counts.get(t) ?? 0) + 2);
    for (const t of tokenize(doc.text)) counts.set(t, (counts.get(t) ?? 0) + 1);
    for (const [term, n] of counts) {
      if (already.has(term)) continue;
      const df = index.index.get(term)?.length ?? 0;
      if (df === 0 || df > index.docCount * 0.35) continue; // too common to help
      scores.set(term, (scores.get(term) ?? 0) + (n * Math.log(1 + index.docCount / df)));
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t]) => t)
    .slice(0, limit);
}

/** Reciprocal Rank Fusion: rank-based, so scores from different passes combine. */
export function fuse(rankings: Array<Array<{ id: string }>>, k = 60): Map<string, number> {
  const fused = new Map<string, number>();
  for (const ranking of rankings) {
    ranking.forEach((item, i) => {
      fused.set(item.id, (fused.get(item.id) ?? 0) + 1 / (k + i + 1));
    });
  }
  return fused;
}

export function deepSearch(
  index: InvertedIndex,
  query: string,
  opts: { limit?: number; deep?: boolean; subQueries?: boolean } = {},
): DeepResult {
  const limit = opts.limit ?? 10;
  const deep = opts.deep ?? CONFIG.deepSearch.enabled;
  const wantSub = opts.subQueries ?? CONFIG.deepSearch.subQueries;
  const plan: QueryPlan = analyzeQuery(query);

  const passes: DeepPass[] = [];
  const rankings: Array<Array<{ id: string }>> = [];
  const byId = new Map<string, SearchHit>();

  const run = (label: string, q: string) => {
    const hits = index.search(q, Math.max(limit * 2, 20));
    passes.push({ label, query: q, results: hits.length });
    if (hits.length > 0) rankings.push(hits);
    for (const h of hits) if (!byId.has(h.id)) byId.set(h.id, h);
    return hits;
  };

  // Pass 1 — the query itself.
  const first = run("query", plan.subject || plan.terms.join(" "));

  let subQueries: string[] = [];
  let expanded: string[] = [];

  if (deep) {
    // Pass 2 — each part of a compound question on its own.
    if (wantSub) {
      subQueries = decomposeQuery(plan.raw);
      for (const sub of subQueries) run(`sub:${sub.slice(0, 24)}`, sub);
    }

    // Pass 3 — expand from what came back and search again.
    const terms = expansionTerms(index, first, CONFIG.deepSearch.expansionTerms, plan.terms);
    if (terms.length > 0) {
      expanded = terms;
      run(`expand:${terms.slice(0, 3).join(" ")}`, [...plan.focus, ...terms].join(" "));
    }
  }

  const fused = fuse(rankings);
  // Keep the magnitude of the best BM25 pass: RRF alone would score the page
  // that matched an exact title phrase 40x harder exactly the same as the page
  // that merely mentioned one word.
  let bestScore = 0;
  for (const id of fused.keys()) bestScore = Math.max(bestScore, byId.get(id)?.score ?? 0);
  const blend = CONFIG.deepSearch.scoreBlend;
  const hits = [...fused.entries()]
    .map(([id, fusedScore]) => ({ hit: byId.get(id)!, fused: fusedScore, id }))
    .filter((x) => x.hit)
    .sort((a, b) => b.fused - a.fused)
    .slice(0, limit)
    .map((x) => {
      const rel = bestScore > 0 ? Math.max(0, x.hit.score) / bestScore : 0;
      const score = x.fused * (1 + blend * rel);
      return { ...x.hit, score: Math.round(score * 1000) / 1000 };
    });

  return {
    hits,
    passes,
    expandedTerms: expanded,
    subQueries,
    terms: plan.terms,
  };
}