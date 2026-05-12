-- ClickHouse initial schema — Faza 1 minimal
-- Full schema u plan §4: vidi sibling repo
--
-- Bilješka: docker-entrypoint pokreće ovaj fajl kao raw query bez --database,
-- pa bi nekvalificirani CREATE TABLE-ovi otišli u `default` DB. Eksplicitni
-- USE statement osigurava da sve ide u CLICKHOUSE_DB (po convention-u `rag`).
CREATE DATABASE IF NOT EXISTS rag;
USE rag;

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
    INDEX idx_embedding   embedding TYPE usearch('cosineDistance') GRANULARITY 1000
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
