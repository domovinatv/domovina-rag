#!/usr/bin/env bash
# scripts/sync-incremental.sh — inkrementalni refresh semantičke baze na cloudu.
#
# Cijeli put: lokalni ETL (oba diska, idempotentan) → embed novih chunkova na
# host MPS embedderu → diff (youtube_id, broj chunkova) lokalni CH vs cloud CH →
# dump delte (Native+zstd) → push preko SSH-a u cloud CH. Sve idempotentno i
# sigurno za ponovni run.
#
# ZAŠTO diff po youtube_id (a NE po datumu):
#   Producer zna indeksirati epizode naknadno — chunkovi s upload_date STARIJIM
#   od cloud-maxa se pojave tek danas. Delta po datumu bi ih promašila; diff
#   po youtube_id ih hvata. Filtriramo length(youtube_id)=11 da izbacimo junk
#   (npr. korumpirani orfan youtube_id="λ", ep 474).
#
# ZAŠTO se uspoređuje BROJ JEDINSTVENIH chunk_id-eva, a ne skup youtube_id-eva:
#   Set-diff po id-u vidi samo NOVE epizode. Epizoda koja je već u cloudu, a
#   lokalno je re-procesirana (ETL je prvi put pao na embedu pa je ušla krnja),
#   ima id na obje strane → delta 0 → popravak nikad ne ode gore. Točno se to
#   dogodilo: 04.08.2026. je cloud četiri dana javljao "up-to-date" dok mu je u
#   76 epizoda nedostajalo ~1 590 chunkova (npr. 6 od 28 stvarnih).
#
# ZAŠTO uniqExact(chunk_id), a ne count():
#   ETL pri re-ingestu epizode dodijeli NOVI episode_id, a on je u ORDER BY
#   ključu (channel, upload_date, episode_id, chunk_index). ReplacingMergeTree
#   zato NE kolabira ponovljene runove — isti chunk_id živi u N kopija (izmjereno
#   04.08.2026: tih 76 epizoda = 8 262 retka za 2 046 stvarnih chunkova, faktor
#   do 24×). count() bi tu duplikaciju čitao kao "sadržaj" i gurao je u cloud, gdje
#   napuhuje HNSW indeks i vraća isti chunk više puta u RAG rezultatima. Zato je
#   mjera uniqExact(chunk_id), a dump ide kroz LIMIT 1 BY chunk_id.
#   Uzrok (episode_id se mijenja po runu) je u services/etl i nije riješen ovdje —
#   ovaj skript samo odbija propagirati posljedicu.
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

# launchd daje minimalan PATH (/usr/bin:/bin:/usr/sbin:/sbin) — docker, node/npx,
# gcloud i ostali alati nisu vidljivi. Razrješava ih zajednički lib.
# shellcheck source=scripts/lib/cron-path.sh
. "$(dirname "$0")/lib/cron-path.sh"

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
# batch=2 (ne 4): MPS GPU allocator segfaulta pod unified-memory pritiskom
# (Docker drži 14/24 GB); manji batch = manji attention buffer. Vidi sync-cron.sh.
ETL_BATCH="${ETL_BATCH_SIZE:-2}"

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
  # ETL se vrti u KONTEJNERU, a `services/etl/` je zapečen u image (mounta se
  # samo /data:ro). Bez ovog builda izmjena Pythona se commita, prođe code
  # review i tiho se NE primijeni — točno se to dogodilo s `embed_lenient`:
  # popravak je bio u gitu 03.08., a cron je 04.08. i dalje vrtio image od 01.08.
  # i odbacivao cijele epizode. S Docker cacheom ovo traje ~5 s kad se ništa nije
  # promijenilo, pa nema razloga da nije bezuvjetno.
  # Output ide u fajl, ne u /dev/null: 05.08.2026. je build pao u 04:01 (Docker se
  # tek budio s Macom), cron je nastavio s imageom od jučer, a JEDINI trag je bio
  # "WARN: ETL build pao" bez razloga. Ako se ovo ponovi, razlog mora biti čitljiv.
  log "Build ETL image (no-op ako se izvor nije promijenio)..."
  BUILD_LOG=".ingest-logs/etl-build-$(date +%Y%m%d).log"
  if ! docker compose --profile etl build etl >"$BUILD_LOG" 2>&1; then
    log "WARN: ETL build pao — nastavljam s postojećim imageom (može biti star!). Razlog:"
    tail -15 "$BUILD_LOG" | sed 's/^/[cron]    │ /'
    log "       Puni log: $BUILD_LOG"
  fi

  for dir in "${DATA_DIRS[@]}"; do
    if [ ! -d "$dir" ]; then
      log "WARN: data dir ne postoji, preskačem: $dir"
      continue
    fi
    log "ETL ingest: $dir"
    # WARNING mora proći filter: load.py namjerno logira "epizoda unesena s X od Y
    # chunkova" kad 413 pojede pojedini chunk, i to je JEDINI trag da je epizoda u
    # korpusu nepotpuna (nijedan agregat to ne pokazuje — chunkova je manje, ali
    # nitko ne zna koliko ih je trebalo biti). Stari filter je propuštao samo
    # Pronađeno|Done:|ERROR, pa je taj WARNING padao u ništa.
    DATA_SOURCE_DIR="$dir" docker compose --profile etl run --rm etl \
      ingest --input /data --batch-size "$ETL_BATCH" 2>&1 | grep -E 'Pronađeno|Done:|ERROR|error|WARNING|preskočen' || true
  done
else
  log "Preskačem ETL (--skip-etl/--dry-run)."
fi

# ─── 2. Diff po (youtube_id, broj chunkova) — validni 11-znakovni id-evi ───────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Računam delta (lokalni CH vs cloud CH)..."
# FINAL na obje strane: ReplacingMergeTree drži nespojene duplikate do mergea, a
# bez FINAL-a bi ih diff čitao kao "razliku" i vrtio push u prazno svaki dan.
# Treći stupac (redaka) služi da se uhvati i cloud koji ima točan sadržaj, ali
# napuhan duplikatima iz ranijih push-eva — i takva epizoda ide na re-push.
CNT_Q="SELECT youtube_id, uniqExact(chunk_id), count() FROM rag_chunks FINAL WHERE length(youtube_id)=11 GROUP BY youtube_id ORDER BY youtube_id FORMAT TSV"
ch_local "$CNT_Q" > "$WORK/local.tsv"
ch_cloud "$CNT_Q" > "$WORK/cloud.tsv"

# delta.tsv: youtube_id \t jedinstvenih_na_cloudu (-1 = epizode nema) \t jedinstvenih_lokalno
awk -F'\t' 'NR==FNR { u[$1]=$2; r[$1]=$3; next }
            { n = ($1 in u) ? u[$1] : -1
              if (n != $2 || ($1 in u && r[$1] != u[$1])) print $1"\t"n"\t"$2 }' \
  "$WORK/cloud.tsv" "$WORK/local.tsv" > "$WORK/delta.tsv"
cut -f1 "$WORK/delta.tsv" > "$WORK/delta.txt"

DELTA_N=$(grep -c . "$WORK/delta.txt" || true)
NEW_N=$(awk -F'\t' '$2 == -1' "$WORK/delta.tsv" | grep -c . || true)
CHANGED_N=$((DELTA_N - NEW_N))
sum_col() { awk -F'\t' -v c="$2" '{s += $c} END {print s+0}' "$1"; }
log "Lokalno: $(grep -c . "$WORK/local.tsv") videa / $(sum_col "$WORK/local.tsv" 2) chunkova ($(sum_col "$WORK/local.tsv" 3) redaka) | Cloud: $(grep -c . "$WORK/cloud.tsv") videa / $(sum_col "$WORK/cloud.tsv" 2) chunkova ($(sum_col "$WORK/cloud.tsv" 3) redaka)"
log "Delta: $DELTA_N epizoda ($NEW_N novih, $CHANGED_N s promijenjenim/dupliciranim sadržajem)"

if [ "$DELTA_N" -eq 0 ]; then
  log "Nema delte — cloud je up-to-date. Gotovo."
  exit 0
fi

log "Epizode za sync (id, cloud→lokalno):"
awk -F'\t' '{printf "    %s  %s → %s\n", $1, ($2 == -1 ? "nema" : $2), $3}' "$WORK/delta.tsv"

if [ "$DRY_RUN" -eq 1 ]; then
  log "--dry-run: stajem prije dump-a/push-a."
  exit 0
fi

# ─── 3. Dump delte (Native+zstd, FINAL za dedup na izvoru) ────────────────────
IN=$(awk 'NF{printf "%s'\''%s'\''", (NR>1?",":""), $1}' "$WORK/delta.txt")
log "Dump $DELTA_N videa → Native+zstd..."
# LIMIT 1 BY chunk_id: u cloud ide jedan red po chunku, iz najnovijeg ETL runa
# (episode_id DESC). Bez toga se lokalna duplikacija preslika gore.
ch_local "SELECT * FROM rag_chunks FINAL WHERE youtube_id IN ($IN) ORDER BY chunk_id, episode_id DESC LIMIT 1 BY chunk_id FORMAT Native" \
  | zstd -19 > "$WORK/delta.native.zst"
DUMP_CHUNKS=$(ch_local "SELECT uniqExact(chunk_id) FROM rag_chunks FINAL WHERE youtube_id IN ($IN)")
log "Dump: $(du -h "$WORK/delta.native.zst" | cut -f1), $DUMP_CHUNKS chunkova"

# ─── 3.5 Brisanje krnjih verzija na cloudu (samo za promijenjene epizode) ─────
# ReplacingMergeTree dedupa po ORDER BY (channel, upload_date, episode_id,
# chunk_index) tek na merge, i to samo preklapajuće ključeve. Ako je epizoda
# lokalno re-chunkana na MANJE chunkova, stari repovi bi ostali zauvijek. Brišemo
# pa ubacujemo — jedini put koji je točan u oba smjera. Za nove epizode se
# preskače (mutacija nad cijelom tablicom nije besplatna).
if [ "$CHANGED_N" -gt 0 ]; then
  IN_CHANGED=$(awk -F'\t' '$2 != -1 {printf "%s'\''%s'\''", (n++ ? "," : ""), $1}' "$WORK/delta.tsv")
  log "Brišem $CHANGED_N promijenjenih epizoda iz clouda (mutacija, čekam završetak)..."
  ch_cloud "ALTER TABLE rag_chunks DELETE WHERE youtube_id IN ($IN_CHANGED) SETTINGS mutations_sync = 2"
  log "Mutacija gotova."
fi

# ─── 4. Push u cloud CH preko SSH-a ───────────────────────────────────────────
BEFORE=$(ch_cloud "SELECT count() FROM rag_chunks")
log "Cloud chunks BEFORE: $BEFORE"
cat "$WORK/delta.native.zst" | ssh $SSH_OPTS "$SSH_HOST" \
  "zstd -d | docker exec -i $CLOUD_CH_CONTAINER clickhouse-client -d $LOCAL_CH_DB --user $LOCAL_CH_USER --password $CLOUD_CH_PASS --query 'INSERT INTO rag_chunks FORMAT Native'"
AFTER=$(ch_cloud "SELECT count() FROM rag_chunks")
log "Cloud chunks AFTER:  $AFTER  (+$((AFTER - BEFORE)))"

# ─── 5. Verifikacija (po epizodi, ne samo po prisutnosti id-a) ────────────────
# "id postoji na cloudu" je bila prestara provjera — prolazila je i za epizodu
# sa 6 od 112 chunkova. Uspoređuje se broj chunkova po epizodi.
ch_cloud "SELECT youtube_id, uniqExact(chunk_id), count() FROM rag_chunks FINAL WHERE youtube_id IN ($IN) GROUP BY youtube_id ORDER BY youtube_id FORMAT TSV" > "$WORK/cloud-after.tsv"
awk -F'\t' 'NR==FNR { u[$1]=$2; r[$1]=$3; next }
            { n = ($1 in u) ? u[$1] : 0
              if (n != $3) print "    "$1"  očekivano "$3" chunkova, na cloudu "n
              else if (r[$1] != n) print "    "$1"  "n" chunkova ali "r[$1]" redaka (duplikati)" }' \
  "$WORK/cloud-after.tsv" "$WORK/delta.tsv" > "$WORK/mismatch.txt"
MISMATCH_N=$(grep -c . "$WORK/mismatch.txt" || true)
log "Verifikacija: $((DELTA_N - MISMATCH_N)) / $DELTA_N epizoda ima točan broj chunkova na cloudu."
if [ "$MISMATCH_N" -eq 0 ]; then
  log "✅ Sync uspješan."
else
  log "⚠️  Mismatch na $MISMATCH_N epizoda:"; cat "$WORK/mismatch.txt"
  exit 1
fi
