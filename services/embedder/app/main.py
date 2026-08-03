"""FastAPI app: POST /embed → L2-normalized bge-m3 dense vektori (1024-d).

Tools u repo-u (MCP server, ETL) komuniciraju s ovim service-om HTTP-om
preko interne `internal` docker network-e.
"""

from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from typing import List

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .model import Embedder, embedder_from_env


log = logging.getLogger("embedder")
logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"))


_MAX_BATCH = int(os.environ.get("EMBEDDER_MAX_BATCH", "256"))

# Gruba brana prije tokenizacije — samo da se ne tokenizira patološki input
# (npr. slučajno poslan cijeli fajl). Pravi limit je u tokenima, vidi /embed.
_MAX_TEXT_CHARS = int(os.environ.get("EMBEDDER_MAX_TEXT_CHARS", "500000"))

# `EMBEDDER_MAX_TEXT_LEN` je UKINUT: rezao je po znakovima, a trošak je po
# tokenima. Za hrvatski je ~3,9 znaka/token, pa je limit od 8192 znaka propuštao
# tek ~2100 tokena — četvrtinu onoga što model podnosi — i odbijao 136 legitimnih
# chunkova. Ako je varijabla ostala u nečijem env-u, reci to naglas umjesto da
# tiho ne radi ništa.
if os.environ.get("EMBEDDER_MAX_TEXT_LEN"):
    log.warning(
        "EMBEDDER_MAX_TEXT_LEN=%s se IGNORIRA — limit je sada memorijski budžet "
        "(EMBEDDER_MEM_BUDGET_GB). Makni ju iz env-a.",
        os.environ["EMBEDDER_MAX_TEXT_LEN"],
    )


class EmbedRequest(BaseModel):
    texts: List[str] = Field(..., min_length=1)


class EmbedResponse(BaseModel):
    vectors: List[List[float]]
    model: str
    dim: int


class HealthResponse(BaseModel):
    status: str
    model: str
    loaded: bool


@asynccontextmanager
async def lifespan(app: FastAPI):
    embedder: Embedder = embedder_from_env()
    app.state.embedder = embedder
    if os.environ.get("EMBEDDER_WARMUP", "1") == "1":
        log.info("Loading model %s on %s", embedder.model_name, embedder.device)
        embedder.load()
        log.info("Model loaded")
    yield


app = FastAPI(title="domovina-rag embedder", version="0.1.0", lifespan=lifespan)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    e: Embedder = app.state.embedder
    return HealthResponse(
        status="ok" if e.is_loaded else "loading",
        model=e.model_name,
        loaded=e.is_loaded,
    )


@app.post("/embed", response_model=EmbedResponse)
def embed(req: EmbedRequest) -> EmbedResponse:
    if len(req.texts) > _MAX_BATCH:
        raise HTTPException(
            status_code=413,
            detail=f"batch_size {len(req.texts)} > max {_MAX_BATCH}",
        )
    for i, t in enumerate(req.texts):
        if len(t) > _MAX_TEXT_CHARS:
            raise HTTPException(
                status_code=413,
                detail=f"texts[{i}] chars {len(t)} > max {_MAX_TEXT_CHARS}",
            )

    e: Embedder = app.state.embedder

    # Tekst koji ne stane u budžet ni sam (batch=1) je jedini tvrdi 413. Ostalo
    # embedder posloži u više prolaza — dugi chunk usporava, ali ne odbija.
    lengths = e.token_lengths(req.texts)
    limit = e.max_tokens
    too_long = [(i, n) for i, n in enumerate(lengths) if n > limit]
    if too_long:
        i, n = too_long[0]
        raise HTTPException(
            status_code=413,
            detail=(
                f"texts[{i}] tokens {n} > max {limit} "
                f"(memorijski budžet {e.budget_bytes / 1e9:.1f} GB; "
                f"ukupno predugih: {len(too_long)})"
            ),
        )

    vectors = e.encode(req.texts)
    return EmbedResponse(vectors=vectors, model=e.model_name, dim=len(vectors[0]))
