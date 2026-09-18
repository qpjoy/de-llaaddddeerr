#!/usr/bin/env bash
# knock-ocr demo 一键管理脚本
#   bash scripts/manage.sh deploy      # 幂等：反复跑都行，会自己清理上一次的残留
# 所有配置都有默认值，需要改时在命令前面传：
#   PROXY=http://127.0.0.1:7788 PORT=9000 bash scripts/manage.sh deploy
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Windows 的 Git Bash(MSYS) 会把 /app/x、/tmp/x 这类「容器内路径」自动改写成
# Windows 路径，导致 docker run / cp / -v 全部错乱。关掉它；Linux 上无影响。
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL='*' 

# ---------------------------------------------------------------- 配置
TIER="${TIER:-fast-gpu}"                 # 部署档：fast | fast-gpu | quality | full
                                         #   fast     RapidOCR/PP-OCRv6 走 CPU，镜像 <1GB，不要 GPU
                                         #   fast-gpu 同一套模型走 onnxruntime CUDA EP，实测快 2.82×
                                         #            （单图 680ms -> 241ms，同 32 核配额同 intra_op）
                                         #            代价是镜像 ~4GB（CUDA+cuDNN 运行时）。默认档。
                                         #   quality  只装 PaddleOCR-VL + vLLM
                                         #   full     fast(CPU) + quality 都装，接口用 ?engine= 选
DEFAULT_ENGINE="${DEFAULT_ENGINE:-}"     # full 档下 /api/ocr 不带 engine 时走哪个，默认 fast
# 快通道每进程的流水线数。CPU 档和 GPU 档的调法方向相反，别照搬：
#   fast     一条流水线 = 一份 CPU 线程预算，靠多进程吃满核
#   fast-gpu 要反过来压进程数、加每进程的流水线数。单卡上多个进程 = 多个
#            CUDA context，是时间片轮转不是并行，加进程纯付切换成本。
#
# 实测（并发 16，n=200，CPU 配额 32 核）：
#   进程4×流水线1 =  4 条   7.02 req/s
#   进程8×流水线1 =  8 条   4.52 req/s   context 翻倍 -> 掉到三分之一
#   进程4×流水线2 =  8 条  10.58 req/s
#   进程4×流水线4 = 16 条  14.73 req/s   全成功
#   进程4×流水线8 = 32 条    ——          52/200 请求 HTTP 500
# 4 是目前跑满且零失败的最大值。想再往上要先查清 8 为什么会 500。
if [ "$TIER" = "fast-gpu" ]; then WORKERS_FAST="${WORKERS_FAST:-4}"; else WORKERS_FAST="${WORKERS_FAST:-8}"; fi
# 单次 ONNX/Paddle 推理会吃满 CPU，靠并发请求提不了吞吐 ——
# 必须「每次推理只用少量线程 + 多进程」才能把多核吃满。128 核机器尤其明显。
OMP_THREADS="${OMP_THREADS:-4}"          # 单次推理的线程数上限
# ONNX Runtime 的 intra_op 默认 0 = 用「它看到的所有核」。容器里它看到的是宿主机
# 核数（比如 128），而 cgroup 配额可能只有 32 —— 线程数超配额几倍，全耗在抢锁上，
# 实测能慢几十倍。必须显式对齐到 CPU 配额。
ORT_INTRA="${ORT_INTRA:-$OMP_THREADS}"   # fast 引擎单次推理的 ONNX 线程数
# fast-gpu 档的整个意义就是走 CUDA，所以默认开，不用额外传 FAST_CUDA=1。
# 其余档的镜像里是 CPU 版 onnxruntime，开了也没用，默认关。
# 想在 fast-gpu 档强行退回 CPU 对比：FAST_CUDA=0 bash scripts/manage.sh deploy
if [ "$TIER" = "fast-gpu" ]; then FAST_CUDA="${FAST_CUDA:-1}"; else FAST_CUDA="${FAST_CUDA:-0}"; fi

# ---- 资源占用上限：这台机器还跑着别的服务，默认只吃一小部分 ----
# 都可以覆盖。想吃满就传 CPU_LIMIT=0 MEM_LIMIT=0（不推荐）。
_HOST_CPUS="$(nproc 2>/dev/null || echo 8)"
_HOST_MEM_GB="$(awk '/MemTotal/{printf "%d", $2/1048576}' /proc/meminfo 2>/dev/null || echo 16)"
# CPU 是「时间片配额」：空闲时一点不占，超限只是被限速，不会让别的程序用不了。
# 所以按机器比例给是合理的。
# fast-gpu 的进程数固定 4：单卡上每进程一个 CUDA context，是时间片轮转不是并行，
# 加进程是负收益（实测 8 进程 4.52 req/s，4 进程 7.02）。
_UW_GPU=4
if [ "$TIER" = "fast-gpu" ]; then
  # GPU 档的 CPU 需求可以精确算出来，不用拍脑袋：满载时的 ONNX 线程总数
  #   进程数 × 每进程流水线数 × 单次推理线程数 = 4 × WORKERS_FAST × ORT_INTRA
  # 默认 4×4×4 = 64。给少了是线程超订 —— 实测 32 核比 64 核低 31%，
  # 那 31% 不是"多给了资源"，就是把超订消掉而已。给多了也用不上。
  # 想缩小占用就连流水线一起降（WORKERS_FAST=2 会自动算出 32 核），
  # 别只降 CPU_LIMIT 不降流水线，那是最差的组合。
  CPU_LIMIT="${CPU_LIMIT:-$(( _UW_GPU * WORKERS_FAST * ORT_INTRA ))}"
  [ "$CPU_LIMIT" -gt "$_HOST_CPUS" ] && CPU_LIMIT="$_HOST_CPUS"
else
  CPU_LIMIT="${CPU_LIMIT:-$(( _HOST_CPUS / 4 > 4 ? _HOST_CPUS / 4 : 4 ))}"   # 默认 1/4 核数，至少 4
fi
# CPUSET 是物理绑核（--cpuset-cpus），比 CPU_LIMIT 更硬：容器只能跑在这些核上，
# 而且在 128 核这种多 NUMA 机器上还顺带拿到访存局部性。默认不绑。
#   CPUSET=0-31   只用 0~31 号核
CPUSET="${CPUSET:-}"
# 内存和 CPU 不同：超限是直接 OOM Kill，不是限速；而且已分配的不会自动归还。
# 所以要按「实际峰值 + 余量」给，不能按机器比例拍 —— 给太小会被杀。
# 实测量级：fast 每 worker 几百 MB；quality 侧 vLLM 加载期host 内存会冲高。
case "$TIER" in
  fast|fast-gpu) MEM_LIMIT="${MEM_LIMIT:-16g}" ;;   # 权重都在显存/镜像里，host 内存要得不多
  *)             MEM_LIMIT="${MEM_LIMIT:-48g}" ;;
esac
GPU_MEM_UTIL="${GPU_MEM_UTIL:-0.35}"     # vLLM 占这张卡的显存比例，剩下留给别人
# API 进程数默认按 CPU 配额推：配额 / 单次推理线程数
if [ "$TIER" = "fast-gpu" ]; then
  UVICORN_WORKERS="${UVICORN_WORKERS:-$_UW_GPU}"
else
  UVICORN_WORKERS="${UVICORN_WORKERS:-$(( CPU_LIMIT / OMP_THREADS > 1 ? CPU_LIMIT / OMP_THREADS : 1 ))}"
fi
CACHE_SIZE="${CACHE_SIZE:-512}"          # 内容寻址缓存条数（sha256 去重）；0=关闭
CACHE_TTL="${CACHE_TTL:-900}"            # 缓存存活秒数，到点销毁（默认 15 分钟）
CACHE_MAX_MB="${CACHE_MAX_MB:-128}"      # 缓存总内存上限；缓存只在内存，不落盘
JOB_WORKERS="${JOB_WORKERS:-4}"          # 异步队列消费线程数
JOB_QUEUE_MAX="${JOB_QUEUE_MAX:-1000}"   # 队列深度，满了返回 429（明确背压）
JOB_TTL="${JOB_TTL:-1800}"               # 任务结果保留秒数
FETCH_ALLOW_HOSTS="${FETCH_ALLOW_HOSTS:-}"  # url 传参的域名白名单，空=不限
# 实测额定值，只用来在界面上给团队看，不影响运行。
# 当前值测自：fast-gpu / 4 进程 × 4 流水线 / 64 核 / 并发 24 / 200 请求 / 零失败。
# 换了配置就要重测并改这里，别让界面挂着一个过期的承诺。
RATED_CONCURRENCY="${RATED_CONCURRENCY:-24}"   # 调用方该用的并发（实测拐点）
RATED_RPS="${RATED_RPS:-24.8}"                 # 该并发下的实测吞吐
                                         # 爬虫重复图多，命中率 30~60%，直接抬高有效吞吐
PROJECT="${PROJECT:-knock-ocr}"          # 容器/网络/卷名前缀，改它可并存多套
GPU_ID="${GPU_ID:-2}"                    # 只占用这一张卡（默认避开挂显示器的 GPU3）
PORT="${PORT:-8710}"                     # 对外 Web + API 端口；被占用会自动顺延
STRICT_PORT="${STRICT_PORT:-0}"          # =1 则端口被占直接报错，不自动顺延
BIND="${BIND:-0.0.0.0}"                  # 只想本机访问就传 BIND=127.0.0.1
LOCAL_HOST="$BIND"
case "$LOCAL_HOST" in 0.0.0.0) LOCAL_HOST=127.0.0.1;; esac
VLLM_PORT="${VLLM_PORT:-8118}"           # 仅容器网络内部使用，不对外发布
MODEL="${MODEL:-PaddleOCR-VL-1.6-0.9B}"  # OmniDocBench v1.6 96.3% 的那个模型
WORKERS="${WORKERS:-4}"                  # API 侧并行流水线数
DEVICE="${DEVICE:-auto}"                 # auto | cpu | gpu:0  —— Paddle 侧（版面分析）跑在哪
WAIT_TIMEOUT="${WAIT_TIMEOUT:-2400}"     # 等服务就绪的秒数（首次要下模型，给足）
VLLM_ARGS="${VLLM_ARGS:-}"               # 透传给 genai_server 的额外参数
                                         # 显存比例见 GPU_MEM_UTIL；若本版本 genai_server
                                         # 不认该参数，用 manage.sh server-help 查真实参数名
PROXY="${PROXY:-}"                       # 出网代理，如 http://127.0.0.1:7788（下模型权重要用）
HOST_NET="${HOST_NET:-0}"                # =1 让 vLLM 走宿主机网络（代理只监听 127.0.0.1 时必须开）
MODEL_SOURCE="${MODEL_SOURCE:-modelscope}" # 模型源 modelscope|aistudio|bos|huggingface；前三个境内直连可达
PIP_INDEX_URL="${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}"  # 仅镜像缺依赖时才用到
FAST="${FAST:-0}"                        # =1 快速模式：更高并发 + 限像素限 token，牺牲少量细节换速度
# vl_rec_max_concurrency 官方默认 None（串行逐块请求 VLM），是最大的性能瓶颈。
if [ "$FAST" = "1" ]; then
  VL_CONCURRENCY="${VL_CONCURRENCY:-16}"
  MAX_PIXELS="${MAX_PIXELS:-1600000}"    # 约 1600x1000，正文够清晰，切块数明显减少
  MAX_NEW_TOKENS="${MAX_NEW_TOKENS:-1024}"
else
  VL_CONCURRENCY="${VL_CONCURRENCY:-8}"
  MAX_PIXELS="${MAX_PIXELS:-}"
  MAX_NEW_TOKENS="${MAX_NEW_TOKENS:-}"
fi
PROBE_TIMEOUT="${PROBE_TIMEOUT:-120}"    # GPU 探测单项超时；正常十几秒，挂住的才等满

REGISTRY="${REGISTRY:-ccr-2vdh3abv-pub.cnc.bj.baidubce.com/paddlepaddle}"
VLLM_IMAGE="${VLLM_IMAGE:-$REGISTRY/paddleocr-genai-vllm-server:latest-nvidia-gpu}"
BASE_IMAGE="${BASE_IMAGE:-$REGISTRY/paddleocr-vl:latest-nvidia-gpu}"
API_IMAGE="${API_IMAGE:-$PROJECT/api:$TIER}"
case "$TIER" in
  fast)          API_DOCKERFILE="docker/fast.Dockerfile" ;;
  fast-gpu)      API_DOCKERFILE="docker/fast-gpu.Dockerfile" ;;
  quality|full)  API_DOCKERFILE="docker/api.Dockerfile" ;;
  *) echo "TIER 只能是 fast | fast-gpu | quality | full，收到 $TIER" >&2; exit 1 ;;
esac
# 两个维度是独立的，别混用：
#   uses_vllm  要不要起 vLLM 容器、拉 20~30GB 官方镜像、挂模型缓存卷
#   needs_gpu  容器要不要 --gpus（fast-gpu 要卡但不要 vLLM）
uses_vllm() { case "$TIER" in quality|full) return 0 ;; *) return 1 ;; esac; }
needs_gpu() { [ "$TIER" != "fast" ]; }

NET="${PROJECT}-net"
C_VLLM="${PROJECT}-vllm"
C_API="${PROJECT}-api"
V_MODELS="${PROJECT}-models"
V_CACHE="${PROJECT}-cache"               # 整个 ~/.cache：huggingface / modelscope / vLLM 编译缓存
# CUDA 把 PTX 的 JIT 编译结果缓存在 ~/.nv/ComputeCache。官方 wheel 若没为 sm_120
# 预编译 kernel，首次推理就要现场 JIT，实测能占掉几十秒。容器一删缓存就没，
# 每次 redeploy 都要重付一遍 —— 挂成卷留住。
V_NVCACHE="${PROJECT}-nvcache"
                                         # 挂子目录会让 docker 以 root 造出父目录 ~/.cache，
                                         # 导致 vLLM 写不了 ~/.cache/vllm 的 torch.compile 缓存
STATE="$ROOT/.deploy"

# ---------------------------------------------------------------- 输出
c_red=$'\033[31m'; c_grn=$'\033[32m'; c_ylw=$'\033[33m'
c_blu=$'\033[36m'; c_dim=$'\033[2m'; c_off=$'\033[0m'
say()  { printf '%s==>%s %s\n' "$c_blu" "$c_off" "$*"; }
ok()   { printf '%s ok %s %s\n' "$c_grn" "$c_off" "$*"; }
warn() { printf '%s  ! %s %s\n' "$c_ylw" "$c_off" "$*"; }
die()  { printf '%s ERR%s %s\n' "$c_red" "$c_off" "$*" >&2; exit 1; }
dim()  { printf '%s%s%s\n' "$c_dim" "$*" "$c_off"; }
rule() { printf '%s%s%s\n' "$c_dim" "────────────────────────────────────────────────────────" "$c_off"; }

# ---------------------------------------------------------------- 工具
have() { command -v "$1" >/dev/null 2>&1; }
container_state() { docker inspect -f '{{.State.Status}}' "$1" 2>/dev/null || echo "absent"; }
container_exit_code() { docker inspect -f '{{.State.ExitCode}}' "$1" 2>/dev/null || echo "?"; }
http_ok() { curl -fsS -m 3 "$1" >/dev/null 2>&1; }

port_busy() {
  if have ss;        then ss -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0
  elif have netstat; then netstat -ltn 2>/dev/null | grep -qE "[:.]$1[[:space:]]" && return 0
  fi
  return 1
}

# 从 PORT 开始往后找一个没被占的
free_port() {
  local p="$1"
  for _ in $(seq 0 50); do
    port_busy "$p" || { echo "$p"; return 0; }
    p=$((p + 1))
  done
  return 1
}

# 容器里的 127.0.0.1 是容器自己，不是宿主机。桥接网络下要改走 host-gateway。
proxy_for_container() { sed -E 's#//(127\.0\.0\.1|localhost)([:/]|$)#//host.docker.internal\2#' <<<"$1"; }

# docker CLI 会把 ~/.docker/config.json 里的 proxies 自动注入每个容器。
# 如果那里写的是 127.0.0.1:xxxx，容器里指的是容器自己 → 必然 Connection refused。
# 所以这里总是显式接管所有代理变量：要么给正确的值，要么置空覆盖掉继承来的。
# 国内模型源始终直连，不走代理。代理若在境外（比如日本节点），
# 让 bcebos / modelscope / aistudio 绕出去会让 CDN 就近调度失效，下载慢一个数量级。
DOMESTIC_DIRECT="bcebos.com,.bcebos.com,baidu.com,.baidu.com,modelscope.cn,.modelscope.cn,aliyuncs.com,.aliyuncs.com"

proxy_run_args() {
  local p=""
  if [ -n "$PROXY" ]; then
    if [ "$HOST_NET" = "1" ]; then p="$PROXY"   # 宿主机网络下 127.0.0.1 就是对的
    else p="$(proxy_for_container "$PROXY")"; fi
  fi
  [ -n "$PROXY" ] && [ "$HOST_NET" != "1" ] && \
    printf '%s\n' --add-host "host.docker.internal:host-gateway"
  local nop="localhost,127.0.0.1,$C_VLLM,$C_API,$DOMESTIC_DIRECT"
  printf '%s\n' \
    -e "http_proxy=$p"  -e "HTTP_PROXY=$p" \
    -e "https_proxy=$p" -e "HTTPS_PROXY=$p" \
    -e "all_proxy=$p"   -e "ALL_PROXY=$p" \
    -e "no_proxy=$nop" \
    -e "NO_PROXY=$nop"
}

# 当前形态是否依赖外部 VLM 后端（将来接别的引擎时这里放宽）
uses_vllm_backend() { uses_vllm; }

# 容器实际继承到的代理变量（诊断用）
inherited_proxy() {
  docker run --rm "$1" env 2>/dev/null | grep -iE '^(http|https|all)_proxy=' || true
}

# 官方镜像以 paddleocr 用户运行，HOME=/home/paddleocr，模型缓存落在那儿。
# 之前把卷挂在 /root/.paddlex，等于没挂 —— 权重每次都要重下。这里动态取真实 HOME。
container_home() {
  docker run --rm --entrypoint sh "$1" -c 'printf %s "$HOME"' 2>/dev/null || printf /root
}

# 镜像里运行进程的 uid:gid（官方镜像是非 root 的 paddleocr 用户）
container_uidgid() {
  docker run --rm --entrypoint sh "$1" -c 'printf "%s:%s" "$(id -u)" "$(id -g)"' 2>/dev/null || printf '0:0'
}

# 命名卷新建时是 root 属主，容器里的非 root 用户写不进去（Errno 13）。
# 这里把卷的属主对齐到镜像实际用户，并放开权限，避免两个镜像 uid 不一致时又卡住。
ensure_volume_perms() {
  local vol="$1" img="$2" ug
  ug="$(container_uidgid "$img")"
  docker run --rm --user 0:0 --entrypoint sh -v "$vol":/vol "$img"     -c "chown -R $ug /vol 2>/dev/null; chmod -R a+rwX /vol 2>/dev/null; true" >/dev/null 2>&1 || true
}

# 容器资源上限。CPU_LIMIT=0 / MEM_LIMIT=0 表示不限（不推荐，会挤占别的服务）。
limit_args() {
  local a=()
  [ "${CPU_LIMIT:-0}" != "0" ] && a+=(--cpus "$CPU_LIMIT")
  [ "${MEM_LIMIT:-0}" != "0" ] && [ "${MEM_LIMIT}" != "0g" ] && a+=(--memory "$MEM_LIMIT")
  [ -n "${CPUSET:-}" ] && a+=(--cpuset-cpus "$CPUSET")
  [ ${#a[@]} -gt 0 ] && printf '%s
' "${a[@]}"
  return 0
}

# 关掉 MSYS 路径转换后，宿主机路径（/e/foo）docker 不认；
# 这个函数在 Windows 上转回 E:/foo，Linux 上原样返回。
hostpath() {
  if have cygpath; then cygpath -m "$1"; else printf '%s' "$1"; fi
}

# 生成测试图到宿主机路径 $1。
# 不用 bind mount —— RHEL 上 SELinux + 容器内用户权限会导致写不进去（Errno 13）。
# 改成容器内写 /tmp，再 docker cp 出来，零挂载零权限问题。
gen_sample() {
  local dst="$1" cid rc=0
  mkdir -p "$(dirname "$dst")"
  # --entrypoint python 绕开基础镜像的 nvidia 入口脚本。它一看没挂 --gpus 就打一句
  # 「NVIDIA Driver was not detected」，而这里只是借镜像用 PIL 画张图，本来就不需要卡。
  # 那句警告在 API 主容器的日志里是有用信号（说明真的漏挂了卡），所以只在这类
  # 辅助调用里绕开，不去动镜像的 ENTRYPOINT。
  cid="$(docker create --entrypoint python "$API_IMAGE" /app/make_sample.py /tmp/sample.png)" || return 1
  docker start -a "$cid" || rc=$?
  if [ $rc -ne 0 ]; then docker rm -f "$cid" >/dev/null 2>&1; return 1; fi
  docker cp "$cid:/tmp/sample.png" "$(hostpath "$dst")" >/dev/null || rc=$?
  docker rm -f "$cid" >/dev/null 2>&1
  return $rc
}

# ---------------------------------------------------------------- preflight
cmd_preflight() {
  say "环境检查"

  have docker || die "未找到 docker。这个 demo 全部跑在容器里，不会碰宿主机的 Python/CUDA。"
  docker info >/dev/null 2>&1 || die "docker 守护进程不可用（当前用户可能不在 docker 组）。"
  ok "docker 可用"

  if ! needs_gpu; then
    ok "档位 $TIER：纯 CPU，不需要 GPU，也不拉 20~30GB 官方镜像"
  else
  uses_vllm || ok "档位 $TIER：要一张卡跑 ONNX CUDA EP，但不起 vLLM、不拉官方大镜像"
  have nvidia-smi || die "未找到 nvidia-smi"
  local ngpu; ngpu="$(nvidia-smi -L | wc -l | tr -d ' ')"
  nvidia-smi -i "$GPU_ID" >/dev/null 2>&1 || die "GPU $GPU_ID 不存在（本机共 $ngpu 张卡，编号 0..$((ngpu-1))）"
  ok "GPU $GPU_ID 存在：$(nvidia-smi -i "$GPU_ID" --query-gpu=name,memory.total --format=csv,noheader)"

  local busy; busy="$(nvidia-smi -i "$GPU_ID" --query-compute-apps=pid,used_memory --format=csv,noheader || true)"
  if [ -n "$busy" ]; then
    warn "GPU $GPU_ID 上已有计算进程，demo 会与其共享显存："
    echo "$busy" | sed 's/^/      /'
  else
    ok "GPU $GPU_ID 空闲"
  fi

  if docker info 2>/dev/null | grep -qi 'nvidia'; then
    ok "docker 已注册 nvidia runtime"
  else
    warn "docker info 里没看到 nvidia runtime，若 deploy 失败请检查 nvidia-container-toolkit"
  fi
  fi

  # 端口：被自己的旧容器占着不算冲突（deploy 会先清掉）
  if port_busy "$PORT"; then
    if [ "$(container_state "$C_API")" = "running" ]; then
      ok "端口 $PORT 目前被本 demo 自己占着，稍后会重启"
    elif [ "$STRICT_PORT" = "1" ]; then
      die "端口 $PORT 已被占用（STRICT_PORT=1）。换一个：PORT=<n> bash scripts/manage.sh deploy"
    else
      local np; np="$(free_port $((PORT + 1)))" || die "$PORT 起往后 50 个端口都被占用了"
      warn "端口 $PORT 被别的服务占用，自动改用 $np（固定端口请传 PORT=<n>）"
      PORT="$np"
    fi
  fi
  ok "对外端口 $PORT"
  if [ "${CPU_LIMIT:-0}" != "0" ]; then
    ok "资源配额：CPU ${CPU_LIMIT} 核 / 内存 ${MEM_LIMIT} / API 进程 ${UVICORN_WORKERS}（宿主机共 ${_HOST_CPUS} 核 ${_HOST_MEM_GB}G）"
    dim "      想多给：CPU_LIMIT=64 MEM_LIMIT=64g bash scripts/manage.sh deploy"
    [ -n "${CPUSET:-}" ] && ok "物理绑核：$CPUSET（容器只能跑在这些核上）"       || dim "      要物理隔离可绑核：CPUSET=0-31 bash scripts/manage.sh deploy"
  else
    warn "未设 CPU/内存上限，可能挤占这台机器上的其他服务"
  fi
  uses_vllm && dim "      vLLM 显存比例 GPU_MEM_UTIL=$GPU_MEM_UTIL（其余留给别人）"
  if [ "$TIER" = "fast-gpu" ]; then
    ok "额定能力：并发 $RATED_CONCURRENCY → $RATED_RPS req/s（$UVICORN_WORKERS 进程 × $WORKERS_FAST 条流水线）"
    if [ "$WORKERS_FAST" -gt 4 ]; then
      warn "WORKERS_FAST=$WORKERS_FAST 实测会撑爆显存：32 条流水线时约 1/4 请求返回 500"
      dim "      报错形如 BFCArena ... Failed to allocate memory。32GB 单卡上别超 4。"
    fi
  fi

  if have firewall-cmd && firewall-cmd --state >/dev/null 2>&1; then
    if firewall-cmd --query-port="$PORT/tcp" >/dev/null 2>&1; then
      ok "firewalld 已放行 $PORT/tcp"
    elif [ "$BIND" = "127.0.0.1" ]; then
      ok "firewalld 运行中；BIND=127.0.0.1 仅本机访问，无需放行"
    else
      warn "firewalld 未放行 $PORT/tcp，外部浏览器可能连不上。放行："
      dim "      firewall-cmd --add-port=$PORT/tcp --permanent && firewall-cmd --reload"
    fi
  fi

  if have getenforce && [ "$(getenforce 2>/dev/null)" = "Enforcing" ]; then
    dim "      SELinux=Enforcing（bind mount 已加 :z，正常情况无需额外处理）"
  fi

  # docker 是否会往容器里硬塞代理变量 —— 指向 127.0.0.1 的话容器必然连不上
  if uses_vllm && docker image inspect "$VLLM_IMAGE" >/dev/null 2>&1; then
    local inh; inh="$(inherited_proxy "$VLLM_IMAGE")"
    if [ -n "$inh" ]; then
      warn "docker 会向容器注入代理变量（来自 ~/.docker/config.json）："
      sed 's/^/      /' <<<"$inh"
      if grep -qE '127\.0\.0\.1|localhost' <<<"$inh"; then
        warn "其中指向 127.0.0.1 —— 在容器里这是容器自己，必然 Connection refused"
      fi
      dim "      本脚本会显式覆盖这些变量，不受它影响"
    else
      ok "docker 没有向容器注入代理变量"
    fi
  fi

  if [ -n "$PROXY" ]; then
    if curl -fsS -m 5 -x "$PROXY" -o /dev/null https://www.baidu.com 2>/dev/null; then
      if [ "$HOST_NET" = "1" ]; then
        ok "代理可用：$PROXY（宿主机网络，容器内直接用同一地址）"
      else
        ok "代理可用：$PROXY（容器内改写为 $(proxy_for_container "$PROXY")）"
      fi
    else
      warn "代理 $PROXY 从宿主机测不通，模型下载可能失败"
    fi
  else
    ok "不使用代理（容器内代理变量已被置空，走直连）"
  fi

  local free; free="$(df -Pk /var/lib/docker 2>/dev/null | awk 'NR==2{print int($4/1048576)}' || echo 0)"
  if [ "${free:-0}" -lt 40 ]; then
    warn "/var/lib/docker 可用空间约 ${free}GB，镜像约需 20~30GB"
  else
    ok "磁盘空间充足（约 ${free}GB）"
  fi
  echo
}

# ---------------------------------------------------------------- GPU 探测
# 分两件事查，别混为一谈：
#   1) vLLM 侧（PyTorch）能否用这张卡 —— 这决定 demo 能不能跑，是硬要求
#   2) Paddle 侧能否用这张卡 —— 只影响版面分析放 CPU 还是 GPU，降级不影响精度
cmd_gpucheck() {
  mkdir -p "$STATE"

  # fast / fast-gpu 档不碰 PyTorch 和 Paddle，下面那两项探测对它们没有意义，
  # 而且会去拉 20~30GB 的官方镜像。换成真正相关的那一项：ONNX Runtime 的 CUDA EP
  # 在这张卡上到底立不立得住。
  if ! uses_vllm; then
    rule
    if ! needs_gpu; then
      ok "档位 $TIER：纯 CPU，无需 GPU 自检"
      rule; return 0
    fi
    say "fast-gpu 自检：ONNX Runtime 能不能真的在 GPU $GPU_ID 上跑"
    if ! docker image inspect "$API_IMAGE" >/dev/null 2>&1; then
      warn "镜像 $API_IMAGE 还没构建，先跑一次 deploy"
      rule; return 1
    fi
    local ort_out ort_rc=0
    ort_out="$(timeout -k 10 "$PROBE_TIMEOUT" docker run --rm --gpus "device=$GPU_ID" \
      -e OCR_TIER=fast-gpu -e OCR_FAST_CUDA=1 "$API_IMAGE" python -c '
import sys, time
sys.path.insert(0, "/app")
from PIL import Image, ImageDraw
img = Image.new("RGB", (360, 90), "white")
ImageDraw.Draw(img).text((12, 34), "gpu probe 12345 ABC", fill="black")
img.save("/tmp/probe.png")
from engines import FastEngine
e = FastEngine()
h = e.build()
print("providers", e.applied.get("providers"))
h("/tmp/probe.png")                       # 预热，让 kernel 真的编译/加载
t = time.perf_counter()
for _ in range(3):
    h("/tmp/probe.png")
print("infer ok %.0f ms" % ((time.perf_counter() - t) / 3 * 1000))
' 2>&1)" || ort_rc=$?
    printf '%s\n' "$ort_out" > "$STATE/ort_probe.log"
    if [ $ort_rc -eq 0 ] && grep -q 'infer ok' <<<"$ort_out" \
       && grep -q 'CUDAExecutionProvider' <<<"$ort_out"; then
      ok "ONNX Runtime 真的跑在这张卡上（providers 里保住了 CUDAExecutionProvider）"
      sed 's/^/      /' <<<"$ort_out" | tail -3
    elif [ $ort_rc -eq 0 ] && grep -q 'infer ok' <<<"$ort_out"; then
      warn "推理跑通了，但 providers 里没有 CUDAExecutionProvider —— 已静默回落 CPU"
      dim "      这正是最容易被忽悠的情况：服务照常起、日志干净，只是白挂了一张卡。"
      sed 's/^/      /' <<<"$ort_out" | tail -4
    else
      warn "fast-gpu 自检未通过"
      sed 's/^/      /' <<<"$ort_out" | tail -12
      dim "      完整日志：$STATE/ort_probe.log"
      dim "      退回 CPU 版：TIER=fast bash scripts/manage.sh deploy"
    fi
    rule; return 0
  fi

  rule
  say "1/2  vLLM 侧（PyTorch）—— 硬要求"
  local torch_out torch_rc=0
  torch_out="$(timeout -k 10 "$PROBE_TIMEOUT" docker run --rm --gpus "device=$GPU_ID" "$VLLM_IMAGE" python -c '
import torch
print("torch", torch.__version__, "cuda", torch.version.cuda)
print("available", torch.cuda.is_available())
if torch.cuda.is_available():
    cc = torch.cuda.get_device_capability(0)
    print("device", torch.cuda.get_device_name(0), "sm_%d%d" % cc)
    x = torch.ones(1024, 1024, device="cuda", dtype=torch.float16)
    print("matmul ok", float((x @ x)[0, 0]))
' 2>&1)" || torch_rc=$?
  printf '%s\n' "$torch_out" > "$STATE/torch_probe.log"
  if [ $torch_rc -eq 0 ] && grep -q 'matmul ok' <<<"$torch_out"; then
    ok "PyTorch 可以在这张卡上跑核"
    sed 's/^/      /' <<<"$torch_out" | head -4
  elif [ $torch_rc -eq 124 ] || [ $torch_rc -eq 137 ]; then
    warn "PyTorch 探测 ${PROBE_TIMEOUT}s 超时"
    sed 's/^/      /' <<<"$torch_out" | tail -8
  else
    warn "PyTorch 在这张卡上跑不起来 —— vLLM 一定会挂"
    sed 's/^/      /' <<<"$torch_out" | tail -12
    dim "      完整日志：$STATE/torch_probe.log"
  fi

  echo
  say "2/2  Paddle 侧（版面分析）—— 失败可降级"
  local pd_out pd_rc=0
  # 不用 paddle.utils.run_check()：它顺带跑分布式自检，容器里常因无关原因失败，
  # 会把 GPU 可用误判成不可用。这里只做最小的真实核启动测试。
  pd_out="$(timeout -k 10 "$PROBE_TIMEOUT" docker run --rm --gpus "device=$GPU_ID" "$BASE_IMAGE" python -c '
import paddle
print("paddle", paddle.__version__)
n = paddle.device.cuda.device_count()
print("device_count", n)
assert n > 0, "看不到 GPU"
print("capability", paddle.device.cuda.get_device_capability(0))
x = paddle.ones([512, 512], dtype="float32").cuda()
print("matmul ok", float(paddle.matmul(x, x)[0, 0]))
' 2>&1)" || pd_rc=$?
  printf '%s\n' "$pd_out" > "$STATE/paddle_probe.log"
  if [ $pd_rc -eq 0 ] && grep -q 'matmul ok' <<<"$pd_out"; then
    ok "Paddle 可以在这张卡上跑核"
    sed 's/^/      /' <<<"$pd_out" | head -4
    echo "gpu:0" > "$STATE/paddle_gpu"
  else
    if [ $pd_rc -eq 124 ] || [ $pd_rc -eq 137 ]; then
      warn "Paddle 探测 ${PROBE_TIMEOUT}s 超时（在不支持的架构上初始化会一直卡住）→ 版面分析走 CPU"
    elif grep -qiE 'no kernel image|sm_120|not compiled with|arch' <<<"$pd_out"; then
      warn "Paddle 不含 sm_120 kernel（Blackwell 已知问题）→ 版面分析走 CPU"
    else
      warn "Paddle GPU 自检未通过 → 版面分析走 CPU"
    fi
    sed 's/^/      /' <<<"$pd_out" | tail -12
    dim "      完整日志：$STATE/paddle_probe.log"
    dim "      注意：这不影响识别精度。决定 96.3% 的 0.9B VLM 跑在 vLLM(GPU) 上，"
    dim "            CPU 只承担轻量版面检测，本机 128 核绰绰有余。"
    echo "cpu" > "$STATE/paddle_gpu"
  fi
  rule
}

resolve_device() {
  mkdir -p "$STATE"
  if [ "$DEVICE" != "auto" ]; then echo "$DEVICE" > "$STATE/paddle_gpu"; fi
  [ -s "$STATE/paddle_gpu" ] || cmd_gpucheck >&2
  cat "$STATE/paddle_gpu"
}

# ---------------------------------------------------------------- 构建 / 启动
ensure_net() {
  docker network inspect "$NET" >/dev/null 2>&1 || docker network create "$NET" >/dev/null
  if needs_gpu && ! uses_vllm; then
    docker volume inspect "$V_NVCACHE" >/dev/null 2>&1 || docker volume create "$V_NVCACHE" >/dev/null
  fi
  docker volume inspect "$V_MODELS" >/dev/null 2>&1 || docker volume create "$V_MODELS" >/dev/null
  docker volume inspect "$V_CACHE"  >/dev/null 2>&1 || docker volume create "$V_CACHE" >/dev/null

  # 卷属主对齐（容器以非 root 用户跑，卷默认 root 属主会导致 Errno 13）
  uses_vllm || { ok "档位 $TIER：无需模型缓存卷"; return 0; }
  say "对齐模型缓存卷属主"
  local img="$API_IMAGE"
  docker image inspect "$img" >/dev/null 2>&1 || img="$BASE_IMAGE"
  for v in "$V_MODELS" "$V_CACHE"; do
    ensure_volume_perms "$v" "$img"
  done
  ok "卷属主已对齐为 $(container_uidgid "$img")"
}

cmd_pull() {
  uses_vllm || { ok "档位 $TIER：不需要官方大镜像"; return 0; }
  say "确认官方镜像（已有则跳过，不会重复下载）"
  docker image inspect "$VLLM_IMAGE" >/dev/null 2>&1 || docker pull "$VLLM_IMAGE"
  docker image inspect "$BASE_IMAGE" >/dev/null 2>&1 || docker pull "$BASE_IMAGE"
  ok "镜像就绪"
}

cmd_build() {
  say "构建 API 镜像（依赖齐全时不需要联网）"
  # 同样要覆盖 docker 从 config.json 注入的构建期代理，否则 RUN 一旦联网就挂
  local net=(--build-arg "http_proxy=" --build-arg "https_proxy="
             --build-arg "HTTP_PROXY=" --build-arg "HTTPS_PROXY=")
  if [ -n "$PROXY" ]; then
    net=(--network host
         --build-arg "http_proxy=$PROXY"  --build-arg "https_proxy=$PROXY"
         --build-arg "HTTP_PROXY=$PROXY"  --build-arg "HTTPS_PROXY=$PROXY")
  fi
  local wf=1; [ "$TIER" = "quality" ] && wf=0   # 纯 quality 档不必装 rapidocr
  docker build "${net[@]}" --build-arg "BASE_IMAGE=$BASE_IMAGE" \
    --build-arg "PIP_INDEX_URL=$PIP_INDEX_URL" \
    --build-arg "WITH_FAST=$wf" \
    -f "$API_DOCKERFILE" -t "$API_IMAGE" .
  ok "API 镜像就绪：$API_IMAGE"
}

start_vllm() {
  local net=(--network "$NET")
  if [ "$HOST_NET" = "1" ]; then
    # 代理只监听 127.0.0.1 时，容器必须共享宿主机网络才连得上
    net=(--network host)
    say "启动 VLM 推理服务（GPU $GPU_ID, model=$MODEL, 宿主机网络）"
  else
    say "启动 VLM 推理服务（GPU $GPU_ID, model=$MODEL）"
  fi
  local px=(); mapfile -t px < <(proxy_run_args)
  local home; home="$(container_home "$VLLM_IMAGE")"; home="${home:-/root}"
  # shellcheck disable=SC2086
  local lim=(); mapfile -t lim < <(limit_args)
  docker run -d --name "$C_VLLM" "${net[@]}" "${lim[@]}" \
    --gpus "device=$GPU_ID" \
    --restart unless-stopped \
    --label com.mx-base.app=mx-ocr \
    --shm-size 8g \
    "${px[@]}" \
    -e VLLM_FLASH_ATTN_VERSION=2 \
    -e PADDLE_PDX_MODEL_SOURCE="$MODEL_SOURCE" \
    -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    -v "$V_MODELS":"$home/.paddlex" \
    -v "$V_CACHE":"$home/.cache" \
    "$VLLM_IMAGE" \
    paddleocr genai_server --model_name "$MODEL" \
      --host 0.0.0.0 --port "$VLLM_PORT" --backend vllm $VLLM_ARGS >/dev/null
  ok "容器 $C_VLLM 已启动（模型源 $MODEL_SOURCE，已跳过连通性预检）"
}

start_api() {
  local dev="$1"
  say "启动 API + Web 服务（版面分析设备：$dev）"
  # 和 vLLM 容器一样必须显式接管代理变量，否则会继承 docker 注入的 127.0.0.1:7788，
  # 下版面分析模型时四个源全部走那个不存在的代理 -> 流水线一条都建不起来。
  local px=(); mapfile -t px < <(proxy_run_args)
  local home; home="$(container_home "$API_IMAGE")"; home="${home:-/root}"
  # vLLM 若在宿主机网络，容器名解析不到，改用 host-gateway
  local vurl="http://$C_VLLM:$VLLM_PORT" extra=()
  if [ "$HOST_NET" = "1" ]; then
    vurl="http://host.docker.internal:$VLLM_PORT"
    extra=(--add-host "host.docker.internal:host-gateway")
  fi
  # 挂卡的理由按档位完全不同，别把这两种情况合并：
  #
  #   quality/full  镜像里是 paddlepaddle 的 GPU 版，import paddle 就要 libcuda.so.1，
  #                 不挂直接 ImportError。但我们只用 CPU 跑版面分析，所以再加
  #                 CUDA_VISIBLE_DEVICES="" 让它看得到驱动库、看不到设备 ——
  #                 不占显存也不碰 paddle 的 sm_120 坑。
  #   fast-gpu      反过来：就是要用这张卡跑 ONNX 的 CUDA EP，绝不能清空
  #                 CUDA_VISIBLE_DEVICES，否则 onnxruntime 找不到设备会静默回落 CPU，
  #                 服务照常起来、日志干干净净，只是白挂了一张卡。
  #   fast          纯 CPU 镜像，不挂。
  local vols=()
  if uses_vllm; then
    extra+=(--gpus "device=$GPU_ID" -e CUDA_VISIBLE_DEVICES="")
    vols=(-v "$V_MODELS":"$home/.paddlex" -v "$V_CACHE":"$home/.cache")
  elif needs_gpu; then
    extra+=(--gpus "device=$GPU_ID")
    vols=(-v "$V_NVCACHE":"$home/.nv")     # 留住 PTX JIT 缓存，redeploy 不用重编
  fi
  local lim=(); mapfile -t lim < <(limit_args)
  docker run -d --name "$C_API" --network "$NET" "${lim[@]}" \
    --restart unless-stopped \
    --label com.mx-base.app=mx-ocr \
    -p "$BIND:$PORT:8000" \
    "${extra[@]}" \
    "${px[@]}" \
    -e "OCR_TIER=$TIER" \
    -e "OCR_DEFAULT_ENGINE=$DEFAULT_ENGINE" \
    -e "OCR_DEVICE=$dev" \
    -e "OCR_MODEL=$MODEL" \
    -e "OCR_VLLM_URL=$vurl" \
    -e "OCR_WORKERS_FAST=$WORKERS_FAST" \
    -e "OCR_CACHE_SIZE=$CACHE_SIZE" \
    -e "OCR_CACHE_TTL=$CACHE_TTL" \
    -e "OCR_CACHE_MAX_MB=$CACHE_MAX_MB" \
    -e "OCR_JOB_WORKERS=$JOB_WORKERS" \
    -e "OCR_JOB_QUEUE_MAX=$JOB_QUEUE_MAX" \
    -e "OCR_JOB_TTL=$JOB_TTL" \
    -e "OCR_FETCH_ALLOW_HOSTS=$FETCH_ALLOW_HOSTS" \
    -e "UVICORN_WORKERS=$UVICORN_WORKERS" \
    -e "OCR_CPU_LIMIT=$CPU_LIMIT" \
    -e "OCR_MEM_LIMIT=$MEM_LIMIT" \
    -e "OCR_CPUSET=$CPUSET" \
    -e "OCR_HOST_CPUS=$_HOST_CPUS" \
    -e "OCR_HOST_MEM_GB=$_HOST_MEM_GB" \
    -e "OCR_GPU_ID=$(needs_gpu && printf '%s' "$GPU_ID")" \
    -e "OCR_RATED_CONCURRENCY=$RATED_CONCURRENCY" \
    -e "OCR_RATED_RPS=$RATED_RPS" \
    -e "OMP_NUM_THREADS=$OMP_THREADS" \
    -e "OCR_ORT_INTRA_THREADS=$ORT_INTRA" \
    -e "OCR_FAST_CUDA=$FAST_CUDA" \
    -e "OPENBLAS_NUM_THREADS=$OMP_THREADS" \
    -e "MKL_NUM_THREADS=$OMP_THREADS" \
    -e "OCR_WORKERS_QUALITY=$WORKERS" \
    -e "OCR_VL_CONCURRENCY=$VL_CONCURRENCY" \
    -e "OCR_MAX_PIXELS=$MAX_PIXELS" \
    -e "OCR_MAX_NEW_TOKENS=$MAX_NEW_TOKENS" \
    -e PADDLE_PDX_MODEL_SOURCE="$MODEL_SOURCE" \
    -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True \
    "${vols[@]}" \
    "$API_IMAGE" >/dev/null
  ok "容器 $C_API 已启动（档位 $TIER）"
}

# ---------------------------------------------------------------- 故障诊断
diagnose() {
  local c="$1" logs
  logs="$(docker logs --tail 400 "$c" 2>&1 || true)"
  echo
  rule
  printf '%s容器 %s 退出（exit=%s），最后 40 行日志：%s\n' \
    "$c_red" "$c" "$(container_exit_code "$c")" "$c_off"
  rule
  tail -40 <<<"$logs" | sed 's/^/  /'
  rule

  say "可能的原因"
  local hit=0
  if grep -qiE 'no kernel image|sm_120|kernel image is available|CUDA capability' <<<"$logs"; then
    hit=1
    warn "GPU 架构不匹配：镜像里的 PyTorch/vLLM 不支持 sm_120（Blackwell）"
    dim "      先跑 bash scripts/manage.sh gpucheck 确认"
    dim "      若确认不支持，需要换支持 Blackwell 的镜像或自行升级 vLLM"
  fi
  if grep -qiE 'no model hoster|no available model hosting|could not prepare the official model' <<<"$logs"; then
    hit=1
    warn "连不上模型源，权重下不下来"
    dim "      先查清容器到底能不能出网：bash scripts/manage.sh netcheck"
    dim "      最常见原因：代理只监听 127.0.0.1，桥接网络里的容器够不着 → 加 HOST_NET=1"
    dim "        HOST_NET=1 PROXY=$PROXY bash scripts/manage.sh deploy"
    dim "      国内机器优先试 BOS 直连（百度自家 CDN，往往不需要代理）："
    dim "        MODEL_SOURCE=modelscope bash scripts/manage.sh deploy   # 或 aistudio / bos"
  fi
  if grep -qi 'proxyerror' <<<"$logs" && grep -qE "127\.0\.0\.1', port=" <<<"$logs"; then
    hit=1
    warn "容器把 127.0.0.1 当代理了 —— 那是容器自己，必然 Connection refused"
    dim "      来源多半是 ~/.docker/config.json 的 proxies，docker 会注入每个容器"
    dim "      查看：cat ~/.docker/config.json"
    dim "      本脚本现在会显式覆盖这些变量，更新代码后重跑即可"
  fi
  if grep -qiE 'proxyerror|max retries|connection refused|connection reset|timed out|temporary failure in name resolution' <<<"$logs"; then
    hit=1
    warn "网络问题：模型权重没下下来"
    dim "      带上代理重试：PROXY=http://127.0.0.1:7788 bash scripts/manage.sh deploy"
    dim "      容器里 127.0.0.1 指容器自己，脚本已自动改写为 host.docker.internal"
  fi
  if grep -qiE 'not a valid|repository not found|no such file or directory|could not find|unknown model|invalid model|does not exist' <<<"$logs"; then
    hit=1
    warn "模型名可能不对：当前用的是 $MODEL"
    dim "      看镜像支持哪些：bash scripts/manage.sh server-help"
    dim "      换一个再试：MODEL=PaddleOCR-VL-0.9B bash scripts/manage.sh deploy"
  fi
  if grep -qiE 'out of memory|CUDA out of memory|OOM' <<<"$logs"; then
    hit=1
    warn "显存不足"
    dim "      换张空卡：GPU_ID=<n> bash scripts/manage.sh deploy"
    dim "      或限制占用：VLLM_ARGS='--gpu-memory-utilization 0.5'（先用 server-help 确认参数名）"
  fi
  if grep -qiE 'address already in use' <<<"$logs"; then
    hit=1
    warn "容器内端口冲突：VLLM_PORT=$VLLM_PORT"
  fi
  if grep -qiE 'flash.?attn' <<<"$logs"; then
    hit=1
    warn "FlashAttention 相关：Blackwell 上 FA3 不可用，已设 VLLM_FLASH_ATTN_VERSION=2"
    dim "      仍失败可试：VLLM_ARGS='--enforce-eager'"
  fi
  [ $hit -eq 0 ] && dim "      没匹配到已知模式，把上面日志发我看看"
  echo
  dim "  完整日志：docker logs $c"
  dim "  改完配置直接重跑：bash scripts/manage.sh deploy（幂等，会自己清理）"
}

# 取容器最后一行有内容的日志，用来在等待时显示"它到底在干嘛"
last_log_line() {
  docker logs --tail 20 "$1" 2>&1 \
    | tr -d '\r' | sed 's/\x1b\[[0-9;]*[a-zA-Z]//g' \
    | grep -vE '^\s*$' | tail -1 | cut -c1-100
}

wait_ready() {
  say "等待服务就绪"
  if uses_vllm; then
    dim "  两个阶段：① vLLM 下权重并加载模型  ② API 侧构建流水线（要下版面模型）"
  else
    dim "  档位 $TIER：模型内置在镜像里，只需构建流水线，通常几秒"
  fi
  dim "  下面显示两者各自的状态，并实时跟随当前还没好的那个容器的日志。"
  dim "  完整日志：manage.sh logs vllm / manage.sh logs api"
  echo
  local t0 now spin=0 elapsed line prev="" stuck=0
  local info vllm_up pool_ready watch stage
  local frames=('|' '/' '-' '\')
  t0="$(date +%s)"
  while :; do
    now="$(date +%s)"; elapsed=$((now - t0))
    if [ "$elapsed" -gt "$WAIT_TIMEOUT" ]; then
      printf '\r\033[K'; warn "等待超时（${WAIT_TIMEOUT}s）"
      dim "  容器还活着，只是没就绪。看日志：manage.sh logs api / manage.sh logs vllm"
      return 1
    fi
    local _cs="$C_API"; uses_vllm && _cs="$C_VLLM $C_API"
    for c in $_cs; do
      if [ "$(container_state "$c")" != "running" ]; then
        printf '\r\033[K'; diagnose "$c"; return 1
      fi
    done

    # /api/info 里既有 vLLM 后端可达性，也有流水线池进度，一次拿全
    info="$(curl -fsS -m 5 "http://$LOCAL_HOST:$PORT/api/info" 2>/dev/null || true)"
    if grep -q '"reachable": *true' <<<"$info"; then vllm_up=yes; else vllm_up=no; fi
    pool_ready="$(grep -o '"ready": *[0-9]\+' <<<"$info" | head -1 | grep -o '[0-9]\+' || true)"
    pool_ready="${pool_ready:-0}"

    # 就绪 = 引擎实例构造成功(pool>0) 且 VLM 后端真的能服务(vllm_up)。
    # 少了后者，deploy 会在 vLLM 还在加载权重时就宣布成功，一上传就失败。
    if [ "$pool_ready" -gt 0 ] && { [ "$vllm_up" = yes ] || ! uses_vllm_backend; }; then
      printf '\r\033[K'; ok "服务就绪（用时 ${elapsed}s）"; return 0
    fi

    # 跟随「当前还没好的那个」的日志，别再一直盯着已经空闲的 vLLM
    # 只要 API 容器已经开始打 [pool] 日志，就跟随它 —— 那是真正决定就绪的一环。
    # 否则才盯 vLLM。避免 vllm 探活假阴性时，永远看不到 API 侧的真实报错。
    if [ "$pool_ready" -gt 0 ] && [ "$vllm_up" = no ]; then
      # API 侧已经好了，只差后端 —— 明确说清楚，别让人以为整个卡住了
      watch="$C_VLLM"; stage="① API 已就绪，等 vLLM 加载权重/编译"
    elif docker logs "$C_API" 2>&1 | grep -q "^.pool."; then
      watch="$C_API"; stage="② 构建流水线"
    elif [ "$vllm_up" = no ]; then
      watch="$C_VLLM"; stage="① vLLM 启动中"
    else
      watch="$C_API"; stage="② 构建流水线"
    fi
    line="$(last_log_line "$watch")"
    if [ "$line" = "$prev" ]; then stuck=$((stuck + 3)); else stuck=0; prev="$line"; fi

    spin=$(( (spin + 1) % 4 ))
    printf '\r\033[K  %s %4ds  vllm=%s pool=%s/%s  %s  %s' \
      "${frames[$spin]}" "$elapsed" "$vllm_up" "$pool_ready" "$WORKERS" "$stage" \
      "${line:0:60}"

    if [ "$stuck" -ge 180 ]; then
      printf '\r\033[K'
      warn "$watch 日志已 ${stuck}s 没有新输出（vllm=$vllm_up pool=$pool_ready/$WORKERS）"
      dim "      最后一行：${line:-（无）}"
      if [ "$vllm_up" = yes ]; then
        dim "      vLLM 已就绪并在空闲等待，它不再输出日志是正常的。"
        dim "      现在卡的是 API 侧：正在下载版面分析模型或构建流水线。"
        dim "      看它在干嘛：bash scripts/manage.sh logs api"
      else
        dim "      加载权重/捕获 CUDA graph 阶段本来就会静默数分钟，可以再等等"
        dim "      若确认是卡在下载：manage.sh netcheck 查网络，或换 MODEL_SOURCE"
      fi
      stuck=0
    fi
    sleep 3
  done
}

print_endpoints() {
  local ip="$BIND"
  case "$BIND" in
    0.0.0.0)
      ip="$(hostname -I 2>/dev/null | awk '{print $1}' || true)"
      ip="${ip:-<服务器IP>}"
      ;;
    127.*|localhost) dim '  仅本机访问；其他机器访问需设置 BIND=0.0.0.0 后重新 deploy';;
  esac
  echo
  printf '  %s界面%s   http://%s:%s/\n'             "$c_grn" "$c_off" "$ip" "$PORT"
  printf '  %sAPI %s   POST http://%s:%s/api/ocr\n' "$c_grn" "$c_off" "$ip" "$PORT"
  printf '  %s信息%s   http://%s:%s/api/info\n'     "$c_grn" "$c_off" "$ip" "$PORT"
  echo
  dim "  curl -F 'file=@a.png' http://$ip:$PORT/api/ocr"
  echo
}

# ---------------------------------------------------------------- 命令
# deploy 可重复执行：准备成功后，只替换归属已核验的本服务容器。
# 反复跑、改了配置再跑、上次跑挂了再跑，都用这一条。
cmd_deploy() {
  cmd_preflight
  cmd_pull
  cmd_build
  ensure_net
  local dev="cpu"
  if uses_vllm; then
    dev="$(resolve_device)"
  fi
  # Recheck after slow pulls/builds. Failures before here leave the old service running.
  python3 "$ROOT/../scripts/gpu-check.py" mx-ocr >/dev/null
  python3 "$ROOT/../scripts/retire-container.py" mx-ocr "$C_API"
  python3 "$ROOT/../scripts/retire-container.py" mx-ocr "$C_VLLM"
  if uses_vllm; then start_vllm; fi
  start_api "$dev"

  if wait_ready; then
    echo; cmd_status; print_endpoints
  else
    return 1
  fi
}

# 强制重来：额外丢掉探测缓存和自建镜像，但保留官方镜像与模型权重
cmd_reset() {
  say "重置：清掉容器和自建镜像，强制重建"
  docker rm -f "$C_API" "$C_VLLM" >/dev/null 2>&1 || true
  docker image rm "$API_IMAGE" >/dev/null 2>&1 || true
  ok "已重置（官方镜像、模型权重、GPU 探测结果都保留）"
  if [ -s "$STATE/paddle_gpu" ]; then
    dim "  沿用已探测的版面分析设备：$(cat "$STATE/paddle_gpu")"
    dim "  要重新探测：manage.sh gpucheck"
  fi
  echo
  cmd_deploy
}

cmd_down()  { say "停止"; docker rm -f "$C_API" "$C_VLLM" >/dev/null 2>&1 || true; ok "已停止（镜像与模型缓存保留）"; }
cmd_up()    { cmd_deploy; }

cmd_status() {
  printf '  %-22s %s\n' "项目"  "$PROJECT"
  if uses_vllm; then
    printf '  %-22s %s\n' "模型"  "$MODEL"
    printf '  %-22s %s\n' "GPU"   "$GPU_ID"
  fi
  printf '  %-22s %s\n' "端口"  "$BIND:$PORT"
  [ -s "$STATE/paddle_gpu" ] && printf '  %-22s %s\n' "版面分析设备" "$(cat "$STATE/paddle_gpu")"
  local _cs="$C_API"; uses_vllm && _cs="$C_VLLM $C_API"
  for c in $_cs; do
    local s; s="$(container_state "$c")"
    if [ "$s" = "running" ]; then printf '  %-22s %s%s%s\n' "$c" "$c_grn" "$s" "$c_off"
    else printf '  %-22s %s%s (exit=%s)%s\n' "$c" "$c_ylw" "$s" "$(container_exit_code "$c")" "$c_off"; fi
  done
  if http_ok "http://$LOCAL_HOST:$PORT/healthz"; then
    curl -fsS -m 5 "http://$LOCAL_HOST:$PORT/healthz" | sed 's/^/  /'; echo
  fi
}

cmd_logs() {
  case "${1:-api}" in
    vllm) docker logs -f --tail 200 "$C_VLLM" ;;
    api)  docker logs -f --tail 200 "$C_API" ;;
    *)    die "logs 参数只能是 api 或 vllm" ;;
  esac
}

# 模拟浏览器的 multipart 请求。
#
# curl 生成的 boundary 是纯小写十六进制，而浏览器发的是含大写的
# `----WebKitFormBoundaryXxYy`。服务端一度把整条 Content-Type 转成小写再解析，
# boundary 大小写被抹掉 -> 找不到起始分段 -> 界面上传一律报「multipart 格式不正确」，
# 而 curl 全绿。所以这条检查必须自己拼 body，不能用 -F。
check_browser_multipart() {
  local img="$1" bnd='----WebKitFormBoundaryKnockOcrAbC123'
  local tmp="$STATE/browser_multipart.bin"
  {
    printf -- '--%s\r\n' "$bnd"
    printf -- 'Content-Disposition: form-data; name="file"; filename="%s"\r\n' "$(basename "$img")"
    printf -- 'Content-Type: application/octet-stream\r\n\r\n'
    cat "$img"
    printf -- '\r\n--%s--\r\n' "$bnd"
  } > "$tmp"
  local out rc=0
  out="$(curl -sS -m 300 -o /dev/null -w '%{http_code}' \
        -H "Content-Type: multipart/form-data; boundary=$bnd" \
        --data-binary "@$(hostpath "$tmp")" \
        "http://$LOCAL_HOST:$PORT/api/ocr?include_json=false" 2>&1)" || rc=$?
  rm -f "$tmp"
  if [ "$rc" -eq 0 ] && [ "$out" = "200" ]; then
    ok "浏览器式 multipart（boundary 含大写）通过"
  else
    warn "浏览器式 multipart 失败（HTTP $out）—— 界面上传会报错，但 curl 察觉不到"
    dim "      boundary 大小写敏感，服务端解析前不能把 Content-Type 转小写。"
  fi
}

cmd_test() {
  local f="${1:-}"
  if [ -n "$f" ]; then
    [ -f "$f" ] || die "文件不存在：$f"
  else
    say "未指定文件，生成一张测试图"
    f="$STATE/sample.png"
    gen_sample "$f" || die "生成测试图失败；也可以自己指定：manage.sh test <文件路径>"
    ok "已生成 $f"
  fi
  say "识别 $f"
  local t0 t1; t0="$(date +%s%3N)"
  curl -fsS -m 300 -F "file=@$(hostpath "$f")" "http://$LOCAL_HOST:$PORT/api/ocr" -o "$(hostpath "$STATE")/result.json" \
    || die "请求失败，先看 bash scripts/manage.sh logs api"
  t1="$(date +%s%3N)"
  ok "完成，耗时 $((t1 - t0)) ms"
  check_browser_multipart "$f"
  python3 - "$STATE/result.json" <<'PY' 2>/dev/null || cat "$STATE/result.json"
import json,sys
d=json.load(open(sys.argv[1],encoding="utf-8"))
print("\n--- markdown ---")
print((d.get("markdown") or "")[:2000])
print("\n--- meta ---")
print(json.dumps({k:v for k,v in d.items() if k not in ("markdown","result")},ensure_ascii=False,indent=2))
PY
}

# 同一张图两个引擎各跑一遍，并排对比 —— 回答「这类图该用哪个引擎」
cmd_compare() {
  local f="${1:-}"
  mkdir -p "$STATE"
  if [ -z "$f" ]; then
    say "未指定文件，生成一张测试图"
    f="$STATE/sample.png"
    gen_sample "$f" || die "生成失败；也可以自己指定：manage.sh compare <图片>"
  fi
  [ -f "$f" ] || die "文件不存在：$f"

  local hp; hp="$(hostpath "$f")"
  for e in fast quality; do
    rule
    say "engine=$e"
    curl -fsS -m 600 -F "file=@$hp"       "http://$LOCAL_HOST:$PORT/api/ocr?engine=$e&include_json=false"       -o "$(hostpath "$STATE")/cmp_$e.json" 2>/dev/null       || { warn "该引擎不可用或失败（本次部署 TIER=$TIER）"; continue; }
    python3 - "$STATE/cmp_$e.json" <<'PY2'
import json, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
t = d.get("timings", {})
print("  耗时   总 %sms  (接收 %s / 排队 %s / 推理 %s)  cached=%s"
      % (d.get("elapsed_ms"), t.get("receive_ms"), t.get("queue_ms"),
         t.get("infer_ms"), d.get("cached")))
md = d.get("markdown") or ""
print("  字符   %d" % len(md))
print("  预览:")
for line in md.splitlines()[:12]:
    print("    " + line[:100])
PY2
  done
  rule
  dim "  完整结果：$STATE/cmp_fast.json  $STATE/cmp_quality.json"
  dim "  看清差别的重点：金额里的逗号、表格结构、竖排/印章、多栏顺序"
}

# 服务器上 python3 可能是很老的版本（比如 conda base 里的 3.6），
# 而 bench.py 用到 f-string 等 3.6+ 语法。优先挑一个够新的解释器。
pick_python() {
  local c
  for c in python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
    have "$c" || continue
    "$c" -c 'import sys; sys.exit(0 if sys.version_info >= (3,6) else 1)' 2>/dev/null && {
      echo "$c"; return 0; }
  done
  return 1
}

cmd_bench() {
  local py; py="$(pick_python)" || die "找不到 Python 3.6+（bench 只用标准库）"
  PYTHONIOENCODING=utf-8 "$py" scripts/bench.py --url "http://$LOCAL_HOST:$PORT/api/ocr" "$@"
}

cmd_disk() {
  say "镜像（拉过就不再拉，除非手动删）"
  docker images --format '  {{.Size}}\t{{.Repository}}:{{.Tag}}' | grep -E "paddleocr|$PROJECT" || dim "  （还没拉）"
  say "模型缓存卷（down/reset 都不会删）"
  for v in "$V_MODELS" "$V_CACHE" "$V_NVCACHE"; do
    if docker volume inspect "$v" >/dev/null 2>&1; then
      local mp sz; mp="$(docker volume inspect -f '{{.Mountpoint}}' "$v")"
      sz="$(du -sh "$mp" 2>/dev/null | cut -f1)"
      printf '  %-8s %s\n' "${sz:-?}" "$v"
    else
      printf '  %-8s %s\n' "-" "$v （未创建）"
    fi
  done
  say "docker 根目录"
  df -h /var/lib/docker 2>/dev/null | sed 's/^/  /'
  echo
  dim "  彻底删干净（下次要重下）："
  dim "    docker volume rm $V_MODELS $V_CACHE $V_NVCACHE"
  dim "    docker image rm $VLLM_IMAGE $BASE_IMAGE"
  dim "  ⚠ 不要用 docker system prune -a，会把上面全清掉"
}

# 在「容器里」测网络 —— 宿主机能通不代表容器能通，这才是决定性的检查
cmd_netcheck() {
  local probe='
import os, socket, ssl, urllib.request, urllib.error
ssl._create_default_https_context = ssl._create_unverified_context
HOSTS = [
    ("bos        ", "https://paddle-model-ecology.bj.bcebos.com"),
    ("modelscope ", "https://modelscope.cn"),
    ("aistudio   ", "https://aistudio.baidu.com"),
    ("huggingface", "https://huggingface.co"),
]
px = os.environ.get("https_proxy") or os.environ.get("HTTPS_PROXY") or ""
print("proxy env :", px or "(未设置，走直连)")
if px:
    try:
        hp = px.split("//", 1)[1].rstrip("/")
        h, _, p = hp.rpartition(":")
        s = socket.create_connection((h, int(p)), timeout=5); s.close()
        print("proxy tcp : 可达", hp)
    except Exception as e:
        print("proxy tcp : 不可达 ->", e)
for name, url in HOSTS:
    try:
        urllib.request.urlopen(url, timeout=8)
        print(name, ": 通")
    except urllib.error.HTTPError as e:
        # 能收到 HTTP 状态码就说明链路是通的。对象存储桶根路径返回 403 属正常。
        print(name, ": 通  (HTTP %d，服务端拒绝列目录，不影响下载模型)" % e.code)
    except Exception as e:
        print(name, ": 不通 ->", str(e)[:70])
'
  local px=(); mapfile -t px < <(proxy_run_args)

  rule
  say "0  docker 默认往容器里塞了什么代理变量"
  local inh; inh="$(inherited_proxy "$VLLM_IMAGE")"
  if [ -n "$inh" ]; then
    sed 's/^/    /' <<<"$inh"
    if grep -qE '127\.0\.0\.1|localhost' <<<"$inh"; then
      warn "指向 127.0.0.1 —— 容器里那是容器自己，必然连不上（本脚本已覆盖它）"
    fi
  else
    dim "    （无）"
  fi

  echo
  say "A  桥接网络（默认部署方式，代理按当前 PROXY 设置）"
  docker run --rm --network "$NET" "${px[@]}" "$VLLM_IMAGE" python -c "$probe" 2>&1 | sed 's/^/    /'

  echo
  say "B  宿主机网络（HOST_NET=1 时的部署方式）"
  local hpx=(-e "http_proxy=" -e "https_proxy=" -e "HTTP_PROXY=" -e "HTTPS_PROXY=")
  [ -n "$PROXY" ] && hpx=(-e "http_proxy=$PROXY" -e "https_proxy=$PROXY" \
                          -e "HTTP_PROXY=$PROXY" -e "HTTPS_PROXY=$PROXY")
  docker run --rm --network host "${hpx[@]}" "$VLLM_IMAGE" python -c "$probe" 2>&1 | sed 's/^/    /'
  rule

  say "怎么读这个结果"
  dim "  「通」包括返回 403/404 —— 收到 HTTP 状态码就说明链路没问题"
  dim "  huggingface 在境内基本必然不通，不影响，我们不用它"
  echo
  dim "  A 里有任意一个源「通」      → 直接 deploy，不用代理"
  dim "  A 全不通但 B 通             → 代理只监听 127.0.0.1，加 HOST_NET=1"
  dim "  A/B 都不通但 proxy tcp 可达 → 代理本身出不去，找网络同事"
  dim "  当前默认源：MODEL_SOURCE=$MODEL_SOURCE"
  dim "  可选 bos|modelscope|aistudio|huggingface，前三个都在国内"
}

# 一次抓全所有诊断信息，不用来回问
cmd_doctor() {
  rule
  say "1  容器状态"
  local _cs="$C_API"; uses_vllm && _cs="$C_VLLM $C_API"
  for c in $_cs; do
    printf '    %-20s %s (exit=%s)\n' "$c" "$(container_state "$c")" "$(container_exit_code "$c")"
  done

  echo; say "2  API 侧流水线构建日志（[pool] 开头的行）"
  docker logs "$C_API" 2>&1 | grep -E '^\[pool\]|Traceback|Error|error' | tail -40 \
    | sed 's/^/    /' || true
  docker logs "$C_API" 2>&1 | grep -q '^\[pool\]' || \
    warn "    没有任何 [pool] 日志 —— 说明跑的是旧镜像，先 bash scripts/manage.sh reset"

  echo; say "3  API 容器能否连到 vLLM"
  docker exec "$C_API" python -c "
import os, urllib.request
u = os.environ.get('OCR_VLLM_URL', '?').rstrip('/')
u = u if u.endswith('/v1') else u + '/v1'
print('OCR_VLLM_URL =', os.environ.get('OCR_VLLM_URL'))
print('probe        =', u + '/models')
for k in ('http_proxy','https_proxy','no_proxy'):
    print('%-13s=' % k, repr(os.environ.get(k)))
try:
    r = urllib.request.urlopen(u + '/models', timeout=5)
    print('RESULT: 通  HTTP', r.status, r.read().decode()[:200])
except Exception as e:
    print('RESULT: 不通 ->', type(e).__name__, str(e)[:200])
" 2>&1 | sed 's/^/    /' || warn "    exec 失败，容器可能没在跑"

  echo; say "4  vLLM 最后 15 行"
  docker logs "$C_VLLM" 2>&1 | tail -15 | sed 's/^/    /' || true

  echo; say "5  /api/info"
  curl -fsS -m 5 "http://$LOCAL_HOST:$PORT/api/info" 2>/dev/null | sed 's/^/    /' || \
    warn "    取不到，API 没起来？"
  echo; rule
  dim "  把以上完整输出贴出来即可定位问题"
}

# 绕开本项目的 API 层，用官方 CLI 跑一次完整识别。
# 注意流水线要跑在 paddleocr-vl 镜像里（含 paddlex[ocr] 依赖），
# genai-vllm-server 镜像只负责 VLM 推理服务，不含解析流水线。
cmd_selftest() {
  [ "$(container_state "$C_VLLM")" = "running" ] || die "$C_VLLM 没在跑，先 deploy"

  rule
  say "0  检查 API 镜像里的解析流水线依赖"
  local dep_out dep_rc=0
  dep_out="$(docker run --rm --entrypoint python "$API_IMAGE" -c "
from paddlex.utils.deps import require_extra
require_extra('ocr')
print('paddlex[ocr] 依赖齐全')
" 2>&1)" || dep_rc=$?
  if [ $dep_rc -eq 0 ]; then
    ok "$dep_out"
  else
    warn "API 镜像缺少解析流水线依赖 —— 这就是 pool=0/4 的原因"
    sed 's/^/      /' <<<"$dep_out" | tail -6
    dim "      Dockerfile 已内置按需安装，重建镜像即可：bash scripts/manage.sh reset"
    dim "      若安装步骤本身失败，看构建输出（多半是 pip 出不去网）"
    rule
    return 1
  fi

  local f="${1:-}"
  mkdir -p "$STATE"
  if [ -z "$f" ]; then
    say "生成测试图"
    f="$STATE/sample.png"
    gen_sample "$f" || die "生成测试图失败；也可以自己指定：manage.sh selftest <图片路径>"
    ok "已生成 $f"
  fi
  [ -f "$f" ] || die "文件不存在：$f"

  echo; say "1  用官方 CLI 直接识别（临时容器，不经过本项目 API 层）"
  dim "  镜像 $API_IMAGE，网络 $NET，后端 http://$C_VLLM:$VLLM_PORT/v1"
  echo
  local px=(); mapfile -t px < <(proxy_run_args)
  local home; home="$(container_home "$API_IMAGE")"; home="${home:-/root}"
  docker run --rm --network "$NET" "${px[@]}"     -e PADDLE_PDX_MODEL_SOURCE="$MODEL_SOURCE"     -e PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True     -v "$V_MODELS":"$home/.paddlex"     -v "$V_CACHE":"$home/.cache"     -v "$(cd "$(dirname "$f")" && pwd)":/in:ro     "$API_IMAGE" bash -lc "
      paddleocr doc_parser --input /in/$(basename "$f") --save_path /tmp/out         --vl_rec_backend vllm-server         --vl_rec_server_url http://$C_VLLM:$VLLM_PORT/v1         --device cpu 2>&1 | tail -40
      echo '--- 产出 ---'
      find /tmp/out -type f 2>/dev/null | head -20
      echo '--- markdown 前 1500 字 ---'
      find /tmp/out -name '*.md' -exec head -c 1500 {} \; 2>/dev/null
    " || true
  rule
  say "怎么判断"
  dim "  出现识别文本 → 模型在这台机器上完全可用，剩下是本项目 API 层的问题"
  dim "  这里就报错   → 把报错贴出来"
}

cmd_server_help() {
  say "genai_server 真实可用参数（用于 MODEL / VLLM_ARGS）"
  docker run --rm "$VLLM_IMAGE" paddleocr genai_server --help
}

cmd_clean() {
  say "清理本 demo 的容器/网络/自建镜像"
  docker rm -f "$C_API" "$C_VLLM" >/dev/null 2>&1 || true
  docker network rm "$NET" >/dev/null 2>&1 || true
  docker image rm "$API_IMAGE" >/dev/null 2>&1 || true
  rm -rf "$STATE"
  ok "已清理"
  dim "  模型缓存卷保留（重装免下载）：docker volume rm $V_MODELS $V_CACHE $V_NVCACHE"
  dim "  官方基础镜像保留：docker image rm $VLLM_IMAGE $BASE_IMAGE"
}

cmd_help() {
  cat <<EOF
knock-ocr demo

  bash scripts/manage.sh <命令>

命令
  deploy        一条命令搞定部署。幂等 —— 反复跑、改配置再跑、上次挂了再跑都用它
  reset         强制重来（丢探测缓存 + 重建 API 镜像），官方镜像和模型权重保留
  down          停止
  status        当前状态
  gpucheck      单独跑 GPU 探测：先查 vLLM(PyTorch) 再查 Paddle，各自给结论
  logs [api|vllm]
  test [文件]   端到端识别一次（不传文件则自动造一张）
  compare [文件] 同一张图两个引擎各跑一遍，并排对比质量与耗时
  bench         并发压测。默认每请求一张新图（不会被缓存蒙蔽）
                  --mode cached  同一张图，测缓存路径能扛多少
                  --mode nocache 服务端跳过缓存，测纯推理
  doctor        一次抓全所有诊断信息（卡住/报错时先跑这个）
  selftest      绕开本项目 API，用官方 CLI 在 vLLM 容器内直接识别一次
  netcheck      在容器里测能不能连上模型源（连不上模型时先跑这个）
  stats         实际占用 vs 配额上限（CPU/内存/GPU）
  disk          镜像与模型缓存占了多少盘
  server-help   查看 genai_server 支持哪些参数（模型名对不对看这个）
  clean         删掉容器/网络/自建镜像（模型权重保留）

可覆盖的环境变量（写在命令前面）
  GPU_ID=$GPU_ID          只占用这一张卡
  PORT=$PORT           对外端口；被别的服务占用会自动顺延，STRICT_PORT=1 可禁止
  BIND=$BIND        只本机访问传 127.0.0.1
  PROXY=                出网代理，如 http://127.0.0.1:7788（下模型权重用）
  HOST_NET=0            =1 让 vLLM 走宿主机网络；代理只监听 127.0.0.1 时必须开
  TIER=fast-gpu         部署档 fast|fast-gpu|quality|full
                        fast     PP-OCRv6(ONNX) 走 CPU，镜像 <1GB，不要 GPU
                        fast-gpu 同一套模型走 CUDA EP，实测 2.82×（680->241ms）
                                 镜像 ~4GB，要一张卡但不起 vLLM。默认档
                        quality  只装 PaddleOCR-VL + vLLM
                        full     fast(CPU) + quality，调用时 ?engine= 自选
  DEFAULT_ENGINE=       full 档下不带 engine 参数时走哪个（默认 fast）
  CPU_LIMIT=<核数/4>    CPU 时间片配额。空闲不占，超限只限速，不会挤到别人。0=不限
  MEM_LIMIT=16g|48g     内存硬上限。超限直接 OOM Kill，按峰值+余量给，别抠
  CPUSET=               物理绑核，如 0-31。比配额更硬，NUMA 机器还有访存局部性收益
  ORT_INTRA=<=OMP_THREADS>  fast 引擎单次推理的 ONNX 线程数。
                        默认 0 会用「容器看到的全部核」，在有 CPU 配额时会
                        严重超配（128 线程抢 32 核），必须对齐到配额
  FAST_CUDA=<按档位>    fast-gpu 档默认 1，其余档默认 0，一般不用手传。
                        传 0 可在 fast-gpu 档强行退回 CPU 做对比。
                        是否真的生效看 /api/info 里的 providers，别看 device_requested
                        —— ONNX Runtime 回落 CPU 时不报错，只是慢
  GPU_MEM_UTIL=0.35     vLLM 占该卡显存的比例，其余留给别人
  UVICORN_WORKERS=      API 进程数，默认按 CPU 配额推算
  CACHE_SIZE=512        sha256 内容寻址缓存条数；0=关闭
  FAST=0                =1 开快速模式：并发 16 + 限像素 + 限 token
  VL_CONCURRENCY=8      版面切块并发请求 VLM 的数量（官方默认串行，首要瓶颈）
  MAX_PIXELS=           送进 VLM 的像素上限，如 1600000
  MODEL_SOURCE=modelscope  模型源 modelscope|aistudio|bos（境内直连）|huggingface（需境外代理）
  WORKERS=$WORKERS            API 并行流水线数
  DEVICE=$DEVICE         auto|cpu|gpu:0，版面分析设备
  MODEL=$MODEL
  VLLM_ARGS=            透传给 genai_server
  PROJECT=$PROJECT     换名字可并存多套

例
  PROXY=http://127.0.0.1:7788 bash scripts/manage.sh deploy
  GPU_ID=1 PORT=9000 bash scripts/manage.sh deploy
EOF
}

case "${1:-deploy}" in
  deploy)  shift; cmd_deploy "$@" ;;
  redeploy) shift; cmd_deploy "$@" ;;
  reset)   shift; cmd_reset "$@" ;;
  up)      shift; cmd_up "$@" ;;
  down)    shift; cmd_down "$@" ;;
  restart) shift; cmd_deploy "$@" ;;
  status)  shift; cmd_status "$@" ;;
  gpucheck) shift; cmd_gpucheck "$@" ;;
  logs)    shift; cmd_logs "$@" ;;
  test)    shift; cmd_test "$@" ;;
  compare) shift; cmd_compare "$@" ;;
  bench)   shift; cmd_bench "$@" ;;
  stats)   shift; cmd_stats "$@" ;;
  disk)    shift; cmd_disk "$@" ;;
  pull)    shift; cmd_pull "$@" ;;
  build)   shift; cmd_build "$@" ;;
  preflight) shift; cmd_preflight "$@" ;;
  doctor)  shift; cmd_doctor "$@" ;;
  selftest) shift; cmd_selftest "$@" ;;
  netcheck) shift; cmd_netcheck "$@" ;;
  server-help) shift; cmd_server_help "$@" ;;
  clean)   shift; cmd_clean "$@" ;;
  help|-h|--help) cmd_help ;;
  *) die "未知命令：$1（bash scripts/manage.sh help）" ;;
esac
