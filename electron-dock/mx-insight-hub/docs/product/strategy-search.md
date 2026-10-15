# 策略搜索

更新：2026-10-15。本文件描述本轮源码和已保存事故证据；不表示已经发布或所有平台已恢复。

## 产品边界

“策略搜索”位于数据服务，按业务接口和目标平台展示路由。它组织三类已有能力：

- **内容搜索**：按关键词查找帖子、文章或视频。
- **账号内容**：按已知账号获取其内容，即 `crawl`。
- **账号资料**：按已知账号获取资料，即 `user-info`，不是关键词搜索账号。

管理端可以查看各平台的迁移范围；本轮仅开放 Instagram 内容搜索与既有 Facebook 内容搜索策略编辑。其他平台和操作只展示已核实的路由，不因为出现在目录中就支持切换供应商。客户指南位于 `/docs/strategy-search`，只展示当前有效 scope 对应的平台与操作，不展示供应商品牌、采购价格、凭据或内部配置。

查看目录、保存策略、发布本轮代码均不自动新增业务授权、Key scope、套餐或价格。调用继续遵循原平台、操作授权和现有计费规则。MX-H2I 用户登录、联网、Launcher 服务不在本轮修改范围。

## 产品工作台（2026-10-15）

页面统一为接口调试、产品展示、接入指南、管理。调试器读取当前身份可见的 OpenAPI 固定接口，包含 `/data/social/crawl` 和 `/data/social/user-info`。产品展示可选择内容搜索、账号内容、账号资料：内容搜索调用 `/api/v1/data/search`，账号查询调用相应 social 入口。展示完整正文、作者、互动、图片、账号资料及来源链接，保留缺失值与零的区别。微信按既有专项响应呈现，不把分类导航当作内容；其余微信与 TikTok 系列接口继续保留，详见 [统一搜索兼容说明](../integrations/unified-strategy-search.md)。

只有 Admin Token 平台管理会话看到管理标签；原迁移状态、Instagram/Facebook 策略与每日调用统计都在此处。旧 `view=routing/interfaces` 链接仍映射到管理/接入指南。页面内状态按原 Key 身份隔离，临时凭据刷新、标签切换和路由往返保留请求标识；调试与展示共享进行中/未知结果锁，核对只读，不自动重发。内容搜索展示的新查询使用 `stable`，账号展示沿用账号接口的原请求幂等规则；下一页保留原请求合同与游标，明确新建相同查询才产生新的请求标识。

完整响应已改为保留全文、自动换行并在限定高度内滚动；长标识不再撑开页面。Facebook `photo.php` 落地页显示原始链接，明确的视频封面与真实混合图片在新标准投影中分开；旧 raw 与 canonical 入库投影不重写。Bilibili 的原生指标修复已移入 Hub 关键词搜索投影，新标准保留缺失 null 与真实 0，兼容 raw 默认值保留。Facebook 标准搜索已加入自动补页；本轮取消默认每请求 3 次的补页调用上限，保留独立的遍历与资源边界。完整字段、接口文档与旧游标兼容边界见 [本轮核查](../operations/strategy-search-contract-audit-2026-10-15.md) 及 [本轮补页调整](../operations/youtube-search-fill-2026-10-15.md)。

## 生产证据与本机调用链必须分开

已归档的 Instagram 事故请求 `ddecf6fe-c6e9-4632-9fb6-67014bdf261a` 原入口是 **`POST /api/v1/data/search`**，不是从路径名猜测出的 raw 请求。该请求由 Hub 调用 TikHub Instagram V3 general_search，外部 HTTP/业务码 400，Hub committed 502，客户结算 CNY 0.01。唯一一次已授权同参数复测 `9c43a396-57bc-433d-9eba-1f30c3762631` 仍返回 400。没有成功数据可用来证明恢复；通用错误文字不能定位为某个确定参数缺陷。详见 [事故记录](../operations/instagram-search-rejection-2026-10-14.md)。该次付费验证授权已经消耗，不随本轮发布再次执行。

本机查验的另一条调用链是：

```text
luopan/po-frontend 新建策略
  POST /api/strategy/add?is_adjust=...
po-backend-java（账号已启用 smart strategy）
  POST /api/data/risk-monitor-plans/
po-infra 采集任务
  /api/v1/search/raw | crawl | user-info
po-infra Hub 迁移适配器（默认启用）
  POST Hub /api/v1/night-all/search/{operation}
Hub
  按平台和请求形状直连，或继续转交 Night-All
```

本机 po-infra HEAD 为 `5f1d29a`（2026-09-24），已查验的 `llm/data_query.py`、`data_hub/tasks.py`、`data_hub/data_query_collector.py` 没有未提交改动。前端 HEAD 为 `a4fc3b9`（2026-10-13），Java 后端 HEAD 为 `e86be9c0`（2026-09-30）。这不是生产版本清单：不能用这些 checkout 否认已保存的线上 `/data/search` 请求，也不能据此宣称线上所有客户端都已改用 `/data/search`。

实现位置：前端 `StrategyConfig.vue` 构造并提交策略；Java `StrategyConfigServiceImpl.sendDeltaSmartStrategyPlan` 创建 Delta 计划；po-infra `data_hub/tasks.py::_run_data_query_collection` 选择 raw/crawl/user-info，`llm/data_query.py::hub_data_query_route` 与 `hub_legacy_search_data` 选择 Hub 兼容入口。未启用 smart strategy 的账号仍有旧长期任务分支；关闭 Hub legacy migration 或显式指定旧 base URL 也有旧客户端路径。这些客户端没有在本轮修改。

Telegram 在本机 po-infra 中单独使用 Hub `/api/v1/data/canonical/search`，检索已采集数据。

## 接口与响应合同

| 用途 | Hub 路径 | 响应与范围 |
| --- | --- | --- |
| 标准内容搜索 | `POST /api/v1/data/search` | 普通内容平台返回 `data.items`、`data.pageInfo`；微信是独立原生合同例外 |
| 兼容内容搜索 | `POST /api/v1/search/raw`、`POST /api/v1/night-all/search/raw` | 普通平台 `data.raw_data`、`data.raw_info` 是 JSON 字符串，分页在 `data.page`；微信路径例外见下文 |
| 兼容账号内容 | `POST /api/v1/search/crawl`、`POST /api/v1/night-all/search/crawl` | 账号与内容原始结构；只支持下表 C 列列出的平台 |
| 兼容账号资料 | `POST /api/v1/search/user-info`、`POST /api/v1/night-all/search/user-info` | 已知账号资料；只支持下表 U 列列出的平台 |
| Hub 账号内容 | `POST /api/v1/data/social/crawl` | Hub 账号合同；平台范围与兼容规则见下文，要求 `social.content.crawl` |
| Hub 账号资料 | `POST /api/v1/data/social/user-info` | Hub 账号合同；平台范围与兼容规则见下文，要求 `social.profile.get` |
| Hub 专用社交搜索 | `POST /api/v1/data/social/search` | 保留既有 Twitter 专用搜索；本轮没有扩展此接口，关键词接入优先使用 `/data/search` |

普通标准搜索的核心字段为 `platform`、`query`、`pageSize`；兼容搜索保留 `keyword/query`、`count/pageSize/limit` 等已声明字段。不能只换 URL 而保留另一接口的请求体、分页逻辑或响应解析。业务调用不接受任意 provider、endpoint、凭据或费用放大控制字段；供应商选择由管理策略决定。

S=内容搜索，C/U 为**旧 `/search` 与 `/night-all/search` 账号转发入口**。下表保留旧入口的范围；新 `/data/social` 账号合同见下一节，不能将其支持范围当成旧转发入口新增支持。“—”表示没有在对应旧兼容合同中声明；表格不是线上健康保证。

| 平台 | S：供应商与执行位置 | C：供应商与执行位置 | U：供应商与执行位置 |
| --- | --- | --- | --- |
| Twitter / X | 标准/social 由 Hub 直连 RapidAPI；raw 部分形状仍经 Night-All，默认 RapidAPI | 旧兼容入口经 Night-All → RapidAPI | 同 C |
| Facebook | Hub → RapidAPI / JustOne，沿用月额度策略 | Night-All → JustOne | Night-All → JustOne |
| Instagram | Hub → JustOne / TikHub，本轮可配置 | Night-All → TikHub | Night-All → TikHub |
| 微博 | 合规单关键词形状 Hub → TikHub；其他形状经 Night-All | Night-All → TikHub | Night-All → TikHub |
| 小红书 | 受支持形状且直连门禁允许时 Hub → TikHub；其他形状经 Night-All | 同左，限单账号 posts 等形状 | 同左，限单账号等形状 |
| 抖音 | Hub → TikHub 固定关键词端点 | Night-All → TikHub | Night-All → TikHub |
| TikTok | Night-All → TikHub | Night-All → TikHub | — |
| Reddit | Night-All → TikHub | Night-All → TikHub | — |
| YouTube | Night-All → TikHub | Night-All → TikHub | — |
| LinkedIn | — | Night-All → TikHub | Night-All → TikHub |
| 知乎 | Hub → TikHub 固定关键词端点 | — | Night-All → TikHub |
| 哔哩哔哩 | Hub → TikHub 固定关键词端点 | — | — |
| 快手 | Hub → TikHub 固定关键词端点 | — | — |
| 微信搜索 / 微信公众号 | Hub → TikHub，独立微信搜索合同 | — | — |
| Telegram | Hub 本地数据检索 | — | — |

具体边界：

- Twitter raw 首次请求只迁移单关键词、每页不超过 50 条且无不兼容复杂参数等形状；标准 `/data/search` 已有独立迁移分支。Twitter 的供应商规则保持 RapidAPI，其他平台不能借此走 RapidAPI。
- 微博首个标准请求 `pageSize >= 20` 或已有 Hub 游标才进入已迁移分支；raw 还需符合单关键词等约束。
- 小红书搜索直连要求单关键词、每页 20 条及相容参数；crawl 要求单一标识、posts、每页 20 条等；user-info 要求单一受支持标识。首次直连还受操作状态和正式 Key 条件约束，已有 Hub 游标保持原链路。原操作 capability 仍必须满足。
- 微信 `/api/v1/search/raw` 与 `/api/v1/data/search` 映射到 `/api/v1/data/wechat/search/search`，采用新合同；**`/api/v1/night-all/search/raw` 的微信请求返回 410**，不回退 Night-All。因此上述本机 po-infra 的通用旧适配器若实际用于微信，会碰到这个边界；需在对应客户端项目单独迁移，不能在 Hub 悄悄恢复旧路径。

路由声明见 `server/contracts/night-all-legacy.mjs`、`raw-search.mjs`、`hub-data-search.mjs`、`hub-social.mjs`、`wechat-search-alias.mjs`；条件分支由 `server/hub-service.mjs` 执行。管理目录在 `server/data/strategy-search-catalog.mjs`，不把声明的支持范围当成供应商实时可用性。

## Hub 账号接口迁移（2026-10-15）

`/data/social/crawl` 与 `/data/social/user-info` 现在由 Hub 执行账号解析、字段适配、余量交付、去重及托管分页。固定平台与活动合同、1–500 逻辑页上限、批量工作量限制、参数别名、返回字段及下游示例见 [Hub 账号内容与资料接入指南](../integrations/social-account-migration.md)。两项分别要求目标平台及 `social.content.crawl` / `social.profile.get`，不会从旧平台授权自动扩权。

旧 `/search` 与 `/night-all/search` 账号入口保持原路由，等待下游切换后再考虑退役。`/data/social/search` 仍为原 Twitter 专用搜索，关键词检索继续逐步接入 `/data/search`。本轮不执行线上付费验证、部署或 Launcher/MX-H2I 变更。

## Twitter 标准搜索自动补页（2026-10-15）

Twitter `/api/v1/data/search` 先消耗已采购完整页的余量，未达到 `pageSize` 时，沿同一 RapidAPI Bottom 游标继续采购并合并。比如上一上游页有 24 条、已交付 20 条，下一次 Hub 请求会先取剩余 4 条，再取后续页补到 20 条；新上游页未消费的内容继续保留。下游只需传回 `pageInfo.nextCursor`，无需识别供应商分页、拼接余量或自行跨页去重。

该方式参考 Night-All 统一分页服务的缓冲优先、跨页去重及有界补采；不复用其爬虫自动重试或提前截断原始页的逻辑。新游标使用服务端已交付记录链去重，完整付费页仍分别归档，各提交一次入库任务。旧 Hub 游标可以继续；没有历史交付链的旧原生游标只能从此次继续时建立去重窗口，不能反查或重写旧交付。

本轮取消默认每个 Hub 请求最多 3 次上游调用的补齐限制；每次上游页仍最多请求 50 条，整次查询最多 15 个上游页、15 个公开页，游标仍有 24 小时期限。每次组页还受原请求期限、归档字节上限、当前授权、采购预算和速率门禁约束。供应商没有后续页时自然返回不足一页；达到独立遍历或资源边界、准入受限时，返回已有内容、`partial` 和警告，并在仍可安全继续时保留下一页。未知结果仍需核对，不能为补齐而重试。因此 `pageSize` 仍是单页上限，不保证任何情况下都恰好返回该条数。

一个 Hub 请求仍按现有客户价格结算一次，每笔实际上游派发分别预留采购费用并记录原始凭证。补页不跨供应商，不自动重试已派发的失败或未知结果；未知状态保留原请求锁与归档，调用方应读取使用记录核对。raw、`/data/social/search` 与旧账号转发入口保持既有合同；新账号 social 分页见前节。此次补页没有新增数据库迁移，不修改授权、单价、历史响应或账单。

本轮补页相关回归 411 项全部通过，无失败或跳过；包含模拟 HTTP、隔离 PGlite、真实计费触发器及故障注入，类型检查通过。生产仍需按下文流程仅发布 Hub；没有执行真实付费查询或改动 MX-H2I 登录联网。

## Facebook 补页与四平台直连（2026-10-15）

Facebook 标准搜索采用余量优先、交付 ID 去重与有界补页，本轮取消默认每请求 3 次的实际派发上限。初次明确 429 后的保底派发仍遵循既有规则，真实上游限流不会被忽略。既有月额度策略只决定新查询的供应商；取得第一页或持有游标后不跨供应商补页。完整上游页逐份归档与入库，余量保留，客户请求只结算一次。raw 保持原单页边界。

Bilibili、抖音、快手、知乎新关键词搜索在 Hub 运行固定原生端点，不依赖 Night-All 运行时，也不暗中回退。标准接口保留 items/pageInfo、原平台授权与价格；两个 raw 别名保留字符串合同和原 raw 计量。本轮取消标准逻辑页默认 3 次派发上限；整个查询仍最多 15 个上游页和公开页，游标有效 24 小时，原请求期限、归档字节和准入边界继续生效。旧已保存响应先精确重放，旧 Night-All 游标的新采集要求明确重启。详情、评论附采尚未迁移，显式参数在派发前拒绝；账号内容与资料保留表中原路径。接口是否可用仍取决于现有固定操作状态、凭据与采购准入，目录登记不会自动启用操作。

Bilibili 点赞 like/stat.like、评论 review/stat.reply、收藏 favorites/stat.favorite、播放 play/stat.view 已在 Hub 投影；不把弹幕或硬币猜作评论、分享。正文、原生视频／文章标题和完整媒体 URL 保留。详细映射、边界与部署验收见 [直连迁移记录](../operations/content-search-direct-migration-2026-10-15.md)。

## YouTube 短页与缺失指标（2026-10-15）

YouTube 内容搜索目前仍通过 Night-All 执行。旧 HTTP 请求默认只获取 1 个上游页面；内部服务兜底为 3 次，并非默认 20 次。`DATA_PROVIDER_CALL_LIMIT_REACHED` 表示尚有后续结果、当前逻辑页不足 `pageSize` 时触及该补页次数预算。标准搜索关闭详情与评论附采，19 条结果不能解释为“1 次搜索加 19 次详情耗完 20 次”，也不能据此判断账户余额或供应商总配额。

本轮取消 Night-All 普通请求的默认补页次数限制；直接调用 Night-All 时显式给出的 `maxProviderCalls` 仍作为调用方预算。Hub 公共搜索合同不新增此字段。达到 `pageSize`、结果耗尽、分页没有进展或原资源／准入边界触发时仍停止，不承诺所有查询都能满页。Hub 的 15 页边界仍保留；详情、评论、账号内容与资料不因本次补页调整增加调用。

YouTube 新标准响应的 `metrics` 保留真实的 `0`，上游未提供的互动、浏览和收藏计数为 `null`，产品展示显示“未提供”。不能由缺失值推断互动为零，也不能从旧默认零恢复未保存的数值。兼容 raw 默认值、已保存响应及原幂等重放保持原样。仅发布 Hub 不能更新仍在 Night-All 执行的 YouTube 补页与原生映射；具体证据、发布范围与无重搜取 ID 方法见 [YouTube 补页记录](../operations/youtube-search-fill-2026-10-15.md)。

## 可配置策略与失败边界

Instagram 内容搜索支持：

- `fixed`：固定 JustOne 或 TikHub。
- `priority`：一个主供应商和另一个保底供应商；只能在**尚未派发第一个供应商请求**且现有门禁明确允许安全切换时，选择一次保底。已有游标、已使用保底或状态发生变化会限制该分支。
- `paused`：阻止新的派发，已经提交且仍在原重放窗口的响应保持原样。

Instagram 已派发后的 HTTP 400/其他拒绝、超时未知、成功响应不可用等，不触发自动二次采购；该“优先/保底”不是付费调用失败重试。原生 TikHub 接口、资料和评论不跟随内容搜索策略切换。

Facebook 沿用独立策略和配额证据：`auto / rapidapi / justone / paused`。auto 根据已核对的 RapidAPI 月度额度、准入与既有确认 429 规则决定是否使用 JustOne。Instagram 的 pre-dispatch 规则不能替代 Facebook 既有语义，Facebook 的规则也不能推广成任意 400/502 后自动切换。

配置保存需要当前 revision 与变更原因，采用 CAS，成功写入独立审计事件；并发旧版本保存返回冲突。配置变更不会把旧游标转换成另一供应商的 token，不重写历史交付或账单。新分页绑定原供应商、Key、查询、页大小及合同，先消耗已归档完整付费页的缓冲，再请求后续页。需要重新开始的历史游标返回 `409 search_restart_required`，由调用方明确决定新查询。

保存 requestId 与原幂等键，用只读诊断和账本确认未知状态。默认 `/data/search` 的 fresh 重放窗口仍为 120 秒：相同幂等键不是永久免付费查询，不应反复 POST 代替状态查询。分页每个新页面使用新幂等键，不能与未知上一请求的“重试”混淆。

## 迁移与发布

本地验证：整合回归 214 项通过、0 失败，包含 Instagram 双供应商固定/主备、供应商绑定游标与缓冲归档、旧响应回放、暂停、未知结果与并发派发保护、采购预留释放、Admin API、权限和产品文档。新增迁移/CAS/审计回滚及归档测试使用隔离 PGlite；4 项既有 Facebook 真实 PostgreSQL 测试因本机未提供对应数据库而跳过。另增 LinkedIn 仅账号权限的实际文档入口检查通过；类型检查与 Vite 构建通过。本机合成管理界面已验证 Instagram 保存、修订冲突提示和 Facebook 配额表单，未发供应商请求。这些结果不代替生产发布或实时数据验证。

本轮新增 `migrations/150_strategy_search_routes.sql`，创建 `control.strategy_search_routes` 和 `control.strategy_search_route_events`。仅种入 Instagram search 的 `fixed / justone` 既有默认值，Facebook 继续使用原策略表；SQL 不修改凭据、价格、授权、订单或历史消费。数据库运行缺少或损坏该策略记录时会明确失败，不临时猜选供应商。

这区别于此前“固定切换 JustOne”补丁不需要新迁移的说明：**此次可配置策略版本需要迁移 150**。正常 Hub 发布流程先执行迁移 Job，成功后再滚动相关服务；不要先启用新策略代码而跳过数据库迁移。

在服务器同步本轮完整代码，在 `electron-dock/mx-insight-hub` 目录由操作者执行：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 bash scripts/manage.sh ops internal-production deploy
```

该命令限定 Hub 发布，不同步 Launcher。检查迁移 Job 已应用 `150_strategy_search_routes.sql`，然后用 Admin 只读确认数据服务中的策略搜索目录、Instagram 默认值和已有 Facebook 配额信息。租户指南只应显示其原有权限范围。保存策略是显式管理操作；浏览、检查目录与发布不应发起业务搜索。验收本轮使用本地 mock、纯合同和隔离数据库测试，不附加生产付费探测，也不声称已验证线上成功或真实下一页。

## 每日接口请求统计（2026-10-15）

管理面通过 `GET /internal/v1/admin/strategy-search/usage?days=7` 只读查询，`days` 为 1–31，默认 7，包含今天。只接受 Admin Token；普通租户、浏览器平台管理员会话和 Public API Key 均不可读取跨客户统计，Public listener 不开放此接口。查询在 PostgreSQL READ ONLY 事务内执行，最长 10 秒，超时提示缩小日期范围。无需新增迁移，不修改历史请求或采集路由，也不发起供应商调用。

统计使用 `usage_requests.created_at` 和已保存的 `acquisition_request.path`，按 **Asia/Shanghai 自然日** 汇总业务请求，逐日补零；今日为未结束的部分日期。返回 `items` 按内容搜索、账号内容、账号资料及逻辑路径分组，各项包含 `total`、`nightAllRequests`、`daily` 和 `platforms`。`daily` 行为 `{day, requests, nightAllRequests}`；`platforms` 采用相同的逐日格式。跨平台或未标明单一平台的记录使用 `unspecified`。

每条已记录业务请求计一次，包含保留的预留、成功、释放与未知状态；幂等重放不会增加同一记录，预检失败尚未进入用量账本，不计入。已存在的 raw/crawl/user-info 双兼容别名会归一为逻辑合同，统计合并显示对应 `paths`，**不能区分旧 URL 与新 URL 的真实 HTTP 访问量**。没有保存请求路径的历史记录不计入，因此零值不能单独证明接口已无人调用。

微信的 `/api/v1/data/search`、`/api/v1/search/raw` 与专项入口共享原生业务合同，保存的路径均为 `/api/v1/data/wechat/search/search`，账本授权平台为 `social`。因此统计会集中在该专项路径及 `social` 平台，不能拆分三个实际入口的流量，也不按 `wechat_search/wechat_mp` 或其别名分别计数。这种归一不代表调用方已经迁移到专项 URL。

`nightAllRequests` 仅计存在关联 `serving.connector_calls` 证据的业务请求；同一请求有多条旧连接器证据仍只计一次。这是进入旧适配器的已记录请求证据，不是供应商付费派发次数，也不是完整迁移率。部分历史 `/data/search` 分支没有写此连接器记录；没有关联证据不能反推它由 Hub 原生执行。停用 Night-All 或特定旧 URL 前仍需结合足够时间的访问日志、客户端迁移情况和对应调用证据确认。

新增只读 `/internal/v1/admin/strategy-search/data-statistics?days=7` 将每日新增 canonical 对象、内容更新、版本和观察与接口调用数分开。该看板仅覆盖有入库链路的子集，Twitter 专用社交接口和微信原生转发当前不自动入 canonical；内存模式明确不可用。完整调用链、Night-All 自存限制、指标去重与退役条件见 [策略接口、持久化与每日入库统计](strategy-search-data-flow.md)。
