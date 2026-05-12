# Documentation

Arhitekturni dokumenti i data contract žive u **sibling repu** `fetch.domovina.tv` jer:

1. Su nastali iz produbljene diskusije o podacima koje taj repo proizvodi
2. Sav povijesni kontekst (Gemini guess slabosti, pyannote failure modes, voice aging matrica)
   je tamo i vrijedi ga zadržati u izvornom kontekstu
3. `data_contract.md` formalno definira API između repova — promjene tamo, ne ovdje

## Glavne reference

- **Arhitekturni plan** (ClickHouse + PostgreSQL + MCP + Eval rig + Speaker entity resolution):
  [`fetch.domovina.tv/docs/rag_clickhouse_postgres_plan.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/rag_clickhouse_postgres_plan.md)

- **Data contract** (shape inputa: JSONL, JSON, SRT, embeddings):
  [`fetch.domovina.tv/docs/data_contract.md`](https://github.com/domovinatv/fetch.domovina.tv/blob/main/docs/data_contract.md)

## Lokalni dokumenti (ovaj repo)

Sad: ništa.

Buduće (kad/ako bude trebalo):
- `docs/adr/` — Architecture Decision Records za odluke specifične za ovaj repo
  (npr. konkretan choice TypeScript runtime, Drizzle vs raw SQL, itd.)
- `docs/operations.md` — runbookovi za production incident response
- `docs/mcp-tools.md` — referenca svih MCP tool-ova s primjerima upita

Za sve što se tiče **data shape-a, pipeline-a, transkripcije, dijarizacije, speaker embedding-a** —
**uvijek** referenciraj fetch.domovina.tv repo. Tamo je istina o producer side-u.
