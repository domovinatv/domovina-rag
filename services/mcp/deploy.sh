#!/usr/bin/env bash
# services/mcp/deploy.sh — okini Coolify redeploy MCP servera i verificiraj da je živ.
#
# ZAŠTO: MCP je Coolify Application BEZ push-webhooka (vidi CLAUDE.md) — `git push`
# NE deploya. Redeploy se inače klika u Coolify UI; ova skripta to radi preko
# Coolify REST API-ja (isti token/URL koji koristi domovina-api/scripts/coolify-*).
#
# Usage:
#   ./services/mcp/deploy.sh              # commitni sam, pa okini deploy
#   ./services/mcp/deploy.sh --no-verify  # ne čekaj da /health odgovori
#
# Secrets (traži se prvi koji postoji):
#   1. env varijable COOLIFY_API_URL + COOLIFY_API_TOKEN
#   2. $COOLIFY_SECRETS_FILE (ako je postavljen)
#   3. ~/git/domovinatv/domovina-api/.local-secrets.env  (default — token već tamo živi)

set -euo pipefail

# --- MCP Coolify Application UUID (mcp.domovina.ai / mcp.domovina.link) ---
APP_UUID="amu4q428khkefqhu5zd6cq88"
BASE_URL="https://mcp.domovina.ai"
VERIFY_PATH="/health"
VERIFY=1

for arg in "$@"; do
  case "$arg" in
    --no-verify) VERIFY=0 ;;
    *) echo "Nepoznat argument: $arg" >&2; exit 2 ;;
  esac
done

# --- Učitaj Coolify credencijale ---
if [ -z "${COOLIFY_API_URL:-}" ] || [ -z "${COOLIFY_API_TOKEN:-}" ]; then
  SECRETS_FILE="${COOLIFY_SECRETS_FILE:-$HOME/git/domovinatv/domovina-api/.local-secrets.env}"
  if [ -f "$SECRETS_FILE" ]; then
    set -a; . "$SECRETS_FILE"; set +a
  fi
fi
: "${COOLIFY_API_URL:?Treba COOLIFY_API_URL (env ili .local-secrets.env)}"
: "${COOLIFY_API_TOKEN:?Treba COOLIFY_API_TOKEN (env ili .local-secrets.env)}"
API_BASE="${COOLIFY_API_URL%/}/api/v1"

echo "→ MCP deploy: $BASE_URL (app $APP_UUID)"

# --- Okini deploy ---
RESP=$(curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
  "$API_BASE/deploy?uuid=$APP_UUID")
DEPLOY_UUID=$(echo "$RESP" | jq -r '.deployments[0].deployment_uuid // empty' 2>/dev/null || true)

if [ -z "$DEPLOY_UUID" ]; then
  echo "❌ Deploy nije queuean. Odgovor:" >&2
  echo "$RESP" >&2
  exit 1
fi
echo "✅ Queuean (deployment $DEPLOY_UUID)"

if [ "$VERIFY" = "0" ]; then
  echo "→ Preskačem verifikaciju (--no-verify). Prati u Coolify UI."
  exit 0
fi

# --- Čekaj da novi kontejner odgovori na /health ---
echo "→ Čekam da $VERIFY_PATH odgovori 200…"
for i in $(seq 1 40); do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" "$BASE_URL$VERIFY_PATH" || true)
  if [ "$CODE" = "200" ]; then
    echo "✅ Živo nakon ~$((i * 10)) s."
    curl -s "$BASE_URL$VERIFY_PATH" | jq . 2>/dev/null || true
    exit 0
  fi
  sleep 10
done

echo "⚠️  $VERIFY_PATH nije vratio 200 u ~400 s. Provjeri Coolify build log." >&2
exit 1
