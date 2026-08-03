"""Pipeline: jedna epizoda → embed → upsert PG → INSERT CH."""

from __future__ import annotations

import datetime as _dt
import json
import logging
from dataclasses import dataclass
from typing import Iterator

from .db import ChClient, PgClient
from .embed import EmbedderClient
from .sources import (
    Chunk,
    JsonlFile,
    episode_meta_from_first_chunk,
    read_article_entity_ts,
    read_mentioned_people,
    stream_chunks,
)
from .speakers import slugify


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

    # Channel UPSERT mora biti commit-an ZASEBNO od episode+chunks transakcije.
    # Inače, ako kasniji embed/CH insert fail-a, `pg.rollback()` u caller-u poništi
    # i channel SERIAL id generation — ali in-memory `channel_cache` zadržava
    # phantom id koji više ne postoji u PG-u. Sljedeća epizoda istog kanala
    # pokuša episode insert s phantom channel_id → FK violation cascade.
    # Fix: commit channel odmah; channel je global state, ne per-episode.
    channel_id = channel_cache.get(meta.channel_slug)
    if channel_id is None:
        channel_id = pg.upsert_channel(meta.channel_slug)
        pg.commit()  # ← komit ČIM channel id postoji, nezavisno od episode rezultata
        channel_cache[meta.channel_slug] = channel_id

    episode_id = pg.upsert_episode(
        channel_id=channel_id,
        youtube_id=meta.youtube_id,
        title=meta.title,
        upload_date=meta.upload_date,
    )

    inserted = 0
    upload_date_str = meta.upload_date or "1970-01-01"
    try:
        upload_date = _dt.date.fromisoformat(upload_date_str)
    except ValueError:
        # Pad/garbage → epoch placeholder. CH partition po `toYYYYMM(upload_date)`
        # ne smije fail-ati zbog jedne loše vrijednosti.
        log.warning("Nevažeći upload_date %r za %s — fallback epoch", upload_date_str, meta.youtube_id)
        upload_date = _dt.date(1970, 1, 1)
    channel = meta.channel_slug

    skipped_chunks = 0
    for batch in _batched(stream_chunks(jsonl), batch_size):
        texts = [c.text for c in batch]
        vectors, skipped = embedder.embed_lenient(texts)
        if len(vectors) != len(batch):
            raise RuntimeError(
                f"embedder vratio {len(vectors)} vektora za {len(batch)} tekstova"
            )
        skipped_chunks += len(skipped)

        rows = []
        for c, vec in zip(batch, vectors):
            if vec is None:
                continue  # predug chunk — preskočen, epizoda ide dalje
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

    # Djelomičan unos NE smije proći tiho — epizoda je u korpusu, ali nepotpuna,
    # a to se ne vidi ni iz jednog agregata. WARNING nosi youtube_id da se
    # pogođene epizode mogu izvući grepom iz cron loga.
    if skipped_chunks:
        log.warning(
            "%s: %d chunk(ova) preskočeno (predugi za embedder) — epizoda unesena "
            "s %d od %d chunkova",
            meta.youtube_id,
            skipped_chunks,
            inserted,
            inserted + skipped_chunks,
        )

    # Mentions: osoba SPOMENUTA u epizodi (summary.mentioned_people[]), ne nužno
    # govornik. Best-effort — ako sidecar summary.json fali, samo preskoči.
    people, title_hr = read_mentioned_people(jsonl)
    if people:
        mention_title = title_hr or meta.title or ""
        # mention_ts: najranija article.json sekcija gdje se osoba (kao entity)
        # spominje. 0 = nema hita → cijela epizoda (fallback). Vidi read_article_entity_ts.
        entity_ts = read_article_entity_ts(jsonl, slugify)
        ch.insert_mentions(
            [[meta.youtube_id, channel, upload_date, mention_title, person,
              entity_ts.get(slugify(person), 0)]
             for person in people]
        )
        resolved = sum(1 for p in people if entity_ts.get(slugify(p), 0) > 0)
        log.info("  → %d spomenutih osoba (mentions), %d s timestampom", len(people), resolved)

    pg.update_sync_state(
        source_name="jsonl_ingest",
        last_basename=jsonl.key,
        meta={"chunks_inserted": inserted, "youtube_id": meta.youtube_id},
    )
    pg.commit()
    return inserted
