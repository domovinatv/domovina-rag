#!/usr/bin/env python3
"""Vector map — UMAP 2D projekcija chunk embeddinga za stats.domovina.ai.

Pokreće se ISKLJUČIVO iz scripts/sync-vector-map.sh, unutar dedicated venva
(.venv-vectormap: numpy + umap-learn) — jedina skripta u repou koja NIJE
stdlib-only, jer UMAP nema stdlib zamjenu. Ulazi su pripremljeni fajlovi
(docker exec izvoz iz lokalnog CH/PG), pa skripta nema DB ovisnosti.

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
  vector-map.bin   N × 8 B little-endian: x u16, y u16, ep_idx u16, t_sec u16
                   (x/y kvantizirani na [0,65535] uz očuvan aspect ratio)
  vector-map.json  {schema_version, generated_at, source, points, source_rows,
                    channels: [ime… po chunkovima DESC],
                    episodes: [[youtube_id, channel_idx, title, date]…]}
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

EMB_DIM = 1024
REC = 11 + 2 + 8 + 2 + 4 * EMB_DIM  # 4119


def log(msg: str) -> None:
    sys.stderr.write(f"[emit_vector_map] {msg}\n")


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


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True, type=Path)
    ap.add_argument("--episodes", required=True, type=Path)
    ap.add_argument("--titles", required=True, type=Path)
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

    # ── UMAP (najskuplji dio: ~min na M4; verbose ide u stderr/log) ───────────
    import umap  # import tek sad — arg/input greške ne čekaju numba JIT

    log("UMAP fit_transform kreće (cosine, n_neighbors=15)...")
    xy = umap.UMAP(
        n_components=2, n_neighbors=15, min_dist=0.08, metric="cosine", verbose=True
    ).fit_transform(emb)
    xy = np.asarray(xy, dtype=np.float64)

    # ── Kvantizacija na uint16 uz očuvan aspect ratio ─────────────────────────
    mins = xy.min(axis=0)
    span = float(max(xy.max(axis=0) - mins))
    span = span or 1.0
    q = np.clip((xy - mins) / span * 65535.0, 0, 65535)
    # centriraj kraću os da mapa ne "visi" u kutu
    for ax in (0, 1):
        pad = (65535 - q[:, ax].max()) / 2
        q[:, ax] += pad
    q = q.round().astype(np.uint16)

    # ── Binarni output: x, y, ep_idx, t_sec (little-endian) ──────────────────
    ep_col = np.fromiter((ep_idx[y] for y in yids), dtype=np.uint16, count=n)
    out = np.empty((n, 4), dtype="<u2")
    out[:, 0] = q[:, 0]
    out[:, 1] = q[:, 1]
    out[:, 2] = ep_col
    out[:, 3] = start
    args.out_dir.mkdir(parents=True, exist_ok=True)
    bin_path = args.out_dir / "vector-map.bin"
    out.tofile(bin_path)

    meta = {
        "schema_version": 1,
        "generated_at": args.generated_at,
        "source": args.source,
        "points": n,
        "source_rows": args.source_rows,
        "channels": channels,
        "episodes": episodes,
    }
    meta_path = args.out_dir / "vector-map.json"
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    log(
        f"✅ {bin_path.name} ({bin_path.stat().st_size / 1e6:.1f} MB, {n} točaka) + "
        f"{meta_path.name} ({meta_path.stat().st_size / 1e3:.0f} kB, "
        f"{len(episodes)} epizoda, {len(channels)} kanala)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
