# scripts/lib/cron-path.sh — PATH za launchd okruženje. SOURCE-aj, ne izvršavaj.
#
# launchd daje samo /usr/bin:/bin:/usr/sbin:/sbin. Bez ovoga u cronu nedostaju:
#   docker  → /usr/local/bin
#   node/npx/gemini → nvm (~/.nvm/versions/node/vXX/bin)
#   gcloud  → ~/google-cloud-sdk/bin
#
# Zašto vlastiti fajl, a ne linija po skripti: linija JE bila po skripti (9 kopija
# `export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"`) i bila je kriva u svih 9 —
# na ovom Macu node nije u Homebrewu nego u nvm-u. Posljedica je bila nijema:
# `sync-stats.sh --deploy` je svaki dan ispisao "ERROR: npx/node nije instaliran",
# cron je to progutao kao WARN i nastavio s rc=0, pa je stats.domovina.ai tjednima
# posluživao stari build iako su snapshoti u public/ bili svježi. Isti je korijen
# rušio i LLM-imenovanje klastera mape osoba (gcloud i gemini također nisu bili na
# PATH-u) pa su nova imena klastera tiho padala na naslijeđena.
#
# Zašto se nvm verzija razrješava, a ne hardkodira: nvm drži traženu verziju u
# ~/.nvm/alias/default (npr. "24"), a direktorij je v24.16.0. Hardkodiran put bi
# pukao na prvoj nadogradnji nodea, s istim nijemim simptomom.
#
# Vidi docs/data-refresh-flow.md § PATH u cronu.

# Dodaj direktorij na početak PATH-a ako postoji i još nije unutra.
# Uvijek vraća 0 — pozivatelji rade pod `set -e`.
_dom_path_prepend() {
  if [ -d "$1" ]; then
    case ":$PATH:" in
      *":$1:"*) ;;
      *) PATH="$1:$PATH" ;;
    esac
  fi
  return 0
}

# node / npx / gemini — nvm, verzija iz `default` aliasa
if [ -r "$HOME/.nvm/alias/default" ]; then
  _dom_nvm_alias="$(cat "$HOME/.nvm/alias/default" 2>/dev/null || true)"
  if [ -n "${_dom_nvm_alias:-}" ]; then
    # alias "24" → najviša instalirana v24.*; alias "v24.16.0" → točno ta
    _dom_nvm_bin="$(ls -d "$HOME/.nvm/versions/node/v${_dom_nvm_alias#v}"* 2>/dev/null \
                    | sort -V | tail -1)"
    [ -n "${_dom_nvm_bin:-}" ] && _dom_path_prepend "$_dom_nvm_bin/bin"
  fi
  unset _dom_nvm_alias _dom_nvm_bin
fi

_dom_path_prepend "$HOME/google-cloud-sdk/bin"   # gcloud — imenovanje klastera
_dom_path_prepend /usr/local/bin                 # docker
_dom_path_prepend /opt/homebrew/bin              # ostali brew alati

export PATH
unset -f _dom_path_prepend
