# Deploy Meilisearch na Coolify

Meilisearch je **frontend keyword tražilica** (typo-tolerant egzaktno pretraživanje
2500+ podcast epizoda). Komplementarna semantičkoj ClickHouse pretrazi — drugi
use-case: čovjek tipka točnu riječ/ime u web UI (domovina.ai), dok semantika
(MCP) služi LLM-u za značenjsku sličnost.

## Arhitektura

```
                       browser (domovina.ai Flutter web)
                            │  HTTPS + search-only key
                            ▼
   CF Tunnel ──► Traefik ──► search.domovina.ai ──► Meili :7700
                                                      ▲
   lokalni Mac ── scripts/sync-meili.sh --cloud ──────┘
     (SSH tunel, master key, puni `episodes` index iz lokalnog CH-a)
```

- **Dva klijenta, dvije razine pristupa:**
  - **Browser** → javni HTTPS (`search.domovina.ai`) + **search-only key** (read-only, samo `search` action). NIKAD master key u frontend.
  - **Sync skripta** → SSH tunel na interni Meili + **master key** (admin: kreira index, puni dokumente, generira search-only key).
- Meili index je **derivat ClickHouse-a** — ne treba mu backup, rebuilda se iz `sync-meili.sh`. Volume `meili_data` je samo radi izbjegavanja re-indexa na svaki restart.

## Deploy je preko COMPOSE-a (ne zaseban Application)

Za razliku od MCP-a (koji je izdvojen u Coolify Application radi zero-downtime —
vidi `coolify-mcp-application.md`), Meili **ostaje u glavnom `docker-compose.yml`**
uz postgres/clickhouse/embedder. Razlog: isti je stateful lifecycle kao CH (puni
se sync skriptom, rijetko mijenja), keyword search nije zero-downtime-critical, a
restart je sekunda (nema build-a). Compose redeploy radi stop-then-start
([[lessons-coolify-compose-no-rolling]]) — prihvatljivo za Meili.

## Koraci

### 1. Env var u Coolify (compose resource)

Dodaj u Coolify UI → compose resource → Environment Variables:

```
MEILI_MASTER_KEY=<openssl rand -base64 32>   # markiraj kao "secret"
```

Generiraj lokalno: `openssl rand -base64 32`. Isti string upiši i u lokalni `.env`
(da `sync-meili.sh --cloud` ne treba — on čita cloud key preko SSH-a, ali lokalni
`.env` MEILI_MASTER_KEY treba za lokalni Meili).

### 2. Redeploy compose

Coolify → compose resource → Redeploy. Meili servis se digne s `meili_data`
volume-om na `coolify` mreži s aliasom `domovina-meili`. Verify na VPS-u:

```bash
ssh -i ~/.ssh/dom-001-oracle-ssh-key-2026-04-20.key ubuntu@89.168.100.120 \
  "docker ps --filter name=meili --format '{{.Names}}: {{.Status}}'"
```

### 3. CF Tunnel public hostname

Cloudflare Zero Trust → Tunnels → (postojeći tunel `01a25a60-...`) → Public Hostnames → Add:

- **Subdomain/domain:** `search.domovina.ai`
- **Service:** `http://traefik:80` (isti pattern kao mcp.domovina.ai) **ILI** direktno `http://domovina-meili:7700` ako tunel ima pristup `coolify` mreži.
- Coolify compose resource → Domains → dodaj `search.domovina.ai` na `meilisearch` servis (Traefik label rute na :7700).

> TLS terminira Cloudflare edge; CF Tunnel forwarda HTTP (vidi cloud_deployment_plan.md — bez Let's Encrypt resolvera).

### 4. Napuni index (prvi put + svaki refresh)

S lokalnog Maca (lokalni CH je već sinkan s cloudom preko `sync-incremental.sh`):

```bash
cd ~/git/domovinatv/domovina-rag
./scripts/sync-meili.sh --cloud
```

Skripta: discovera cloud Meili container + master key preko SSH-a, otvori SSH
tunel na interni :7700, pokrene indexer (čita lokalni CH, piše cloud Meili),
zatvori tunel. ~sekunde za 2500 dokumenata.

### 5. Generiraj search-only key (za frontend)

Jednom, na VPS-u (ili preko tunela). Search-only key smije samo `search`, samo
index `episodes`:

```bash
curl -X POST 'http://localhost:7700/keys' \
  -H "Authorization: Bearer $MEILI_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  --data '{
    "name": "frontend-search",
    "description": "domovina.ai web keyword search (read-only)",
    "actions": ["search"],
    "indexes": ["episodes"],
    "expiresAt": null
  }'
```

Vraćeni `key` ide u frontend (domovina.ai `meili_client.dart`) preko
`--dart-define=MEILI_SEARCH_KEY=...` i `--dart-define=MEILI_URL=https://search.domovina.ai`.
**Master key NIKAD u frontend bundle.**

### 6. Frontend prod-switch (domovina.ai repo)

`lib/services/meili_client.dart` trenutno ima hardkodiran lokalni master key i
`localhost:7700` — to je samo za lokalni PoC. Za prod: čitaj `baseUrl` i key iz
`--dart-define` (build-time) ili runtime config, default na lokalni za dev.

## Sync cadence

Dodaj `sync-meili.sh --cloud` u isti launchd ciklus kao CH sync
([[project-incremental-sync-pipeline]]) — nakon `sync-incremental.sh` (CH delta),
re-indexaj Meili. Jeftino (puni re-index ~sekunde), pa nema delta logike.

## CORS

Meili v1.11 šalje `Access-Control-Allow-Origin: *` na `/search` po defaultu, pa
browser keyword pretraga radi bez dodatnog proxyja. Ako želiš suziti na samo
`domovina.ai`, dodaj Traefik CORS middleware u Coolify domain konfiguraciji.

## Vezano

- `coolify-mcp-application.md` — zašto je MCP Application, a Meili compose
- `cloud_deployment_plan.md` — CF Tunnel + Traefik + TLS pattern
- `scripts/sync-meili.sh` — punjenje indexa (lokalno `--local`, cloud `--cloud`)
- `scripts/meili-poc-index.py` — indexer (čita CH article_summary + PG title)
