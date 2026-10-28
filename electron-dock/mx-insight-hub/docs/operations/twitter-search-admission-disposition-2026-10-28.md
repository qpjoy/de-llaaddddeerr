# Twitter 历史未知请求与后续采集恢复

## 本次生产证据

Delta Run `106978` 的 HTTP 请求 `730a3f06-3c06-42c1-a096-108e790b811d` 收到 `409 search_admission_blocked`，明确 `dispatchState=not_started`，阻塞请求为 `567255e8-fef1-4471-9dd9-1247f068bc99`。前者是本次 HTTP 关联 ID，没有采购 usage 并不表示诊断数据丢失。

用户导出的阻塞请求报告确认：北京时间 2026-10-28 06:01:42–06:02:12，RapidAPI `twitter-aio.search` 调用 `f2540fd6-a661-4616-b6ba-c595c868c9e6` 在 30002ms 后记为 `unknown / social_upstream_timeout_or_size_limit`；HTTP、业务码、供应商 billed 均为空，没有可回放正文。`hasArchive=true` 不是已保存响应正文的证明。客户结算 `unknown`、报价 CNY 1 minor、已扣 0、未结算，不代表预占已释放或供应商免费。

用户的只读重试准备确认这是 `/api/v2/data/search`，第一页、20 条、fresh，冻结窗口为 `2026-10-25T16:00:00.000Z` 至 `2026-10-27T22:01:41.818Z`。本次选择**优先恢复后续正常采集**，不补采原页，不将历史结果改成成功、失败或已释放。该报告界定了阻塞链条，不能区分上游、代理或具体传输阶段的超时原因。

## 实现与保护边界

迁移 `166_search_admission_dispositions.sql` 新增独立、不可修改/删除的 `control.search_admission_dispositions`。管理员只能处置一个精确的历史 Twitter 标准搜索 usage UUID；记录原 tenant、consumer、API Key、查询哈希、请求指纹、证据版本、操作者、原因和确认时间。

准备阶段使用只读一致性事务。确认阶段按原 key、query 锁与行锁重读证据，比较准备版本后只插入处置记录；相同确认重复提交返回原记录，证据变化或不同确认产生冲突。缺少完整参数/调用归属、仍有 pending 调用、协议租约、running binding 或原请求活跃派发占用时拒绝处理。旧游标到期不代表原结果已知，也不妨碍在完整证据可验证时处置未来准入。

协议级准入、Twitter 编译等价查询检查、RapidAPI fill、TikHub content-search 和供应商派发前的未知结果检查共同识别此记录。处置只排除该精确旧 unknown，其他未知请求、pending、活跃租约、响应解析隔离、权限、预算和费用控制继续生效。没有历史 blocker 的正常路径不读取处置证据；缺少新增表时维持原保护。

原 usage、provider call、协议 binding、客户 hold 和账本不改变，原 key 继续禁止重新采购。处置 ID 不写入人工重试祖先或分页游标。相同底层参数的新合法采集身份也能继续；这点对 Twitter v2 必须成立，因为其时间窗是交付过滤，底层请求指纹不会仅因时间窗变化而变化。

操作本身不调用供应商，不提交 Delta 任务，不推进 checkpoint，不补回 Run `106978` 的原页。正常调度后续可能产生费用；原客户冻结金额需通过已有独立账务入口处理。仅释放资金冻结不能解除搜索阻断。

## 管理入口与上线步骤

仅 Admin Token 可调用，Public listener 和 Launcher 会话不开放：

```text
GET  /internal/v1/admin/acquisitions/{原usage UUID}/search-admission-disposition
POST /internal/v1/admin/acquisitions/{原usage UUID}/search-admission-disposition
```

POST 提交准备响应的 `revision`、3–500 字 `reason` 和 `acceptUnknownRisk: true`。写入响应丢失时仅 GET 核对；不因未收到响应认定未写入。返回的 `upstreamDispatched: false` 仅说明处置操作不派发采购，不是历史请求未执行的证据。

1. 在服务器 Hub 源码目录同步完整代码后，按现有流程应用新增迁移，并统一发布 Public、Admin 和前端。保持 Hub 独立发布：

   ```bash
   MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
   ```

2. 在「诊断中心」查询 `567255e8-fef1-4471-9dd9-1247f068bc99`，使用新增「恢复后续正常采集 → 查看后续采集恢复条件」。不要选旁边的原页付费重试入口。
3. 核对原请求、身份和查询范围，填写处置原因，再确认解除这一条历史阻塞。看到保存的审计记录后，才认为此次处置已提交。
4. 等待 Delta 正常后续调度，核对新 Run 的结果。若还有其他 blocker，按其 ID 独立诊断，不进行全 Key/平台清空，也不自动重跑已结束的旧 Run。

Delta 当前策略是准入拒绝后结束本次采集并告警，不自动重试。Hub 的 `automaticRetryAllowed=true` 是保留原 body/key 的重试许可；`retryAfterSeconds=300` 不是旧 unknown 的自动失效时间。本次不修改 Delta 策略。

## 第二个 blocker：Run 106855 / `17b94611`（2026-10-28 晚）

生产告警：策略 `bmzs_政情·爱泼斯坦文件最新动态·3eb463f4-a66e-415d-8f7a-e59a7f2c2694_dev_853`，Delta Run `106855`，HTTP 关联 ID `75a5f259-576c-4fc5-abc1-cb742dcd26dc` 收到 `409 search_admission_blocked`，`dispatchState=not_started`，`blockingRequestId=17b94611-6ecf-4680-a01c-f147476c48e7`。这与上文 `567255e8` 是不同的阻塞请求，处置 `567255e8` 不会放行它。本次请求未派发、未采购；Delta 按现行策略结束本次 Run，不自动重试。

`search_admission_blocked` 只说明同一 Key、平台、查询下有未结请求，不区分两种情况：

- **仍在执行**（usage `reserved`，或协议 binding `running` 且租约未到期）：会自行结束，下一次调度即可通过，不需要处置。
- **结果未知**（usage/binding `unknown`，或 `running` 但租约已过期）：永久阻塞同一查询，只能按上文流程逐条处置。

同一查询可能同时挂着多条 blocker；按告警逐条发现时，每处置一条都要再失败一次 Run 才会暴露下一条。因此新增只读脚本 `server/ops/diagnose-search-admission-scope.mjs`：从一个 blockingRequestId 出发，按与 `SearchProtocolStore.begin` 相同的三项扫描（协议 binding、v1/v2 usage、协议租约），列出该范围内**全部**未结请求、各自的供应商调用结果和应采取的动作，并报告处置功能（迁移 166 和模块）是否已在生产就绪。脚本只读一致性事务，不写库、不处置、不调用供应商，查询正文只输出长度和哈希前缀。无需部署，从有 kubectl 权限、包含此文件的 Hub 源码目录执行：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- node --input-type=module - 17b94611-6ecf-4680-a01c-f147476c48e7 < server/ops/diagnose-search-admission-scope.mjs
```

| `action` | 含义 | 操作 |
| --- | --- | --- |
| `wait_in_progress` | 正常执行中（预占不足 30 分钟） | 不处理，等下次调度 |
| `investigate_stuck_reservation` | `reserved` 超过 30 分钟仍未结束 | 贴回输出，排查预占清理，不要处置 |
| `dispose_in_diagnostics_center` | 结果未知，处置功能已就绪 | 诊断中心查询该 ID →「恢复后续正常采集」，逐条处置 |
| `deploy_disposition_then_dispose` | 结果未知，生产尚无迁移 166 或其模块 | 先按上文第 1 步发布，再逐条处置 |
| `none_disposed` | 已有有效处置，不再阻塞 | 无 |

`summary.blocking=0` 后下一次调度即可正常准入。`leases.expired>0` 或 `unboundBindings>0` 表示存在没有 usage ID 的阻塞，不能用本处置解决，需贴回输出。已结束的 Run `106855` 不会补跑。

### 反复出现的根因与可选方向（未实施）

一天内已出现两条 Twitter 未知结果 blocker。已知的那条来自 RapidAPI `twitter-aio.search` 30 秒超时。只要供应商仍会偶发超时，周期性策略就会每遇到一次超时就停住，直到管理员处置。可选方向（均需用户决定）：

1. 保持现状：逐条人工处置，用上面的范围诊断一次清完同一查询的所有 blocker。
2. Delta 侧：收到 `automaticRetryAllowed=true` 时按 `retryAfterSeconds` 延迟一次，用同一请求体和 Idempotency-Key 重试。只能消除“仍在执行”的 blocker，对结果未知无效；Delta 不在本仓库。
3. Hub 侧：对一个窄类别自动接受风险，例如供应商超时、没有任何 HTTP 响应、且已超过若干小时的 Twitter unknown。这会改变“只允许管理员逐条处置”的既定决定，可能为同一页重复向供应商付费。

## 验证与发布状态

新增定向测试 37 项通过、0 失败、0 跳过，覆盖真实 PGlite SQL、只读准备、CAS、幂等确认、审计不可变、旧账务不变、跨身份隔离、其他 blocker、pending/租约、旧 key 保护以及三层准入联动。证据摘要包含派发指纹和调用顺序，变化后处置失效；前端只在明确核实有效时显示解除成功。既有协议/人工重试/诊断/SSO 回归 102 项通过；深层相关联合测试 70 项中 64 通过、6 项既有原生 PostgreSQL 条件测试跳过（与新测试存在重叠，不相加计数）。PGlite 只有单会话，串行模拟不等于原生 PostgreSQL 多会话竞争验证。

类型检查和前端构建通过。浏览器使用本机合成数据检查只读准备、默认焦点在取消的确认框、成功审计展示，以及写入响应丢失后只读核对；没有使用生产凭据或执行生产处置。证据变化时已有审计的 `disposition.effective=false`，界面保留记录并说明保护仍生效，不把“曾保存处置”当作当前恢复成功。

本次仅本地实现与合成数据验证；没有执行生产部署、该请求的生产处置或付费查询。MX-H2I、Launcher、SSO、网络配置及共享数据库配置未改。
