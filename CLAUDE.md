# CLAUDE.md

Project-specific guidance za Claude Code agenta koji radi u ovom repu.

## Što je ovaj repo

**domovina-rag** = data consumer / agent backend za hrvatski podcast korpus.

Čita pripremljene podatke iz [`fetch.domovina.tv`](../fetch.domovina.tv) (data producer),
sprema u ClickHouse + PostgreSQL, eksponira preko MCP servera.

**Strict separation of concerns:**
- Producer repo radi: YouTube fetch, transkripcija, dijarizacija, summarization, article generation, RAG chunking, speaker embedding extraction
- Ovaj repo radi: import u DB, retrieval, MCP API, entity resolution, eval

Ako se zatekneš u skripti za fetch/convert/transkripciju — **prebaci se u fetch.domovina.tv** repo.

## Glavne reference

- **Arhitekturni plan**: [`../fetch.domovina.tv/docs/rag_clickhouse_postgres_plan.md`](../fetch.domovina.tv/docs/rag_clickhouse_postgres_plan.md)
- **Data contract**: [`../fetch.domovina.tv/docs/data_contract.md`](../fetch.domovina.tv/docs/data_contract.md)
- **Speaker entity resolution**: §15 plana

## Hard-defined odluke (NE mijenjati bez ADR-a)

| Odluka | Vrijednost | Razlog |
|---|---|---|
| Licenca | AGPL-3.0 | Force-share modifications za hosted service; sprječava proprietary fork-ove |
| Repo struktura | Mono s `services/` | Solo dev; lakše ako kasnije razdijeliš |
| Primarni DB roles | PG=OLTP, CH=OLAP+vectors | Vidi plan §2 |
| MCP transport | HTTP+SSE (prod), stdio (dev) | MCP spec standard |
| MCP auth (start) | API key | Private MCP do Faze 4 |
| MCP auth (later) | OAuth 2.1 + DCR | Public MCP, ako odlučiš |
| Embedding model | bge-m3 (default), bge-reranker-v2-m3 | MIT/Apache, multilingual, HR-friendly |
| Embedding dim | 1024 | bge-m3 standard |
| Speaker embedding model | TitaNet-Large + pyannote-wespeaker34 (ensemble) | Vidi plan §15.5 |
| LLM provider (default) | Vertex AI Gemini 2.5 Flash | gcloud OAuth, free credits, HR kvaliteta |

## Konvencije

### Jezik
- Sav user-facing tekst, komentari, dokumentacija = **hrvatski**
- Schema/code identifiers = engleski (industry standard)
- Strings vraćene MCP klijentima = hrvatski

### Code style
- **MCP server**: TypeScript (Node.js 22+), strict mode, ESM modules
- **Embedder/Reranker**: Python 3.11+, FastAPI, type hints svuda
- **SQL**: snake_case, sve tablice imaju `created_at` i `updated_at`
- **No abstractions premature**: 3 slična upita > nego "univerzalni query builder"

### Testing
- Embedder/reranker: pytest s mock model za brze unit testove
- MCP server: vitest, real PG/CH containers (testcontainers)
- Integration: docker-compose + manual smoke testovi

### Git
- Konvencionalni commits: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`
- Skopuovi: `mcp`, `embedder`, `reranker`, `infra`, `docs`
- Primjer: `feat(mcp): add search_podcasts tool with channel filter`

## Što NE raditi

- **Nemoj** kopirati podatke iz fetch.domovina.tv u ovaj repo. Pristup je preko data contract-a (R2 CDN, lokalni mount, ili rclone sync).
- **Nemoj** mijenjati shape `*.rag_combined.jsonl` ili drugih producer outputa ovdje — to je producerov posao, ovdje samo konzumiraš.
- **Nemoj** ubacivati API keys u repo — sve secrets idu kroz `.env` (ignored).
- **Nemoj** premature dodavati frontend kod — primarni frontend je `domovina.ai` repo, ili Claude.ai kao MCP klijent.

## Initial scope (Faza 1)

Minimal viable backend:

1. PostgreSQL s minimalnom shemom (`episodes`, `speakers` placeholder)
2. ClickHouse s `rag_chunks` tablicom + USearch HNSW indeks
3. Embedder service (bge-m3 preko FastAPI)
4. MCP server s **jednim alatom**: `search_podcasts(query, channel?, limit?)`
5. ETL skripta: čita `*.rag_combined.jsonl` iz lokalnog mount-a, batch insert u CH
6. docker-compose koji sve gore pokrene + minimal health checks

Bez: reranker, multi-model embedding ensemble, OAuth, frontend, eval rig. To dolazi u Fazi 2-4.

## Lokalni razvoj

Compose file je na repo root-u (`docker-compose.yml`). Init skripte za DB-ove
ostaju u `infra/{postgres,clickhouse}/init.sql`.

```bash
# Sve servise (pg + ch + embedder + mcp)
docker compose up -d

# Samo DB-ovi za development (lakši build/restart, embedder izvan kontejnera)
docker compose up -d postgres clickhouse

# MPS host embedder workflow (Apple Silicon dev)
# Terminal 1: embedder na hostu (vidi memory/project-mps-embedder-host)
cd services/embedder && EMBEDDER_DEVICE=mps EMBEDDER_MAX_TEXT_LEN=32768 \
  .venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8000
# Terminal 2: MCP container koji zove host embedder
# (.env mora imati EMBEDDER_URL=http://host.docker.internal:8000)
docker compose up -d mcp

# ETL ingest (one-shot, profile=etl)
docker compose --profile etl run --rm etl ingest --input /data --batch-size 4

# Pokretanje MCP servera direktno (stdio dev, bez containera)
cd services/mcp && npm run dev
# Konektaj Claude Desktop preko stdio (claude_desktop_config.json)
```

## Pitanja koja često iskaču

**Q: Trebam dodati novo polje u chunk shemu — kako?**
A: To je breaking change data contract-a. Prvo izmjeni `data_contract.md` u producer repu, bump verzije, pa update CH shemu ovdje.

**Q: Postoji li tablica X u PG?**
A: Provjeri `infra/postgres/init.sql`. Ako ne — to je signal da plan §4 nije implementiran tu, što je vjerojatno deferred za fazu kad bude potreban.

**Q: Gdje su raw JSONL fajlovi?**
A: Tri opcije ovisi o setupu:
- Lokalno: `../fetch.domovina.tv/storage/output/{channel}/`
- R2 CDN: `https://cdn.domovina.ai/data/{youtube_id}/...`
- Drive: `MyDrive/domovina_fetch_data/canary_wav/`
