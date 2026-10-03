#!/usr/bin/env bash
set -u
if [ ! -d .git ]; then
  git clone --depth 1 https://github.com/JustScriptzz/search-engine.git /tmp/s
  cp -r /tmp/s/. .
  rm -rf /tmp/s
fi
if [ ! -s data/index.json ]; then
  bun src/cli.ts crawl --max 2000 --concurrency 3
fi
# Always clean the index against the current filters: cheap, and it rescues an
# index that was built before a quality rule existed.
bun src/cli.ts prune
