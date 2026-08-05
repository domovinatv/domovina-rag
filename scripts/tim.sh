#!/usr/bin/env bash
# tim.sh — "AI tim" oneliner: 1 tmux session s 5 Claude Code panela, 100% YOLO.
#
#   ┌──────────────┬──────────────┬──────────────┐
#   │              │ orkestrator  │    dev1      │
#   │   planner    │   (fable)    │   (opus)     │
#   │   (opus)     ├──────────────┼──────────────┤
#   │   ◀ TI       │  reviewer    │    dev2      │
#   │  promptaš    │   (fable)    │   (opus)     │
#   └──────────────┴──────────────┴──────────────┘
#      36%              32%             32%
#
# Ti promptaš SAMO u lijevom (planner) panelu. Kad je plan gotov, kažeš "daj
# timu" (ili /delegiraj) i plan ide orkestratoru, koji ga razbija na taskove za
# dev1/dev2, pa nakon njih pušta reviewera. Ostala četiri panela rade autonomno
# i primaju upute jedan od drugoga preko scripts/tim-send.sh — nitko od njih ne
# smije pisati u planner panel (helper to odbija s izlazom 2).
#
# Pokretanje (prazan iTerm2 window, ⌘+Enter za fullscreen):
#   cd ~/git/domovinatv/domovina-rag && ./scripts/tim.sh
#
# Planneru se pri dizanju automatski pošalje /pocni. Isključivanje: TIM_AUTOSTART=0
#
# Modeli:
#   TIM_MODEL_PLAN=opus TIM_MODEL_ORCH=fable TIM_MODEL_REVIEW=fable \
#   TIM_MODEL_DEV=opus ./scripts/tim.sh
#
# ⚠️ OVAJ REPO PIŠE U PRODUKCIJSKE BAZE. Za razliku od domovina.ai (gdje je
# najgori ishod krivo iscrtan ekran), ovdje jedan ETL run ili `psql -f` može
# zagaditi cloud PG koji poslužuje živi /api/person. Zato:
#   • migracije i `--cloud` sync pokreće ISKLJUČIVO orkestrator, i to tek nakon
#     VERDIKT: OK — nikad dev usred taska;
#   • svaka destruktivna operacija (DELETE, DROP, full-refresh) ide prvo nad
#     LOKALNIM PG/CH, pa tek onda nad cloudom;
#   • plan koji dira `infra/postgres/migrations/` ili `scripts/sync-*.sh` nosi
#     Rizik: visok → orkestrator digne reviewera na Opus (`/model opus`).
# `--dangerously-skip-permissions` je na svim panelima po odluci vlasnika repoa
# (git je sigurnosna mreža za KOD, ali ne i za bazu — otud gornja pravila).
#
# Zašto NE worktree po devu: docker compose profili, `.env` i montirani diskovi
# vise o putanji repoa; worktree bi ih razbio. Izolaciju čuva pravilo
# "disjunktni fajlovi" iz plana — zato je popis fajlova po tasku obavezan.
#
# Popis svih timova:  tmux ls | grep '^tim-'
# Gašenje SAMO ovog:  ./scripts/tim-kill.sh
set -euo pipefail

. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"
SESSION=$(tim_session_name)     # tim-domovina-rag
TARGET=$(tim_target)            # "=$SESSION" — egzaktan match
OPT=$(tim_opt_target)           # golo ime — set-option ne prima "="
MODEL_PLAN="${TIM_MODEL_PLAN:-opus}"
MODEL_ORCH="${TIM_MODEL_ORCH:-fable}"
MODEL_REVIEW="${TIM_MODEL_REVIEW:-fable}"
MODEL_DEV="${TIM_MODEL_DEV:-opus}"
ROLES="planner orkestrator reviewer dev1 dev2"
cd "$(cd "$(dirname "$0")/.." && pwd)"

command -v tmux >/dev/null 2>&1 || { echo "tmux fali — instaliram (brew)…"; brew install tmux; }
command -v claude >/dev/null 2>&1 || { echo "GREŠKA: 'claude' CLI nije u PATH-u"; exit 1; }

# Ako si ovo pokrenuo IZ panela drugog tima, naslijeđeni TIM_SESSION bi te
# attachao na taj tuđi session umjesto da digne ovaj. Ime je izvedeno iz imena
# repo direktorija, pa nesklad znači naslijeđenu okolinu.
EXPECTED="tim-$(basename "$PWD" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9_-]+/-/g')"
if [ -n "${TIM_SESSION:-}" ] && [ "$TIM_SESSION" != "$EXPECTED" ]; then
  echo "GREŠKA: TIM_SESSION='$TIM_SESSION' naslijeđen iz okoline, a ovaj repo je '$EXPECTED'."
  echo "Pokrećeš li ovo iz panela drugog tima? Otvori čist iTerm prozor, ili:"
  echo "  env -u TIM_SESSION ./scripts/tim.sh"
  exit 1
fi

if tmux has-session -t "$TARGET" 2>/dev/null; then
  echo "Session '$SESSION' već postoji — attacham."
  exec tmux attach -t "$TARGET"
fi

mkdir -p .tim/reviews
: > .tim/status.line

# ── Uloge u system promptu ────────────────────────────────────────────────
# Ovdje ide ono što vrijedi UVIJEK; ritual (što netko pokrene) je u
# .claude/commands/*.md.
REPO_RULES='Repo je domovina-rag — data consumer i agent backend za hrvatski podcast korpus (ClickHouse + PostgreSQL + MCP server na mcp.domovina.ai). CLAUDE.md u rootu je OBAVEZNO štivo prije prvog zadatka; docs/person-hub.md i docs/person-data-gaps.md su izvor istine za person hub. Producer je zaseban repo (../fetch.domovina.tv) i NE dira se odavde; frontend je ../domovina.ai i NE dira se odavde. Verifikacija: za TypeScript izmjene `cd services/mcp && npm run typecheck` mora biti čist; za Python/ETL izmjene `python -m pytest services/etl/tests -q`. GRANICE KOJE SE NE POPUŠTAJU: nijedna migracija, `--cloud` sync ni ručni psql nad PRODUKCIJSKOM bazom bez izričite potvrde — sve se prvo dokazuje lokalno; nijedan secret ne ulazi u repo (sve kroz .env); init.sql se NE re-runa ni na PG ni na CH, promjena sheme ide kao nova migracija u infra/postgres/migrations/.'

planner_prompt() {
  printf 'Ti si PLANNER — lijevi panel AI tima u tmux sessionu "%s"; ovdje korisnik promptira izravno i ovo mu je glavni chat. Tvoj posao je istraživanje koda, dijalog s korisnikom i pisanje plana, a NE izvođenje većih zahvata: kad je plan gotov i korisnik kaže "daj timu" (ili pokrene /delegiraj), plan zapiši u docs/plans/ i pošalji ga orkestratoru — pravila su u .claude/commands/delegiraj.md. Dok tim radi, TI NE MIJENJAŠ kod (dev1 i dev2 dijele isti radni direktorij i pregazili biste se) — smiješ pisati samo docs/plans/*. Read-only upiti nad LOKALNIM PG/CH su ti dopušteni radi mjerenja; pisanje u bilo koju bazu nije. Status tima čitaš sa scripts/tim-status.sh i scripts/tim-read.sh, nikad ne šalješ poruke u svoj vlastiti panel. %s' "$SESSION" "$REPO_RULES"
}
orch_prompt() {
  printf 'Ti si ORKESTRATOR AI tima u tmux sessionu "%s" (paneli: planner, dev1, dev2, reviewer). Na početku sessiona pročitaj .claude/commands/tim.md — to su tvoja pravila rada; poslove ti šalje planner kao putanju do plana u docs/plans/. Ti si jedini koji commita, integrira i pokreće migracije, ETL runove i sync skripte — i to tek nakon VERDIKT: OK. NIKAD ne šalji poruke u planner panel (korisnik ondje tipka); status javljaš preko scripts/tim-status.sh set "…". %s' "$SESSION" "$REPO_RULES"
}
review_prompt() {
  printf 'Ti si REVIEWER AI tima u tmux sessionu "%s". Pravila su u .claude/commands/pregled.md — pročitaj ih kad dobiješ prvi zadatak. Ne mijenjaš kod NIKAD: čitaš git diff radnog stabla, uspoređuješ ga s planom, pokrećeš typecheck/testove iz plana, pa pišeš verdikt u .tim/reviews/. Najstrože gledaš sve što piše u bazu ili mijenja shemu: idempotentnost re-runa, ponašanje na djelomičnom ulazu, i je li destruktivna operacija ograničena na lokalnu bazu. Budi strog ali konkretan: svaki nalaz mora imati fajl:liniju i posljedicu, bez stilskih dlakocjepstava — lažan nalaz troši cijeli krug deva. %s' "$SESSION" "$REPO_RULES"
}
dev_prompt() {
  printf 'Ti si %s — izvršni developer u AI timu (tmux session "%s"). Taskove ti šalje orkestrator, a tvoj rad pregledava reviewer i može ti vratiti dorade — dorade radiš bez rasprave, u istom kontekstu. Radi TOČNO opisani task, ništa šire: ne diraj fajlove izvan opsega jer paralelno radi drugi dev u istom direktoriju. NE commitaj, NE pushaj, NE pokreći migracije, ETL runove ni sync skripte nad cloudom — to radi orkestrator. Ne vjeruj ni zadatku: pretpostavke koje dobiješ provjeri i reci ako su netočne. Kad završiš, zadnji blok odgovora MORA počinjati linijom koja glasi točno "SAŽETAK" (velikim slovima, sama u redu) — po njoj te nadzor prepoznaje kao gotovog. Ispod nje: promijenjeni fajlovi, kako je verificirano, i što si NAMJERNO ostavio nedovršeno. Dokumentacija je hrvatski, kod i identifikatori engleski. %s' "$1" "$SESSION" "$REPO_RULES"
}

# tmux spaja višestruke argumente u JEDAN shell string, pa svaki mora biti
# shell-quoted (printf %q) — inače se system prompt raspadne na riječi.
q() { printf '%q ' "$@"; }
# TIM_SESSION eksplicitno u okolinu svakog panela: tmux paneli nasljeđuju
# okolinu tmux SERVERA, ne shella koji je pokrenuo skriptu.
ENVP="TIM_SESSION=$(printf '%q' "$SESSION") "
CMD_PLAN=$ENVP$(q claude --dangerously-skip-permissions \
  --model "$MODEL_PLAN" -n planner --append-system-prompt "$(planner_prompt)")
CMD_ORCH=$ENVP$(q claude --dangerously-skip-permissions \
  --model "$MODEL_ORCH" -n orkestrator --append-system-prompt "$(orch_prompt)")
CMD_REVW=$ENVP$(q claude --dangerously-skip-permissions \
  --model "$MODEL_REVIEW" -n reviewer --append-system-prompt "$(review_prompt)")
CMD_DEV1=$ENVP$(q claude --dangerously-skip-permissions \
  --model "$MODEL_DEV" -n dev1 --append-system-prompt "$(dev_prompt dev1)")
CMD_DEV2=$ENVP$(q claude --dangerously-skip-permissions \
  --model "$MODEL_DEV" -n dev2 --append-system-prompt "$(dev_prompt dev2)")

# Pane ID-evi (%N) su stabilni neovisno o base-index konfiguraciji korisnika.
P_PLAN=$(tmux new-session -d -s "$SESSION" -c "$PWD" -P -F '#{pane_id}' "$CMD_PLAN")
P_ORCH=$(tmux split-window -h -t "$P_PLAN" -c "$PWD" -l 64% -P -F '#{pane_id}' "$CMD_ORCH")
P_DEV1=$(tmux split-window -h -t "$P_ORCH" -c "$PWD" -l 50% -P -F '#{pane_id}' "$CMD_DEV1")
P_REVW=$(tmux split-window -v -t "$P_ORCH" -c "$PWD" -l 45% -P -F '#{pane_id}' "$CMD_REVW")
P_DEV2=$(tmux split-window -v -t "$P_DEV1" -c "$PWD" -l 50% -P -F '#{pane_id}' "$CMD_DEV2")

# Claude Code TUI pregazi pane_title, pa uloge držimo u tmux user opcijama:
# na paneu (@role, za border) i na sessionu (@tim_<uloga>, za lookup iz skripti).
set_role() {
  tmux set -p -t "$2" @role "$1"
  tmux set -t "$OPT" "@tim_$1" "$2"
  tmux select-pane -t "$2" -T "$1"
}
set_role planner     "$P_PLAN"
set_role orkestrator "$P_ORCH"
set_role reviewer    "$P_REVW"
set_role dev1        "$P_DEV1"
set_role dev2        "$P_DEV2"
# Popis uloga na sessionu → helperi ga čitaju umjesto hardkodirane liste.
tmux set -t "$OPT" @tim_roles "$ROLES"

cat > .tim/panes.env <<EOF
TIM_SESSION=$SESSION
TIM_PANE_PLANNER=$P_PLAN
TIM_PANE_ORKESTRATOR=$P_ORCH
TIM_PANE_REVIEWER=$P_REVW
TIM_PANE_DEV1=$P_DEV1
TIM_PANE_DEV2=$P_DEV2
EOF

tmux set -t "$OPT" pane-border-status top
# Marker samo na čovjekovom panelu — da se na prvi pogled zna gdje se tipka.
tmux set -t "$OPT" pane-border-format \
  ' #{pane_id} #{@role}#{?#{==:#{@role},planner}, ◀ TI TIPKAŠ OVDJE,} '
tmux set -t "$OPT" pane-active-border-style 'fg=colour39,bold'
tmux set -t "$OPT" mouse on
tmux set -w -t "$OPT" automatic-rename off
tmux rename-window -t "$OPT" tim

# Lijevo ime sessiona (prefix ) te zna odvesti u tuđi tim), desno status koji
# orkestrator osvježava — tako vidiš napredak bez da ti itko upada u panel.
tmux set -t "$OPT" status-interval 5
tmux set -t "$OPT" status-left-length 40
tmux set -t "$OPT" status-left " #S "
tmux set -t "$OPT" status-right-length 140
tmux set -t "$OPT" status-right "#(cat '$PWD/.tim/status.line' 2>/dev/null) "

tmux select-pane -t "$P_PLAN"

# Kickoff: /pocni čim TUI proradi. Ovo je JEDINI trenutak kad išta ide u
# planner panel — session je nov, korisnik još ne tipka.
if [ "${TIM_AUTOSTART:-1}" != "0" ]; then
  for _ in $(seq 40); do
    tmux capture-pane -p -t "$P_PLAN" -S -20 2>/dev/null | grep -qi 'bypass permissions' && break
    sleep 0.5
  done
  tmux send-keys -t "$P_PLAN" -l '/pocni'
  sleep 0.4
  tmux send-keys -t "$P_PLAN" Enter
fi

if [ -t 0 ]; then
  exec tmux attach -t "$TARGET"
else
  echo "Session '$SESSION' spreman — attachaj s: tmux attach -t =$SESSION"
fi
