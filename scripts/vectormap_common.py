#!/usr/bin/env python3
"""Zajednički dijelovi generatora vektorskih mapa (mapa isječaka + mapa osoba).

Uvozi ga `emit_vector_map.py` (točke = chunkovi) i `emit_person_map.py`
(točke = osobe). Oba se pokreću ISKLJUČIVO iz svojih sync-* skripti, unutar
`.venv-vectormap` (numpy + umap-learn) — numpy je jedina teška ovisnost ovdje,
sve ostalo je stdlib.

Sadrži ono što je za obje mape doslovno isto:
  quantize()       float koordinate → uint16 [0,65535], očuvan aspect ratio
  find_clusters()  HDBSCAN nad 2D layoutom
  name_clusters()  LLM imenovanje u batchevima (Vertex → gemini CLI fallback)
  inherit_labels() nasljeđivanje imena iz prethodnog snapshota po preklapanju

NE sadrži ništa o tome ŠTO je točka — to ostaje u pozivateljima.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.request
from typing import Callable, Sequence

import numpy as np

Log = Callable[[str], None]


def make_log(prefix: str) -> Log:
    def log(msg: str) -> None:
        sys.stderr.write(f"[{prefix}] {msg}\n")
    return log


_default_log = make_log("vectormap")


# ── Geometrija ───────────────────────────────────────────────────────────────


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


def find_clusters(xy: np.ndarray, mcs: int, log: Log = _default_log) -> np.ndarray:
    """HDBSCAN nad 2D layoutom (standard: datamapplot/Nomic). -1 = šum.

    `leaf` selekcija namjerno: `eom` na UMAP layoutu kolapsira sve u 1-2
    megaklastera (izmjereno na 136k točaka: eom=2, leaf=60 klastera). Visok
    udio šuma je OK — klasteri služe samo kao SIDRA za labele, šum-točke se
    normalno crtaju."""
    from sklearn.cluster import HDBSCAN  # sklearn je već dep umap-learna

    lab = HDBSCAN(min_cluster_size=mcs, cluster_selection_method="leaf").fit_predict(xy)
    k = int(lab.max()) + 1
    log(f"HDBSCAN: {k} klastera (min_cluster_size={mcs}, šum: {int((lab < 0).sum())} točaka)")
    return lab


# ── LLM imenovanje ───────────────────────────────────────────────────────────


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


def name_clusters(
    payloads: Sequence[str],
    intro: str,
    batch: int = 60,
    log: Log = _default_log,
) -> list[str] | None:
    """LLM imenovanje u BATCHEVIMA (na 240 odjednom model gubi brojanje — vraćao
    196/240 labela). Failani batch → prazne labele (caller ih naslijedi iz
    prethodnog snapshota); None samo ako NIŠTA nije imenovano.

    `payloads[i]` = tekstualni opis klastera i (naslovi epizoda, imena osoba…).
    `intro` = zadatak za model; iza njega ide numerirani popis i JSON envelope.
    """
    out: list[str] = []
    for s in range(0, len(payloads), batch):
        chunk = payloads[s : s + batch]
        labels = _name_batch(chunk, intro, log)
        out += labels if labels else [""] * len(chunk)
    return out if any(out) else None


def _name_batch(payloads: Sequence[str], intro: str, log: Log) -> list[str] | None:
    """Jedan LLM poziv. Backend: Vertex (default) s fallbackom na gemini CLI;
    GEMINI_BACKEND=cli forsira CLI."""
    numbered = "\n".join(f"{i}: {p}" for i, p in enumerate(payloads))
    prompt = (
        f"{intro}\n\n"
        f"{numbered}\n\n"
        'Odgovori ISKLJUČIVO JSON objektom: {"labels": ["naziv za 0", "naziv za 1", ...]} '
        f"s točno {len(payloads)} elemenata, istim redom."
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
            if not isinstance(labels, list) or len(labels) != len(payloads):
                raise ValueError(f"očekivano {len(payloads)} labela, dobiveno {len(labels)}")
            log(f"imenovanje preko {name} OK")
            return [str(x).strip() for x in labels]
        except Exception as e:  # noqa: BLE001
            log(f"WARN: {name} imenovanje palo ({e})")
    log("WARN: nijedan LLM backend nije uspio — clusters se izostavljaju")
    return None


def inherit_labels(
    labels: list[str],
    members: Sequence[Sequence[str]],
    prev: Sequence[dict],
    key: str,
    min_overlap: int = 3,
    log: Log = _default_log,
) -> int:
    """Popuni prazne labele iz prethodnog snapshota po preklapanju članova.

    UMAP se između runova može rotirati/zrcaliti, pa koordinate nisu ključ —
    ali "tko je u klasteru" jest. `members[i]` = otisak klastera i (npr. top
    epizode ili top slugovi), `prev` = klasteri prethodnog snapshota, `key` =
    ime polja u njima koje nosi isti otisak. Vraća broj naslijeđenih labela.
    """
    named = [pc for pc in prev if pc.get("label")]
    if not named or all(labels):
        return 0
    inherited = 0
    for i, label in enumerate(labels):
        if label:
            continue
        mine = set(members[i])
        best, best_ov = "", min_overlap - 1
        for pc in named:
            ov = len(mine & set(pc.get(key, [])))
            if ov > best_ov:
                best, best_ov = pc["label"], ov
        if best:
            labels[i] = best
            inherited += 1
    if inherited:
        log(f"{inherited} labela naslijeđeno iz prethodnog snapshota")
    return inherited
