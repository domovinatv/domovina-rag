-- ClickHouse initial schema — Faza 1 minimal
-- Full schema u plan §4: vidi sibling repo
--
-- Bilješka: docker-entrypoint pokreće ovaj fajl kao raw query bez --database,
-- pa bi nekvalificirani CREATE TABLE-ovi otišli u `default` DB. Eksplicitni
-- USE statement osigurava da sve ide u CLICKHOUSE_DB (po convention-u `rag`).
CREATE DATABASE IF NOT EXISTS rag;
USE rag;

-- Vector similarity index je experimental u CH 24.x — treba ga eksplicitno
-- omogućiti prije CREATE TABLE. `usearch` (stari naziv) je removed u 24.10.
SET allow_experimental_vector_similarity_index = 1;

-- ─── RAG chunks (primarni vector store) ────────────────────
CREATE TABLE IF NOT EXISTS rag_chunks (
    chunk_id        String,
    episode_id      UInt64,                    -- logički FK na PG.episodes.id
    youtube_id      String,
    channel         LowCardinality(String),
    upload_date     Date,
    speaker         LowCardinality(String),    -- canonical iz PG, fallback "SPEAKER_XX"
    start_ts        Float32,
    end_ts          Float32,
    text            String,
    text_summary    String,
    chunk_index     UInt32,
    chunk_strategy  LowCardinality(String),    -- 'combined' | 'fixed' | 'outline'
    embedding       Array(Float32) CODEC(NONE),
    metadata        String,                    -- raw JSONB iz JSONL-a za rezerva
    inserted_at     DateTime DEFAULT now(),

    -- Indexi
    INDEX idx_text_tokens text TYPE tokenbf_v1(8192, 3, 0) GRANULARITY 4,
    -- vector_similarity je nasljednik `usearch`/`annoy` u CH 24.10+.
    -- Syntax: vector_similarity(metoda, metrika [, hnsw_m, ef_construction, dimensions])
    INDEX idx_embedding   embedding TYPE vector_similarity('hnsw', 'cosineDistance') GRANULARITY 1000
) ENGINE = ReplacingMergeTree(inserted_at)
PARTITION BY toYYYYMM(upload_date)
ORDER BY (channel, upload_date, episode_id, chunk_index);

-- ─── Speaker voice signatures (Faza 3 — multi-model per-speaker embeddings) ─
CREATE TABLE IF NOT EXISTS speaker_voice_signatures (
    speaker_id      UInt64,                    -- FK na PG.speakers.id
    episode_id      UInt64,                    -- u kojoj epizodi je opažen
    model_key       LowCardinality(String),    -- 'titanet' | 'pyannote_wespeaker34' | ...
    local_tag       String,                    -- "SPEAKER_00" u toj epizodi
    embedding       Array(Float32) CODEC(NONE),
    total_speech_sec Float32,
    num_segments    UInt32,
    confidence      Float32,
    inserted_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (speaker_id, episode_id, model_key);

-- ─── Episode mentions (osoba se SPOMINJE u epizodi, ne nužno govori) ─────────
-- Izvor: producerov `{basename}.wav.canary.summary.json` → `summary.mentioned_people[]`
-- (array imena). NIJE u rag_chunks jer je per-epizoda, ne per-chunk. Puni ju ETL
-- (load.py hook + `python -m etl mentions` backfill) iz sibling summary.json-a.
-- Derivat person_mentions (PG) se izvodi odavde — vidi scripts/sync-person-mentions.sh.
-- Ostaje LOKALNO (summary.json postoji samo lokalno); cloud PG se puni čitanjem
-- OVE lokalne tablice, ne preko CH delta push-a.
CREATE TABLE IF NOT EXISTS episode_mentions (
    youtube_id      String,
    channel         LowCardinality(String),
    upload_date     Date,
    title           String,                    -- summary.title_hr (fallback metadata.title)
    person          String,                    -- SIROVO ime iz mentioned_people; slug računa Python
    inserted_at     DateTime DEFAULT now()
) ENGINE = ReplacingMergeTree(inserted_at)
ORDER BY (youtube_id, person);

-- ─── Daily aggregates (materialized view, Faza 2) ──────────
CREATE MATERIALIZED VIEW IF NOT EXISTS mv_channel_daily
ENGINE = SummingMergeTree
ORDER BY (channel, day)
AS SELECT
    channel,
    toDate(upload_date) AS day,
    count() AS chunk_count,
    countDistinct(episode_id) AS episode_count,
    sum(end_ts - start_ts) AS total_speech_sec
FROM rag_chunks
GROUP BY channel, day;
