# Meilisearch ključevi i frontend integracija — runbook

Trajni referentni dokument za Meili **autentikaciju** (master + search-only key)
i kako se ti ključevi protežu kroz cloud (Coolify) i frontend (domovina.ai).
Za sam deploy containera vidi `coolify-meili-application.md`; ovaj doc je o
ključevima i wiringu.

## Model ključeva

Meilisearch ima **master key** (admin: sve) i izvedene **API ključeve**
(scoped: npr. samo `search`). Ključna činjenica:

> Meili izvodi `key` string **deterministički** kao `HMAC-SHA256(master_key, uid)`.

Posljedica: **isti master key + isti `uid` → IDENTIČAN search-key string na
svakoj instanci** (lokalni dev I cloud). Zato:
- jedan master key vrijedi za sve okoline (lokalni + cloud koriste isti),
- search-only key je deterministički pa ga frontend može imati kao **default u
  kodu** (`meili_client.dart`) — radi protiv lokalnog i cloud Meilija bez rebuilda.

### Aktualne vrijednosti (gdje žive, NE commitane)

| Ključ | Gdje | Napomena |
|---|---|---|
| `MEILI_MASTER_KEY` | `domovina-rag/.env` (lokalno, gitignored) + Coolify env (cloud, `domovina-rag` app `ddvxwy…`) | admin; NIKAD u frontend |
| `MEILI_SEARCH_UID` | `domovina-rag/.env` | fiksni uuid za deterministički search-key (`39ed0b6b-…`) |
| `MEILI_SEARCH_KEY` | izveden iz gornja dva; default u `domovina.ai/lib/services/meili_client.dart` | read-only (`actions:[search]`, `indexes:[episodes]`); siguran za bundle |

> Master key generiran s `openssl rand -hex 32`. Ako ga rotiraš, search-key se
> mijenja → moraš re-provisionirati (`meili-provision-keys.sh`) i re-buildati
> frontend s novim defaultom/dart-define.

## Skripte (domovina-rag/scripts/)

| Skripta | Što radi |
|---|---|
| `meili-provision-keys.sh` | Idempotentno registrira search-only key s fiksnim `uid`-om, ispiše `MEILI_SEARCH_KEY`. `--cloud` preko SSH tunela. |
| `sync-meili.sh` | (Re)indeksira `episodes` iz lokalnog CH-a. `--local` / `--cloud`. |
| `meili-poc-index.py` | Indexer (CH article_summary + PG title → Meili dokumenti). |

## Frontend wiring (domovina.ai)

`lib/services/meili_client.dart` čita preko `--dart-define`:
- `MEILI_URL` — prod `https://search.domovina.ai`; bez override-a dev (`localhost:7700`, Android emu `10.0.2.2:7700`)
- `MEILI_SEARCH_KEY` — read-only; ima radni **default** u kodu (deterministički), pa override treba samo ako prod master key drukčiji

`scripts/deploy.sh` embeda oba ako su u `.env` (uz Supabase defines). Ruta
`/search` registrirana u `lib/router/app_router.dart` → `MeiliSearchScreen`.

## Cloud provisioning (Coolify API, iz domovina-api skripti ili ručno)

Master key se postavlja na **`domovina-rag` compose app** (`ddvxwyfmd2ynx3fyl96p7ltq`),
NE na Supabase service ni MCP app (`amu4q428…`). Coolify API:

```bash
# set env (iz domovina-api repo-a, .local-secrets.env ima COOLIFY_API_TOKEN)
curl -X POST "$COOLIFY_API_URL/api/v1/applications/ddvxwyfmd2ynx3fyl96p7ltq/envs" \
  -H "Authorization: Bearer $COOLIFY_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"key":"MEILI_MASTER_KEY","value":"<master>","is_preview":false}'
# redeploy (pull main HEAD → digne Meili servis iz compose-a)
curl -X POST "$COOLIFY_API_URL/api/v1/deploy?uuid=ddvxwyfmd2ynx3fyl96p7ltq" \
  -H "Authorization: Bearer $COOLIFY_API_TOKEN"
```

Nakon što se cloud Meili digne:
```bash
./scripts/sync-meili.sh --cloud            # napuni episodes index
./scripts/meili-provision-keys.sh --cloud  # registrira isti search-key uid
```

## Coolify resource mapa (domovina-rag)

| UUID | Što |
|---|---|
| `ddvxwyfmd2ynx3fyl96p7ltq` | **compose stack** — postgres, clickhouse, embedder, **meilisearch**. Ovdje ide MEILI_MASTER_KEY. |
| `amu4q428khkefqhu5zd6cq88` | MCP Application (zaseban, rolling deploy) |

## Sigurnosna pravila

- **Master key NIKAD u frontend / git.** Samo search-only key ide u bundle.
- Search-only key je read-only (`search` action) → bezopasan ako procuri; max šteta je čitanje javnog korpusa.
- Rotacija master keya: nova vrijednost u `.env` + Coolify env, redeploy, re-provision search-key, re-build frontend.

## Vezano
- `coolify-meili-application.md` — deploy containera, CF Tunnel, CORS
- `scripts/meili-provision-keys.sh`, `scripts/sync-meili.sh`
- `cloud_deployment_plan.md` — opći CF Tunnel/Traefik pattern
