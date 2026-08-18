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
ARG PYTORCH_CPU_WHEEL_LINKS=https://download.pytorch.org/whl/cpu/torch/
ARG PIP_DEFAULT_TIMEOUT=300
ARG PIP_RETRIES=10
ARG PREFETCH_MODEL=0
ARG HANLP_MODEL=COARSE_ELECTRA_SMALL_ZH
ARG HANLP_VERSION=2.1.3
ARG TORCH_VERSION=2.13.0
ARG TRANSFORMERS_VERSION=4.54.1
ENV HANLP_HOME=/models \
    HANLP_MODEL=${HANLP_MODEL} \
    PIP_DEFAULT_TIMEOUT=${PIP_DEFAULT_TIMEOUT} \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_RETRIES=${PIP_RETRIES} \
    PYTHONUNBUFFERED=1 \
    PORT=8000

WORKDIR /app

# CPU-only torch: the GPU wheels are several gigabytes and this workload is
# tokenization on short social-post text, which is not GPU-bound. PyTorch's CPU
# wheel page supplies only torch itself; the sole package index remains the
# configured PyPI mirror. Pinning the +cpu local version prevents pip from
# choosing the ordinary PyPI wheel. Keep pip's cache outside the image layer so
# a failed dependency download does not force the ~200MB wheel to be downloaded
# again.
RUN --mount=type=cache,target=/root/.cache/pip,sharing=locked \
    python -m pip install \
      --timeout "$PIP_DEFAULT_TIMEOUT" \
      --retries "$PIP_RETRIES" \
      --index-url "$PIP_INDEX_URL" \
      --find-links "$PYTORCH_CPU_WHEEL_LINKS" \
      "torch==${TORCH_VERSION}+cpu" \
      "hanlp==${HANLP_VERSION}" \
      "transformers==${TRANSFORMERS_VERSION}" \
 && python -m pip check \
 && python -c \
      "import torch; assert '+cpu' in torch.__version__, torch.__version__; assert torch.version.cuda is None, torch.version.cuda"

# The model prefetch comes before any application source is copied.
#
# Layer order is load-bearing here, not cosmetic. This step downloads ~2GB and
# is the expensive half of the build; putting a `COPY server.py` above it means
# every edit to the server invalidates it. That is not merely slow -- if the
# rebuild then runs without PREFETCH_MODEL=1, or without the network the
# download needs, the `if` is simply skipped and the image is produced
# *successfully* with no model seed at all. The failure then surfaces minutes
# later and one layer away, as an initContainer exiting 1 because
# /opt/hanlp-model-seed/.mx-common-manifest.sha256 does not exist.
# Copied above the prefetch and nowhere near the server: this file changes about
# once a year, so it can sit on top of the expensive layer without invalidating it.
COPY prefetch-models.py ./

RUN if [ "$PREFETCH_MODEL" = "1" ]; then \
      HANLP_SEED_DIR=/opt/hanlp-model-seed \
      HANLP_HOME=/opt/hanlp-model-seed python prefetch-models.py; \
      cd /opt/hanlp-model-seed; \
      find . -type f ! -name .mx-common-manifest.sha256 -print0 \
        | sort -z | xargs -0 -r sha256sum > .mx-common-manifest.sha256; \
      [ -s .mx-common-manifest.sha256 ] \
        || { echo 'model prefetch produced no manifest' >&2; exit 1; }; \
    fi

# Below the prefetch: editing these rebuilds seconds of layers, not gigabytes.
COPY server.py seed-models.sh ./

RUN chmod +x /app/seed-models.sh \
 && useradd --uid 1000 --create-home hanlp \
 && mkdir -p /models /opt/hanlp-model-seed \
 && chown -R 1000:1000 /app /models /opt/hanlp-model-seed
USER 1000:1000

EXPOSE 8000
CMD ["python", "server.py"]
