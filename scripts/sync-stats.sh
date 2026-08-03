#!/usr/bin/env bash
# scripts/sync-stats.sh — generiraj javni statistički snapshot (stats.json) iz
# ClickHouse-a i (opcionalno) deployaj na Cloudflare Pages (stats.domovina.ai).
#
# stats.json je DERIVAT ClickHouse-a (agregati nad rag_chunks), isto kao Meili
# index i PG speakers. Zato je dio dnevnog sync-a (sync-cron.sh), poslije CH delta
# push-a. Consumer je zaseban repo `domovina-stats` (frontend crta snapshot); ovaj
# skript samo puni njegov public/stats.json. Data contract:
# domovina-stats/docs/02-data-contract.md.
#
# Mehanika (dependency-free, uzor sync-speakers.sh): CH se čita preko
# `clickhouse-client` (docker exec lokalno ili ssh docker exec za --cloud),
# rezultati (FORMAT JSON) se sklope stdlib python-om (emit_stats_json.py).
#
# Usage:
#   scripts/sync-stats.sh                    # local CH → domovina-stats/public/stats.json
#   scripts/sync-stats.sh --cloud            # cloud CH → stats.json (source="cloud")
#   scripts/sync-stats.sh --cloud --deploy   # + npm build + wrangler pages deploy
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

PY="${STATS_PYTHON:-python3}"
STATS_REPO_DIR="${STATS_REPO_DIR:-$REPO/../domovina-stats}"
PAGES_PROJECT="${STATS_PAGES_PROJECT:-domovina-stats}"

SSH_KEY="${CLOUD_SSH_KEY:-$HOME/.ssh/dom-001-oracle-ssh-key-2026-04-20.key}"
SSH_HOST="${CLOUD_SSH_HOST:-ubuntu@89.168.100.120}"
SSH_OPTS="-i $SSH_KEY -o ConnectTimeout=20 -o StrictHostKeyChecking=accept-new"

LOCAL_CH_CONTAINER="${LOCAL_CH_CONTAINER:-$(docker ps --filter name=clickhouse --format '{{.Names}}' | grep -i domovina | head -1)}"
CH_DB="${CLICKHOUSE_DB:-rag}"
CH_USER="${CLICKHOUSE_USER:-rag_user}"

TARGET="local"
DEPLOY=0
for arg in "$@"; do
  case "$arg" in
    --cloud)  TARGET="cloud" ;;
    --deploy) DEPLOY=1 ;;
    *) echo "Nepoznat argument: $arg" >&2; exit 2 ;;
  esac
done

log() { echo "[stats-sync $(date +%H:%M:%S)] $*"; }

# ─── Konekcija (local ili cloud, discover container kao sync-speakers.sh) ──────
if [ "$TARGET" = "local" ]; then
  [ -n "$LOCAL_CH_CONTAINER" ] || { echo "ERROR: lokalni CH container nije up." >&2; exit 1; }
  : "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije set u .env}"
  ch_query() { docker exec -i "$LOCAL_CH_CONTAINER" clickhouse-client -d "$CH_DB" \
    --user "$CH_USER" --password "$CLICKHOUSE_PASSWORD" --query "$1"; }
  log "Izvor: LOKALNI CH ($LOCAL_CH_CONTAINER)"
else
  [ -f "$SSH_KEY" ] || { echo "ERROR: SSH ključ ne postoji: $SSH_KEY" >&2; exit 1; }
  CLOUD_CH=$(ssh $SSH_OPTS "$SSH_HOST" "docker ps --filter name=clickhouse --format '{{.Names}}' | head -1")
  [ -n "$CLOUD_CH" ] || { echo "ERROR: cloud CH container nije pronađen." >&2; exit 1; }
  CLOUD_CH_PW=$(ssh $SSH_OPTS "$SSH_HOST" "docker exec $CLOUD_CH printenv CLICKHOUSE_PASSWORD")
  ch_query() { ssh $SSH_OPTS "$SSH_HOST" \
    "docker exec -i $CLOUD_CH clickhouse-client -d $CH_DB --user $CH_USER --password $CLOUD_CH_PW --query \"$1\""; }
  log "Izvor: CLOUD CH ($CLOUD_CH @ $SSH_HOST)"
fi

# ─── Upiti (vidi domovina-stats/docs/02-data-contract.md) ─────────────────────
# length(youtube_id)=11 izbacuje junk orfane (npr. korumpirani "λ").
WHERE="length(youtube_id) = 11"

Q_TOTALS="SELECT count() AS chunks, uniqExact(youtube_id) AS episodes, uniqExact(channel) AS channels, round(sum(end_ts - start_ts) / 3600) AS hours, toString(min(upload_date)) AS first_date, toString(max(upload_date)) AS last_date FROM rag_chunks WHERE $WHERE FORMAT JSON"

# Svi distinct raw govornici (broj govornika + leaderboard računa emit_stats_json.py
# preko build_persons — isti dedup+role-filter kao person hub, pa se brojke slažu).
Q_SPEAKERS_RAW="SELECT trim(BOTH ' ' FROM arrayJoin(splitByChar(',', speaker))) AS raw, count() AS chunks, uniqExact(youtube_id) AS episodes, arrayStringConcat(arraySort(groupUniqArray(channel)), '|') AS channels FROM rag_chunks WHERE $WHERE GROUP BY raw HAVING raw != '' FORMAT JSON"

Q_CHANNELS="SELECT channel, uniqExact(youtube_id) AS episodes, count() AS chunks, round(sum(end_ts - start_ts) / 3600, 1) AS hours FROM rag_chunks WHERE $WHERE GROUP BY channel ORDER BY episodes DESC FORMAT JSON"

Q_TIMELINE="SELECT toString(toStartOfMonth(upload_date)) AS month, uniqExact(youtube_id) AS episodes, count() AS chunks FROM rag_chunks WHERE $WHERE AND upload_date >= '2010-01-01' GROUP BY month ORDER BY month FORMAT JSON"

# ─── Izvrši + sklopi ──────────────────────────────────────────────────────────
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

log "Izvršavam upite..."
ch_query "$Q_TOTALS"       > "$WORK/totals.json"
ch_query "$Q_SPEAKERS_RAW" > "$WORK/speakers_raw.json"
ch_query "$Q_CHANNELS"     > "$WORK/channels.json"
ch_query "$Q_TIMELINE"     > "$WORK/timeline.json"

GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
OUT_DIR="$STATS_REPO_DIR/public"
[ -d "$OUT_DIR" ] || mkdir -p "$OUT_DIR"
OUT="$OUT_DIR/stats.json"

"$PY" scripts/emit_stats_json.py \
  --totals       "$WORK/totals.json" \
  --speakers-raw "$WORK/speakers_raw.json" \
  --channels     "$WORK/channels.json" \
  --timeline     "$WORK/timeline.json" \
  --generated-at "$GENERATED_AT" \
  --source       "$TARGET" \
  > "$OUT"

log "✅ Snapshot zapisan: $OUT (source=$TARGET, $GENERATED_AT)"

# ─── Deploy (opcionalno) ──────────────────────────────────────────────────────
if [ "$DEPLOY" -eq 1 ]; then
  [ -d "$STATS_REPO_DIR" ] || { echo "ERROR: stats repo ne postoji: $STATS_REPO_DIR" >&2; exit 1; }
  command -v npx >/dev/null || { echo "ERROR: npx/node nije instaliran." >&2; exit 1; }
  : "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN nije set u .env (Pages:Edit token)}"
  if [ ! -f "$STATS_REPO_DIR/package.json" ]; then
    log "WARN: $STATS_REPO_DIR nema package.json (frontend još nije scaffoldan) — preskačem deploy."
    exit 0
  fi
  log "Build + deploy na CF Pages ($PAGES_PROJECT)..."
  ( cd "$STATS_REPO_DIR" && npm run build

    # dist bez public/ ima ~8 fajlova (samo build output), s podacima ~74. Deploy
    # praznog dista je tih: sajt se digne, ali svi grafovi i mape ostanu prazni.
    n="$(find dist -type f | wc -l | tr -d ' ')"
    [ "$n" -ge 20 ] || { echo "ERROR: dist ima samo $n fajlova — public/ je prazan, ne deployam." >&2; exit 1; }

    # --branch main je OBAVEZAN: bez njega wrangler deploya na preview alias
    # imena trenutne grane, produkcija se ne mijenja, a izlaz i dalje kaže
    # "Success". Vidi ../domovina-stats/CLAUDE.md § Deploy.
    npx wrangler pages deploy dist --project-name="$PAGES_PROJECT" --branch main )
  log "✅ Deploy gotov → stats.domovina.ai"
fi
