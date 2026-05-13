#!/usr/bin/env bash
# scripts/r2-backup-native.sh — varijanta bez S3 disk-a u CH.
# Dump-a rag_chunks u Native format + zstd, upload u R2 preko wrangler
# (fallback: rclone). Ne diže CH restart, ne treba S3 API token.
#
# Koristi kad:
#   - ne želiš restart-ati CH za config.d mount
#   - R2 token nije S3-compatible (samo OAuth wrangler ili public CDN)
#   - testiraš brz dump bez CH konfiguracije
#
# Preduvjeti:
#   - `wrangler whoami` autentikiran (Cloudflare OAuth), ili
#   - `rclone config` s `r2:` remote-om kao backup
#   - CLOUDFLARE_ACCOUNT_ID env var ili u .env-u ako imaš više CF accounts
#
# Files u R2 nakon uspješnog runa (multipart):
#   bucket/
#     rag_chunks-YYYYMMDD-HHMM.manifest.json      ← metadata
#     rag_chunks-YYYYMMDD-HHMM.native.zst.part-aa ← chunk 1
#     rag_chunks-YYYYMMDD-HHMM.native.zst.part-ab ← chunk 2
#     ...
#
set -euo pipefail

cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  echo "ERROR: .env ne postoji." >&2
  exit 1
fi

# shellcheck disable=SC1091
set -a; . ./.env; set +a

: "${CLICKHOUSE_USER:?}"; : "${CLICKHOUSE_PASSWORD:?}"; : "${CLICKHOUSE_DB:?}"

BUCKET="${R2_BUCKET:-domovina-rag-snapshots}"
SUFFIX="${1:-$(date +%Y%m%d-%H%M)}"
OUT_DIR="${OUT_DIR:-./snapshots}"
OUT_FILE="${OUT_DIR}/rag_chunks-${SUFFIX}.native.zst"

mkdir -p "$OUT_DIR"

CH_CONTAINER=$(docker ps --filter "name=clickhouse" --format "{{.Names}}" | head -1)
if [ -z "$CH_CONTAINER" ]; then
  echo "ERROR: ClickHouse container nije up." >&2
  exit 1
fi

if ! command -v zstd >/dev/null 2>&1; then
  echo "ERROR: zstd nije instaliran. brew install zstd" >&2
  exit 1
fi

UPLOAD_TOOL=""
if command -v wrangler >/dev/null 2>&1; then
  UPLOAD_TOOL="wrangler"
elif command -v rclone >/dev/null 2>&1; then
  UPLOAD_TOOL="rclone"
else
  echo "WARN: ni wrangler ni rclone nisu instalirani. Dump će biti samo lokalno." >&2
fi

echo "[native-backup] Counting chunks..."
CHUNKS=$(docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT count() FROM rag_chunks")
echo "[native-backup] $CHUNKS chunkova"

echo "[native-backup] Dump → zstd -19 → $OUT_FILE..."
docker exec "$CH_CONTAINER" clickhouse-client \
  --user "$CLICKHOUSE_USER" --password "$CLICKHOUSE_PASSWORD" --database "$CLICKHOUSE_DB" \
  --query "SELECT * FROM rag_chunks FORMAT Native" \
  | zstd -19 -o "$OUT_FILE" -f

SIZE_BYTES=$(stat -f%z "$OUT_FILE" 2>/dev/null || stat -c%s "$OUT_FILE")
SIZE_MB=$(( SIZE_BYTES / 1024 / 1024 ))
SHA=$(shasum -a 256 "$OUT_FILE" | awk '{print $1}')
echo "[native-backup] Local: $OUT_FILE (${SIZE_MB} MiB)"
echo "[native-backup] SHA256: $SHA"

KEY=$(basename "$OUT_FILE")
WRANGLER_LIMIT_MB=270   # wrangler r2 object put limit je 300 MiB; safe margin 270

# Generate manifest (sadrži parts breakdown ako split, jedan part inače).
MANIFEST_FILE="${OUT_FILE%.native.zst}.manifest.json"

upload_with_wrangler() {
  local local_path="$1" remote_key="$2"
  if [ -n "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
    CLOUDFLARE_ACCOUNT_ID="$CLOUDFLARE_ACCOUNT_ID" \
      wrangler r2 object put "$BUCKET/$remote_key" --file "$local_path" --remote
  else
    wrangler r2 object put "$BUCKET/$remote_key" --file "$local_path" --remote
  fi
}

if [ "$UPLOAD_TOOL" = "wrangler" ] && [ "$SIZE_MB" -gt "$WRANGLER_LIMIT_MB" ]; then
  echo "[native-backup] File ${SIZE_MB} MiB > ${WRANGLER_LIMIT_MB} MiB → split + multipart upload..."
  SPLIT_PREFIX="${OUT_FILE}.part-"
  rm -f "${SPLIT_PREFIX}"*
  split -b "${WRANGLER_LIMIT_MB}m" "$OUT_FILE" "$SPLIT_PREFIX"

  # Build manifest s parts info
  PARTS_JSON=""
  for p in "${SPLIT_PREFIX}"*; do
    part_size=$(stat -f%z "$p" 2>/dev/null || stat -c%s "$p")
    part_sha=$(shasum -a 256 "$p" | awk '{print $1}')
    part_key=$(basename "$p")
    [ -n "$PARTS_JSON" ] && PARTS_JSON="$PARTS_JSON,"
    PARTS_JSON="$PARTS_JSON{\"key\":\"$part_key\",\"size\":$part_size,\"sha256\":\"$part_sha\"}"
  done

  cat > "$MANIFEST_FILE" <<MEOF
{
  "snapshot": "$(basename "${OUT_FILE%.native.zst}")",
  "format": "Native+zstd",
  "table": "rag.rag_chunks",
  "chunks": $CHUNKS,
  "uncompressed_bytes": $(du -k "$OUT_FILE" | cut -f1 | awk '{print $1*1024}'),
  "compressed_bytes": $SIZE_BYTES,
  "sha256_full": "$SHA",
  "parts": [$PARTS_JSON],
  "restore_cmd": "cat *.part-* | zstd -d | clickhouse-client --query 'INSERT INTO rag.rag_chunks FORMAT Native'"
}
MEOF

  echo "[native-backup] Upload manifest..."
  upload_with_wrangler "$MANIFEST_FILE" "$(basename "$MANIFEST_FILE")"

  for p in "${SPLIT_PREFIX}"*; do
    echo "[native-backup] Upload part: $(basename "$p") ($(du -h "$p" | cut -f1))"
    upload_with_wrangler "$p" "$(basename "$p")"
  done

  echo "[native-backup] Cleanup local parts (keeping full $OUT_FILE)..."
  rm -f "${SPLIT_PREFIX}"*

elif [ "$UPLOAD_TOOL" = "wrangler" ]; then
  cat > "$MANIFEST_FILE" <<MEOF
{
  "snapshot": "$(basename "${OUT_FILE%.native.zst}")",
  "format": "Native+zstd",
  "table": "rag.rag_chunks",
  "chunks": $CHUNKS,
  "compressed_bytes": $SIZE_BYTES,
  "sha256_full": "$SHA",
  "parts": [{"key": "$KEY", "size": $SIZE_BYTES, "sha256": "$SHA"}]
}
MEOF
  echo "[native-backup] Upload manifest + full file..."
  upload_with_wrangler "$MANIFEST_FILE" "$(basename "$MANIFEST_FILE")"
  upload_with_wrangler "$OUT_FILE" "$KEY"

elif [ "$UPLOAD_TOOL" = "rclone" ]; then
  echo "[native-backup] Upload preko rclone → r2:$BUCKET/..."
  rclone copy "$OUT_FILE" "r2:$BUCKET/" --progress

else
  echo "[native-backup] Skipping upload. Manual upload preko Cloudflare R2 UI:"
  echo "  → bucket: $BUCKET"
  echo "  → file:   $OUT_FILE"
fi

if [ -n "$UPLOAD_TOOL" ]; then
  echo "[native-backup] Done. Manifest: $BUCKET/$(basename "$MANIFEST_FILE")"
fi

cat <<EOF

Za RESTORE na cloud CH (alternativa S3 disk-u):

  # 1. scp file na VPS:
  scp $OUT_FILE vps:/tmp/

  # 2. na VPS-u (Coolify CH container ime može biti drugo):
  CONTAINER=\$(docker ps --filter "name=clickhouse" --format "{{.Names}}" | head -1)
  cat /tmp/$(basename "$OUT_FILE") | zstd -d | \\
    docker exec -i "\$CONTAINER" clickhouse-client \\
      --user $CLICKHOUSE_USER --password "\$CLICKHOUSE_PASSWORD" \\
      --database $CLICKHOUSE_DB --query "INSERT INTO rag_chunks FORMAT Native"

EOF
