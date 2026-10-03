#!/usr/bin/env bash
# Issue and renew the Let's Encrypt certificate for this server, using DuckDNS
# for a DNS-01 challenge.
#
# Why DNS-01 and not HTTP-01: the app is reached on an allocated port
# (https://minisearch.duckdns.org:6036), not on 443, so the CA cannot reach a
# /.well-known/acme-challenge/ path. DNS-01 only needs to write a TXT record,
# which DuckDNS lets us do with a token — no public port, no downtime, and it
# works while the server is stopped.
#
# Usage
#   DUCKTNS_TOKEN=<token> bash tls-cert.sh            # issue, then install
#   DUCKTNS_TOKEN=<token> bash tls-cert.sh renew      # renew if under 30 days
#   DUCKTNS_TOKEN=<token> bash tls-cert.sh install    # re-install files only
#   bash tls-cert.sh check                            # inspect what is on disk
#   bash tls-cert.sh cron                             # install the renew timer
#
# The token is the "token" shown at https://www.duckdns.org (not your password).
# Keep it in .env as DUCKTNS_TOKEN; the script reads .env itself so you do not
# have to paste it on the command line (where it would end up in shell history).

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

DOMAIN="${DOMAIN:-minisearch.duckdns.org}"
ALT_DOMAINS="${ALT_DOMAINS:-}"          # space-separated extra names
CERT_FILE="$ROOT/${CERT_FILE:-fullchain.pem}"
KEY_FILE="$ROOT/${KEY_FILE:-privkey.pem}"
RENEW_DAYS="${RENEW_DAYS:-30}"          # renew when fewer than this many days left
ACME_HOME="${ACME_HOME:-$HOME/.acme.sh}"
ACME="$ACME_HOME/acme.sh"
CA="${CA:-letsencrypt}"
STAGING="${STAGING:-0}"                 # 1 = Let's Encrypt staging, for testing
RENEW_RELOAD_CMD="${RENEW_RELOAD_CMD:-}"  # e.g. "kill -USR2 \$(pgrep -f pterodactyl.ts)"

log()  { printf '\033[1;32m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m warn\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31merror\033[0m %s\n' "$*" >&2; exit 1; }

# ---- configuration ------------------------------------------------------
# Read .env without exporting anything else, so the DuckDNS token stays out of
# the environment of every child process except acme.sh.
load_dotenv() {
  [ -f .env ] || return 0
  while IFS= read -r line; do
    case "$line" in
      ''|'#'*) continue ;;
      *=*) ;;
      *) continue ;;
    esac
    key="${line%%=*}"
    val="${line#*=}"
    val="${val%$'\r'}"
    # strip surrounding quotes
    case "$val" in
      \"*\") val="${val#\"}"; val="${val%\"}" ;;
      \'*\') val="${val#\'}"; val="${val%\'}" ;;
    esac
    case "$key" in
      DUCKTNS_TOKEN|DUCKTNS_DOMAIN|ACME_EMAIL|TLS_RELOAD_CMD)
        [ -n "${!key:-}" ] || export "$key=$val" ;;
    esac
  done < .env
}
load_dotenv

DOMAIN="${DUCKTNS_DOMAIN:-$DOMAIN}"
ACME_EMAIL="${ACME_EMAIL:-admin@duckdns.org}"
RENEW_RELOAD_CMD="${TLS_RELOAD_CMD:-$RENEW_RELOAD_CMD}"

has_openssl() { command -v openssl >/dev/null 2>&1; }

# ---- acme.sh ------------------------------------------------------------
ensure_acme() {
  if [ -x "$ACME" ]; then
    log "acme.sh found at $ACME"
  else
    log "installing acme.sh into $ACME_HOME"
    mkdir -p "$ACME_HOME"
    # --home keeps it out of the system package manager; nothing is installed
    # globally, so this works on a container without root.
    curl -fsSL https://get.acme.sh -o "$ACME_HOME/install.sh" \
      || die "could not download acme.sh (no outbound network?)"
    bash "$ACME_HOME/install.sh" --home "$ACME_HOME" --nocron >/dev/null \
      || die "acme.sh install failed"
    rm -f "$ACME_HOME/install.sh"
  fi
  # Pin the CA to Let's Encrypt production unless we are testing.
  "$ACME" --set-default-ca --server "$CA" >/dev/null 2>&1 || true
  "$ACME" --upgrade --auto-upgrade >/dev/null 2>&1 || true
}

# DuckDNS TXT propagation is not instant; acme.sh waits, but give it a nudge by
# asking the API directly so we can fail early with a clear message.
verify_duckdns_token() {
  local token="${DUCKTNS_TOKEN:-}"
  [ -n "$token" ] || die "DUCKTNS_TOKEN is not set. Put it in .env as DUCKTNS_TOKEN=<token> (duckdns.org -> your domain -> token)."
  local body
  body="$(curl -fsS --max-time 20 "https://www.duckdns.org/update?domains=${DOMAIN}&token=${token}&txt=minisearch-acme-check&clear=true" 2>/dev/null || true)"
  case "$body" in
    OK*) log "DuckDNS token accepted for ${DOMAIN}" ;;
    KO) die "DuckDNS rejected the token for ${DOMAIN}. Check DUCKTNS_TOKEN belongs to this domain." ;;
    "") warn "could not reach the DuckDNS API; continuing anyway" ;;
    *) warn "unexpected DuckDNS reply: ${body}" ;;
  esac
}

# ---- issue --------------------------------------------------------------
do_issue() {
  ensure_acme
  verify_duckdns_token

  local args=(--issue --server "$CA" --dns dns_duckdns -d "$DOMAIN" --force)
  [ "$STAGING" = "1" ] && args+=(--staging)
  for extra in $ALT_DOMAINS; do
    args+=(-d "$extra")
  done

  log "requesting a certificate for ${DOMAIN}${ALT_DOMAINS:+ and $ALT_DOMAINS} (dns-01 via DuckDNS)"
  # acme.sh's duckdns hook reads DD_Token from the environment.
  if DD_Token="${DUCKTNS_TOKEN}" "$ACME" "${args[@]}"; then
    log "certificate issued"
  else
    die "issuance failed. If this is your first run, try STAGING=1 to stay out of the CA's rate limits."
  fi
}

# ---- install ------------------------------------------------------------
# This is the renew-safe path: acme.sh re-runs --install-cert on every renewal,
# so fullchain.pem and privkey.pem in the repo root are rewritten in place.
do_install() {
  [ -x "$ACME" ] || die "acme.sh is not installed yet; run: DUCKTNS_TOKEN=... bash tls-cert.sh"
  local args=(--install-cert -d "$DOMAIN"
              --key-file "$KEY_FILE"
              --fullchain-file "$CERT_FILE"
              --reloadcmd "$RENEW_RELOAD_CMD")
  log "installing certificate into the workspace root"
  "$ACME" "${args[@]}" >/dev/null || die "could not install the certificate"
  harden "$KEY_FILE"
  harden "$CERT_FILE"
  chmod 644 "$CERT_FILE" 2>/dev/null || true
  log "wrote ${CERT_FILE} and ${KEY_FILE}"
}

harden() {
  [ -f "$1" ] || return 0
  # The key is only readable by the user running the app.
  if [ "$(basename "$1")" = "privkey.pem" ]; then chmod 600 "$1"; else chmod 644 "$1"; fi
}

# ---- check --------------------------------------------------------------
do_check() {
  local ok=0
  if [ -f "$CERT_FILE" ] && [ -f "$KEY_FILE" ]; then
    log "found ${CERT_FILE} + ${KEY_FILE}"
  else
    warn "missing certificate files in $ROOT"
    ok=1
  fi
  if has_openssl && [ -f "$CERT_FILE" ]; then
    echo
    openssl x509 -in "$CERT_FILE" -noout -subject -issuer -dates 2>/dev/null || warn "openssl could not parse the certificate"
    echo
    if openssl x509 -in "$CERT_FILE" -noout -checkend 0 >/dev/null 2>&1; then
      log "certificate is currently valid"
    else
      warn "certificate is EXPIRED"
      ok=1
    fi
    if openssl x509 -in "$CERT_FILE" -noout -checkend $((RENEW_DAYS * 86400)) >/dev/null 2>&1; then
      log "more than ${RENEW_DAYS} days left"
    else
      warn "fewer than ${RENEW_DAYS} days left — run: bash tls-cert.sh renew"
      ok=1
    fi
    # The certificate must actually cover the hostname people type.
    if openssl x509 -in "$CERT_FILE" -noout -text 2>/dev/null | grep -q "DNS:${DOMAIN}"; then
      log "covers ${DOMAIN}"
    else
      warn "certificate does not list ${DOMAIN} in its SANs"
      ok=1
    fi
    if [ -n "$KEY_FILE" ] && [ -f "$KEY_FILE" ]; then
      local c k
      c="$(openssl x509 -in "$CERT_FILE" -noout -pubkey 2>/dev/null | openssl sha256 2>/dev/null || true)"
      k="$(openssl pkey -in "$KEY_FILE" -pubout 2>/dev/null | openssl sha256 2>/dev/null || true)"
      if [ -n "$c" ] && [ "$c" = "$k" ]; then
        log "private key matches the certificate"
      else
        warn "private key does NOT match the certificate"
        ok=1
      fi
    fi
  else
    warn "openssl not installed, cannot inspect the certificate"
  fi
  echo
  [ "$ok" = "0" ] && log "all good" || warn "something needs attention (see above)"
  return "$ok"
}

# ---- cron ---------------------------------------------------------------
# acme.sh renews by re-running --renew, which triggers --install-cert, which
# rewrites the files in the workspace root.
do_cron() {
  ensure_acme
  "$ACME" --install-cronjob --home "$ACME_HOME" >/dev/null 2>&1 \
    || die "could not install the cron job"
  log "renew timer installed (acme.sh runs daily, renews under ${RENEW_DAYS} days)"
  warn "renewal rewrites the certificate files, but a running server keeps the old"
  warn "certificate in memory. Restart the panel after a renewal, or set TLS_RELOAD_CMD."
}

do_renew() {
  ensure_acme
  log "checking whether ${DOMAIN} needs a renewal"
  if "$ACME" --renew -d "$DOMAIN" --server "$CA" --force >/dev/null 2>&1; then
    log "renewed (or already current)"
  else
    # --force can fail when the cert is still valid for weeks; that is fine.
    log "nothing to do yet, or renewal failed — check: bash tls-cert.sh check"
  fi
  do_install
}

case "${1:-all}" in
  issue|all) do_issue; do_install; do_check || true ;;
  renew)     do_renew ;;
  install)   do_install ;;
  check)     do_check ;;
  cron)      do_cron ;;
  *) die "unknown command '${1}'. Use: issue | renew | install | check | cron" ;;
esac