# Reranker Service

**Status:** ⏳ Faza 2 — implementacija nakon što retrieval baseline funkcionira.

FastAPI servis koji wrapa `BAAI/bge-reranker-v2-m3` (Apache 2.0) za re-ranking top-N kandidata
nakon vektorske pretrage.

## Planirani API

```
POST /rerank
Body: {"query": "...", "passages": ["chunk1", "chunk2", ...]}
Response: {"scores": [0.92, 0.45, ...]}
```

## Kad uvesti

Vidi plan §11 Faza 2 — tek nakon što imamo baseline ClickHouse retrieval kvalitetu izmjerenu na
golden setu (eval rig). Reranker dodaje 100-300ms latency per upit, ali tipično podiže
precision@5 za 5-15%.
