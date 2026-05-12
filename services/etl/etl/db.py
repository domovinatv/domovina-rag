"""Tanak sloj iznad psycopg (PG) i clickhouse-connect (CH).

PG drži OLTP istinu (channels, episodes, sync_state).
CH drži chunkove (rag_chunks) + vector index.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Optional, Sequence
from urllib.parse import urlparse

import clickhouse_connect
import psycopg
from psycopg.rows import dict_row


# ─────────── PostgreSQL ───────────────────────────────────────


@dataclass
class PgConfig:
    dsn: str  # postgres://user:pass@host:port/db


class PgClient:
    def __init__(self, cfg: PgConfig) -> None:
        self.conn = psycopg.connect(cfg.dsn, row_factory=dict_row, autocommit=False)

    def close(self) -> None:
        self.conn.close()

    def upsert_channel(self, slug: str, name: Optional[str] = None) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO channels (slug, name)
                VALUES (%s, %s)
                ON CONFLICT (slug) DO UPDATE SET updated_at = now()
                RETURNING id
                """,
                (slug, name or slug),
            )
            row = cur.fetchone()
            assert row is not None
            return row["id"]

    def upsert_episode(
        self,
        channel_id: int,
        youtube_id: str,
        title: Optional[str],
        upload_date: Optional[str],
    ) -> int:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO episodes (channel_id, youtube_id, title, upload_date, status)
                VALUES (%s, %s, %s, %s, 'indexed')
                ON CONFLICT (youtube_id) DO UPDATE SET
                    title = COALESCE(EXCLUDED.title, episodes.title),
                    upload_date = COALESCE(EXCLUDED.upload_date, episodes.upload_date),
                    status = 'indexed',
                    processed_at = now(),
                    updated_at = now()
                RETURNING id
                """,
                (channel_id, youtube_id, title, upload_date),
            )
            row = cur.fetchone()
            assert row is not None
            return row["id"]

    def is_episode_indexed(self, youtube_id: str) -> bool:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT 1 FROM episodes WHERE youtube_id = %s AND status = 'indexed'",
                (youtube_id,),
            )
            return cur.fetchone() is not None

    def get_sync_state(self, source_name: str) -> Optional[dict]:
        with self.conn.cursor() as cur:
            cur.execute(
                "SELECT last_basename, last_synced_at, meta FROM sync_state WHERE source_name = %s",
                (source_name,),
            )
            return cur.fetchone()

    def update_sync_state(
        self,
        source_name: str,
        last_basename: str,
        meta: Optional[dict] = None,
    ) -> None:
        with self.conn.cursor() as cur:
            cur.execute(
                """
                INSERT INTO sync_state (source_name, last_basename, meta, last_synced_at)
                VALUES (%s, %s, %s::jsonb, now())
                ON CONFLICT (source_name) DO UPDATE SET
                    last_basename = EXCLUDED.last_basename,
                    meta = EXCLUDED.meta,
                    last_synced_at = now()
                """,
                (source_name, last_basename, json.dumps(meta or {})),
            )

    def commit(self) -> None:
        self.conn.commit()

    def rollback(self) -> None:
        self.conn.rollback()


# ─────────── ClickHouse ───────────────────────────────────────


@dataclass
class ChConfig:
    url: str  # http://user:pass@host:port/db


class ChClient:
    def __init__(self, cfg: ChConfig) -> None:
        u = urlparse(cfg.url)
        self.client = clickhouse_connect.get_client(
            host=u.hostname or "localhost",
            port=u.port or 8123,
            username=u.username or "default",
            password=u.password or "",
            database=(u.path or "/default").lstrip("/") or "default",
        )

    def close(self) -> None:
        self.client.close()

    def indexed_youtube_ids(self) -> set[str]:
        """Vrati set youtube_id-jeva koji već imaju barem jedan chunk u CH.

        Koristi se za `etl retry-missing` da identificira epizode koje su na
        disku ali nikad nisu ingestirane (npr. fail-ane preko httpx.ReadTimeout).
        """
        result = self.client.query("SELECT DISTINCT youtube_id FROM rag_chunks")
        return {row[0] for row in result.result_rows}

    def insert_chunks(self, rows: Sequence[Sequence]) -> None:
        """Batch insert u `rag_chunks`. Re-insert je idempotentan jer je tablica
        ReplacingMergeTree na `inserted_at` — najnoviji insert za isti
        `chunk_id` (unutar iste partition+sort key kombinacije) pobjeđuje
        nakon merge-a.
        """
        if not rows:
            return
        self.client.insert(
            "rag_chunks",
            rows,
            column_names=[
                "chunk_id",
                "episode_id",
                "youtube_id",
                "channel",
                "upload_date",
                "speaker",
                "start_ts",
                "end_ts",
                "text",
                "text_summary",
                "chunk_index",
                "chunk_strategy",
                "embedding",
                "metadata",
            ],
        )
