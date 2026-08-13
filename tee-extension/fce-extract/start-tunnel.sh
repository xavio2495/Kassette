#!/usr/bin/env bash
# Starts Kassette's ngrok tunnel to the FCE-B extension proxy.
#
#   tee-extension/fce-extract/start-tunnel.sh          run in the foreground
#   tee-extension/fce-extract/start-tunnel.sh --check  verify config without connecting
#
# ⛔ Why this script exists rather than `ngrok config add-authtoken` + `ngrok http`.
#
# ~/.config/ngrok/ holds **Gestalt's** credentials (ngrok.yml, margin.yml) backing its
# two registered FCEs. `add-authtoken` rewrites the default config in place — it would
# swap Gestalt's credential for Kassette's, and nothing would fail until Gestalt next
# tried to bring a tunnel up.
#
# So: the token is read from the repo-root .env as NGROK_AUTHTOKEN_2 (the agent reads
# NGROK_AUTHTOKEN natively and it takes precedence over any config file, so this script
# exports it under that name), and --config always points at ngrok.yml here, which holds
# the tunnel definition and no credential. Nothing under ~/.config/ngrok is read or written.
#
# ⚠️ FCE-B is a SEPARATE ngrok account from FCE-A — the free plan gives one reserved
# domain each. NGROK_AUTHTOKEN is FCE-A's and NGROK_AUTHTOKEN_2 is FCE-B's; crossing them
# makes the reserved domain unavailable and the agent silently falls back to an ephemeral
# hostname, which is the one failure this file exists to prevent.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$SRC/../.." && pwd)"
CONFIG="$SRC/ngrok.yml"
TUNNEL=ext-proxy
DOMAIN=snuggle-humvee-polar.ngrok-free.dev
PORT=6694
TOKEN_VAR=NGROK_AUTHTOKEN_2

[ -f "$CONFIG" ] || { echo "error: $CONFIG not found" >&2; exit 1; }

# Only the tunnel token is taken from .env; the file also holds the deployer key, the
# model credential and indexer credentials, and this process has no business with those.
TOKEN="${NGROK_AUTHTOKEN_2:-}"
if [ -z "$TOKEN" ]; then
  [ -f "$ROOT/.env" ] || { echo "error: $ROOT/.env not found and $TOKEN_VAR unset" >&2; exit 1; }
  TOKEN="$(grep -E "^${TOKEN_VAR}=" "$ROOT/.env" | head -1 | cut -d= -f2- | tr -d '"'"'"' \r')"
fi
[ -n "$TOKEN" ] || { echo "error: $TOKEN_VAR is empty" >&2; exit 1; }
export NGROK_AUTHTOKEN="$TOKEN"

# The tunnel's target port and the URL registered on-chain have to agree with the
# scaffold, and they live in three files. Drift here fails as instructions that are
# accepted on-chain and never delivered, so check rather than trust.
SCAFFOLD_ENV="$ROOT/infra/fce-extension-scaffold-extract/.env"
if [ -f "$SCAFFOLD_ENV" ]; then
  want_bind="$(grep -E '^EXT_PROXY_EXTERNAL_BIND=' "$SCAFFOLD_ENV" | cut -d= -f2- | awk -F: '{print $NF}')"
  want_url="$(grep -E '^EXT_PROXY_URL=' "$SCAFFOLD_ENV" | cut -d= -f2-)"
  if [ -n "$want_bind" ] && [ "$want_bind" != "$PORT" ]; then
    echo "error: scaffold EXT_PROXY_EXTERNAL_BIND port is $want_bind, tunnel targets $PORT" >&2
    exit 1
  fi
  if [ -n "$want_url" ] && [ "$want_url" != "https://$DOMAIN" ]; then
    echo "error: scaffold EXT_PROXY_URL is $want_url, tunnel serves https://$DOMAIN" >&2
    echo "       the on-chain hostname must match the tunnel exactly" >&2
    exit 1
  fi
fi

if [ "${1:-}" = "--check" ]; then
  ngrok config check --config "$CONFIG"
  echo "start-tunnel: config valid, authtoken present, scaffold agrees"
  echo "  https://$DOMAIN -> localhost:$PORT  (agent API on localhost:4042)"
  exit 0
fi

echo "start-tunnel: https://$DOMAIN -> localhost:$PORT"
exec ngrok start --config "$CONFIG" "$TUNNEL"
