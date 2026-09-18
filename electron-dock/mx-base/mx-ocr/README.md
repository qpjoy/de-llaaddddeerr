# mx-ocr

将 `qpjoy/knock-ocr` 作为 mx-base 的独立 OCR 能力引入，保留 Web 调试界面、HTTP API、快速 GPU OCR、文档精修模式、测试及压测工具。它不参与 MX-H2I 登录或网络就绪判断。

## 部署和开关

在目标 GPU 服务器的 `electron-dock/mx-base` 目录执行：

```bash
cp .env.gpu.example .env.gpu            # 首次执行；已有配置不要覆盖
cp mx-ocr/.env.example mx-ocr/.env
bash scripts/manage.sh doctor mx-ocr
bash scripts/manage.sh deploy mx-ocr
bash scripts/manage.sh test mx-ocr
bash scripts/manage.sh logs mx-ocr
bash scripts/manage.sh stats mx-ocr
bash scripts/manage.sh stop mx-ocr
bash scripts/manage.sh start mx-ocr
```

默认 GPU 2，显示器预留 GPU 3，Embedding 用 GPU 1。两应用都读取 `mx-base/.env.gpu`，部署前校验 UUID、显示输出和其他进程/容器占用。不要直接执行 `scripts/upstream-manage.sh`；它是保留的内部实现，统一入口才包含启动保护。GPU 主机需要 Linux、Bash 4+、Python 3、flock、Docker、NVIDIA Container Toolkit。

`deploy` 先要求输入 `yes`，再准备镜像；成功后重新核验 GPU 归属，给旧容器最多 40 秒停止，再按当前配置重建本应用容器。重复执行更新同一套容器，构建失败不停止旧服务；替换期间会中断，启动失败不提供自动回滚。`start` 恢复已部署容器，不下载模型；`restart` 重启并等待健康。改变 .env（包括显卡）后用 `deploy`，不是 `start`。`stop` 保留容器、镜像、命名模型缓存卷，释放该服务运行中的 CPU/内存/显存；不会停止原 `knock-ocr-*` 或其他应用。若原服务仍占 GPU 2，会拒绝启动，需操作者选择迁移窗口或其他空闲卡。

**上游异步 OCR 队列、识别结果缓存是进程内状态，不是持久任务队列。** 停止前让调用方停止提交并收集结果；重启可能丢失未完成任务，客户端需要按业务任务恢复。不得把“模型缓存保留”理解为“识别任务不丢”。当前多进程模式的异步任务轮询也不是跨进程共享存储，生产调用优先同步接口，持久异步调度交给上层。

## 模式和资源

| 档位 `TIER` | 能力 | 默认用途 |
| --- | --- | --- |
| `fast-gpu` | RapidOCR / PP-OCRv6 ONNX CUDA | 图片文字提取，默认 |
| `fast` | 同一快速引擎，CPU | 对照调试；本包装入口仍校验统一 GPU 规划 |
| `quality` | PaddleOCR-VL + vLLM | 文档版面、表格、PDF 精修 |
| `full` | CPU fast + GPU quality | 显式选择引擎 |

默认 16 核 / 16 GiB 主存、2 API 进程 × 2 流水线 × 4 ONNX 线程；与上游 64 核压测不同，额定吞吐设为未测。quality/full 首次模型加载可能需要提高 `MEM_LIMIT`（上游默认为 48g）；在独立 GPU 上先压测再扩大资源。模型 CUDA 内核兼容性由上游真实预热检查，不能用“CUDA EP 出现在列表”代替端到端验证。

GPU 服务不是显存硬隔离：独立卡分配和拒绝其他进程是启动时保护，Docker CPU/主存限额并不限制任意第三方 GPU 程序。不得绕过管理入口共享同一卡。

## 接口和访问

默认绑定 `0.0.0.0:8710`，其他机器通过 `http://<服务器IP>:8710` 访问，Web UI 与 API 共用端口：

- `POST /api/ocr`：上传文件；`?engine=fast|quality` 显式选引擎。
- `GET /healthz`、`GET /api/info`、`GET /api/metrics`：就绪、配置与运行指标。
- `GET /api/docs`：完整接口说明。

保留上游行为，**本服务没有新增租户鉴权层，并有在线调参接口**。默认监听全部 IPv4 接口用于内网跨机器访问；通过已有网络访问控制或反向代理鉴权限制调用，不直接暴露公网。URL 抓取功能可配置 `FETCH_ALLOW_HOSTS` 白名单。只需本机使用时可设置 `BIND=127.0.0.1`。

已有 `.env` 若仍有 `BIND=127.0.0.1`，将其改为 `BIND=0.0.0.0` 后重新执行 `deploy mx-ocr`；仅 restart 不会修改 Docker 发布地址。也可临时使用 `BIND=0.0.0.0 bash scripts/manage.sh deploy mx-ocr`（在 mx-base 目录），命令行 BIND 优先于 .env；永久配置仍应更新 .env。部署输出按实际绑定显示访问地址，回环监听不会再显示局域网地址。

`PROXY` 仅影响本应用容器下载；不改宿主机代理、DNS、路由或 MX-H2I。模型源默认 ModelScope，历史文档中的 BOS 默认值以当前脚本为准。

来源与改动：[UPSTREAM.md](UPSTREAM.md)。上游历史说明保留在 `docs/`，其中的部署规划、评分和吞吐不是本次线上验收结果。
