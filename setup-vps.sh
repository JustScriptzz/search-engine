#!/usr/bin/env bash
# MiniSearch VPS setup — auto-detects OS, installs Bun, deploys search-engine.
# Usage: sudo bash setup-vps.sh
# Env overrides: REPO_URL=... PORT=3000 MAX_PAGES=2000 APP_DIR=/opt/minisearch
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/JustScriptzz/search-engine.git}"
PORT="${PORT:-3000}"
MAX_PAGES="${MAX_PAGES:-2000}"
APP_DIR="${APP_DIR:-/opt/minisearch}"

log() { echo "[minisearch] $*"; }
have() { command -v "$1" >/dev/null 2>&1; }

# --- detect package manager ---
install_deps() {
  if have apt-get; then
    log "Debian/Ubuntu detected (apt)"
    apt-get update -y
    apt-get install -y curl git ca-certificates
  elif have dnf; then
    log "RHEL/Fedora detected (dnf)"
    dnf install -y curl git ca-certificates
  elif have yum; then
    log "RHEL/CentOS detected (yum)"
    yum install -y curl git ca-certificates
  elif have apk; then
    log "Alpine detected (apk)"
    apk add --no-cache curl git ca-certificates
  else
    log "No supported package manager found; need curl + git installed."
  fi
}

install_deps

# --- install Bun ---
if ! have bun; then
  log "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="${BUN_INSTALL:-$HOME/.bun}"
  export PATH="$BUN_INSTALL/bin:$PATH"
  # make available system-wide for the service
  ln -sf "$BUN_INSTALL/bin/bun" /usr/local/bin/bun || true
else
  log "Bun already installed: $(bun --version)"
fi
have bun || { export PATH="$HOME/.bun/bin:/root/.bun/bin:$PATH"; }
command -v bun >/dev/null || { echo "ERROR: bun not found after install"; exit 1; }

# --- deploy app ---
if [ -d "$APP_DIR/.git" ]; then
  log "Updating existing checkout in $APP_DIR"
  git -C "$APP_DIR" pull --ff-only || log "pull failed, keeping current checkout"
else
  log "Cloning $REPO_URL -> $APP_DIR"
  mkdir -p "$(dirname "$APP_DIR")"
  git clone "$REPO_URL" "$APP_DIR"
fi
cd "$APP_DIR"

# --- initial crawl (small, VPS-friendly) ---
if [ ! -s data/index.json ]; then
  log "Crawling $MAX_PAGES pages (first run)..."
  mkdir -p data
  bun src/cli.ts crawl --seeds seeds.txt --max "$MAX_PAGES" --concurrency 3 || log "crawl had errors, continuing"
else
  log "Existing index found, skipping initial crawl"
fi

# --- run as a service ---
if have systemctl && [ -d /run/systemd/system ]; then
  log "Installing systemd service (port $PORT)..."
  cat > /etc/systemd/system/minisearch.service <<EOF
[Unit]
Description=MiniSearch engine
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
ExecStart=/usr/local/bin/bun src/cli.ts serve --port $PORT
Restart=always
RestartSec=5
Environment=PORT=$PORT

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now minisearch
  sleep 2
  systemctl status minisearch --no-pager | head -15 || true
  log "Service installed. Logs: journalctl -u minisearch -f"
else
  log "No systemd — starting in background with nohup..."
  pkill -f "cli.ts serve" 2>/dev/null || true
  nohup bun src/cli.ts serve --port "$PORT" > minisearch.log 2>&1 &
  sleep 2
  log "Running in background (log: $APP_DIR/minisearch.log). Add to crontab @reboot to persist."
fi

# --- verify ---
log "Checking API..."
sleep 1
if curl -fsS "http://localhost:$PORT/api/stats" | head -c 300; then
  echo
  log "OK — UI at http://<your-vps-ip>:$PORT (put Caddy/Nginx in front for TLS)"
else
  log "API not responding yet — check logs."
fi
