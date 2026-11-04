# Internal 断电恢复：Hub 启动依赖门禁

状态：**已实现未部署**。本次只修改本地代码与生产 Kubernetes 清单，未重建镜像、未访问或改变现网。

Internal 的 Public、Admin、projector、ingest、classifier、retrieval 六个工作负载，在新 Pod 启动时先运行同版本 Hub 镜像中的 `server/ops/wait-startup-dependencies.mjs`。两个条件在同一轮探测均通过后才启动业务进程：

1. 当前节点的 `127.0.0.1:5432` 返回 PostgreSQL 协议响应，表明可接受连接。使用与 `pg_isready` 一致的判定：认证请求可通过；启动/恢复时的 SQLSTATE `57P03` 不通过；其他合法服务端 SQLSTATE 只证明服务正在响应。探测不提供密码、不执行 SQL、不校验数据库身份、源库权限或表结构。已有 saved-records 源库身份检查仍然有效且不可省略。[PostgreSQL libpq 实现依据](https://github.com/postgres/postgres/blob/REL_17_STABLE/src/interfaces/libpq/fe-connect.c#L4194-L4253)。
2. ConfigMap `mx-insight-hub-config` 中已保存的 `MX_COMMON_HANLP_URL` 的 `/health` 返回 HTTP 200 且 JSON `status=ready`。mx-common 的该接口在全部模型 worker 预热完成后才报告 ready。URL 缺失或无效立即阻止启动，不降级成其他分词器。

每次 PG/HTTP 探测最多 3 秒，每轮间隔 2 秒，单次 initContainer 最多等待 900 秒；超时退出非零，Kubernetes 按 initContainer 重试规则继续尝试。响应大小有上限，日志仅记录依赖状态，不打印地址、凭据或服务端错误正文。探测直接访问依赖，不经过宿主 HTTP 代理。

门禁只放在 `deploy/k8s/internal/30–35-*.yaml`，适用于当前单机、全部 `hostNetwork` 的 Internal 部署。它不会修改 Compose、本地开发、迁移 Job、Launcher、MX-H2I、宿主 kubelet 或其他工作负载；不会把 Hub 的依赖失败升级成整台服务器不能启动。已经运行的 Hub 也不会因该脚本主动被停止。initContainer 不是持续健康监控，业务容器在同一个 Pod 内单独重启时不能假设 initContainer 必然重跑。

发布需要先重建并导入包含该脚本的 Hub 镜像，再使用同一镜像标签更新这六份清单、滚动 Hub；无需发布 Launcher。现有渲染器同时替换 initContainer 与业务容器的 `mx-insight-hub:shadow`。镜像构建的 `COPY .../server ./server` 已覆盖新脚本。若依赖预热超过部署命令的 rollout 等待时间，应将该命令记录为未完成，核对 Pod 的 init 日志并在依赖恢复后重新验收，不能把命令超时当成依赖已就绪。

本地验证：`node --test tests/server/startup-dependencies.test.mjs` 使用真实回环 TCP/HTTP 测试服务，覆盖 PG 恢复拒绝、认证响应、分片/无效/超长响应、硬超时、HanLP 503 后恢复、URL 缺失、两依赖同时就绪与总等待上限。此结果不代表现网已完成断电演练。现网后续验收需观察六个 Pod 的 init 完成、原有 readiness 和工作负载健康，并独立核对 MX-H2I 登录与联网。

多节点迁移前必须重新设计此地址约定：其他节点的 `127.0.0.1:5432` 不代表 Internal 源库，不能原样推广。见 [部署拓扑与多节点演进](../architecture/spider_man/01-topology-and-multinode.md)。
