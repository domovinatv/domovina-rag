#!/usr/bin/env python3
"""
PoC: napuni Meilisearch po-epizoda dokumentima iz ClickHouse-a (article_summary
chunkovi) za frontend keyword tražilicu.

Dokument = epizoda. article_text = svi article_summary chunkovi spojeni.
Searchable: title, article_text. Faseteable: channel, upload_date, speakers.

Pokretanje:
  services/embedder/.venv/bin/python scripts/meili-poc-index.py

Env (default = lokalni PoC):
  CH_URL            http://localhost:8123  (ako CH ne sluša na hostu, koristi docker fallback)
  CH_USER, CH_PASS, CH_DB
  MEILI_URL         http://localhost:7700
  MEILI_KEY         poc_master_key_domovina_2026
"""
import json
import os
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


def ch_query(sql: str) -> str:
    """Run a CH query via docker exec; return raw stdout."""
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


def main():
    print("[meili-poc] Dohvaćam po-epizoda dokumente iz CH-a...")
    # Spoji article_summary chunkove u jedan text po youtube_id-u; uzmi meta.
    # groupArray + arrayStringConcat poreda po chunk_index.
    sql = f"""
    SELECT
      youtube_id,
      any(channel) AS channel,
      max(upload_date) AS upload_date,
      arrayStringConcat(
        arrayMap(x -> x.2,
          arraySort(x -> x.1,
            groupArray((chunk_index, text)))),
        '\n\n') AS article_text
    FROM {CH_DB}.rag_chunks
    WHERE chunk_strategy = 'article_summary' AND length(youtube_id) = 11
    GROUP BY youtube_id
    FORMAT JSONEachRow
    """
    raw = ch_query(sql)
    docs = []
    for line in raw.splitlines():
        if not line.strip():
            continue
        r = json.loads(line)
        # Izvuci sve "Naslov: ..." retke kao zaseban boostan field
        titles = [
            ln.split("Naslov:", 1)[1].strip()
            for ln in r["article_text"].splitlines()
            if ln.strip().startswith("Naslov:")
        ]
        docs.append({
            "id": r["youtube_id"],          # Meili primary key (11-char yt id je validan)
            "youtube_id": r["youtube_id"],
            "channel": r["channel"],
            "upload_date": r["upload_date"],
            "section_titles": titles,
            "article_text": r["article_text"],
            "deep_link": f"https://domovina.ai/v/{r['youtube_id']}",
        })
    print(f"[meili-poc] {len(docs)} epizoda-dokumenata iz CH-a.")

    # Obogati title-om iz PG-a (CH nema title)
    print("[meili-poc] Dohvaćam title-ove iz PG-a...")
    pg_raw = pg_query("SELECT youtube_id, coalesce(title,'') FROM episodes")
    titles_by_yt = {}
    for ln in pg_raw.splitlines():
        if "\t" in ln:
            yt, title = ln.split("\t", 1)
            titles_by_yt[yt.strip()] = title.strip()
    for d in docs:
        d["title"] = titles_by_yt.get(d["youtube_id"], "")
    with_title = sum(1 for d in docs if d["title"])
    print(f"[meili-poc] {with_title}/{len(docs)} dokumenata ima title.")

    sess = requests.Session()
    sess.headers.update({"Authorization": f"Bearer {MEILI_KEY}"})

    # Konfiguriraj index settings (searchable, filterable, sortable)
    print("[meili-poc] Postavljam index settings...")
    sess.patch(f"{MEILI_URL}/indexes/{INDEX}/settings", json={
        "searchableAttributes": ["title", "section_titles", "article_text"],
        "filterableAttributes": ["channel", "upload_date"],
        "sortableAttributes": ["upload_date"],
        "displayedAttributes": [
            "id", "youtube_id", "title", "channel", "upload_date",
            "section_titles", "deep_link",
        ],
    }, timeout=60).raise_for_status()

    # Batch upload
    print(f"[meili-poc] Uploadam {len(docs)} dokumenata u index '{INDEX}'...")
    resp = sess.post(f"{MEILI_URL}/indexes/{INDEX}/documents", json=docs, timeout=120)
    resp.raise_for_status()
    task_uid = resp.json()["taskUid"]

    # Čekaj da Meili obradi task
    for _ in range(60):
        time.sleep(1)
        t = sess.get(f"{MEILI_URL}/tasks/{task_uid}", timeout=30).json()
        if t["status"] in ("succeeded", "failed"):
            print(f"[meili-poc] Task {t['status']}: {t.get('details', {})}")
            break

    stats = sess.get(f"{MEILI_URL}/indexes/{INDEX}/stats", timeout=30).json()
    print(f"[meili-poc] Index stats: {stats}")
    print("[meili-poc] Gotovo. Test: "
          f"curl '{MEILI_URL}/indexes/{INDEX}/search' "
          f"-H 'Authorization: Bearer {MEILI_KEY}' "
          "-H 'Content-Type: application/json' "
          "--data '{\"q\":\"poniznost\"}'")


if __name__ == "__main__":
    main()
