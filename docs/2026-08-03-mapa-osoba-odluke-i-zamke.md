# Mapa osoba — odluke i zamke koje nisu vidljive iz koda

> Zapisano 03.08.2026., nakon što je `/people` isporučen i deployan.
> Ovo NIJE plan (plan je `docs/plans/2026-08-01-mapa-osoba.md`) ni opis kako
> sustav radi (to je u kodu i u `docs/data-refresh-flow.md`,
> `../domovina-stats/docs/02-data-contract.md`, `03-frontend.md`).
>
> Ovdje je samo ono što se **ne vidi iz koda**: odluke koje su razmatrane pa
> odbačene, zamke koje su koštale vremena, i stvari koje su još otvorene.
> Bez ovoga bi sljedeći prolaz ponovio iste korake.

## 1. Infrastruktura: NE uvodi se graf baza (Memgraph/Neo4j)

Pitanje je bilo prirodno — mapa osoba uvodi „društvene povezanosti", a to zvuči
kao posao za graf bazu. Odgovor je **ne, i nije blizu.** Izmjereno:

| Mjera | Vrijednost |
|---|---|
| čvorova (osoba iznad praga ≥3 epizode) | 2 426 |
| bridova ko-pojavljivanja | 95 271 (20 702 s težinom ≥2) |
| cijeli graf u memoriji | ~10 MB |
| PPMI + SVD nad cijelim grafom (numpy) | **1,3 s** |
| sva susjedstva iz ClickHousea | jedan `GROUP BY` nad 41 074 retka |

Graf baze rješavaju tri problema: (1) graf ne stane u RAM, (2) višeskočni
obilasci u upitnom vremenu nad milijunima bridova, (3) Cypher je izražajniji od
SQL-a za složene uzorke nad heterogenim grafom. **Ovdje ne postoji nijedan.**

Uz to, arhitektura je **statični snapshot, ne živi upit**: frontend nikad ne
gađa bazu, dobiva 130 kB JSON-a s CDN-a. Graf baza bi u tom modelu služila samo
generatoru koji se vrti jednom dnevno ~50 s. Cijena je stvarna — četvrti
datastore koji treba deployati, backupirati, dodati mu korak u `sync-cron.sh` i
držati konzistentnim (vidi `data-refresh-flow.md` §9, koji postoji baš zato što
svaki takav derivat tiho zaostane kad se zaboravi).

**Okidači za ponovno razmatranje** (dok nijedan ne vrijedi, odgovor ostaje ne):

1. **Živi graf-upiti u sučelju** — npr. „put od Plenkovića do Ivana Merza kroz
   zajedničke epizode", interaktivno, po korisničkom unosu. I tada je prvi korak
   precompute u `networkx`/`scipy` u snapshot, kao što je mapa sad.
2. **Red veličine više čvorova** — npr. ako se doda granularnost (osoba × tema ×
   razdoblje kao zasebni čvorovi) pa se pređe ~10⁶ bridova.
3. **Heterogeni graf s puno tipova veza** — osoba–epizoda–kanal–tema–organizacija–
   vrijeme. Danas postoje točno **dvije** vrste veze: govori, spominje se.

Jeftin sljedeći korak ako graf-strana zanima kao feature: precompute zajednica
(Louvain/Leiden) u istoj skripti i emitiranje `community` polja u snapshot —
nekoliko sekundi, nula nove infrastrukture.

Postojeći stack pokriva sve: **ClickHouse** (`arrayJoin` + `GROUP BY` za
ko-pojavljivanje, `avgForEach` za centroide), **Postgres** (rekurzivni CTE ako
ikad zatreba put između dvije osobe), **Meilisearch** (nije ni potreban za mapu —
2 426 imena se pretražuje u pregledniku), **R2** (ovdje uopće nije u igri).

## 2. Odbačene alternative pri projektiranju mape

Detaljno u planu §2 i §4; ovdje kratko, jer se svaka od njih „prirodno" ponovno
predlaže:

- **Graf ko-pojavljivanja kao GEOMETRIJA** (force-directed umjesto point-clouda).
  Testirano PPMI+SVD: oštrije za guste blokove (ukrajinsko-EU blok je precizniji),
  ali za rep daje artefakte („Isus → Danijel Katanović") jer je susjedstvo osobe
  s 3 spomena u cijelosti određeno postavom te tri epizode. Uz to 95 k bridova =
  hairball. **Odluka: geometrija = semantički centroid, graf = sloj na odabir.**
- **Boja po klasteru** — klaster je već kodiran položajem i labelom; bojanje troši
  jedini kategorijski kanal na redundanciju, uz 44 klastera koje je nemoguće
  razlikovati bojom.
- **Boja po kanalu** — isječak pripada jednom kanalu, osoba ne (311 govornika i
  3 014 spominjanih je na ≥2 kanala). „Dominantni kanal" bi ih obojio po
  slučajnoj većini.
- **TF-IDF / vlastiti tematski profil** — radi, ali proizvodi DRUGI vektorski
  prostor pa se gubi jedina stvar koja mapu osoba čini dijelom sustava:
  usporedivost osobe i isječka istom metrikom.

## 3. Zamke koje su koštale vremena

### 3.1 CF Pages: prvih ~30-60 s nakon deploya assets vraćaju `index.html`

Nakon `wrangler pages deploy` HTML se propagira prije assetsa, pa
`/assets/people-XXXX.js` neko vrijeme vraća **200 s `content-type: text/html`**
(SPA fallback). Simptom u pregledniku: bijela stranica +
`Failed to load module script: … MIME type of "text/html"`.

**Nije bug u buildu.** Provjera:

```bash
for f in $(curl -s https://stats.domovina.ai/people | grep -oE '/assets/[a-zA-Z0-9_.-]+' | sort -u); do
  printf "%-42s %s\n" "$f" "$(curl -s -o /dev/null -w '%{http_code} %{content_type}' https://stats.domovina.ai$f)"
done
```

Ako neki vraća `text/html`, pričekaj i ponovi. Kad `curl` pokaže
`application/javascript`, a preglednik i dalje puca — preglednik je keširao onaj
HTML odgovor; otvori stranicu u **svježem/izoliranom kontekstu**, ne samo reload.

Isti mehanizam objašnjava zašto `/person-map-dupes.json` vraća 200 iako se NE
deploya (`vite.config.ts` ga briše iz dista) — to je `index.html` fallback, ne
fajl. Zato i frontend provjerava „je li ovo doista snapshot" umjesto da vjeruje
statusu 200.

### 3.2 iOS deep-linkovi: emulacija ne dokazuje ništa

Dvije stvari koje su prošle sve provjere u Chromeu s emuliranim iPhone UA-om, a
pale na pravom uređaju:

1. **iPad:** `ai.domovina://…` kad aplikacije nema baca **blokirajući** Safarijev
   dijalog *„cannot open the page because the address is invalid"* — a ne tiho
   ništa, kako je pretpostavljeno.
2. **iPhone 15 Pro:** obična https poveznica u novoj kartici **ne ostaje u
   pregledniku** — Universal Link uhvati i tu karticu. Ručni unos istog URL-a u
   adresnu traku ostaje u pregledniku, jer iOS Universal Links namjerno ne okidaju
   na ručnu navigaciju.

Rezultat je mehanika koja se razlikuje po platformi (zapisana u
`../domovina-stats/docs/03-frontend.md`). **Pravilo za ubuduće: sve što dira
Universal Links, custom sheme ili PWA ponašanje na iOS-u — traži test na
uređaju, emulacija je samo provjera da se ne ruši.**

### 3.3 Odgođena navigacija na vanjski protokol je blokirana

`setTimeout(() => location.href = "https://apps.apple.com/…")` → Chrome:
`Not allowed to launch 'itms-appss://…' because a user gesture is required`.
Isto vrijedi za svaki fallback-na-trgovinu iz tajmera. Rješenje je **ponuditi
poveznicu koju korisnik dodirne**, ne preusmjeravati.

### 3.4 Instaliranost aplikacije se ne može detektirati s druge domene

`navigator.getInstalledRelatedApps()` radi samo s vlastitog originа aplikacije
(`domovina.ai`), ne sa `stats.domovina.ai`. Namjerno, zbog fingerprintinga.
Svaki dizajn koji počinje s „ako je aplikacija instalirana, onda…" mora se
preformulirati u „pokušaj, pa pošteno reci ako nije uspjelo".

### 3.5 WebGL: generički vertex atribut je (0,0,0,1)

Kad se u shader doda `in float a_size`, a `enableVertexAttribArray` se NE pozove
(mapa isječaka ne koristi po-točka veličinu), atribut je **0** → sve točke
nestanu. Neutralna vrijednost mora se postaviti eksplicitno:
`gl.disableVertexAttribArray(loc); gl.vertexAttrib1f(loc, 1.0)`.

### 3.6 Klasteri: `people[i][7]` je indeks u NEFILTRIRANI niz

Frontend je u jednoj verziji filtrirao `clusters.filter(c => c.label)` prije
indeksiranja — tooltip je onda pokazivao naziv krivog područja. Prazne labele
preskače sloj labela, ne pozivatelj.

### 3.7 Cron je tri tjedna prijavljivao uspjeh, a nije deployao

Otkriveno pri zatvaranju O4 (prvi pravi 04:00 ciklus). Korak 7b jest prošao —
ali korak 7 (`sync-stats.sh --deploy`) padao je od 14.07. na
`ERROR: npx/node nije instaliran`, jer launchd daje minimalan PATH, a devet
`sync-*.sh` skripti imalo je po kopiju krive linije
(`/opt/homebrew/bin:/usr/local/bin` — node je na ovom Macu u nvm-u).

Dvije stvari čine ovo skupljim nego što zvuči:

1. **Simptom je bio tišina, ne pad.** Cron je WARN progutao i završio s `rc=0`,
   pa je izgledao zdravo. Snapshoti u `public/` bili su svježi svaki dan —
   samo ih nitko nije deployao. Nema alarma za „sve je prošlo, ali javni sajt je
   star tri tjedna".
2. **Isti je korijen tiho degradirao mapu osoba.** `gcloud` i `gemini` također
   nisu bili na PATH-u, pa je LLM-imenovanje klastera padalo na naslijeđene
   labele (48 klastera, 37 imenovanih). Nakon popravka: **45/45**.

Popravak: `scripts/lib/cron-path.sh` (jedan izvor, nvm verzija se razrješava iz
`~/.nvm/alias/default`), brojač WARN-ova u zadnjem retku `sync-cron.sh`, i
`--branch main` koji je u deploy naredbi **nedostajao** — pa bi i da je npx
postojao deploy otišao na preview alias, a produkcija se ne bi mijenjala.
Detalji i način testiranja: `data-refresh-flow.md` §10.

**Pravilo za ubuduće:** cron skripta se testira s `env -i` i `/bin/bash`, nikad
iz vlastitog shella — inače test dokazuje samo da radi kod tebe.

## 4. Otvorene stavke (ništa od ovoga nije blokada)

| # | Stavka | Stanje |
|---|---|---|
| O1 | **`x-safari-https://` nije potvrđen na uređaju** — treba provjeriti ostaje li „Otvori u pregledniku" doista u Safariju na iPhoneu | čeka test |
| O2 | **Android varijanta izbornika nije testirana na uređaju** (custom shema + Google Play fallback) | čeka test |
| O3 | ~~Svijetla tema na `/map`: točke isprane (alpha 0.55 preko bijele)~~ — **riješeno 03.08.** Izmjereno: ista alpha daje ΔE 21,5 od bijele naspram 25,7 od tamne (OKLab ×100, medijan). Sada α=0,65 na svijetloj za mapu isječaka i 0,85 za mapu osoba; `u_alpha` se preselio u `setPalette`. Tamna nepromijenjena | **zatvoreno** |
| O4 | ~~Korak 7b nije prošao pravi ciklus u 04:00~~ — **prošao 03.08. u 04:06:07–04:06:21 (14 s)**. Ali je isti log otkrio da korak **7** (deploy) pada od 14.07.; vidi §3.7 | **zatvoreno** |
| O5 | **`person-map-dupes.json`**: 18 kandidata (bilo 17). Dokazi po paru i prijedlog: **`2026-08-03-merge-identiteta-pregled.md`** — 9 sigurnih merge-eva + 9 varijanti zapisa koje lista ne vidi, 4 kratka imena („Ivan", „Marija", „Pavao", „Franjo") dokazano su skupovi ljudi i ostaju. `speaker_aliases.csv` NIJE mijenjan | čeka potvrdu |
| O6 | **Klaster jednočlanih imena** („Marko, Ante, Nikola, Hrvoje…", n=30) — LLM mu je dao uvjerljiv naziv („Duhovnost i pastoral") iako to nisu ljudi nego fragmenti. Nema sigurnog automatskog pravila (35,8 % slugova je jednočlano, a „Isus"/„Marija"/„Mojsije" su legitimni) | poznato, dokumentirano |

## 5. Vezani dokumenti

- `docs/plans/2026-08-01-mapa-osoba.md` — plan, sva mjerenja, faze, rizici
- `docs/2026-08-03-merge-identiteta-pregled.md` — O5: dokazi po paru + prijedlog za `speaker_aliases.csv`
- `docs/person-data-gaps.md` — rupe u podacima (§2 zatvoren 01.08.)
- `docs/data-refresh-flow.md` — dnevni ciklus, korak 7b
- `scripts/emit_person_map.py`, `scripts/sync-person-map.sh`, `scripts/vectormap_common.py`
- `../domovina-stats/docs/02-data-contract.md` § Person map — ugovor snapshota
- `../domovina-stats/docs/03-frontend.md` § /people — otvaranje profila po platformi
