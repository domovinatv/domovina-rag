# Person hub — cross-channel profil osobe

Read-only, javna, korpus-wide značajka: **jedna osoba → sve epizode u kojima se
pojavljuje, kroz sve kanale, iza stabilnog javnog slug-a**
(`/p/don-tomislav-lukac`, `/p/ivan-merz`). Živi u `domovina-rag` (NE u
`domovina-api` — tamo je user-auth/finance).

## Granice (locked)

- **Dva izvora pojavljivanja, dva odvojena popisa**: `episodes[]` = osoba
  GOVORI (diarizirani `rag_chunks.speaker`), `mentions[]` = osoba se SPOMINJE
  (`summary.mentioned_people`). Disjunktno — govori ima prednost.
- **Osoba postoji ako je zadovoljen BAR JEDAN izvor.** Povijesna/pokojna figura
  koja nikad nije bila gost (bl. Ivan Merz) ima valjan profil samo iz spomena.
  Do 2026-07-27 identitet je tražio `speakers` red, pa je ~15.5k mention-only
  slugova vraćalo 404 iako je korpus pun spomena — vidi „Mention-only profil".
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
   `upload_date` desc, `deep_link = /v/{id}/t/{sec}` kad je `mention_ts > 0`,
   inače `/v/{id}` (cijela epizoda).

Slug se poklapa jer je isti fold: "Ante Čaljkušić" → `ante-caljkusic` i kao
speaker i kao mention.

> **Stanje korpusa i preostale rupe** (fragmentacija slugova po prezimenu,
> nedostajući `speaking_seconds`/`duration_seconds`, `_unlisted`, pokrivenost
> `mention_ts`) — izmjereno u `docs/person-data-gaps.md`. Pročitaj to prije nego
> kreneš u F1/F2 iz plana virtualnih kanala.

### Mention-only profil (osoba koja nikad ne govori)

Do 2026-07-27 `getPerson` je 404-ao ako nema `speakers` reda — a `speakers` se
puni **isključivo** iz diarizacije. Posljedica: bl. Ivan Merz (33 spomena),
i još ~15.5k slugova od ukupno 17.4k u `person_mentions`, bili su nedohvatljivi,
uključujući entity-chipove u člancima koji već linkaju na `/p/<slug>`.

Sad je identitet **disjunkcija** dvaju izvora:

- `speakers` red postoji → govor-hub (+ eventualni spomeni), kao i prije.
- nema ga, ali `person_mentions` ima redove → hub SAMO iz spomena:
  `episodes: []`, `channels: []`, `timeline: []`, `episode_count: 0`, a
  `mention_channels[]` / `mention_timeline[]` nose iste agregacije nad spomenima
  (bez njih bi takav profil bio potpuno gol).
- ni jedno ni drugo → `PersonNotFoundError` (404). To je jedini 404 slučaj.

**Display ime**: `person_mentions.person_name` (migracija 005) čuva sirovo ime s
dijakritikom; hub uzima najčešću varijantu po slugu. Dok kolona nije popunjena
(prije prvog sync-a nakon migracije) pada na titlecase slug-a — `ivan-merz` →
"Ivan Merz", ali `zeljka-markic` → "Zeljka Markic" (fold je nepovratan). Zato
**pokreni `sync-person-mentions.sh` nakon migracije 005**.

**Pobožni prefiks se skida prije slugify-a** (`strip_veneration` u
`emit_person_mentions_sql.py`): "bl. Ivan Merz", "Blaženi Ivan Merz" i
"Ivan Merz" su jedna osoba, ne tri profila. Klerički naslovi (don, fra, vlč.,
mons.) se NAMJERNO ne diraju — dio su `speakers` konvencije
(`don-tomislav-lukac`), pa bi ih skidanje odvojilo od huba istog čovjeka koji
govori. Efekt se vidi tek nakon sljedećeg `sync-person-mentions.sh`.

### Timestamp deep-link (`mention_ts`)

`deep_link` skoči na TOČAN trenutak spomena kad ga uspijemo razriješiti iz
`article.json` (`iterations[].sections[]`; svaka sekcija: `screenshot_timestamp`
"HH:MM:SS" + `entities[]`). Algoritam pri ETL-u (`read_article_entity_ts` u
`sources.py`, poziva se u `load.py` hooku + `etl mentions` backfillu):

1. Splošti sve sekcije, `clock_to_sec(screenshot_timestamp)` = `start_sec`.
2. Slug-foldaj sve `entities[]` (**isti** `slugify` kao person slug — ASR mrvi
   dijakritike: article "Mi**ć**" vs summary "Mi**č**", pa string-match promašuje).
3. `mention_ts` = NAJRANIJI `start_sec` sekcije gdje `person_slug ∈ entity_slugs`;
   0 ako nema hita.

Precompute (CH `episode_mentions.mention_ts` → PG `person_mentions.mention_ts`)
da `/api/person` ostane jedan jeftin PG upit. `article.json` je lokalni sibling
(`{basename}.wav.canary.diarized_*.article.json`, najnoviji po mtime); ako fali →
tiho 0 (cijela epizoda). **Pokrivenost je namjerno djelomična** (`mentioned_people`
je šire od sekcijskih entiteta — ~59% redova ima ts); "timestamp kad možemo,
cijela epizoda inače". 100% bi tražio pravi NER+entity-linking nad transkriptom.

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
  "mentions":  [{ "youtube_id": "H1eVsztGkeo", "title": "…", "channel": "…",
                  "upload_date": "2025-10-08", "first_ts": 3261,
                  "deep_link": "https://domovina.ai/v/H1eVsztGkeo/t/3261" },   // razriješen ts
                { "youtube_id": "DR9rrCDpnTA", "title": "…", "channel": "…",
                  "upload_date": "2026-04-24", "first_ts": 0,
                  "deep_link": "https://domovina.ai/v/DR9rrCDpnTA" }],          // fallback (cijela epizoda)
  "mention_episode_count": 2,
  "mention_channels": [{ "channel": "…", "count": 2 }],  // agregacije nad mentions[]
  "mention_timeline": [{ "month": "2025-10", "count": 1 }]
}
```

`first_ts` = najranija sekunda u kojoj osoba govori u toj epizodi. Deep link
gađa frontend player rutu `https://domovina.ai/v/{youtube_id}/t/{first_ts}`.

`mentions[]` = epizode gdje se osoba **spominje** ali ne govori (disjunktno od
`episodes[]`); `first_ts` = trenutak spomena iz `article.json` (0 = nepoznato →
`deep_link` bez `/t/`, cijela epizoda). `mention_episode_count` = `mentions.length`.
Osoba bez spomena → `mentions: []`, `mention_episode_count: 0` (backward-compat).

Mention-only osoba (nikad gost) vraća isti shape s praznim govor-dijelom:
`episodes: []`, `channels: []`, `timeline: []`, `episode_count: 0`,
`channel_count: 0` — a `mentions[]` + `mention_channels[]`/`mention_timeline[]`
su popunjeni. Frontend to gata preko `PersonHub.isMentionOnly`.

### Deploy mentions (uz gornji runbook)

⚠️ **NIJEDAN init.sql se ne re-runa nakon prvog deploya — ni PG ni CH.** Dodavanje
kolone postojećoj tablici traži eksplicitan `ALTER` (ili migraciju), inače novi
kod piše u kolonu koje nema. Zato dva migracijska koraka (0. i 1b.) ispod.

```bash
# 0. CH episode_mentions — kreiraj tablicu (prvi put) I dodaj mention_ts kolonu
#    (init.sql se NE re-runa na CH). Lokalni CH (izvor je uvijek lokalni):
docker exec -i $CH clickhouse-client -d rag --user rag_user --password $PW --query \
  "ALTER TABLE episode_mentions ADD COLUMN IF NOT EXISTS mention_ts UInt32 DEFAULT 0"

# 1. Migracija person_mentions (PG init.sql se NE re-runa; sync skripta self-bootstrapa):
psql "$POSTGRES_URL" -f infra/postgres/migrations/003_person_mentions.sql
# 1b. Timestamp deep-link kolona (v0.7.0). sync-person-mentions.sh SCHEMA_SQL ionako
#     ima ADD COLUMN IF NOT EXISTS, pa se cloud sam nadogradi — ali za jasnoću:
psql "$POSTGRES_URL" -f infra/postgres/migrations/004_person_mentions_ts.sql
# 1c. Display ime za mention-only osobe (v0.8.0). Isto: SCHEMA_SQL ima ADD COLUMN,
#     ali bez SYNC-a (korak 3) kolona ostaje NULL → hub pada na titlecase slug-a.
psql "$POSTGRES_URL" -f infra/postgres/migrations/005_person_mentions_name.sql

# 2. Backfill episode_mentions po disku (čita summary.json + article.json siblings):
DATA_SOURCE_DIR=/Volumes/DOMOVINA1TB/... docker compose --profile etl run --rm etl mentions --input /data
DATA_SOURCE_DIR=/Volumes/DOMOVINA2TB/... docker compose --profile etl run --rm etl mentions --input /data
# 3. Derivat u PG (local + cloud; --cloud čita LOKALNI CH, piše cloud PG):
./scripts/sync-person-mentions.sh
./scripts/sync-person-mentions.sh --cloud
# 4. Redeploy MCP (Coolify Application, rolling) — nema push-webhooka, klik u UI.
#    /health verzija potvrđuje da je novi kod živ.
```
