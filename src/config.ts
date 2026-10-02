// Single source of truth for every hardcoded value in the engine.
// Everything else imports from here — change a number here, not in 6 files.

export const CONFIG = {
  name: "MiniSearch",
  version: "0.2.0",

  server: {
    port: 3000,
    host: "0.0.0.0",
    indexPath: "data/index.json",
    cors: true,
    // SSE responses stay open while the model thinks: Bun's default 10s
    // idleTimeout would cut them off. Unit is seconds (Bun caps it at 255).
    idleTimeoutSeconds: 240,
    sseHeartbeatMs: 8_000,
  },

  // English-language, non-Wikipedia sources. Kept deliberately small and
  // high-signal: news, tech, docs, discussion.
  seeds: [
    "https://example.com",
    "https://developer.mozilla.org/en-US/docs/Web",
    "https://news.ycombinator.com",
    "https://text.npr.org",
    "https://arstechnica.com",
    "https://www.theverge.com",
    "https://techcrunch.com",
    "https://news.mit.edu",
    "https://stackoverflow.com/questions",
    "https://github.com/explore",
    "https://www.bbc.com/news",
    "https://www.reuters.com",
  ] as string[],

  crawl: {
    maxPages: 2000,
    concurrency: 3,
    politenessMs: 800,
    timeoutMs: 12000,
    maxBytes: 2_000_000,
    minTextChars: 100,
    maxTextChars: 20_000,
    maxLinksPerPage: 200,
    maxOutlinksQueued: 500,
    sameHostOnly: false,
  },

  userAgent: "MiniSearchBot/0.2 (+https://github.com/JustScriptzz/search-engine)",
  acceptLanguage: "en-US,en;q=0.9", // keep crawled pages in English

  language: {
    // Scripts we refuse to index. Latin-script languages (English, German,
    // French, Spanish, Turkish, Vietnamese, ...) stay in.
    blockedScripts: [
      "arabic",
      "hebrew",
      "cyrillic",
      "cjk",
      "devanagari",
      "thai",
      "greek",
    ] as string[],
    // Reject a page if this share of its letters fall in blocked scripts.
    maxBlockedRatio: 0.2,
  },

  bm25: { k1: 1.2, b: 0.75, titleRepeat: 2 },

  tokenizer: {
    minLen: 2,
    maxLen: 32,
    extraStopwords: ["com", "http", "https", "www", "html", "org", "net"] as string[],
  },

  geo: {
    endpoint: "http://ip-api.com/json",
    timeoutMs: 700,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    maxCacheEntries: 5000,
    boost: 1.35,
  },

  ai: {
    // text.pollinations.ai speaks the OpenAI API at POST {baseUrl}/openai.
    baseUrl: "https://text.pollinations.ai",
    model: "openai",
    temperature: 0.3,
    maxTokens: 900,
    reasoningEffort: "minimal", // only sent when a token is configured
    timeoutMs: 90_000,
    maxSteps: 6,
    retries: 2,
    retryBackoffMs: 4000,
    // Anonymous tier: one request per 15s, and it 402s/500s on richer bodies,
    // so we send the minimal {model, messages} payload and pace ourselves.
    // Set POLLINATIONS_TOKEN to unlock the full parameter set and a 3s cadence.
    minIntervalMsAnonymous: 16_000,
    minIntervalMsToken: 3_000,
    // Native OpenAI function calling. The anonymous free tier rejects it
    // (500/402), so the agent uses the MINISEARCH_TOOL protocol instead.
    // Auto-enabled when POLLINATIONS_TOKEN is set.
    nativeTools: false,
    tokenEnv: "POLLINATIONS_TOKEN",
    readPageChars: 4000,
  },

  ui: {
    title: "MiniSearch",
    tagline: "BM25-ranked, zero tracking, tuned to your country.",
    defaultLimit: 10,
    maxLimit: 25,
  },
} as const;

export type AppConfig = typeof CONFIG;