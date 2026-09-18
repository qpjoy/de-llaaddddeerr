# ADR 0004：独立 GPU 基础服务与统一启停

2026-09-19，用户要求引入 knock-ocr、自建 Qwen3 Embedding，并可独立释放资源。

mx-base 放置可独立部署、独立停止的基础能力。新增 `mx-ocr/`、`mx-embedding/`；保留 mx-static 与 Jenkins 的现有路径、部署类型和数据。此次不迁移 mx-common，也不把基础服务捆成一个必须一起启动的大 Compose。后续每个服务拥有自己的源码、配置、模型/数据目录、README 和测试。

`scripts/manage.sh <操作> <应用>` 是统一入口；无参数支持应用选择，status 只读，无全量自动部署/全停。GPU 应用各自维护生命周期实现，共享只读 GPU 校验和配置。非交互部署必须明确指定服务。

GPU 默认：显示器 3、OCR 2、Embedding 1；运行前解析编号为 UUID，拒绝重复分配、显示活跃/未知、其他容器设备申请和其他计算进程。检查与启动在主机锁内完成；外部程序不遵守该锁，仍不能视为硬资源隔离。改动分配需要 deploy，start 必须符合容器保存的 UUID。

stop 保留模型缓存/Key，释放运行资源；不会删除业务数据。OCR 原有队列在内存中，不能承诺重启恢复。模型文件与 Hub 的向量数据库分别规划空间。

新服务不是登录、网络或 Hub readiness 的必需依赖。Hub 仅显式配置 Provider 后才调用 Embedding；不自动启用全库任务、扩大预算或调整集群。已有 MX-H2I/Launcher/VPN/认证代码不改动。

初始 Qwen 服务固定 revision、512 维、BF16 和有界输入/并发，查询指令是显式 input_type 扩展；当前 Hub 的标准调用可用，但不会自动得到 query instruction。量化、跨记录合批和 Hub 查询指令接入另行验收，不隐式改变向量空间。

2026-09-19 部署确认：所有 Docker 应用 deploy 执行前要求输入 yes，EOF/其他输入不执行。重复部署更新同一实例，保留持久数据和凭据；不承诺滚动发布或自动回滚。OCR 准备镜像后才按已验证容器 ID 停止/移除本服务旧实例，停止超时最多 40 秒。GPU PID 识别解析 top 列名并用完整容器 ID 的 cgroup 核验新 Worker，不能凭 GPU 相同或进程名称相同就认领。
