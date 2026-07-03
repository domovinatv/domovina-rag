# Person hub — cross-channel profil govornika

Read-only, javna, korpus-wide značajka: **jedna osoba → sve epizode u kojima
GOVORI, kroz sve kanale, iza stabilnog javnog slug-a** (`/p/don-tomislav-lukac`).
Živi u `domovina-rag` (NE u `domovina-api` — tamo je user-auth/finance).

## Granice (locked)

- **"Govori" only** — filter na `rag_chunks.speaker` (diarizirani/imenovani
  govornik). NE "spominje se u tekstu" (bez NER-a).
- **Identitet = normalizacija + ručni aliasi** — bez voice-embedding rezolucije
  (Faza 3 ostaje deferred). Slug (ASCII-fold imena) JE ključ identiteta: sve
  case/dijakritika/crtica varijante iste osobe spajaju se u jedan red.

## Komponente

| Sloj | Datoteka | Uloga |
|---|---|---|
| Migracija | `infra/postgres/migrations/002_speakers_hub.sql` | `speakers.slug` (UNIQUE) + `avatar_url` + indexi |
| Schema (fresh) | `infra/postgres/init.sql` | isti stupci za nove deploye |
| Populate | `services/etl/etl/speakers.py` + `python -m etl speakers` | CH distinct govornici → normalizacija → PG `speakers` |
| Ručni seed | `infra/postgres/seeds/speaker_aliases.csv` | merge-evi koje automatika ne pogodi (samo-ime, nadimak) |
| REST | `services/mcp/src/public-api.ts` → `GET /api/person/:slug` | frontend (domovina.ai), no-auth, CORS + IP rate-limit |
| MCP tool | `services/mcp/src/tools/get-person.ts` → `get_person` | ista logika na MCP površini (samo HTTP transport — treba PG) |
| Mentions (CH) | `infra/clickhouse/init.sql` → `episode_mentions` + ETL hook (`load.py`, `python -m etl mentions`) | spomeni iz `summary.mentioned_people` |
| Mentions (PG) | `infra/postgres/migrations/003_person_mentions.sql` → `person_mentions` + `scripts/sync-person-mentions.sh` | derivat CH → PG, čita ga `/api/person` |
| Testovi | `services/etl/tests/test_speakers.py` + `test_mentions.py` + e2e `person-hub-*` | normalizacija + mentions (unit) + endpoint (e2e) |

## Normalizacija (populate skripta)

1. `SELECT DISTINCT arrayJoin(splitByChar(',', speaker))` iz CH, trim.
2. **Isključi**: prazno, `SPEAKER_XX`, role-labele (`Voditelj`, `Sugovornik`,
   `Gost N`, `UNKNOWN`, … — regex `_ROLE_RE` + blocklist u `speakers.py`).
3. **Slug** = fold dijakritike (č→c, ć→c, š→s, ž→z, đ→d) + lowercase +
   non-alnum→`-`. Deterministički iz normaliziranog imena → **stabilan public
   URL** kroz re-runove.
4. Grupiraj po slug-u → **canonical_name** = najčešća sirova varijanta;
   **aliases[]** = svi sirovi CH tokeni te osobe (endpoint matcha po njima).
5. Ručni seed (CSV) se primijeni na kraju; `needs_review=true` na svima.
6. UPSERT po slug-u + prune zastarjelih (`slug IS NOT NULL` redovi kojih nema u
   svježem buildu; ručni/voice redovi bez slug-a se NE diraju).

Endpoint matcha osobu kao **cijeli token**:
`arrayExists(x -> x IN aliases, arrayMap(trim, splitByChar(',', speaker)))` —
NE substring (inače bi "Vinko" pokupio "Vinko Mihaljević").

## Spominje se u (mentions)

Osoba se u epizodi može **spominjati** a da ne **govori**. Govori = diarizirani
speaker u `rag_chunks.speaker` (agregira ga `episodes[]`). Spominje se =
nalazi se u `summary.mentioned_people` te epizode. To polje NIJE u ClickHouse
`rag_chunks` — živi u producerovom `{basename}.wav.canary.summary.json` sidecar-u.

Put podatka (paralela speakers-a, ali izvor je **lokalni CH** jer summary.json
postoji samo lokalno — nikad se ne push-a u cloud CH):

1. **ETL → CH `episode_mentions`**: `load.py` čita sibling summary.json pri
   svakom ingestu (novi epizode); `python -m etl mentions --input /data` je
   backfill za postojeće (per-disk, kao ingest). Red = `(youtube_id, channel,
   upload_date, title, person)`, `person` je sirovo ime.
2. **CH → PG `person_mentions`**: `scripts/sync-person-mentions.sh` (local +
   `--cloud`) čita lokalni CH, slugificira `person` **istim** algoritmom kao
   `speakers.slug` (`emit_person_mentions_sql.py` → `etl.speakers.slugify`),
   full-refresh (`DELETE`+`INSERT`) u PG. `--cloud` piše u cloud PG ali i dalje
   čita **lokalni** CH. Dio dnevnog cron-a (korak 6b u `sync-cron.sh`).
3. **`/api/person` → `mentions[]`**: čita `person_mentions WHERE slug`, **izbaci
   youtube_id koji su već u `episodes[]`** (govori ima prednost), sort
   `upload_date` desc, `deep_link = /v/{id}` **bez** `/t/` (nema speaking-timestamp).

Slug se poklapa jer je isti fold: "Ante Čaljkušić" → `ante-caljkusic` i kao
speaker i kao mention. Osoba koja se **samo** spominje (nema `speakers` red)
i dalje vraća 404 — mention-only profili su izvan scope-a.

## Deploy runbook

Vrijedi za svaki DB (lokalno + cloud). `speakers` je 100% izveden iz CH, pa
populate treba **nakon** što je CH ingest/sync gotov.

```bash
# 1. Migracija (init.sql se NE re-runa nakon prvog deploya — vidi memoriju
#    lessons-pg-init-sql-not-rerun). Primijeni ručno:
psql "$POSTGRES_URL" -f infra/postgres/migrations/002_speakers_hub.sql
#    Cloud: Coolify → Postgres resurs → Terminal, isti file.

# 2. Populate (idempotentno; slugovi stabilni). Dry-run prvo:
docker compose --profile etl run --rm etl speakers --dry-run
docker compose --profile etl run --rm etl speakers

# 3. Re-run nakon svakog većeg CH ingesta/synca (novi govornici).
#    Može se okačiti na isti dnevni cron kao Meili re-index (data-refresh-flow.md).
```

Deploy MCP-a (novi `/api/person` + `get_person`) ide kroz Coolify **Application**
rolling deploy (`coolify-mcp-application.md`), kao i dosad.

## Verifikacija

```bash
curl -s $BASE/api/person/zeljka-markic | jq '{name, episode_count, channel_count}'
curl -s -o /dev/null -w '%{http_code}\n' $BASE/api/person/ne-postoji   # → 404

# e2e (person kategorija; ne treba embedder):
cd services/mcp
MCP_API_KEY=$KEY MCP_URL=$BASE TEST_CATEGORY=person node test/e2e/run.mjs
```

## Response shape (`GET /api/person/:slug` == `get_person`)

```jsonc
{
  "name": "Željka Markić",
  "slug": "zeljka-markic",
  "avatar_url": null,                       // opcionalno (kolona postoji, zasad NULL)
  "channel_count": 3,
  "episode_count": 154,
  "channels":  [{ "channel": "…", "count": 150 }],   // count = broj epizoda na kanalu
  "episodes":  [{ "youtube_id": "…", "title": "…", "channel": "…",
                  "upload_date": "2026-06-05", "first_ts": 6,
                  "deep_link": "https://domovina.ai/v/…/t/6" }],
  "timeline":  [{ "month": "2019-01", "count": 3 }],  // count = broj epizoda u mjesecu
  "mentions":  [{ "youtube_id": "DR9rrCDpnTA", "title": "…", "channel": "…",
                  "upload_date": "2026-04-24",
                  "deep_link": "https://domovina.ai/v/DR9rrCDpnTA" }],  // BEZ /t/
  "mention_episode_count": 1
}
```

`first_ts` = najranija sekunda u kojoj osoba govori u toj epizodi. Deep link
gađa frontend player rutu `https://domovina.ai/v/{youtube_id}/t/{first_ts}`.

`mentions[]` = epizode gdje se osoba **spominje** ali ne govori (disjunktno od
`episodes[]`); `deep_link` je `/v/{id}` bez `/t/`. `mention_episode_count` =
`mentions.length`. Osoba bez spomena → `mentions: []`, `mention_episode_count: 0`
(backward-compat; stari klijenti nezahvaćeni).

### Deploy mentions (uz gornji runbook)

```bash
# 1. Migracija person_mentions (init.sql se NE re-runa; sync skripta usto self-bootstrapa):
psql "$POSTGRES_URL" -f infra/postgres/migrations/003_person_mentions.sql
# 2. CH episode_mentions tablica na lokalnom CH (init.sql se NE re-runa; kreiraj ručno ili
#    re-createom sheme) + backfill po disku:
DATA_SOURCE_DIR=/Volumes/DOMOVINA1TB/... docker compose --profile etl run --rm etl mentions --input /data
DATA_SOURCE_DIR=/Volumes/DOMOVINA2TB/... docker compose --profile etl run --rm etl mentions --input /data
# 3. Derivat u PG (local + cloud):
./scripts/sync-person-mentions.sh
./scripts/sync-person-mentions.sh --cloud
# 4. Redeploy MCP (Coolify Application, rolling) — /api/person novi mentions dio.
```
