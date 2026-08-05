#!/usr/bin/env bash
# tim-kill.sh — ugasi tim OVOG repoa (i ničiji drugi).
#
#   ./scripts/tim-kill.sh          # pita ako neki panel još radi
#   ./scripts/tim-kill.sh -f       # bez pitanja
#
# Postoji da se ne tipka `tmux kill-session -t tim` — bez "=" prefiksa tmux
# radi prefix matching i može ubiti tim drugog projekta (vidi tim-common.sh).
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"

SESSION=$(tim_session_name)
TARGET=$(tim_target)
FORCE=0
[ "${1:-}" = "-f" ] && FORCE=1

tmux has-session -t "$TARGET" 2>/dev/null || { echo "Tim '$SESSION' ionako ne radi."; exit 0; }

if [ "$FORCE" -eq 0 ]; then
  busy=""
  for role in $TIM_ROLES; do
    pane=$(tim_pane "$role"); [ -n "$pane" ] || continue
    a=$(tmux capture-pane -p -t "$pane" -S -20 2>/dev/null | cat -s || true)
    sleep 0.5
    b=$(tmux capture-pane -p -t "$pane" -S -20 2>/dev/null | cat -s || true)
    [ "$a" != "$b" ] && busy="$busy $role"
  done
  if [ -n "$busy" ]; then
    echo "PAŽNJA: još rade:$busy" >&2
    echo "Nedovršen rad tih panela nestaje s gašenjem. Ponovi s -f ako si siguran." >&2
    exit 1
  fi
fi

tmux kill-session -t "$TARGET"
echo "Tim '$SESSION' ugašen. (Ostali timovi: $(tmux ls 2>/dev/null | grep -c '^tim-' || echo 0))"
