# MCP Server

**Status:** 🚧 Stub — implementacija slijedi.

Glavni API sloj prema LLM klijentima (Claude Desktop, Claude.ai, ChatGPT, Cursor, custom agenti).
Eksponira tools za pretragu podcast korpusa kao MCP (Model Context Protocol) endpoint.

## Planirani stack

- Node.js 22+ s TypeScript (strict mode, ESM)
- `@modelcontextprotocol/sdk` (MIT)
- Express ili Fastify za HTTP+SSE transport
- Direct PG i CH klijenti (`pg`, `@clickhouse/client`)

## Planirani tools

Vidi plan §7.5.1: https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/rag_clickhouse_postgres_plan.md#751-tools-koje-eksponiramo

- `search_podcasts(query, channel?, speaker?, date_from?, date_to?, limit?)`
- `get_episode(youtube_id)`
- `list_speakers(channel?)`
- `list_channels()`
- `get_related_episodes(youtube_id, limit?)`
- `analytics_top_speakers(date_range?)`

## Auth (Faza 1 → Faza 4)

- **Faza 1-3**: API key (`Authorization: Bearer <key>`)
- **Faza 4**: OAuth 2.1 + Dynamic Client Registration za public MCP

## Lokalni razvoj (kad bude implementiran)

```bash
cd services/mcp
npm install
npm run dev    # stdio transport za Claude Desktop testiranje
# ili
npm run dev:http    # HTTP+SSE za production-style
```

## Claude Desktop konfiguracija (dev)

```json
{
  "mcpServers": {
    "domovina-podcast": {
      "command": "node",
      "args": ["/Users/ms/git/domovinatv/domovina-rag/services/mcp/dist/index.js"],
      "env": {
        "POSTGRES_URL": "postgres://...",
        "CLICKHOUSE_URL": "http://..."
      }
    }
  }
}
```
