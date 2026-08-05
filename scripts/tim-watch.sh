#!/usr/bin/env bash
# tim-watch.sh — nadzornik AI tima: prati sve panele i javlja SAMO događaje na
# koje se reagira. Svaka linija na stdout je jedan događaj (format za Monitor /
# `tail -f`), a povijest ide u .tim/watch.log.
#
#   ./scripts/tim-watch.sh            # petlja (default svakih 20 s)
#   ./scripts/tim-watch.sh --once     # jedan prolaz pa izlaz
#   TIM_WATCH_INTERVAL=10 ./scripts/tim-watch.sh
#
# Što javlja:
#   GOTOV      dev (samo dev1/dev2) stao i ispisao SAŽETAK
#   MIRUJE     dev stao BEZ sažetka (sumnjivo — prekid ili greška); NE javlja se
#              za panel koji je upravo očišćen s /clear (ctx: 0). Planner,
#              orkestrator i reviewer se namjerno NE prate ovako: oni se nakon
#              svakog odgovora vraćaju u mirovanje i alarm bi bio neprekidan.
#   BLOKIRAN   panel čeka odgovor (picker "Enter to select" / dijalog)
#   NEPOSLANO  u input boxu stoji utipkan tekst koji nitko nije poslao (>40 s)
#              — tiha zamka: svi čekaju, a poruka nikad nije stigla
#   GREŠKA     u panelu je API/tool greška, rate limit, crash
#   KONTEKST   panel prešao 70 % konteksta (vrijeme za /compact ili /clear)
#   VERDIKT    reviewer je zapisao novi .tim/reviews/*.md
#   COMMIT     HEAD se pomaknuo (orkestratorova integracija)
#   PAŽNJA     commit aplikacijskog koda BEZ zabilježenog verdikta — kršenje
#              pravila "review prije commita" (tooling commitovi se ne broje)
#   PANEL      panel je nestao (zatvoren/ugašen)
#   TIM        session je nestao → watcher staje
#
# NAMJERNO ne javlja početke radova ni svaku promjenu stanja — inače bi
# nadzor bio bučniji od samog tima.
#
# Watcher NIŠTA ne šalje panelima i ništa ne mijenja u repou. Čisti promatrač.
set -uo pipefail   # bez -e: nadzornik mora preživjeti tranzijentne greške
. "$(cd "$(dirname "$0")" && pwd)/tim-common.sh"

SESSION=$(tim_session_name)
TARGET=$(tim_target)
ROOT=$(tim_repo_root)
INTERVAL="${TIM_WATCH_INTERVAL:-20}"
ONCE=0
[ "${1:-}" = "--once" ] && ONCE=1

mkdir -p "$ROOT/.tim/reviews"
LOG="$ROOT/.tim/watch.log"

emit() {
  printf '%s %s\n' "$(date +%H:%M:%S)" "$1"
  printf '%s %s\n' "$(date '+%F %T')" "$1" >> "$LOG"
}

snap() { tmux capture-pane -p -t "$1" -S -40 2>/dev/null | cat -s; }

# Marker skupovi. Držani kao fiksni stringovi (BSD grep + multibajtni TUI znaci).
is_blocked() { printf '%s' "$1" | grep -qE 'Enter to select|Tab/Arrow keys|Do you want to|❯ 1\. Yes'; }
has_error()  { printf '%s' "$1" | grep -qE 'API Error|Request timed out|rate limit|Overloaded|usage limit reached|Killed: 9|command not found|Segmentation fault|Traceback \(most recent'; }
# Kraj devovog rada: doslovni marker ILI strukturni naslovi koje modeli
# stvarno ispisuju (uhvaćeno u radu — dev2 je završio bez riječi "SAŽETAK").
has_summary() { printf '%s' "$1" | grep -qiE 'SAŽETAK|SAZETAK|Verifikacij|Namjerno nedovršeno|Promijenjeni fajlovi|za orkestratora'; }
# Svjež/očišćen panel: /clear obriše transkript pa i sažetak nestane — to nije
# tihi prekid nego uredan kraj kruga (uhvaćeno kad je orkestrator poslao /clear
# objema devovima nakon VERDIKT: OK).
is_cleared() { printf '%s' "$1" | grep -q 'ctx: 0/'; }
# Neposlan tekst: zadnjih 6 linija panela, red koji počinje promptom "❯" i ima
# sadržaj = poruka stoji u input boxu. (Povijesni "❯ …" redovi su gore u
# transkriptu, zato gledamo samo dno.)
#
# GOTCHA 1: iza prompta NIJE obični razmak nego U+00A0 (c2 a0) — uzorak "^❯ ."
# nikad ne pogodi živi slučaj, a sintetički test s običnim razmakom prođe.
#
# GOTCHA 2 (izmjereno 2026-07-25): Claude Code u prazan input box upisuje
# PRIJEDLOG sljedeće poruke, tamnosivim tekstom. Po sadržaju je neraspoznatljiv
# od pravog neposlanog unosa — prva verzija ovog detektora je zato prijavljivala
# prijedloge kao "korisnikova poruka čeka Enter" i generirala krive savjete.
# Razlika je isključivo u stilu (izmjereno preko capture-pane -e, ista linija,
# isti panel):
#     pravi utipkan unos → SGR [39]        (obična boja)
#     prijedlog sučelja  → SGR [39, 2, 0]  ← SGR 2 = faint
# (Poslane poruke u transkriptu nose [38;5;239, 48;5;237] jer su u okviru s
# pozadinom — njih ionako ne gledamo, uzima se samo ZADNJA ❯ linija = input box.)
# Zato se linija hvata SA escape kodovima i odbacuje ako nosi faint atribut.
pending_input() {
  tmux capture-pane -p -e -t "$1" -S -8 2>/dev/null \
    | grep -a '❯' | tail -1 \
    | grep -av $'\033\[2m' \
    | LC_ALL=C sed $'s/\033\\[[0-9;]*m//g' \
    | sed 's/[[:space:]]*$//' \
    | grep -E '^❯.*[[:alnum:]/]' | cut -c1-60
}

ctx_pct() {
  # footer: "ctx: 134.4k/1.0M (13%)"
  printf '%s' "$1" | grep -oE 'ctx: [^)]*\(([0-9]+)%\)' | tail -1 | grep -oE '\(([0-9]+)%\)' | tr -dc '0-9'
}

ROLES=(planner orkestrator reviewer dev1 dev2)
PREV_SNAP=(); PREV_BUSY=(); PREV_BLOCK=(); PREV_ERR=(); PREV_CTX=(); PREV_PEND=(); PEND_WARNED=()
for i in "${!ROLES[@]}"; do PREV_SNAP[$i]=""; PREV_BUSY[$i]=0; PREV_BLOCK[$i]=0; PREV_ERR[$i]=0; PREV_CTX[$i]=0; PREV_PEND[$i]=""; PEND_WARNED[$i]=""; done
SEEN_REVIEWS=$(ls "$ROOT"/.tim/reviews/*.md 2>/dev/null | tr '\n' ' ')
PREV_HEAD=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)
VERDICTS_SINCE_COMMIT=0

emit "TIM watcher pokrenut na sessionu $SESSION (interval ${INTERVAL}s)"

while :; do
  if ! tmux has-session -t "$TARGET" 2>/dev/null; then
    emit "TIM session $SESSION je nestao — watcher staje"
    exit 0
  fi

  for i in "${!ROLES[@]}"; do
    role="${ROLES[$i]}"
    pane=$(tim_pane "$role")
    if [ -z "$pane" ] || ! tmux list-panes -t "$TARGET" -F '#{pane_id}' 2>/dev/null | grep -qx "$pane"; then
      [ "${PREV_BUSY[$i]}" = "gone" ] || { emit "PANEL $role je nestao"; PREV_BUSY[$i]=gone; }
      continue
    fi

    cur=$(snap "$pane")
    busy=0
    [ -n "${PREV_SNAP[$i]}" ] && [ "$cur" != "${PREV_SNAP[$i]}" ] && busy=1

    # BLOKIRAN — čeka odgovor. Javi jednom po pojavi.
    if is_blocked "$cur"; then
      [ "${PREV_BLOCK[$i]}" -eq 1 ] || emit "BLOKIRAN $role čeka odgovor (picker/dijalog) — pogledaj: ./scripts/tim-read.sh $role"
      PREV_BLOCK[$i]=1
    else
      PREV_BLOCK[$i]=0
    fi

    # GREŠKA — javi jednom dok traje.
    if has_error "$cur"; then
      [ "${PREV_ERR[$i]}" -eq 1 ] || emit "GREŠKA u panelu $role — ./scripts/tim-read.sh $role 60"
      PREV_ERR[$i]=1
    else
      PREV_ERR[$i]=0
    fi

    # Prijelaz rad → mirovanje. SAMO za devove: planner, orkestrator i reviewer
    # se poslije svakog odgovora legitimno vrate u mirovanje, pa bi ih ovo
    # prijavljivalo bez prestanka (uhvaćeno u prvom satu rada).
    case "$role" in
      dev1|dev2)
        if [ "${PREV_BUSY[$i]}" = "1" ] && [ "$busy" -eq 0 ]; then
          if has_summary "$cur"; then
            emit "GOTOV $role je završio i ispisao SAŽETAK"
          elif is_cleared "$cur"; then
            : # orkestrator je očistio kontekst nakon verdikta — normalno
          elif ! is_blocked "$cur"; then
            emit "MIRUJE $role je stao bez SAŽETKA — provjeri je li prekinut"
          fi
        fi ;;
    esac
    [ "${PREV_BUSY[$i]}" = "gone" ] || PREV_BUSY[$i]=$busy

    # Neposlan tekst u input boxu — javi tek ako preživi dva ciklusa (da se ne
    # javlja dok korisnik tipka) i nikad za planner (ondje čovjek piše stalno).
    if [ "$role" != "planner" ]; then
      pend=$(pending_input "$pane")
      if [ -n "$pend" ] && [ "$pend" = "${PREV_PEND[$i]}" ] && [ "$pend" != "${PEND_WARNED[$i]}" ]; then
        emit "NEPOSLANO $role ima utipkan tekst koji nije poslan: ${pend}"
        PEND_WARNED[$i]="$pend"
      fi
      [ -n "$pend" ] || PEND_WARNED[$i]=""
      PREV_PEND[$i]="$pend"
    fi

    # Kontekst preko 70 % — jednom po prelasku praga.
    pct=$(ctx_pct "$cur"); pct=${pct:-0}
    if [ "$pct" -ge 70 ] 2>/dev/null && [ "${PREV_CTX[$i]}" -lt 70 ]; then
      emit "KONTEKST $role na ${pct}% — vrijeme za /compact (u tijeku) ili /clear (nakon verdikta)"
    fi
    PREV_CTX[$i]=$pct
    PREV_SNAP[$i]="$cur"
  done

  # Novi verdikt reviewera.
  for f in "$ROOT"/.tim/reviews/*.md; do
    [ -e "$f" ] || continue
    case " $SEEN_REVIEWS " in
      *" $f "*) ;;
      *) emit "VERDIKT $(basename "$f"): $(head -1 "$f")"
         SEEN_REVIEWS="$SEEN_REVIEWS $f"
         VERDICTS_SINCE_COMMIT=$((VERDICTS_SINCE_COMMIT + 1)) ;;
    esac
  done

  # Integracija: pomak HEAD-a + provjera invarijante "review prije commita".
  head=$(git -C "$ROOT" rev-parse HEAD 2>/dev/null || echo none)
  if [ "$head" != "$PREV_HEAD" ] && [ "$head" != none ]; then
    subj=$(git -C "$ROOT" log -1 --format='%h %s' 2>/dev/null)
    emit "COMMIT $subj"
    # Tooling commitovi (skripte tima, njihove komande i doc) ne trebaju verdikt.
    appfiles=$(git -C "$ROOT" show --name-only --format= HEAD 2>/dev/null \
      | grep -vE '^scripts/tim|^\.claude/commands/|^docs/ai-tim-tmux\.md$' | grep -v '^$' | head -5)
    # Ni release commit: deploy.sh mehanički bumpa verziju u pubspec.yaml i
    # appVersion konstantu u main.dart — nema što recenzirati.
    # Commit koji ne dira kod (samo dokumentacija) također ne treba verdikt.
    codefiles=$(printf '%s' "$appfiles" | grep -vE '^docs/|\.md$' || true)
    [ -z "$codefiles" ] && appfiles=""
    case "$subj" in
      *"chore(release)"*)
        others=$(printf '%s' "$appfiles" | grep -vE '^pubspec\.yaml$|^lib/main\.dart$' || true)
        [ -z "$others" ] && appfiles=""
        ;;
    esac
    if [ -n "$appfiles" ] && [ "$VERDICTS_SINCE_COMMIT" -eq 0 ]; then
      emit "PAŽNJA commit dira kod bez zabilježenog verdikta reviewera: $(printf '%s' "$appfiles" | tr '\n' ' ')"
    fi
    VERDICTS_SINCE_COMMIT=0
    PREV_HEAD=$head
  fi

  [ "$ONCE" -eq 1 ] && break
  sleep "$INTERVAL"
done
