#!/usr/bin/env python3
"""Person-mentions populate — TSV (iz CH episode_mentions) → full-refresh SQL (za PG).

Namjerno dependency-free (samo stdlib + etl.speakers.slugify, isto stdlib): CH se
čita preko `docker exec clickhouse-client`, a PG puni preko `docker exec psql`, pa
ovaj korak ne treba clickhouse-connect/psycopg ni venv. Dio dnevnog sync-a
(scripts/sync-person-mentions.sh).

Slug se računa ISTIM algoritmom (etl.speakers.slugify) kao speakers.slug —
"Ante Čaljkušić" → "ante-caljkusic" — pa se person_mentions.slug whole-person
poklapa s person hub slug-om. Role-labeli i prazna imena se izbacuju.

Ulaz (stdin, TSV, bez headera): youtube_id \t channel \t upload_date \t title \t person
Izlaz (stdout): BEGIN; DELETE FROM person_mentions; INSERT …; COMMIT;
"""

from __future__ import annotations

import sys
from pathlib import Path

# etl.speakers je pure-stdlib (slugify, is_role_label) — bez DB deps.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "etl"))
from etl.speakers import is_role_label, slugify  # noqa: E402


def _q(s: str) -> str:
    # standard_conforming_strings=on → samo ' se udvaja
    return "'" + s.replace("'", "''") + "'"


def _qd(s: str) -> str:
    # upload_date: '' ili junk → NULL, inače 'YYYY-MM-DD'::date
    s = s.strip()
    if len(s) == 10 and s[4] == "-" and s[7] == "-":
        return _q(s) + "::date"
    return "NULL"


def main() -> int:
    # Dedup po (slug, youtube_id) — dva imenska varijante iste osobe u istoj
    # epizodi (rijetko) ne smiju dati dva reda (PK bi ionako pao).
    seen: set[tuple[str, str]] = set()
    vals: list[str] = []
    dropped = 0

    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        youtube_id, channel, upload_date, title, person = parts[0], parts[1], parts[2], parts[3], parts[4]
        person = person.strip()
        if not person or is_role_label(person):
            dropped += 1
            continue
        slug = slugify(person)
        if not slug:
            dropped += 1
            continue
        key = (slug, youtube_id)
        if key in seen:
            continue
        seen.add(key)
        vals.append(
            f"({_q(slug)},{_q(youtube_id)},{_q(channel)},{_q(title)},{_qd(upload_date)})"
        )

    out = ["BEGIN;", "DELETE FROM person_mentions;"]
    for i in range(0, len(vals), 500):
        grp = ",\n".join(vals[i : i + 500])
        out.append(
            "INSERT INTO person_mentions "
            "(slug, youtube_id, channel, title, upload_date) VALUES\n"
            + grp
            + "\nON CONFLICT (slug, youtube_id) DO NOTHING;"
        )
    out.append("COMMIT;")
    sys.stdout.write("\n".join(out) + "\n")
    sys.stderr.write(
        f"[emit_person_mentions_sql] {len(vals)} mention-redova "
        f"({len(seen)} distinct slug×video; {dropped} odbačeno: role/prazno)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
