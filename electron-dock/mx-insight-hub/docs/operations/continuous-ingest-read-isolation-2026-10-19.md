# 持续同步与检索读写隔离

2026-10-19。目标是让 Night-All-A、全国省份舆情、TG 三条必需 pipeline 持续同步，并逐步恢复后台向量化、容纳后续计划。用户接受 TG 约 5–15 分钟的数据延迟；这是待验收目标，不是已经达到的 SLO。临时暂停用于本次故障排空，不能成为长期运行方案。

先在现有硬件上降低无效写入、控制批次节奏并测量。用户未承诺增加硬件；NAS 只承载 Delta 媒体，本方案不迁移 Hub 到 NAS。全程保留 MX-H2I 登录/联网、SSO 与支付边界。

## 现状与边界

Hub 已有逻辑上的读写分离：PostgreSQL 保存权威数据和任务状态，outbox 驱动 ES 内容投影，embedding worker 生成向量并维护投影；API、ingest、projector、retrieval 分进程运行。这是 CQRS 的逻辑分工，并非物理 I/O 隔离。

`server/index.mjs` 的 store/API pool 与 `server/retrieval/pool.mjs` 仍连接同一 PostgreSQL。独立 pool 可限制连接竞争，不能隔离 WAL、checkpoint 或磁盘排队。现网已确认共享 PG 与 etcd 在同一 `nvme0n1p1`，该设备曾出现内核 I/O timeout；后续短时延迟下降不能证明底层故障已消失，详见 [故障证据](admin-freeze-controller-2026-10-19.md)。14Z Hub 请求与 17Z 控制平面慢仍不能直接归为同一原因。

本地 mx-common 定义为单 PG、单 ES；PG/ES 的 hostPath 使用同一数据根下的不同目录，但现网 ES 的设备映射尚未确认。PVC 的 50Gi 声明不是 hostPath 用量或硬配额。TG 的约 186 万 `processed_count` 是累计处理数，不是去重内容数、向量数，也不能单凭它判定 ES 是瓶颈。

## 第一阶段：本轮软件减载

以下为本轮代码方案；本地测试、部署与线上效果分别验收，不把工作区改动写成已上线。

| 改动 | 默认行为及边界 |
| --- | --- |
| external-pull 页间调度 | 通用/Night-All-A 与 TG monitor 续页 `runAt` 延后 1000ms；省份舆情保持 2000ms，TG SQLite 保持 1000ms。延迟期间释放执行槽，其他就绪源可以推进。 |
| retrieval 租约检查 | 阶段检查改为主库 `SELECT` 验证 token、running、未过期；典型短记录路径减少 7 次重复租约 UPDATE。已有每 30 秒作业 heartbeat 继续续租；worker 遥测 heartbeat 是另一条 10 秒路径。 |
| external-pull worker 批次间让步 | 单 worker 批次结算后，延后 1000ms 再领取，并发仍为 1；不拖慢前台搜索结果 ingest 或旧 backfill 队列。本地回归已通过，线上效果待验收。 |

页间配置：`MX_INSIGHT_EXTERNAL_PULL_PAGE_DELAY_MS=1000`、`MX_INSIGHT_TELEGRAM_MONITOR_PAGE_DELAY_MS=1000`；省份沿用 `MX_INSIGHT_PROVINCE_PAGE_DELAY_MS=2000`，TG SQLite 沿用 `MX_INSIGHT_TELEGRAM_SQLITE_PAGE_DELAY_MS=1000`。批次间让步为 `MX_INSIGHT_EXTERNAL_PULL_WORKER_DELAY_MS=1000`。这些是毫秒级调度间隔，不是端到端延迟承诺；多个 worker 仍可能并行，其他队列、reclaim、遥测继续工作，不能将它们当全局 I/O 限额或全库零 I/O 间隙。

保持现有批次身份、映射、幂等去重、已提交批次记录、checkpoint 与失败续接语义。不得为提速提前推进 checkpoint、重新扫描全库或关闭持久性设置；也不把已有 external-pull 续接保证套到所有旧 Night-All backfill 路径。

新计划先复用上述持久队列与有界分页。后续若采样仍显示源间饥饿，再实现按源公平调度及共享写入预算；本轮不能宣称已具备全局公平或磁盘自适应限速。

## 恢复持续运行

1. 确认 controller-manager/scheduler 稳定续租、现有服务可用，按标准流程部署软件优化；继续 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`，不绕过 Admin 冻结或强删 Pod。
2. **先恢复 TG 低速持续同步**：从 Internal 的 TG pipeline 管理入口激活，使用既有合同和 checkpoint 校验；需要恢复停止状态时走 `resume`，不 reset 游标。核对两子源及续页都能推进，避免只把页面状态改为 active。
3. 保持或恢复 Night-All-A、全国省份舆情的持续调度，分别核对每源最近成功批次、待处理年龄及失败原因。保留各自页间节奏，历史追赶逐步推进，不同时触发额外全量重建。
4. 三条同步稳定后，经现有 Internal 向量设置入口恢复 embedding，先 `maxConcurrency=1`，保留既有预算语义。`dailyTokenBudget=0` 代表无日预算上限，必须通过现有在线 worker/资源 guard 校验；不得用 SQL 直接改 paused 绕过这些门槛。
5. 保留历史 catch-up 位置与增量任务，保底删除/retire 投影继续工作。先观察并发 1，再决定是否提高；“恢复向量”不等于重新发起全库初始化，也不使用 cancel 来代替限速。

每次只提高一种负载。若持续出现队列年龄增长、WAL 等待或控制面续租异常，先降低批次速率/向量并发，保留源低速进度；严重存储故障时记录明确阻塞和临时处置，不以永久 paused 宣称完成持续同步目标。

## 验收与容量口径

| 指标 | 定义与用途 |
| --- | --- |
| TG 新数据延迟 | 源变更已持久化且可由合同读取，到 Hub 对应版本可检索的时间；拆为排队/拉取、canonical 提交、ES 投影与 refresh。目标 5–15 分钟，需连续窗口验收。 |
| 历史追赶 | 剩余范围、最老待处理年龄、每小时提交/变化记录数；与新数据延迟分别记录，不能用旧消息 event_time 当同步等待。 |
| 向量延迟 | canonical 版本提交到同 revision 的向量可检索；独立于全文可见时间，同时跟踪 tokens、依赖限流和失败重试。 |
| 数据规模 | canonical/chunks 的表与索引字节、近似去重行数、每日变化量；ES 有效文档、主分片/副本、store、旧 generation 与 merge 峰值。 |
| 数据库压力 | 每窗口 WAL bytes、checkpoint 次数/耗时、临时文件增量、连接等待、慢阶段与 SQLSTATE；累计值必须用差分和统计重置时间解释。 |
| 服务与控制面 | canonical/Luopan/Delta 耗时分位、504/503、各源进度；同窗设备延迟/队列、etcd fsync 延迟、Lease 推进和组件重启。 |

源没有可靠变更时间时，标记端到端延迟不可精确计算；可报告 checkpoint 进度和源/Hub 观察时间，但不能伪造 5–15 分钟达标。回填与晚到数据要单独归类。

已有 `server/scripts/retrieval-capacity.mjs` 可做只读容量采样：表/索引大小、planner 估计、有限正文样本计算后的汇总及 ES 元数据；默认不调用 embedding。样本估算不等于全量普查，向量裸字节不包含 HNSW、正文、WAL、临时空间和旧索引。不要在生产做全库 COUNT、EXPLAIN ANALYZE 或存储压测来取得第一轮数据。

本轮同时补齐 Hub alias、实际 refresh/shard/replica 设置、索引 indexing/search/merge/refresh 与节点 heap/GC/I/O/write rejection 指标。固定 9 个顺序 GET，逐请求 10 秒上限；部分指标失败保留其余证据，错误正文不外泄。节点计数包含其他业务，累计值需要间隔对照；alias 按名称前缀筛选，不能据此认定未出现的旧索引没有其他读者。`scripts/inspect-retrieval-capacity.sh` 的独立实现同步更新，拉取代码后可在旧 Admin 镜像上运行；7 项离线回归及语法检查通过，未执行线上设置修改。

持续吞吐至少要覆盖三源新增速率，并留出历史追赶、查询和删除余量；增加计划前先测该计划变化量和每批资源成本。未取得这些数据前，不承诺最大计划数、向量完成日期或新硬件规格。

### 首次真实容量回执

操作者提供的只读报告时间为 `2026-10-18T18:58:31.608Z`；以下 GB 按十进制字节换算，行数/文档数保留各自口径。

| 对象 | 报告数量 | 存储 |
| --- | --- | --- |
| PG `canonical_records` | planner 估计 2,902,099 行 | 表 5,672,345,600 + 索引 5,194,596,352 bytes，合计约 10.8669 GB |
| PG `record_chunks` | planner 估计 2,213,327 行 | 表 8,315,117,568 + 索引 415,105,024 bytes，合计约 8.7302 GB |
| PG `jobs` / `run_items` | planner 估计 1,744,004 / 2,500,558 行 | 连同上述两表，四表及其索引合计约 20.6975 GB；不是整个 PG 实例用量 |
| Hub ES `content-v6-current` | `docs.count` 2,416,398 | 约 7.6691 GB |
| Hub ES `chunk-v2-current` | `docs.count` 2,219,695 | 约 9.6041 GB |
| Hub 其余 v1/v2/v3/v4/v4-rebuild/v5/v5-rebuild 索引 | 本次不合并文档数 | 约 11.7655 GB；全部所列 Hub 索引合计约 29.0387 GB |
| ES allocation 汇总 | 32 shards，为全 ES 集群口径，不是仅 Hub | 所有索引约 29.1154 GB；设备使用率 33%，可用 1,330,367,852,544 bytes |

回执中所列 Hub 索引均为 1 主分片、0 副本；向量 mapping 为 512 维、`int8_hnsw`、`m=16`、`ef_construction=100`。报告中的环境维度为 null 不代表没有向量，实际 mapping 已提供上述证据。

PG planner 估计、当前逻辑可见记录与 ES Lucene `docs.count` 不是同一计数；后者还可能包含 nested 文档，不能直接用 PG/ES 数量差判定丢数据或投影滞后。[Elastic CAT indices 计数说明](https://www.elastic.co/docs/api/doc/elasticsearch/operation/operation-cat-indices)

本次 2000 条样本估算约 166 万 chunks，低于 PG 已有约 221 万 chunks，不能当作全量容量或剩余待向量化数量。旧 generation 的 alias、读者及回滚用途尚未检查，11.7655 GB 不能标成可安全删除空间。设备空余充足只支持容量判断，不能证明 I/O、refresh/merge 或查询延迟没有瓶颈。

## 第二阶段：明确的只读候选查询

此阶段是设计，尚未实现读副本接线或部署 standby。保持现有主库 URL；新增 reader 必须是显式、默认关闭的查询组件依赖，不按 HTTP GET/POST 粗分，也不替换整个 store、search 或 retrieval pool。

| 路径 | 归属 |
| --- | --- |
| SSO/API Key、权限/撤销、钱包、配额、幂等、committed/released/unknown 与请求状态 | 主库，必须看到当前权威状态 |
| 队列领取/心跳、ingest 批次/游标、outbox、向量任务与 revision 写回 | 主库，不拆事务、不双写 |
| 耗时的内容过滤/排序/候选 ID | 明确允许延迟的路径才可用 standby |
| 最终正文、删除/发布状态、dataset/platform/object scope 与 revision 确认 | 主库按候选 ID 有界批量复核 |
| 高级检索召回 | 继续 ES；当前主库证据复核、并发租约、snapshot/audit 均保留 |

目标链路为：主库授权/预留 → standby 选候选 ID → 主库验证并读取当前内容 → 主库结算。副本暂时没有新记录会影响召回；主库复核能拦住已删除/失效内容，不能补齐副本漏召回。因此必须显式定义可见性时间、空页及精确总数契约，不能把旧总数冒充当前精确值。

分页须测试副本切换、被过滤候选、排序字段变化；游标绑定读取模式，并按已扫描候选推进。账务状态查询仍只读主库，副本缺行不得解释为未派发或触发供应方重试。

reader 验收包含数据库/集群身份、schema、只读角色、真实 standby、复制进度及超时；URL 不同不证明独立设备。复制滞后结合主库 LSN 与 replay LSN，主库空闲时不能只看最后 replay 时间。写后即读继续主库，或将来实现有界 LSN fence。[PG 流复制](https://www.postgresql.org/docs/16/warm-standby.html)

standby 故障/过旧时有界返回不可用，不能把全部重查询自动倾倒主库；可另设小并发显式兜底。长查询可能与 WAL replay 冲突，盲开 `hot_standby_feedback` 会带来主库膨胀风险；副本也有 replay、数据页及临时文件写入。[PG Hot Standby](https://www.postgresql.org/docs/16/hot-standby.html)

现有 PG StatefulSet 没有复制初始化，**不能把 replicas 改成 2 当作读写分离**；其 Service 会选中相同 label 的实例，manage ensure 也固定恢复为 1。真正部署需独立 primary/reader 入口、复制及 WAL 保留策略、初始化 I/O 预算和失败演练，不在本轮顺带执行。

## 物理隔离的后续门槛

在现有硬件上先完成软件减载与连续采样。若仍有同盘长尾延迟，优先评估把 etcd 放在独立且已验证健康的 SSD/主机，随后再评估 PG/ES 隔离；这是后续资源与维护方案，不代表已经授权搬盘或采购。etcd 对落盘延迟敏感，共享负载可影响控制面稳定性。[etcd 硬件说明](https://etcd.io/docs/v3.6/op-guide/hardware/)

同一异常磁盘上的 standby 会额外 replay 写入，不能消除主库 TG/向量写入，也不是物理隔离。现有 `mx-common manage.sh migrate-storage` 会停止 PG/ES/Redis，不适合直接用于此次持续同步优化；Launcher、支付和容器运行时共盘，不能随 Hub 操作一并迁移或重启。

ES 是否需要调优须由搜索/写入耗时、bulk 拒绝、refresh/merge、heap、分片及实际设备证据决定。可在明确可见性预算内评估 bulk 大小与 refresh 间隔，不在活跃索引上盲目关闭 refresh 或执行 force merge；保持稳定 ID、版本和删除语义。[Elastic 索引性能说明](https://www.elastic.co/docs/deploy-manage/production-guidance/optimize-performance/indexing-speed)

NAS 的 Delta 媒体迁移与以上数据库/控制面隔离是不同事项；它不是本轮 Hub 延迟的已证原因，也不是本方案的数据库目标盘。

## 完成条件

本地最终验证：mx-common 120 项通过、1 项既有 skip；Hub external 117/117，此前包含 external/SQLite/pacing 的相关套件 165/165；retrieval 59/59；manage shell 170/170；typecheck 通过。post-batch 与 Hub 接线的独立复核 16/16 通过，覆盖结算后等待、并发批次收尾、stop/abort、默认 0 与配置边界；这些计数存在覆盖重叠，不相加为唯一测试总量。

本轮交付需有软件回归结果、目标版本部署回执、TG 低速恢复和三源持续推进证据，再验收向量并发 1。仅本地测试通过、页面显示 active 或短时无 WALWait 都不代表持续目标达成。读副本与物理隔离单独进入后续实现和验收，不计为本轮已经上线。
