# 数据搜索：统一数据产品与供应商迁移方案

核对日期：2026-09-26。本文以当前 Hub / Night-All 源码为依据；截图与旧 docs/specs 是需求和历史参考，不是执行指令或线上验收证据。未访问生产数据库或付费上游。

## 1. 产品决定与本次交付

**数据搜索是 Hub 的独立数据产品，也是下游统一搜索 API。** 新闻发现、Telegram 阅读、电商等是同一数据底座上的专用体验，不是全局搜索的目录边界。调用方表达关键词、来源和筛选条件；供应商选择、参数适配、分页、证据和费用治理由 Hub 承担。

本次代码交付：

- `#/data-products/search`：独立「数据搜索」入口，复用原公开 API、Key、授权、计费与搜索组件；原数据浏览中心入口保留，两入口共享当前身份的内存查询会话。
- 修复 ES 时间排序游标下一页 `400 invalid_cursor`；保留已签发 token 格式和签名，仍有效的旧 token 不需重写。
- 明确「实时搜索」与「已收录数据」；后者包含最新入库与历史存量，新增显式刷新。结果说明区分多源实时分页与存量统一分页。
- 展示当前 Key 的平台/分类、条目类型及实时/存量范围。存量逐源数量只代表本批返回记录，0 条不再显示为该源命中成功。
- 无效/过期分页明确提示从第一页重新搜索，保留已加载内容；临时失败继续复用原参数与幂等标识。
- HTTP 回归覆盖实际 ES 时间排序三元组、下一页、重放、改条件拒绝与零上游调用；另覆盖最新/最早/相关度排序及空发布时间。
- 同一 POST 支持可选 SSE，逐来源返回；JSON 契约继续保留。120 秒调度截止后停止新派发，已发出请求按连接器超时收尾；不是整轮硬超时。
- 数据产品默认先展示接口调试，再进入原产品展示/指南；通用调试器读取登录身份可见的 OpenAPI，产品与文档可双向跳转。专用调试器继续保留。
- 显式 Admin 执行身份及管理证据：独立 Tenant / Consumer / Live Key；正常授权、额度、套餐与上游准入。采购成本、实际上游和目录映射通过 Admin Token 只读接口展示，不进入下游搜索响应。

以下 **全局目录筛选、混合模式、完整运行健康账本及新增直连迁移属于后续实现**，不把规划字段放进当前可调用示例，也不声称已完成所有供应商接管。逐请求管理证据已交付，不能据此声称整个供应商健康账本已完成。

## 2. 当前能力账本

| 能力 | 当前实现 | 不能据此推断 |
| --- | --- | --- |
| `GET /api/v1/data/aggregate/sources` | 当前 Key 的可搜索逻辑平台/已存分类与条目类型；目录与执行合同分离 | 不证明线上凭据、费用策略或上游健康 |
| `POST /api/v1/data/aggregate/search`，`refresh` | 支持的社交内容/商品操作，每个继续中的来源取一页，并发最多 3；父游标 `mxag1` 引用已提交子请求 | 不包含所有账号搜索、新闻站点或目录条目；不等于全网搜索 |
| 同接口，`stored` | 一次 canonical ES 查询或有界 PG 降级；平台/类型多选、标签 AND、发布时间区间 | 不会在请求时读取每个清洗源数据库；不包含尚未索引的数据 |
| 新闻发现 | 已识别新闻的目录 UUID、来源代码、类别、首次入库/发布时间、待映射来源 | 其新闻谓词不可直接成为全局搜索谓词 |
| 数据源目录 | 全局治理记录，分类、场景、状态与稳定 ID；Admin 接入清单按源码及当前清洗登记生成 | 215 条目录登记、人工“已覆盖”、接口实现、运行成功是不同事实 |
| 三个兼容接口 | `raw` 14 平台，`crawl` 10 平台，`user-info` 8 平台；短路径与 `/night-all/` 别名共享行为 | 固定合同声明不等于每个平台都已直连或实测可用 |
| 小红书直连 | 已核验搜索、资料、用户内容等形状按现行开关直连；旧游标/批量/未迁移形状保留兼容分支 | 平台级开关不能替代具体请求形状的迁移核验 |

当前三个兼容接口的平台矩阵（“兼容”表示存在固定 Hub 合同，实际走直连还是历史分支还取决于形状及运行策略）：

| 平台 | raw 关键词 | crawl 账号内容 | user-info 资料 |
| --- | --- | --- | --- |
| 小红书 | 部分 Hub 直连 | 部分 Hub 直连 | 部分 Hub 直连 |
| 抖音、Facebook、Instagram、Twitter、微博 | 兼容 | 兼容 | 兼容 |
| Reddit、TikTok、YouTube | 兼容 | 兼容 | 未登记 |
| LinkedIn | 未登记 | 兼容 | 兼容 |
| 知乎 | 兼容 | 未登记 | 兼容 |
| B站、快手、微信公众号、微信搜一搜 | 兼容 | 未登记 | 未登记 |

电商关键词搜索已有淘宝/天猫、京东、小红书店铺、闲鱼合同，仍按 `ecommerce` 域授权。IP、企业详情、私有报告、未上架商品不能因为“全量”而进入共享全文结果。

## 3. “全量”与实时的准确含义

全量 = **当前 Key 可访问、已经接入、支持此次查询的全部逻辑来源**。同一平台有两个供应商时，默认选定一条审核过的路由，不默认付费调用两份相同内容。不存在“读取全部 215 个目录就一定有结果”的隐含承诺。

| 用户意图 | 当前请求 | 数据新鲜度 | 成本/动作 |
| --- | --- | --- | --- |
| 查刚入库及历史内容 | `mode=stored` | 采集 → 清洗 → canonical → outbox → 索引的实际进度 | 一次原存量查询计量；不采集 |
| 向已支持平台获取本轮最新内容 | `mode=refresh` | 上游本次响应；可能自带缓存/截断 | 显式执行受控子调用；父请求不另收费 |
| 先看存量，再补实时 | 后续显式混合模式 | 两部分分别标注 | 先返回存量，用户明确补实时；不更改旧默认值 |

五分钟清洗计划是调度周期，不是端到端新鲜度 SLA。需要同时记录 `sourceObservedAt`、`lastIngestSucceededAt`、`indexedThrough`、`observedAt` 和失败/积压状态。只有已测量的差值才能展示“约 N 分钟前更新”；未获取则显示未知。`eventTime` 是内容发布时间，不能拿最新发布时间当清洗健康证明。

既有 `refresh` 默认行为保持。未来混合模式必须显式 opt-in；禁止在 `stored` 零结果或 ES 降级时自动发起付费补搜。首屏只做有界查询，总数/分面统计独立返回。

## 4. 全局目录、内容类别与授权分层

稳定标识分为四层：

1. **目录条目 UUID**：平台、站点、频道、发布者、采集器的治理身份，另有 `sourceKind` 区分；改名不换 ID。
2. **业务授权域**：当前 `platform` 和 Key 快照，例如 `data_center_saved_records_news`。保留兼容，不以目录可见性授予数据。
3. **内容分类与类型**：新闻/汽车/法律等多值 taxonomy；文章/帖子/消息/商品/账号等 `objectTypes`。新闻可以来自多个授权分类，平台也可以产生多种条目。
4. **供应商及操作路由**：仅管理侧记录 TikHub、JustOne、Night-All 等、接口、凭据修订、价格证据、适配器版本和分页模型。

全局目录查询复用 `source_catalog` 的既有授权与公开安全投影。搜索页的来源候选只暴露当前身份可检索的逻辑元数据；产品可见不授予完整治理目录权限。原始目录、连接凭据、供应商选择和采购成本不下发给租户。

规划新增搜索条件：

| 字段 | 语义与边界 |
| --- | --- |
| `catalogEntryIds[]` | 同组 OR；发布者/平台目录 UUID，最多 50；不得直接传供应商条目执行 |
| `categories[]` | 内容业务分类，多值 OR；不等同已存授权域的字符串替换 |
| `objectTypes[]` | 已有，多类型 OR；与目录、平台之间 AND |
| `filters.tags[]` | 已有，同时包含；不从正文猜标签 |
| `filters.from/to` | 既有发布时间含边界；带时区；空时间不匹配 |
| `timeField` / `sort` | 新增时先用于 stored；先实现 publishedAt/firstSeenAt 与 latest/relevance，明确空值在末尾 |
| `sourceBinding` | all/mapped/unmapped；待归类内容可发现，不能因未映射丢失 |

目录绑定按记录当前 revision 的审核绑定优先，其次摄取时的可信 publisher/marketplace binding；采集器只放 lineage，不冒充发布者。不可通过标题关键字、connectorHints 或分类名猜目录关系。

实现顺序：先共享全局 binding 解析（从新闻查询抽取，移除新闻谓词），再给 canonical outbox/ES 增加安全的 catalog UUID、类别与绑定修订投影；PG 与 ES 同条件回归后才开放筛选。迁移期间无法严格执行目录谓词时明确拒绝或固定走支持该谓词的 PG 路径，不能检索后在前端过滤第一页。不自动启动生产全量重建；旧数据映射覆盖率未知时如实标注。

## 5. 可执行能力目录与运行证据

以 `(catalogEntryId, logicalPlatform, operation, requestShape, adapterVersion)` 为矩阵行，一条平台记录可以展开多个 operation。各行分开展示：

- 合同：未登记 / 已实现 / 样本验证 / 在线验证，支持筛选、返回类型、字段完整度、分页方式/上限。
- 路由：Hub 直连 / 历史兼容 / 入库查询；选择规则和不可变 release，禁止根据清单顺序选供应商。
- 运行：当前 rollout、凭据是否配置、策略阻断原因、最近真实成功/失败时间、观测窗口与样本量。没有证据就是 `unknown/not_checked`。
- 数据：已登记清洗计划、最近成功 watermark、索引积压、可检索覆盖证据；目录预期与实测字段分栏。

“刷新支持情况”只读取 Hub 当前配置和既有调用/清洗证据，零付费调用。在线探测属于单独显式动作，沿用既有成本准入。过时成功不等于当前健康；零调用不等于故障。显示可用性时附 `observedAt` 和失效规则。

管理实现复用 `sourceConnectionSnapshot`、固定 contracts、provider operation controls、usage/provider calls 与 ingest runs，避免维护第三份手工平台支持列表。公开 `aggregate/sources` 只投影逻辑能力、限制、新鲜度与服务状态，不返回物理供应商信息。运行数据应有短 TTL、本地缓存及超时隔离；它不能成为登录/readiness 的依赖。

## 6. 搜索编排与游标

执行顺序：规范化条件 → Key/consumer 当前权限 → 选定可执行操作 → 明确不支持的筛选 → 预览/准入 → 幂等预占 → 有界调用 → 统一条目与来源状态 → 保存证据 → 结算与 outbox。

- 存量保持一次全局检索，ES PIT + search_after 固定快照；PG keyset 为活数据边界，两者不假装一致快照。续页时固定后端，ES 失效不能切 PG 后无提示继续。
- 实时各来源保留自己的页状态，聚合游标引用已提交证据。固定本轮来源、适配器版本、父/子身份与参数，运行期间默认路由变更只影响新轮。
- 父下一批沿用 root request + 页序 + 来源标识派生子幂等键；同游标换父键不能重复购买。失败/unknown/耗尽来源不被续页重新启动。
- 新的目录/混合游标应绑定 tenant、consumer、原 Key、授权集合、完整过滤、排序、pageSize、路由/binding revision。现有 canonical token 是查询/平台范围绑定，不能宣称已经有完整的 Key 绑定；未来扩展采用新游标版本，不静默扩大旧签名语义。
- 不以短页、无统一 total 或跨页重复判断结束。唯一可执行续页依据为有效 continuation；无 continuation 停止。未知数据量显示未知。
- 同平台 stable ID 去重；没有 ID 不合并整个平台。同标题、同正文摘录、跨平台转载不是同一条。实时与存量最终应通过 canonical identity/revision 关联，不能靠标题混合去重。
- 单源失败保留其他结果，来源失败与空结果分开。UI 显示成功/未执行/不可用/未知，以及本批返回与总已展示数量。

当前三项时间排序位置为 `[eventTime, id, shardDoc]`，相关度为 `[score, eventTime, id, shardDoc]`。本次故障来自解码器只认后者；修复接受两种已签名形状，未变更签名密钥、合同版本、筛选绑定或数据。

恢复规则：`400 invalid_cursor`/`410 search_cursor_expired` 提示显式重新搜索；`503 search_cursor_unavailable` 保留原参数稍后重试；结果未知用原请求记录核实，不自动换键补采。重新搜索会按当前合同计量，不默默免费重派或双扣。

## 7. 三个历史接口逐步由 Hub 接管

以下路径和业务响应保持不变：

| 路径 | 输入保留 | 输出保留 |
| --- | --- | --- |
| `/api/v1/search/raw` | platform + keyword/query 及原兼容形状 | `raw_data` 字符串、原业务字段、page/meta |
| `/api/v1/search/crawl` | username/userId/uid 与现有批量语义 | `raw_info` + `raw_data`、账号内容关联 |
| `/api/v1/search/user-info` | 原账号别名/标识 | `raw_info`、完整资料业务字段 |

保留 `/api/v1/night-all/search/*` 别名和共用计费/指纹域。新适配器先产内部标准结果，再由同一 compatibility projector 输出旧 envelope；聚合 API 只取稳定公共投影。不能直接用聚合 items 替代旧 raw 字符串或吞掉 `raw_info`。

逐 operation + shape 迁移，不按平台名称一刀切：

1. 从 Hub 固定合同与 Night-All `raw-search-service`、provider-result-contract、manifest、pagination/normalizer 形成黄金样本。覆盖 keyword/query、账号各别名、单/批量、非第一页、空结果、长正文/媒体/标签、未知结果及费用证据。
2. 实现 Hub 适配器及离线重放；记录 endpoint release、参数映射、响应取值与分页规则。上线比较优先重放既有受限样本，不做隐含双份付费 shadow。
3. 通过固定 origin、凭据、采购价格、rollout 和 Key 原 scope 门槛后，显式小范围 canary；不改客户价格、余额、Key 或 grants。
4. 新首轮切直连，旧 `mxnc1` 固定历史路径，旧直连 token 固定原 connector。恢复默认路由只影响新轮；已有轮次不能在失败后跳供应商。
5. 线上合同/分页/计量验收后升 active；保留可回滚 release。只有所有历史形状都迁完且旧游标到期后才能移除 Night-All 搜索依赖。

优先级：先补齐小红书已迁移形状的差异清单，再抖音、Twitter/Facebook、微博/微信，随后其余平台。各波次顺序由实际调用量、失败率、样本可得性决定，目前未读取生产用量，不能声称这就是实测排名。

必须保留的 Night-All 经验：

- Twitter/Facebook 内容无源标题：旧 raw title 空字符串，canonical title null；资料名字保留。全文、raw evidence、旧 replay 不重写。
- 抖音已核验 endpoint 的 `search_id`/`backtrace` 与原生 cursor 同时保留；仅该 endpoint 可从响应根 `log_pb.impr_id` 获取会话，不泛化猜字段。
- page count 对应 envelope 实际记录，明确 duplicateCount；不能为凑满 count 隐式买更多页。
- Facebook / wechat_mp 现行 Night-All 默认分别来自 RapidAPI / JustOne manifest；迁移不能假定全走 TikHub。
- 旧路径 15 页边界及 Hub 加密续页继续生效；暂不可用或 unknown 不自动重新第一页、不跨供应商重试。

## 8. 内部体验与 API 产品化

默认只需关键词；平台与条目类型多选，复杂筛选折叠。后续增加可检索的全局目录多选，目录维度跨新闻/社交/论坛/商品，不能复制“全部新闻来源”作为全局标题。关键词先保持单查询字符串；多关键词 AND/OR 在明确语法与成本后再开放。

首屏包含内容、平台、类型、发布时间/采集时间、作者和原链接；无标题保持无标题，不生成假标题。供应商、价格诊断、逐源请求证据折叠到管理侧。实时按钮说明会发起新调用，存量按钮说明索引新鲜度。切换页签、返回入口、滚动、展开正文、更新临时凭据都不采集。

当前下游接入（可用，不含规划字段）：

```http
GET /api/v1/data/aggregate/sources
Authorization: Bearer <HUB_API_KEY>
```

```http
POST /api/v1/data/aggregate/search
Authorization: Bearer <HUB_API_KEY>
Content-Type: application/json
Idempotency-Key: search-stored-round-001

{"query":"自行车","mode":"stored","platforms":["xiaohongshu"],"objectTypes":["post"],"pageSize":20}
```

下一页保留 body 与 Key，仅加返回的 `data.pageInfo.nextCursor`，换新幂等标识。网络重试保留该页原标识；刷新移除 cursor 换新标识。实时模式用 `refresh`，按来源分页，历史来源不能被迫发起采集。`preview` 用相同 body 预览，但不是锁价。

## 9. 交付波次与验收

| 波次 | 交付 | 放行条件 |
| --- | --- | --- |
| P0，本次 | 分页修复、独立产品入口、双模式文案、范围说明、显式恢复、设计 | HTTP 400 复现转通过；旧接口/身份回归；桌面与窄屏无额外采集 |
| P1，全局目录 | binding 解析与安全索引投影、目录/分类 filter、未映射来源 | ES/PG 同谓词；目录改名、归档、修订、权限收缩、分页无泄漏；索引变更显式执行 |
| P2，能力证据 | 操作/形状矩阵、运行策略与真实观测、清洗和索引新鲜度 | 读页零探测；过期/未知正确显示；权限无扩张；可追溯到合同/请求/run |
| P3，直连接管 | 分波迁移 raw/crawl/user-info，并补入聚合可执行 registry | 黄金样本、真实分页、错误与计费一致；旧游标固定；可回滚 |
| P4，统一补搜 | 显式混合模式、稳定结果窗口、跨源公平分页、异步进度 | 首屏不等待慢源；总 deadline；每轮成本上限由已发布策略约束；中断不遗失账务 |
| P5，质量演进 | 可复现中文/多语言评测、去重、排序、字段完整度趋势 | 固定评测集版本；相关性/延迟/零结果/失败分别测量；不造完整覆盖率 |

建议验收目标（待用真实规模基线校准，非现状承诺）：正常索引存量首屏 p95 ≤ 2 秒；UI 操作反馈 ≤ 100ms；游标正确率 100% 的合同样本；幂等重放零重复付费；未知结果零隐式重试。记录 tokenize、ES/PG、权限/准入、回读、网络及上游耗时，避免只报平均响应时间。

## 10. 系统隔离与发布

MX-H2I V2 继续以 Internal 为用户/配置操作面；Launcher 与客户端 ProductNetwork 拥有登录及联网，Luopan 是独立测试产品。Hub provider 缺失/暂停、搜索异常、索引迁移不得影响这些链路。本次只修改 `mx-insight-hub`，不改 Launcher/MX-H2I/Luopan、DNS/WireGuard/路由/代理、身份合同或部署配置。

P0 无数据库迁移，发布 Hub 服务与前端即可；在 ES PIT 尚有效时原时间游标能继续，PIT 过期则用户显式重开。旧 replay 保持原响应，不重写历史证据。部署后应以受控 Key 验证 stored 第一/二页、明确刷新、400/410 提示，再进行已授权 live 请求验证。本次没有发布生产版本或调用真实付费接口。

本机验收：17 个测试文件共 253 项，251 通过、2 个 PostgreSQL 环境相关测试跳过；包含搜索、旧兼容接口、身份、临时凭据、文档和计费回归。构建通过，保留既有 bundle 体积提示。隔离服务使用模拟 ES PIT/上游响应，经真实 Hub HTTP 与搜索代码验证存量 20→40→45 条、实时 4→7 条、双入口切换零采集、400 显式重开与 503 原标识重试。Playwright 检查 1440×1000 / 390×844、浅色/深色、无横向溢出、无 React 运行异常；console 仅有测试注入的 400/503 与既有 favicon.ico 404。未做真实 ES/PG 数据规模压测、生产登录联网实测或供应商在线合同核验。

源码依据：`server/data/aggregate-search.mjs`、`stored-search.mjs`、`news-discovery.mjs`、`source-connections.mjs`、`server/search/queries.mjs`、`server/contracts/night-all-legacy.mjs`、`server/hub-service.mjs`。历史/现行关系见 [聚合搜索架构](../architecture/aggregate-search-and-source-routing.md)、[新闻发现](news-discovery-design.md)、[兼容 facade ADR](../adr/0010-night-all-compatibility-facade.md)。

## 11. 流式交付、超时与 Admin 执行身份（2026-09-26）

### 当前 221 条结果应该如何理解

它是本轮已成功返回页面的合并、去重数量，不是全部平台的结果总数。19 个实时来源分别有自己的页长、上限、游标与失败状态；授权范围中的存量分类也不等于实时来源数。真实搜索范围是当前 Consumer grants 与原 Key scope snapshot 的有效交集，并继续通过每个子请求的操作、额度、服务准入检查。为空的 `platforms` 只代表这个范围的全部平台。撤销授权后续请求立即收敛，不能借旧游标绕过。

### 两种传输共享一次执行

`POST /api/v1/data/aggregate/search` 默认 JSON；显式 `Accept: text/event-stream` 开启 SSE。URL、请求体、Authorization、Idempotency-Key、分页与计费不变，不创建另一个购买身份。

| 事件 | 字段/含义 | 客户端行为 |
| --- | --- | --- |
| `search.started` | requestId、totalSources、execution | 显示本批范围和调度边界 |
| `source.started` | id、platform、label | 标记该来源正在执行 |
| `source.completed` | source 状态、items 安全投影 | 展示先到结果，按 item.id 去重 |
| `search.completed` | 完整已提交 JSON envelope，外加 replay | 以最终响应为准，启用 nextCursor |
| `search.error` | 安全错误码、requestId | 保留已显示内容和原请求参数，不自动重采 |

SSE 开始前鉴权、参数或幂等冲突继续返回正常 HTTP/JSON 错误。开始之后 HTTP 已是 200，因此只有 `search.completed` 表示父请求已提交。来源事件仅表示子请求已完成；不能先生成父游标。存量请求和已提交的回放可直接产生最终事件。

每 10 秒注释心跳；设置 `Cache-Control: no-store, no-transform` 与 `X-Accel-Buffering: no`。慢客户端写缓冲超过 1 MiB 时断开传输以限制内存；已发出的调用继续正常结算。下游应使用支持 POST/Authorization 的 fetch 流读取，而非不能设置这些信息的原生 EventSource。未实现事件日志和 Last-Event-ID 续传；手动重试必须用原 body/Key/Idempotency-Key，进行中为 409，提交后只回放最终结果。

### 调度预算与连接器超时分开

源码默认值：Night-All 60 秒，TikHub 30 秒，JustOne 120 秒，可被对应部署配置覆盖。这些是连接器调用边界；多次详情补充、出口探测或供应商排队可能使一个逻辑来源持续更久。它们不是整轮总时限。

本次新增聚合调度预算 120 秒、并发 3。预算到达后不再启动队列中的新来源，返回 `not_started / aggregate_dispatch_deadline`；已发出的请求按其既有超时收尾并留存账务证据，不用 Promise.race 抛弃结算。未开始的来源不收费，也不会在下一批偷偷补查。重新采集由用户显式开始新查询。

`execution.hardResponseDeadlineMs=null` 明示目前没有硬响应截止。若今后要求“无论发生什么 30 秒必须结束连接”，应增加持久化搜索任务及查询状态端点：到时返回已完成部分与 jobId，后台工作受持久租约管理，迟到结果可读，断线恢复以事件日志/已提交快照为准。不能简单取消 HTTP 并当作付费调用未发生。本次没有后台任务、全局自动重试或供应商故障切换。

### 独立 Admin Key

先部署 `111_admin_execution_identity.sql`；迁移只创建身份绑定表，不创建 Key、不派发上游。Admin Token 会话在身份下拉明确选择“Admin · 独立执行身份”时，调用 `POST /internal/v1/admin/admin-execution-credential`，事务性创建一个独立租户、调用者与 Live Key，保存创建者和 scope snapshot。跨实例通过 PostgreSQL advisory lock 防止重复创建。

- Key 的初始有效期为 180 天，使用创建时已实现的平台、分类与产品能力快照；每项 Key 额度为 1000 次/小时，页长上限 100。既有服务、套餐与供应商配额仍可能更低。
- 新 Consumer 使用已有默认套餐分配流程；新的租户计费配置沿用现行默认值。它不会修改 LCY-delta、既有消费价格、余额、授权和历史。
- 浏览器只收到一小时签名引用，不收到或持久化长期原始 Key。该 Key 不是管理凭证，不能凭自身读取管理证据；所有公有调用重新验证 Key / Consumer / Tenant 状态。
- 刷新只签发临时引用，不恢复被撤销的 grant、不扩入未来平台、不替换撤销/过期 Key。停用与权限调整继续在既有 Key / 调用者管理中进行。
- 供应商凭据、已审价合同、运行开关、预算、限速及不确定结果规则照常适用。Admin 不等于免费，也不等于上游一定可用。
- Launcher 会话（包括平台管理员）和 Public Key 均不能创建此身份；仅 Hub Admin Token 可以。

### 管理证据与信息边界

`GET /internal/v1/admin/aggregate/requests/{requestId}` 按已提交父响应关联子请求；在相同 Consumer / Key 内读取实际调用证据。接口仅接受 Admin Token，不在 Public OpenAPI 或租户契约中开放。

展示实际 provider call 的供应商、操作、端点、结果、计费状态、原币种采购金额、耗时及客户结算。币种不混加，缺失成本显示未知；Night-All 连接器只能证明发生历史服务转发，不能猜测其内部供应商或价格。证据服务暂不可用不会破坏原搜索响应，界面保留“未记录/暂不可读”的区别。

目录关系来自稳定 `sourceKey` 的实现清单；用于解释本次来源对应哪些目录条目。它是当前映射，不是历史路由快照，也不是线上健康。搜索 DTO、普通 Key 与租户文档不增加上游身份、采购价格或内部端点。

### 验收边界

采用本地模拟上游和真实 Hub HTTP/账务流程验证：快慢来源流式先后、JSON/SSE 同身份重放、截止后不派发、权限拒绝、UTF-8 分块、Admin 单例与撤销、目录映射及采购/客户币种分离。桌面/手机浏览器验证了调试优先、流式结果先到、文档往返、身份切换与页签切换不新增采集。没有调用真实付费上游或部署到生产；本机没有 PostgreSQL 集成环境，生产上线须先执行迁移并核对数据库路径。
