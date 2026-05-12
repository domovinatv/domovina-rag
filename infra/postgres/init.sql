-- PostgreSQL initial schema — Faza 1 minimal
-- Full schema u plan §4: ../docs/README.md → sibling repo

-- ─── Extensions ─────────────────────────────────────────────
CREATE EXTENSION IF NOT EXISTS vector;        -- pgvector za speaker voice embeddings (Faza 3)
CREATE EXTENSION IF NOT EXISTS pg_trgm;       -- za fuzzy name matching u speaker resolution

-- ─── Channels ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS channels (
    id              BIGSERIAL PRIMARY KEY,
    slug            TEXT UNIQUE NOT NULL,
    name            TEXT NOT NULL,
    youtube_handle  TEXT,
    video_count     INT DEFAULT 0,
    first_video_at  DATE,
    last_video_at   DATE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

-- ─── Episodes ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS episodes (
    id              BIGSERIAL PRIMARY KEY,
    channel_id      BIGINT NOT NULL REFERENCES channels(id),
    youtube_id      TEXT UNIQUE NOT NULL,
    title           TEXT,
    description     TEXT,
    duration_sec    FLOAT,
    upload_date     DATE,
    processed_at    TIMESTAMPTZ,
    status          TEXT DEFAULT 'pending',
        -- pending | indexed | blocked_summary | blocked_article | failed
    created_at      TIMESTAMPTZ DEFAULT now(),
    updated_at      TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_episodes_channel ON episodes(channel_id);
CREATE INDEX IF NOT EXISTS idx_episodes_upload_date ON episodes(upload_date);
CREATE INDEX IF NOT EXISTS idx_episodes_status ON episodes(status);

-- ─── Sync state (za ETL idempotency) ───────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
    source_name     TEXT PRIMARY KEY,
    last_synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_basename   TEXT,
    meta            JSONB DEFAULT '{}'::jsonb
);

-- ─── Speakers placeholder (Faza 3 full schema, vidi plan §15.4) ─
CREATE TABLE IF NOT EXISTS speakers (
    id                  BIGSERIAL PRIMARY KEY,
    canonical_name      TEXT NOT NULL,
    aliases             JSONB DEFAULT '[]'::jsonb,
    voice_embedding_avg VECTOR(192),
    channels            JSONB DEFAULT '[]'::jsonb,
    confidence          FLOAT DEFAULT 0.5,
    needs_review        BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

-- ─── Auto-update updated_at ─────────────────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER episodes_updated_at BEFORE UPDATE ON episodes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER speakers_updated_at BEFORE UPDATE ON speakers
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
