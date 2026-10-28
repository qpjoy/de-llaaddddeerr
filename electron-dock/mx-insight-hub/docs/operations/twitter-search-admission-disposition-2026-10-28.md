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

## 验证与发布状态

新增定向测试 37 项通过、0 失败、0 跳过，覆盖真实 PGlite SQL、只读准备、CAS、幂等确认、审计不可变、旧账务不变、跨身份隔离、其他 blocker、pending/租约、旧 key 保护以及三层准入联动。证据摘要包含派发指纹和调用顺序，变化后处置失效；前端只在明确核实有效时显示解除成功。既有协议/人工重试/诊断/SSO 回归 102 项通过；深层相关联合测试 70 项中 64 通过、6 项既有原生 PostgreSQL 条件测试跳过（与新测试存在重叠，不相加计数）。PGlite 只有单会话，串行模拟不等于原生 PostgreSQL 多会话竞争验证。

类型检查和前端构建通过。浏览器使用本机合成数据检查只读准备、默认焦点在取消的确认框、成功审计展示，以及写入响应丢失后只读核对；没有使用生产凭据或执行生产处置。证据变化时已有审计的 `disposition.effective=false`，界面保留记录并说明保护仍生效，不把“曾保存处置”当作当前恢复成功。

本次仅本地实现与合成数据验证；没有执行生产部署、该请求的生产处置或付费查询。MX-H2I、Launcher、SSO、网络配置及共享数据库配置未改。
