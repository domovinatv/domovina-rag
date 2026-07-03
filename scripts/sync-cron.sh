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

# launchd daje minimalan PATH (/usr/bin:/bin:/usr/sbin:/sbin) — docker, zstd i
# ostali alati nisu vidljivi. Prepend Homebrew + /usr/local/bin.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

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
  # MAX_TEXT_LEN=8192 (ne 32768): attention je O(n²) po duljini; predugi chunkovi
  # su rušili MPS HeapAllocator (SIGSEGV u scaled_dot_product_attention) jer je na
  # M4 Pro 24 GB unified dijeljen s Dockerom (14 GB). 8192 drži GPU buffer malim.
  ( cd services/embedder && \
    EMBEDDER_DEVICE=mps EMBEDDER_MAX_TEXT_LEN=8192 \
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

# ─── 4. Sync ClickHouse (semantička baza) ─────────────────────────────────────
echo "[cron] Pokrećem sync-incremental.sh (ClickHouse delta)..."
./scripts/sync-incremental.sh
RC=$?

# ─── 5. Re-index Meili (keyword tražilica) ────────────────────────────────────
# Meili index je derivat CH-a — kad CH dobije nove epizode, Meili treba refresh.
# Puni re-index je jeftin (~sekunde za 2500 dok). Lokalni uvijek; cloud ako je
# Meili gore (preskoči tiho ako nije deployan). Ne ruši cijeli cron na grešku.
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-indeksiram Meili (lokalni)..."
  ./scripts/sync-meili.sh || echo "[cron] WARN: lokalni Meili re-index pao (nastavljam)."
  echo "[cron] Re-indeksiram Meili (cloud)..."
  ./scripts/sync-meili.sh --cloud || echo "[cron] WARN: cloud Meili re-index pao/nije deployan (nastavljam)."
fi

# ─── 6. Re-populate "person hub" (PG speakers) ────────────────────────────────
# speakers je derivat CH-a (distinct govornici → slug + aliases). Kad CH dobije
# nove epizode/govornike, tablica treba refresh inače /api/person/{slug} vraća
# stare/nedostajuće profile. Idempotentno (UPSERT+prune), jeftino (~10s).
# VAŽNO: svaka nova CH-derivat tablica (Meili, speakers, …) MORA dobiti svoj
# korak ovdje — vidi docs/data-refresh-flow.md § "Nova derivat-tablica".
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-populiram person hub (lokalni PG)..."
  ./scripts/sync-speakers.sh || echo "[cron] WARN: lokalni speakers populate pao (nastavljam)."
  echo "[cron] Re-populiram person hub (cloud PG)..."
  ./scripts/sync-speakers.sh --cloud || echo "[cron] WARN: cloud speakers populate pao/nije deployan (nastavljam)."
fi

# ─── 6b. Re-populate person_mentions ("Spominje se u" sekcija person huba) ─────
# person_mentions je derivat CH `episode_mentions` (koji ETL puni iz producerovog
# summary.mentioned_people). Kad novi ingest doda spomene, tablica treba refresh
# inače /api/person/{slug} ne prikaže sekciju "Spominje se u". Izvor je UVIJEK
# lokalni CH (summary.json postoji samo lokalno), pa i --cloud čita lokalni CH.
# VAŽNO: novi CH-derivat → svoj korak ovdje (docs/data-refresh-flow.md).
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-populiram person_mentions (lokalni PG)..."
  ./scripts/sync-person-mentions.sh || echo "[cron] WARN: lokalni person_mentions populate pao (nastavljam)."
  echo "[cron] Re-populiram person_mentions (cloud PG)..."
  ./scripts/sync-person-mentions.sh --cloud || echo "[cron] WARN: cloud person_mentions populate pao/nije deployan (nastavljam)."
fi

# ─── 7. Osvježi javni stats dashboard (derivat CH-a) ──────────────────────────
# stats.json je derivat CH-a (agregati nad rag_chunks) kao Meili i speakers. Puni
# ga sync-stats.sh i deploya na CF Pages (stats.domovina.ai). Consumer je zaseban
# repo domovina-stats. Bez ovog koraka javni dashboard tiho zaostaje.
# VAŽNO: isti razlog kao za Meili/speakers — svaki CH-derivat MORA imati korak
# ovdje (vidi docs/data-refresh-flow.md § "Nova derivat-tablica").
if [ "$RC" -eq 0 ]; then
  echo "[cron] Generiram + deployam stats dashboard (cloud)..."
  ./scripts/sync-stats.sh --cloud --deploy \
    || echo "[cron] WARN: stats sync/deploy pao/nije konfiguriran (nastavljam)."
fi

echo "[cron $(date '+%Y-%m-%d %H:%M:%S')] sync-cron gotov (rc=$RC)"
exit $RC
