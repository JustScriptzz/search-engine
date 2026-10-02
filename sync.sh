#!/usr/bin/env bash
# Pterodactyl BUILD_COMMAND helper (`bash sync.sh`, 12 chars).
# 1. First boot with no .git: clone the repo over this directory so later
#    boots auto-update via the egg's `git pull` line. data/ is gitignored,
#    so the existing index is never touched.
# 2. Crawl once when there is no index yet.
set -u
if [ ! -d .git ]; then
  git clone --depth 1 https://github.com/JustScriptzz/search-engine.git /tmp/s \
    && cp -r /tmp/s/. . && rm -rf /tmp/s
fi
if [ ! -s data/index.json ]; then
  bun src/cli.ts crawl --seeds seeds.txt --max 2000 --concurrency 3
fi
