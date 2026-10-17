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

`Idempotency-Key` 必填。起止时间必须有明确时区，精度最多毫秒且起点早于终点；`timezone` 必须是有效 IANA 时区。Hub 统一为 UTC 瞬时比较，不采用服务器本地时区。供应商坐标、`params`、隐式日期默认值、`X-MX-Insight-Retry-Of` 不属于 v2 输入。

支持 Facebook、Twitter、Instagram、Reddit、Weibo、Bilibili、Douyin、Kuaishou、Zhihu、YouTube、TikTok、Xiaohongshu 标准内容搜索。现有平台及操作权限继续生效，平台可调用仍取决于其原运行开关、凭据和财务准入。微信、账号、支付和其他独立合同不纳入此入口，未支持平台明确返回 422，不退回 v1 或忽略时间。

| 平台 | 上游时间过滤 | Hub 交付过滤 | 可声明的覆盖 |
| --- | --- | --- | --- |
| Facebook | 换算为上海日历日期；`endDate` 保守使用 `to` 对应日期 | 按真实发布时间精确 `[from,to)` | 有限遍历；供应商日期上界包含性及全历史覆盖未验证 |
| Twitter / Instagram / Reddit 及其余已列平台 | 当前统一 v2 合同未提供原生时间过滤 | 按真实发布时间精确 `[from,to)` | `partial`，明确 `upstream_time_filter_unsupported`，不保证能回溯到所需历史 |

完整采购证据、原始结果及原有采集计量仍保存，交付过滤不会改写底层数据或退款。无可靠发布时间的条目不以采集时间替代；不交付这些条目并返回缺失计数。交付页可能少于 `pageSize` 或为空；仍有 `nextCursor` 时必须继续同一遍历。不会为了补齐过滤后的页额外隐藏发起一轮采购。

## 响应与空结果

`data.contractVersion` 为 `mx-insight-hub.data-search.v2`，保留 `data.items/pageInfo/status/warnings`。以下字段位于 **`data.meta`**：

- `requestedWindow`：规范化后的明确请求窗。
- `effectiveWindow`：同一精确窗、`deliveryFiltering: "exact"` 与上游能力。Facebook 额外给出 `upstreamTimezone: "Asia/Shanghai"`、`upstreamDates`。
- `capabilities`：`upstreamFiltering: "calendar_date" | "unsupported"`、`deliveryFiltering: "exact"`、`ordering: "unspecified"`、`coverageComplete: false`、`maxPages: 15`、`paginationVersion: 2`、`idempotency: "permanent"`。
- `limitations`：来源覆盖、日期边界、缺失时间、遍历受限等明确原因；`timeFilter` 给出本页检查、窗外及缺失时间数量。

`coverageComplete: false` 表示不能证明全历史覆盖，不等于每次 Facebook 遍历失败。`status: partial` / 原采集限制则要保留本次未完整遍历事实。特别是无原生时间过滤的平台，最后一页为空也不能写成“整月不存在数据”。

## 分页、重试与版本绑定

v2 的 `mxds2` 加密游标绑定原 Key、查询、页大小、结果类型和精确时间窗，并封装底层原游标。v1 拒绝 `mxds2`；v2 拒绝所有旧游标。窗口和版本随任务创建持久化，分页与重试不再按当前时间计算。旧任务不得在恢复时补上新窗、改成 v2 或把旧空页当作新窗采集完毕。

同页重试保持原请求体及 key；下一页使用新的 key 和返回的原游标。v2 的同一 key **永久重放**原交付，`type=fresh` 不允许过 120 秒后同 key 再次采购；新采集必须是明确的新任务/新 key。v1 的原 fresh/stable 重放策略保持原样。每个底层标准页仍只走原授权、预留、采购、原始存档、入库及一次客户结算。

新增 `control.data_search_protocol_bindings` 保存协议归属、冻结请求、精确投影响应和底层 requestId，不复制或重建客户账单。新 `control.data_search_protocol_leases` 在查询维度允许多个 v1 并发、阻止 v1/v2 重叠；同 consumer/key 还有独立竞争保护，不会因换 query 绕过。v2 同查询的新请求也串行派发。协议与 key 不能跨 API Key 复用。

跨版本 unresolved 保护按同 tenant/consumer/Key/platform/query 保守阻断，日期、游标或 key 改变不解除。已有 v1 unknown 不因超过 24 小时自动消失；无法恢复查询归属的旧未知证据也不视为安全。v2 投影或持久化未知同样阻止降级为 v1。过期的未完成协议租约没有自动重启入口；需要先核对原请求。这个保护不会扩展任何平台权限或自动清除历史 unknown。

上述跨版本范围是标准 `/api/v1/data/search` 与 `/api/v2/data/search`。旧 raw 兼容接口保持独立操作语义；已知 raw 路径原本就不参与标准搜索的历史路径检查。对于快照字段尚未引入时的记录，只有 usage 为 `unknown`、整个 acquisition 快照为空、capability 为空、计量项为 `raw`、指纹为合法 SHA256，且关联的**唯一一条** connector 也为 `raw/unknown`，consumer、平台、指纹逐项一致，才恢复其旧 raw 操作身份，排除缺路径导致的标准搜索扩大阻断。缺证据、矛盾证据、多个 connector、`reserved`、部分缺失的快照及标准搜索路径仍保守阻断。此判断不恢复 query、不改变旧 raw 的 unknown、不允许复用它的 key，也不跳过其他协议 binding、lease 或标准请求检查。

### 准入等待与结果未知

`409 search_admission_blocked` 表示本次 v2 key 尚无任何请求归属，Hub 在采购前被其他未完成请求挡住。响应示例：

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

下游保留原 body、Idempotency-Key、版本、身份和游标，按建议间隔重试即可。该响应不代表原 blocker 已解决，也不允许更换请求条件。Hub 不为这次拒绝创建采购或页绑定；阻断消除后，原请求可正常执行，再次重试重放原交付。当前 key 已有 usage、binding 或 lease 时不会声明未开始采购，保留原冲突/running/unknown 语义。

Delta 更新后由既有 beat 自动接续冷启动/增量的原 CollectionRun；无需逐条跑解锁脚本。旧版本误分类的拒绝只做一次同 key 核对，期间继续阻止新 Run 绕路；真实 unknown、超时和投影不确定仍保持保护。日报 Skill 仍按原页身份重试，不自动重跑整份历史报告。`blockingRequestId` 和顶层 HTTP `requestId` 均不等于本页新采购 ID。

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

## 发布与统一验收

1. 先应用 `158_data_search_v2_protocol.sql`，再统一发布所有 Hub Public 实例及带新文档的 Admin/UI。新表仅新增协议状态，不修改既有任务、账本、用户、权限、登录或网络。未迁移时 v2 不可用，旧 v1 继续原链路。
2. 不允许旧、新 Public 实例混用后就开启 v2：旧二进制不了解跨版本门禁。完整 Hub 发布后再启用下游新任务 v2。
3. Delta Web、采集 worker、日报/Agent worker 必须同时具有新请求构造器、绑定及 unknown 保护；新日报版本需要按其原发布机制激活，旧版本包不修改。新任务固定版本，旧任务继续 v1。
4. 罗盘和更新后的 Java 源码一同发布，使时间范围、时区、固定截止点/请求意图一路传到 Delta。不能只换全局 Hub URL。
5. 统一离线验收四平台窗口、上海跨日、空页有游标、同页重复、下一页新 key、双向版本游标拒绝、同 key 换版本冲突、unknown 双向阻断、超 24 小时未知、投影失败但采集成功、旧 v1 稳定重放、v1-v1 并发和当前权限检查。

针对性测试在 `tests/server/data-search-v2.test.mjs` 与 `tests/server/facebook-search.test.mjs`。设置 `MX_INSIGHT_TEST_PGLITE_MODULE` 可运行真实 PGlite SQL；它不等同真实多会话 PostgreSQL 调度。HTTP 用本地 listener 和合成供应商响应；没有真实采购、生产迁移、部署或流量验收。最终跨语言/端到端结果以本次任务的统一验收报告为准。
