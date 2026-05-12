# domovina-rag

> **Status:** 🚧 Bootstrapping — strukturni skelet, implementacija stiže u sljedećim commitovima.

RAG (Retrieval-Augmented Generation) backend za hrvatski katolički/politički podcast korpus.
Open-source samohostani stack koji:

- Konzumira pripremljene chunkove iz [`fetch.domovina.tv`](https://github.com/domovinatv/fetch.domovina.tv) (data producer)
- Sprema ih u **ClickHouse** (analytical + vector store) + **PostgreSQL** (transactional source of truth)
- Eksponira pretragu kao **MCP server** (Model Context Protocol) — bilo koji LLM klijent
  (Claude Desktop, Claude.ai, ChatGPT, Cursor, custom agent) se može spojiti
- Generaciju odgovora delegira cloud LLM-u (Gemini/Claude API) preko tool calling-a

## Arhitektura

Detaljan arhitekturni plan, schema design, MCP tools, eval rig i speaker entity resolution
strategija žive u sibling repu zbog povijesnog konteksta o podacima:

➡️ **[fetch.domovina.tv/docs/rag_clickhouse_postgres_plan.md](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/rag_clickhouse_postgres_plan.md)**

Sažetak stack-a:

```
LLM klijenti  ────►  MCP server  ────►  ClickHouse (vectors + analytics)
(Claude.ai,         (HTTPS+SSE        + PostgreSQL (entities, sessions)
 ChatGPT,            + OAuth/API key)  + embedder (bge-m3, FastAPI)
 Cursor, ...)                          + reranker (bge-reranker-v2-m3)
```

## Data contract

Format ulaznih datoteka (chunks JSONL, summary JSON, article JSON, speaker embeddings) je
formaliziran u producer repu:

➡️ **[fetch.domovina.tv/docs/data_contract.md](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/data_contract.md)**

## Struktura

```
domovina-rag/
├── services/
│   ├── mcp/           # MCP server (Node.js + TypeScript)
│   ├── embedder/      # bge-m3 embedding service (Python + FastAPI)
│   └── reranker/      # bge-reranker-v2-m3 service (Python + FastAPI)
├── infra/
│   ├── docker-compose.yml
│   ├── postgres/init.sql
│   └── clickhouse/init.sql
└── docs/              # cross-links to plan + lokalni operativni docs
```

## Status komponenti

| Komponenta | Status |
|---|---|
| LICENSE (AGPL-3.0) | ✅ |
| Architecture plan | ✅ (u fetch.domovina.tv) |
| Data contract | ✅ (u fetch.domovina.tv) |
| docker-compose skeleton | ✅ |
| PostgreSQL schema | 🚧 Bootstrap stub |
| ClickHouse schema | 🚧 Bootstrap stub |
| MCP server | 🚧 Stub |
| Embedder service | 🚧 Stub |
| Reranker service | ⏳ Faza 2 |
| Eval rig | ⏳ Faza 2 |
| Speaker entity resolution | ⏳ Faza 3 |

## Quick start (kad bude funkcionalno)

```bash
cp .env.example .env  # popuni PG_PASSWORD, CH_PASSWORD, MCP_API_KEY
docker compose up -d
# Health check: http://localhost:3000/health
```

Trenutno: **ništa od ovoga ne radi**. Implementacija slijedi.

## Licenca

[AGPL-3.0](./LICENSE) — ako hostiraš ovaj kod kao service, modifikacije moraš share-ati natrag.
