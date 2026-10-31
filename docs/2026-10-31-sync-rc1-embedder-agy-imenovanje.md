# RAG sync 31.10.2026.: lažni rc=1, embedder koji ostaje upaljen, imenovanje klastera kroz agy

Tri kvara otkrivena istog dana, sva tri tiha. Popravci: `5e6bfc6`, `1362bf7` + `26a5c8d`, `d132aa9`
(i u produceru `fetch.domovina.tv` `9f166dc3`, `tools/agy_json_cli.js`).

## 1. `sync-incremental.sh` je od 27.10. uvijek vraćao rc=1

Zadnja naredba skripte bila je `[ -s "$REINGEST_WIP" ] && { ... }`. Kad je red ponovnog unosa
prazan (gotovo svaku noć), test vrati 1, a to postane izlazni kod cijele skripte, iako je sync
uspio. `sync-cron.sh` sve izvedene korake vrti samo uz `RC==0`, pa su **od 29.10. do 31.10.
svaku noć preskočeni**: Meili, Meili segments (`find_in_transcript`), person hub,
`person_mentions`, vektorska mapa, mapa osoba i stats deploy. Embeddinzi su na cloud stizali,
pa semantička pretraga nije pokazivala kvar.

Popravak: `if [ -s ... ]; then ...; fi`. Pravilo: **zadnja naredba skripte pod `set -e` nikad
ne smije biti `test && akcija`.**

Prvi run nakon popravka (31.10. 14:36): `rc=0 warn=0`, segments su dobili 15 zaostalih epizoda,
person hub 3093 osobe, 45 118 mentions, stats deployan.

## 2. Host embedder je ostajao upaljen danima

`sync-cron.sh` diže MPS embedder (uvicorn na :8008) kad ga nema, ali ga nikad nije gasio.
31.10. je zatečen star 2,5 dana s ~10 GB RSS + 7 GB komprimirano; swap je narastao na 20 GB i
slobodan disk na `/` pao na 2 GB usred nightly obrade.

Sad: `STARTED_EMBEDDER=1` + `trap stop_own_embedder EXIT` gasi embedder **samo ako ga je ovaj
run podigao** (ručno pokrenut ostaje). Stari `pkill -9 -f "uvicorn app.main"` je pogađao i
uvicorn drugih projekata (adria-analytics), pa je suženo na port `$EMBEDDER_PORT`.

### Mjerenje (2 epizode, 137 chunkova, uzorak svakih 10 s)

| | prije | najgore | nakon |
|---|---|---|---|
| slobodno na `/` | 14 GB | 8 GB | 11 GB |
| swap | 16,8 GB | 22,8 GB | 20,9 GB |
| embedder RSS | — | 0,66 GB | ugašen |

Embedder za mali delta treba < 1 GB. Rast swapa tijekom synca tjera **Docker VM**
(14 GB + 24 GB komprimirano: ClickHouse, Meili, Postgres i nepovezani kontejneri), ne embedder.

## 3. Vektorska mapa i mapa osoba bez imena klastera

`vectormap_common.py` je imenovao klastere kroz Vertex (403, deprecated od 29.10.) s fallbackom
na `gemini` CLI (pada). Klasteri su izlazili prazni ili naslijeđeni.

Sad je jedini backend **agy**: `_gemini_agy()` zove producerov
`../fetch.domovina.tv/tools/agy_json_cli.js` (stdin → JSON, tmux sesija `agymap`, put se
može prepisati s `AGY_JSON_CLI`). Vertex i gemini CLI ostaju u kodu kao DEPRECATED.
Prvi run: vektorska mapa 53 + 240 klastera, mapa osoba 43, sve imenovano; ~30 s po batchu
od 60 klastera, ukupno 6 agy poziva (~4 min). Ovisnost: repo `fetch.domovina.tv` mora biti
sibling, a `agy` i `tmux` na PATH-u (`cron-path.sh` dodaje `/opt/homebrew/bin`;
`agy` je u `~/.local/bin`, koji `cron-path.sh` dodaje od 31.10.; provjereno s launchd PATH-om
`/usr/bin:/bin:/usr/sbin:/sbin`).

## Otvoreno

- Prvi noćni run s agy imenovanjem (01.11. 04:00): u logu tražiti `imenovanje preko agy OK`.
- Docker VM memorija: limit veći od onoga što Mac podnese uz ostalo; smanjiti ili ugasiti
  kontejnere koji ne trebaju (odluka korisnika).

## Vezani dokumenti

- `docs/data-refresh-flow.md` — cijeli dnevni ciklus
- producer: `docs/2026-10-28-vertex-iskljucen-agy-jedini-gemini.md`
