#!/usr/bin/env bash
# Boot script for the Pterodactyl panel. The panel runs this on every start, so
# it has to do three things: get the current code, keep the crawl fresh, and
# clean the index against the current quality rules.
set -u
cd "$(dirname "$0")"

BRANCH="${GIT_BRANCH:-main}"

# ---- 1. update the code -------------------------------------------------
# This used to clone only when there was no .git directory, which meant a server
# that was ever deployed once never received another update. Rely on this, not on
# the panel's auto-update setting, so a fix is live on the next restart.
if [ -d .git ]; then
  git fetch --depth 1 origin "$BRANCH" 2>/dev/null || git fetch origin "$BRANCH" || true
  git reset --hard "origin/$BRANCH" 2>/dev/null || git pull --ff-only origin "$BRANCH" || true
else
  rm -rf /tmp/s
  git clone --depth 1 --branch "$BRANCH" https://github.com/JustScriptzz/search-engine.git /tmp/s \
    && cp -r /tmp/s/. . \
    && rm -rf /tmp/s
fi
# .env is gitignored, so a hard reset never touches the API key.

# ---- 2. keep the crawl fresh --------------------------------------------
# The old gate was "crawl only if data/index.json is missing", which made a
# re-crawl a manual chore: delete the file, restart. Crawl-time behaviour
# (media cards, seed priority, trust) only reaches the corpus when a crawl
# actually runs, so freshness is now time-based.
INDEX=data/index.json
STALE_HOURS="${STALE_HOURS:-6}"      # re-crawl at most this often
CRAWL_MAX="${CRAWL_MAX:-300}"        # pages per crawl; ~60 pages per site
CRAWL_CONCURRENCY="${CRAWL_CONCURRENCY:-3}"

need_crawl=1
if [ -s "$INDEX" ]; then
  now=$(date +%s)
  then=$(stat -c %Y "$INDEX" 2>/dev/null || stat -f %m "$INDEX" 2>/dev/null || echo 0)
  age_h=$(( (now - then) / 3600 ))
  echo "index age: ${age_h}h (stale after ${STALE_HOURS}h)"
  if [ "$age_h" -lt "$STALE_HOURS" ]; then
    need_crawl=0
  fi
fi

if [ "$need_crawl" = "1" ]; then
  echo "crawling (max=${CRAWL_MAX}, concurrency=${CRAWL_CONCURRENCY})"
  # New pages are added to the existing index; duplicates are rejected by
  # content hash, so repeated crawls grow the corpus instead of rewriting it.
  bun src/cli.ts crawl --max "$CRAWL_MAX" --concurrency "$CRAWL_CONCURRENCY"
fi

# ---- 3. keep the index honest -------------------------------------------
# Cheap, and it rescues an index built before a quality rule existed.
bun src/cli.ts prune