# ETL — JSONL → ClickHouse

> **Status:** ✅ Faza 1 implementirano i smoke-testano. ~151 epizoda ingestirano u lokalnoj bazi (od ~1843 total).

One-shot Python servis koji čita `*.rag_combined.jsonl` iz producer outputa
(`fetch.domovina.tv/storage/output/{channel}/`), generira bge-m3 embedding preko
embedder service-a, upsert-a `channels`/`episodes` u PostgreSQL i batch-insert-a
chunkove u ClickHouse `rag_chunks`.

## Tijek

```mermaid
flowchart TD
    Start[CLI: python -m etl ingest --input /data] --> Discover[discover_jsonl<br/>scan dir za *.rag_combined.jsonl]
    Discover --> SkipMac[Skip macOS dotfiles<br/>._*.jsonl]
    SkipMac --> Resume{sync_state cursor?}
    Resume -->|--no-resume| Loop
    Resume -->|use cursor| Filter[Filter fajlove > last_basename]
    Filter --> Loop[Za svaku epizodu]
    Loop --> SkipExisting{episodes.status = 'indexed'<br/>u PG?}
    SkipExisting -->|da| NextEp[Sljedeća epizoda]
    SkipExisting -->|ne| Meta[Prva linija → episode_meta<br/>upsert PG channels + episodes]
    Meta --> Batches[Stream chunkova u batchevima<br/>po --batch-size]
    Batches --> Embed[POST /embed<br/>na embedder]
    Embed --> Insert[Batch INSERT u CH rag_chunks]
    Insert --> MoreBatches{Više batchova?}
    MoreBatches -->|da| Batches
    MoreBatches -->|ne| Commit[Update sync_state<br/>set episodes.status = 'indexed']
    Commit --> NextEp
    NextEp --> Done{Više epizoda?}
    Done -->|da| Loop
    Done -->|ne| End[Done summary:<br/>processed, skipped, chunks, errors]
```

ClickHouse `rag_chunks` je `ReplacingMergeTree(inserted_at)` — re-insert istog `chunk_id` je idempotentan (najnoviji insert pobjeđuje nakon merge-a).

## Komande

```bash
# Standard production-style (kontejner, embedder URL iz .env-a)
docker compose --profile etl run --rm etl ingest --input /data

# Filter na jedan kanal, prvih 2 epizode (smoke test)
docker compose --profile etl run --rm etl ingest --input /data \
  --channel podcast_cuspajz --limit 2

# Status sync cursor-a
docker compose --profile etl run --rm etl status

# Lokalno (host) — bez containera, treba PG/CH/embedder eksponirane porte
EMBEDDER_URL=http://localhost:8000 \
POSTGRES_URL=postgres://rag_user:...@localhost:5432/rag \
CLICKHOUSE_URL=http://rag_user:...@localhost:8123/rag \
  python -m etl ingest --input /Volumes/DATA/fetch_domovina_tv_output
```

## CLI argumenti

| Flag | Default | Opis |
|---|---|---|
| `--input` | (required) | Korijenski dir s `{channel}/{basename}.rag_combined.jsonl` |
| `--channel` | (all) | Filtriraj na jedan kanal slug |
| `--batch-size` | 64 | Chunkova po embed/insert batch-u |
| `--limit` | 0 | Procesiraj samo prvih N fajlova (testiranje) |
| `--no-resume` | false | Ignoriraj `sync_state` cursor |
| `--reingest` | false | Re-ingest fajlove ≤ cursoru (ReplacingMergeTree pobjeđuje) |

## Mapping JSONL → ClickHouse

| JSONL polje | CH kolona | Notes |
|---|---|---|
| `id` (nested) | `chunk_id` | Stvarni shape iz producer-a |
| `metadata.youtube_id` | `youtube_id` | + `episode_id` lookup u PG |
| `metadata.channel` | `channel` | + `channel_id` lookup u PG |
| `metadata.upload_date` | `upload_date` | `1970-01-01` ako prazno |
| `metadata.speakers` array | `speaker` | comma-join (`SPEAKER_00,SPEAKER_01`) |
| `metadata.start_ts`, `end_ts` | `start_ts`, `end_ts` | |
| `text` | `text` | passed as-is u embedder (s `[SPEAKER_XX]` tagovima) |
| — | `text_summary` | `""` u Fazi 1, populated u Fazi 2 |
| `metadata.chunk_index` | `chunk_index` | |
| `metadata.chunk_strategy` | `chunk_strategy` | |
| (embedder output) | `embedding` | 1024-d L2-normalized |
| (cijeli JSON redak) | `metadata` | raw JSON za fallback |

## Performance benchmarking

| Setup | Throughput | 1843 ep proj. | Napomena |
|---|---|---|---|
| Containerized embedder (CPU) | ~1500ms/text | ~30-40h | Pinned CPU, thermal throttle |
| **MPS host embedder (Apple M3 Pro)** | ~37ms/text | **~1.5h** | 40× speedup, ali GUI stutter pri sustained load |
| ETL batch=4 + MPS | ~3-5s/ep | ~2h | Stabilno, ne zamrzava GUI |
| ETL batch=16 + MPS | ~2s/ep | ~1h | Zamrzava GUI, ne preporučujem |

**Preporuka**: za bulk ingest na Mac-u koristi **batch=4** s MPS host embedder workflow-om — vidi [`services/embedder/README.md`](../embedder/README.md).

## Limitacije Faze 1

- Channel upsert je minimalan (samo `slug`); full enrichment (`name`, `youtube_handle`, `video_count`) iz `fetch.domovina.tv/automatic/podcasts/{channel}-channel.json` je Faza 2.
- `text_summary` se ne popunjava — `prepare_rag_combined.js` u producer repu generira `summary_snippet` u opcionalnom polju, ali nije konzistentno prisutno.
- Speaker resolution (`SPEAKER_XX` → kanonsko ime) je Faza 3, vidi plan §15.
- Bez paralelizacije epizoda — sekvencijalno, jedna po jedna. Embedder je bottleneck.
- macOS dotfiles (`._*.jsonl`) se skipaju (fix iz commita `b32e3f6`).

## Cloud sync (planirano, Faza 5 deploymenta)

ETL se vrti **samo lokalno** (MPS GPU). Cloud baza dobiva podatke preko snapshot transfer-a:

```bash
# Nakon ingest-a, lokalno:
docker exec domovina-rag-infra-clickhouse-1 clickhouse-client \
  --query "BACKUP TABLE rag.rag_chunks TO Disk('r2_backup', 'snapshot-$(date +%Y%m%d).zip')"

# Coolify cron na cloud side-u:
docker exec domovina-rag-clickhouse-... clickhouse-client \
  --query "RESTORE TABLE rag.rag_chunks FROM Disk('r2_backup', 'snapshot-YYYYMMDD.zip')"
```

Vidi [`docs/cloud_deployment_plan.md`](../../docs/cloud_deployment_plan.md) §3 i §5 za detalje.

## Programi stranaka (`etl programs`)

Kompas stranaka (repo `stranke.domovina.ai`) reže izborne, trajne i koalicijske
programe stranaka u `data/raw/kompas/chunks.jsonl` (gitignored ondje; ovamo se
NE kopira). `python -m etl programs` ih učita u CH `program_chunks`
(shema u `infra/clickhouse/init.sql`), s bge-m3 embeddingom teksta.

- **Stranke:** `party_ids` se spajaju s `data/kompas/liste_2024.json["stranke"]` u
  paralelne nizove `party_names` / `party_short` / `party_slugs` (`''` kad
  stranke nema u katalogu). Koalicijski dokument je jedan chunk s više stranaka.
- **NULL → `''` / `0`**, `nesiguran` → `UInt8`, `text_hash` = sha256(text),
  `metadata` = sirovi JSON (`sort_keys`).
- **Idempotentno po `doc_id`:** potpis dokumenta = skup (chunk_id, text_hash,
  metadata, party_*). Isti → preskoči bez embeddera; različit → embedaj, pa
  `ALTER TABLE … DELETE WHERE doc_id = … SETTINGS mutations_sync = 2` i insert;
  `doc_id` kojeg više nema u fajlu → obriši. Embedding se ponovno koristi po
  `text_hash`, pa promjena samo metapodataka ne zove embedder. Stari redovi se
  brišu tek kad su novi embeddinzi u ruci.
- **Embedder:** batch ≤ 8 (tvrda granica), sekvencijalno. Ako nije dostupan, a
  nešto treba embedati, ti dokumenti se odgode uz WARNING i rc 0.
- Prazan `chunks.jsonl` je greška (inače bi prune ispraznio tablicu).

```bash
# Uobičajeno: kroz skriptu (ETL u kontejneru, fajlovi mountani read-only)
./scripts/sync-programs.sh --dry-run    # plan bez embeddanja i pisanja
./scripts/sync-programs.sh              # lokalni CH
./scripts/sync-programs.sh --cloud      # lokalni CH → cloud CH (delta po doc_id)

# Izravno (putanje: --input/--liste, ili $PROGRAMS_INPUT/$PROGRAMS_LISTE,
# ili $STRANKE_REPO/data/..., default ../stranke.domovina.ai)
docker compose --profile etl run --rm \
  -v "$PWD/../stranke.domovina.ai/data/raw/kompas/chunks.jsonl:/programs/chunks.jsonl:ro" \
  -v "$PWD/../stranke.domovina.ai/data/kompas/liste_2024.json:/programs/liste_2024.json:ro" \
  etl programs --input /programs/chunks.jsonl --liste /programs/liste_2024.json --dry-run
```

Testovi (bez CH-a i bez modela): `uvx pytest services/etl/tests/test_programs.py`
ili `python3 services/etl/tests/test_programs.py`.
