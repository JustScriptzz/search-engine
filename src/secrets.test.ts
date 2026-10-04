import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { CONFIG } from "./config.ts";

/**
 * A credential must never live in a tracked file.
 *
 * This repository is public, so a key committed to src/config.ts is readable by
 * anyone and billable to whoever set it. That happened once: the chat key was
 * hardcoded as a "last-resort fallback". The key itself also has to be rotated,
 * because removing it from HEAD does not remove it from history — this test only
 * stops it happening again going forward.
 */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ["chat key", /cog-live-[A-Za-z0-9_-]{8,}/],
  ["embedding key", /nvapi-[A-Za-z0-9_-]{8,}/],
  ["github token", /ghp_[A-Za-z0-9]{8,}/],
  ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];

/**
 * Tests must fabricate key-shaped strings ("cog-live-test", a PEM header), so a
 * bare pattern match is not enough to fail. What distinguishes a real
 * credential is that nobody chose it on purpose: placeholders are obvious.
 */
const PLACEHOLDER =
  /(^|[^A-Za-z])(test|example|fake|dummy|xxxx|placeholder|notreal|sample)([^A-Za-z]|$)|CONFIGKEY|ENVKEY|MIIB/i;

/** Test files are exempt from the pattern scan: fabricating key-shaped strings
 *  ("cog-live-test", a PEM header) is exactly what they are for. They are NOT
 *  exempt from the check below, which compares against the real credentials
 *  configured in this environment. */
function isTestFile(file: string): boolean {
  return /\.test\.ts$/.test(file);
}

const SKIP_DIRS = new Set([".git", "node_modules", "data", ".openchamber", "dist"]);
const SKIP_FILES = new Set([".env", ".env.bak", "bun.lockb", "bun.lock"]);

function trackedFiles(dir = ".", out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) trackedFiles(full, out);
    else if (/\.(ts|js|json|md|sh|toml|yaml|yml|html|css)$|\.env\.example$/.test(entry)) out.push(full);
  }
  return out;
}

describe("no credentials in tracked files", () => {
  test("shipped source, docs and scripts contain no live keys", () => {
    const offenders: string[] = [];
    for (const file of trackedFiles()) {
      if (isTestFile(file)) continue;
      const text = readFileSync(file, "utf8");
      for (const [label, re] of SECRET_PATTERNS) {
        for (const match of text.matchAll(new RegExp(re.source, "g"))) {
          if (!PLACEHOLDER.test(match[0])) offenders.push(`${file} (${label})`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("no live key from the environment appears in a tracked file", () => {
    // The precise check: whatever real credentials are configured right now must
    // not be in the repository. Catches a real key pasted into a test too.
    const live = [process.env.COGITO_API_KEY, process.env.EMBEDDING_API_KEY]
      .map((v) => (v ?? "").trim())
      .filter((v) => v.length >= 12);
    if (live.length === 0) return; // nothing configured here, nothing to leak
    const found: string[] = [];
    for (const file of trackedFiles()) {
      const text = readFileSync(file, "utf8");
      for (const secret of live) if (text.includes(secret)) found.push(file);
    }
    expect(found).toEqual([]);
  });

  test("the chat key comes from the environment, not from config", () => {
    // Empty fallback: a fresh clone must have no credentials baked in.
    expect(CONFIG.ai.apiKeyFallback).toBe("");
    // ...and the environment is where it comes from.
    expect(CONFIG.ai.tokenEnv).toBe("COGITO_API_KEY");
  });

  test("the embedding key is environment-only too", () => {
    // The endpoint and model are fine to commit; the key is not.
    expect(CONFIG.embeddings.baseUrl.length).toBeGreaterThan(0);
    expect(CONFIG.embeddings.model.length).toBeGreaterThan(0);
    // nothing key-shaped lives in config
    const configText = readFileSync("src/config.ts", "utf8");
    for (const [label, re] of SECRET_PATTERNS) {
      for (const m of configText.matchAll(new RegExp(re.source, "g"))) {
        expect(`${label}: ${PLACEHOLDER.test(m[0])}`).toBe(`${label}: true`);
      }
    }
    // and the old hardcoded value is gone for good
    expect(configText).not.toContain("CBUnsHwHzmrTLhpLrzWWiDIacFPDFWcQxaqZ");
  });

  test("the template file has blank slots, not values", () => {
    const example = readFileSync(".env.example", "utf8");
    for (const [label, re] of SECRET_PATTERNS) {
      for (const m of example.matchAll(new RegExp(re.source, "g"))) {
        expect(`${label}: ${PLACEHOLDER.test(m[0])}`).toBe(`${label}: true`);
      }
    }
    expect(example).toContain("COGITO_API_KEY=");
    expect(example).toContain("EMBEDDING_API_KEY=");
  });

  test(".env stays ignored", () => {
    const ignore = readFileSync(".gitignore", "utf8");
    expect(ignore.split(/\r?\n/).some((l) => l.trim() === ".env")).toBe(true);
  });
});