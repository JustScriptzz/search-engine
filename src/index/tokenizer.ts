const STOPWORDS = new Set([
  "a","an","and","are","as","at","be","but","by","for","if","in","into","is","it",
  "no","not","of","on","or","such","that","the","their","then","there","these",
  "they","this","to","was","will","with","di","e","il","la","che","per","una",
  "in","con","non","si","come","piu","the","a","de","en","el","los","las",
]);

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9à-ÿ\s]/gi, " ")
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 1 && t.length < 32 && !STOPWORDS.has(t));
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}
