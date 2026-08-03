#!/usr/bin/env bash
# scripts/sync-speakers.sh — (re)populiraj "person hub" (PG `speakers`) iz
# ClickHouse-a. Radi lokalno ILI prema cloud PG-u (preko SSH-a).
#
# speakers tablica je DERIVAT ClickHouse-a (distinct govornici → normalizacija →
# slug + aliases), pa je re-populate jeftin i idempotentan (slugovi stabilni,
# UPSERT + prune). Dio dnevnog sync-a (sync-cron.sh), poslije CH delta push-a i
# Meili re-indexa. Bez toga /api/person/{slug} vraća stare/nedostajuće profile.
#
# Mehanika (namjerno dependency-free): CH se čita preko `clickhouse-client`,
# transformira plain `python3`-om (scripts/emit_speakers_sql.py, samo stdlib),
# a PG puni preko `psql` — sve preko `docker exec` (lokalno) ili `ssh docker
# exec` (cloud). Nema venva, nema tunela, nema per-row latencije.
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

PY="${SPEAKERS_PYTHON:-python3}"

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
LOCAL_PG_CONTAINER="${LOCAL_PG_CONTAINER:-$(docker ps --filter name=postgres --format '{{.Names}}' | grep -i domovina | head -1)}"

CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"
PG_DB="${POSTGRES_DB:-rag}"
PG_USER="${POSTGRES_USER:-rag_user}"

TARGET="local"
[ "${1:-}" = "--cloud" ] && TARGET="cloud"

log() { echo "[speakers-sync $(date +%H:%M:%S)] $*"; }

RAW_QUERY="SELECT trim(BOTH ' ' FROM arrayJoin(splitByChar(',', speaker))) AS raw, count() AS chunks, uniqExact(youtube_id) AS episodes, arrayStringConcat(arraySort(groupUniqArray(channel)), '|') AS channels FROM rag_chunks GROUP BY raw HAVING raw != ''"

# Idempotentni bootstrap sheme (cloud PG je imao samo oauth_* tablice; lokalni
# ima cijelu Faza-1 shemu, ali IF NOT EXISTS je bezopasan svugdje).
read -r -d '' SCHEMA_SQL <<'SQL' || true
CREATE EXTENSION IF NOT EXISTS vector;
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
CREATE TABLE IF NOT EXISTS speakers (
    id BIGSERIAL PRIMARY KEY, canonical_name TEXT NOT NULL, slug TEXT UNIQUE,
    avatar_url TEXT, aliases JSONB DEFAULT '[]'::jsonb, voice_embedding_avg VECTOR(192),
    channels JSONB DEFAULT '[]'::jsonb, confidence FLOAT DEFAULT 0.5,
    needs_review BOOLEAN DEFAULT TRUE, created_at TIMESTAMPTZ DEFAULT now(),
    updated_at TIMESTAMPTZ DEFAULT now());
CREATE INDEX IF NOT EXISTS idx_speakers_slug ON speakers(slug);
CREATE INDEX IF NOT EXISTS idx_speakers_aliases ON speakers USING gin (aliases);
DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='speakers_updated_at') THEN
    CREATE TRIGGER speakers_updated_at BEFORE UPDATE ON speakers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
END IF; END $$;
SQL

if [ "$TARGET" = "local" ]; then
  [ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
  [ -n "$LOCAL_PG_CONTAINER" ] || { echo "ERROR: lokalni PG container nije up." >&2; exit 1; }
  : "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"
  ch_query() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }
  pg_apply() { docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -v ON_ERROR_STOP=1 -q; }
  log "Cilj: LOKALNI PG ($LOCAL_PG_CONTAINER), izvor CH ($LOCAL_CH_CONTAINER)"
else
  [ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }
  CLOUD_CH=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=clickhouse --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_CH" ] || { echo "ERROR: cloud CH container nije pronađen." >&2; exit 1; }
  # RAG PG dijeli Coolify stack-UUID s CH containerom (clickhouse-<UUID>-<ts>).
  # Na hostu ima više postgres containera (supabase, coolify, drugi projekti) —
  # stack-UUID je jedini pouzdan diskriminator.
  STACK_UUID=$(printf '%s' "$CLOUD_CH" | sed -E 's/^clickhouse-([a-z0-9]+)-.*/\1/')
  CLOUD_PG=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=postgres-$STACK_UUID --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_PG" ] || { echo "ERROR: cloud PG container (stack $STACK_UUID) nije pronađen." >&2; exit 1; }
  CLOUD_CH_PW=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_CH printenv CLICKHOUSE_PASSWORD")
  ch_query() { ssh $SSH_OPTS "$SSH_HOST" "docker exec -i $CLOUD_CH clickhouse-client -d $CH_DB --user $CH_USER --password $CLOUD_CH_PW --query \"$1\""; }
  pg_apply() { ssh $SSH_OPTS "$SSH_HOST" "docker exec -i $CLOUD_PG psql -U $PG_USER -d $PG_DB -v ON_ERROR_STOP=1 -q"; }
  log "Cilj: CLOUD PG ($CLOUD_PG @ $SSH_HOST), izvor CH ($CLOUD_CH)"
fi

# 1. Osiguraj shemu (idempotentno).
printf '%s\n' "$SCHEMA_SQL" | pg_apply
log "Shema osigurana."

# 2. CH → TSV → SQL → PG. Generiraj u temp fajl (da vidimo broj redova prije apply-a).
TMP_SQL="$(mktemp -t speakers_sql.XXXXXX)"
trap 'rm -f "$TMP_SQL"' EXIT
ch_query "$RAW_QUERY" | "$PY" scripts/emit_speakers_sql.py > "$TMP_SQL"
log "SQL generiran ($(wc -l < "$TMP_SQL" | tr -d ' ') linija)."

# 3. Apply.
pg_apply < "$TMP_SQL"
COUNT=$(printf '%s' "SELECT count(*) FROM speakers;" | { if [ "$TARGET" = "local" ]; then docker exec -i "$LOCAL_PG_CONTAINER" psql -U "$PG_USER" -d "$PG_DB" -tAc "SELECT count(*) FROM speakers;"; else ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_PG psql -U $PG_USER -d $PG_DB -tAc 'SELECT count(*) FROM speakers;'"; fi; })
log "✅ Person hub populiran ($TARGET): $COUNT osoba."
