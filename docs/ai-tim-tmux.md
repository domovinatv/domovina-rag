# AI tim u tmuxu — planner → orkestrator → dev1/dev2 → reviewer

Jedan iTerm2 prozor (fullscreen), pet Claude Code panela, jedan čovjek koji
promptira samo u jednom od njih. Pokretanje:

```bash
cd ~/git/domovinatv/domovina-rag && ./scripts/tim.sh     # ⌘+Enter za fullscreen
./scripts/tim-kill.sh                                    # gašenje SAMO ovog tima
```

```
┌──────────────┬──────────────┬──────────────┐
│              │ orkestrator  │    dev1      │
│   planner    │   (fable)    │   (opus)     │
│   (opus)     ├──────────────┼──────────────┤
│   ◀ TI       │  reviewer    │    dev2      │
│  promptaš    │   (fable)    │   (opus)     │
└──────────────┴──────────────┴──────────────┘
   36%              32%             32%
```

Lijevi stupac je tvoj chat; srednji je „management" (koordinacija + kontrola
kvalitete); desni su ruke. Border lijevog panela nosi marker
`◀ TI TIPKAŠ OVDJE` — jedini panel u koji čovjek smije pisati.

Ovaj postav je port iz `domovina.ai` (`docs/ai-tim-tmux.md` ondje ima puni
zapisnik odluka i mjerenja iz prvih krugova). Ovdje je zapisano **samo ono što
je drukčije jer je ovo data repo**, plus zajednička pravila koja moraš znati da
tim ne radi štetu.

## Što je ovdje drukčije nego u domovina.ai

**Najgori ishod nije krivo iscrtan ekran, nego zagađena produkcijska baza.**
`domovina.ai` je frontend iza feature flaga — rollback je jedan deploy. Ovdje
jedan `--cloud` sync ili `psql -f` mijenja podatke koje živi
`mcp.domovina.ai/api/person` poslužuje frontendu istog trena. Otud tri pravila
koja u drugom repou ne postoje:

1. **Devovi ne diraju baze osim lokalne, i to samo za čitanje/testiranje.**
   Migracije, ETL runove, `sync-*.sh` i `services/mcp/deploy.sh` pokreće
   **isključivo orkestrator**, i to tek nakon `VERDIKT: OK`.
2. **Lokalno prije clouda, uvijek.** Svaka destruktivna ili shema-mijenjajuća
   operacija prvo se dokaže nad lokalnim PG/CH, s izmjerenim brojkama, pa tek
   onda ide na produkciju.
3. **Shema ide kao migracija, nikad kao izmjena `init.sql`.** Ni PG ni CH ne
   re-runaju `init.sql` nakon prvog deploya — nova kolona bez migracije znači
   kod koji piše u kolonu koje nema (zapisano u `docs/person-hub.md`).

Verifikacija nema `flutter analyze`; umjesto njega:

```bash
cd services/mcp && npm run typecheck      # TypeScript: MCP server + REST API
python -m pytest services/etl/tests -q    # Python: ETL, speakers, mentions
```

Plus **ciljani SQL upit s očekivanom brojkom** — u data repou je to prava
verifikacija, a plan ga mora sadržavati (vidi `.claude/commands/delegiraj.md`,
pravilo 6).

**Uska grla za paralelizaciju** (pandan `app_hr.arb` zamci iz frontenda):
`services/etl/etl/sources.py` i `load.py` (dira ih gotovo svaki ETL task),
`services/mcp/src/public-api.ts` (sve REST rute na jednom mjestu),
`infra/postgres/init.sql`, `docker-compose.yml`. Dva taska koja trebaju isti od
tih fajlova moraju biti **serijska**.

**Dugi runovi izgledaju kao zaglavljen panel.** Dev koji čeka
`docker compose run … mentions --input /data` sat vremena je BUSY bez ijednog
novog retka. To nije zaglavljivanje — ne prekidaj ga.

**ClickHouse zna biti „Up, healthy" a ne odgovarati.** Izmjereno 29.07.2026.:
container zdrav, dva upita istekla nakon 60 s odnosno 120 s. Zato `/pocni`
provjerava CH pravim upitom (`SELECT 1`), ne `docker ps`-om.

## Podjela modela

| Panel | Model | Zašto |
|---|---|---|
| planner | **opus** | Kriva odluka u planu množi se s dva deva — tu ide najjači model. |
| orkestrator | **fable** | Dispatch, polling, čitanje sažetaka, git. Traži pouzdanost i brzinu, ne dubinu. |
| reviewer | **fable** (+ eskalacija) | Konformnost planu, typecheck, idempotentnost. Za *Rizik: visok* orkestrator mu pošalje `/model opus` prije pregleda. |
| dev1, dev2 | **opus** | Pisanje koda. |

Override preko env varijabli:
`TIM_MODEL_PLAN`, `TIM_MODEL_ORCH`, `TIM_MODEL_REVIEW`, `TIM_MODEL_DEV`.

⚠️ **Fable NIJE jeftiniji od Opusa — dvostruko je skuplji** (API cjenik: fable-5
$10/$50 po MTok, opus-5 $5/$25). Podjela stoji zbog *sposobnosti i brzine*
koordinacije, ne zbog cijene. Izmjereno u domovina.ai timu: orkestrator je bio
NAJSKUPLJI panel iako nije napisao ni retka koda — polling mu je napuhao
cache-read (2.4 M tokena). Ako trošak postane problem, prvo skrati polling
(neka orkestrator **blokira jednom** u `until` petlji umjesto da polla), pa tek
onda diraj podjelu modela.

**Rizik: visok** u ovom repou znači: migracija sheme, bilo koja `--cloud` sync
skripta, `services/mcp/deploy.sh`, destruktivna operacija nad produkcijskim
podacima, i svaka izmjena `/api/*` ugovora koji `domovina.ai` već troši.

## Petlja

0. **Kickoff je automatiziran** — `tim.sh` planneru pošalje `/pocni`
   (`.claude/commands/pocni.md`) čim mu TUI proradi: pročita ovaj doc i
   `delegiraj.md`, provjeri panele, stanje repoa i odgovaraju li CH/PG, javi ti
   to u 6 redaka i stane. Isključivanje: `TIM_AUTOSTART=0 ./scripts/tim.sh`.
1. **Ti u planneru** — normalan razgovor: istraživanje koda, mjerenje upitima,
   dogovor opsega.
2. **`/delegiraj`** (ili „daj timu") → planner zapiše
   `docs/plans/YYYY-MM-DD-<slug>.md` (Cilj, Kontekst, Taskovi s popisom
   fajlova, Ovisnosti, Rizik, Verifikacija, Van opsega) i pošalje orkestratoru
   `/tim izvrši plan iz docs/plans/….md`.
3. **Orkestrator** razbije plan i pošalje po jedan task dev1 i dev2 — samo ako
   su im popisi fajlova disjunktni; inače serijalizira.
4. **Devovi** rade, završe SAŽETKOM. Ne commitaju, ne migriraju, ne deployaju.
5. **Reviewer** dobije `/pregled …`, čita `git diff` radnog stabla, pokreće
   typecheck/testove i ciljane upite, pa piše verdikt u
   `.tim/reviews/<slug>-rN.md` (prva linija `VERDIKT: OK` ili `VERDIKT: DORADA`).
6. **DORADA** → dorade idu istom devu, bez `/clear`, pa novi krug pregleda.
   **OK** → orkestrator commita, pa (ako je plan to tražio) izvršava operacije
   nad bazama redoslijedom lokalno → provjera → cloud → deploy, tek onda
   `/clear` objema devovima.

Ti u koraku 3–6 ne moraš raditi ništa. Ako želiš intervenirati, klikni u
orkestratorov panel (miš je uključen) i utipkaj ispravak — to je predviđeno.

## Kako pratiš, a da te nitko ne prekida

Nijedan agent ne smije slati poruke u planner panel (`tim-send.sh` to odbija s
izlazom 2) — poruka bi ti upala usred prompta. Umjesto toga:

- **tmux status bar** — lijevo ime sessiona (da znaš u čijem si timu), desno
  napredak koji orkestrator osvježava sa `./scripts/tim-status.sh set '…'`.
- `./scripts/tim-status.sh` — tablica: uloga, pane, BUSY/IDLE, `ctx`,
  zadnja linija, plus popis verdikata iz `.tim/reviews/`.
- `./scripts/tim-read.sh dev1 120` — zadnjih 120 linija iz panela.
- `./scripts/tim-watch.sh` — nadzornik u zasebnom prozoru: 1 linija = 1 događaj
  (`GOTOV`, `MIRUJE`, `BLOKIRAN`, `NEPOSLANO`, `GREŠKA`, `KONTEKST`, `VERDIKT`).
  Bash proces, ne model — nadzor je besplatan.

## Helperi

```bash
./scripts/tim-send.sh <uloga> '<jedna linija>'   # planner|orkestrator|reviewer|dev1|dev2
./scripts/tim-read.sh  <uloga> [linija]
./scripts/tim-status.sh [set "<tekst>"] [session]
./scripts/tim-watch.sh [--once]
./scripts/tim-cost.py [--since HH:MM] [--json]   # izmjerena potrošnja po ulozi i modelu
./scripts/tim-kill.sh [-f]                       # ugasi SAMO tim ovog repoa
```

`tim-send.sh` rješava tri zamke odjednom: pane ID čita iz tmux user opcije
(`@tim_<uloga>`) umjesto da pogađa geometriju; tekst šalje u `-l` literal modu
(navodnici, `$`, `-` prolaze netaknuti); Enter šalje **odvojeno**, nakon pauze —
Claude Code TUI inače proguta red. Poruka mora biti jednolinijska: svaki `\n` je
za TUI submit. Dugi sadržaj → fajl, pa pošalji putanju.

**Dvije zaštite u `tim-send.sh`** (obje se gase s `--force`): `/clear` i
`/compact` se **odbijaju dok panel radi** (TUI bi ih stavio u red i izvršio čim
task završi — pobrisao bi baš ono što reviewer treba); i svaka poruka se nakon
slanja **provjeri** — ako se panel nije prerendao, izlaz je 4 uz upozorenje.

Uloge NISU hardkodirane u helperima: `tim.sh` ih upiše u session opciju
`@tim_roles`, pa isti helperi rade i za drukčiju postavu tima.

## Runtime stanje (`.tim/`, gitignorirano)

| Fajl | Što je |
|---|---|
| `.tim/panes.env` | mapa uloga → pane ID (debug; skripte čitaju tmux opcije) |
| `.tim/status.line` | tekst koji tmux status bar prikazuje |
| `.tim/reviews/*.md` | verdikti reviewera po krugu |

Planovi (`docs/plans/`) NISU gitignorirani — oni su trag odluka i idu u repo.

## Zamke iz prakse (vrijede za svaki tim)

- **Ime sessiona je per-projekt**: `tim-<repo-slug>` → ovdje **`tim-domovina-rag`**.
  tmux radi *prefix matching* na imenima, pa `kill-session -t tim` može pogoditi
  tuđi tim; skripte zato uvijek koriste `=` prefiks (`tim_target()`).
  `tmux ls | grep '^tim-'` izlista sve timove na stroju.
- **Pokretanje iz panela drugog tima**: tmux paneli nose `TIM_SESSION` u
  okolini, pa bi `./scripts/tim.sh` pokrenut iz `domovina.ai` panela pokušao
  attachati taj session. `tim.sh` to sad detektira i odbije s uputom
  (`env -u TIM_SESSION ./scripts/tim.sh`). Najsigurnije: čist iTerm prozor.
- **Panel koji čeka odgovor izgleda kao gotov.** Claude Code za pitanja s
  ponuđenim opcijama otvori picker i time *prestane raditi* — `tim-status.sh` ga
  vidi kao IDLE. Orkestrator zato ne smije zaključiti „dev je gotov" bez
  SAŽETKA: ako u zadnjoj liniji piše `Enter to select`, dev je **blokiran**.
- **Utipkan a neposlan tekst je tiha zamka.** Poruka koja ostane u input boxu
  izgleda identično kao „panel čeka posao". Watcher to javlja kao `NEPOSLANO`.
  Vrijedi i za tebe: ako utipkaš uputu devu, provjeri da si je poslao.
- **Claude Code u prazan input box upisuje PRIJEDLOG sljedeće poruke**, faint
  tekstom, i mijenja ga sam od sebe. Po sadržaju je neraspoznatljiv od pravog
  neposlanog unosa; jedina pouzdana razlika je SGR stil (pravi unos `[39]`,
  prijedlog `[39, 2, 0]`) — `tim-watch.sh` to već zna.
- **Ako ručno pišeš devu, javi orkestratoru.** Rad naručen izravno u dev panelu
  ne postoji u orkestratorovoj knjigovodstvenoj slici: neće ga uključiti u opseg
  reviewa ni u zapisnik plana, a može sudariti fajlove s taskom koji je sam
  dodijelio.
- **BUSY/IDLE je heuristika** — `tim-status.sh` uzima dva uzorka panela u
  razmaku od 1.2 s i uspoređuje ih (tekst „esc to interrupt" nije pouzdan; TUI
  ga zna zamijeniti prikazom tokena/efforta).
- **Nema worktreeja po devu.** Docker compose profili, `.env` i montirani
  diskovi vise o putanji repoa. Izolaciju drži isključivo pravilo *disjunktni
  fajlovi* iz plana — zato je popis fajlova po tasku obavezan, a ne ukras.
- **Svi paneli rade s `--dangerously-skip-permissions`** (odluka vlasnika repoa,
  git je sigurnosna mreža za KOD — ali ne i za bazu, otud pravila na vrhu).
