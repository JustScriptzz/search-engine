// Optional semantic layer: embed pages and queries, store the vectors compactly,
// and let a strong semantic match lift a page that the keywords ranked low.
//
// Why this exists: BM25 cannot match "how do I stop my car overheating" to a page
// titled "Engine temperature warning lights". It can only match words, and only
// exact ones. A vector closes that gap.
//
// Why it does not replace BM25: cosine similarity is bad at exact strings.
// Searching "never gonna give you up" must return the video with that title, not
// ten pages that are vaguely about giving up. So the vector score *multiplies*
// the keyword score instead of being fused with it by rank, which keeps exact
// matches on top and lets meaning lift the rest.
//
// Storage is int8: a 1024-dimension float32 vector is 4 KB per page, which would
// be 100 MB for 25,000 pages. Quantised to one signed byte per dimension it is
// 1 KB, and cosine on int8 is accurate enough for ranking.
import { CONFIG } from "./config.ts";
import { base64ToBytes, bytesToBase64 } from "./util.ts";

export interface EmbeddingConfig {
  key: string;
  baseUrl: string;
  model: string;
}

export interface EmbeddingStatus {
  /** A key is present, so the layer is switched on. */
  configured: boolean;
  /** Dimensions last observed from the service, 0 until the first call. */
  dimensions: number;
  /** Documents that carry a vector, and the share of the corpus. */
  embedded: number;
  total: number;
  coveragePct: number;
  /** Last failure, for diagnosing a misconfigured key. Never names the service. */
  lastError?: string;
  /** Cached query embeddings. */
  cachedQueries: number;
}

let observedDims = 0;
let lastError: string | undefined;

export function embeddingConfig(): EmbeddingConfig | null {
  if (!CONFIG.embeddings.enabled) return null;
  const key = (process.env.EMBEDDING_API_KEY ?? "").trim();
  if (!key) return null;
  const baseUrl = (process.env.EMBEDDING_BASE_URL ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
  const model = (process.env.EMBEDDING_MODEL ?? "nvidia/nemotron-3-embed-1b").trim();
  return { key, baseUrl, model };
}

export function embeddingsEnabled(): boolean {
  return embeddingConfig() !== null;
}

// ---- quantisation -------------------------------------------------------

/**
 * Pack a float vector into one signed byte per dimension.
 *
 * Each vector is scaled by its own largest absolute component, so a page of
 * small numbers is not quantised to all zeros. That costs one float per vector.
 */
export function quantize(vec: number[]): { bytes: Int8Array; scale: number } {
  let peak = 0;
  for (const v of vec) {
    const a = Math.abs(v);
    if (a > peak) peak = a;
  }
  const scale = peak > 0 ? peak / 127 : 1;
  const out = new Int8Array(vec.length);
  for (let i = 0; i < vec.length; i++) {
    const q = Math.round(vec[i] / scale);
    out[i] = q > 127 ? 127 : q < -128 ? -128 : q;
  }
  return { bytes: out, scale };
}

/** Cosine similarity between a query vector and a stored quantised vector. */
export function cosine(query: number[], stored: Int8Array, scale: number): number {
  const n = Math.min(query.length, stored.length);
  if (n === 0) return 0;
  let dot = 0;
  let qs = 0;
  let ss = 0;
  for (let i = 0; i < n; i++) {
    const q = query[i];
    const s = stored[i] * scale;
    dot += q * s;
    qs += q * q;
    ss += s * s;
  }
  if (qs === 0 || ss === 0) return 0;
  const cos = dot / (Math.sqrt(qs) * Math.sqrt(ss));
  // Embedding services often return cosine-only or euclidean-normalised values;
  // a non-negative similarity is all the ranking needs.
  return cos > 0 ? cos : 0;
}

// ---- storage ------------------------------------------------------------

export interface StoredVector {
  /** base64 of the int8 bytes */
  v: string;
  /** scale used when quantising */
  s: number;
}

export function storeVector(vec: number[]): StoredVector {
  const { bytes, scale } = quantize(vec);
  return { v: bytesToBase64(bytes), s: scale };
}

/** Decoded vectors, cached per document so repeated searches do not re-decode. */
const vectorCache = new Map<string, Int8Array>();

export function loadVector(docId: string, stored: StoredVector): Int8Array | null {
  const hit = vectorCache.get(docId);
  if (hit) return hit;
  let bytes: Int8Array;
  try {
    bytes = base64ToBytes(stored.v);
  } catch {
    return null;
  }
  vectorCache.set(docId, bytes);
  return bytes;
}

/** Drop a document's cached vector when it leaves the index. */
export function forgetVector(docId: string): void {
  vectorCache.delete(docId);
}

export function clearVectorCache(): void {
  vectorCache.clear();
}

// ---- the service --------------------------------------------------------

function truncate(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > CONFIG.embeddings.maxInputChars ? clean.slice(0, CONFIG.embeddings.maxInputChars) : clean;
}

/**
 * Embed a batch of texts. Returns null on failure rather than throwing: a search
 * must still work when the semantic layer is unavailable.
 */
export async function embedBatch(texts: string[], cfg = embeddingConfig()): Promise<number[][] | null> {
  if (!cfg) return null;
  const inputs = texts.map(truncate).filter(Boolean);
  if (inputs.length === 0) return null;

  const body: Record<string, unknown> = { model: cfg.model, input: inputs };
  if (CONFIG.embeddings.dimensions > 0) body.dimensions = CONFIG.embeddings.dimensions;

  for (let attempt = 0; attempt <= CONFIG.embeddings.maxRetries; attempt++) {
    try {
      const res = await fetch(`${cfg.baseUrl}/embeddings`, {
        method: "POST",
        headers: { authorization: `Bearer ${cfg.key}`, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONFIG.embeddings.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        // Rate limits are the normal case on a free tier: back off and retry.
        await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
        continue;
      }
      if (!res.ok) {
        lastError = `embedding service returned HTTP ${res.status}`;
        return null;
      }
      const json = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
      const data = json.data ?? [];
      if (data.length !== inputs.length) {
        lastError = `expected ${inputs.length} vectors, got ${data.length}`;
        return null;
      }
      const out: number[][] = [];
      for (const row of data) {
        const v = row.embedding;
        if (!Array.isArray(v) || v.length === 0) {
          lastError = "malformed embedding in response";
          return null;
        }
        out.push(v);
        observedDims = v.length;
      }
      lastError = undefined;
      return out;
    } catch (e: any) {
      lastError = String(e?.name === "TimeoutError" ? "timeout" : e?.message ?? e).slice(0, 80);
      if (attempt === CONFIG.embeddings.maxRetries) return null;
      await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    }
  }
  lastError = "gave up after retries";
  return null;
}

/** Embed many texts in batches of CONFIG.embeddings.batchSize. */
export async function embedAll(texts: string[], cfg = embeddingConfig()): Promise<number[][] | null> {
  if (!cfg || texts.length === 0) return null;
  const size = Math.max(1, CONFIG.embeddings.batchSize);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += size) {
    const got = await embedBatch(texts.slice(i, i + size), cfg);
    if (!got) return out.length ? out : null;
    out.push(...got);
  }
  return out;
}

// ---- query side ---------------------------------------------------------

const queryCache = new Map<string, number[]>();

export async function embedQuery(query: string, cfg = embeddingConfig()): Promise<number[] | null> {
  if (!cfg) return null;
  const key = query.trim().toLowerCase();
  const hit = queryCache.get(key);
  if (hit) return hit;
  const got = await embedBatch([key], cfg);
  if (!got || !got[0]) return null;
  const vec = got[0];
  if (queryCache.size >= CONFIG.embeddings.queryCacheSize) {
    // Cheap eviction: drop the oldest entry.
    const first = queryCache.keys().next().value;
    if (first) queryCache.delete(first);
  }
  queryCache.set(key, vec);
  return vec;
}

export function clearQueryCache(): void {
  queryCache.clear();
}

/** Status for the diagnostics endpoint. Never names the service or the model. */
export function embeddingStatus(total: number, embedded: number): EmbeddingStatus {
  return {
    configured: embeddingsEnabled(),
    dimensions: observedDims,
    embedded,
    total,
    coveragePct: total > 0 ? Math.round((embedded / total) * 100) : 0,
    lastError,
    cachedQueries: queryCache.size,
  };
}
