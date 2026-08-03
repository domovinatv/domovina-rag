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

# MPS GPU. MAX_TEXT_LEN=8192 i manji batch: bge-m3 attention je O(n²) i PyTorch
# MPS cache-a buffere → footprint je znao narasti na ~20 GB (od 24 unified) i
# segfaultati allocator. Uz to model.py sad zove torch.mps.empty_cache() nakon
# svakog batcha. Vidi lessons-mps-embedder-segfault + docs/mps-embedder-memory.md.
export EMBEDDER_DEVICE=mps
export EMBEDDER_MODEL=BAAI/bge-m3
# EMBEDDER_MAX_TEXT_LEN je ukinut — rezao je po znakovima, a trošak je po
# tokenima (~3,9 znaka/token za HR), pa je odbijao valjane chunkove. Zamjena je
# EMBEDDER_MEM_BUDGET_GB (default 4,5); embedder sam slaže prolaze ispod budžeta.
export EMBEDDER_BATCH_SIZE=8

# Logging level (INFO default; DEBUG za debug).
export LOG_LEVEL=${LOG_LEVEL:-INFO}

# Pri prvom run-u sentence-transformers download bge-m3 weights (~2GB) u
# ~/.cache/huggingface/. Sljedeći run-ovi koriste cache.

echo "Starting host embedder on :8000 (device=mps)"
exec .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000 --no-access-log
