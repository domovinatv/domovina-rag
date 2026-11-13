"""
Vlasnikove postavke kanala (lanac „postavke kanala”, S8) za noćne sync skripte.

Izvor je katalog `GET https://domovina.ai/api/katalog/v1/settings`:
  {"version":"1","settings":{"UC…":{"status":"active|withdrawn|deleted","off":[…],
   "deleted_at"?:"…","slugs"?:["slug",…]}}}
Navedeni su samo UC-ovi s barem jednim isključenim ključem ili tombstoneom; svi
ostali su „sve uključeno”. Zatvaranje ovisnosti je isto kao `closeOff` u
fetch.domovina.tv/lib/channel_settings.js (i services/mcp/src/channel-settings.ts).

U ovom repou je kanal slug (`rag_chunks.channel` = ime direktorija producera,
`domovina_tv`), a katalog piše `domovina-tv` — uspoređuje se normalizirano
(lowercase, `_` → `-`).

**Neuspio dohvat NIKAD ne smije smanjiti indeks.** Svaki uspješan dohvat se sprema
na disk (`logs/channel_settings.last_ok.json`, logs/ je u .gitignore); kad dohvat
padne, koristi se ta snimka (isto stanje kao zadnji put → isti indeks). Bez nje se
ne filtrira ništa (indeks kao prije postavki), uz glasno upozorenje.

Samo stdlib — skripte se zovu i iz embedder venva i iz golog python3.
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
import urllib.request
from pathlib import Path
from typing import Callable, Iterable, Optional

DEFAULT_URL = "https://domovina.ai/api/katalog/v1/settings"
REPO = Path(__file__).resolve().parent.parent
DEFAULT_SNAPSHOT = REPO / "logs" / "channel_settings.last_ok.json"

# 20 ključeva, ugovor s ostalim potrošačima (odluka 1). Ne preimenovati.
KEYS = (
    "channel_enabled", "processing", "home_featured", "in_app_search", "search_engines",
    "push_notifications", "cdn_playback", "share_clips", "ebook", "article_summary",
    "transcript_subtitles", "english_translation", "magisterium", "highlights_reels",
    "persons_mentions", "news_portal", "ai_assistants", "donations", "paid_sponsor_moments",
    "sponsors_in_video",
)
AI_KEYS = (
    "article_summary", "transcript_subtitles", "english_translation", "magisterium",
    "highlights_reels", "persons_mentions", "news_portal", "ai_assistants",
)
# Odluka 108/200: ovisni ključevi padaju s člankom.
ARTICLE_DEPENDENTS = ("ebook", "magisterium", "english_translation", "share_clips", "news_portal")

_UC_RE = re.compile(r"^UC[A-Za-z0-9_-]{22}$")

Log = Callable[[str], None]


def _stderr(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def close_off(off: Optional[Iterable[str]], status: Optional[str] = None) -> set[str]:
    """Master/tombstone → svih 20; transkript → AI ključevi; članak → ovisni."""
    s = {k for k in (off or []) if k in KEYS}
    if status in ("withdrawn", "deleted") or "channel_enabled" in s:
        return set(KEYS)
    if "transcript_subtitles" in s:
        s.update(AI_KEYS)
    if "article_summary" in s:
        s.update(ARTICLE_DEPENDENTS)
    return s


def normalize_slug(slug: str) -> str:
    """`Domovina_TV` → `domovina-tv`."""
    return slug.strip().lower().replace("_", "-")


def parse_catalog_response(body) -> dict:
    """Provjeri oblik odgovora kataloga; vrati {UC: {status, off, slugs?}} ili baci ValueError."""
    j = json.loads(body) if isinstance(body, (str, bytes)) else body
    if not isinstance(j, dict) or not isinstance(j.get("settings"), dict):
        raise ValueError("neispravan odgovor kataloga (nema objekta settings)")
    out: dict = {}
    for uc, v in j["settings"].items():
        if not isinstance(uc, str) or not _UC_RE.match(uc) or not isinstance(v, dict):
            continue
        status = v.get("status") if v.get("status") in ("withdrawn", "deleted") else "active"
        entry = {
            "status": status,
            "off": [k for k in (v.get("off") or []) if isinstance(k, str)],
        }
        if isinstance(v.get("slugs"), list):
            entry["slugs"] = [s for s in v["slugs"] if isinstance(s, str) and s.strip()]
        if isinstance(v.get("deleted_at"), str):
            entry["deleted_at"] = v["deleted_at"]
        out[uc] = entry
    return out


def fetch_settings(url: str = DEFAULT_URL, timeout: float = 15, retries: int = 3,
                   opener=urllib.request.urlopen, sleep=time.sleep) -> dict:
    """Dohvati i provjeri; baca nakon `retries` neuspjeha."""
    last: Exception = RuntimeError("nepoznata greška")
    for attempt in range(1, retries + 1):
        try:
            req = urllib.request.Request(url, headers={
                "accept": "application/json", "user-agent": "domovina-rag-sync"})
            with opener(req, timeout=timeout) as res:
                status = getattr(res, "status", 200)
                if status != 200:
                    raise RuntimeError(f"HTTP {status}")
                return parse_catalog_response(res.read())
        except Exception as e:  # noqa: BLE001 — svaka greška = pokušaj ponovno
            last = e
            if attempt < retries:
                sleep(2 * attempt)
    raise RuntimeError(f"{type(last).__name__}: {last}")


def write_snapshot(path: Path, settings: dict, url: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps({
        "ok": True,
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "url": url,
        "settings": settings,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_snapshot(path: Path) -> Optional[dict]:
    """Zadnja uspješna snimka ili None (nema je / nečitljiva)."""
    try:
        s = json.loads(Path(path).read_text(encoding="utf-8"))
        if s.get("ok") is True and isinstance(s.get("settings"), dict):
            return s
    except Exception:  # noqa: BLE001
        pass
    return None


def load_settings(url: Optional[str] = None, snapshot_path: Optional[Path] = None,
                  fetch: Callable[[str], dict] = fetch_settings,
                  log: Log = _stderr) -> tuple[Optional[dict], str]:
    """
    Vrati (postavke, izvor). Izvor: "katalog" | "snimka" | "nema".
    `None` znači: ne filtriraj ništa (indeksiraj kao prije postavki).
    """
    url = url or os.environ.get("CHANNEL_SETTINGS_URL") or DEFAULT_URL
    snap = Path(snapshot_path or os.environ.get("CHANNEL_SETTINGS_SNAPSHOT") or DEFAULT_SNAPSHOT)
    try:
        settings = fetch(url)
    except Exception as e:  # noqa: BLE001
        prev = read_snapshot(snap)
        if prev is not None:
            log(f"[channel-settings] UPOZORENJE: dohvat {url} pao ({e}) — koristim zadnju "
                f"uspješnu snimku od {prev.get('fetched_at')} ({snap})")
            return prev["settings"], "snimka"
        log(f"[channel-settings] GREŠKA: dohvat {url} pao ({e}) i nema snimke ({snap}) — "
            f"NE filtriram kanale, indeks ide kao prije postavki")
        return None, "nema"
    try:
        write_snapshot(snap, settings, url)
    except OSError as e:
        log(f"[channel-settings] UPOZORENJE: ne mogu spremiti snimku {snap}: {e}")
    return settings, "katalog"


def blocked_channels(settings: Optional[dict], keys: Iterable[str], log: Log = _stderr) -> set[str]:
    """Normalizirani slugovi kanala kojima je isključen barem jedan od `keys`."""
    keys = tuple(keys)
    out: set[str] = set()
    for uc, entry in (settings or {}).items():
        off = close_off(entry.get("off"), entry.get("status"))
        if not any(k in off for k in keys):
            continue
        slugs = entry.get("slugs") or []
        if not slugs:
            log(f"[channel-settings] UPOZORENJE: {uc} ima isključene ključeve, ali katalog "
                f"nije poslao `slugs` — kanal se NE filtrira")
            continue
        out.update(normalize_slug(s) for s in slugs)
    return out


def is_blocked(channel: Optional[str], blocked: set[str]) -> bool:
    return bool(channel) and normalize_slug(channel) in blocked


def filter_docs(docs: list[dict], blocked: set[str], max_drop_share: float = 0.5,
                key: str = "channel") -> tuple[list[dict], int]:
    """
    Izbaci dokumente isključenih kanala. Prazan `blocked` vraća ISTU listu.
    Ako bi otpalo više od `max_drop_share` dokumenata, baca SystemExit — to je
    gotovo sigurno pokvaren odgovor kataloga, a ne volja vlasnika.
    """
    if not blocked:
        return docs, 0
    kept = [d for d in docs if not is_blocked(d.get(key), blocked)]
    dropped = len(docs) - len(kept)
    if docs and dropped / len(docs) > max_drop_share:
        raise SystemExit(
            f"[channel-settings] postavke bi izbacile {dropped}/{len(docs)} dokumenata "
            f"(> {max_drop_share:.0%}) — odustajem, indeks ostaje kakav jest")
    return kept, dropped
