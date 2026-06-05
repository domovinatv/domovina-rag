# A2A — single source of truth

> **Ovo je jedina referentna točka za A2A (Agent2Agent) protokol u domovina-rag.**
> Sve potrebno da sagradiš vlastiti A2A server nad svojim podacima je ovdje.
> Istraženo i destilirano 2026-06-05 (firecrawl). Referentni uzor: **Magisterium AI**.

## Što je ovdje

| Dokument | Sadržaj | Kad čitati |
|---|---|---|
| [`protocol-reference.md`](protocol-reference.md) | **Destilirana A2A spec** — sve sheme (Task/Message/Part/Artifact/AgentCard), JSON-RPC metode, error kodovi, security, kanonski primjeri. Samodostatno za implementaciju. | Dok pišeš kod |
| [`build-guide.md`](build-guide.md) | **Konkretni plan Faze 1** — kako izložiti domovina-rag kao A2A server, datoteku po datoteku, reuse postojeće MCP infre. | Kad implementiraš |
| [`comparison-and-vision.md`](comparison-and-vision.md) | **Strategija** — usporedba našeg MCP-a vs Magisterium, što je A2A vs MCP, i vizija multi-agent sustava (Faza B). | Za kontekst / odluke |

Sirovi scrape-ani izvori: `.firecrawl/` (`a2a-specification.md`, `magisterium-a2a.md`,
`a2a-key-concepts.md`, `a2a-agent-discovery.md`, `a2a-life-of-a-task.md`, `a2a-protocol-home.md`).

## 60-sekundni sažetak

- **MCP** = agent → alati. **A2A** = agent ↔ agent (peer). Nadopunjuju se. Već imamo MCP
  (`services/mcp/`); A2A je tanki JSON-RPC sloj **povrh iste retrieval logike i istog OAuth-a**.
- **A2A wire shape koji gradimo:** JSON-RPC 2.0, `method: "message/send"`, skill biran preko
  `message.metadata.skillId`, odgovor = `completed` Task s artifacts (`text` + `data` part).
  Vidi [`protocol-reference.md`](protocol-reference.md) §0 o verzijama (0.2.x vs 0.3.x).
- **Discovery:** Agent Card JSON na `/.well-known/agent-card.json` (+ `/.well-known/agent.json`).
- **Za MVP trebaju samo 2 metode:** `message/send` + `tasks/get`. Bez streaminga/push (kao Magisterium).
- **3 starter skilla** mapiraju postojeće tool-ove: `podcast_search` → `searchPodcasts()`,
  `mention_analytics` → `countMentions()`, `episode_lookup` → `getEpisode()`.

## Status

- [x] Istraživanje + SSOT dokumentacija (ovaj folder)
- [ ] Implementacija Faze 1 (vidi [`build-guide.md`](build-guide.md) §10 checklist) — **TODO**
- [ ] Faza B: multi-agent orkestracija — **kasnije** (ovisi o Fazi 1 + entity resolution §15)

## Ključne odluke (za ADR kad se krene graditi)

1. **Wire-shape:** 0.2.x JSON-RPC (Claude.ai konektor + SDK-ovi to govore), Agent Card na oba well-known puta.
2. **Auth:** reuse `auth.ts` OAuth 2.1 + DCR; static API key dijeli verifier (svjesna odluka treba li ga dopustiti za A2A).
3. **Task persistencija:** in-memory TTL za MVP; PG `a2a_tasks` ako zatreba persist/audit.
4. **Bez streaminga** dok neki skill ne postane spor.
5. **Protocol version pin** — A2A je 0.x, pratiti breaking changes kao i MCP spec.
