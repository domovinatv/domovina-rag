#!/usr/bin/env bash
# scripts/sync-vector-map.sh — generiraj 2D UMAP "vector map" chunk embeddinga
# za stats.domovina.ai (Razina 2 stats dashboarda; plan: domovina-stats/docs/00-plan.md).
#
# Izvor je UVIJEK LOKALNI ClickHouse: embeddingi su identični cloudu (lokalni CH
# je source-of-truth koji pusha deltu u cloud ranije u sync-cron.sh), a izvoz je
# ~560 MB — preko SSH-a bi bio besmisleno skup. Output ide u domovina-stats/public/
# (vector-map.bin + vector-map.json) i deploya ga POSTOJEĆI sync-stats.sh --deploy
# korak (jedan wrangler deploy nosi i stats.json i mapu) — zato u cronu ide PRIJE
# koraka 7.
#
# UMAP (umap-learn) nema stdlib zamjenu → jedina iznimka od dependency-free
# pravila za scripts/: dedicated venv .venv-vectormap (gitignoran), bootstrap
# ovdje. Težak dio (~5-10 min na M4) se PRESKAČE ako se broj chunkova u CH nije
# promijenio od zadnjeg snapshota (source_rows u vector-map.json); --force gazi.
#
# Usage:
#   scripts/sync-vector-map.sh            # skip ako count nepromijenjen
#   scripts/sync-vector-map.sh --force    # uvijek regeneriraj
#
# launchd daje minimalan PATH — prepend Homebrew/usr-local.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

STATS_REPO_DIR="${STATS_REPO_DIR:-$REPO/../domovina-stats}"
OUT_DIR="$STATS_REPO_DIR/public"
VENV="$REPO/.venv-vectormap"

LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-$(docker ps --filter name=postgres --format '{{.Names}}' | grep -i domovina | head -1)}"
CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"
PG_DB="${POSTGRES_DB:-rag}"
PG_USER="${POSTGRES_USER:-rag_user}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { echo "[vector-map $(date +%H:%M:%S)] $*"; }

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
[ -n "$LOCAL_PG_CONTAINER" ] || { echo "ERROR: lokalni PG container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

ch_query() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" \
  --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }

WHERE="length(youtube_id) = 11"

# ─── Skip-if-unchanged (jeftin count vs. source_rows zadnjeg snapshota) ────────
SOURCE_ROWS=$(ch_query "SELECT count() FROM rag_chunks WHERE $WHERE")
PREV_ROWS=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('source_rows',-1))" \
  "$OUT_DIR/vector-map.json" 2>/dev/null || echo -1)
if [ "$FORCE" -eq 0 ] && [ "$SOURCE_ROWS" = "$PREV_ROWS" ]; then
  log "Broj chunkova nepromijenjen ($SOURCE_ROWS) — preskačem UMAP (--force za gaziti)."
  exit 0
fi

# ─── Bootstrap venv (jednokratno; umap-learn povlači numba/llvmlite) ───────────
if [ ! -x "$VENV/bin/python" ]; then
  log "Bootstrap $VENV (umap-learn + numpy)..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "umap-learn>=0.5.7" "numpy>=2"
fi

# ─── Izvozi (lokalni CH + PG preko docker exec-a) ─────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Izvoz embeddinga iz CH ($SOURCE_ROWS chunkova, RowBinary ~$((SOURCE_ROWS * 4119 / 1000000)) MB)..."
# Fiksni record (vidi emit_vector_map.py docstring) — omogućuje numpy reshape bez parsera.
ch_query "SELECT CAST(youtube_id AS FixedString(11)), toUInt16(least(round(start_ts), 65535)), cityHash64(chunk_id), embedding FROM rag_chunks WHERE $WHERE FORMAT RowBinary" \
  > "$WORK/raw.bin"

log "Izvoz episode meta (channel, date) iz CH..."
ch_query "SELECT youtube_id, any(channel), toString(min(upload_date)) FROM rag_chunks WHERE $WHERE GROUP BY youtube_id FORMAT TSV" \
  > "$WORK/episodes.tsv"

log "Izvoz naslova iz PG..."
docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -Atc \
  "COPY (SELECT youtube_id, title FROM episodes WHERE title IS NOT NULL) TO STDOUT" \
  > "$WORK/titles.tsv"

# ─── UMAP + sklapanje outputa ─────────────────────────────────────────────────
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$VENV/bin/python" scripts/emit_vector_map.py \
  --raw          "$WORK/raw.bin" \
  --episodes     "$WORK/episodes.tsv" \
  --titles       "$WORK/titles.tsv" \
  --out-dir      "$OUT_DIR" \
  --generated-at "$GENERATED_AT" \
  --source       "local" \
  --source-rows  "$SOURCE_ROWS"

log "✅ Vector map svjež u $OUT_DIR (deploya ga sync-stats.sh --deploy)."
