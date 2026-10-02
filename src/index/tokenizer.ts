import { CONFIG } from "../config.ts";

const STOPWORDS = new Set([
  // English
  "a","an","and","are","as","at","be","but","by","for","if","in","into","is","it",
  "no","not","of","on","or","such","that","the","their","then","there","these",
  "they","this","to","was","will","with","from","have","has","been","were","you","your",
  // German / French / Italian / Spanish (light, so bilingual pages stay searchable)
  "de","la","le","les","des","du","der","die","das","und","ein","eine","für","mit",
  "che","per","con","una","uno","del","della","che","più","el","los","las","con","por",
  ...CONFIG.tokenizer.extraStopwords,
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= CONFIG.tokenizer.minLen && t.length <= CONFIG.tokenizer.maxLen && !STOPWORDS.has(t));
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}