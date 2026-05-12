"""HTTP klijent za embedder service (services/embedder).

Retry-on-timeout: Apple Silicon MPS embedder može sustained-load-no zaglaviti se
na pojedinim request-ovima (vidi memory: project-mps-embedder-host). Umjesto da
ETL puca na prvi httpx.ReadTimeout, retry 3x s exponential backoff (5s, 15s, 45s)
prije nego što baci. Zbroj max čekanja ~65s + 3× timeout. Ako i dalje fail —
ETL caller-a uhvati exception i preskoči epizodu, koja se može retry-ati
naknadno preko `etl retry-missing`.
"""

from __future__ import annotations

import logging
import time

import httpx


log = logging.getLogger("etl.embed")


class EmbedderClient:
    def __init__(
        self,
        base_url: str,
        timeout: float = 300.0,
        max_retries: int = 3,
        retry_backoff: tuple[float, ...] = (5.0, 15.0, 45.0),
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self._client = httpx.Client(base_url=self.base_url, timeout=timeout)
        self._max_retries = max_retries
        self._retry_backoff = retry_backoff

    def health(self) -> dict:
        r = self._client.get("/health")
        r.raise_for_status()
        return r.json()

    def embed(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []
        last_exc: Exception | None = None
        for attempt in range(self._max_retries + 1):
            try:
                r = self._client.post("/embed", json={"texts": texts})
                r.raise_for_status()
                return r.json()["vectors"]
            except (httpx.ReadTimeout, httpx.ConnectError, httpx.RemoteProtocolError) as e:
                last_exc = e
                if attempt < self._max_retries:
                    wait = self._retry_backoff[min(attempt, len(self._retry_backoff) - 1)]
                    log.warning(
                        "embed timeout/conn error (attempt %d/%d, batch=%d): %s — retry za %.0fs",
                        attempt + 1,
                        self._max_retries + 1,
                        len(texts),
                        type(e).__name__,
                        wait,
                    )
                    time.sleep(wait)
                    continue
                break
        raise last_exc if last_exc else RuntimeError("embed failed without exception")

    def close(self) -> None:
        self._client.close()

    def __enter__(self) -> "EmbedderClient":
        return self

    def __exit__(self, *args) -> None:
        self.close()
