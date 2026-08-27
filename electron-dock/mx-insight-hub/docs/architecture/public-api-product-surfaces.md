# 对外 API 产品面与文档准则

- 状态：Accepted
- 日期：2026-08-27
- 适用范围：MX Insight Hub `/api/v1`、`/docs/*` 与后续新增的对外数据产品 API

## 1. 目标

Hub Admin 是操作与治理控制面；Open API 是供外部系统还原业务数据产品的读取面。对外 API
应尽量与 Admin 的业务导航保持同一概念模型，使调用方能够重建数据源目录、Telegram 会话和全国
舆情等界面，但不复制 Admin 路由、登录方式或管理权限。

这里的“还原”表示外部系统可以通过稳定字段、筛选、分页和资源关系实现等价业务视图，不表示暴露
管理端内部对象、数据库结构、凭据、原始载荷或诊断实现。

## 2. 控制面与数据面

| 边界 | Hub Admin 控制面 | Open API 数据面 |
| --- | --- | --- |
| 路径 | `/internal/v1/admin/*` | `/api/v1/*` |
| 身份 | Admin Token 或明确支持的 Launcher 管理会话 | Consumer API Key |
| 用途 | 配置、增删改、归档、审计、运行诊断 | 受授权的业务读取、检索和上下文 |
| 授权 | Hub 管理角色和控制面能力 | platform grant 与可选 step-up capability |
| 计量 | 管理操作，不借用 consumer 额度 | consumer policy、quota、usage evidence |

对外调用统一使用：

```http
Authorization: Bearer <mx insight api key>
```

也可使用 `x-api-key`。Admin Token、Launcher token、浏览器 Admin 会话和上游 provider token 都不
是 Public API Key，不能相互替代。新增公开路由必须进入 Public listener 的 API Key 鉴权、授权和
计量链路，禁止把 Admin facade 直接换一个前缀对外发布。

## 3. 导航与资源映射

Open API 文档的业务导航尽量跟随 Admin 信息架构，但只保留可对外读取的产品面：

| Admin 概念 | Open API 文档页 | 对外资源 |
| --- | --- | --- |
| 开始调用 | `/docs` | Base URL、API Key、首个请求 |
| 认证与调用规则 | `/docs/auth` | grant、quota、cursor、idempotency |
| 数据源目录 | `/docs/source-catalog` | 目录列表、详情与 metadata/facets |
| Telegram 会话 | `/docs/telegram` | 会话、消息、检索、canonical context |
| 全国舆情 | `/docs/public-opinion` | 地区、coverage、feed、详情、检索 |
| 通用搜索 | `/docs/search` | live、stored、canonical search |
| Night-All 兼容层 | `/docs/night-all` | 有界迁移兼容路由 |
| 通用工具 | `/docs/tools` | tokenize 等独立 capability |
| 能力与证据 | `/docs/evidence` | capabilities、request status、usage |
| 错误与重试 | `/docs/errors` | 稳定错误码、requestId、重试规则 |
| 机器合同 | `/docs/openapi.json` | OpenAPI 3.1 JSON |

每个左侧标签必须对应可直接打开、刷新和分享的独立 route。页面内部可以使用小型目录，但不得再把
整个文档实现为一个依赖 `#anchor` 的超长页面。旧的 `/docs#...` 链接可以重定向到新 route，不能
成为新文档的主导航合同。

导航同步是概念同步，不是路径一比一复制：例如 Admin 的“数据源目录”有编辑、归档、审计和关联
数据功能，Public 只提供经治理的读取投影。

## 4. 通用 Public API 规则

### 4.1 先授权，再发现

- 每个业务面使用显式 platform grant，例如 `source_catalog`、`telegram`、`public_opinion`。
- 跨平台或高敏口径使用独立 step-up capability，不能借基础 platform grant 隐式获得。
- 调用方先读取 `GET /api/v1/data/capabilities`。该结果是当前 consumer 的授权与服务能力发现，
  不是 provider 实时配置、Admin 健康详情或 freshness 承诺。
- 未授权返回 403；服务面未就绪应 fail closed，并区分“合法空结果”与“服务不可用”。

### 4.2 读取、搜索与幂等

- 列表和详情优先使用 `GET`，通过 consumer platform policy 计量，不要求 `Idempotency-Key`。
- 会触发检索、成本或可能重放的 `POST` 必须接受 `Idempotency-Key`，同 key + 同规范请求重放同一
  结果；同 key + 不同请求返回冲突。
- 服务端不得接受 provider、endpoint、index、SQL、ES DSL、任意字段名、credential 或任意
  `includeRaw` 等物理执行控制。

### 4.3 分页和时间

- 列表使用不透明 keyset cursor；调用方只能原样回传 `nextCursor`，不能解码或构造。
- cursor 绑定规范化筛选条件、排序、来源范围和 page size。修改任一条件必须从首页重新查询。
- page size 有默认值、consumer policy 上限与服务硬上限；不得提供无界导出或 OFFSET 页码。
- 返回 `returnedCount`、`hasMore`、`nextCursor`。能安全、经济地计算时才返回 authoritative
  `totalCount`，否则不伪造。
- 时间使用 RFC 3339。事件时间缺失时若产品使用采集/入库时间回退，必须在合同和响应中说明，不能
  把回退时间宣称为真实事件时间。

### 4.4 身份、来源和关系

- 对外资源使用稳定 ID；名称、标题、username 和 alias 不是主键。
- 跨 dataset 产品同时返回 canonical ID、dataset/source provenance 和必要的关系键。
- 相同业务对象来自多套 dataset 时，不应无证据地去重；如果提供 merged 视图，必须保留来源并让
  调用方选择范围。
- 详情、上下文和子资源通过稳定 ID/关系导航，不能要求调用方从显示文本猜关联。

### 4.5 安全投影

Public response 使用显式 allowlist。默认不得返回：

- password、token、cookie、header、DSN、connection、bucket credential 或 provider 配置；
- raw payload、任意 custom field、内部 evidence 原文、Admin audit actor 或删除历史；
- 内部 SQL/ES index/DSL、模型 chain-of-thought、prompt secret 或未经治理的推理细节；
- Launcher membership、登录账号绑定、内部租户关系或控制面 revision lock。

业务分类、覆盖状态、实施阶段、数据来源、质量状态和公开内容不因为“内部实现字段”而被隐藏；是否
发布由产品合同和 grant 决定，而不是临时在前端删字段。

### 4.6 版本、错误和可观测性

- 每个产品响应带稳定 `contractVersion`，新增可选字段向后兼容；删除/改义必须发布新版本。
- 错误使用稳定 `error.code`，响应和 header 均带 request ID；不返回 stack、SQL 或上游凭据。
- 限流、cursor 过期、索引不可用、能力未授权、对象不存在与空数据必须有不同语义。
- OpenAPI、HTML docs、Markdown 合同、示例和实现必须在同一变更中更新并由契约测试核对。

### 4.7 已接入合同优先保持兼容

已经进入生产调用链的 Public API 不因 Admin 导航或文档重组而改名、改默认值或改响应语义。当前
Night-All 兼容链路尤其需要区分两层路径：

- 调用方继续请求 Hub 的 `POST /api/v1/night-all/search/{raw,crawl,user-info}`；
- Hub adapter 继续转发 Night-All 的 `POST /api/v1/search/{raw,crawl,user-info}`；
- 请求字段、Night-All 业务响应、幂等绑定、计量证据和 last-good 行为沿用既有合同。

Telegram 也遵循同一原则：省略新增参数时，既有 chats/messages/search 仍使用 Monitor 默认口径和
兼容游标；`GET /api/v1/data/canonical/items/{id}/context` 的 `before`、`after` 默认仍各为 10，单侧
上限仍为 50。Monitor + SQLite、会话类型筛选和新的签名游标只能通过显式新参数启用。新增合同必须
用回归测试同时证明“新能力可用”和“旧请求字节级语义未被静默迁移”。

## 5. 数据源目录公开投影

数据源目录使用 `source_catalog` platform grant。它公开已发布的活动目录事实，不开放 Admin CRUD、
归档、审计、关联数据原始记录或 saved-view 管理。

能力发现中的该平台项固定使用 Hub stored 数据面，并声明 `catalog_entries`、`catalog_metadata`、
`catalog_detail` 和 `filtered_browse`。Public 调用者不能自行授予这些能力；operator 完成 consumer
授权后，调用者通过 `GET /api/v1/data/capabilities` 验证授权与服务就绪状态。

```http
GET /api/v1/data/source-catalog
GET /api/v1/data/source-catalog/metadata
GET /api/v1/data/source-catalog/{id}
```

列表支持 `query`、`sourceKind`、`majorCategory`、`scenario`、`region`、`coverageStatus`、
`deliveryStatus`、`reviewStatus`、`runtimeStatus`、`priority`、`ownerId`、`tag`、`pageSize` 和
`cursor`。调用方可以按 cursor 拉取完整活动表，也可以还原 Admin 的多维筛选体验。

条目投影包含稳定 ID/key、规范名称和 alias、来源类型、父级引用、业务分类、场景、区域、模块、可
监测内容、可提取线索、追踪字段、建议接入方式、合规边界、优先级、coverage/delivery/review/
runtime 四条状态轴、负责人引用、connector hints、tags 和经治理备注。

`metadata` 返回：

- 字段定义与枚举 choices；
- 活动 taxonomy 与负责人公共投影；
- 同一口径的 summary 与 facets，供筛选器和汇报卡片直接使用。

`summary` 与 `facets` 是稳定合同，不是任意 JSON。summary 固定包含 active 总量、coverage/delivery/
review/priority 计数、coverage rate、未分配负责人数量和分类汇总；facets 固定包含
`majorCategories/scenarios/regions/owners/connectorHints/tags`。两者的 OpenAPI schema 都使用
`additionalProperties=false`，新增字段必须走合同版本评审。

详情只接受列表返回的 active UUID，返回同一个 customer-safe `SourceCatalogEntry` 投影，不额外暴露
管理字段。详情不接受 query 参数；非法 UUID 返回 `invalid_source_catalog_id`，未知或归档 UUID 返回
`source_catalog_entry_not_found`。列表、metadata 和详情共享 `source_catalog` platform quota，分别计量。

Public 不返回 archived entries/terms/owners、`evidenceRefs`、`customFields`、`importedFrom`、内部
revision/timestamps/events、linked login account、related canonical records、physical source
connection 或 credential。Admin saved views 是用户/团队界面状态；外部系统通过上述 filters 自行
保存视图，不把 saved view 当目录事实。

备注、建议接入方式、合规边界、负责人/分类描述等自由文本仍属于可还原的业务字段，但 Public
projection 会在字段级拦截误粘贴的 DSN、带凭据 URL、Bearer/Basic 值、API Key、密码、token、私钥
和私网连接。响应以 `redactedFields` 明示受影响字段；全文搜索、facets 与 summary 也只基于脱敏后的
投影，不能通过过滤条件旁路探测被拦截内容。

## 6. Telegram 会话公开投影

Telegram 使用 `telegram` platform grant，沿用现有资源：

```http
GET  /api/v1/data/telegram/chats
GET  /api/v1/data/telegram/messages
POST /api/v1/data/telegram/search
GET  /api/v1/data/canonical/items/{id}/context
```

- `sourceScope=all|monitor|sqlite` 选择合并、Monitor 或 SQLite。既有 v1 路由在省略参数时继续默认
  `monitor`，避免静默改变现有调用；需要还原完整数据产品的调用方显式传 `all`。
- 会话目录支持 `kind=all|channel|group|unknown`、`query` 和 cursor。
- 消息列表通过稳定 `chatId/chatKey` 选择会话，支持时间窗和 cursor；返回 `canonicalId` 与来源。
- 搜索默认跨当前 source scope；传 `chatId` 时限定当前会话。
- 普通历史通过 cursor 连续加载；`before/after` 只属于搜索命中的 canonical context，不是会话总量
  限制。
- 上下文仍使用 canonical context 合同，不为 Telegram 复制另一套窗口实现。

这样调用方可以重建左侧会话目录、频道/群组切换、会话内无限历史、全局/会话内搜索、命中高亮和
前后文，同时看到 Monitor/SQLite provenance。Public 合同仍受 Telegram grant 与配额约束；Admin
的内部质量诊断和连接状态不是会话内容。

## 7. 全国舆情公开投影

全国舆情使用 `public_opinion` platform grant，复用已发布的地区、coverage、列表和详情合同：

```http
GET /api/v1/data/public-opinion/regions
GET /api/v1/data/public-opinion/regions/{regionCode}/items
GET /api/v1/data/public-opinion/provinces/{province}/items
GET /api/v1/data/public-opinion/province-coverage
GET /api/v1/data/public-opinion/items/{id}
```

调用方可以据此重建 34 个省级地区切换、时间窗、coverage/缺口、hot/latest 列表和详情。普通
`public_opinion` grant 只提供已治理的产品口径；`visibility=all_ingested` 的 region feed 仍要求
单独的 `public_opinion.all_ingested.read` capability。

实时 funnel、未展示记录以及未归属/候选/拒绝原因是增强诊断面，不进入基础
`public_opinion` grant。需要还原完整数据产品的 consumer 必须同时取得独立的
`public_opinion.diagnostics.read` capability，之后可以调用：

```http
GET /api/v1/data/public-opinion/funnel
GET /api/v1/data/public-opinion/records
GET /api/v1/data/public-opinion/records/{id}
```

这些路由复用同一 current canonical 母集、筛选和 keyset cursor，只返回有界业务内容、发布/质量/
地理状态和稳定诊断原因。它们不返回 raw payload、source connection、provider credential、内部
pipeline 配置、Admin actor 或模型 reasoning。未取得 step-up capability 的 consumer 必须得到
403，而不是通过基础 feed 间接获得未发布语料。

## 8. 新增 Public 产品面的交付检查表

每个新增或扩展的 Public API 合并前必须同时满足：

1. 明确对应的 Admin 业务概念与 Public 使用场景；
2. 明确 platform/capability grant，不依赖 Admin Token；
3. 建立显式 response allowlist 和稳定资源 ID；
4. 规定 cursor、page size、时间窗、排序和空/错语义；
5. 接入 consumer quota、usage evidence，POST 接入 idempotency；
6. 在 `GET /data/capabilities` 中可发现；
7. 更新 OpenAPI JSON/YAML、独立 docs route、Markdown 合同和示例；
8. 测试 API Key 成功、无 key/错误 key/Admin Token/Launcher token 拒绝、未授权拒绝；
9. 测试分页无重复/遗漏、cursor 与筛选绑定、敏感字段不泄漏；
10. 验证不改变 Admin、Launcher、MX-H2I 登录、联网和现有 Public API 的兼容行为。
