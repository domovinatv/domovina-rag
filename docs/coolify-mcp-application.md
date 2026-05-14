# Coolify Application setup — MCP servis

Ovaj dokument opisuje kako deployati MCP servis kao **zaseban Coolify Application**
resurs (umjesto kao dio glavnog compose stack-a). Glavni razlog: **rolling deploy
+ zero-downtime**, što compose deployment ne podržava (memory:
`lessons_coolify_compose_no_rolling`).

## Arhitektura

```
                          mcp.domovina.link (ili .ai)
                                  │
                                  ▼
                  ┌────────────────────────────────┐
                  │  Coolify Application: mcp      │  ← rolling, zero-downtime
                  │  Build: services/mcp/Dockerfile│
                  └────────────────────────────────┘
                                  │
                                  │ docker network: <compose-stack>_internal
                                  ▼
              ┌────────────┬─────────────┬──────────────┐
              │ postgres   │ clickhouse  │ embedder     │  ← compose stack
              │ (5432)     │ (8123)      │ (8000)       │     (privatno, internal)
              └────────────┴─────────────┴──────────────┘
```

Kompletni compose stack (`postgres`, `clickhouse`, `embedder`) i dalje vrti kao
Coolify Compose resurs. **Samo MCP** je izdvojen kao Application.

## Setup koraci

### 1. Domena

DNS:

```
mcp.domovina.link  →  CNAME  →  Coolify server hostname
```

Cloudflare proxy: **omogući** (orange cloud) za HTTPS + DDoS + cache.
Kasnije, kad budeš spreman, isti recept za `mcp.domovina.ai` (zamijeniti postojeći
compose-deployed MCP).

### 2. Coolify Application kreiranje

U Coolify UI:

1. Projekt **domovina-rag** → **+ New Resource** → **Application**
2. Source: **Public Repository** (ili GitHub App ako je već povezan)
   - Repository: `github.com/domovinatv/domovina-rag`
   - Branch: `main`
3. Build:
   - **Build Pack: Dockerfile**
   - **Base Directory:** `/services/mcp`
   - **Dockerfile Location:** `Dockerfile` (relativan u odnosu na Base Directory)
4. Ports:
   - **Ports Exposes:** `3000`
   - **Ports Mappings:** ostavi prazno (Traefik ga interno hvata)
5. Network:
   - **Connect Predefined Networks:** odaberi `<compose-stack-uuid>` mrežu na kojoj
     vrte `postgres`, `clickhouse`, `embedder`. Ovo je ključno — bez share-ane mreže
     MCP neće moći resolvati `postgres` / `clickhouse` / `embedder` po service imenu.

     Ako Coolify ne nudi UI checkbox, koristi **Custom Docker Options**:
     ```
     --network <stack-uuid>
     ```

     Stack network ime saznaš na hostu: `docker network ls | grep internal`.
6. Domains:
   - **Domains:** `https://mcp.domovina.link`
   - **HTTPS Enabled:** ✅ (auto Let's Encrypt preko Traefik)
7. Healthcheck:
   - **Health Check Path:** `/health`
   - **Health Check Port:** `3000`
   - **Healthcheck Method:** `GET`
   - **Interval:** `10` s
   - **Start Period:** `15` s

### 3. Environment varijable

U Application → **Environment Variables**:

```bash
# Transport
MCP_TRANSPORT=http
PORT=3000

# Database connections (preko share-ane internal mreže prema compose stack-u)
POSTGRES_URL=postgres://<user>:<password>@postgres:5432/<db>
CLICKHOUSE_URL=http://<user>:<password>@clickhouse:8123/<db>
EMBEDDER_URL=http://embedder:8000

# Public base URL — OAuth issuer + icons[] srcovi se izvode odavde
MCP_PUBLIC_BASE_URL=https://mcp.domovina.link

# Auth (OAuth + static API key)
MCP_AUTH_MODE=apikey
MCP_API_KEY=<isti API key kao u .env za postojeći deploy ili novi za .link>

# Admin dashboard (opcionalno)
ADMIN_API_KEY=<Bearer token za /admin>

# OAuth GC
OAUTH_GC_INTERVAL_HOURS=24
OAUTH_GC_RETENTION_DAYS=90
```

> **Napomena**: PG/CH credovi moraju biti **isti** kao u glavnom compose stack-u
> (jer Application share-a istu bazu). Najlakše: kopiraj iz Coolify-eve env
> tablice za compose resurs.

### 4. Deploy

Klikni **Deploy**. Coolify:
1. Klonira repo
2. Buildaa `services/mcp/Dockerfile` (multi-stage, ~30 s s cache-om)
3. Spawne novi container, čeka da healthcheck postane healthy
4. Tek tada gasi stari container (rolling) → **zero-downtime**

### 5. Verifikacija

```bash
curl -s https://mcp.domovina.link/health
# {"status":"ok","service":"domovina-podcast","version":"0.3.0"}

curl -s https://mcp.domovina.link/.well-known/oauth-authorization-server | python3 -m json.tool
# issuer mora biti "https://mcp.domovina.link/"
```

## Lokalni dev (Docker)

Production MCP nije više u glavnom `docker-compose.yml`. Za lokalni full-stack:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d
```

`docker-compose.dev.yml` re-dodaje `mcp` servis identičnoj produkciji, ali bez
Traefik labela (port 3000 mapped na host).

## Migracija s compose deploy-a na Application

Kad budeš spreman zamijeniti `mcp.domovina.ai` deploy s Application varijantom:

1. **Application varijantu testiraj** na `mcp.domovina.link` (paralelno)
2. Kad si zadovoljan, u Coolify compose resursu — ukloni MCP servis (već učinjeno u
   ovom commit-u)
3. Redeploy compose stack (postgres/clickhouse/embedder ostaju)
4. U Application postavi `mcp.domovina.ai` kao alias domain (Coolify UI → Domains →
   dodaj drugi domain)
5. CF cache purge za obje zone

Stari OAuth tokeni iz PG-a će raditi za oba URL-a sve dok `MCP_PUBLIC_BASE_URL`
matcha s issuer-om u PG zapisima. Ako mijenjaš issuer (s `.ai` na `.link`), klijenti
moraju re-registrirati (DCR).

## Troubleshooting

### "Cannot reach postgres" / "Cannot reach clickhouse" iz MCP Application-a

Network bridge nije aktivan. Provjeri:

```bash
docker inspect <mcp-app-container> --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool
docker inspect <postgres-container> --format '{{json .NetworkSettings.Networks}}' | python3 -m json.tool
```

Oba moraju imati barem jednu zajedničku mrežu.

### Rolling deploy ipak radi stop-then-start

Provjeri da Application resurs nije Compose-based. Build Pack mora biti
**Dockerfile** (ne **Docker Compose**) da Coolify napravi rolling.

### Stari container ne odlazi nakon deploya

To je dobro za rolling — Coolify drži starog dok novi ne prođe healthcheck. Ako
oba ostanu duže od 60 s, healthcheck novog je broken. Pogledaj logs u Coolify UI.
