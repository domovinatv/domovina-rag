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

import datetime as _dt

from .db import ChClient, ChConfig, PgClient, PgConfig
from .embed import EmbedderClient
from .load import LoadStats, load_file
from .sources import (
    discover_jsonl,
    episode_meta_from_first_chunk,
    read_article_entity_ts,
    read_mentioned_people,
)
from .speakers import build_persons, slugify, _load_seed


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


def cmd_mentions(args: argparse.Namespace) -> int:
    """Backfill `episode_mentions` (CH) iz sibling summary.json-a za već ingestirane epizode.

    Novi ingest puni episode_mentions inline (load.py hook). Ova komanda pokrije
    POSTOJEĆE epizode koje su ingestirane prije nego je hook postojao. Restrikcija
    na youtube_id koji SU u rag_chunks — spominjemo samo epizode koje poslužujemo.
    Idempotentno (ReplacingMergeTree). Pokreni per-disk kao ingest (DATA_SOURCE_DIR).
    """
    input_dir = Path(args.input).resolve()
    files = discover_jsonl(input_dir, channel_filter=args.channel)
    log.info("Pronađeno %d JSONL fajlova u %s", len(files), input_dir)

    ch = ChClient(ChConfig(url=_build_ch_url()))
    try:
        indexed = ch.indexed_youtube_ids()
        log.info("CH ima %d ingestiranih epizoda", len(indexed))
        targets = [f for f in files if f.youtube_id in indexed]
        if args.limit:
            targets = targets[: args.limit]
        log.info("Backfill mentions za %d epizoda", len(targets))

        episodes_with = 0
        total_rows = 0
        total_ts = 0
        for f in targets:
            people, title_hr = read_mentioned_people(f)
            if not people:
                continue
            meta = episode_meta_from_first_chunk(f)
            upload_date_str = meta.upload_date or "1970-01-01"
            try:
                upload_date = _dt.date.fromisoformat(upload_date_str)
            except ValueError:
                upload_date = _dt.date(1970, 1, 1)
            title = title_hr or meta.title or ""
            entity_ts = read_article_entity_ts(f, slugify)
            rows = [
                [meta.youtube_id, meta.channel_slug, upload_date, title, person,
                 entity_ts.get(slugify(person), 0)]
                for person in people
            ]
            resolved = sum(1 for r in rows if r[5] > 0)
            total_ts += resolved
            if args.dry_run:
                print(f"  {f.youtube_id}  {len(people):>3} osoba ({resolved} s ts)  {title[:50]}")
            else:
                ch.insert_mentions(rows)
            episodes_with += 1
            total_rows += len(rows)

        log.info(
            "Done: %d epizoda sa spomenima, %d mention-redova (%d s timestampom)%s",
            episodes_with, total_rows, total_ts, " (dry-run)" if args.dry_run else "",
        )
    finally:
        ch.close()
    return 0


def cmd_speakers(args: argparse.Namespace) -> int:
    """Populate `speakers` "person hub" iz distinct CH govornika.

    Idempotentno (UPSERT po slug-u). Slugovi su STABILNI kroz re-runove —
    public share URL se ne smije mijenjati.
    """
    ch = ChClient(ChConfig(url=_build_ch_url()))
    rows = ch.raw_speaker_rows()
    ch.close()
    log.info("CH: %d distinct raw govornika", len(rows))

    seed = _load_seed(Path(args.seed).resolve() if args.seed else None)
    if seed:
        log.info("Seed: %d ručnih alias→slug mapiranja", len(seed))

    result = build_persons(rows, seed=seed)
    log.info(
        "Izgrađeno %d osoba (skip: %d role-labeli, %d SPEAKER_XX; "
        "%d varijanti spojeno, %d seed-merge-eva)",
        len(result.persons),
        result.skipped_role,
        result.skipped_speaker_xx,
        result.variants_merged,
        result.seed_merges,
    )

    if args.dry_run:
        print(f"\n{'slug':<34} {'chunks':>7}  {'alias':>5}  canonical")
        print("-" * 78)
        limit = args.limit or 40
        for p in result.persons[:limit]:
            print(
                f"{p.slug:<34} {p.chunks:>7}  {len(p.aliases):>5}  "
                f"{p.canonical_name}"
            )
        if len(result.persons) > limit:
            print(f"... + {len(result.persons) - limit} više")
        return 0

    pg = PgClient(PgConfig(dsn=_build_pg_dsn()))
    written = 0
    try:
        for p in result.persons:
            pg.upsert_speaker(
                canonical_name=p.canonical_name,
                slug=p.slug,
                aliases=p.aliases,
                channels=sorted(p.channels),
                confidence=p.confidence(),
            )
            written += 1
        pruned = pg.prune_speakers([p.slug for p in result.persons])
        pg.commit()
        log.info(
            "Upisano %d osoba, obrisano %d zastarjelih (speakers total: %d)",
            written, pruned, pg.count_speakers(),
        )
    except Exception:
        pg.rollback()
        log.exception("Populate fail — rollback")
        return 1
    finally:
        pg.close()
    return 0


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

    p_sp = sub.add_parser(
        "speakers",
        help="Populate 'person hub' (speakers) iz distinct CH govornika",
    )
    p_sp.add_argument(
        "--seed",
        default="infra/postgres/seeds/speaker_aliases.csv",
        help="CSV 'slug,alias' ručnih merge-eva (default: infra/postgres/seeds/...)",
    )
    p_sp.add_argument("--dry-run", action="store_true", help="Samo ispiši, ne piši u PG")
    p_sp.add_argument("--limit", type=int, default=0, help="Dry-run: prikaži prvih N (default 40)")
    p_sp.set_defaults(func=cmd_speakers)

    p_men = sub.add_parser(
        "mentions",
        help="Backfill 'episode_mentions' (CH) iz summary.json za već ingestirane epizode",
    )
    p_men.add_argument("--input", required=True, help="Korijenski dir s {channel}/*.rag_combined.jsonl")
    p_men.add_argument("--channel", default=None, help="Filtriraj na jedan kanal slug")
    p_men.add_argument("--limit", type=int, default=0, help="Procesiraj samo prvih N epizoda")
    p_men.add_argument("--dry-run", action="store_true", help="Samo ispiši, ne piši u CH")
    p_men.set_defaults(func=cmd_mentions)

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
