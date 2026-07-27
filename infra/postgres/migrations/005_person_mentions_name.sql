-- Migration 005 — display ime za osobu koja se SAMO spominje (nikad ne govori).
--
-- Person hub identitet je dosad dolazio isključivo iz `speakers` (diarizirani
-- govornici), pa je /api/person/{slug} vraćao 404 za svakoga tko je u korpusu
-- samo spomenut — npr. bl. Ivan Merz (~15.5k takvih slugova). Sad `getPerson`
-- gradi hub i samo iz `person_mentions`, ali mu treba ČITLJIVO ime: slug je
-- ASCII-fold pa bi bez ovoga profil pisao "Zeljka Markic" umjesto "Željka
-- Markić". `person_name` čuva sirovu varijantu imena iz summary.mentioned_people
-- (hub uzima najčešću varijantu po slugu).
--
-- Dok kolona nije popunjena (prije prvog sync-a) hub pada na titlecase slug-a —
-- vidi titleizeSlug u services/mcp/src/tools/get-person.ts.
--
-- PG init.sql se NE re-runa nakon prvog deploya (vidi memoriju
-- lessons-pg-init-sql-not-rerun) → na prod-u ovu migraciju primijeni ručno:
--   psql "$POSTGRES_URL" -f infra/postgres/migrations/005_person_mentions_name.sql
-- sync-person-mentions.sh usto ima isti ADD COLUMN IF NOT EXISTS u SCHEMA_SQL
-- bootstrapu, pa se cloud tablica sama nadogradi pri sljedećem syncu.

ALTER TABLE person_mentions ADD COLUMN IF NOT EXISTS person_name TEXT;
