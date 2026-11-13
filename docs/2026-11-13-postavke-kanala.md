# Postavke kanala u RAG-u (lanac „postavke kanala”, S8)

13. 11. 2026. Vlasnik YouTube kanala isključuje funkcionalnosti po kanalu. Ovaj repo
čita stanje iz kataloga i poštuje četiri ključa: `ai_assistants`, `in_app_search`,
`transcript_subtitles`, `persons_mentions` (+ `news_portal` za `/api/search?purpose=news`).
Izvor lanca: `../domovina.ai/postavke-kanala/` (plan, matrica provedbe §4, §11, §15, §17).

## Izvor stanja

`GET https://domovina.ai/api/katalog/v1/settings` →
`{"version":"1","settings":{"UC…":{"status","off":[…],"slugs":[…]}}}`. Navedeni su
samo kanali s barem jednim isključenim ključem; svi ostali su „sve uključeno”, a
nepoznat ključ je uključen.

- **Zatvaranje ovisnosti** je isto kao `closeOff` u `fetch.domovina.tv/lib/channel_settings.js`:
  `withdrawn`/`deleted` ili `channel_enabled` off → svih 20 ključeva; `transcript_subtitles`
  off → svi AI ključevi (pa preko `article_summary` i njegovi ovisni); `article_summary`
  off → `ebook`, `magisterium`, `english_translation`, `share_clips`, `news_portal`.
  Implementacije: `services/mcp/src/channel-settings.ts` i `scripts/channel_settings.py`.
- **UC → slug** ide preko polja `slugs`. Ovdje je kanal slug (`rag_chunks.channel`,
  ime direktorija producera: `domovina_tv`), a katalog piše `domovina-tv`, pa se
  uspoređuje normalizirano (lowercase, `_` → `-`). Za upite nad bazom i Meilijem se
  iz normaliziranog sluga izvode sve varijante pisanja (`domovina-tv`, `domovina_tv`)
  i filtar je običan `channel NOT IN [...]`.
- **Kanal bez `slugs`** (katalog prije tog polja) se ne može preslikati: ne filtrira
  se, uz upozorenje u logu (MCP jednom po UC-u po procesu, sync jednom po runu).

## Što se filtrira gdje

| Mjesto | Ključ (nakon zatvaranja) | Kako |
|---|---|---|
| MCP `search_podcasts`, `list_channels`, `list_episodes`, `get_episode`, `server_info` | `ai_assistants` | `WHERE channel NOT IN …` prije `LIMIT`; `get_episode` vraća `EPISODE_NOT_FOUND` |
| MCP `count_mentions` | `ai_assistants`; uz `group_by=speaker` i `persons_mentions` | isto |
| MCP `find_in_transcript` | `ai_assistants`, `transcript_subtitles` | Meili filtar `channel NOT IN [...]` u upitu |
| MCP `get_person` | `ai_assistants`, `persons_mentions` | CH upit + filtar spomena (PG `person_mentions`) |
| `GET /api/search` (i `mode=map`) | `purpose=search` → `in_app_search`, `assistant` → `ai_assistants`, `news` → `news_portal` | `WHERE` prije `LIMIT`; bez `purpose` = `search` (stari buildovi); nepoznata vrijednost → `400 {"error":"invalid_purpose"}` |
| `GET /api/person/:slug` | `persons_mentions` | epizode kanala izostaju iz `episodes[]`, `cameo_episodes[]` i `mentions[]`; `is_virtual_channel` se računa bez njih |
| `GET /api/persons` | `persons_mentions` | epizode se ne broje, pa osoba ispod praga ispada iz indeksa; 15-min cache je vezan uz skup skrivenih kanala |
| Meili `episodes` (`scripts/meili-poc-index.py`) | `in_app_search` | sekcije kanala ne ulaze u build (puni rebuild + swap svaku noć) |
| Meili `segments` (`scripts/meili-segments-index.py`) | `in_app_search`, `transcript_subtitles` | nove epizode se ne indeksiraju; indeksirane se brišu zajedno sa stanjem u `segments_state` |

Osoba poznata samo iz isključenog kanala dobiva prazan profil (200), ne 404 — isto
načelo kao opt-out: podijeljeni `/p/` link ne smije puknuti.

**`is_virtual_channel` se ne predračunava nigdje u syncu** (provjereno grepom:
`grep -rn -i virtual scripts/ services/etl/etl/ infra/` nalazi samo migraciju 006).
`emit_person_mentions_sql.py` i `sync-speakers.sh` pune samo sirove tablice
(`person_mentions`, `speakers`), a pravilo (`tools/person-channel.ts`) se računa u
svakom upitu — zato je upitni filtar dovoljan i djeluje odmah.

## Što se NE mijenja

- **`rag_chunks` se ne briše prekidačem** (odluka orkestratora): ponovno uključivanje
  bi tražilo re-embed. Fizičko brisanje radi samo skripta trajnog brisanja (S9).
- **ETL / `sync-incremental.sh` ne preskače nove epizode.** `rag_chunks` je izvor i za
  Meili `episodes`/`segments` i za person hub, pa bi preskakanje zbog `ai_assistants`
  izbacilo epizodu i iz pretrage u aplikaciji kojoj je `in_app_search` uključen.
  Kanal kojem je sve isključeno (`channel_enabled`/`processing`) ionako ne dobiva nove
  artefakte iz pipelinea (S7).
- **Nije pokriveno ovdje:** `scripts/sync-person-map.sh` i `sync-vector-map.sh` /
  `sync-stats.sh` (stats.domovina.ai mape i statistike), admin dashboard, Vertex AI
  import u pipelineu.

## Latencija

| Put | Najgore od upisa u katalog |
|---|---|
| MCP alati | rub kataloga (`max-age=60, stale-while-revalidate=600`, matrica zaključak 2) + TTL snimke 60 s (`CHANNEL_SETTINGS_TTL_SECONDS`) + jedan zahtjev dok pozadinsko osvježavanje ne sjedne |
| `/api/search`, `/api/person/:slug` | gore + `Cache-Control: max-age=300` odgovora |
| `/api/persons` | gore + `Cache-Control: max-age=900` |
| Meili `episodes`, `segments` | do sljedećeg `sync-cron.sh` (04:00), tj. do 24 h |

Zastarjela snimka u MCP-u se vraća odmah, a osvježavanje ide u pozadini — upit ne čeka
katalog. Čeka samo prvi upit nakon starta procesa, i to najviše 5 s (timeout); start
procesa ionako odmah pokrene dohvat.

## Ponašanje pri grešci (čitači nisu fail-closed, odluka 701)

- **MCP:** greška dohvata (mreža, HTTP ≠ 2xx, neispravan JSON) zadržava zadnju uspješnu
  snimku i logira `[channel-settings] GREŠKA … koristim zadnju uspješnu snimku`. Bez
  ijedne uspješne snimke ne filtrira ništa i logira `NEMA uspješne snimke, NE filtriram
  kanale`. Novi pokušaj tek nakon TTL-a, da pad kataloga ne pretvori svaki upit u
  čekanje na timeout.
- **Meili sync:** uspješan dohvat se spremi u `logs/channel_settings.last_ok.json`
  (`CHANNEL_SETTINGS_SNAPSHOT` za drugu putanju). Pad dohvata koristi tu snimku, dakle
  isti skup kao prošli run — indeks se ne smanjuje. Bez snimke se ne filtrira ništa.
- **Zaštita od pokvarenog odgovora:** `episodes` odustaje od zamjene ako bi postavke
  izbacile više od 50 % sekcija; `segments` preskače skrivanje ako bi sakrio više od
  50 % indeksiranih epizoda (`MAX_SETTINGS_HIDE_SHARE`). Postojeći prag (`< 1000`
  dokumenata, `MAX_DELETE`) i dalje mjeri korpus, ne postavke.
- **Prazne postavke** (`"settings":{}`, današnja produkcija) ne mijenjaju nijedan upit
  ni dokument: bez skrivenih kanala SQL nema `NOT IN` ni parametra, a `filter_docs`
  vraća istu listu (testovi to provjeravaju).

## Konfiguracija

| Varijabla | Default | Gdje |
|---|---|---|
| `CHANNEL_SETTINGS_URL` | `https://domovina.ai/api/katalog/v1/settings` | MCP i sync |
| `CHANNEL_SETTINGS_TTL_SECONDS` | `60` | MCP |
| `CHANNEL_SETTINGS_SNAPSHOT` | `logs/channel_settings.last_ok.json` | sync |
| `MAX_SETTINGS_HIDE_SHARE` | `0.5` | `meili-segments-index.py` |

## Kako provjeriti

```bash
# Testovi (bez mreže i živih servisa)
cd services/mcp && npm run typecheck && npm test
python3 -m unittest discover -s scripts/tests -v

# Što katalog trenutno kaže
curl -s https://domovina.ai/api/katalog/v1/settings | python3 -m json.tool

# Nakon deploya MCP-a: nepoznat purpose mora dati 400, poznat 200
curl -s -o /dev/null -w '%{http_code}\n' 'https://mcp.domovina.ai/api/search?q=molitva&purpose=xyz'
curl -s -o /dev/null -w '%{http_code}\n' 'https://mcp.domovina.ai/api/search?q=molitva&purpose=assistant'

# Isključen kanal ne smije biti u pogocima (zamijeni SLUG)
curl -s 'https://mcp.domovina.ai/api/search?q=molitva&limit=25' \
  | python3 -c 'import json,sys; print(sorted({r["channel"] for r in json.load(sys.stdin)["results"]}))'

# Sync: što je skripta odlučila (redak „postavke kanala (…)”)
grep -h 'Postavke kanala\|postavke kanala' .ingest-logs/sync-cron-$(date +%Y%m%d).log
```

Neprovjereno: utječe li `channel NOT IN …` u `WHERE` na korištenje HNSW indeksa
(`vector_similarity`) na cloud ClickHouseu 24.10. Filtri `channel`/`speaker` već prije
su išli u isti `WHERE`, ali s praznim postavkama upit je nepromijenjen. Kad se pojavi
prvi isključeni kanal, izmjeriti `EXPLAIN indexes = 1` i trajanje `/api/search` prije
i poslije.
