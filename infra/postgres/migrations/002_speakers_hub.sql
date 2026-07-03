-- Migration 002 — "person hub" nadogradnja speakers tablice (Faza 2 feature).
--
-- Dodaje public share slug (/p/{slug}) + avatar_url + indekse za brzu
-- rezoluciju slug→osoba i reverse alias→osoba lookup. Ostatak sheme
-- (canonical_name, aliases, channels, confidence, needs_review) već postoji
-- iz init.sql-a (Faza-3 placeholder), ovdje ga samo popunjavamo životom.
--
-- PG init.sql se NE re-runa nakon prvog deploya (vidi memoriju
-- lessons-pg-init-sql-not-rerun) → na prod-u ovu migraciju primijeni ručno
-- preko Coolify Terminal-a:
--   psql "$POSTGRES_URL" -f infra/postgres/migrations/002_speakers_hub.sql
-- Za fresh deploye isti stupci žive i u init.sql-u (idempotentno).

-- Public share slug — ASCII-folded (č→c, ć→c, š→s, ž→z, đ→d), lowercase,
-- riječi spojene '-'. Deterministički generiran iz merge-keya u populate
-- skripti; STABILAN kroz re-runove (public URL se ne smije mijenjati).
ALTER TABLE speakers ADD COLUMN IF NOT EXISTS slug TEXT;

-- Opcionalni avatar (npr. R2 CDN URL). Zasad NULL — kolona postoji da je
-- frontend kontrakt stabilan bez buduće migracije.
ALTER TABLE speakers ADD COLUMN IF NOT EXISTS avatar_url TEXT;

-- Slug je javni ključ → mora biti UNIQUE. IF NOT EXISTS guard preko DO bloka
-- jer ADD CONSTRAINT nema IF NOT EXISTS u starijim PG verzijama.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'speakers_slug_key'
    ) THEN
        ALTER TABLE speakers ADD CONSTRAINT speakers_slug_key UNIQUE (slug);
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_speakers_slug ON speakers(slug);

-- GIN nad aliases jsonb — omogućuje brzi reverse lookup (raw CH token → osoba)
-- ako ikad zatreba (npr. enrichment pipeline). Endpoint sam radi slug→aliases,
-- ali ovo drži vrata otvorena bez naknadne migracije.
CREATE INDEX IF NOT EXISTS idx_speakers_aliases ON speakers USING gin (aliases);
