"""Populate `speakers` — "person hub" indeks (cross-channel govornici).

Čita distinct govornike iz CH `rag_chunks.speaker`, normalizira, kolapsira
case/honorifik varijante iste osobe, generira STABILAN ASCII slug i UPSERT-a u
PG `speakers`. Ručni alias seed (CSV) primijeni se na kraju za merge-eve koje
automatika ne može sigurno pogoditi (samo-ime, nadimak, tipfeler).

Granica: "govori" (diarizirani/imenovani speaker), NE "spominje se u tekstu".
Sirovi tokeni koji NISU osobe (role-labeli tipa "Voditelj", "Sugovornik",
"UNKNOWN", te raw "SPEAKER_XX") se isključuju iz huba.

    python -m etl speakers --dry-run
    python -m etl speakers
    python -m etl speakers --seed infra/postgres/seeds/speaker_aliases.csv
"""

from __future__ import annotations

import csv
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Iterable, Optional

log = logging.getLogger("etl.speakers")


# ── Isključivi tokeni ────────────────────────────────────────────────────────

# Raw diarizacijske oznake bez imena (upstream nije razriješio govornika).
_SPEAKER_XX_RE = re.compile(r"^speaker[_\s-]?\d+$", re.IGNORECASE)

# Generički role-labeli — NISU osobe (diarizacija nije razriješila stvarno ime).
# Empirijski otkriveni u korpusu: "Voditelj" (16k chunkova), plus cijela obitelj
# numeriranih placeholdera "Gost 1", "Sugovornik 2", "Voditelj 1"… Regex hvata
# role-stem + opcionalni broj; frozenset hvata ne-pattern oddballe.
_ROLE_RE = re.compile(
    r"^(?:"
    r"voditelj(?:ica)?|suvoditelj(?:ica)?|gostuju[cć]i voditelj|uvodni (?:voditelj|govornik)"
    r"|sugovornik|sugovornica|sugovornici"
    r"|gost|go[šs][cć]a|gostja|gosti"
    r"|govornik|govornica|govornici"
    r"|moderator(?:ica)?|narator(?:ica)?|naracija"
    r"|novinar(?:ka)?|novinari"
    r"|osoba|sudionik|sudionica|panelist(?:ica)?|ispitanik|ispitanica"
    r"|slu[šs]atelj(?:ica)?|gledatelj(?:ica)?|[čc]lan"
    r"|glas(?:ovi)?|publika"
    r"|unknown|nepoznat[oa]?"
    r")(?:[ _.\-]*\d+)?$",
    re.IGNORECASE,
)

# Ne-pattern oddballi (interpunkcija, kombinacije).
ROLE_BLOCKLIST: frozenset[str] = frozenset(
    {"gost/gošća", "gošća/gost", "glas iz publike", "n/a", "na", "-", "?", "…"}
)


def is_role_label(name: str) -> bool:
    """True ako je token generički role-placeholder (ne stvarna osoba)."""
    s = collapse_ws(name).lower()
    return s in ROLE_BLOCKLIST or bool(_ROLE_RE.match(s))

# Dijakritika → ASCII fold za slug (deterministički, stabilan public URL).
_FOLD = str.maketrans(
    {
        "č": "c", "ć": "c", "š": "s", "ž": "z", "đ": "d",
        "Č": "c", "Ć": "c", "Š": "s", "Ž": "z", "Đ": "d",
        # occasional non-HR unosi
        "á": "a", "à": "a", "ä": "a", "â": "a",
        "é": "e", "è": "e", "ë": "e", "ê": "e",
        "í": "i", "ì": "i", "ï": "i",
        "ó": "o", "ò": "o", "ö": "o", "ô": "o",
        "ú": "u", "ù": "u", "ü": "u", "û": "u",
        "ñ": "n", "ç": "c", "ß": "ss",
    }
)


def collapse_ws(s: str) -> str:
    """Trim + kolapsiraj interne razmake u jedan."""
    return " ".join(s.split())


def slugify(name: str) -> str:
    """ASCII slug — ujedno KLJUČ IDENTITETA osobe u hubu.

    Fold dijakritike (č→c…), lowercase, non-alnum → '-'. Deterministički i
    stabilan: računa se iz normaliziranog imena, ne iz display varijante, pa se
    javni URL ne mijenja kad se promijeni koji je zapis najčešći.
    Npr. "don Tomislav Lukač" → "don-tomislav-lukac".

    Slug se koristi kao merge-ključ: sve varijante koje folda-ju u isti slug
    (case: "fra"/"Fra"; dijakritika: "Kraljević"/"Kraljevic"; crtica:
    "Vidović Krišto"/"Vidović-Krišto") su ista osoba. To je namjerno — model
    identiteta je normalizacija + ručni aliasi (bez voice-resolucije).
    """
    folded = collapse_ws(name).lower().translate(_FOLD)
    return re.sub(r"[^a-z0-9]+", "-", folded).strip("-")


def is_person_token(raw: str) -> bool:
    """True ako je raw token stvarna imenovana osoba (ne role/placeholder/SPEAKER_XX)."""
    s = collapse_ws(raw)
    if not s:
        return False
    if _SPEAKER_XX_RE.match(s):
        return False
    if is_role_label(s):
        return False
    if not slugify(s):  # folda u prazno (samo interpunkcija/znamenke)
        return False
    return True


# ── Grupiranje ───────────────────────────────────────────────────────────────


@dataclass
class Person:
    slug: str
    canonical_name: str
    aliases: list[str] = field(default_factory=list)  # sirovi CH tokeni
    channels: set[str] = field(default_factory=set)
    chunks: int = 0
    _variant_chunks: dict[str, int] = field(default_factory=dict)

    def add_variant(self, raw: str, chunks: int, channels: Iterable[str]) -> None:
        self.aliases.append(raw)
        self._variant_chunks[raw] = self._variant_chunks.get(raw, 0) + chunks
        self.chunks += chunks
        self.channels.update(channels)

    def recompute_canonical(self) -> None:
        # Display = najčešća sirova varijanta (vjerna kapitalizaciji pipeline-a);
        # tie-break: leksikografski, za determinizam.
        best = max(self._variant_chunks.items(), key=lambda kv: (kv[1], kv[0]))
        self.canonical_name = best[0]
        self.aliases = sorted(set(self.aliases))

    def confidence(self) -> float:
        c = 0.5
        if self.chunks >= 100:
            c += 0.2
        elif self.chunks >= 20:
            c += 0.1
        if len(self.aliases) == 1:
            c += 0.1
        if len(self.canonical_name.split()) < 2:
            c -= 0.25  # samo-ime → vjerojatno fragment, treba review
        return round(max(0.1, min(0.95, c)), 3)


@dataclass
class BuildResult:
    persons: list[Person]
    skipped_role: int
    skipped_speaker_xx: int
    variants_merged: int  # koliko je sirovih varijanti spojeno u kanonske osobe
    seed_merges: int


def _load_seed(path: Optional[Path]) -> dict[str, str]:
    """CSV `slug,alias` → {slugify(alias): target_slug}. Prazne/'#' linije skip."""
    if not path:
        return {}
    if not path.exists():
        log.warning("Seed fajl %s ne postoji — preskačem ručne merge-eve", path)
        return {}
    out: dict[str, str] = {}
    with path.open(encoding="utf-8") as fh:
        for row in csv.reader(fh):
            if not row:
                continue
            first = row[0].strip()
            if not first or first.startswith("#") or len(row) < 2:
                continue
            target_slug, alias = first, row[1].strip()
            if target_slug and alias:
                out[slugify(alias)] = target_slug
    return out


def build_persons(
    rows: list[tuple[str, int, int, list[str]]],
    seed: Optional[dict[str, str]] = None,
) -> BuildResult:
    """Grupiraj sirove tokene u osobe. Čista funkcija (testabilna bez DB-a).

    rows = [(raw_token, chunks, episodes, channels[])] iz CH. Identitet = slug
    (ASCII-fold), pa se sve case/dijakritika/crtica varijante iste osobe spajaju
    u jedan red — nema `-2` suffiksa za istog čovjeka.
    """
    seed = seed or {}
    skipped_role = 0
    skipped_speaker_xx = 0
    variants = 0

    # Faza A: grupiraj po slug-u (ASCII-fold identitet). Spaja case ("fra"/"Fra"),
    # dijakritiku ("Kraljević"/"Kraljevic") i crticu ("A B"/"A-B") iste osobe.
    by_slug: dict[str, Person] = {}
    for raw, chunks, _episodes, channels in rows:
        s = collapse_ws(raw)
        if not s:
            continue
        if _SPEAKER_XX_RE.match(s):
            skipped_speaker_xx += 1
            continue
        if is_role_label(s) or not slugify(s):
            skipped_role += 1
            continue
        slug = slugify(s)
        p = by_slug.get(slug)
        if p is None:
            p = Person(slug=slug, canonical_name=s)
            by_slug[slug] = p
        else:
            variants += 1
        p.add_variant(raw, chunks, channels)

    # Faza B: ručni seed — premjesti aliase u ciljnu osobu, izbriši izvornu.
    seed_merges = 0
    for alias_slug, target_slug in seed.items():
        src = by_slug.get(alias_slug)
        target = by_slug.get(target_slug)
        if target is None:
            log.warning("Seed: ciljni slug '%s' ne postoji — skip", target_slug)
            continue
        if src is None or src is target:
            continue
        for raw, ch in src._variant_chunks.items():
            target.add_variant(raw, ch, [])
        target.channels.update(src.channels)
        del by_slug[alias_slug]
        seed_merges += 1

    persons = list(by_slug.values())
    for p in persons:
        p.recompute_canonical()
    persons.sort(key=lambda x: x.chunks, reverse=True)
    return BuildResult(
        persons=persons,
        skipped_role=skipped_role,
        skipped_speaker_xx=skipped_speaker_xx,
        variants_merged=variants,
        seed_merges=seed_merges,
    )
