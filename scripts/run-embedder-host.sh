#!/bin/bash
# Pokreće embedder natively na hostu s Apple Silicon MPS GPU acceleracijom.
#
# Kontejneri (mcp, etl) ga zovu preko `host.docker.internal:8000` —
# vidi `EMBEDDER_URL` u .env.
#
# Usage:
#   bash scripts/run-embedder-host.sh           # foreground, Ctrl-C za stop
#   bash scripts/run-embedder-host.sh &         # background
#   nohup bash scripts/run-embedder-host.sh > .ingest-logs/embedder-host.log 2>&1 &
#
# Setup (samo prvi put):
#   cd services/embedder && python3 -m venv .venv
#   .venv/bin/pip install fastapi==0.115.0 'uvicorn[standard]==0.32.0' pydantic==2.9.2 \
#                         'torch>=2.6.0' 'sentence-transformers>=3.2' 'transformers>=4.45' \
#                         sentencepiece

set -e

cd "$(dirname "$0")/../services/embedder"

if [ ! -f .venv/bin/python ]; then
  echo "ERROR: .venv ne postoji u services/embedder/. Vidi setup blok u headeru ovog scripta."
  exit 1
fi

# MPS GPU + povišen text limit (matchira compose embedder env).
export EMBEDDER_DEVICE=mps
export EMBEDDER_MODEL=BAAI/bge-m3
export EMBEDDER_MAX_TEXT_LEN=32768
export EMBEDDER_BATCH_SIZE=32

# Logging level (INFO default; DEBUG za debug).
export LOG_LEVEL=${LOG_LEVEL:-INFO}

# Pri prvom run-u sentence-transformers download bge-m3 weights (~2GB) u
# ~/.cache/huggingface/. Sljedeći run-ovi koriste cache.

echo "Starting host embedder on :8000 (device=mps)"
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log
