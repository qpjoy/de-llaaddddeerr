# 交付链路写放大：原始数据份数与 mxq.jobs 保留期（设计稿，待确认）

2026-10-21。接 [delivery-path-throughput-2026-10-21.md](delivery-path-throughput-2026-10-21.md)「仍然存在的上限」第 1、2 条。服务器的盘是消费级 NVMe，和 etcd 共用，出现过 fsync 卡顿，所以真正要省的是 WAL 量。

**状态：A 和 B 都已按用户确认实现（见下文 A、B 两节）。C 和 D 暂缓。**

## 结论

- **同步事务里的原始数据比「约 5 份」还多。** TikHub 每次调用把同一个完整响应存了 5 份：`response_archives.raw_payload`、`archive_objects` 的响应行，以及受限表的 `body_bytes`、`body_text`、`parsed_payload`。ingest 任务里还有一份逐条记录。JustOne 电商的每个商品在 ingest 任务里存了两遍：`rawItem` 和 `extensions.sourceItem`。
- **「任务里只放引用」只适用于 3 条路径：** JustOne 电商、TikHub 小红书搜索/详情/笔记、TikHub 小红书用户信息（多数记录）。其余路径（content-search 全平台、Twitter/Facebook 补页、社交账号工作流、微博补全、raw search、Qixin）的 `rawItem` 是 Hub 投影后的形状，其他表里没有逐字节相同的副本，worker 无法按 call id 还原。
- **任务格式的变更没法在一次发版里完成。** `manage.sh deploy` 先滚动 Public API 和 Admin，再建索引，最后才重启 ingest。这几分钟里，新 API 写出的引用格式任务会被旧 worker 消费，失败 5 次后进 dead。
- **推荐本轮只做两项：**
  - **A：** `mxq.jobs` 的 done 行保留 14 天，由 ingest worker 按字节预算慢慢删。
  - **B：** ingest 入库时，值没变就保留原来的 TOAST，不再每次重写。本机实测，一次未变化的 upsert 从 18 KB WAL 降到 370 字节。

  两项都不改任务格式、证据表、计费、回放、幂等和 unknown 语义。不加 env，随一次正常 deploy 生效。
- 「任务带引用」（C）和「响应存 5 份」（D）**先跑测量 SQL 再决定**。

## 先测量

```bash
kubectl -n mx-common exec -i statefulset/mx-common-postgres -- psql -X -U mx_common -d mx_insight_hub < scripts/delivery-write-amplification.sql
```

[`scripts/delivery-write-amplification.sql`](../../scripts/delivery-write-amplification.sql) 全程运行在一个 `READ ONLY` 事务里，用的是纯 SQL，没有 psql 元命令。大小按 `pg_column_size()` 统计，也就是压缩后实际存储的字节，等于插入时写进 WAL 的量；它只读 TOAST 指针，不取值。

| 段 | 看什么 | 代价 |
| --- | --- | --- |
| 1 | WAL 设置、`pg_stat_wal` 折算的每天 WAL 量 | 无 |
| 2 | 按 provider/平台/operation 统计：每次调用在各表写入的字节、24 小时合计、`archive_dup_pct`（响应归档与响应行是同一 payload 的比例） | 每个 provider 只取最近 5000 次调用，再按 24 小时调用数折算，全部走索引 |
| 3 | 按副本汇总 24 小时字节数和占比，用来和第 1 段的 `wal_per_day` 对比 | 同上 |
| 4 | 最近 200 个 ingest 任务：`rawItem`、`sourceItem` 各占 payload 多少，`raw_in_archive_pct`（与本次调用的 `archive_objects` 条目行完全相同的比例），以及 `removable_pct`（C 能省掉的比例） | 读 200 个任务 |
| 5 | 同一批对象在入库侧的大小：`source_objects` 和 canonical 的 TOAST 字节、revision 数、observation 数 | 唯一键查找 |
| 6 | `mxq.jobs` 的体积、vacuum 状态、最老一行、dead 任务分布 | 走索引 |
| 7 | 各队列 done 行按 7/14/30 天的分布，以及 14 天前 done 行的 payload 字节数（即 A 的积压量） | **唯一一次全表扫描**（只扫 heap），放在最后，可以随时 Ctrl-C |

本机 PG 17 验证：用真实 store 代码写入数据后跑过全部 7 段；在 `enable_seqscan=off` 下，第 1–6 段没有一处顺序扫描。第 2–3 段的逐调用值都是相关子查询，按唯一索引逐条查，不会被规划成大表 hash join。

怎么判断：

- 第 3 段的总量占第 1 段 `wal_per_day` 的比例，就是同步交付写入在 WAL 中所占份额的下限。
- 第 4 段 `removable_pct × stored_job_bytes`，乘上第 2 段对应路径的调用量，就是 C 每天最多能省的量。
- 第 5 段 `observations` 远大于 `source_revisions` 时，说明 B 的收益大。
- 第 7 段的 `done_14d_payload` 是 A 一次性清理积压要写的 WAL 量（见下文实测）。

## 逐路径清单

方法：用一个只读探针包住 `commitLiveDelivery` 和 `finishProviderStep`，跑 17 个网关测试文件，共 866 次结算。比较前先对两侧做 JSON 往返和键排序，等价于 jsonb 相等。测试 fixture 不等于生产数据，生产上以第 4 段为准。

| 写入 ingest 任务的路径 | provider / 平台 / dataset | `response_archives` 是否等于响应行 | `archive_objects` 条目行 | 任务里的 `rawItem` 与哪一份完全相同 |
| --- | --- | --- | --- | --- |
| `gateway.mjs` 电商搜索 | JustOne / ecommerce / `ecommerce.products.v1` | 相同 | 每个商品一行 | **条目行（7/7）**；`extensions.sourceItem` 与 `rawItem` 相同（7/7） |
| `gateway.mjs` raw search | TikHub、JustOne / instagram、weibo、facebook / `night-all.search.v1` | 相同 | 无 | 无（0/504） |
| 同上，兼容数据集 | 同上加 RapidAPI twitter、facebook / `night-all.compat.v1` | TikHub、JustOne 相同；RapidAPI 的响应归档只是 48–249 字节的占位，完整响应只在受限表里 | 无 | 部分条目出现在公开响应体里（251/378），即 snapshot 和 `usage_requests.response_body` |
| `gateway.mjs` 企业 | Qixin / enterprise | 不写 | 不写 | 受限表 `parsed_payload` 的子树（32/32） |
| `gateway.mjs` 社交账号搜索 | JustOne、TikHub / social | — | 每个账号一行 | 按代码构造与条目行相同，`sourceItem` 也重复一份（fixture 没覆盖到；另见「后续」） |
| `tikhub-gateway.mjs` 小红书搜索/详情/笔记 | TikHub / xiaohongshu | 相同 | 每条一行 | **条目行（15/15）** |
| `tikhub-user-info-gateway.mjs` | TikHub / xiaohongshu / compat | 相同 | 有 | **条目行 19/25**，公开响应体 3，无副本 3 |
| `content-search-workflow.mjs` | TikHub / 13 个平台 | 相同 | 无 | 无（0/555） |
| `twitter-search-fill.mjs` | RapidAPI / twitter | 占位 | 无 | 无（0/1163） |
| `facebook-search-fill.mjs` | JustOne、RapidAPI / facebook | JustOne 相同；RapidAPI 是占位 | 无 | 无（0/818）。fixture 里 RapidAPI 的任务 payload 是响应本身的约 6 倍 |
| `social-account-workflow.mjs` | JustOne、RapidAPI、TikHub | 相同或占位 | 无 | 无（0/167） |
| `raw-search-enrichment.mjs` | TikHub / weibo | 相同 | 无 | 无（0/2） |

所有带 `rawPayload` 的 TikHub 和 JustOne 调用里，`response_archives.raw_payload` 与 `archive_objects` 的响应行是同一个 JS 对象，`payload_sha256` 也相同（TikHub 见 `adapters/tikhub.mjs` 的 `archiveEvidence`，JustOne 见 `gateway.mjs` 的 `persistedCallEvidence`）。TikHub 受限表的 `parsed_payload` 多数与响应归档相同；JustOne 和 RapidAPI 不同，因为受限表存的是未脱敏的原文。

### 一次交付写了什么

| 写入 | 内容 | 主要读者 |
| --- | --- | --- |
| `response_archives.raw_payload` | 脱敏后的完整响应 | 结算证据核对、诊断 |
| `archive_objects` 响应行 | 同一个对象 | 结算证据核对、诊断 |
| `archive_objects` 条目行 | 每条原始条目（只有上表加粗的路径和社交账号搜索才写） | 结算证据核对 |
| 受限表 `body_bytes` / `body_text` / `parsed_payload` | 精确字节、同一字节解码成的文本、解析后的 JSON | content-search、Facebook、社交搜索的续页，以及 20 多个诊断脚本 |
| `response_snapshots.response_body` | 公开响应（缓存，后续调用会覆盖） | 缓存命中 |
| `usage_requests.response_body` | 公开响应 | 幂等回放，必须逐字节一致 |
| `mxq.jobs.payload` | 归一化记录加 `rawItem` | ingest worker、结算证据核对 |
| 异步写入：`source_objects.raw_payload`、canonical 的 `body` / `stable_fields` / `extensions` | 原始条目、清洗后字段 | **每次再看到同一条都会整列重写**，即使值没变 |
| 异步写入：`source_object_revisions`、`record_revisions` | 同上 | 只在 hash 变化时写入 |

## worker 能否按 provider call id 还原 records

- **`rawItem`：只有上表中「条目行」那几条路径可以。** `archive_objects` 只插入、从不更新或删除（全仓库没有对它的 UPDATE/DELETE），有 `UNIQUE (provider_call_id, item_ordinal)`，而且和任务在同一个事务里写入。worker 用一条走索引的查询就能取回。
- **整条 records：不行。** title、body、作者、`stableFields`、`extensions` 等字段是网关在请求上下文里归一化出来的（marketplace、指纹、凭据脱敏、补全结果）。在 worker 里重跑，等于把网关代码和上下文都搬过去，代码版本一旦不一致，写出的 canonical 就会不同。
- **投影路径的 `rawItem`：不行。** 探针还拿它们和受限表原文、公开响应体的所有子树比过（包括嵌在字符串里的 JSON），都找不到。

## 推荐改动

### A. `mxq.jobs` 的 done 行保留 14 天

**读者核对：**

| 读者 | 读什么 | 删除 14 天前的 done 行之后 |
| --- | --- | --- |
| `finishProviderStep` 证据核对（`#readProviderEvidence includeIngestJob`） | 按 `dedupe_key` 取最新一个任务，写入前后各读一次，失败后再 reconcile 一次 | 都发生在同一个请求里，秒级。全部调用方（`tikhub-gateway`、`tikhub-user-info-gateway`、`gateway`、`content-search-workflow`、`social-account-workflow`、`twitter-search-fill`、`facebook-search-fill`、`raw-search-enrichment`）都在请求路径里直接调用；ops 脚本和恢复流程都不调用它。**无影响** |
| `commitLiveDelivery` | 只插入，不读 | 无影响 |
| 去重唯一索引 `jobs_dedupe_idx` | 只覆盖 pending/running | done 行本来就不阻止重新入队。**无影响** |
| `diagnose-content-search.mjs:406`、`verify-kuaishou-search-49814.mjs:98` | `EXISTS(mxq.jobs …) AS ingest_job` | 14 天前的调用会显示 false。**一起改**：加上 `OR EXISTS (ingest.ingest_runs WHERE external_platform_call_id = call.id)`（唯一索引），入库完成本身就证明任务存在过 |
| `diagnose-telegram-ingestion.mjs` | 只看 pending/running/dead | 无影响 |
| mx-common 队列（Hub 只调用 `enqueue`、`heartbeat`、`hasOutstandingJob`、`stats` 和游标方法） | claim、reclaim、heartbeat、`hasOutstandingJob` 只碰 pending/running；`stats()` 只计数 | 管理后台 backfill 面板显示的 done 数会变成近 14 天的数量 |
| 恢复流程（admission recovery、Twitter 手动重试、Facebook 空页恢复、unknown 重试） | 都新建 usage request 和 provider call，用新的 dedupe key | 无影响 |
| dead 行 | — | **永远不删** |

**做法：**

- ingest worker 进程里加一个后台循环（新模块 `server/ingest/job-retention.mjs`），复用 worker 已有的连接池。worker 只有 1 个副本（Recreate 策略）；即使同时跑两个，删除也是幂等的。
- 每 10 分钟一轮：从最小 id 开始，按主键每次取 200 行，删掉其中 `status = 'done' AND completed_at < now() - interval '14 days'` 的行。扫到 `created_at` 还在保留期内的行，本轮结束（id 和创建时间单调递增）。不需要新索引。
- 范围是所有队列的 done 行：上面已核对过，没有读者依赖任何队列的 done 行。
- 每条语句都设 `SET LOCAL lock_timeout = '1s'`、`statement_timeout = '15s'`、`synchronous_commit = off`；提交丢了，下一轮会再删。
- 批间停顿取三者最大值：2 秒、本批耗时的 4 倍、本批删掉的 payload 字节数 ÷ 预算。预算内置为每小时 1 GiB payload（用 `RETURNING pg_column_size(payload)` 统计，不读 TOAST）。
- 不加 env，不改 mx-common 的队列 API，不改表结构。

**WAL 代价（本机实测）：** 删除本身也要写 WAL。被删行所在的 heap 页和 TOAST 页，在每个 checkpoint 周期里第一次修改时都要写整页镜像。3000 行、24.7 MB 的 payload，批量删除写了 **1.00 倍 payload 大小**的 WAL，之后 VACUUM 再写 0.04 倍。所以积压清理的 WAL 约等于第 7 段的 `done_14d_payload`。按每小时 1 GiB 的预算，约 0.3 MB/s，积压量除以 1 GiB 就是需要的小时数。稳态下每天删掉的量约等于每天新增的量。

**已实现：**

- 新模块 [`server/ingest/job-retention.mjs`](../../server/ingest/job-retention.mjs)，由 `server/workers/ingest.mjs` 启动，和其他后台循环一起随 worker 停止。
- 节奏：启动 60 秒后跑第一轮，之后每 10 分钟一轮。每一轮从上一轮停下的 id 接着扫；每 24 小时、以及每次进程重启时，从头完整扫一遍。这样当时还在 pending、之后才完成的任务也能被删掉。
- 每批的删除语句：
  - 只删 `status = 'done' AND completed_at < now() - interval '14 days'` 的行，覆盖所有队列；
  - pending、running、dead 一律不碰；
  - 窗口里出现保留期内创建的行，这一轮就停。
- 每批的其余参数：在自己的事务里 `SET LOCAL lock_timeout = '1s'`、`statement_timeout = '15s'`、`synchronous_commit = off`；每批 200 行；批间停顿 = max(2 秒, 4 × 本批耗时, 本批 payload 字节 ÷ 每小时 1 GiB)。
- 出错（含锁等待超时、语句超时）只结束本轮，下一轮从同一位置继续，不会让 worker 退出。删掉了行时，每轮打一行日志：`[ingest] job retention: deleted N done job(s), X MiB payload, in B batch(es)`。
- `diagnose-content-search.mjs` 和 `verify-kuaishou-search-49814.mjs` 里的 `ingest_job` 改为「有任务行，或 `ingest.ingest_runs` 里有这次调用」。诊断版本号保持不变。
- 测试：
  - native [`job-retention-postgres.test.mjs`](../../tests/server/job-retention-postgres.test.mjs)：只删过期的 done 行（两个队列都删）；pending、running、dead、昨天才完成的老任务和新任务都保留；每批最多 200 行，按主键顺序；按 payload 字节停顿；被其他会话锁住的行 1 秒左右放弃并保留；循环能跑完一轮，在初始等待和轮间等待中都能立即响应停止。另有停顿公式的单元测试。
  - 两个诊断脚本的 PGlite 测试：加了 `ingest_runs` 表；没有任务行、只有 ingest run 的调用读出 `ingest_job = true`。

**收益：** 表和 TOAST 不再增长，空间可以复用，备份变小。anti-wraparound 冻结扫描只需覆盖 14 天的数据；不清理的话，这些旧页迟早也要冻结一遍，同样要写一次整页镜像。

### B. 入库时值不变就保留原 TOAST

现在每看到一次同一条记录，`source_objects` 的 upsert 都执行 `raw_payload = EXCLUDED.raw_payload`，canonical 的 upsert 都执行 `body/stable_fields/extensions = EXCLUDED.*`。哪怕值完全相同，也会写一份新的 TOAST 并删掉旧的。

改成：

```sql
raw_payload = CASE WHEN ingest.source_objects.raw_payload IS NOT DISTINCT FROM EXCLUDED.raw_payload
                   THEN ingest.source_objects.raw_payload ELSE EXCLUDED.raw_payload END
```

canonical 的三列同理。UPDATE 时，如果新值就是原来磁盘上的 TOAST 指针，PostgreSQL 会直接复用它，不写新的 TOAST 块。

- **本机实测（PG 17，值约 8 KB，每轮前先 checkpoint）：** 一次未变化的 upsert，WAL 从 **18,009 字节降到 370 字节**。值变了照常替换（500/500）。
- **已实现：** `server/stores/postgres-store.mjs` 里两条入库路径都已改好：`ingestExternalRecords`（外部平台结果、Night-All 兼容、导入）和 `ingestSearchResult`（`search-result` 任务）。改动覆盖 `source_objects.raw_payload` 和 canonical 的 `body`、`stable_fields`、`extensions`。用真实 ingest 代码走完整个入库事务，每轮前先 checkpoint，「每次看到未变化的记录」所写的 WAL 如下：

  | 正文 | 改前 | 改后 |
  | --- | --- | --- |
  | 24k 随机 4 字母（TOAST 大、trigram 少） | 115,278 B | 4,823 B |
  | 1500 个汉字 | 25,163 B | 4,150 B |

  新增 native 测试 [`ingest-unchanged-toast-postgres.test.mjs`](../../tests/server/ingest-unchanged-toast-postgres.test.mjs)，两条路径各一个用例：
  - 未变化时 TOAST chunk id（`pg_column_toast_chunk_id`）不变、revision 不变，WAL 少于存储字节的 1/4；
  - 值变化的那一条照常重写、`current_revision` +1、新增 revision 行，其余记录不受影响。

  拿改前的 SQL 跑这个测试，两个用例都会失败。
- **回归：** 在同一台机器上，分别用当前 `pro` 原样代码和加了 B 的代码，在全新迁移的库上各跑一遍。
  - native：基线 110 通过 / 4 失败 / 3 跳过（117 个），加 B 后 112 / 4 / 3，多出的 2 个就是新增测试。
  - 单元：两边都是 4019 通过 / 43 失败 / 365 跳过。
  - 两个套件里失败的用例名单完全相同，都是已有失败（commercial-governance、dataport、来源目录、Twitter、小红书路由等）。文档早先记的 116/3/3 基线是更早的 `pro`。
- 不变的部分：revision 判断（仍按 hash）、`ON CONFLICT` 键、`last_seen_at`、`projection_revision`、两张 revisions 表的写入、ES 投影。
- 代价：比较时要读出旧值，这是读 I/O，通常在缓存里，不产生 WAL，也不触发 fsync。
- 覆盖所有 provider，是异步路径，但和同步交付写同一块盘。收益由第 5 段估算：`(observations − revisions) / observations` × 每次重写的字节数。
- 风险：jsonb 相等把数值相等的数字视为相等（`1.0` 和 `1`）。新值都由 `JSON.stringify` 生成，不会出现这种表示差异；即使旧行是这样存的，按值也相等。

### C.（暂缓）ingest 任务里用引用代替 `rawItem`

只适用于 JustOne 电商和 TikHub 小红书（加上社交账号搜索）。

- **做法：** store 在 `commitLiveDelivery` / `finishProviderStep` 写入之前先压缩任务：某条记录的 `rawItem` 和同一次调用某个条目行的 `rawPayload` jsonb 相等时，换成 `rawItemRef: { itemOrdinal, payloadSha256 }`；JustOne 的 `sourceItem` 与它相同时，只记一个标记。插入任务和事后核对都用压缩后的 payload，压缩是确定性的，所以 reconcile 的语义不变。
- **worker 侧：** 一条查询 `WHERE provider_call_id = $1 AND item_ordinal = ANY($2)` 取回原文，并校验 `payload_sha256` 和 `object_kind`。对不上就抛错，任务重试，最终进 dead（dead 行会保留）。
- **为什么暂缓：**
  1. 收益只覆盖少数路径，要看第 4 段这些路径在 `mxq.jobs` 字节里占多少。
  2. 按上面的部署顺序，必须分两次发版：第一次只上线 worker 的读取能力，第二次再让 API 开始压缩；或者由 worker 在 `mxq.cursors` 里写心跳，API 看到心跳才压缩。
  3. 回滚越过这个版本时，还在排队的压缩任务会被旧 worker 送进 dead。

### D.（以后）一个响应存 5 份

- `response_archives.raw_payload` 与 `archive_objects` 响应行：在 TikHub 和 JustOne 上 100% 是同一个 payload（生产数据看第 2 段的 `archive_dup_pct`），每次调用多存一个完整响应。
- 受限表的 `body_text` 就是 `body_bytes` 解码出来的（store 会校验两者一致），`parsed_payload` 是解析结果，对所有 provider 都多存了两份精确原文。
- 读者有 20 多个（content-search、Facebook、社交搜索的续页，以及诊断脚本），证据核对也会逐列比较。PG 17 没有虚拟生成列，去掉其中任何一列都要逐个改读者。所以按第 2–3 段的占比，另开一项单独做。

## 不变

计费、回放（`usage_requests.response_body`）、幂等、unknown outcome、结算证据核对（A 和 B 都不碰证据表）、同步 API 契约、MX-H2I 登录和联网、Launcher 和 Pay 配置。不加 env，没有新的部署步骤，不做数据库迁移，也不加索引。

## 确认后的测试计划

- 现有套件：结算相关（external-platform store、provider-*、各网关测试）、ingest 相关（`ingest`、`justone-ingest`、`social-accounts-ingest`、`facebook-search-ingest` 等）、mx-common 队列测试、两个诊断脚本的测试。
- native PG：跑 34 个 native 文件，基线是 116 通过 / 3 个 commercial-governance 失败 / 3 跳过。另加：
  - A：只删 14 天前的 done 行；pending、running、dead 和较新的 done 行都保留；遵守批大小和字节预算；`lock_timeout` 生效；停止信号能及时退出。
  - B：同一批记录再入库一次，WAL 差值降到百字节级，TOAST 行数不增长；值变了照常替换，revision 照常 +1。
- 本仓库网关测试有 6 个已有失败（Facebook v1/v2 unknown、Twitter data/search），和本次无关，不加探针时同样失败。

## 回退

- A：回退代码即可。已删除的只是 done 任务，canonical 数据都在，不需要恢复。
- B：回退代码即可，不涉及数据变更。

## 后续（不在本轮）

- **canonical 的每次 upsert 都是非 HOT 更新，会把整行重新插进全部 18 个索引。**
  - 原因：`last_seen_at` 有索引（`canonical_records_last_seen_idx`，`canonical_records_admin_feed_idx` 的 COALESCE 里也用到它），而每次看到记录都要更新它。
  - 后果：即使内容没变，正文也会重新进 5 个 GIN trigram 索引之一的 `canonical_records_body_trgm_idx`。本机用 18 KB 随机 base64 正文测，一次未变化的入库约 290 KB WAL，几乎全是这个 GIN；B 只省掉 TOAST 那部分。
  - 实际代价取决于正文有多少个不同的 trigram。中文能不能抽出 trigram 取决于服务器的 locale：本机 macOS 两种 locale 都抽不出，所以测不到中文的这部分开销。可以在服务器上用 `SELECT array_length(show_trgm('中文测试文本内容'), 1)` 确认。
  - 要减少这部分，得先决定 `last_seen_at` 的更新规则（例如内容未变时限制刷新频率），并核对它的读者（搜索重建进度、数据浏览、admin feed）。这是一项单独的决定。
- **社交账号搜索的 ingest 任务对不上 worker 的固定契约：** `platform` 是 `social`，`datasetId` 默认成了 `ecommerce.products.v1`，`classifyExternalPlatformIngest` 不认，所以会在 5 次尝试后进 dead。第 6 段的 dead 分布可以确认。
- C 和 D，等测量结果出来再定。
