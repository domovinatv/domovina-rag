# Person hub — stanje podataka i preostale rupe

> **Dopuna 01.08.2026.**: §2 je bio jedina nemjerena rupa i sad je zatvoren
> (udio višegovornih chunkova + otkriće da 43 % korpusa uopće nema govornika).
> Šire mjerenje istog korpusa iz perspektive „koliko osoba ima dovoljno signala"
> je u `docs/plans/2026-08-01-mapa-osoba.md` §1 — ondje su brojke o univerzumu od
> 18 252 sluga i o tome zašto prag od 3 epizode nije proizvoljan.

Izmjereno **29.07.2026.** nad **produkcijskim** PG-om (`postgres-ddvxwyfmd2ynx…`
na dom-001). Ovo je podatkovni pandan `docs/person-hub.md` (koji opisuje kako
sustav radi) i planu `domovina.ai/docs/plans/virtualni-kanali.md` (koji opisuje
kamo ide). Ovdje je samo ono što je **izmjereno**, s upitima za ponavljanje.

Svrha: `/p/:slug` radi end-to-end, ali kvaliteta odgovora ovisi o četiri rupe u
podacima. Nijedna nije bug u kodu — sve su ETL/korpus posao.

## Polazne brojke

| Mjera | Vrijednost |
|---|---|
| `person_mentions` redaka | 39 988 |
| različitih slugova | 17 117 |
| s `person_name` (migr. 005) | 39 988 / 39 988 |
| s razriješenim `mention_ts` | 23 471 (**58,7 %**) |
| `speakers` redaka (govornici) | 2 577 |

```sql
SELECT count(*) redaka, count(DISTINCT slug) slugova, count(person_name) s_imenom,
       count(*) FILTER (WHERE mention_ts > 0) s_ts
FROM person_mentions;
```

**Riješeno 28.07.2026.**: mention-only profili (identitet = `speakers` ∪
`person_mentions`), `person_name` s dijakritikom, spajanje pobožnog prefiksa
(`bl.`/`blaženi` → `ivan-merz`, 33 → 44 spomena). Vidi `docs/person-hub.md`.

---

## 1. Fragmentacija identiteta po prezimenu  ← najveći utjecaj

Ista osoba živi pod dva sluga: puno ime i samo prezime. Korisnik koji dođe na
prezime-slug vidi otprilike pola korpusa, bez ikakvog signala da drugi profil
postoji.

| Puno ime | Samo prezime | Udio na „krivom" profilu |
|---|---|---|
| `andrej-plenkovic` 149 | `plenkovic` 113 | 43 % |
| `zoran-milanovic` 111 | `milanovic` 78 | 41 % |
| `franjo-tudman` 132 | `tudman` 41 | 24 % |

**4 488 od 17 117** slugova (26 %) je jednočlano — nema crticu, dakle jedno ime
ili jedno prezime.

```sql
SELECT count(*) FROM (
  SELECT slug FROM person_mentions GROUP BY 1 HAVING slug NOT LIKE '%-%'
) t;
```

**Zašto još nije riješeno**: `speakers` ima ručni alias mehanizam
(`infra/postgres/seeds/speaker_aliases.csv` → `etl.speakers` seed merge).
`person_mentions` **nema nikakav** ekvivalent — slug je ono što `slugify` izbaci
iz sirovog imena, i tu prestaje.

**Što treba**: alias/canonical sloj koji vrijedi za OBA izvora. Ne može se
automatizirati naslijepo — prezime je često višeznačno („Kovačević"), a krivi
merge spaja dvije stvarne osobe u jedan profil, što je gore od podjele. Realan
opseg: seed CSV za ~100 najčešćih figura + `ambiguous` flag (model ga na
frontendu već poznaje, vidi `PersonHub.ambiguous`) za ostatak.

**Razlika od rizika „Kolizija slugova" u planu**: tamo je *jedan slug → više
osoba* (Mič/Mić). Ovdje je *jedna osoba → više slugova*. Suprotan smjer, druga
mitigacija; plan ovo ne pokriva.

---

## 2. `speaking_seconds` i `duration_seconds` — ne postoje

Blokira odluku O3 (cameo vs primary) iz plana virtualnih kanala. Frontend zato
sve tretira kao `primary` (`classifyPersonEpisodeTier` bez mjerenja → primary,
namjerna graceful degradacija).

**Govor** je u principu izračunljiv: `rag_chunks` ima `start_ts`/`end_ts` po
chunku uz `speaker`. **Ali `speaker` je comma-joined** („Ante Čaljkušić,Dijana
Brozović") — naivni `sum(end_ts - start_ts)` broji isti chunk punim trajanjem
SVAKOM govorniku, pa panel-epizode napuhuju udio. Prag od 15 % je na to izravno
osjetljiv.

> **IZMJERENO 01.08.2026.** (CH je tada odgovorio bez problema; 29.07. nije
> odgovarao ni na jedan upit, pa je ovo dotad stajalo kao nepoznanica):
> ```sql
> SELECT chunk_strategy, count() n, countIf(speaker = '') prazan,
>        countIf(position(speaker, ',') > 0) visegovorni
> FROM rag_chunks WHERE length(youtube_id) = 11 GROUP BY chunk_strategy;
> ```
>
> | `chunk_strategy` | chunkova | bez govornika | višegovornih |
> |---|---|---|---|
> | `topic_transcript` | 83 383 | 0 | **50 793 (60,9 %)** |
> | `article_summary` | 63 704 | **63 704 (100 %)** | 0 |
>
> Dva nalaza, oba mijenjaju plan za (2):
>
> 1. Udio višegovornih chunkova nije „netrivijalan" nego **dominantan (60,9 %)**.
>    Naivni `sum(end_ts - start_ts)` po govorniku napuhuje udio na dvije trećine
>    govornih chunkova — prag od 15 % je time neupotrebljiv bez korekcije.
>    Trajanje chunka treba dijeliti brojem govornika u njemu ili mjeriti iz same
>    diarizacije (per-cue SRT), ne iz chunk granica.
> 2. **43 % korpusa uopće nema govornika**: `article_summary` chunkovi (sažeci)
>    nikad nemaju `speaker`. Za svaki izračun temeljen na govoru postoji samo
>    83 383 od 147 087 chunkova.
>
> Raspodjela broja govornika po govornom chunku: 1 → 32 590, 2 → 42 713,
> 3 → 6 616, 4+ → 1 464.

**Trajanje epizode** nema izvor:

- `episodes.duration_sec` je popunjen u **0 od 2 960** redaka lokalnog PG-a.
- Na **cloud PG-u tablica `episodes` uopće ne postoji** — ondje su samo
  `speakers` i `person_mentions` (`ERROR: relation "episodes" does not exist`).

Dakle trajanje mora doći iz CDN `info.json` ili iz `max(end_ts)` po epizodi.
Isto vrijedi za `avg_magisterium_score` iz ugovora — nije ni u CH ni u PG, živi
samo u CDN JSON-u.

---

## 3. Ad-hoc epizode (`_unlisted`) — F1 iz plana

MSR (`marijana-sarolic-robic`) ima **1 od 17** epizoda uživo
(`dDDwWZPVS0s`, kanal `slijedi_svoj_poziv_2`).

Plan pretpostavlja da je jedina blokada „ETL nije pušten nad `_unlisted`".
Provjera 29.07.: **`_unlisted` nije ni na jednom montiranom disku.**

```
/Volumes/DOMOVINA1TB/fetch_domovina_tv_output/  → 34 direktorija
/Volumes/DOMOVINA2TB/fetch_domovina_tv_output/  → 14 direktorija
                                          ukupno 48 = točno praćeni kanali
```

Prije ETL runa treba **locirati izvor** (druga mašina? samo CDN?) ili čitati
`info.json` s CDN-a — plan potvrđuje da su ondje `channel` i `channel_id`
netaknuti, pa se virtualni kanal može složiti bez ijednog YouTube poziva.

---

## 4. `mention_ts` pokrivenost 58,7 %

23 471 / 39 988 spomena ima razriješen trenutak; preostalih **41 %** otvara
cijelu epizodu. Od v2.0.120 to je bar pošteno označeno u UI-u (prigušeni chip
„spomen negdje u epizodi" vs puna crvena „spomen u 16:45"), pa nije tiha
degradacija.

Uzrok je strukturni, ne bug: `mention_ts` se izvodi iz `article.json`
`sections[].entities`, a `summary.mentioned_people` je **šire** od onoga što
sekcijski entiteti hvataju. Za veću pokrivenost treba pravi NER nad
transkriptom, ne bolja heuristika nad istim izvorom. Vidi „Timestamp deep-link"
u `docs/person-hub.md`.

---

## Predloženi redoslijed

1. **(1)** — najjeftinije, najviše mijenja doživljaj, bez novih shema.
2. **(3)** — otključava virtualne kanale kao feature; prvi korak je pronaći izvor.
3. **(2)** — najskuplje; mjernu zamku riješiti PRIJE nego prag od 15 % uđe u UI.
4. **(4)** — istraživački posao (NER), ne dorada.
