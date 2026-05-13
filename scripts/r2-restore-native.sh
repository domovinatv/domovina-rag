#!/usr/bin/env bash
# scripts/r2-restore-native.sh — restore CH rag_chunks iz multipart native dumpa.
# Pokrene na CLOUD VPS-u (Coolify host) za bootstrap clean baze.
#
# Strategy:
#   1. Download manifest iz R2
#   2. Download sve parts (wrangler r2 object get)
#   3. Verify SHA256 svakog parta
#   4. cat parts | zstd -d | clickhouse-client INSERT FORMAT Native
#
# Usage:
#   SNAPSHOT=rag_chunks-20260513-1145 ./scripts/r2-restore-native.sh
#     # ili
#   SNAPSHOT=rag_chunks-20260513-1145 ./scripts/r2-restore-native.sh --dry-run
#
set -euo pipefail

: "${SNAPSHOT:?Set SNAPSHOT env var, npr: SNAPSHOT=rag_chunks-YYYYMMDD-HHMM}"
: "${BUCKET:=domovina-rag-snapshots}"
: "${CLICKHOUSE_USER:=rag_user}"
: "${CLICKHOUSE_PASSWORD:?CLICKHOUSE_PASSWORD nije postavljen}"
: "${CLICKHOUSE_DB:=rag}"

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

MANIFEST_KEY="${SNAPSHOT}.manifest.json"
MANIFEST_FILE="$TMP/$MANIFEST_KEY"

if ! command -v wrangler >/dev/null 2>&1; then
  echo "ERROR: wrangler nije instaliran. npm i -g wrangler" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq nije instaliran. apt-get install jq" >&2
  exit 1
fi

echo "[restore] Fetching manifest $MANIFEST_KEY..."
wrangler r2 object get "$BUCKET/$MANIFEST_KEY" --file "$MANIFEST_FILE" --remote

echo "[restore] Manifest:"
jq . "$MANIFEST_FILE"

CHUNKS=$(jq -r '.chunks' "$MANIFEST_FILE")
SHA_FULL=$(jq -r '.sha256_full' "$MANIFEST_FILE")
PARTS=$(jq -r '.parts[] | "\(.key)|\(.size)|\(.sha256)"' "$MANIFEST_FILE")

echo "[restore] $CHUNKS chunkova očekivano, $(echo "$PARTS" | wc -l | tr -d ' ') parts"

if [ "$DRY_RUN" = "1" ]; then
  echo "[restore] DRY-RUN — done."
  exit 0
fi

echo "[restore] Downloading parts..."
while IFS='|' read -r key size sha; do
  echo "  - $key ($size bytes)"
  wrangler r2 object get "$BUCKET/$key" --file "$TMP/$key" --remote
  ACTUAL_SHA=$(shasum -a 256 "$TMP/$key" | awk '{print $1}')
  if [ "$ACTUAL_SHA" != "$sha" ]; then
    echo "ERROR: SHA mismatch za $key. Expected: $sha, got: $ACTUAL_SHA" >&2
    exit 1
  fi
done <<< "$PARTS"

CH_CONTAINER=$(docker ps --filter "name=clickhouse" --format "{{.Names}}" | head -1)
if [ -z "$CH_CONTAINER" ]; then
  echo "ERROR: ClickHouse container nije up." >&2
  exit 1
fi

# Verify full assembled SHA (cat + sha256)
echo "[restore] Verifying assembled SHA256..."
ACTUAL_FULL=$(cat $(jq -r '.parts[].key' "$MANIFEST_FILE" | sed "s|^|$TMP/|" | tr '\n' ' ') | shasum -a 256 | awk '{print $1}')
if [ "$ACTUAL_FULL" != "$SHA_FULL" ]; then
  echo "ERROR: Assembled SHA mismatch. Expected: $SHA_FULL, got: $ACTUAL_FULL" >&2
  exit 1
fi
echo "[restore] SHA OK."

echo "[restore] Pre-restore count u CH:"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() FROM rag_chunks" 2>/dev/null || echo "(tablica ne postoji)"

echo "[restore] Streaming parts → zstd -d → CH INSERT..."
cat $(jq -r '.parts[].key' "$MANIFEST_FILE" | sed "s|^|$TMP/|" | tr '\n' ' ') | \
  zstd -d | \
  docker exec -i "$CH_CONTAINER" clickhouse-client \
    --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
    --query "INSERT INTO rag_chunks FORMAT Native"

echo "[restore] Post-restore verification:"
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() AS chunks, uniqExact(episode_id) AS episodes, uniqExact(youtube_id) AS yt_ids FROM rag_chunks FORMAT Vertical"

echo "[restore] Done."
