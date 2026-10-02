# MiniSearch — tiny production-oriented web search engine

Crawl web pages → build a BM25 inverted index → search via CLI or web UI.

Built with **Bun + TypeScript, zero dependencies**.

```
seeds.txt → Frontier (politeness + dedup)
  → Fetcher (timeout, content-type filter)
  → robots.txt check
  → Parser (title/text/links)
  → InvertedIndex (tokenize + BM25, content dedup)
  → data/index.json → API + UI
```

## Quickstart

```bash
# needs Bun 1.x: https://bun.sh
bun install  # optional (zero runtime deps)
bun test

# crawl 20 pages from seeds
bun src/cli.ts crawl --seeds seeds.txt --max 20 --concurrency 5

# search the local index
bun src/cli.ts search --query "search engine"

# serve UI + JSON API
bun src/cli.ts serve --port 3000
# open http://localhost:3000
# API: GET /api/search?q=hello&limit=10
#      GET /api/stats
```

Country tuning: the API reads the visitor IP (`x-forwarded-for` aware),
resolves the country via ip-api.com (cached 6h, 700ms timeout, fail-open),
and boosts results from that country's home TLDs 1.35x. `?country=DE`
overrides detection (testing / privacy). IPs are never stored.

Options:

- `--same-host-only` — stay on seed domains (good for large crawls)
- Increase `--max` / `--concurrency` as you scale; politeness default 800ms/host
- Index persists to `data/index.json` (gitignored)

## Scaling notes (toward production web-scale)

- Phase 1 here = single-node. Works to ~100k docs on one machine.
- Next steps: replace `data/index.json` with OpenSearch, `Frontier` queue with Kafka/Redis, add workers (see `src/crawler/crawler.ts` — worker pool is already isolated).
- Honor `robots.txt` (`src/crawler/robots.ts`), timeouts, max-bytes, content dedup via sha256.

## Layout

- `src/crawler/` — frontier, fetcher, parser, robots, crawler
- `src/index/` — tokenizer, invertedIndex (BM25)
- `src/server.ts` — Bun.serve API + static UI
- `src/cli.ts` — crawl / search / serve commands
- `public/` — search UI
