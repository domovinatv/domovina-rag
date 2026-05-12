"""Pipeline: jedna epizoda → embed → upsert PG → INSERT CH."""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass
from typing import Iterator

from .db import ChClient, PgClient
from .embed import EmbedderClient
from .sources import Chunk, JsonlFile, episode_meta_from_first_chunk, stream_chunks


log = logging.getLogger("etl.load")


@dataclass
class LoadStats:
    files_processed: int = 0
    files_skipped: int = 0
    chunks_inserted: int = 0
    errors: int = 0


def _batched(it: Iterator[Chunk], n: int) -> Iterator[list[Chunk]]:
    buf: list[Chunk] = []
    for x in it:
        buf.append(x)
        if len(buf) >= n:
            yield buf
            buf = []
    if buf:
        yield buf


def load_file(
    jsonl: JsonlFile,
    *,
    pg: PgClient,
    ch: ChClient,
    embedder: EmbedderClient,
    batch_size: int,
    channel_cache: dict[str, int],
) -> int:
    """Učitaj jednu epizodu. Vraća broj inserted chunkova.

    Tijek:
      1. Pročitaj prvu liniju za episode metadata
      2. Upsert channel + episode u PG (commit nakon svake epizode za checkpoint)
      3. Stream chunkove u batch-evima → embed → CH insert
      4. Ažuriraj sync_state.last_basename
    """
    meta = episode_meta_from_first_chunk(jsonl)

    channel_id = channel_cache.get(meta.channel_slug)
    if channel_id is None:
        channel_id = pg.upsert_channel(meta.channel_slug)
        channel_cache[meta.channel_slug] = channel_id

    episode_id = pg.upsert_episode(
        channel_id=channel_id,
        youtube_id=meta.youtube_id,
        title=meta.title,
        upload_date=meta.upload_date,
    )

    inserted = 0
    upload_date = meta.upload_date or "1970-01-01"
    channel = meta.channel_slug

    for batch in _batched(stream_chunks(jsonl), batch_size):
        texts = [c.text for c in batch]
        vectors = embedder.embed(texts)
        if len(vectors) != len(batch):
            raise RuntimeError(
                f"embedder vratio {len(vectors)} vektora za {len(batch)} tekstova"
            )

        rows = []
        for c, vec in zip(batch, vectors):
            speaker = ",".join(c.speakers) if c.speakers else ""
            rows.append(
                [
                    c.chunk_id,
                    episode_id,
                    c.youtube_id,
                    channel,
                    upload_date,
                    speaker,
                    c.start_ts,
                    c.end_ts,
                    c.text,
                    "",  # text_summary — populated in Faza 2 kada budemo imali per-chunk summarize
                    c.chunk_index,
                    c.chunk_strategy,
                    vec,
                    json.dumps(c.raw, ensure_ascii=False),
                ]
            )
        ch.insert_chunks(rows)
        inserted += len(rows)

    pg.update_sync_state(
        source_name="jsonl_ingest",
        last_basename=jsonl.key,
        meta={"chunks_inserted": inserted, "youtube_id": meta.youtube_id},
    )
    pg.commit()
    return inserted
