-- Migration 001 — OAuth 2.1 + DCR storage + audit log
--
-- Primjena: prod PG deploy-evi inicijalizirani PRIJE commit-a 1c802f9
-- ("feat(mcp,etl): OAuth+DCR u PG") nemaju ove tablice — init.sql se
-- pokreće samo na first volume mount.
--
-- Sve je IF NOT EXISTS → idempotentno. Sigurno pokrenuti više puta i
-- na bazama koje već imaju neke od ovih tablica.
--
-- Pokretanje:
--
--   docker exec -i <pg_container> psql -U $POSTGRES_USER -d $POSTGRES_DB \
--       < infra/postgres/migrations/001_oauth_tables.sql
--
-- ili copy-paste cijeli sadržaj u Coolify PG container Terminal.

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


CREATE TABLE IF NOT EXISTS oauth_access_tokens (
    token_hash              TEXT PRIMARY KEY,
    client_id               TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
    scopes                  JSONB NOT NULL DEFAULT '[]'::jsonb,
    resource                TEXT,
    expires_at              TIMESTAMPTZ NOT NULL,
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
