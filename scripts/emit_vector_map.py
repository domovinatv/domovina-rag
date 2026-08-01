#!/usr/bin/env python3
"""Vector map — UMAP 2D projekcija chunk embeddinga za stats.domovina.ai.

Pokreće se ISKLJUČIVO iz scripts/sync-vector-map.sh, unutar dedicated venva
(.venv-vectormap: numpy + umap-learn) — jedna od dvije skripte u repou koje
NISU stdlib-only (druga je emit_person_map.py), jer UMAP nema stdlib zamjenu.
Ulazi su pripremljeni fajlovi (docker exec izvoz iz lokalnog CH/PG), pa skripta
nema DB ovisnosti. Zajedničko s mapom osoba (kvantizacija, HDBSCAN, LLM
imenovanje, nasljeđivanje labela) živi u scripts/vectormap_common.py.

Ulazi:
  --raw       RowBinary izvoz iz CH, FIKSNI record (4119 B):
              CAST(youtube_id AS FixedString(11))            11 B
              toUInt16(least(round(start_ts),65535))          2 B
              cityHash64(chunk_id)                            8 B
              embedding Array(Float32), uvijek dim=1024:
                varint duljine 1024 = b'\\x80\\x08'           2 B
                1024 × Float32                             4096 B
  --episodes  TSV: youtube_id \t channel \t upload_date (per-epizoda, iz CH)
  --titles    PG `COPY ... TO STDOUT` TSV: youtube_id \t title (escaped)

Izlazi (u --out-dir, consumer je domovina-stats frontend /map.html):
  vector-map.bin     N × 8 B little-endian: x u16, y u16, ep_idx u16, t_sec u16
                     (x/y kvantizirani na [0,65535] uz očuvan aspect ratio)
  vector-map-3d.bin  N × 6 B little-endian: x u16, y u16, z u16 — zaseban UMAP
                     3D fit, ISTI poredak točaka kao 2D bin (ep/t se ne ponavlja)
  vector-map.json    {schema_version, generated_at, source, points, source_rows,
                      channels: [ime… po chunkovima DESC],
                      episodes: [[youtube_id, channel_idx, title, date]…],
                      clusters: [{label, x, y, x3, y3, z3, n}…]}

Klasteri: HDBSCAN na 2D layoutu (datamapplot/Nomic pattern), imena preko Vertex
Gemini (naslovi epizoda klastera → 1-3 riječi HR tema; VERTEX_PROJECT/
VERTEX_LOCATION/GEMINI_MODEL iz env-a, token preko `gcloud auth
print-access-token`). Ako LLM nije dostupan, clusters se izostave (WARN) —
frontend graceful degradira na mapu bez labela.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
from vectormap_common import (  # noqa: E402
    find_clusters,
    inherit_labels,
    make_log,
    name_clusters,
    quantize,
)

EMB_DIM = 1024
REC = 11 + 2 + 8 + 2 + 4 * EMB_DIM  # 4119

log = make_log("emit_vector_map")


def _pg_unescape(s: str) -> str:
    # PG COPY TSV escape: \t \n \r \\ (titles realno nemaju druge)
    return (
        s.replace("\\t", "\t").replace("\\n", "\n").replace("\\r", "\r").replace("\\\\", "\\")
    )


def load_raw(path: Path):
    """RowBinary fiksni record → (youtube_ids, start_u16, emb float32[N,1024]), dedup po chunk hashu."""
    buf = np.fromfile(path, dtype=np.uint8)
    if buf.size % REC != 0:
        raise SystemExit(f"raw export nije fiksni record: {buf.size} % {REC} != 0 (embedding dim != {EMB_DIM}?)")
    n = buf.size // REC
    rows = buf.reshape(n, REC)
    yid = rows[:, :11].tobytes().decode("ascii", errors="replace")
    yids = [yid[i * 11 : (i + 1) * 11] for i in range(n)]
    start = rows[:, 11:13].copy().view(np.uint16).ravel()
    chash = rows[:, 13:21].copy().view(np.uint64).ravel()
    # sanity: varint prefiksa duljine mora biti 1024 u svim recordima
    if not (np.all(rows[:, 21] == 0x80) and np.all(rows[:, 22] == 0x08)):
        raise SystemExit("embedding varint prefix != 1024 — shema se promijenila, prilagodi REC")
    emb = rows[:, 23:].copy().view(np.float32).reshape(n, EMB_DIM)

    # Dedup (ReplacingMergeTree može imati ne-mergeane duplikate): zadnji zapis pobjeđuje.
    _, keep = np.unique(chash[::-1], return_index=True)
    keep = (n - 1) - keep  # indeksi u originalnom poretku, zadnja pojava
    keep.sort()
    if keep.size != n:
        log(f"dedup: {n - keep.size} dupliciranih chunkova preskočeno")
    yids = [yids[i] for i in keep]
    return yids, start[keep], emb[keep]


def _naming_intro(fine: bool) -> str:
    """Zadatak za LLM; iza njega vectormap_common lijepi numerirani popis + JSON envelope."""
    kind = (
        "što SPECIFIČNIJU podtemu (razina detalja: \"Krunica i pobožnosti\", "
        "\"Izbori u Zagrebu\", \"Rukometne legende\")"
        if fine else
        "kratak naziv GLAVNE teme (razina detalja: \"Vjera i Crkva\", \"Rat u Ukrajini\", "
        "\"Domaća politika\")"
    )
    return (
        "Dolje su klasteri semantički sličnih isječaka hrvatskih podcasta; za svaki su "
        f"navedeni najčešći naslovi epizoda. Za SVAKI klaster vrati {kind} na "
        "hrvatskom — 1-3 riječi, imenska fraza, bez navodnika i interpunkcije. "
        "Nazivi neka budu međusobno što raznolikiji."
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--episodes", required=True, type=Path)
    ap.add_argument("--titles", required=True, type=Path)
    ap.add_argument("--chapters", type=Path, help="TSV: youtube_id \\t t_sec \\t naslov chunka (Tema:/Naslov: prva linija)")
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--generated-at", required=True)
    ap.add_argument("--source", required=True, choices=["cloud", "local"])
    ap.add_argument("--source-rows", required=True, type=int, help="sirovi count() iz CH (za skip-if-unchanged)")
    args = ap.parse_args()

    yids, start, emb = load_raw(args.raw)
    n = emb.shape[0]
    log(f"{n} chunkova × {EMB_DIM}d učitano")

    # ── Episode meta (channel, date) + PG naslovi ─────────────────────────────
    ep_chan: dict[str, str] = {}
    ep_date: dict[str, str] = {}
    for line in args.episodes.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t")
        if len(parts) >= 3 and len(parts[0]) == 11:
            ep_chan[parts[0]] = parts[1]
            ep_date[parts[0]] = parts[2]

    titles: dict[str, str] = {}
    for line in args.titles.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t", 1)
        if len(parts) == 2 and len(parts[0]) == 11:
            titles[parts[0]] = _pg_unescape(parts[1])

    # Kanali po broju chunkova DESC → indeks 0 = najveći (frontend tako dodjeljuje boje).
    chan_chunks: dict[str, int] = {}
    for y in yids:
        c = ep_chan.get(y, "?")
        chan_chunks[c] = chan_chunks.get(c, 0) + 1
    channels = sorted(chan_chunks, key=lambda c: -chan_chunks[c])
    chan_idx = {c: i for i, c in enumerate(channels)}

    ep_order = sorted(set(yids))
    if len(ep_order) > 65535:
        raise SystemExit("preko 65535 epizoda — ep_idx ne stane u uint16, bump format")
    ep_idx = {y: i for i, y in enumerate(ep_order)}
    episodes = [
        [y, chan_idx.get(ep_chan.get(y, "?"), 0), titles.get(y, ""), ep_date.get(y, "")]
        for y in ep_order
    ]
    ep_col = np.fromiter((ep_idx[y] for y in yids), dtype=np.uint16, count=n)

    # ── Chapter shardovi (naslov isječka za tooltip/snackbar) ─────────────────
    # Per-chunk naslov ("Tema:"/"Naslov:" prva linija texta) je ~10 MB za cijeli
    # korpus — preskupo za jedan fetch, pa se sharda po ep_idx % 64 (~160 kB po
    # shardu); frontend lazy-fetcha shard tek na hover/tap i kešira ga.
    NSHARD = 64
    if args.chapters and args.chapters.exists():
        chap: dict[int, list[list]] = {}
        n_titles_ch = 0
        for line in args.chapters.read_text(encoding="utf-8").splitlines():
            parts = line.split("\t")
            if len(parts) < 3 or len(parts[0]) != 11 or parts[0] not in ep_idx:
                continue
            title = "\t".join(parts[2:]).strip()
            if not title:
                continue
            e = ep_idx[parts[0]]
            t = int(parts[1]) if parts[1].isdigit() else 0
            chap.setdefault(e, []).append([t, title[:90]])
            n_titles_ch += 1
        args.out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(NSHARD):
            shard = {str(e): sorted(lst) for e, lst in chap.items() if e % NSHARD == i}
            (args.out_dir / f"vector-map-chap-{i:02d}.json").write_text(
                json.dumps(shard, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        log(f"chapters: {n_titles_ch} naslova isječaka u {NSHARD} shardova")

    # ── UMAP 2D + 3D (najskuplji dio: ~2×2 min na M4; verbose u stderr/log) ───
    import umap  # import tek sad — arg/input greške ne čekaju numba JIT

    log("UMAP 2D fit_transform kreće (cosine, n_neighbors=15)...")
    xy = np.asarray(umap.UMAP(
        n_components=2, n_neighbors=15, min_dist=0.08, metric="cosine", verbose=True
    ).fit_transform(emb), dtype=np.float64)

    log("UMAP 3D fit_transform kreće...")
    xyz = np.asarray(umap.UMAP(
        n_components=3, n_neighbors=15, min_dist=0.08, metric="cosine", verbose=True
    ).fit_transform(emb), dtype=np.float64)

    q = quantize(xy)
    q3 = quantize(xyz)

    # ── Klasteri (na 2D layoutu) + LLM imena ─────────────────────────────────
    # DVIJE razine ("l"): 0 = glavne teme (grubi HDBSCAN), 1 = podteme (finiji) —
    # frontend fine labele otkriva tek na dubljem zoomu (progressive disclosure,
    # kao imena gradova/kvartova na karti). Klasteri se emitiraju UVIJEK (i bez
    # imena, label=""; frontend prazne skipa). "eps" (top epizode po klasteru) je
    # stabilan otisak sadržaja: ako LLM nije dostupan, novi klasteri NASLIJEDE
    # labele iz prethodnog vector-map.json po preklapanju epizoda (unutar iste
    # razine) — otporno na to što se UMAP layout rotira/flipa između runova.
    prev_path = args.out_dir / "vector-map.json"
    prev_clusters = []
    if prev_path.exists():
        try:
            prev_clusters = json.loads(prev_path.read_text(encoding="utf-8")).get("clusters", [])
        except Exception:  # noqa: BLE001
            pass

    clusters: list[dict] = []
    sidecar: list[dict] = []
    #        (mcs,               cap, n_titles, tchars, fine)
    LEVELS = [(max(150, n // 600), 60, 12, 110, False),
              (max(60, n // 2000), 240, 8, 90, True)]
    for lvl, (mcs, cap, n_titles, tchars, fine) in enumerate(LEVELS):
        clab = find_clusters(xy, mcs, log)
        k = int(clab.max()) + 1
        if k == 0:
            continue
        title_lists: list[list[str]] = []
        eps_lists: list[list[str]] = []
        order = np.argsort([-(clab == c).sum() for c in range(k)])[:cap]
        for c in order:
            m = clab == c
            eps, cnt = np.unique(ep_col[m], return_counts=True)
            top = eps[np.argsort(-cnt)][:n_titles]
            title_lists.append([episodes[e][2] or episodes[e][0] for e in top])
            eps_lists.append([episodes[e][0] for e in top[:10]])
        payloads = [" | ".join(t[:tchars] for t in titles) for titles in title_lists]
        labels = name_clusters(payloads, _naming_intro(fine), log=log) or [""] * len(title_lists)

        # Nasljeđivanje iz prethodnog snapshota (ista razina) za neimenovane.
        prev_lvl = [pc for pc in prev_clusters if pc.get("l", 0) == lvl]
        inherit_labels(labels, eps_lists, prev_lvl, "eps", log=make_log(f"emit_vector_map lvl{lvl}"))

        lvl_clusters = []
        for i, c in enumerate(order):
            m = clab == c
            lvl_clusters.append({
                "label": labels[i],
                "l": lvl,
                "x": int(np.median(q[m, 0])), "y": int(np.median(q[m, 1])),
                "x3": int(np.median(q3[m, 0])), "y3": int(np.median(q3[m, 1])),
                "z3": int(np.median(q3[m, 2])),
                "n": int(m.sum()),
                "eps": eps_lists[i],
            })
        lvl_clusters.sort(key=lambda d: -d["n"])
        named = sum(1 for c in lvl_clusters if c["label"])
        log(f"lvl{lvl}: {len(lvl_clusters)} klastera ({named} imenovano)")

        # Sidecar s naslovima po klasteru — za ručno/naknadno imenovanje i debug.
        by_eps = {tuple(e): t for e, t in zip(eps_lists, title_lists)}
        sidecar += [
            {"i": len(clusters) + i, "l": lvl, "label": c["label"], "n": c["n"],
             "titles": by_eps.get(tuple(c["eps"]), [])}
            for i, c in enumerate(lvl_clusters)
        ]
        clusters += lvl_clusters

    if sidecar:
        (args.out_dir / "vector-map-titles.json").write_text(
            json.dumps(sidecar, ensure_ascii=False, indent=1), encoding="utf-8")

    # ── Binarni outputi (little-endian) ───────────────────────────────────────
    out = np.empty((n, 4), dtype="<u2")
    out[:, 0] = q[:, 0]
    out[:, 1] = q[:, 1]
    out[:, 2] = ep_col
    out[:, 3] = start
    args.out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = args.out_dir / "vector-map.bin"
    out.tofile(bin_path)
    bin3_path = args.out_dir / "vector-map-3d.bin"
    q3.astype("<u2").tofile(bin3_path)

    meta = {
        "schema_version": 1,
        "generated_at": args.generated_at,
        "source": args.source,
        "points": n,
        "source_rows": args.source_rows,
        "channels": channels,
        "episodes": episodes,
        "clusters": clusters,
    }
    meta_path = args.out_dir / "vector-map.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    log(
        f"✅ {bin_path.name} ({bin_path.stat().st_size / 1e6:.1f} MB) + "
        f"{bin3_path.name} ({bin3_path.stat().st_size / 1e6:.1f} MB) + "
        f"{meta_path.name} ({meta_path.stat().st_size / 1e3:.0f} kB) — "
        f"{n} točaka, {len(episodes)} epizoda, {len(channels)} kanala, {len(clusters)} klastera"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
