# MCP Server — domovina-podcast

API sloj prema LLM klijentima (Claude Desktop, Claude.ai, ChatGPT, Cursor).
Eksponira semantic search hrvatskog podcast korpusa kao MCP (Model Context Protocol) tools.

## Stack

- Node.js 22+, TypeScript strict, ESM
- `@modelcontextprotocol/sdk` (1.x)
- Express 4 + SSE transport za HTTP mode
- `pg` (PostgreSQL) i `@clickhouse/client` (ClickHouse)
- `zod` za argument validaciju

## Tools (Faza 1)

### `search_podcasts(query, channel?, limit?)`

Semantic search nad `rag_chunks` u ClickHouse-u. Tijek:
1. `query` se embed-a preko embedder service-a (bge-m3, 1024-d)
2. ClickHouse `cosineDistance` sort, USearch HNSW index ubrzava
3. Rezultati: `chunk_id`, `youtube_id`, `deep_link` (s `t=` na `start_ts`),
   `channel`, `upload_date`, `episode_title`, `speakers`, `text`, `score`

Argumenti:
- `query` (string, 2-500 char, **required**) — pitanje na hrvatskom
- `channel` (string, optional) — filter na slug kanala (npr. `podcast_cuspajz`)
- `limit` (int, 1-50, default 10)

Tools planirani za Fazu 2+: `get_episode`, `list_channels`, `list_speakers`,
`get_related_episodes`, `analytics_top_speakers`.

## Transport

Selektiran preko `MCP_TRANSPORT` env varijable:

| Vrijednost | Use case | Auth |
|---|---|---|
| `stdio` (default) | Claude Desktop lokalni dev | nema (subprocess) |
| `http` | Production Coolify deploy | Bearer API key |

HTTP mode izlaže:
- `GET /health` — health check (no auth) za Docker
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
| `EMBEDDER_URL` | ne | `http://embedder:8000` | bge-m3 service |

## Lokalni razvoj

```bash
npm install
npm run typecheck         # tsc --noEmit
npm run build             # tsc → dist/
npm run dev               # tsx watch, stdio mode (default)
npm run dev:http          # tsx watch, http mode na MCP_PORT
```

## Claude Desktop konfig (stdio)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "domovina-podcast": {
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

Pretpostavlja da su PG/CH/embedder portovi forward-ani van docker internal mreže
(npr. `docker compose up postgres clickhouse embedder` s dodanim `ports:` mappingom).

## Production (HTTP)

`docker compose --profile full up mcp` — sluša na `${MCP_PORT}` host portu.
Klijent:

```
GET https://your-host/sse
Authorization: Bearer YOUR_KEY
```
