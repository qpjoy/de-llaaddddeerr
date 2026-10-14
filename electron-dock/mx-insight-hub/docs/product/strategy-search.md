# 策略搜索

更新：2026-10-15。本文件描述本轮源码和已保存事故证据；不表示已经发布或所有平台已恢复。

## 产品边界

“策略搜索”位于数据服务，按业务接口和目标平台展示路由。它组织三类已有能力：

- **内容搜索**：按关键词查找帖子、文章或视频。
- **账号内容**：按已知账号获取其内容，即 `crawl`。
- **账号资料**：按已知账号获取资料，即 `user-info`，不是关键词搜索账号。

管理端可以查看各平台的迁移范围；本轮仅开放 Instagram 内容搜索与既有 Facebook 内容搜索策略编辑。其他平台和操作只展示已核实的路由，不因为出现在目录中就支持切换供应商。客户指南位于 `/docs/strategy-search`，只展示当前有效 scope 对应的平台与操作，不展示供应商品牌、采购价格、凭据或内部配置。

查看目录、保存策略、发布本轮代码均不自动新增业务授权、Key scope、套餐或价格。调用继续遵循原平台、操作授权和现有计费规则。MX-H2I 用户登录、联网、Launcher 服务不在本轮修改范围。

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
| Hub 专用社交接口 | `POST /api/v1/data/social/search`、`crawl`、`user-info` | 当前仅 Twitter，有自己的严格字段与响应合同，不能泛化给其他平台 |

普通标准搜索的核心字段为 `platform`、`query`、`pageSize`；兼容搜索保留 `keyword/query`、`count/pageSize/limit` 等已声明字段。不能只换 URL 而保留另一接口的请求体、分页逻辑或响应解析。业务调用不接受任意 provider、endpoint、凭据或费用放大控制字段；供应商选择由管理策略决定。

S=内容搜索，C=账号内容，U=账号资料。下表是 Hub 当前源码可证明的范围，不是线上健康保证；“—”表示没有在对应 Hub 兼容合同中声明。

| 平台 | S：供应商与执行位置 | C：供应商与执行位置 | U：供应商与执行位置 |
| --- | --- | --- | --- |
| Twitter / X | 标准/social 由 Hub 直连 RapidAPI；raw 部分形状仍经 Night-All，默认 RapidAPI | social 直连 RapidAPI；兼容入口经 Night-All → RapidAPI | 同 C |
| Facebook | Hub → RapidAPI / JustOne，沿用月额度策略 | Night-All → JustOne | Night-All → JustOne |
| Instagram | Hub → JustOne / TikHub，本轮可配置 | Night-All → TikHub | Night-All → TikHub |
| 微博 | 合规单关键词形状 Hub → TikHub；其他形状经 Night-All | Night-All → TikHub | Night-All → TikHub |
| 小红书 | 受支持形状且直连门禁允许时 Hub → TikHub；其他形状经 Night-All | 同左，限单账号 posts 等形状 | 同左，限单账号等形状 |
| 抖音 | Night-All → TikHub | Night-All → TikHub | Night-All → TikHub |
| TikTok | Night-All → TikHub | Night-All → TikHub | — |
| Reddit | Night-All → TikHub | Night-All → TikHub | — |
| YouTube | Night-All → TikHub | Night-All → TikHub | — |
| LinkedIn | — | Night-All → TikHub | Night-All → TikHub |
| 知乎 | Night-All → TikHub | — | Night-All → TikHub |
| 哔哩哔哩 | Night-All → TikHub | — | — |
| 快手 | Night-All → TikHub | — | — |
| 微信搜索 / 微信公众号 | Hub → TikHub，独立微信搜索合同 | — | — |
| Telegram | Hub 本地数据检索 | — | — |

具体边界：

- Twitter raw 首次请求只迁移单关键词、每页不超过 50 条且无不兼容复杂参数等形状；标准 `/data/search` 已有独立迁移分支。Twitter 的供应商规则保持 RapidAPI，其他平台不能借此走 RapidAPI。
- 微博首个标准请求 `pageSize >= 20` 或已有 Hub 游标才进入已迁移分支；raw 还需符合单关键词等约束。
- 小红书搜索直连要求单关键词、每页 20 条及相容参数；crawl 要求单一标识、posts、每页 20 条等；user-info 要求单一受支持标识。首次直连还受操作状态和正式 Key 条件约束，已有 Hub 游标保持原链路。原操作 capability 仍必须满足。
- 微信 `/api/v1/search/raw` 与 `/api/v1/data/search` 映射到 `/api/v1/data/wechat/search/search`，采用新合同；**`/api/v1/night-all/search/raw` 的微信请求返回 410**，不回退 Night-All。因此上述本机 po-infra 的通用旧适配器若实际用于微信，会碰到这个边界；需在对应客户端项目单独迁移，不能在 Hub 悄悄恢复旧路径。

路由声明见 `server/contracts/night-all-legacy.mjs`、`raw-search.mjs`、`hub-data-search.mjs`、`hub-social.mjs`、`wechat-search-alias.mjs`；条件分支由 `server/hub-service.mjs` 执行。管理目录在 `server/data/strategy-search-catalog.mjs`，不把声明的支持范围当成供应商实时可用性。

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
