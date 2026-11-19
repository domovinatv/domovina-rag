#!/usr/bin/env bash
# scripts/sync-programs.sh — programi stranaka (Kompas stranaka) u ClickHouse
# `program_chunks`. Radi lokalno ILI prema cloud CH-u (preko SSH-a).
#
# Izvor je stranke.domovina.ai `data/raw/kompas/chunks.jsonl` (+ liste_2024.json
# za nazive stranaka). Fajl se mijenja samo kad stranke repo ponovno izreže
# programe, pa je obična noć no-op: ETL usporedi potpis svakog dokumenta s CH-om
# i ne zove embedder (vidi services/etl/etl/programs.py).
#
#   lokalno:  ETL (`python -m etl programs`) u kontejneru, isto kao ingest u
#             sync-incremental.sh (host nema venv s clickhouse_connect). Embed
#             ide na host MPS embedder (EMBEDDER_URL iz .env). Ako embedder nije
#             gore, a nešto treba embedati, ETL ispiše WARNING, odgodi te
#             dokumente i izađe s 0 — idući run ih uzima.
#   --cloud:  cloud NE računa ništa. Lokalni program_chunks (s embeddinzima) se
#             preslika u cloud CH, delta po doc_id-u.
#
# Usage:
#   scripts/sync-programs.sh                 # lokalni ETL
#   scripts/sync-programs.sh --dry-run       # lokalni plan, bez embeddanja i pisanja
#   scripts/sync-programs.sh --cloud         # lokalni CH → cloud CH (delta po doc_id)
#   scripts/sync-programs.sh --cloud --dry-run
#
# Env: STRANKE_REPO (default ../stranke.domovina.ai), PROGRAMS_INPUT,
#      PROGRAMS_LISTE, PROGRAMS_BATCH_SIZE (default 8, max 8).
#
# launchd daje minimalan PATH (/usr/bin:/bin:/usr/sbin:/sbin) — docker, node/npx,
# gcloud i ostali alati nisu vidljivi. Razrješava ih zajednički lib.
# shellcheck source=scripts/lib/cron-path.sh
. "$(dirname "$0")/lib/cron-path.sh"

set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

TARGET="local"
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --cloud) TARGET="cloud" ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Nepoznat argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[programs-sync $(date +%H:%M:%S)] $*"; }

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"

ch_local() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }

# ─── Shema (idempotentno, i lokalno i na cloudu) ──────────────────────────────
# init.sql se na postojećoj bazi NE re-runa (ni lokalno ni na cloudu), pa tablicu
# kreira ova skripta. DDL se čita iz init.sql (jedan izvor istine): od
# `CREATE TABLE IF NOT EXISTS program_chunks` do prvog `ORDER BY (doc_id, chunk_index);`.
# vector_similarity indeks je u CH 24.x experimental → setting kao opcija klijenta.
DDL="$(awk '/^CREATE TABLE IF NOT EXISTS program_chunks/{p=1} p{print} p&&/^ORDER BY \(doc_id, chunk_index\);/{exit}' infra/clickhouse/init.sql)"
case "$DDL" in
  *"ORDER BY (doc_id, chunk_index);"*) : ;;
  *) echo "ERROR: DDL za program_chunks nije pronađen u infra/clickhouse/init.sql" >&2; exit 1 ;;
esac
DDL_OPTS="--allow_experimental_vector_similarity_index=1"

printf '%s\n' "$DDL" | docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" \
  --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" $DDL_OPTS
log "Lokalna shema osigurana ($LOCAL_CH_CONTAINER)."

# ══════════════════════════════════════════════════════════════════════════════
# LOKALNO: ETL u kontejneru
# ══════════════════════════════════════════════════════════════════════════════
if [ "$TARGET" = "local" ]; then
  STRANKE_REPO="${STRANKE_REPO:-$REPO/../stranke.domovina.ai}"
  INPUT="${PROGRAMS_INPUT:-$STRANKE_REPO/data/raw/kompas/chunks.jsonl}"
  LISTE="${PROGRAMS_LISTE:-$STRANKE_REPO/data/kompas/liste_2024.json}"
  [ -f "$INPUT" ] || { echo "ERROR: nema $INPUT (stranke.domovina.ai: scripts za Kompas ga generiraju)." >&2; exit 1; }
  [ -f "$LISTE" ] || { echo "ERROR: nema $LISTE." >&2; exit 1; }
  # docker -v traži apsolutne putanje.
  INPUT="$(cd "$(dirname "$INPUT")" && pwd)/$(basename "$INPUT")"
  LISTE="$(cd "$(dirname "$LISTE")" && pwd)/$(basename "$LISTE")"

  # Isto kao sync-cron.sh: ETL je u kontejneru, embedder na hostu.
  export EMBEDDER_URL="${EMBEDDER_URL:-http://host.docker.internal:${EMBEDDER_HOST_PORT:-8008}}"

  # Image mora sadržavati etl/programs.py; s Docker cacheom je ovo ~5 s no-op.
  mkdir -p .ingest-logs
  BUILD_LOG=".ingest-logs/etl-build-$(date +%Y%m%d).log"
  if ! docker compose --profile etl build etl >>"$BUILD_LOG" 2>&1; then
    log "WARN: ETL build pao — nastavljam s postojećim imageom. Log: $BUILD_LOG"
    tail -5 "$BUILD_LOG" | sed 's/^/[programs-sync]    │ /'
  fi

  EXTRA=()
  [ "$DRY_RUN" = 1 ] && EXTRA=(--dry-run)
  log "ETL: $INPUT (embedder: $EMBEDDER_URL)"
  # Svaki fajl se mounta zasebno (read-only), pa DATA_SOURCE_DIR ostaje netaknut.
  ETL_OUT="$(mktemp -t programs_etl.XXXXXX)"
  trap 'rm -f "$ETL_OUT"' EXIT
  docker compose --profile etl run --rm -T \
    -v "$INPUT:/programs/chunks.jsonl:ro" \
    -v "$LISTE:/programs/liste_2024.json:ro" \
    etl programs --input /programs/chunks.jsonl --liste /programs/liste_2024.json \
    --batch-size "${PROGRAMS_BATCH_SIZE:-8}" ${EXTRA[@]+"${EXTRA[@]}"} 2>&1 | tee "$ETL_OUT"
  COUNT=$(ch_local "SELECT count() FROM program_chunks FINAL")
  # Embedder dolje = namjerno rc 0 (nije kvar podataka, idući run nadoknadi),
  # ali mora biti vidljivo: bez ovoga zadnji redak kaže ✅ uz 0 unesenih.
  if grep -q 'odgođeno' "$ETL_OUT"; then
    log "WARN: embedder nije dostupan — dio programa NIJE unesen (program_chunks = $COUNT redova)."
  else
    log "✅ Lokalno: program_chunks = $COUNT redova."
  fi
  exit 0
fi

# ══════════════════════════════════════════════════════════════════════════════
# CLOUD: lokalni CH → cloud CH, delta po doc_id
# ══════════════════════════════════════════════════════════════════════════════
# ZAŠTO delta po dokumentu, a ne puni replace (iako je tablica samo ~1k redova,
# ~4 MB s embeddinzima): (1) obična noć bez promjena = dva mala upita i nula
# prijenosa; (2) puni replace (TRUNCATE + INSERT) ostavlja prozor u kojem je
# cloud tablica prazna i MCP `search_programs` ne vraća ništa; (3) dokument je
# ionako jedinica promjene u ETL-u (programs.py briše i ubacuje cijeli doc).
# Potpis dokumenta = broj redova + hash sortiranog skupa (chunk_id, text_hash,
# hash metapodataka, duljina embeddinga) — isti izraz se računa na obje strane.
command -v zstd >/dev/null || { echo "ERROR: zstd nije instaliran (brew install zstd)." >&2; exit 1; }
[ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }

# Cloud CH se nalazi kao u sync-incremental.sh / sync-speakers.sh: Coolify label
# projekta + ime servisa; ime je clickhouse-<stack-UUID>-<ts>.
CLOUD_CH=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter label=coolify.projectName=domovina-rag --filter name=clickhouse --format '{{.Names}}' | head -1")
[ -n "$CLOUD_CH" ] || { echo "ERROR: cloud CH container nije pronađen." >&2; exit 1; }
STACK_UUID=$(printf '%s' "$CLOUD_CH" | sed -E 's/^clickhouse-([a-z0-9]+)-.*/\1/')
CLOUD_CH_PW=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_CH printenv CLICKHOUSE_PASSWORD")
ch_cloud() { ssh $SSH_OPTS "$SSH_HOST" "docker exec -i $CLOUD_CH clickhouse-client -d $CH_DB --user $CH_USER --password $CLOUD_CH_PW --query \"$1\""; }
log "Cilj: CLOUD CH ($CLOUD_CH, stack $STACK_UUID @ $SSH_HOST), izvor lokalni CH ($LOCAL_CH_CONTAINER)"

printf '%s\n' "$DDL" | ssh $SSH_OPTS "$SSH_HOST" \
  "docker exec -i $CLOUD_CH clickhouse-client -d $CH_DB --user $CH_USER --password $CLOUD_CH_PW $DDL_OPTS"
log "Cloud shema osigurana."

COLS="chunk_id, doc_id, chunk_index, total_chunks, party_ids, party_names, party_short, party_slugs, list_id, manjine_id, vrsta, izvor, nesiguran, nesiguran_razlog, naslov, url, datum, page_from, page_to, section, words, format, text, text_hash, embedding, metadata, inserted_at"
SIG_EXPR="lower(hex(sipHash128(arrayStringConcat(arraySort(groupArray(concat(chunk_id, '|', text_hash, '|', toString(cityHash64(metadata, arrayStringConcat(party_names, '|'), arrayStringConcat(party_short, '|'), arrayStringConcat(party_slugs, '|'))), '|', toString(length(embedding))))), ','))))"
SIG_Q="SELECT doc_id, count(), $SIG_EXPR FROM program_chunks FINAL GROUP BY doc_id ORDER BY doc_id FORMAT TSV"

WORK="$(mktemp -d -t programs_sync.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
ch_local "$SIG_Q" > "$WORK/local.tsv"
ch_cloud "$SIG_Q" > "$WORK/cloud.tsv"
LOCAL_DOCS=$(wc -l < "$WORK/local.tsv" | tr -d ' ')
# Prazan lokalni CH (npr. ETL još nije prošao) NE smije obrisati cloud.
[ "$LOCAL_DOCS" -gt 0 ] || { echo "ERROR: lokalni program_chunks je prazan — ne diram cloud." >&2; exit 1; }

# changed = lokalni doc kojeg na cloudu nema ili ima drukčiji potpis;
# replace = changed koji na cloudu postoji (treba ga prvo obrisati);
# prune   = doc na cloudu kojeg lokalno nema.
awk -F'\t' 'FILENAME==ARGV[1] {c[$1]=$2"\t"$3; next} !($1 in c) || c[$1] != $2"\t"$3 {print $1}' \
  "$WORK/cloud.tsv" "$WORK/local.tsv" > "$WORK/changed.txt"
awk -F'\t' 'FILENAME==ARGV[1] {c[$1]=1; next} ($1 in c) {print $1}' "$WORK/cloud.tsv" "$WORK/changed.txt" > "$WORK/replace.txt"
awk -F'\t' 'FILENAME==ARGV[1] {l[$1]=1; next} !($1 in l) {print $1}' "$WORK/local.tsv" "$WORK/cloud.tsv" > "$WORK/prune.txt"
CHANGED_N=$(wc -l < "$WORK/changed.txt" | tr -d ' ')
REPLACE_N=$(wc -l < "$WORK/replace.txt" | tr -d ' ')
PRUNE_N=$(wc -l < "$WORK/prune.txt" | tr -d ' ')
log "Lokalno $LOCAL_DOCS dok., cloud $(wc -l < "$WORK/cloud.tsv" | tr -d ' ') dok. → za slanje $CHANGED_N (od toga zamjena $REPLACE_N), za brisanje $PRUNE_N"

if [ "$CHANGED_N" -eq 0 ] && [ "$PRUNE_N" -eq 0 ]; then
  log "✅ Cloud program_chunks je up-to-date."
  exit 0
fi
if grep -qvE '^[A-Za-z0-9_-]+$' "$WORK/changed.txt" "$WORK/prune.txt"; then
  echo "ERROR: doc_id s neočekivanim znakovima — prekidam." >&2; exit 1
fi
if [ "$DRY_RUN" = 1 ]; then
  log "(dry-run) slao bih: $(tr '\n' ' ' < "$WORK/changed.txt")"
  log "(dry-run) brisao bih: $(tr '\n' ' ' < "$WORK/prune.txt")"
  exit 0
fi

in_list() { awk 'NF{printf "%s'\''%s'\''", (n++?",":""), $1}' "$@"; }

# 1. Brisanje na cloudu: zamijenjeni + prune (jedna mutacija, čeka kraj).
if [ "$REPLACE_N" -gt 0 ] || [ "$PRUNE_N" -gt 0 ]; then
  DEL_IN=$(in_list "$WORK/replace.txt" "$WORK/prune.txt")
  ch_cloud "ALTER TABLE program_chunks DELETE WHERE doc_id IN ($DEL_IN) SETTINGS mutations_sync = 2"
  log "Obrisano na cloudu: $REPLACE_N zamjena + $PRUNE_N prune."
fi

# 2. Dump promijenjenih dokumenata (Native+zstd) i insert na cloud.
if [ "$CHANGED_N" -gt 0 ]; then
  IN=$(in_list "$WORK/changed.txt")
  ch_local "SELECT $COLS FROM program_chunks FINAL WHERE doc_id IN ($IN) FORMAT Native" \
    | zstd -19 -q > "$WORK/delta.native.zst"
  log "Dump: $(du -h "$WORK/delta.native.zst" | cut -f1)"
  ssh $SSH_OPTS "$SSH_HOST" \
    "zstd -d | docker exec -i $CLOUD_CH clickhouse-client -d $CH_DB --user $CH_USER --password $CLOUD_CH_PW --query 'INSERT INTO program_chunks ($COLS) FORMAT Native'" \
    < "$WORK/delta.native.zst"
fi

# 3. Verifikacija: potpisi svih dokumenata moraju biti isti na obje strane.
ch_cloud "$SIG_Q" > "$WORK/cloud-after.tsv"
if cmp -s "$WORK/local.tsv" "$WORK/cloud-after.tsv"; then
  log "✅ Cloud program_chunks = lokalni ($LOCAL_DOCS dok., $(awk -F'\t' '{s+=$2} END{print s}' "$WORK/local.tsv") redova)."
else
  echo "ERROR: cloud se nakon pusha razlikuje od lokalnog:" >&2
  diff "$WORK/local.tsv" "$WORK/cloud-after.tsv" | head -10 >&2 || true
  exit 1
fi
