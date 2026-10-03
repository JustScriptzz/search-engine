// "AI overview": a short, cited answer shown above the organic results.
//
// It reads the same index the results come from. If the model is unavailable
// we still return something useful — a deterministic extractive summary — so
// the panel never shows an empty box.
import { CONFIG } from "./config.ts";
import { chat } from "./provider.ts";
import { buildContext, summarizeCorpus, type AgentEvent } from "./ai.ts";
import { analyzeQuery } from "./query.ts";
import type { InvertedIndex } from "./index/invertedIndex.ts";

export interface OverviewSource {
  title: string;
  url: string;
}

export interface Overview {
  text: string;
  sources: OverviewSource[];
  mode: "model" | "extractive";
}

const OVERVIEW_SYSTEM = [
  "You are MiniSearch AI, writing the short answer shown above search results.",
  "Rules:",
  "1. Answer ONLY from the numbered sources provided. Never use outside knowledge.",
  "2. 2-4 sentences, plain prose, neutral tone, no headings and no bullet lists.",
  "3. Cite with markdown links using the exact source URLs, like [NASA](https://nasa.gov/x).",
  "4. If the sources do not answer the question, say so in one sentence and stop.",
  "5. Never invent URLs, quotes or numbers.",
].join("\n");

export async function buildOverview(opts: {
  query: string;
  index: InvertedIndex;
  countryCode?: string;
  onEvent?: (e: AgentEvent) => void;
}): Promise<Overview> {
  const { query, index, countryCode = "XX" } = opts;
  const ctx = buildContext(index, countryCode);
  const plan = analyzeQuery(query);
  const hits = ctx.search(plan.subject || plan.terms.join(" "), 6);
  const sources = hits.map((h) => ({ title: h.title, url: h.url }));
  const fallback = extractiveOverview(hits, index, plan.intent);

  if (hits.length === 0 || !process.env[CONFIG.ai.tokenEnv] && !CONFIG.ai.apiKeyFallback) {
    return { text: fallback.text, sources, mode: "extractive" };
  }

  const corpus = summarizeCorpus(index);
  const numbered = hits
    .slice(0, 6)
    .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet}`)
    .join("\n\n");
  const user = [
    `Question: ${plan.raw}`,
    `Question type: ${plan.intent}`,
    `The index holds ${corpus.docCount} documents and covers: ${corpus.domains.slice(0, 10).join(", ")}.`,
    "",
    "Sources:",
    numbered,
  ].join("\n");

  try {
    const res = await chat([
      { role: "system", content: OVERVIEW_SYSTEM },
      { role: "user", content: user },
    ]);
    const text = (res.content || res.reasoning || "").trim();
    if (!text || /TOOL_RESULT|MINISEARCH_TOOL/.test(text)) return { text: fallback.text, sources, mode: "extractive" };
    return { text, sources, mode: "model" };
  } catch {
    return { text: fallback.text, sources, mode: "extractive" };
  }
}

/** No-model answer: the two densest snippets, stitched and cited. */
function extractiveOverview(
  hits: ReturnType<ReturnType<typeof buildContext>["search"]>,
  index: InvertedIndex,
  intent: string,
): { text: string } {
  if (hits.length === 0) {
    const s = index.stats();
    return {
      text: `No indexed pages cover that. This index holds ${s.docCount} documents from ${index.hosts.size} sites — try simpler keywords.`,
    };
  }
  const lead = {
    how: "From the pages we crawled:",
    what: "From the pages we crawled:",
    why: "From the pages we crawled:",
    best: "What the crawl covers, in order of authority:",
    who: "From the pages we crawled:",
    when: "From the pages we crawled:",
    where: "From the pages we crawled:",
    lookup: "Top matches from the crawl:",
  }[intent];

  const body = hits
    .slice(0, 3)
    .map((h) => `${clean(h.snippet)} [${trim(h.title, 48)}](${h.url})`)
    .join(" ");
  return { text: `${lead} ${body}`.trim() };
}

function clean(s: string): string {
  return s.replace(/^…/, "").replace(/…$/, "").replace(/\s+/g, " ").trim();
}

function trim(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}