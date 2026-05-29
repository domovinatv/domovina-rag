#!/usr/bin/env bash
# scripts/sync-cron.sh — wrapper za scheduled (launchd) inkrementalni sync.
#
# Osigura preduvjete pa pozove sync-incremental.sh:
#   1. caffeinate (Mac ne smije zaspati usred ingest-a)
#   2. host MPS embedder gore (ETL ga treba za embed novih chunkova)
#   3. lokalni CH + PG up
#   4. sync-incremental.sh (ETL oba diska → delta push na cloud)
#
# Logovi → .ingest-logs/sync-cron-YYYYMMDD.log
#
# Pozadina: ovaj wrapper je namjerno u domovina-rag repu, NE u producerovom
# run_pipeline.sh — separation of concerns. Producer samo generira JSONL; ovaj
# repo ga konzumira (vidi CLAUDE.md). Trigger je vremenski (launchd), ne
# producer-side hook.
set -uo pipefail

cd "$(dirname "$0")/.."
REPO="$(pwd)"

mkdir -p .ingest-logs
LOG=".ingest-logs/sync-cron-$(date +%Y%m%d).log"
exec >>"$LOG" 2>&1

echo "════════════════════════════════════════════════════════════"
echo "[cron $(date '+%Y-%m-%d %H:%M:%S')] sync-cron start"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

# ─── 1. Caffeinate (drži Mac budan dok wrapper živi) ──────────────────────────
caffeinate -i -w $$ &

# ─── 2. Embedder up? ──────────────────────────────────────────────────────────
if ! curl -s -m 5 http://localhost:8000/health 2>/dev/null | grep -q '"loaded":true'; then
  echo "[cron] Embedder nije gore — pokrećem MPS host embedder..."
  pkill -9 -f "uvicorn app.main" 2>/dev/null || true
  sleep 1
  ( cd services/embedder && \
    EMBEDDER_DEVICE=mps EMBEDDER_MAX_TEXT_LEN=32768 \
    nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 \
    >"$REPO/.ingest-logs/embedder-host.log" 2>&1 & )
  # Čekaj model load (do 90s)
  for _ in $(seq 1 30); do
    sleep 3
    curl -s -m 5 http://localhost:8000/health 2>/dev/null | grep -q '"loaded":true' && break
  done
fi
if curl -s -m 5 http://localhost:8000/health 2>/dev/null | grep -q '"loaded":true'; then
  echo "[cron] Embedder OK."
else
  echo "[cron] ERROR: embedder se nije podigao — prekidam (ETL bi failao na embed)."
  exit 1
fi

# ─── 3. Lokalni CH + PG up? ───────────────────────────────────────────────────
if ! docker ps --filter name=clickhouse --format '{{.Names}}' | grep -qi domovina; then
  echo "[cron] Lokalni stack nije up — pokrećem postgres + clickhouse..."
  docker compose up -d postgres clickhouse
  sleep 10
fi

# ─── 4. Sync ──────────────────────────────────────────────────────────────────
echo "[cron] Pokrećem sync-incremental.sh..."
./scripts/sync-incremental.sh
RC=$?
echo "[cron $(date '+%Y-%m-%d %H:%M:%S')] sync-cron gotov (rc=$RC)"
exit $RC
