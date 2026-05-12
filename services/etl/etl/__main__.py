"""CLI entrypoint:

    python -m etl ingest --input /path/to/storage/output
    python -m etl ingest --input ... --channel cuspajz --limit 2
    python -m etl status
"""

from __future__ import annotations

import argparse
import logging
import os
import sys
from pathlib import Path

from .db import ChClient, ChConfig, PgClient, PgConfig
from .embed import EmbedderClient
from .load import LoadStats, load_file
from .sources import discover_jsonl


log = logging.getLogger("etl")


def _build_pg_dsn() -> str:
    if dsn := os.environ.get("POSTGRES_URL"):
        return dsn
    user = os.environ["POSTGRES_USER"]
    pw = os.environ["POSTGRES_PASSWORD"]
    host = os.environ.get("POSTGRES_HOST", "postgres")
    port = os.environ.get("POSTGRES_PORT", "5432")
    db = os.environ["POSTGRES_DB"]
    return f"postgres://{user}:{pw}@{host}:{port}/{db}"


def _build_ch_url() -> str:
    if url := os.environ.get("CLICKHOUSE_URL"):
        return url
    user = os.environ["CLICKHOUSE_USER"]
    pw = os.environ["CLICKHOUSE_PASSWORD"]
    host = os.environ.get("CLICKHOUSE_HOST", "clickhouse")
    port = os.environ.get("CLICKHOUSE_HTTP_PORT", "8123")
    db = os.environ["CLICKHOUSE_DB"]
    return f"http://{user}:{pw}@{host}:{port}/{db}"


def cmd_ingest(args: argparse.Namespace) -> int:
    input_dir = Path(args.input).resolve()
    files = discover_jsonl(input_dir, channel_filter=args.channel)
    log.info("Pronađeno %d JSONL fajlova u %s", len(files), input_dir)

    if args.limit:
        files = files[: args.limit]
        log.info("Limit %d → procesiram prvih %d", args.limit, len(files))

    pg = PgClient(PgConfig(dsn=_build_pg_dsn()))
    ch = ChClient(ChConfig(url=_build_ch_url()))
    embedder = EmbedderClient(base_url=os.environ.get("EMBEDDER_URL", "http://embedder:8000"))

    # Resume = po `episodes.status='indexed'` u PG (truth source). `sync_state`
    # se i dalje upisuje za visibility/observability, ali nije izvor istine.
    if not args.no_resume:
        state = pg.get_sync_state("jsonl_ingest")
        if state:
            log.info("Posljednji sync: last_basename=%s last_synced_at=%s",
                     state["last_basename"], state["last_synced_at"])

    stats = LoadStats()
    channel_cache: dict[str, int] = {}

    try:
        for f in files:
            if not args.no_resume and not args.reingest and pg.is_episode_indexed(f.youtube_id):
                stats.files_skipped += 1
                continue
            log.info("Ingest %s", f.key)
            try:
                n = load_file(
                    f,
                    pg=pg,
                    ch=ch,
                    embedder=embedder,
                    batch_size=args.batch_size,
                    channel_cache=channel_cache,
                )
                stats.chunks_inserted += n
                stats.files_processed += 1
                log.info("  → %d chunkova", n)
            except Exception:
                stats.errors += 1
                pg.rollback()
                log.exception("Greška na %s — nastavljam dalje", f.key)
    finally:
        embedder.close()
        ch.close()
        pg.close()

    log.info(
        "Done: processed=%d skipped=%d chunks=%d errors=%d",
        stats.files_processed,
        stats.files_skipped,
        stats.chunks_inserted,
        stats.errors,
    )
    return 0 if stats.errors == 0 else 1


def cmd_status(args: argparse.Namespace) -> int:
    pg = PgClient(PgConfig(dsn=_build_pg_dsn()))
    try:
        state = pg.get_sync_state("jsonl_ingest")
        if state is None:
            print("sync_state[jsonl_ingest]: <prazno>")
        else:
            print(f"sync_state[jsonl_ingest]: {state}")
    finally:
        pg.close()
    return 0


def cmd_retry_missing(args: argparse.Namespace) -> int:
    """Re-ingestiraj epizode čiji JSONL postoji na disku ali NEMA chunkova u CH.

    Tipično: ETL je timeoutalo tijekom prvog ingest-a (httpx.ReadTimeout od
    sustained MPS embedder load-a). Sada nakon embedder retry logike + cool-off,
    retry-aj specifično te epizode bez re-iteriranja kroz sve.
    """
    input_dir = Path(args.input).resolve()
    files = discover_jsonl(input_dir, channel_filter=args.channel)
    log.info("Pronađeno %d JSONL fajlova u %s", len(files), input_dir)

    ch = ChClient(ChConfig(url=_build_ch_url()))
    pg = PgClient(PgConfig(dsn=_build_pg_dsn()))
    embedder = EmbedderClient(base_url=os.environ.get("EMBEDDER_URL", "http://embedder:8000"))

    try:
        # CH query: koje youtube_id-jeve već imamo (count > 0)?
        ingested = ch.indexed_youtube_ids()
        log.info("CH ima %d epizoda s chunkovima", len(ingested))

        missing = [f for f in files if f.youtube_id not in ingested]
        log.info("Disk - CH = %d epizoda fali", len(missing))

        if args.dry_run:
            for f in missing[:50]:
                print(f"  {f.key}  (youtube_id={f.youtube_id})")
            if len(missing) > 50:
                print(f"  ... + {len(missing) - 50} više")
            return 0

        if args.limit:
            missing = missing[: args.limit]
            log.info("Limit %d → procesiram prvih %d", args.limit, len(missing))

        stats = LoadStats()
        channel_cache: dict[str, int] = {}
        for f in missing:
            log.info("Retry %s", f.key)
            try:
                n = load_file(
                    f,
                    pg=pg,
                    ch=ch,
                    embedder=embedder,
                    batch_size=args.batch_size,
                    channel_cache=channel_cache,
                )
                stats.chunks_inserted += n
                stats.files_processed += 1
                log.info("  → %d chunkova", n)
            except Exception:
                stats.errors += 1
                pg.rollback()
                log.exception("Retry fail na %s — nastavljam dalje", f.key)

        log.info(
            "Retry done: processed=%d chunks=%d errors=%d",
            stats.files_processed,
            stats.chunks_inserted,
            stats.errors,
        )
        return 0 if stats.errors == 0 else 1
    finally:
        embedder.close()
        ch.close()
        pg.close()


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    p = argparse.ArgumentParser(prog="etl", description="JSONL → ClickHouse ingest")
    sub = p.add_subparsers(dest="cmd", required=True)

    p_ing = sub.add_parser("ingest", help="Ingest JSONL chunkove u CH")
    p_ing.add_argument("--input", required=True, help="Korijenski dir s {channel}/{basename}.rag_combined.jsonl")
    p_ing.add_argument("--channel", default=None, help="Filtriraj na jedan kanal slug")
    p_ing.add_argument("--batch-size", type=int, default=64, help="Chunkova po embed/insert batchu")
    p_ing.add_argument("--limit", type=int, default=0, help="Procesiraj samo prvih N fajlova (testiranje)")
    p_ing.add_argument("--no-resume", action="store_true", help="Ignoriraj sync_state cursor")
    p_ing.add_argument("--reingest", action="store_true", help="Re-ingest već viđenih fajlova (ReplacingMergeTree pobjeđuje)")
    p_ing.set_defaults(func=cmd_ingest)

    p_st = sub.add_parser("status", help="Prikaži sync_state")
    p_st.set_defaults(func=cmd_status)

    p_retry = sub.add_parser(
        "retry-missing",
        help="Re-ingestiraj epizode čiji JSONL postoji ali NEMA chunkova u CH",
    )
    p_retry.add_argument("--input", required=True, help="Korijenski dir s {channel}/*.rag_combined.jsonl")
    p_retry.add_argument("--channel", default=None, help="Filtriraj na jedan kanal slug")
    p_retry.add_argument("--batch-size", type=int, default=4, help="Chunkova po embed/insert batchu (default 4)")
    p_retry.add_argument("--limit", type=int, default=0, help="Retry samo prvih N propalih")
    p_retry.add_argument("--dry-run", action="store_true", help="Samo ispiši što fali, ne pokreni ingest")
    p_retry.set_defaults(func=cmd_retry_missing)

    args = p.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
