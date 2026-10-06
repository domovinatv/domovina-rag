#!/usr/bin/env python3
"""
Inkrementalno puni Meili index `segments` (1 dokument = 1 SRT segment s imenom
govornika i točnom sekundom) iz producerovih `*.segments.jsonl` datoteka.

Ugovor izvora: ../fetch.domovina.tv/docs/data_contract.md §14.
Plan: docs/plans/2026-10-06-meili-segments-pretraga-transkripta.md.

Pun re-index (~1,4 M dokumenata) svaku noć nije opcija, pa se radi delta po
epizodi:
  - stanje živi u MALOM indexu `segments_state` u ISTOM Meiliju (1 dok po
    epizodi: SHA-256 datoteke). Lokalni i cloud Meili tako svaki imaju svoje
    stanje — nema lokalnog state fajla koji bi se razišao s cloudom.
  - epizoda se (re)indeksira kad joj se hash promijeni: brisanje po filteru
    `youtube_id` pa dodavanje (broj segmenata se može i smanjiti).
  - indeksira se SAMO ono što je u lokalnom ClickHouse korpusu (`rag_chunks`).
    Index je time derivat korpusa: što MCP ne vidi, ne vidi ni `segments`.
  - epizoda koje više nema u CH-u se briše. Epizoda kojoj samo fali datoteka
    (npr. disk nije montiran) se NE briše.

Env:
  MEILI_URL, MEILI_KEY          cilj (master key)
  SEGMENTS_SOURCE_DIRS          razmakom odvojeni direktoriji (traži se */*.segments.jsonl)
  CH_CONTAINER, CLICKHOUSE_*    lokalni CH (docker exec)
  MEILI_SEGMENTS_INDEX          default `segments`
  MAX_DELETE                    zaštita od masovnog brisanja (default 50)
"""
import glob
import hashlib
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

MEILI_URL = os.environ.get("MEILI_URL", "http://localhost:7700").rstrip("/")
MEILI_KEY = os.environ["MEILI_KEY"]
INDEX = os.environ.get("MEILI_SEGMENTS_INDEX", "segments")
STATE_INDEX = f"{INDEX}_state"
SOURCE_DIRS = os.environ.get("SEGMENTS_SOURCE_DIRS", "").split()
CH_CONTAINER = os.environ.get("CH_CONTAINER", "domovina-rag-infra-clickhouse-1")
CH_DB = os.environ.get("CLICKHOUSE_DB", "rag")
CH_USER = os.environ.get("CLICKHOUSE_USER", "rag_user")
CH_PASS = os.environ.get("CLICKHOUSE_PASSWORD", "")
MAX_DELETE = int(os.environ.get("MAX_DELETE", "50"))
# Dokumenti po zahtjevu. Svaki zahtjev se čeka do kraja prije sljedećeg: Meili
# inače spoji sve redom poslane add-taskove u jedan batch, a na prvom punjenju
# (1,4 M dokumenata) to bi na dijeljenom VPS-u podiglo RAM indeksiranja bez gornje
# granice. Izmjereno lokalno: 129 k dokumenata u batchu ≈ 0,66 GiB peak.
BATCH_DOCS = int(os.environ.get("SEGMENTS_BATCH_DOCS", "25000"))

SETTINGS = {
    # Samo `text`. Da je i `speaker` pretraživ, upit "Matij" bi pogodio i SVAKI
    # segment koji izgovara govornik imena "Matija" (19 pogodaka umjesto 2 na
    # 35Oq01CmGWE). Spomen i govor su različita pitanja: govor = filter `speaker`.
    "searchableAttributes": ["text"],
    # `seq`: MCP dohvaća susjedne segmente (kontekst ±1) search-only ključem, koji
    # ne smije zvati /documents — pa preko filtra `youtube_id = X AND seq IN [...]`.
    "filterableAttributes": ["youtube_id", "channel", "speaker", "upload_date", "seq"],
    "sortableAttributes": ["start_sec", "upload_date"],
    # byWord (default) je namjerno eksplicitan. byAttribute daje pola manji index,
    # ali fraza "za vrijeme rata" tada pogađa i segmente gdje riječi NISU jedna do
    # druge (12/19 lažnih na uzorku) — a doslovna fraza je glavni use-case.
    "proximityPrecision": "byWord",
    # Grupiranje po epizodi (facet youtube_id) bez youtube_id filtra.
    "faceting": {"maxValuesPerFacet": 500},
}


def log(msg: str) -> None:
    print(f"[segments {time.strftime('%H:%M:%S')}] {msg}", flush=True)


def meili(method: str, path: str, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode()
    req = urllib.request.Request(
        MEILI_URL + path, method=method, data=data,
        headers={"Authorization": f"Bearer {MEILI_KEY}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode(errors="replace")
        raise RuntimeError(f"Meili {method} {path} → HTTP {e.code}: {body[:500]}") from None


def wait_task(uid: int) -> None:
    while True:
        t = meili("GET", f"/tasks/{uid}")
        if t["status"] == "succeeded":
            return
        if t["status"] in ("failed", "canceled"):
            raise RuntimeError(f"Meili task {uid} {t['status']}: {t.get('error')}")
        time.sleep(0.5)


def ensure_index(uid: str) -> None:
    try:
        meili("GET", f"/indexes/{uid}")
    except RuntimeError as e:
        if "HTTP 404" not in str(e):
            raise
        wait_task(meili("POST", "/indexes", {"uid": uid, "primaryKey": "id"})["taskUid"])
        log(f"kreiran index '{uid}'")


def ch_youtube_ids() -> set[str]:
    out = subprocess.run(
        ["docker", "exec", CH_CONTAINER, "clickhouse-client", "-d", CH_DB,
         "--user", CH_USER, "--password", CH_PASS,
         "--query", "SELECT DISTINCT youtube_id FROM rag_chunks WHERE length(youtube_id) = 11"],
        capture_output=True, text=True,
    )
    if out.returncode != 0:
        sys.exit(f"CH upit pao: {out.stderr}")
    ids = {ln.strip() for ln in out.stdout.splitlines() if ln.strip()}
    if not ids:
        sys.exit("CH je vratio 0 epizoda — prekidam (inače bih obrisao cijeli index).")
    return ids


def discover_files() -> dict[str, tuple[str, str]]:
    """youtube_id → (putanja, sha256). youtube_id se čita iz prvog reda, ne iz imena."""
    found: dict[str, tuple[str, str]] = {}
    for d in SOURCE_DIRS:
        if not os.path.isdir(d):
            log(f"WARN: izvor ne postoji (disk nije montiran?): {d}")
            continue
        for path in glob.glob(os.path.join(d, "*", "*.segments.jsonl")):
            with open(path, "rb") as f:
                raw = f.read()
            if not raw.strip():
                continue
            yt = json.loads(raw.split(b"\n", 1)[0])["youtube_id"]
            found[yt] = (path, hashlib.sha256(raw).hexdigest())
    return found


def load_state() -> dict[str, str]:
    state, offset = {}, 0
    while True:
        r = meili("GET", f"/indexes/{STATE_INDEX}/documents?limit=1000&offset={offset}&fields=id,hash")
        for d in r["results"]:
            state[d["id"]] = d["hash"]
        offset += len(r["results"])
        if offset >= r["total"] or not r["results"]:
            return state


def delete_episodes(ids: list[str]) -> None:
    for i in range(0, len(ids), 200):
        part = ids[i:i + 200]
        flt = "youtube_id IN [" + ", ".join(f"'{y}'" for y in part) + "]"
        wait_task(meili("POST", f"/indexes/{INDEX}/documents/delete", {"filter": flt})["taskUid"])


def main() -> None:
    if not SOURCE_DIRS:
        sys.exit("SEGMENTS_SOURCE_DIRS nije postavljen.")
    ensure_index(INDEX)
    ensure_index(STATE_INDEX)
    # PATCH s istim vrijednostima ne re-indeksira; nakon promjene da.
    wait_task(meili("PATCH", f"/indexes/{INDEX}/settings", SETTINGS)["taskUid"])

    corpus = ch_youtube_ids()
    files = discover_files()
    state = load_state()

    eligible = {yt: v for yt, v in files.items() if yt in corpus}
    changed = sorted(yt for yt, (_, h) in eligible.items() if state.get(yt) != h)
    gone = sorted(yt for yt in state if yt not in corpus)
    missing = len(corpus) - len(eligible)
    log(f"korpus {len(corpus)} ep · datoteka {len(files)} (u korpusu {len(eligible)}) · "
        f"stanje {len(state)} · za indeksirati {len(changed)} · za obrisati {len(gone)} · "
        f"bez segments.jsonl {missing}")

    if gone:
        if len(gone) > MAX_DELETE:
            log(f"WARN: {len(gone)} epizoda za brisanje > MAX_DELETE={MAX_DELETE} — preskačem brisanje.")
        else:
            delete_episodes(gone)
            wait_task(meili("POST", f"/indexes/{STATE_INDEX}/documents/delete-batch", gone)["taskUid"])
            log(f"obrisano {len(gone)} epizoda")

    # Brisanje prije dodavanja samo za epizode koje već postoje u indexu.
    reindexed = [yt for yt in changed if yt in state]
    if reindexed:
        delete_episodes(reindexed)

    batch: list[dict] = []
    pending: list[str] = []  # epizode čiji su SVI dokumenti u batchu
    done_docs = 0

    def flush() -> None:
        nonlocal batch, pending, done_docs
        if batch:
            wait_task(meili("POST", f"/indexes/{INDEX}/documents", batch)["taskUid"])
            done_docs += len(batch)
        # Stanje tek nakon uspjeha — pad usred runa znači samo ponovni pokušaj sutra.
        if pending:
            now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            wait_task(meili("POST", f"/indexes/{STATE_INDEX}/documents", [
                {"id": yt, "hash": eligible[yt][1], "indexed_at": now} for yt in pending
            ])["taskUid"])
        batch, pending = [], []

    for n, yt in enumerate(changed, 1):
        with open(eligible[yt][0], encoding="utf-8") as f:
            batch.extend(json.loads(ln) for ln in f if ln.strip())
        pending.append(yt)
        if len(batch) >= BATCH_DOCS:
            flush()
            log(f"{n}/{len(changed)} epizoda, {done_docs} dokumenata")
    flush()

    stats = meili("GET", f"/indexes/{INDEX}/stats")
    log(f"✅ gotovo: indeksirano {len(changed)} epizoda ({done_docs} dok) · "
        f"index ukupno {stats['numberOfDocuments']} dokumenata")


if __name__ == "__main__":
    main()
