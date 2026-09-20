# MX Insight Hub：Internal 部署与重启档案

此文件是本项目日常部署、停机恢复及后续排查的入口。适用当前 Internal 单节点 Kubernetes/containerd 环境；已知环境信息核验于 2026-09-21。服务器上的实际 PV、身份记录和配置是最终依据，不能只凭目录名选择数据。功能设计见 `docs/`，本次旧盘恢复经过见[恢复复盘](docs/operations/restart-and-recovery.md)。

## 固定依赖和责任边界

**Hub 的持久业务数据来自兄弟项目 `../mx-common`，不是 Hub 容器文件层或 Hub 自己的 PostgreSQL。** Hub 与 mx-common 都要同步代码；仅拉取/复制 Hub 子目录不能获得共享部署脚本的修复。

| 项目 | 当前约定 |
| --- | --- |
| Hub 命名空间 | `mx-insight-hub`：Admin、Public、ingest、projector、classifier、retrieval、迁移 Job |
| 共享数据命名空间 | `mx-common`：PostgreSQL、Elasticsearch、Redis，按需安装 HanLP |
| PostgreSQL | PG16 / pgvector；数据库及产品角色均为 `mx_insight_hub`；共享管理角色为 `mx_common` |
| PG 服务地址 | `mx-common-postgres.mx-common.svc.cluster.local:5432` |
| Elasticsearch | 本环境恢复使用 9.4.2；`mx-common-elasticsearch.mx-common.svc.cluster.local:9200` |
| Redis | `mx-common-redis.mx-common.svc.cluster.local:6379`；缓存/可选队列，不是业务持久数据的唯一副本 |
| HanLP | 可选本地分词服务；已安装/已配置的实例重启时继续使用，不能在暂时不可达时静默改成 jieba |
| Admin / Public | 当前分别使用宿主机 `18151` / `18150`；浏览器 Public origin 以保留的 `MX_INSIGHT_PUBLIC_URL` 为准 |
| 后台副本 | 当前清单为 ingest 1、projector 1、classifier 1、retrieval 2；以版本化清单为准 |
| 人的登录身份 | 由 Launcher 负责。Hub 自己保存 tenant、membership、consumer、API Key、授权、账本及业务记录 |
| 上游数据 | Night-All / Night-All-A 和其他平台提供源数据或调用能力；上游异常不等于 Hub 本地数据丢失 |

PG、ES 使用 Service DNS，不固定 Kubernetes ClusterIP 或 Pod IP，它们可能在重建后变化。搜索索引版本和服务 alias 由现有数据/配置决定；不要把某次截图中的 v6、document 数量或租户数写成每次启动必须相等的条件。

## 原数据盘与必须保留的文件

当前确认的数据根目录：`/data/k8s/mx-runtime/mx-common/k8s`。

| PV | PVC（namespace `mx-common`） | 原数据路径 |
| --- | --- | --- |
| `mx-common-postgres-data` | `data-mx-common-postgres-0` | `/data/k8s/mx-runtime/mx-common/k8s/postgres/data` |
| `mx-common-elasticsearch-data` | `data-mx-common-elasticsearch-0` | `/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/data` |
| `mx-common-elasticsearch-snapshots` | `mx-common-elasticsearch-snapshots` | `/data/k8s/mx-runtime/mx-common/k8s/elasticsearch/snapshots` |

三组卷使用 `Retain`；PGDATA 位于 PostgreSQL 卷的 `pgdata` 子目录。当前原 PG system identifier 为 `7671038612254789664`。这些是本环境档案，不是新安装另一环境时应复制的数据库身份。

`/var/lib/mx-common/k8s` 曾因重建元数据而生成空库，**不能因为那里存在目录就认定是原数据**。也不要使用 `relocate` / `migrate-storage` 将该空库覆盖到 `/data`。普通 deploy 从现有 PV 发现路径，然后核对路径、节点、Bound/Retain、claim UID、文件系统及 PG 身份，不自动迁移或重绑卷。

必须保留：

- 原数据目录、PV/PVC 及其绑定。
- Hub `.env.internal`（0600），尤其原 `MX_INSIGHT_API_KEY_PEPPER`；它参与旧 Key 认证和加密凭据/vault 的使用。
- `mx-insight-hub/mx-insight-hub-secrets`：Hub DSN、Pepper、Admin Token 等；`mx-common/mx-common-secrets` 与 `mx-common/mx-common-db-mx-insight-hub`：共享及产品数据库凭据。备份实际 Secret，不在此文档写密钥值。
- `/var/lib/mx-common/storage-identity.json`：无密钥的存储身份记录，包含根路径、节点、PG 身份、挂载点和文件系统 UUID。首次核验后原子发布，不能为绕过校验随意删改。
- 其他保留的 Hub runtime Secret/ConfigMap，包括 bootstrap Key 和模型配置；日常部署沿用既有配置。

2026-09-21 核验时数据盘显示为 `/dev/nvme0n1p1`、挂载到 `/data`。设备名可能变化，应按文件系统 UUID 确认和配置主机持久挂载。脚本不会自动修改 `/etc/fstab`、挂载未知磁盘、修改 VPN 或全局 Docker 代理。

## 正常部署：只执行这一条

在服务器 `electron-dock/mx-insight-hub` 目录，以可读取 PGDATA 的 root 身份执行：

```bash
MX_INSIGHT_BUILD_PROXY=http://127.0.0.1:7788 \
  bash scripts/manage.sh ops internal-production deploy
```

需要原数据盘已挂载、Kubernetes/containerd 可用，以及 Node.js ≥ 22.18、kubectl、findmnt、flock、Docker、ctr。**不需要提前手动启动 mx-common。** 正常 deploy 的顺序是：

1. 取得部署锁并核对配置/凭据连续性；新部署锁记录主机 boot ID，重启后即使 PID 被复用也可识别旧锁。Linux 进程锁防止两个部署同时清理旧锁。正在运行的部署/恢复仍会被阻止。
2. `mx-common ensure` 核验原盘/原库，复用既有卷，创建缺失的核心工作负载/Service，将 PG、ES、Redis 恢复到 1；已安装的 HanLP 也恢复到 1。先等依赖可用。
3. `provision mx-insight-hub` 使用保留的产品凭据。已有凭据但数据库或角色不存在时停止，绝不把“重建空数据库”当成恢复。只有角色、库和凭据均不存在的首次产品安装才允许初始化。
4. 关闭 projector 的重启全量索引入口，再构建 Hub 镜像并导入 containerd。
5. 保留运行配置，冻结 Hub Admin 写入，终止并确认前次迁移 Job/Pod 已退出，再执行本版迁移；迁移失败不会无限自动重试。
6. 启动 Public/Admin，再恢复四种后台 worker 到清单副本数；完成依赖、工作负载、API 检查后才报告完整成功。

后台队列会按数据库里原有启停、预算、并发和检查点继续处理；正常部署不创建全量索引、向量初始化或重新采集任务。应用版本有新迁移时仍执行正常 schema 升级，这不是逐字节不变的备份恢复。

`MX_INSIGHT_REQUIRE_SEARCH` 默认 `1`。若旧 `.env.internal` 中明确设置 `0`，请删除该覆盖或改为 `1` 才是“全部服务恢复”的验收方式；0 只表示允许降级，仍不能绕过存储/凭据保护。其他值会被拒绝。

独立 Hub 部署默认不触发 Launcher 同步或重启，即使 `.env.internal` 留有旧同步开关。不要为恢复 Hub 添加 `MX_INSIGHT_SYNC_LAUNCHER=1`；该显式选项保留给原有 Launcher 委托入口。MX-H2I 登录、用户联网、订阅和全局代理不属于 Hub 部署范围。

### 镜像、等待与短暂中断

Docker 和 Kubernetes/containerd 是两个镜像存储。共享镜像缺失时优先导入本机 Docker 缓存，没有缓存才拉取；`MX_INSIGHT_BUILD_PROXY` 只控制 Hub 构建，不会替 Docker daemon 或 containerd 配置仓库代理。

核心依赖的 CLI 默认等待上限为单项 1200 秒，可用 `MX_COMMON_WAIT_TIMEOUT` 配置。PG/ES 另有 30 分钟容器启动探针预算，避免崩溃/WAL/索引恢复较慢时被早期 liveness 反复杀死；正常启动后才启用原有存活检测。启动探针语义见 [Kubernetes 官方文档](https://kubernetes.io/docs/concepts/workloads/pods/probes/)。这个预算与 CLI 等待、镜像下载耗时不同，CLI 超时不是删除原数据或立即强杀数据库的理由。

PG/ES 正常终止保留 120 秒宽限。首次应用新的探针/启动保护或其他 Pod 模板变更会滚动这些服务；单节点期间 Hub 可能短暂不可用。后续配置不变时，mx-common 不因正常 ensure 而额外滚动，Hub 自身仍按既有 deploy 流程更新。

## 停机与之后的重启

只停止 Hub：

```bash
bash scripts/manage.sh ops internal-production down
```

它停止六种 Hub Deployment 并等待其 Pod 退出，保留 mx-common、持久卷和凭据。不要在部署或单独迁移/恢复任务仍运行时并行执行 down。

若还要停止共享数据服务，先确认其他依赖 mx-common 的产品已停，再执行：

```bash
bash ../mx-common/scripts/manage.sh down
```

共享 down 会确认缩容并等待核心 Pod 退出；API 查询、缩容或等待失败返回错误，不能据此直接拆盘。之后仍用上面的 Hub `deploy` 一条命令恢复。`down`、主机正常重启和删除 namespace/PVC/PV/Secret 是不同操作，后者不属于普通重启。

## 部署后的只读验收

在 Hub 目录执行，不读取 Secret 值：

```bash
bash ../mx-common/scripts/manage.sh status
kubectl -n mx-insight-hub get deployments
kubectl get pv -l app.kubernetes.io/part-of=mx-common \
  -o custom-columns='NAME:.metadata.name,STATUS:.status.phase,PATH:.spec.hostPath.path'
findmnt -T /data/k8s/mx-runtime/mx-common/k8s -o TARGET,SOURCE,FSTYPE,UUID
```

验收要点：PG/ES/Redis 就绪、ES primary shards 可用、三组 PV 仍指向上表的 `/data` 路径、六种 Hub 工作负载达到清单副本数。页面应能看到原租户、Key、数据目录和历史记录；近 24 小时图表随时间变化，不能作为全库一致性证明。后台积压可以继续消化，不要求在启动时归零。

本次恢复的历史基线是 9 租户、10 调用者、13 个总 Key（其中启用 10）、旧 v6 索引 2,046,052 documents；之后合法新增/处理数据会改变这些值。专用恢复脚本当时有意暂停四个 worker，后续正常 deploy 才恢复它们。当前是否已恢复后台，以实时 Deployment 状态为准。

## 遇到以下情况，停止初始化并保留现场

| 情况 | 正常 deploy 的行为 / 处理 |
| --- | --- |
| mx-common Pod/Deployment/StatefulSet/Service 停止或缺失，原 PV/PVC/Secret 完好 | 自动复用原卷并恢复核心服务 |
| `/data` 未挂载、UUID/PG 身份变了、目录/元数据缺失 | 停止；恢复正确盘/原文件后重试，不回退根分区 |
| PV/PVC 丢失、Released、terminating、UID 或路径不符 | 停止；进入显式存储恢复，不自动清除 claimRef 或重绑 |
| Hub/数据库 Secret 缺失或冲突、原 Pepper 不明 | 停止；使用原配置/私有备份核验恢复，不生成替代密钥 |
| 原产品数据库或角色缺失，但产品 Secret 仍在 | 停止；恢复原库，不 CREATE 一个同名空库 |
| HanLP 整个 Deployment 被删且原 Hub 仍配置使用它 | 需要按 mx-common 文档显式恢复 HanLP；不自动降级分词器或重建模型 |
| 镜像/仓库网络不可用、磁盘满、依赖未就绪 | 明确失败，处理具体原因后重试同一 deploy；保留卷和数据 |
| 旧版本留下没有 boot ID 的锁且 PID 恰好存活，或同次启动锁损坏 | 保守停止；先核实进程/恢复任务，不盲目删除锁。新锁能自动识别跨重启残留 |

常规排查不要运行 `reset-storage`、`decommission-local-postgres`、`relocate`、删除 namespace/PVC/PV、清空 PGDATA、`pg_resetwal` 或全量重建来“试一下”。显式灾难恢复按[旧盘核验与恢复流程](docs/operations/retained-data-inspection.md)执行。

原私有核验/恢复目录暂时保留：`/data/.mx-hub-inspect-U5pAiZ`、`/data/.mx-hub-recovery-ljwH6x`。不要贴出整个目录、Secret 备份或原始配置；同盘 reflink 和同盘 ES snapshots 不是离机备份。独立备份及恢复演练见[备份恢复文档](docs/operations/backup-restore.md)。

## 备份与新机器安装

原盘完好的重启继续用本文件的 deploy 命令；**deploy 不会从阿里云自动恢复，也不能代替离机备份**。当前 ES 默认快照和事故 reflink 都在同盘，PG 尚未配置持续 WAL/物理备份。完整方案及状态见[备份、OSS 与大数据量恢复](docs/operations/backup-restore.md)；全新业务安装和接替旧机的区别见[新机器恢复顺序](docs/operations/new-host-restore.md)。

面向几百 GB / TB 的主方案：PG pgBackRest full/diff/incr + WAL、ES 原生 segment 快照、原 Pepper/数据库凭据等配置单独加密。业务数据来自 mx-common；只恢复 Hub 源代码、`.env.internal` 或数据库之一均不完整。恢复目标的新节点和磁盘 UUID 必须显式登记，不能直接复制原 `storage-identity.json` 或初始化同名空库。

现在可执行 `node scripts/backup-readiness.mjs` 查询只读证据，以及 `node scripts/export-recovery-kit.mjs --help` 查看加密配置包用法。配置包不包含数据库；云仓库接入、定时任务、新机自动登记及真实恢复演练仍待实施，不能把这些辅助工具通过测试写成“云备份已上线”。

## 本轮检查的验证范围

本轮在本地检查了路径与卷绑定、PG 身份与挂载、密钥、provision、依赖启动、镜像缓存导入、探针、六种 Hub 工作负载、迁移失败清理、部署锁及 Launcher 隔离。回归测试使用临时文件和模拟 Kubernetes/Docker，不访问生产库、不发付费上游调用；部署清单另做 YAML 解析与启动探针检查。

这些检查验证部署逻辑，不能替代服务器上的实际重启演练、硬件健康检查或全库完整性核验。本轮代码需要由操作员提交、服务器拉取后生效；不要把本地测试通过写成服务器已经执行了新 deploy。
