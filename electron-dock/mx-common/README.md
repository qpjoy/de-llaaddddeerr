# MX Common

MX 产品模块共用的数据面：PostgreSQL 连接与迁移、Elasticsearch 索引生命周期、持久化任务队列、中文分词、依赖健康探针。既是一个 npm 包，也是一组 `mx-common` namespace 下的共享有状态服务。

它是 `mx-insight-hub` 和 `mx-launcher` 的兄弟项目，不是任何一方的子模块。它**不包含任何业务语义**：没有租户、没有账本、没有 dataset 定义。产品自己拥有这些，只把存储原语交给这里。

## 隔离模型

一个产品 = 一个 `productId`（如 `mx-insight-hub`），对应：

| 资源 | 隔离粒度 |
| --- | --- |
| PostgreSQL | 一个独立 database + 独立 role（`mx_insight_hub`） |
| Elasticsearch | 独立索引前缀 + 独立 ILM policy（`mx-insight-hub-*`） |
| 队列 | 队列名前缀（`mx-insight-hub:<queue>`），任务表在产品自己的库里 |

这是 ADR-0003「独立事务边界」在共享实例下的落地方式：共用一个实例省运维，但备份、恢复、故障域和权限仍按产品切分，任何产品都无法读到另一个产品的数据，也无法用长事务拖垮对方。

## 关键取舍

**队列默认落在 PostgreSQL，不是 Redis。** 这不是省事，是因为主导需求是「任务和触发它的那行数据必须一起提交」。`enqueue` 接受调用方的事务 client，业务写入和任务入队在同一个事务里；Redis 做不到这点，BullMQ 在 COMMIT 之后入队存在一个进程崩溃就永久丢任务的窗口。崩溃恢复用租约而非连接：worker 认领任务时盖上 `lease_expires_at`，pod 被 rollout/OOM/重启杀掉后租约自然过期，下一轮 sweep 把任务放回 `pending`——**重新 deploy 后自动续跑未完成任务，不需要任何人工介入**。

Redis 仍然部署，但定位是缓存类依赖：限流、singleflight、短缓存，以及显式选择 `MX_COMMON_QUEUE_DRIVER=bullmq` 的产品。丢了只掉吞吐，不掉正确性。

**中文分词在写入端做，ES 不装插件。** 索引侧只用 `whitespace` tokenizer 读取已分好的词。代价是换分词器需要 reindex；收益是所有 MX 集群都跑官方原版 elasticsearch 镜像——装 IK 或 HanLP 插件意味着每个 ES 补丁版本都要重建自定义镜像，且任何节点重启前都必须先装好插件。因为按 ADR-0005 所有搜索索引都是 PostgreSQL 的可重建投影，reindex 是可接受的操作，而自定义镜像是长期负担。

三档分词后端，`MX_COMMON_SEGMENTER` 可显式指定，不指定则自动选最好的可用项：

| 后端 | 质量 | 代价 | 何时用 |
| --- | --- | --- | --- |
| `hanlp` | 最好，实体/品牌名尤其准 | 约 2GB PyTorch 容器 + 模型下载 | 语料以人名机构名为主，且愿意维护一个服务 |
| `jieba` | 好，词典分词 | 一个 npm 可选依赖，带预编译二进制 | **默认**，绝大多数场景 |
| `fallback` | 差，CJK 双字组合 | 零依赖 | 前两者都不可用时自动兜底 |

对比同一句话：

```
jieba     建议 都 去 学 吴恩达 的 ai agent 人工智能 与 检索 增强 生成 的 关系   (15 tokens)
fallback  建 议 都 去 学 吴 恩 达 建议 议都 都去 ...                          (45 tokens)
```

每一档都是**运行时降级而非启动失败**：HanLP 不可达退 jieba 的位置、jieba 装不上退 bigram，入库永不中断。这是刻意的——入不了库是账本上的永久空洞，而错误的分词以后 reindex 就能修好。

两个容易踩且会静默减半质量的点已在代码里处理：`new Jieba()` 的词典是**空的**，会把中文切成单字（看起来在工作，检索效果等同 bigram），必须显式 `Jieba.withDict(dict)`；以及 `hmm: true` 才能切出词典里没有的词，社交文本里这类词很多。

**ILM 没有 delete 阶段。** hot(30d rollover) → warm(30d, forcemerge) → cold(90d, readonly)，数据无限期保留，清理只能通过显式的、有审计的操作。

一个必须说清的限制：**ES 的 ILM 按年龄迁移，不按访问**。没有「被查询到就滚回热层」这个动作。cold 阶段的数据仍然可查，只是分配优先级低、已 forcemerge，读起来慢一些而不是不可用。真正「查到才恢复」的形态是 `searchable_snapshot`，那需要 Enterprise license；以上全部在 Basic 上运行。

## 用法

```bash
# 共享数据面：幂等，健康时是 no-op，不会删任何数据
bash scripts/manage.sh ensure
bash scripts/manage.sh status
bash scripts/manage.sh health    # 退出码 0=健康 1=降级/宕机
bash scripts/manage.sh down      # 只缩容，保留 PVC/PV/索引
```

`ensure` 会自己处理单节点 kubeadm 上的两个硬性前提：`vm.max_map_count`（ES 不满足就起不来，需要节点 root 权限，所以在这里设而不是塞一个 privileged init container）和无默认 StorageClass 时的 Retain hostPath PV 绑定。

正常 Hub `deploy` 已调用 `ensure`，因此停止的共享服务无需提前手动启动。当前版本先核对本地卷绑定、磁盘 UUID 与 PG16 身份，在 `/var/lib/mx-common/storage-identity.json` 保留无密钥记录；不明存储、缺失旧文件或 Secret 返回 78，调用方不得将其当成搜索降级。需要在 Linux 节点以能读取 PGDATA 的 root 身份执行，并保留该身份记录。普通工作负载缺失可重建；PV/PVC 元数据丢失需要显式恢复，不自动初始化第二个库。

核心服务默认等待上限改为 1200 秒（`MX_COMMON_WAIT_TIMEOUT`），镜像优先从 Docker 缓存导入 containerd。已安装的 HanLP 会在 `ensure` 中恢复副本数并等待健康；首次安装或被删除的 HanLP Deployment 仍使用下面的独立部署命令。首次接入新版启动保护会滚动 PG/ES，后续配置不变不会额外重启。完整边界和本次恢复证据见[停机恢复复盘](../mx-insight-hub/docs/operations/restart-and-recovery.md)。

PostgreSQL / Elasticsearch / Redis 是核心组件，随 `ensure` 一起部署。HanLP 使用独立的幂等部署目标：

```bash
bash scripts/manage.sh deploy hanlp
```

该命令会先确认当前主机就是唯一 Kubernetes 节点并检查至少 8GiB 可用磁盘，
再用专用的 `docker-container` buildx builder 和 Docker cache 构建约 2GB 的模型
预热镜像。builder 会自动创建并收敛到 4GiB/2 CPU 限额；
Python 依赖默认经清华 PyPI 镜像下载，Torch 只从官方 CPU wheel 源下载；下载缓存
会跨失败重试保留，慢网络下也不会因为后续小依赖超时而重新下载完整 Torch wheel。
构建完成后会停止 builder 容器并保留 cache；
随后把本次构建结果重新导入 `k8s.io` containerd（可自愈同名旧镜像）、把镜像
模型校验后精确同步到持久化 PVC、应用 HanLP Service/Deployment/NetworkPolicy，
并以 `/health` 和 `/tokenize` 作为成功条件。相同 image ID 不会触发无变化的
Pod rollout；整个命令可安全重复执行。

若节点访问 PyTorch 官方 CPU wheel 源仍然很慢，可只给这次构建传代理；脚本会把
代理同时交给 builder 和镜像内的 pip/模型下载步骤，不改 Docker daemon 的全局配置：

```bash
HTTP_PROXY=http://127.0.0.1:7788 \
HTTPS_PROXY=http://127.0.0.1:7788 \
bash scripts/manage.sh deploy hanlp
```

不要再把 `MX_COMMON_HANLP_ENABLED=1` 当作部署开关；该旧入口会被明确拒绝，
避免 Docker 与 Kubernetes containerd 的同名镜像内容不一致。

HanLP ready 后重新部署 `mx-insight-hub`；Hub 会从 ready Endpoint 自动发现
`http://mx-common-hanlp.mx-common.svc.cluster.local:8000`。显式设置
`MX_COMMON_HANLP_URL` 仍可覆盖自动发现，显式设置为空则关闭自动发现并使用 jieba。

镜像与容量调节：

```bash
MX_COMMON_ELASTICSEARCH_IMAGE=<mirror>/elasticsearch:9.4.2   # 境内镜像源
MX_COMMON_ELASTICSEARCH_HEAP=12g                             # M 档默认/上限
MX_COMMON_SEGMENTER=jieba|hanlp|fallback                     # 分词后端
bash scripts/manage.sh preload                               # 预热镜像，避免 ensure 卡在拉取
```

Kubernetes Elasticsearch 当前使用固定 M 档：CPU request `1`、limit `8`，memory
request `24Gi`、limit `32Gi`，JVM heap `12g`。CPU 可以在节点有余量时 burst 到 limit，
`8` 不是保证配额；plain StatefulSet 不会按监控阈值自动增大 memory 或 heap。显式调低
`MX_COMMON_ELASTICSEARCH_HEAP` 会更新 Pod template 并滚动重启，且不会降低固定的
`24Gi/32Gi` request/limit；超过 `12g` 会被部署脚本拒绝。在既有单节点 Internal 目标上，
`ensure` 不修改 StatefulSet 名称、Service、PVC 名称或 claim template，资源/heap 变更只滚动
Pod 并继续挂载原 data PVC。直接在多节点 hostPath 集群运行前，必须先为 PV/Pod 固定同一节点；
同名 hostPath 在另一节点不是同一份数据。

### ES 磁盘水位

`manage.sh ensure` / `deploy` 会在线应用并回读校验以下剩余空间阈值。Hub 的 Kubernetes
`deploy` 已调用该 `ensure`，所以同步更新兄弟目录 `mx-common` 后正常部署即可生效。
只更新 Hub 镜像或单独 `kubectl apply` 不会执行此步骤。

| 水位 | 剩余容量 | 动作 |
| --- | --- | --- |
| low | 100 GiB | 限制分配新分片，新建主分片有例外 |
| high | 50 GiB | 限制分配并尝试迁移；不直接禁止已有索引写入 |
| flood-stage | 30 GiB | 对受影响索引启用写保护，恢复至 high 安全侧后自动解除 |

配置源为 `scripts/elasticsearch-disk-policy.mjs`，部署主机需要 Node.js，无需安装 npm
依赖。通过 `/_cluster/settings` 写入 persistent 设置，保留磁盘保护并仅清除这些键的
transient 覆盖和百分比 headroom；不修改其他集群设置。回读失败会明确报告 `ensure`
未完成，Hub 保留原来的依赖降级处理。重复部署匹配时不写入，ES 重启后设置仍保留。
水位变更本身不滚动重启 ES、不清理数据、不启动任何索引重建或向量化。

该策略按 2026-09-17 用户指定的 100/50/30 GiB 设置；Internal 已确认 kubelet
`nodefs/imagefs.available<20Gi`，ES 写保护比磁盘驱逐提前 10 GiB。
它按 ES 数据所在文件系统判断；同盘的 PG、WAL、镜像与日志都占用
余量。水位调整不构成全库任务容量保证。可用 `bash scripts/manage.sh status` 查看实际值。
不同磁盘或 kubelet 阈值的部署需重新评估并调整上述配置源。

参考：[Elastic 磁盘水位](https://www.elastic.co/docs/reference/elasticsearch/configuration-reference/cluster-level-shard-allocation-routing-settings)。

代码侧：

```js
import { loadCommonConfig, createPool, createQueue, runCommonMigrations } from '@qpjoy/mx-common'
import { createElasticsearchClient, defineIndexSet, ensureIndexSet } from '@qpjoy/mx-common/elasticsearch'

const config = loadCommonConfig('mx-insight-hub')
const pool = createPool(config.postgres)
await runCommonMigrations({ connectionString: config.postgres.url })
const queue = createQueue(config.queue, { pool })

// 业务写入和任务入队在同一个事务里
await withTransaction(pool, async (client) => {
  await client.query('INSERT INTO ... ')
  await queue.enqueue('embed', { recordId }, { client, dedupeKey: recordId })
})
```

## 每产品一个数据库

`manage.sh provision <productId>` 幂等地在共享实例里建角色、建库、装 `pg_trgm` 和 `vector` 扩展，并把凭据存进 mx-common 自己的 Secret（重复部署复用而不是轮换），然后把 DSN 打到 stdout——其余输出都走 stderr，所以调用方可以直接 `$(...)` 捕获。

Hub 的 `deploy` 会自动调用它，不需要手动执行。

## hostPath 与 fsGroup

无默认 StorageClass 时 `ensure` 会建 Retain 的 hostPath PV，并**按各 Pod 的 `runAsUser` 修正目录属主**（PG `999:999 0700`、ES `1000:0 0775`）。这一步不能省：**`fsGroup` 对 hostPath 卷不生效**，kubelet 只对支持所有权管理的卷类型做 chown。root 建的目录是 `root:root`，PG 会在 `mkdir PGDATA` 时失败、ES 会在创建 `node.lock` 时失败，两者的报错都只说 Permission denied，不会指向真正的原因。

属主每次运行都校验，所以早先版本留下的错属主目录会被自动修好。

## 依赖健康契约

`postgres` 是 required，其余全是 optional。required 失败才影响 readiness——让 Elasticsearch 拖垮 readiness 探针会把「搜索降级但能用」变成「API 直接下线」，这正是 ADR-0005 和 Launcher 集成契约明令禁止的。`runProbes` 返回的 `degraded` 字段让运维仍然看得到 optional 依赖挂了。

## 备份责任与检查

PG 是多个产品共享的物理实例；整机物理恢复和 Hub 单产品恢复必须区分。ES 默认快照在同机，不能覆盖丢机/坏盘。PG 物理增量与 WAL、OSS、密钥托管、TB 级容量及新机恢复的统一说明见 [Hub 备份操作档案](../mx-insight-hub/docs/operations/backup-restore.md)。

`bash scripts/manage.sh snapshot status` 现在校验最近成功时间（默认 36 小时）及其后的失败；配置存在或很久以前成功过不会通过。可用 `MX_COMMON_SNAPSHOT_STALE_HOURS` 调整阈值。日常 ensure 对快照配置失败仍只警告，服务成功不代表备份成功。

ES S3 endpoint/region/path-style 应在命名 client 配置中，凭据在持久 keystore；repository 只引用 client。`node scripts/print-snapshot-config.mjs client` 可生成非密钥 client 配置，默认 `mx_backup`。这是待部署配置，当前清单不自动注入 S3 client/keystore；旧 S3 配置使用者需要一并迁移，不能仅设置 Bucket。默认 filesystem 行为不变。
