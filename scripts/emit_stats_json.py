#!/usr/bin/env python3
"""Stats snapshot — ClickHouse `FORMAT JSON` outputi → jedan stats.json.

Namjerno dependency-free (stdlib + etl.speakers koji je isto stdlib): CH se čita
preko `docker exec clickhouse-client` (lokalno ili SSH na cloud) u
scripts/sync-stats.sh, a ovaj skript sklapa rezultate u data-contract shape
(domovina-stats/docs/02-data-contract.md). Consumer je stats.domovina.ai.

Govornike NE brojimo naivno: reuse-amo `build_persons` iz person huba (isti
role-filter + dedup varijanti "fra"/"Fra"), pa se broj govornika i leaderboard
POKLAPAJU s PG `speakers` tablicom / /api/person.

ClickHouse quota UInt64 (count/uniqExact) kao STRING u JSON-u → coerce po polju.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

# etl.speakers je pure-stdlib (build_persons, _load_seed) — bez DB deps.
REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO / "services" / "etl"))
from etl.speakers import build_persons, _load_seed  # noqa: E402


def _load_rows(path: str) -> list[dict]:
    with open(path, encoding="utf-8") as fh:
        return json.load(fh).get("data", [])


def _i(v) -> int:
    if v in (None, ""):
        return 0
    return int(float(v))


def _f(v) -> float:
    if v in (None, ""):
        return 0.0
    return round(float(v), 1)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--totals", required=True)
    ap.add_argument("--speakers-raw", required=True)  # svi distinct raw govornici
    ap.add_argument("--channels", required=True)
    ap.add_argument("--timeline", required=True)
    ap.add_argument("--generated-at", required=True)
    ap.add_argument("--source", required=True, choices=["cloud", "local"])
    ap.add_argument("--top-n", type=int, default=15)
    args = ap.parse_args()

    totals_rows = _load_rows(args.totals)
    if not totals_rows:
        sys.stderr.write("[emit_stats_json] ERROR: prazan totals — CH nedostupan?\n")
        return 1
    t = totals_rows[0]

    # ── Govornici preko person-hub logike (dedup + role filter) ──────────────
    seed_path = os.environ.get(
        "SPEAKER_SEED", str(REPO / "infra" / "postgres" / "seeds" / "speaker_aliases.csv")
    )
    seed = _load_seed(Path(seed_path))
    raw_rows = _load_rows(args.speakers_raw)
    # build_persons očekuje (raw, chunks, episodes, channels_list)
    person_input = [
        (
            str(r.get("raw") or ""),
            _i(r.get("chunks")),
            _i(r.get("episodes")),
            str(r.get("channels") or "").split("|") if r.get("channels") else [],
        )
        for r in raw_rows
    ]
    res = build_persons(person_input, seed=seed)

    # Epizode po osobi: sum epizoda njenih raw-varijanti (alias-i). Sitni
    # double-count rizik (ista osoba pod 2 labela u istoj epizodi) je zanemariv
    # za leaderboard; broj OSOBA je egzaktan (= person hub).
    eps_by_raw = {row[0]: row[2] for row in person_input}
    persons_ranked = sorted(
        (
            {
                "name": p.canonical_name,
                "episodes": sum(eps_by_raw.get(a, 0) for a in p.aliases),
                "chunks": p.chunks,
            }
            for p in res.persons
        ),
        key=lambda d: (-d["episodes"], -d["chunks"], d["name"]),
    )

    totals = {
        "episodes": _i(t.get("episodes")),
        "chunks": _i(t.get("chunks")),
        "channels": _i(t.get("channels")),
        "hours": _i(t.get("hours")),
        "speakers": len(res.persons),
        "first_date": str(t.get("first_date") or ""),
        "last_date": str(t.get("last_date") or ""),
    }

    channels = [
        {
            "channel": str(r.get("channel") or ""),
            "episodes": _i(r.get("episodes")),
            "chunks": _i(r.get("chunks")),
            "hours": _f(r.get("hours")),
        }
        for r in _load_rows(args.channels)
    ]

    timeline = [
        {
            "month": str(r.get("month") or ""),
            "episodes": _i(r.get("episodes")),
            "chunks": _i(r.get("chunks")),
        }
        for r in _load_rows(args.timeline)
    ]

    out = {
        "schema_version": 1,
        "generated_at": args.generated_at,
        "source": args.source,
        "totals": totals,
        "channels": channels,
        "timeline": timeline,
        "top_speakers": persons_ranked[: args.top_n],
    }
    json.dump(out, sys.stdout, ensure_ascii=False, indent=2)
    sys.stdout.write("\n")
    sys.stderr.write(
        f"[emit_stats_json] {totals['episodes']} epizoda, {totals['chunks']} chunkova, "
        f"{totals['channels']} kanala, {totals['hours']}h, {totals['speakers']} govornika "
        f"(skip: {res.skipped_role} role, {res.skipped_speaker_xx} SPEAKER_XX), "
        f"{len(channels)} channel-redova, {len(timeline)} mjeseci\n"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
