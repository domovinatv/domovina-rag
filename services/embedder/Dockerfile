# CPU-only build. Za CUDA: override FROM na nvidia/cuda base i prilagodi torch wheels.
FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/root/.cache/huggingface \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1

WORKDIR /app

# System deps: git ponekad treba sentence-transformers za HF download.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    && rm -rf /var/lib/apt/lists/*

# CPU-only PyTorch wheels: spasi ~5GB CUDA bloat-a u defaultnom slučaju.
COPY requirements.txt .
RUN pip install --index-url https://download.pytorch.org/whl/cpu torch==2.5.1 \
    && pip install -r requirements.txt

COPY app ./app

EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
    CMD python -c "import urllib.request,sys; \
        r=urllib.request.urlopen('http://localhost:8000/health', timeout=5); \
        sys.exit(0 if r.status==200 else 1)"

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
