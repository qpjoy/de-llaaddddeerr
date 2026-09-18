# 快速版镜像：RapidOCR + PP-OCRv6(ONNX)，纯 CPU，不到 1GB。
# 不含 PaddlePaddle，因此没有 sm_120 问题；也不需要拉 20~30GB 官方镜像。
# 爬虫级批量入口用这个档（TIER=fast）。
FROM python:3.11-slim

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1

# opencv 需要这两个系统库；字体包让自检样张能画中文
RUN apt-get update && apt-get install -y --no-install-recommends \
        libgl1 libglib2.0-0 fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/*

RUN python -m pip install --no-cache-dir -i "$PIP_INDEX_URL" \
        "fastapi>=0.110" "uvicorn[standard]>=0.29" "pillow>=10.0"

COPY docker/install_fast_engine.sh /tmp/install_fast_engine.sh
RUN sh /tmp/install_fast_engine.sh "$PIP_INDEX_URL" cpu \
 && (rm -f /tmp/install_fast_engine.sh 2>/dev/null || true)

WORKDIR /app
COPY app/ /app/

ENV OCR_TIER=fast
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=30 \
    CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).status==200 else 1)"

# uvicorn 进程数可配。ONNX/Paddle 单次推理会吃满 CPU，靠并发请求提不了吞吐，
# 必须「限制单次推理线程数 + 多进程」才能把多核用满。
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-1}"]
