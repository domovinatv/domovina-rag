#!/usr/bin/env bash
# scripts/meili-provision-keys.sh — idempotentno provisionira Meili API ključeve.
#
# Meili izvodi `key` string DETERMINISTIČKI kao HMAC-SHA256(master_key, uid).
# Zato: isti master_key + isti uid → IDENTIČAN search-key string na svakoj
# instanci (lokalno I cloud). To znači da frontend može hardkodirati search-key
# kao siguran default — radi protiv bilo kojeg Meilija s istim master keyem.
#
# Skripta:
#   1. provjeri da master key radi (GET /keys)
#   2. registrira (ili potvrdi) search-only ključ s FIKSNIM uid-om
#      (actions:[search], indexes:[episodes]) — read-only, siguran za browser
#   3. ispiše MEILI_SEARCH_KEY string (za frontend dart-define / domovina-api)
#
# Usage:
#   MEILI_URL=http://localhost:7700 MEILI_MASTER_KEY=... MEILI_SEARCH_UID=... \
#     ./scripts/meili-provision-keys.sh
#   ./scripts/meili-provision-keys.sh --cloud      # preko SSH tunela na cloud Meili
#
# launchd daje minimalan PATH (/usr/bin:/bin:/usr/sbin:/sbin) — docker, node/npx,
# gcloud i ostali alati nisu vidljivi. Razrješava ih zajednički lib.
# shellcheck source=scripts/lib/cron-path.sh
. "$(dirname "$0")/lib/cron-path.sh"
set -euo pipefail
cd "$(dirname "$0")/.."
# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
INDEX="${MEILI_INDEX:-episodes}"

: "${MEILI_SEARCH_UID:?MEILI_SEARCH_UID nije set (fiksni uuid za deterministički search-key). Generiraj: uuidgen | tr A-Z a-z}"

TUNNEL_PID=""
cleanup() { [ -n "$TUNNEL_PID" ] && kill "$TUNNEL_PID" 2>/dev/null || true; }
trap cleanup EXIT

if [ "${1:-}" = "--cloud" ]; then
  CLOUD_MEILI=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=meili --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_MEILI" ] || { echo "ERROR: cloud Meili container nije pronađen (redeployaj compose prvo)." >&2; exit 1; }
  MASTER=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_MEILI printenv MEILI_MASTER_KEY")
  CIP=$(ssh $SSH_OPTS "$SSH_HOST" "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $CLOUD_MEILI" | awk '{print $1}')
  ssh $SSH_OPTS -f -N -L "17700:$CIP:7700" "$SSH_HOST"
  TUNNEL_PID=$(pgrep -f "17700:$CIP:7700" | head -1)
  sleep 2
  URL="http://localhost:17700"
  echo "[provision] Cloud Meili: $CLOUD_MEILI (tunel localhost:17700)"
else
  URL="${MEILI_URL:-http://localhost:7700}"
  MASTER="${MEILI_MASTER_KEY:?MEILI_MASTER_KEY nije set}"
  echo "[provision] Lokalni Meili: $URL"
fi

auth=(-H "Authorization: Bearer $MASTER" -H "Content-Type: application/json")

# 1. Sanity: master key radi
code=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$URL/keys")
[ "$code" = "200" ] || { echo "ERROR: master key ne radi na $URL (HTTP $code)." >&2; exit 1; }

# 2. Registriraj search-only key s fiksnim uid-om (idempotentno).
#    Postojanje: GET /keys/{uid} → 200 znači već postoji.
exists=$(curl -s -o /dev/null -w '%{http_code}' "${auth[@]}" "$URL/keys/$MEILI_SEARCH_UID")
if [ "$exists" = "200" ]; then
  echo "[provision] Search-key ($MEILI_SEARCH_UID) već postoji."
else
  echo "[provision] Kreiram search-only key ($MEILI_SEARCH_UID)..."
  curl -s "${auth[@]}" -X POST "$URL/keys" --data "$(cat <<JSON
{
  "uid": "$MEILI_SEARCH_UID",
  "name": "frontend-search",
  "description": "domovina.ai web keyword search (read-only)",
  "actions": ["search"],
  "indexes": ["$INDEX"],
  "expiresAt": null
}
JSON
)" >/dev/null
fi

# 3. Dohvati i ispiši search-key string
SEARCH_KEY=$(curl -s "${auth[@]}" "$URL/keys/$MEILI_SEARCH_UID" | jq -r '.key')
[ -n "$SEARCH_KEY" ] && [ "$SEARCH_KEY" != "null" ] || { echo "ERROR: ne mogu dohvatiti search-key." >&2; exit 1; }

echo ""
echo "════════════════════════════════════════════════════════════"
echo "MEILI_SEARCH_KEY=$SEARCH_KEY"
echo "════════════════════════════════════════════════════════════"
echo "(read-only; actions:[search], indexes:[$INDEX]; siguran za frontend bundle)"
