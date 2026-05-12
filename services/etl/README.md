# ETL — JSONL → ClickHouse

One-shot Python servis koji čita `*.rag_combined.jsonl` iz producer outputa
(`fetch.domovina.tv/storage/output/{channel}/`), generira bge-m3 embedding preko
embedder service-a, upsert-a `channels`/`episodes` u PostgreSQL i batch-insert-a
chunkove u ClickHouse `rag_chunks`.

## Tijek

1. `discover_jsonl` skenira `--input` direktorij za `{channel}/*.rag_combined.jsonl`
2. Za svaku epizodu: prva linija → `episode_meta`, upsert PG `channels` + `episodes`
3. Stream chunkova u batch-evima (`--batch-size`, default 64) → `POST /embed` →
   batch INSERT u CH `rag_chunks`
4. Nakon epizode: `sync_state.last_basename = {channel}/{basename}`, PG commit

ClickHouse `rag_chunks` je `ReplacingMergeTree(inserted_at)` — re-insert istog
`chunk_id` je idempotentan (najnoviji insert pobjeđuje nakon merge-a).

## Komande

```bash
# Pokretanje preko docker-compose (production-style)
docker compose --profile etl run --rm etl ingest --input /data

# Filter na jedan kanal, prvih 2 epizode (za testiranje)
docker compose --profile etl run --rm etl ingest --input /data \
  --channel podcast_cuspajz --limit 2

# Status sync cursor-a
docker compose --profile etl run --rm etl status

# Lokalno (host) — treba PG/CH/embedder portove forward-ane van internal mreže
EMBEDDER_URL=http://localhost:8000 \
POSTGRES_URL=postgres://rag_user:...@localhost:5432/rag \
CLICKHOUSE_URL=http://rag_user:...@localhost:8123/rag \
  python -m etl ingest --input ../fetch.domovina.tv/storage/output
```

## CLI argumenti

| Flag | Default | Opis |
|---|---|---|
| `--input` | (required) | Korijenski dir s `{channel}/{basename}.rag_combined.jsonl` |
| `--channel` | (all) | Filtriraj na jedan kanal slug |
| `--batch-size` | 64 | Chunkova po embed/insert batchu |
| `--limit` | 0 | Procesiraj samo prvih N fajlova (testiranje) |
| `--no-resume` | false | Ignoriraj `sync_state` cursor |
| `--reingest` | false | Re-ingest fajlove ≤ cursoru (ReplacingMergeTree pobjeđuje) |

## Mapping JSONL → ClickHouse

| JSONL polje | CH kolona | Notes |
|---|---|---|
| `chunk_id` | `chunk_id` | |
| `youtube_id` | `youtube_id` | + `episode_id` lookup u PG |
| `channel` | `channel` | + `channel_id` lookup u PG |
| `upload_date` | `upload_date` | `1970-01-01` ako prazno |
| `speakers` array | `speaker` | comma-join (`SPEAKER_00,SPEAKER_01`) |
| `start_ts`, `end_ts` | `start_ts`, `end_ts` | |
| `text` | `text` | passed as-is u embedder (s `[SPEAKER_XX]` tagovima) |
| — | `text_summary` | `""` u Fazi 1, populated u Fazi 2 |
| `chunk_index` | `chunk_index` | |
| `chunk_strategy` | `chunk_strategy` | |
| (embedder output) | `embedding` | 1024-d L2-normalized |
| (cijeli JSON redak) | `metadata` | raw za rezerva |

## Limitacije Faze 1

- Channel upsert je minimalan (samo `slug`); full enrichment (`name`, `youtube_handle`,
  `video_count`) iz `fetch.domovina.tv/automatic/podcasts/{channel}-channel.json` je
  Faza 2.
- `text_summary` se ne popunjava — `prepare_rag_combined.js` u producer repu
  generira `summary_snippet` u opcionalnom polju, ali nije konzistentno prisutno.
- Speaker resolution (`SPEAKER_XX` → kanonsko ime) je Faza 3, vidi plan §15.
- Bez paralelizacije epizoda — sekvencijalno, jedna po jedna. CPU embedder je
  bottleneck (~50-100 chunkova/s).
