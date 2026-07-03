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

-- ─── Speakers (Faza 3 voice-resolution shema; slug/aliases popunjava
--     "person hub" populate skripta — vidi migrations/002_speakers_hub.sql) ─
CREATE TABLE IF NOT EXISTS speakers (
    id                  BIGSERIAL PRIMARY KEY,
    canonical_name      TEXT NOT NULL,
    slug                TEXT UNIQUE,           -- public share URL /p/{slug}, ASCII-folded
    avatar_url          TEXT,                  -- opcionalni CDN avatar (zasad NULL)
    aliases             JSONB DEFAULT '[]'::jsonb,   -- svi raw CH speaker varijante ove osobe
    voice_embedding_avg VECTOR(192),
    channels            JSONB DEFAULT '[]'::jsonb,
    confidence          FLOAT DEFAULT 0.5,
    needs_review        BOOLEAN DEFAULT TRUE,
    created_at          TIMESTAMPTZ DEFAULT now(),
    updated_at          TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_speakers_slug ON speakers(slug);
CREATE INDEX IF NOT EXISTS idx_speakers_aliases ON speakers USING gin (aliases);

-- ─── Person mentions ("spominje se u", ne nužno govori) ─────
-- Derivat CH `episode_mentions` (koji je pak izveden iz producerovog
-- summary.mentioned_people). Puni scripts/sync-person-mentions.sh (full-refresh:
-- DELETE + INSERT). Slug se računa istim ASCII-fold algoritmom kao speakers.slug,
-- pa se whole-person joina u person hub. /api/person/{slug} čita ovu tablicu i
-- izbaci epizode u kojima osoba GOVORI (govori ima prednost). Vidi migrations/003.
CREATE TABLE IF NOT EXISTS person_mentions (
    slug            TEXT NOT NULL,             -- ASCII-fold imena (isti algoritam kao speakers.slug)
    youtube_id      TEXT NOT NULL,
    channel         TEXT NOT NULL,
    title           TEXT,
    upload_date     DATE,
    mention_ts      INT DEFAULT 0,             -- sekunda najranijeg spomena (article.json); 0 = cijela epizoda
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (slug, youtube_id)
);

CREATE INDEX IF NOT EXISTS idx_person_mentions_slug ON person_mentions(slug);

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


-- ═══════════════════════════════════════════════════════════════
-- OAuth 2.1 + DCR storage (services/mcp koristi za authorization
-- server state — clients, codes, tokens). Service-to-service static
-- API key se i sam upiše kao record u oauth_access_tokens (client_id
-- = 'static-api-key') na startup-u da audit log radi univerzalno.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id               TEXT PRIMARY KEY,
    client_secret           TEXT,
    client_id_issued_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    client_secret_expires_at TIMESTAMPTZ,
    redirect_uris           JSONB NOT NULL DEFAULT '[]'::jsonb,
    grant_types             JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]'::jsonb,
    response_types          JSONB NOT NULL DEFAULT '["code"]'::jsonb,
    scope                   TEXT,
    token_endpoint_auth_method TEXT DEFAULT 'none',
    client_name             TEXT,
    metadata                JSONB DEFAULT '{}'::jsonb,
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_clients_created ON oauth_clients(created_at);


CREATE TABLE IF NOT EXISTS oauth_authorization_codes (
    code                    TEXT PRIMARY KEY,
    client_id               TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    redirect_uri            TEXT NOT NULL,
    code_challenge          TEXT NOT NULL,
    code_challenge_method   TEXT DEFAULT 'S256',
    scopes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource                TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_codes_expires ON oauth_authorization_codes(expires_at);


-- tokens se pohranjuju kao SHA-256 hash (security: ako baza leakne, raw tokeni
-- ne mogu biti reused). Lookup je po hash-u.
CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash              TEXT PRIMARY KEY,
    client_id               TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scopes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource                TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
    -- Audit polja (denormalizirano radi performance — alternativa je SELECT count
    -- iz oauth_audit_log; ovako su per-token brojevi jeftin lookup).
    request_count           BIGINT NOT NULL DEFAULT 0,
    last_used_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_tokens_client ON oauth_access_tokens(client_id);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_expires ON oauth_access_tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_last_used ON oauth_access_tokens(last_used_at DESC);


CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
    token_hash              TEXT PRIMARY KEY,
    client_id               TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scopes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource                TEXT,
    created_at              TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);


-- Audit log — svaki autoriziran request u /mcp endpoint
-- (i drugi protected endpoints) generira jedan red ovdje.
-- Token_hash je SHA-256 raw bearer-a — možeš joinati s oauth_access_tokens
-- za client info bez čuvanja raw bearer-a.
CREATE TABLE IF NOT EXISTS oauth_audit_log (
    id                      BIGSERIAL PRIMARY KEY,
    timestamp               TIMESTAMPTZ NOT NULL DEFAULT now(),
    token_hash              TEXT,
    client_id               TEXT,
    method                  TEXT NOT NULL,
    path                    TEXT NOT NULL,
    status_code             INT,
    latency_ms              INT,
    user_agent              TEXT,
    ip                      TEXT,
    error                   TEXT
);

CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON oauth_audit_log(timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_client ON oauth_audit_log(client_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_token ON oauth_audit_log(token_hash, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_audit_status ON oauth_audit_log(status_code) WHERE status_code >= 400;
