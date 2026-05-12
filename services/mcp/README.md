# MCP Server — domovina-podcast

> **Status:** ✅ Faza 1 implementirano, live na `https://mcp.domovina.ai/health` (cloud) i lokalno (`docker compose up mcp`).

API sloj prema LLM klijentima (Claude Desktop, Claude.ai, ChatGPT, Cursor). Eksponira semantic search hrvatskog podcast korpusa kao MCP (Model Context Protocol) tools.

## Stack

- Node.js 22+, TypeScript strict, ESM
- `@modelcontextprotocol/sdk` (1.x)
- Express 4 + SSE transport za HTTP mode
- `pg` (PostgreSQL) i `@clickhouse/client` (ClickHouse)
- `zod` za argument validaciju

## Tools (Faza 1)

### `search_podcasts(query, channel?, lexical_terms?, limit?)`

Semantic search nad `rag_chunks` u ClickHouse-u, opcionalno s hybrid lexical filter.

Tijek:
1. `query` se embed-a preko embedder service-a (bge-m3, 1024-d)
2. ClickHouse `cosineDistance` sort, `vector_similarity` HNSW index ubrzava
3. Opcionalno `lexical_terms` filtriranje preko `hasToken` (Bloom filter)
4. PG lookup za `episode_title` po `youtube_id`-evima
5. Rezultati: `chunk_id`, `youtube_id`, `deep_link` (s `t=` na `start_ts`),
   `channel`, `upload_date`, `episode_title`, `speakers`, `text`, `score`

```mermaid
sequenceDiagram
    autonumber
    participant Client
    participant MCP as mcp server
    participant Emb as embedder<br/>(bge-m3)
    participant CH as ClickHouse
    participant PG as PostgreSQL

    Client->>MCP: search_podcasts("iskustvo kliničke smrti", limit=5)
    MCP->>Emb: POST /embed {"texts":["iskustvo..."]}
    Emb-->>MCP: vector[1024]
    MCP->>CH: SELECT ... ORDER BY cosineDistance(embedding, [...])<br/>LIMIT 5
    CH-->>MCP: 5 chunks (chunk_id, youtube_id, start_ts, text, score)
    MCP->>PG: SELECT youtube_id, title FROM episodes WHERE youtube_id IN (...)
    PG-->>MCP: titles
    MCP-->>Client: 5 formatted results s deep linkovima
```

**Argumenti:**

| Param | Tip | Validacija | Opis |
|---|---|---|---|
| `query` | string | 2-500 chars, required | Pitanje na hrvatskom |
| `channel` | string? | optional | Filter na slug kanala (npr. `podcast_cuspajz`) |
| `lexical_terms` | string[]? | optional | Hybrid mode: chunkovi MORAJU sadržavati sve term-e |
| `limit` | int? | 1-50, default 10 | Max rezultata |

**Hybrid mode primjer:**
```json
{
  "query": "razgovor o vjeri",
  "lexical_terms": ["Isusom", "molitvi"]
}
```
Vraća samo chunkove koji semantički matchaju "razgovor o vjeri" **i** sadrže riječi "Isusom" i "molitvi" (case-insensitive, hasToken na text-u).

**Tools planirani za Fazu 2+:** `get_episode`, `list_channels`, `list_speakers`, `get_related_episodes`, `analytics_top_speakers`.

## Transport

Selektiran preko `MCP_TRANSPORT` env varijable:

| Vrijednost | Use case | Auth |
|---|---|---|
| `stdio` (default) | Claude Desktop lokalni dev | nema (subprocess) |
| `http` | Production Coolify deploy | Bearer API key |

HTTP mode izlaže:
- `GET /health` — health check (no auth) za Docker healthcheck
- `GET /sse` — SSE stream, klijent otvara i drži open
- `POST /messages?sessionId=...` — JSON-RPC frames natrag

SSE je legacy MCP transport. Streamable HTTP upgrade je Faza 2.

## Auth (HTTP mode)

`Authorization: Bearer ${MCP_API_KEY}` — provjeravan na svim rutama osim `/health`.

OAuth 2.1 + Dynamic Client Registration (per plan §7.3) je Faza 4.

## Env varijable

| Naziv | Required | Default | Opis |
|---|---|---|---|
| `MCP_TRANSPORT` | ne | `stdio` | `stdio` ili `http` |
| `MCP_PORT` | ne | `3000` | Listen port u http mode-u |
| `MCP_AUTH_MODE` | ne | `apikey` | `apikey` ili `none` |
| `MCP_API_KEY` | da (http+apikey) | — | Bearer token za /sse i /messages |
| `POSTGRES_URL` | **da** | — | `postgres://user:pass@host:5432/db` |
| `CLICKHOUSE_URL` | **da** | — | `http://user:pass@host:8123/db` |
| `EMBEDDER_URL` | ne | `http://embedder:8000` | bge-m3 service URL |

## Lokalni razvoj

### Standalone (stdio mode, Claude Desktop dev)

```bash
cd services/mcp
npm install
npm run typecheck         # tsc --noEmit
npm run build             # tsc → dist/
npm run dev               # tsx watch, stdio mode (default)
npm run dev:http          # tsx watch, http mode na MCP_PORT
```

### Containerized (cijeli stack)

```bash
# Iz repo root-a
docker compose up -d
# Sve: pg + ch + embedder + mcp na :3000

# Health check
curl http://localhost:3000/health
# → {"status":"ok"}

# Sa Bearer token-om (uzmi iz .env-a)
curl -H "Authorization: Bearer $(grep MCP_API_KEY ../../.env | cut -d= -f2)" \
     http://localhost:3000/sse
# → SSE stream
```

## Smoke + e2e testovi

```bash
# Iz services/mcp/
MCP_API_KEY=$(grep MCP_API_KEY ../../.env | cut -d= -f2) \
  node scripts/smoke-test.mjs

# Cijeli e2e test set (21 hrvatski case)
MCP_API_KEY=... node test/e2e/run.mjs
# Filter na drugi minimum dataset:
TEST_REQUIRES=multi_channel MCP_API_KEY=... node test/e2e/run.mjs
```

Detalji: [`test/e2e/README.md`](./test/e2e/README.md).

## Claude Desktop konfig (stdio, lokalni dev)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "domovina-podcast-local": {
      "command": "node",
      "args": ["/Users/ms/git/domovinatv/domovina-rag/services/mcp/dist/index.js"],
      "env": {
        "POSTGRES_URL": "postgres://rag_user:PASS@localhost:5432/rag",
        "CLICKHOUSE_URL": "http://rag_user:PASS@localhost:8123/rag",
        "EMBEDDER_URL": "http://localhost:8000"
      }
    }
  }
}
```

Pretpostavlja da su PG/CH/embedder portovi forward-ani van docker internal mreže (lokalni dev — `docker compose up postgres clickhouse embedder` s dodanim `ports:` mapping-om u override file-u).

## Claude Desktop konfig (HTTP, production cloud)

```json
{
  "mcpServers": {
    "domovina-podcast-prod": {
      "url": "https://mcp.domovina.ai/sse",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

API key dobivaš iz `.env.coolify` (osoba koja maintaina Coolify deployment).

## Production deploy (Coolify)

Vidi [`docs/cloud_deployment_plan.md`](../../docs/cloud_deployment_plan.md) — Coolify UI flow s "Public Repository" source-om, env vars set u UI-u, Cloudflare Tunnel za public expose, R2 za snapshot sync iz lokalnih podataka.

Trenutno deployano na `https://mcp.domovina.ai` (Coolify projekt `px79sl4tx5o2ehbk5kpgbxp0`).
