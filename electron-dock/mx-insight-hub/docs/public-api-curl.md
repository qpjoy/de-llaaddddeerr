# MX Insight Hub Public API curl 使用指南

本文覆盖 Hub public listener 暴露的全部路由：健康检查、公开文档、需要认证的
数据/工具 API，以及当前 consumer 自己的请求证据。不包括 `/internal/v1/*` 或
Admin API。生产域名会把 `/health/**` 转给 admin listener，因此外部域名上的
`GET /health/dependencies` 当前可读；若直连 public listener `18150`，该路径则返回
`404 not_found`。

实现所维护的机器可读契约位于 `GET /docs/openapi.json`。如果本文与该文档不一致，
在发送可能付费或改变状态的请求前，应先停止调用并核对部署版本。

生产请求链路为：调用方先到 Domestic Nginx（仅终止 TLS 和反向代理），再经
WireGuard 回源到 Internal Nginx `10.88.88.88:80`；Internal 按路径将公共 API
转发到本机 Hub public listener `127.0.0.1:18150`，将管理面和健康检查转发到
`127.0.0.1:18151`。Hub 再从同一 Internal 宿主机访问 Night-All
`127.0.0.1:13141`。Domestic 不运行 Hub 或 Night-All，排查业务 500 时应查看
Internal Hub/Night-All 日志；Domestic 日志只用于确认 TLS、回源和最终 HTTP 状态。

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

下文每个 POST 都会生成格式合法且新的 `Idempotency-Key`。如果只是重试
**相同路径和完全相同的规范化 body**，应复用已有的 `IDEMPOTENCY_KEY`，不要再次
执行 `new_idempotency_key`。更换 body、路径或 cursor 页面必须使用新 key。同一个
key 对应不同请求会返回 `409 idempotency_conflict`。

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
数据库、搜索服务或 Night-All 已经就绪。

```bash
curl -sS -i "$HUB_URL/health"
curl -sS -i "$HUB_URL/health/live"
```

### `GET /health/ready`

只有 Hub 所需依赖全部正常时才返回 `200` 和 `data.status=ready`；否则返回 `503`
和 `data.status=not_ready`。生产域名的 `/health/**` 由 Internal Nginx 转到 admin
listener `18151`，当前可能附带 `store`、`nightAll` 等依赖状态；直连 public listener
`18150` 时只返回摘要。客户端不能依赖这些可选明细，响应不得包含连接坐标或凭据。

```bash
curl -sS -i "$HUB_URL/health/ready"
```

### `GET /health/dependencies`

生产域名当前通过 Internal Nginx 将该路径转到 admin listener，返回 `store` 和
`nightAll` 的安全状态摘要；无需 API Key。它只适合运维诊断，业务调用方不能把它
当作稳定数据 API。直连 public listener `18150` 时该路径返回 `404`。

```bash
curl -sS -i "$HUB_URL/health/dependencies"
```

### `GET /docs`（`/docs/` 是别名）

返回自包含的 HTML 公开指南开始页，可缓存五分钟。左侧每个标签都有独立路由，可直达、刷新和复制链接：

| 文档页 | 路径 |
| --- | --- |
| 认证与调用规则 | `/docs/auth` |
| 数据源目录 | `/docs/source-catalog` |
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
都应先读取此接口。当前 consumer 没有可用于 Night-All compatibility 的平台 grant 时，
`legacySearch` 为 `null`，兼容路由会 fail closed。

```bash
curl -sS -i \
  -H "Authorization: Bearer $HUB_KEY" \
  "$HUB_URL/api/v1/data/capabilities"
```

对某个 operation，平台必须同时出现在
`data.legacySearch.operations.<operation>.supportedPlatforms` 与 `readyPlatforms` 中才可
dispatch。这里的 `readyPlatforms` 是兼容字段，表示当前 Hub 固定契约允许 dispatch；
它不证明 Night-All 当前 handler、endpoint、provider、credential 或上游健康。
`data.platforms[]` 中出现 `telegram` 只代表 Hub stored/monitor 数据面可用，
其平台项使用 `source=hub`、`servingMode=stored`；这不代表 Telegram 支持 Night-All
legacy search。若该项包含 `message_context`，应继续检查 `context.ready` 和
`context.datasets`；前者是独立的索引服务门禁，后者是明确支持上下文的 dataset
清单。Key 缺失、无效或已撤销时返回 `401`。

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
`catalog_entries`、`catalog_metadata` 和 `filtered_browse`。

## 3.1 数据源目录 API

本节需要显式 `source_catalog` platform grant，只接受 API Key。两个 GET
都独立计量且不使用幂等 key。

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
curl -sS -i --get \
  -H "Authorization: Bearer $HUB_KEY" \
  --data-urlencode 'coverageStatus=covered' \
  --data-urlencode 'deliveryStatus=doing' \
  --data-urlencode 'pageSize=50' \
  "$HUB_URL/api/v1/data/source-catalog"
```

cursor 是绑定完整 filters 和 pageSize 的 HMAC 签名 keyset，稳定顺序为
`(legacySequence NULLS LAST, canonicalName, id)`。条件改变后应移除 cursor
从首页开始；复用旧 cursor 返回 `400 invalid_cursor`。

### `GET /api/v1/data/source-catalog/metadata`

返回公开字段/枚举、active taxonomy、负责人公开投影、summary 和 facets，
供外部系统还原目录筛选器和看板。列表和 metadata 都不包含
`evidenceRefs/customFields/importedFrom/events/related-data`、登录绑定、连接或凭据。
该接口不接受 query 参数；传入任何 query key 都返回 `400 unsupported_fields`。

```bash
curl -sS -i \
  -H "Authorization: Bearer $HUB_KEY" \
  "$HUB_URL/api/v1/data/source-catalog/metadata"
```

## 4. 搜索 API

所有搜索 POST 都会返回 `x-mx-insight-request-id` 和 `idempotent-replay`。必须原样
保留 opaque `pageInfo.nextCursor`，下一页使用新的幂等 key。

`/data/search`、`/data/stored/search` 和 `/data/canonical/search` 支持 `type`：

- `fresh`（默认）检索当前数据，并为传输重试保留 120 秒的已提交结果重放窗口；
- `stable` 让同一个 key 永久重放第一次提交的结果。

### `POST /api/v1/data/search`

必填 body 字段为 `platform` 和 `query`。可选字段包括 `pageSize`（`1..100`，policy
可能进一步降低）、opaque `cursor`（最多 8192 字符）和 `type`。一次请求只能指定
一个已授权平台，`all` 和 `*` 无效。`platform=telegram` 时搜索 Hub 已存 canonical
message；其他平台使用受治理的 Night-All data-search 契约。

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
provider/credential 字段都会被拒绝。Night-All 明确拒绝会映射为安全的
`502 night_all_rejected`；无法证明 dispatch 结果时返回
`502 upstream_outcome_unknown`，此时应使用原 request ID/key 查询，不能换新 key
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
cursor 过期时返回 `410`；应移除 cursor、换新 key 并从第一页重新开始。

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
cursor、换新 key 并从第一页重新搜索。

## 5. 全国与省级 all-ingested 舆情 API

这两个 P1 接口只读取 Hub 的 `canonical_current_safe` 当前投影，不直连上游源库。
正式产品不要把 Hub API Key 存进浏览器或 Electron renderer；应由 AppCenter/BFF 使用
consumer key 调用，再向前端返回业务所需字段。

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

客户端不要自己维护平台全集；应读取运行中 Hub 的
`GET /api/v1/data/capabilities`。其中 `data.legacySearch` 是该 Hub 发布版本固定、再按
当前 consumer grants 过滤的 dispatch 矩阵：

| operation | 本文示例 | 支持/就绪判断字段 |
|---|---|---|
| `raw` | `xiaohongshu + query` | `data.legacySearch.operations.raw` |
| `crawl` | `twitter + username=openai` | `data.legacySearch.operations.crawl` |
| `user-info` | `twitter + username=openai` | `data.legacySearch.operations["user-info"]` |

**Telegram 不支持这三条 compatibility route。** 第 4 节的
`HUB_PLATFORM=telegram` 只用于 Hub 搜索；Telegram 已存数据应使用第 7 节的专用
Hub API。替换本文示例变量前，应同时确认 platform grant、`supportedPlatforms` 和
`readyPlatforms`。

这里的 `readyPlatforms` 仅表示 Hub 在当前固定兼容契约下允许 dispatch。它不是从
Night-All 实时发现的 capability，也不证明 handler、endpoint、provider、credential
已经配置或健康。实际可用性只能由本次 Night-All 调用结果确定；上游失败时按本节的
exact snapshot fallback 规则处理。

重要的数据处理契约：**此兼容层当前不会对业务数据、provider/endpoint 字段，以及
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

每个 compatibility `Idempotency-Key` 永久标识一次付费 dispatch。复用 key 永远
重放该结果；需要当前数据时必须使用新 key。complete 结果更新 exact last-good
snapshot；partial 结果会 live 返回但不替换快照。只有
`STANDARD_PAYLOAD_EMPTY` warning 的结果是确认的 complete 空结果，会替换快照。

发生 network/timeout 歧义、不可用的 HTTP 2xx content-type/JSON/envelope，或真实
非 2xx Night-All `502/503/504` 时，Hub 只能返回 consumer、operation、规范化请求
fingerprint 完全一致且尚未过期的 complete snapshot。stale 返回状态为 `200`，并
携带 `x-mx-insight-source-mode: stale`、`x-mx-insight-captured-at`、`Age` 和
`Warning: 110`。body 保留历史 Night-All `requestId`/`traceId`，当前 Hub ID 位于
`x-mx-insight-request-id`。没有可用快照的 ambiguous dispatch 返回
`502 upstream_outcome_unknown`，usage 保持 unknown，同一个 key 不会再次
dispatch。

错误语义如下；除明确标注的 fallback 外，不要自动换新幂等 key 重试：

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
返回 `404`。`unknown` 表示结果存在歧义：应保留原幂等 key，不能创建新的付费
重试。

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
