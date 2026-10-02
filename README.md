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

- Provider: **Cogito (Decart)** — OpenAI-compatible `https://api.cogito.decart.ai/v1`,
  model resolved from `GET /v1/models` to your account's GPT-OSS 120B slug
  (e.g. `gpt-oss:ultra-fast`). text.pollinations.ai's text API is deprecated,
  so nothing depends on it any more.
- System prompt brands it *MiniSearch AI*, forces `search_index` before any claim,
  forbids invented URLs, and requires markdown citations from tool output.
- Tools (full backend access): `search_index` (BM25 + country boost),
  `read_page` (refetches an indexed URL; off-index URLs are rejected),
  `index_stats`.
- Tool protocol: Cogito's `/chat/completions` returns empty `tool_calls` for
  gpt-oss (harmony channels aren't mapped), so the agent emits
  `MINISEARCH_TOOL {"name":…,"args":…}` and we execute it ourselves. Native
  `tool_calls` are still honoured if a provider ever sends them —
  flip `ai.nativeTools` in `src/config.ts`.
- Resilience: model-slug caching, 400ms pacing, retry with backoff on 5xx,
  auth errors never retried, SSE heartbeat + 240s idle timeout, and a
  deterministic **extractive fallback** so the UI always answers.

Measured: tool call → cited answer in ~2s.

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