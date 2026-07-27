#!/usr/bin/env python3
"""Person-mentions populate — TSV (iz CH episode_mentions) → full-refresh SQL (za PG).

Namjerno dependency-free (samo stdlib + etl.speakers.slugify, isto stdlib): CH se
čita preko `docker exec clickhouse-client`, a PG puni preko `docker exec psql`, pa
ovaj korak ne treba clickhouse-connect/psycopg ni venv. Dio dnevnog sync-a
(scripts/sync-person-mentions.sh).

Slug se računa ISTIM algoritmom (etl.speakers.slugify) kao speakers.slug —
"Ante Čaljkušić" → "ante-caljkusic" — pa se person_mentions.slug whole-person
poklapa s person hub slug-om. Role-labeli i prazna imena se izbacuju.

Prije slugify-a skida se POBOŽNI prefiks ("bl.", "blaženi", "sv.", "sveta"…) —
producer isti entitet piše kao "Ivan Merz", "bl. Ivan Merz" i "Blaženi Ivan
Merz", što bi inače bila tri odvojena profila. Klerički naslovi (don, fra, vlč.,
mons.) se NE diraju: oni su dio speakers konvencije ("don-tomislav-lukac"), pa
bi skidanje razbilo poklapanje sa slugom govornika.

Uz slug se emitira i `person_name` (sirovo ime s dijakritikom) — hub ga koristi
kao display ime za osobe bez speakers reda. Vidi migrations/005.

Ulaz (stdin, TSV, bez headera): youtube_id \t channel \t upload_date \t title \t person \t mention_ts
Izlaz (stdout): BEGIN; DELETE FROM person_mentions; INSERT …; COMMIT;
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

# etl.speakers je pure-stdlib (slugify, is_role_label) — bez DB deps.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "etl"))
from etl.speakers import collapse_ws, is_role_label, slugify  # noqa: E402


# Pobožni prefiks (blaženi/sveti) — producer ga stavlja nedosljedno, pa bi
# "Ivan Merz" / "bl. Ivan Merz" / "Blaženi Ivan Merz" bila tri profila. Skidamo
# ga PRIJE slugify-a da se sve svede na jednu osobu.
#
# NAMJERNO bez kleričkih naslova (don, fra, vlč., mons., o.) — oni su dio
# speakers konvencije ("don Tomislav Lukač" → don-tomislav-lukac), pa bi ih
# skidanje ovdje odvojilo od huba istog čovjeka koji GOVORI.
_VENERATION_RE = re.compile(
    r"^(?:"
    r"bl|bla[žz]en[aiu]?|bla[žz]enik|bla[žz]enica"
    r"|sv|svet[aiou]|svetac|svetica"
    r")\.?\s+",
    re.IGNORECASE,
)


def strip_veneration(name: str) -> str:
    """'bl. Ivan Merz' → 'Ivan Merz'. Skida i višestruki prefiks ('sv. bl. X').

    Nikad ne vraća prazno: ako je nakon skidanja ostalo ništa (ime JE prefiks,
    npr. samo "Blaženi"), vraća original — takav token ionako otpadne kasnije.
    """
    s = collapse_ws(name)
    while True:
        stripped = _VENERATION_RE.sub("", s, count=1).strip()
        if stripped == s or not stripped:
            break
        s = stripped
    return s or collapse_ws(name)


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
    # epizodi (npr. "Ivan Merz" i "bl. Ivan Merz") drže SE zajedno; mention_ts =
    # MIN (najraniji spomen wins), person_name = leksikografski min (deterministički
    # neovisno o redoslijedu ulaza; ASCII velika slova < mala, pa "Ivan Merz"
    # pobjeđuje "ivan merz").
    # Row = [channel, upload_date, title, mention_ts, person_name].
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
        # "bl. Ivan Merz" → "Ivan Merz" (jedan profil, ne tri) — vidi docstring.
        person = strip_veneration(person)
        if is_role_label(person):
            dropped += 1
            continue
        slug = slugify(person)
        if not slug:
            dropped += 1
            continue
        key = (slug, youtube_id)
        existing = rows.get(key)
        if existing is None:
            rows[key] = [channel, upload_date, title, mention_ts, person]
        else:
            # ista osoba, isti video: zadrži raniji ne-nula timestamp
            cur = existing[3]
            if mention_ts > 0 and (cur == 0 or mention_ts < cur):
                existing[3] = mention_ts
            if person < existing[4]:
                existing[4] = person

    vals = [
        f"({_q(slug)},{_q(yid)},{_q(r[0])},{_q(r[2])},{_qd(r[1])},{r[3]},{_q(r[4])})"
        for (slug, yid), r in rows.items()
    ]

    out = ["BEGIN;", "DELETE FROM person_mentions;"]
    for i in range(0, len(vals), 500):
        grp = ",\n".join(vals[i : i + 500])
        out.append(
            "INSERT INTO person_mentions "
            "(slug, youtube_id, channel, title, upload_date, mention_ts, person_name) VALUES\n"
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
