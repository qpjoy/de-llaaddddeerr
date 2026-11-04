# MX Insight Hub 数据源、接口与供应商总目录

核对日期：**2026-10-30，Asia/Shanghai**。依据当前工作树的 HTTP 分发、运行合同、适配器、初始化数据与迁移说明。本文用于内部研发、交付和统计；供应商及内部源表信息不应原样放进租户公开文档。

本次未连接生产数据库、未读取密钥、未调用采集/付费接口、未部署。**“已实现”表示代码具备执行合同，不代表生产已启用、当前可用或已经有数据。** 线上数量、健康度和最新入库时间必须另取运行证据。

## 1. 从哪里查

| 需要了解 | 入口 |
| --- | --- |
| 产品支持什么平台、走哪个供应商、是否仍依赖 Night-All | 本文第 3–7 节 |
| 每条接口的方法、Hub 路径、上游路径、授权操作 | [接口逐项明细](interfaces.md) |
| 所有治理目录名称、分类、初始化状态、固定叶表 | [数据源治理目录](source-directory.md) |
| 做筛选、分组、统计、与后续版本比较 | [机器可读清单 inventory.json](inventory.json) |
| 参数、响应、权限与调用示例 | [公共 API 合同](../contracts/public-api-v1.md)、[curl 指南](../public-api-curl.md)，以及运行服务的 `/docs`、`/openapi.json` |
| 当前 Key 可用能力 | `GET /api/v1/data/capabilities`；Web Search 另有 `/api/v1/data/web-search/capabilities` |

## 2. 当前源码统计

以下是不同口径，不能全部相加成为“数据源总数”或“可用接口数”。

| 对象 | 数量 | 口径与限制 |
| --- | ---: | --- |
| 治理目录初始化条目 | 223 | 原始清单 215 + 供应商补充 8；含待接入/规划项，不是 223 个可运行连接器 |
| Native 固定合同 | 1,083 | TikHub 803、JustOne 280；含微信专项路径、电商授权别名和不同版本 |
| Native 原始平台代码 | 44 | 保留 `xiaohongshu_ec`/`xiaohongshu-ec` 等不同标识，不能当作 44 个独立商业平台 |
| Native 去重上游方法/路径 | 1,058 | 按 `provider + method + path` 去重；不同 Hub 授权别名可指向同一上游 |
| 企业 apiId | 274 | 启信宝；260 个有公开价格合同，14 个议价合同被代码禁止派发 |
| 公开 HTTP 方法/路径条目 | 1,467 | 1,083 native + 274 企业 + 110 业务及配套入口；展开旧 operation 模板，补入 2 条 IP batch 别名，同方法同路径去重；不含 Admin/SSO/支付管理 API |
| v2 标准内容搜索平台 | 12 | 不含微信专项响应、Telegram 存量检索或 LinkedIn 账号采集 |
| 新版账号内容/资料平台 | 各 13 | 同一批平台的两个业务合同，不应相加为 26 个平台 |
| 关键词搜索账号平台 | 4 | 小红书、抖音、微博、快手；与按已知账号获取资料不同 |
| 统一电商商品搜索平台 | 6 | 淘宝、天猫、京东、小红书电商、抖音电商、闲鱼；8 个平台×供应商映射 |
| 电商专用资源 | 4 条路径 / 11 个版本 | 淘宝/天猫详情、评价、问答、店铺商品 |
| Web Search 渠道 | 8 | 百度、Exa、Tavily、Serper、You.com、SearchAPI、Firecrawl、SerpApi |
| 固定初始化清洗输入 | 19 | TG PostgreSQL 2 + TG SQLite API 2 + 全国舆情 1 + 手机电商 1 + saved_records 13；动态发现、自定义文件和数据库输入不计入 |
| Night-All-A 允许派发操作 | 18 | 16 个上游读取 + 2 个上游写操作；仅 Admin，非 18 个公共数据产品 |

明细中的 `runtimeStatus=not_checked` 表示未观测；不以默认 disabled、历史故障或旧文档中的 active 代替当前状态。没有在本次统计全库行数、接口调用量、有效 Key 数或生产可用率。

## 3. 上游供应商与自建来源

| 来源 | 已实现用途 | 接入方式与代码证据 |
| --- | --- | --- |
| TikHub | 多平台内容搜索、账号资料/内容、小红书详情/评论/分析、YouTube 评论、微信专项、native 社交及电商合同 | Hub 直连；固定 origin `api.tikhub.io` / `api.tikhub.dev`，见 [native 合同](../../server/contracts/native-forwarding.mjs)与[内容搜索 recipe](../../server/contracts/tikhub-content-search.mjs) |
| JustOne | 六平台商品搜索、淘宝资源、小红书/抖音关键词搜账号、小红书热搜、Facebook 账号、新搜索策略中的 Facebook/Instagram、native 合同 | Hub 直连 `api.justoneapi.com`；见 [商品](../../server/contracts/justone.mjs)、[账号](../../server/contracts/hub-social-compat.mjs) |
| RapidAPI | Twitter AIO；Facebook Scraper；淘宝/天猫商品搜索候选渠道 | `twitter-aio.p.rapidapi.com`、`facebook-scraper3.p.rapidapi.com`、`taobao-tmall-all-api1.p.rapidapi.com`；淘宝渠道为同一 JustOne 后端的另一个采购入口，不是独立数据生产源 |
| 启信慧眼/启信宝 Qixin | 工商、司法、经营、知识产权、证券、关联关系、集团等 18 个分类 / 274 个合同 | Hub → `api.qixin.com`；[企业合同](../../server/contracts/enterprise.mjs)、[完整分类及接口明细](interfaces.md) |
| ipsearch / IP 数据云 | legacy-v1 IPv4 风险画像 | Hub → `POST https://api.ipdatacloud.com/v2/query`；[适配器](../../server/adapters/ipsearch.mjs) |
| 百度 IP 风险 | baidu-v2 IP 风险画像 | Hub → `cloud.baidu.com/api/afd-ip-threat/act/v1/ipage` 的 `base/{ip}` 与 `overall/{ip}`；[适配器](../../server/adapters/baidu-ip-risk.mjs)，与百度 Web Search 是不同服务 |
| 八家 Web Search | 搜索结果链接/摘要；百度另支持图片和视频 | Hub 直接 HTTP 适配器；[渠道地址明细](interfaces.md)、[接入说明](../integrations/web-search.md) |
| Night-All（历史服务） | 部分旧 raw/crawl/user-info、历史导出回填、微信搜狗自建引擎 | 配置 `NIGHT_ALL_BASE_URL` 或自建引擎独立连接；不是所有带 night-all 名字的数据集都需要实时请求它 |
| Night-All-A（独立采集平台） | 任务、计划、运行、日志、产物与记录管理；saved_records 分类数据清洗 | [18 项 Admin HTTP 派发](interfaces.md)与独立 PostgreSQL 拉取；二者分别启用、分别验收 |
| Telegram monitor PostgreSQL | 群/频道及消息 | 源表增量拉取，不在搜索时请求 Telegram；源契约与索引/writer 验证独立 |
| Telegram SQLite read API | 群/频道及消息的另一条输入 | 固定 GET `/v1/chats`、`/v1/messages?include_deleted=true`；与 monitor 保留独立 dataset/身份 |
| 手机采集器数据库 | 快手、抖音、淘宝、闲鱼等手机采集结果 | Hub 拉取 `mb_collected_items`；公开读取不自动驱动手机采集器 |
| Android 小红书 PoC 外设 | 管理员搜索、下一页、笔记详情 | 独立 Hub 外设队列调用固定 `/api/state`、`/api/search`、`/api/next`、`/api/note`；已实现可选适配，不自动 Canonical 入库，不是公共数据产品 |
| 文件及自定义 PostgreSQL | 运营上传、共享目录、归档与其他经过映射的源表 | Hub 负责注册、映射、清洗和入库；文件路径、数据库密码不进入本清单 |

HanLP、Elasticsearch、Embedding/Chat Sequence 是处理/检索依赖，不是内容供应商。现有架构中 mx-embedding 支撑向量化/RAG；每次实际模型路由由当前 Sequence 配置确定。mx-common 是 Hub 基础设施依赖；mx-pay 是独立支付中心；Launcher SSO 是身份依赖；mx-rig 是测试中心，均不计为内容数据源。

## 4. 内容与账号平台矩阵

标准入口为 `POST /api/v1/data/search`；`POST /api/v2/data/search` 提供显式时间窗合同，仅支持表中标“是”的 12 个平台。时间窗、可采购页数和结果完整性以接口响应为准，不能据平台支持推断全量覆盖。

新账号入口为 `POST /api/v1/data/social/crawl`、`POST /api/v1/data/social/user-info`。这些新接口不回退 Night-All；旧 `/api/v1/search/*` 和 `/api/v1/night-all/search/*` 继续有独立兼容规则。

| 平台 | v1 内容入口 | v2 | 新账号内容/资料供应商 | 旧 raw 是否仍有 Night-All 跳转 |
| --- | --- | --- | --- | --- |
| 抖音 `douyin` | TikHub | 是 | TikHub | 已接管固定内容合同 |
| B站 `bilibili` | TikHub | 是 | TikHub | 已接管固定内容合同 |
| 快手 `kuaishou` | TikHub | 是 | TikHub | 已接管固定内容合同 |
| 知乎 `zhihu` | TikHub | 是 | TikHub | 已接管固定内容合同 |
| Reddit `reddit` | TikHub | 是 | TikHub | **有：两个 raw 入口** |
| YouTube `youtube` | TikHub | 是 | TikHub | **有：两个 raw 入口** |
| TikTok `tiktok` | TikHub | 是 | TikHub | **有：两个 raw 入口** |
| Twitter/X `twitter` | RapidAPI / TikHub 策略 | 是 | RapidAPI | **有：不符合 Hub raw 合同的复杂形状**；已迁移 raw 仍为 RapidAPI |
| 微博 `weibo` | TikHub，含小页缓冲 | 是 | TikHub | **有：复杂/未迁移 raw 形状** |
| 小红书 `xiaohongshu` | TikHub，所有有效页大小 | 是 | TikHub | **有：旧 raw 条件分支**；标准入口已无旧 gate 分流 |
| Instagram `instagram` | JustOne / TikHub 策略 | 是 | TikHub | 新 raw 由 Hub 策略处理 |
| Facebook `facebook` | RapidAPI / JustOne 策略 | 是 | JustOne | 新 raw 由 Hub 策略处理 |
| LinkedIn `linkedin` | 未纳入标准关键词内容搜索 | 否 | TikHub | 未声明 raw 支持；旧账号接口另有 Night-All 路线 |
| 微信综合 `wechat_search` | TikHub 专项合同/原生响应 | 否 | 未纳入 13 平台账号合同 | `/search/raw` 转专项；`/night-all/search/raw` 返回 410 |
| 微信公众号 `wechat_mp` | TikHub 专项文章搜索；另有独立自建引擎 | 否 | 未纳入 13 平台账号合同 | 同上；不能与自建引擎混算 |
| Telegram `telegram` | Hub 已存数据检索 | 否 | 未纳入 13 平台账号合同 | 不在旧 raw 允许列表 |

路由依据：[业务分流](../../server/hub-service.mjs)、[策略目录](../../server/data/strategy-search-catalog.mjs)、[账号 recipe](../../server/contracts/hub-social-compat.mjs)、[v2 平台集](../../server/contracts/data-search-v2.mjs)。

Twitter 标准搜索默认 RapidAPI 优先，策略可以固定/优先/暂停。受限的首请求 RapidAPI 明确 HTTP 400 可按规则转 TikHub 一次；已有分页、未知结果或不可用成功响应不能据此自动切换。Facebook 按 auto/指定供应商/暂停策略执行；Instagram 为 fixed/priority/paused。**这些是代码候选规则，当前实际选择必须看数据库策略和请求回执。** 目录中旧 `source-connections.mjs` 的 Twitter 默认文案仍存在滞后，本目录以[执行路由](../../server/data/twitter-search-routing.mjs)为准。

### 4.1 其他社交能力

| 业务 | Hub 入口 | 来源/支持范围 |
| --- | --- | --- |
| Twitter 专项内容搜索 | `POST /api/v1/data/social/search` | RapidAPI；此入口没有继承标准搜索的 TikHub 策略 |
| 关键词搜账号 | `POST /api/v1/data/social/accounts/search` | 小红书/抖音 → JustOne；微博/快手 → TikHub |
| 小红书笔记内容/标签 | `POST /api/v1/data/post`；`GET/POST /api/v1/xiaohongshu/app/get_note_info` | TikHub `app_v2/get_image_note_detail`，与用户内容采集是不同操作 |
| 小红书 AppV2 兼容接口 | `GET/POST /api/v1/xiaohongshu/app_v2/{方法}` | 固定五项：get_image_note_detail、search_notes、search_users、get_user_info、get_user_posted_notes；不是任意方法转发 |
| 小红书阅读/互动指标 | `POST /api/v1/data/xiaohongshu/notes/detail` | TikHub 蒲公英详情；别名 `/api/v1/xiaohongshu/pgy/get_note_detail` |
| 小红书评论 | `POST /api/v1/data/xiaohongshu/notes/comments` | TikHub `app_v2/get_note_comments` |
| 小红书用户笔记指标 | `POST /api/v1/data/xiaohongshu/users/notes/analytics` | TikHub `pgy/get_blogger_notes_v2`；同名平台路径别名也已实现 |
| 小红书热门笔记 | `POST /api/v1/data/xiaohongshu/hot-notes/search` | JustOne `hot-search/v1` |
| 小红书创作灵感 | `POST /api/v1/data/xiaohongshu/creator-inspirations` | TikHub `get_creator_hot_inspiration_feed` |
| YouTube 视频评论 | `POST /api/v1/data/youtube/comments` | TikHub `web_v2/get_video_comments`；一级评论，不自动展开回复 |
| YouTube 频道评论 | `POST /api/v1/data/youtube/channel-comments` | TikHub 频道解析 → 有界视频窗口 → 评论，可能产生多次采购 |
| 微信专项 | 注册表中的 `/api/v1/data/wechat/...` 固定 POST 路径 | TikHub 公众号、综合搜索、视频号；包含在 1,083 个 native 合同内，不能重复计数 |
| 微信自建引擎 | `/api/v1/data/wechat/self-hosted/jobs`、`batches`、状态/结果/取消接口 | Hub 队列 → Night-All `/api/v1/search/raw`，固定 `wechat_mp + provider=sogou`；提交与读取分开，独立能力 `wechat.selfhosted.search` |

账号内容除 posts 外还支持已固定的活动：Instagram reels/stories/tagged_posts/highlights/followers/following，抖音 likes，微博 original_posts，小红书 likes，知乎 answers，TikTok likes/reposts，LinkedIn company_posts，Reddit comments。它们不意味着任意 native 活动都可以放入统一账号合同。

更宽的平台覆盖（豆瓣、头条、西瓜、Lemon8、皮皮虾、Threads、优酷、IMDb、Pixabay、1688、Amazon、AliExpress、Shopee、星图、蒲公英等）在 [native 平台与逐项表](interfaces.md) 中列出。**只有 native 合同不等于统一搜索/账号/商品产品已适配该平台。**

## 5. 电商、企业、Web Search 与 IP

| 业务 | 平台/范围 | 接口与当前实现 |
| --- | --- | --- |
| 统一商品搜索 | 淘宝、天猫、京东、小红书电商、抖音电商、闲鱼 | `POST /api/v1/data/ecommerce/products/search`；六平台均有 JustOne 合同；淘宝/天猫另可选 RapidAPI，其他四个平台未接该备选 |
| 淘宝/天猫专用资源 | 商品详情、评价、问答、店铺商品 | 四条 `/api/v1/data/ecommerce/taobao/...` 路径；详情 v1/v3/v4/v5/v7/v9（默认 v7），评价 v3，问答 v1，店铺 v1/v2/v4（默认 v4） |
| 电商 native 补充 | 快手电商、小红书电商、TikTok Shop 等 | TikHub 新电商授权别名：快手 2、小红书 5、TikTok Shop 12；与既有 social native 合同可能共享物理上游，不能重复算独立数据源 |
| 暂无统一商品搜索 | 拼多多、快手电商、TikTok Shop、Amazon 等 | 榜单/native/目录存在不补齐统一商品搜索；TikHub 小红书商品接口也尚不是统一商品搜索的备选适配器 |
| 企业查询 | 274 个 apiId | `POST /api/v1/data/enterprise/{apiId}/query` → 启信宝；完整业务响应/观察数据，不等于已经归并为统一企业实体库 |
| Web Search | 百度、Exa、Tavily、Serper、You.com、SearchAPI、Firecrawl、SerpApi | `POST /api/v1/data/web-search/search`；另有百度形状兼容入口和 capabilities；百度 web/image/video，其余当前为 web |
| IP 风险旧版 | legacy-v1 | `POST /api/v1/data/ip/risk` 及 `/batch` → IP 数据云 |
| IP 多渠道 | baidu-v2、legacy-v1 | `POST /api/v1/data/ip/risk/v2` 及 `/v2/batch`；显式渠道对照，不以失败自动重试另一家 |
| IP 订阅产品 | 当前产品交付策略选择的通道 | `POST /api/v1/data/ip/risk/service` 及 `/service/batch`；订阅/历史 GET 不发供应商查询 |

Web Search 当前交付搜索摘要/链接，不自动抓全文或生成答案；不把 Night-All 中 Bing RSS、DuckDuckGo、SearXNG、Defuddle 等后续迁移项算作 Hub 已接渠道。IP 画像保存调用方范围内的快照，不隐式公开到共享内容库。

电商路由新增能力见 [2026-10-29 供应商路由说明](../operations/ecommerce-supplier-routing-2026-10-29.md)。该文记录的是当时本地实现和待开通条件；本次未重新验证余额、订阅或部署，不能据历史 JustOne 余额不足判断今天仍不可用。

## 6. 已存数据与清洗输入

这些是内容进入 Hub 的途径。Public 存量读取使用 Hub PostgreSQL/Elasticsearch，不因数据血缘来自 Night-All 就实时回源。

| 输入/来源标识 | 源表或读取方式 | Hub dataset / 对外使用 | 实现及状态边界 |
| --- | --- | --- | --- |
| `telegram-monitor-chats` | PostgreSQL `public.tg_monitor_chats` | `telegram.monitor.chats.v1` | 已实现增量；需连接、writer/索引验证和启用 |
| `telegram-monitor-messages` | PostgreSQL `public.tg_monitor_messages` | `telegram.monitor.messages.v1` | 同上，保留来源、聊天和消息身份 |
| `telegram-sqlite-api-chats` | GET `/v1/chats` | `telegram.sqlite.chats.v1` | 固定只读 HTTP；与 monitor 不合并来源身份 |
| `telegram-sqlite-api-messages` | GET `/v1/messages?include_deleted=true` | `telegram.sqlite.messages.v1` | 已实现初次/手动对齐、增量重叠轮询与前一日窗口；不自动重复全历史扫描 |
| `province-opinion-results` | PostgreSQL `public.monitor_strategy_results` | `public-opinion.province.v1` / `public_opinion` | 全国/34 省级目录、发布和质量状态；源库 writer 合同及分析启用独立，源行不等于已发布文章 |
| `mobile-commerce-collected-items` | PostgreSQL `public.mb_collected_items` | `mobile-commerce.collected-items.v1` / `mobile_commerce` | 手机采集快手/抖音/淘宝/闲鱼等记录；捕获行身份不等于全平台统一商品身份 |
| `night-all-saved-records-{source_type}` | PostgreSQL `public.saved_records_{source_type}` 的 LIST 叶表 | `data-center.saved-records.{source_type}.v1` / `data_center_saved_records_{source_type}` | 初始化 13 类，后续可动态发现；任务名称为 Night-All-A 清洗；需结构、游标、writer 和映射验证 |
| Night-All 历史回填 | `GET /api/v1/data/export` | 历史规范化内容与血缘；按回填任务范围 | 已实现独立 backfill；不能由旧适配器里存在 health/capabilities 方法推断当前也在调用 |
| Twitter/Canyie 文件 | `rule-twitter-canyie`；CSV/JSON/JSONL 规则 | `external.twitter.canyie.v1` / twitter / post | 内置格式识别；需要具体文件注册、映射与导入，规则存在不代表已有源文件 |
| 其他文件/共享目录 | 上传或 allowlist 目录注册；CSV/TSV/JSON/JSONL/NDJSON/XLSX/XLSM/TXT/MD | 经批准映射决定 dataset/platform/objectType | 已实现；没有把 .xls 或任意远程 URL 说成支持；结构规则归档不移动原文件 |
| 其他 PostgreSQL 源表 | Admin 数据库配置与外部数据源 | 经批准映射决定 dataset/platform/objectType | 通用数据库适配器目前为 PostgreSQL；SQLite 是上面专用 HTTP，不是通用本地 SQLite/MySQL 连接器 |
| Hub 直接采购结果 | TikHub/JustOne/RapidAPI/Qixin 等成功业务交付 | 商品、社交内容/账号/评论、企业响应等合同规定的 Canonical/观察 | 完整受限上游证据与交付快照分开；native 合同不保证每条结果都已变成同构文章或商品 |

saved_records 的 13 个初始类别为：`automotive`、`finance`、`forum`、`hotspot`、`local_news`、`media`、`news`、`other`、`recruitment`、`research`、`social`、`technology`、`web`。每项 sourceKey、dataset 和 platform 见[逐项表](source-directory.md)。这些类别不是永久平台总表，某类存在也不证明某个具体新闻站已接入。

清洗证据：[TG monitor](../../server/ingest/telegram/monitor-pipeline.mjs)、[TG SQLite](../../server/ingest/telegram/sqlite-pipeline.mjs)、[全国舆情](../../server/ingest/province/source-contract.mjs)、[手机电商](../../server/ingest/mobile-commerce/source-contract.mjs)、[Night-All-A 叶表](../../server/ingest/crawler/source-contract.mjs)、[文件格式](../../server/ingest/external/parsers.mjs)、[历史回填](../../server/ingest/backfill.mjs)。

### 6.1 库存与派生产品接口

| 产品 | 已实现入口 | 是否触发新采集/模型调用 |
| --- | --- | --- |
| 统一存量搜索 | `POST /api/v1/data/stored/search`、`/data/canonical/search` | 不请求采集供应商；检索可有分词服务依赖 |
| 聚合搜索 | `/api/v1/data/aggregate/sources`、`/preview`、`/search` | sources/preview 只读；search 的 refresh 子请求可采购，stored 模式读库存；不能给整组标成“全免费/全离线” |
| Telegram | chats、messages、search、entities/search；Canonical context/timeline | 已存数据；timeline 是消息流前后阅读，不是采集增量订阅 |
| Telegram 语义搜索 | `POST /api/v1/data/telegram/semantic-search` | 已存向量 + 配置的 Embedding 检索链；不实时抓 Telegram |
| 新闻发现 | sources、source-options、search、facets、articles/{id} | 读取已入库、满足发布/可见规则的新闻；不补抓正文 |
| 全国舆情 | regions、regions/{region}/items、provinces/{province}/items、province-coverage、items/{id}、funnel、records、records/{id} | 读 Hub 发布数据/安全诊断；all_ingested 需要单独能力，不代表所有原始行都公开 |
| 商品历史/手机电商 | `/api/v1/data/ecommerce/products/items`、`/data/mobile-commerce/items` | 库存读取；历史商品受调用方范围控制 |
| 虚拟超市 | metadata、products、products/{id}、search | 基于手机捕获的独立上架投影，权限为 `virtual_supermarket`，不是新采集器 |
| 治理目录 | source-catalog、metadata、services、{id}、{id}/items；platforms/saved-records/categories | 目录与分类可见不授予对应业务调用权 |
| 专题洞察 | GET/POST `/api/v1/data/topic-reports`，GET `/{id}` | GET 只读；POST 异步创建报告可执行配置的分析流程，不能与 GET 混算 |
| Admin 高级搜索/回答 | `POST /internal/v1/admin/data-browser/advanced/search`、`/answer` | PG/ES + 配置的 Embedding/Chat Sequence；显式回答可能调用模型 |
| 分词 | `POST /api/v1/tools/tokenize` | HanLP；允许的本地 jieba/bigram 降级按具体合同报告，不是内容采购 |
| 图片媒体 relay | `/api/v1/data/posts/media`、`/data/ecommerce/products/media` | 可能请求已留存 URL 的原图 CDN；不是“纯本地”，也不代表 mx-static 已持久化接管 |

表中缩写路径的完整前缀、方法与逐项名称均在[接口明细](interfaces.md)。mx-static 尚未上线、mx-ocr 尚未集成业务工具，按本次用户给定现状不计入已完成的 Hub 内容接入链路。小米应用商店 `market-195` 的 manifest 明确为 candidate / ingestion=not_connected，也不计作已运行来源，见 [manifest](../../integrations/market-195/manifest.json)。

### 6.2 手机外设的独立 Admin 接口

前缀为 `/internal/v1/admin/peripherals`，仅 Admin Token 可用，不包含在公开接口 1,467 条统计中。当前固定适配器为 `xhs-poc.v1`；已实现调度与证据保存，尚无本次线上手机验收，也未接公共授权、计费或 Canonical 入库。

| 方法/相对路径 | 用途/上游行为 |
| --- | --- |
| GET `/` | 设备目录与调度状态，只读 Hub |
| POST `/` | 注册设备，默认暂停 |
| GET `/{id}` | 配置、任务摘要与事件，只读 Hub |
| POST `/{id}/probe` | 显式读取手机 `/api/state` |
| POST `/{id}/control` | 配置、启停、关闭会话、取消排队、人工恢复 |
| POST `/{id}/jobs` | 排队执行 search/next/note，对应手机 `/api/search`、`/api/next`、`/api/note` |
| GET `/{id}/jobs/{jobId}` | 保存的任务结果和原始证据，不重复调用手机 |

参见[外设路由代码](../../server/peripherals/routes.mjs)与[手机外设接入说明](../operations/peripheral-scheduler.md)。它与手机电商数据库拉取是两条独立链路；也不应与 mx-device、mx-rig 的设备管理/测试能力混算。

## 7. Night-All 迁移仍剩哪些依赖

| 依赖 | 当前边界 | 迁移/统计时如何处理 |
| --- | --- | --- |
| 标准 v1/v2 内容搜索 | 已支持的新请求走 Hub；微信 v1 为专项，TG 为库存 | 不再用 10 月 16 日“TikTok 标准搜索仍经 Night-All”的结论 |
| 旧 raw | Reddit/YouTube/TikTok，以及 Twitter/微博/小红书部分兼容形状 | 按平台 + 路径 + 请求形状统计，不能只看路径里有没有 night-all |
| 旧 crawl | 10 平台允许列表；小红书有条件直连 | 新 13 平台 `/data/social/crawl` 已可用于逐步替换；不能据此删除旧入口 |
| 旧 user-info | 8 平台允许列表；小红书有条件直连 | 新 13 平台 `/data/social/user-info` 已实现；旧页游标/幂等结果仍有兼容边界 |
| 微信自建搜狗引擎 | 独立调用 Night-All raw，Hub 管理排队和结果 | 不因旧公开微信 raw 410 就误判自建引擎无依赖 |
| 历史导出回填 | Night-All export API | 独立数据迁移流程 |
| 全国舆情/其他源库 | 源 PostgreSQL | 属于数据写入者和同步依赖，不是在线搜索 API 转发 |
| Night-All-A | 独立 HTTP 采集控制 + saved_records 数据库 | 与历史 Night-All 分开统计；不能因键名沿用 night-all 把二者合并 |

旧 crawl 平台：抖音、Facebook、Instagram、LinkedIn、Reddit、TikTok、Twitter、微博、小红书、YouTube。旧 user-info 平台：抖音、Facebook、Instagram、LinkedIn、Twitter、微博、小红书、知乎。允许列表不表示所有请求都发出采购，也不表示下游已切到新接口。

保留 [10 月 16 日历史审计](../operations/hub-upstream-inventory-2026-10-16.md)与[逐项旧快照](../operations/hub-upstream-registry-2026-10-16.md)，不覆写历史证据。本清单更新纳入 10 月 17 日搜索/评论迁移、Twitter 搜索策略、微信自建引擎和 10 月 29 日电商新合同。

## 8. 怎样补线上统计与持续维护

线上清单应按以下对象分别取证，且记录环境、Public/worker 代码版本和观测时间：

| 需要确认 | 只读依据 | 不可替代的事实 |
| --- | --- | --- |
| 当前治理目录 | Admin source-catalog 列表/metadata/related-data，按分页读全 | 初始化 223 不包含后续新增、归档、重命名或覆盖状态变更 |
| 已注册物理输入 | `catalog.external_sources` 与 pipeline 配置/进度 | 注册、启用、同步中、失败、最后成功、检查点分别统计；不要导出 connection/凭据 |
| 当前供应商和操作就绪 | Admin external-platforms、逐 operation policy、strategy-search | 合同、凭据、价格、预算、授权和健康分别记录，缺任一项不能宣称可调用 |
| 真正调用量 | usage/request + provider_calls/connector_calls + 交付记录 | HTTP 请求、逻辑计费、实际采购次数、缓存/缓冲/重放不同；一请求可多次采购 |
| 数据量及新鲜度 | 数据浏览统计、dataset/current revision、入库/投影/向量状态 | 原始采集、canonical 当前记录、ES 文档、向量覆盖不能混加 |

本次仅完成源码清单，未取得以上生产快照。近期历史故障与测试结果只在相应运维文档成立，不自动推定今天的可用率。

生成附表（在 Hub 目录，Node 22 + 已安装项目依赖）：

```bash
node scripts/generate-data-inventory.mjs
node scripts/generate-data-inventory.mjs --check
```

脚本只读取固定源码合同并写本目录的 `interfaces.md`、`source-directory.md`、`inventory.json`，不启动服务器、不加载部署凭据、不调用供应商。`--check` 只比较文件；关键证据文件的 SHA-256 保存在 JSON 中。新增业务、平台或路由后，应同时维护本总览的业务解释和统计日期，再重新生成。`inventory.json` 各数组保留明确口径，不能把重复出现在业务、native、资源版本表的接口相加。

这次没有修改业务运行代码、路由配置、授权、价格、数据库、Launcher 或 MX-H2I；现有登录、SSO 与用户联网链路不受本次文档整理影响。
