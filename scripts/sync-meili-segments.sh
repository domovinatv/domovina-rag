#!/usr/bin/env bash
# scripts/sync-meili-segments.sh — inkrementalno osvježi Meili index `segments`
# (1 dok = 1 SRT segment, točna sekunda + ime govornika) iz producerovih
# `*.segments.jsonl`. Lokalno ILI prema cloud Meiliju (preko SSH tunela).
#
# Za razliku od sync-meili.sh (`episodes`, ~3k dok, pun re-index) ovdje je
# ~1,4 M dokumenata, pa indexer radi DELTU po epizodi (SHA-256 datoteke, stanje u
# indexu `segments_state`). Prvo punjenje cloud indexa traje nekoliko minuta;
# svaka sljedeća noć samo nove/promijenjene epizode.
#
# Izvor podataka je LOKALNI disk producera (kao ETL), korpus-filter je LOKALNI CH
# (već sinkan s cloudom u koraku 4 sync-cron.sh). Razlikujemo samo KAMO pišemo.
#
# Usage:
#   ./scripts/sync-meili-segments.sh            # lokalni Meili (localhost:7700)
#   ./scripts/sync-meili-segments.sh --cloud    # cloud Meili preko SSH tunela
#
# shellcheck source=scripts/lib/cron-path.sh
. "$(dirname "$0")/lib/cron-path.sh"

set -euo pipefail
cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

PY="services/embedder/.venv/bin/python"
[ -x "$PY" ] || PY="python3"

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"
LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
# Isti diskovi kao sync-incremental.sh (producer raspršuje kanale po dva diska).
SEGMENTS_SOURCE_DIRS="${SEGMENTS_SOURCE_DIRS:-${DATA_SOURCE_DIRS:-/Volumes/DOMOVINA1TB/fetch_domovina_tv_output /Volumes/DOMOVINA2TB/fetch_domovina_tv_output}}"
# 17701, ne 17700: sync-meili.sh drži svoj tunel na 17700.
TUNNEL_PORT=17701

TARGET="local"
[ "${1:-}" = "--cloud" ] && TARGET="cloud"

log() { echo "[segments-sync $(date +%H:%M:%S)] $*"; }

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

run_indexer() {
  MEILI_URL="$1" MEILI_KEY="$2" \
  SEGMENTS_SOURCE_DIRS="$SEGMENTS_SOURCE_DIRS" \
  CH_CONTAINER="$LOCAL_CH_CONTAINER" \
  CLICKHOUSE_DB="${CLICKHOUSE_DB:-rag}" \
  CLICKHOUSE_USER="${CLICKHOUSE_USER:-rag_user}" \
  CLICKHOUSE_PASSWORD="$CLICKHOUSE_PASSWORD" \
    "$PY" scripts/meili-segments-index.py
}

if [ "$TARGET" = "local" ]; then
  : "${MEILI_MASTER_KEY:?MEILI_MASTER_KEY nije set u .env}"
  LOCAL_MEILI_URL="${MEILI_URL:-http://localhost:7700}"
  if ! curl -s -m 5 "$LOCAL_MEILI_URL/health" | grep -q available; then
    echo "ERROR: lokalni Meili ne odgovara na $LOCAL_MEILI_URL. Pokreni: docker compose up -d meilisearch" >&2
    exit 1
  fi
  log "Lokalni Meili: $LOCAL_MEILI_URL"
  run_indexer "$LOCAL_MEILI_URL" "$MEILI_MASTER_KEY"
else
  [ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }
  CLOUD_MEILI=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=meili --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_MEILI" ] || { echo "ERROR: cloud Meili container nije pronađen." >&2; exit 1; }
  CLOUD_KEY=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_MEILI printenv MEILI_MASTER_KEY")
  [ -n "$CLOUD_KEY" ] || { echo "ERROR: ne mogu pročitati cloud MEILI_MASTER_KEY." >&2; exit 1; }
  CIP=$(ssh $SSH_OPTS "$SSH_HOST" \
    "docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}' $CLOUD_MEILI" | awk '{print $1}')
  [ -n "$CIP" ] || { echo "ERROR: ne mogu dobiti cloud Meili IP." >&2; exit 1; }
  log "Cloud Meili: $CLOUD_MEILI (tunel localhost:$TUNNEL_PORT → $CIP:7700)"
  ssh $SSH_OPTS -f -N -L "$TUNNEL_PORT:$CIP:7700" "$SSH_HOST"
  TUNNEL_PID=$(pgrep -f "$TUNNEL_PORT:$CIP:7700" | head -1)
  trap '[ -n "${TUNNEL_PID:-}" ] && kill "$TUNNEL_PID" 2>/dev/null || true' EXIT
  sleep 2
  run_indexer "http://localhost:$TUNNEL_PORT" "$CLOUD_KEY"
fi
