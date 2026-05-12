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
_MAX_TEXT_LEN = int(os.environ.get("EMBEDDER_MAX_TEXT_LEN", "8192"))


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
        if len(t) > _MAX_TEXT_LEN:
            raise HTTPException(
                status_code=413,
                detail=f"texts[{i}] length {len(t)} > max {_MAX_TEXT_LEN}",
            )

    e: Embedder = app.state.embedder
    vectors = e.encode(req.texts)
    return EmbedResponse(vectors=vectors, model=e.model_name, dim=len(vectors[0]))
