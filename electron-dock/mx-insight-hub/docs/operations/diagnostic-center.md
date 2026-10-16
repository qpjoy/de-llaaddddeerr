# 可观测性诊断中心（2026-10-16）

## 本次落地范围

将“请求诊断”和“限制与恢复”统一到 **可观测性 → 诊断中心**，数据浏览中心保留业务数据查看与检索。使用记录按原请求 ID 进入诊断，原数据浏览诊断链接继续兼容。诊断只在用户明确查询时读取历史证据；切换页面不重新采集数据。

第一阶段复用现有 Admin Token 权限及两条接口，不新增数据库授权，不修改 Launcher/Hub SSO 或 MX-H2I 登录、联网。普通 Launcher 用户、包括 Launcher 平台管理员，不能因此访问全局诊断。界面移动不是授权扩展。

| 入口 | 数据来源与效果 |
| --- | --- |
| 请求诊断 | `GET /internal/v1/admin/request-diagnostics/:identifier`，固定请求 ID 精确查询，只读账本 |
| 证据分析 | 对上述脱敏 DTO 执行固定规则，区分已记录事实、未确认项及下一步；没有模型调用 |
| 限制与恢复 | 读取当前配额、冷却和恢复信息；原恢复操作仍是单独的显式管理员写操作，保留预览、限制和审计 |
| 按原参数验证 / Twitter 人工重试 | 保留原有独立流程：准备阶段读取历史，后续明确确认发送可能创建新请求及费用；不是只读分析的一部分 |
| 使用记录、通知中心、运行状态 | 保留各自职责，按请求 ID 或告警关联进入诊断；当前限制不追溯证明历史故障原因 |

“诊断中心”不等于其中所有按钮都只读。历史查询与证据分析严格只读；现有 `RequestValidation` / `AcquisitionComparison` 的“按原参数验证”在准备后仍需单独明确确认发送，并可能产生新请求及费用。`TwitterRequestRetry` 保留既有适用范围、证据核对及人工确认，不因为进入诊断中心而自动执行。普通限制恢复沿用现有独立权限和业务规则，不得据此解除 unknown、改写失败记录或自动重试。当前没有面向测试同学的独立只读角色，不应把 Admin Token 当作测试账号分发。

## 历史查询与证据边界

已有实现 `server/acquisitions/diagnostics.mjs` 使用 `REPEATABLE READ READ ONLY` 事务，3 秒语句超时、1 秒锁等待，最多 20 条关联请求，每条 50 条供应商调用及 50 条连接器调用，超限明确标记。支持 Hub UUID 和已保存的精确上游 request ID，不支持任意 SQL、模糊扫描或任意响应正文检索。

查询直接经过 `acquisitionHistory.getAdminDiagnostics()`，不会调用普通业务请求、租约回收、交付重放、历史补采或供应商探测。响应为 `private, no-store`。新增分析只有纯函数调用，没有增加 SQL 或网络请求。原脱敏边界见 [管理员请求诊断](request-diagnostics.md)。

`run.analysis` 为版本 1：

- `mode=recorded_evidence`、`readOnly=true`、`modelInvoked=false`，明确当前为规则解释。
- `summary` 总结当前证据；`findings` 最多 12 条，每条含稳定代码、`confirmed/unresolved`、中文解释及最多 8 个 `evidenceRefs`。
- 引用是当前 run 内的字段路径，例如 `status`、`connectorCalls[0].failureKind`，不把描述文本当成证据。
- `nextSteps` 最多 6 条，只提出原请求证据核对建议，不执行重发、配置改动或模型调用。
- `semanticRelevance=not_assessed`。诊断不读取原查询与正文，不生成搜索相关性评分。

解释必须保留以下差异：

1. `committed` 表示已保存交付；HTTP 2xx 不证明内容相关，HTTP 4xx/5xx 的已提交记录仍是失败响应。
2. 显式 `connector.failureKind=timeout` 才能确认等待超时。仅有约 30 秒的起止时间或 `night_all_outcome_unknown` 名称不能推出超时配置，更不能推出下游停止或失败。
3. 上游 `httpStatus=200` 加 `outcome=unknown` 可能只记录了响应头，不证明完整响应和成功业务结果。
4. 没有当次供应商调用记录，不证明没有执行；Night-All 的内部供应商调用不一定在 Hub `providerCalls`。
5. `chargedMinor=0` 加 `status=unknown/reserved` 不能解释为退款、预占释放或供应商免费；影子计费、报价与实际钱包扣款分别解释。
6. 当前恢复倒计时、当前部署配置和窗口内候选请求，不是历史请求根因或最终结算的直接证明。

Twitter 截图请求 `7c686127-a835-473a-80eb-e14241194c90` 的原证据与既有现场回执继续保留在 [Twitter 账号采集超时](twitter-crawl-timeout-2026-10-16.md)。本次不会把相邻 Night-All 成功候选写回该原 unknown。

三个小红书原请求 `b42243d1-0dfd-45e5-99a5-9aebf3216dae`、`c4dcec7a-8d2e-4aef-89a2-e93dfab10fae`、`a330ca1e-cfd2-467e-9525-3d9dc31d69bd` 的问题是主体/关键词相关性，需要使用原归档验证真实传参和结果；不能因为请求成功或返回了 20 条，就判定语义正确，也不能因为未出现姓名就判定每条无关。诊断中心的状态分析不会替代这项验证。

## 测试同学只读访问的下一阶段

以下为规划，未在本次开放权限。建议增加 Hub 本地 `diagnostics.read` 能力，由已验证的身份绑定到明确租户、consumer、测试环境或授权请求范围，不改变登录链或沿用 Launcher 全局管理员角色。跨租户全局查看仍归平台运维。

服务端在查请求之前执行范围校验；通过上游 ID 反查也必须与同一授权范围求交，不能先返回跨租户匹配数量。只读用户不能访问当前 Admin Token API、受限正文、供应商凭据或恢复 POST。限制查询与导出次数、有效时间及条数，并记录查看范围的审计。不得给浏览器数据库连接、SQL 编辑器或 kubeconfig。

最小交互应为“输入请求 ID → 查看有权限的请求证据 → 导出脱敏诊断报告”。恢复继续由单独权限、明确影响范围、当前版本校验和现有审计控制。此授权改造需要独立评审、路由/上游 ID 防越权测试和逐环境开通，不应靠在 UI 隐藏按钮实现。

## 复用现有 Agent 的具体接入位置

Hub 已有 `server/agent/runtime.mjs` 的 `AgentRuntime.complete()` 和显式 Chat Sequence 解析，可复用受治理的 Provider/Sequence、模型参数、超时与调用证据。`server/agent-market/runner.ts` 已示范有界证据、结构化输出校验、阶段轨迹和模型 token/耗时记录。它当前服务于高级搜索，并不是日志诊断 Agent。

`server/agent-studio/registry.mjs` 的通用节点清单默认 `availability=compile-only`、`runtimeAvailable=false`；不能把图能编译解释为已经能读生产日志。本次诊断中心没有接入 Agent，也没有自动调用 `complete()`。

建议下一阶段先做固定诊断工作流，而不是开放自治终端：

1. **证据包**：按显式授权请求 ID 获取上述 DTO，固定 schema/version、采集时间、截断标记、证据引用和摘要。不会读取请求正文；语义相关性核查另走有授权的受限归档投影。
2. **固定工具**：只允许 `get_request_evidence(identifier)`、`get_current_limit_snapshot(scopedFilter)`，以后再增 `get_correlated_log_events(requestId, boundedWindow)`。不接受模型生成的 SQL、shell、URL、服务名、任意日志检索条件。当前限制快照标为“当前”，不能补写成历史证据。现有 `admissionRecovery.snapshot()` 是 Admin 全局接口，传入 `scopedFilter` 本身不是授权；测试同学版本必须由服务端重新执行租户/consumer 范围授权并投影，排除跨租户或供应商全局敏感状态，未实现前继续仅限管理员。
3. **日志接入**：优先接入已有集中日志；若必须通过 Kubernetes，由独立服务账号只读指定 namespace/workload 的 pods 和 pods/log，禁用 exec、secrets、patch。服务端校验请求所属范围和时间窗，仅投影固定结构化字段；原错误消息、响应正文、Headers、账号和凭据不交给模型。日志内容是非可信证据，不得作为指令。
4. **显式模型分析**：用户单击“Agent 分析”并看到使用的 Sequence、证据范围及模型成本提示才启动；设置请求并发、时间、token 和成本上限。只读指业务系统不被修改，模型调用仍可能计费。未配置/过期 Sequence 应明确失败，不回退到任意外部模型。
5. **可验证输出**：严格 schema 返回“观察到的事实、候选原因、缺失证据、只读下一步”，每个结论必须引用输入证据 ID；服务端校验引用存在并拒绝超出证据的自动修复指令。模型结论是辅助解释，不更新 usage/provider/billing 账本、不执行恢复、重发或改配置。
6. **隔离验收**：使用合成超时、HTTP 200 后中断、供应商业务拒绝、成功但语义不相关、跨租户 ID 和恶意日志指令样本验证，再以已授权历史证据验收，不用新付费采集生成测试样本。

## 本地验证与发布

`tests/server/request-diagnostic-analysis.test.mjs` 覆盖上述推断边界、无任意文本透传、引用可解析、分析不改输入及原查询没有新增 SQL；与既有 `request-diagnostics.test.mjs` 一起运行。HTTP 入口继续沿用既有 Admin-only 保护，UI 归并需要同时验证新入口及旧链接。

本次功能无需新 migration。按现有流程发布 Hub Admin API 和前端后才会生效，不要求更新 Launcher/MX-H2I。没有执行生产部署、读生产日志、付费搜索、恢复或账本改写。

2026-10-16 本地验收：诊断规则、只读查询、HTTP 权限/SSO 隔离、导航/会话及小红书取证共 71 项通过、0 跳过；SQL 测试使用实际 PGlite。类型检查、Vite 构建及桌面/390px 模拟浏览器验收通过，浏览器仅发生模拟 GET，无写入、供应商请求或页面异常。模拟截图不代表生产证据。额外扩展运行 `usage-authorization.test.mjs` 时有 4 项既有 SQL mock 与当前 `hub_rate_limit_exempt` 查询不匹配；该测试和 PostgreSQL store 均未被本次修改，不将此结果计入上述通过数量。
