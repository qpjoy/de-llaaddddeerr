ARG BASE_IMAGE=ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle/paddleocr-vl:latest-nvidia-gpu
FROM ${BASE_IMAGE}

ARG PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
ARG WITH_FAST=1
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

# 官方镜像里 fastapi / uvicorn / starlette 都已具备，服务端代码也刻意不用
# python-multipart（自己用标准库解析上传），所以 Web 层不需要联网。
RUN python -c "import fastapi, uvicorn, starlette; print('fastapi', fastapi.__version__, '| uvicorn', uvicorn.__version__)"

# 文档解析流水线（PaddleOCR-VL）需要 paddlex 的 ocr 附加依赖。
# 镜像里已经有就跳过，完全不联网；缺了才装，并且钉死当前 paddlex 版本，
# 避免顺带把 paddlex 升级掉。装不上会直接失败，不静默放过。
RUN set -e; \
    if python -c "from paddlex.utils.deps import require_extra; require_extra('ocr')" 2>/dev/null; then \
        echo "paddlex[ocr] 依赖已具备，跳过安装"; \
    else \
        PDX="$(python -c 'import paddlex; print(paddlex.__version__)')"; \
        echo "缺少 paddlex[ocr]，安装 paddlex[ocr]==$PDX"; \
        python -m pip install --no-cache-dir -i "$PIP_INDEX_URL" "paddlex[ocr]==$PDX"; \
        python -c "from paddlex.utils.deps import require_extra; require_extra('ocr'); print('paddlex[ocr] 安装完成')"; \
    fi

# TIER=full 时同一容器里也要有 fast 引擎。rapidocr 是纯 ONNX，几百 MB，
# 相对这个镜像可以忽略。装不上不致命：fast 引擎届时不可用，quality 照常。
COPY docker/install_fast_engine.sh /tmp/install_fast_engine.sh
RUN if [ "$WITH_FAST" = "1" ]; then \
        sh /tmp/install_fast_engine.sh "$PIP_INDEX_URL" || \
        echo "[warn] rapidocr 安装失败，本镜像只提供 quality 引擎"; \
    else \
        echo "WITH_FAST=0，跳过 fast 引擎"; \
    fi; \
    rm -f /tmp/install_fast_engine.sh 2>/dev/null || true

WORKDIR /app
COPY app/ /app/

ENV OCR_TIER=full
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=5s --start-period=30s --retries=60 \
    CMD python -c "import urllib.request,sys;sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz',timeout=3).status==200 else 1)"

# uvicorn 进程数可配。ONNX/Paddle 单次推理会吃满 CPU，靠并发请求提不了吞吐，
# 必须「限制单次推理线程数 + 多进程」才能把多核用满。
CMD ["sh", "-c", "exec uvicorn server:app --host 0.0.0.0 --port 8000 --workers ${UVICORN_WORKERS:-1}"]
