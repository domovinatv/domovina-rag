#!/usr/bin/env bash
# tim-read.sh <uloga> [linija] — pročitaj zadnjih N linija iz panela (default 80).
#
#   ./scripts/tim-read.sh dev1
#   ./scripts/tim-read.sh reviewer 200
#
# Session se izvodi iz repo direktorija (tim-<repo-slug>, vidi tim-common.sh).
# Prazne linije se kolabiraju (Claude TUI ih baca na desetke) da ti capture
# ne pojede kontekst.
set -euo pipefail
. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"

role="${1:-}"
lines="${2:-80}"
[ -n "$role" ] || { echo "upotreba: tim-read.sh <planner|orkestrator|reviewer|dev1|dev2> [linija]" >&2; exit 1; }

pane=$(tim_pane "$role")
[ -n "$pane" ] || { echo "GREŠKA: uloga '$role' nije registrirana u sessionu '$(tim_session_name)'." >&2; exit 1; }

tmux capture-pane -p -t "$pane" -S "-$lines" | cat -s
