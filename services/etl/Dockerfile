FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY requirements.txt .
RUN pip install -r requirements.txt

COPY etl ./etl

# ETL je one-shot job — `docker compose run --rm etl ingest --input /data`.
# Default command samo prikazuje help.
ENTRYPOINT ["python", "-m", "etl"]
CMD ["--help"]
