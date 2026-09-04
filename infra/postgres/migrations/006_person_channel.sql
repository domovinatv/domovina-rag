-- Migration 006 — virtualni kanali: ručna kuracija i pravo na uklanjanje.
--
-- Feature „osoba postaje kanal" (../domovina.ai/docs/plans/virtualni-kanali.md,
-- odluke O3 i O8). Frontend je isporučen u domovina.ai v2.0.122 iza
-- PersonChannelFlag; ove dvije tablice su njegova jedina obrana od dvije
-- greške koje prag i tier NE mogu uhvatiti:
--
--   1. LAŽNA ATRIBUCIJA — loša diarizacija ili ASCII-fold mismatch stavi tuđu
--      epizodu u nečiji kanal. Tier prag tu ne pomaže; jedini izlaz je ručni
--      `exclude`.
--   2. ZAHTJEV ZA UKLANJANJEM — profil se gradi od javno objavljenih tuđih
--      snimki, po opt-out modelu. Osoba mora moći izaći.
--
-- OBJE SU TOMBSTONE TABLICE. Moraju preživjeti `python -m etl speakers` i svaki
-- rerun ingesta — inače sljedeći ingest vrati uklonjenu osobu natrag u katalog.
-- Zato tablica, a ne brisanje redova u `speakers`.
--
-- PG init.sql se NE re-runa nakon prvog deploya → na prod-u primijeni ručno:
--   psql "$POSTGRES_URL" -f infra/postgres/migrations/006_person_channel.sql

-- ─── Ručna kuracija pojedine epizode u virtualnom kanalu ────────────────────
--
-- `confirmed` je razlika između prijave i odluke. Gumb „Prijavi grešku" u appu
-- (person_screen.dart) piše redak s confirmed=false; agregacija u
-- get-person.ts / list-persons.ts primjenjuje SAMO confirmed=true. Bez te
-- podjele bi javni gumb bio brisač tuđih epizoda bez ijedne provjere.
CREATE TABLE IF NOT EXISTS person_channel_overrides (
  slug         TEXT NOT NULL,
  youtube_id   TEXT NOT NULL,
  action       TEXT NOT NULL CHECK (action IN ('exclude', 'force_primary')),
  reason       TEXT,
  -- false = korisnikova prijava koja čeka čovjeka; true = primijenjena odluka.
  confirmed    BOOLEAN NOT NULL DEFAULT false,
  -- Koliko je puta ista epizoda prijavljena (ON CONFLICT increment). Signal
  -- prioriteta pri pregledu; ne utječe na primjenu.
  report_count INTEGER NOT NULL DEFAULT 0,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (slug, youtube_id)
);

-- Agregacija čita „sve za ovaj slug" → indeks po slugu, ne po PK-u.
CREATE INDEX IF NOT EXISTS idx_person_channel_overrides_slug
  ON person_channel_overrides (slug) WHERE confirmed;

-- Red čekanja za čovjeka: neprimijenjene prijave, najprijavljenije prvo.
CREATE INDEX IF NOT EXISTS idx_person_channel_overrides_pending
  ON person_channel_overrides (report_count DESC, created_at)
  WHERE NOT confirmed;

-- ─── Opt-out cijelog virtualnog kanala ─────────────────────────────────────
--
-- Efekt (O8 §2): osoba nestaje iz /api/persons, s kartica, iz TV lanea i iz
-- sitemapa. /p/{slug} NAMJERNO ostaje 200 s `optout: true` — frontend to crta
-- kao minimalni profil (ime + poruka), jer bi 404 razbio već podijeljene
-- linkove. Taj prikaz NIJE iza feature flaga.
CREATE TABLE IF NOT EXISTS person_optouts (
  slug         TEXT PRIMARY KEY,
  scope        TEXT NOT NULL DEFAULT 'channel' CHECK (scope IN ('channel')),
  requested_by TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
