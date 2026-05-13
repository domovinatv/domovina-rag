#!/usr/bin/env bash
# scripts/r2-backup.sh — snapshot lokalne CH baze (rag.rag_chunks) u R2 bucket
# preko CH-ove BACKUP TABLE komande (S3 disk).
#
# Preduvjeti:
#   1. .env popunjen s R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#      (bucket: domovina-rag-snapshots, vidi docs/cloud_deployment_plan.md §Faza 0).
#   2. ClickHouse je restart-an POSLIJE prvog popunjavanja R2 env vars-a
#      (config.d/r2_backup.xml se učita samo na start CH-a).
#
# Usage:
#   ./scripts/r2-backup.sh                  # snapshot-YYYYMMDD-HHMM.zip
#   ./scripts/r2-backup.sh latest           # custom suffix → snapshot-latest.zip
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env ne postoji. Kopiraj .env.example pa popuni." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${R2_ENDPOINT_URL:?R2_ENDPOINT_URL nije postavljen u .env}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID nije postavljen u .env}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY nije postavljen u .env}"
: "${CLICKHOUSE_USER:?}" ; : "${CLICKHOUSE_PASSWORD:?}" ; : "${CLICKHOUSE_DB:?}"

SUFFIX="${1:-$(date +%Y%m%d-%H%M)}"
SNAPSHOT="snapshot-${SUFFIX}.zip"

CH_CONTAINER=$(docker ps --filter "name=clickhouse" --format "{{.Names}}" | head -1)
if [ -z "$CH_CONTAINER" ]; then
  echo "ERROR: ClickHouse container nije up." >&2
  exit 1
fi

echo "[r2-backup] Provjera da je r2_backup disk učitan u CH..."
HAS_DISK=$(docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT count() FROM system.disks WHERE name='r2_backup'" 2>/dev/null || echo 0)
if [ "$HAS_DISK" -ne 1 ]; then
  echo "ERROR: r2_backup disk nije u system.disks." >&2
  echo "       Vjerojatno treba restart CH-a poslije popunjavanja R2 env vars-a:" >&2
  echo "       docker compose restart clickhouse" >&2
  exit 1
fi

echo "[r2-backup] Pre-snapshot stats:"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() AS chunks, uniqExact(episode_id) AS episodes, formatReadableSize(sum(bytes_on_disk)) AS size FROM system.parts JOIN (SELECT count() c FROM rag_chunks) USING () WHERE table='rag_chunks' AND active FORMAT Vertical" 2>/dev/null || \
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() AS chunks, uniqExact(episode_id) AS episodes FROM rag_chunks FORMAT Vertical"

echo "[r2-backup] Pokrećem BACKUP TABLE → Disk('r2_backup','$SNAPSHOT')..."
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "BACKUP TABLE rag.rag_chunks TO Disk('r2_backup', '$SNAPSHOT')"

echo "[r2-backup] Provjera u system.backups (zadnji):"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT name, status, num_files, formatReadableSize(total_size) AS size, error FROM system.backups ORDER BY start_time DESC LIMIT 1 FORMAT Vertical"

echo "[r2-backup] Done. R2 key: $SNAPSHOT"
echo "[r2-backup] Za RESTORE na cloud CH vidi: scripts/r2-restore.sh"
