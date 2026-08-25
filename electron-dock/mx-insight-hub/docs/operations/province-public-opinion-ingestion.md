# 全国省份舆情固定源运维手册

状态：仓库实现与激活手册；截至 2026-08-24，没有任何环境连接、导入或部署完成证明。

本手册覆盖 Night-All `public.monitor_strategy_results` 到 MX Insight Hub 的首次全量、
自动增量、raw revision、规则与 Agent 派生分析、人工审核边界，以及严格 HanLP 搜索
投影。固定源的设计和公共 API 边界见
[全国省份舆情源架构](../architecture/province-public-opinion-source.md)，模型凭据和
provider 配置见 [Agent provider settings](agent-provider-settings.md)，全文索引恢复见
[Elasticsearch、HanLP、Kibana 与日志组件](search-and-observability-stack.md)。

这不是执行授权。应用 migration、安装索引、配置凭据、连接 Night-All、启动 worker、
激活源和授予消费者权限都是相互独立的运维审批。

## 1. 当前实现边界

| 层 | 仓库当前状态 | 不能据此声称的状态 |
| --- | --- | --- |
| 固定源 | migration 033 注册固定 dataset、表、mapping 和 `updated_at + id` 游标；默认 `paused` 且无物理连接。Night-All 042 提供水位合同，043 在原表增加默认 formal 的 `source_stage` | 042/043 已在目标 PostgreSQL 执行并经实库/writer-path 验证、候选 writer 已安全启用、连接已验证或已导入任何业务行 |
| Hub 服务索引 | 提供独立的 `CREATE INDEX CONCURRENTLY` 操作并在激活时校验两个精确索引 | 任一环境已经实际安装 |
| raw revision | migration 034 增加 append-only `ingest.source_object_revisions`；新 ingest 按 semantic raw SHA-256 独立于 canonical hash 产出 payload-change source revision，传输水位 `updated_at` 单独保留但不触发重分析 | migration 之前不存在的 raw 历史已被恢复 |
| 分类任务 | migration 034 注册默认暂停的 `province-geography-v1`，ingest 与当前记录 materializer 都能幂等创建任务 | pipeline 已启用、模型已配置或任务已跑完 |
| 分类 worker | `npm run classifier`、Compose service 和独立 K8s Deployment 已接线；单飞、租约、心跳、重试和 stale-input fence 已实现 | 任一环境已成功 rollout、拥有可用 Chat provider，或暂停的 pipeline 已启用 |
| 发布态 | Hub migration 035 增加 revision-fenced current state；formal 保持公开，candidate 从 pending 经质量/地理分析变为 qualified/rejected/failed，并触发 content-v5 重投影 | pipeline 已启用、候选已评估或任一环境已完成 content-v5 重建 |
| 审核证据 | assertion schema、计数和只读列表已实现；source/rule/agent/manual 状态模型已保留，原始 evidence/provider 仅限内部 | 已有人工 accept/reject 产品流程或模型 proposal 已成为 canonical 事实 |
| HanLP | 省份固定源激活/调度要求显式 `MX_COMMON_SEGMENTER=hanlp` 和 HanLP URL；常驻 content/chunk writer 与全量重建都使用严格、带 provenance 的分词包装；查询仍 fail-soft | 某环境的 HanLP、ES 或 content alias 已经健康并完成重建 |

迁移和 API 可以先发布，但固定源与分类 pipeline 都应继续保持 `paused`，直到本手册的
前置条件和验收全部完成。当前分类结果是派生证据，不是公共事实。

## 2. 数据流与故障域

```text
Night-All public.monitor_strategy_results
        │ read-only keyset: (updated_at, id)
        ▼
external-pull queue ──► Hub PostgreSQL transaction
                        ├─ current source object
                        ├─ append-only raw source revision
                        ├─ canonical current record + canonical revision
                        ├─ current publication state (formal/pending/...)
                        ├─ content projection outbox
                        └─ province analysis task
                                 │ independent, paused by default
                                 ▼
                         rule extraction ──► bounded Chat Agent if ambiguous
                                 │
                                 ▼
                         append-only assertions ──► revision-fenced publication state

content projection outbox ──► strict HanLP ──► Elasticsearch current-state index
province hot/latest/detail ──────────────────► PostgreSQL serving indexes
```

关键隔离规则：

- 模型永远不在源读取、canonical commit 或 checkpoint 路径内调用；provider 故障只会
  增加分类 backlog。
- Elasticsearch/HanLP 故障不回滚 PostgreSQL ingest，也不要求重置源 checkpoint。
- 分类 assertion 不写 Night-All，不改 canonical identity、`admin1_code`、游标或授权；
  它只更新 Hub 自有 publication state，并通过 outbox 刷新有界 content-v5 投影。
- 省份热门、最新与详情读取 PostgreSQL；严格 HanLP 影响全文/切片检索的新鲜度，不是
  这些省份接口的可用性前置。

## 3. Night-All 激活前置

### 3.1 `updated_at + id` writer contract

`created_at` 只能证明首次插入，不能发现后来补写的省份、来源、热度或 LLM 结果，禁止
作为增量游标。Night-All 仓库现在提供
`migrations/042_monitor_strategy_results_hub_watermark.sql`。该 migration：

- 将旧行 `updated_at` 回填为有限的 `created_at`，没有可用 `created_at` 时使用数据库
  当前时间；随后设置 `DEFAULT clock_timestamp()`、`NOT NULL` 和经过 validate 的
  `CHECK (isfinite(updated_at))`；
- 创建 `idx_monitor_strategy_results_hub_cursor(updated_at, id)`；
- 用 `BEFORE INSERT OR UPDATE` trigger 拒绝修改 `id`，取得 transaction-scoped advisory
  lock `(129761, 40040)`，再原子推进单行
  `monitor_strategy_results_hub_watermark_state.last_updated_at`，取数据库当前时间与旧水位
  加 1 microsecond 的较大值。锁保留到事务提交；高隔离级别遇到旧快照时必须
  serialization-fail 后重试，不能静默产生落后水位；
- 在 Night-All migration baseline 中标成必须执行，不能从“表里碰巧已有 updated_at”
  推断已经完成。

`migrations/043_monitor_strategy_result_source_stage.sql` 只扩展原
`monitor_strategy_results`：历史行默认 `formal`，候选行为 `candidate`，并带可选
disposition。它不在 Night-All 建候选产品表、评分接口或覆盖率 API。候选写入还受
`NIGHTALL_PUBLIC_OPINION_CANDIDATE_WRITER_ENABLED` 显式闸门控制。

042/043 存在和静态/领域测试通过只证明仓库意图。当前没有 Docker/真实 PostgreSQL 执行
证据，更不能证明任一目标环境已经部署。Night-All owner 必须先在目标数据库执行 042/043，
再用实库和生产等价写路径证明：

1. `updated_at` 为 `timestamp` 或 `timestamptz`、`NOT NULL`，并有已经 validate 的精确
   `CHECK (isfinite(updated_at))`；`date`、`infinity` 和 `-infinity` 都不接受。
2. 每次 insert 和每次相关 update 都推进 `updated_at`。相关字段至少包括 `province`、
   source 元数据、`published_at`、标题/摘要/链接、`heat_score`、LLM 标签/理由/置信度，
   以及将来支持的删除标记。
3. `id` 不变且唯一；索引的前导列严格为 `(updated_at, id)`。相同时间戳下由 `id`
   提供稳定全序。
4. 提交顺序不会让后提交的修改出现在 Hub 已确认 checkpoint 的同一位置或其之前。
   如果应用写入无法保证这一点，应改用有序 change journal/CDC，而不是增加 overlap
   窗口猜测。
5. 禁止不可观察的 hard delete。删除必须先成为有水位的 tombstone/change record；
   否则当前固定表 adapter 无法证明删除完整性。

042 不会擅自安装全表 hard-delete blocker，因为这会同时改变现有外键级联和清理流程。
因此第 5 项仍是部署前 writer attestation：必须核对 Night-All 清理任务、结果表删除权限
及父表级联路径；无法证明“不会删除”时保持 pipeline paused，改造 tombstone/journal 后再启用。

Hub 的 schema probe 能验证列、类型、nullability、有限值约束和索引，但不能证明应用
writer/commit 行为。Night-All owner 必须提交写路径测试证据，Hub operator 再确认
当前 API 返回的 `writerContract.version` 和 `writerContract.digest`；不要复制旧环境的
digest 或口头确认。

建议至少保留以下验收样例及其提交前后值：新增一行、只改 `province`、只改 heat、只改
LLM 字段、两个相同 `updated_at` 的不同 ID、软删除，以及并发事务反序提交。每个相关
修改都必须在严格 `>` 旧 checkpoint 的查询中可见。

目标环境至少要保存以下 042 实库证据；不要在生产业务行上直接演练 destructive update：

```sql
select column_name, data_type, is_nullable, column_default
  from information_schema.columns
 where table_schema = 'public'
   and table_name = 'monitor_strategy_results'
   and column_name = 'updated_at';

select conname, convalidated, pg_get_constraintdef(oid) as definition
  from pg_constraint
 where conrelid = 'public.monitor_strategy_results'::regclass
   and conname = 'monitor_strategy_results_updated_at_finite';

select indexname, indexdef
  from pg_indexes
 where schemaname = 'public'
   and tablename = 'monitor_strategy_results'
   and indexname = 'idx_monitor_strategy_results_hub_cursor';

select tgname, pg_get_triggerdef(oid) as definition
  from pg_trigger
 where tgrelid = 'public.monitor_strategy_results'::regclass
   and not tgisinternal;

select singleton, last_updated_at, isfinite(last_updated_at) as finite
  from public.monitor_strategy_results_hub_watermark_state;

select count(*) filter (where updated_at is null) as null_watermarks,
       count(*) filter (where not isfinite(updated_at)) as nonfinite_watermarks
  from public.monitor_strategy_results;
```

还要在生产等价测试库用正常 writer 证明：insert/update 自动推进水位；尝试改 `id` 被
拒绝；两个并发事务按相反计划顺序提交后，较晚提交者的 `(updated_at,id)` 仍严格位于
已提交者之后；`REPEATABLE READ` 写入只能得到更大水位或明确 serialization-fail。
记录 migration runner 输出、目标 database identity、042/043 checksum、上述
查询结果和并发测试，不要只截 migration 文件。最后再让 Hub 以 read-only 连接重新
probe；只有本次 GET 的 configuration issues 为空，才能提交本次返回的 digest。

### 3.2 连接和凭据边界

- 固定 locator 只能是 `public.monitor_strategy_results`、`updated_at`、`id`；API 不能
  改表名或游标列。
- Hub 源连接强制 read-only session；当前源池上限 2，连接超时 10 秒，SQL statement
  timeout 60 秒。
- PostgreSQL 主机、数据库、用户名和密码当前直接保存在
  `catalog.external_sources.connection`，没有仓库实现的列级加密或 Secret 引用。数据库
  dump、WAL、备份、只读副本和恢复介质都必须按 credential-bearing 资产管理。
- 配置连接不会自动激活源；激活源不会授予 `public_opinion` 给消费者。

### 3.3 Hub 本地前置

发布顺序是安全边界，而不是可互换的操作清单：

1. 先在 Hub 应用 migration 035，部署 formal-only 的 list/detail/search gate、publication
   state 和 content-v5 代码；保持固定源与分类 pipeline 为 `paused`。
2. 先用历史 formal 数据验证默认 API、索引回退和 MX-H2I 登录/联网 smoke。此时不应有
   Night-All candidate writer。
3. 再在 Night-All 数据库先应用并验证 042/043；两者是 additive，旧代码仍把历史/新增行
   当作原 formal 结果。保持 candidate writer gate 为 false，随后滚动升级所有 Night-All
   API/worker，使每个 reader 都具备 formal-only 条件并等待旧实例完全退出。
4. 重新 probe、提交当前 writer attestation，完成首次导入和 content-v5 全量重建。只有
   Hub 默认隐藏 candidate、显式查询及 PostgreSQL/Elasticsearch 结果一致后，才启用
   Night-All candidate writer；质量 pipeline 仍需单独的模型/成本审批后启用。

Hub migration 只会建立 Hub 自有 metadata、raw revision、publication state 和暂停的分类
backlog，不会打开 Night-All 网络连接或调用模型。反向发布（先写 candidate、后部署 Hub
gate）会把低质量候选暴露给旧 reader；禁止这样做。回滚时先关闭 Night-All writer gate、
暂停 Hub source/classifier/projector，再回退 Hub workload。已有 candidate 行不能在旧
Night-All reader 仍运行时仅靠回退代码处理。

省份源启用前必须先部署并验证 HanLP。owned K8s 环境中先执行 mx-common 的显式模型
部署流程，再部署 Hub；普通 `mx-common ensure` 不会下载/安装 HanLP 模型：

```bash
cd electron-dock/mx-common
bash scripts/manage.sh deploy hanlp

cd ../mx-insight-hub
bash scripts/manage.sh deploy
```

Hub deploy 只在发现 ready HanLP Endpoint 时写入 URL，并把 backend 固定为 `hanlp`；
首次没有 HanLP 时 Hub 其他能力仍可部署，但全国省份 pipeline 的状态会列出 HanLP
configuration issues，激活、手工 sync、scheduler 和已经排队的续页都会 fail-closed。
这不是跳过 HanLP：服务瞬时不可达时 projector 保留 pending 并退避，恢复后继续分词。
Compose/manual 环境必须显式设置 `MX_COMMON_SEGMENTER=hanlp`、可达的
`MX_COMMON_HANLP_URL`，并单独运行 projector；当前 Compose 文件不包含 HanLP/ES 服务，
不能当成完整索引环境。

`ops internal-production deploy|apply` 会在 migration Job 成功后、API/worker rollout 前，
自动把下列 SQL 流式送入共享 Hub PostgreSQL。已有精确索引时会快速跳过；创建、重建或
最终有效性校验失败时部署会 fail closed，不再依赖 operator 记住额外命令。手工/Compose
环境或故障修复仍可单独执行：

```bash
cd electron-dock/mx-insight-hub
DATABASE_URL='<Hub PostgreSQL URL>' npm run ops:province-opinion-indexes
```

该命令只应在已批准的 Hub PostgreSQL 上运行，不能包在 `BEGIN/COMMIT` 中。激活 API
会验证索引名、表、btree keys、partial predicate 及 valid/ready/live 状态，不能用一个
同名但结构不同的索引冒充。

## 4. 首次全量操作流程

下面的 HTTP 示例使用 Admin listener 和 Hub admin token。不要把真实密码提交到文档、
工单或 shell history；生产连接优先通过受控管理面输入。

```bash
HUB_ADMIN_BASE='https://<hub-admin-host>'
HUB_ADMIN_TOKEN='<hub-admin-token>'
```

### 4.1 保持两个 pipeline 暂停

先读取固定源和 Agent 状态：

```bash
curl -sS -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion"

curl -sS -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  "$HUB_ADMIN_BASE/internal/v1/admin/agent"
```

预期固定源为 `paused`，`configured=false` 或明确列出缺失连接/索引；
`province-geography-v1` 也应为 `paused`。Agent pipeline 与源 pipeline 独立，不要为了
导入数据先启用模型。

### 4.2 配置并探测只读连接

`PUT /internal/v1/admin/pipelines/province-opinion` 只接受 `connection` 和
`syncIntervalSeconds`。源必须暂停且没有运行中的 cursor。当前范围为 60–86,400 秒，
默认 300 秒。

```json
{
  "connection": {
    "host": "<night-all-pg-host>",
    "port": 5432,
    "database": "<database>",
    "username": "<read-only-user>",
    "password": "<secret>",
    "sslMode": "verify-full"
  },
  "syncIntervalSeconds": 300
}
```

保存时会实际测试连接并确认 session 为 read-only，但仍不会激活或读取业务行。随后
重新读取 pipeline，确认 fixed locator、built-in mapping、两个服务索引和 schema probe
都没有 drift。

### 4.3 审核 042/043 实库证据并提交当前 writer attestation

本步骤必须发生在目标 Night-All 已执行 042/043、实库/writer-path 证据通过，并且 Hub 用
只读连接重新 probe 之后。激活请求必须原样使用本次 GET 返回的 version/digest：

```json
{
  "status": "active",
  "writerContractAttestation": {
    "confirmed": true,
    "contractVersion": "province-opinion.writer.v1",
    "contractDigest": "<本次 GET 返回的 digest>"
  }
}
```

发送到 `POST /internal/v1/admin/pipelines/province-opinion/status`。服务会在激活前重新
检查固定源身份、连接、服务索引、built-in mapping、schema/约束/索引、checkpoint
兼容性和 attestation。任一项失败都应修复根因，禁止临时用 `created_at`、去掉有限值
约束或手工伪造 digest。042/043 的文件存在、Night-All baseline 条目或另一环境的成功记录
都不能代替目标环境证据。

### 4.4 启动一次完整 current-table alignment

源激活后，空 checkpoint 会让 scheduler 自动视为 due。为了留下明确的操作记录，也可
立即手工提交：

```bash
curl -sS -X POST \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  -H 'content-type: application/json' \
  --data '{"batchSize":200}' \
  "$HUB_ADMIN_BASE/internal/v1/admin/pipelines/province-opinion/sync"
```

固定源 `batchSize` 范围为 1–500，默认安全值 200；自动 scheduler 即使全局 external
batch 更大也会封顶 200。每个 job 只处理一个有界 batch，若正好读满，就用带 chunk
序号的 dedupe key 交接下一 job；省份源 continuation 默认延后 2 秒，
`MX_INSIGHT_PROVINCE_PAGE_DELAY_MS` 可设 0–60,000 ms。外部源队列全局 concurrency
为 1，同一源另有 session advisory lock 和 running cursor，因此 scheduler 与手工提交
不会并行扫描同一源。

operator 提供的 5,158 只是计划基线。附件 CSV 只是字段样例，不能作为行数证明；
`GET /internal/v1/admin/pipelines/province-opinion/progress` 才会显式对上游执行精确 count。
不要把昂贵 count 放入 scheduler 探测。

### 4.5 监控到全量完成

反复读取 pipeline 和 progress，直到：

- cursor 为 `idle`，position 保存最后一个精确 `updated_at + id`；
- import run 为 `succeeded`，没有 rejected rows；
- processed/remaining 与经审核的上游当前行数相符；
- canonical 数量、raw current 数量和 current source revision join 均符合预期；
- content projection outbox 正在收敛，且没有未解释的 `dead`；
- `province-geography-v1.tasks.pending` 可以增长，但分类仍保持暂停。

全量“入库完成”不等于“全文索引完成”或“分类审核完成”。三者必须分别验收。

## 5. checkpoint、raw revision 与幂等语义

### 5.1 batch commit 与 checkpoint acknowledgement

当前实现是两个可恢复的持久阶段，不是把上游读取、Hub 数据写入和 cursor 全塞进一个
事务：

1. Hub transaction 写 current raw、append-only raw revision、canonical/revision、
   projection outbox、分类任务和 import batch evidence；
2. transaction 成功后，独立 acknowledge 当前 batch 的 cursor；最后一批再把 import
   run 和 cursor 一起原子 finalize。

worker 若在阶段 1 之前失败，数据和 cursor 都不前进；若在 batch commit 之后、cursor
ack 之前退出，下次会先发现相同 `batch_key` 已提交，直接用保存的 `cursor_end` 补
acknowledge，不重新相信已经漂移的上游 page。commit outcome unknown 会保留 run/batch
供重试判定，而不是盲目跳过。

### 5.2 canonical revision 和 raw revision 是两条轴

- `core.canonical_records.current_revision` 只在 canonical content hash 变化时增长。
- `ingest.source_objects.current_revision` 由 semantic raw payload 的独立 SHA-256 驱动；
  固定源从 digest 中排除传输/运行坐标（`updated_at`、run ID、召回采集时间等），原值仍
  保存在 current raw/lineage 中。标题、摘要、来源证据、source stage、地理线索或审核
  输入变化仍会产生新 revision。
- `ingest.source_object_revisions` 保存每次 semantic raw payload 变化、其 source `updated_at` 和
  import lineage；A→B→A 会保留三个有序 revision，而完全相同的 replay 不增长。
- 只改 `llm_reason`、keywords、嵌套 raw 或其他 `_drop` 字段时，可以保持同一 canonical
  revision，但必须产生新的 source revision 和新的分析任务。
- 分析任务同时锚定 `source_object_revision_id`、canonical revision、input SHA 和
  analysis/taxonomy/rule/prompt version。旧任务在 claim 前或完成前发现新 source/canonical
  revision 时转成 `superseded`，不会提交陈旧 assertion。
- 已经成功落库的旧 assertion 仍作为 source-revision-anchored 历史证据保留；当前 writer
  不会自动把它改成 `superseded`。

### 5.3 migration 034 的历史边界

migration 之前只有 source object 当前态，没有 append-only raw 历史。migration 034
只能把当时可见的 current raw seed 为 revision 1，并把旧 canonical digest 标成 hash
version 0；它不会虚构已经被覆盖的历史。第一次新版本 pull 不会直接比较两种不同算法的
hash，而会在 PostgreSQL 中比较旧/新 semantic JSONB（省份源排除上述运行坐标）：相同则
原地采用 hash version 1 且不增加 revision/task，真正变化才形成 revision 2。后续全部按
独立 semantic raw SHA-256 判断。

source revision 是“semantic payload 变化的证据历史”，不是每次 poll 的 observation
日志；仅运行坐标变化时 `source_objects.raw_payload/source_updated_at` 会反映最新
传输位置，但 immutable revision 仍保留第一次形成该 semantic revision 时的水位快照，
不会新增 revision/分类任务，避免 Night-All 每次 upsert 推进水位时重复计费。无发布时间
candidate 的 `collected_at` 变化仍会只推进 projection revision/outbox，使 PostgreSQL 与
Elasticsearch 的候选时间窗一致，但不会重置质量状态或重复调用模型。激活前
必须在隔离环境验证 legacy hash adoption、A、仅水位变化、A→B 和
A→B→A 三组序列，并确认 current source revision 始终能 join 到 immutable payload、
raw-only 变化会产 task、相同 replay 不重复计费。任一序列失败都应保持源暂停，这不是
可以靠 checkpoint reset 绕过的问题。

## 6. 自动增量规则

首次对齐结束后使用完全相同的 source worker：

1. scheduler 默认每 60 秒扫描一次 catalog；只考虑 fixed contract 未 drift、状态
   `active`、当前 writer attestation 匹配且 cursor 为 `idle` 的省份源。
2. source 自身默认每 300 秒到期一次；可配置 60–86,400 秒。
3. 查询严格使用
   `(updated_at, id) > (:checkpoint_updated_at, :checkpoint_id)`，按相同两列升序读取；
   不做定期历史全扫，也不用 overlap window 掩盖不可靠 writer。
4. 一批中任何 row mapping rejection 都使整批失败且不前进 checkpoint。修复上游数据
   或合同后从旧位置恢复。
5. 新 raw hash 在 ingest transaction 内同时产生 raw revision 和分析 task；模型是否
   可用不参与 commit。
6. source 在运行中被暂停时，当前已提交 batch 仍会安全 acknowledge，随后 run 结束，
   不再交接下一批。

因此 Night-All 对已消费行的后补必须推进 `updated_at`。如果它把新值写在 checkpoint
之前，Hub 没有安全规则可以自动发现；普通运维不得用每日全量扫描补偿 writer 缺陷。

## 7. 规则 → Agent → 审核

### 7.1 何时创建和执行任务

- migration 034 会为迁移时已有的 current 省份记录建立暂停 backlog。
- 每个新 raw revision 在同一 ingest transaction 内幂等创建 task。
- `POST /internal/v1/admin/agent/pipelines/province-geography-v1/materialize` 可对 current
  records 做一次幂等 anti-join，补齐迁移或历史缺口；重复调用只返回 `enqueued=0`。
- pipeline 默认 `paused`。启用只影响 claim，不影响源 ingest、公共接口或 HanLP。

建议首次全量期间保持分类暂停；全量完成后先 materialize、确认 backlog 和 provider，
再以低速启用。仓库已提供 `npm run classifier`、Compose service 和独立 K8s Deployment；
K8s workload 为 1 replica/Recreate、无 Service/Ingress，使用 Hub 数据库 Secret 和可选
model-key Secret。`scripts/manage.sh deploy` 中 classifier rollout 失败只告警，不会使
API/ingest 部署失败。operator 必须检查目标环境的实际 Pod/日志/Secret/egress，不能把
manifest 存在写成“已部署并完成分类”。

### 7.2 本地规则和有界 Agent 输入

每个 task 先执行本地规则：

- explicit `province`/canonical `admin1_code` 是 source evidence；
- structured location、正文中唯一且非媒体后缀的省份命中是 event province proposal；
- publisher/media 省份与 event province 分开；
- `national`、`multi_province`、`maritime`、`overseas`、`unknown` 是独立 geo scope；
- source class 和已有 `llm_label` 分开归档。

“江苏媒体”不能自动证明事件发生在江苏；`台海`、`南海`、`黄岩岛` 不能因为字符串
包含行政区名而推成台湾或海南；URL region、query keyword 和客户端 region 不是事件
地理证据。

只有没有 explicit/structured location、正文省份命中不是唯一值，且范围没有已明确为
maritime/national/overseas/multi-province 时才调用 Chat Agent。模型不会收到整行 raw
或固定前 N 个字符，而只收到有界、去重后的语义投影：
title 最多 600 字符、summary 最多 800、source name 240、已有 reason 160，以及最多 5
个确定性候选窗口。当前 completion 上限为 256 tokens、temperature 为 0、无 tools；
system prompt 明确把 payload 当不可信数据。

Agent 返回值必须是支持的 CN admin1 code/geo scope；非空 event evidence 必须逐字存在于
event text，publisher evidence 必须存在于 source name，而且省/城市/adcode 的语义必须
与返回 code 一致。例如“南京”可支持 `CN-JS`，不能支持 `CN-BJ`；“台湾海峡”和“海南州”
也不会被字符串前缀误当成台湾/海南事件省份。非法 JSON、无效 code 或无法回指/语义
不一致的证据都会使 task 失败并重试，而不是静默落库。

### 7.3 assertion 状态和当前审核闭环

- `method=source` 的明确事实可以记为 `accepted`；built-in mapping 同时已经把显式
  province 写入 canonical `admin1_code`。
- `method=rule` 和 `method=agent` 默认只能是 `proposed`；上游 `llm_label` 也仍是
  proposal。
- correction 通过追加新 source revision/assertion 表达，不重写 raw 历史；schema 支持
  `superseded`，但当前没有自动决定并更新既有 assertion 的 writer。

当前 Admin API 可读取 pipeline 计数、最近 assertions，并通过
`GET /internal/v1/admin/agent/pipelines/province-geography-v1/assertions?limit=100`
查看最多 100 条。Hub 没有人工 accept/reject 写 API，不能用临时 SQL 冒充产品审核；
但 migration 035 已提供自动、revision-fenced 的 publication materializer：formal 保持
`formal`，candidate 依据同一 source/canonical revision 的地理与质量 assertion 变为
`qualified`、`rejected` 或 `failed`，并递增 projection revision、写 outbox。只有
`formal` 或达到阈值的 `qualified` 会进入对应公共可见模式，原始 reason/provider/evidence
始终只在内部证据层。

人工纠正仍应回写 Night-All 明确 source 字段并推进 `updated_at`，从而形成新的 raw
revision；当前没有 Hub-local manual decision 产品。publisher/dateline 只能成为
`display_admin1` 兜底，不能计作 verified event province；`overseas`、`maritime`、
`national`、`multi_province` 禁止回退 publisher。境外事件保留 country/location/geo scope，
不会塞入中国省份列。

## 8. 分类限流、provider fallback 与重试

### 8.1 分类 pipeline 限流

| 控制 | 当前值/范围 | 语义 |
| --- | --- | --- |
| `itemsPerMinute` | 默认 12，可设 1–60 | PostgreSQL 中的全局 dispatch 时间门；所有 worker replica 共享，不只是单进程 sleep |
| `maxInFlight` | 固定 1 | schema 强制单飞；增加 replica 不提升模型并发 |
| task lease | 300 秒 | worker 每 30 秒 heartbeat；每 30 秒回收过期 claim |
| task attempts | 默认 5 | 失败后约 10、20、40、80 秒退避；第 5 次进入 `dead` |
| idle poll | 1 秒 | 无 due task 时仅轮询 PostgreSQL，不调用模型 |

默认 12 items/min 时，5,158 个 task 的理论 dispatch 下限约 7.2 小时；规则命中也经过
同一 dispatch gate，但不会产生模型 token。实际 Agent provider 延迟和失败会进一步
降低吞吐。`itemsPerMinute` 是 item 速率，不是 TPM、日 token 或费用预算；当前仓库
没有 provider 级 RPM/TPM/日成本控制，也不持久化价格。模型返回 usage 时只在 task
summary 记录 token 数。容量审批不能把 12 items/min 等同于完整账单上限。

启用或调速使用 optimistic revision：

```json
{
  "expectedRevision": 0,
  "status": "active",
  "itemsPerMinute": 12
}
```

发送到 `PUT /internal/v1/admin/agent/pipelines/province-geography-v1`。必须使用刚读取的
revision；冲突返回 409 后重新读取，不可盲目覆盖另一 operator 的修改。暂停后不再
claim 新 task，但已经运行的单条会在 lease 内完成或失败。

### 8.2 Chat provider 顺序和熔断

enabled provider 按 priority 顺序尝试，每个 provider timeout 默认 60 秒、允许
1,000–300,000 ms，最多配置 8 个。以下失败会尝试下一个 provider：

- transport/timeout 和无效 JSON response；
- HTTP 401、403、404、429 和 5xx；
- 当前 provider 缺少所需 Bearer key。

其他普通 4xx（例如请求 shape/context 被拒）被视为同一个请求在其他 provider 也会
失败，立即返回 `agent_request_rejected`，不放大延迟和费用。一个 provider 连续 3 次
失败后，本进程 circuit 打开 60 秒；随后半开允许一次探测。circuit 是 process-local，
Admin API 展示的状态不等同于 classifier worker 进程的 circuit 状态。

`POST /internal/v1/admin/agent/providers/:kind/:providerId/test` 只测试指定 provider，
不会因为 fallback 成功而把首选误报健康。成功的 test 只证明 Admin API 进程能访问该
provider，不证明 classifier workload 已部署或拥有相同 egress/Secret。

provider chain 不解析 `Retry-After`，429 会立即转向下一个 provider；全部失败后由 task
级退避控制下一次尝试。若供应商长时间限流，应先暂停 classification、降低
`itemsPerMinute` 或修正 provider 容量，再统一 retry dead，不能让源 ingest 停止等待。

### 8.3 失败任务恢复

- worker crash：claim lease 到期后自动回到 pending；claim generation、worker ID 和
  completion transaction 阻止旧 worker 提交 stale result。heartbeat 丢失/异常会立即
  abort 该 claim 的 provider 调用，避免新旧 worker 重复出境和计费。
- 正常 SIGTERM/rollout：当前 claim owner-fenced 地无损回到 pending，并回退本次 claim
  attempt；部署中断不消耗内容失败预算。
- 新 source/canonical revision：旧 pending/running task 转 `superseded`；current
  revision 自己有独立 task。
- 无 Chat provider：明确规则可完成；需要 Agent 的歧义 task 失败并按预算重试，最终
  `dead`，不会猜 province。
- 修复 provider/input 后，`POST .../retry-dead` 会把该 pipeline **全部** dead task 的
  attempts 清零并重新排队。操作前先检查错误分布；当前没有单 task retry API。
- deleted record 会以 skipped summary 完成且不生成 assertion。

## 9. 严格 HanLP 分词与索引

分类 graph 本身不调用 HanLP。canonical commit 后，content outbox 和可选 chunk pipeline
分别在 projector workload 中索引：

1. Hub 未显式配置 common segmenter 参数时，专用安全默认是 live concurrency 2、
   batch size 16；显式 `MX_COMMON_SEGMENTER_CONCURRENCY`/`BATCH_SIZE` 只应在容量实测后
   提高。
2. content projector 默认每次 claim 50 个 event、lease 300 秒并每 60 秒 heartbeat，
   避免长 HanLP/ES batch 被误回收。
3. index writer 要求部署配置的精确 backend；全国省份固定源必须为 `hanlp`，未显式配置
   backend 和 URL 时激活、调度与手工 sync 都会 fail closed。
4. 每个有字母/数字的字段都校验 `backendUsed`、`degraded=false` 和非空 tokens；收到
   Jieba/bigram fallback 不写入 HanLP postings。
5. 单字段共享瞬时失败最多尝试 6 次。普通瞬时错误等待约
   250 ms、500 ms、1 s、2 s、4 s；busy/timeout/429/503 使用约
   1 s、2 s、4 s、8 s、16 s。仍失败才交还上层。
6. content projector 对 HanLP 网络、timeout、busy、429/5xx 等共享故障释放 claim 并
   抵消本次 durable attempt；loop 从 2 秒指数退避，最多 60 秒。后端恢复后自动追赶。
7. record-specific 非法响应、backend mismatch 或永久 4xx 消耗 outbox 预算，5 次后
   content event 进入 `dead`；chunk 同类失败 5 次后进入 `projection_failed_at`
   quarantine。新的 canonical revision 会建立新的可投影工作。
8. chunk/embedding loop 的共享故障从 5 秒退避，最多 300 秒；embedding provider 故障
   与 content outbox 是独立 loop。
9. strict 全量 reindex 对瞬时分词错误同样最多尝试 6 次，仍失败就终止本次操作；它
   不会偷偷切 alias，也不会自动清除已有 dead/quarantine。

查询分词有意 fail-soft：HanLP 降级时报告实际 backend/error，并切到兼容的 raw phrase
路径；fallback tokens 不查询 HanLP pre-segmented fields。修复索引滞后应恢复 HanLP/ES
并重试 projector 或执行受控 A/B reindex，绝不能 reset Night-All checkpoint。

显式 source province 的 upstream 修正会产生 canonical revision/outbox，随后按上述严格
规则进入全文索引。rule/Agent proposal 当前没有 serving projection，因此也没有需要
HanLP 索引的公共字段。

## 10. 故障恢复矩阵

| 现象 | 数据保证 | 操作 |
| --- | --- | --- |
| 连接/probe/writer contract drift | cursor 不越过不安全行；任务停止 | 暂停源；确认目标 Night-All 042/043 已执行且 trigger/constraint/index 未 drift，修复连接或 writer 后重新 probe 和 attest；不要改用 `created_at` |
| 一批有 rejected row | 整批失败，checkpoint 留在批前 | 修复源数据/固定合同；调用 province `/resume` 清除 failed 状态，位置不变 |
| transient external-pull 失败 | mxq 默认最多 5 次，lease 120 秒，30 秒 heartbeat；约 10/20/40/80 秒退避 | 观察自动重试；耗尽后 cursor 保持 failed，再用 `/resume` |
| cursor `running` 但 worker 已消失 | 小于阈值时防止误并发；静默达到 `max(10 × cadence, 15 min)` 视为 abandoned | 确认没有实际 worker/锁后调用 `/resume`；原 checkpoint 不清空 |
| batch commit 后 ack 前崩溃 | committed batch 保留 `cursor_end`；重放只补 ack | 让同一 job/run 自动恢复，不手工跳 checkpoint |
| classifier provider 全失败 | source/canonical/搜索不回滚；task retry/dead | 暂停分类，修 provider/限流，精确测试后 `retry-dead` |
| classifier worker crash | 300 秒 lease + 30 秒 reclaim；generation fence 防旧 claim；心跳失败中止 provider 调用 | supervisor 重启 worker，等待自动 reclaim；正常 SIGTERM 会无损 requeue |
| 新 raw 到达时旧分析运行 | 旧 task 标记 `superseded`，不写陈旧 assertion | 无需重跑旧 task；确认 current revision task 存在 |
| HanLP/ES 瞬时故障 | canonical 与 checkpoint 已安全提交；outbox 保持 pending | 恢复依赖并等待 projector；不要重拉 Night-All |
| content dead/chunk quarantine | poison 不再阻塞后续记录，但对应搜索投影缺失 | 修内容/分词合同；产生新 revision 或执行专门的投影恢复，不直接改 PG evidence |
| 必须从头重放固定源 | 这是显式高风险操作，不是 retry | 先暂停并 drain；POST checkpoint reset 时传 `confirmPipelineKey=province-opinion`，再重新激活/同步 |

checkpoint reset 会让 current table 从头对齐；canonical identity、raw hash 和 task unique
keys 吸收完全相同的 replay，但会增加上游、Hub PG 和 projection 负载。它不能恢复
Night-All 已 hard-delete 的历史，也不能修复不推进 `updated_at` 的 writer。

## 11. 监控与验收

### 11.1 必看状态

- fixed source：status/configurationIssues、writer attestation、cursor、latest import run、
  exact progress、两个 serving indexes；
- classification：pending/running/succeeded/dead/superseded、oldest pending、last completed，
  proposed/accepted/rejected/superseded assertions；
- provider：enabled order、keyConfigured、circuit、精确单 provider test；
- search：outbox pending/claimed/dead/lag、`chunks_pending_projection`、
  `chunks_projection_failed`、实际 tokenizer backend；
- public behavior：仅显式 source province 出现在相应 feed；缺省或 proposal 不得猜测。

### 11.2 首次上线验收清单

- [ ] 目标 Night-All PostgreSQL 已执行 042/043；保存 database identity、migration/checksum、
  finite/non-null、trigger、索引和真实 writer 证据，没有把仓库文件存在当成部署证明。
- [ ] Night-All owner 通过 insert/update、`id` 不可变、并发 commit、soft-delete 和
  `(updated_at,id)` 增量可见性测试。
- [ ] Hub source 仍暂停时完成连接 test、fixed schema probe、migration 和两个 online
  serving index 验证。
- [ ] raw revision 的 same replay、raw-only change、A→B→A 和 stale-task fence 在隔离
  环境通过。
- [ ] 激活使用本次 GET 的 writer contract version/digest，没有旧 attestation 复用。
- [ ] 首次 current-table alignment 的上游 count、canonical count、cursor 和 import
  evidence 对账；0 rejected。
- [ ] 分类保持暂停完成 backlog 估算；Chat providers 分别精确测试，token/时间/费用
  上限获批；classifier workload 的真实部署和 egress 另有证据。
- [ ] 规则/Agent assertions 抽样区分 event province、publisher province 和 geo scope；
  unreviewed proposal 不进入公共 API。
- [ ] content/chunk writer 记录实际 HanLP 且无 fallback postings；outbox dead 与 chunk
  quarantine 为 0 或每条有处置记录。
- [ ] Hub ingest、classifier、projector 任一停止时，MX-H2I 登录与已有用户联网 smoke
  均保持通过。

## 12. MX-H2I 零耦合保证

本流程只操作 MX Insight Hub 的 Admin API、Hub PostgreSQL、Hub ingest/classifier/
projector 和只读 Night-All 连接。它不需要也不允许：

- 修改 MX-H2I、Domestic/Internal、用户、session、DNS、WireGuard 或网络路由；
- 同步 Launcher Secret、重启 Launcher、重新发布 MX-H2I 或改变其登录 provider；
- 把 Agent/源数据库凭据放进 Launcher；
- 让 Hub classification/ES/HanLP 成为 MX-H2I readiness 或登录依赖。

`MX_INSIGHT_SYNC_LAUNCHER` 与本流程无关，应保持默认 `0`。当前 classifier 是无
Service/Ingress 的独立 Hub K8s workload；现有 NetworkPolicy 只约束 ingress，并没有
为 classifier 声明 provider hostname egress allowlist，所以不能虚构网络出口已经最小化。
它的 crash、provider timeout 或 backlog 不会触发 Launcher rollout。

逻辑隔离不等于共享基础设施容量无限。Hub 数据库位于共享 PostgreSQL 服务时，首次
全量、严格 reindex 和分类不要同时拉满；使用本手册的 batch/单飞/速率限制并监控 PG、
HanLP 和 ES。任何 MX-H2I 登录/联网回归都应立即停止 Hub 变更并按独立故障处理，不能
通过修改 MX-H2I 网络配置来“适配”这条数据管线。
