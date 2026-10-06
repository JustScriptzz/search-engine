# MiniSearch container.
#
# One image for any host that runs containers: Fly.io, Railway, Render, Cloud Run,
# a VPS, or a laptop. There is no build step to speak of — Bun runs TypeScript
# directly — so this is just a pinned runtime, the source, and a data directory
# that survives restarts.
#
#   docker build -t minisearch .
#   docker run -p 3000:3000 -v minisearch-data:/data \
#     -e EMBEDDING_API_KEY=... -e COGITO_API_KEY=... minisearch
#
# The volume matters. Without one the index is lost on every restart, and a
# search engine that forgets everything between requests is not a search engine.

FROM oven/bun:1.4-alpine

WORKDIR /app

# Dependencies first so the layer caches across source edits.
COPY package.json ./
RUN bun install --frozen-lockfile 2>/dev/null || bun install

COPY . .

# The index lives here and must be a mounted volume in production.
ENV SERVER_INDEX_PATH=/data/index.json \
    SERVER_PORT=3000 \
    HOST=0.0.0.0 \
    # Nothing should crawl during a container start: deploy platforms have boot
    # timeouts, and the background fill is better run deliberately. Turn it on
    # with AUTO_FILL=1 once the instance is up.
    AUTO_FILL=0 \
    NODE_ENV=production

RUN mkdir -p /data && chown -R bun:bun /app /data
USER bun

VOLUME ["/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=90s --retries=3 \
  CMD bun -e "const r = await fetch('http://127.0.0.1:' + (process.env.SERVER_PORT || 3000) + '/healthz'); process.exit(r.ok ? 0 : 1)"

CMD ["bun", "run", "pterodactyl.ts"]