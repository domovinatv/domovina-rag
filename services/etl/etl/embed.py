"""HTTP klijent za embedder service (services/embedder)."""

from __future__ import annotations

import httpx


class EmbedderClient:
    def __init__(self, base_url: str, timeout: float = 120.0) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)

    def health(self) -> dict:
        r = self._client.get("/health")
        r.raise_for_status()
        return r.json()

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        r = self._client.post("/embed", json={"texts": texts})
        r.raise_for_status()
        data = r.json()
        return data["vectors"]

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EmbedderClient":
        return self

    def __exit__(self, *args) -> None:
        self.close()
