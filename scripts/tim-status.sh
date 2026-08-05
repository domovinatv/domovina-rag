#!/usr/bin/env bash
# tim-status.sh — stanje AI tima.
#
#   ./scripts/tim-status.sh                 # tko radi, tko čeka, zadnji verdikti
#   ./scripts/tim-status.sh set "T3 dev1 · T4 dev2 · review pending"
#                                           # ambijentalna linija u tmux status baru
#   ./scripts/tim-status.sh session         # ime tmux sessiona ovog projekta
#
# "set" je jedini način da orkestrator javi napredak korisniku a da mu NE
# upadne u planner panel — tmux status bar se osvježava svakih 5 s.
#
# BUSY/IDLE se mjeri iz DVA uzorka panela u razmaku od ~1.2 s: dok Claude Code
# radi, status linija broji vrijeme ("Puzzling… (1m 31s · ↓ 4.5k tokens…)"), pa
# se sadržaj mijenja. Tekstualni marker ("esc to interrupt") NIJE dovoljan —
# u 2.1.220 ga footer zna zamijeniti token/effort prikazom (uhvaćeno u radu).
# Panel zaglavljen u dijalogu izgleda kao IDLE — zato prije zaključka pogledaj
# scripts/tim-read.sh <uloga>.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"

SESSION=$(tim_session_name)
TARGET=$(tim_target)
ROOT=$(tim_repo_root)

case "${1:-}" in
  session)
    echo "$SESSION"; exit 0 ;;
  set)
    shift
    mkdir -p "$ROOT/.tim"
    printf '%s' "$*" > "$ROOT/.tim/status.line"
    echo "status: $*"
    exit 0 ;;
esac

tmux has-session -t "$TARGET" 2>/dev/null || { echo "Session '$SESSION' ne radi (pokreni ./scripts/tim.sh)." >&2; exit 1; }

snap() { tmux capture-pane -p -t "$1" -S -25 2>/dev/null | cat -s || true; }

echo "session: $SESSION"
declare -a PANES ROLESEEN FIRST
for role in $TIM_ROLES; do
  pane=$(tim_pane "$role")
  [ -n "$pane" ] || continue
  ROLESEEN+=("$role"); PANES+=("$pane"); FIRST+=("$(snap "$pane")")
done
sleep 1.2   # drugi uzorak — promjena sadržaja = panel radi

printf '%-12s %-5s %-6s %-6s %s\n' ULOGA PANE STANJE CTX 'ZADNJA LINIJA'
for i in "${!PANES[@]}"; do
  pane="${PANES[$i]}"
  second=$(snap "$pane")
  if [ "$second" != "${FIRST[$i]}" ] || printf '%s' "$second" | grep -qi 'esc to interrupt'; then
    state=BUSY
  else
    state=IDLE
  fi
  # Popunjenost konteksta iz footera ("ctx: 134.4k/1.0M (13%)") — signal
  # orkestratoru kad je devu vrijeme za /clear.
  ctx=$(printf '%s' "$second" | grep -oE 'ctx: [^ ]+' | tail -1 | cut -d' ' -f2 | cut -d/ -f1 || true)
  # Zadnja SADRŽAJNA linija: bez footera, okvira i praznog prompta. Filtri su
  # FIKSNI stringovi, ne bracket klase — okvir i ❯ su multibajtni, pa ih BSD
  # grep u [] ne hvata pouzdano.
  last=$(printf '%s' "$second" | sed 's/[[:space:]]*$//' \
    | grep -v '^$' | grep -v '^ *ctx:' | grep -v '⏵⏵' \
    | grep -v '^─' | grep -v '^ *❯$' | grep -v 'Tip:' \
    | tail -1 | cut -c1-55 || true)
  printf '%-12s %-5s %-6s %-6s %s\n' "${ROLESEEN[$i]}" "$pane" "$state" "${ctx:-–}" "$last"
done

if [ -s "$ROOT/.tim/status.line" ]; then
  printf '\nstatus bar: %s\n' "$(cat "$ROOT/.tim/status.line")"
fi

if compgen -G "$ROOT/.tim/reviews/*.md" > /dev/null; then
  echo
  echo "verdikti (.tim/reviews/):"
  for f in "$ROOT"/.tim/reviews/*.md; do
    printf '  %-40s %s\n' "$(basename "$f")" "$(head -1 "$f")"
  done
fi
