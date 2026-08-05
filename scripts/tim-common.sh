#!/usr/bin/env bash
# tim-common.sh — zajedničko za tim.sh i tim-{send,read,status}.sh.
# Sourcaj, ne pokreći:  . "$(dirname "$0")/tim-common.sh"
#
# Ime sessiona je izvedeno iz imena repo direktorija: domovina.ai → tim-domovina-ai.
# Tako na istom Macu paralelno rade timovi za više projekata bez kolizije, a
# `tmux ls | grep '^tim-'` ih izlista sve.
#
# GOTCHA 1: tmux radi PREFIX matching na imenima sessiona — `-t tim` bi pogodio
# tim-domovina-ai ili tim-rodj, ovisno o tome što postoji. Zato has-session /
# attach / kill-session / list-panes idu kroz tim_target() s `=` prefiksom
# (egzaktan match).
#
# GOTCHA 2 (izmjereno na tmux 3.5a): `set-option` / `show-options` /
# `rename-window` NE prihvaćaju `=` prefiks — jave "no such session: =ime".
# Njima ide golo ime kroz tim_opt_target(). To je sigurno jer tmux egzaktno
# ime traži PRIJE prefiksa, pa `-t tim-domovina-ai` nikad ne odluta na drugi
# session dok taj postoji.

tim_repo_root() { (cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd); }

tim_session_name() {
  if [ -n "${TIM_SESSION:-}" ]; then printf '%s' "$TIM_SESSION"; return; fi
  local slug
  slug=$(printf '%s' "$(basename "$(tim_repo_root)")" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9_-]+/-/g; s/^-+//; s/-+$//')
  [ -n "$slug" ] || slug=repo
  printf 'tim-%s' "$slug"
}

# Egzaktan target — has-session, attach, kill-session, list-panes, capture-pane.
tim_target() { printf '=%s' "$(tim_session_name)"; }

# Target za set-option/show-options/rename-window (ne primaju `=`).
tim_opt_target() { tim_session_name; }

# Uloga → pane ID (mapu postavlja tim.sh u tmux user opcije @tim_<uloga>).
tim_pane() { tmux show -v -t "$(tim_opt_target)" "@tim_$1" 2>/dev/null || true; }

# Uloge NISU hardkodirane: tim.sh ih upiše u session opciju @tim_roles pri
# dizanju, pa isti helperi rade i za drukčiju postavu (npr. istraživački tim iz
# docs/ai-tim-istrazivanje.md). Fallback vrijedi samo ako session ne radi.
tim_roles() {
  local r
  r=$(tmux show -v -t "$(tim_opt_target)" @tim_roles 2>/dev/null || true)
  printf '%s' "${r:-planner orkestrator reviewer dev1 dev2}"
}
TIM_ROLES=$(tim_roles)
