# Hub 数据产品下游交付入口

核对日期：2026-10-19。以下是当前仓库的接入入口与策略边界，目标环境须完成对应版本发布和联调。平台是否出现在管理后台，不等于当前 API Key 已获授权或上游已就绪。

## 先选数据产品，再编译关键词策略

| 下游需求 | 主要入口（前缀 `/api/v1`） | 使用规则与详细合同 |
| --- | --- | --- |
| Telegram 已存消息、会话和命中上下文 | `/data/telegram/search`、`/data/telegram/chats`、`/data/telegram/messages`、`/data/canonical/items/{id}/timeline` | [Telegram 完整交付指南](telegram-downstream-guide.md)：来源选择、关键词策略、分页、增量和性能 |
| 对 Hub 已存语料选择全文策略 | `POST /data/canonical/search` | 显式 `platform`、可选 `datasetId/objectType/searchProfile/sort`；不同平台过滤器不可混用。见[公共合同](../contracts/public-api-v1.md#unified-canonical-search) |
| 单平台外部内容检索 | `POST /data/search` | [统一策略搜索](unified-strategy-search.md)与[当前策略产品](../product/strategy-search.md)；可能发生外部采集与计费，平台查询语法不通用；v2 支持范围须按该产品合同单独选择 |
| 已知账号内容／资料 | `POST /data/social/crawl`、`POST /data/social/user-info` | [账号迁移接入](social-account-migration.md)；账号查询与关键词找内容是两类操作，旧兼容路径继续按旧合同使用 |
| 跨平台聚合 | `/data/aggregate/sources`、`POST /data/aggregate/preview`、`POST /data/aggregate/search` | [聚合产品与路由](../architecture/aggregate-search-and-source-routing.md)；先发现已授权来源，再按该接口合同选择执行模式；不能把单平台游标混用 |
| 新闻及组织网站新闻 | `/data/news/source-options`、`POST /data/news/search`、`/data/news/articles/{id}` | [新闻接入指南](organization-web-data-api.md)：类别、来源、时间窗、分页、正文与统计；目前无公开 batch tag 过滤或网站首页快照产品 |
| 区域舆情 | `/data/public-opinion/regions`、`/data/public-opinion/regions/{region}/items` | [公共合同](../contracts/public-api-v1.md#public-opinion-data)：正式数据、候选和诊断权限分开 |
| 电商商品检索 | `POST /data/ecommerce/products/search` | [公共合同](../contracts/public-api-v1.md#external-data-platform-product-search)：市场、交付模式、商品与内容搜索的区别、独立分页和计费 |
| 其他已开通产品 | 当前 Key 可见的 OpenAPI 和 `/data/capabilities` | 企业、IP、微信、小红书专项等以自己的产品合同为准；不要从管理页面标题推测请求结构 |

Telegram 查询读取 Hub 已入库的数据，不要求下游连接 Night-All、源数据库、Embedding 或 Launcher。不得用 `/search/raw` 等外部采集兼容路径替代 Telegram stored 接口。SSO 用于人的控制台访问，下游服务调用使用 Hub Public API Key。

## 每个下游策略应保存的最小状态

1. `strategyId/version` 与业务关键词规则：保留原词、别名、匹配模式，明确是召回还是最终命中规则。
2. 选定的 Hub endpoint、来源/平台、固定过滤器和 `pageSize`。每条请求只能提交该接口 allowlist 中的字段。
3. 每个检索分支自己的不透明 cursor、当前页请求体、Idempotency-Key、成功响应的 requestId；改变规则或过滤器开启新遍历。
4. 用 canonical UUID 去重；对外部内容按该产品身份合同去重。落库成功后再推进检查点，禁止遇到失败就跳过当前页。
5. 保存返回的 warnings、partial、数据版本和时间，区分正常耗尽、执行中、降级、失败和未完成。零条不能单独证明没有更多结果。

不要把 `AND/OR` 字符串直接传给所有数据源。Telegram 当前的公共全文策略和受控关键词组合规则见[指南第 4 节](telegram-downstream-guide.md)。外部平台的 Boolean 支持不能从 Telegram 或某个供应方行为推断。

## 公共接入约定

- 由服务方提供 Public HTTPS origin 与具备所需平台／操作权限的 Key。后端保管 Key，通过 `Authorization: Bearer …` 或 `X-API-Key` 发送，不把它交给最终浏览器用户。
- 首先调用 `GET /api/v1/data/capabilities`；能力、授权、数据新鲜度与线上健康是独立事实。API 文档中的当前 Key 可见范围也不替代实际请求校验。
- 每个有幂等要求的新页面使用新 Key；重试同一页面保留原 Key 与原请求。重放期限依接口和 `type` 而异。不要认为所有 GET 都免幂等：例如新闻详情需要，Telegram history/context/timeline 不需要。
- 对可能触发外部采购的未知结果，只读查询原请求状态，不自动换键、换路径或换供应商。stored GET 可有界重试，但会重新计量。
- 从每分支串行、`pageSize=20` 开始；总并发服从已购套餐和服务方限制。限流退避，前端搜索加防抖，详情及上下文按需加载；不为渲染第一页等待全库统计。

## 本次 Telegram 改动与发布验收

本次只修改 Hub：专用搜索路由恢复按合同省略 `platform`；消息历史先限页选 ID 再读取正文，使用现有会话时间索引；history 和 PostgreSQL 搜索游标保留微秒；PG 内容包含检索转义 `%`、`_`、反斜杠；后台搜索补齐前后页并隔离切源的旧结果。保留既有鉴权、配额和历史响应重放，不改变 MX-H2I 登录与联网。

无需新增迁移或重建全库搜索。沿用原 Hub 发布流程与现有索引检查，保持 `MX_INSIGHT_SYNC_LAUNCHER=0`、`MX_SMOKE_DATA=0`，同时发布 Public、Admin 与前端。新代码继续接受旧毫秒游标；旧进程不能保证接受新微秒游标，避免混用版本。旧 token 已经丢失的微秒不能逆向恢复，严格核对任务应在发布后新开遍历并去重。

验收至少覆盖：按文档发起 TG 专用搜索（不加 `platform`）、首屏及第二页、同毫秒多条消息无遗漏、旧游标继续可读、Monitor/SQLite 来源隔离、后台大会话打开和切换、搜索翻页与失败重试。记录代表性大／小会话首屏及续页延迟、数据库执行计划和降级比例；本地测试不代表线上延迟指标。大量无业务时间的历史记录仍可能排序空值子集，索引缺失或数据库拥塞也需分别判断。

当前尚未提供任意 Boolean DSL、消息正文编辑距离 fuzzy、跨来源同消息自动归并、冻结全量导出或可靠 CDC。这些能力不能通过客户端拼接游标或轮询业务时间来补出完整保证。
