// Every hardcoded value lives here. Change it once, not in six files.

export const CONFIG = {
  name: "MiniSearch",
  version: "0.3.0",

  server: {
    port: 3000,
    host: "0.0.0.0",
    indexPath: "data/index.json",
    cors: true,
    // SSE stays open while the model thinks; Bun's default 10s idleTimeout
    // would cut it off. Unit is seconds (Bun caps it at 255).
    idleTimeoutSeconds: 240,
    sseHeartbeatMs: 8_000,
  },

  // English-language, non-Wikipedia sources.
  // English-language, deliberately mixed: world news, tech, primary docs,
  // science, standards, discussion. Wikipedia is a couple of entries out of
  // thirty, not the corpus.
  seeds: [
    // world + general news
    "https://www.bbc.com/news",
    "https://www.reuters.com",
    "https://apnews.com",
    "https://text.npr.org",
    "https://www.aljazeera.com",
    "https://www.theguardian.com/international",
    "https://www.dw.com/en/top-stories/s-9097",
    "https://www.france24.com/en/",
    "https://www3.nhk.or.jp/nhnews/en/",
    "https://www.cbc.ca/news",
    "https://www.thehindu.com/news/international/",
    "https://www.scmp.com/news",
    // tech + industry
    "https://arstechnica.com",
    "https://www.theverge.com",
    "https://techcrunch.com",
    "https://news.ycombinator.com",
    "https://github.com/explore",
    "https://stackoverflow.com/questions",
    "https://dev.to",
    "https://css-tricks.com",
    "https://www.smashingmagazine.com",
    // primary documentation + standards
    "https://developer.mozilla.org/en-US/docs/Web",
    "https://html.spec.whatwg.org/multipage/",
    "https://www.w3.org/TR/",
    "https://caniuse.com",
    "https://webkit.org",
    "https://developer.chrome.com/docs/devtools",
    "https://www.rfc-editor.org",
    // science
    "https://www.nasa.gov",
    "https://phys.org",
    "https://www.nature.com/news",
    "https://arstechnica.com/science",
    // reference (deliberately a minority)
    "https://en.wikipedia.org/wiki/Search_engine",
    "https://www.britannica.com",
    "https://example.com",
  ] as string[],

  crawl: {
    maxPages: 2000,
    concurrency: 3,
    politenessMs: 800,
    timeoutMs: 12_000,
    maxBytes: 2_000_000,
    minTextChars: 100,
    maxTextChars: 20_000,
    maxLinksPerPage: 200,
    maxOutlinksQueued: 500,
    sameHostOnly: false,
    // Link-shaped noise we never want in the index.
    blockedHosts: [
      "youtube.com", "youtu.be", "x.com", "twitter.com", "facebook.com", "instagram.com",
      "linkedin.com", "tiktok.com", "pinterest.com", "reddit.com", "discord.com",
      "doubleclick.net", "googlesyndication.com", "adservice.google.com",
      "aboutads.info", "adsrvr.org", "amazon-adsystem.com",
    ] as string[],
    blockedPathPatterns: [
      "/subscribe", "/login", "/signin", "/sign-in", "/register", "/account",
      "/privacy", "/terms", "/cookie", "/user-agreement", "/aboutads", "/newsletter",
      "/advertise", "/careers", "/press",
    ] as string[],
  },

  userAgent: "MiniSearchBot/0.3 (+https://github.com/JustScriptzz/search-engine)",
  acceptLanguage: "en-US,en;q=0.9",

  language: {
    // Scripts we refuse to index. Latin-script languages stay in.
    blockedScripts: ["arabic", "hebrew", "cyrillic", "cjk", "devanagari", "thai", "greek"] as string[],
    maxBlockedRatio: 0.2,
  },

  bm25: {
    k1: 1.2,
    b: 0.75,
    titleRepeat: 2,
    // Query-term coordination: multiply score by (matched/total)^exponent so a
    // page matching every query term beats one that repeats a single term.
    coordination: 1.6,
  },

  tokenizer: {
    minLen: 2,
    maxLen: 32,
    // No domain/URL-ish stopwords: "html", "com" and "www" are real query
    // terms on a web index, and dropping them silently broke queries like
    // "html standards" (they matched a single term instead of two).
    extraStopwords: [] as string[],
  },

  geo: {
    endpoint: "http://ip-api.com/json",
    timeoutMs: 700,
    cacheTtlMs: 6 * 60 * 60 * 1000,
    maxCacheEntries: 5000,
    boost: 1.35,
  },

  ai: {
    // Cogito (Decart) — OpenAI-compatible. text.pollinations.ai's text API is
    // deprecated, so the agent runs on Cogito's gpt-oss-120B weights.
    provider: "cogito",
    baseUrl: "https://api.cogito.decart.ai/v1",
    tokenEnv: "COGITO_API_KEY",
    // Last-resort fallback so a fresh clone works with no .env setup.
    // A .env COGITO_API_KEY (or panel env) always wins over this.
    apiKeyFallback: "cog-live-CBUnsHwHzmrTLhpLrzWWiDIacFPDFWcQxaqZ",
    model: "gpt-oss:ultra-fast",
    // First slug from GET /v1/models that matches wins; gpt-oss-120b is served
    // under different ids depending on the account tier.
    modelPreference: ["gpt-oss:ultra-fast", "gpt-oss-120b", "gpt-oss"] as string[],
    modelCacheTtlMs: 10 * 60 * 1000,
    temperature: 0.3,
    maxTokens: 1200,
    timeoutMs: 60_000,
    maxSteps: 6,
    retries: 2,
    retryBackoffMs: 1500,
    // Cogito's /chat/completions returns empty tool_calls for gpt-oss, so the
    // agent drives tools with the MINISEARCH_TOOL protocol. Flip this on once
    // the endpoint maps harmony tool calls properly.
    nativeTools: false,
    minIntervalMs: 400,
    readPageChars: 4000,
  },

  ui: {
    defaultLimit: 10,
    maxLimit: 25,
  },
} as const;

export type AppConfig = typeof CONFIG;