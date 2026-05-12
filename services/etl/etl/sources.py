"""Discovery i parsing producer outputa (`*.rag_combined.jsonl`).

Path layout:
    {input_dir}/{channel_slug}/{basename}.rag_combined.jsonl

`basename` ima oblik `{YYYYMMDD}_{title_sanitized}_yt_{youtube_id}`.

JSONL shape (stvarni, observed 2026-05-12 — NE matcha data_contract.md koji opisuje
aspirational schemu):

    {
      "id": "{youtube_id}_topic_{NNN}",        # chunk identifier
      "text": "Tema: ...\\n\\n[Speaker] ...",   # tekst chunka
      "metadata": {
        "type": "topic_transcript",            # → chunk_strategy
        "channel": "ad_deum_podcast",
        "title": "...",                        # episode title
        "youtube_id": "2fiE6NsRz8M",
        "upload_date": "2025-05-10",
        "topic": "...",
        "speakers": ["Voditelj"],              # NB: imena, ne SPEAKER_XX tagovi
        "start_time": "00:00:08",              # HH:MM:SS, NE float
        "end_time": "00:02:43",
        "topics": [...],
        "chunk_index": 1,                      # NB: 1-based
        "total_chunks": 52,
        "has_speaker_names": true
      }
    }
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Iterator, Optional


_JSONL_GLOB = "*.rag_combined.jsonl"
_BASENAME_RE = re.compile(r"^(\d{8})_(.+)_yt_([A-Za-z0-9_-]{11})$")


def _parse_hms(s: str) -> float:
    """`HH:MM:SS` ili `HH:MM:SS.frac` → sekunde. Tolerantno na čisti broj."""
    if not s:
        return 0.0
    parts = s.split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(s)
    except (ValueError, TypeError):
        return 0.0


@dataclass(frozen=True)
class JsonlFile:
    path: Path
    channel_slug: str
    basename: str
    youtube_id: str

    @property
    def key(self) -> str:
        """Stabilan ključ za sync_state.last_basename — unique per epizoda."""
        return f"{self.channel_slug}/{self.basename}"


@dataclass
class Chunk:
    chunk_id: str
    youtube_id: str
    channel: str
    chunk_index: int
    chunk_strategy: str
    start_ts: float
    end_ts: float
    speakers: list[str]
    text: str
    raw: dict


@dataclass
class EpisodeMeta:
    youtube_id: str
    channel_slug: str
    title: Optional[str]
    upload_date: Optional[str]  # ISO YYYY-MM-DD


def discover_jsonl(input_dir: Path, channel_filter: Optional[str] = None) -> list[JsonlFile]:
    """Vrati sve `*.rag_combined.jsonl` fajlove pod `input_dir/{channel}/`.

    `channel_filter`: ako je postavljen, samo taj kanal slug.
    """
    if not input_dir.exists():
        raise FileNotFoundError(f"input_dir ne postoji: {input_dir}")

    out: list[JsonlFile] = []
    channel_dirs: Iterable[Path]
    if channel_filter:
        channel_dirs = [input_dir / channel_filter]
    else:
        channel_dirs = [d for d in input_dir.iterdir() if d.is_dir()]

    for ch_dir in channel_dirs:
        if not ch_dir.exists():
            continue
        for jsonl_path in ch_dir.glob(_JSONL_GLOB):
            basename = jsonl_path.name.removesuffix(".rag_combined.jsonl")
            m = _BASENAME_RE.match(basename)
            if not m:
                # Skip — basename ne matcha očekivani producer pattern.
                continue
            youtube_id = m.group(3)
            out.append(
                JsonlFile(
                    path=jsonl_path,
                    channel_slug=ch_dir.name,
                    basename=basename,
                    youtube_id=youtube_id,
                )
            )
    out.sort(key=lambda f: (f.channel_slug, f.basename))
    return out


def stream_chunks(jsonl: JsonlFile) -> Iterator[Chunk]:
    """Streamira chunk-ove iz JSONL-a, jedan po liniji."""
    with jsonl.path.open("r", encoding="utf-8") as f:
        for line_no, line in enumerate(f, start=1):
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError as e:
                raise ValueError(
                    f"{jsonl.path}:{line_no} nije validan JSON: {e.msg}"
                ) from e
            meta = obj.get("metadata") or {}
            yield Chunk(
                chunk_id=obj["id"],
                youtube_id=meta.get("youtube_id") or jsonl.youtube_id,
                channel=meta.get("channel") or jsonl.channel_slug,
                chunk_index=int(meta.get("chunk_index", 0)),
                chunk_strategy=str(meta.get("type") or "combined"),
                start_ts=_parse_hms(str(meta.get("start_time", "") or "")),
                end_ts=_parse_hms(str(meta.get("end_time", "") or "")),
                speakers=list(meta.get("speakers") or []),
                text=obj["text"],
                raw=obj,
            )


def episode_meta_from_first_chunk(jsonl: JsonlFile) -> EpisodeMeta:
    """Pročita prvu liniju JSONL-a samo da izvuče episode-level metadata."""
    chunk = next(stream_chunks(jsonl))
    meta = chunk.raw.get("metadata") or {}
    return EpisodeMeta(
        youtube_id=chunk.youtube_id,
        channel_slug=jsonl.channel_slug,
        title=meta.get("title"),
        upload_date=meta.get("upload_date"),
    )
