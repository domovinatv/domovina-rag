#!/usr/bin/env bash
# scripts/r2-restore.sh — restore CH `rag_chunks` iz R2 snapshot-a.
# Pokreni NA CLOUD VPS-u (Coolify host), nakon što tamošnji CH ima
# config.d/r2_backup.xml i R2_* env vars postavljene.
#
# Usage:
#   SNAPSHOT=snapshot-20260513-0145.zip ./scripts/r2-restore.sh
#   SNAPSHOT=snapshot-latest.zip ./scripts/r2-restore.sh
#
set -euo pipefail

: "${SNAPSHOT:?Set SNAPSHOT env var, npr: SNAPSHOT=snapshot-YYYYMMDD-HHMM.zip}"
: "${CLICKHOUSE_USER:=rag_user}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije postavljen}"
: "${CLICKHOUSE_DB:=rag}"

CH_CONTAINER=$(docker ps --filter "name=clickhouse" --format "{{.Names}}" | head -1)
if [ -z "$CH_CONTAINER" ]; then
  echo "ERROR: ClickHouse container nije up." >&2
  exit 1
fi

echo "[r2-restore] Pre-restore stats (lokalni CH):"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() AS existing_chunks FROM rag_chunks FORMAT Vertical" 2>/dev/null || \
  echo "rag_chunks ne postoji još (svjež CH)"

echo "[r2-restore] Provjera r2_backup disk-a..."
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  --query "SELECT name, type FROM system.disks WHERE name='r2_backup' FORMAT Vertical"

echo "[r2-restore] Pokrećem RESTORE TABLE rag.rag_chunks FROM Disk('r2_backup','$SNAPSHOT')..."
# AS = restore u istu tablicu, ALLOW_NON_EMPTY_TABLES=0 default-no fail-a ako tablica nije prazna.
# Ako želiš overwrite: prvo `TRUNCATE TABLE rag.rag_chunks`.
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "RESTORE TABLE rag.rag_chunks FROM Disk('r2_backup', '$SNAPSHOT')"

echo "[r2-restore] Post-restore verifikacija:"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() AS chunks, uniqExact(episode_id) AS episodes, uniqExact(youtube_id) AS yt_ids FROM rag_chunks FORMAT Vertical"

echo "[r2-restore] Done."
