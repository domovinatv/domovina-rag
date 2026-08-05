#!/usr/bin/env python3
"""tim-cost.py — stvarna potrošnja tokena AI tima, po ulozi i modelu.

    ./scripts/tim-cost.py                  # tablica od početka današnjih sesija
    ./scripts/tim-cost.py --since 17:10    # samo od tog vremena (lokalno)
    ./scripts/tim-cost.py --json           # strojno čitljivo
    ./scripts/tim-cost.py --watch 120      # watcher: 1 linija po promjeni

Izvor je transkript svake Claude Code sesije (~/.claude/projects/<slug>/*.jsonl),
gdje svaka assistant poruka nosi stvarni `usage` blok. To je mjerenje, ne
procjena — ne koristi se nikakav tokenizer ni heuristika.

Uloga se pripisuje preko `agent-name` ILI `custom-title` zapisa (oba nastaju iz
`claude -n <ime>`; tim.sh to radi za svih pet panela). OBA su nužna: `/clear`
otvara NOVI transkript u kojem `agent-name` više ne postoji, ali `custom-title`
preživi — bez njega bi devovi nakon prvog čišćenja konteksta nestali iz
mjerenja. Sesije bez ijednog zapisa (npr. ovaj alatnički chat) idu u "ostalo" i
NE ulaze u zbroj tima.

Dedupe: isti assistant zapis se u JSONL-u pojavi više puta (stream update),
pa se `usage` broji jednom po `message.id`.

Cijene su API cjenik po milijunu tokena (stanje 2026-07-25):
    claude-opus-5   ulaz $5   izlaz $25
    claude-fable-5  ulaz $10  izlaz $50
    cache write = 1.25× ulaz (5-min TTL)   ·   cache read = 0.1× ulaz
Vlasnik repoa je na Claude Max pretplati, pa je iznos u dolarima NOTIONAL —
"koliko bi ovo stajalo preko API-ja", ne stvarni račun.
"""
import argparse
import json
import os
import pathlib
import re
import sys
import time
from datetime import datetime, timezone

def _roles() -> list[str]:
    """Uloge iz .tim/panes.env (piše ih tim.sh) — da lista ne živi na dva mjesta."""
    env = pathlib.Path(__file__).resolve().parent.parent / ".tim" / "panes.env"
    try:
        found = [ln.split("=", 1)[0].removeprefix("TIM_PANE_").lower()
                 for ln in env.read_text().splitlines() if ln.startswith("TIM_PANE_")]
        if found:
            return found
    except OSError:
        pass
    return ["planner", "orkestrator", "reviewer", "dev1", "dev2"]


ROLES = _roles()

# $ po milijunu tokena: (ulaz, izlaz). Ostalo se izvodi iz ulaza.
PRICES = {
    "claude-opus-5": (5.0, 25.0),
    "claude-fable-5": (10.0, 50.0),
    "claude-sonnet-5": (3.0, 15.0),
    "claude-haiku-4-5": (1.0, 5.0),
}
CACHE_WRITE_MULT = 1.25   # 5-minutni TTL (1h bi bio 2.0×)
CACHE_READ_MULT = 0.10


def project_dir(repo_root: pathlib.Path) -> pathlib.Path:
    slug = re.sub(r"[^A-Za-z0-9]", "-", str(repo_root))
    return pathlib.Path.home() / ".claude" / "projects" / slug


def parse_since(value: str | None) -> float | None:
    if not value:
        return None
    now = datetime.now()
    for fmt in ("%H:%M", "%H:%M:%S"):
        try:
            t = datetime.strptime(value, fmt)
            return now.replace(hour=t.hour, minute=t.minute,
                               second=t.second, microsecond=0).timestamp()
        except ValueError:
            pass
    return datetime.fromisoformat(value).timestamp()


def record_ts(rec: dict) -> float | None:
    ts = rec.get("timestamp")
    if not ts:
        return None
    try:
        return datetime.fromisoformat(ts.replace("Z", "+00:00")).astimezone().timestamp()
    except ValueError:
        return None


def collect(repo_root: pathlib.Path, since: float | None, until: float | None = None):
    """→ {(uloga, model): {in, cw, cr, out, msgs}}"""
    pdir = project_dir(repo_root)
    totals: dict[tuple[str, str], dict[str, int]] = {}
    if not pdir.is_dir():
        return totals, pdir

    for f in pdir.glob("*.jsonl"):
        role = None
        seen: set[str] = set()
        rows = []
        try:
            with f.open(encoding="utf-8", errors="replace") as fh:
                for line in fh:
                    try:
                        rec = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    rtype = rec.get("type")
                    if rtype in ("agent-name", "custom-title"):
                        name = rec.get("agentName") or rec.get("customTitle")
                        if name in ROLES:
                            role = name
                        continue
                    if rtype != "assistant":
                        continue
                    msg = rec.get("message") or {}
                    usage = msg.get("usage")
                    mid = msg.get("id")
                    if not usage or not mid or mid in seen:
                        continue
                    if since is not None or until is not None:
                        ts = record_ts(rec)
                        if ts is not None:
                            if since is not None and ts < since:
                                continue
                            if until is not None and ts > until:
                                continue
                    seen.add(mid)
                    rows.append((msg.get("model") or "?", usage))
        except OSError:
            continue

        bucket_role = role or "ostalo"
        for model, usage in rows:
            key = (bucket_role, model)
            acc = totals.setdefault(key, {"in": 0, "cw": 0, "cr": 0, "out": 0, "msgs": 0})
            acc["in"] += usage.get("input_tokens", 0) or 0
            acc["cw"] += usage.get("cache_creation_input_tokens", 0) or 0
            acc["cr"] += usage.get("cache_read_input_tokens", 0) or 0
            acc["out"] += usage.get("output_tokens", 0) or 0
            acc["msgs"] += 1
    return totals, pdir


def cost(model: str, a: dict[str, int]) -> float | None:
    price = PRICES.get(model)
    if not price:
        return None
    inp, out = price
    return (a["in"] * inp
            + a["cw"] * inp * CACHE_WRITE_MULT
            + a["cr"] * inp * CACHE_READ_MULT
            + a["out"] * out) / 1_000_000


def human(n: int) -> str:
    return f"{n/1_000_000:.2f}M" if n >= 1_000_000 else f"{n/1_000:.1f}k" if n >= 1_000 else str(n)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--since", help="HH:MM ili ISO vrijeme — broji samo poruke od tada")
    ap.add_argument("--until", help="HH:MM ili ISO vrijeme — gornja granica (za mjerenje jednog kruga)")
    ap.add_argument("--json", action="store_true", help="strojno čitljiv ispis")
    ap.add_argument("--watch", type=int, metavar="SEK",
                    help="petlja: ispiši liniju kad se potrošnja promijeni")
    ap.add_argument("--all", action="store_true",
                    help="uključi i sesije bez uloge (ovaj chat, drugi prozori)")
    args = ap.parse_args()

    repo_root = pathlib.Path(__file__).resolve().parent.parent
    since = parse_since(args.since)
    until = parse_since(args.until)

    def snapshot():
        totals, pdir = collect(repo_root, since, until)
        if not args.all:
            totals = {k: v for k, v in totals.items() if k[0] in ROLES}
        return totals, pdir

    if args.watch:
        prev = -1
        while True:
            totals, _ = snapshot()
            tok = sum(a["in"] + a["cw"] + a["cr"] + a["out"] for a in totals.values())
            usd = sum(cost(m, a) or 0 for (_, m), a in totals.items())
            if tok != prev:
                per_role = " · ".join(
                    f"{r}:{human(sum(v[k] for k in ('in', 'cw', 'cr', 'out')))}"
                    for r in ROLES
                    for (rr, _), v in [(k, v) for k, v in totals.items() if k[0] == r][:1]
                )
                print(f"{datetime.now():%H:%M:%S} TROŠAK {human(tok)} tokena "
                      f"≈ ${usd:.2f} (API cjenik) · {per_role}", flush=True)
                prev = tok
            time.sleep(args.watch)

    totals, pdir = snapshot()
    if args.json:
        print(json.dumps({
            "project_dir": str(pdir),
            "since": args.since,
            "rows": [{"role": r, "model": m, **a, "usd": cost(m, a)}
                     for (r, m), a in sorted(totals.items())],
        }, ensure_ascii=False, indent=2))
        return 0

    if not totals:
        print(f"Nema podataka u {pdir} (je li tim pokrenut preko scripts/tim.sh?)")
        return 1

    print(f"izvor: {pdir}")
    if args.since or args.until:
        print(f"okvir: {args.since or 'početak'} → {args.until or 'sada'}")
    print()
    hdr = f"{'ULOGA':<12} {'MODEL':<16} {'ULAZ':>8} {'CACHE-W':>9} {'CACHE-R':>9} {'IZLAZ':>8} {'PORUKA':>7} {'≈USD':>8}"
    print(hdr)
    print("-" * len(hdr))
    order = {r: i for i, r in enumerate(ROLES)}
    tot = {"in": 0, "cw": 0, "cr": 0, "out": 0, "msgs": 0}
    usd_total = 0.0
    for (role, model), a in sorted(totals.items(), key=lambda kv: (order.get(kv[0][0], 9), kv[0][1])):
        c = cost(model, a)
        usd_total += c or 0
        for k in tot:
            tot[k] += a[k]
        print(f"{role:<12} {model:<16} {human(a['in']):>8} {human(a['cw']):>9} "
              f"{human(a['cr']):>9} {human(a['out']):>8} {a['msgs']:>7} "
              f"{('$%.2f' % c) if c is not None else '?':>8}")
    print("-" * len(hdr))
    print(f"{'UKUPNO':<12} {'':<16} {human(tot['in']):>8} {human(tot['cw']):>9} "
          f"{human(tot['cr']):>9} {human(tot['out']):>8} {tot['msgs']:>7} {'$%.2f' % usd_total:>8}")
    grand = tot["in"] + tot["cw"] + tot["cr"] + tot["out"]
    print(f"\nsvi tokeni: {human(grand)}  ·  izlaz (stvarno generirano): {human(tot['out'])}")
    print("USD je API cjenik (opus-5 $5/$25, fable-5 $10/$50 po MTok; cache write 1.25×, read 0.1×).")
    print("Vlasnik je na Claude Max pretplati — iznos je 'koliko bi stajalo preko API-ja', ne račun.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
