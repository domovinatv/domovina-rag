"""Testovi za "Spominje se u" pipeline (episode_mentions → person_mentions).

Bez pytest ovisnosti — pokretljivo kao `python3 -m tests.test_mentions`
(iz services/etl) i preko pytesta. Pokriva: čitanje summary.json sidecar-a i
slug-konzistentnost emittera (person_mentions.slug === speakers.slug).
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path

REPO_ETL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ETL))

from etl.sources import (  # noqa: E402
    JsonlFile,
    clock_to_sec,
    read_article_entity_ts,
    read_mentioned_people,
)
from etl.speakers import slugify  # noqa: E402

REPO_ROOT = REPO_ETL.parent.parent
EMIT_SCRIPT = REPO_ROOT / "scripts" / "emit_person_mentions_sql.py"


def _make_jsonl(dirpath: Path, basename: str, youtube_id: str) -> JsonlFile:
    p = dirpath / f"{basename}.rag_combined.jsonl"
    p.write_text('{"id":"x","text":"t","metadata":{}}\n', encoding="utf-8")
    return JsonlFile(path=p, channel_slug="test_channel", basename=basename, youtube_id=youtube_id)


def test_read_mentioned_people_parses_sidecar():
    with tempfile.TemporaryDirectory() as d:
        dirpath = Path(d)
        base = "20260528_koncert_yt_DR9rrCDpnTA"
        jsonl = _make_jsonl(dirpath, base, "DR9rrCDpnTA")
        (dirpath / f"{base}.wav.canary.summary.json").write_text(
            json.dumps({
                "summary": {
                    "title_hr": "Vanessa i Thompson",
                    "mentioned_people": ["Ante Čaljkušić", "  ", "Michael Jackson"],
                }
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        people, title = read_mentioned_people(jsonl)
        assert people == ["Ante Čaljkušić", "Michael Jackson"], people  # blank odbačen
        assert title == "Vanessa i Thompson"


def test_read_mentioned_people_missing_sidecar():
    with tempfile.TemporaryDirectory() as d:
        jsonl = _make_jsonl(Path(d), "20200101_x_yt_abcdefghijk", "abcdefghijk")
        assert read_mentioned_people(jsonl) == ([], None)


def test_read_mentioned_people_bad_json():
    with tempfile.TemporaryDirectory() as d:
        dirpath = Path(d)
        base = "20200101_x_yt_abcdefghijk"
        jsonl = _make_jsonl(dirpath, base, "abcdefghijk")
        (dirpath / f"{base}.wav.canary.summary.json").write_text("{ ne-json", encoding="utf-8")
        assert read_mentioned_people(jsonl) == ([], None)


def test_clock_to_sec():
    assert clock_to_sec("00:00:40") == 40
    assert clock_to_sec("01:02:03") == 3723
    assert clock_to_sec("06:00") == 360        # MM:SS
    assert clock_to_sec("90") == 90
    assert clock_to_sec("") == 0
    assert clock_to_sec("junk") == 0


def test_read_article_entity_ts():
    with tempfile.TemporaryDirectory() as d:
        dirpath = Path(d)
        base = "20260424_koncert_yt_DR9rrCDpnTA"
        jsonl = _make_jsonl(dirpath, base, "DR9rrCDpnTA")
        (dirpath / f"{base}.wav.canary.diarized_2026-05-11_gemini.article.json").write_text(
            json.dumps({
                "iterations": [{
                    "sections": [
                        {"screenshot_timestamp": "00:03:10", "entities": ["Ante Čaljkušić"]},
                        {"screenshot_timestamp": "00:00:40", "entities": ["Vanessa Mioć"]},
                        # Ista osoba kasnije — MIN mora pobijediti:
                        {"screenshot_timestamp": "00:10:00", "entities": ["Ante Caljkusic"]},
                    ],
                }]
            }, ensure_ascii=False),
            encoding="utf-8",
        )
        m = read_article_entity_ts(jsonl, slugify)
        assert m["ante-caljkusic"] == 190, m   # 00:03:10, ne 00:10:00 (ASR fold match)
        assert m["vanessa-mioc"] == 40


def test_read_article_entity_ts_missing():
    with tempfile.TemporaryDirectory() as d:
        jsonl = _make_jsonl(Path(d), "20200101_x_yt_abcdefghijk", "abcdefghijk")
        assert read_article_entity_ts(jsonl, slugify) == {}


def test_emit_person_mentions_slug_matches_speakers():
    # Isti slug algoritam kao speakers.slug → whole-person join u hub.
    tsv = "DR9rrCDpnTA\t40_dana_za_zivot\t2026-05-28\tKoncert\tAnte Čaljkušić\n"
    out = subprocess.run(
        [sys.executable, str(EMIT_SCRIPT)],
        input=tsv, capture_output=True, text=True, check=True,
    ).stdout
    assert slugify("Ante Čaljkušić") == "ante-caljkusic"
    assert "'ante-caljkusic'" in out
    assert "DELETE FROM person_mentions;" in out
    assert "ON CONFLICT (slug, youtube_id) DO NOTHING" in out
    assert "'2026-05-28'::date" in out


def test_emit_person_mentions_drops_role_and_dedups():
    # Role-label se izbaci; dupli (slug, youtube_id) se dedupira.
    tsv = (
        "vid1\tch\t2026-01-01\tT\tVoditelj\n"      # role → drop
        "vid1\tch\t2026-01-01\tT\tAnte Čaljkušić\n"
        "vid1\tch\t2026-01-01\tT\tAnte Caljkusic\n"  # ista osoba (fold) → dedup
    )
    out = subprocess.run(
        [sys.executable, str(EMIT_SCRIPT)],
        input=tsv, capture_output=True, text=True, check=True,
    ).stdout
    assert out.count("'ante-caljkusic'") == 1, out
    assert "Voditelj" not in out


def test_emit_carries_and_mins_mention_ts():
    # mention_ts se prenese; dva reda iste osobe+videa → MIN ne-nula ts.
    tsv = (
        "vid1\tch\t2026-01-01\tT\tMarko Perković Thompson\t190\n"
        "vid1\tch\t2026-01-01\tT\tAnte Čaljkušić\t0\n"        # miss → 0 → /v/ fallback
        "vid2\tch\t2026-01-01\tT\tAnte Čaljkušić\t530\n"
        "vid2\tch\t2026-01-01\tT\tAnte Caljkusic\t120\n"      # ista osoba+video → min(530,120)=120
    )
    out = subprocess.run(
        [sys.executable, str(EMIT_SCRIPT)],
        input=tsv, capture_output=True, text=True, check=True,
    ).stdout
    assert "'marko-perkovic-thompson','vid1','ch','T','2026-01-01'::date,190," in out, out
    assert "'ante-caljkusic','vid1','ch','T','2026-01-01'::date,0," in out, out
    assert "'ante-caljkusic','vid2','ch','T','2026-01-01'::date,120," in out, out


def test_emit_carries_person_name():
    # person_name = sirovo ime s dijakritikom (display za osobe bez speakers reda).
    # Kolizija varijanti u istom videu → leksikografski min (ASCII: 'A' < 'a').
    tsv = (
        "vid1\tch\t2026-01-01\tT\tŽeljka Markić\t10\n"
        "vid2\tch\t2026-01-01\tT\tante čaljkušić\t10\n"
        "vid2\tch\t2026-01-01\tT\tAnte Čaljkušić\t20\n"
    )
    out = subprocess.run(
        [sys.executable, str(EMIT_SCRIPT)],
        input=tsv, capture_output=True, text=True, check=True,
    ).stdout
    assert "person_name) VALUES" in out, out
    assert ",10,'Željka Markić')" in out, out
    assert ",10,'Ante Čaljkušić')" in out, out  # velika slova pobijedila


def test_emit_merges_veneration_prefix():
    # "bl. Ivan Merz" / "Blaženi Ivan Merz" / "Ivan Merz" = JEDNA osoba.
    # Klerički naslov (don) se NE dira — dio je speakers slug konvencije.
    tsv = (
        "vid1\tch\t2026-01-01\tT\tbl. Ivan Merz\t10\n"
        "vid2\tch\t2026-01-01\tT\tBlaženi Ivan Merz\t10\n"
        "vid3\tch\t2026-01-01\tT\tIvan Merz\t10\n"
        "vid4\tch\t2026-01-01\tT\tSv. Ivan Pavao II\t10\n"
        "vid5\tch\t2026-01-01\tT\tdon Tomislav Lukač\t10\n"
    )
    out = subprocess.run(
        [sys.executable, str(EMIT_SCRIPT)],
        input=tsv, capture_output=True, text=True, check=True,
    ).stdout
    assert out.count("'ivan-merz'") == 3, out          # tri videa, jedan slug
    assert "blazeni-ivan-merz" not in out, out
    assert "bl-ivan-merz" not in out, out
    assert "'ivan-pavao-ii'" in out, out               # sv. skinut
    assert "'don-tomislav-lukac'" in out, out          # don NETAKNUT


def test_strip_veneration_edge_cases():
    sys.path.insert(0, str(REPO_ROOT / "scripts"))
    from emit_person_mentions_sql import strip_veneration  # noqa: PLC0415

    assert strip_veneration("bl. Ivan Merz") == "Ivan Merz"
    assert strip_veneration("Blažena Djevica Marija") == "Djevica Marija"
    assert strip_veneration("sveti Nikola Tavelić") == "Nikola Tavelić"
    assert strip_veneration("Ivan Merz") == "Ivan Merz"
    assert strip_veneration("Blaženi") == "Blaženi"          # ime JE prefiks → original
    assert strip_veneration("Blaž Kraljević") == "Blaž Kraljević"  # NIJE prefiks


def _main() -> int:
    fns = [v for k, v in sorted(globals().items()) if k.startswith("test_")]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"  ok  {fn.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL  {fn.__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_main())
