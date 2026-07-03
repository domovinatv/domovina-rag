"""Testovi za normalizaciju "person hub"-a (etl.speakers).

Bez pytest ovisnosti — pokretljivo i kao `python3 -m tests.test_speakers`
(iz services/etl) i preko pytesta ako je instaliran. Pokriva rizično područje:
slug-fold, role-blocklist, grupiranje varijanti, ručni seed.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from etl.speakers import (  # noqa: E402
    build_persons,
    is_person_token,
    is_role_label,
    slugify,
)


def test_slugify_folds_diacritics():
    assert slugify("don Tomislav Lukač") == "don-tomislav-lukac"
    assert slugify("Željka Markić") == "zeljka-markic"
    assert slugify("Mislav Kolakušić") == "mislav-kolakusic"
    assert slugify("Karolina Vidović-Krišto") == "karolina-vidovic-kristo"
    # case + interni razmaci se normaliziraju u isti slug
    assert slugify("  fra   Stjepan  Brčina ") == "fra-stjepan-brcina"


def test_slug_is_stable_identity_across_variants():
    # Dijakritika, case i crtica varijante iste osobe → isti slug.
    for a, b in [
        ("Iva Kraljević", "Iva Kraljevic"),
        ("fra Stjepan Brčina", "Fra Stjepan Brčina"),
        ("Karolina Vidović Krišto", "Karolina Vidović-Krišto"),
    ]:
        assert slugify(a) == slugify(b), (a, b)


def test_role_labels_are_not_persons():
    for role in [
        "Voditelj", "voditeljica", "Sugovornik", "Gost", "UNKNOWN",
        "Gost 1", "Sugovornik 2", "Voditelj 3", "Narator", "Publika",
        "Sudionik 10", "-", "N/A",
    ]:
        assert is_role_label(role), role
        assert not is_person_token(role), role


def test_speaker_xx_excluded():
    for tok in ["SPEAKER_00", "SPEAKER_12", "speaker 3", "SPEAKER-7"]:
        assert not is_person_token(tok), tok


def test_real_people_are_persons():
    for name in ["Željka Markić", "don Damir Stojić", "fra Ante Vučković", "Vinko"]:
        assert is_person_token(name), name
        assert not is_role_label(name), name


def test_build_merges_case_and_diacritic_variants():
    rows = [
        ("fra Stjepan Brčina", 100, 10, ["a"]),
        ("Fra Stjepan Brčina", 20, 5, ["b"]),
        ("Iva Kraljević", 50, 5, ["a"]),
        ("Iva Kraljevic", 5, 1, ["c"]),
        ("Voditelj", 999, 50, ["a"]),      # role → skip
        ("SPEAKER_00", 30, 3, ["a"]),      # raw diar → skip
        ("Gost 2", 40, 4, ["a"]),          # numbered role → skip
    ]
    res = build_persons(rows)
    by_slug = {p.slug: p for p in res.persons}
    assert set(by_slug) == {"fra-stjepan-brcina", "iva-kraljevic"}
    brcina = by_slug["fra-stjepan-brcina"]
    assert brcina.chunks == 120
    assert sorted(brcina.aliases) == ["Fra Stjepan Brčina", "fra Stjepan Brčina"]
    # canonical = najčešća varijanta
    assert brcina.canonical_name == "fra Stjepan Brčina"
    assert set(brcina.channels) == {"a", "b"}
    assert res.skipped_role == 2  # Voditelj + Gost 2
    assert res.skipped_speaker_xx == 1
    assert res.variants_merged == 2  # druga varijanta Brčine + Kraljević


def test_seed_merges_standalone_into_target():
    rows = [
        ("Vinko Mihaljević", 100, 10, ["a"]),
        ("Vinko", 20, 5, ["b"]),
    ]
    # seed key = slugify(alias) → target_slug
    seed = {slugify("Vinko"): "vinko-mihaljevic"}
    res = build_persons(rows, seed=seed)
    by_slug = {p.slug: p for p in res.persons}
    assert set(by_slug) == {"vinko-mihaljevic"}
    p = by_slug["vinko-mihaljevic"]
    assert sorted(p.aliases) == ["Vinko", "Vinko Mihaljević"]
    assert p.chunks == 120
    assert res.seed_merges == 1


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
