# F1 — ad-hoc epizode u korpus, izvor je CDN (ne disk)

> Plan, 29.07.2026. Faza **F1** iz `../domovina.ai/docs/plans/virtualni-kanali.md`.
> Zatvara rupu §3 iz `docs/person-data-gaps.md` i, usput, mjernu zamku iz §2.

## Cilj

`GET /api/person/marijana-sarolic-robic` vraća **17 epizoda** umjesto današnje
jedne, svaka s ispravnim izvornim kanalom (N1, Lider, TEDx Talks…), bez ijednog
poziva prema YouTubeu i bez ijednog fajla s diska. Time cijeli frontend
virtualnih kanala — koji je već landan i deployan u `domovina.ai` v2.0.122 iza
`PersonChannelFlag` — prvi put dobiva sadržaj koji može prikazati.

Uz to, epizode dobivaju **`speaking_seconds` po imenovanom govorniku**,
izračunat iz per-cue diariziranog SRT-a. To je ulaz za tier `primary`/`cameo`
(odluka O3) i zaobilazi mjernu zamku zbog koje je taj podatak dosad bio
neupotrebljiv.

## Kontekst

Sve brojke ispod su **izmjerene 29.07.2026.**, uz naredbu kojom se ponavljaju.
Gdje se ovaj plan razilazi s `docs/person-data-gaps.md` §3 i s planom
virtualnih kanala, mjerenje ima prednost — ti su dokumenti stariji.

### Zatečeno stanje

MSR ima 17 obrađenih epizoda (katalog:
`../certilia-esign/podcast/MSR-OBRADENI-VIDEI.md`), a u korpusu je **jedna**:

```bash
curl -s https://mcp.domovina.ai/api/person/marijana-sarolic-robic | jq .episode_count
# → 1
```

Uzrok nije mapiranje kanala nego izostanak podataka: **16 od 17 epizoda nema
nijedan chunk u ClickHouseu.**

```sql
-- docker exec domovina-rag-infra-clickhouse-1 clickhouse-client -d rag --query "…"
SELECT youtube_id, any(channel), count() FROM rag_chunks
WHERE youtube_id IN ('bkp-0X4aG9E','dDDwWZPVS0s',…17 id-eva…) GROUP BY youtube_id;
-- → jedan redak: dDDwWZPVS0s | slijedi_svoj_poziv_2 | 14
```

ETL čita `{input_dir}/{channel_slug}/{basename}.rag_combined.jsonl`
(`services/etl/etl/sources.py:87`, glob `_JSONL_GLOB`, basename regex
`_BASENAME_RE` na `:44`). Tog producer outputa za tih 16 epizoda **nema ni na
jednom montiranom disku** — `_unlisted` direktorij ne postoji
(`/Volumes/DOMOVINA1TB/fetch_domovina_tv_output/` 34 + `DOMOVINA2TB/` 14 = 48
direktorija, točno praćeni kanali).

### Otkriće koje mijenja pristup: sve što treba je na CDN-u

`docs/person-data-gaps.md` §3 kaže „prvi korak F1 je locirati izvor (druga
mašina? samo CDN?)". Izvor je **CDN**, i nosi više nego što je taj doc
pretpostavio. Provjereno na sve 17 epizoda (`https://cdn.domovina.ai/data/<id>/`):

| Fajl | Što nosi | Pokrivenost |
|---|---|---|
| `info.json` | `channel`, `channel_id`, `duration` | 17/17 |
| `summary.json` | `summary.speakers[]` = **SPEAKER_XX → suggested_name + role**, `summary.mentioned_people[]` | 17/17 |
| `diarized.srt` | cue-ovi `HH:MM:SS,mmm --> …` + `[SPEAKER_XX] tekst` | 17/17 |
| `article.json` | `iterations[].sections[]` sa `screenshot_timestamp` + `entities[]` | 17/17 |
| `article.magisterium.json` | Magisterium ocjene | 17/17 |

Ključno: `diarized.srt` sam nosi **samo anonimne** `SPEAKER_XX` oznake, ali
`summary.json` nosi mapu u imena. Spoj to dvoje daje imenovanog govornika s
vremenskim rasponima — točno ono što `speakers` i `rag_chunks.speaker` trebaju.

Primjer (`AVsBPQ7iLSQ`, N1):

```json
"speakers": [
  {"id": "SPEAKER_00", "suggested_name": "Ivana Dragičević",       "role": "voditelj"},
  {"id": "SPEAKER_01", "suggested_name": "Marijana Šarolić Robić", "role": "gost"}
]
```

**Kontrolni zbroj koji potvrđuje da je to isti korpus:** zbroj `info.duration`
kroz svih 17 epizoda = **49 151 s** (13 h 39 min 11 s) — znak u znak isto kao
neovisno izračunat zbroj iz kataloga (`virtualni-kanali.md` §4.2). Reproduciraj
skriptom iz *Verifikacije*.

### Izmjerene govorne sekunde (i što one znače za prag)

Iz SRT-a, zbrajanjem trajanja cue-ova po `SPEAKER_XX` pa mapiranjem u ime:

| youtube_id | kanal | trajanje | MSR govori | udio |
|---|---|---:|---:|---:|
| `davaNFH62oQ` | TEDx Talks | 593 | 535 | 90 % |
| `C0twNvhPq7g` | MBA Croatia | 3649 | 3085 | 85 % |
| `bkp-0X4aG9E` | Lider | 1667 | 1352 | 81 % |
| `dDDwWZPVS0s` | Centar Ignacije | 1038 | 829 | 80 % |
| `AVsBPQ7iLSQ` | N1 | 3076 | 1966 | 64 % |
| `FFdkjhc9hEY` | COTRUGLI Business School | 292 | 167 | 57 % |
| `R3W0fskEptk` | LeaderSHE | 4886 | 1281 | 26 % |
| `PrPHDgVlqIA` | IUS-INFO | 2858 | 751 | 26 % |
| `UaRMz1geMag` | Hrvatsko društvo skladatelja | 4993 | 1034 | 21 % |
| `Ib7ebBOAwWs` | Poduzetnički Mindset | 638 | 110 | 17 % |
| `GCho3KkCjGc` | globalthinkersforum | 2507 | 352 | 14 % |
| `glG9kVRGivQ` | Borna Kos | 4162 | 440 | 11 % |
| `CZZiby8IAUQ` | Poslovni dnevnik | 2598 | 254 | 10 % |
| `hHyF_UqPKtk` | SLO CRO Gospodarska komora | 7379 | 590 | 8 % |
| `cZqcZRBiGQo` | MTG ZIP | 4272 | 144 | 3 % |
| `5c9yfPm8yfs` | KnowING IPR | 2393 | — | ime ne matcha |
| `r6VnaAZDmF8` | biznis world | 2150 | — | ime ne matcha |

Dvije posljedice koje plan izvodi bez preispitivanja:

1. **Mjerna zamka iz `person-data-gaps.md` §2 ovdje ne postoji.** Ta zamka
   vrijedi za `rag_chunks.speaker` koji je comma-joined — izmjereno danas,
   **34,5 %** chunkova je višegovorno (48 831 / 141 340), pa bi naivni
   `sum(end_ts - start_ts)` po govorniku napuhao trećinu korpusa. SRT cue ima
   **točno jednog** govornika, pa je zbrajanje po cue-u točno po konstrukciji.
   Zato se `speaking_seconds` računa **iz SRT-a, nikad iz chunk granica.**
2. **Prag iz O3 (`>= 15 %` ILI `>= 300 s`) daje 13 `primary` + 2 `cameo`**
   (`CZZiby8IAUQ` 254 s/10 %, `cZqcZRBiGQo` 144 s/3 %). Hero za MSR će dakle
   pisati **13**, ne 17 — 15 epizoda ukupno dok se ne riješi točka 3 niže. To je
   očekivano ponašanje O3, ne bug; zapisano je ovdje da netko ne „popravi" broj.

### Dvije epizode traže alias

`5c9yfPm8yfs` i `r6VnaAZDmF8` imaju MSR pod ASR/LLM varijantom imena:

```
5c9yfPm8yfs → "Marjana Šarolić Robić"   → slug marjana-sarolic-robic   (Marjana / Marijana)
r6VnaAZDmF8 → "Marijana Šarlić-Robić"   → slug marijana-sarlic-robic   (Šarlić / Šarolić)
```

To je isti mehanizam kao rupa §1 (fragmentacija identiteta), samo u smjeru
varijante imena. Postojeći alias sloj je `infra/postgres/seeds/speaker_aliases.csv`
→ `etl.speakers` seed merge (`docs/person-hub.md`, „Normalizacija", korak 5).
Bez ta dva unosa kriterij prihvaćanja je 15, ne 17.

### Što ovaj plan NE pretpostavlja

- Ne pretpostavlja da je `_unlisted` igdje pronalaziv. Ako se disk jednog dana
  nađe, ingest kroz `rag_combined.jsonl` i dalje radi — CDN putanja je **drugi
  izvor za isti loader**, ne zamjena.
- Ne pretpostavlja da CDN ima `rag_combined.jsonl`. Nema ga; chunkovi se
  **sintetiziraju** iz SRT-a (vidi T2, „Zašto chunkovi, a ne samo speakers").

## Taskovi

### T1 — CDN izvor: čitač + parser (bez upisa u bazu)

- **Fajlovi**: `services/etl/etl/cdn_source.py` (novi),
  `services/etl/tests/test_cdn_source.py` (novi),
  `services/etl/tests/fixtures/cdn/` (novi direktorij s uzorcima)
- **Opis**: modul koji za dani `youtube_id` dohvati s
  `https://cdn.domovina.ai/data/<id>/` fajlove `info.json`, `summary.json`,
  `diarized.srt` i vrati strukture koje ostatak ETL-a već razumije:
  - `CdnEpisode` — `youtube_id`, `title`, `channel_name` (`info.channel`),
    `channel_youtube_id` (`info.channel_id`), `channel_slug` (ASCII-fold +
    razmak→`_` nad `info.channel`: „Centar Ignacije" → `centar_ignacije`),
    `upload_date`, `duration_seconds` (`info.duration`).
  - `SpeakerSegment[]` — `speaker_name`, `start_ts`, `end_ts`, `text`, nastalo
    spajanjem SRT cue-ova s mapom `summary.speakers[].id → suggested_name`.
  - `speaking_seconds_by_name` — zbroj `end_ts - start_ts` po imenu.
  - `mentioned_people` iz `summary.mentioned_people` (za postojeći mentions tok).
  Rubni slučajevi koji MORAJU biti pokriveni testom, jer se svi pojavljuju u
  korpusu: govornik bez `suggested_name` ili sa `suggested_name` koji je uloga
  („Su-voditelj", vidi `5c9yfPm8yfs`) → **ne** postaje osoba, ali njegovo
  vrijeme se i dalje broji u trajanje epizode; `summary.json` bez `speakers`
  ključa; SRT cue bez `[SPEAKER_XX]` prefiksa; 404 na bilo kojem od tri fajla
  (epizoda se preskače uz jasan log, ne ruši run).
  Postojeći `_ROLE_RE` + blocklist iz `services/etl/etl/speakers.py` je
  **jedini** izvor istine za „ovo je uloga, ne ime" — ne piši drugu listu.
- **Definicija gotovog**: `python -m pytest services/etl/tests/test_cdn_source.py -q`
  prolazi nad fixture-ima (bez mreže); ručna provjera nad `AVsBPQ7iLSQ` vraća
  `duration_seconds == 3076` i `speaking_seconds_by_name["Marijana Šarolić Robić"]`
  u rasponu 1960–1970 s.

### T2 — Ingest ad-hoc epizoda iz CDN-a u ClickHouse

- **Fajlovi**: `services/etl/etl/load.py`, `services/etl/etl/__main__.py`,
  `services/etl/tests/test_cdn_ingest.py` (novi)
- **Opis**: nova CLI podkomanda `python -m etl ingest-cdn --ids <file|lista>`
  (uz postojeće `ingest`/`mentions`/`speakers` u `__main__.py:330`) koja kroz
  `cdn_source` (T1) upisuje u `rag_chunks` i okida postojeći mentions hook.

  **Zašto chunkovi, a ne samo `speakers` redak**: `/api/person` gradi
  `episodes[]` agregacijom nad `rag_chunks` (`docs/person-hub.md`, „Endpoint
  matcha osobu kao cijeli token"). Bez chunkova epizoda ne postoji ni za jedan
  postojeći upit — dodavanje reda u `speakers` dalo bi osobu bez epizoda.

  Chunk se sintetizira **grupiranjem uzastopnih SRT cue-ova istog govornika** do
  praga (predlažem ~90 s ili prekid govornika, što prije nastupi). `speaker` se
  upisuje kao **jedno ime po chunku** — ne comma-joined; to je moguće upravo
  zato što je grupiranje po govorniku, i time novi zapisi ne nasljeđuju zamku
  od 34,5 %. `chunk_strategy` = `cdn_srt` da se sintetizirani chunkovi mogu
  razlikovati od producerovih u svakom kasnijem upitu.

  **Mapiranje kanala** (ključni zahtjev iz plana virtualnih kanala): kanal se
  NE smije zapisati kao `_unlisted`. Ako `channel_slug` izveden iz
  `info.channel` već postoji među praćenim kanalima → koristi postojeći; inače
  novi netracked zapis. `dDDwWZPVS0s` se **ne smije duplicirati** — već je u CH
  pod `slijedi_svoj_poziv_2`, i taj redak ima prednost pred CDN verzijom.
- **Definicija gotovog**: run nad 17 ID-eva je **idempotentan** (drugi run ne
  mijenja `count()`); nakon runa
  `SELECT uniq(youtube_id) FROM rag_chunks WHERE youtube_id IN (…17…)` = 17;
  `SELECT uniq(channel) …` = 17 i nijedan nije `_unlisted`;
  `dDDwWZPVS0s` i dalje ima `channel = 'slijedi_svoj_poziv_2'`;
  ukupan broj epizoda u CH poraste za točno 16 (3034 → 3050).
- **Ovo pokreće ORKESTRATOR, nad lokalnim CH, tek nakon `VERDIKT: OK`.**

### T3 — `speaking_seconds` i `duration_seconds` kao trajni podatak

- **Fajlovi**: `infra/clickhouse/migrations/` (novi fajl s `ALTER TABLE … ADD
  COLUMN IF NOT EXISTS`), `services/etl/etl/db.py`,
  `services/etl/tests/test_speaking_seconds.py` (novi)
- **Opis**: trajno zapiši ono što T1 izračuna, da `/api/person` (F2) ne mora
  ponovo parsirati SRT. Minimalno: `episode_speakers (youtube_id, speaker_name,
  speaking_seconds, duration_seconds)` ili ekvivalentne kolone — **dev bira
  oblik i obrazlaže ga u sažetku**, uz uvjet da se puni i za epizode koje su
  ušle preko `rag_combined.jsonl`, ne samo za CDN put.
  **PROVJERITI prvi korak**: postoji li `infra/clickhouse/migrations/` uopće —
  u repou je dosad viđen samo `infra/clickhouse/init.sql`, a init se NE re-runa
  (`docs/person-hub.md`, „Deploy mentions"). Ako direktorija nema, uspostavi ga
  po uzoru na `infra/postgres/migrations/`.
- **Definicija gotovog**: za `AVsBPQ7iLSQ` upit vraća MSR ≈ 1966 s uz
  `duration_seconds` 3076; kolona postoji i nakon ponovnog pokretanja ingesta;
  test prolazi.

### T4 — Alias za dvije varijante imena

- **Fajlovi**: `infra/postgres/seeds/speaker_aliases.csv`,
  `services/etl/tests/test_speakers.py`
- **Opis**: dodaj `Marjana Šarolić Robić` i `Marijana Šarlić-Robić` kao aliase
  kanonske `marijana-sarolic-robic`. Provjeri da postojeći seed-merge korak
  (`speakers.py`, korak 5 normalizacije) to primijeni i na CDN-om unesene
  govornike, ne samo na disk-om unesene. Ako mehanizam radi samo za jedan put,
  to je nalaz — zapiši ga u sažetak, ne krpaj šire od ovog taska.
- **Definicija gotovog**: nakon `python -m etl speakers`,
  `/api/person/marijana-sarolic-robic` (lokalno) broji i te dvije epizode;
  `test_speakers.py` ima slučaj za obje varijante.
- **Van opsega ovog taska**: šira fragmentacija po prezimenu (rupa §1) — to je
  zaseban krug. Ovdje samo dva unosa koja blokiraju kriterij prihvaćanja.

### T5 — Sync u PG i dokumentacija

- **Fajlovi**: `docs/person-hub.md`, `docs/person-data-gaps.md`,
  `services/etl/README.md`
- **Opis**: dopiši CDN putanju kao **drugi izvor** u „Komponente" i u deploy
  runbook (`ingest-cdn` → `speakers` → `sync-person-mentions.sh`). U
  `person-data-gaps.md` ispravi §3 (izvor je pronađen — CDN, ne disk) i §2
  (mjerna zamka: 34,5 % višegovornih izmjereno; SRT put je zaobilazi;
  `duration_seconds` ima izvor u `info.json`). Ne brisati stare brojke nego ih
  datirati — taj doc je zapisnik mjerenja.
- **Definicija gotovog**: netko tko pročita samo `person-hub.md` zna pokrenuti
  cijeli tok od nule; nijedna tvrdnja u `person-data-gaps.md` §2–§3 nije više
  netočna.

## Ovisnosti

```
Krug 1:  T1              (sve ostalo troši cdn_source)
Krug 2:  T2 ‖ T4         (load.py/__main__.py vs seeds/test_speakers.py — disjunktno)
Krug 3:  T3              (dira db.py + migracije; ovisi o T2 obliku podataka)
Krug 4:  T5              (dokumentacija — nakon što su brojke potvrđene runom)
```

- `T1 → T2, T3` — oba troše `cdn_source`.
- `T2 → T3` — T3 trajno zapisuje ono što T2 upisuje; različit oblik podataka
  znači drukčiju shemu.
- `T4` je neovisan o T1–T3 po fajlovima i smije ići paralelno s T2, ali se
  **verificira tek nakon T2 runa** (bez epizoda nema što aliasirati).
- **T2 i T3 NE smiju ići istovremeno** — oboje diraju put upisa.

## Rizik

**Ukupno: srednji.**

- **T2 je visok** dok se ne dokaže lokalno: piše u `rag_chunks`, tablicu koju
  čita živi `/api/person`. Sintetizirani chunkovi s krivim `speaker` poljem
  pripisali bi tuđe epizode nečijem profilu — reputacijski problem opisan u
  tablici rizika plana virtualnih kanala. Orkestrator neka digne reviewera na
  Opus za T2 i T3.
- **T3 je visok** — mijenja shemu (`ALTER TABLE`), a `init.sql` se ne re-runa.
- T1, T4, T5 su niski: čisto čitanje, dva retka seeda, dokumentacija.

Cijeli posao je aditivan prema frontendu: `domovina.ai` ne treba nikakvu izmjenu
da bi vidio 17 epizoda, jer `episode_count` i `episodes[]` već postoje u ugovoru.

## Verifikacija

**Prije ijedne izmjene** — reproduciraj polazne brojke (ovo je i regresijska
osnovica):

```bash
# 1. koliko epizoda MSR ima danas (očekivano: 1)
curl -s https://mcp.domovina.ai/api/person/marijana-sarolic-robic | jq .episode_count

# 2. koliko ih je u lokalnom CH (očekivano: 1 redak, dDDwWZPVS0s)
docker exec domovina-rag-infra-clickhouse-1 clickhouse-client -d rag --query \
  "SELECT youtube_id, any(channel), count() FROM rag_chunks WHERE youtube_id IN
   ('bkp-0X4aG9E','dDDwWZPVS0s','glG9kVRGivQ','hHyF_UqPKtk','FFdkjhc9hEY',
    'CZZiby8IAUQ','AVsBPQ7iLSQ','R3W0fskEptk','UaRMz1geMag','5c9yfPm8yfs',
    'Ib7ebBOAwWs','davaNFH62oQ','cZqcZRBiGQo','GCho3KkCjGc','r6VnaAZDmF8',
    'C0twNvhPq7g','PrPHDgVlqIA') GROUP BY youtube_id"

# 3. ukupno epizoda u CH (očekivano: 3034 — nakon T2 mora biti 3050)
docker exec domovina-rag-infra-clickhouse-1 clickhouse-client -d rag --query \
  "SELECT uniq(youtube_id) FROM rag_chunks"

# 4. udio višegovornih chunkova (očekivano: 48831/141340 = 34,5 %)
docker exec domovina-rag-infra-clickhouse-1 clickhouse-client -d rag --query \
  "SELECT count(), countIf(position(speaker, ',') > 0) FROM rag_chunks"
```

**Kontrolni zbroj CDN korpusa** (mora dati točno `49151`; ako ne da, CDN se
promijenio i plan treba revalidirati prije nastavka):

```bash
for id in bkp-0X4aG9E dDDwWZPVS0s glG9kVRGivQ hHyF_UqPKtk FFdkjhc9hEY \
          CZZiby8IAUQ AVsBPQ7iLSQ R3W0fskEptk UaRMz1geMag 5c9yfPm8yfs \
          Ib7ebBOAwWs davaNFH62oQ cZqcZRBiGQo GCho3KkCjGc r6VnaAZDmF8 \
          C0twNvhPq7g PrPHDgVlqIA; do
  curl -s "https://cdn.domovina.ai/data/$id/info.json" | jq .duration
done | paste -sd+ - | bc
```

**Nakon svakog taska**: `python -m pytest services/etl/tests -q`.
Ako task dira TypeScript: `cd services/mcp && npm run typecheck`.

**Kriterij prihvaćanja cijelog F1** (lokalno, prije ijednog dodira clouda):

1. `SELECT uniq(youtube_id) FROM rag_chunks WHERE youtube_id IN (…17…)` = **17**
2. `SELECT uniq(channel) …` = **17**, i `countIf(channel = '_unlisted')` = **0**
3. `dDDwWZPVS0s` i dalje `channel = 'slijedi_svoj_poziv_2'`, bez duplikata
4. Nakon `python -m etl speakers`: lokalni `/api/person/marijana-sarolic-robic`
   vraća `episode_count = 17` i `channel_count = 17`
5. Regresija: `tomislav-belavic` nije izgubio nijednu epizodu
   (danas 6 — provjeri prije i poslije)
6. Drugi run cijelog toka ne mijenja nijednu od gornjih brojki (idempotentnost)

**Tek nakon toga**, i uz izričitu potvrdu čovjeka: ista migracija + sync nad
cloud PG-om (`./scripts/sync-person-mentions.sh --cloud`) i, ako plan to zatraži
u sljedećem krugu, `services/mcp/deploy.sh`.

## Van opsega

- **F2** — `GET /api/persons` index, `person_channel_overrides`/`person_optouts`
  tablice, tier polja u `/api/person` odgovoru. Zaseban plan; F1 mu isporučuje
  podatke koje će trošiti.
- **Fragmentacija identiteta po prezimenu** (rupa §1) — ovdje samo dva aliasa
  nužna za kriterij prihvaćanja. Napomena za taj budući krug: „4 488 jednočlanih
  slugova" je **loš proxy** za veličinu problema — izmjereno danas, glava te
  distribucije su biblijske/jednoimene figure (`isus` 575, `pavao` 382,
  `marija` 304, `mojsije` 178…) kod kojih je jednočlano ime kanonsko i merge bi
  bio štetan; prezimenskih je malo (`trump` 147, `putin` 118).
- **`mention_ts` pokrivenost** (rupa §4) — traži NER, nije dorada.
- **`fetch.domovina.tv`** — producer repo se ne dira; `generate_channel_index.js`
  i dalje preskače `_` prefiks i ad-hoc epizode namjerno ne ulaze u
  `channels/data/index.json`.
- **`domovina.ai`** — frontend je gotov i deployan; ovaj krug ga ne dira.
- **Obavijest MSR-u prije javne objave** (odluka O8, opt-out tok) — to je
  vlasnikov korak prije nego što se `PersonChannelFlag` upali, ne devov.
