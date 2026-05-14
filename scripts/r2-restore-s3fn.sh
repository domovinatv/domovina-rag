#!/usr/bin/env bash
# scripts/r2-restore-s3fn.sh — restore CH rag_chunks iz R2 preko s3() table funkcije.
#
# Razlika prema r2-restore-native.sh:
#   - Ne treba wrangler/jq na host-u (CH server sam pull-a iz R2)
#   - Pokreni unutar CH containera (Coolify Terminal) — koristi `clickhouse-client` lokalno
#   - Radi samo za single-object snapshote (NE multipart .part-aa/.part-ab)
#   - CH container mora imati env vars: R2_ENDPOINT_URL, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY
#     (proslijeđeno preko docker-compose.yml; Coolify env vars na CH resource-u)
#
# Usage (unutar Coolify CH container Terminal-a):
#   curl -fsSL https://raw.githubusercontent.com/.../scripts/r2-restore-s3fn.sh | \
#     SNAPSHOT=rag_chunks-YYYYMMDD-HHMM bash
#
#   # ili copy file na container, pa:
#   SNAPSHOT=rag_chunks-20260513-1451 bash r2-restore-s3fn.sh
#
# Preduvjeti:
#   1. R2 bucket sadrži `${SNAPSHOT}.native.zst` (single object, ne split)
#   2. CH container env vars R2_* set (provjeri s `env | grep ^R2_`)
#   3. Schema (`rag_chunks` tablica) već postoji u bazi `rag`
#
# Vidi: docs/cloud_deployment_plan.md §Faza 3, [[lessons_coolify_ch_restore_s3fn]]
set -euo pipefail

: "${SNAPSHOT:?Set SNAPSHOT env var, npr: SNAPSHOT=rag_chunks-YYYYMMDD-HHMM}"
: "${BUCKET:=domovina-rag-snapshots}"
: "${CLOUDFLARE_ACCOUNT_ID:=7dc7167b7e2e00923bfa7cd697df14e4}"
: "${CLICKHOUSE_USER:?CLICKHOUSE_USER not set}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD not set}"
: "${CLICKHOUSE_DB:=rag}"
: "${R2_ACCESS_KEY_ID:?R2_ACCESS_KEY_ID not set in CH container env}"
: "${R2_SECRET_ACCESS_KEY:?R2_SECRET_ACCESS_KEY not set in CH container env}"

KEY="${SNAPSHOT}.native.zst"
URL="https://${CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com/${BUCKET}/${KEY}"

echo "[restore-s3fn] Snapshot: $SNAPSHOT"
echo "[restore-s3fn] URL: $URL"
echo "[restore-s3fn] Target: ${CLICKHOUSE_DB}.rag_chunks"

# Pre-check schema
TABLES=$(clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  -d "$CLICKHOUSE_DB" --query "SHOW TABLES LIKE 'rag_chunks'" 2>/dev/null || true)
if [ -z "$TABLES" ]; then
  echo "ERROR: rag_chunks tablica ne postoji u bazi ${CLICKHOUSE_DB}." >&2
  echo "       Init.sql nije runan — runni infra/clickhouse/init.sql ručno prije restore-a." >&2
  exit 1
fi

BEFORE=$(clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  -d "$CLICKHOUSE_DB" --query "SELECT count() FROM rag_chunks")
echo "[restore-s3fn] Rows prije: $BEFORE"

clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  -d "$CLICKHOUSE_DB" --send_timeout 1800 --receive_timeout 1800 \
  --query "
INSERT INTO rag_chunks
SELECT * FROM s3(
  '${URL}',
  '${R2_ACCESS_KEY_ID}',
  '${R2_SECRET_ACCESS_KEY}',
  'Native'
)
SETTINGS
  s3_truncate_on_insert = 0,
  max_insert_threads = 4,
  input_format_parallel_parsing = 0
"

AFTER=$(clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  -d "$CLICKHOUSE_DB" --query "SELECT count() FROM rag_chunks")
echo "[restore-s3fn] Rows poslije: $AFTER"
echo "[restore-s3fn] Inserted: $((AFTER - BEFORE))"

echo
echo "Verifikacija:"
clickhouse-client -u "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" \
  -d "$CLICKHOUSE_DB" --query "
SELECT
  count() AS chunks,
  uniqExact(youtube_id) AS episodes,
  uniqExact(channel) AS channels,
  min(upload_date) AS oldest,
  max(upload_date) AS newest
FROM rag_chunks
FORMAT Vertical
"
