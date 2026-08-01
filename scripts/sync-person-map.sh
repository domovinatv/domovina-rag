#!/usr/bin/env bash
# scripts/sync-person-map.sh — generiraj "mapu osoba" (UMAP nad embeddinzima
# osoba) za stats.domovina.ai/people. Plan: docs/plans/2026-08-01-mapa-osoba.md.
#
# Izvor je UVIJEK LOKALNI stack: ClickHouse računa centroide (avgForEach) i
# lokalni CH je source-of-truth koji je deltu u cloud pushao ranije u
# sync-cron.sh; person hub tablice (speakers, person_mentions) čitaju se iz
# LOKALNOG PG-a jer ih je korak 6/6b upravo osvježio. Output ide u
# domovina-stats/public/person-map.json i deploya ga POSTOJEĆI
# sync-stats.sh --deploy korak (jedan wrangler deploy nosi sve) — zato u cronu
# ide PRIJE koraka 7.
#
# Za razliku od sync-vector-map.sh, ovdje se NE izvoze sirovi embeddinzi
# (~560 MB) nego per-epizoda i per-(epizoda,govornik) centroidi koje agregira
# sam ClickHouse — ~110 MB teksta i ~1,5 s. Cijeli run je ~30 s.
#
# Dijeli venv s mapom isječaka (.venv-vectormap: numpy + umap-learn).
#
# Usage:
#   scripts/sync-person-map.sh            # skip ako se izvor nije promijenio
#   scripts/sync-person-map.sh --force    # uvijek regeneriraj
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
MIN_EPISODES="${PERSON_MAP_MIN_EPISODES:-3}"

LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-$(docker ps --filter name=postgres --format '{{.Names}}' | grep -i domovina | head -1)}"
CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"
PG_DB="${POSTGRES_DB:-rag}"
PG_USER="${POSTGRES_USER:-rag_user}"

FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

log() { echo "[person-map $(date +%H:%M:%S)] $*"; }

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
[ -n "$LOCAL_PG_CONTAINER" ] || { echo "ERROR: lokalni PG container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

ch_query() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" \
  --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }
# -At -F tab: unaligned, bez COPY escapinga (imena nemaju tabove ni nove retke)
pg_query() { docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" \
  -At -F $'\t' -c "$1"; }

WHERE="length(youtube_id) = 11"

# ─── Skip-if-unchanged ────────────────────────────────────────────────────────
# Dva izvora, dva brojača: chunkovi (geometrija) i spomeni (tko je uopće osoba).
# Novi spomen bez novog chunka i dalje mijenja mapu, pa oba ulaze u potpis.
CH_ROWS=$(ch_query "SELECT count() FROM rag_chunks WHERE $WHERE")
PG_ROWS=$(pg_query "SELECT count(*) FROM person_mentions" 2>/dev/null || echo 0)
SOURCE_ROWS=$((CH_ROWS + PG_ROWS))
PREV_ROWS=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('source_rows',-1))" \
  "$OUT_DIR/person-map.json" 2>/dev/null || echo -1)
if [ "$FORCE" -eq 0 ] && [ "$SOURCE_ROWS" = "$PREV_ROWS" ]; then
  log "Izvor nepromijenjen ($CH_ROWS chunkova + $PG_ROWS spomena) — preskačem (--force za gaziti)."
  exit 0
fi

# ─── Bootstrap venv (dijeli ga sync-vector-map.sh) ────────────────────────────
if [ ! -x "$VENV/bin/python" ]; then
  log "Bootstrap $VENV (umap-learn + numpy)..."
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install -q --upgrade pip
  "$VENV/bin/pip" install -q "umap-learn>=0.5.7" "numpy>=2"
fi

# ─── Izvozi ───────────────────────────────────────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Izvoz per-epizoda centroida iz CH (nad $CH_ROWS chunkova)..."
ch_query "SELECT youtube_id, any(channel), count(),
  arrayStringConcat(arrayMap(x -> toString(round(x, 5)), avgForEach(embedding)), ',')
FROM rag_chunks WHERE $WHERE GROUP BY youtube_id FORMAT TSV" > "$WORK/episodes.tsv"

log "Izvoz per-(epizoda, govornik) centroida iz CH..."
# speaker je comma-joined ("Ante Čaljkušić,Dijana Brozović") — arrayJoin ga
# razdvaja, pa panel-chunk doprinosi centroidu SVAKOG svog govornika. To je
# namjerno: chunk je razgovor u kojem oboje sudjeluju.
ch_query "SELECT tok, youtube_id, n,
  arrayStringConcat(arrayMap(x -> toString(round(x, 5)), c), ',') FROM (
    SELECT trim(arrayJoin(splitByChar(',', speaker))) AS tok, youtube_id,
           count() AS n, avgForEach(embedding) AS c
    FROM rag_chunks WHERE $WHERE AND speaker != '' GROUP BY tok, youtube_id
  ) WHERE tok != '' FORMAT TSV" > "$WORK/speaker-centroids.tsv"

log "Izvoz person huba iz PG (speakers + person_mentions)..."
pg_query "SELECT slug, canonical_name FROM speakers WHERE slug IS NOT NULL" \
  > "$WORK/speakers.tsv"
pg_query "SELECT slug, youtube_id, channel, coalesce(person_name, '') FROM person_mentions" \
  > "$WORK/mentions.tsv"

log "$(wc -l < "$WORK/episodes.tsv") epizoda, $(wc -l < "$WORK/speaker-centroids.tsv") govor-centroida, $(wc -l < "$WORK/speakers.tsv") govornika, $(wc -l < "$WORK/mentions.tsv") spomena"

# ─── UMAP + sklapanje outputa ─────────────────────────────────────────────────
GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
"$VENV/bin/python" scripts/emit_person_map.py \
  --episodes           "$WORK/episodes.tsv" \
  --speaker-centroids  "$WORK/speaker-centroids.tsv" \
  --mentions           "$WORK/mentions.tsv" \
  --speakers           "$WORK/speakers.tsv" \
  --out-dir            "$OUT_DIR" \
  --generated-at       "$GENERATED_AT" \
  --source             "local" \
  --source-rows        "$SOURCE_ROWS" \
  --min-episodes       "$MIN_EPISODES"

log "✅ Mapa osoba svježa u $OUT_DIR (deploya je sync-stats.sh --deploy)."
