#!/usr/bin/env python3
"""Person-hub populate — TSV (iz ClickHouse) → batched UPSERT SQL (za Postgres).

Namjerno dependency-free (samo stdlib + etl.speakers koji je isto stdlib): CH se
čita preko `docker exec clickhouse-client` (lokalno ili SSH na cloud), a PG se
puni preko `docker exec psql`, pa ovaj korak ne treba clickhouse-connect/psycopg
ni venv. Dio dnevnog sync-a (scripts/sync-speakers.sh).

Ulaz (stdin, TSV, bez headera): raw_speaker \t chunks \t episodes \t ch1|ch2|...
Izlaz (stdout): BEGIN; INSERT … ON CONFLICT …; DELETE (prune); COMMIT;
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

# etl.speakers je pure-stdlib (build_persons, slugify, _load_seed) — bez DB deps.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "etl"))
from etl.speakers import build_persons, _load_seed  # noqa: E402


def _parse_tsv(stream) -> list[tuple[str, int, int, list[str]]]:
    rows: list[tuple[str, int, int, list[str]]] = []
    for line in stream:
        line = line.rstrip("\n")
        if not line:
            continue
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        raw = parts[0]
        chunks = int(parts[1]) if parts[1].isdigit() else 0
        episodes = int(parts[2]) if parts[2].isdigit() else 0
        channels = parts[3].split("|") if len(parts) > 3 and parts[3] else []
        rows.append((raw, chunks, episodes, channels))
    return rows


def _q(s: str) -> str:
    # standard_conforming_strings=on → samo ' se udvaja
    return "'" + s.replace("'", "''") + "'"


def _qj(obj) -> str:
    return _q(json.dumps(obj, ensure_ascii=False)) + "::jsonb"


def main() -> int:
    seed_path = os.environ.get(
        "SPEAKER_SEED", str(REPO / "infra" / "postgres" / "seeds" / "speaker_aliases.csv")
    )
    seed = _load_seed(Path(seed_path))
    rows = _parse_tsv(sys.stdin)
    res = build_persons(rows, seed=seed)

    vals, slugs = [], []
    for p in res.persons:
        slugs.append(p.slug)
        vals.append(
            f"({_q(p.canonical_name)},{_q(p.slug)},"
            f"{_qj(sorted(set(p.aliases)))},{_qj(sorted(p.channels))},{p.confidence()},TRUE)"
        )

    out = ["BEGIN;"]
    for i in range(0, len(vals), 500):
        grp = ",\n".join(vals[i : i + 500])
        out.append(
            "INSERT INTO speakers "
            "(canonical_name, slug, aliases, channels, confidence, needs_review) VALUES\n"
            + grp
            + "\nON CONFLICT (slug) DO UPDATE SET "
            "canonical_name=EXCLUDED.canonical_name, aliases=EXCLUDED.aliases, "
            "channels=EXCLUDED.channels, confidence=EXCLUDED.confidence, updated_at=now();"
        )
    if slugs:
        arr = ",".join(_q(s) for s in slugs)
        out.append(
            f"DELETE FROM speakers WHERE slug IS NOT NULL AND NOT (slug = ANY(ARRAY[{arr}]));"
        )
    out.append("COMMIT;")
    sys.stdout.write("\n".join(out) + "\n")
    sys.stderr.write(
        f"[emit_speakers_sql] {len(res.persons)} osoba "
        f"(skip: {res.skipped_role} role, {res.skipped_speaker_xx} SPEAKER_XX; "
        f"{res.variants_merged} varijanti spojeno, {res.seed_merges} seed-merge)\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
