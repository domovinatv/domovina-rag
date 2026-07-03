#!/usr/bin/env bash
# scripts/sync-person-mentions.sh — (re)populiraj `person_mentions` (PG) iz
# ClickHouse `episode_mentions`. Radi lokalno ILI prema cloud PG-u (preko SSH-a).
#
# person_mentions je DERIVAT CH `episode_mentions` (koji je pak izveden iz
# producerovog summary.mentioned_people). Full-refresh (DELETE + INSERT), jeftin
# i idempotentan. Dio dnevnog sync-a (sync-cron.sh), poslije speakers re-populate-a.
# Bez toga /api/person/{slug} ne vraća sekciju "Spominje se u".
#
# ⚠️  RAZLIKA OD sync-speakers.sh: izvor je UVIJEK LOKALNI CH. `episode_mentions`
# se puni iz summary.json-a koji postoji SAMO lokalno (nikad se ne push-a u cloud
# CH). Zato i --cloud mod čita lokalni CH, a mijenja se samo PG cilj. Jedan izvor
# istine (lokalni CH), dva PG odredišta.
#
# Mehanika (dependency-free, kao sync-speakers.sh): CH → `clickhouse-client` TSV,
# transform plain `python3`-om (scripts/emit_person_mentions_sql.py, samo stdlib),
# PG → `psql`. Sve preko `docker exec` (lokalni CH i lokalni PG) ili `ssh docker
# exec` (cloud PG).
#
# launchd daje minimalan PATH — prepend Homebrew/usr-local.
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

set -euo pipefail
cd "$(dirname "$0")/.."
REPO="$(pwd)"

# shellcheck disable=SC1091
[ -f .env ] && { set -a; . ./.env; set +a; }

PY="${MENTIONS_PYTHON:-python3}"

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

# Izvor je UVIJEK lokalni CH (vidi header).
LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-$(docker ps --filter name=postgres --format '{{.Names}}' | grep -i domovina | head -1)}"

CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"
PG_DB="${POSTGRES_DB:-rag}"
PG_USER="${POSTGRES_USER:-rag_user}"

TARGET="local"
[ "${1:-}" = "--cloud" ] && TARGET="cloud"

log() { echo "[mentions-sync $(date +%H:%M:%S)] $*"; }

# FINAL da dedup-a ReplacingMergeTree prije nego što ga proslijedimo emitteru.
RAW_QUERY="SELECT youtube_id, channel, toString(upload_date), title, person, toString(mention_ts) FROM episode_mentions FINAL"

# Idempotentni bootstrap sheme (cloud PG nema person_mentions do prve migracije;
# IF NOT EXISTS je bezopasan svugdje). Mora se poklapati s init.sql + migrations/003+004.
# ADD COLUMN IF NOT EXISTS nadogradi već-postojeću tablicu (mention_ts, migr. 004).
read -r -d '' SCHEMA_SQL <<'SQL' || true
CREATE TABLE IF NOT EXISTS person_mentions (
    slug TEXT NOT NULL, youtube_id TEXT NOT NULL, channel TEXT NOT NULL,
    title TEXT, upload_date DATE, mention_ts INT DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (slug, youtube_id));
ALTER TABLE person_mentions ADD COLUMN IF NOT EXISTS mention_ts INT DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_person_mentions_slug ON person_mentions(slug);
SQL

[ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"
ch_query() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }

if [ "$TARGET" = "local" ]; then
  [ -n "$LOCAL_PG_CONTAINER" ] || { echo "ERROR: lokalni PG container nije up." >&2; exit 1; }
  pg_apply() { docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q; }
  pg_count() { docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM person_mentions;"; }
  log "Cilj: LOKALNI PG ($LOCAL_PG_CONTAINER), izvor CH ($LOCAL_CH_CONTAINER)"
else
  [ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }
  # Cloud PG dijeli Coolify stack-UUID s cloud CH containerom (clickhouse-<UUID>-<ts>).
  # Na hostu ima više postgres containera — stack-UUID je jedini pouzdan diskriminator.
  CLOUD_CH=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=clickhouse --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_CH" ] || { echo "ERROR: cloud CH container nije pronađen (za stack-UUID)." >&2; exit 1; }
  STACK_UUID=$(printf '%s' "$CLOUD_CH" | sed -E 's/^clickhouse-([a-z0-9]+)-.*/\1/')
  CLOUD_PG=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=postgres-$STACK_UUID --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_PG" ] || { echo "ERROR: cloud PG container (stack $STACK_UUID) nije pronađen." >&2; exit 1; }
  pg_apply() { ssh $SSH_OPTS "$SSH_HOST" "docker exec -i $CLOUD_PG psql -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1 -q"; }
  pg_count() { ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_PG psql -U $PG_USER -d $PG_DB -tAc 'SELECT count(*) FROM person_mentions;'"; }
  log "Cilj: CLOUD PG ($CLOUD_PG @ $SSH_HOST), izvor CH ($LOCAL_CH_CONTAINER, lokalni)"
fi

# 1. Osiguraj shemu (idempotentno).
printf '%s\n' "$SCHEMA_SQL" | pg_apply
log "Shema osigurana."

# 2. CH → TSV → SQL → PG. Generiraj u temp fajl (da vidimo broj redova prije apply-a).
TMP_SQL="$(mktemp -t person_mentions_sql.XXXXXX)"
trap 'rm -f "$TMP_SQL"' EXIT
ch_query "$RAW_QUERY" | "$PY" scripts/emit_person_mentions_sql.py > "$TMP_SQL"
log "SQL generiran ($(wc -l < "$TMP_SQL" | tr -d ' ') linija)."

# 3. Apply.
pg_apply < "$TMP_SQL"
COUNT=$(pg_count | tr -d '[:space:]')
log "✅ person_mentions populiran ($TARGET): $COUNT redova."
