#!/usr/bin/env python3
"""Mapa osoba — UMAP 2D projekcija "embeddinga osobe" za stats.domovina.ai/people.

Analogon emit_vector_map.py, ali točka je OSOBA, ne isječak. Pokreće se
ISKLJUČIVO iz scripts/sync-person-map.sh, unutar .venv-vectormap (numpy +
umap-learn). Ulazi su pripremljeni fajlovi (docker exec izvoz iz lokalnog CH+PG),
pa skripta nema DB ovisnosti. Plan: docs/plans/2026-08-01-mapa-osoba.md.

Embedding osobe = HIBRIDNI TEŽINSKI CENTROID, pa mean-centriranje:

    v = Σ nᵢ·cᵢ / Σ nᵢ        zatim   v ← normalize(v − v̄)

  govor:   cᵢ = centroid chunkova gdje osoba GOVORI u epizodi i
  spomen:  cᵢ = centroid CIJELE epizode i (spomen nema vlastiti tekst)

Centriranje NIJE kozmetika: sirovi centroidi imaju srednji međusobni kosinus
0,84–0,90 jer se svi razgovori vuku prema prosjeku korpusa. Tek nakon oduzimanja
prosjeka susjedstva postaju diskriminativna (Plenković → Milanović/Sanader/Vučić
umjesto "sve na 0,99").

PRAG (--min-episodes, default 3) je podatkovno određen, ne kozmetički: osoba
spomenuta u jednoj epizodi ima profil koji je doslovno centroid te epizode. Bez
praga 65 % osoba dijeli identičan vektor s nekim drugim (18 252 osobe → 8 255
različitih pozicija) i UMAP odustaje od spektralne inicijalizacije. Pri ≥3
epizode degeneriranih je 0,1 %.

Ulazi (TSV, bez headera):
  --episodes          youtube_id \t channel \t n_chunkova \t vec (1024 zareza)
  --speaker-centroids raw_speaker_token \t youtube_id \t n_chunkova \t vec
  --mentions          slug \t youtube_id \t channel \t person_name
  --speakers          slug \t canonical_name          (PG person hub, display ime)

Izlazi (u --out-dir, consumer je domovina-stats frontend /people.html):
  person-map.json        {schema_version, generated_at, source, persons,
                          min_episodes, source_slugs, source_rows,
                          clusters: [{label, x, y, n, top}…],
                          people: [[slug, ime, x, y, eps, eps_govori,
                                    kanala, cluster, co]…]}
  person-map-dupes.json  kandidati za ručni merge (sidecar, NE deploya se) —
                         jednočlani slug koji je token višečlanog I blizak mu je
                         u embedding prostoru. Ulaz za speaker_aliases.csv.
                         Skripta NIKAD ne mergea sama: krivi merge spaja dvije
                         stvarne osobe, što je gore od podjele.
"""

from __future__ import annotations

import argparse
import collections
import itertools
import json
import sys
from pathlib import Path

import numpy as np

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(REPO / "services" / "etl"))

from vectormap_common import (  # noqa: E402
    find_clusters,
    inherit_labels,
    make_log,
    name_clusters,
    quantize,
)
from etl.speakers import _load_seed, is_person_token, slugify  # noqa: E402

EMB_DIM = 1024
log = make_log("emit_person_map")

# Epizoda s previše sudionika nije stvarna ko-pojava nego popis (npr. pregled
# godine sa 96 imena) — klika bi joj bila 4560 bridova samog šuma.
MAX_CLIQUE = 60
CO_TOP = 8          # koliko susjeda po osobi ide u snapshot
DUPE_COS = 0.90     # prag za kandidata za merge (mjereno: 17 parova pri ≥3)


def _naming_intro() -> str:
    """Zadatak za LLM; vectormap_common lijepi numerirani popis + JSON envelope."""
    return (
        "Dolje su skupine osoba koje se u hrvatskim podcastima pojavljuju u sličnim "
        "temama; za svaku su navedeni najistaknutiji članovi. Za SVAKU skupinu vrati "
        "kratak naziv PODRUČJA na hrvatskom (razina detalja: \"Hrvatska politika\", "
        "\"Pape i sveci\", \"Sportske legende\", \"Kripto i financije\", "
        "\"Biblijski likovi\") — 1-3 riječi, imenska fraza, bez navodnika i "
        "interpunkcije. Nazivi neka budu međusobno što raznolikiji."
    )


def _read_tsv(path: Path):
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.rstrip("\n")
            if line:
                yield line.split("\t")


def load_centroids(path: Path, key_cols: int):
    """TSV s vektorom u zadnjem stupcu → (keys, n_chunkova, vec float32[N,1024])."""
    keys: list[tuple[str, ...]] = []
    ns: list[int] = []
    vecs: list[np.ndarray] = []
    for p in _read_tsv(path):
        if len(p) < key_cols + 2:
            continue
        v = np.fromstring(p[key_cols + 1], sep=",", dtype=np.float64)
        if v.size != EMB_DIM:
            raise SystemExit(f"{path.name}: vektor dim={v.size}, očekivano {EMB_DIM}")
        keys.append(tuple(p[:key_cols]))
        ns.append(int(p[key_cols]) if p[key_cols].isdigit() else 1)
        vecs.append(v)
    if not vecs:
        raise SystemExit(f"{path.name}: prazan izvoz")
    return keys, np.asarray(ns, dtype=np.float64), np.asarray(vecs, dtype=np.float32)


def normalize(v: np.ndarray) -> np.ndarray:
    n = np.linalg.norm(v, axis=-1, keepdims=True)
    n[n == 0] = 1.0
    return v / n


def main() -> int:  # noqa: PLR0915 — jedan linearan pipeline, dijeljenje bi ga zamaglilo
    ap = argparse.ArgumentParser()
    ap.add_argument("--episodes", required=True, type=Path)
    ap.add_argument("--speaker-centroids", required=True, type=Path)
    ap.add_argument("--mentions", required=True, type=Path)
    ap.add_argument("--speakers", required=True, type=Path)
    ap.add_argument("--out-dir", required=True, type=Path)
    ap.add_argument("--generated-at", required=True)
    ap.add_argument("--source", required=True, choices=["cloud", "local"])
    ap.add_argument("--source-rows", required=True, type=int,
                    help="chunkova + spomena u izvoru (za skip-if-unchanged)")
    ap.add_argument("--min-episodes", type=int, default=3)
    args = ap.parse_args()

    # ── 1. Ulazi ─────────────────────────────────────────────────────────────
    ep_keys, ep_n, ep_vec = load_centroids(args.episodes, 2)
    ep_row = {k[0]: i for i, k in enumerate(ep_keys)}
    ep_chan = {k[0]: k[1] for k in ep_keys}
    log(f"{len(ep_keys)} epizoda × {EMB_DIM}d")

    sp_keys, sp_n, sp_vec = load_centroids(args.speaker_centroids, 2)
    log(f"{len(sp_keys)} (epizoda, govornik) centroida")

    display: dict[str, str] = {}
    for p in _read_tsv(args.speakers):
        if len(p) >= 2 and p[0]:
            display[p[0]] = p[1]
    log(f"{len(display)} imena iz person huba (speakers)")

    # Seed merge-evi vrijede i ovdje — inače bi mapa imala slug koji person hub
    # više nema, pa bi klik vodio na 404.
    seed = _load_seed(REPO / "infra" / "postgres" / "seeds" / "speaker_aliases.csv")
    canon = lambda s: seed.get(s, s)  # noqa: E731

    # ── 2. Skupovi epizoda po osobi (govor + spomen) ─────────────────────────
    speak_eps: dict[str, set[str]] = collections.defaultdict(set)
    all_eps: dict[str, set[str]] = collections.defaultdict(set)
    chans: dict[str, set[str]] = collections.defaultdict(set)
    ep_people: dict[str, set[str]] = collections.defaultdict(set)

    sp_slug: list[str | None] = []
    for tok, yid in sp_keys:
        if not is_person_token(tok) or yid not in ep_row:
            sp_slug.append(None)
            continue
        s = canon(slugify(tok))
        sp_slug.append(s)
        speak_eps[s].add(yid)
        all_eps[s].add(yid)
        chans[s].add(ep_chan.get(yid, "?"))
        ep_people[yid].add(s)

    ment_rows: list[tuple[str, str]] = []
    ment_name: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    for p in _read_tsv(args.mentions):
        if len(p) < 2 or not p[0] or p[1] not in ep_row:
            continue
        s = canon(p[0])
        ment_rows.append((s, p[1]))
        all_eps[s].add(p[1])
        chans[s].add(ep_chan.get(p[1], "?"))
        ep_people[p[1]].add(s)
        if len(p) > 3 and p[3]:
            ment_name[s][p[3]] += 1

    universe = sorted(all_eps)
    log(f"univerzum: {len(universe)} osoba "
        f"(govore {len(speak_eps)}, spominju se {len(set(s for s, _ in ment_rows))})")

    # ── 3. Prag ──────────────────────────────────────────────────────────────
    keep = [s for s in universe if len(all_eps[s]) >= args.min_episodes]
    if len(keep) < 50:
        raise SystemExit(f"samo {len(keep)} osoba iznad praga {args.min_episodes} — odustajem")
    row = {s: i for i, s in enumerate(keep)}
    log(f"iznad praga ≥{args.min_episodes} epizoda: {len(keep)} osoba")

    # ── 4. Hibridni težinski centroid ────────────────────────────────────────
    acc = np.zeros((len(keep), EMB_DIM), dtype=np.float64)
    wsum = np.zeros(len(keep), dtype=np.float64)
    for i, s in enumerate(sp_slug):
        if s is None or s not in row:
            continue
        r = row[s]
        acc[r] += sp_vec[i] * sp_n[i]
        wsum[r] += sp_n[i]
    for s, yid in ment_rows:
        if s not in row:
            continue
        j = ep_row[yid]
        r = row[s]
        acc[r] += ep_vec[j] * ep_n[j]
        wsum[r] += ep_n[j]

    if not wsum.all():  # nemoguće po konstrukciji, ali dijeljenje nulom je tiho
        raise SystemExit("osoba bez ijednog chunka je prošla prag — ulazi su nekonzistentni")
    V = (acc / wsum[:, None]).astype(np.float32)
    X = normalize(V - V.mean(axis=0))
    log("centroidi izračunati i mean-centrirani")

    # ── 5. UMAP 2D ───────────────────────────────────────────────────────────
    # random_state=42 (za razliku od mape isječaka): layout je time STABILAN
    # između dnevnih runova, pa se korisnik sutra ne vraća na presloženu mapu.
    # Cijena je jednodretvenost, ali pri ~2,5k točaka je to ionako <10 s.
    import umap  # import tek sad — arg/input greške ne čekaju numba JIT

    log(f"UMAP 2D fit_transform kreće ({len(keep)} osoba, cosine)...")
    xy = np.asarray(umap.UMAP(
        n_components=2, n_neighbors=15, min_dist=0.1, metric="cosine",
        random_state=42, verbose=True,
    ).fit_transform(X), dtype=np.float64)
    q = quantize(xy)

    # ── 6. Klasteri + imena ──────────────────────────────────────────────────
    prev_path = args.out_dir / "person-map.json"
    prev_clusters: list[dict] = []
    if prev_path.exists():
        try:
            prev_clusters = json.loads(prev_path.read_text(encoding="utf-8")).get("clusters", [])
        except Exception:  # noqa: BLE001
            pass

    def name_of(s: str) -> str:
        if s in display:
            return display[s]
        if ment_name[s]:
            return ment_name[s].most_common(1)[0][0]
        return s.replace("-", " ").title()

    eps_count = {s: len(all_eps[s]) for s in keep}
    clab = find_clusters(xy, max(8, len(keep) // 200), log)
    k = int(clab.max()) + 1
    clusters: list[dict] = []
    cluster_of = np.full(len(keep), -1, dtype=np.int32)
    if k:
        order = np.argsort([-(clab == c).sum() for c in range(k)])
        tops: list[list[str]] = []
        for c in order:
            members = np.where(clab == c)[0]
            members = members[np.argsort([-eps_count[keep[i]] for i in members])]
            tops.append([keep[i] for i in members[:10]])
        payloads = [" · ".join(name_of(s) for s in t) for t in tops]
        labels = name_clusters(payloads, _naming_intro(), log=log) or [""] * len(tops)
        inherit_labels(labels, tops, prev_clusters, "top", log=log)
        for ci, c in enumerate(order):
            m = clab == c
            cluster_of[m] = ci
            clusters.append({
                "label": labels[ci],
                "x": int(np.median(q[m, 0])), "y": int(np.median(q[m, 1])),
                "n": int(m.sum()),
                "top": tops[ci],
            })
        named = sum(1 for c in clusters if c["label"])
        log(f"{len(clusters)} klastera ({named} imenovano)")

    # ── 7. Ko-pojavljivanje (top susjedi po broju zajedničkih epizoda) ───────
    co: dict[str, collections.Counter] = collections.defaultdict(collections.Counter)
    skipped = 0
    for yid, ppl in ep_people.items():
        ps = sorted(p for p in ppl if p in row)
        if len(ps) > MAX_CLIQUE:
            skipped += 1
            continue
        for a, b in itertools.combinations(ps, 2):
            co[a][b] += 1
            co[b][a] += 1
    log(f"ko-pojavljivanje: {sum(len(v) for v in co.values()) // 2} parova"
        f"{f' ({skipped} epizoda preskočeno, >{MAX_CLIQUE} sudionika)' if skipped else ''}")

    # ── 8. Snapshot ──────────────────────────────────────────────────────────
    people = [
        [s, name_of(s), int(q[i, 0]), int(q[i, 1]),
         len(all_eps[s]), len(speak_eps.get(s, ())), len(chans[s]),
         int(cluster_of[i]),
         [[o, n] for o, n in co[s].most_common(CO_TOP)]]
        for i, s in enumerate(keep)
    ]
    args.out_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "schema_version": 1,
        "generated_at": args.generated_at,
        "source": args.source,
        "persons": len(people),
        "min_episodes": args.min_episodes,
        "source_slugs": len(universe),
        "source_rows": args.source_rows,
        "clusters": clusters,
        "people": people,
    }
    out = args.out_dir / "person-map.json"
    out.write_text(json.dumps(meta, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")

    # ── 9. Sidecar: kandidati za ručni merge ─────────────────────────────────
    # "Plenković" i "Andrej Plenković" su na mapi dvije susjedne točke s dvije
    # labele. Ovdje se SAMO prijavljuju; odluku donosi čovjek i upisuje je u
    # infra/postgres/seeds/speaker_aliases.csv. Lista sadrži i zamke
    # ("Pavao" ~ "Ivan Pavao II.") pa automatski merge nije opcija.
    tokens: dict[str, list[str]] = collections.defaultdict(list)
    for s in keep:
        if "-" in s:
            for t in s.split("-"):
                tokens[t].append(s)
    dupes = []
    for s in keep:
        if "-" in s or s not in tokens:
            continue
        i = row[s]
        for other in tokens[s]:
            j = row[other]
            cos = float(X[i] @ X[j])
            if cos >= DUPE_COS:
                dupes.append({
                    "cos": round(cos, 3),
                    "a": s, "a_name": name_of(s), "a_episodes": eps_count[s],
                    "b": other, "b_name": name_of(other), "b_episodes": eps_count[other],
                })
    dupes.sort(key=lambda d: -d["cos"])
    (args.out_dir / "person-map-dupes.json").write_text(
        json.dumps(dupes, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")

    log(f"✅ {out.name} ({out.stat().st_size / 1000:.0f} kB) — {len(people)} osoba "
        f"od {len(universe)}, {len(clusters)} klastera, {len(dupes)} kandidata za merge")
    return 0


if __name__ == "__main__":
    sys.exit(main())
