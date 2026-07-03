-- Migration 003 — "person_mentions" tablica (person hub: sekcija "Spominje se u").
--
-- Osoba se u epizodi može SPOMINJATI (summary.mentioned_people) a da NE govori
-- (nije diarizirani speaker). Person hub je dosad agregirao samo govore; ova
-- tablica dodaje spomene. /api/person/{slug} ju čita i izbaci epizode u kojima
-- osoba već govori (govori ima prednost, ne dupliciramo).
--
-- Derivat CH `episode_mentions` → puni scripts/sync-person-mentions.sh
-- (full-refresh: DELETE + INSERT). Slug se računa istim ASCII-fold algoritmom
-- kao speakers.slug, pa se whole-person joina u hub.
--
-- PG init.sql se NE re-runa nakon prvog deploya (vidi memoriju
-- lessons-pg-init-sql-not-rerun) → na prod-u ovu migraciju primijeni ručno
-- preko Coolify Terminal-a:
--   psql "$POSTGRES_URL" -f infra/postgres/migrations/003_person_mentions.sql
-- Za fresh deploye ista tablica živi i u init.sql-u (idempotentno). Cloud sync
-- skripta (sync-person-mentions.sh) usto embeda isti CREATE za self-bootstrap.

CREATE TABLE IF NOT EXISTS person_mentions (
    slug            TEXT NOT NULL,
    youtube_id      TEXT NOT NULL,
    channel         TEXT NOT NULL,
    title           TEXT,
    upload_date     DATE,
    created_at      TIMESTAMPTZ DEFAULT now(),
    PRIMARY KEY (slug, youtube_id)
);

CREATE INDEX IF NOT EXISTS idx_person_mentions_slug ON person_mentions(slug);
