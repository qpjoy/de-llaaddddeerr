FROM pytorch/pytorch:2.7.1-cuda12.8-cudnn9-runtime
WORKDIR /app
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1 HF_HOME=/models TOKENIZERS_PARALLELISM=false
ARG PIP_INDEX_URL=https://pypi.org/simple
COPY requirements.txt .
RUN python -m pip install --no-cache-dir --index-url "$PIP_INDEX_URL" -r requirements.txt
COPY app/ /app/
EXPOSE 8000
HEALTHCHECK --interval=15s --timeout=5s --start-period=30m --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=3)"
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--limit-concurrency", "8", "--timeout-keep-alive", "5"]
