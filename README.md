# MiniSearch — small web search engine with an AI agent

Crawl the web → BM25 inverted index → keyword search UI **and** a tool-calling
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
bun test                                   # 28 tests
bun src/cli.ts crawl --max 2000           # crawl (defaults come from src/config.ts)
bun src/cli.ts search --query "how to parse html"
bun src/cli.ts ask "what is bm25 ranking?" # MiniSearch AI in the terminal
bun src/cli.ts serve --port 3000           # UI at http://localhost:3000
```

No `--seeds` file needed: the default seed list lives in `src/config.ts`.

## HTTP API

| Route | Purpose |
| --- | --- |
| `GET /api/search?q=…&limit=10&country=DE` | Ranked hits + timing + resolved country |
| `GET /api/stats` | doc/term counts, version |
| `POST /api/chat` | Agent. Body `{message, history?, country?}` → **SSE** events |
| `GET /` | Web UI (search + AI chat) |

`POST /api/chat` streams `data:` frames: `status`, `tool`, `answer`, `error`, `done`.

```bash
curl -N -X POST localhost:3000/api/chat -H 'content-type: application/json' \
  -d '{"message":"what is bm25?"}'
```

## MiniSearch AI

- Provider: **text.pollinations.ai**, OpenAI-compatible route `POST /openai`, model `openai`.
- System prompt brands it *MiniSearch AI*, forces `search_index` before any claim,
  forbids invented URLs, and requires markdown citations from tool output.
- Tools (full backend access): `search_index` (BM25 + country boost),
  `read_page` (refetches an indexed URL, returns text), `index_stats`.
- Tool calling: the anonymous free tier rejects native `tools` (500/402), so the
  agent uses a `MINISEARCH_TOOL {"name":…,"args":…}` protocol and still honours
  native `tool_calls` when the provider sends them (auto-enabled with a token).
- Resilience: pacing (1 request / 15s anonymous), retry with backoff on
  402/429/5xx, SSE heartbeat + 240s idle timeout, and a deterministic
  **extractive fallback** so the UI always answers even if the model is down.

```bash
export POLLINATIONS_TOKEN=…   # optional: 3s cadence + richer params + native tools
```

## Country tuning

`src/geo.ts` resolves the visitor IP (`x-forwarded-for` aware) via ip-api.com
(cached 6h, 700ms timeout, fail-open, IPs never stored) and boosts that
country's home TLDs 1.35×. `?country=DE` overrides detection for testing.

## Configuration

Everything hardcoded lives in `src/config.ts`: server/port/host, seeds, crawl
limits (pages, concurrency, politeness, timeouts, byte caps), blocked scripts,
BM25 `k1`/`b`/title repeat, stopwords, geo endpoint + boost, AI model/temperature/
step limits/rate limits, UI limits.

## Deploying on Pterodactyl

Panel variables (Startup tab):

- `MAIN_FILE` = `pterodactyl.ts` — reads `SERVER_PORT`, no args needed
- `BUILD_COMMAND` = `bash sync.sh` — first boot clones the repo, then crawls once
- `AUTO_UPDATE` = `1` — boot `git pull`s new commits

Plain VPS instead:

```bash
sudo bash setup-vps.sh        # OS auto-detect, Bun, systemd unit, verification
bun build --compile ./src/cli.ts --outfile ./minisearch
```

## Tests

`bun test` covers tokenizer, BM25 ranking + title boost + dedup, parser/entity
decoding, charset decoding, Frontier politeness/dedup, script detection, geo
boosts, and the agent (tool protocol, native tool calls, provider-outage
fallback, `read_page` sandboxing).

## Limits

Single node, index in one JSON file — fine to ~10–50k docs. Beyond that, move
the index to OpenSearch and the frontier to Redis/Kafka (the worker pool in
`src/crawler/crawler.ts` is already isolated for that).