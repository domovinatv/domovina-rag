"""Programi stranaka (Kompas stranaka) → ClickHouse `program_chunks`.

Izvor je `chunks.jsonl` iz repoa stranke.domovina.ai (gitignored ondje, nikad se
ne kopira ovamo): jedan red = jedan odjeljak programa, `metadata.doc_id` veže
odjeljke istog dokumenta. Nazivi stranaka dolaze iz `liste_2024.json` i spajaju
se pri unosu u paralelne nizove party_names / party_short / party_slugs.

Idempotentno po dokumentu:
  - potpis dokumenta = skup (chunk_id, text_hash, metadata, party_*) njegovih redaka;
  - isti potpis u CH-u i u fajlu → preskoči (bez ijednog poziva embeddera);
  - različit → embedaj što treba, obriši stare retke dokumenta, ubaci nove;
  - doc_id koji je u CH-u, a nema ga u fajlu → obriši (prune).

Embedding se ponovno koristi po text_hash: ako se promijenio samo metapodatak
(naslov, URL, naziv stranke), tekst je već embedan i embedder se ne zove. Embed
ide u malim batchevima (≤8), sekvencijalno, u jednom procesu — MPS embedder na
Macu ne podnosi više (vidi docs/mps-embedder-memory.md).

Modul namjerno ne uvozi clickhouse_connect ni httpx: CH i embedder ulaze kao
objekti, pa se logika testira bez baze i bez modela (tests/test_programs.py).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterable, Iterator, Optional, Protocol, Sequence


log = logging.getLogger("etl.programs")

# Embedder na MPS-u: mali batchevi. Gornja granica je tvrda (CLI je klampa).
DEFAULT_BATCH_SIZE = 8
MAX_BATCH_SIZE = 8

# Kolone koje ETL piše (inserted_at puni CH sam). Redoslijed = redoslijed u retku.
COLUMNS: list[str] = [
    "chunk_id",
    "doc_id",
    "chunk_index",
    "total_chunks",
    "party_ids",
    "party_names",
    "party_short",
    "party_slugs",
    "list_id",
    "manjine_id",
    "vrsta",
    "izvor",
    "nesiguran",
    "nesiguran_razlog",
    "naslov",
    "url",
    "datum",
    "page_from",
    "page_to",
    "section",
    "words",
    "format",
    "text",
    "text_hash",
    "embedding",
    "metadata",
]

# Isti uzorak kao db._SAFE_ID: doc_id ide u SQL literal pri brisanju.
_SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


# ─────────── putanje ───────────────────────────────────────────


def stranke_repo() -> Path:
    """`STRANKE_REPO` iz env-a, inače `../stranke.domovina.ai` od korijena repoa."""
    if env := os.environ.get("STRANKE_REPO"):
        return Path(env)
    # services/etl/etl/programs.py → korijen repoa je parents[3]. U kontejneru
    # (/app/etl/programs.py) toga nema — ondje se putanje uvijek daju eksplicitno.
    here = Path(__file__).resolve()
    root = here.parents[3] if len(here.parents) > 3 else here.parent
    return root.parent / "stranke.domovina.ai"


def default_input() -> Path:
    if env := os.environ.get("PROGRAMS_INPUT"):
        return Path(env)
    return stranke_repo() / "data" / "raw" / "kompas" / "chunks.jsonl"


def default_liste() -> Path:
    if env := os.environ.get("PROGRAMS_LISTE"):
        return Path(env)
    return stranke_repo() / "data" / "kompas" / "liste_2024.json"


# ─────────── čitanje i mapiranje ────────────────────────────────


def load_parties(path: Path) -> dict[int, dict]:
    """party_id → {canonical_name, short_name, slug} iz liste_2024.json["stranke"]."""
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    out: dict[int, dict] = {}
    for s in data.get("stranke", []):
        try:
            out[int(s["party_id"])] = s
        except (KeyError, TypeError, ValueError):
            continue
    return out


def read_chunks(path: Path) -> list[dict]:
    """Pročitaj i validiraj chunks.jsonl. Prazan fajl je GREŠKA, ne „nula
    dokumenata” — inače bi prune obrisao cijelu tablicu."""
    recs: list[dict] = []
    seen: set[str] = set()
    with Path(path).open(encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            if not line.strip():
                continue
            rec = json.loads(line)
            cid = rec.get("id")
            meta = rec.get("metadata") or {}
            doc_id = meta.get("doc_id")
            if not isinstance(cid, str) or not _SAFE_ID.match(cid):
                raise ValueError(f"{path}:{lineno}: neispravan id {cid!r}")
            if not isinstance(doc_id, str) or not _SAFE_ID.match(doc_id):
                raise ValueError(f"{path}:{lineno}: neispravan doc_id {doc_id!r}")
            if not isinstance(rec.get("text"), str):
                raise ValueError(f"{path}:{lineno}: text nije string")
            if cid in seen:
                raise ValueError(f"{path}:{lineno}: dupli id {cid}")
            seen.add(cid)
            recs.append(rec)
    if not recs:
        raise ValueError(f"{path}: nema nijednog chunka — odbijam (prune bi ispraznio tablicu)")
    return recs


def _s(v) -> str:
    return "" if v is None else str(v)


def _u(v) -> int:
    if v is None or v == "":
        return 0
    return max(0, int(v))


def text_hash(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def map_row(rec: dict, parties: dict[int, dict]) -> dict:
    """JSONL red → dict po COLUMNS (bez embeddinga). NULL → '' / 0."""
    meta = rec.get("metadata") or {}
    pids = [int(p) for p in (meta.get("party_ids") or [])]
    names, shorts, slugs = [], [], []
    for pid in pids:
        p = parties.get(pid) or {}
        names.append(_s(p.get("canonical_name")))
        shorts.append(_s(p.get("short_name")))
        slugs.append(_s(p.get("slug")))
    text = rec["text"]
    return {
        "chunk_id": rec["id"],
        "doc_id": meta["doc_id"],
        "chunk_index": _u(meta.get("chunk_index")),
        "total_chunks": _u(meta.get("total_chunks")),
        "party_ids": pids,
        "party_names": names,
        "party_short": shorts,
        "party_slugs": slugs,
        "list_id": _s(meta.get("list_id")),
        "manjine_id": _s(meta.get("manjine_id")),
        "vrsta": _s(meta.get("vrsta")),
        "izvor": _s(meta.get("izvor")),
        "nesiguran": 1 if meta.get("nesiguran") else 0,
        "nesiguran_razlog": _s(meta.get("nesiguran_razlog")),
        "naslov": _s(meta.get("naslov")),
        "url": _s(meta.get("url")),
        "datum": _s(meta.get("datum")),
        "page_from": _u(meta.get("page_from")),
        "page_to": _u(meta.get("page_to")),
        "section": _s(meta.get("section")),
        "words": _u(meta.get("words")),
        "format": _s(meta.get("format")),
        "text": text,
        "text_hash": text_hash(text),
        "embedding": [],
        # sort_keys: isti metadata → isti string → stabilan potpis između runova.
        "metadata": json.dumps(meta, ensure_ascii=False, sort_keys=True),
    }


def group_by_doc(rows: Iterable[dict]) -> dict[str, list[dict]]:
    docs: dict[str, list[dict]] = {}
    for r in rows:
        docs.setdefault(r["doc_id"], []).append(r)
    for rs in docs.values():
        rs.sort(key=lambda r: r["chunk_index"])
    return docs


# ─────────── odluka: skip / new / reload / prune ───────────────


def _sig(chunk_id, th, metadata, names, shorts, slugs) -> tuple:
    return (chunk_id, th, metadata, tuple(names), tuple(shorts), tuple(slugs))


def row_signature(row: dict) -> tuple:
    return _sig(
        row["chunk_id"], row["text_hash"], row["metadata"],
        row["party_names"], row["party_short"], row["party_slugs"],
    )


def doc_signatures(file_docs: dict[str, list[dict]]) -> dict[str, frozenset]:
    return {d: frozenset(row_signature(r) for r in rs) for d, rs in file_docs.items()}


def state_signatures(state_rows: Iterable[Sequence]) -> dict[str, frozenset]:
    """Redovi iz ChClient.program_state() → doc_id → potpis."""
    acc: dict[str, set] = {}
    for doc_id, chunk_id, th, metadata, names, shorts, slugs in state_rows:
        acc.setdefault(doc_id, set()).add(_sig(chunk_id, th, metadata, names, shorts, slugs))
    return {d: frozenset(s) for d, s in acc.items()}


@dataclass
class Plan:
    skip: list[str] = field(default_factory=list)
    new: list[str] = field(default_factory=list)
    reload: list[str] = field(default_factory=list)
    prune: list[str] = field(default_factory=list)


def plan_sync(file_sigs: dict[str, frozenset], ch_sigs: dict[str, frozenset]) -> Plan:
    p = Plan()
    for d in sorted(file_sigs):
        if d not in ch_sigs:
            p.new.append(d)
        elif ch_sigs[d] == file_sigs[d]:
            p.skip.append(d)
        else:
            p.reload.append(d)
    p.prune = sorted(set(ch_sigs) - set(file_sigs))
    return p


# ─────────── izvođenje ─────────────────────────────────────────


class Embedder(Protocol):
    def embed(self, texts: list[str]) -> list[list[float]]: ...


class ProgramStore(Protocol):
    def program_state(self) -> list[tuple]: ...
    def program_embeddings(self, text_hashes: Sequence[str]) -> dict[str, list[float]]: ...
    def delete_program_docs(self, doc_ids: Sequence[str]) -> None: ...
    def insert_program_chunks(self, rows: Sequence[Sequence], column_names: Sequence[str]) -> None: ...


def clamp_batch_size(n: int) -> int:
    if n < 1:
        return 1
    if n > MAX_BATCH_SIZE:
        log.warning("--batch-size %d > %d — koristim %d (MPS embedder)", n, MAX_BATCH_SIZE, MAX_BATCH_SIZE)
        return MAX_BATCH_SIZE
    return n


def batched(seq: Sequence, n: int) -> Iterator[Sequence]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


@dataclass
class Summary:
    docs: int = 0
    skipped: int = 0
    new: int = 0
    reloaded: int = 0
    pruned: int = 0
    deferred: int = 0          # trebali embed, a embedder nije dostupan
    chunks_inserted: int = 0
    embedded: int = 0          # tekstova poslanih embedderu
    reused: int = 0            # tekstova kojima je embedding uzet iz CH-a
    errors: int = 0
    plan: Plan = field(default_factory=Plan)

    def line(self, dry_run: bool = False) -> str:
        return (
            f"Done: docs={self.docs} skipped={self.skipped} new={self.new} "
            f"reloaded={self.reloaded} pruned={self.pruned} deferred={self.deferred} "
            f"chunks_inserted={self.chunks_inserted} embedded={self.embedded} "
            f"reused={self.reused} errors={self.errors}"
            + (" (dry-run)" if dry_run else "")
        )


def sync_programs(
    store: ProgramStore,
    file_docs: dict[str, list[dict]],
    get_embedder: Callable[[], Optional[Embedder]],
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    dry_run: bool = False,
) -> Summary:
    """Dovedi `program_chunks` u stanje iz fajla. `get_embedder` se zove tek
    kad stvarno treba embedati (None = embedder nije dostupan → ti dokumenti se
    odgađaju uz WARNING, ostatak plana se izvodi)."""
    batch_size = clamp_batch_size(batch_size)
    plan = plan_sync(doc_signatures(file_docs), state_signatures(store.program_state()))
    s = Summary(docs=len(file_docs), skipped=len(plan.skip), plan=plan)

    to_load = plan.new + plan.reload
    needed = sorted({r["text_hash"] for d in to_load for r in file_docs[d]})
    vectors = store.program_embeddings(needed) if needed else {}
    missing = [h for h in needed if h not in vectors]
    s.reused = len(needed) - len(missing)

    if dry_run:
        s.new, s.reloaded, s.pruned = len(plan.new), len(plan.reload), len(plan.prune)
        s.embedded = len(missing)  # koliko BI ih išlo u embedder
        s.chunks_inserted = sum(len(file_docs[d]) for d in to_load)
        return s

    embedder: Optional[Embedder] = None
    if missing:
        embedder = get_embedder()
        if embedder is None:
            log.warning(
                "embedder nije dostupan — odgađam dokumente kojima treba %d novih embeddinga",
                len(missing),
            )

    for d in to_load:
        rows = file_docs[d]
        todo: list[tuple[str, str]] = []  # (hash, text), jedinstveno po hashu
        seen: set[str] = set()
        for r in rows:
            h = r["text_hash"]
            if h not in vectors and h not in seen:
                seen.add(h)
                todo.append((h, r["text"]))
        if todo and embedder is None:
            s.deferred += 1
            continue
        try:
            for batch in batched(todo, batch_size):
                vecs = embedder.embed([t for _, t in batch])  # type: ignore[union-attr]
                if len(vecs) != len(batch) or any(not v for v in vecs):
                    raise RuntimeError(f"embedder vratio {len(vecs)} vektora za {len(batch)} tekstova")
                for (h, _), v in zip(batch, vecs):
                    vectors[h] = list(v)
                s.embedded += len(batch)
        except Exception as e:  # noqa: BLE001 — jedan dokument ne ruši ostale
            log.error("doc %s: embed pao (%s: %s) — stari redovi ostaju", d, type(e).__name__, e)
            s.errors += 1
            continue

        out = []
        for r in rows:
            r = dict(r, embedding=vectors[r["text_hash"]])
            out.append([r[c] for c in COLUMNS])
        if d in plan.reload:
            # Briši TEK kad su svi embeddinzi u ruci: pad embeddera ne smije
            # ostaviti dokument bez redaka.
            store.delete_program_docs([d])
            s.reloaded += 1
        else:
            s.new += 1
        store.insert_program_chunks(out, COLUMNS)
        s.chunks_inserted += len(out)

    if plan.prune:
        store.delete_program_docs(plan.prune)
        s.pruned = len(plan.prune)
    return s


def load_file_docs(input_path: Path, liste_path: Path) -> dict[str, list[dict]]:
    parties = load_parties(liste_path)
    rows = [map_row(rec, parties) for rec in read_chunks(input_path)]
    unknown = sorted({pid for r in rows for pid, n in zip(r["party_ids"], r["party_names"]) if not n})
    if unknown:
        log.warning("party_id bez naziva u %s: %s ('' u party_names)", liste_path, unknown)
    return group_by_doc(rows)
