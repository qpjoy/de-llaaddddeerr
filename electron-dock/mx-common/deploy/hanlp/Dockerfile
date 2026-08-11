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

COPY server.py seed-models.sh ./

RUN if [ "$PREFETCH_MODEL" = "1" ]; then \
      mkdir -p /opt/hanlp-model-seed; \
      HANLP_HOME=/opt/hanlp-model-seed python -c \
        "import hanlp, os; tokenizer = hanlp.load(getattr(hanlp.pretrained.tok, os.environ['HANLP_MODEL'])); tokens = tokenizer(['吴恩达与人工智能']); assert isinstance(tokens, list) and any(isinstance(sentence, list) and any(isinstance(token, str) and token.strip() for token in sentence) for sentence in tokens), 'HanLP tokenizer inference returned no tokens'"; \
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
