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
5. Rezultati: `chunk_id`, `youtube_id`, `deep_link` (`https://domovina.ai/v/{id}/t/{start_ts}`),
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

## Tool: `get_episode`

Vraća metapodatke, popis poglavlja i (po želji) cijeli transkript jedne epizode prema YouTube ID-u. CH-only (bez PG joina) — naslov se parsa iz `metadata` JSON kolone, isti pattern kao `search_podcasts`.

**Argumenti:**

| Param | Tip | Validacija | Opis |
|---|---|---|---|
| `youtube_id` | string | regex `^[A-Za-z0-9_-]{11}$`, required | 11-znakovni YouTube video ID |
| `include_transcript` | bool? | default `true` | `false` vraća samo meta + chapters |
| `view_range` | `[number, number]?` | start < end | Filtriraj chunkove na `[start_sec, end_sec]`. Bypassira soft limit. |

**Truncation (char-based):**
- soft `80 000` — bez `view_range`-a vrati meta + chapters, `transcript=null`, `truncated=true`
- hard `200 000` — uvijek throwsa `EPISODE_TOO_LARGE` s actionable hintom

**Domain greške** (mapirane u MCP `isError` response):
`EPISODE_NOT_FOUND`, `EPISODE_TOO_LARGE`, `VALIDATION_ERROR`, `STORAGE_ERROR`.

## Tool: `list_episodes`

Vraća distinct epizode korpusa s metapodacima (naslov, kanal, datum, trajanje, govornici, broj chunkova). Use case: discovery/browsing, "tko sve gostuje", "najnovije epizode".

Argumenti: `channel?`, `speaker?` (partial match), `min_upload_date?`, `max_upload_date?` (YYYY-MM-DD), `sort_by` (`upload_date_desc`|`asc`|`chunks_desc`|`duration_desc`), `limit` (1-100, default 20).

## Tool: `count_mentions`

Agregat: top N grupa (channel/speaker/month) po broju chunkova koji semantički matchaju upit. Vraća samo brojeve, ne sadržaj — drastično manji payload od `search_podcasts(limit=N)`.

Argumenti: `query`, `group_by` (`channel`|`speaker`|`month`), `relevance_threshold` (0-1, default 0.4), `limit` (1-50, default 20), `min/max_upload_date?`, `channel?`.

## Tool: `server_info`

Vraća metadata o servisu i korpusu: verzija, build info (BUILD_SHA, BUILD_DATE env vars), dataset stats (channels/episodes/chunks counts + earliest/latest_upload), popis dostupnih tool-ova.

Bez argumenata. Komplementarno standardnom `Implementation` objektu iz MCP `initialize` handshake-a — taj je static, ovaj je live.

**Tools planirani za Fazu 2+:** `list_speakers` (Faza 3, traži speaker entity resolution), `get_related_episodes`, `chat` (Q&A pipeline).

## Transport

Selektiran preko `MCP_TRANSPORT` env varijable:

| Vrijednost | Use case | Auth |
|---|---|---|
| `stdio` (default) | Claude Desktop lokalni dev (subprocess) | nema |
| `http` | Production Coolify deploy | Bearer API key |

HTTP mode (Streamable HTTP, MCP spec 2025-03-26+):
- `GET /health` — health check (no auth) za Docker healthcheck
- `POST /mcp` — JSON-RPC requests (initialize, tools/list, tools/call). Vraća single JSON ili SSE stream (Content-Type: text/event-stream).
- `GET /mcp` — open SSE stream za server-sent notifications (long-lived)
- `DELETE /mcp` — eksplicitna terminacija sesije
- Server vraća `Mcp-Session-Id` header u initialize response-u; svi sljedeći request-ovi moraju ga sadržavati

Single Server instance per sessija (SDK limitation — Server može biti spojen na samo jedan transport). `Streamable HTTP` je standardni transport koji **Claude.ai Custom Connectors** native podržava — bez `mcp-remote` bridge-a.

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

Streamable HTTP transport native-podržan u modernim MCP klijentima (Claude Desktop, Claude.ai Custom Connectors, MCP Inspector, etc).

### Claude.ai Custom Connectors (najjednostavnije)

Profile → Custom Integrations → Add custom MCP server:
- **URL**: `https://mcp.domovina.ai/mcp`
- **Auth**: Bearer + API key

Bez ikakvog dodatnog setup-a.

### Claude Desktop config file (alternativa)

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "domovina-podcast-prod": {
      "url": "https://mcp.domovina.ai/mcp",
      "transport": "http",
      "headers": {
        "Authorization": "Bearer YOUR_API_KEY"
      }
    }
  }
}
```

API key dobivaš iz `.env.coolify` (osoba koja maintaina Coolify deployment).

## Production deploy (Coolify)

> **Zamka izmjerena 4.9.2026.: `/health` 200 NE znači da je tvoj kod živ.**
> `deploy.sh` javi „Živo nakon ~10 s" dok **stari** kontejner još služi promet —
> Coolify tek gradi image pa zamjenjuje kontejner. Nova ruta je tog dana vraćala
> 404 još **8 minuta** nakon te poruke, a tijekom same zamjene dala jedan 200 pa
> opet 404. Verificiraj **novu funkcionalnost**, ne `/health`:
>
> ```bash
> # status samog deploya
> curl -sS -H "Authorization: Bearer $COOLIFY_API_TOKEN" \
>   "$COOLIFY_API_URL/api/v1/deployments/<deployment_uuid>" | jq .status
> # → in_progress … finished
>
> # koji commit je STVARNO u kontejneru (image tag je SHA)
> ssh dom-001 "docker ps --filter name=amu4q428khkefqhu5zd6cq88 \
>   --format '{{.Status}}\t{{.Image}}'"
> ```
>
> Kontejner zna biti tjednima star, pa jedan deploy odjednom isporuči sve MCP
> commitove nakupljene u međuvremenu — pogledaj `git log` prije nego okineš.


Vidi [`docs/cloud_deployment_plan.md`](../../docs/cloud_deployment_plan.md) — Coolify UI flow s "Public Repository" source-om, env vars set u UI-u, Cloudflare Tunnel za public expose, R2 za snapshot sync iz lokalnih podataka.

Trenutno deployano na `https://mcp.domovina.ai` (Coolify projekt `px79sl4tx5o2ehbk5kpgbxp0`).
