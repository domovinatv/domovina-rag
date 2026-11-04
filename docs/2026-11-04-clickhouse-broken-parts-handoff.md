# Handoff: lokalni ClickHouse ne učitava `rag.rag_chunks` (04.11.2026.)

Napisano iz sesije u `fetch.domovina.tv` nakon analize nightlyja 04.11. Ovdje se
ništa nije diralo; sve ispod je očitano naredbama samo za čitanje.

## Simptom

`tv.domovina.rag.sync` (launchd, 05:00) 04.11. je završio s `rc=210`:

```
[sync 05:01:35] ERROR: ETL nije unio NIJEDNU epizodu, a 30 ih je palo (processed=0).
[cron] WARN: ETL: FAIL-ETL processed=0 errors=30 (/Volumes/DOMOVINA2TB/fetch_domovina_tv_output)
```

Svaka epizoda pada na istom (`.ingest-logs/sync-cron-20261104.log`):

```
Code: 722 ... Load job 'load table rag.rag_chunks' failed: Code: 231. DB::Exception:
Suspiciously many (175 parts, 0.00 B in total) broken parts to remove while maximum
allowed broken parts count is 100 ... (TOO_MANY_UNEXPECTED_DATA_PARTS)
```

Isto vrijedi i za unutarnju tablicu materijaliziranog viewa (SummingMergeTree,
`channel, day, chunk_count, episode_count, total_speech_sec`):
`rag..inner_id.a50f5a10-69aa-4777-92d6-276e7f2a7ce3`, 177 oštećenih dijelova.
Zbog toga pada čak i `SELECT ... FROM system.tables WHERE database='rag'`.

Posljedica: **nove epizode od 03.11. i 04.11. nisu ušle u korpus** (pretraga,
`find_in_transcript`, person hub). Na popisu palih su i sve 4 epizode nightlyja
04.11.: `pIx_7N-6HJ4`, `uw5vYIdAHeM`, `3GGuSVt4Q4Y` i `uMVmX4GDYag`.

## Vremenska crta

| Kada | Što |
|---|---|
| 01.11., 02.11. | `sync-cron gotov (rc=0, warn=0)` |
| 03.11. 05:01 | ETL kontejner se nije pokrenuo: `OCI runtime create failed: runc create failed`. Log završava bez retka `sync-cron gotov`, run nije došao do kraja. |
| 03.11. 08:44 CET | ClickHouse kontejner ponovno pokrenut (`StartedAt 2026-11-03T07:44:06Z`). |
| 04.11. 05:01 | `rag.rag_chunks` se ne može učitati → 30/30 epizoda palo, `rc=210`. |

Vjerojatni uzrok je pun SSD: `/System/Volumes/Data` je na 98 %, slobodno 13 GB. CH
je ostao bez mjesta ili je ubijen usred pisanja, pa su ostali dijelovi od 0 B. To nije
potvrđeno, samo je najvjerojatnije.

## Stanje (očitano 04.11. oko 10:15)

- `domovina-rag-infra-clickhouse-1`: `Up 26 hours (healthy)`, image
  `clickhouse/clickhouse-server:24.10` (server 24.10.4). Healthcheck prolazi iako
  tablica ne radi.
- `/var/lib/clickhouse` u volumenu `ch_data`: 9,7 GB.
- Docker: volumeni 23,3 GB (5,5 GB reclaimable), imagei 15,7 GB (3,7 GB reclaimable).
- Meilisearch kontejner je zdrav.

## Što treba odlučiti i napraviti (u ovoj, domovina-rag sesiji)

1. **Prvo mjesto na disku.** S 13 GB slobodno svaki popravak riskira isti kvar.
   Kandidati su reclaimable Docker volumeni i imagei. Prije brisanja nabroji što je
   u njima.
2. **Je li lokalni CH izvor istine ili samo staging?** Prema `scripts/sync-cron.sh`
   lokalni ETL radi delta push na cloud CH. Ako je cloud potpun, najčišće je lokalnu
   tablicu iznova izgraditi ili povući s clouda, umjesto spašavanja dijelova od 0 B.
   Provjeri broj redaka i zadnju epizodu u cloud `rag.rag_chunks` prije odluke.
3. **Ako se lokalna tablica spašava:** ClickHouse nudi `max_suspicious_broken_parts`
   (merge_tree postavka). Privremeno povisi, pusti CH da odbaci oštećene dijelove
   (završe u `detached/`), pa vrati na default. Dijelovi od 0 B ne nose podatke, ali
   provjeri broj redaka prije i poslije. Postavku obavezno vrati.
4. Isto za unutarnju tablicu MV-a (`.inner_id.a50f5a10-…`), ili je izgradi iznova iz
   `rag_chunks`.
5. **Ponovno pokreni sync** (`scripts/sync-cron.sh`, ili samo `sync-incremental.sh`)
   i provjeri da su ušle epizode od 03.11. i 04.11., i lokalno i na cloudu.
6. **Healthcheck:** razmisli o provjeri koja čita `rag.rag_chunks` (npr.
   `SELECT count() FROM rag.rag_chunks`), ne samo „server odgovara”. Ovaj kvar je
   prošao kao „healthy”.

## Ograničenja

- Ne pokreći ništa što treba puno diska dok se ne oslobodi mjesto.
- Pipeline u `fetch.domovina.tv` ide dalje normalno. Epizode su na disku i CDN-u,
  samo nisu u RAG korpusu.
- Pravilo iz `fetch.domovina.tv` (04.11.2026.): cilj je da **nove** epizode prođu bez
  greške. Popravak treba vratiti dnevni sync; povijesni re-ingest nije cilj ovog
  zadatka, osim ako se lokalna tablica ionako gradi iznova.

## Rješenje (04.11.2026. navečer)

**Uzrok.** Svih 175 + 177 oštećenih dijelova ima vrijeme 03.11. 04:04:38, usred
noćnog ETL-a: spojeni dijelovi (merge) su ostali s datotekama od 0 B. To odgovara
rušenju Docker VM-a prije nego je sadržaj stigao na disk. `Docker.raw` je 41 GB od
dopuštenih 60 GB, a Mac je imao 9,7 GB slobodno.

**Postupak** (bez gubitka podataka, provjereno prema cloudu):

1. Referenca: na cloud CH-u `uniqExact(chunk_id)` i `uniqExact(youtube_id)` po
   `toYYYYMM(upload_date)`.
2. Privremeni `config.d/zz_broken_parts.xml` ubačen u kontejner (`docker cp`):
   `max_suspicious_broken_parts=1000`, `max_suspicious_broken_parts_bytes=10000000`,
   pa `docker restart`. CH je oštećene dijelove premjestio u `detached/`
   (`broken-on-start_*`).
3. `CHECK TABLE` (s `check_query_single_value_result=0`) je našao još jedan dio
   pun nula (`202611_82808_82888_16`, `UNKNOWN_CODEC`), pa je odvojen s
   `ALTER TABLE rag_chunks DETACH PART`.
4. Sve particije do 202610 su identične cloudu. Lokalni 202611 je imao više od
   clouda i nijedna epizoda nije imala rupu u `chunk_index`.
5. Unutarnja tablica `mv_channel_daily` je ispražnjena (`TRUNCATE`) i iznova
   napunjena iz `rag_chunks FINAL`. `episode_mentions` je ponovno popunjen preko
   `etl mentions` (idempotentno).
6. Privremeni config je uklonjen, CH ponovno pokrenut, a postavka je opet 100.
7. Ručni `sync-cron.sh`: ETL je unio 46 epizoda (0 grešaka), na cloud je otišla
   delta od 60 epizoda, a sve 4 epizode od 04.11. su na cloudu. Završio je s
   `rc=0, warn=0`.

**Prevencija.** `sync-cron.sh` korak 3 sad stvarno čita `rag.rag_chunks` i prekida s
`rc=3` i jasnom porukom, umjesto da ETL padne na svakoj epizodi. Healthcheck u
compose-u nije diran jer ga koristi i Coolify.

**Otvoreno:** mjesto na Macu (`~/Library/Caches` 15 GB, Docker volumen
`domovina-rag-infra_hf_cache` 2,1 GB bez kontejnera). Dijelovi u `detached/` se mogu
obrisati kad prođe nekoliko mirnih noći (`ALTER TABLE … DROP DETACHED PART`
uz `allow_drop_detached=1`).
