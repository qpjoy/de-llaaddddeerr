# mx-base：独立基础设施

2026-09-19：按应用独立部署和管理，新增 GPU OCR 与 Embedding 基础能力。仓库实现不是线上状态证明；本次未操作 GPU 服务器，使用 `status` 查看目标主机实际状态。

| 应用 | 职责 | 部署与状态 |
| --- | --- | --- |
| mx-static | 多媒体持久采集、缓存、文件读取与签名预览 | 独立 Docker Compose，writer + reader，默认 18200 / 18201 |
| mx-ocr | 图片文字提取、文档精修与 Web 调试 | 独立 Docker，默认 GPU 2，0.0.0.0:8710 |
| mx-embedding | Qwen3-Embedding-0.6B 文本向量服务 | 独立 Docker Compose，默认 GPU 1，127.0.0.1:18210 |
| jenkins | 可选的制品构建 | 原 Kubernetes `mx-base` namespace，默认 NodePort 30880，未自动启用 |

mx-common 复用代码；mx-test-framework 调度测试和构建作业；mx-insight-hub 管数据产品、原始响应、租户授权和计费；mx-base 承载可独立运行的基础服务。MX-H2I 登录、网络、DNS 不依赖这些可选服务。停止 OCR/Embedding 不停止 Hub，也不自动修改其配置。

## 统一入口

在目标 Internal 主机、`electron-dock/mx-base` 目录执行：

```sh
bash scripts/manage.sh                  # 展示状态 → 选择应用 → 选择操作
bash scripts/manage.sh status           # 当前主机 / Docker / Kubernetes 上下文及所有登记应用
bash scripts/manage.sh gpu              # 所有 GPU 的计算进程与服务归属
bash scripts/manage.sh gpu 2            # 只检查 GPU 2（也支持完整 UUID）
bash scripts/manage.sh deploy           # 交互选择，非交互必须指定应用
bash scripts/manage.sh deploy mx-static # 生成首次凭据、准备目录、构建、等待健康
bash scripts/manage.sh jobs mx-static   # 项目任务状态计数、writer 内存缓存指标
bash scripts/manage.sh logs mx-static
bash scripts/manage.sh restart mx-static
bash scripts/manage.sh stop mx-static   # 保留文件、队列、凭据
bash scripts/manage.sh start mx-static
bash scripts/manage.sh doctor mx-static
bash scripts/manage.sh deploy mx-ocr
bash scripts/manage.sh deploy mx-embedding
bash scripts/manage.sh stats mx-embedding
bash scripts/manage.sh test mx-embedding
bash scripts/manage.sh stop mx-ocr       # 保留模型缓存；释放该服务运行资源
bash scripts/manage.sh start mx-ocr      # 恢复保存的容器配置，不重新下载
```

Jenkins 使用相同的 `操作 jenkins`；额外支持 `password jenkins`、`agent-cmd jenkins`。不提供全量部署、全停或删除数据命令。Docker 不可用、集群访问失败显示 UNKNOWN；只有查询成功且没有对应资源才显示 NOT DEPLOYED。`status` 只读，不会启用任何应用。Jenkins 停止仅缩容为零。

Docker 应用（mx-static、mx-ocr、mx-embedding）的 `deploy` 执行前均要求输入完整的 `yes`；其他输入或 EOF 取消且不执行部署。重复执行会更新同一服务，不创建另一套实例，也不轮换已有凭据/删除模型缓存。它不是无中断发布：OCR 会先准备镜像，再核验并停止本服务旧容器、重新创建并等待健康；替换后的启动失败不保证自动回滚。构建失败时 OCR 旧服务保持运行。

GPU 校验按容器名称和应用标签识别归属，兼容 `docker top` 多列输出，并通过主机 cgroup 核验新建 Worker。`yes` 不会跳过显示器保护或授权终止其他应用进程；无法证明属于本应用的 PID 仍会拒绝并打印原因。

`gpu` 是只读诊断：显示 GPU 编号/UUID、显示状态、计算进程 PID/显存、进程名以及能核验的容器名、镜像、mx-base/Compose/Kubernetes 服务标签；非 Docker 进程尝试显示 systemd unit。按 cgroup 或 docker top 关联，不凭 Python 进程名称猜服务。无法查询时明确显示归属未确认，不输出命令行参数和环境变量。NVIDIA 计算进程列表不包含全部图形进程，不能据此断言显卡空闲。部署拒绝提示也会带上可查到的占用服务。

## GPU 基础能力

统一显卡分配在 `.env.gpu`（模板 `.env.gpu.example`），默认显示器 GPU 3、OCR GPU 2、Embedding GPU 1。启动前检查显示输出、GPU UUID 冲突、其他容器申请和计算进程；检查失败不会杀进程或抢卡。必须在 GPU 主机本地执行，不用本机 nvidia-smi 检查远程 Docker。宿主机 GPU 管理脚本兼容 Python 3.6+，无需升级系统 Python；模型服务使用容器内独立的 Python 环境。

各服务 `.env` 只保存自己的资源、端口、模型路径。`deploy` 应用变更；`start/restart` 使用已保存配置；`stop` 保留容器、模型文件和 Key，释放运行中的占用。默认不提供删除模型或所有服务一键全停；需要再次部署时无需重新下载已缓存模型。OCR 识别队列属于内存状态，停止前需收集结果。

- [mx-ocr 部署/API/上游来源](mx-ocr/README.md)
- [mx-embedding 部署/API/Hub 接入](mx-embedding/README.md)
- [GPU 服务边界与管理决策](docs/adr/0004-gpu-base-services.md)

OCR 默认监听 0.0.0.0:8710，支持内网其他机器访问；Embedding 保持回环监听，跨容器/主机调用须选择受控内网入口；Embedding 有独立 Bearer Key，OCR 沿用上游接口与调参能力，应由入口限制访问。没有自动配置 Hub 默认模型、索引维度或发起历史向量化。

## 首次部署 mx-static

```sh
cp mx-static/.env.example mx-static/.env
# 按主机规划编辑数据目录、本机队列目录、UID/GID、绑定地址。
bash scripts/manage.sh deploy mx-static
bash scripts/manage.sh status
```

默认 `/srv/mx-static/data` 放文件，`/srv/mx-static/state` 放 SQLite 队列。使用 root 执行管理命令时只负责创建目录并交给配置 UID/GID，容器仍以 1000:1000 运行。非 root 部署须预先准备可写目录，UID/GID 与服务进程一致。重复部署不会轮换凭据。

当前暂停 Hub 接入，先验收独立静态服务。可选 NAS 使用 `attach mx-static` / `detach mx-static` / `storage mx-static`，不会替换主服务数据卷。详细步骤、接口、故障恢复和 NAS 管理见 [mx-static 运维文档](mx-static/docs/README.md)。首次部署需保证主机有 Docker Compose v2、镜像仓库网络和足够磁盘空间。

2026-09-21：mx-static 从与 knock-nas 完全相同的 0.3.0 快照升级到其 0.7.0，实现已归并至本目录并适配统一入口。保留 Docker 部署、本机 SQLite/SSD 和独立 NAS 归档；宿主 Nginx 发文件是默认关闭的可选优化。[来源与部署决策](mx-static/docs/deployment-decision.md)、[存储迁移与只读排查](mx-static/docs/storage-migration.md)。升级旧实例前先停止写入并备份；新的管理界面 admin-token 会幂等补建，原读写令牌与 signing-key 保留。

## 目录边界

- `scripts/manage.sh`：应用选择和通用入口；`scripts/apps/jenkins.sh` 保留 Jenkins 原有生命周期实现。
- `mx-ocr/`、`mx-embedding/`：独立 GPU 应用，各有管理脚本、配置和文档。
- `scripts/gpu-*.{sh,py}`：统一 GPU 分配与只读启动检查；不改宿主机驱动和全局代理。
- `mx-static/`：该应用自己的源码、Compose、环境配置、文档和测试；独立凭据及两套数据挂载。
- `jenkins/`、`deploy/k8s/internal/`：现有 Jenkins 结构与资源名称保留，避免不必要迁移。
- `docs/adr/`：跨应用边界和架构决策；新增基础设施应拥有独立部署、数据、凭据和状态操作。

相关文档：[分层决策](docs/adr/0002-independent-apps-and-media-storage.md)、[Jenkins 说明](docs/jenkins.md)。
