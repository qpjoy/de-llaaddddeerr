# Hub 新闻与组织网站数据接口接入指南

文档版本：1.0 · 核对日期：2026-10-17 · 新闻接口合同：`mx-insight-hub.news-discovery.v1`

面向下游应用开发者，介绍如何通过 Hub 查询已清洗的新闻、筛选来源、分页并读取正文。本文根据当前仓库实现核对；**不代表已验证目标环境部署版本、当前库存或当前 Key 的授权**。联调前由 Hub 服务方提供 Public 地址、有效 API Key 和可用类别。

## 1. 已有数据产品与可交付范围

Hub 已有 **“数据产品 → 新闻发现”** 的页面和 API 实现。控制台路由为 `#/data-products/news`，包含新闻列表、接口调试和接入说明；部署对应版本后，Public 文档入口为 `/docs/news-discovery`。

| 需求 | 当前实现 |
| --- | --- |
| 按关键词、来源、类别、时间查新闻 | 新闻发现支持，读取已入库数据 |
| 空关键词浏览、游标分页、读取已存正文 | 新闻发现支持 |
| 查看来源选项、来源及类别统计 | 支持；来源下拉与统计的覆盖范围不同，见第 5 节 |
| 读取 `maidanglao` 所采集的新闻 | 符合新闻规则、已清洗且在 Key 授权范围内的记录可参与查询 |
| 精确指定 `tag=maidanglao` 或 `tag=tasiting` | **尚不支持公开批次筛选**，不能将站点过滤等同于批次过滤 |
| 读取组织网站首页快照 `web.page` | **尚无对应公开产品接口**；已内部入库不等于公开可读 |
| 固定快照全量导出、可靠增量变更流 | 本文接口未提供；分页是实时结果，不能作为 CDC 合同 |

“325 个网站”是采集范围，不是文章数量，也不代表每个网站都有可公开新闻。当前没有单独按 `maidanglao` 批次隔离的数据产品。

新闻发现识别 `news`、`news.article`、`news.resolved`，以及指定 BBC 采集路径的 `bbc.article`；记录须未删除、标题或正文非空，且未标记为质量拒绝。它不会在请求时采集网页、补抓正文、翻译或调用模型。

## 2. 地址、身份与权限

服务方提供的 `HUB_URL` 是 **Hub Public origin**，不含 `/api/v1`。仓库配置示例为 `https://hub.minsight-ai.com`；实际接入以服务方确认地址为准。

下游只访问 Hub HTTPS API，无须连接源 PostgreSQL、开放数据库端口或持有源库密码。

认证任选一种：

```http
Authorization: Bearer <Hub API Key>
```

或 `X-API-Key: <Hub API Key>`。不要同时发送两套凭据。API Key 保存在应用服务端或密钥管理系统中；不把长期 Key 嵌入公开网页。

读取 `news` 类通常需要 `data_center_saved_records_news` 有效授权。其他类别同理，由当前 Key 实际授权决定。来源过滤只缩小查询范围，不增加权限；新增类别也不会自动扩展旧 Key 的授权。

| 概念 | 示例 | 接口中的用法 |
| --- | --- | --- |
| 批次 `tag` | `maidanglao`、`tasiting` | 内部溯源；当前无公开过滤参数 |
| 类别 `source_type` | `news`、`finance`、`web` | 新闻请求使用 `categories`，如 `["news"]` |
| 授权数据域 `platform` | `data_center_saved_records_news` | 用于开通权限；不要放进 `categories` |
| 来源代码 | 响应的 `source.code` | 放入 `sourceCodes`；组织站通常映射自站点标识，以实际返回为准 |
| 来源目录 ID | 来源下拉的 `items[].key` | 放入 `catalogEntryIds`，UUID |
| 文章 ID | 新闻搜索的 `items[].id` | 用于文章详情，UUID；不是来源目录 ID |

`organization-web` 是采集器标识，不能作为通用的新闻来源代码使用。相同站点可以属于不同批次，站点列表不能保证只命中 `maidanglao`。

## 3. 接口一览

下表路径均接在 `HUB_URL` 后。所有接口要求有效 Hub Key；这些接口不接受 URL 查询参数，搜索条件放在 POST JSON 中。

| 方法与路径 | 用途 | Idempotency-Key | 用量 |
| --- | --- | --- | --- |
| `GET /api/v1/data/platforms` | 已知类别与当前 Key 授权状态 | 不需要 | 不计 usage unit |
| `GET /api/v1/data/news/sources` | 目录元数据与当前 Key 的新闻类别范围 | 不需要 | 不计 usage unit |
| `GET /api/v1/data/news/source-options` | 有可读新闻且已绑定目录的来源选项 | 不需要 | 不计 usage unit |
| `POST /api/v1/data/news/search` | 新闻浏览、检索、分页 | 必需 | 返回条数，至少 1 unit |
| `GET /api/v1/data/news/articles/{id}` | 已存文章详情 | **必需，虽然是 GET** | 1 unit |
| `POST /api/v1/data/news/facets` | 有界来源和类别统计 | 必需 | 1 unit |

用量复用 `data.canonical-search` 规则；unit 不等于固定金额，实际费用、额度和最大页大小以当前套餐及 Key 政策为准。

成功响应统一包含 `data` 和 `requestId`。接入方保留 `requestId` 便于排查。POST 请求体最大 32 KiB。

## 4. 从首个请求到文章详情

以下 Bash 示例需要 `curl`、`jq`、`uuidgen`。先通过安全方式设置 `HUB_KEY`。所有文章、站点及 UUID 示例均为结构说明，不承诺目标环境存在对应库存。

### 4.1 配置地址并核对类别

```bash
export HUB_URL='https://hub.minsight-ai.com'
: "${HUB_KEY:?请先设置服务方提供的 Hub API Key}"

curl --fail-with-body -sS "$HUB_URL/api/v1/data/platforms" \
  -H "Authorization: Bearer $HUB_KEY" \
  -o hub-categories.json
jq '.data.items[] | select(.registered and .authorized)' hub-categories.json
```

`data.contractVersion` 为 `mx-insight-hub.saved-record-categories.v1`。每个 `items[]` 含：

| 字段 | 含义 |
| --- | --- |
| `id` / `sourceType` | 类别代码，如 `news` |
| `label` | 显示名称 |
| `platform` | 授权数据域，如 `data_center_saved_records_news` |
| `datasetId` | 如 `data-center.saved-records.news.v1` |
| `objectType` | `saved_record` |
| `registered` | 类别是否已登记并符合源配置合同 |
| `authorized` | 已登记且当前 Key 获得该类别授权 |

类别目录动态变化，不要硬编码“14 类”。`authorized=true` 不证明已有数据、清洗完成或数据新鲜。新闻发现还会按新闻规则筛选内容。

### 4.2 获取来源下拉和可用类别

```bash
curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/source-options" \
  -H "Authorization: Bearer $HUB_KEY" \
  -o hub-news-sources.json

curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/sources" \
  -H "Authorization: Bearer $HUB_KEY" \
  -o hub-news-catalog.json
```

下拉使用 `hub-news-sources.json` 的 `data.items[]`：`key` 是目录 UUID，`value` 是显示名称。选择后提交 `catalogEntryIds:[key]`。如果前端组件采用 value/label 约定，映射为 `{value:item.key,label:item.value}`。

新闻类别从 `hub-news-catalog.json` 的 `data.categories[]` 读取，使用其 `id` 构造 `categories`。来源未绑定目录时不会出现在下拉中，但仍可能通过 `binding=all` 或 `sourceCodes` 查到新闻。

### 4.3 浏览第一批新闻

下面假设第 4.1 步已确认 `news` 获得授权。要浏览其他类别，换成实际授权代码；省略 `categories` 则查询当前 Key 的全部可用新闻类别范围。

```bash
cat > hub-news-query.json <<'JSON'
{
  "query": "",
  "categories": ["news"],
  "binding": "all",
  "timeField": "firstSeenAt",
  "pageSize": 20
}
JSON

NEWS_PAGE_KEY="news-$(uuidgen)"
curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $NEWS_PAGE_KEY" \
  --data-binary @hub-news-query.json \
  -o hub-news-page.json
jq '{requestId, pageInfo: .data.pageInfo, articles: .data.items}' hub-news-page.json
```

`query` 为空表示浏览；例如改为 `"能源"` 表示在标题或正文中匹配该字面子串。不是 AND/OR 搜索表达式。

超时或连接中断后重试上述请求时，保留同一个 `NEWS_PAGE_KEY` 和请求文件，只重跑 `curl`。不要重新执行生成幂等键的那一行。

### 4.4 请求下一页

```bash
if jq -e '.data.pageInfo.hasMore == true' hub-news-page.json >/dev/null; then
  NEXT_CURSOR=$(jq -er '.data.pageInfo.nextCursor' hub-news-page.json)
  jq --arg cursor "$NEXT_CURSOR" '. + {cursor: $cursor}' \
    hub-news-query.json > hub-news-next-query.json

  NEWS_NEXT_KEY="news-$(uuidgen)"
  curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/search" \
    -H "Authorization: Bearer $HUB_KEY" \
    -H "Content-Type: application/json" \
    -H "Idempotency-Key: $NEWS_NEXT_KEY" \
    --data-binary @hub-news-next-query.json \
    -o hub-news-next-page.json
fi
```

继续翻页时，使用最新响应的 `nextCursor`，保持原过滤条件与 `pageSize` 不变，每个新页面生成新幂等键；`hasMore=false` 时停止。同一页面重试仍复用该页面的幂等键。

游标有效期 6 小时，绑定 Key、consumer、授权及所有查询条件。按选定时间与文章 ID 倒序实时分页，不提供冻结快照或精确总数。客户端按文章 `id` 去重；需要处理修订时同时保存 `revision`。`firstSeenAt` 不是可靠的“最近更新”变更水位。

### 4.5 读取一篇文章

```bash
if ARTICLE_ID=$(jq -er '.data.items[0].id // empty' hub-news-page.json); then
  NEWS_DETAIL_KEY="detail-$(uuidgen)"
  curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/articles/$ARTICLE_ID" \
    -H "Authorization: Bearer $HUB_KEY" \
    -H "Idempotency-Key: $NEWS_DETAIL_KEY" \
    -o hub-news-article.json
  jq '.data.article' hub-news-article.json
fi
```

详情位于 `data.article`。它比列表多 `body` 字段，返回完整的**已存内容**；内容可能只是 RSS 摘要，不会自动补抓原文。

## 5. 来源、时间与统计

### 5.1 按网站或目录筛选

从列表的 `source.code` 取得真实代码后，放入 `sourceCodes`。以下是代码值为 `cpd.org.bd` 时的请求体示例：

```json
{
  "query": "",
  "sourceCodes": ["cpd.org.bd"],
  "categories": ["news"],
  "binding": "all",
  "timeField": "firstSeenAt",
  "pageSize": 20
}
```

组织网站的新映射通常可从 `site_id` 得到来源代码，但历史记录或其他来源字段可能不同，应以响应为准。也可以使用来源下拉返回的 UUID 组成 `catalogEntryIds`。数组内多个值取 OR；同时传来源代码、目录、类别等不同维度则取 AND。

**当前不能提交 `tag`、`connectorId`、`connector_id`、`siteId`、`site_id` 或 `source_type` 作为过滤字段**，否则返回 `400 unsupported_fields`。也不支持 `sources`、`matchMode`、`sort`、`topics` 等未列入合同的字段。

### 5.2 search / facets 参数

全部为可选字段；缺省查询当前授权新闻范围。

| 参数 | 类型与默认值 | 规则 |
| --- | --- | --- |
| `query` | string，默认 `""` | 最长 300 字符；标题/正文不区分大小写的字面子串 |
| `categories` | string[]，默认 `[]` | 类别代码；每一项均须获得当前 Key 授权 |
| `catalogEntryIds` | UUID[]，默认 `[]` | 来源目录 ID；不要传文章 ID 或名称 |
| `sourceCodes` | string[]，默认 `[]` | 来源代码，区分大小写；最长 96 字符，匹配 `^[a-zA-Z0-9][a-zA-Z0-9._-]{0,95}$` |
| `binding` | string，默认 `all` | `all`、`mapped`、`unmapped`；表示目录绑定状态 |
| `timeField` | string，默认 `firstSeenAt` | `firstSeenAt` 或 `publishedAt` |
| `from` | RFC3339 string / null | 包含下界，必须带时区，最多 6 位小数秒 |
| `to` | RFC3339 string / null | 不包含上界；同时给出时须 `from < to` |
| `pageSize` | integer，默认 20 或更低的政策上限 | 1–100，且不超过当前 Key 政策限制 |
| `cursor` | string / null | search 翻页使用返回值，最长 4096；facets 请省略 |

三个数组各最多 50 项；空数组表示不额外限制该维度。`categories` 不能超过授权范围，即使另一个类别已获授权也不会忽略未授权项。

按原文时间筛选示例：

```json
{
  "query": "能源",
  "categories": ["news"],
  "timeField": "publishedAt",
  "from": "2026-10-01T00:00:00+08:00",
  "to": "2026-10-17T00:00:00+08:00",
  "pageSize": 20
}
```

选定时间字段为空的记录不参与该次查询。仅有发布日期、没有精确发布时间的文章可返回 `publishedDate`，但不会伪造 `publishedAt`，因此按 `publishedAt` 搜索可能少于按 `firstSeenAt` 浏览。

### 5.3 获取有界统计

```bash
NEWS_FACETS_KEY="facets-$(uuidgen)"
curl --fail-with-body -sS "$HUB_URL/api/v1/data/news/facets" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $NEWS_FACETS_KEY" \
  --data-binary @hub-news-query.json \
  -o hub-news-facets.json
```

facets 使用相同过滤条件，按选定时间取最新最多 5,000 条匹配记录；不随 search 的页大小或游标分段统计。返回：

- `sources[]`：`catalogEntryId`、`code`、`name`、`count`。
- `categories[]`：`id`、`count`。
- `sampledRecords`、`truncated`、`asOf`、`countBasis="records"`、`scope="latest_matching_records"`。

`truncated=true` 表示统计达到上限。计数是记录数，不是去重文章数或事件数，不应作为全库数量。

三个来源接口用途不同：`sources` 是目录元数据（`coverage=not_measured`）；`source-options` 是当前有可读新闻且绑定目录的全部来源选项；`facets` 是筛选结果的有界统计。目录存在、下拉数量、统计数量都不能证明 325 个网站全部采集成功。

## 6. 响应字段

以下为虚构数据的结构示例；UUID、名称和内容不代表线上记录：

```json
{
  "data": {
    "contractVersion": "mx-insight-hub.news-discovery.v1",
    "items": [
      {
        "id": "00000000-0000-4000-8000-000000000001",
        "revision": 1,
        "category": "news",
        "source": {
          "catalogEntryId": null,
          "name": "示例研究机构",
          "code": "example.org",
          "bindingStatus": "unmapped"
        },
        "title": "示例能源研究报告发布",
        "excerpt": "这是已存内容的示例摘录。",
        "summary": null,
        "url": "https://example.org/news/energy",
        "author": {"name": null},
        "publishedAt": null,
        "publishedDate": "2026-10-16",
        "publishedAtPrecision": "date",
        "firstSeenAt": "2026-10-16T08:00:00.000Z",
        "contentExtent": "summary",
        "topics": [],
        "keywords": [],
        "section": null
      }
    ],
    "pageInfo": {"returnedCount": 1, "hasMore": false, "nextCursor": null},
    "filters": {
      "query": "", "catalogEntryIds": [], "sourceCodes": [],
      "categories": ["news"], "binding": "all", "from": null, "to": null,
      "timeField": "firstSeenAt", "pageSize": 20
    },
    "dataBasis": "stored_canonical",
    "pagination": "live_keyset"
  },
  "requestId": "00000000-0000-4000-8000-000000000002"
}
```

| 字段 | 使用说明 |
| --- | --- |
| `id` / `revision` | Hub 文章记录身份及修订版本；不同采集记录可能对应同一原文 |
| `source.catalogEntryId` / `code` | 可分别回填目录或来源代码过滤；允许 null |
| `source.bindingStatus` | 目录是否绑定；`unmapped` 不等于内容不可用 |
| `title` | 标题，可能为 null |
| `excerpt` | 已存正文的前最多 360 字符；不是来源摘要 |
| `summary` | 来源明确提供的摘要，缺失为 null |
| `body` | 仅详情返回；已存正文或摘要，可能为 null |
| `contentExtent` | `full_text`、`summary`、`reference`、`unknown`；正文非空不证明全文 |
| `publishedAt` / `publishedDate` / `publishedAtPrecision` | 原文发布时间、仅日期值及解析精度；未知为 null，不用收录时间替代 |
| `firstSeenAt` | 记录携带的收录时间，不表示本次请求时间或最后修改时间 |
| `url` | 可公开的 HTTP(S) 原文地址，允许 null |
| `author.name` / `section` | 上游提供的信息，可能为 null |
| `topics` / `keywords` | 上游结构化数组，可能为空；当前仅展示，不支持独立过滤 |

列表不含 `body`；详情返回 `{data:{contractVersion,article:{...}},requestId}`。不返回源库坐标、密码、原始响应或内部批次标签。

## 7. 幂等、错误与重试

`Idempotency-Key` 长度 8–128，匹配 `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`。

同一个路径、请求体和页面重试复用原键；成功重放不重复计量。不同页面、修改条件或另一次详情读取使用新键。不能用一个固定键承载所有搜索。

错误响应格式：

```json
{
  "error": {"code": "platform_not_granted", "message": "One or more categories are not granted"},
  "requestId": "00000000-0000-4000-8000-000000000003"
}
```

| HTTP / code | 处理方式 |
| --- | --- |
| 400 `unsupported_fields` / `invalid_request` | 对照参数表修正请求，勿附带原始 tag/site 字段 |
| 400 `idempotency_key_required` / `invalid_idempotency_key` | 补充合法幂等键 |
| 400 `invalid_cursor` | 游标过期、条件/身份/授权变化或值无效；重新开始查询，使用新幂等键 |
| 401 | 检查 Hub Key 是否有效，勿使用 Admin Token 替代 |
| 403 `platform_not_granted` | 核对类别授权，联系服务方开通对应范围 |
| 404 `news_article_not_found` | 文章不存在、已不可读或不在当前 Key 范围内 |
| 409 `idempotency_conflict` | 同一键用于不同请求；核对后为新请求生成新键 |
| 409 `request_in_progress` / `request_outcome_unknown` | 原请求未完成或结果未知；保留原键及 requestId，等待或联系服务方核查，避免换键重复提交 |
| 429 | 达到额度或限流；遵循服务端提示，延迟重试 |
| 503 `news_unavailable` | 环境尚未具备新闻服务条件，联系服务方核对部署与迁移 |
| 503 `news_query_timeout` | 缩小日期或来源范围；条件改变属于新请求，使用新幂等键 |

请求返回空列表不等于清洗失败：先核对授权和类别，再去掉关键词、日期及目录过滤，用 `binding=all` 浏览。`publishedAt` 缺失、目录未绑定和非新闻类型也会影响结果。

## 8. 下游交付验收与后续范围

下游联调至少完成：

1. 类别目录可读，预期类别 `registered=true` 且 `authorized=true`。
2. 新闻接口存在；使用服务方确认有库存的范围，首屏返回文章 ID 和 `requestId`。
3. 取真实 `source.code` 或目录 UUID 筛选，并用搜索结果的文章 ID 获取详情。
4. 存在下一页时保持条件翻页；同一请求重放不重复计量。
5. 页面正确展示摘要/全文程度、未知时间和统计截断状态。

以上验收证明下游查询链路可用，**不证明 `maidanglao` 全批次完整性**。严格批次验收仍由 Hub 服务方对源数据与入库记录核对；当前 API 不能单独提供这个证明。

如果交付目标是“仅开放 maidanglao、覆盖新闻和首页快照的完整 325 站数据包”，还需实现批次范围的查询/授权合同，以及首页快照的公开字段、版本、时间和分页合同。现有普通 canonical 搜索也不会公开这些内部 `web.page` 快照；不能通过增加 `web` 类别授权替代该能力。

一般新闻阅读应用可直接基于本文的新闻发现合同接入。该文档不承诺实时采集 SLA、全站覆盖率或固定库存数量。

## 9. 文档与合同位置

- 部署对应版本后的在线指南：`HUB_URL/docs/news-discovery`；类别说明：`HUB_URL/docs/saved-record-categories`。在线文档需使用 Hub 控制台账号登录；业务 API Key 用于 `/api/v1` 数据请求，不能替代文档登录。只有 API Key 的下游可直接使用本文。
- OpenAPI：`HUB_URL/docs/openapi.json`，同样需要控制台登录，按登录身份及租户权限裁剪；新闻路径是否可见取决于部署及授权。普通账户文档隐藏通用 canonical/stored 搜索，不能用是否出现在该文档判断所有接口是否存在。
- [新闻产品设计与实际交付](../product/news-discovery-design.md#122-实际交付)。早期设计草案含尚未采用的参数，接入以本文和实际合同为准。
- 维护依据：[新闻请求与响应](../../server/data/news-discovery.mjs)、[公开路由](../../server/app.mjs)、[新闻 OpenAPI 合同](../../server/contracts/news-discovery-docs.mjs)、[类别目录](../../server/data/saved-record-categories.mjs)。
