#!/usr/bin/env bash
# scripts/sync-meili.sh — (re)indeksiraj Meilisearch `episodes` index iz lokalnog
# ClickHouse-a. Radi lokalno ILI prema cloud Meiliju (preko SSH tunela).
#
# Meili index je DERIVAT ClickHouse-a (article_summary chunkovi + PG title-ovi),
# pa je re-index jeftin i idempotentan (~2562 dok = sekunde). Nema delta logike —
# puni re-index svaki put je jednostavniji i dovoljno brz. Pokreće
# scripts/meili-poc-index.py s odgovarajućim env varijablama.
#
# launchd daje minimalan PATH — prepend Homebrew/usr-local.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

PY="services/embedder/.venv/bin/python"
[ -x "$PY" ] || { echo "ERROR: python venv ne postoji ($PY). Vidi project-mps-embedder-host." >&2; exit 1; }

# ─── Konfiguracija ────────────────────────────────────────────────────────────
SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-$(docker ps --filter name=postgres --format '{{.Names}}' | grep -i domovina | head -1)}"

TARGET="local"
[ "${1:-}" = "--cloud" ] && TARGET="cloud"

log() { echo "[meili-sync $(date +%H:%M:%S)] $*"; }

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

# Indexer uvijek čita iz LOKALNOG CH/PG (već sinkan s cloudom preko
# sync-incremental.sh). Razlikujemo samo KAMO pišemo Meili dokumente.
run_indexer() {
  local meili_url="$1" meili_key="$2"
  CH_CONTAINER="$LOCAL_CH_CONTAINER" \
  PG_CONTAINER="$LOCAL_PG_CONTAINER" \
  CLICKHOUSE_DB="${CLICKHOUSE_DB:-rag}" \
  CLICKHOUSE_USER="${CLICKHOUSE_USER:-rag_user}" \
  CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
  POSTGRES_USER="${POSTGRES_USER:-rag_user}" \
  POSTGRES_DB="${POSTGRES_DB:-rag}" \
  MEILI_URL="$meili_url" \
  MEILI_KEY="$meili_key" \
  MEILI_INDEX="${MEILI_INDEX:-episodes}" \
    "$PY" scripts/meili-poc-index.py
}

if [ "$TARGET" = "local" ]; then
  : "${MEILI_MASTER_KEY:?MEILI_MASTER_KEY nije set u .env}"
  LOCAL_MEILI_URL="${MEILI_URL:-http://localhost:7700}"
  log "Re-indeksiram LOKALNI Meili: $LOCAL_MEILI_URL"
  if ! curl -s -m 5 "$LOCAL_MEILI_URL/health" | grep -q available; then
    echo "ERROR: lokalni Meili ne odgovara na $LOCAL_MEILI_URL. Pokreni: docker compose up -d meilisearch" >&2
    exit 1
  fi
  run_indexer "$LOCAL_MEILI_URL" "$MEILI_MASTER_KEY"
  log "✅ Lokalni Meili re-indeksiran."

else
  # ─── Cloud: SSH tunel na cloud Meili (interni port 7700 nije javan) ──────────
  [ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }
  log "Discovering cloud Meili container + master key preko SSH-a..."
  CLOUD_MEILI_CONTAINER=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=meili --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_MEILI_CONTAINER" ] || { echo "ERROR: cloud Meili container nije pronađen (je li deployan?)." >&2; exit 1; }
  CLOUD_MEILI_KEY=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_MEILI_CONTAINER printenv MEILI_MASTER_KEY")
  [ -n "$CLOUD_MEILI_KEY" ] || { echo "ERROR: ne mogu pročitati cloud MEILI_MASTER_KEY." >&2; exit 1; }
  log "Cloud Meili: $CLOUD_MEILI_CONTAINER"

  # Otvori SSH lokalni-forward tunel na cloud Meili (7700 → localhost:17700).
  # Cloud Meili sluša na coolify mreži; preko VPS-a ga dohvaćamo na 127.0.0.1.
  CLOUD_MEILI_HOSTPORT=$(ssh $SSH_OPTS "$SSH_HOST" \
    "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $CLOUD_MEILI_CONTAINER" | awk '{print $1}')
  [ -n "$CLOUD_MEILI_HOSTPORT" ] || { echo "ERROR: ne mogu dobiti cloud Meili IP." >&2; exit 1; }
  log "Tunel: localhost:17700 → $CLOUD_MEILI_HOSTPORT:7700 (preko $SSH_HOST)"
  ssh $SSH_OPTS -f -N -L "17700:$CLOUD_MEILI_HOSTPORT:7700" "$SSH_HOST"
  TUNNEL_PID=$(pgrep -f "17700:$CLOUD_MEILI_HOSTPORT:7700" | head -1)
  trap '[ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true' EXIT
  sleep 2

  run_indexer "http://localhost:17700" "$CLOUD_MEILI_KEY"
  log "✅ Cloud Meili re-indeksiran."
fi
