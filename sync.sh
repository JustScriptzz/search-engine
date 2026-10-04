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

# ---- 2. keep the index honest -------------------------------------------
# Cheap, and it rescues an index built before a quality rule existed.
#
# The crawl itself is NOT here. This script is the build step, so anything it
# runs happens *before* the server starts: filling the index from here made the
# site unreachable for the whole 25-minute crawl, on every boot. The server now
# starts first and grows the index in the background (AUTO_FILL in
# pterodactyl.ts), which keeps this to a fast, safe operation.
bun src/cli.ts prune