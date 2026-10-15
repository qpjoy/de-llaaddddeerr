# Delta → Hub Web Search

合同核对：2026-10-13，版本 `mx-insight-hub.web-search.v1`。本文说明当前源码合同，所有示例为合成数据；本轮文档与迁移代码未生产部署。当前渠道是否可用以该 Key 的 capabilities 和实际调用为准，配置存在不等于搜索已验收。管理员操作见 [配置迁移说明](../operations/web-search-migration-2026-10-13.md)，整体实现见 [Web Search](web-search.md)。

## 接入地址与身份

- 服务根地址：`https://hub.minsight-ai.com`。
- 文档：`/docs/web-search`；OpenAPI：`/docs/openapi.json`。二者都是登录后的 Hub 控制台内容，可从「接口文档」进入，并非无需登录的公开网页；机器业务 API 仍使用下面的 Hub Key。
- Delta 使用原有 **Hub Live API Key**：`Authorization: Bearer <Hub Key>`。不要把 Night-All/百度等渠道的原始 API Key 交给 Delta。Test Key 不能执行真实搜索。
- 不改变 MX-H2I 登录、联网或 Launcher 的身份配置。

| 方法 | 路径 | 行为 |
| --- | --- | --- |
| GET | `/api/v1/data/web-search/capabilities` | 当前 Key 的授权渠道、顺序和配置就绪状态；不发起搜索 |
| POST | `/api/v1/data/web-search/search` | 一次统一搜索；必须有 `Idempotency-Key` |
| POST | `/api/v1/data/web-search/compatible/baidu` | 百度输入形状；仍返回 Hub 统一结果 |

这三个接口均不接受 URL 查询参数。POST 仅接受本文所列 JSON 字段，不支持 `page`、`cursor`、`stream`、全文抓取、AI 答案生成或自动补量。

## 第一步：读取当前 Key 的能力

通过安全方式注入 `HUB_API_KEY` 环境变量；不要将真实值写入代码、工单或日志。

```bash
HUB_URL='https://hub.minsight-ai.com'
curl -sS "$HUB_URL/api/v1/data/web-search/capabilities" \
  -H "Authorization: Bearer $HUB_API_KEY"
```

合成响应示例，不代表 LCY-delta 当前实际顺序：

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.web-search.v1",
    "order": ["baidu", "tavily"],
    "providers": [
      {"key":"baidu","label":"百度 AI 搜索","resources":["web","image","video"],"maxResults":50,"ready":true},
      {"key":"tavily","label":"Tavily","resources":["web"],"maxResults":20,"ready":false}
    ],
    "defaultAccess": "explicit",
    "selection": "pre_dispatch_only"
  }
}
```

`providers` 只列当前 Key 有效授权的渠道；空列表表示尚未开放。`ready=false` 是已授权但配置未就绪，应由管理员检查渠道凭据、操作状态及准入配置，无需反复重新授权。`ready=true` 只证明当时配置预检查通过，不保证发送时的额度、余额、预算、并发、出网或搜索业务结果。

正常搜索需要 Consumer 与 Key 同时有效授权 `web_search`、`web.search` 和 `web.search.provider.<key>`。普通新租户/新 Key 默认不开放；特殊托管 Key 按其管理策略处理。租户文档展示不等于当前具体 Key 已获授权。

`order` 优先使用 Key 自己的顺序，否则采用租户顺序；已授权但未排序的渠道按登记顺序追加。**百度不是强制全局默认**。Delta 若明确要求百度，发送 `provider: "baidu"`；若交给 Hub 根据当前顺序选择，省略 provider。

## 第二步：发送一次搜索

先将业务意图、原 Key 身份、原正文与幂等标识持久保存，再发送。下例只发送一次，不配置自动重试：

```bash
IDEMPOTENCY_KEY='delta-web-20261013-001'
curl --max-time 60 -i "$HUB_URL/api/v1/data/web-search/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  --data '{"query":"人工智能","provider":"baidu","limit":10}'
```

建议客户端总超时从 60 秒起配置，并按部署网络调整；这是客户端建议，不是完成时限保证。客户端超时不代表 Hub 取消，也不证明未计费。不要在重试循环内生成新幂等标识。

省略 provider 时，Hub 在派发前选择第一个已授权、就绪且支持参数的渠道。一旦开始业务派发，不因超时、失败或空结果切换渠道/代理或重试。选择后发现预算等后续准入阻断也会明确失败，不继续尝试下个渠道。

### 统一请求字段

| 字段 | 类型 / 默认值 | 约束 |
| --- | --- | --- |
| `query` | 必填 string | 原输入 1–2000 字符，不全为空白、不含 NUL；首尾空白会去除 |
| `provider` | 可选 string | `baidu`、`exa`、`tavily`、`serper`、`you`、`searchapi`、`firecrawl`、`serpapi`；当前权限看 capabilities |
| `limit` | integer，默认 10 | 只请求 web；与 resources 互斥。百度 1–50，其余渠道 1–20 |
| `resources` | array | 1–3 个 `{type,limit}`；type 不重复。百度 web/image/video 上限分别 50/30/10；其他仅 web，最多 20 |
| `edition` | `standard` / `lite`，默认 standard | lite 仅百度；其他渠道接受 standard 默认值但不向渠道发送该字段 |
| `sites` | array，默认 `[]` | 最多 20 个域名，如 `example.com`；不带协议/路径/通配符，不传 IP。非空仅百度 |
| `from` / `to` | 成对 `YYYY-MM-DD` | 合法日期且 from ≤ to；统一入口不用时省略，不传空字符串 |
| `recency` | `week` / `month` / `semiyear` / `year` / `noTimeLimit` | 有效相对时间范围仅百度；noTimeLimit 等同不筛选 |

所有资源 limit **之和**还受当前 Key 的页大小额度限制；capabilities 的 `maxResults` 是渠道网页上限，不是 Key 总量额度。数量都是上限，不承诺凑足；每次只交付一批结果，没有下一页游标。

非空 sites、日期范围或有效 recency 要求包含 web；日期范围不能与有效 recency 同用。这些筛选针对百度网页，不承诺图片/视频同样按日期过滤。显式渠道不支持选项返回 `400 web_search_options_unsupported`；省略渠道时先排除不支持的候选，无就绪候选返回 `503 web_search_no_ready_provider`。

多资源请求（不要再传 limit）：

```json
{
  "query": "新能源汽车",
  "provider": "baidu",
  "resources": [
    {"type":"web","limit":5},
    {"type":"image","limit":3},
    {"type":"video","limit":2}
  ]
}
```

## 第三步：解析结果与证据

HTTP 200 合成示例；实际 meta 可以有其他说明字段，客户端应容忍新增元数据：

```json
{
  "data": {
    "query": "人工智能",
    "provider": "baidu",
    "items": [{
      "type": "web",
      "title": "示例资料",
      "url": "https://example.com/article",
      "snippet": "合成摘要，不是线上搜索结果。",
      "publishedAt": null
    }]
  },
  "meta": {
    "contractVersion": "mx-insight-hub.web-search.v1",
    "capturedAt": "2026-10-13T02:00:00.000Z",
    "empty": false,
    "fullText": false,
    "servedAt": "2026-10-13T02:00:01.000Z",
    "sourceMode": "live",
    "ageSeconds": 1
  },
  "requestId": "00000000-0000-4000-8000-000000000001"
}
```

- `data.provider` 是实际使用的渠道。`type` 为 web/image/video，url 为 HTTP(S) 来源链接。
- `snippet` 是摘要，可能为空；`fullText=false`。不生成 AI 答案，也不隐式提取网页全文。
- `publishedAt` 保留渠道日期文本或 null，不保证 ISO 格式或时区；`capturedAt` 是采集记录时间，不是页面发布时间。
- `items=[]`、`meta.empty=true` 是正式成功结果；不要因此自动补搜。
- 保存 `requestId` 与响应头 `x-mx-insight-request-id`。`idempotent-replay=true` 表示本次回放；`x-mx-insight-source-mode` 为 live 或 idempotent_replay。
- 回放正文保持原样，因此正文 `meta.sourceMode` 仍可能是 live，时间也不会刷新；本次是否回放以响应头为准。错误响应不保证提供回放头。

计费项为 `web.search`，具体客户价格与账户策略以 Hub 当前配置为准，本文不声明固定价格。只读 capabilities/请求状态不会派发搜索。新的幂等标识表示独立潜在计费意图；不要把 Key 名称或 ready=true 当作免费依据。

## 幂等、超时与错误处理

幂等标识为 8–128 位字母、数字、`.`、`_`、`:` 或 `-`；建议字母/数字开头以兼容状态查询。相同原 Key、相同规范化语义、相同标识绑定原渠道及交付；顺序、凭据或操作策略变化不会自动改变该意图。参数改变时复用旧标识返回 `409 idempotency_conflict`。当前授权撤销后也不能回放旧渠道结果。

超时、连接中断或未决错误先查询状态，GET 不发起搜索：

```bash
# 未收到 requestId：传原始幂等标识，不放到 URL 中。
curl -sS "$HUB_URL/api/v1/requests/by-idempotency-key" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY"

# 已收到持久 requestId：
curl -sS "$HUB_URL/api/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $HUB_API_KEY"
```

状态在 `data.status`，原请求 UUID 在 `data.id`；外层 requestId 是这次状态查询的标识。状态查询按当前 Consumer 隔离，不返回原搜索正文。

| 状态 | Delta 行为 |
| --- | --- |
| `reserved` | 仍在处理中；有界、退避查询 GET，不发起另一搜索 |
| `committed` | 可用原 Key、原请求正文及原标识取回原交付；可能是保存的错误，不代表一定成功 |
| `released` | 原预留已释放；保留失败记录，不保证同一标识可重新派发 |
| `unknown` | 保留未知结果，交给管理员核对；不自动换标识/渠道 |
| `request_not_found` | 当前 Consumer 未找到持久记录；保留原意图并确认身份/网络，不盲目创建新付费请求 |

Web Search **未实现**电商的 `X-MX-Insight-Retry-Of` 强制重采流程，不要据通用请求文档把电商重采策略套用到这里。重新获取相同搜索是一个新的业务意图，需明确接受可能重复消费，再使用新标识发送。

| HTTP | 常见 error.code | 处理 |
| --- | --- | --- |
| 400 | `invalid_web_search_request`、`invalid_web_search_provider`、`idempotency_key_required`、`web_search_options_unsupported`、`page_size_exceeded` | 修正字段、渠道或总量；参数改变不要覆盖已绑定意图 |
| 401 / 403 | `web_search_not_granted`、`web_search_provider_not_granted`、`platform_not_granted`、`capability_not_granted`、`test_key_not_supported` | 核对 Hub Live Key 状态与 Consumer/Key 交集授权 |
| 402 / 429 | 余额、额度、并发、限流或渠道拒绝的具体代码 | 按 code 处理；保留原标识，不自动换标识购买 |
| 409 | `idempotency_conflict`、`request_in_progress`、`request_outcome_unknown` | 冲突时核对原参数；后两者查询原状态 |
| 502 | `web_search_upstream_rejected`、`web_search_upstream_outcome_unknown`、`web_search_upstream_response_unusable` | 保留错误、原标识及 requestId，核对原请求；不自动换渠道 |
| 503 | `web_search_no_ready_provider`、`web_search_unavailable`、`web_search_egress_unavailable` 或操作/预算/熔断阻断 | 管理员核对配置与运行状态；ready 与最终准入是不同阶段 |

错误 envelope 为 `{error:{code,message,details?},requestId}`。`message` 用于显示，程序优先判断 HTTP 与 code；不要解析英文文案。`details` 可包含原 requestId、outcome 与 `retryable:false`；HTTP 失败不等于已证明供应商未扣费。

## 百度输入兼容入口

将下面 JSON 发送到 `/api/v1/data/web-search/compatible/baidu`，HTTP 头仍为 Hub Key、Content-Type 和 Idempotency-Key：

```json
{
  "messages": [{"role":"user","content":"人工智能"}],
  "resource_type_filter": [{"type":"web","top_k":10}],
  "edition": "standard"
}
```

只接受一条 user message。`resource_type_filter[].top_k` 对应统一 resources[].limit，`search_filter.match.site` 对应 sites，`search_filter.range.page_time.gte/lte` 对应 from/to，`search_recency_filter` 对应 recency。仅此入口把同时为空的 gte/lte 视作未设置日期。

响应是 Hub `data.items`，不是百度原生 `references`，不承诺完整原生 API 兼容。上例与统一入口 `{query:"人工智能",provider:"baidu",limit:10}` 在同 Key、同标识时共享交付；省略 provider 的动态选择请求是不同意图，不能与百度兼容请求互换同一个幂等标识。
