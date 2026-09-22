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

# launchd daje minimalan PATH (/usr/bin:/bin:/usr/sbin:/sbin) — docker, node/npx,
# gcloud i ostali alati nisu vidljivi. Razrješava ih zajednički lib.
# shellcheck source=scripts/lib/cron-path.sh
. "$(dirname "$0")/lib/cron-path.sh"

cd "$(dirname "$0")/.."
REPO="$(pwd)"

mkdir -p .ingest-logs
LOG=".ingest-logs/sync-cron-$(date +%Y%m%d).log"
exec >>"$LOG" 2>&1

echo "════════════════════════════════════════════════════════════"
echo "[cron $(date '+%Y-%m-%d %H:%M:%S')] sync-cron start"

# Koraci 5-7 su best-effort: pad jednog ne smije srušiti ostatak ciklusa, pa svaki
# završava s `|| warn "..."`. Ali WARN koji se samo ispiše usred 400 redaka loga je
# nevidljiv — `sync-stats.sh --deploy` je tako padao tri tjedna ("npx nije
# instaliran") dok je cron svaki dan uredno završavao s rc=0 i nitko nije imao
# razloga otvoriti log. Zato se WARN-ovi broje i PONAVLJAJU u zadnjem retku, koji
# je jedino što se realno gleda. Rc namjerno ostaje 0 — cilj je vidljivost, ne
# rušenje ciklusa zbog npr. ugašenog lokalnog Meilija.
# Bez nizova: launchd pokreće ovu skriptu preko /bin/bash (3.2), gdje je prazan
# `${#ARR[@]}` pod `set -u` unbound variable.
WARN_N=0
WARN_LIST=""
warn() {
  echo "[cron] WARN: $1"
  WARN_N=$((WARN_N + 1))
  WARN_LIST="${WARN_LIST}
[cron]    · $1"
}

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

# ─── 1b. Embedder: port i URL koji ETL stvarno zove ───────────────────────────
# Port 8000 na ovom Macu nije naš — drugi projekti (newsroom-be) bindaju
# 127.0.0.1:8000. macOS SO_REUSEADDR pusti naš embedder da svejedno bindne
# 0.0.0.0:8000, pa u logu uredno piše "Uvicorn running", ali `localhost:8000`
# ide squatteru (FastAPI 404) i health-check ispod padne. Zato vlastiti port.
EMBEDDER_PORT="${EMBEDDER_HOST_PORT:-8008}"
# ETL se vrti u KONTEJNERU i bez ovog override-a uzima compose default
# `http://embedder:8000` (servis iz `full` profila). Taj kontejner je ubijen
# 14.08.2026. i nikad se nije vratio: pet tjedana je svaka nova epizoda padala
# na ConnectError dok je health-check ispod javljao "Embedder OK" — jer mjeri
# HOST embedder, a ne onaj koji ETL zove. Dvije različite stvari; drži ih
# spojene ovdje, na jednom mjestu.
export EMBEDDER_URL="${EMBEDDER_URL:-http://host.docker.internal:$EMBEDDER_PORT}"

# ─── 1. Caffeinate (drži Mac budan dok wrapper živi) ──────────────────────────
caffeinate -i -w $$ &

# ─── 2. Embedder up? ──────────────────────────────────────────────────────────
echo "[cron] Embedder: host :$EMBEDDER_PORT, ETL ga zove na $EMBEDDER_URL"
if ! curl -s -m 5 "http://localhost:$EMBEDDER_PORT/health" 2>/dev/null | grep -q '"loaded":true'; then
  echo "[cron] Embedder nije gore — pokrećem MPS host embedder..."
  pkill -9 -f "uvicorn app.main" 2>/dev/null || true
  sleep 1
  # Limit je MEMORIJSKI BUDŽET, ne broj znakova. Attention drži tenzor
  # (batch, glave, n, n) u float32 → peak ≈ 244 × batch × n²; trošak je kvadratan
  # po duljini, a linearan po batchu, pa embedder sam slaže prolaze da ostane
  # ispod budžeta (app/model.py). Default 4,5 GB = izmjereni peak stare, dokazano
  # stabilne postavke. Vidi docs/mps-embedder-memory.md §6.
  ( cd services/embedder && \
    EMBEDDER_DEVICE=mps \
    nohup .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port "$EMBEDDER_PORT" \
    >"$REPO/.ingest-logs/embedder-host.log" 2>&1 & )
  # Čekaj model load (do 180s). bge-m3 na hladnom MPS-u zna preko 90 s.
  for _ in $(seq 1 60); do
    sleep 3
    curl -s -m 5 "http://localhost:$EMBEDDER_PORT/health" 2>/dev/null | grep -q '"loaded":true' && break
  done
fi
if curl -s -m 5 "http://localhost:$EMBEDDER_PORT/health" 2>/dev/null | grep -q '"loaded":true'; then
  echo "[cron] Embedder OK."
else
  echo "[cron] ERROR: embedder se nije podigao na :$EMBEDDER_PORT — prekidam (ETL bi failao na embed)."
  echo "[cron]        Provjeri zauzeće porta: lsof -nP -iTCP:$EMBEDDER_PORT -sTCP:LISTEN"
  echo "[cron]        i zadnjih 20 redaka: .ingest-logs/embedder-host.log"
  exit 1
fi

# Embedder odgovara na hostu — ali ETL ga zove IZ KONTEJNERA, drugom rutom.
# Ako EMBEDDER_URL pokazuje na compose servis `embedder`, taj kontejner mora
# biti gore; upravo je njegova smrt 14.08.2026. pet tjedana prolazila ispod
# radara jer je health-check gledao host embedder.
case "$EMBEDDER_URL" in
  *host.docker.internal*) : ;;  # host embedder — upravo provjeren iznad
  *)
    if ! docker ps --format '{{.Names}}' | grep -q embedder; then
      echo "[cron] WARN: EMBEDDER_URL=$EMBEDDER_URL pokazuje na compose servis,"
      echo "[cron]       a nijedan embedder kontejner nije gore. ETL će pasti na"
      echo "[cron]       ConnectError. Odkomentiraj EMBEDDER_URL=http://host.docker.internal:$EMBEDDER_PORT u .env."
    fi
    ;;
esac

# ─── 3. Lokalni CH + PG up? ───────────────────────────────────────────────────
if ! docker ps --filter name=clickhouse --format '{{.Names}}' | grep -qi domovina; then
  echo "[cron] Lokalni stack nije up — pokrećem postgres + clickhouse..."
  docker compose up -d postgres clickhouse
  sleep 10
fi

# ─── 4. Sync ClickHouse (semantička baza) ─────────────────────────────────────
echo "[cron] Pokrećem sync-incremental.sh (ClickHouse delta)..."
rm -f "$REPO/.ingest-logs/.etl-status"
./scripts/sync-incremental.sh
RC=$?

# ETL vrati rc=0 i kad NIJEDNA epizoda nije ušla — `Done: processed=0 … errors=111`
# pa `Delta: 0` pa "cloud je up-to-date". Točno tako je korpus od 14.08. do
# 22.09.2026. tiho stajao na 3157 epizoda dok je disk imao 3303. Status-fajl piše
# sync-incremental.sh; ovdje se samo pretvori u WARN koji se ponovi u zadnjem retku.
if [ -f "$REPO/.ingest-logs/.etl-status" ] && grep -q '^FAIL' "$REPO/.ingest-logs/.etl-status"; then
  warn "ETL: $(cat "$REPO/.ingest-logs/.etl-status") — nijedna nova epizoda nije ušla u korpus."
fi

# ─── 5. Re-index Meili (keyword tražilica) ────────────────────────────────────
# Meili index je derivat CH-a — kad CH dobije nove epizode, Meili treba refresh.
# Puni re-index je jeftin (~sekunde za 2500 dok). Lokalni uvijek; cloud ako je
# Meili gore (preskoči tiho ako nije deployan). Ne ruši cijeli cron na grešku.
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-indeksiram Meili (lokalni)..."
  ./scripts/sync-meili.sh || warn "lokalni Meili re-index pao (nastavljam)."
  echo "[cron] Re-indeksiram Meili (cloud)..."
  ./scripts/sync-meili.sh --cloud || warn "cloud Meili re-index pao/nije deployan (nastavljam)."
fi

# ─── 6. Re-populate "person hub" (PG speakers) ────────────────────────────────
# speakers je derivat CH-a (distinct govornici → slug + aliases). Kad CH dobije
# nove epizode/govornike, tablica treba refresh inače /api/person/{slug} vraća
# stare/nedostajuće profile. Idempotentno (UPSERT+prune), jeftino (~10s).
# VAŽNO: svaka nova CH-derivat tablica (Meili, speakers, …) MORA dobiti svoj
# korak ovdje — vidi docs/data-refresh-flow.md § "Nova derivat-tablica".
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-populiram person hub (lokalni PG)..."
  ./scripts/sync-speakers.sh || warn "lokalni speakers populate pao (nastavljam)."
  echo "[cron] Re-populiram person hub (cloud PG)..."
  ./scripts/sync-speakers.sh --cloud || warn "cloud speakers populate pao/nije deployan (nastavljam)."
fi

# ─── 6b. Re-populate person_mentions ("Spominje se u" sekcija person huba) ─────
# person_mentions je derivat CH `episode_mentions` (koji ETL puni iz producerovog
# summary.mentioned_people). Kad novi ingest doda spomene, tablica treba refresh
# inače /api/person/{slug} ne prikaže sekciju "Spominje se u". Izvor je UVIJEK
# lokalni CH (summary.json postoji samo lokalno), pa i --cloud čita lokalni CH.
# VAŽNO: novi CH-derivat → svoj korak ovdje (docs/data-refresh-flow.md).
if [ "$RC" -eq 0 ]; then
  echo "[cron] Re-populiram person_mentions (lokalni PG)..."
  ./scripts/sync-person-mentions.sh || warn "lokalni person_mentions populate pao (nastavljam)."
  echo "[cron] Re-populiram person_mentions (cloud PG)..."
  ./scripts/sync-person-mentions.sh --cloud || warn "cloud person_mentions populate pao/nije deployan (nastavljam)."
fi

# ─── 7a. Regeneriraj vektorsku mapu (UMAP nad chunk embeddinzima) ─────────────
# vector-map.{bin,json} je CH-derivat kao stats.json (Razina 2 dashboarda,
# stats.domovina.ai/map). Izvor je LOKALNI CH (izvoz embeddinga ~560 MB — preko
# SSH-a bi bio besmislen; lokalni == cloud jer smo deltu upravo pushali u koraku
# 4). Skripta sama PRESKAČE UMAP ako broj chunkova nije promijenjen. Mora ići
# PRIJE koraka 7: sync-stats.sh --deploy nosi i mapu u istom wrangler deployu.
if [ "$RC" -eq 0 ]; then
  echo "[cron] Regeneriram vektorsku mapu (lokalni CH → domovina-stats/public)..."
  ./scripts/sync-vector-map.sh || warn "vector map regeneracija pala (nastavljam)."
fi

# ─── 7b. Regeneriraj mapu osoba (UMAP nad embeddinzima osoba) ─────────────────
# person-map.json je derivat CH-a (centroidi) I person huba (tko je uopće osoba),
# pa MORA ići iza koraka 6 i 6b — inače crta jučerašnji hub. Izvor je lokalni CH
# + lokalni PG; centroide računa sam ClickHouse (avgForEach), pa je cijeli run
# ~30-50 s naspram 5-10 min za mapu isječaka. Skripta sama PRESKAČE ako se broj
# chunkova + spomena nije promijenio. Kao 7a, mora PRIJE koraka 7 (isti deploy).
if [ "$RC" -eq 0 ]; then
  echo "[cron] Regeneriram mapu osoba (lokalni CH+PG → domovina-stats/public)..."
  ./scripts/sync-person-map.sh || warn "mapa osoba pala (nastavljam)."
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
    || warn "stats sync/deploy pao/nije konfiguriran (nastavljam)."
fi

if [ "$WARN_N" -gt 0 ]; then
  echo "[cron] ⚠️  $WARN_N korak(a) nije prošao:$WARN_LIST"
fi
echo "[cron $(date '+%Y-%m-%d %H:%M:%S')] sync-cron gotov (rc=$RC, warn=$WARN_N)"
exit $RC
