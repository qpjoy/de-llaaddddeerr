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

HanLP 服务是可选的。没配 `MX_COMMON_HANLP_URL` 时用内置回退分词器（CJK 双字组合 + 拉丁词），质量明显更差但永远可用。这是刻意的：HanLP 挂掉应该降级搜索质量，而不是中断入库——入不了库是账本上的永久空洞，而错误的分词以后 reindex 就能修好。

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

可选组件默认关闭：

```bash
MX_COMMON_HANLP_ENABLED=1      # HanLP 分词服务（镜像约 2GB）
MX_COMMON_POSTGRES_ENABLED=1   # 共享 PostgreSQL 实例
```

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

## 与 mx-insight-hub 现有 PostgreSQL 的关系

Hub 已有的 PostgreSQL **不会被 deploy 搬迁**。它带着 retained local PV 在运行，迁移一个活库是一次需要独立演练、备份和 cutover 的操作，把它塞进 `deploy` 等于让运行中的数据离一个脚本 bug 只有一步之遥。所以：

- mx-common 提取的是 PG 的 **manifest 定义和代码封装**；
- Hub 默认仍连自己那套 StatefulSet；
- 共享实例（`optional/10-postgres.yaml`，用 `pgvector/pgvector:pg16`）供后续产品使用；
- Hub 要合并过去，走独立的显式命令，不混在部署流程里。

## 依赖健康契约

`postgres` 是 required，其余全是 optional。required 失败才影响 readiness——让 Elasticsearch 拖垮 readiness 探针会把「搜索降级但能用」变成「API 直接下线」，这正是 ADR-0005 和 Launcher 集成契约明令禁止的。`runProbes` 返回的 `degraded` 字段让运维仍然看得到 optional 依赖挂了。
