# MX Insight Hub Public API curl 使用指南

本文覆盖以 `$HUB_URL` 为 origin 暴露的健康检查、公开文档、需要认证的数据/工具 API，
以及当前 consumer 自己的请求证据。调用方只需使用部署方提供的 HTTPS `$HUB_URL`；
未在公开 OpenAPI 声明的路由，以及 Hub 内部路由、部署拓扑与供应方选择不属于公开合同。

实现所维护的机器可读契约位于 `GET /docs/openapi.json`。如果本文与该文档不一致，
在发送可能付费或改变状态的请求前，应先停止调用并核对部署版本。

## 1. Shell 环境

以下示例可在 Bash 或 Zsh 中执行。`HUB_URL` 是不含 `/api/v1` 的服务 origin。
请先根据 `GET /api/v1/data/capabilities` 确认当前 consumer 的平台授权。
`HUB_PLATFORM=telegram` 仅用于第 4 节的 Hub 搜索示例；Night-All 兼容层使用独立的
分平台变量，避免把 Telegram 误当成三个 legacy operation 的共同支持平台。所有
默认值只说明请求格式和 operation 选择，不会绕过平台授权或 Hub dispatch eligibility
检查。

```bash
export HUB_URL="${HUB_URL:-https://hub.minsight-ai.com}"
export HUB_KEY="${HUB_KEY:?set HUB_KEY to an issued MX Insight Hub API key}"
export HUB_PLATFORM="${HUB_PLATFORM:-telegram}"
export NIGHT_ALL_RAW_PLATFORM="${NIGHT_ALL_RAW_PLATFORM:-xiaohongshu}"
export NIGHT_ALL_ACCOUNT_PLATFORM="${NIGHT_ALL_ACCOUNT_PLATFORM:-twitter}"
export NIGHT_ALL_ACCOUNT_USERNAME="${NIGHT_ALL_ACCOUNT_USERNAME:-openai}"

new_idempotency_key() {
  printf 'docs-%s-%s-%s\n' "$(date +%s)" "$$" "$RANDOM"
}
```

需要认证的示例使用 `Authorization: Bearer $HUB_KEY`。也可以改用
`x-api-key: $HUB_KEY`，但不要同时发送两种认证头。

下文每个 POST 都会生成格式合法且新的 `Idempotency-Key`。默认情况下，如果只是重试
**相同路径和完全相同的规范化 body**，应复用已有的 `IDEMPOTENCY_KEY`，不要再次
执行 `new_idempotency_key`；更换 body、路径或 cursor 页面必须使用新的 `Idempotency-Key`。
第 3.4 节的小红书正文解析是明确例外：GET 平台路径、POST 平台路径和
`POST /api/v1/data/post` 三个入口共享一个 canonical 幂等 namespace。同一次逻辑请求的重试
不能仅因 method 或入口路径写法变化而生成新的 `Idempotency-Key`，且应保持规范化笔记标识和
`deliveryMode` 不变；复用 key 后改变 `deliveryMode` 会返回 `409 idempotency_conflict`。
同一个 key 对应其他不同请求也会返回 `409 idempotency_conflict`。POST 重试还必须继续使用创建该
usage 记录的同一把 Hub API Key；同一 consumer 的另一把 Key 只能执行只读状态查询，不能接管旧记录，
需要发起新业务请求时应使用新的 `Idempotency-Key`。

所有 JSON 错误均采用稳定结构：

```json
{
  "error": {
    "code": "stable_code",
    "message": "安全的公开错误信息",
    "details": {}
  },
  "requestId": "request-correlation-id"
}
```

常见状态包括：`400` 请求无效、`401` API Key 缺失或无效、`403` 缺少授权、
`409` 幂等冲突/处理中/结果未知、`410` 搜索 cursor 过期、`429` 配额耗尽、
`502` 上游失败或结果存在歧义，以及 `503` 存储数据或工具运行时不可用。

## 2. 健康检查与公开文档（无需 API Key）

### `GET /health` 和 `GET /health/live`

两个路径是等价的存活检查，成功时返回 `200` 和 `data.status=live`。存活不代表
数据库、搜索服务或任一外部数据连接已经就绪。

```bash
curl -sS -i "$HUB_URL/health"
curl -sS -i "$HUB_URL/health/live"
```

### `GET /health/ready`

只有 Hub 所需依赖全部正常时才返回 `200` 和 `data.status=ready`；否则返回 `503`
和 `data.status=not_ready`。ready 门禁以 Hub 必需存储为准，外部数据连接的诊断状态
不把整个 Hub 判为 not-ready。`$HUB_URL` 的部署策略可能只返回摘要；客户端不能依赖
可选诊断明细，响应不得包含连接坐标或凭据。

```bash
curl -sS -i "$HUB_URL/health/ready"
```

### `GET /health/dependencies`

该路径属于部署方可选的安全依赖摘要，可能在客户 `$HUB_URL` 上不可用并返回 `404`；
无需 API Key。它只适合运维诊断，业务调用方不能把它当作稳定数据 API，也不能依赖
某个具体依赖名称一定出现。

```bash
curl -sS -i "$HUB_URL/health/dependencies"
```

### `GET /docs`（`/docs/` 是别名）

返回自包含的 HTML 公开指南开始页，可缓存五分钟。左侧每个标签都有独立路由，可直达、刷新和复制链接：

| 文档页 | 路径 |
| --- | --- |
| 认证与调用规则 | `/docs/auth` |
| 数据源目录 | `/docs/source-catalog` |
| 虚拟超市 | `/docs/virtual-supermarket` |
| Telegram 会话 | `/docs/telegram` |
| 全国舆情 | `/docs/public-opinion` |
| 通用搜索 | `/docs/search` |
| Night-All 兼容层 | `/docs/night-all` |
| 通用工具 | `/docs/tools` |
| 能力与证据 | `/docs/evidence` |
| 错误与重试 | `/docs/errors` |

`/docs/authentication` 和 `/docs/operations` 保留为旧路径的 308 规范化跳转。旧的
`/docs#telegram` 等锚点会由开始页跳到对应的新路由，新页面不再下发整份长文档。

```bash
curl -sS "$HUB_URL/docs"
```

### `GET /docs/openapi.json`

返回 OpenAPI 3.1 公开机器契约，并允许跨域读取。

```bash
curl -sS "$HUB_URL/docs/openapi.json"
```

## 3. 能力发现

### `GET /api/v1/data/capabilities`

参数：无。`data.platforms` 只描述当前 consumer 已授权的 Hub 数据面；
`data.legacySearch` 是三条 Night-All compatibility operation 的 Hub-pinned、按 grants
过滤的 dispatch 矩阵，其固定版本为
`night-all.legacy-search-capabilities.v1`。矩阵由当前 Hub 发布版本固定，不会在请求时从
Night-All `/api/v1/search/capabilities` 实时发现。选择 `HUB_PLATFORM`、调用
`nlp.tokenize`、全国/省级 all-ingested 舆情 feed 或执行 Night-All compatibility 请求前，
都应先读取此接口。当前 consumer 没有可用于 Night-All-owned 历史执行路径的平台 grant 时，
`legacySearch` 为 `null`，该历史路径会 fail closed；`data.platforms` 中单独广告的
Hub-native contract 不受它门禁。

Direct search 只接管兼容的首屏 raw 子集，不会把小红书从 `legacySearch` 移除。对于同时
授权小红书与 Twitter 的 consumer，`raw`、`crawl` 和 `user-info` 三项矩阵仍会在
`supportedPlatforms`/`readyPlatforms` 中列出两个平台；小红书的非 direct 形状继续由该
历史矩阵门禁。

```bash
curl -sS -i \
  -H "Authorization: Bearer $HUB_KEY" \
  "$HUB_URL/api/v1/data/capabilities"
```

对某个 Night-All-owned operation，平台必须同时出现在
`data.legacySearch.operations.<operation>.supportedPlatforms` 与 `readyPlatforms` 中才可
dispatch。这里的 `readyPlatforms` 是兼容字段，表示当前 Hub 固定契约允许 dispatch；
它不证明 Night-All 当前 handler、endpoint、provider、credential 或上游健康。
`data.platforms[]` 中出现 `telegram` 只代表 Hub stored/monitor 数据面可用，
其平台项使用 `source=hub`、`servingMode=stored`；这不代表 Telegram 支持 Night-All
legacy search。若该项包含 `message_context`，应继续检查 `context.ready` 和
`context.datasets`；若包含 `message_timeline`，则检查 `timeline.ready`、
`timeline.consistency=live-keyset` 和 `timeline.datasets`。两者的 ready 都是独立的索引
服务门禁，dataset 清单是明确支持范围。Key 缺失、无效或已撤销时返回 `401`。

P1 地区目录需要 `data.platforms[]` 中存在 `platform=public_opinion`，且其
`capabilities` 包含 `region_catalog`。全国/省级 all-ingested feed 还要求同一平台项
包含 `region_feed`，并在独立的 `data.capabilities[]` 中出现：

```json
{ "capability": "public_opinion.all_ingested.read", "ready": true }
```

`public_opinion` platform grant 与 `public_opinion.all_ingested.read` 是两个独立门禁，
缺少任意一个都不能读取该 feed；后者不默认授予，也不会自行授予数据平台访问权。
后者的 `ready=true` 还表示 region feed 专用的全局 latest 索引和
revision-fenced display-province 索引均已通过精确合同校验。

`public_opinion.diagnostics.read` 是另一个非默认 step-up capability，与
`public_opinion` platform grant 同时存在时才能查看漏斗和未展示记录。
`source_catalog` 平台项使用 Hub stored 数据面，能力包括
`catalog_entries`、`catalog_metadata`、`catalog_detail` 和 `filtered_browse`。
`virtual_supermarket` 是独立的 Hub stored 发布产品授权；它不由
`mobile_commerce` 或 `source_catalog` 授权推导。当平台项 `ready=true`
时，应包含 metadata、products、product_detail、stored_search 和已实现的语义
分类筛选能力，但不包含上下架或 Admin CRUD。

调用第 3.3 节前，必须看到显式 `platform=ecommerce` 项。它应广告
`capabilities=[product_search]`、
`contractVersion=mx-insight-hub.ecommerce-products.v1`、支持的 marketplaces、
`pagination=opaque_cursor`、`idempotencyKey=optional`、
`servingMode=live_with_stored_fallback` 和四种 freshness mode。`ready=true` 只表示当前
Hub 部署有可用 adapter，不承诺下一次外部调用的网络、余额、配额或实时健康。
若调用凭据是仍可认证的旧 `mih_test_` Key 且所属 consumer 有 ecommerce grant，该项仍会出现，
但固定为 `ready=false`；Test 只是兼容元数据，不是可调用的 ecommerce 沙箱。读取 capabilities
本身不创建 ecommerce usage reservation，也不调用供应方。

调用小红书搜索前，应看到 `platform=xiaohongshu` 项包含 `search_posts`，并检查
`search.ready=true`；这表示独立的首屏 rollout gate 已开启。其 `search` 子契约使用 `source=hub`、
`servingMode=live_with_stored_fallback` 和
`contractVersion=night-all.data-search.v1`。`post_detail` 与 `postDetail` 只在当前 Key
还拥有独立 `social.posts.resolve` capability 时出现；拥有 `search_posts` 不会自动授权
第 3.4 节的显式笔记详情 API。
若 compatibility capability 已含小红书顶层项，Hub 保留它原有的 provider-neutral
`ready`/source identity；不能把顶层 `ready` 或 `source=hub` 当成 direct readiness。
只有嵌套 `search.ready`/`search.source` 与 `postDetail.ready`/`postDetail.source` 描述
Hub-direct 合同。

## 3.1 数据源目录 API

本节需要显式 `source_catalog` platform grant，只接受 API Key。负责 consumer 的
Hub operator 必须先完成授权；调用者不能通过 Public API 自行授权。三个 GET 都独立
计量且不使用幂等 key。operator 在 Hub 管理台“开放能力”中依次选择租户、调用者和
“数据源目录”，配置配额后启用。新 Key 在签发时冻结明确的平台/能力范围；撤销 consumer
授权会立即收窄旧 Key，新增授权则必须重新签发并显式勾选该范围。迁移期的
`legacy_dynamic` Key 仅用于兼容，应该轮换。
为了让本节可以单独复制执行，请静默读取 API Key，避免把凭据写入 shell history：

```bash
read -rsp 'MX Insight API Key: ' MX_INSIGHT_API_KEY
export MX_INSIGHT_API_KEY
printf '\n'
```

### 授权预检

先确认当前 Key 对应的 consumer 确实获得目录授权。结果必须有
`platform=source_catalog`、`ready=true`，并包含 `catalog_entries`、
`catalog_metadata`、`catalog_detail` 和 `filtered_browse`：

```bash
curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/capabilities" \
  | jq '.data.platforms[] | select(.platform == "source_catalog")'
```

没有该平台项时，请让 operator 为当前 consumer 授权；不要尝试用管理凭据替代
Public API Key。

### `GET /api/v1/data/source-catalog/metadata`

建议在构造筛选条件前先调用 metadata。它返回公开字段/枚举、active taxonomy、
负责人公开投影、summary 和 facets，供外部系统还原目录筛选器和看板。列表和
metadata 都不包含 `evidenceRefs/customFields/importedFrom/events/related-data`、
登录绑定、连接或凭据。该接口不接受 query 参数；传入任何 query key 都返回
`400 unsupported_fields`。

```bash
curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/source-catalog/metadata" \
  | jq '{contractVersion: .data.contractVersion,
         fields: .data.fields,
         enums: .data.enums,
         summary: .data.summary,
         facets: .data.facets,
         taxonomy: .data.taxonomy,
         owners: .data.owners,
         requestId}'
```

- `summary` 的固定字段是 `total`、`covered`、`uncovered`、`partial`、`unknownCoverage`、
  `coverageRate`、`complete`、`inProgress`、`exploring`、`blocked`、`unassigned`、
  `coverage`、`delivery`、`priorities`、`review`、`categories`。
- `facets` 的固定字段是 `majorCategories`、`scenarios`、`regions`、`owners`、
  `connectorHints`、`tags`。

调用方应使用 metadata 返回的精确 taxonomy、owner ID 和 enum 值生成 filters。

### `GET /api/v1/data/source-catalog`

支持 `query`、`sourceKind`、`majorCategory`、`scenario`、`region`、
`coverageStatus`、`deliveryStatus`、`reviewStatus`、`runtimeStatus`、`priority`、
`ownerId`、`tag`、`pageSize`和`cursor`。`pageSize` 默认 50，上限 100，且可被
platform policy 进一步降低。返回 active-only 的 `source-catalog.public.v1`
公开投影及 `returnedCount/totalCount/hasMore/nextCursor`。
普通业务备注仍会返回；若误粘了 DSN、带凭据 URL、私网连接、API key、token、
password 等高置信凭据内容，Hub 会在搜索和 facet 计算前按字段移除，并在条目的
`redactedFields` 中列出字段名。taxonomy/负责人只有发生脱敏时才返回该字段。

```bash
FIRST_PAGE=$(curl -sS --get \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'coverageStatus=covered' \
  --data-urlencode 'deliveryStatus=doing' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/source-catalog")

printf '%s\n' "$FIRST_PAGE" \
  | jq '{contractVersion: .data.contractVersion,
         items: .data.items,
         filters: .data.filters,
         pageInfo: .data.pageInfo,
         requestId}'
```

cursor 是绑定完整 filters 和 pageSize 的 HMAC 签名 keyset，稳定顺序为
`(legacySequence NULLS LAST, canonicalName, id)`。条件改变后应移除 cursor
从首页开始；复用旧 cursor 返回 `400 invalid_cursor`。

仅当 `pageInfo.hasMore=true` 时，原样携带 `nextCursor`，并保持所有 filters 和
`pageSize` 不变：

```bash
NEXT_CURSOR=$(printf '%s\n' "$FIRST_PAGE" | jq -r '.data.pageInfo.nextCursor // empty')

curl -sS --get \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'coverageStatus=covered' \
  --data-urlencode 'deliveryStatus=doing' \
  --data-urlencode 'pageSize=50' \
  --data-urlencode "cursor=$NEXT_CURSOR" \
  "$HUB_URL/api/v1/data/source-catalog" | jq
```

### `GET /api/v1/data/source-catalog/{id}`

从列表条目取得 active UUID，再读取同一份 customer-safe `SourceCatalogEntry` 投影。
详情路由不接受 query 参数；不要从名称、sequence 或其他业务字段自行拼接 ID。

```bash
SOURCE_ID=$(printf '%s\n' "$FIRST_PAGE" | jq -r '.data.items[0].id')

curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/source-catalog/${SOURCE_ID}" \
  | jq '{contractVersion: .data.contractVersion, item: .data.item, requestId}'
```

### 稳定错误码

| HTTP | `error.code` | 处理方式 |
| --- | --- | --- |
| 400 | `invalid_request`, `invalid_cursor`, `invalid_source_catalog_id`, `page_size_exceeded`, `unsupported_fields` | 修正字段、UUID 或分页状态；不要原样重试。 |
| 401 | `api_key_required`, `invalid_api_key` | 提供或轮换当前 consumer 的 API Key。 |
| 403 | `platform_not_granted` | 让 operator 为该 consumer 授予 `source_catalog`。 |
| 404 | `source_catalog_entry_not_found` | 重新从列表获取 active UUID。 |
| 429 | `quota_exceeded` | 等待 platform policy 的计量窗口恢复。 |
| 503 | `stored_data_unavailable` | 安全 GET 可稍后重试；保留 `requestId` 供排查。 |

## 3.2 虚拟超市 API

这些路由只接受 API Keys 生命周期签发的 Hub Public API Key，并要求独立
`virtual_supermarket` platform grant。仅有 `mobile_commerce` 或
`source_catalog` 授权不能访问。首先预检：

```bash
curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/capabilities" \
  | jq '.data.platforms[] | select(.platform == "virtual_supermarket")'
```

返回项必须是 `source=hub`、`servingMode=stored`、`ready=true`，并广告
metadata/products/detail/search 与已实现的分类筛选能力。该发现项不含管理、
上下架或远程手机采集能力。

### `GET /api/v1/data/virtual-supermarket/metadata`

metadata 返回 `mx-insight-hub.data-products.virtual-supermarket.v1`、
`storefrontRevision` 和有序的 department/aisle/shelf/category 语义。它足以构造“逛超市”、
“超市全景”或“目录模式”；全景完全由客户端渲染，响应不包含 WebGL 坐标、摄像机、
网格、材质或灯光。

```bash
MARKET_META=$(curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/virtual-supermarket/metadata")

printf '%s\n' "$MARKET_META" \
  | jq '{contractVersion: .data.contractVersion,
         storefrontRevision: .data.storefrontRevision,
         departments: .data.departments,
         requestId}'
```

### `GET /api/v1/data/virtual-supermarket/products`

列表只返回已上架 safe projection。支持 `categoryId`、`department`、`aisle`、
`shelf`、`marketplace`、`query`、`sort`、`pageSize` 和 `cursor`。`sort` 默认
`newest`，且只能是 `newest|title_asc|price_asc|price_desc`；v1 不提供服务端
merchandising sort。

```bash
PRODUCT_PAGE=$(curl -sS --get \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'department=home-care' \
  --data-urlencode 'aisle=laundry' \
  --data-urlencode 'sort=newest' \
  --data-urlencode 'pageSize=24' \
  "$HUB_URL/api/v1/data/virtual-supermarket/products")

printf '%s\n' "$PRODUCT_PAGE" \
  | jq '{storefrontRevision: .data.storefrontRevision,
         items: .data.items,
         pageInfo: .data.pageInfo,
         requestId}'
```

`placement.department/aisle/shelf/position` 是语义货位和陈列顺序，不是三维坐标。
price amount 使用 decimal string，并返回 display/provenance。当前固定源没有 currency 字段，
所以 source price 的 `currency=null`，不能猜成 CNY；只有人工 curated price override 才携带
已审核的三位 ISO currency。商品外层 `collectedAt` 是采集观测时间，不代表平台实时交易价。
当前 v1 不发布 brand 或 media 字段；规格未审核时为 null。

下一页原样回传 `nextCursor`，并保持所有 filters、sort 和 pageSize 不变。cursor
与完整条件及 `storefrontRevision` 绑定；条件改变后从无 cursor 首页开始。

### `GET /api/v1/data/virtual-supermarket/products/{id}`

使用列表返回的独立 Hub publication UUID 读取同一 allowlist 详情。这个 UUID 不是
mobile-commerce capture/canonical row ID，不能用 capture ID 调用此详情路由。下架、归档或不存在统一返回
`404 virtual_supermarket_product_not_found`；调用方不能据此探测内部状态。下架只改变 Hub
storefront overlay，不删除 canonical capture。

```bash
PRODUCT_ID=$(printf '%s\n' "$PRODUCT_PAGE" | jq -r '.data.items[0].id')

curl -sS \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  "$HUB_URL/api/v1/data/virtual-supermarket/products/$PRODUCT_ID" | jq
```

### `GET /api/v1/data/virtual-supermarket/search`

搜索是安全、已计量的 GET，`query` 必填，其余筛选和 cursor 规则与 products 相同。
调用方不能指定 Elasticsearch index、field、analyzer、DSL、script 或 boost。

```bash
curl -sS --get \
  -H "Authorization: Bearer $MX_INSIGHT_API_KEY" \
  --data-urlencode 'query=婴儿洗衣液' \
  --data-urlencode 'sort=price_asc' \
  --data-urlencode 'pageSize=20' \
  "$HUB_URL/api/v1/data/virtual-supermarket/search" | jq
```

### 外部复刻流程

外部应用先读取 metadata，记录它的 `storefrontRevision`，再用 `products` 的默认
`sort=newest` 从无 cursor 首页逐页读取到 `nextCursor=null`。每一页必须与 metadata 保持同一
revision；任一页不同或遇到 `409 storefront_revision_changed` 时，丢弃未完成的本地快照，重新读取
metadata 和无 cursor 首页。

完整快照取完后，客户端按 metadata 中 department/aisle/shelf/category 的 `sortOrder` 建导航，
再按每个 item 的 `placement.position` 陈列；position 相同或为空时用独立 publication UUID
稳定打破平局。不要把 API 的 `newest` 分页顺序误当成货架顺序。客户端可以分别实现 2D 逛超市、
3D 全景或可访问目录，但不应从屏幕/WebGL 坐标反推业务分类。

所有这些响应都不包含 capture/source row ID、marketplace product/shop source ID、marketplace raw label/
映射状态/内部 source key、task/run/campaign、raw tags/share payload、metadata/device/`is_reported`、
source profile/table/checkpoint、Admin audit 或凭据。公开 marketplace 只有经审核的 `{id,name}`；
未有 approved mapping 时二者均为 null。

## 3.3 外部数据平台商品搜索

### `POST /api/v1/data/ecommerce/products/search`

该接口需要当前 consumer 的 `ecommerce` platform grant。Hub 通过受治理的外部数据平台
完成实时商品搜索，但公开契约不是透明转发：不会返回外部平台身份、凭据、接口地址、私有
continuation 或 raw response。

`ecommerce` 是供应方中立的数据授权域，不代表某一家物理数据供应方。当前发布只有一个私有
合格适配器，尚未启用多供应商运行时路由或自动故障转移；未来新增已验证适配器不改变调用方
契约。缺失、无效或已撤销
的 Hub Public API Key 返回 `401 invalid_api_key`（完全缺少凭据时为
`401 api_key_required`）；仍可认证的 `mih_test_` Key 返回
`403 test_key_not_supported`；有效 Live Key 但 consumer 未获 `ecommerce` grant 时才返回
`403 platform_not_granted`。Test 拒绝发生在 grant、usage reservation、缓存和 provider dispatch
之前，不会创建 usage reservation 或上游调用。调用方应据此区分“重新提供/签发 Key”、
“使用 Live Key”和“补授数据域权限”。
这里使用管理台 **API Keys** 已签发的同一把 Key；不需要为 ecommerce 另签 Key，也不需要或
接受供应方密钥。新 Key 必须在签发时把 `ecommerce` 选入 entitlement snapshot；consumer
撤权会立即阻断它，但之后重新授予不会静默扩大旧 Key，需要签发明确包含该范围的替代 Key。
本节所有搜索和媒体示例要求 `$HUB_KEY` 是以 `mih_live_` 开头的完整 Hub Public API Key。
若旧版百宝箱留下 Test-key `ambiguous` 记录，只保留原 body、原 `Idempotency-Key` 和指纹锁供
审计；不要粘贴旧 Test secret 或换成 Live Key 重放该请求。管理台使用当前 Live Key 自动执行
consumer-scoped 状态 GET，不要求用户填写 UUID 或人工核查 consumer 归属。独立的本地安全演示和
`cache_only` 存量读取不创建 provider call，仍可继续使用。

body 是严格对象，只允许以下字段：

| 字段 | 规则 |
| --- | --- |
| `marketplace` | 必填；`taobao\|tmall\|jd\|xiaohongshu_ec\|xianyu`。 |
| `query` | 必填；NFKC 规范化并 trim 后 1–200 字符。 |
| `deliveryMode` | 可选；`cache_only\|cache_first\|refresh`，默认 `cache_first`。`cache_only` 禁止上游派发；`refresh` 绕过新鲜快照且必须显式提供 Idempotency-Key。 |
| `page` | 可选；整数 `1..1000`，默认 1，不能与 `cursor` 同时使用。 |
| `cursor` | 可选；上一页返回的不透明 `nextCursor`，最多 4096 字符。 |
| `sort` | marketplace 专属：淘宝/天猫支持 `relevance\|sales_desc\|price_asc\|price_desc`；闲鱼支持 `relevance\|recent\|seller_credit\|price_asc\|price_desc\|price_drop\|newest`；京东和小红书店铺不接受。 |
| `price` | 仅淘宝/天猫；`min/max` 必须是非负 decimal string（整数最多 12 位、小数最多 8 位，不接受指数、空白或前导零），且 min 不得大于 max。 |

`page` 与 `cursor` 互斥；首次遍历可以省略二者，后续优先使用 Hub 返回的 cursor。
没有 `pageSize`。返回条数由 Hub 的有界策略决定，传入 `pageSize` 或任意路由、凭据字段会
返回 `400 unsupported_request_field`。管理端百宝箱中的 `3 / 6 / 9` 只是把当前已返回批次
在浏览器中分组陈列，不进入请求 body、不改变 Hub 数据页，也不会单独触发下一次搜索。

首页调用：

```bash
ECOMMERCE_BODY='{"marketplace":"taobao","query":"AI recorder","sort":"sales_desc","price":{"min":"100","max":"800"}}'
ECOMMERCE_FIRST_KEY="$(new_idempotency_key)"

ECOMMERCE_FIRST=$(curl -sS -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $ECOMMERCE_FIRST_KEY" \
  -d "$ECOMMERCE_BODY" \
  "$HUB_URL/api/v1/data/ecommerce/products/search")

printf '%s\n' "$ECOMMERCE_FIRST" \
  | jq '{contractVersion, items: .data.items, page: .data.page, freshness: .meta, requestId}'
```

若要保证本次不产生外部平台调用，使用同一路径并显式发送 `cache_only`。命中存量会形成一笔
新的 Hub usage，未命中返回 `404 stored_snapshot_not_found` 并释放预留；两种情况都不会创建
provider-call：

```bash
ECOMMERCE_STORED_KEY="$(new_idempotency_key)"
ECOMMERCE_STORED_BODY='{"marketplace":"taobao","query":"AI recorder","sort":"sales_desc","price":{"min":"100","max":"800"},"deliveryMode":"cache_only"}'
curl -sS -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $ECOMMERCE_STORED_KEY" \
  -d "$ECOMMERCE_STORED_BODY" \
  "$HUB_URL/api/v1/data/ecommerce/products/search" | jq
```

若要明确尝试一次可能产生外部供应方采购成本的新采集，将同一 body 的 `deliveryMode` 设为
`refresh`，生成一个新的 Idempotency-Key，并且只执行一次。不要把该调用放入 readiness 或
自动重试循环。对管理台百宝箱，选择“重新采集”并点击主搜索按钮就是这次明确授权，不再有
独立复选框或二次“核对”按钮。

```bash
ECOMMERCE_REFRESH_KEY="$(new_idempotency_key)"
ECOMMERCE_REFRESH_BODY=$(printf '%s\n' "$ECOMMERCE_BODY" | jq -c '. + {deliveryMode:"refresh"}')
curl -sS -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $ECOMMERCE_REFRESH_KEY" \
  -d "$ECOMMERCE_REFRESH_BODY" \
  "$HUB_URL/api/v1/data/ecommerce/products/search" | jq
```

同一页发生网络传输重试时，原样复用 `ECOMMERCE_FIRST_KEY` 和 body。调用下一页时必须使用
新的 Idempotency-Key，因为 cursor 使 body 发生变化；复用首页 key 会返回
`409 idempotency_conflict`：

```bash
ECOMMERCE_CURSOR=$(printf '%s\n' "$ECOMMERCE_FIRST" | jq -r '.data.page.nextCursor // empty')

if [ -n "$ECOMMERCE_CURSOR" ]; then
  ECOMMERCE_NEXT_KEY="$(new_idempotency_key)"
  ECOMMERCE_NEXT_BODY=$(printf '%s\n' "$ECOMMERCE_BODY" \
    | jq -c --arg cursor "$ECOMMERCE_CURSOR" '. + {cursor: $cursor} | del(.page)')
  curl -sS -X POST \
    -H "Authorization: Bearer $HUB_KEY" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $ECOMMERCE_NEXT_KEY" \
    -d "$ECOMMERCE_NEXT_BODY" \
    "$HUB_URL/api/v1/data/ecommerce/products/search" | jq
fi
```

cursor 经认证加密，并与 consumer 及 `marketplace/query/sort/price` 绑定；必须保持这些字段
不变并原样回传 cursor，不能解码、篡改或跨 consumer 使用。
部分 marketplace 的第二页只能通过 cursor 继续，不能自行拼数字页码。`nextCursor=null`
时停止；`hasMore=null` 表示外部响应没有提供足够证据让 Hub 发放安全 cursor，同样必须停止，
不能猜测 continuation。

成功 envelope 固定为：

```json
{
  "contractVersion": "mx-insight-hub.ecommerce-products.v1",
  "data": {
    "items": [],
    "page": {
      "page": 1,
      "returnedCount": 0,
      "discardedCount": 0,
      "hasMore": false,
      "nextCursor": null
    }
  },
  "meta": {
    "capturedAt": "2026-09-03T00:00:00.000Z",
    "servedAt": "2026-09-03T00:00:00.010Z",
    "sourceMode": "live",
    "ageSeconds": 0
  },
  "requestId": "00000000-0000-4000-8000-000000000006"
}
```

`data.items[]` 只包含 provider-neutral 字段：`id/marketplace/title/url`、
`pricing{current,original,currency}`、`shop{id,name}`、`images[]`、
`signals{sales,reviewCount,location}` 与 `attributes{brand,category}`。无法可靠映射的可选值为
`null` 或空数组，不会伪造。

### `GET /api/v1/data/ecommerce/products/media`

商品响应中的 `images[]` 是来源引用，不应由管理浏览器直接加载。需要显示图片时，使用同一
`mih_live_` Hub Public API Key，通过 Hub 安全中继读取已提交商品响应中的指定图片：

```bash
curl -sS -G \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode "requestId=$(printf '%s\n' "$ECOMMERCE_FIRST" | jq -r '.requestId')" \
  --data-urlencode "itemId=$(printf '%s\n' "$ECOMMERCE_FIRST" | jq -r '.data.items[0].id')" \
  --data-urlencode 'imageIndex=0' \
  "$HUB_URL/api/v1/data/ecommerce/products/media" \
  --output product-image
```

三个 query 参数均必填：`requestId` 是商品搜索成功 envelope 的 Hub request ID，`itemId` 是该
响应中的商品 ID，`imageIndex` 是 `0..19` 的整数。这也是完整 query allowlist；额外参数返回
`400 unsupported_fields`。接口不接受 URL；Hub 只会从指定的已提交响应中解析图片来源，并
通过限制协议、地址、重定向、类型和大小的安全中继返回 JPEG、PNG 或 WebP 内容。

读取必须同时满足：`mih_live_` API Key 有效、consumer 当前仍有 `ecommerce` grant、`requestId` 属于同一
consumer、该请求是已提交且 HTTP 200 的 ecommerce 请求，并且 item/index 确实存在。认证失败
返回 `401 invalid_api_key`，缺少数据域权限返回 `403 platform_not_granted`，来源不存在或不属于
当前 consumer 统一返回 `404 external_media_not_found`。图片来源被安全策略拒绝时返回 4xx，
外部图片暂不可读取时返回 502，端到端超时返回 `504 external_media_timeout`。超过 consumer 媒体请求窗口返回
`429 external_media_rate_limited`；consumer 或中继全局并发已满返回
`429 external_media_busy`。图片源站自身返回 429 时，Hub 返回不可自动重试的
`502 external_media_source_throttled`，不会把源站限流伪装成 Hub busy；调用方必须停止放大重试。

这次 GET 不创建 Hub usage，不派发商品搜索，也不改变原搜索的 `sourceMode`；它只是按既有
提交结果读取一项媒体内容。它仍可能按需访问图片来源，因此客户端不要轮询或并发放大；Hub
内部使用同 consumer 范围的短时有界缓存来避免重复拉取。响应使用实际图片 Content-Type、
`X-Content-Type-Options: nosniff`、`Cache-Control: private, no-store` 与
`Vary: Authorization`；浏览器和共享代理不得保留或跨 bearer 复用响应。
有效 Test Key 会在 Hub 查询已提交结果或调用媒体加载器之前返回
`403 test_key_not_supported`，不会创建 usage、读取图片来源或触发商品搜索。

`meta.sourceMode` 与响应头 `x-mx-insight-source-mode` 一致：

| sourceMode | 含义 | 客户端判断 |
| --- | --- | --- |
| `live` | 本次完成新的外部数据调用。 | 仍使用 `capturedAt/ageSeconds` 判断时效。 |
| `fresh_cache` | 同 consumer、同规范化请求的有效快照；没有再次外部调用。 | 当作该 capturedAt 的快照。 |
| `stored_fallback` | 实时路径不可用，返回同请求的 last-good 快照。 | 检查 `fallbackReason`、`Age`、`Warning: 110`，不得标成实时。 |
| `idempotent_replay` | 同 `Idempotency-Key`、同 path/body 的已提交结果。 | `idempotent-replay: true`，不产生新的外部调用。 |

`Idempotency-Key` 对 `cache_only` 和 `cache_first` 可省略，但 `refresh` 必须提供；建议所有模式
都显式提供。省略时 Hub 只根据规范化请求生成
短期 freshness-bucket key，客户端不能用它实现持久重放。缓存与 fallback 都严格绑定当前
consumer 和完整请求 fingerprint，不会跨 consumer、模糊 query 或用 canonical search
结果拼装。

常见错误：

| HTTP | `error.code` | 处理方式 |
| --- | --- | --- |
| 400 | `unsupported_marketplace`, `unsupported_sort`, `unsupported_price_filter`, `invalid_pagination`, `cursor_scope_mismatch`, `unsupported_request_field`, `invalid_delivery_mode`, `idempotency_key_required` | 修正请求、交付策略或从无 cursor 首页开始，不要原样重试。 |
| 401 | `api_key_required`, `invalid_api_key` | 提供当前 Hub 实例通过 API Keys 签发的完整 Hub Public API Key；不要用管理令牌、掩码或供应方密钥。 |
| 403 | `test_key_not_supported` | 外部 ecommerce 仅接受 `mih_live_` Hub Public API Key。不要把 Test 当沙箱，也不要用 Live Key 替代历史模糊请求来自动重放。该拒绝不创建 usage reservation 或上游调用。 |
| 403 | `platform_not_granted` | Key 的 snapshot 没有 `ecommerce`，或 consumer 已撤销该授权；授权后签发明确包含该范围的新 Key。 |
| 400 | `invalid_uncertain_retry` | `X-MX-Insight-Retry-Of` 格式错误或未与 `refresh` 配对。管理台会从自动状态 GET 构造该头；不要手填或猜 UUID。 |
| 404 | `stored_snapshot_not_found` | `cache_only` 未命中精确存量；本次没有调用外部平台。可换条件，或选择 `refresh` 并点击主按钮授权一次采集。 |
| 409 | `request_in_progress`, `idempotency_conflict`, `request_outcome_unknown`, `uncertain_retry_not_allowed` | 保留原 `Idempotency-Key`/requestId，不要自动换 Key。管理台由同一主按钮先执行状态 GET；只有明确为 `unknown` 且当前选择 `refresh` 时，才自动使用新 Key 和 retry-of 头发起一次独立采集。 |
| 409 | `external_platform_response_unusable` | 近期同 endpoint 已出现成功但无法规范化的响应；停止探测并由 operator 检查归档。 |
| 429 | `quota_exceeded` | Hub consumer 配额不足；等待窗口或调整 ecommerce policy，无需换 Key。 |
| 429 | `external_platform_busy`, `external_platform_capacity_exceeded` | Hub 并发保护或外部容量不足；按响应退避，不要并发放大。 |
| 502 | `external_platform_response_unusable` | 上游成功 envelope 无法映射。该稳定错误会随同一 `Idempotency-Key` 重放且不再次派发；保存 requestId 作为证据，不得使用 uncertain-repeat 通道。 |
| 502 | `external_platform_outcome_unknown` | 结果可能已经产生外部调用；保存 requestId 和原幂等键，禁止自动换键重试。只有只读状态 GET 明确返回 `unknown`，才可用一次新的 `refresh`、新 Key 和 `X-MX-Insight-Retry-Of`；这可能形成第二笔供应方成本。 |
| 502 | `external_platform_rejected` | 上游已确定拒绝；检查请求条件，避免连续自动重试。 |
| 503 | `external_platform_unavailable`, `external_platform_not_configured`, `external_platform_circuit_open`, `external_platform_capacity_unavailable` | 若没有 exact fallback，按运维窗口退避。 |
| 200 | `data.items=[]` | 正常空结果，不是接口故障；可调整关键词或平台。空结果不能证明上游成本为零。 |

`external_platform_not_configured` intentionally does not expose whether a
provider release gate, credential source or internal credential store is the
cause. A client must keep the original request/`Idempotency-Key` evidence and must not switch
the `Idempotency-Key` to probe or retry. Operators distinguish those causes through
the Admin-only external-platform runbook without probing the live acquisition route.

公开响应不返回供应方费率、余额、免费额度、采购成本或客户账单；未知费用不会冒充为 0。
Hub usage、供应方采购成本与 Hub 客户计价是三个相互独立的计量/计价域。当前前两者已有
运行证据；客户计价待独立、版本化的 Hub price book 落地，并继续作用于同一 consumer，
无需更换 API Key，也不能从 `sourceMode` 或供应方成本直接推导。

## 3.4 小红书笔记 API

### `POST /api/v1/xiaohongshu/app/get_note_info`

这是 Hub-owned 的平台命名入口，把官方笔记链接归一化为稳定的
`mx-insight-hub.social-post.v1`，要求当前 Key 的 immutable snapshot 和 consumer
当前授权同时包含 `xiaohongshu` 与 `social.posts.resolve`。供应方身份、上游密钥、原始
envelope 和成本都不会出现在公开响应中。

```bash
XHS_NOTE_URL='https://www.xiaohongshu.com/explore/0123456789abcdef01234567'
XHS_KEY="xhs-note-$(uuidgen)"
XHS_BODY=$(jq -cn --arg url "$XHS_NOTE_URL" '{url:$url,deliveryMode:"cache_first"}')

XHS_RESULT=$(curl -sS -D /tmp/mxih-xhs.headers -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $XHS_KEY" \
  -d "$XHS_BODY" \
  "$HUB_URL/api/v1/xiaohongshu/app/get_note_info")

printf '%s\n' "$XHS_RESULT" \
  | jq '{contractVersion,data:{item:{id:.data.item.id,title:.data.item.title,text:.data.item.text,tags:.data.item.tags,author:.data.item.author,metrics:.data.item.metrics,media:.data.item.media}},meta,requestId}'
```

平台命名的 POST 是链接输入的推荐形式；body 只接受 `platform`、`url` 和 `deliveryMode`，
并在缺失 `platform` 时默认小红书。`GET /api/v1/xiaohongshu/app/get_note_info` 继续兼容
`share_text` 和 24 位十六进制 `note_id`，两者同时出现时 `note_id` 优先。等价输入会尽可能归一到
同一个规范化笔记身份。输入只接受官方
`xiaohongshu.com` 笔记 URL 或 `xhslink.com` / `xhslink.cn` 分享 URL；不接受任意网页、
上游参数或凭据。

GET 会把链接放在 request-target 中。如果分享链接带 `xsec_token` 等临时查询参数，它可能被客户端、
反向代理或 APM 的访问日志记录。此时应优先传 `note_id`，或改用下方 POST JSON 形式；不要在
公共 URL、截图或日志中保留临时参数。

Hub 自定义数据产品入口 `POST /api/v1/data/post` 继续接受
`{"platform":"xiaohongshu","url":"...","deliveryMode":"cache_first"}`。GET 和两个 POST 入口共享
同一个笔记身份、快照与外采去重域；幂等绑定还包含交付策略，所以同一
`Idempotency-Key` 改变 `deliveryMode` 会返回冲突。不要为了重试
切换 URL、method 或参数写法。

租户端完整开通路径是：平台方建立 tenant、consumer、`xiaohongshu` 和
`social.posts.resolve` grants 与 membership；租户成员通过 Launcher 会话登录 Internal Hub，
在“API Keys”签发只显示一次完整 secret 的 Live Key；客户后端用该 Key 调用上面的 POST；
租户再从套餐、余额和用量视图检查调用与扣费。Public 文档和响应始终不显示外部平台凭据、
采购成本或内部归档位置。

`cache_only|cache_first|refresh` 的交付证据与 3.3 节一致。`refresh` 必须有调用方生成的
`Idempotency-Key`。完全相同的传输重试复用原 body/key；`409 reserved/unknown` 或
`502 outcome_unknown` 不能自动换 key 重试。某些无效/失效笔记可能已被外部平台接受并消耗
容量，因此 Hub 只对已严格识别的单笔不存在结果做短时 negative cache。调用方显式提供的
key 仍按 consumer 唯一并绑定首次使用它的 API Key，跨 Key 重用返回
`409 idempotency_conflict`；省略 header 时 Hub 生成包含 API Key 身份的短时 key，因此同一
consumer 的不同 Key 会各自记一笔 usage，但继续共享 consumer 级快照和外采 dispatch lease。

### `GET /api/v1/data/posts/media`

响应里的每个 `media[].url` 已是同源 Hub 中继 locator，不包含上游地址；
`author.avatarUrl` 当前固定为 `null`。用同一 consumer 的 Live Key 获取 locator（浏览器端先
fetch 为 Blob，不能用不带 Authorization 的裸 `<img>` 请求）。也可以用已提交结果的
`requestId` 和 `0..19` 的 `mediaIndex` 直接构造同一中继路径；客户端可以在服务端并发护栏内
并发加载一页多图：

```bash
XHS_REQUEST_ID=$(printf '%s\n' "$XHS_RESULT" | jq -r '.requestId')
XHS_MEDIA_COUNT=$(printf '%s\n' "$XHS_RESULT" | jq '.data.item.media | length')
export XHS_REQUEST_ID

if [ "$XHS_MEDIA_COUNT" -gt 0 ]; then
  seq 0 $((XHS_MEDIA_COUNT - 1)) \
    | xargs -P 12 -I '{}' sh -c '
        curl -fsS -G \
          -H "Authorization: Bearer $HUB_KEY" \
          --data-urlencode "requestId=$XHS_REQUEST_ID" \
          --data-urlencode "mediaIndex={}" \
          "$HUB_URL/api/v1/data/posts/media" \
          -o "/tmp/mxih-xhs-{}.img"
      '
fi
```

生产客户端不必固定为 12；应限制自己的同时在途请求并对单图失败显示占位符。Hub 当前默认
允许每个 consumer 16、单实例全局 32 个媒体请求，并受独立的滑动窗口限制；这些是部署护栏，
不是套餐承诺，运营可在容量验证后调高。媒体 GET 不创建 note usage、不再次请求笔记、不接受
原图 URL，并返回 `Cache-Control: private, no-store`。

常见错误：`400 invalid_post_url|invalid_platform|unsupported_fields`、
`403 platform_not_granted|capability_not_granted|test_key_not_supported`、
`404 post_not_found|stored_snapshot_not_found|external_media_not_found`、
`429 quota_exceeded|external_platform_busy|external_platform_capacity_exceeded|external_media_busy`、
`502 external_platform_response_unusable|external_platform_outcome_unknown|external_platform_rejected` 和
`503 external_platform_not_configured|external_platform_circuit_open|external_platform_capacity_unavailable`。
429 是 Hub 额度/并发或外部平台容量类别，不是域名封禁的证据；保留 requestId 后按错误码处理。

## 4. 搜索 API

所有搜索 POST 都会返回 `x-mx-insight-request-id` 和 `idempotent-replay`。必须原样
保留 opaque `pageInfo.nextCursor`，下一页使用新的 `Idempotency-Key`。

`/data/search`、`/data/stored/search` 和 `/data/canonical/search` 支持 `type`：

- `fresh`（默认）检索当前数据，并为传输重试保留 120 秒的已提交结果重放窗口；
- `stable` 让同一个 key 永久重放第一次提交的结果。

### `POST /api/v1/data/search`

必填 body 字段为 `platform` 和 `query`。可选字段包括 `pageSize`（`1..100`，policy
可能进一步降低）、opaque `cursor`（最多 8192 字符）和 `type`。一次请求只能指定
一个已授权平台，`all` 和 `*` 无效。`platform=telegram` 时搜索 Hub 已存 canonical
message。`platform=xiaohongshu` 且 `pageSize` 恰好为默认值 20 时，兼容的首屏请求只有在
独立 rollout gate 开启后才会无感使用受治理的 direct external-data connector；调用方不选择
或获知 provider。省略 `pageSize` 等价于 20。此前由 direct traversal 签发的 opaque cursor
仍留在同一路径，并且必须连同相同 query 和 pageSize 原样回传；历史
cursor 或非 20 pageSize 继续使用历史兼容路径，不能跨路径交换 cursor。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"platform\":\"$HUB_PLATFORM\",\"query\":\"AI Agent\",\"pageSize\":20,\"type\":\"fresh\"}" \
  "$HUB_URL/api/v1/data/search"
```

成功返回 `200`。未知 body 字段、平台 fan-out 列表、通配平台，以及调用方选择的
provider/credential 字段都会被拒绝。小红书 direct search 会识别 UTF-16、Unicode
code point 或 grapheme 长度恰好为 60 的正文边界，执行有界的内部详情补全，并且只接受
严格更长的正文；未能补全时以 `status=partial` 及
`xiaohongshu_detail_incomplete|xiaohongshu_detail_unavailable` warning 明示，不能作为完整
正文沉淀。该质量步骤不授予调用方 `post_detail` 权限。

小红书 direct 交付还会返回 `x-mx-insight-source-mode`、
`x-mx-insight-captured-at`、`Age`，并在 `stored_fallback` 时返回 `Warning: 110`。
新增稳定错误包括 `403 test_key_not_supported`、
`400 invalid_page_size|cursor_scope_mismatch`、
`409 external_platform_response_unusable`、
`429 external_platform_busy|external_platform_rate_limited|external_platform_capacity_exceeded`、
`502 external_platform_response_unusable|external_platform_outcome_unknown|external_platform_rejected` 和
`503 external_platform_unavailable|external_platform_not_configured|external_platform_circuit_open|external_platform_capacity_unavailable`。
历史路径上的 Night-All 明确拒绝会映射为安全的
`502 night_all_rejected`；无法证明 dispatch 结果时返回
`502 upstream_outcome_unknown`，此时应使用原 request ID/`Idempotency-Key` 查询，不能换新的 `Idempotency-Key`
自动重试。

### `POST /api/v1/data/stored/search`

只搜索 Hub canonical 存储，不调用 provider。必填字段为 `platform` 和 `query`。
`datasetId` 与 `objectType` 是可选的精确过滤器，只缩小已经由 platform grant 授权的
数据范围，不是独立授权。还可使用 `pageSize`、`cursor` 和 `type`。不接受物理数据库/
索引名称、SQL 或 Elasticsearch DSL。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"platform\":\"$HUB_PLATFORM\",\"query\":\"AI Agent\",\"objectType\":\"post\",\"pageSize\":20,\"type\":\"fresh\"}" \
  "$HUB_URL/api/v1/data/stored/search"
```

成功返回 `200`，其中 `source=hub`，`searchMode=elasticsearch|postgres`。缺少平台授权
返回 `403`；PostgreSQL 搜索层不可用时返回 `503 stored_search_unavailable`。

### `POST /api/v1/data/canonical/search`

必填字段为 `query`。省略 `platform` 时，会在当前全部已授权平台的一份统一排名投影
中搜索。可选过滤器为 `platform`、`datasetId`、`objectType`；可选控制字段为
`pageSize`（`1..100`，policy 可能更低）、opaque `cursor`、
`sort=newest|oldest|relevance`、`type` 和已发布的 `searchProfile`。默认 profile 是
`canonical.balanced.v1`。不接受任意 analyzer、tokenizer、filter 或 Elasticsearch
DSL。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"query":"AI Agent","pageSize":20,"sort":"relevance","searchProfile":"canonical.balanced.v1","type":"fresh"}' \
  "$HUB_URL/api/v1/data/canonical/search"
```

成功返回 `200`，包含本次搜索的授权平台 scope、请求/实际 profile、降级标记、total
元数据和 `searchMode`。当前 consumer 至少需要一个平台授权。Elasticsearch PIT
cursor 过期时返回 `410`；应移除 cursor、换新的 `Idempotency-Key` 并从第一页重新开始。

### stored/canonical 中的 `public_opinion` 可见性

只要 stored/canonical 搜索范围可能包含 `public_opinion`，该平台分支默认只返回
`sourceStage=formal` 且 `status=formal` 的记录；混合平台搜索中的其他平台完全不受
影响。候选与精确地理/时间过滤必须显式指定 `platform=public_opinion`：

- `includeCandidates=qualified` 只加入已经是 `status=qualified` 的候选；
  `minQualityScore` 默认 80，且只是额外请求下限，传 0 不会重新分类 pending/rejected；
- `includeCandidates=all` 必须同时提供 RFC3339 `from`、`to`，并至少提供
  `province`、ISO alpha-2 `countryCode` 或精确 `location` 之一；要包含 unscored candidate
  必须省略 `minQualityScore`；
- formal 时间窗只使用 `eventTime`；候选缺少 `eventTime` 时可回退 `collectedAt`；
- 显式候选结果只增加有界的 `quality` 与 `location`，不返回候选 author、
  contentType、source/provider、raw、flags 或内部理由。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"platform":"public_opinion","query":"涉恐","includeCandidates":"all","countryCode":"SS","location":"南苏丹","from":"2026-08-24T00:00:00Z","to":"2026-08-25T23:59:59Z","pageSize":20}' \
  "$HUB_URL/api/v1/data/canonical/search"
```

publication visibility 是幂等指纹的一部分。升级到该契约后，首次请求必须使用新的
`Idempotency-Key`；复用升级前的 key 会返回 `409 idempotency_conflict`，不会回放
升级前可能未门禁的响应。默认请求的 cursor binding 保持兼容，但升级前创建的
Elasticsearch PIT 若不是 content-v5 会返回 `503 search_cursor_unavailable`，应移除
cursor、换新的 `Idempotency-Key` 并从第一页重新搜索。

## 5. 全国与省级 all-ingested 舆情 API

这两个 P1 接口只读取 Hub 的 `canonical_current_safe` 当前投影，不直连上游源库。
正式产品不要把 Hub API Key 存进浏览器或 Electron renderer；应由 AppCenter/BFF 使用
同一把 Hub Public API Key 调用，再向前端返回业务所需字段。

### `GET /api/v1/data/public-opinion/regions`

P1 地区目录仅支持组合 `parentCode=CN&level=province`；两项省略时分别默认 `CN` 和
`province`，其他值会被拒绝。接口稳定返回全部 34 个省级地区及代码，不因当前是否有
数据而删减。城市目录属于 P2，P1 不接受 city level。

```bash
curl -sS -G \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'parentCode=CN' \
  --data-urlencode 'level=province' \
  "$HUB_URL/api/v1/data/public-opinion/regions" |
jq '.error // .data.regions'
```

调用方应原样保存并传回每个 `regions[].code`，不要自行构造或猜测地区代码。

### `GET /api/v1/data/public-opinion/regions/{regionCode}/items`

P1 feed 只接受以下固定语义：

- `regionCode=CN` 表示全国，或使用目录返回的 34 个省级代码之一；不接受中文别名和市级代码；
- `visibility` 必填且只能为 `all_ingested`；
- `sort` 可省略并默认 `latest`，不接受其他值，因此无 heatScore 的记录不会因排序模式而消失；
- `from` 与 `to` 都必填，使用 RFC3339 闭区间；
- `pageSize` 可选，默认 20，上限取 100 与 consumer 平台策略中的较小值；
- `cursor` 可选，必须原样使用上一页的 `pageInfo.nextCursor`。

全国示例：

```bash
curl -sS -G \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'visibility=all_ingested' \
  --data-urlencode 'sort=latest' \
  --data-urlencode 'from=2026-08-24T00:00:00+08:00' \
  --data-urlencode 'to=2026-08-26T23:59:59+08:00' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/public-opinion/regions/CN/items" |
jq '.error // .data'
```

选择江苏后的请求只替换 path 中的地区代码，其他参数保持不变：

```bash
curl -sS -G \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'visibility=all_ingested' \
  --data-urlencode 'sort=latest' \
  --data-urlencode 'from=2026-08-24T00:00:00+08:00' \
  --data-urlencode 'to=2026-08-26T23:59:59+08:00' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/public-opinion/regions/CN-JS/items" |
jq '.error // .data'
```

响应中的 `region` 是目录同结构对象（全国为
`{code:"CN",name:"中国",officialName:"中华人民共和国",level:"country",parentCode:null}`），
并回显 `visibility={mode:"all_ingested",qualityFiltered:false,
corpusDefinition:"canonical_current_safe"}`、`sort="latest"`、`timeBasis="effective"`、
归一化后的 `from`/`to`，以及 `items` 和 `pageInfo`。这里没有 `scope` 字段。

翻页时必须保留相同的 region、visibility、sort、时间窗和 pageSize：

```bash
FIRST_PAGE="$(
  curl -sS -G \
    -H "Authorization: Bearer $HUB_KEY" \
    --data-urlencode 'visibility=all_ingested' \
    --data-urlencode 'sort=latest' \
    --data-urlencode 'from=2026-08-24T00:00:00+08:00' \
    --data-urlencode 'to=2026-08-26T23:59:59+08:00' \
    --data-urlencode 'pageSize=50' \
    "$HUB_URL/api/v1/data/public-opinion/regions/CN/items"
)"
NEXT_CURSOR="$(printf '%s' "$FIRST_PAGE" | jq -r '.data.pageInfo.nextCursor // empty')"

if [ -n "$NEXT_CURSOR" ]; then
  curl -sS -G \
    -H "Authorization: Bearer $HUB_KEY" \
    --data-urlencode 'visibility=all_ingested' \
    --data-urlencode 'sort=latest' \
    --data-urlencode 'from=2026-08-24T00:00:00+08:00' \
    --data-urlencode 'to=2026-08-26T23:59:59+08:00' \
    --data-urlencode 'pageSize=50' \
    --data-urlencode "cursor=$NEXT_CURSOR" \
    "$HUB_URL/api/v1/data/public-opinion/regions/CN/items" |
  jq '.error // .data'
fi
```

`all_ingested` 表示不按质量分数、qualification status 或地理验证状态过滤；它会包含
未评分、pending、rejected 和 failed candidate。全国 `CN` 还包含当前未分配省份的安全
记录，这些 item 保持 `province=null`。该接口没有 `minQualityScore` 参数；不要把旧接口中
的 `minQualityScore=0` 当作“全部”，因为旧查询中显式 0 仍会排除 null/unscored candidate。

这里的“全部”严格限定为 `canonical_current_safe`：当前未删除、已 canonical 化且具有
revision-fenced current publication state 的公开安全投影。不包含上游 raw/raw payload、
历史 source/canonical revision、删除或 tombstone、映射/导入失败、没有 current
publication state 的记录，也不返回 provider/endpoint、凭据、策略/运行 ID、extensions、
质量 flags/拒绝理由、模型 reasoning 或内部 lineage。

旧的 `/provinces/{province}/items`、`/province-coverage`、`/items/{id}` 和搜索接口均保持
原有路径、默认值、授权和 cursor 语义；P1 不提供城市 feed。

### 漏斗与未展示记录诊断

这三个诊断 GET 除 `public_opinion` platform grant 外，还需要独立的
`public_opinion.diagnostics.read` capability。前者缺失返回
`403 platform_not_granted`，后者缺失返回 `403 capability_not_granted`。
它们仅接受 API Key，每次调用/重试独立计量，不使用幂等 key。

```bash
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'from=2026-08-24T00:00:00Z' \
  --data-urlencode 'to=2026-08-25T23:59:59Z' \
  "$HUB_URL/api/v1/data/public-opinion/funnel"

curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'reason=missing_province' \
  --data-urlencode 'from=2026-08-24T00:00:00Z' \
  --data-urlencode 'to=2026-08-25T23:59:59Z' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/public-opinion/records"
```

`records` 支持 `cursor/from/heat/pageSize/province/query/reason/scope/stage/status/time/to`。
可用 `reason=missing_province|missing_publication_state|not_formal_stage|not_formal_status|
missing_event_time|outside_window|missing_heat` 定位漏斗原因，再用返回的 ID
调用 `GET /api/v1/data/public-opinion/records/{id}?from=...&to=...` 查看安全诊断详情。
列表 cursor 是绑定完整筛选的签名 keyset；条件变化后必须从首页开始。
公开投影不返回 raw、extensions、connection/凭据、Admin 操作或模型 reasoning。

## 6. Night-All 兼容层

公开的 legacy Night-All 路由仅有：

```text
POST /api/v1/night-all/search/raw
POST /api/v1/night-all/search/crawl
POST /api/v1/night-all/search/user-info
```

每条路由都要求一个明确授权的 `platform`。`businessId` 由已认证 consumer 派生，
调用方应省略；如果发送 `businessId`/`business_id`，值必须与 consumer 完全一致。
legacy 客户端可发送 `includeRaw:false`，Hub 会在 dispatch 前移除；
`includeRaw:true` 会被拒绝。

对于小红书 `raw`，独立 rollout gate 开启后，Hub 才会让满足下列条件的首屏请求无感使用
direct external-data connector：只提供一个 scalar `keyword` 或 `query`；有效
`count|pageSize|limit` 恰好为 20；请求为 page 1；不提供 plural query、
`params`、cache-age、并发、详情/评论工作量或 comment continuation 控制。
`includeDetails:false` 与 `includeComments:false` 是可接受的 no-op 默认值；
`disableAutoDetails:true` 可关闭 60 字符边界的自动详情检查。任一 true 详情/评论开关、
`maxEnrichItems`、`commentLimit`、`commentCursor`、`enrichConcurrency`、非 20 页大小、
历史 cursor，以及 `crawl`/`user-info` 都保留历史执行路径。调用方不需要改变 URL 或解析器。
此前由 direct traversal 签发的 opaque cursor 即使在新首屏切换关闭后也继续走同一路径。

客户端不要自己维护平台全集；应读取运行中 Hub 的
`GET /api/v1/data/capabilities`。其中 `data.legacySearch` 是该 Hub 发布版本固定、再按
当前 consumer grants 过滤的 dispatch 矩阵：

| operation | 本文示例 | 支持/就绪判断字段 |
|---|---|---|
| `raw` direct 子集 | `xiaohongshu + 单 query + 20` | `data.platforms[xiaohongshu].capabilities` 的 `search_posts` 与 `search.ready` |
| `raw` 历史形状 | 非 direct 条件 | `data.legacySearch.operations.raw` |
| `crawl` | `twitter + username=openai` | `data.legacySearch.operations.crawl` |
| `user-info` | `twitter + username=openai` | `data.legacySearch.operations["user-info"]` |

**Telegram 不支持这三条 compatibility route。** 第 4 节的
`HUB_PLATFORM=telegram` 只用于 Hub 搜索；Telegram 已存数据应使用第 7 节的专用
Hub API。替换本文示例变量前，应同时确认 platform grant、`supportedPlatforms` 和
`readyPlatforms`。

这里的 `readyPlatforms` 仅表示 Hub 在当前固定历史兼容契约下允许 dispatch。它不是从
Night-All 实时发现的 capability，也不证明 handler、endpoint、provider、credential
已经配置或健康。实际可用性只能由本次 Night-All 调用结果确定；上游失败时按本节的
exact snapshot fallback 规则处理。它不门禁上述由 `search_posts` 广告的 Hub-native
小红书 raw 子集。

重要的数据处理契约：**Night-All-owned 结果不会对业务数据、provider/endpoint 字段，以及
`data.raw_info`、`data.raw_data` 中的业务内容做脱敏；live response、exact
compatibility snapshot 和 raw ingest lineage 均保留这些上游业务字段。**
这不构成认证凭据透传契约：API Key、access token、Authorization、cookie、password
等认证凭据不属于业务响应，Night-All 和 Hub 均不得将其作为响应返回或记录。如果
响应中意外出现认证凭据，应按安全事件处理，而不能把它视为兼容行为。未来的脱敏
产品必须使用独立、版本化的 projection/API，不能静默改写这三条接口或其快照。

请求侧信任边界仍然严格：调用方不能通过 body 或嵌套 `params` 注入 provider、
endpoint、credential、token/auth、proxy、header/cookie、capability/moduleCode、
timeout、billing、raw/debug、archive/fullArchive/allTweets、archive/count/page 放大
参数或 workload 覆盖。

每个 compatibility `Idempotency-Key` 永久标识一次可能产生 Hub 内部供应方成本的 dispatch。复用 `Idempotency-Key` 永远
重放该结果；需要当前数据时必须使用新的 `Idempotency-Key`。在历史执行路径上，complete 结果更新 exact last-good
snapshot；partial 结果会 live 返回但不替换快照。只有
`STANDARD_PAYLOAD_EMPTY` warning 的结果是确认的 complete 空结果，会替换快照。

Hub-native 小红书 raw 仍将 `raw_info` 和 `raw_data` 保持为 JSON string；body
`requestId` 与响应头 `x-mx-insight-request-id` 是同一个 durable Hub UUID，外部 correlation
保持私有。Night-All-owned live/fallback body 则继续原样保留历史 `requestId`/`traceId`，
当前 Hub ID 只在响应头中。

Legacy transport 的 `x-mx-insight-source-mode` 始终为 `live|stale`。Hub-native cache
和 replay 状态映射为 `live`；stored fallback 或原始状态为 stale 的 replay 映射为
`stale`。`idempotent-replay` 与 `Age` 继续提供更细的交付证据。

历史执行路径发生 network/timeout 歧义、不可用的 HTTP 2xx content-type/JSON/envelope，或真实
非 2xx Night-All `502/503/504` 时，Hub 只能返回 consumer、operation、规范化请求
fingerprint 完全一致且尚未过期的 complete snapshot。stale 返回状态为 `200`，并
携带 `x-mx-insight-source-mode: stale`、`x-mx-insight-captured-at`、`Age` 和
`Warning: 110`。body 保留历史 Night-All `requestId`/`traceId`，当前 Hub ID 位于
`x-mx-insight-request-id`。没有可用快照的 ambiguous dispatch 返回
`502 upstream_outcome_unknown`，usage 保持 unknown，同一个 key 不会再次
dispatch。

错误语义如下；除明确标注的 fallback 外，不要自动换新 `Idempotency-Key` 重试：

| HTTP / `error.code` | 语义 |
|---|---|
| `400 platform_operation_unsupported` | 平台不在该 operation 的 `supportedPlatforms`；Telegram 会走此分支，尚未 dispatch |
| `403 platform_not_granted` | consumer 没有该平台 grant |
| `503 platform_operation_unavailable` | 平台在固定支持集内，但 Hub dispatch 矩阵未将其列入 `readyPlatforms`；不是 provider 健康状态，尚未 dispatch |
| `503 compatibility_capabilities_unavailable` | Hub-pinned `legacySearch` dispatch 矩阵缺失或无效，Hub fail closed，尚未 dispatch |
| `503 compatibility_store_unavailable` | fallback 所需的 Hub compatibility store 暂不可用 |
| `400/404/409/422/429 night_all_rejected` | Night-All 明确拒绝；Hub 保留这些可安全转发的上游 HTTP 状态 |
| `502 night_all_rejected` | Night-All 的其他明确拒绝，且没有可用 exact snapshot |
| `502 upstream_outcome_unknown` | dispatch 结果存在歧义且没有可用 exact snapshot；同一 key 不会重新 dispatch |
| `429 external_platform_rate_limited` | Hub-native 小红书请求达到服务端外部调用速率门禁；没有可用 stored fallback |
| `409/429/502/503 external_platform_*` | Hub-native 小红书的去重、容量、响应合同、结果歧义、配置或 circuit 类别；保留 durable request ID 并按具体 code 处理 |

### `POST /api/v1/night-all/search/raw`

至少提供一个 singular string `keyword`/`query`，或 plural string array
`keywords`/`queries`。通用分页别名为 `count`、`pageSize`、`limit`、`page`、
`cursor`、`concurrency`。raw enrichment 字段包括 `disableAutoDetails`、
`includeDetails`、`includeComments`、`commentLimit`（`1..100`）、
`cacheMaxAgeHours`（`0..720`）、`maxEnrichItems`（`1..20`）、`commentCursor` 和
`enrichConcurrency`（`1..5`）。query 总数最多为 50，并且
`queryCount × effectivePageSize` 不得超过 consumer policy work budget。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"platform\":\"$NIGHT_ALL_RAW_PLATFORM\",\"query\":\"AI Agent\",\"count\":20,\"includeRaw\":false}" \
  "$HUB_URL/api/v1/night-all/search/raw"
```

路由自身的 page 上限为 1000，但 consumer policy 可以更低。校验或 work-budget
失败返回 `400`；平台未授权返回 `403`。

### `POST /api/v1/night-all/search/crawl`

至少提供一个 user/channel selector：
`username/usernames/userId/userIds/user_id/uid/channelUrl/channel_url/channelId/channel_id/url/urls`。
可选 `activityTypes` 是非空 string array；`cacheMaxAgeHours` 范围为 `0..720`。
通用分页别名同样适用。一次请求最多让 50 个 identifier 产生工作，并且
`identifierCount × effectivePageSize × activityTypeCount` 不得超过 consumer work
budget。路由自身的 page 上限为 100。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"platform\":\"$NIGHT_ALL_ACCOUNT_PLATFORM\",\"username\":\"$NIGHT_ALL_ACCOUNT_USERNAME\",\"count\":20,\"activityTypes\":[\"posts\"]}" \
  "$HUB_URL/api/v1/night-all/search/crawl"
```

成功响应原样保留 `raw_info`、`raw_data`、`page`、`meta` 和上游 correlation 字段。
selector/page/work 无效时返回 `400`；上游与 fallback 语义遵循本节的共享规则。

### `POST /api/v1/night-all/search/user-info`

至少提供 `username/usernames/userId/userIds/user_id/uid/url/profileUrl/profile_url/urls`
之一。LinkedIn 必须提供完整的 `/in/` 个人 profile URL；公司 URL 和裸 slug 会被拒绝。
通用分页别名适用；
identifier collection 仍然有界，但此 operation 不使用 raw 或 crawl 的乘法预算规则。
路由自身的 page 上限为 100。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d "{\"platform\":\"$NIGHT_ALL_ACCOUNT_PLATFORM\",\"username\":\"$NIGHT_ALL_ACCOUNT_USERNAME\"}" \
  "$HUB_URL/api/v1/night-all/search/user-info"
```

LinkedIn 示例（调用前仍应在 Hub dispatch 矩阵中确认 `linkedin` 同时 supported 且
dispatch-eligible）：

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"platform":"linkedin","url":"https://www.linkedin.com/in/satyanadella"}' \
  "$HUB_URL/api/v1/night-all/search/user-info"
```

成功与错误行为遵循共享 compatibility 规则。不要向 `user-info` 发送 channel
selector；operation 不支持的字段会被拒绝。

## 7. 分词

### `POST /api/v1/tools/tokenize`

需要 `nlp.tokenize` capability。body 只允许 `text`：长度 1–4096，必须至少包含一个
Unicode 字母或数字，且不能包含不支持的控制字符。默认配额是每个
consumer/capability 在滚动 3600 秒内 1000 次，由该 consumer 的所有 API Key
共享。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"text":"吴恩达与人工智能"}' \
  "$HUB_URL/api/v1/tools/tokenize"
```

成功返回 `200`，包含有界 tokens、`actualBackend=hanlp|jieba|bigram`、`degraded`
和可选 error code。缺少 capability 返回 `403 capability_not_granted`；HTTP body
过大可能返回 `413`；分词运行时不可用返回 `503`。精确重放不会再次分词或重复
计量。

## 8. Telegram 已存数据 API

本节全部路由都需要明确的 `telegram` 平台授权。当前所有获得该授权的 consumer
读取同一份 Hub 已存 canonical Telegram 语料，尚未实现 tenant-specific row subset。
现有三个路径没有改名；省略扩展字段仍是原有 Monitor-only 合同。Night-All 的
`raw/crawl/user-info` 转接路径、默认和响应也保持不变。

### `GET /api/v1/data/telegram/chats`

可选 query 参数：`sourceScope=all|monitor|sqlite`（默认 `monitor`）、
`kind=all|channel|group|unknown`（默认 `all`）、`query`、`pageSize`（`1..100`，
policy 可能降低，默认 50）和 opaque `cursor`。返回的 `chatKey` 是合并
Monitor/SQLite 后的稳定会话选择键。每次 GET 和重试都会独立计量，不使用幂等 key。
省略 `sourceScope/kind/query` 时沿用 Monitor unsigned v1 cursor；显式任一扩展字段
时使用绑定 sourceScope、kind、query、pageSize 的 HMAC v2 cursor（最长 2048）。

```bash
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'sourceScope=all' \
  --data-urlencode 'kind=channel' \
  --data-urlencode 'query=news' \
  --data-urlencode 'pageSize=20' \
  "$HUB_URL/api/v1/data/telegram/chats"
```

成功返回 `200`。必须原样传回 `nextCursor`。时间顺序/cursor 无效或含未知 query
字段时返回 `400`；缺少授权返回 `403`；已存数据不可用返回 `503`。

显式传 `sourceScope`、`kind` 或 `query` 时，扩展模式按不可变的
`effectiveSortTime` 分页：优先业务事件时间，其次采集时间，最后首次入库时间；响应中
可空的 `eventTime`/`collectedAt` 不会被回填改写。省略这些扩展参数时仍使用既有
Monitor 排序与 cursor 语义。

### `GET /api/v1/data/telegram/messages`

可选 `sourceScope=all|monitor|sqlite`（默认 `monitor`）、`chatId`、inclusive RFC3339
`from`/`to`、`pageSize` 和 `cursor`。`chatId` 可使用 chats 返回的稳定会话键精确
过滤。不支持 offset pagination。每条消息额外返回 `canonicalId` 和
`sourceScope`，用于上下文读取和来源诊断。
省略 `sourceScope` 且使用普通 external chatId 时仍是 Monitor v1；显式
`sourceScope` 或使用 `monitor:<canonical UUID>` / `sqlite:<canonical UUID>` chatKey
启用绑定来源、chat、时间窗和 pageSize 的 HMAC v2 cursor。只有
`sourceScope=all` + 普通 external chatId 会合并两套来源。

```bash
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'sourceScope=all' \
  --data-urlencode 'pageSize=20' \
  --data-urlencode 'from=2026-08-01T00:00:00Z' \
  "$HUB_URL/api/v1/data/telegram/messages"
```

成功返回 `200`，包含 normalized record、lineage 和 `pageInfo`。下一页可将返回的
cursor 作为新的 `--data-urlencode "cursor=$CURSOR"` 参数。

### `GET /api/v1/data/canonical/items/{id}/context`

`id` 是 `/api/v1/data/canonical/search` 返回的 Telegram message canonical UUID。
可选 `before`、`after` 分别为 `0..50`，默认都是 10。接口只在命中项所在的同一
dataset、同一 normalized chat 中按 `(eventTime, canonicalId)` 总序读取邻近消息，
返回一个升序 `items` 列表；`items[anchorIndex].id` 等于 `anchorId`。不会把 Monitor
和 SQLite 两个 dataset 混进同一窗口。

```bash
ANCHOR_ID="${ANCHOR_ID:?set ANCHOR_ID to a Telegram canonical search item id}"
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'before=10' \
  --data-urlencode 'after=10' \
  "$HUB_URL/api/v1/data/canonical/items/$ANCHOR_ID/context"
```

`storedWindow.hasMoreStoredBefore/After` 只说明 Hub PostgreSQL 当前是否还有邻近行，
不能解释为 Telegram 上游的第一/最后消息。`upstreamCompleteness` 是独立的来源证据：
Monitor 当前为 `unknown`，SQLite 当前为 `bounded`。GET 不使用幂等 key，每次调用和
重试独立计量。未知 dataset 返回 `409 context_not_supported`；所需索引未就绪返回
`503 serving_indexes_unavailable`。响应复用 canonical public allowlist，不包含 raw、
`extensions`、连接信息或内部 lineage。

### `GET /api/v1/data/canonical/items/{id}/timeline`

这是搜索命中后持续向前、向后滚动的正式 Public 合同，要求 `telegram` grant。首屏
不发送 cursor；`before`、`after` 各自默认 10、范围 `0..50`，并受当前 grant 的
`maxPageSize` 限制。响应 `items` 始终按 `(eventTime, canonicalId)` 升序，
`items[anchorIndex].id` 是搜索命中项。
某一侧传 `0` 只会省略该侧的首屏数据；如果 Hub 返回该侧续页游标，游标使用
`min(10, 当前 grant maxPageSize)` 作为后续页大小，不会产生每页 0 条的游标。
timeline 与 context 返回的 `eventTime` 保留用于排序和游标排他的 UTC 六位微秒值，
因此客户端能直接观察服务端实际分页使用的完整总序键。

外部应用可直接按下面的固定流程复刻 Telegram 会话搜索与双向滚动。先搜索并从命中项取
`canonicalId`（canonical search 的命中则直接取 `id`）：

```bash
SEARCH_KEY="$(new_idempotency_key)"
SEARCH_PAGE=$(curl -sS -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $SEARCH_KEY" \
  -d '{"query":"AI Agent","sourceScope":"all","scope":"messages","pageSize":20}' \
  "$HUB_URL/api/v1/data/telegram/search")

ANCHOR_ID=$(printf '%s\n' "$SEARCH_PAGE" | jq -r '.data.items[0] | .canonicalId // .id')
```

每个搜索下一页都改变了含 cursor 的规范 body，因此必须生成新的 `Idempotency-Key`；只有重试
完全相同的一页才复用原 `Idempotency-Key`。timeline 是安全 GET，不发送幂等 Key。

```bash
ANCHOR_ID="${ANCHOR_ID:?set ANCHOR_ID to a Telegram canonical search item id}"
TIMELINE=$(curl -sS --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'before=10' \
  --data-urlencode 'after=10' \
  "$HUB_URL/api/v1/data/canonical/items/$ANCHOR_ID/timeline")

printf '%s\n' "$TIMELINE" \
  | jq '{items:.data.items,anchorIndex:.data.anchorIndex,pageInfo:.data.pageInfo,consistency:.data.consistency,requestId}'
```

首屏 `pageInfo.mode=initial`、`direction=null`，并同时返回 `older` 与 `newer`。
需要更早内容时只回传 `pageInfo.older.cursor`；direction 已封装在签名 token 中：

```bash
OLDER_CURSOR=$(printf '%s\n' "$TIMELINE" | jq -r '.data.pageInfo.older.cursor // empty')

OLDER_PAGE=$(curl -sS --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode "cursor=$OLDER_CURSOR" \
  "$HUB_URL/api/v1/data/canonical/items/$ANCHOR_ID/timeline")

printf '%s\n' "$OLDER_PAGE" | jq
```

续页不能再发送 `before` 或 `after`，也不接受 `olderCursor`、`newerCursor` 或单独的
direction 字段。搜索、Telegram search、history 和 timeline cursor 不能互换。HMAC
将路径 anchor、dataset、chat stream、方向、排他 `(eventTime, canonicalId)` 边界、
page size、tenant/consumer、`telegram` 授权范围及合同版本绑定；篡改或跨作用域重放
返回 `400 invalid_cursor`。

续页 `anchorIndex=null`，只有所请求方向的 pageInfo 非空。客户端将 older items prepend、
newer items append，并按 canonical `id` 去重。prepend 前记录 scroll height 与 scrollTop，
插入后把新增高度补偿到 scrollTop，避免用户当前命中/阅读位置跳动。即使 `newer.hasMore=false`，
`pageInfo.newer.cursor` 仍会保留：有新项时推进到最新返回项，空页保持原 token，可以继续轮询后来写入；older 已耗尽时其 cursor
为 null。

`consistency=live-keyset` 明确表示这不是冻结快照：并发写入、晚到或删除可能改变尚未读取的
边界外集合。`hasMore` 仅描述 Hub 当前 stored active 行，不代表 Telegram 上游完整性；
该接口不触发 Telegram/Night-All/其他上游采集，也不承诺 changes feed、修改或删除事件。
当前只支持 capabilities 的 `timeline.datasets` 列出的 Monitor 与 SQLite 两个 message
dataset。未知 dataset 返回 `409 context_not_supported`，服务索引未就绪返回
`503 serving_indexes_unavailable`。GET 不使用幂等 key，每次调用和重试独立计量。

### `POST /api/v1/data/telegram/search`

必填字段为 `query`。可选字段包括 `sourceScope=all|monitor|sqlite`（默认
`monitor`，显式 `all` 合并 Monitor + SQLite）、`scope=messages|chats|all`（默认 `messages`）、
`chatId`、`authorId`、inclusive RFC3339 `from`/`to`、`matchMode=full_text`、
`pageSize`（`1..100`，默认 50 且受 policy 限制）和最多 8192 字符的 opaque cursor。
该路由已固定为 Telegram，不接受 `platform` 字段。
省略 `sourceScope` 保留旧 Monitor-only v3 cursor binding；显式传
`monitor|sqlite|all` 才把来源加入扩展 binding。

```bash
IDEMPOTENCY_KEY="$(new_idempotency_key)"
curl -sS -i -X POST \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $IDEMPOTENCY_KEY" \
  -d '{"query":"AI Agent","sourceScope":"all","scope":"messages","from":"2026-08-01T00:00:00Z","matchMode":"full_text","pageSize":20}' \
  "$HUB_URL/api/v1/data/telegram/search"
```

成功返回 `200`。搜索可能从 Elasticsearch/HanLP 明确降级到已记录的
PostgreSQL/phrase 行为。不支持的 match mode 或字段返回 `400`；PIT cursor 过期
返回 `410`；存储/搜索不可用返回 `503`。

### `GET /api/v1/data/telegram/entities/search`

必填 query 参数为 `query`（1–200 字符）。可选 `pageSize` 范围为 `1..100` 且受
policy 限制。接口对 author name/username 和 chat title/username 做模糊搜索。GET
请求独立计量，不使用幂等 key。

```bash
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'query=openai' \
  --data-urlencode 'pageSize=20' \
  "$HUB_URL/api/v1/data/telegram/entities/search"
```

成功返回 `200`，包含排序后的 author/chat union 及
`searchMode=elasticsearch|postgres`。缺少 query 返回 `400`；搜索不可用返回
`503`。

## 9. 请求与用量证据

### `GET /api/v1/requests/{requestId}`

将 `HUB_REQUEST_ID` 设置为之前 POST 返回的 `x-mx-insight-request-id`。只有拥有该
请求的 consumer 可以读取。

```bash
export HUB_REQUEST_ID="${HUB_REQUEST_ID:?set HUB_REQUEST_ID from x-mx-insight-request-id}"
curl -sS -i \
  -H "Authorization: Bearer $HUB_KEY" \
  "$HUB_URL/api/v1/requests/$HUB_REQUEST_ID"
```

成功返回 `200`，包含 `status=reserved|committed|released|unknown`、units、时间戳和
可选 platform/capability/source-mode 证据。其他 consumer 的 ID 或不存在的 ID
返回 `404`。`unknown` 表示结果存在歧义：原 POST 不能重放，也不能在自动重试循环中换 Key。
对 ecommerce，调用方可明确发送一个独立的 `refresh`：使用新的 `Idempotency-Key`，并把这次
GET 返回的旧请求 ID 放入 `X-MX-Insight-Retry-Of`；发送该组合即接受旧请求可能已产生供应方成本。
`reserved`、查询失败、跨 consumer、指纹不匹配或已消费的 retry-of 均不能走此通道。管理台
百宝箱会在选择 `refresh` 并点击主按钮后自动完成 GET 和请求头组装，页面不要求填写 UUID、
单独确认或人工核查 consumer 归属。

### `GET /api/v1/usage`

可选 query 参数为 `from` 和 `to`。客户端应发送 RFC3339 timestamp，并保证
`from <= to`。Hub 始终将结果限制在当前已认证 consumer；调用方传入 tenant/
consumer 坐标不属于公开契约。

```bash
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'from=2026-08-01T00:00:00Z' \
  --data-urlencode 'to=2026-08-31T23:59:59Z' \
  "$HUB_URL/api/v1/usage"
```

成功返回 `200`，包含 requests、committed、released、unknown、units、latency、
`byPlatform` 和 `byCapability` 汇总。**当前实现对日期解析及 `from <= to` 仍存在
校验缺口**；无效日期或反向区间的行为不是稳定公开契约，客户端不能依赖它一定
返回 `400`。认证缺失或无效时返回 `401`。
