# MiniSearch — small web search engine with an AI agent

Crawl the web → BM25 inverted index → keyword search UI **and** a tool-using
agent ("MiniSearch AI") that answers from the same index and cites what it read.

Bun + TypeScript, **zero runtime dependencies**.

```
seeds → Frontier (dedup + per-host politeness)
      → robots.txt gate
      → Fetcher (English Accept-Language, charset detection, size cap)
      → Language filter (Latin-only: no random Arabic/CJK/Cyrillic pages)
      → Parser (title / text / links / lang)
      → InvertedIndex (BM25 + title boost + content dedup)
      → data/index.json → HTTP API → web UI + /api/chat agent
```

## Quickstart

```bash
cp .env.example .env      # add COGITO_API_KEY
bun test                   # 30 tests
bun src/cli.ts crawl --max 2000
bun src/cli.ts search --query "how to parse html"
bun src/cli.ts ask "what is bm25 ranking?"   # agent in the terminal
bun src/cli.ts serve --port 3000             # UI at http://localhost:3000
```

No `--seeds` file needed: the default seed list lives in `src/config.ts`.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/search?q=…&limit=10&country=DE` | Ranked hits + timing + resolved country |
| `GET /api/stats` | doc/term counts, version, AI provider status |
| `POST /api/chat` | Agent. Body `{message, history?, country?}` → **SSE** events |
| `GET /` | Web UI (search + AI chat) |

`POST /api/chat` streams `data:` frames: `status`, `tool`, `answer`, `error`, `done`.

```bash
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"what is bm25?"}'
```

## MiniSearch AI

- Runs on an OpenAI-compatible chat endpoint configured in `src/config.ts`
  (`ai.baseUrl`, `ai.model`, resolved at runtime against `GET /v1/models`).
  Nothing about the vendor or model is exposed by the API or the UI.
- System prompt brands it *MiniSearch AI*, forces `search_index` before any claim,
  forbids invented URLs, and requires markdown citations from tool output.
- Tools (full backend access): `search_index` (BM25 + country boost),
  `read_page` (refetches an indexed URL; off-index URLs are rejected),
  `index_stats`.
- Tool protocol: this endpoint returns empty `tool_calls` for the configured
  model, so the agent emits
  `MINISEARCH_TOOL {"name":…,"args":…}` and we execute it ourselves. Native
  `tool_calls` are still honoured if a provider ever sends them —
  flip `ai.nativeTools` in `src/config.ts`.
- Credentials: `.env` `COGITO_API_KEY` wins; `ai.apiKeyFallback` in
  `src/config.ts` is the last resort so a fresh clone answers questions out of
  the box. **Move the key out of the config file into `.env` once you deploy.**
- Resilience: model-slug caching, 400ms pacing, retry with backoff on 5xx,
  auth errors never retried, SSE heartbeat + 240s idle timeout, and a
  deterministic **extractive fallback** so the UI always answers.

Measured: tool call → cited answer in ~2s.

## Indexing the famous sites

`src/famous.ts` holds a 66-site allowlist (Google, Wikipedia, GitHub, NASA,
Netflix Tech, Khan Academy, Library of Congress, ANSA, Corriere…). Homepages of
those sites are link farms with almost no prose, so instead of dropping them the
crawler stores a **site card** — title + host + the first real sentences. Cards
are only minted for a site's own front page or a top-level section, never for
`/store`, `/signin` or app-store leaves.

Result: searching `google` returns `google.com` itself, not pages that merely
mention it.

## More URL sources

Three independent sources, none of which require crawling through link graphs:

```bash
# 1. published sitemaps (cheapest bulk source on the web)
bun src/cli.ts sitemap --hosts nasa.gov,www.bbc.com --per-host 5000 --out data/urls.txt

# 2. certificate transparency: real subdomains, no API key
bun src/cli.ts crt --hosts bbc.com --limit 200

# 3. Common Crawl index (wildcards across topic domains)
bun src/cli.ts discover --patterns "*.arxiv.org/*" --per-pattern 100

# build a big frontier on disk WITHOUT fetching a single page
bun src/cli.ts plan --per-pattern 60 --sitemaps 40 --out data/discovered.txt
bun src/cli.ts crawl --seeds data/discovered.txt --max 2000
```

Sitemaps are the big one: sites publish their whole URL inventory there, and
`sitemapsPerHost` × `sitemapUrlLimit` scales to tens of thousands of real article
URLs per domain for the price of a few HTTP requests. Verified: `nasa.gov` and
`bbc.com` yield 300+ article URLs each in seconds.

### Storage reality on 1 GB

URLs and documents cost very differently:

| thing | bytes | 1 GB holds |
| --- | --- | --- |
| URL string | ~50–80 | **~13–20 million** |
| indexed document | ~44 KB (full text) | ~20–25 thousand |

So keep discovery and fetching separate: `plan` writes millions of URLs to a
text file for a few MB, and `crawl` fetches as many as your CPU, RAM and disk
allow. Dropping full text and storing only title + description + URL cuts a doc
to ~1 KB (~1 million on 1 GB) if you want a URL-scale index — see `types.ts`
for where `text` is consumed.

### Other bulk sources worth adding

- **Common Crawl WARC/WET dumps** — fetch once, parse locally; no per-URL HTTP
- **Wikipedia / Stack Exchange dumps** — whole encyclopedias as text
- **HTTP Archive** — millions of real URLs with response metadata
- **Tranco / Cloudflare Radar domain lists** — top-N ranked domains as seeds

Each trades disk or a dependency for volume; none of them can be crawled *and*
stored in full on 1 GB, so the right shape is a URL frontier on disk plus a
bounded fetched index in memory.

Seed lists only get you so far, so `src/discovery.ts` queries the **Common Crawl
index** — a public catalogue of every URL anyone has crawled:

```bash
bun src/cli.ts discover --patterns "*.nasa.gov/*" --per-pattern 8
bun src/cli.ts crawl --discover --discover-limit 10 --max 600
```

It resolves the newest collection from `collinfo.json`, streams the match set
and aborts once it has enough URLs (their index ignores `pageSize` and 504s on
`matchType=domain`). Topic wildcards in `config.discovery.topicPatterns` cover
`en.wikipedia.org`, NASA, arXiv, IEEE, Nature, gov.uk, europa.eu, `.edu`,
GitHub Pages, Rust/Python/MDN/Apache.

Honest limits: this finds URLs, it does not index the whole web. Their index
serves stale URLs and ignores `robots.txt` on our side — the crawler still
enforces robots, per-host politeness and the quality gate on every fetch. On a
1 GB VPS budget crawl volume by pages, not ambition: raise `--max` as disk
allows, and re-run `prune` afterwards.

## Ranking

BM25 (`k1=1.2`, `b=0.75`) with the title repeated twice in the term stream, plus:

- **query-term coordination** — score × `(matched/query)^1.6`, so covering the
  whole query beats repeating one term
- **field weights** — title ×1.2, exact domain ×2.2, subdomain ×0.8, exact
  phrase in title ×0.8 (`google.com` beats `issuetracker.google.com`)
- **country + language** — ×1.8 for the visitor's TLD, ×2.4 for pages written in
  their language (half for the English fallback)

The UI shows coverage per result (`2/2 terms`).

Crawl quality: `Accept-Language` + charset-correct decoding, script detection
(dropping non-Latin pages), robots.txt, per-host politeness, content dedup, and
a junk-link filter (social/video/ad hosts, `/subscribe`, `/privacy`, …).

## UI

One page, no framework, no third-party requests:
sticky search bar with `/` shortcut, `↑ ↓ j k` result navigation, `Enter` to
open, domain facet pills from the API, term highlighting, dark/light theme with
a persisted choice, recent searches in `localStorage`, and a slide-over
MiniSearch AI chat that streams tool calls and citations.

## Country tuning

`src/geo.ts` resolves the visitor IP (`x-forwarded-for` aware) via ip-api.com
(cached 6h, 700ms timeout, fail-open, IPs never stored) and boosts that
country's home TLDs 1.35×. `?country=DE` overrides detection for testing.

## Configuration

`src/config.ts` holds every hardcoded value: server/port/host/timeouts, seeds,
crawl limits, blocked scripts, BM25 `k1`/`b`/title repeat, stopwords, geo
endpoint + boost, AI provider/model/preference/retries, UI limits.
Secrets live in `.env` (gitignored) — see `.env.example`.

## Deploying on Pterodactyl

Startup tab:

- `MAIN_FILE` = `pterodactyl.ts` — reads `SERVER_PORT`, loads `.env`, no args needed
- `BUILD_COMMAND` = `bash sync.sh` — first boot clones the repo, then crawls once
- `AUTO_UPDATE` = `1` — boot `git pull`s new commits

Upload a `.env` file containing `COGITO_API_KEY` in the Files tab (it is
gitignored, so `git pull` never clobbers it). Without it the agent still answers,
falling back to raw index results.

Plain VPS instead:

```bash
sudo bash setup-vps.sh        # OS auto-detect, Bun, systemd unit, verification
bun build --compile ./src/cli.ts --outfile ./minisearch
```

## Tests

`bun test` covers tokenizer, BM25 ranking + title boost + dedup, parser/entity
decoding, charset decoding, Frontier politeness/dedup, script detection, geo
boosts, and the agent (tool protocol, native tool calls, empty-content
handling, missing-key path, provider outage fallback, `read_page` sandboxing).

## Limits

Single node, index in one JSON file — fine to ~10–50k docs. Beyond that, move
the index to OpenSearch and the frontier to Redis/Kafka (the worker pool in
`src/crawler/crawler.ts` is already isolated for that).