// Every hardcoded value lives here. Change it once, not in six files.
import { FAMOUS_SITES } from "./famousSites.ts";

const FAMOUS_SITE_URLS = FAMOUS_SITES.map((s) => s.url);

export const CONFIG = {
  name: "MiniSearch",
  version: "0.3.1",

  server: {
    port: 3000,
    host: "0.0.0.0",
    indexPath: "data/index.json",
    cors: true,
    // SSE stays open while the model thinks; Bun's default 10s idleTimeout
    // would cut it off. Unit is seconds (Bun caps it at 255).
    idleTimeoutSeconds: 240,
    sseHeartbeatMs: 8_000,
    tls: {
      // TLS is used as soon as both files are found. There is no separate switch
      // to forget: a missing certificate degrades to plain HTTP with a loud log
      // rather than refusing to boot on a box where renewal has not run yet.
      enabled: true,
      certFile: "fullchain.pem",
      keyFile: "privkey.pem",
      // Checked in order after the env overrides. Certs are usually written to
      // the workspace root by tls-cert.sh.
      searchDirs: [".", "certs"],
      // Set these to point somewhere else (e.g. a secrets mount) without
      // touching the repo.
      certEnv: "TLS_CERT_FILE",
      keyEnv: "TLS_KEY_FILE",
      // Extra hostnames/SANs requested from the CA.
      altNames: [] as string[],
    },
  },

  // English-language, non-Wikipedia sources.
  // Famous sites are indexed too, including link-farm homepages: those become
  // "site cards" (title + description) so searching "google" finds google.com.
  // Full allowlist in src/famous.ts.
  // English-language, deliberately mixed: world news, tech, primary docs,
  // science, standards, discussion. Wikipedia is a couple of entries out of
  // thirty, not the corpus.
  seeds: [
    // the allowlist of famous sites first, so "google"/"github"/"nasa" resolve
    ...FAMOUS_SITE_URLS,
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
    "https://arxiv.org/list/cs.SE/recent",
    // named places people actually search for ("how to x on github", "python docs")
    "https://www.youtube.com",
    "https://www.python.org",
    "https://doc.rust-lang.org/book/",
    "https://go.dev/doc/",
    // Italy — so an Italian visitor gets real local coverage, not just a boost.
    // Article URLs, not homepages: homepages are link farms and get pruned.
    "https://it.wikipedia.org/wiki/Italia",
    "https://it.wikipedia.org/wiki/Cucina_italiana",
    "https://it.wikipedia.org/wiki/Campionato_di_Italia",
    "https://www.ansa.it/scienza/index.html",
    "https://www.corriere.it/cronache/index.shtml",
    // reference (deliberately a minority)
    "https://en.wikipedia.org/wiki/Search_engine",
    "https://www.britannica.com",
    // concrete media pages so the Images / Videos / Shorts verticals have
    // something to show (classification comes from page metadata)
    "https://www.youtube.com/watch?v=aqz-KE-bpKQ", // Big Buck Bunny (CC)
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ", // Never Gonna Give You Up
    "https://www.youtube.com/watch?v=jNQXAC9IVRw",
    "https://vimeo.com/76979871",
    "https://commons.wikimedia.org/wiki/File:Earth_from_SLR-4.jpg",
    "https://commons.wikimedia.org/wiki/File:The_Earth_seen_from_Apollo_17.jpg",
    "https://www.nasa.gov/image-article/pale-blue-dot/",
    "https://example.com",
  ] as string[],

  crawl: {
    maxPages: 2000,
    concurrency: 3,
    politenessMs: 800,
    maxBytes: 2_000_000,
    minTextChars: 100,
    maxTextChars: 20_000,
    maxLinksPerPage: 200,
    maxOutlinksQueued: 500,
    sameHostOnly: false,
    // Stops one link-heavy seed from eating the whole page budget.
    maxPagesPerHost: 6,
    // Re-crawl when the index file is older than this (sync.sh honours the same
    // threshold via STALE_HOURS). Crawl-time rules only reach the corpus when a
    // crawl runs, so this is how a fix becomes searchable without deleting
    // data/index.json by hand.
    staleHours: 6,
    // Famous-site roots get their own slow pass first (see bootstrapFamous),
    // so a link-heavy wide crawl cannot starve them.
    timeoutMs: 25_000,
    // Host prefixes that are never content: account/investor/support subdomains.
    blockedHostPrefixes: [
      "account", "accounts", "investor", "investors", "skills", "maintainers",
      "locate", "careers", "jobs", "support", "help", "status", "billing",
      "checkout", "my", "dashboard",
    ] as string[],
    // Link-shaped noise we never want in the index.
    blockedHosts: [
      // Login-walled social networks: no public text to index.
      "x.com", "twitter.com", "facebook.com", "instagram.com", "linkedin.com",
      "tiktok.com", "pinterest.com", "discord.com", "reddit.com",
      // Auth endpoints and ad infrastructure.
      "accounts.google.com", "doubleclick.net", "googlesyndication.com",
      "adservice.google.com", "aboutads.info", "adsrvr.org", "amazon-adsystem.com",
    ] as string[],
    blockedPathPatterns: [
      "/subscribe", "/login", "/signin", "/sign-in", "/register", "/account",
      "/privacy", "/terms", "/cookie", "/user-agreement", "/aboutads", "/newsletter",
      "/advertise", "/careers", "/press",
    ] as string[],
    // Whole path segments that mean "profile or listing page", matched per
    // segment so /user?id=x and /user/ are both caught.
    blockedPathSegments: [
      "user", "users", "u", "profile", "profiles", "author", "authors", "members",
      "tag", "tags", "category", "categories", "feed", "rss", "sitemap",
      "from", "item", "items", "comments", "thread", "submit", "drafts",
      // auth endpoints and locale/marketing variants
      "servicelogin", "accounts", "intl", "ads", "adwords", "preferences",
      // store/checkout/app/profile subpages: no article text
      "search", "signin", "signup", "store", "shop", "cart", "checkout",
      "investors", "investor", "apps", "app", "download", "downloads", "imghp",
    ] as string[],
  },

  userAgent: "MiniSearchBot/0.3 (+https://github.com/JustScriptzz/search-engine)",
  acceptLanguage: "en-US,en;q=0.9",

  language: {
    // Scripts we refuse to index. Latin-script languages stay in.
    blockedScripts: [
      "arabic", "hebrew", "cyrillic", "cjk", "devanagari", "thai", "greek",
      "bengali", "tamil", "telugu", "kannada", "malayalam", "gujarati",
      "punjabi", "oriya", "sinhala", "myanmar", "khmer", "lao", "tibetan",
      "georgian", "armenian", "ethiopic", "cherokee",
    ] as string[],
    maxBlockedRatio: 0.15,
  },

  quality: {
    // Query-time gate (also applied while crawling). A doc shorter than this, or
    // built from repeated nav/link filler, is never shown.
    minDocChars: 80,
    maxShingleDupRatio: 0.35,
    // Site index pages ("/news", "/jobs", "/ask") are short by nature and would
    // otherwise win generic queries like "news". Articles are not.
    minWords: 120,
    // Pages whose text is mostly link labels (index/tag/listing pages) are not
    // articles and must never outrank one.
    maxLinkDensity: 0.45,
  },

  deepSearch: {
    // Multi-pass retrieval: decompose, expand from the top hits, fuse.
    // Pure classical IR — no model call, so no extra latency or cost.
    enabled: true,
    subQueries: true,
    expansionTerms: 6,
    // Reciprocal-rank fusion only knows position, not magnitude: a page that
    // matched an exact title phrase 40x harder than the next one arrives with
    // the same fused score and loses on a tie-break. This blends the original
    // BM25 score back in (relative to the best hit) so decisive matches stay
    // decisive across passes.
    scoreBlend: 1.5,
    maxPasses: 4,
    rrfK: 60,
  },

  authority: {
    // Link-graph authority: how strongly a well-linked domain is promoted.
    // weight 0 = off, ~1.5 = noticeable, 3 = dominant.
    weight: 1.8,
    damping: 0.85,
    iterations: 25,
    // Curated roots get a floor so a famous domain never sinks below noise.
    curatedFloor: 0.55,
  },

  bm25: {
    k1: 1.2,
    b: 0.75,
    titleRepeat: 2,
    // Query-term coordination: multiply score by (matched/total)^exponent so a
    // page matching every query term beats one that repeats a single term.
    coordination: 1.6,
    // Field weights applied on top of BM25: a term in the page title counts
    // more than in the body, and matching the site's own host counts most, so
    // "youtube" surfaces youtube.com rather than pages that mention it.
    field: { title: 1.2, host: 2.2, subdomainHost: 0.8, phrase: 0.8, bodyPhrase: 0.4 },
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
    // Multiplier for a .tld (or .com) that serves the visitor's country.
    boost: 1.8,
    // Extra multiplier when the page's own language matches the visitor's.
    langBoost: 2.4,
  },

verticals: {
    // Vertical search (image / video / shorts) works off page metadata, not a
    // third-party media API: og:type, og:image, og:video and shorts URL shapes.
    boost: 1.9, // how much a matching vertical is promoted
    penalty: 3.0, // how much a non-matching vertical is demoted
    thumbMaxWidth: 640,
  },

  trust: {
    // Two tiers of source. Curated = allowlisted or reached from our seed list,
    // i.e. somewhere we chose on purpose. Discovered = found by Common Crawl or
    // certificate transparency, which is also how a search engine ends up with
    // NIH grant-spam link farms outranking the sites you actually seeded.
    // Discovered pages are demoted, never hidden: if nothing else matches, they
    // are still better than an empty page.
    curatedBoost: 1.2,
    discoveredPenalty: 0.3,
  },

  api: {
    // Public JSON API at /api/v1 (open, no key). Fixed window per IP: enough for
    // a demo or a side project, cheap enough that one runaway script cannot pin
    // a core on a 1 GB box. Deep search is CPU-heavy, so the ceiling matters.
    rateLimitPerMinute: 60,
    maxLimit: 50,
    // Keep /api/v1 out of the static file listing and out of search-engine crawls.
    excludeFromCrawl: true,
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

  storage: {
    // What we are willing to spend on disk. The VPS has ~1 GB, so the crawl has
    // to stop on its own rather than fill the disk and take the panel down with
    // it. data/index.json is rewritten on every save, so leave headroom for two
    // copies of it plus the runtime and the OS.
    indexBudgetMb: 500,
    // Refuse to start a fill run that would leave less than this free.
    minFreeMb: 120,
    // Documents per host in fill mode: many hosts, a few pages each. Coverage
    // beats depth when the budget is the binding constraint.
    bulkPerHost: 2,
    // Fill mode only takes pages from the hosts we chose on purpose unless you
    // pass --long-tail. The long tail is where link-farm spam lives.
    bulkCuratedOnly: true,
    // Wall-clock ceiling for one fill run, so a boot never hangs forever.
    fillMaxMinutes: 25,
    // Pages pulled per host from its sitemap in fill mode.
    fillSitemapPerHost: 400,
    // Bounded passes over the Common Crawl index, so a fill run moves through
    // its phases instead of living on discovery forever.
    fillDiscoverRounds: 6,
    // Stop a fill run at this fraction of the RAM ceiling. The kernel would
    // otherwise kill it mid-round and the run would look like a crash.
    memoryStopPct: 0.75,
    // RAM ceiling in bytes. Containers rarely see the host's memory, so this
    // defaults conservatively and the cgroup limit wins when we can read it.
    memoryLimitBytes: 700 * 1_048_576,
  },

  discovery: {
    // Common Crawl's public index: a catalogue of every crawled URL on the web.
    collectionIndexUrl: "https://index.commoncrawl.org/collinfo.json",
    indexUrl: "https://index.commoncrawl.org",
    // WARC records are stored as gzipped byte ranges inside huge files on
    // Common Crawl's own storage. Reading a range of one is how we index a site
    // that refuses to be crawled, without touching its origin.
    dataUrl: "https://data.commoncrawl.org",
    // Bandwidth ceiling per range fetch, so a fat page cannot blow up the box.
    maxRecordBytes: 2_000_000,
    timeoutMs: 90_000,
    collectionCacheTtlMs: 6 * 60 * 60 * 1000,
    // How many URLs to pull per pattern during `discover`.
    perPattern: 40,
    // Sitemap expansion: how many sitemap docs to read per host, and how many
    // URLs to keep. Sitemaps are the cheapest bulk URL source on the web.
    sitemapsPerHost: 8,
    // Hard ceiling on the bytes read from one sitemap document. Sitemaps are
    // read as a stream, so this bounds the buffer rather than the process, but
    // it stops a 50 MB "sitemap" from eating the box.
    maxSitemapBytes: 2_000_000,
    sitemapUrlLimit: 5000,
    // Topic wildcards expanded into URL patterns for `crawl --discover`.
    topicPatterns: [
      "en.wikipedia.org/wiki/*",
      "*.nasa.gov/*",
      "*.arxiv.org/abs/*",
      "*.ieee.org/*",
      "*.nature.com/articles/*",
      "*.sciencedirect.com/science/article/*",
      "*.gov.uk/*",
      "*.europa.eu/*",
      "*.edu/*",
      "*.github.io/*",
      "*.rust-lang.org/*",
      "*.python.org/*",
      "*.mozilla.org/en-US/docs/*",
      "*.apache.org/*",
      "*.redcross.org/*",
      "*.un.org/*",
    ] as string[],
  },

  ui: {
    defaultLimit: 10,
    maxLimit: 25,
  },
} as const;

export type AppConfig = typeof CONFIG;