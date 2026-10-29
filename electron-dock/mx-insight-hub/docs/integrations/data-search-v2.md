# 数据搜索 v2：冻结时间窗与跨版本请求保护

本次实现新增 `POST /api/v2/data/search`。旧 `/api/v1/data/search`、旧任务、旧游标与已保存结果继续保留原合同。升级的是新业务任务的搜索协议，登录、SSO、Launcher/MX-H2I 网络、支付和账号类接口不参与迁移。

## 请求与能力边界

```json
{
  "platform": "facebook",
  "query": "regional cooperation",
  "pageSize": 20,
  "type": "stable",
  "timeWindow": {
    "from": "2026-10-16T08:00:00.000+08:00",
    "to": "2026-10-17T08:00:00.000+08:00",
    "timezone": "Asia/Shanghai",
    "boundary": "[from,to)"
  }
}
```

`Idempotency-Key` 必填。起止时间必须有明确时区，精度最多毫秒且起点早于终点；`timezone` 必须是有效 IANA 时区。Hub 统一为 UTC 瞬时比较，不采用服务器本地时区。供应商坐标和隐式日期默认值不属于 v2 输入。2026-10-20 起仅 Twitter 可附加 `params.category`（新查询默认 Latest，可选 Top/Photos/Videos）、`params.filters`（最长2048字字符串）和 `params.includeTimestamp`（布尔值，默认false）；其他平台仍拒绝 `params`。详见 [Twitter 参数与供应商兼容](twitter-standard-provider-routing.md)。只有下述 Twitter 人工安全重试可以使用 `X-MX-Insight-Retry-Of`；其他平台仍拒绝未知结果重购 override。

支持 Facebook、Twitter、Instagram、Reddit、Weibo、Bilibili、Douyin、Kuaishou、Zhihu、YouTube、TikTok、Xiaohongshu 标准内容搜索。现有平台及操作权限继续生效，平台可调用仍取决于其原运行开关、凭据和财务准入。微信、账号、支付和其他独立合同不纳入此入口，未支持平台明确返回 422，不退回 v1 或忽略时间。

| 平台 | 上游时间过滤 | Hub 交付过滤 | 可声明的覆盖 |
| --- | --- | --- | --- |
| Facebook | 换算为上海日历日期；`endDate` 保守使用 `to` 对应日期 | 按真实发布时间精确 `[from,to)` | 有限遍历；供应商日期上界包含性及全历史覆盖未验证 |
| Twitter / Instagram / Reddit 及其余已列平台 | 不把 timeWindow 自动转换为上游时间过滤；Twitter 的调用方 filters 不构成时间窗完整性承诺 | 按真实发布时间精确 `[from,to)` | `partial`，明确 `upstream_time_filter_unsupported`，不保证能回溯到所需历史 |

完整采购证据、原始结果及原有采集计量仍保存，交付过滤不会改写底层数据或退款。无可靠发布时间的条目不以采集时间替代；不交付这些条目并返回缺失计数。交付页可能少于 `pageSize` 或为空；仍有 `nextCursor` 时必须继续同一遍历。不会为了补齐过滤后的页额外隐藏发起一轮采购。

## 响应与空结果

`data.contractVersion` 为 `mx-insight-hub.data-search.v2`，保留 `data.items/pageInfo/status/warnings`。以下字段位于 **`data.meta`**：

- `requestedWindow`：规范化后的明确请求窗。
- `effectiveWindow`：同一精确窗、`deliveryFiltering: "exact"` 与上游能力。Facebook 额外给出 `upstreamTimezone: "Asia/Shanghai"`、`upstreamDates`。
- `capabilities`：`upstreamFiltering: "calendar_date" | "unsupported"`、`deliveryFiltering: "exact"`、`ordering: "unspecified"`、`coverageComplete: false`、`maxPages: 15`、`paginationVersion: 2`、`idempotency: "permanent"`。
- `limitations`：来源覆盖、日期边界、缺失时间、遍历受限等明确原因；`timeFilter` 给出本页检查、窗外及缺失时间数量。

`coverageComplete: false` 表示不能证明全历史覆盖，不等于每次 Facebook 遍历失败。`status: partial` / 原采集限制则要保留本次未完整遍历事实。特别是无原生时间过滤的平台，最后一页为空也不能写成“整月不存在数据”。

## 分页、重试与版本绑定

v2 的 `mxds2` 加密游标绑定原 Key、查询、页大小、结果类型、显式 Twitter params 和精确时间窗，并封装底层原游标。v1 拒绝 `mxds2`；v2 拒绝所有旧游标。窗口和版本随任务创建持久化，分页与重试不再按当前时间计算。旧任务不得在恢复时补上新窗、改成 v2 或把旧空页当作新窗采集完毕。

同页重试保持原请求体及 key；下一页使用新的 key 和返回的原游标。v2 的同一 key **永久重放**原交付，`type=fresh` 不允许过 120 秒后同 key 再次采购；新采集必须是明确的新任务/新 key。v1 的原 fresh/stable 重放策略保持原样。每个底层标准页仍只走原授权、预留、采购、原始存档、入库及一次客户结算。

新增 `control.data_search_protocol_bindings` 保存协议归属、冻结请求、精确投影响应和底层 requestId，不复制或重建客户账单。新 `control.data_search_protocol_leases` 在查询维度允许多个 v1 并发、阻止 v1/v2 重叠；同 consumer/key 还有独立竞争保护，不会因换 query 绕过。v2 同查询的新请求也串行派发。协议与 key 不能跨 API Key 复用。

跨版本 unresolved 保护限定在能够确认的同 tenant/consumer/Key/platform/query。已有协议 binding 的 unknown、持久化未知或过期未完成租约仍保护两个版本，日期、游标或 key 改变不解除，也不因超过 24 小时自动清除。

管理员可针对完整证据且已停止执行的一条历史 Twitter unknown，明确接受未决风险并保存独立准入处置记录。它只解除该记录对后续独立采集的阻断，不改变旧状态、账务或原 key，不授权其他未知请求、运行中调用或不合法游标。原页补采仍是独立人工重试流程。见 [历史未知请求处置](../operations/twitter-search-admission-disposition-2026-10-28.md)。

自 `SEARCH_ADMISSION_POLICY_REVISION=known-query.v1` 起，v2 检查旧 usage 时必须同时满足：保存路径为 `/api/v1/data/search`，query 为非空字符串，去除两端空白后与本次查询完全相等，且归属一致。这样的旧 `unknown/reserved` 仍阻止新 v2 请求。缺少路径、缺少有效 query 或已知属于其他操作的记录不再阻断整个平台的新查询，也不要求下游逐条核对这些无关历史才能调用。旧 v1 自身的重放与并发语义不变。

这个放宽不修改历史状态、不认定旧请求未收费或已成功；原 key 归属仍然保留，包括缺少当前 binding 的孤立 usage，以及缺少 usage 的悬空幂等 binding，不能通过 v2 复用旧 key。历史 raw 及无快照记录无需再依赖 connector 表证明操作身份。权限、预算、同一查询的协议 binding/lease 检查照常执行。

### 准入等待与结果未知

`409 search_admission_blocked` 表示本次 v2 key 尚无任何请求归属，Hub 在采购前被其他未完成请求挡住。Hub 会先在服务端等待该请求最多 40 秒，结束后自动放行本次请求；只有等待后它仍在执行时才返回此 409。响应示例：

```json
{
  "error": {
    "code": "search_admission_blocked",
    "details": {
      "dispatchState": "not_started",
      "automaticRetryAllowed": true,
      "retrySameRequest": true,
      "retryAfterSeconds": 300,
      "blockingRequestId": "已有请求的 UUID（可选）"
    }
  },
  "requestId": "本次 HTTP correlation ID"
}
```

该响应允许下游保留原 body、Idempotency-Key、版本、身份和游标，在阻断解决后按建议间隔重试；是否自动重试由下游策略决定。它不代表原 blocker 已解决，也不允许更换请求条件。Hub 不为这次拒绝创建采购 usage；协议入口拒绝不建 binding，而 Twitter 路由在 reserve 前拒绝时可能保留无 usage 的 retryable binding。已有自有采购、运行中或未知归属仍保留原冲突/running/unknown 语义。

2026-10-28 核对 Delta 当前代码：准入拒绝结束本次 Run 并告警，不再由 beat 自动接续；原请求身份和证据保留。历史版本的自动恢复说明不再作为当前行为。真实 unknown、超时和投影不确定仍保持保护。`blockingRequestId` 属于旧阻塞请求，顶层 HTTP `requestId` 属于本次尝试，均不等于本页新采购 ID。

`GET /api/v1/requests/by-idempotency-key` 与 `GET /api/v1/requests/{requestId}` 增加 `data.searchProtocol`（仅关联 v2 时）：

```json
{
  "version": 2,
  "state": "unknown",
  "acquisitionRequestId": "原始 Hub usage UUID",
  "deliveryConfirmed": false,
  "automaticRetryAllowed": false,
  "errorCode": "request_outcome_unknown"
}
```

原采集 `status=committed` 只说明底层采购交付已记录；外层 `searchProtocol.state=complete` / `deliveryConfirmed=true` 才说明 v2 精确投影已记录。投影丢失不授权新 key、v1 或新窗口再采购。若还未取得 usage UUID，按原 key 查询协议状态；不会伪造一个 usage requestId。

## Twitter unknown 的人工安全重试

先在 Hub Internal「数据浏览中心 → 请求诊断」查询原 requestId，选择「准备按原参数重试 Twitter」。准备只读保存的原请求、v2 时间窗/游标、原 Key 和资格，不采集。满足条件后明确点击「确认按当前链路重试（可能再次计费）」，才发起一次新的关联请求。原 unknown 和原账单不改写，新请求独立结算。

公开合同复用 `POST /api/v2/data/search` 和 `X-MX-Insight-Retry-Of: <原 usage UUID>`，使用同一有效 API Key、原规范化 v2 body（包括 `type`、精确时间窗、原游标及 Twitter params）及一个新的永久 `Idempotency-Key`。只允许具有完整 v2 归属、原 usage unknown 和当前 RapidAPI Twitter 调用证据的请求；缺参数、身份不符、处理中、游标失效、其他供应商、其他未决请求以及底层 committed 但 v2 投影未知，不得据此重购。

迁移 162 在进入新 usage/采购前就持久绑定原请求和后续幂等键。双击、并行页面、刷新或响应丢失不能换键创建另一笔重试；即使尚无新 usage UUID，也展示已登记的重试意图。断线后保留新键、只读核对，不自动重发采购。后续再次 unknown 时，保留该后续请求，后续人工重试须继续其已验证的单线关联，不能从旧祖先分叉。

若服务端能证明该意图没有任何采购调用、没有未决 usage、协议为 `retryable` 且游标仍有效，准备回执才给出 `retryIntent.resumeAllowed=true`。面板经人工确认可继续已登记的同一键；unknown、运行中、已取得采购证据或仅响应丢失均不能据此继续发送。

`GET /api/v1/requests/{原 usage UUID}/search-recovery` 使用原 API Key，返回 `mx-insight-hub.data-search-recovery.v1` 的只读回执：原请求、原协议状态、已绑定的后续请求以及 `delivery`。只有完整保存的 v2 结果才能出现在 `delivery`；底层 usage 的 committed 不够。此 GET 不做过期清理、预留、采购、重新投影或账务写入，`delivery=null` 也不证明没有采购。

成功重试签发的后续游标只能继承服务端已验证的原 unknown 关联，继续同一时间窗遍历；客户端不能自行提交 ancestor UUID 来绕过其他未决请求。旧 unknown 不因此被改为成功。

Delta 使用该只读回执恢复政情报告原页：核对原持久键对应的原 usage、原 body/window/cursor 和 Hub 保存的关联结果后，仅为指定页保存恢复指针，原页幂等键及原请求 ID 保留。恢复命令不发采购、不推进游标，也不标记入库成功；原 Run 正常接续时 GET 已确认的 v2 结果，沿既有幂等入库与 `_finish_page` 完成，再按原游标继续。具体命令和验证记录见本次运维记录。

## 发布与统一验收

1. 先应用 `158_data_search_v2_protocol.sql`；人工安全重试还需要迁移 162，再统一发布所有 Hub Public 实例及带新文档的 Admin/UI。新表仅新增协议状态，不修改既有任务、账本、用户、权限、登录或网络。未迁移时 v2 重试不可用，旧 v1 继续原链路。
2. 不允许旧、新 Public 实例混用后就开启 v2：旧二进制不了解跨版本门禁。完整 Hub 发布后再启用下游新任务 v2。
3. Delta Web、采集 worker、日报/Agent worker 必须同时具有新请求构造器、绑定及 unknown 保护；新日报版本需要按其原发布机制激活，旧版本包不修改。新任务固定版本，旧任务继续 v1。
4. 罗盘和更新后的 Java 源码一同发布，使时间范围、时区、固定截止点/请求意图一路传到 Delta。不能只换全局 Hub URL。
5. 统一离线验收四平台窗口、上海跨日、空页有游标、同页重复、下一页新 key、双向版本游标拒绝、同 key 换版本冲突、unknown 双向阻断、超 24 小时未知、投影失败但采集成功、旧 v1 稳定重放、v1-v1 并发和当前权限检查。

针对性测试在 `tests/server/data-search-v2.test.mjs` 与 `tests/server/facebook-search.test.mjs`。设置 `MX_INSIGHT_TEST_PGLITE_MODULE` 可运行真实 PGlite SQL；它不等同真实多会话 PostgreSQL 调度。HTTP 用本地 listener 和合成供应商响应；没有真实采购、生产迁移、部署或流量验收。最终跨语言/端到端结果以本次任务的统一验收报告为准。
