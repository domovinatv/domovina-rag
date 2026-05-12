# Cloud deployment plan (Coolify + Cloudflare Tunnel + R2)

> **Cilj:** javno dostupan MCP endpoint na `mcp.domovina.ai`, bez da MacMini bude SPOF.
> **Pattern:** lokalni embed (GPU) → R2 snapshot → cloud serve (CPU).
> **Infrastructure:** Coolify (`app.domovina.link`) deploya stack, Cloudflare Tunnel exposa Traefik, R2 store-a snapshot-e.
> **Coolify project:** `px79sl4tx5o2ehbk5kpgbxp0`, env `p61gjclkyz58fmdkd0owxqk8`
> **Repo:** `https://github.com/domovinatv/domovina-rag` (public)
> **Verzija plana:** v3, 2026-05-12.

> ⚠️ **Tijekom prvog deploya (2026-05-12) saznali smo:**
> - Coolify v4 NEMA UI polje za `--profile` flag → maknuli smo `profiles: [full]` iz base compose-a; svi servisi (pg, ch, embedder, mcp) sad auto-startaju. ETL ostaje pod `profiles: [etl]` jer je one-shot.
> - Coolify resolva build paths protiv compose-file directory-a → **compose file je premješten na repo root** (`/docker-compose.yml`, ne više `/infra/docker-compose.yml`). Init skripte ostaju u `infra/{pg,ch}/init.sql`.
> - **`infra/docker-compose.prod.yml` više NE postoji.** Coolify-native put (UI "Domains for mcp" field → auto-generira Traefik labels) je čišći nego hand-coded override.
> - Sve sekcije ispod su ažurirane gdje je trebalo, ali u tekstu još ima staromodnih referenci na prod.yml — ignoriraj ih.

## TL;DR arhitektura

```
LOKALNO (MacMini, MPS)                    CLOUD (Coolify VPS, app.domovina.link)
─────────────────────────────             ──────────────────────────────────────
producer (fetch.domovina.tv)              ┌─ ClickHouse  (internal)
    ↓ JSONL                               ├─ Embedder bge-m3 CPU (internal)
ETL → MPS embedder → CH (local)           ├─ MCP :3000   (internal)
    ↓                                     │     ↑
BACKUP TABLE ... TO S3(R2)                │   Traefik (Host: mcp.domovina.ai)
    ↓                                     │     ↑
[R2 bucket] ──────────────► RESTORE       │   cloudflared (outbound only)
                                          └─────┴─► Cloudflare edge (TLS terminate)
                                                          ↑
                                          public Internet (Claude Desktop, frontend, ...)
```

CF Tunnel UUID `01a25a60-6819-4e7b-b661-b1ce34bb588d` već exposa druge Coolify servise — samo dodajemo novi public hostname `mcp.domovina.ai` → `http://traefik:80`. Nema novih portova na VPS-u, nema Let's Encrypt-a (TLS na CF edge).

## Pretpostavke (verificirano 2026-05-12)

- ✅ Coolify postoji na `https://app.domovina.link/`
- ✅ Cloudflare Tunnel aktivan, već exposa druge servise preko Traefik-a
- ✅ Coolify project kreiran: `px79sl4tx5o2ehbk5kpgbxp0`, environment: `p61gjclkyz58fmdkd0owxqk8`
- ✅ Repo public: `https://github.com/domovinatv/domovina-rag`
- ✅ `infra/docker-compose.prod.yml` postoji u repo-u (override za prod)
- [ ] R2 bucket — treba kreirati (Faza 0)
- [ ] Lokalni full ingest dovršen — u tijeku, ~3h
- [ ] DNS `mcp.domovina.ai` u CF tunnel route — treba dodati (Faza 5)

## Faza 0 — Preduvjeti (sad, tijekom ingest-a)

- [ ] Verificiraj domenu — odluči subdomenu (preporuka: `mcp.domovina.ai`)
- [ ] R2 bucket: izradi `domovina-rag-snapshots` u Cloudflare dashboard-u → Storage → R2
- [ ] R2 API token: kreiraj S3-compatible credentials (Cloudflare → R2 → Manage R2 API Tokens) s `Object Read & Write` permission za taj bucket
  - Spremi `access_key_id`, `secret_access_key`, `endpoint` (`https://{account_id}.r2.cloudflarestorage.com`)
- [ ] Procijeni veličinu snapshot-a (poslije ingest-a):
  ```bash
  docker exec domovina-rag-infra-clickhouse-1 clickhouse-client \
    --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
    --query "SELECT formatReadableSize(sum(bytes_on_disk)) FROM system.parts WHERE table='rag_chunks' AND active"
  ```
- [ ] Coolify VPS spec — preporuka:
  - **CPU:** 4 cores (8 ako želiš headroom za reranker u Fazi 2)
  - **RAM:** **min 8 GB** (bge-m3 CPU ~3 GB + CH ~2 GB + OS+ostali ~2 GB)
  - **Disk:** 20 GB SSD (CH data ~2 GB + Docker overhead)
  - Provideri: Hetzner CX31 (€7/mo), Contabo VPS M (€8), DigitalOcean Basic 8GB ($48 — skuplje)

## Faza 1 — Coolify setup ✅

- ✅ Coolify v4 instaliran na `https://app.domovina.link/`
- ✅ Cloudflare Tunnel aktivan i routa druge servise
- ✅ Project `domovina-rag` kreiran u Coolify-u
- ✅ Traefik dostupan kao reverse proxy (Coolify default)

Verifikacija Traefik network imena na VPS-u (jednom):
```bash
ssh <vps>; docker network ls | grep coolify
# Očekivano: `coolify` (default v4). Ako se zove drukčije, update `infra/docker-compose.prod.yml` -> networks.coolify.name
```

## Faza 2 — Repo priprema za cloud ✅

- ✅ `infra/docker-compose.prod.yml` napisan (override file, vidi root repo-a)
- ✅ MCP server podržava `MCP_AUTH_MODE=api_key` + `MCP_API_KEY` (per [[project-mcp-service]])
- ✅ Embedder respekuje `EMBEDDER_DEVICE` env var (CPU default na Linux/Coolify)

**Što override radi:**
- Embedder: `EMBEDDER_DEVICE=cpu`, ostaje na `internal` mreži (ne `web`)
- MCP: makne `ports:` (bez direct expose), doda Traefik labels za `mcp.domovina.ai`, attacha na `coolify` proxy network
- TLS-a NEMA na Traefik strani — Cloudflare edge radi terminaciju, CF Tunnel forwarda HTTP

**Što ostaje isto kao dev:**
- PG init.sql i CH init.sql se i u prod-u izvršavaju na first-boot (volumes su prazni)
- bge-m3 model isti — zero vector drift između lokala i cloud-a
- Profili: `full` (postgres+ch+embedder+mcp) se aktivira; `etl` NE

## Faza 3 — Snapshot iz lokalne baze u R2

Pretpostavka: full ingest dovršen, ~92K chunkova u local CH.

- [ ] Local CH: konfiguriraj S3 disk za backup destination (jednokratno, u `infra/clickhouse/config.d/r2_backup.xml`):

  ```xml
  <clickhouse>
    <storage_configuration>
      <disks>
        <r2_backup>
          <type>s3</type>
          <endpoint>https://{R2_ACCOUNT_ID}.r2.cloudflarestorage.com/domovina-rag-snapshots/</endpoint>
          <access_key_id>{R2_ACCESS_KEY}</access_key_id>
          <secret_access_key>{R2_SECRET_KEY}</secret_access_key>
          <region>auto</region>
        </r2_backup>
      </disks>
      <policies>
        <r2_backup_policy>
          <volumes><main><disk>r2_backup</disk></main></volumes>
        </r2_backup_policy>
      </policies>
    </storage_configuration>
    <backups>
      <allowed_disk>r2_backup</allowed_disk>
    </backups>
  </clickhouse>
  ```

  Mountaj u `clickhouse` servis u dev compose-u kao `./infra/clickhouse/config.d:/etc/clickhouse-server/config.d:ro`.

  Restartaj CH: `docker compose restart clickhouse`.

- [ ] Trigger backup:

  ```bash
  docker exec domovina-rag-infra-clickhouse-1 clickhouse-client \
    --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
    --query "BACKUP TABLE rag.rag_chunks TO Disk('r2_backup', 'snapshot-$(date +%Y%m%d).zip')"
  ```

  Backup je inkrementalan ako koristiš isti naming pattern; za prvi run je full.

- [ ] Verificiraj u Cloudflare R2 UI: bucket sadrži `snapshot-YYYYMMDD.zip` (više fileova, jedan po partu)

**Alternativa za prvi snapshot bez S3 konfiguracije** (jednostavnije, dobar fallback):

```bash
docker exec domovina-rag-infra-clickhouse-1 clickhouse-client \
  --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
  --query "SELECT * FROM rag_chunks FORMAT Native" | \
  zstd -19 > rag_chunks-$(date +%Y%m%d).native.zst

# Upload manually
rclone copy rag_chunks-*.native.zst r2:domovina-rag-snapshots/
```

## Faza 4 — Coolify deployment (UI flow)

Project i environment već postoje:
- Project UUID: `px79sl4tx5o2ehbk5kpgbxp0`
- Environment UUID: `p61gjclkyz58fmdkd0owxqk8`
- URL: `https://app.domovina.link/project/px79sl4tx5o2ehbk5kpgbxp0/environment/p61gjclkyz58fmdkd0owxqk8/new`

### Koraci u Coolify UI (verificirano 2026-05-12, deploy uspio)

- [x] **Add resource** → **Docker Compose** → izvor: **Public Repository**
- [x] Repository URL: `https://github.com/domovinatv/domovina-rag`
- [x] Branch: `main`
- [x] **Build pack**: Docker Compose (auto-detected)
- [x] **Base Directory**: `/` (root repo-a)
- [x] **Docker Compose Location**: `/docker-compose.yml` (compose je na repo root-u, NE `/infra/`)
- [x] Custom Build/Start Command — **OSTAVI PRAZNO**. Coolify radi `docker compose up -d` default-ano; profili su uklonjeni iz base compose-a pa sve auto-startuje.

### Domain — Coolify-native auto-Traefik (BEZ prod.yml override-a)

- [x] **Configuration → General → Domains for mcp**: `http://mcp.domovina.ai`
  - **Bitno**: `http://` prefix (NE `https://`) — s `https://` + CF Tunnel-om dolazi do redirect loop-a (Coolify Traefik 301 → https, CF re-forwarda HTTP → loop).
  - TLS rješava Cloudflare edge; Traefik unutar Coolify-ja samo radi Host header routing na HTTP-u.
- [x] **Configuration → Advanced → Force Https**: OFF (ili `http://` u domeni preskoči redirect middleware)

Coolify auto-generira Traefik labels:
```
- traefik.enable=true
- traefik.http.routers.http-0-{uuid}-mcp.rule=Host(`mcp.domovina.ai`) && PathPrefix(`/`)
- traefik.http.routers.http-0-{uuid}-mcp.entryPoints=http
```

Port (3000) Traefik auto-discover-a iz `EXPOSE 3000` direktive u `services/mcp/Dockerfile`.

### Environment variables (Coolify UI → Environment Variables tab)

Generiraj jake passwords/keys u terminalu:
```bash
openssl rand -base64 32 | tr -d '/=+' | cut -c1-32   # pokreni 3x za 3 različite
```

Set u Coolify UI:
```
POSTGRES_DB=rag
POSTGRES_USER=rag_user
POSTGRES_PASSWORD=<random 32 char>
CLICKHOUSE_DB=rag
CLICKHOUSE_USER=rag_user
CLICKHOUSE_PASSWORD=<random 32 char>
MCP_AUTH_MODE=api_key
MCP_API_KEY=<random 32 char>
MCP_PORT=3000
EMBEDDER_MODEL=BAAI/bge-m3
EMBEDDER_DEVICE=cpu                       # NE mps na Linux/Coolify
DATA_SOURCE_DIR=/tmp                      # placeholder, ETL profile=etl nije aktiviran
```

Sve označi kao **Build Time = OFF, Runtime = ON** (Coolify default OK).

### Deploy

- [x] Pritisni **Deploy** u Coolify UI
- [x] Pratiti deploy logove (Coolify → Logs tab):
  - Image pull (PG, CH) + build (embedder, mcp, etl) — ~3-5 min ukupno
  - PG up u ~10s
  - **CH može fail-ati na first boot** — init.sql timing issue. Fix: **Redeploy**, drugi pokušaj radi (volume već inicijaliziran).
  - Embedder boot ~3-5 min (first-time bge-m3 ~2 GB download iz HF do `hf_cache` volume-a)
  - MCP healthy u <30s
- [x] Verificiraj svih container statuse zelene u Coolify UI Resources view-u

## Faza 4b — Cloudflare Tunnel route za mcp.domovina.ai ✅ (verificirano 2026-05-12)

Tvoj CF Tunnel: `01a25a60-6819-4e7b-b661-b1ce34bb588d`

- [x] CF dashboard → Zero Trust → Networks → Tunnels → odaberi tunel → **Public Hostname**
- [x] **Add a public hostname**:
  ```
  Subdomain: mcp
  Domain: domovina.ai
  Type: HTTP
  URL: <isti pattern kao tvoji drugi Coolify servisi — npr. traefik:80>
  ```
- [x] **Save hostname**

DNS record (`mcp.domovina.ai` CNAME → tunnel) Cloudflare auto-kreira.

**Verifikacija iz vana:**
```bash
curl -I https://mcp.domovina.ai/health
# Očekivano: HTTP/2 200, {"status":"ok","service":"domovina-podcast","version":"0.1.0"}

curl -i -m 3 -H "Authorization: Bearer YOUR_MCP_API_KEY" https://mcp.domovina.ai/sse | head -15
# Očekivano: HTTP/2 200, content-type: text/event-stream, event: endpoint
```

### Troubleshooting koji se desio u prvom deployu

| Simptom | Uzrok | Fix |
|---|---|---|
| `unable to prepare context: path "/artifacts/services/embedder" not found` | Compose file u `infra/` + Coolify `--project-directory` = repo root → relative paths se resolvaju krivo | **Premjesti compose na repo root** (`/docker-compose.yml`), path-ovi `./services/...` rade kako treba |
| `dependency failed to start: clickhouse is unhealthy` | CH init.sql timing issue na first boot s praznim volume-om | **Redeploy** — drugi pokušaj radi (volume već inicijaliziran) |
| `Too many redirects` na `https://mcp.domovina.ai` | Coolify "Force Https" + CF Tunnel HTTP forward → 301 loop | **`http://` u Domain field-u** (NE `https://`); ili **Advanced → Force Https OFF** |

## Faza 5 — Restore podataka u cloud CH

- [ ] U Coolify VPS-u: konfiguriraj isti R2 disk (`r2_backup.xml`) preko Coolify "Persistent Storage" config mount-a, ili ručno:

  ```bash
  # SSH na VPS
  CONTAINER=$(docker ps --filter "name=clickhouse" --format "{{.Names}}")
  docker exec "$CONTAINER" clickhouse-client \
    --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
    --query "RESTORE TABLE rag.rag_chunks FROM Disk('r2_backup', 'snapshot-YYYYMMDD.zip')"
  ```

  **Alternativa** (ako S3 disk komplicirano): stream direktno preko `clickhouse-client`:

  ```bash
  # lokalno:
  rclone copy r2:domovina-rag-snapshots/rag_chunks-YYYYMMDD.native.zst /tmp/

  # SSH na VPS, scp file gore:
  scp /tmp/rag_chunks-YYYYMMDD.native.zst vps:/tmp/

  # na VPS-u:
  cat /tmp/rag_chunks-*.native.zst | zstd -d | \
    docker exec -i "$CONTAINER" clickhouse-client \
      --user rag_user --password "$CLICKHOUSE_PASSWORD" \
      --database rag --query "INSERT INTO rag_chunks FORMAT Native"
  ```

- [ ] Verificiraj count:
  ```bash
  docker exec "$CONTAINER" clickhouse-client \
    --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
    --query "SELECT count(), uniq(youtube_id) FROM rag_chunks"
  ```
  Mora odgovarati lokalnom (~92K chunkova, ~1843 epizoda).

- [ ] PG `channels`/`episodes`/`sync_state` — slično, ali manje važno (MCP tool ih ne treba; samo ETL ih piše). Možeš:
  - **Option A**: pg_dump lokalno → restore na cloud (clean state)
  - **Option B**: ostavi cloud PG prazan — MCP radi pure-CH workflow

  Preporuka: **B**, dok ne implementiraš MCP tool koji čita PG (npr. `list_channels`).

## Faza 6 — E2E verifikacija

- [ ] Health checks iz cloud-a:
  ```bash
  curl https://mcp.domovina.ai/health  # → 200
  curl -H "Authorization: Bearer $API_KEY" https://mcp.domovina.ai/sse  # → 200 SSE stream
  ```

- [ ] Local MCP SDK smoke test protiv cloud URL-a (modificirano iz `services/mcp/scripts/smoke-test.mjs`):
  ```bash
  MCP_URL=https://mcp.domovina.ai/sse \
  MCP_API_KEY=$API_KEY \
    node services/mcp/scripts/smoke-test.mjs
  ```
  Trebaš dobiti 3 chunka za query "iskustvo kliničke smrti".

- [ ] Claude Desktop konfiguracija — dodaj u `~/Library/Application Support/Claude/claude_desktop_config.json`:
  ```json
  {
    "mcpServers": {
      "domovina-rag-prod": {
        "url": "https://mcp.domovina.ai/sse",
        "headers": { "Authorization": "Bearer YOUR_API_KEY" }
      }
    }
  }
  ```
  Restartaj Claude Desktop → "search_podcasts" tool treba se pojaviti.

- [ ] E2E test set (21 case iz `services/mcp/test/e2e/`) — okini protiv cloud endpointa.

## Faza 7 — Sync cadence (kad producer doda nove epizode)

Setup za inkrementalni update bez full re-deployment-a.

- [ ] Lokalni cron (npr. weekly nakon producer run-a):
  ```bash
  # ~/scripts/sync-to-r2.sh
  cd /Users/ms/git/domovinatv/domovina-rag
  docker compose --env-file .env -f infra/docker-compose.yml --profile etl --profile full \
    run --rm etl ingest --input /data --batch-size 4
  docker exec domovina-rag-infra-clickhouse-1 clickhouse-client \
    --user rag_user --password "$CLICKHOUSE_PASSWORD" --database rag \
    --query "BACKUP TABLE rag.rag_chunks TO Disk('r2_backup', 'snapshot-$(date +%Y%m%d).zip')"
  ```

- [ ] Cloud side: ručno trigger restore (ili Coolify cron job):
  ```bash
  # na VPS-u, scheduled cron
  docker exec "$CONTAINER" clickhouse-client \
    --query "RESTORE TABLE rag.rag_chunks FROM Disk('r2_backup', 'snapshot-latest.zip')"
  ```

  **Bolja varijanta** (kad budeš na CH 24.10+): `BACKUP ... INCREMENTAL`, samo nove parts ide u R2, cloud aplicira diff.

- [ ] Eventually (Faza 3+): postavi GitHub Action koji nakon novog tag-a okida deploy + restore.

## Faza 8 — Coolify API automation (defer until Faza 6 verified)

Cilj: reproducible `scripts/coolify-deploy.sh` koji bilo koji budući redeploy svodi na jednu komandu.

### Coolify REST API basics

- **Base**: `https://app.domovina.link/api/v1/`
- **Auth**: Bearer token. Generiraj jednom u UI:
  - Profile (gornji desni avatar) → **Keys & Tokens** → **API Tokens** → **Create New Token**
  - Scope: minimum **read+write on Applications, Environment Variables, Deployments**
  - Spremi token u `~/.config/coolify/token` (chmod 600), nikad u repo
- **OpenAPI spec**: tvoja instance ima `https://app.domovina.link/api/v1/openapi.json` (alternativno `/docs`)

### Ključni endpoint-i (verificirati kad krene Faza 8)

| Što | HTTP + endpoint |
|---|---|
| List projects | `GET /api/v1/projects` |
| Get application by UUID | `GET /api/v1/applications/{uuid}` |
| Create app (Docker Compose, public repo) | `POST /api/v1/applications` (body: `type=docker-compose`, `git_repository=...`, `git_branch=main`, `docker_compose_location=/infra/docker-compose.yml`, `environment_uuid=p61gjclkyz58fmdkd0owxqk8`) |
| Set env var | `POST /api/v1/applications/{uuid}/envs` (body: `{key, value, is_build_time}`) |
| Set domain | `PATCH /api/v1/applications/{uuid}` (body: `{fqdn: "mcp.domovina.ai"}`) |
| Trigger deploy | `POST /api/v1/deploy?uuid={uuid}` ili `POST /api/v1/applications/{uuid}/deploy` |
| Stream logs | `GET /api/v1/applications/{uuid}/logs` |

### Skripta scaffold (TBD u Fazi 8)

```bash
#!/usr/bin/env bash
# scripts/coolify-deploy.sh — idempotent deploy/update na Coolify
set -euo pipefail
: "${COOLIFY_TOKEN:?missing}"; : "${COOLIFY_BASE:=https://app.domovina.link/api/v1}"
PROJECT="px79sl4tx5o2ehbk5kpgbxp0"; ENV="p61gjclkyz58fmdkd0owxqk8"
APP_NAME="domovina-rag-mcp"

# 1. Find existing app or create
APP_UUID=$(curl -sS -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_BASE/projects/$PROJECT/applications" | jq -r ".[] | select(.name==\"$APP_NAME\") | .uuid")

if [ -z "$APP_UUID" ]; then
  APP_UUID=$(curl -sS -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"'"$APP_NAME"'","type":"docker-compose","git_repository":"https://github.com/domovinatv/domovina-rag","git_branch":"main","docker_compose_location":"/infra/docker-compose.yml","environment_uuid":"'"$ENV"'"}' \
    "$COOLIFY_BASE/applications" | jq -r .uuid)
  echo "Created app $APP_UUID"
fi

# 2. Upsert env vars iz lokalnog .env.coolify (gitignored)
while IFS='=' read -r key val; do
  [[ "$key" =~ ^# ]] && continue; [[ -z "$key" ]] && continue
  curl -sS -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" -H "Content-Type: application/json" \
    -d "{\"key\":\"$key\",\"value\":\"$val\",\"is_build_time\":false}" \
    "$COOLIFY_BASE/applications/$APP_UUID/envs"
done < .env.coolify

# 3. Trigger deploy
curl -sS -X POST -H "Authorization: Bearer $COOLIFY_TOKEN" \
  "$COOLIFY_BASE/deploy?uuid=$APP_UUID"

echo "Deploy triggered for $APP_UUID"
```

### Pripadni `.env.coolify` (gitignored, locally only)

```
POSTGRES_DB=rag
POSTGRES_USER=rag_user
POSTGRES_PASSWORD=...
CLICKHOUSE_DB=rag
CLICKHOUSE_USER=rag_user
CLICKHOUSE_PASSWORD=...
MCP_AUTH_MODE=api_key
MCP_API_KEY=...
EMBEDDER_MODEL=BAAI/bge-m3
```

**Open items prije Faze 8:**
- Verificirati točan API shape preko OpenAPI spec-a (može se razlikovati per Coolify minor version)
- Kreirati Coolify API token jednokratno preko UI-a
- Dodati `.env.coolify` u `.gitignore` (već treba biti, ali eksplicitno)

## Sigurnost — NE zaboraviti

- [ ] **Secrets nikad u repo-u.** `.env`, `.env.production`, sve preko Coolify env UI.
- [ ] **MCP API key ne smije biti u logovima.** Provjeri da MCP server u `services/mcp/src/server.ts` ne loguje `Authorization` header.
- [ ] **CH user nije default** — `rag_user`, ne `default`. Default disable-aj.
- [ ] **Firewall**: VPS `ufw` allow samo 22 (SSH, ideal preko Tailscale ili IP whitelist), 80/443. CH 8123/9000 NE expose-aj.
- [ ] **Backup retention**: stari snapshot-i u R2 — postavi lifecycle rule (delete > 30 days).
- [ ] **Rate limit MCP** (Faza 4 per CLAUDE.md): defer dok ne imaš public traffic.

## Troubleshooting / poznati edge case-i

| Simptom | Uzrok | Fix |
|---|---|---|
| `BACKUP` baca `disk 'r2_backup' not found` | Config XML nije mounted ili tipfeler | Provjeri `<allowed_disk>` element, restart CH |
| `RESTORE` baca `Cannot read object key from S3` | Lifecycle rule obrisao snapshot, ili tipfeler u keyu | List u R2 UI, provjeri tačan name |
| Embedder OOM na cloud-u | VPS premali, bge-m3 needs ~3 GB | Upgrade VPS na 8 GB ili koristi `bge-small-multilingual` (mali quality drop, ali 4× brže) |
| MCP query latency > 3s | Embedder CPU spor; HNSW index loš | Provjeri da CH ima `vector_similarity` index aktivan (`SELECT * FROM system.data_skipping_indices`); osigurati da query embed je cached (rare to repeat exact query) |
| Cloudflare proxy returns 502 | Proxy ON ali Traefik na port-u koji CF ne expecta | DNS proxy OFF, Coolify Traefik radi vlastiti TLS |
| Restore traje dugo (>30 min) | CH parti se mergaju + index rebuild | Normalno za prvi run; sljedeći incremental backup-i će biti brzi |

## Otvorena pitanja prije start-a

- [ ] **Domena**: `mcp.domovina.ai` ili nešto drugo? (utječe na DNS, TLS)
- [ ] **Coolify VPS**: već imaš ili treba provisionirati? (Hetzner CX31 preporuka)
- [ ] **R2 vs S3**: R2 preporuka (zero egress, jeftinije), ali ako imaš već AWS account → S3 isto radi
- [ ] **Public access policy**: anyone-with-API-key, ili allowlist klijenata? (Faza 1: API key; Faza 4: OAuth 2.1 + DCR)
- [ ] **Frontend rollout**: kad i kako `domovina.ai` frontend ide live i koristi MCP?

## Referencirane memorije

- [[project-mps-embedder-host]] — zašto MPS embedder NE u produkciji
- [[reference-db-architecture]] — zašto PG+CH ostaju zajedno
- [[decision-fulltext-engine-deferred]] — zašto ne Meilisearch sad
- [[status-snapshot]] — current state, za update poslije Faze 6
