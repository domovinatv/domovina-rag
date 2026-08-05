#!/usr/bin/env bash
# tim-send.sh <uloga> <poruka…> — pošalji JEDNU liniju u Claude Code panel.
#
#   ./scripts/tim-send.sh dev1 'Pročitaj docs/plans/2026-07-25-x.md pa izvrši task T1.'
#   ./scripts/tim-send.sh dev2 /clear
#
# Uloge: planner | orkestrator | reviewer | dev1 | dev2
#
# Zašto skripta a ne goli send-keys: session je per-projekt (tim-<repo-slug>,
# vidi tim-common.sh), pane ID se čita iz tmux user opcije (@tim_<uloga>) koju
# je postavio tim.sh, tekst ide u -l literal modu (ne interpretira se kao imena
# tipki, pa navodnici/$/- prolaze netaknuti), a Enter ide ODVOJENO nakon kratke
# pauze — Claude Code TUI inače proguta red.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"

SESSION=$(tim_session_name)
FORCE=0
[ "${1:-}" = "--force" ] && { FORCE=1; shift; }

role="${1:-}"; shift || true
msg="$*"
[ -n "$role" ] && [ -n "$msg" ] || {
  echo "upotreba: tim-send.sh [--force] <planner|orkestrator|reviewer|dev1|dev2> <poruka>" >&2
  exit 1
}

case "$msg" in
  *$'\n'*)
    echo "GREŠKA: poruka mora biti JEDNA linija — Claude TUI svaki \\n čita kao submit." >&2
    echo "       Dugi sadržaj zapiši u fajl pa pošalji putanju ('Pročitaj X pa izvrši')." >&2
    exit 1 ;;
esac

if [ "$role" = "planner" ] && [ "$FORCE" -eq 0 ]; then
  echo "ODBIJENO: u planner panel se ne šalje — ondje korisnik tipka i poruka bi mu" >&2
  echo "          upala usred prompta. Status javi s: scripts/tim-status.sh set \"…\"" >&2
  echo "          (ako baš moraš i znaš da je panel prazan: --force)" >&2
  exit 2
fi

pane=$(tim_pane "$role")
[ -n "$pane" ] || { echo "GREŠKA: uloga '$role' nije registrirana u sessionu '$SESSION'." >&2; exit 1; }
tmux list-panes -t "$(tim_target)" -F '#{pane_id}' | grep -qx "$pane" || {
  echo "GREŠKA: pane $pane ($role) više ne postoji — je li panel zatvoren?" >&2; exit 1; }

snap() { tmux capture-pane -p -t "$pane" -S -30 2>/dev/null | cat -s; }

# Zaštita konteksta: /clear i /compact poslani panelu KOJI RADI TUI stavi u
# red i izvrši ih čim task završi — pobrisao bi upravo ono što reviewer treba
# (ili prekinuo posao u tijeku). Zato ih šaljemo samo u panel u mirovanju.
case "$msg" in
  /clear*|/compact*)
    if [ "$FORCE" -eq 0 ]; then
      a=$(snap); sleep 1.0; b=$(snap)
      if [ "$a" != "$b" ]; then
        echo "ODBIJENO: $role trenutno RADI — '$msg' bi se izvršio čim završi i" >&2
        echo "          pobrisao kontekst prije nego što ga pročitaš/reviewer pregleda." >&2
        echo "          Pričekaj mirovanje (scripts/tim-status.sh) ili --force." >&2
        exit 3
      fi
    fi ;;
esac

before=$(snap)
tmux send-keys -t "$pane" -l "$msg"
sleep 0.4
tmux send-keys -t "$pane" Enter
echo "→ $role ($pane @ $SESSION): $msg"

# Potvrda isporuke: submit uvijek prerenda panel. Bez promjene je poruka
# najvjerojatnije ostala u input boxu (TUI je bio u dijalogu ili nije primio Enter).
sleep 0.8
[ "$(snap)" != "$before" ] || {
  echo "UPOZORENJE: panel se nije promijenio — poruka možda nije poslana." >&2
  echo "            Provjeri: ./scripts/tim-read.sh $role 20" >&2
  exit 4
}
