// Query understanding: turn a natural-language question into terms a BM25
// index can actually answer, and say what the user is trying to do.
import { tokenize } from "./index/tokenizer.ts";

export type Intent =
  | "how" // explanation: how does X work, how to X
  | "what" // definition / description
  | "why" // cause
  | "best" // recommendation / comparison
  | "who" // person / organisation
  | "when" // date / event
  | "where"
  | "lookup"; // plain keywords

export interface QueryPlan {
  raw: string;
  terms: string[]; // all content terms, deduped
  /** Terms worth ranking on: question words removed, rare words kept. */
  focus: string[];
  intent: Intent;
  /** Short noun phrase we can quote back to the user. */
  subject: string;
}

const INTENT_PATTERNS: Array<[Intent, RegExp]> = [
  ["how", /^\s*(how|how do|how does|how can|how to|how would)\b/i],
  ["why", /^\s*(why|why do|why does|why is|why are)\b/i],
  ["what", /^\s*(what|what is|what are|what does|what's)\b/i],
  ["who", /^\s*(who|who is|who are|who was)\b/i],
  ["when", /^\s*(when|when did|when is)\b/i],
  ["where", /^\s*(where|where is|where do)\b/i],
  ["best", /\b(best|top|vs|versus|compare|comparison|alternative|alternatives|recommend)\b/i],
];

/** Words that carry no ranking signal in a question. */
const QUESTION_NOISE = new Set([
  "how", "why", "what", "who", "whom", "whose", "when", "where", "which",
  "please", "can", "could", "would", "should", "does", "do", "did", "is", "are", "was", "were",
  "tell", "explain", "give", "show", "need", "want", "help", "me", "you", "i", "us", "about",
  "work", "works", "use", "used", "using", "make", "made", "mean", "means", "happen",
]);

export function detectIntent(raw: string): Intent {
  for (const [intent, re] of INTENT_PATTERNS) if (re.test(raw)) return intent;
  return "lookup";
}

export function analyzeQuery(raw: string): QueryPlan {
  const cleaned = raw.replace(/[?!.]+$/g, "").replace(/\s+/g, " ").trim();
  const terms = [...new Set(tokenize(cleaned))];
  const intent = detectIntent(cleaned);
  const focus = terms.filter((t) => !QUESTION_NOISE.has(t));
  return {
    raw: cleaned,
    terms,
    // A pure question ("how does github work") still needs *something* to rank on.
    focus: focus.length ? focus : terms,
    intent,
    subject: focus.join(" ") || cleaned,
  };
}

/**
 * Coordination weight per term: a term that exists nowhere in the index should
 * not make every document look like it "half matched". Terms present in the
 * index count fully; absent ones count 0.35.
 */
export function coordinationWeights(plan: QueryPlan, inIndex: (t: string) => boolean): Map<string, number> {
  const weights = new Map<string, number>();
  for (const t of plan.focus) weights.set(t, inIndex(t) ? 1 : 0.35);
  if (weights.size === 0) for (const t of plan.terms) weights.set(t, 1);
  return weights;
}

/** Total weight for a set of matched terms. */
export function coordinationScore(weights: Map<string, number>, matched: Set<string>): number {
  let total = 0;
  let got = 0;
  for (const [term, w] of weights) {
    total += w;
    if (matched.has(term)) got += w;
  }
  return total === 0 ? 0 : got / total;
}