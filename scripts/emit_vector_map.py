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
import os
import subprocess
import sys
import urllib.request
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


def quantize(x: np.ndarray) -> np.ndarray:
    """Float koordinate (bilo koje dim.) → uint16 [0,65535], očuvan aspect ratio,
    kraće osi centrirane da oblak ne "visi" u kutu."""
    mins = x.min(axis=0)
    span = float(max(x.max(axis=0) - mins))
    span = span or 1.0
    q = np.clip((x - mins) / span * 65535.0, 0, 65535)
    for ax in range(x.shape[1]):
        q[:, ax] += (65535 - q[:, ax].max()) / 2
    return q.round().astype(np.uint16)


def find_clusters(xy: np.ndarray, n: int) -> np.ndarray:
    """HDBSCAN nad 2D layoutom (standard: datamapplot/Nomic). -1 = šum.

    `leaf` selekcija namjerno: `eom` na UMAP layoutu kolapsira sve u 1-2
    megaklastera (izmjereno na 136k točaka: eom=2, leaf=60 klastera). Visok
    udio šuma (~60%) je OK — klasteri služe samo kao SIDRA za labele tema,
    šum-točke se normalno crtaju."""
    from sklearn.cluster import HDBSCAN  # sklearn je već dep umap-learna

    mcs = max(150, n // 600)
    lab = HDBSCAN(min_cluster_size=mcs, cluster_selection_method="leaf").fit_predict(xy)
    k = int(lab.max()) + 1
    log(f"HDBSCAN: {k} klastera (min_cluster_size={mcs}, šum: {int((lab < 0).sum())} točaka)")
    return lab


def _gemini_vertex(prompt: str) -> str:
    """Vertex AI REST (isti endpoint/auth kao producer summarize_gemini.js)."""
    project = os.environ["VERTEX_PROJECT"]
    location = os.environ.get("VERTEX_LOCATION", "global")
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    acct = os.environ.get("VERTEX_ACCOUNT")
    cmd = ["gcloud", "auth", "print-access-token"] + ([f"--account={acct}"] if acct else [])
    token = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True).stdout.strip()
    host = "aiplatform.googleapis.com" if location == "global" else f"{location}-aiplatform.googleapis.com"
    url = (
        f"https://{host}/v1/projects/{project}/locations/{location}"
        f"/publishers/google/models/{model}:generateContent"
    )
    body = {
        "contents": [{"role": "user", "parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.2, "responseMimeType": "application/json"},
    }
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
    )
    with urllib.request.urlopen(req, timeout=120) as resp:
        data = json.load(resp)
    return data["candidates"][0]["content"]["parts"][0]["text"]


def _gemini_cli(prompt: str) -> str:
    """gemini CLI fallback (isti pattern kao producerov callGeminiCli) — radi
    kad je Vertex billing ugašen (BILLING_DISABLED na domovina-sync-ms)."""
    model = os.environ.get("GEMINI_MODEL", "gemini-2.5-flash")
    res = subprocess.run(
        ["gemini", "-m", model, "-o", "text", "--skip-trust",
         "-p", "Slijedi upute iz inputa. Vrati ISKLJUČIVO valjan JSON, bez markdown code blokova."],
        input=prompt, capture_output=True, text=True, timeout=300, check=True,
    )
    return res.stdout


def name_clusters(title_lists: list[list[str]]) -> list[str] | None:
    """LLM imenovanje: po klasteru lista naslova → 1-3 riječi HR tema. Backend:
    Vertex (default) s fallbackom na gemini CLI; GEMINI_BACKEND=cli forsira CLI.
    None ako oba puknu — caller tada izostavi clusters iz meta."""
    numbered = "\n".join(
        f"{i}: " + " | ".join(t[:110] for t in titles) for i, titles in enumerate(title_lists)
    )
    prompt = (
        "Dolje su klasteri semantički sličnih isječaka hrvatskih podcasta; za svaki su "
        "navedeni najčešći naslovi epizoda. Za SVAKI klaster vrati kratak naziv teme na "
        "hrvatskom (1-3 riječi, imenska fraza, bez navodnika i interpunkcije; npr. "
        "\"Vjera i Crkva\", \"Rat u Ukrajini\", \"Domaća politika\"). Nazivi neka budu "
        "međusobno što raznolikiji.\n\n"
        f"{numbered}\n\n"
        'Odgovori ISKLJUČIVO JSON objektom: {"labels": ["naziv za 0", "naziv za 1", ...]} '
        f"s točno {len(title_lists)} elemenata, istim redom."
    )
    backends = [("gemini-cli", _gemini_cli)] if os.environ.get("GEMINI_BACKEND", "").lower() == "cli" \
        else [("vertex", _gemini_vertex), ("gemini-cli", _gemini_cli)]
    if not os.environ.get("VERTEX_PROJECT"):
        backends = [b for b in backends if b[0] != "vertex"]
    for name, fn in backends:
        try:
            text = fn(prompt).strip()
            text = text.removeprefix("```json").removeprefix("```").removesuffix("```").strip()
            labels = json.loads(text)["labels"]
            if not isinstance(labels, list) or len(labels) != len(title_lists):
                raise ValueError(f"očekivano {len(title_lists)} labela, dobiveno {len(labels)}")
            log(f"imenovanje preko {name} OK")
            return [str(x).strip() for x in labels]
        except Exception as e:  # noqa: BLE001
            log(f"WARN: {name} imenovanje palo ({e})")
    log("WARN: nijedan LLM backend nije uspio — clusters se izostavljaju")
    return None


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
    ep_col = np.fromiter((ep_idx[y] for y in yids), dtype=np.uint16, count=n)

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
    # Klasteri se emitiraju UVIJEK (i bez imena, label=""; frontend prazne
    # skipa). "eps" (top epizode po klasteru) je stabilan otisak sadržaja:
    # ako LLM nije dostupan (Vertex BILLING_DISABLED…), novi klasteri
    # NASLIJEDE labele iz prethodnog vector-map.json po preklapanju epizoda —
    # otporno na to što se UMAP layout rotira/flipa između runova.
    clab = find_clusters(xy, n)
    k = int(clab.max()) + 1
    clusters: list[dict] = []
    if k > 0:
        title_lists: list[list[str]] = []
        eps_lists: list[list[str]] = []
        order = np.argsort([-(clab == c).sum() for c in range(k)])[:60]  # cap 60 najvećih
        for c in order:
            m = clab == c
            eps, cnt = np.unique(ep_col[m], return_counts=True)
            top = eps[np.argsort(-cnt)][:12]
            title_lists.append([episodes[e][2] or episodes[e][0] for e in top])
            eps_lists.append([episodes[e][0] for e in top[:10]])
        labels = name_clusters(title_lists) or [""] * len(title_lists)

        # Nasljeđivanje iz prethodnog snapshota za neimenovane klastere.
        prev_path = args.out_dir / "vector-map.json"
        prev_clusters = []
        if prev_path.exists():
            try:
                prev_clusters = json.loads(prev_path.read_text(encoding="utf-8")).get("clusters", [])
            except Exception:  # noqa: BLE001
                pass
        inherited = 0
        if prev_clusters and not all(labels):
            for i, label in enumerate(labels):
                if label:
                    continue
                mine = set(eps_lists[i])
                best, best_ov = "", 2  # traži bar 3 zajedničke top-epizode
                for pc in prev_clusters:
                    ov = len(mine & set(pc.get("eps", [])))
                    if ov > best_ov and pc.get("label"):
                        best, best_ov = pc["label"], ov
                if best:
                    labels[i] = best
                    inherited += 1
        if inherited:
            log(f"{inherited} labela naslijeđeno iz prethodnog snapshota")

        for i, c in enumerate(order):
            m = clab == c
            clusters.append({
                "label": labels[i],
                "x": int(np.median(q[m, 0])), "y": int(np.median(q[m, 1])),
                "x3": int(np.median(q3[m, 0])), "y3": int(np.median(q3[m, 1])),
                "z3": int(np.median(q3[m, 2])),
                "n": int(m.sum()),
                "eps": eps_lists[i],
            })
        clusters.sort(key=lambda d: -d["n"])
        named = sum(1 for c in clusters if c["label"])
        log(f"{len(clusters)} klastera ({named} imenovano)")

        # Sidecar s naslovima po klasteru — za ručno/naknadno imenovanje i debug.
        # (clusters je sortiran po n DESC, a title_lists prati `order` — spoji preko eps otiska)
        by_eps = {tuple(e): t for e, t in zip(eps_lists, title_lists)}
        sidecar = [
            {"i": i, "label": c["label"], "n": c["n"], "titles": by_eps.get(tuple(c["eps"]), [])}
            for i, c in enumerate(clusters)
        ]
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
