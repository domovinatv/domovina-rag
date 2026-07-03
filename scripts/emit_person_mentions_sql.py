#!/usr/bin/env python3
"""Person-mentions populate — TSV (iz CH episode_mentions) → full-refresh SQL (za PG).

Namjerno dependency-free (samo stdlib + etl.speakers.slugify, isto stdlib): CH se
čita preko `docker exec clickhouse-client`, a PG puni preko `docker exec psql`, pa
ovaj korak ne treba clickhouse-connect/psycopg ni venv. Dio dnevnog sync-a
(scripts/sync-person-mentions.sh).

Slug se računa ISTIM algoritmom (etl.speakers.slugify) kao speakers.slug —
"Ante Čaljkušić" → "ante-caljkusic" — pa se person_mentions.slug whole-person
poklapa s person hub slug-om. Role-labeli i prazna imena se izbacuju.

Ulaz (stdin, TSV, bez headera): youtube_id \t channel \t upload_date \t title \t person \t mention_ts
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
    # Akumuliraj po (slug, youtube_id) — dvije imenske varijante iste osobe u istoj
    # epizodi (rijetko) drže SE zajedno; mention_ts = MIN (najraniji spomen wins).
    # Row = [channel, upload_date, title, mention_ts].
    rows: dict[tuple[str, str], list] = {}
    dropped = 0

    for line in sys.stdin:
        line = line.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 5:
            continue
        youtube_id, channel, upload_date, title, person = parts[0], parts[1], parts[2], parts[3], parts[4]
        mention_ts = int(parts[5]) if len(parts) > 5 and parts[5].strip().lstrip("-").isdigit() else 0
        if mention_ts < 0:
            mention_ts = 0
        person = person.strip()
        if not person or is_role_label(person):
            dropped += 1
            continue
        slug = slugify(person)
        if not slug:
            dropped += 1
            continue
        key = (slug, youtube_id)
        existing = rows.get(key)
        if existing is None:
            rows[key] = [channel, upload_date, title, mention_ts]
        else:
            # ista osoba, isti video: zadrži raniji ne-nula timestamp
            cur = existing[3]
            if mention_ts > 0 and (cur == 0 or mention_ts < cur):
                existing[3] = mention_ts

    vals = [
        f"({_q(slug)},{_q(yid)},{_q(r[0])},{_q(r[2])},{_qd(r[1])},{r[3]})"
        for (slug, yid), r in rows.items()
    ]

    out = ["BEGIN;", "DELETE FROM person_mentions;"]
    for i in range(0, len(vals), 500):
        grp = ",\n".join(vals[i : i + 500])
        out.append(
            "INSERT INTO person_mentions "
            "(slug, youtube_id, channel, title, upload_date, mention_ts) VALUES\n"
            + grp
            + "\nON CONFLICT (slug, youtube_id) DO NOTHING;"
        )
    out.append("COMMIT;")
    sys.stdout.write("\n".join(out) + "\n")
    with_ts = sum(1 for r in rows.values() if r[3] > 0)
    sys.stderr.write(
        f"[emit_person_mentions_sql] {len(vals)} mention-redova "
        f"({with_ts} s timestampom; {dropped} odbačeno: role/prazno)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
