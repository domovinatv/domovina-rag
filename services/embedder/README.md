# Embedder Service

> **Status:** ✅ Faza 1 implementirano i smoke-testano.

FastAPI servis koji wrapa `BAAI/bge-m3` (MIT licenca) za on-demand text embedding.

Glavne uporabe:
- **ETL ingest**: batch embed-a chunkove iz `*.rag_combined.jsonl` prije insert-a u CH
- **MCP search**: query-time embed user query-ja prije CH cosine search-a

## API

```
GET /health
→ {"status":"ok","model":"BAAI/bge-m3","loaded":true}

POST /embed
Body: {"texts": ["string1", "string2", ...]}
→ {"vectors": [[1024 float32, L2-normalized], ...]}
```

`texts` može imati 1..N stringova. Limit NIJE broj znakova nego memorijski
budžet: attention košta `≈ 244 × batch × n²` bajtova (n = tokena), pa embedder
sam slaže tekstove u više prolaza da ostane ispod `EMBEDDER_MEM_BUDGET_GB`.

413 dobiješ samo ako tekst ne stane ni **sam** (`n > √(budžet / 244)`, pri 4,5 GB
to je 4295 tokena) ili ako batch prelazi `EMBEDDER_MAX_BATCH`. Redoslijed
vektora uvijek odgovara redoslijedu ulaza, bez obzira na interno grupiranje.

Vidi `docs/mps-embedder-memory.md` §6.

## Stack

- Python 3.11+ (Linux container) ili Python 3.13 (host macOS/MPS dev)
- FastAPI + uvicorn
- `sentence-transformers` 3.2+ (Apache 2.0)
- PyTorch s CPU / CUDA / MPS backend

## Env varijable

| Naziv | Default | Opis |
|---|---|---|
| `EMBEDDER_MODEL` | `BAAI/bge-m3` | HF model ID |
| `EMBEDDER_DEVICE` | `cpu` | `cpu`, `cuda`, ili `mps` (Apple Silicon) |
| `EMBEDDER_BATCH_SIZE` | `32` | Internal SentenceTransformer batch size |
| `EMBEDDER_MAX_BATCH` | `256` | Max strings u jednom `/embed` POST-u |
| `EMBEDDER_MEM_BUDGET_GB` | `4.5` | Budžet nad `244 × batch × n²`; iz njega ispada limit tokena po tekstu |
| `EMBEDDER_MAX_TEXT_CHARS` | `500000` | Gruba brana prije tokenizacije (ne zamjena za budžet) |
| `EMBEDDER_MPS_CAP_GB` | `8.0` | **Tvrda** kapica MPS alokacije procesa (`torch.mps.set_per_process_memory_fraction`). Prekoračenje digne RuntimeError umjesto da sruši stroj |
| ~~`EMBEDDER_MAX_TEXT_LEN`~~ | — | **Ukinut** — rezao po znakovima umjesto po tokenima. Ostane li u env-u, ignorira se uz WARNING |
| `EMBEDDER_WARMUP` | `1` | Eager load model on boot (=1) ili lazy (=0) |
| `LOG_LEVEL` | `INFO` | Standard Python logging |

## Backend performance (M3 Pro Mac Mini, bge-m3)

| Mode | Per single text (~2K chars) | Batch 32 | Napomena |
|---|---|---|---|
| **CPU container** | ~1500ms | ~30s | Pinned svih CPU jezgri, thermal throttling preko ~100°C |
| **MPS host** | ~37ms | ~1.2s | ~40× speedup; GUI stutter ako sustained batch |
| **CUDA (NVIDIA dev)** | ~10ms | ~300ms | Reference target |

Za bulk ingest na Mac-u: **MPS host workflow** (vidi sekciju ispod).

## Pokretanje

### Containerized (production, Linux)

```bash
# Iz repo root-a
docker compose up -d embedder

# Embedder će prvi put downloadati bge-m3 weights (~2 GB) iz HF u hf_cache volume.
# Sljedeći boot-ovi su brzi.

# Health check
docker compose exec embedder curl -s http://localhost:8000/health
```

### Host MPS (Apple Silicon dev)

Nije containerized — Docker Desktop na macOS-u ne prosljeđuje MPS u kontejner. Vrti se native na hostu.

```bash
# Jednokratno setup
cd services/embedder
python3 -m venv .venv
.venv/bin/pip install fastapi==0.115.0 'uvicorn[standard]==0.32.0' pydantic==2.9.2 \
                     'torch>=2.6.0' 'sentence-transformers>=3.2' 'transformers>=4.45' \
                     sentencepiece

# Pokreni (na svaki dev start)
EMBEDDER_DEVICE=mps \
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
```

Drugi kontejneri zovu `http://host.docker.internal:8000` (Docker Desktop gateway). `.env` mora imati:
```
EMBEDDER_URL=http://host.docker.internal:8000
```

### Standalone HTTP test

```bash
# Embed jedan tekst
curl -X POST http://localhost:8000/embed \
  -H "Content-Type: application/json" \
  -d '{"texts": ["iskustvo kliničke smrti"]}' | jq '.vectors[0][:5]'
# Vraća prvih 5 floata iz 1024-d vektora
```

## ⚠️ Što treba paziti

- **NE u produkciji s MPS device-om.** Linux servere nemaju MPS. Cloud deploy MORA biti `EMBEDDER_DEVICE=cpu` (default override u `docker-compose.yml` cloud env-u).
- **Apple Silicon GUI freeze pri sustained batch-evima** — vidi [memory: project-mps-embedder-host](https://github.com/anthropics/claude-code) detalji. Ako Mac postane neresponzivan tijekom ingest-a, koristi `--batch-size 4` (ne 16).
- **First boot weights download** je ~2 GB iz HF. Treba `web` network attached. Nakon prvog cache hita persistira u `hf_cache` volume.
- **Disk requirement**: ~10 GB free za weights + dependencies + Docker layers.

## Speaker embedding bilješka

Per-speaker voice embeddings (TitaNet-Large, pyannote-wespeaker34) se **NE rade ovdje** — to je posao producer repa ([`fetch.domovina.tv/colab_speaker_embeddings/`](https://github.com/domovinatv/fetch.domovina.tv)). Ovaj service radi samo **tekstualne** embeddinge.

Speaker entity resolution (mapiranje `SPEAKER_XX` → kanonska imena) je Faza 3, koristit će ensembled voice embeddings iz producer side-a — vidi plan §15.
