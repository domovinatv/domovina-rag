#!/usr/bin/env python3
"""
Napuni Meilisearch index `episodes` za frontend keyword tražilicu
(domovina.ai paleta + /search) iz ClickHouse-a i PG-a.

Dokument = SEKCIJA sažetka (jedan `article_summary` chunk), ne cijela epizoda.
`distinctAttribute: youtube_id` vraća jedan pogodak po epizodi — najbolju
sekciju. Razlog (evaluacija 14.10.2026., domovina.ai
docs/2026-10-13-pretraga-mali-gpu-i-pametni-search.md §5): dok je dokument bio
spojeni sažetak cijele epizode, uobičajene riječi upita uvijek su se našle
zajedno negdje u satu razgovora, pa je „kako se nositi s tugom nakon smrti
djeteta" vraćao epizode o odnosima i križnom putu. Unutar jedne sekcije
blizina riječi opet nešto znači, a isječak (`article_text` crop) je iz sekcije
koja je pogođena.

Polja zadržavaju imena koja klijent već čita (`title`, `section_titles`,
`article_text`, `channel`, `upload_date`, `deep_link`), pa stari build radi:
`section_titles` je sad lista s naslovom jedne sekcije, `article_text` tijelo
te sekcije. Nova polja: `speakers` (imena govornika epizode iz transkripta),
`channel_name` (ime kanala s CDN-a), `section_index`, `lead`.

Meili 1.11 facete i `estimatedTotalHits` broji po DOKUMENTU, ne po
`distinct` grupi — bez ograde bi chip „40 dana za život" pokazivao 1811
(sekcija) umjesto broja epizoda. Zato `lead: true` nosi točno jedna sekcija po
epizodi (prva), i facet upit filtrira `lead = true`. Broj pogodaka upita klijent
čita iz `totalHits` uz `page`/`hitsPerPage`, koji `distinct` poštuje.

Index se gradi u privremenom `<INDEX>__build` i atomski zamijeni sa živim
(`/swap-indexes`) — upsert u živi index ostavio bi stare po-epizoda dokumente
(drugi `id`) zauvijek, a brisanje pa punjenje ostavilo bi prazan index usred
noćnog synca. Search ključ je vezan uz IME indexa, pa zamjena ne dira ključeve.

Pokretanje (inače kroz scripts/sync-meili.sh):
  services/embedder/.venv/bin/python scripts/meili-poc-index.py

Env:
  CH_CONTAINER, PG_CONTAINER, CLICKHOUSE_*, POSTGRES_*
  MEILI_URL         http://localhost:7700
  MEILI_KEY         master key
  MEILI_INDEX       episodes
  CHANNELS_INDEX_URL  https://cdn.domovina.ai/channels/data/index.json
"""
import json
import os
import re
import subprocess
import sys
import time

import requests

CH_DB = os.environ.get("CLICKHOUSE_DB", "rag")
CH_USER = os.environ.get("CLICKHOUSE_USER", "rag_user")
CH_PASS = os.environ.get("CLICKHOUSE_PASSWORD", "")
CH_CONTAINER = os.environ.get("CH_CONTAINER", "domovina-rag-infra-clickhouse-1")
PG_CONTAINER = os.environ.get("PG_CONTAINER", "domovina-rag-infra-postgres-1")
PG_USER = os.environ.get("POSTGRES_USER", "rag_user")
PG_DB = os.environ.get("POSTGRES_DB", "rag")

MEILI_URL = os.environ.get("MEILI_URL", "http://localhost:7700")
MEILI_KEY = os.environ.get("MEILI_KEY", "poc_master_key_domovina_2026")
INDEX = os.environ.get("MEILI_INDEX", "episodes")
BUILD = f"{INDEX}__build"
CHANNELS_INDEX_URL = os.environ.get(
    "CHANNELS_INDEX_URL", "https://cdn.domovina.ai/channels/data/index.json")

# Funkcijske riječi. Ista lista kao `contentQuery` u domovina.ai
# (packages/podcast_core/lib/utils/text_search.dart) — klijent ih miče iz
# upita, ovdje ih Meili ne broji ni kad stignu (stari build, /search ekran).
STOP_WORDS = sorted({
    "a", "ali", "bi", "bio", "bila", "biti", "da", "do", "gdje", "i", "ili",
    "iz", "je", "jesu", "k", "ka", "kad", "kada", "kako", "koja", "koje",
    "kojeg", "koji", "li", "mi", "na", "ne", "ni", "o", "od", "po", "pri", "s",
    "sa", "sam", "se", "si", "smo", "ste", "su", "ta", "te", "ti", "tko", "to",
    "u", "uz", "vi", "za", "što", "šta", "zašto",
    # Meili normalizira dijakritike pa upit bez kvačica mora pasti na isto.
    "sto", "sta", "zasto",
})

SETTINGS = {
    # Redoslijed je težina (Meili ranking rule `attribute`): naslov epizode,
    # pa tko govori, pa naslov sekcije, pa tekst, pa kanal.
    "searchableAttributes": [
        "title", "speakers", "section_titles", "article_text", "channel_name",
    ],
    "displayedAttributes": [
        "id", "youtube_id", "title", "channel", "channel_name", "upload_date",
        "speakers", "section_titles", "section_index", "article_text",
        "deep_link",
    ],
    "distinctAttribute": "youtube_id",
    "filterableAttributes": ["channel", "upload_date", "youtube_id", "lead"],
    "sortableAttributes": ["upload_date"],
    "stopWords": STOP_WORDS,
}

# Oznake govornika koje nisu imena (diarizacija ih daje kad ne zna tko je).
_GENERIC_SPEAKER = re.compile(
    r"unknown|speaker|sugovorni|voditelj|glas|molitelj|svećenik|prolaznik|"
    r"publika|novinar|reporter|narator|pjevač|zbor|\(|\d",
    re.IGNORECASE)


def ch_query(sql: str) -> str:
    cmd = [
        "docker", "exec", CH_CONTAINER, "clickhouse-client",
        "-d", CH_DB, "--user", CH_USER, "--password", CH_PASS,
        "--query", sql,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"CH query failed: {out.stderr}")
    return out.stdout


def pg_query(sql: str) -> str:
    cmd = [
        "docker", "exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB,
        "-t", "-A", "-F", "\t", "-c", sql,
    ]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode != 0:
        sys.exit(f"PG query failed: {out.stderr}")
    return out.stdout


def is_person_name(name: str) -> bool:
    """„Damir Sabol", „fra Stjepan Brčina" — da; „Sugovornik 1", „Voditelj" — ne."""
    if not name or _GENERIC_SPEAKER.search(name):
        return False
    words = name.split()
    return len(words) >= 2 and any(w[:1].isupper() for w in words)


def split_summary(text: str) -> tuple[str, str]:
    """`Naslov: …\\n\\nSažetak: …` → (naslov, tijelo bez markdowna)."""
    title, body = "", text
    m = re.match(r"\s*Naslov:\s*(.*?)\n", text)
    if m:
        title = m.group(1).strip()
        body = text[m.end():]
    body = re.sub(r"^\s*Sažetak:\s*", "", body.strip())
    body = body.replace("**", "")
    return title, body.strip()


def channel_names() -> dict[str, str]:
    try:
        idx = requests.get(CHANNELS_INDEX_URL, timeout=30).json()
        return {c["id"]: c["name"] for c in idx.get("channels", [])}
    except Exception as e:  # ime kanala je ukras; bez njega index i dalje radi
        print(f"[meili] UPOZORENJE: imena kanala nedostupna ({e})")
        return {}


def build_docs() -> list[dict]:
    print("[meili] Dohvaćam sekcije (article_summary) iz CH-a...")
    sections = ch_query(f"""
        SELECT youtube_id, channel, toString(upload_date) AS upload_date,
               chunk_index, text
        FROM {CH_DB}.rag_chunks
        WHERE chunk_strategy = 'article_summary' AND length(youtube_id) = 11
        ORDER BY youtube_id, chunk_index
        FORMAT JSONEachRow
    """)

    print("[meili] Dohvaćam govornike (topic_transcript) iz CH-a...")
    speakers_raw = ch_query(f"""
        SELECT youtube_id, groupUniqArray(speaker) AS speakers
        FROM {CH_DB}.rag_chunks
        WHERE chunk_strategy = 'topic_transcript' AND speaker != ''
        GROUP BY youtube_id
        FORMAT JSONEachRow
    """)
    speakers: dict[str, list[str]] = {}
    for line in speakers_raw.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        names = {n.strip() for s in r["speakers"] for n in s.split(",")}
        speakers[r["youtube_id"]] = sorted(n for n in names if is_person_name(n))

    print("[meili] Dohvaćam naslove iz PG-a...")
    titles = {}
    for ln in pg_query("SELECT youtube_id, coalesce(title,'') FROM episodes").splitlines():
        if "\t" in ln:
            yt, title = ln.split("\t", 1)
            titles[yt.strip()] = title.strip()

    names = channel_names()

    docs = []
    seen: set[str] = set()
    for line in sections.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        yt = r["youtube_id"]
        section_title, body = split_summary(r["text"])
        lead = yt not in seen  # redovi stižu po (youtube_id, chunk_index)
        seen.add(yt)
        docs.append({
            # Meili id: [a-zA-Z0-9_-]; YouTube ID to već jest.
            "id": f"{yt}_{r['chunk_index']}",
            "youtube_id": yt,
            "title": titles.get(yt, ""),
            "channel": r["channel"],
            "channel_name": names.get(r["channel"], ""),
            "upload_date": r["upload_date"],
            "speakers": speakers.get(yt, []),
            "section_index": r["chunk_index"],
            "lead": lead,
            "section_titles": [section_title] if section_title else [],
            "article_text": body,
            "deep_link": f"https://domovina.ai/v/{yt}",
        })
    episodes = len({d["youtube_id"] for d in docs})
    print(f"[meili] {len(docs)} sekcija iz {episodes} epizoda; "
          f"{sum(1 for d in docs if d['title'])} s naslovom, "
          f"{len(speakers)} epizoda s govornicima.")
    return docs


def wait_task(sess: requests.Session, task_uid: int, timeout_s: int = 1800,
              ok_codes: tuple[str, ...] = ()) -> dict:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        t = sess.get(f"{MEILI_URL}/tasks/{task_uid}", timeout=30).json()
        if t["status"] in ("succeeded", "failed", "canceled"):
            if t["status"] != "succeeded" and (t.get("error") or {}).get("code") not in ok_codes:
                sys.exit(f"[meili] Task {task_uid} {t['status']}: {t.get('error')}")
            return t
        time.sleep(1)
    sys.exit(f"[meili] Task {task_uid} nije gotov nakon {timeout_s} s")


def drop_index(sess: requests.Session, uid: str) -> None:
    """Obriši index; nepostojeći nije greška (Meili to javlja tek u tasku)."""
    r = sess.delete(f"{MEILI_URL}/indexes/{uid}", timeout=30)
    if r.status_code == 202:
        wait_task(sess, r.json()["taskUid"], ok_codes=("index_not_found",))


def ensure_index(sess: requests.Session, uid: str) -> None:
    r = sess.post(f"{MEILI_URL}/indexes", json={"uid": uid, "primaryKey": "id"}, timeout=30)
    r.raise_for_status()
    wait_task(sess, r.json()["taskUid"], ok_codes=("index_already_exists",))


def main():
    docs = build_docs()
    if len(docs) < 1000:
        # Prazan/polupun CH (npr. container tek dignut) ne smije zamijeniti živi index.
        sys.exit(f"[meili] Samo {len(docs)} dokumenata — odustajem od zamjene indexa.")

    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {MEILI_KEY}"})

    # Svježi build index (ostatak prekinutog prošlog pokretanja se briše).
    drop_index(sess, BUILD)
    ensure_index(sess, BUILD)

    print(f"[meili] Postavljam settings na '{BUILD}'...")
    r = sess.patch(f"{MEILI_URL}/indexes/{BUILD}/settings", json=SETTINGS, timeout=60)
    r.raise_for_status()
    wait_task(sess, r.json()["taskUid"])

    print(f"[meili] Uploadam {len(docs)} dokumenata...")
    for i in range(0, len(docs), 10000):
        r = sess.post(f"{MEILI_URL}/indexes/{BUILD}/documents",
                      json=docs[i:i + 10000], timeout=300)
        r.raise_for_status()
        wait_task(sess, r.json()["taskUid"])

    # Atomska zamjena; živi index mora postojati (prvo pokretanje na praznom Meiliju).
    ensure_index(sess, INDEX)
    r = sess.post(f"{MEILI_URL}/swap-indexes",
                  json=[{"indexes": [INDEX, BUILD]}], timeout=30)
    r.raise_for_status()
    wait_task(sess, r.json()["taskUid"])
    drop_index(sess, BUILD)  # nakon zamjene u njemu je stari sadržaj

    stats = sess.get(f"{MEILI_URL}/indexes/{INDEX}/stats", timeout=30).json()
    print(f"[meili] Gotovo. '{INDEX}': {stats.get('numberOfDocuments')} dokumenata.")


if __name__ == "__main__":
    main()
