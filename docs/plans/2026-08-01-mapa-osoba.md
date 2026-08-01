# Mapa osoba — vizualna (semantička) mapa ljudi iz korpusa

> Plan, 01.08.2026. Analogon postojeće mape isječaka
> (`stats.domovina.ai/map`, generator `scripts/emit_vector_map.py`).
> Sve brojke ispod su **izmjerene** nad lokalnim CH/PG-om istog dana; uz svaku
> je upit kojim se ponavlja. Gdje se plan razilazi s
> `docs/person-data-gaps.md`, mjerenje ima prednost — taj je dokument stariji
> i jednu je rupu (§2, udio višegovornih chunkova) ostavio nemjerenom jer CH
> tada nije odgovarao.

## Cilj

`stats.domovina.ai/people` — point-cloud u kojem je **svaka točka osoba**,
blizina = pojavljivanje u sličnim temama i kontekstima, klasteri imenovani
(„Hrvatska politika", „Pape i sveci", „Kripto i financije"), imena ljudi
ispisana preko mape, tražilica po imenu, klik vodi na `domovina.ai/p/{slug}`.

Osobe su danas **tekstualno** pretražive (person hub + `get_person`). Ovo
dodaje **vizualnu** pretragu: pregled cijelog panteona korpusa odjednom i
otkrivanje susjeda koje korisnik ne bi znao upisati.

**Izvedivost je potvrđena prototipom** (§3.4) — nije hipoteza.

---

## 1. Izmjereno stanje

Sve preko lokalnog stacka (`domovina-rag-infra-clickhouse-1`,
`domovina-rag-infra-postgres-1`), 01.08.2026.

### 1.1 Korpus

| Mjera | Vrijednost |
|---|---|
| chunkova (`length(youtube_id)=11`) | 147 087 |
| epizoda | 3 157 |
| kanala | 48 |

### 1.2 Govornici (`rag_chunks.speaker`)

```sql
SELECT chunk_strategy, count() n, countIf(speaker='') prazan,
       countIf(position(speaker,',')>0) visegovorni
FROM rag_chunks WHERE length(youtube_id)=11 GROUP BY chunk_strategy;
```

| `chunk_strategy` | chunkova | bez govornika | višegovornih |
|---|---|---|---|
| `topic_transcript` | 83 383 | 0 | 50 793 (60,9 %) |
| `article_summary` | 63 704 | **63 704 (100 %)** | 0 |

**Dva nalaza koja mijenjaju plan, oba nova:**

1. **43 % korpusa nema govornika uopće.** `article_summary` chunkovi (sažeci)
   nikad nemaju `speaker`. Nisu izgubljeni za mapu — koriste se preko
   spomen-kanala (§3) — ali za „govori" signal ne postoje.
2. **Udio višegovornih chunkova je 60,9 %, ne „netrivijalan" nego dominantan.**
   Ovo zatvara nemjerenu rupu iz `person-data-gaps.md` §2 i potvrđuje njezino
   upozorenje: naivni `sum(end_ts-start_ts)` po govorniku napuhuje udio na
   dvije trećine chunkova. Za mapu to **nije blokada** (centroid je otporniji
   od zbroja trajanja), ali za odluku O3 (cameo vs primary) jest.

Raspodjela broja govornika po govornom chunku: 1 → 32 590, 2 → 42 713,
3 → 6 616, 4+ → 1 464.

### 1.3 Osobe — koliko ih realno ima

Nakon `etl.speakers.build_persons` (role-filter + slug-dedup + seed):

| Izvor | Osoba |
|---|---|
| govori (`speakers`, PG) | **2 698** |
| spominje se (`person_mentions`, PG, 41 074 redaka) | **17 394** |
| oba | 1 840 |
| **unija (svi slugovi)** | **18 252** |

Spomeni pokrivaju **3 121 od 3 157 epizoda (98,9 %)**, prosječno **13,2**
osobe po epizodi (medijan 10, max 96). Govornici pokrivaju bitno manje.

**Repovi podataka — ovo je odlučujuća tablica plana:**

| Prag (epizoda, govor ∪ spomen) | Osoba |
|---|---|
| ≥ 1 | 18 252 |
| ≥ 2 | 4 328 |
| **≥ 3** | **2 426** |
| ≥ 5 | 1 282 |
| ≥ 10 | 546 |
| ≥ 20 | 219 |
| ≥ 50 | 73 |

Za same govornike rep je još oštriji: **2 077 od 2 698 (77 %) pojavljuje se u
točno jednoj epizodi.** Samo 621 govori u ≥ 2 epizode, 311 u ≥ 3.

Broj epizoda po osobi iznad praga ≥3: p50 = 5, p75 = 9, p90 = 18, p95 = 34,
p99 = 113, max = 594 (Isus).

### 1.4 Zašto prag nije kozmetika

Osoba spomenuta u točno jednoj epizodi ima profil koji je **doslovno centroid
te epizode**. Mjereno nad punim univerzumom:

| Skup | Osoba | Identičan vektor barem još jednoj | Različitih pozicija |
|---|---|---|---|
| svi | 18 252 | **11 923 (65,3 %)** | 8 255 |
| ≥ 2 epizode | 4 328 | 192 (4,4 %) | — |
| ≥ 3 epizode | 2 426 | **2 (0,1 %)** | 2 425 |

Mapa svih 18 252 osoba imala bi **8 255 stvarno različitih točaka** — to nije
mapa ljudi nego mapa epizoda s ljudskim imenima na sebi. Uz to UMAP na punom
skupu odustaje od spektralne inicijalizacije („Falling back to random
initialisation") jer je k-NN graf raspadnut.

**Prag ≥ 3 epizode je time podatkovno određen, ne proizvoljan.**

---

## 2. Što je „embedding osobe" — opcije

Pet kandidata, ocijenjeni po tome daje li mapu koja korisniku nešto **znači** i
koliko košta u dnevnom cronu.

| # | Definicija | Pokriva | Cijena | Problem |
|---|---|---|---|---|
| A | centroid chunkova gdje osoba **govori** | 2 698 osoba, 621 s ≥2 epizode | ~1 s | premali skup; 61 % chunkova dijeli 2+ govornika pa je „njezin" tekst zapravo tuđi razgovor |
| B | centroid epizoda gdje se **spominje** | 17 394 osoba | ~0,5 s | rep od jedne epizode (§1.4) |
| C | **A ∪ B, težinsko po broju chunkova** | 18 252 (2 426 iznad praga) | ~1,5 s | — |
| D | TF-IDF / tematski profil nad tekstom | isto kao C | ~30 s | drugi vektorski prostor od `search_podcasts`; gubi se veza s postojećim embeddinzima |
| E | graf ko-pojavljivanja → PPMI + SVD | isto kao C | ~1,5 s | vidi §4.1 |

**Odabrano: C — hibridni težinski centroid, mean-centriran.**

```
v(osoba) = Σ_i n_i · c_i / Σ_i n_i          zatim   v ← normalize(v − v̄)

  gdje je za svaku epizodu/govor-segment i:
    c_i = avgForEach(embedding)   (ClickHouse računa)
    n_i = broj chunkova u tom segmentu

  govor:   c po (epizoda, speaker-token) — samo chunkovi gdje osoba govori
  spomen:  c po epizodi                  — cijela epizoda, jer spomen nema tekst
```

**Zašto baš to:**

- **Isti vektorski prostor** kao mapa isječaka i kao `search_podcasts` (bge-m3,
  1024d). Mapa osoba i mapa isječaka su tako *ista karta u dva zuma*, a ne dvije
  nepovezane slike. To je i preduvjet za kasniju vezu „skoči s osobe na njezine
  isječke".
- **Govor ima prednost gdje postoji**, spomen popunjava sve ostalo. Povijesne
  figure (Ivan Merz, Stepinac) i strane javne osobe (Putin, Trump) nikad ne
  govore — bez B ih na mapi ne bi bilo, a upravo su one najzanimljivije.
- **Mean-centriranje nije kozmetika.** Sirovi centroidi su gurnuti prema
  prosjeku korpusa: srednji kosinus među osobama je 0,84–0,90 (p95 = 0,98),
  jer se svi Katolički podcast razgovori „vuku" u istu regiju. Nakon oduzimanja
  prosjeka susjedstva postaju diskriminativna (usporedba u §3.4).
- **Trošak je zanemariv** — cijeli izračun centroidа radi ClickHouse
  (`avgForEach`) u **1,4 s**, bez izvoza 560 MB embeddinga koji mapa isječaka
  mora raditi.

### 2.1 Zašto ne samo govor (A)

621 osoba s ≥2 epizode je premalo za mapu, a 77 % jednoepizodnih bi je pretvorilo
u mapu epizoda. Uz to je 61 % govornih chunkova višegovorno, pa je centroid
„govora" osobe zapravo centroid **razgovora** u kojem sudjeluje — signal koji
za mapu ionako nije lošiji od spomenskog, ali nije ni čišći nego što se čini.

### 2.2 Zašto ne TF-IDF (D)

Radio bi, ali proizvodi **drugi prostor**. Time se gubi jedina stvar koja mapu
osoba čini dijelom sustava, a ne zasebnim eksperimentom: mogućnost da se osoba
i isječak uspoređuju istom metrikom. Uz to traži vlastiti tokenizer za hrvatski
(deklinacije), a to je istraživački posao bez izvjesnog dobitka.

---

## 3. Prototip — što je izmjereno

Sve u `.venv-vectormap` (postojeći venv mape isječaka: numpy 2.4, umap-learn,
sklearn 1.9). Nijedan zapis nije pisan u bazu.

### 3.1 Izvoz iz ClickHousea

```sql
-- per-epizoda centroid (3 157 × 1024)  → 0,43 s
SELECT youtube_id, count(), avgForEach(embedding)
FROM rag_chunks WHERE length(youtube_id)=11 GROUP BY youtube_id;

-- per (epizoda, govornik) centroid (9 389 × 1024)  → 0,94 s
SELECT tok, youtube_id, count(), avgForEach(embedding) FROM (
  SELECT trim(arrayJoin(splitByChar(',', speaker))) AS tok, youtube_id, embedding
  FROM rag_chunks WHERE length(youtube_id)=11 AND speaker != ''
) WHERE tok != '' GROUP BY tok, youtube_id;
```

Ukupno **1,4 s** i **108 MB** teksta (u produkciji ide RowBinary → ~50 MB).
Za usporedbu, mapa isječaka izvozi 560 MB i računa UMAP nad 147 k točaka.

### 3.2 Layout

| Korak | Trajanje (M4) |
|---|---|
| UMAP 2D nad 2 426 osoba (cosine, `n_neighbors=15`) | **8,5 s** |
| UMAP 2D nad 18 252 osoba | 9,2 s |
| HDBSCAN (`min_cluster_size=12`, `leaf`) | 0,04 s |

44 klastera, šum 1 171/2 426 (48 %) — isti red kao mapa isječaka, gdje je šum
namjerno visok jer klasteri služe samo kao sidra za labele.

### 3.3 Klasteri (bez ijedne LLM oznake — čitljivi su iz članova)

```
k6  n=132  Elon Musk, Jordan Peterson, Steve Jobs, Bill Gates, Joe Rogan
k1  n= 86  Charlie Chapman, John Gruber, Marco Arment, Christian Selig
k42 n= 76  Pavao, Petar, Mojsije, Augustin, David, Adam, Abraham, Eva
k11 n= 67  Aristotel, Platon, Nietzsche, Hegel, Charlie Kirk
k30 n= 39  Tomislav Tomašević, Milan Bandić, Miroslav Škoro, Sandra Benčić
k35 n= 29  Papa Franjo, Papa Ivan Pavao II, Papa Pavao VI, Kardinal Bozanić
k24 n= 27  Vladimir Putin, Joe Biden, Volodimir Zelenski, Barack Obama
k2  n= 27  Michael Saylor, Jerome Powell, Gary Gensler, Satoshi Nakamoto
k5  n= 35  Oliver Dragojević, Nina Badrić, Mišo Kovač, Maja Šuput
```

Biblijski likovi, filozofi, pape, zagrebačka politika, svjetska geopolitika,
kripto, estrada i — jer je korpus dvojezičan — Apple/indie-dev scena iz
`subclub` i `launched` kanala. Klasteri su **interpretabilni bez pomoći**.

### 3.4 Najbliži susjedi — sirovo vs. centrirano

```
Andrej Plenković  → Zoran Milanović 0,97 · Plenković 0,95 · Sanader 0,92 · Vučić 0,91
Ivan Pavao II.    → Augustin 0,94 · Papa Benedikt XVI. 0,94 · Papa Franjo 0,94
Vladimir Putin    → Zelenski 0,98 · Macron 0,97 · Orban 0,96 · Xi Jinping 0,96
Luka Modrić       → Michael Jordan 0,81 · Cristiano Ronaldo 0,78 · Dražen Petrović 0,76
Mislav Kolakušić  → von der Leyen 0,94 · Dragan Šolak 0,90 · Macron 0,87 · Farage 0,86
Alojzije Stepinac → Ivan Merz 0,85 · Ivan Pavao II. 0,83 · Kardinal Ratzinger 0,82
```

Bez centriranja iste liste imaju sve kosinuse 0,99–1,00 i poredak je slabije
određen. **Centriranje ulazi u ugovor pipelinea, nije opcija.**

---

## 4. Odbačene alternative

### 4.1 Force-directed graf ko-pojavljivanja umjesto point-clouda

Izmjereno je i ovo: osoba × epizoda matrica → PPMI → SVD(128), 1,3 s.

```
Vladimir Putin   → Zelenski 0,79 · Netanyahu 0,70 · Kaja Kallas 0,69 · Borrell 0,63
Andrej Plenković → Milanović 0,70 · Frano Čirko 0,61 · Božinović 0,56 · Pupovac 0,55
Ivan Pavao II.   → Igor Kanižaj 0,81 · Papa Leo XIII 0,57 · Ignacije Loyolski 0,46
Isus             → Otac 0,53 · Danijel Katanović 0,52 · Bog 0,51 · Ivona Turić 0,46
```

Graf je **oštriji za guste skupine** (ukrajinsko-EU blok je precizniji nego kod
centroida) i **lošiji za sve ostalo**: „Ivan Pavao II. → Igor Kanižaj" i
„Isus → Danijel Katanović" su artefakti pojedinačnih epizoda. Za osobu s 3
spomena susjedstvo je u cijelosti određeno postavom te tri epizode.

Uz to je i **skup za crtanje**: pri pragu ≥3 graf ima 2 426 čvorova i 95 271
brid (20 702 s težinom ≥2). Force-directed layout tolikog grafa u pregledniku
je posao za sebe, a rezultat je hairball koji se čita lošije od point-clouda.

**Odluka: geometrija = semantički centroid; graf ide kao _sloj_, ne kao osnova.**
Ko-pojavljivanje je stvarno korisno, ali kao odgovor na pitanje „**s kim** se
ova osoba pojavljuje", a ne „**gdje** stoji". Zato ulazi u snapshot kao
`co: [[slug, n], …]` (top 8 po osobi) i crta se **tek na odabir točke** — 8
linija prema susjedima, ne 95 tisuća odjednom. To je jeftino (§5) i zadržava
sav dobitak grafa bez njegove vizualne cijene.

### 4.2 Boja po klasteru

Klaster je već kodiran **položajem** i **labelom**. Bojati ga znači trošiti
jedini kategorijski kanal na redundantnu informaciju, uz 44 klastera koje je
nemoguće razlikovati bojom (pravilo: ≥9 kategorija → „Ostali"). Odbačeno.

### 4.3 Boja po kanalu (kao na mapi isječaka)

Isječak pripada točno jednom kanalu; osoba ne. Mjereno: **311 govornika** i
**3 014 spominjanih osoba** pojavljuju se na ≥2 kanala — a upravo su te
najzanimljivije, jer je cross-channel prisutnost cijela poanta person huba.
„Dominantni kanal" bi im obojio identitet po slučajnoj većini. Ostaje kao
**opcionalni toggle** (Razina 2), ne kao default.

---

## 5. Data contract

Po uzoru na `vector-map.*`, ali **bitno jednostavniji: nema binarnog dijela**.
Pri N = 2 426 cijeli snapshot stane u jedan JSON.

Izmjereno na stvarnom prototipu:

| Varijanta | Sirovo | gzip |
|---|---|---|
| bez `co[]` | 128 kB | **48 kB** |
| s `co[]` (top 8 susjeda) | 456 kB | **124 kB** |
| ekstrapolacija na 4 328 osoba (prag ≥2) | 228 kB | 85 kB |
| ekstrapolacija na 18 252 (svi) | 963 kB | 360 kB |

124 kB gzip je manje od **jednog** chapter-sharda mape isječaka (~150 kB) i
manje od `vector-map.json` (368 kB). **Kvantizacija u `.bin` i lazy shardanje
nisu potrebni** — bila bi to složenost bez dobitka. Ako univerzum jednom naraste
preko ~20 k osoba, tek tada se `co[]` odvaja u lazy shardove istim uzorkom kao
`vector-map-chap-NN.json`.

### `public/person-map.json`

```jsonc
{
  "schema_version": 1,
  "generated_at": "2026-08-01T04:12:00Z",   // ISO 8601 UTC
  "source": "local",                         // "local" | "cloud"
  "persons": 2426,                           // = people.length
  "min_episodes": 3,                         // primijenjen prag (frontend ga ispisuje)
  "source_slugs": 18252,                     // veličina punog univerzuma prije praga
  "clusters": [
    { "label": "Svjetska politika", "x": 31204, "y": 48810, "n": 27 }
    // label može biti "" (LLM nedostupan) — frontend prazne preskače, kao na /map
  ],
  "people": [
    // [slug, ime, x, y, epizoda_ukupno, epizoda_govori, kanala, cluster, co]
    ["vladimir-putin", "Vladimir Putin", 31204, 48810, 96, 0, 12, 24,
      [["volodimir-zelenski", 41], ["joe-biden", 33]]]
  ]
}
```

| Polje | Tip | Značenje |
|---|---|---|
| `slug` | string | ključ identiteta, isti kao `/api/person/:slug` i `/p/:slug` |
| `ime` | string | display ime s dijakritikom (`speakers.canonical_name` ili `person_mentions.person_name`) |
| `x`, `y` | uint16 | kvantizirano `[0, 65535]`, očuvan aspect ratio — ista `quantize()` kao mapa isječaka |
| `epizoda_ukupno` | int | `|govori ∪ spominje se|` — nosi veličinu točke |
| `epizoda_govori` | int | `|govori|`; `0` = osoba se samo spominje — nosi boju |
| `kanala` | int | broj različitih kanala (govor ∪ spomen) — samo za tooltip |
| `cluster` | int | indeks u `clusters[]`, `-1` = šum |
| `co` | `[[slug, n], …]` | top 8 po broju zajedničkih epizoda; `[]` dopušteno |

**Pravila ugovora** (ista filozofija kao `docs/02-data-contract.md` u
`domovina-stats`):

- Frontend **graceful degradira**: `clusters` može nedostajati ili imati prazne
  labele; `co` može biti `[]`; `epizoda_govori` može biti 0 za sve.
- `slug` je jedina stvar koja se **ne smije** mijenjati između runova — to je
  javni URL i deep-link ključ.
- `x`/`y` se **smiju** rotirati/zrcaliti između runova (UMAP nije determinističan
  bez `random_state`). Zato labele klastera nasljeđuju imena po **preklapanju
  članova**, ne po koordinatama — isti mehanizam kao `eps[]` u
  `emit_vector_map.py`.

---

## 6. Pipeline

Novi generator `scripts/emit_person_map.py` + orkestrator
`scripts/sync-person-map.sh`, po uzoru na `emit_vector_map.py` /
`sync-vector-map.sh`. **Granica repoa: sve ovo živi u `domovina-rag`.**
`domovina-stats` dobiva samo `public/person-map.json` i crta ga.

```
                    lokalni ClickHouse                    lokalni PG
                          │                                    │
   ┌──────────────────────┼────────────────────────────────────┼───────────┐
   │ 1. izvoz (1,4 s)     │                                    │           │
   │    per-epizoda centroid     avgForEach(embedding)          speakers    │
   │    per-(ep,govornik) centroid                              person_mentions
   └──────────────────────┬────────────────────────────────────┬───────────┘
                          ▼                                    ▼
   2. identitet — etl.speakers.build_persons + slugify (ISTI kod kao person hub)
                          │
   3. v(osoba) = Σ n·c / Σ n   →  v − v̄  →  normalize            (~2 s)
                          │
   4. prag: epizoda_ukupno >= MIN_EPISODES (default 3)           2 426 osoba
                          │
   5. UMAP 2D (cosine, n_neighbors=15, min_dist=0.1)             8,5 s
                          │
   6. HDBSCAN (min_cluster_size=12, leaf) → 44 klastera          0,04 s
                          │
   7. imena klastera: Gemini (Vertex → gemini CLI fallback)      ~15 s, 1 poziv
      nasljeđivanje iz prethodnog snapshota po preklapanju članova
                          │
   8. co[] iz person_mentions (epizoda = klika, top 8)           ~1 s
                          │
                          ▼
        domovina-stats/public/person-map.json   (~124 kB gzip)
                          │
        deploya ga POSTOJEĆI sync-stats.sh --deploy (korak 7 crona)
```

### 6.1 Zajednički kod

`emit_vector_map.py` već ima `quantize()`, `find_clusters()`, `name_clusters()`
i oba Gemini backenda. Duplicirati ih bilo bi loše. **Izdvojiti u
`scripts/vectormap_common.py`** i importati iz oba emittera — čist refaktor bez
promjene ponašanja mape isječaka, s postojećim testovima kao zaštitom.

Prompt za imenovanje se **mijenja**: mapa isječaka daje modelu naslove epizoda,
mapa osoba daje **imena članova klastera** (Putin, Zelenski, Biden, Orban →
„Svjetska politika"). To je izravniji signal i traži manje tokena.

### 6.2 Skip-if-unchanged

Isti uzorak kao `sync-vector-map.sh`: jeftin `count()` iz CH plus broj redaka
`person_mentions` → ako se nijedno nije promijenilo od `source_rows` u
prethodnom snapshotu, preskoči. `--force` gazi.

### 6.3 Cron

`scripts/sync-cron.sh`, **novi korak 7b, odmah iza 7a (vector map) i prije
koraka 7** (`sync-stats.sh --deploy` nosi sve u istom `wrangler` deployu):

```bash
# ─── 7b. Regeneriraj mapu osoba (centroidi + UMAP nad person hubom) ───────────
if [ "$RC" -eq 0 ]; then
  echo "[cron] Regeneriram mapu osoba (lokalni CH+PG → domovina-stats/public)..."
  ./scripts/sync-person-map.sh || echo "[cron] WARN: mapa osoba pala (nastavljam)."
fi
```

Mora ići **iza koraka 6 i 6b** (`sync-speakers.sh`, `sync-person-mentions.sh`) —
mapa čita upravo te tablice, pa bi prije njih radila nad jučerašnjim hubom.

Checklist iz `docs/data-refresh-flow.md` §9 vrijedi djelomično: ovo **nije**
derivat-tablica (ne piše ni u jednu bazu, piše fajl), pa točke 2–3 (`--cloud`
mod, schema bootstrap) otpadaju — kao i za `sync-vector-map.sh`. Točke 1, 4, 5, 6
vrijede.

---

## 7. UX

Različita forma od mape isječaka, jer je različit posao. Točke isječaka su
anonimne masa (142 k, čitaju se samo kao oblak); točke osoba su **imenovane
i malobrojne** (2,4 k) — **ime je glavni nositelj vrijednosti, ne boja.**

### 7.1 Forma

Point-cloud, ali s **imenima ispisanim izravno na mapi** — kao imena mjesta na
zemljovidu. To je razlika: mapa isječaka ispisuje samo ~12 naziva tema, mapa
osoba ispisuje desetke imena i raste sa zumom.

- **Prioritet labele = `epizoda_ukupno` desc**, greedy anti-overlap, budžet
  raste sa zumom (isti mehanizam kao `map-labels.ts`, ali per-točka umjesto
  per-klaster). Na default zumu ~30–50 imena; zum u regiju otkriva ostatak.
- **Labele klastera su drugi sloj**, krupnije i prigušenije, ispod imena ljudi —
  kontekst („Pape i sveci"), ne sadržaj.
- Reuse: `map-gl.ts` (WebGL2 point renderer), `map-view.ts`, `map-pick.ts`,
  `map-chrome.ts` rade bez izmjena. 2 426 točaka je za WebGL ništa — moglo bi i
  SVG-om, ali dijeljenje koda s `/map` vrijedi više od pojednostavljenja.

### 7.2 Boja — kategorijska, **2 slota**

**Boja = izvor pojavljivanja**, jer je to jedino svojstvo osobe koje je (a)
stabilno, (b) binarno čitljivo, (c) korisniku odmah korisno („je li ovaj čovjek
bio gost ili se o njemu priča").

| Slot | Značenje | Light | Dark | Osoba |
|---|---|---|---|---|
| 1 | **govori** u korpusu (`epizoda_govori > 0`) | `#2a78d6` | `#3987e5` | 650 |
| 2 | **samo se spominje** (`epizoda_govori == 0`) | `#c07d00` | `#c98500` | 1 776 |

Omjer je 27 : 73 — manjinska klasa je „govori", pa ona nosi jaču (plavu) boju.

Validirano skriptom, ne okom (pravilo iz `domovina-stats/CLAUDE.md`):

```
node scripts/validate_palette.js "#2a78d6,#c07d00" --mode light --pairs all
  → ALL CHECKS PASS   (CVD ΔE 27,0 protan · normal 30,8 · kontrast ≥3:1, bez WARN-a)
node scripts/validate_palette.js "#3987e5,#c98500" --mode dark  --pairs all
  → ALL CHECKS PASS   (CVD ΔE 27,4 protan · normal 30,7)
```

Provjerene i odbačene varijante: troslotna plava/jantarna/crvena pada na
`Lightness band` u darku; plava/jantarna/ljubičasta pada na `CVD separation`
(ΔE 1,9 protan); plava/zelena/crvena prolazi, ali s CVD WARN-om u pojasu 6–8
koji je dopušten samo uz sekundarno kodiranje. Dvoslotna varijanta ima **rezervu
od 27 ΔE** i ne treba nikakvu ispriku.

Boja prati **entitet** (svojstvo osobe), pa filter po legendi ne preboja
preživjele — pravilo je zadovoljeno po konstrukciji.

Dark nije automatski flip nego birani koraci iz iste rampe kao `/map`
(`PAL_LIGHT`/`PAL_DARK` u `map-gl.ts`).

### 7.3 Veličina — `epizoda_ukupno`

Površina ∝ broju epizoda, dakle **polumjer ∝ √epizoda**, s podom i stropom:

```
r_px = clamp(2.5 + 5.5 · √(eps / 594), 3, 11)     // 594 = max, mjereno
```

Raspon 3–594 epizoda; p50 = 5, p95 = 34. Bez √ i bez stropa Isus (594) bi bio
14× širi od medijane i pojeo bi pola ekrana.

Legenda veličine (tri kružića: 3 / 30 / 300 epizoda) ide u drawer „O mapi",
kao i objašnjenje metodologije.

### 7.4 Interakcija

| Ulaz | Ponašanje |
|---|---|
| hover (miš) | tooltip: ime · „govori u N epizoda" / „spominje se u N epizoda" · kanali · naziv klastera |
| klik (miš) | otvara `https://domovina.ai/p/{slug}` u novom tabu |
| tap (dodir) | snackbar s imenom + „Otvori profil ↗" (isti uzorak kao `/map`) |
| odabir točke | crtaju se linije prema `co[]` susjedima; susjedi se istaknu, ostalo priguši |
| tražilica | input u alatnoj traci, prefix-match po imenu i slugu, ≤8 rezultata, Enter → zoom-to-point + odabir |
| legenda | dva chipa (govori / samo spomen), klik izdvaja, ponovni klik vraća — kao filtar kanala na `/map` |

**Tražilica je obavezna, ne nice-to-have.** Mapa isječaka je pregled; mapa
osoba je i **alat za pronaći konkretnog čovjeka**. Bez pretrage po imenu
korisnik s 2 426 točaka ne može ništa.

### 7.5 Veza s ostatkom sustava

- **na osobu**: `domovina.ai/p/{slug}` (person hub — govori/spominje se,
  timeline, deep-linkovi na trenutke)
- **s mape isječaka**: klik na „prikaži isječke ove osobe" vodi na
  `/map?person={slug}` — Faza 2, traži per-chunk speaker filtar na `/map`
- **a11y**: `role="img"` + `aria-label` s brojem osoba (kao `/map`); tablični
  prikaz (`/people?view=table`, sortabilna lista ime/epizode/klaster) je
  obavezan pandan jer je identitet inače nošen položajem koji čitač ekrana ne vidi

---

## 8. Cijena i trajanje

| Korak | Trajanje | Napomena |
|---|---|---|
| izvoz centroidа iz CH | **1,4 s** | mjereno; `avgForEach` radi CH |
| izvoz `speakers` + `person_mentions` iz PG | ~1 s | `COPY … TO STDOUT` |
| identitet + centroidi + centriranje | ~2 s | numpy, 18 k × 1024 |
| UMAP 2D | **8,5 s** | mjereno na 2 426 osoba |
| HDBSCAN | 0,04 s | mjereno |
| Gemini imenovanje 44 klastera | ~15 s | **1 poziv** (batch = 60) |
| `co[]` + serijalizacija | ~1 s | |
| **ukupno** | **~30 s** | |

Za usporedbu: `sync-vector-map.sh` traje **5–10 min** (2 × UMAP nad 147 k točaka
+ izvoz 560 MB). Mapa osoba je **red veličine jeftinija** i može se u cronu
vrtjeti bez `skip-if-unchanged` logike — ali je se ipak dodaje, radi
konzistentnosti i da se Gemini poziv ne troši uzalud.

**LLM je potreban, ali marginalno.** Jedan `gemini-2.5-flash` poziv dnevno,
~2 k ulaznih tokena (44 klastera × ~8 imena). Uz Vertex free-tier kredite to je
efektivno **0 €**; i kad ne bi bilo, red veličine je 0,001 €/dan. Fallback lanac
je već izgrađen (Vertex → `gemini` CLI → nasljeđivanje iz prethodnog snapshota →
prazne labele), pa pad LLM-a ne ruši mapu.

**Nema novih dependencyja.** `.venv-vectormap` već ima sve (numpy, umap-learn,
sklearn). Nema novih tablica, migracija ni cloud-side promjena.

---

## 9. Faze

### MVP — vrijedi shipati

1. `scripts/vectormap_common.py` — izdvojiti `quantize` / `find_clusters` /
   `name_clusters` / Gemini backende iz `emit_vector_map.py` (čist refaktor).
2. `scripts/emit_person_map.py` — hibridni centroid (§2), prag `MIN_EPISODES=3`,
   UMAP + HDBSCAN + imenovanje + `co[]` → `person-map.json`.
3. `scripts/sync-person-map.sh` — izvozi iz CH/PG, poziva emitter, skip-if-unchanged.
4. `sync-cron.sh` korak 7b (§6.3) + ažuriranje `docs/data-refresh-flow.md`.
5. `domovina-stats`: `people.html` + `src/people.ts` — reuse `map-gl` / `map-view` /
   `map-pick` / `map-chrome`, novi `people-labels.ts` (per-točka labele) i
   `people-search.ts`. Boja po §7.2, veličina po §7.3, tablični prikaz.
6. `domovina-stats/docs/02-data-contract.md` — dodati `person-map.json` shape.

Isporučuje: mapa 2 426 osoba, imenovani klasteri, imena na mapi, pretraga,
veza na person hub, `co[]` susjedi na odabir.

### Razina 2

- **3D toggle** — `person-map-3d.bin` istim uzorkom kao `vector-map-3d.bin`
  (drugi UMAP fit, isti poredak točaka). Trošak +9 s.
- **Toggle boje: dominantni kanal** — 8 kategorijskih slotova iz postojeće
  validirane palete + „Ostali". Smisleno tek uz jasno „dominantni", ne „kanal".
- **Spuštanje praga na ≥2** (4 328 osoba) uz vizualnu oznaku niskog signala —
  tek nakon što se izmjeri koliko 4,4 % degeneriranih vektora smeta u praksi.
- **`/map?person={slug}`** — skok s osobe na njezine isječke na mapi isječaka.
  Traži per-chunk speaker kolonu u `vector-map.bin` (novi uint16 slot).
- **Vremenska os** — pozicija osobe kroz godine (isti UMAP fit, težine po
  razdoblju). Skupo i lako se pogrešno pročita; zadnje na popisu.

### Nije u opsegu

Voice-embedding rezolucija identiteta (Faza 3 person huba) ostaje deferred.
Mapa je koristi ako se pojavi, ali je ne čeka.

---

## 10. Otvoreni rizici

### R1 — fragmentacija identiteta je na mapi **vidljiva** 🔴

`person-data-gaps.md` §1 mjeri 4 488 od 17 117 jednočlanih slugova. Na mapi to
prestaje biti apstrakcija: „Plenković" i „Andrej Plenković" su dvije točke na
kosinusu 0,95, jedna pored druge, s dvije labele. Isto Putin, Trump, Biden,
Zelenski, Milanović, Orban, Modrić, Satoshi.

**Ovo je istovremeno i prilika.** Prototip nalazi **17 parova** s kosinusom
> 0,90 **i** slug-containmentom pri pragu ≥3 — gotova **radna lista za
`speaker_aliases.csv`**:

```
0,954  Putin ~ Vladimir Putin          0,953  Andrej Plenković ~ Plenković
0,933  Milanović ~ Zoran Milanović     0,930  Satoshi ~ Satoshi Nakamoto
0,917  Donald Trump ~ Trump            0,912  Volodimir Zelenski ~ Zelenski
0,909  Orban ~ Viktor Orban            0,909  Biden ~ Joe Biden
```

Ali lista sadrži i **stvarne pogreške**: „Ivan ~ Ivan Krstitelj",
„Pavao ~ Ivan Pavao II.", „Marija ~ Marija Magdalena", „Franjo ~ Franjo Saleški".
Krivi merge spaja dvije osobe u jednu, što je gore od podjele — kao što
`person-data-gaps.md` §1 već upozorava.

**Mitigacija: mapa emitira `person-map-dupes.json` sidecar (ljudski pregled),
NIKAD ne mergea sama.** Uzor: `vector-map-titles.json`. Odluku donosi čovjek,
upisuje je u seed CSV, `sync-speakers.sh` je pokupi.

### R2 — jednočlani slugovi tvore lažni klaster

Prototip ima klaster k37 = „Marko, Ante, Nikola, Hrvoje, Oliver, Mario, Jelena,
Vlado" (n=30). To nisu ljudi nego **fragmenti**: sama imena bez prezimena, čiji
je semantički profil difuzan pa se skupljaju u sredini. Na mapi izgleda kao
smislen klaster, a nije.

**Naivna mitigacija ne radi — izmjereno.** Pri pragu ≥3 ima **869 jednočlanih
slugova (35,8 %)**, a od njih je 489 ujedno token nekog višečlanog sluga. Ni
jedan od ta dva kriterija nije upotrebljiv kao automatsko prigušenje:

```
jednočlan + token višečlanog:  Isus(594), Pavao(392), Marija(317), Petar(288)   ← legitimni
jednočlan, „čist":             Mojsije(184), Augustin(168), Aristotel(55)        ← legitimni
```

Prigušiti sve jednočlane značilo bi sakriti najveću točku na mapi (Isus, 594
epizoda) i polovicu biblijskog klastera. **Nema sigurnog automatskog pravila.**

**Mitigacija (MVP):** flag se dodjeljuje samo na **mjereni** signal — jednočlan
slug koji je token višečlanog **i** ima kosinus > 0,90 prema njemu. To je 17
parova (§R1), ne 869. Takva točka ostaje **normalno obojena i labelirana**, a u
tooltipu dobiva redak „moguće ista osoba kao *Andrej Plenković*". Vizualnog
prigušenja nema — dvosmislenost se **imenuje**, ne skriva.

### R3 — spomen ≠ tema

Osoba spomenuta usput u epizodi o nečem trećem dobiva puni centroid te epizode.
Pri 13,2 spomena po epizodi to je česta situacija. Efekt slabi s brojem
epizoda (zato prag), ali za osobe pri samom pragu ostaje.

**Mitigacija (Razina 2):** `person_mentions.mention_ts` je razriješen za 58,9 %
redaka — ondje se spomen može vezati na **najbliži chunk** umjesto na cijelu
epizodu, što je bitno uži signal. Nije u MVP-u jer traži drugi izvoz (per-chunk
umjesto per-epizoda centroidi) i jer se učinak ne može procijeniti bez A/B
usporedbe dviju mapa.

### R4 — dvojezičan korpus

`subclub`, `launched`, `founder_talks`, `catholic_futurist` su engleski
(8 165 + 5 394 + 262 + 587 chunkova). bge-m3 je multilingvalan pa embeddinzi
rade, i klaster k1 (Gruber, Arment, Selig) je ispravan — ali **imena klastera
Gemini traži na hrvatskom**. Za engleske klastere to daje pomalo neobične
nazive („Razvoj aplikacija"). Prihvatljivo; jezik sučelja je hrvatski.

### R5 — nestabilnost layouta između runova

UMAP nije determinističan bez `random_state`, a `random_state` isključuje
paralelizam. Mapa isječaka to već živi i rješava nasljeđivanjem labela po
preklapanju članova. Ovdje je isto, samo je članstvo skup slugova umjesto skupa
epizoda. Korisnik koji se vraća sutradan vidjet će drukčije raspoređenu mapu —
**to je poznata cijena, ne bug.** Alternativa (fiksni `random_state`) košta
~2× trajanja i vrijedi razmotriti baš zato što je ovdje ukupno trajanje samo 30 s.

### R6 — prag skriva 87 % osoba

18 252 → 2 426 znači da mapa **ne pokazuje** 15 826 slugova koji u person hubu
postoje i imaju valjan profil. Korisnik koji dođe s `/p/{slug}` neke rijetko
spominjane osobe neće je naći na mapi.

**Mitigacija:** `min_episodes` i `source_slugs` su u snapshotu; frontend to
eksplicitno piše („Prikazano 2 426 od 18 252 osoba — one s barem 3 epizode").
Tražilica koja ne nađe ime nudi izravan link na `/p/{slug}` umjesto praznog
rezultata.

---

## Vezani dokumenti

- `scripts/emit_vector_map.py`, `scripts/sync-vector-map.sh` — uzor pipelinea
- `services/etl/etl/speakers.py` — `build_persons`, `slugify` (identitet)
- `docs/person-hub.md` — kako person hub radi
- `docs/person-data-gaps.md` — rupe u podacima (§1 i §2 su ovdje dopunjene mjerenjima)
- `docs/data-refresh-flow.md` §9 — checklist za novi korak crona
- `../domovina-stats/src/map*.ts` — referentna implementacija point-clouda
- `../domovina-stats/docs/02-data-contract.md` — uzor ugovora
- `../domovina-stats/CLAUDE.md` — dataviz non-negotiables (paleta, jedna os, legenda)
