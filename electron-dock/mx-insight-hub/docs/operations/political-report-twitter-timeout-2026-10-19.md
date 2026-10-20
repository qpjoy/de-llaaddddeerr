# 政情报告 Twitter 冷启动 409（2026-10-19）

## 已确认的原请求结果

用户重建政情报告后，Delta 告警报告第一页失败、0 页完成、0 条入库。精确原请求为 `5a05a551-e349-4be1-b7a9-a755e5406f38`，策略 `edaa45f3-8670-4925-8fe3-1038c5d2b9d8`，Run `b82352db-6087-4d61-b0cd-e688b356a699`。截图的下游 `operation=raw` 标签不能替代真实接口路径。

用户在生产操作机执行现有 `diagnose-twitter-outcome.mjs`，返回 v4 只读诊断，数据库时间为 `2026-10-19T03:13:20.163Z`：

| 字段 | 保存证据 |
| --- | --- |
| usage | `unknown`，`/api/v1/data/search`，billing meter `twitter` |
| usage 预留／完成 | `03:06:45.613Z`／`03:07:15.698Z`，相差 30085 ms |
| 唯一 own call | `02fc51df-887f-4cf8-b071-2251e763b4d9`，RapidAPI `twitter-aio.search` |
| call | `unknown`，`social_upstream_timeout_or_size_limit`，耗时 30003 ms |
| transportFailure | `phase=request`，`deadlineExceeded=true`，`timeoutMs=30000`，`codes=[]` |
| HTTP／业务码／billed | 均为 null；不能把 null 解释成未扣费 |
| 正文证据 | 有 unknown operational 元数据，无 HTTP、正文大小、正文哈希或 restricted response |
| gateway | Hub 保存 `unavailable`／502；不是上游返回 HTTP 502 的证据 |
| v2 protocol | `unknown`，绑定上述精确 usage，result 不存在，无残留 lease |
| failureDiagnostic | 表存在、无记录；本次已有适配器捕获并保存的传输失败信息，不据此推断迁移缺失或 PG 故障 |

这次由 Hub 的 30 秒适配器期限触发，未取得 HTTP 响应对象。v2 将底层未知结果映射为外层 `409 request_outcome_unknown`。不是已知的供应商 HTTP 429、Hub 并发/RPM 准入拒绝或“正文已取得、canonical/ES 后处理失败”。结束时间也未显示几十秒的后段持久化延迟。

`request` 阶段仍包含代理配置读取、探测、连接和等待响应头，不能从这份归档区分 DNS、代理或供应商处理慢。强制超时会中止等待，`codes=[]` 不证明这些环节都正常，也不能证明业务请求一定到达上游。没有原始正文可据此恢复下游数据；原 unknown、可能发生的费用及原 Key 必须保持。

诊断附带的 runtime 哈希只属于 Admin 容器，不证明 Public 的实际运行版本。回执中 RapidAPI adapter SHA-256 为 `bd195ef86de855b0359d7145474fd6b0bc1fc11f1479944cd71d7b15b78b5d14`。

## 超时与下游边界

当前 Hub `rapidapi-config.mjs` 的上游总等待为硬编码 30000 ms，适配器计时涵盖 route 读取、代理探测、响应头与正文。不能只根据一次超时，把它提高后宣称链路修复。

只读检查 Delta 当前源码：Twitter v2 默认使用 `DATA_QUERY_API_TIMEOUT` 的 90 秒缺省值（生产自定义值未读取），以单路线、原页持久键 POST；传输未知不自动切供应商或创建新采购。Celery 的 1800／1860 秒任务上限、Delta 普通 Nginx route 的 600 秒与本次 30003 ms 不是同一个计时器。HTTP 库的 scalar timeout 也不是严格端到端总预算。

已有只读同窗诊断命令如下，不触发采集或写入：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 5a05a551-e349-4be1-b7a9-a755e5406f38 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-busy.mjs
```

本次未重新采购、变更出口、清理历史、部署或修改 MX-H2I 登录/联网。原请求不能通过更换 API 版本、Key、供应商或删除策略来自动证明可重试。

## 同时间窗回执

用户补回 `diagnose-twitter-busy.mjs` 报告，数据库时间为 `2026-10-19T03:18:00.650Z`。有 11 笔同 tenant、consumer、API Key 的邻近 RapidAPI 标准搜索，全部 `succeeded / HTTP 200`，结果未截断。其中 4 笔与目标窗口重叠，分别在 `03:06:47.598Z`、`03:06:48.550Z`、`03:06:49.086Z`、`03:06:48.504Z` 完成；目标请求仍等到 `03:07:15.698Z` 才超时。邻近记录的 `completed_at-started_at` 间隔约 2.572–5.709 秒，这是数据库时间字段间隔，不是严格的 HTTP 计时或提交回执时间。

这个有界样本不支持整批请求同时被 PG/Hub 卡住或全局上游中断，指向目标调用的孤立异常等待。它不能证明这些调用走了同一个代理实例，也不能证明其他检索式就是目标检索式或解释上游内部原因。因此本次不改 Delta 调度、全局并发或 30 秒期限，不因一个超时自动换供应商。

此脚本旧错误码白名单未包含 `social_upstream_timeout_or_size_limit`，所以输出 `other`；上节 v4 原请求回执已经保留精确错误码。这是诊断投影差异，不是错误码后来被改写。两份回执已足以界定现有证据，不要求再次泛查日志或为验收付费重跑。

## 独立修复的未派发误分类

代码核对另行复现一个可能扩大后续阻塞的缺陷，与上述真实超时不同：v2 协议入口按原查询文字判断旧 unknown，Twitter 路由按编译后的查询比较。原文字不同、实际语义编译相同时，路由会在 gateway reserve 前拒绝新页；原包装层仅因错误码含 unknown，就把没有自己 usage 的新页也永久标记为 unknown。

修复仅让该路由明确发出的内部错误类型携带可信“尚未派发”证据。v2 仍需确认没有 underlying、没有开始投影、原 key 的 usage 查询成功且没有自有 usage，才保存 `retryable` 并返回 `search_admission_blocked`；公开 JSON 的 `not_started` 字段不能冒充证据。只允许保留原请求和原 key 等待旧 blocker 独立处理，不能自动解决旧 unknown 或绕过采购保护。

协议保存失败继续返回保守 unknown，但不会把旧 blocker UUID 冒充为新页自己的回执。已有 usage、真实传输未知、数据库查询失败或投影开始的路径不放宽。修改不重写已保存的历史误分类。

验证包括 Memory 和实际隔离 PGlite 的编译等价查询：阻塞期间 3 次同 key 尝试均 0 新 usage、0 采购，旧 blocker 逐字段不变；独立处理 blocker 后同 key 仅执行一次、以后精确回放。另用真实 RapidAPI adapter + gateway/workflow + v2 wrapper 注入请求期限，确认本次超时形态仍保持原 usage、call、客户 hold 和 protocol 为 unknown，原 key 重试不再执行，不切供应商。

这个修复防止后续未派发的页面被误标，不宣称恢复目标请求或修复其网络/上游等待。在此诊断阶段，v2 合同尚不接受未知结果重购 override；当时旧 v1 人工重试入口不具备本次 v2 时间窗的恢复能力。

本轮 11 个文件、178 项定向回归全部通过，无跳过，含实际隔离 PGlite、上游期限、协议保存失败、供应商路由/切换保护、HTTP 代理和 SSO 路由。类型检查和差异格式检查通过。测试使用合成数据与离线 HTTP fixture，不触发生产采购。仅本地修复，未部署，也未恢复这笔原 unknown。

## 后续人工安全重试

用户随后明确要求补齐 unknown 的安全重试。现已在本地补齐严格保留原 v2 参数、窗口和 Key 的 Twitter 人工入口、持久单一后继意图，以及 Delta 只读恢复原页的流程；详见 [Twitter unknown 人工重试与政情原页恢复](twitter-unknown-safe-retry-2026-10-19.md)。这项后续实现取代上述“v2 不接受 override”的能力描述，但不改写本事故证据，也未对这笔生产请求执行新采购或恢复。
