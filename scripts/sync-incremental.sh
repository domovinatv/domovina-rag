#!/usr/bin/env bash
# scripts/sync-incremental.sh — inkrementalni refresh semantičke baze na cloudu.
#
# Cijeli put: lokalni ETL (oba diska, idempotentan) → embed novih chunkova na
# host MPS embedderu → youtube_id set-diff lokalni CH vs cloud CH → dump delte
# (Native+zstd) → push preko SSH-a u cloud CH. Sve idempotentno i sigurno za
# ponovni run.
#
# ZAŠTO set-diff po youtube_id (a NE po datumu):
#   Producer zna indeksirati epizode naknadno — chunkovi s upload_date STARIJIM
#   od cloud-maxa se pojave tek danas. Delta po datumu bi ih promašila; set-diff
#   po youtube_id ih hvata. Filtriramo length(youtube_id)=11 da izbacimo junk
#   (npr. korumpirani orfan youtube_id="λ", ep 474).
#
# ZAŠTO embed lokalno, serve na cloudu:
#   bge-m3 je MPS-heavy (~37ms/text na Apple Silicon, ~1500ms na cloud CPU).
#   Cloud VPS nema GPU → embeddanje ostaje lokalno, cloud samo poslužuje.
#   Vidi memory: project-cloud-deployment-plan, project-mps-embedder-host.
#
# Preduvjeti:
#   - lokalni stack up (docker compose up -d postgres clickhouse)
#   - host MPS embedder gore (scripts/run-embedder-host.sh) — za ETL embed
#   - SSH pristup cloud VPS-u (ključ ispod)
#   - zstd lokalno (brew install zstd)
#
# Usage:
#   scripts/sync-incremental.sh              # full: ETL + delta push
#   scripts/sync-incremental.sh --dry-run    # samo izračun delte, bez ETL-a i push-a
#   scripts/sync-incremental.sh --skip-etl   # preskoči ETL, samo push postojeće delte
#
set -euo pipefail

cd "$(dirname "$0")/.."

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

# ─── Konfiguracija (override preko .env ili env vars) ──────────────────────────
SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

# Lokalni CH (iz compose-a)
LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_CH_DB="${CLICKHOUSE_DB:-rag}"
LOCAL_CH_USER="${CLICKHOUSE_USER:-rag_user}"
LOCAL_CH_PASS="${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

# Diskovi koje ETL skenira (producer raspršuje kanale preko više diskova preko
# symlinkova; svaki disk mora ići eksplicitno — vidi lessons-etl-data-source-symlinks)
DATA_DIRS=(${DATA_SOURCE_DIRS:-/Volumes/DOMOVINA1TB/fetch_domovina_tv_output /Volumes/DOMOVINA2TB/fetch_domovina_tv_output})
ETL_BATCH="${ETL_BATCH_SIZE:-4}"

DRY_RUN=0
SKIP_ETL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1; SKIP_ETL=1 ;;
    --skip-etl) SKIP_ETL=1 ;;
    *) echo "Nepoznat argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[sync $(date +%H:%M:%S)] $*"; }

# ─── 0. Preflight ─────────────────────────────────────────────────────────────
[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
command -v zstd >/dev/null || { echo "ERROR: zstd nije instaliran (brew install zstd)." >&2; exit 1; }
[ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }

ch_local() { docker exec "$LOCAL_CH_CONTAINER" clickhouse-client -d "$LOCAL_CH_DB" \
  --user "$LOCAL_CH_USER" --password "$LOCAL_CH_PASS" --query "$1"; }

# Cloud container + lozinka se discoveraju (ne hardkodiraju — mijenjaju se na redeploy)
log "Discovering cloud CH container..."
CLOUD_CH_CONTAINER=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=clickhouse --format '{{.Names}}' | head -1")
[ -n "$CLOUD_CH_CONTAINER" ] || { echo "ERROR: cloud CH container nije pronađen." >&2; exit 1; }
CLOUD_CH_PASS=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_CH_CONTAINER printenv CLICKHOUSE_PASSWORD")
log "Cloud CH: $CLOUD_CH_CONTAINER"

ch_cloud() { ssh $SSH_OPTS "$SSH_HOST" \
  "docker exec $CLOUD_CH_CONTAINER clickhouse-client -d $LOCAL_CH_DB --user $LOCAL_CH_USER --password $CLOUD_CH_PASS --query \"$1\""; }

# ─── 1. ETL ingest (idempotentan, per-disk) ───────────────────────────────────
if [ "$SKIP_ETL" -eq 0 ]; then
  for dir in "${DATA_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
      log "WARN: data dir ne postoji, preskačem: $dir"
      continue
    fi
    log "ETL ingest: $dir"
    DATA_SOURCE_DIR="$dir" docker compose --profile etl run --rm etl \
      ingest --input /data --batch-size "$ETL_BATCH" 2>&1 | grep -E 'Pronađeno|Done:|ERROR|error' || true
  done
else
  log "Preskačem ETL (--skip-etl/--dry-run)."
fi

# ─── 2. Set-diff po youtube_id (validni 11-znakovni; junk se izbacuje) ─────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Računam delta (lokalni CH vs cloud CH)..."
ch_local "SELECT DISTINCT youtube_id FROM rag_chunks WHERE length(youtube_id)=11 ORDER BY youtube_id" > "$WORK/local.txt"
ch_cloud "SELECT DISTINCT youtube_id FROM rag_chunks WHERE length(youtube_id)=11 ORDER BY youtube_id" > "$WORK/cloud.txt"
comm -23 "$WORK/local.txt" "$WORK/cloud.txt" > "$WORK/delta.txt"

DELTA_N=$(grep -c . "$WORK/delta.txt" || true)
log "Lokalno: $(grep -c . "$WORK/local.txt") videa | Cloud: $(grep -c . "$WORK/cloud.txt") videa | Delta: $DELTA_N"

if [ "$DELTA_N" -eq 0 ]; then
  log "Nema delte — cloud je up-to-date. Gotovo."
  exit 0
fi

log "Nova videa za sync:"; sed 's/^/    /' "$WORK/delta.txt"

if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run: stajem prije dump-a/push-a."
  exit 0
fi

# ─── 3. Dump delte (Native+zstd, FINAL za dedup na izvoru) ────────────────────
IN=$(awk 'NF{printf "%s'\''%s'\''", (NR>1?",":""), $1}' "$WORK/delta.txt")
log "Dump $DELTA_N videa → Native+zstd..."
ch_local "SELECT * FROM rag_chunks FINAL WHERE youtube_id IN ($IN) FORMAT Native" \
  | zstd -19 > "$WORK/delta.native.zst"
DUMP_CHUNKS=$(ch_local "SELECT count() FROM rag_chunks WHERE youtube_id IN ($IN)")
log "Dump: $(du -h "$WORK/delta.native.zst" | cut -f1), $DUMP_CHUNKS chunkova"

# ─── 4. Push u cloud CH preko SSH-a ───────────────────────────────────────────
BEFORE=$(ch_cloud "SELECT count() FROM rag_chunks")
log "Cloud chunks BEFORE: $BEFORE"
cat "$WORK/delta.native.zst" | ssh $SSH_OPTS "$SSH_HOST" \
  "zstd -d | docker exec -i $CLOUD_CH_CONTAINER clickhouse-client -d $LOCAL_CH_DB --user $LOCAL_CH_USER --password $CLOUD_CH_PASS --query 'INSERT INTO rag_chunks FORMAT Native'"
AFTER=$(ch_cloud "SELECT count() FROM rag_chunks")
log "Cloud chunks AFTER:  $AFTER  (+$((AFTER - BEFORE)))"

# ─── 5. Verifikacija ──────────────────────────────────────────────────────────
CLOUD_DELTA_VIDS=$(ch_cloud "SELECT count(DISTINCT youtube_id) FROM rag_chunks WHERE youtube_id IN ($IN)")
log "Verifikacija: $CLOUD_DELTA_VIDS / $DELTA_N novih videa prisutno na cloudu."
if [ "$CLOUD_DELTA_VIDS" -eq "$DELTA_N" ]; then
  log "✅ Sync uspješan."
else
  log "⚠️  Mismatch — provjeri ručno (možda ReplacingMergeTree dedup ili djelomičan insert)."
  exit 1
fi
