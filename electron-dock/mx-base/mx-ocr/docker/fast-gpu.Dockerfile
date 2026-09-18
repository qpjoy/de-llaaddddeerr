# 快速版 GPU 镜像：RapidOCR + PP-OCRv6(ONNX)，走 onnxruntime 的 CUDA EP。
#
# 和 fast.Dockerfile 是同一套代码、同一批模型，只换推理运行时。代价是镜像
# 从 <1GB 涨到 4GB 左右（CUDA + cuDNN 运行时），换来实测 2.82× 的单图提速：
#   同容器 / 同 32 核配额 / 同 intra_op=4，单图 680ms(CPU) -> 241ms(CUDA)
#
# 这里不碰 PaddlePaddle，所以没有 sm_120 的坑 —— 那是 paddle 独有的问题。
# onnxruntime-gpu 官方 wheel 在 RTX 5090(compute_cap 12.0) 上已实测能真正执行，
# det/rec/cls 三个 session 都留在 CUDAExecutionProvider 上，没有静默回落。
FROM nvidia/cuda:12.8.0-cudnn-runtime-ubuntu22.04

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    DEBIAN_FRONTEND=noninteractive

# opencv 需要 libgl/libglib；字体包让自检样张能画中文。
# 这个基础镜像没有 python，要自己装；install_fast_engine.sh 调的是 `python`，
# 而 ubuntu 只提供 python3，所以补一个软链。
RUN apt-get update && apt-get install -y --no-install-recommends \
        python3 python3-pip libgl1 libglib2.0-0 fonts-wqy-zenhei \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf /usr/bin/python3 /usr/local/bin/python

RUN python -m pip install --no-cache-dir -i "$PIP_INDEX_URL" \
        "fastapi>=0.110" "uvicorn[standard]>=0.29" "pillow>=10.0"

COPY docker/install_fast_engine.sh /tmp/install_fast_engine.sh
RUN sh /tmp/install_fast_engine.sh "$PIP_INDEX_URL" gpu \
 && (rm -f /tmp/install_fast_engine.sh 2>/dev/null || true)

WORKDIR /app
COPY app/ /app/

# 镜像自带默认值：即使直接 docker run 这个镜像、不传任何环境变量，也走 CUDA。
ENV OCR_TIER=fast-gpu \
    OCR_FAST_CUDA=1
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s --retries=30 \
    CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).status==200 else 1)"

# 推理搬到 GPU 后 CPU 侧只剩预处理和后处理，但 uvicorn 进程数仍按 CPU 配额给，
# 这样前后处理不会成为新瓶颈。真正的并发上限由显卡决定，要压测才知道。
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-1}"]
