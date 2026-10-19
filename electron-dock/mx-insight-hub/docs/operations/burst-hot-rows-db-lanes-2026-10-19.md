# Hub 突发写入：供应商热点行与数据库分道（2026-10-19）

接续 [数据 API 削峰](data-pressure-reservoir-2026-10-19.md)。上一版已经把入口等待放进内存、降低 ingest/projector 节奏、合并归档写入；本轮复核"瞬间 30 个任务×10 个请求"时数据库为何仍会拒绝服务，结论是**瓶颈不在总吞吐，而在串行化点**：同一供应商的所有请求排在少数几行上，每行锁都要等 COMMIT 落盘后才释放；而该盘（nvme0n1，消费级无 DRAM 的 Lexar NQ790，同盘还有 etcd、containerd、kubelet、Pay PG）在事故中 fdatasync 达 1.5 秒、写等待 1–2 秒。锁持有时间 ≈ 落盘时间，于是 300 个请求被串成一列，叠加 5 秒 `lock_timeout` / 5 秒取连接超时，结算失败就成了 `persistence_unknown`，管理页拿不到连接就是 500/503。

服务器还有约 105G 内存、128 核空闲，但 PG 容器限额只有 4 核 / 16Gi、`shared_buffers=2GB`。本轮用 CPU/内存换落盘次数，不降低任何已提交数据的持久性。

## 一次付费采集请求的数据库路径

通用网关（Twitter、TikHub 各平台、JustOne 等同构）每个新采集请求约 10 次读、8 次写事务：

| 阶段 | 写事务 | 串行化范围（改前） |
| --- | --- | --- |
| 预留 `usage_requests` | 1 | 按 consumer/key 的配额锁 |
| 派发租约 `dispatch_leases` | 1 | 同指纹 |
| 成本预留 `reserveProviderCostWorkflow` | 1 | **每供应商 advisory 锁**，锁内按月聚合 provider_calls（配置了价格簿预算时） |
| 令牌桶 `provider_rate_buckets` | 1 | **每供应商一行**，自动提交，持锁到落盘 |
| 开始调用 `beginProviderCall` | 1 | 同上 advisory 锁 + **`provider_state` 一行 `last_call_at`** |
| 上游 I/O | 0 | — |
| 证据/结算 `finishProviderStep` / `commitLiveDelivery` | 1–2 | **`provider_state` 一行**（成功时每次都写 `last_success_at`） |
| 释放成本与租约 | 1–2 | 每供应商 try-lock（上一版已改为不等待） |

## 本轮改动（Hub 代码）

| 改动 | 行为 |
| --- | --- |
| `beginProviderCall` 的 `last_call_at` | 只在 ≥5 秒未更新时写，并 `FOR UPDATE SKIP LOCKED`：行被占用就跳过，从不等待。调用记录本身仍是证据，`last_call_at` 只是观测值，且不再倒退。 |
| 成功结算的 `provider_state` | 只有存在待恢复字段（连续失败、熔断、错误码）或 `last_success_at` ≥5 秒未更新时才写。健康供应商的结算不再锁这一行；熔断恢复/延迟成功的围栏语义不变。 |
| 令牌桶 | 同一 SQL，改在事务内 `SET LOCAL synchronous_commit TO off`：行锁在提交记录写入 WAL 缓冲后立即释放，不等落盘。PG 崩溃最多丢最后几百毫秒的取令牌记录，效果只是令牌回到桶里。其他事务的持久性不变。 |
| 连接分道 | 每个 HTTP 请求一个 lane：数据接口在预留前为 `admission`，预留成功后升为 `inflight`；登录、回执查询、管理页、worker 为 `default`。连接紧张时先给 `default`/`inflight`（FIFO），`admission` 只在前者为空时取得连接，并按**请求到达时间**排序——同一请求的后续读取不会再排到所有更新请求后面，突发按先来先完成。等待只在内存中，不持有 PG 连接、钱包预留或供应商名额。 |
| 等待上限 | `default` 5 秒（原值）、`inflight` 15 秒（防止已派发请求因取不到连接变成 unknown）、`admission` 20 秒（慢盘上让突发按序排空，同时在 60 秒代理预算内答复）。`inflight` 不受 512 等待上限约束，其他 lane 满队即拒。 |
| 拒绝语义 | `usage_admission_unavailable`（预留在 COMMIT 前失败）与 admission lane 中的 `hub_database_unavailable` 增加 `currentAttemptStarted: false` 与 `Retry-After: 1`：本次尝试没有预留，因此没有派发；同一 key 重试仍受幂等保护。与入口的 `hub_data_busy` 同义。 |
| 连接断开报错 | `Connection terminated unexpectedly` 等无 SQLSTATE 的断连归入 `hub_database_unavailable`（503），不再是 500 `internal_error`。 |
| projector 提交 | projector 会话 `synchronous_commit=off`（`MX_INSIGHT_PROJECTOR_SYNCHRONOUS_COMMIT`，默认 `off`，`on` 恢复）。它只写自己的 outbox 领取/确认和运行记录；崩溃丢失的是 WAL 尾部，对应事件会再次投影（ES 按 id/版本幂等）。启动重建进度若丢尾部，只会从更早位置继续或让完整性检查保守失败。ingest、检索 worker、请求结算**不**使用此设置：ingest 写入的行会被 projector 读到并写进 ES，异步提交可能让 ES 留下 PG 已丢失的行。 |

`GET /internal/v1/admin/data-pressure` 的两个 pool 快照新增 `waitingByLane`（`inflightOrDefault` / `admission`）；`waitingConnections`、`acquireTimeouts`、`queueRejected`、`waitingHighWatermark` 含义不变（高水位不再把命中空闲连接的瞬时 checkout 计为等待）。

## 证据

原生 PostgreSQL 18.4 上新增 `tests/server/provider-hot-row-postgres.test.mjs`：另一会话持有该供应商 `provider_state` 行时，改前代码的 `beginProviderCall` 和成功结算都以 `canceling statement due to lock timeout` 失败——这正是突发时结算变 `persistence_unknown` 的路径；改后两者都在锁超时前完成，失败后的成功仍会恢复熔断。原有的 `commitLiveDelivery` / `finishProviderStep` 延迟成功围栏、令牌桶跨实例突发/耗尽/补充的原生测试全部通过。

## 数据库参数（热加载，无需重启）

`electron-dock/mx-common/scripts/postgres-burst-tuning.sql`，以 mx_common 超级用户执行：

```bash
kubectl -n mx-common exec -i mx-common-postgres-0 -- psql -U mx_common -d mx_common -v ON_ERROR_STOP=1 < electron-dock/mx-common/scripts/postgres-burst-tuning.sql
```

| 参数 | 值 | 原因 |
| --- | --- | --- |
| `max_wal_size` / `min_wal_size` | 8GB / 2GB（现网已热调为 4GB） | 突发时 checkpoint 曾 25 秒一次；拉长间隔减少整页镜像和脏页集中刷盘。代价是 WAL 占盘和更长的崩溃恢复。 |
| `checkpoint_timeout` | 15min（现网 10min） | 同上。`completion_target` 保持 0.9。 |
| `wal_compression` | lz4（构建不支持时 pglz） | 用 CPU 压缩整页镜像，减少 WAL 写入量。 |
| `default_toast_compression` | lz4 | 新写入的大 JSON（原始响应、归档）压缩 CPU 远低于 pglz，只影响新值。 |
| `track_io_timing` / `log_lock_waits` | on | 下次事故可直接看到每库/语句 I/O 时间和超过 1 秒的锁等待（含语句）。 |

脚本先拒绝被 `-c` 命令行固定的参数，打印前后值；所有行 `pending_restart` 应为 false。逐项回退：`ALTER SYSTEM RESET <name>; SELECT pg_reload_conf();`。这些语句已在本地 PG 18.4 验证可热加载并已复原；本机没有 psql，脚本中的 `\gset`/`\if` 元命令未在本地执行。不改 `fsync`、`synchronous_commit`、`full_page_writes`。

## 需要重启的资源调整（待决定）

以下需要修改 `mx-common/deploy/k8s/common/10-postgres.yaml`，**下一次执行 mx-common ensure（包括 Hub 标准部署中的 mx-common 步骤）就会重建 PG Pod**，所以本轮没有改清单，需要单独安排窗口。同一 PG 承载 Hub 等 mx-common 产品；MX-H2I 登录（Launcher 自有库）和 Pay（`mx-pay-postgres`）不在这个实例上。

1. **先确认 CPU 节流**：`kubectl -n mx-common exec mx-common-postgres-0 -- cat /sys/fs/cgroup/cpu.stat`，间隔 1 分钟取两次，看 `nr_throttled` / `throttled_usec` 增量。4 核限额下突发查询被 CFS 节流时，持锁事务也被暂停，表现与慢盘相同。若有明显增量，把 limit 提到 16 核（request 可保持 2）。
2. 内存 limit 16Gi → 48Gi，`shared_buffers` 2GB → 12GB，`effective_cache_size` 8GB → 40GB，`wal_buffers` 64MB。容器 limit 同时限制该 cgroup 的页缓存，现值下约 30GB 的 Hub 表和索引无法常驻内存。
3. 物理隔离仍是根治：etcd 迁出 nvme0n1（mx-base/mx-move 进行中）。PG WAL 单独放到 nvme1n1 也能隔离提交落盘，但该卷是 91% 满的根卷，需先腾空间，不建议本轮做。

## 未做与后续

- **成本 advisory 锁**：已设计并实现（未发布），见下方「供应商采购预算检查」。生产规模测量尚未执行。
- **原始数据三份写入**：每页原始响应同步写 `response_archives`、`archive_objects`，ingest job 的 payload 再带一份 records；`mxq.jobs` 的 done 行从不清理（容量回执约 174 万行）。改为 job 只引用 call id、done 行按保留期清理，可显著减少请求路径 WAL 和表膨胀，需逐 provider 核对 rehydrate 契约。
- **Delta（用户决定：不做自动重试）**：Delta 保持原有报错逻辑。v1 标准搜索对任何 5xx 仍按 key 查回执，查不到预留就停住等人工核对；v2（政情报告）收到 503 时该方向/平台按原逻辑失败。Hub 的 `currentAttemptStarted: false` + `Retry-After` 只作诊断信号，Delta 不据此重发。
- **v2 被拒请求不再记成 unknown**：`executeDataSearchV2` 原来把任何非 AppError 失败都记成协议 `unknown`，而同查询的 unknown 绑定（或未删除的过期租约）会让该 Key 之后的同一查询一直返回 `request_outcome_unknown`。现在：请求仍在 admission lane（本次没有预留、也就没有派发）且失败是数据库压力类错误时，绑定记为 `retryable`，返回 503 `hub_database_unavailable`（`currentAttemptStarted: false`、`Retry-After: 1`），同一个 key 之后可以正常再发。已预留后的失败、非数据库错误、预留 COMMIT 回执丢失、结果查询失败，仍记 `unknown`，走人工流程。结果查询和 `finish()`（含 v1 guard 的租约删除）改在最高 lane 执行，突发时也能写完，不会留下过期租约阻塞同查询。测试：`tests/server/data-search-v2-shed.test.mjs` 8 项。
- ES `refresh_interval`：Hub 索引使用默认 1 秒。若后续确认 ES merge/refresh 占用设备，可在可见性预算内调到 5–10 秒（动态设置）；本轮没有证据，未改。

### 供应商采购预算检查：月账本 + 落盘移出锁（已实现，未发布）

**串行化点拆开看。** 改前每次付费派发两次进入 `external-platform-cost:<provider>` advisory 锁（成本预留、开始调用），每次锁内：聚合该供应商本月全部 `provider_calls`；补贴项再把本月每个 usage 与 `billing.customer_charges` 关联（计划是对**整张收费表**做 hash join，随历史无限增长）；然后同步 COMMIT，锁持有到落盘。锁持有 ≈ 2 ×（聚合 + fsync）。本地 PG 18.4（笔记本、热缓存）实测聚合约 1.3 ms / 千条月调用：1 万条 13 ms、5 万条 65–78 ms、20 万条约 500 ms（work_mem 溢出）。所以即使磁盘正常，月调用上万的供应商在突发时也已排队；磁盘卡顿时 fsync 再按次叠加。只做"余额行"去掉聚合并不够：锁仍会持有到落盘。两部分都要处理。

**生产测量（只读，未执行）**：`scripts/provider-cost-budget-measure.sql`，`psql -X "$DATABASE_URL" -v ON_ERROR_STOP=1 < …`，单个 READ ONLY 事务、每条 30 秒上限、最后 ROLLBACK，不用 EXPLAIN ANALYZE、不做全表 COUNT。

1. 任何时间：表行数估算与大小；每供应商本月调用的**计划器估算**（`EXPLAIN` 不带 ANALYZE，只出计划）；`pg_stat_io` 中 WAL 的 fsync 次数/耗时（需先热开 `track_wal_io_timing`，测完可 RESET）。
2. 突发期间每秒重复第 4 段：按 `hashtext('external-platform-cost:'||provider)` 对上 `pg_locks`，给出每供应商持有/等待成本锁的会话数；`pg_stat_activity` 等待事件；若装了 `pg_stat_statements`，给出旧聚合语句的平均/最大耗时。
3. 离峰（第 5–6 段，每供应商一次索引区间，只碰本月/最近 24 小时）：本月精确调用量、usage 数、异常成本证据数；最近 24 小时峰值分钟派发数，以及其中 enforced 收费请求数（这类请求本来就绕过预算，但旧代码仍为它做全月聚合）。
4. 判定：旧代码每次派发持锁 ≈ 2 ×（聚合耗时 + 平均 fsync）；峰值分钟派发数 × 该值接近或超过 60 秒的供应商，突发时必然排队。脚本只含标准 SQL 和 `DO`（无 psql 元命令），已在本地 PG 18.4 执行验证。

**设计：预算语义逐项不变。**

1. **月账本**（迁移 163）。`provider_cost_open_usages(provider, month, usage)` 是仍需现算的请求；`provider_cost_month_totals(provider, month, currency)` 是已折叠请求的已知成本与补贴之和。`provider_calls` 每次 INSERT 由触发器在同一事务里登记 open；后台 fold 在**一条语句、一个快照**内删除可折叠的 open 行，并把这些行的贡献加进 totals（`DELETE … RETURNING` 驱动加法）。准入读 = totals + 只对 open 请求按原 SQL 现算；原查询逐列保留，只把 `monthly_calls` 的来源换成 open 请求，当前请求自己的调用改为按 usage 索引直接读。读量从 O(本月) 变成 O(open + 活跃预留)。
2. **何时可折叠**：贡献再也不会变，且没有异常证据。具体条件：usage 不是 `reserved`（调用只能在 reserved 时插入，usage 也不会回到 reserved）；该请求本月在该供应商下没有 `pending` 调用（成本证据只在 pending 时被结算改写）；收费不存在、为 shadow，或已经 `captured`/`released`（收费只随 usage 创建，定价不可变，终态不可变；覆盖额只会在释放时归零一次）；没有异常证据（`cost_kind` 非 unknown 但成本为空或 ≤0，或有成本但币种为空/非法）。异常永远留在 open。
3. **逐项对照**：已知成本 = totals + open；未知成本/异常计数完全来自 open（已折叠的请求按定义无异常；当前请求另一合法币种的行从当前请求直接读）；预留成本与预留补贴来自活跃预留，而活跃预留只属于 reserved 请求，必在 open；其他合法币种的调用仍按原规则忽略；租约过期的预留仍不计（该 CTE 未改）；客户覆盖在折叠时已是终态，与原 LEFT JOIN 结果相同；enforced 收费请求的旁路不变。
4. **护栏**（同在迁移 163）：已结算调用的成本、币种、种类不可改，不得回到 pending；调用的 provider/usage/started_at 不可改；本月及上月已折叠的调用不可删（均报 55000）。现有写入路径全部满足：结算更新都带 `outcome = 'pending'`，回收/恢复脚本只改 outcome 和错误字段。
5. **回填**（迁移 164）单独一个事务，把本月和上月已有调用的请求登记为 open。163 提交后每个新调用自带 open 行，163 之前已提交的调用都在 164 的快照里，二者之间不会漏；回填只读 `provider_calls`，不阻塞写入。
6. **fold**：`foldProviderCostLedger` 不取供应商成本锁，每供应商 try-lock（不等待），异步提交，每次最多 2000 个请求。成功预留后机会触发：连接池有空闲连接时才启动，每供应商至多每 5 秒一次，请求不等待它，失败忽略。fold 从不运行时只退化为改前的 O(月) 读，结果仍然精确。发布后到 fold 追上之前，读量与改前相同（但已不在锁内落盘，见下）。
7. **落盘移出锁**。成本预留与释放在取得供应商锁后 `SET LOCAL synchronous_commit TO off`，COMMIT 不等 fsync 就释放锁。预留只是派发前的额度占位，从不作为调用证据。派发只发生在 `beginProviderCall` 同步提交之后；该提交 flush 到自己的提交记录，必然覆盖它读到的、更早写入 WAL 的预留/释放提交记录。所以崩溃只会丢掉还没人据以派发的预留，或只让别人更保守的预留/释放。消费自己预留的 `beginProviderCall` 不再取供应商锁：它的成本只是从"已预留"转为"已知"，其他准入看到的"已知 + 预留"不变。它改为先 `FOR UPDATE` 锁自己的预留行（与同一请求的第二个调用、与释放互斥），再读状态、插入调用、同步提交。没有预留的独立调用保持原锁（生产付费路径都先预留）。
8. **对账与修复**：`scripts/provider-cost-ledger-check.sql`。第 1 段随时可跑（open/folded 规模）；第 2–3 段离峰，按 `provider_calls` 和收费重算已折叠部分并与 totals 比较，并列出不该被折叠却已折叠的调用。返回任何行即不一致。修复是对该供应商该月重新登记全部 open、删除 totals，一个事务，任何时刻都精确；SQL 在脚本头部，store 有同名方法 `resetProviderCostLedger`。

**证据**（原生 PG 18.4，完整迁移，新增 `tests/server/provider-cost-ledger-postgres.test.mjs`）

- **与原聚合逐列一致**：原聚合 SQL 原样保存在测试中作为 oracle。随机模型走真实计费触发器：enforced 收费的 reserve→captured/released/unknown 及 unknown 的人工对账；九种成本证据形态（正常、供应商回报改价、未知成本、他币、空成本、零成本、空币种、非法币种、rejected）；预留、消费、释放；随机 fold 与 reset。每一步在同一 REPEATABLE READ 快照里比较新读法与 oracle。8 个种子各 320 步、约 2000 次比较，全部一致；`describeCostBudget` 与其原 SQL 也一致。准入决策是这一行的纯函数，行相同即 admit/refuse 相同。
- **可折叠条件逐项**：pending 调用、仍 reserved、收费 unknown、异常证据都留在 open；captured（报价 150 覆盖成本 100，补贴 0）与 released（覆盖归零，补贴 100）折叠后 totals 为已知 200 / 补贴 100；护栏拒绝改写、回到 pending 和删除。
- **并发**：20 条历史（一半已折叠，一半在并发结算/提交），后台连续 fold，40 个请求争抢剩余 12 份额度：恰好 12 个获准，其余全部 `external_platform_cost_budget_exhausted`，本月总花费恰好等于预算。同一请求的两个调用并发消费同一预留：5 轮都只有一个成功，另一个 `reservation_mismatch`（预留行锁替代供应商锁后仍不会超用）。
- **锁**：另一会话持有供应商成本锁时，带预留的调用和 fold 在 1 秒锁超时内完成；无预留调用和新预留仍等这把锁（55P03）。
- **慢盘**：`commit_delay=100ms`（每次 flush 前固定等待，模拟卡盘）下 10 个派发 < 1 秒；持锁过两次落盘需 ≥ 2 秒。
- **回滚与崩溃**：插入调用后回滚不留 open 行；以 ROLLBACK 结束的 fold 不改账本。崩溃用例需显式开启并独占服务器（`MX_INSIGHT_TEST_PG_CRASH=1`、`MX_INSIGHT_TEST_PG_CTL`、`MX_INSIGHT_TEST_PGDATA`）：12 路并发跑到 400 个派发的约 1/3 时 `pg_ctl stop -m immediate`，重启后每个已确认的调用及其异步提交的预留都在，账本与 oracle 一致；5/5 次通过（每次约 136 个已确认）。
- 回归：原有成本、清理、热点行相关测试 84 项通过。mock 测试按新语句更新了断言：两处严格释放仍不设超时、不用 try-lock，但会设异步提交；三个预留用例接受锁后的异步提交；带预留调用的用例断言不取供应商锁、先锁预留行。全量 server 测试（无原生库）失败 38 项，用加载钩子换回改前的 store 后失败集合完全相同（即前文记录的既有失败）。原生库子集（34 个文件，串行，新建并完整迁移的库）：本轮 116 通过 / 3 失败 / 3 跳过；换回改前 store 为 113 / 6。3 项共同失败都在 `commercial-governance` 计费 fixture；改前多出的 3 项正是本轮新增的慢盘、锁外两例和更新后的严格释放断言，说明这些用例确实能区分新旧行为。typecheck 通过。
- 复核（新建 PG 18.4、完整迁移含 163/164）：全量 server 测试失败集合仍与基线的 38 项完全相同；原生/PGlite 相关 159 项中 126 通过、0 失败、33 跳过（PGlite 或专用配置）；崩溃用例单独再跑通过（135 个已确认派发全部持久，预留 136）。两个 PGlite 夹具（`twitter-fallback-postgres`、`youtube-comments-cost-scope`）手工列迁移，需加入 163，否则成本预留读不到账本表；已补。

**本地基准**（同一供应商 30 个并发派发，各自预留 + 开始调用；"改前" 为本轮之前的代码，月调用、收费按 40% enforced 合成；commit_delay 模拟每次 flush 的固定延迟）：

| 月调用 | 每次 flush 附加延迟 | 代码 | 单次预留 / 开始调用 (ms) | 30 个并发派发总耗时 (ms) |
| --- | --- | --- | --- | --- |
| 10,000 | 0 ms | 改前 | 12.4 / 12.6 | 982 |
| 10,000 | 0 ms | 本轮（已折叠） | 2 / 2.4 | 167 |
| 10,000 | 0 ms | 本轮（发布后 fold 前，全部 open） | 17.4 / 17.9 | 697 |
| 10,000 | 20 ms | 改前 | 44.5 / 45.8 | 2,732 |
| 10,000 | 20 ms | 本轮（已折叠） | 5.2 / 27.4 | 278 |
| 10,000 | 20 ms | 本轮（发布后 fold 前，全部 open） | 22.7 / 43.3 | 871 |
| 10,000 | 100 ms | 改前 | 164.4 / 148.3 | 8,592 |
| 10,000 | 100 ms | 本轮（已折叠） | 7.9 / 109.1 | 247 |
| 10,000 | 100 ms | 本轮（发布后 fold 前，全部 open） | 49.8 / 129.8 | 947 |
| 50,000 | 0 ms | 改前 | 77.8 / 81.9 | 5,412 |
| 50,000 | 0 ms | 本轮（已折叠） | 2.1 / 2.5 | 167 |
| 50,000 | 0 ms | 本轮（发布后 fold 前，全部 open） | 107.6 / 129.1 | 3,615 |
| 50,000 | 20 ms | 改前 | 131.7 / 129.3 | 8,696 |
| 50,000 | 20 ms | 本轮（已折叠） | 4.3 / 25.8 | 215 |
| 50,000 | 20 ms | 本轮（发布后 fold 前，全部 open） | 114.1 / 136.3 | 3,814 |
| 50,000 | 100 ms | 改前 | 236.7 / 226.7 | 15,212 |
| 50,000 | 100 ms | 本轮（已折叠） | 10 / 110 | 242 |
| 50,000 | 100 ms | 本轮（发布后 fold 前，全部 open） | 141.1 / 225 | 4,008 |

读法：改前的总耗时随月调用和 flush 延迟同时上升（两者都在锁内）。"全部 open" 一行只去掉了锁内落盘：无附加延迟时快 1.4–1.5 倍，flush 延迟 20–100 ms 时快 2.3–9.1 倍。fold 追上后，单次预留降到约 2–10 ms，30 个派发总耗时不再随月调用或 flush 延迟增长；开始调用的耗时仍包含它自己的一次同步 flush（这是派发前的证据要求），但多个调用可以合并 flush。数字来自笔记本热缓存，只作相对比较。

**发布与回退**

- 迁移 163（建表和触发器，持 `provider_calls` 的 SHARE ROW EXCLUSIVE 锁，毫秒级）和 164（回填，只读扫描最近两个月）。必须在新 Pod 之前执行（标准 Hub 迁移 Job），两者不能合并成一个事务。旧代码在新 schema 上无感，只多一次 open 行插入。
- 回退：还原代码即可，表和触发器可保留。要彻底撤除需新增迁移删除触发器与两张表（不要改已应用的迁移）。
- 发布后：先跑 `provider-cost-ledger-check.sql` 第 1 段，确认 open 随 fold 下降；离峰跑第 2–3 段，应无行；突发时测量脚本第 4 段的成本锁 waiting 应接近 0。

**限制**：UTC 月初切换未用可控时钟测试（读法与原 SQL 用同一个 `now()` 月界；open 按 `started_at` 所在月登记；回填含上月）。本地基准不代表生产 4 核限额和 nvme0n1 的设备超时；`commit_delay` 只模拟固定 flush 延迟，不模拟 walwriter 与设备队列争用。fold 只在有成功预留的 Hub 进程里触发，长期无付费请求的供应商 open 集合不变（只影响它下一次准入的读量）。生产测量和对账脚本都未在生产执行；本会话未连接生产或付费上游。

## 发布、观测与回退

按 Hub 标准流程发布，继续 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`；以上热点行/分道改动无迁移、无 DDL（供应商采购预算检查另含迁移 163/164，见上）。

部署前须知（`ops internal-production deploy`）：

- 镜像从**工作树**构建，会带上所有未提交改动（含另一会话的 Twitter v2 重试与迁移 162）；建议先提交，部署内容可追溯。
- mx-common 清单未改，`ensure` 不会重启共享 PG；三个迁移只新增表、列、触发器和回填行，不改写或删除既有数据。迁移失败时部署在滚动前停止并恢复 Admin，旧版本继续运行（已提交的 163 与旧代码兼容）。
- 迁移 Job 的 `activeDeadlineSeconds` 为 240 秒，164 要全表扫描 `provider_calls`（PG16 无法按 started_at 单独走索引）。先读规模：`SELECT reltuples::bigint FROM pg_class WHERE oid = 'external_platform.provider_calls'::regclass;` 数百万行以内正常；更大时先离峰手工执行 164 再部署。
- 162/163/164 都设 `lock_timeout 5s`：有长事务时迁移失败而不是让所有写入排队。部署前确认 `pg_stat_activity` 中没有超过 30 秒的 Hub 事务。
- public/admin/projector/ingest 都是单副本 `Recreate`：public API 会中断约数十秒，进行中的付费请求被切断后按 unknown/回执查询处理。选在没有政情报告批量运行的时段。
- 发布前确认控制面稳定（controller-manager、scheduler Ready 且 Lease 持续续租，etcd 无秒级 fdatasync）；否则 Admin 冻结会卡住。
- 新版本启动后 fold 会在后台追平迁移 164 登记的 open 行（每供应商至多每 5 秒处理 2000 个、异步提交），追平前准入读量与改前相同。

发布后观察：

- `GET /internal/v1/admin/data-pressure`：突发时 `waitingByLane.admission` 上涨而 `inflightOrDefault` 保持低位、`acquireTimeouts` 不再伴随 unknown，即分道生效。
- 执行调参脚本后 PG 日志中的 `still waiting for ... lock`（log_lock_waits）应不再出现 `provider_state` / `provider_rate_buckets`；`pg_stat_bgwriter` 中 `checkpoints_req` 占比下降。
- 同窗口仍需核对 nvme0n1 `w_await`、etcd fdatasync 与 Lease 续租；软件减少落盘次数不能修复设备本身的超时。

代码回退：还原本轮提交即可，热点行/分道改动无数据结构变化（采购预算账本的回退见上节）。projector 可单独设 `MX_INSIGHT_PROJECTOR_SYNCHRONOUS_COMMIT=on`。不涉及 MX-H2I 登录/联网、Launcher、SSO、Pay 或网络配置。

## 验证

- 连接池单元测试 18/18（分道顺序、按到达排序、inflight 不受等待上限、超时、结束时拒绝等待者、HTTP 503 语义、projector 会话设置）；原有池语义测试全部保留。
- Hub 全量 server 测试：失败集合与"当前工作树去掉本轮改动"的基线完全相同（38 项既有失败，涉及 Night-All 限流 fixture、公共目录、小红书路由等，均与本轮无关）。
- 原生 PG 18.4（临时实例，完整迁移）：原有原生测试 96 项通过、0 失败；新增热点行测试 3/3，改前代码 2 项以锁超时失败。开启原生 PG + PGlite 跑全量时，额外失败中 5 项在基线同样失败（测试 fixture 列名漂移等），2 项为多文件共用一库的并发干扰、单独运行通过，1 项为断言旧实现的高水位假象，已更新。
- 部署脚本 shell 测试 171 项通过；类型检查通过。
- 测试均使用合成数据、离线 fixture 和隔离数据库，未连接生产或付费上游。本地结果不代表生产 100 QPS 的持续吞吐，也不代表 nvme0n1 的设备超时已经消除。
