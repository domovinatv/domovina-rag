# Kako se domovina-rag osvježava

Vizualni pregled cijelog data-refresh ciklusa: od novog YouTube videa kod
producera do svježeg rezultata u semantičkoj (ClickHouse) i keyword (Meilisearch)
pretrazi na cloudu.

> **TL;DR:** Jedan dnevni launchd job na Macu (`04:00`) povuče nove epizode,
> embeda ih lokalno na MPS GPU, i pusha deltu u cloud ClickHouse + re-indeksira
> cloud Meilisearch. Cloud samo poslužuje — ne računa embeddinge.

---

## 1. Big picture — tko što radi

```mermaid
flowchart TB
    subgraph PROD["fetch.domovina.tv  (PRODUCER — drugi repo)"]
        YT[YouTube fetch] --> ASR[Canary ASR + dijarizacija]
        ASR --> GEN[Gemini: summary + članci]
        GEN --> JSONL[("*.rag_combined.jsonl<br/>+ *.article.json<br/>na DOMOVINA1TB/2TB")]
    end

    subgraph MAC["Mac Mini  (domovina-rag — OVAJ repo, lokalno)"]
        CRON{{"launchd 04:00<br/>sync-cron.sh"}}
        EMB[["MPS embedder<br/>bge-m3 1024-d"]]
        LCH[("lokalni ClickHouse")]
        LPG[("lokalni PostgreSQL")]
        LMEILI[("lokalni Meili")]
    end

    subgraph CLOUD["Coolify VPS  (Oracle, BEZ GPU — samo poslužuje)"]
        CCH[("cloud ClickHouse")]
        CMEILI[("cloud Meili")]
        MCP[["MCP server"]]
    end

    subgraph CLIENTS["Klijenti"]
        CLAUDE["Claude.ai<br/>(semantika preko MCP)"]
        WEB["domovina.ai web<br/>(keyword tražilica)"]
    end

    JSONL -.čita.-> CRON
    CRON --> EMB
    EMB --> LCH
    CRON --> LPG
    LCH -- "SSH push delte" --> CCH
    LCH -. "re-index" .-> LMEILI
    LCH == "SSH tunel re-index" ==> CMEILI

    CCH --> MCP --> CLAUDE
    CMEILI --> WEB

    style PROD fill:#2d3748,color:#fff
    style MAC fill:#1a365d,color:#fff
    style CLOUD fill:#22543d,color:#fff
    style CLIENTS fill:#44337a,color:#fff
```

**Ključna odluka:** embedding je skup (bge-m3 je ~40× sporiji na CPU nego na
Apple MPS GPU), a cloud VPS nema GPU. Zato se sve računanje radi **lokalno na
Macu**, a cloud dobiva gotove podatke i samo ih poslužuje.

---

## 2. Dnevni ciklus — `sync-cron.sh` korak po korak

```mermaid
flowchart TD
    START(["launchd okida 04:00<br/>tv.domovina.rag.sync"]) --> CAF[caffeinate<br/>Mac ostaje budan]
    CAF --> CHKEMB{MPS embedder<br/>gore?}
    CHKEMB -- ne --> STARTEMB[pokreni embedder<br/>+ čekaj model load]
    CHKEMB -- da --> CHKDB
    STARTEMB --> CHKDB{lokalni CH + PG<br/>gore?}
    CHKDB -- ne --> STARTDB[docker compose up<br/>postgres clickhouse]
    CHKDB -- da --> SYNC
    STARTDB --> SYNC

    SYNC["<b>sync-incremental.sh</b><br/>(ClickHouse delta)"] --> RC{rc == 0?}
    RC -- da --> MEILILOCAL["sync-meili.sh<br/>(lokalni re-index)"]
    MEILILOCAL --> MEILICLOUD["sync-meili.sh --cloud<br/>(cloud re-index)"]
    MEILICLOUD --> DONE(["log + exit"])
    RC -- ne --> DONE

    style SYNC fill:#1a365d,color:#fff
    style MEILILOCAL fill:#553c1a,color:#fff
    style MEILICLOUD fill:#553c1a,color:#fff
```

Preduvjeti za uspješan run: **Mac budan u 04:00** (ili job krene na buđenju —
launchd `StartCalendarInterval` semantika) i **eksterni diskovi mountani**
(DOMOVINA1TB/2TB; ako nisu, ETL ih preskoči uz WARN). Logovi:
`.ingest-logs/sync-cron-YYYYMMDD.log`.

---

## 3. ClickHouse delta — `sync-incremental.sh`

Srce semantičkog osvježavanja. Idempotentno, pusha samo NOVE epizode.

```mermaid
sequenceDiagram
    autonumber
    participant ETL as ETL (oba diska)
    participant EMB as MPS embedder
    participant LCH as lokalni CH
    participant CCH as cloud CH (SSH)

    ETL->>ETL: discover *.rag_combined.jsonl<br/>(DOMOVINA1TB + 2TB)
    ETL->>LCH: koje epizode već indexirane?<br/>(PG episodes.status)
    Note over ETL: preskoči postojeće (idempotentno)
    loop za svaku NOVU epizodu
        ETL->>EMB: POST /embed (chunkovi)
        EMB-->>ETL: 1024-d vektori
        ETL->>LCH: INSERT rag_chunks
    end
    ETL->>LCH: SELECT youtube_id (length=11)
    ETL->>CCH: SELECT youtube_id (preko SSH)
    Note over ETL,CCH: set-diff po youtube_id<br/>(NE po datumu!)
    ETL->>LCH: SELECT delta FORMAT Native | zstd
    LCH->>CCH: SSH push → INSERT FORMAT Native
    CCH-->>ETL: verifikacija (count match)
```

**Zašto set-diff po `youtube_id` a ne po datumu:** producer zna indeksirati
epizode naknadno — chunk sa starijim `upload_date` od cloud-maxa pojavi se tek
danas. Diff po datumu bi ga promašio. Filter `length=11` izbacuje korumpirane
youtube_id-eve (npr. λ orfan).

---

## 4. Meilisearch re-index — `sync-meili.sh`

Keyword tražilica. Index je **derivat ClickHouse-a** (ne zaseban izvor istine),
pa je puni re-index jeftin (~sekunde za 2562 dokumenta).

```mermaid
flowchart LR
    LCH[("lokalni CH<br/>article_summary<br/>chunkovi")] --> AGG["spoji po youtube_id<br/>→ 1 dokument/epizoda"]
    LPG[("lokalni PG<br/>title")] --> AGG
    AGG --> DOC["{ id, title, channel,<br/>upload_date, section_titles,<br/>article_text, deep_link }"]
    DOC -->|"--local"| LM[("lokalni Meili")]
    DOC -->|"--cloud (SSH tunel)"| CM[("cloud Meili<br/>search.domovina.ai")]

    style LCH fill:#1a365d,color:#fff
    style CM fill:#22543d,color:#fff
```

Dokument je **po epizodi** (ne po sekciji) — korisnik traži "koja epizoda priča o
X", pa uđe u nju. Searchable: `title`, `section_titles`, `article_text`.
Fasete: `channel`, `upload_date`.

---

## 5. Kako podaci stignu do klijenta (read path)

Dvije nezavisne pretrage, komplementarne — ne miješaju se:

```mermaid
flowchart TB
    subgraph SEM["SEMANTIČKA  (značenje)"]
        direction TB
        Q1["Claude.ai upit"] --> MCP[["MCP search_podcasts"]]
        MCP --> QEMB["embed upit (bge-m3)"]
        QEMB --> COS["cosine HNSW<br/>cloud ClickHouse"]
        COS --> R1["top-K chunkova<br/>+ deep linkovi"]
    end

    subgraph KEY["KEYWORD  (egzaktna riječ)"]
        direction TB
        Q2["domovina.ai/search<br/>korisnik tipka"] --> SK["search-only key"]
        SK --> MEILI["cloud Meilisearch<br/>search.domovina.ai"]
        MEILI --> R2["epizode + typo-tolerance<br/>+ fasete, &lt;5ms"]
    end

    style SEM fill:#1a365d,color:#fff
    style KEY fill:#553c1a,color:#fff
```

| | Semantička (ClickHouse) | Keyword (Meilisearch) |
|---|---|---|
| Klijent | Claude / LLM preko MCP | čovjek u web UI |
| Upit | "iskustvo kliničke smrti" (značenje) | "Immaculée Ilibagiza" (točno ime) |
| Jako | konceptualna sličnost | egzaktni match, typo, fasete |

---

## 6. Frekvencija po komponenti

```mermaid
flowchart LR
    subgraph DAILY["DNEVNO — launchd 04:00 (Mac)"]
        CH["ClickHouse delta<br/>sync-incremental.sh"]
        ME["Meili re-index<br/>sync-meili.sh ×2"]
        CH --> ME
    end
    subgraph ONPUSH["NA GIT PUSH — Coolify auto"]
        MCPD["MCP server<br/>(rolling, zero-downtime)"]
    end
    subgraph MANUAL["RUČNO"]
        FE["Frontend domovina.ai<br/>./scripts/deploy.sh<br/>(flutter wasm + wrangler)"]
    end

    style DAILY fill:#22543d,color:#fff
    style ONPUSH fill:#1a365d,color:#fff
    style MANUAL fill:#553c1a,color:#fff
```

| Komponenta | Kada | Mehanizam |
|---|---|---|
| **ClickHouse** (semantika) | dnevno 04:00, delta | launchd → `sync-incremental.sh` → SSH push |
| **Meilisearch** (keyword) | dnevno 04:00, nakon CH | launchd → `sync-meili.sh --local && --cloud` |
| **MCP server** (kod) | na `git push` | Coolify auto-rebuild (rolling) |
| **Frontend** (domovina.ai) | ručno | `./scripts/deploy.sh` (wasm + wrangler Pages) |

---

## 7. Ručno pokretanje (kad ne želiš čekati 04:00)

```bash
cd ~/git/domovinatv/domovina-rag

# Cijeli dnevni ciklus odjednom (kao cron):
./scripts/sync-cron.sh

# Ili pojedinačno:
./scripts/sync-incremental.sh          # CH delta na cloud
./scripts/sync-incremental.sh --dry-run  # samo izračun delte, bez pisanja
./scripts/sync-meili.sh                # lokalni Meili re-index
./scripts/sync-meili.sh --cloud        # cloud Meili re-index
```

---

## 8. Ovisnosti i rizici

```mermaid
mindmap
  root((domovina-rag<br/>refresh))
    Mac budan u 04:00
      inače job krene na buđenju
    Eksterni diskovi mountani
      DOMOVINA1TB + 2TB
      ako ne → ETL preskoči uz WARN
    MPS embedder
      ~40× brži od CPU
      restart ako hang &gt;2-3h
    Disk slobodan
      Docker crash ako &lt;10% free
    SSH do VPS-a
      cloud CH + Meili push
```

**Jedini SPOF je Mac** — sve računanje (embedding) ovisi o njemu. Cloud je čisti
poslužitelj. Ako Mac postane usko grlo, alternativa je embed na GPU box ili cron
na samom VPS-u (veći zahvat, budući sprint).

---

## Vezani dokumenti

- `scripts/sync-incremental.sh`, `scripts/sync-meili.sh`, `scripts/sync-cron.sh`
- `infra/launchd/tv.domovina.rag.sync.plist` — raspored
- `meili-keys-and-frontend.md` — Meili ključevi + frontend wiring
- `coolify-meili-application.md` — Meili deploy
- `cloud_deployment_plan.md` — opći cloud pattern (CF Tunnel, Traefik)
