#!/bin/sh
# 装 fast 引擎（RapidOCR + PP-OCRv6 ONNX），并做一次真实构造验证。
# 单独成脚本而不是塞进 Dockerfile 的 RUN —— 多行 python 内联在 RUN 里
# 极易被各层转义吃坏，独立文件最稳。
#
#   用法: install_fast_engine.sh [PIP_INDEX_URL] [cpu|gpu]
#
# 第二个参数决定装哪个推理运行时。两者提供同一个 `onnxruntime` 模块，
# 装错或同时装会互相覆盖，所以必须二选一。
set -e
INDEX="${1:-https://pypi.tuna.tsinghua.edu.cn/simple}"
RUNTIME="${2:-cpu}"
PIP="python -m pip install --no-cache-dir -i $INDEX"

case "$RUNTIME" in
    gpu) ORT_PKG="onnxruntime-gpu" ;;
    cpu) ORT_PKG="onnxruntime" ;;
    *)   echo "第二个参数只能是 cpu 或 gpu，收到 $RUNTIME" >&2; exit 1 ;;
esac
echo "推理运行时：$ORT_PKG"

# rapidocr 3.x 把推理运行时拆成了可选依赖，必须单独装 onnxruntime，
# 否则构造时报 "onnxruntime is not installed."。
# 新版默认模型就是 PP-OCRv6 的 det/rec small。
if $PIP "rapidocr>=3.0" "$ORT_PKG"; then
    echo "已安装 rapidocr 3.x + $ORT_PKG"
elif [ "$RUNTIME" = "cpu" ]; then
    echo "rapidocr 3.x 安装失败，退回经典包（模型为 v4/v5 系列，精度低一档）"
    $PIP "rapidocr-onnxruntime>=1.4"
else
    # GPU 档没有等价的经典包退路，宁可让构建失败也不要静默变成 CPU 版
    echo "rapidocr 3.x + $ORT_PKG 安装失败" >&2
    exit 1
fi

RUNTIME="$RUNTIME" python - <<'PY'
import importlib.util as u
import os
import sys

mod = "rapidocr" if u.find_spec("rapidocr") else "rapidocr_onnxruntime"
RapidOCR = __import__(mod, fromlist=["RapidOCR"]).RapidOCR
RapidOCR()          # 真的构造一次，确认模型随包分发、运行时不用联网
print("fast 引擎就绪:", mod)

# 构建期没有 --gpus，拿不到真实设备，所以这里只能确认「包里编进了 CUDA EP」。
# 「这张卡上真的能跑」要等运行时看 /api/info 里的 providers —— ONNX Runtime
# 在 kernel 架构不匹配时会静默回落 CPU，不看那个就会被骗。
if os.environ.get("RUNTIME") == "gpu":
    try:
        import onnxruntime as ort
        avail = ort.get_available_providers()
    except Exception as exc:
        # 构建期没挂 --gpus，也就没有 libcuda.so.1，查询失败不代表包装错了。
        # 真正的判据在运行时，别在这里误杀构建。
        print("构建期查不到 providers（正常，没有驱动）:", exc)
    else:
        print("编译进包的 providers:", avail)
        if "CUDAExecutionProvider" not in avail:
            # 这个是真错：包本身就没编 CUDA EP，八成装成 CPU 版了
            sys.exit("装的不是 GPU 版 onnxruntime —— 包里没有 CUDAExecutionProvider")
PY
