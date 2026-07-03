"""bge-m3 dense embedding wrapper.

Lazy loader: model se učita pri prvom pozivu (ili eksplicitno kroz `warmup`),
ne pri importu modula. To omogućava brži container startup i da `/health`
može razlikovati "model nije učitan" od "model spreman".
"""

from __future__ import annotations

import os
import threading
from typing import List, Optional

from sentence_transformers import SentenceTransformer


_DEFAULT_MODEL = "BAAI/bge-m3"
_DEFAULT_DEVICE = "cpu"
_DEFAULT_BATCH = 32


class Embedder:
    def __init__(
        self,
        model_name: str = _DEFAULT_MODEL,
        device: str = _DEFAULT_DEVICE,
        batch_size: int = _DEFAULT_BATCH,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.batch_size = batch_size
        self._model: Optional[SentenceTransformer] = None
        self._lock = threading.Lock()

    @property
    def is_loaded(self) -> bool:
        return self._model is not None

    def load(self) -> None:
        # Double-checked locking — sentence-transformers nije thread-safe pri init-u.
        if self._model is not None:
            return
        with self._lock:
            if self._model is not None:
                return
            self._model = SentenceTransformer(self.model_name, device=self.device)

    def encode(self, texts: List[str]) -> List[List[float]]:
        if self._model is None:
            self.load()
        assert self._model is not None
        vectors = self._model.encode(
            texts,
            batch_size=self.batch_size,
            normalize_embeddings=True,
            convert_to_numpy=True,
            show_progress_bar=False,
        )
        # MPS: PyTorch cache-a GPU buffere neograničeno → footprint naraste na
        # ~20 GB (od 24 unified) i sruši allocator (SIGSEGV). Otpusti cache nakon
        # svakog batcha da footprint ostane nizak. Vidi lessons-mps-embedder-segfault.
        if self.device == "mps":
            try:
                import torch

                torch.mps.empty_cache()
            except Exception:  # torch bez mps builda — no-op
                pass
        return vectors.tolist()


def embedder_from_env() -> Embedder:
    return Embedder(
        model_name=os.environ.get("EMBEDDER_MODEL", _DEFAULT_MODEL),
        device=os.environ.get("EMBEDDER_DEVICE", _DEFAULT_DEVICE),
        batch_size=int(os.environ.get("EMBEDDER_BATCH_SIZE", _DEFAULT_BATCH)),
    )
