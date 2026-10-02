// Script detection so the crawl stays English/Latin and random Arabic,
// Chinese or Russian pages never land in the index.
import { CONFIG } from "./config.ts";

const RANGES: Array<{ script: string; re: RegExp }> = [
  { script: "arabic", re: /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF]/g },
  { script: "hebrew", re: /[\u0590-\u05FF\uFB1D-\uFB4F]/g },
  { script: "cyrillic", re: /[\u0400-\u04FF\u0500-\u052F\u2DE0-\u2DFF\uA640-\uA69F]/g },
  { script: "cjk", re: /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/g },
  { script: "devanagari", re: /[\u0900-\u097F\uA8E0-\uA8FF]/g },
  { script: "thai", re: /[\u0E00-\u0E7F]/g },
  { script: "greek", re: /[\u0370-\u03FF\u1F00-\u1FFF]/g },
];

const LATIN_LETTER = /[A-Za-z\u00C0-\u024F]/g;

export interface ScriptProfile {
  dominant: string;
  latinCount: number;
  blockedCount: number;
  blockedRatio: number;
}

/** Count letters per script and report the dominant one ("latin" if none found). */
export function scriptProfile(text: string): ScriptProfile {
  const counts = new Map<string, number>();
  for (const { script, re } of RANGES) {
    counts.set(script, (text.match(re) ?? []).length);
  }
  const latinCount = (text.match(LATIN_LETTER) ?? []).length;
  const blockedScripts = new Set(CONFIG.language.blockedScripts);
  let blockedCount = 0;
  for (const [script, n] of counts) if (blockedScripts.has(script)) blockedCount += n;

  const total = latinCount + blockedCount;
  if (total === 0) return { dominant: "unknown", latinCount, blockedCount, blockedRatio: 0 };

  let dominant = "latin";
  let best = latinCount;
  for (const [script, n] of counts) {
    if (n > best) {
      dominant = script;
      best = n;
    }
  }
  return { dominant, latinCount, blockedCount, blockedRatio: blockedCount / total };
}

/** True when the page is mostly Latin-script (i.e. keep it). */
export function isAllowedLanguage(text: string): boolean {
  const p = scriptProfile(text);
  if (p.dominant === "unknown") return true; // no letters (e.g. code page) — don't drop
  if (p.blockedRatio > CONFIG.language.maxBlockedRatio) return false;
  return !CONFIG.language.blockedScripts.includes(p.dominant);
}