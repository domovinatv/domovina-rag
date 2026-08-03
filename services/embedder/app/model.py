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
# 4,5 GB nije procjena nego JEDINA dokazano sigurna točka: batch od 4 teksta po
# ~2100 tokena (stara postavka `MAX_TEXT_LEN=8192`) košta 4,30 GB i vrti se u
# produkciji tjednima bez pada. Jedina druga izmjerena točka je 15,13 GB, koja je
# zamrznula stroj. Između njih nema mjerenja, pa default ostaje na donjoj —
# podigni `EMBEDDER_MEM_BUDGET_GB` tek kad se potvrdi da je stabilno.
_DEFAULT_BUDGET_GB = 4.5

# Koliko memorije košta jedan forward, izmjereno na M4 Pro (26 GB unified, od
# čega 14,6 GB drži Docker → embedderu ostaje ~11 GB).
#
# bge-m3 je XLM-RoBERTa-large: 16 glava, 24 sloja, float32. Attention drži tenzor
# (batch, glave, n, n) → 16 × n² × 4 B po kopiji, a unutar jednog koraka ih živi
# ~3,8 odjednom (scores + softmax + mask). Mjerenje: jedan tekst od 7877 tokena
# digao je MPS driver peak na 15,13 GB, pa je
#     15,13e9 / (16 × 7877² × 4) = 3,81
# odakle:  peak_bytes ≈ 244 × batch × n²
#
# Trošak je kvadratan po DULJINI, a linearan po batchu — zato limit ne može biti
# broj znakova po tekstu (stara postavka `EMBEDDER_MAX_TEXT_LEN=8192`) nego mora
# biti budžet nad `batch × n²`. Vidi docs/mps-embedder-memory.md §6.
_ATTN_BYTES_PER_BATCH_TOKEN2 = 16 * 4 * 3.81  # ≈ 244


class Embedder:
    def __init__(
        self,
        model_name: str = _DEFAULT_MODEL,
        device: str = _DEFAULT_DEVICE,
        batch_size: int = _DEFAULT_BATCH,
        budget_gb: float = _DEFAULT_BUDGET_GB,
    ) -> None:
        self.model_name = model_name
        self.device = device
        self.batch_size = batch_size
        self.budget_bytes = budget_gb * 1e9
        self._model: Optional[SentenceTransformer] = None
        self._lock = threading.Lock()

    @property
    def max_tokens(self) -> int:
        """Najdulji tekst koji stane u budžet SAM (batch=1).

        Iz `peak ≈ 244 × batch × n²` uz batch=1 → `n = √(budžet / 244)`.
        Pri 6 GB to je ~4960 tokena. Tekst iznad toga ne može se embeddati ni
        sam, pa `/embed` na njemu vraća 413 — to je jedini preostali tvrdi limit.
        """
        n = int((self.budget_bytes / _ATTN_BYTES_PER_BATCH_TOKEN2) ** 0.5)
        return min(n, self.max_seq_length)

    @property
    def max_seq_length(self) -> int:
        if self._model is None:
            self.load()
        assert self._model is not None
        return int(self._model.max_seq_length)

    def token_lengths(self, texts: List[str]) -> List[int]:
        """Broj tokena po tekstu, odrezan na model max_seq_length.

        Rezanje je namjerno: SentenceTransformer ionako trunca na
        `max_seq_length`, pa je za procjenu memorije mjerodavna odrezana duljina,
        ne sirova.
        """
        if self._model is None:
            self.load()
        assert self._model is not None
        enc = self._model.tokenizer(
            texts,
            add_special_tokens=True,
            truncation=False,
            return_attention_mask=False,
            return_token_type_ids=False,
        )
        cap = self.max_seq_length
        return [min(len(ids), cap) for ids in enc["input_ids"]]

    def _plan_batches(self, lengths: List[int]) -> List[List[int]]:
        """Indeksi grupirani tako da `244 × batch × maxn²` ostane ispod budžeta.

        Sortira SILAZNO po duljini prije grupiranja jer transformer padira cijeli
        batch na najdulji član — pomiješaš li 7877-tokenski tekst s tri kratka,
        platit ćeš kao za četiri duga. To je točno ono što je srušilo stroj pri
        mjerenju. Silaznim sortom slični završe zajedno i padding se ne plaća.
        """
        order = sorted(range(len(lengths)), key=lambda i: -lengths[i])
        batches: List[List[int]] = []
        cur: List[int] = []
        cur_max = 0
        for i in order:
            n = max(lengths[i], 1)
            m = max(cur_max, n)
            cost = _ATTN_BYTES_PER_BATCH_TOKEN2 * (len(cur) + 1) * m * m
            if cur and (cost > self.budget_bytes or len(cur) >= self.batch_size):
                batches.append(cur)
                cur, cur_max, m = [], 0, n
            cur.append(i)
            cur_max = m
        if cur:
            batches.append(cur)
        return batches

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
        if not texts:
            return []
        if self._model is None:
            self.load()
        assert self._model is not None

        # Ne prosljeđuj cijeli `texts` SentenceTransformeru s `batch_size` —
        # on bi sam grupirao po BROJU tekstova, ne po duljini, pa bi jedan dugi
        # chunk odredio padding za cijeli batch. Grupiraj sam, po memoriji.
        lengths = self.token_lengths(texts)

        # Obrana u dubinu: /embed ovo odbija s 413 prije nego dođe dovamo, ali
        # `encode()` je javni API i ne smije pokušati alokaciju koja ruši stroj.
        limit = self.max_tokens
        over = [(i, n) for i, n in enumerate(lengths) if n > limit]
        if over:
            raise ValueError(
                f"tekst[{over[0][0]}] ima {over[0][1]} tokena > max {limit} "
                f"(budžet {self.budget_bytes / 1e9:.1f} GB) — ne stane ni sam"
            )

        out: List[Optional[List[float]]] = [None] * len(texts)
        for idx in self._plan_batches(lengths):
            sub = [texts[i] for i in idx]
            vectors = self._model.encode(
                sub,
                batch_size=len(sub),  # plan je već odlučio veličinu
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            )
            for i, vec in zip(idx, vectors.tolist()):
                out[i] = vec
            self._release()

        missing = [i for i, v in enumerate(out) if v is None]
        if missing:
            raise RuntimeError(f"encode nije vratio vektore za indekse {missing}")
        return [v for v in out if v is not None]

    def _release(self) -> None:
        # MPS: PyTorch cache-a GPU buffere neograničeno → footprint naraste na
        # ~20 GB (od 24 unified) i sruši allocator (SIGSEGV). Otpusti cache nakon
        # svakog batcha da footprint ostane nizak. Vidi lessons-mps-embedder-segfault.
        if self.device == "mps":
            try:
                import torch

                torch.mps.empty_cache()
            except Exception:  # torch bez mps builda — no-op
                pass


def embedder_from_env() -> Embedder:
    return Embedder(
        model_name=os.environ.get("EMBEDDER_MODEL", _DEFAULT_MODEL),
        device=os.environ.get("EMBEDDER_DEVICE", _DEFAULT_DEVICE),
        batch_size=int(os.environ.get("EMBEDDER_BATCH_SIZE", _DEFAULT_BATCH)),
        budget_gb=float(os.environ.get("EMBEDDER_MEM_BUDGET_GB", _DEFAULT_BUDGET_GB)),
    )
