# Embedder Service

**Status:** 🚧 Stub — implementacija slijedi.

FastAPI servis koji wrapa `BAAI/bge-m3` (MIT licenca) za on-demand query embedding.

## Planirani API

```
POST /embed
Body: {"texts": ["pitanje korisnika", ...]}
Response: {"vectors": [[1024 floats, L2-normalized], ...]}
```

## Stack

- Python 3.11+
- FastAPI
- `sentence-transformers` (Apache 2.0)
- PyTorch (CPU / CUDA / MPS)

## Konfig

Env varijable:
- `EMBEDDER_MODEL=BAAI/bge-m3` (alternative: `intfloat/multilingual-e5-large`)
- `EMBEDDER_DEVICE=cpu` (`cuda` ili `mps` ako dostupno)
- `EMBEDDER_BATCH_SIZE=32`

## Bilješka o speaker embedding-zima

Per-speaker voice embeddings (TitaNet, pyannote-wespeaker34) se NE rade ovdje — to je posao
producer repa (`fetch.domovina.tv/colab_speaker_embeddings/`). Ovaj service radi samo
**tekstualne** embeddinge za query.
