# syntax=docker/dockerfile:1.7
#
# HanLP tokenization service. Opt-in: the Hub runs with mx-common's fallback
# segmenter until MX_COMMON_HANLP_URL is set, because this image is ~2GB with
# weights and pulling PyTorch is a poor default for every environment.
#
# Managed build/import/deploy (always preloads the model):
#   bash scripts/manage.sh deploy hanlp
FROM python:3.11-slim-bookworm

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG PREFETCH_MODEL=0
ARG HANLP_MODEL=COARSE_ELECTRA_SMALL_ZH
ARG HANLP_VERSION=2.1.3
ARG TORCH_VERSION=2.13.0
ENV HANLP_HOME=/models \
    HANLP_MODEL=${HANLP_MODEL} \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# CPU-only torch: the GPU wheels are several gigabytes and this workload is
# tokenization on short social-post text, which is not GPU-bound.
RUN pip install --no-cache-dir --index-url "$PIP_INDEX_URL" \
      --extra-index-url https://pypi.org/simple \
      "torch==${TORCH_VERSION}" --index-url https://download.pytorch.org/whl/cpu \
 && pip install --no-cache-dir --index-url "$PIP_INDEX_URL" "hanlp==${HANLP_VERSION}"

COPY server.py seed-models.sh ./

RUN if [ "$PREFETCH_MODEL" = "1" ]; then \
      mkdir -p /opt/hanlp-model-seed; \
      HANLP_HOME=/opt/hanlp-model-seed python -c \
        "import hanlp, os; hanlp.load(getattr(hanlp.pretrained.tok, os.environ['HANLP_MODEL']))"; \
      cd /opt/hanlp-model-seed; \
      find . -type f ! -name .mx-common-manifest.sha256 -print0 \
        | sort -z | xargs -0 -r sha256sum > .mx-common-manifest.sha256; \
    fi

RUN chmod +x /app/seed-models.sh \
 && useradd --uid 1000 --create-home hanlp \
 && mkdir -p /models /opt/hanlp-model-seed \
 && chown -R 1000:1000 /app /models /opt/hanlp-model-seed
USER 1000:1000

EXPOSE 8000
CMD ["python", "server.py"]
