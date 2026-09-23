# 新闻发现：数据产品分析与实施设计

日期：2026-09-24。状态：**首版已在本地实现，未部署生产**。第 1–11 节保留分析时的事实基线与目标设计；第 12 节列明实际交付、取舍与未完成范围。

本稿依据用户提供的数据库附件、两张控制台截图和当前仓库代码形成。附件中的操作命令、维护规则和建议只作为背景资料，不构成执行迁移、采集、发布或修改其他项目的指令。本轮没有连接生产数据库，因此不宣称真实库存、来源覆盖率或线上完整性已经验证。

## 1. 产品判断

建议新增「新闻发现」，与「专题洞察」并列：

- 新闻发现：查找、筛选、阅读和通过 API 分页取得已入库新闻，主要入口是关键词、新闻来源、分类和时间。
- 专题洞察：围绕研究问题生成有证据的趋势、维度和共现报告；后续可以接收新闻发现的筛选条件。
- 数据浏览中心：保留内部原始记录、清洗结果和质量诊断职责。

不宜通过把专题洞察的 `platforms` 从类别改成网站来实现新产品。这会改变旧 API、Key 授权和历史报告的含义。新产品需要独立的文章查询合同，复用 Hub 的存储、身份与授权基础。

第一版使用已经清洗的库存，查询不发起上游采集、正文补抓、LLM 或翻译。现有通用聚合搜索默认可能触发 live 请求，不能直接作为新闻页面的默认调用入口。

## 2. 当前实现已核实的事实

| 事实 | 代码或文档依据 | 产品影响 |
| --- | --- | --- |
| 现有 `platforms` 是 `data_center_saved_records_<source_type>` | `server/ingest/crawler/source-contract.mjs` 的 `crawlerSourceSpec()` | 新闻、财经、科技等是类别及授权范围，不是新浪、环球网等网站 |
| 初始 13 类已支持持久化动态发现 | `listCrawlerSpecs()`；`docs/operations/night-all-saved-records-ingestion.md` | 不应把 13 类写成永久枚举 |
| `attributes.platform/platform_name/section` 已进入 canonical 血缘 | `server/ingest/crawler/record.mjs` 的 `enrichCrawlerRecord()` | 可从结构化字段整理来源，无须从普通标签猜平台 |
| collector 与 publisher 已分别保留 | `stableFields.crawler.lineage`、`stableFields.sourceCatalog` | `china-news` 是采集入口；`sina` 才可能是该条新闻的来源网站 |
| 公开候选类型仅有 `news` 和 `news.article`，且要求标题或正文非空 | `PUBLICATION_CANDIDATE_TYPES` 与 `publication()` | `news.resolved`、`bbc.article` 目前不会进入这条公开新闻链路 |
| 分类不限制上述类型只能在 news 分区 | 同一 `publication()` | 财经、科研等类别的 `news.article` 已可能是公开候选；只选择 news 会漏查 |
| 专题标签来自 tags/keywords 数组 | `server/insights/topic-reports.mjs` 的 `recordTags()` | 来源、采集器和主题可混在标签排行中，排行不能直接成为权威平台目录 |
| 清洗器未将 `source_topics`、摘要、正文状态等映射为新闻专用字段 | `record.mjs`；`CRAWLER_FIELD_MAP` | 仅改 UI 不能完整交付文章主题、摘要、全文程度等信息 |
| 原始输入另存 `rawItem` 与 raw 哈希 | `server/ingest/external/mapping.mjs`；`ingestExternalRecords()` | 历史字段可评估从 Hub 已留存原始证据重算，不必默认重新采集 |
| 专题分析上限 500 条，返回证据最多 80 条 | `normalizeTopicReportRequest()`、`buildTopicReport()` | 专题报告不是新闻全集分页 API，截图中的标签计数也不能当全库数量 |

这些事实说明主要缺口在新闻语义和产品服务层，已有数据库清洗管线可以继续使用。

本次本地核验：`crawler-record.test.mjs` 与 `topic-reports.test.mjs` 共 28 项通过；合成数据确认上述类型门禁与字段投影行为。测试没有使用生产新闻数据，不等于线上覆盖验收。

## 3. 五个维度应分别建模

| 维度 | 示例 | 建议公开名称 | 用途 |
| --- | --- | --- | --- |
| 数据类别 | `news`、`finance`、`technology`、`research` | `categories` | 分类筛选，映射现有类别授权 |
| 内容实体类型 | `news.article`、`bbc.article`、文章引用、评论 | `contentKind` | 判断文章、摘要、引用等实体；不要求用户理解采集器类型 |
| 新闻来源网站/内容平台 | 新浪、环球网、BBC、公众号平台 | `sources` | 主筛选维度，使用稳定 Hub 来源 ID |
| 作者/发布机构 | 作者姓名、报社、账号 | `author`、`publisher` | 保留平台与实际发布主体的区别 |
| 主题、栏目和关键词 | 国际、科技、选举 | `topics`、`section`、`keywords` | 内容筛选，保留结构化来源 |

`connector_id`、`source_family`、运行 ID 属于内部采集血缘。具体新闻网站不是付费供应商凭据，可以经白名单映射公开；内部 provider、数据库坐标、凭据、原始响应不随之开放。

同一平台下可能有多个发布者。Google News 等聚合入口也不必然是原文出版方：来源平台、原文出版方和内部采集路径不能强行压成一个字段。未知出版方应保留未知。

## 4. 来源分组与标签的使用

来源归一化建议按以下证据顺序处理：

1. 读取已保留的结构化 publisher code/name，并映射到经核实的 Hub 来源目录。
2. 缺失时，按特定连接器的已核实合同处理 `source_id` 前缀或原文域名。仅对确定规则启用；Google 重定向域名等不能当出版方。
3. 历史标签只作为兼容线索：与来源别名白名单匹配，结合连接器/URL 证据；普通主题词和 `china-news` 等 collector 标签不产生来源平台。
4. 冲突或证据不足显示「未识别来源」，保留记录并进入内部诊断，不静默丢弃新闻。

内部记录 `sourceResolution.method/version/status`，方便追溯和更换归一化规则。

**可以 GROUP BY，但应先归一化结构化来源，再 GROUP BY sourceId。** 标签上的 DISTINCT 只能回答“出现过哪些标签”，不能证明这些标签都是平台，更不能证明文章重复。

来源目录应结合“已核实来源定义”和“当前授权库存观测”：附件提到的 51 个 china-news 子来源是潜在覆盖清单，不能当作 51 个站点均已采集成功。下游可筛选来源及其计数来自当前授权数据；内部可另外展示尚无库存的已登记来源。

## 5. 怎样覆盖各类别中的新闻

检索范围应是：**全部已登记类别中、符合已核实文章规则、处于允许公开状态、并在当前 Key 授权内的记录**。不能只查询 `saved_records_news`，也不能把所有分区的所有记录都叫新闻。

建议维护版本化判定规则，以来源合同 + `record_type` + 内容结构综合识别：

- 已核实的 `news`、`news.article`：作为基线文章类型。
- `news.resolved`、`bbc.article` 等：核对实际样本和连接器合同后纳入，不凭名称包含 article 全量放行。
- `selfmedia.article_ref`：可作为「文章线索」进入独立筛选，明确没有正文；不计为完整新闻正文。
- 热榜条目、评论、账号、运行结果、岗位、一般论文等：保留原实体类型，不混入默认新闻列表。
- DOE 等科研报道：从 research 类识别文章。专表中的实验室、原文/译文、完整性等增强字段若未进入统一清洗链路，需要单独验证接入，不能假定当前已有。

附件中的通用 `source_type=news` 查询示例不能满足“跨类别全部新闻”；该附件自身已指出财经、科技、汽车、地方新闻和 DOE 的例外。

新产品应增加独立、版本化的新闻判定/公开投影，保持现有 crawler publication v1 行为。扩展新闻产品的类型覆盖时，不顺便放宽旧 stored/canonical/topic API 的可见集合。

完整性需要分层说明：源库文章 → 已清洗记录 → 已识别文章 → 可公开记录 → 当前 Key 可见记录 → 当前筛选结果。界面应显示同步时间、时间字段缺失、来源未识别和线索/正文状态；不将“查询成功”标成“已覆盖源库全部新闻”。

## 6. 去重分三层

| 层次 | 依据 | 推荐行为 |
| --- | --- | --- |
| 采集记录幂等 | 原始 `record_key`，即 connector + record_type + source_id 的哈希 | 保留既有源身份和 canonical ID |
| 同一文章的重复采集 | 已核实的来源文章 ID、保守规范化 URL、足够完整正文的确定性指纹 | 建立可追溯重复组；保留每条记录及其来源证据 |
| 同一事件的多篇报道 | 实体、时间、语义、引用证据 | 后续事件聚类，不当成重复记录删除 |

不同 connector、不同记录类型的同一文章可能有不同 `record_key`。反过来，相同标题、主题标签或平台也不能证明同一文章。URL 规范化只剔除已知追踪参数，不能任意删除具有文章身份含义的 query。

第一版默认保留全部来源记录，只处理分页重复 ID；确定性重复组就绪后提供可选「折叠重复采集」。组内成员、代表文章和计数先经过授权过滤，不能泄露其他类别的记录。转载自不同网站的报道保留各自来源，可显示关联，不直接吞掉。

## 7. 下游数据合同草案

以下路径均为**拟新增**，当前不可调用：

| 接口 | 用途 |
| --- | --- |
| `GET /api/v1/data/news/sources` | 当前 Key 可使用的新闻来源及覆盖信息 |
| `POST /api/v1/data/news/search` | 条件检索、空关键词浏览、游标分页 |
| `GET /api/v1/data/news/articles/{id}` | 文章完整的已存内容与公开来源字段 |
| `POST /api/v1/data/news/facets` | 同一检索条件下的来源、类别、主题统计 |

保留 `GET /api/v1/data/platforms` 的原有类别语义，不把它改成网站目录。第一版不复用通用 canonical 请求体硬塞新参数：当前该请求体要求关键词，且日期参数有 public_opinion 专用限制，缺少新闻来源过滤。

示意搜索请求：

```json
{
  "query": "新能源",
  "matchMode": "all",
  "sources": ["sina", "huanqiu"],
  "categories": ["news", "technology"],
  "from": "2026-09-01T00:00:00+08:00",
  "to": "2026-09-25T00:00:00+08:00",
  "timeField": "publishedAt",
  "sort": "newest",
  "pageSize": 20,
  "cursor": null
}
```

`sources` 中的值以新来源目录实际返回为准；示例不代表已有库存。日期区间建议统一为左闭右开。第一版关键词采用已说明的字面词项 any/all；中文全文和相关性排序如后续启用，应有独立明确的查询语义，不能在不同后端间静默改变。

建议文章返回字段：

```text
id / canonicalId / revision
category
source { id, name }
publisher { name } / author { name }
title / summary / body / url
contentKind / contentExtent(full_text|summary|reference|unknown)
topics[] / keywords[] / section
publishedAt / publishedDate / publishedAtPrecision
firstSeenAt / lastObservedAt
media[]（仅经审查的公开媒体字段）
duplicateGroupId（有确定性分组时）
```

字段要求：

- summary 取来源摘要；列表需要正文摘录时另叫 excerpt，不把摘录或 AI 生成内容伪装成来源摘要。
- body 返回完整的已存正文；非空不代表全文，未知完整性返回 unknown。详情不会自动补抓。
- 原文时间解析失败或只有日期时保留相应状态/精度；不能拿采集时间冒充发布时间。
- 默认可用 firstSeenAt 展示「最新收录」，同时显示原文时间；切换 publishedAt 筛选时明确无可比较发布时间的记录未参与该时间范围，不偷偷混入采集时间。
- 标签只使用上游明确提供的结构化内容标签；collector/source 标识与主题分离；缺失不从正文猜词补齐。
- 原始 source_id 保持字符串，公开稳定 ID 不依赖浮点数解析。
- 不整体返回 `stableFields.crawler`、raw、credentials 或内部运行血缘，使用专用字段白名单。

分页按确定性 `(sortTime, id)` 或经验证的搜索排序进行，游标绑定版本、Key/consumer、有效授权、完整过滤条件、排序和页大小。每页重验权限；授权变化后拒绝失效游标。live keyset 不承诺冻结快照，未来全量同步/导出应使用独立快照或 change feed。

返回 `returnedCount/hasMore/nextCursor`。来源/主题分面以相同授权和过滤范围计算，并明确 `countBasis=records`；未来折叠重复后显示数另行命名。精确总数和分面统计可独立限时、缓存并标注时间，不让首屏列表等待全库 COUNT 或 GROUP BY。

## 8. 权限、用量与界面

沿用 tenant → consumer → 当前 Key entitlement 与类别 grant 的交集。选择新浪只是缩小查询范围，不能绕过 finance 等类别授权。新增来源或发现新类别都不自动扩大 Key 快照。来源目录、facet、详情和重复组执行与列表一致的可见性过滤。

新闻产品可作为现有类别范围的商业组合，不新增一个能覆盖所有类别的万能 `news` grant。接口用量、价格、幂等与精确请求重放沿现有 Hub 机制落地；操作计量应单独命名并在编码阶段核对价格配置，不能因为读取库存就声称对客户免费，也不能自动改价或修改既有套餐。

控制台复用当前产品 Key 选择与临时凭据机制，页面提供「接口调试」和「新闻列表」：

- 顶部关键词、时间和新闻来源筛选；类别、主题、栏目、正文状态作为附加条件。
- 来源 chips 展示规范名称和当前范围计数，不显示混合采集器/主题标签。
- 列表优先展示标题、摘要、来源、作者、原文发布时间、首次收录时间和全文程度。
- 详情读取已存文章，可查看原文链接与重复来源；不自动调用付费接口。
- 后续可显式将筛选条件带入专题洞察，不在浏览、切页或打开详情时创建报告。

视觉继续使用 Hub 的 Neon Void 明暗主题和共享 DropdownField，无需引入另一套设计系统。

## 9. 实施顺序与历史数据

1. **覆盖审计**：在授权的只读数据环境按 source_type、record_type、结构化来源、正文状态核查分布和少量样本；对照 source 与 canonical 的水位和记录数。真实生产总量目前未知。
2. **新闻投影与合同**：以单独的新闻规则版本增加受控字段/查询模块，保留现有 source/dataset/platform/canonical ID、checkpoint、旧 publication 规则与 API。先用 Hub PostgreSQL 做有界列表与结构化过滤。
3. **API 与工作台**：实现来源目录、列表、详情及有界分面，共享 Key 身份与权限，补齐 OpenAPI、请求/响应、分页、错误和下游示例。
4. **历史补齐**：检查 Hub 原始归档完整性；以固定历史范围、checkpoint、小批次从已存 raw 重算新投影，保留来源与规则版本。源新闻可能为首次插入后跳过、last_seen_at 不再变化，因此仅升级清洗代码或等待下次增量不能补齐旧数据。
5. **搜索扩展**：只有明确需要中文全文/相关性时扩展现有 PG + outbox → ES 投影，核验 PG/ES 可见性一致。不能请求双写或部署即启动全库重建。
6. **后续分析**：确定性重复分组、事件聚类、订阅、导出、引用式摘要按需求逐步增加，不作为新闻列表首版前置条件。

历史补齐应是独立、可暂停的 Hub 派生数据任务；不默认重置原清洗 checkpoint、重跑全部采集或更改新闻原始记录。raw 不完整时明确标注覆盖缺口，再制定受控补齐方案。

## 10. 兼容性边界与验收

实现和管理配置归属 MX Insight Hub，操作面继续在 Internal；Night-All-A 的清洗来源、历史 Night-All 兼容调用以及 `/Users/qpjoy/workspace/mingxi/Night-All/` 的旧规划分别理解，不凭名字迁移源库或替换服务。

不改 MX-H2I、Luopan、Launcher 身份、OAuth/飞书登录、租约、WireGuard、路由、PAC、DNS 或本机网络 owner。Hub 发布沿现有隔离流程，保持 `MX_INSIGHT_SYNC_LAUNCHER=0`，不 rollout Launcher。后台补齐的数据库连接、并发和 IO 有上限，避免共享节点资源争抢影响登录。

编码验收至少覆盖：

- 新浪/环球网来源可独立过滤，collector 标识与主题词不误作网站。
- 财经、科技、汽车、地方、科研等类别中的已核实文章可检索；引用、评论、热榜等不伪装成全文。
- 列表、详情、来源统计、主题统计、去重组和游标均不越过当前类别授权。
- 无来源、无发布时间、仅日期、正文缺失和来源冲突均有诚实状态；原文不被摘要覆盖。
- 分页不依赖专题报告的 80 条证据上限；同一时间多篇文章具有稳定次序。
- 查询不采集、不触发 Agent，不更改旧平台 ID、API、报告结果、授权或价格。
- 历史派生任务可恢复，新增清洗与重算幂等；不存在新字段只有新记录有、旧记录静默漏查的上线状态。
- 预发布验证 Hub 异常与后台任务压力下 MX-H2I 登录/联网持续正常；本次本地测试不替代该线上隔离验收。

## 11. 参考

- 用户附件：`/Users/qpjoy/Downloads/DATABASE_FIELD_REFERENCE.md`、`/Users/qpjoy/Downloads/NEWS_STORAGE_FIELD_MAPPING.md`。
- [现有专题洞察](../topic-insight-reports.md)。
- [Night-All-A 清洗与动态类别](../operations/night-all-saved-records-ingestion.md)。
- [Hub 存储与服务架构](../architecture/data-platform-storage-and-serving.md)。
- [Launcher / Hub 隔离架构](../../../mx-launcher/docs/26-mx-insight-hub-integration-architecture.md)。
- `/Users/qpjoy/workspace/mingxi/Night-All/specs/` 提供历史职责和规划参考；以当前 Hub 代码核实已实现状态。

## 12. 目录可行性评估与首版落地

### 12.1 目录方案的判断

保留 [原目录方案](source-catalog-and-data-plans.md) 的稳定 UUID、唯一 PG 权威、分类词表、人工状态和审计，逐步实现 [能力/接入证据对账](source-catalog-reconciliation-plan.md)。基础可行，无须等待通用 Agent Studio 或重做 Launcher。

| 做法 | 优点 | 局限与决策 |
| --- | --- | --- |
| 按新闻标签 DISTINCT / GROUP BY | 快速看到存量线索，成本低 | 标签混有采集器、网站、主题；只作辅助分布，不充当权威目录 |
| 目录 UUID + 入库结构化来源 | 名称可改、绑定稳定，可跨产品归纳和审计 | 需维护别名/映射；缺项显式待归类。作为主路径 |
| LLM 全库自动分类 | 处理非标准名称和文本 | 有成本、延迟、误分类风险，可能把被报道机构当来源；不作为入库硬依赖 |
| 规则优先 + Agent 提议 + 审核 | 可追溯、覆盖长尾，模型故障不阻塞清洗/阅读 | 仍需补齐目录和人工审核。首版采用 |

“尽量归纳所有入库数据”分为三层：既有 dataset/platform/object_type 提供基本分类；明确来源绑定目录；未匹配或冲突进入待归类集合。不能为了宣称 100% 分类，把未知来源猜成已知平台。覆盖状态、接口实现、实际运行、库存数量继续独立，历史 covered 不等于真实接通。

目录是新闻的来源筛选主轴，关键词检索标题/正文。二者组合：先选来源/类别/时间，再查内容。目录不能替代全文搜索、也不能扩大 Key 授权。新闻来源、业务类别、采集器、主题标签分别建模。

### 12.2 实际交付

- 数据产品 → **新闻发现**：列表、接口调试、目录/来源代码/类别/归类状态/时间筛选、显式分页、已存详情、有界来源统计、下游接口文档。
- `GET /api/v1/data/news/sources` 返回安全目录元数据和当前 Key 的类别，`coverage=not_measured`。目录有条目不证明有库存。
- `POST /api/v1/data/news/search`、`POST /api/v1/data/news/facets`、`GET /api/v1/data/news/articles/{id}` 使用 PG 库存和授权类别交集；每次重验身份/授权，游标绑定 Key、consumer、条件与授权范围。
- 识别各个 saved-record 类别中的 `news/news.article/news.resolved`，以及 `bbc-news-openweb` 的 `bbc.article`。空内容和明确 rejected 不作为可读新闻；旧 publication 规则、canonical 接口和专题洞察合同保持原状。
- 新入库记录保存 `stableFields.news`；历史记录缺该字段时，只读取当前页/单条 current revision 已留存 raw 的新闻白名单字段，无全库重写。字段缺失返回 unknown，不伪造摘要/全文。
- 新入库来源优先按已核对的来源代码 → 稳定目录键，其次唯一规范名/别名匹配；不自动创建条目、覆盖人工别名或改覆盖状态。
- Agent 中心 → **数据归类**：浏览全部 canonical 类型，执行规则或 Agent 建议，审核后写入 record → catalog 绑定。目录的管理端关联数据也纳入当前版本的已审核绑定，并保留原始来源血缘关联证据。
- migration **110** 新增建议审计和绑定表；记录版本、目录版本、规则、目录摘要、Sequence/模型、操作人、审核人持久化。审核检查记录、目录及绑定版本；新 canonical revision 不自动继承旧审核绑定，结构化入库绑定仍作基础。
- 规则先执行，未命中且显式选择 Agent 时才调用默认 Chat Sequence，沿用其出网策略。不写入 7788/全局代理配置，也不把截图中的“需重验”视为模型验活已通过。
- Agent 同一 requestKey 只认领一次；结果未知保留 unknown，不自动再次调用。模型只可建议现有目录 ID，不能新建目录、发布、改授权、重置水位。审核是单独的显式操作。
- 搜索/统计/详情复用 `data.canonical-search` 计量：搜索按返回条数且最少 1 unit，统计/详情 1 unit；来源元数据不计量。沿用既有价格/套餐，不扩授权或改价。重试保留幂等键，详情重开使用页面缓存。

### 12.3 尚未交付或需要线上核验

1. 长尾来源可用 sourceCodes 查询；需在目录管理补充条目/别名，再执行归类。工作台覆盖全部 canonical 数据，但首版不是全库自动 LLM 任务。
2. 尚无跨来源转载合并或事件聚类。统计仅取最新最多 5,000 条匹配记录，明确 `countBasis=records`、`sampledRecords/truncated/asOf`；分来源不等于文章去重或事件计数。
3. PG 字面子串支持中文匹配，但无分词相关性/语义检索。主题、栏目、正文程度可展示，尚无独立过滤。读取超时为 5 秒，大范围查询可能需要收窄条件。
4. 未知 record_type 不能自动当新闻；其他数据仍在 canonical 和归类工作台可见。新增科研全文/引用类型须审核后纳入。
5. 公共目录 `/source-catalog/{id}/items` 原有商品合同没有扩成新闻接口。下游新闻使用新 API 的 catalogEntryIds。Admin 关联数据是治理证据，可能含采集器/原始结构化关联，不等于新闻产品的当前来源筛选。
6. 未执行生产迁移、全库回填、ES 重建、真实 LLM 调用或线上来源覆盖审计；未改现有登录、联网、租约和网关。

### 12.4 上线与验证

按既有 Hub 独立发布流程，先应用 migration 110 再发布 Hub，保持 `MX_INSIGHT_SYNC_LAUNCHER=0`，不发布 Launcher/MX-H2I。迁移不会启动分类/采集或修改价格、grants、Keys、checkpoints。

大库存先检查查询计划，再评估可选 `scripts/news-discovery-serving-indexes.sql`，仅在 Hub DB 显式运行在线索引，不在迁移事务中执行。同名存在不证明定义/有效性正确，检查脚本末尾结果；当前没有真实数据量的压测结论。

验证包括构建、TypeScript、新闻/目录/文档回归，以及隔离 PGlite 中的真实 SQL、迁移、历史字段投影、版本冲突、权限/幂等、默认 Sequence 选择、模型失败不重复调用。集成测试用 `MX_NEWS_TEST_PGLITE_MODULE` 指定现有模块，默认跳过，永不读取生产 DATABASE_URL。

浏览器在本机合成新闻/隔离数据库上验证 1440×1040、390×844：检索、20+4 条分页、来源筛选、空结果、完整详情、缓存重开、tab 切换、统计、规则审核绑定。没有调用真实模型/外部采集。

本地验收结果：56 项专项回归通过，追加的微秒分页/异常发布时间用例通过；构建、TypeScript 和运维脚本检查通过。浏览器无框架覆盖层或脚本异常，控制台仅有测试站点 `/favicon.ico` 的 404，与新闻/归类接口无关。Browser 插件未提供，使用已安装的 Playwright。生产数据量性能、真实模型和在线 MX-H2I 隔离验收仍未执行。

全量测试另有 4 项既有失败，已在原始 HEAD 隔离副本复现：external-platform-pricing-preflight 操作集合、price-book-seed 缺既有小红书端点价、tokenize 能力集合、ip-risk-client 的 data-URL 相对模块加载。本次不借此修改原有价格/操作/授权。

### 12.5 新闻来源选项与目录多选

新增 `GET /api/v1/data/news/source-options`，供下游和新闻发现的来源下拉使用。返回 `items:[{key:目录UUID,value:当前目录名称}]`，以及 `scope=authorized_news_catalog_sources`、`countBasis=catalog_entries`、`total`。UUID 不随名称修改而改变；同名目录不合并。现有 `/news/sources` 继续提供通用目录元数据与授权类别，保持兼容。

选项来自当前 Key 授权类别中至少存在一条可读新闻的有效目录绑定，排除归档目录和 provider。查询沿用入库来源、历史 marketplace 和当前版本审核绑定，审核优先；失效审核回退到原始结构化绑定。按索引候选检查存在性，不受最近 5,000 条来源统计上限影响。仅包含旧新闻的来源也可选；`total` 表示目录选项数，不是新闻条数。保留只读事务和 5 秒查询超时；大库需检查既有 `night-all-saved-records-hub-indexes.sql` 的两个目录绑定索引与 migration 110 的审核绑定索引。

页面首次展开时读取选项，同一凭据下复用成功结果，支持显式刷新、名称/ID 搜索、最多 50 项勾选、逐项移除和清空。多选后将 key 数组原样用于 `catalogEntryIds`；数组内部取 OR，与关键词、类别等维度取交集。界面展示名称，接口调试同时展示 ID/名称映射。展开、勾选、切换 tab 不查询文章或计量，点击查询才检索；分页沿用已提交条件。

选择空数组表示不限目录，未绑定新闻仍可检索。若需要浏览选定来源的所有可见新闻，关键词留空并使用现有搜索游标逐页读取；不增加无上限的全文批量返回接口。本次无需新迁移，不更改 MX-H2I/Launcher、登录、联网、代理、价格和授权。

本次验证：16 项新闻/文档回归通过（包含隔离 PGlite 真实 SQL、超过 5,000 条近期记录时旧来源仍可见、当前与过期审核绑定、名称修改、同名不同 ID、授权撤回和元数据不计量）。类型检查与构建通过。Playwright 合成数据验证首次展开取选项、搜索并多选、清空和移除、ID 数组联合检索、翻页保留已提交条件、接口调试名称映射、读取失败后显式重试，以及 1440×1040 和 390×844 布局；无脚本异常。未部署或执行生产查询。
