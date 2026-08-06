# syntax=docker/dockerfile:1.7
#
# HanLP tokenization service. Opt-in: the Hub runs with mx-common's fallback
# segmenter until MX_COMMON_HANLP_URL is set, because this image is ~2GB with
# weights and pulling PyTorch is a poor default for every environment.
#
# Build:
#   docker build -t mx-common-hanlp:local deploy/hanlp
# Warm the model into the image (recommended for internal deploys, so a pod
# restart does not re-download):
#   docker build --build-arg PREFETCH_MODEL=1 -t mx-common-hanlp:local deploy/hanlp
FROM python:3.11-slim-bookworm

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PREFETCH_MODEL=0
ENV HANLP_HOME=/models \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# CPU-only torch: the GPU wheels are several gigabytes and this workload is
# tokenization on short social-post text, which is not GPU-bound.
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" \
      --extra-index-url https://pypi.org/simple \
      torch --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir --index-url "$PIP_INDEX_URL" hanlp

COPY server.py ./server.py

RUN if [ "$PREFETCH_MODEL" = "1" ]; then \
      python -c "import hanlp; hanlp.load(hanlp.pretrained.tok.COARSE_ELECTRA_SMALL_ZH)"; \
    fi

RUN useradd --uid 1000 --create-home hanlp && chown -R 1000:1000 /app /models 2>/dev/null || true
USER 1000:1000

EXPOSE 8000
CMD ["python", "server.py"]
