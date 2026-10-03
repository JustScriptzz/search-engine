// OpenAI-compatible chat provider (Cogito / Decart).
// Two jobs beyond a plain POST:
//  1. resolve the configured model slug against GET /v1/models (their account
//     catalogue names gpt-oss-120b as e.g. "gpt-oss:ultra-fast"), cached.
//  2. return the assistant message with null-safe fields, because gpt-oss on
//     this endpoint can come back with empty content.
import { CONFIG } from "./config.ts";

export interface AssistantMessage {
  content: string;
  reasoning: string;
  toolCalls: Array<{ id: string; name: string; args: Record<string, unknown> }>;
  raw: unknown;
}

export class ProviderError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
    this.name = "ProviderError";
  }
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

class ModelCache {
  private resolved?: { model: string; at: number };
  private inflight?: Promise<string>;

  async resolve(): Promise<string> {
    if (this.resolved && Date.now() - this.resolved.at < CONFIG.ai.modelCacheTtlMs) return this.resolved.model;
    if (this.inflight) return this.inflight;
    this.inflight = this.fetchModel();
    try {
      return await this.inflight;
    } finally {
      this.inflight = undefined;
    }
  }

  private async fetchModel(): Promise<string> {
    try {
      const res = await fetch(`${CONFIG.ai.baseUrl}/models`, { headers: headers() });
      if (!res.ok) return CONFIG.ai.model;
      const body = (await res.json()) as { data?: Array<{ id?: string }> };
      const ids = (body.data ?? []).map((m) => m.id ?? "").filter(Boolean);
      for (const preferred of CONFIG.ai.modelPreference) {
        const hit = ids.find((id) => id === preferred || id.endsWith(preferred));
        if (hit) {
          this.resolved = { model: hit, at: Date.now() };
          return hit;
        }
      }
      const fallback = ids.find((id) => /gpt-oss/i.test(id));
      if (fallback) {
        this.resolved = { model: fallback, at: Date.now() };
        return fallback;
      }
    } catch {
      // fall through to the configured slug
    }
    return CONFIG.ai.model;
  }
}

const modelCache = new ModelCache();

function headers(key = apiKey()): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (key) h.authorization = `Bearer ${key}`;
  return h;
}

/** Pull a well-formed key out of whatever the environment actually holds:
 *  stray quotes, CRLF, a pasted "Bearer cog-live-…" prefix or trailing
 *  whitespace are all recoverable. Returns "" when nothing usable is present. */
export function sanitizeKey(raw: string | undefined): string {
  if (!raw) return "";
  const m = /((?:cog|sk|pk)-[A-Za-z0-9_-]{6,})/.exec(raw.replace(/[\r\n\t"']/g, " "));
  if (!m) return "";
  const key = m[1];
  // Reject obvious placeholders copied from an example file.
  if (/^(.)\1+$/.test(key.slice(key.indexOf("-") + 1))) return "";
  if (/(x{4,}|your|changeme|example|placeholder|replace)/i.test(key)) return "";
  return key;
}

export function apiKey(): string {
  return keyCandidates()[0] ?? "";
}

/** Every key we are willing to try, best first: env var, then the fallback
 *  baked into config. A 401 falls through to the next candidate instead of
 *  leaving the agent permanently broken by a stale/typo'd .env. */
export function keyCandidates(): string[] {
  const out: string[] = [];
  for (const raw of [process.env[CONFIG.ai.tokenEnv], CONFIG.ai.apiKeyFallback]) {
    const key = sanitizeKey(raw);
    if (key && !out.includes(key)) out.push(key);
  }
  return out;
}

/** Which credential would be used first — surfaced by /api/stats for debugging.
 *  Never returns the key itself. */
export function keySource(): "env" | "config" | "none" {
  if (sanitizeKey(process.env[CONFIG.ai.tokenEnv])) return "env";
  if (sanitizeKey(CONFIG.ai.apiKeyFallback)) return "config";
  return "none";
}

export function hasApiKey(): boolean {
  return keyCandidates().length > 0;
}

/** True when the failure means "bad/absent credentials", not a transient fault. */
export function isAuthError(status: number): boolean {
  return status === 401 || status === 403;
}

let lastRequestAt = 0;

export const providerPacing: { minIntervalMs: number } = { minIntervalMs: CONFIG.ai.minIntervalMs };

/** One chat completion. Throws ProviderError with the HTTP status attached. */
export async function chat(messages: Array<Record<string, unknown>>): Promise<AssistantMessage> {
  const keys = keyCandidates();
  if (keys.length === 0) throw new ProviderError(`missing ${CONFIG.ai.tokenEnv} — set it in .env or the panel startup`);

  await pace();
  const model = await modelCache.resolve();

  const body: Record<string, unknown> = {
    model,
    messages,
    temperature: CONFIG.ai.temperature,
    max_tokens: CONFIG.ai.maxTokens,
  };

  let lastError: ProviderError | null = null;
  let keyIndex = 0;
  for (let attempt = 0; attempt <= CONFIG.ai.retries; attempt++) {
    try {
      lastRequestAt = Date.now();
      const res = await fetch(`${CONFIG.ai.baseUrl}/chat/completions`, {
        method: "POST",
        headers: headers(keys[keyIndex]),
        body: JSON.stringify(body),
      });
      if (res.ok) return toMessage(await res.json());

      const text = await res.text().catch(() => "");
      lastError = new ProviderError(`HTTP ${res.status}: ${text.slice(0, 180)}`, res.status);
      // 401/403: that key is bad — try the next candidate instead of failing.
      if (isAuthError(res.status) && keyIndex + 1 < keys.length) {
        keyIndex++;
        continue;
      }
      if (isAuthError(res.status) || res.status === 404 || res.status === 400) throw lastError;
      await sleep(CONFIG.ai.retryBackoffMs * (attempt + 1));
    } catch (err) {
      if (err instanceof ProviderError && err.status && !lastError) lastError = err;
      if (attempt === CONFIG.ai.retries) break;
      await sleep(CONFIG.ai.retryBackoffMs * (attempt + 1));
    }
  }
  throw lastError ?? new ProviderError("provider request failed");
}

function toMessage(json: any): AssistantMessage {
  const m = json?.choices?.[0]?.message ?? {};
  return {
    content: typeof m.content === "string" ? m.content : "",
    reasoning: typeof m.reasoning === "string" ? m.reasoning : "",
    toolCalls: (m.tool_calls ?? []).map((c: any, i: number) => ({
      id: c?.id ?? `call_${i}`,
      name: c?.function?.name ?? "",
      args: safeParse(c?.function?.arguments) ?? {},
    })),
    raw: json,
  };
}

async function pace() {
  const wait = lastRequestAt + providerPacing.minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
}

function safeParse(raw: unknown): Record<string, unknown> | null {
  if (typeof raw === "object" && raw) return raw as Record<string, unknown>;
  if (typeof raw !== "string" || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw);
    return typeof v === "object" && v ? v : null;
  } catch {
    return null;
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}