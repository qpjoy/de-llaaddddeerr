# P0 Demo 说明

目标：**在这台 4×5090 服务器上把 PaddleOCR-VL-1.6 全量跑起来**，验证「OmniDocBench v1.6 96.3%」这套东西在本机确实可用，并留出向高并发演进的接口形状。

---

## 一、跑起来

```bash
bash scripts/manage.sh deploy
```

`deploy` 依次做完：环境检查 → 拉官方镜像 → 构建 API 镜像 → 探测 Paddle GPU 可用性 → 启动两个容器 → 等就绪 → 打印地址。

首次执行需要拉约 20~30GB 镜像并下载模型权重，慢，属正常。想看进度：

```bash
bash scripts/manage.sh logs vllm
```

---

## 二、架构

```
                 ┌──────────────────────────────────────┐
  浏览器 / curl  │  knock-ocr-api        (容器, 无 GPU)  │
  ──────────────►│  FastAPI + Web UI                    │
      :8710      │  PaddleOCRVL 流水线池 × WORKERS       │
                 │    └ 版面分析 PP-DocLayoutV2 → CPU    │
                 └──────────────┬───────────────────────┘
                                │ HTTP，仅走容器内网
                                ▼
                 ┌──────────────────────────────────────┐
                 │  knock-ocr-vllm       (容器, GPU 2)   │
                 │  paddleocr genai_server --backend vllm│
                 │  PaddleOCR-VL-1.6-0.9B (0.9B VLM)     │
                 └──────────────────────────────────────┘
```

**为什么拆成两个容器**：VLM 主体（吃算力的部分）跑在 vLLM 上独占 GPU，前面的版面分析和编排是无状态的普通服务。这条边界就是后面横向扩容的切分线 —— 加卡时只需要多起几个 vLLM 容器，API 侧改成轮询即可。

---

## 三、怎么做到不影响服务器上其他服务

| 手段 | 具体 |
|---|---|
| **全容器化** | 不在宿主机装任何 Python 包、CUDA 组件或系统服务；宿主机只需要已有的 docker + nvidia-container-toolkit |
| **单卡绑定** | `--gpus "device=$GPU_ID"`，容器只看得见这一张卡。**默认 GPU 2**，刻意避开挂着显示器的 GPU 3（Xorg/gnome/firefox 在那上面），不会把桌面挤掉 |
| **占用前告警** | preflight 会检查目标卡上有没有别的计算进程，有就明确列出来让你换卡 |
| **独立网络** | 专属 bridge 网络 `knock-ocr-net`；vLLM 端口**只在容器网内**，不发布到宿主机 |
| **端口可控** | 只发布一个端口（默认 8710），deploy 前先检查是否被占；`BIND=127.0.0.1` 可改成仅本机可访问 |
| **命名隔离** | 容器/网络/卷全部带 `knock-ocr-` 前缀，`clean` 能精确删干净，不碰别人的东西 |
| **可并存** | 改 `PROJECT=` 就能在同一台机器上起第二套互不干扰 |

---

## 四、关于 Blackwell（sm_120）

这台机器是 RTX 5090，Blackwell 架构 sm_120。已知 **PaddlePaddle 官方 GPU wheel 长期不含 sm_120 kernel**。

deploy 时会实测一次：

```
==> 探测 PaddlePaddle 能否用上这张卡（Blackwell sm_120 已知问题）
```

- **能用** → 版面分析走 `gpu:0`
- **不能用** → 自动降级到 `cpu`，并把完整报错留在 `.deploy/paddle_probe.log`

**降级不影响识别精度。** 真正决定 96.3% 那个分数的是 0.9B VLM，它跑在 vLLM（PyTorch cu128，sm_120 支持完好）上；CPU 只承担轻量的版面检测，本机 128 核绰绰有余。

想手动指定：`DEVICE=cpu bash scripts/manage.sh deploy`（或 `DEVICE=gpu:0`）。

探测结果缓存在 `.deploy/paddle_gpu`，删掉可重新探测 —— 以后 Paddle 官方补上 sm_120 时，删掉这个文件重新 deploy 就会自动切回 GPU。

vLLM 容器已设 `VLLM_FLASH_ATTN_VERSION=2`，因为 FlashAttention 3 在 Blackwell 上还不工作。

---

## 五、验证

```bash
# 造一张带中文段落 + 表格的样张并识别
bash scripts/manage.sh test

# 用自己的真实文件
bash scripts/manage.sh test /path/to/合同.pdf
```

界面上会分三栏给出：渲染结果、Markdown 源码、结构化 JSON，附服务端耗时与端到端耗时。

**这一步要确认的是「能不能全量跑」，不是「跑得多快」**：表格结构对不对、中文有没有漏字、PDF 多页顺序对不对、公式和印章有没有丢。

---

## 六、并发摸底

```bash
bash scripts/manage.sh bench -c 1  -n 10
bash scripts/manage.sh bench -c 4  -n 40
bash scripts/manage.sh bench -c 8  -n 80
bash scripts/manage.sh bench -c 16 -n 160
```

从并发 1 往上扫，**QPS 不再上涨的那个点就是当前配置的上限**。

- QPS 不涨、P95 陡增 → 先加 `WORKERS`（API 侧流水线数）
- 加了 `WORKERS` 也不涨 → 瓶颈在 vLLM 侧，加卡或调 batch
- 单请求延迟本来就高 → 看是不是版面分析在 CPU 上拖了后腿

这条曲线是后续生产配置（worker 数、batch size、CPU 核分配）的唯一依据，别靠估。

---

## 七、可调项

全部有默认值，改的时候写在命令前面：

| 变量 | 默认 | 说明 |
|---|---|---|
| `GPU_ID` | `2` | 只占用这一张卡 |
| `PORT` | `8710` | 对外 Web + API 端口；被别的服务占用会自动顺延 |
| `STRICT_PORT` | `0` | `=1` 则端口被占直接报错，不顺延 |
| `BIND` | `0.0.0.0` | 传 `127.0.0.1` 则仅本机可访问 |
| `PROXY` | 空 | 出网代理；不设则强制直连（并覆盖 docker 注入的代理变量） |
| `HOST_NET` | `0` | `=1` 让 vLLM 走宿主机网络，代理只监听回环时用 |
| `MODEL_SOURCE` | `bos` | `bos` / `modelscope` / `aistudio` / `huggingface` |
| `WORKERS` | `4` | API 侧并行流水线数 |
| `DEVICE` | `auto` | `auto` / `cpu` / `gpu:0`，版面分析设备 |
| `MODEL` | `PaddleOCR-VL-1.6-0.9B` | |
| `PROJECT` | `knock-ocr` | 改名可并存多套 |
| `VLLM_ARGS` | 空 | 透传给 `genai_server`；先用 `manage.sh server-help` 查真实可用参数 |
| `PROBE_TIMEOUT` | `240` | GPU 探测单项超时 |
| `WAIT_TIMEOUT` | `2400` | 等服务就绪的上限 |

---

## 七点五、代理与网络（本机踩过的坑）

### 现象

vLLM 容器启动几十秒后退出，日志里是：

```
ProxyError: ... HTTPSConnection(host='127.0.0.1', port=7788): Connection refused
RuntimeError: Could not prepare the official model for the 'PaddleOCR-VL-1.6-0.9B' model
```

### 原因

`~/.docker/config.json` 里配了客户端级代理：

```json
"proxies": { "default": {
    "httpProxy":  "http://127.0.0.1:7788",
    "httpsProxy": "http://127.0.0.1:7788",
    "noProxy": "localhost,127.0.0.1,.local"
}}
```

docker CLI 会把它作为环境变量**注入每一个容器**。而容器里的 `127.0.0.1` 指的是容器自己，
不是宿主机 —— 所以任何出网请求都会 `Connection refused`。这同样会让构建期的 `pip install` 失败。

验证：

```bash
docker run --rm <任意镜像> env | grep -i proxy
```

### 处理方式：只在本项目内解决，不动全局

这台机器上其他应用依赖这份全局代理配置，**不要修改它**。
本脚本的做法是在自己两个容器的 `docker run` 上显式覆盖，作用域仅限本项目：

```
docker run ... -e http_proxy= -e https_proxy= -e all_proxy= ...
```

`docker build` 同理，传空的 `--build-arg http_proxy=` 覆盖构建期注入。

两种可选模式，都不触碰全局配置：

| 模式 | 命令 | 说明 |
|---|---|---|
| 直连（默认） | `bash scripts/manage.sh deploy` | 置空代理变量，走 BOS 直连。国内机器首选 |
| 借用全局代理 | `HOST_NET=1 PROXY=http://127.0.0.1:7788 bash scripts/manage.sh deploy` | 容器共享宿主机网络，`127.0.0.1:7788` 此时就是宿主机的代理，无需改其监听地址 |

### 拿不准走哪条就先诊断

```bash
bash scripts/manage.sh netcheck
```

在容器里分别用桥接网络和宿主机网络，测四个模型源与代理的可达性：

| 结果 | 结论 |
|---|---|
| A 段有源 OK | 直接 `deploy`，不用代理 |
| A 全挂、B 有 OK | 代理只监听回环 → 加 `HOST_NET=1` |
| A/B 都挂但 B 的 proxy tcp 可达 | 代理本身出不去，需要网络侧协助 |

### 模型源

`MODEL_SOURCE` 可选 `bos`（默认）/ `modelscope` / `aistudio` / `huggingface`。
国内内网优先 `bos`（百度自家 CDN，通常直连可达）。

另外两个容器都已设 `PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK=True` ——
PaddleX 启动时会先做一轮模型源连通性预检，很慢（实测卡了 20 多分钟）且失败即放弃下载。

---

## 八、排障

| 现象 | 处理 |
|---|---|
| deploy 卡在「等待服务就绪」 | `manage.sh logs vllm` 看模型下载/加载进度，首次很慢是正常的 |
| 界面显示「VLM 后端 离线」 | vLLM 还在加载，或已崩溃：`manage.sh logs vllm` |
| 流水线 `0/4` 且 error 非空 | `manage.sh logs api` 看栈；多半是 Paddle 侧设备问题，试 `DEVICE=cpu` 重新 deploy |
| 端口被占 | `PORT=<其他端口> bash scripts/manage.sh deploy` |
| 想彻底删干净 | `manage.sh clean`，模型缓存卷会保留；连缓存一起删见命令输出提示 |
| 识别结果为空 | 先确认文件类型在支持列表内；再看 `/api/docs` 手动调一次拿完整报错 |

---

## 九、这个 demo 为后面铺了什么

| demo 里的东西 | 生产时长成 |
|---|---|
| 流水线池 + 借还 | 多进程 worker / 多机 worker |
| API 与推理分离在两个容器 | API 网关 + Triton / vLLM 集群 |
| `/api/metrics` 的 P50/P95 | Prometheus + Grafana |
| `bench.py` 的并发扫描 | 容量规划与回归基线 |
| 503 快速失败（`OCR_ACQUIRE_TIMEOUT`） | 队列 + 背压 + 429 |
| `POST /api/ocr` 的请求/响应形状 | 保持不变，后面换引擎不动调用方 |

下一步（P1）是把**图片快通道**（PP-OCRv6 + TensorRT，GPU 0/1/2）接到同一个 API 形状下，按图片类型路由 —— 那才是高并发的主力，本 demo 的 VL 通道到时候专门吃 PDF 和复杂版面。
