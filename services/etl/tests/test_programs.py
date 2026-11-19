"""Testovi za programe stranaka (Kompas) → `program_chunks`.

Bez prave baze i bez modela: CH je FakeStore u memoriji, embedder je FakeEmbedder
koji bilježi batcheve. Pokretljivo i bez pytesta: `python3 -m tests.test_programs`
(iz services/etl). Pokriva: mapiranje retka (NULL-ovi, spajanje stranaka),
odluku skip / new / reload / prune, ponovnu upotrebu embeddinga, odgodu kad
embedder nije dostupan i veličinu batcha.
"""

from __future__ import annotations

import json
import sys
import tempfile
from pathlib import Path

REPO_ETL = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ETL))

from etl import programs as P  # noqa: E402


PARTIES = {
    1: {"party_id": 1, "canonical_name": "Hrvatska demokratska zajednica", "short_name": "HDZ", "slug": "hdz"},
    2: {"party_id": 2, "canonical_name": "Agrameri - nezavisna lista", "short_name": None, "slug": "agrameri"},
}


def _rec(doc_id: str, idx: int, text: str, party_ids=(1,), **meta) -> dict:
    m = {
        "type": "program_section",
        "doc_id": doc_id,
        "party_ids": list(party_ids),
        "list_id": None,
        "manjine_id": None,
        "vrsta": "izborni-2024",
        "izvor": "web",
        "nesiguran": False,
        "nesiguran_razlog": None,
        "naslov": f"Program {doc_id}",
        "url": f"https://example.hr/{doc_id}",
        "datum": None,
        "page_from": idx,
        "page_to": idx,
        "section": f"Odjeljak {idx}",
        "chunk_index": idx,
        "total_chunks": 3,
        "words": len(text.split()),
        "overlap_words": 0,
        "format": "pdf",
    }
    m.update(meta)
    return {"id": f"prog_{doc_id}_{idx:04d}", "text": text, "metadata": m}


def _docs(recs) -> dict[str, list[dict]]:
    return P.group_by_doc(P.map_row(r, PARTIES) for r in recs)


class FakeEmbedder:
    def __init__(self) -> None:
        self.batches: list[list[str]] = []

    def embed(self, texts: list[str]) -> list[list[float]]:
        self.batches.append(list(texts))
        return [[float(len(t)), 1.0, 0.5] for t in texts]


class FailingEmbedder:
    def embed(self, texts):
        raise ConnectionError("embedder pao")


class FakeStore:
    """program_chunks u memoriji: lista redova kao dict po P.COLUMNS."""

    def __init__(self) -> None:
        self.rows: list[dict] = []
        self.deleted: list[list[str]] = []
        self.inserts = 0

    def program_state(self):
        return [
            (r["doc_id"], r["chunk_id"], r["text_hash"], r["metadata"],
             list(r["party_names"]), list(r["party_short"]), list(r["party_slugs"]))
            for r in self.rows
        ]

    def program_embeddings(self, text_hashes):
        want = set(text_hashes)
        return {r["text_hash"]: r["embedding"] for r in self.rows if r["text_hash"] in want and r["embedding"]}

    def delete_program_docs(self, doc_ids):
        self.deleted.append(list(doc_ids))
        self.rows = [r for r in self.rows if r["doc_id"] not in set(doc_ids)]

    def insert_program_chunks(self, rows, column_names):
        self.inserts += 1
        for vals in rows:
            self.rows.append(dict(zip(column_names, vals)))


def _sync(store, docs, embedder=None, **kw):
    calls = []

    def get_embedder():
        calls.append(1)
        return embedder

    s = P.sync_programs(store, docs, get_embedder, **kw)
    return s, calls


BASE = [
    _rec("aaaaaaaaaaaa", 1, "Prvi odjeljak programa."),
    _rec("aaaaaaaaaaaa", 2, "Drugi odjeljak programa."),
    _rec("bbbbbbbbbbbb", 1, "Koalicijski program.", party_ids=(1, 2, 99)),
]


# ─────────── mapiranje ─────────────────────────────────────────


def test_map_row_nulls_become_empty_or_zero():
    r = P.map_row(_rec("aaaaaaaaaaaa", 1, "Tekst.", page_from=None, words=None), PARTIES)
    assert r["list_id"] == "" and r["manjine_id"] == "" and r["datum"] == ""
    assert r["nesiguran"] == 0 and r["nesiguran_razlog"] == ""
    assert r["page_from"] == 0 and r["words"] == 0
    assert r["embedding"] == []
    assert set(r) == set(P.COLUMNS)


def test_map_row_values_and_hash():
    rec = _rec("aaaaaaaaaaaa", 2, "Sekcija\n\nTekst.", list_id="dp-x", datum="2024-03-31",
               nesiguran=True, nesiguran_razlog="wayback")
    r = P.map_row(rec, PARTIES)
    assert r["chunk_id"] == "prog_aaaaaaaaaaaa_0002"
    assert r["chunk_index"] == 2 and r["total_chunks"] == 3
    assert r["list_id"] == "dp-x" and r["datum"] == "2024-03-31"
    assert r["nesiguran"] == 1 and r["nesiguran_razlog"] == "wayback"
    assert r["text"] == "Sekcija\n\nTekst."
    assert len(r["text_hash"]) == 64 and r["text_hash"] == P.text_hash("Sekcija\n\nTekst.")
    assert json.loads(r["metadata"]) == rec["metadata"]


def test_party_join_parallel_arrays_with_unknown():
    r = P.map_row(_rec("bbbbbbbbbbbb", 1, "K.", party_ids=(1, 2, 99)), PARTIES)
    assert r["party_ids"] == [1, 2, 99]
    assert r["party_names"] == ["Hrvatska demokratska zajednica", "Agrameri - nezavisna lista", ""]
    assert r["party_short"] == ["HDZ", "", ""]
    assert r["party_slugs"] == ["hdz", "agrameri", ""]


def test_read_chunks_rejects_empty_and_duplicates():
    with tempfile.TemporaryDirectory() as d:
        p = Path(d) / "chunks.jsonl"
        p.write_text("\n", encoding="utf-8")
        try:
            P.read_chunks(p)
            raise AssertionError("prazan fajl mora pasti")
        except ValueError:
            pass
        line = json.dumps(_rec("aaaaaaaaaaaa", 1, "x"), ensure_ascii=False)
        p.write_text(line + "\n" + line + "\n", encoding="utf-8")
        try:
            P.read_chunks(p)
            raise AssertionError("dupli id mora pasti")
        except ValueError:
            pass


def test_load_file_docs_from_disk():
    with tempfile.TemporaryDirectory() as d:
        cp, lp = Path(d) / "chunks.jsonl", Path(d) / "liste.json"
        cp.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in BASE), encoding="utf-8")
        lp.write_text(json.dumps({"stranke": list(PARTIES.values())}), encoding="utf-8")
        docs = P.load_file_docs(cp, lp)
        assert sorted(docs) == ["aaaaaaaaaaaa", "bbbbbbbbbbbb"]
        assert [r["chunk_index"] for r in docs["aaaaaaaaaaaa"]] == [1, 2]


# ─────────── idempotentnost ────────────────────────────────────


def test_first_load_inserts_everything():
    store, emb = FakeStore(), FakeEmbedder()
    s, _ = _sync(store, _docs(BASE), emb)
    assert (s.new, s.reloaded, s.skipped, s.pruned, s.errors) == (2, 0, 0, 0, 0)
    assert s.chunks_inserted == 3 and s.embedded == 3
    assert all(r["embedding"] for r in store.rows)


def test_unchanged_skips_without_calling_embedder():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    emb = FakeEmbedder()
    s, calls = _sync(store, _docs(BASE), emb)
    assert (s.skipped, s.new, s.reloaded, s.pruned) == (2, 0, 0, 0)
    assert calls == [] and emb.batches == []
    assert store.deleted == []


def test_changed_text_reloads_only_that_doc():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    changed = [BASE[0], _rec("aaaaaaaaaaaa", 2, "Drugi odjeljak, NOVA verzija."), BASE[2]]
    emb = FakeEmbedder()
    s, _ = _sync(store, _docs(changed), emb)
    assert (s.reloaded, s.skipped, s.new) == (1, 1, 0)
    assert store.deleted == [["aaaaaaaaaaaa"]]
    # Nepromijenjeni prvi odjeljak ima embedding u CH → embedder vidi samo novi tekst.
    assert emb.batches == [["Drugi odjeljak, NOVA verzija."]]
    assert s.embedded == 1 and s.reused == 1
    assert len([r for r in store.rows if r["doc_id"] == "aaaaaaaaaaaa"]) == 2


def test_metadata_only_change_reloads_without_embedding():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    changed = [_rec("aaaaaaaaaaaa", 1, BASE[0]["text"], url="https://novo.hr"), BASE[1], BASE[2]]
    s, calls = _sync(store, _docs(changed), FakeEmbedder())
    assert s.reloaded == 1 and s.embedded == 0 and calls == []
    urls = {r["chunk_index"]: r["url"] for r in store.rows if r["doc_id"] == "aaaaaaaaaaaa"}
    assert urls == {1: "https://novo.hr", 2: "https://example.hr/aaaaaaaaaaaa"}


def test_fewer_chunks_reload_drops_tail():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    s, _ = _sync(store, _docs([BASE[0], BASE[2]]), FakeEmbedder())
    assert s.reloaded == 1
    assert [r["chunk_index"] for r in store.rows if r["doc_id"] == "aaaaaaaaaaaa"] == [1]


def test_doc_missing_from_file_is_pruned():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    s, calls = _sync(store, _docs(BASE[:2]), FakeEmbedder())
    assert (s.pruned, s.skipped) == (1, 1) and calls == []
    assert store.deleted == [["bbbbbbbbbbbb"]]
    assert {r["doc_id"] for r in store.rows} == {"aaaaaaaaaaaa"}


def test_plan_sync_buckets():
    f = {"a": frozenset({1}), "b": frozenset({2}), "c": frozenset({3})}
    c = {"a": frozenset({1}), "b": frozenset({9}), "z": frozenset({0})}
    p = P.plan_sync(f, c)
    assert (p.skip, p.reload, p.new, p.prune) == (["a"], ["b"], ["c"], ["z"])


def test_dry_run_writes_nothing_and_never_embeds():
    store = FakeStore()
    s, calls = _sync(store, _docs(BASE), FakeEmbedder(), dry_run=True)
    assert s.new == 2 and s.embedded == 3 and s.chunks_inserted == 3
    assert calls == [] and store.rows == [] and store.inserts == 0


def test_embedder_down_defers_but_still_prunes():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    changed = [_rec("aaaaaaaaaaaa", 1, "Potpuno novi tekst."), BASE[1]]  # b nestao
    s, _ = _sync(store, _docs(changed), None)
    assert s.deferred == 1 and s.errors == 0 and s.pruned == 1
    # Stari redovi dokumenta ostaju dok embed ne uspije.
    assert len([r for r in store.rows if r["doc_id"] == "aaaaaaaaaaaa"]) == 2
    assert store.deleted == [["bbbbbbbbbbbb"]]


def test_embed_failure_keeps_old_rows_and_counts_error():
    store = FakeStore()
    _sync(store, _docs(BASE), FakeEmbedder())
    changed = [_rec("aaaaaaaaaaaa", 1, "Novi."), BASE[1], BASE[2]]
    s, _ = _sync(store, _docs(changed), FailingEmbedder())
    assert s.errors == 1 and s.reloaded == 0
    assert store.deleted == []
    assert len(store.rows) == 3


# ─────────── batch ─────────────────────────────────────────────


def test_batches_never_exceed_eight():
    recs = [_rec("cccccccccccc", i, f"Odjeljak broj {i}.") for i in range(1, 21)]
    emb = FakeEmbedder()
    s, _ = _sync(FakeStore(), _docs(recs), emb, batch_size=64)
    assert [len(b) for b in emb.batches] == [8, 8, 4]
    assert s.embedded == 20 and s.chunks_inserted == 20


def test_custom_small_batch_and_dedup_of_identical_texts():
    recs = [_rec("dddddddddddd", i, "Isti tekst." if i <= 3 else f"Tekst {i}.") for i in range(1, 6)]
    emb = FakeEmbedder()
    s, _ = _sync(FakeStore(), _docs(recs), emb, batch_size=2)
    assert [len(b) for b in emb.batches] == [2, 1]
    assert s.embedded == 3 and s.chunks_inserted == 5


def test_clamp_batch_size():
    assert P.clamp_batch_size(0) == 1
    assert P.clamp_batch_size(4) == 4
    assert P.clamp_batch_size(100) == P.MAX_BATCH_SIZE == 8


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
