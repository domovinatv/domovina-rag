-- Migration 004 — timestamp deep-link za person_mentions ("spominje se u točan trenutak").
--
-- Dodaje `mention_ts` (sekunda najranijeg spomena osobe iz article.json entity
-- sekcija). /api/person gradi deep_link /v/{id}/t/{mention_ts} kad je > 0, inače
-- /v/{id} (cijela epizoda). Puni ga ETL (episode_mentions.mention_ts) →
-- sync-person-mentions.sh → ovamo. Vidi migrations/003 + docs/person-hub.md.
--
-- PG init.sql se NE re-runa (vidi lessons-pg-init-sql-not-rerun) → na prod-u ručno:
--   psql "$POSTGRES_URL" -f infra/postgres/migrations/004_person_mentions_ts.sql
-- sync-person-mentions.sh usto ima isti ADD COLUMN IF NOT EXISTS u SCHEMA_SQL
-- bootstrapu, pa se cloud tablica sama nadogradi pri sljedećem syncu.

ALTER TABLE person_mentions ADD COLUMN IF NOT EXISTS mention_ts INT DEFAULT 0;
