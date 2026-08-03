# Merge identiteta — pregled kandidata (O5)

> 03.08.2026. Odgovor na otvorenu stavku **O5** iz
> `2026-08-03-mapa-osoba-odluke-i-zamke.md` §4: `person-map-dupes.json` nudi
> 18 parova kandidata, a odluka je bila „čeka ljudski pregled".
>
> Ovaj dokument NE mijenja `speaker_aliases.csv`. On daje dokaze po paru i
> prijedlog, da odluka bude potvrda, a ne istraživanje.

## 1. Zašto kosinus nije dokaz

Svi kandidati u `person-map-dupes.json` imaju `cos > 0,9` — to je uvjet po kojem
su uopće ušli na listu, pa među njima ne razlikuje ništa. Najviši kosinus na
listi (0,96, „Isus" ~ „Isus Krist") i sedmi po redu (0,93, „Pavao" ~
„Ivan Pavao II.") vode na suprotne odluke.

Razlog je u samoj definiciji embeddinga osobe (plan §2): vektor je centroid
epizoda u kojima se osoba pojavljuje. Dvije **različite** osobe o kojima se
govori u istim epizodama imaju gotovo isti centroid. Kosinus mjeri „pojavljuju
se u istom kontekstu", a pitanje je „jesu li ista osoba" — to nije isto.

## 2. Dva signala koja jesu dokaz

### 2.1 Dominacija proširenja

Za kratko ime (`Trump`, `Ivan`) skupe se sva puna imena u korpusu koja to ime
sadrže kao zasebnu riječ, pa se gleda **udio vodećeg u ukupnom broju epizoda**:

```
dominacija = epizode(najveće proširenje) / Σ epizode(sva proširenja)
```

Smisao: ako jedno proširenje nosi gotovo svu masu, kratko ime je u praksi ta
osoba. Ako je masa razdijeljena, kratko ime nije osoba nego **skup ljudi** i
merge bi jednoj osobi pripisao tuđe spomene.

Ovo hvata razliku koju broj proširenja ne hvata: „Putin" ima 2 proširenja, ali
je drugo tipfeler od jedne epizode (dominacija 0,99); „Franjo" ima 56 proširenja
i nijedno ne dominira (0,48).

### 2.2 Preklapanje epizoda

Ista osoba pod dva imena: sažimatelj po epizodi bira jedan oblik, pa je
preklapanje **~0**. Visoko preklapanje znači da se oba imena pojavljuju u istoj
epizodi, dakle riječ je o **dvije osobe o kojima se govori zajedno**.

Najjasniji slučaj na listi: „Pavao" i „Ivan Pavao II." dijele **73 epizode**.

**Prag korišten ispod:** merge ako `dominacija ≥ 0,85` **i**
`preklapanje / min(epizode) < 0,05`.

## 3. Rezultat — 18 parova

| kratki | puni | zaj. ep. | dominacija | vodeće proširenje | odluka |
|---|---|---:|---:|---|---|
| Isus | Isus Krist | 0 | 0,96 | Isus Krist (173) | **DA** |
| Plenković | Andrej Plenković | 0 | 0,98 | Andrej Plenković (151) | **DA** |
| Putin | Vladimir Putin | 0 | 0,99 | Vladimir Putin (78) | **DA** |
| Milanović | Zoran Milanović | 1 | 0,92 | Zoran Milanović (114) | **DA** |
| Satoshi | Satoshi Nakamoto | 0 | 0,90 | Satoshi Nakamoto (9) | **DA** |
| Trump | Donald Trump | 1 | 0,94 | Donald Trump (221) | **DA** |
| Zelenski | Volodimir Zelenski | 0 | 0,87 | Volodimir Zelenski (34) | **DA** |
| Biden | Joe Biden | 0 | 0,92 | Joe Biden (59) | **DA** |
| Orban | Viktor Orban | 0 | 1,00 | Viktor Orban (52) | **DA** |
| Ivan | Ivan Krstitelj | 7 | 0,23 | Ivan Pavao II. (255) | NE |
| Ivan | Ivan Apostol | 1 | 0,23 | — | NE |
| Ivan | Ivan od Križa | 4 | 0,23 | — | NE |
| Ivan | Ivan Zlatousti | 4 | 0,23 | — | NE |
| Marija | Djevica Marija | 0 | 0,12 | Marija Magdalena (37) | NE |
| Marija | Marija Magdalena | 10 | 0,12 | — | NE |
| Pavao | Ivan Pavao II. | **73** | 0,60 | Ivan Pavao II. (255) | NE |
| Franjo | Franjo Saleški | 3 | 0,48 | Papa Franjo (281) | NE |
| Franjo | Franjo Asiški | 1 | 0,48 | — | NE |

### 3.1 Zamke — zašto četiri kratka imena ostaju kakva jesu

Nisu granični slučajevi; svako je dokazivo skup ljudi:

| kratko ime | dominacija | vodeći kandidati (epizode) |
|---|---:|---|
| **Ivan** (228 ep) | 0,23 | Ivan Pavao II. 255 · Ivan Krstitelj 87 · Papa Ivan Pavao II. 48 · Ivan Merz 46 — i još 327 |
| **Marija** (317 ep) | 0,12 | Marija Magdalena 37 · Djevica Marija 30 · Marija Selak Raspudić 25 · Marija Petković 12 — i još 147 |
| **Pavao** (392 ep) | 0,60 | Ivan Pavao II. 255 · Papa Ivan Pavao II. 48 · Papa Pavao VI 38 · Pavao VI 25 |
| **Franjo** (131 ep) | 0,48 | Papa Franjo 281 · Franjo Tuđman 134 · Franjo Asiški 39 · Franjo Saleški 33 |

„Franjo" je najjasnija ilustracija: dva vodeća kandidata su **papa i predsjednik**.
Bilo koji merge tu je pogrešan u većini slučajeva.

Ovo je ista pojava kao **O6** (klaster jednočlanih imena) — jednočlani slug u
ovom korpusu nije osoba nego fragment. Razlika je što ovdje ima mjeru
(dominacija), pa se barem zna KOJI su jednočlani slugovi sigurni.

## 4. Prijedlog za `infra/postgres/seeds/speaker_aliases.csv`

Format je `slug,alias` gdje je `slug` ciljni kanonski slug, a `alias` se
slugificira pri učitavanju (`etl.speakers._load_seed` → `{slugify(alias): slug}`).
Isti seed vrijedi i za govornike i za spomene — `emit_person_map.py` primjenjuje
`canon()` na oba puta, pa merge odmah mijenja i mapu.

### 4.1 Iz liste kandidata (9)

```csv
isus-krist,Isus
andrej-plenkovic,Plenković
vladimir-putin,Putin
zoran-milanovic,Milanović
satoshi-nakamoto,Satoshi
donald-trump,Trump
volodimir-zelenski,Zelenski
joe-biden,Biden
viktor-orban,Orban
```

### 4.2 Bonus — varijante zapisa koje lista NE vidi

`person-map-dupes.json` uspoređuje samo osobe **iznad praga ≥3 epizode** i samo
parove iznad kosinusa, pa mu promaknu varijante istog imena. Nađene su usput,
pri brojanju proširenja. Sve imaju **0 zajedničkih epizoda** (isti obrazac kao
potvrđeni merge-evi):

```csv
ivan-pavao-ii,Papa Ivan Pavao II.      # 48 ep → 255 ep
ivan-merz,Ivan Merc                    # 27 ep → 46 ep (transkripcijska greška)
pavao-vi,Papa Pavao VI                 # 38 ep → 25 ep
volodimir-zelenski,Vladimir Zelenski   # 5 ep → 34 ep
isus-krist,Isus iz Nazareta            # 5 ep → 173 ep
andrej-plenkovic,Andreja Plenković     # 1 ep
joe-biden,Joseph Biden                 # 1 ep
joe-biden,Predsjednik Biden            # 1 ep
vladimir-putin,Vladimir Vladimirovič Putin  # 1 ep
```

`ivan-merc → ivan-merz` je najveći pojedinačni dobitak u kvaliteti podataka
(27 epizoda blaženika vodilo je na zaseban, prazan profil).

**Kontrola koja je prošla:** `papa-franjo` (281 ep) i `franjo-asiski` (39 ep)
dijele **15** epizoda → pravilo ih ispravno NE spaja, iako im je ime slično.

### 4.3 Kako primijeniti

```bash
cd ~/git/domovinatv/domovina-rag
# dopiši retke u infra/postgres/seeds/speaker_aliases.csv, pa:
./scripts/sync-speakers.sh && ./scripts/sync-speakers.sh --cloud
./scripts/sync-person-map.sh --force
```

Nakon toga `person-map-dupes.json` mora imati **9 kandidata manje**, a broj osoba
iznad praga pasti za isto toliko.

## 5. Što ostaje otvoreno

- Četiri kratka imena iz §3.1 nemaju sigurno automatsko rješenje. Opcija koja se
  NIJE ovdje odlučivala: izbaciti jednočlane slugove s dominacijom < 0,85 iz
  mape (ne iz baze). To bi maknulo „Ivan", „Marija", „Pavao", „Franjo" —
  4 od 2 426 točaka — i zatvorilo dio O6. Traži zasebnu odluku jer mijenja
  pravilo tko ulazi na mapu.
- Prag `dominacija ≥ 0,85` je odabran tako da razdvoji izmjereni raspon (0,87 …
  1,00 nasuprot 0,12 … 0,60) — u podacima je **prazan pojas između 0,60 i 0,87**,
  pa je izbor unutar njega neosjetljiv.
