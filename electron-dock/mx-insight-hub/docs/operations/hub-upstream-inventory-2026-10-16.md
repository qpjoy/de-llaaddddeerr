# Hub 接口与 Night-All／上游调用清单（2026-10-16）

> 2026-10-17 后续实现：已补齐 YouTube 单视频/频道评论，并迁移 TikTok、微博小页及小红书标准搜索剩余分支。本文保留当时审计结论；当前变化、兼容边界和部署条件见 [迁移说明](../integrations/youtube-comments-and-standard-search-migration.md)。

本次按当前工作树的 HTTP 分发、业务路由、适配器和运行时注册表进行只读审计，同时核对本机 Night-All 源码。没有调用付费接口、修改运行配置或部署。本工作树有尚未提交的改动；下表表示当前源码的路由实现，不等同于生产镜像、数据库开关或历史请求实际走过的路线。

范围为 Hub 的数据查询、采集和相关管理／同步接口；不展开登录、SSO、支付和普通账户管理。表中的“调用上游”指需要新采集时：幂等重放、缓存命中和已采购分页缓冲可以零上游调用。

**结论：Night-All 尚未完全移除。剩余业务依赖集中在 TikTok 标准搜索、部分 raw 搜索、小红书／微博条件分支，以及旧 crawl／user-info。另有独立的 Night-All 数据回填、源数据库同步和 Night-All-A 管理调用。新版账号接口、企业、电商、全网搜索及大量 native 接口已经由 Hub 直接执行。**

完整逐项目录见 [上游接口注册表](hub-upstream-registry-2026-10-16.md)：1,065 条 native 路由（TikHub 785、JustOne 280）、274 个企业 apiId、4 个专用电商资源路由的 11 个版本映射。这些数量是注册数量，不能当作线上 active 数量，也不能相加当作独立业务能力或独立上游 URL 数量。

## 1. 搜索接口：同一平台按入口分开判断

本表的标准入口均为 `POST /api/v1/data/search`；raw 入口均为 `POST /api/v1/search/raw` 和 `POST /api/v1/night-all/search/raw`。微信的两个 raw 名称有明确例外。

| 平台 | 标准 data/search | 两条旧 raw 入口 | 仍依赖 Night-All 的条件 |
| --- | --- | --- | --- |
| 抖音 `douyin` | Hub → TikHub | Hub → TikHub | 当前已实现的新派发不经过 Night-All；已保存结果仍按原规则重放 |
| 哔哩哔哩 `bilibili` | Hub → TikHub | Hub → TikHub | 同上 |
| 快手 `kuaishou` | Hub → TikHub | Hub → TikHub | 同上 |
| 知乎 `zhihu` | Hub → TikHub | Hub → TikHub | 同上 |
| Reddit | Hub → TikHub | **Hub → Night-All `/api/v1/search/raw`** | raw 仍走旧链；标准入口已迁移，不能混为一谈 |
| YouTube | Hub → TikHub | **Hub → Night-All `/api/v1/search/raw`** | 同上 |
| TikTok | **Hub → Night-All `/api/v1/data/search`** | **Hub → Night-All `/api/v1/search/raw`** | 当前这两个搜索合同尚未由 Hub 固定 recipe 接管；native 中有 TikTok 接口不代表该业务已迁移 |
| Twitter / X | Hub → RapidAPI | 受支持形状 Hub → RapidAPI；其他形状 → Night-All raw | raw 的批量关键词、非空 `params`、评论／缓存／并发等复杂参数、每页超过 50、历史分页形状等仍走旧链 |
| 微博 | 受支持形状 Hub → TikHub；其他形状 → Night-All data/search | 受支持形状 Hub → TikHub；其他形状 → Night-All raw | 普通首请求每页不足 20、旧历史游标，以及 raw 批量／复杂参数等；有效 Hub 游标保持 Hub 路线 |
| 小红书 | 已迁移且符合形状时 Hub → TikHub；历史分支 → Night-All data/search | 已迁移且符合形状时 Hub → TikHub；历史分支 → Night-All raw | 单关键词／20 条等合同条件、Live Key、迁移 gate 决定分流；历史分页、非适配形状、测试 Key、尚未迁移的 gate 仍有旧链。已有数据库 operation 配置后，即使暂停也在 Hub 拒绝／读取存储，不因暂停倒回 Night-All |
| Instagram | Hub → TikHub 或 JustOne，按 Hub 策略 | Hub → TikHub 或 JustOne，按 Hub 策略 | 当前新派发不回退 Night-All；不支持的形状／旧游标可能明确报错或要求重启 |
| Facebook | Hub → RapidAPI 或 JustOne，按 Hub 策略 | Hub → RapidAPI 或 JustOne，按 Hub 策略 | 当前新派发不经过 Night-All；供应商选择与额度／策略有关，不是任意失败后换源 |
| 微信搜索／公众号 `wechat_search`、`wechat_mp` | Hub → TikHub 微信专项合同 | `/search/raw` → Hub TikHub；`/night-all/search/raw` **410 已退役** | 无 Night-All 失败保底；两个别名在此不等价 |
| Telegram | Hub 已收录数据 | 不属于上述 raw 支持列表 | 无实时 Night-All 采集 |

已迁移路线选定后，供应商失败、暂停、凭据缺失或未知结果不意味着自动回退 Night-All。历史成功／失败重放也不代表本次又调用了其原上游。

主要依据：[HubService](../../server/hub-service.mjs) `nightAllCompatibilitySearch/search`；[raw 分流](../../server/contracts/raw-search.mjs) L22–44；[六平台固定 recipe](../../server/contracts/tikhub-content-search.mjs) L9–26；[策略目录](../../server/data/strategy-search-catalog.mjs)；[微信退役边界](../../server/contracts/wechat-search-alias.mjs)。

## 2. 搜索在 Hub 内实际调用的上游

以下是上一表中“Hub 直连”的固定合同；供应商域名见第 8 节。

| 平台／步骤 | 供应商 | 上游方法与路径 | 触发说明 |
| --- | --- | --- | --- |
| 抖音内容搜索 | TikHub | `POST /api/v1/douyin/search/fetch_video_search_v1` | 标准与 raw 的已迁移 recipe |
| B站内容搜索 | TikHub | `GET /api/v1/bilibili/web/fetch_general_search` | 同上 |
| 快手内容搜索 | TikHub | `GET /api/v1/kuaishou/app/search_comprehensive` | 同上 |
| 知乎内容搜索 | TikHub | `GET /api/v1/zhihu/web/fetch_article_search_v3` | 同上 |
| Reddit 标准搜索 | TikHub | `GET /api/v1/reddit/app/fetch_dynamic_search` | 只迁移标准入口；raw 保留旧链 |
| YouTube 标准搜索 | TikHub | `GET /api/v1/youtube/web_v2/get_general_search_v2` | 同上 |
| Twitter 搜索 | RapidAPI Twitter AIO | `GET /search/{编码后的query}` | 标准入口和受支持 raw；分类／数量参数由对应合同映射 |
| 微博搜索 | TikHub | `GET /api/v1/weibo/web_v2/fetch_realtime_search` | 受支持的标准／raw 形状 |
| 微博全文补取 | TikHub | `GET /api/v1/weibo/web_v2/fetch_post_detail` | 需要补全文时产生额外受控调用，不能把一条 Hub 请求等同于一次上游请求 |
| 小红书搜索 | TikHub | `GET /api/v1/xiaohongshu/app_v2/search_notes` | 受支持的标准／raw 形状；详情补取另有独立调用 |
| 小红书搜索详情补取 | TikHub | `GET /api/v1/xiaohongshu/app_v2/get_image_note_detail` | preview_boundary 或 includeDetails 模式，按请求／配置选择至多 20 条；这是独立详情调用，不是 Night-All 回退 |
| Instagram 搜索 | TikHub／JustOne | `GET /api/v1/instagram/v3/general_search`／`GET /api/instagram/general-search/v1` | fixed／priority 策略与当前操作就绪性决定；后续页绑定原供应商 |
| Facebook 搜索 | RapidAPI／JustOne | `GET /search/posts`／`GET /api/facebook/search-post/v1` | auto／rapidapi／justone／paused 策略；已派发结果未知不自动换源 |
| 微信搜索 | TikHub | `POST /api/v1/wechat_search/v2/fetch_search` | Hub 专项 `/api/v1/data/wechat/search/search`；微信参数与分页专用合同，不是 Night-All 转发 |

native key 的精确物理路径和方法均已在 [逐项注册表](hub-upstream-registry-2026-10-16.md) 展开，可直接搜索 key；这样不会把供应商目录里同名但未接入业务流程的其他接口混入调用链。

## 3. 账号内容／资料：旧接口与新接口分开

| Hub HTTP 入口 | 支持平台 | 新采集上游 | Night-All 依赖 |
| --- | --- | --- | --- |
| `POST /api/v1/search/crawl`；`POST /api/v1/night-all/search/crawl` | 抖音、Facebook、Instagram、LinkedIn、Reddit、TikTok、Twitter、微博、小红书、YouTube，共 10 个 | 通常 → Night-All `POST /api/v1/search/crawl` | **仍有**；小红书单账号、posts、20 条、并发 1、无自定义 params 且命中迁移门控的 Live 请求在 Hub 执行 |
| `POST /api/v1/search/user-info`；`POST /api/v1/night-all/search/user-info` | 抖音、Facebook、Instagram、LinkedIn、Twitter、微博、小红书、知乎，共 8 个 | 通常 → Night-All `POST /api/v1/search/user-info` | **仍有**；小红书单账号、受支持字段且命中迁移门控的 Live 请求在 Hub 执行 |
| `POST /api/v1/data/social/crawl` | 下表 13 个平台 | Hub 固定账号 recipe，按需解析身份、多页采集和读取已采购缓冲 | **无 Night-All 回退** |
| `POST /api/v1/data/social/user-info` | 下表 13 个平台 | Hub 固定资料 recipe，按需先解析账号 | **无 Night-All 回退** |
| `POST /api/v1/data/social/search` | Twitter | Hub → RapidAPI `GET /search/{query}` | 无；不是 13 平台通用内容搜索，通用入口是 `/data/search` |

小红书已进入 Hub 路线后，操作暂停、凭据缺失或准入失败不回退 Night-All；已有 Hub 游标保持原路线。新版账号接口的主要上游如下。一个账号请求可能先 lookup，再获取 profile/posts；活动类型还会选择额外路径。

| 平台 | 供应商 | 账号资料／身份解析 | 默认账号内容 | 额外活动 |
| --- | --- | --- | --- | --- |
| Twitter | RapidAPI | `/user/by/username/{username}` 或 `/user/users/by/ids` | `/user/{id或-1}/tweets` | — |
| Facebook | JustOne | `/api/facebook/get-profile-id/v1` | `/api/facebook/get-profile-posts/v1` | — |
| Instagram | TikHub | `/api/v1/instagram/v2/fetch_user_info` | `/api/v1/instagram/v3/get_user_posts` | reels、stories、tagged_posts、highlights、followers、following |
| B站 | TikHub | `/api/v1/bilibili/web/fetch_user_profile` | `/api/v1/bilibili/web/fetch_user_post_videos` | — |
| 抖音 | TikHub | `/api/v1/douyin/web/handler_user_profile`；lookup `handler_user_profile_v2` | `/api/v1/douyin/app/v3/fetch_user_post_videos` | likes |
| 快手 | TikHub | `/api/v1/kuaishou/app/fetch_one_user_v2` | `/api/v1/kuaishou/app/fetch_user_post_v2` | — |
| 微博 | TikHub | `/api/v1/weibo/web_v2/fetch_user_info` | `/api/v1/weibo/web_v2/fetch_user_posts` | original_posts |
| 小红书 | TikHub | `/api/v1/xiaohongshu/app_v2/get_user_info`；lookup `search_users` | `/api/v1/xiaohongshu/app_v2/get_user_posted_notes` | likes → `get_user_faved_notes` |
| YouTube | TikHub | `/api/v1/youtube/web/get_channel_info`；lookup `/api/v1/youtube/web_v2/get_channel_id` | `/api/v1/youtube/web_v2/get_channel_videos` | — |
| 知乎 | TikHub | `/api/v1/zhihu/web/fetch_user_info` | `/api/v1/zhihu/web/fetch_user_articles` | answers |
| TikTok | TikHub | `/api/v1/tiktok/app/v3/handler_user_profile` | `/api/v1/tiktok/app/v3/fetch_user_post_videos` | likes、reposts |
| LinkedIn | TikHub | `/api/v1/linkedin/web_v2/get_user_profile` | `/api/v1/linkedin/web_v2/get_user_posts` | company_posts |
| Reddit | TikHub | `/api/v1/reddit/app/fetch_user_profile` | `/api/v1/reddit/app/fetch_user_posts` | comments |

依据：[旧平台允许列表](../../server/contracts/night-all-legacy.mjs) L8；[新版账号 RECIPES](../../server/contracts/hub-social-compat.mjs) L26–98；[账号执行工作流](../../server/external-platforms/social-account-workflow.mjs)。新账号路径不会自动修复旧入口的未知结果、旧游标或旧幂等请求。

## 4. 其他产品接口

下表中的采集路径均没有 Night-All API 回退；缓存回退指 Hub 自己保存的结果。

| Hub HTTP 入口 | 范围／平台 | 真实上游／内部依赖 | 运行条件与备注 |
| --- | --- | --- | --- |
| `POST /api/v1/data/enterprise/{apiId}/query` | 274 个企业 apiId | 启信宝 `https://api.qixin.com` + 目录中的固定路径；上游 GET／POST 按接口声明 | 260 个公开价格合同，14 个议价合同禁止派发。支持 live_only／cache_only／cache_first／refresh；每项还需运行发布、凭据、价格和授权，详见逐项附表 |
| `POST /api/v1/data/ecommerce/products/search` | taobao、tmall | JustOne `GET /api/taobao/search-item-list/v1` | 天猫用同一路径加对应筛选 |
| 同上 | jd | JustOne `GET /api/jd/search-item-list/v1` | Hub 商品合同／缓存／存储策略 |
| 同上 | xiaohongshu_ec | JustOne `GET /api/xiaohongshu-ec/search-products/v1` | 同上 |
| 同上 | douyin_ec | JustOne `GET /api/douyin-ec/search-item-list/v1` | 同上 |
| 同上 | xianyu | JustOne `GET /api/xianyu/search-item-list/v1` | 同上 |
| 同上 | pinduoduo、kuaishou_ec | **当前无统一商品搜索适配器** | 不能把 routing 目录／快手榜单 native 接口当成已实现商品搜索 |
| `POST /api/v1/data/ecommerce/taobao/product-detail` | 淘宝／天猫商品详情 | JustOne `GET /api/taobao/get-item-detail/{version}` | 已 release 版本 v1／v3／v4／v5／v7／v9 |
| `POST /api/v1/data/ecommerce/taobao/product-reviews` | 淘宝／天猫评价 | JustOne `GET /api/taobao/get-item-comment/v3` | 专用资源 |
| `POST /api/v1/data/ecommerce/taobao/product-questions` | 淘宝／天猫问答 | JustOne `GET /api/taobao/get-social-feed/v1` | 专用资源 |
| `POST /api/v1/data/ecommerce/taobao/shop-products` | 淘宝／天猫店铺商品 | JustOne `GET /api/taobao/get-shop-item-list/{version}` | 已 release v1／v2／v4 |
| `POST /api/v1/data/social/accounts/search` | 小红书 | JustOne `GET /api/xiaohongshu/search-user/v2` | 按关键词查账号；与内容搜索和按账号查资料不同 |
| 同上 | 抖音 | JustOne `GET /api/douyin/search-user/v2` | 同上 |
| 同上 | 微博 | TikHub `GET /api/v1/weibo/web_v2/fetch_user_search` | 同上 |
| 同上 | 快手 | TikHub `GET /api/v1/kuaishou/app/search_user_v2` | 同上 |
| `POST /api/v1/data/post`；别名 `GET/POST /api/v1/xiaohongshu/app/get_note_info` | 小红书详情 | TikHub `GET /api/v1/xiaohongshu/app_v2/get_image_note_detail` | 默认 cache_first；别名共用原 paid operation／fingerprint |
| `GET/POST /api/v1/xiaohongshu/app_v2/get_image_note_detail` | 小红书兼容详情 | TikHub GET 同路径 | AppV2 官方兼容层 |
| `GET/POST /api/v1/xiaohongshu/app_v2/search_notes` | 小红书兼容内容搜索 | TikHub GET 同路径 | 专项兼容合同，不是 Night-All 转发 |
| `GET/POST /api/v1/xiaohongshu/app_v2/search_users` | 小红书兼容账号搜索 | TikHub GET 同路径 | 与统一 accounts/search 的 JustOne 路线不同 |
| `GET/POST /api/v1/xiaohongshu/app_v2/get_user_info` | 小红书兼容资料 | TikHub GET 同路径 | 需 userActivity 操作状态 |
| `GET/POST /api/v1/xiaohongshu/app_v2/get_user_posted_notes` | 小红书兼容账号笔记 | TikHub GET 同路径 | 需 userActivity 操作状态 |
| `POST /api/v1/data/xiaohongshu/hot-notes/search` | 热门笔记 | JustOne `GET /api/xiaohongshu/hot-search/v1` | live_only，独立受控分页 |
| `POST /api/v1/data/xiaohongshu/creator-inspirations` | 创作灵感 | TikHub `GET /api/v1/xiaohongshu/app_v2/get_creator_hot_inspiration_feed` | live_only |
| `POST /api/v1/data/xiaohongshu/notes/detail`；别名 `POST /api/v1/xiaohongshu/pgy/get_note_detail` | 蒲公英详情／阅读量 | TikHub `POST /api/v1/xiaohongshu/pgy/get_note_detail` | 共享队列与缓存；支持 cache_first／refresh，cache_first 可存储回退 |
| `POST /api/v1/data/xiaohongshu/notes/comments` | 评论 | TikHub `GET /api/v1/xiaohongshu/app_v2/get_note_comments` | live_only，签名分页 |
| `POST /api/v1/data/xiaohongshu/users/notes/analytics`；别名 `POST /api/v1/xiaohongshu/pgy/get_blogger_notes_v2` | 用户笔记指标 | TikHub `POST /api/v1/xiaohongshu/pgy/get_blogger_notes_v2` | live_only，每页至多 8 条 |
| `POST /api/v1/data/ip/risk`、`.../risk/batch` | IP 风险旧版 | `POST https://api.ipdatacloud.com/v2/query` | form body；保留幂等重放 |
| `POST /api/v1/data/ip/risk/v2`、`.../v2/batch` | 多渠道 IP 风险 | 显式选 legacy-v1、baidu-v2 或两者；默认百度 | 百度每 IP 两个 GET：`https://cloud.baidu.com/api/afd-ip-threat/act/v1/ipage/base/{ip}`、`.../overall/{ip}`；是显式多渠道，不是失败自动回退 |
| `POST /api/v1/data/ip/risk/service`、`.../service/batch` | IP 商业产品 | 当前 commerce delivery policy 选中的 legacy-v1／baidu-v2 | 批次保存所选通道，重放不重新选源 |
| `GET /api/v1/data/ip/risk/subscription`、`.../history`、`.../history/{kind}/{id}` | IP 订阅／历史 | Hub PostgreSQL | 读取不请求供应商 |
| `POST /api/v1/tools/tokenize` | 分词 | 配置 HanLP 时 `POST {hanlpUrl}/tokenize`；失败可本地 jieba／bigram 降级 | 返回实际 backend／degraded；不是 Night-All |
| `GET /api/v1/data/ecommerce/products/items`、`/data/mobile-commerce/items`、`/data/virtual-supermarket/*` | 已存商品与数据 | Hub 已存数据 | 没有实时电商抓取 |
| `GET /api/v1/data/posts/media`、`/data/ecommerce/products/media` | 小红书详情图片／商品图片读取 | 已提交结果中的图片 URL → Hub 内存缓存或受限原图 CDN | 只支持 JPEG／PNG／WebP 图片，不代理视频；posts/media 当前要求小红书及详情授权。不是 Night-All 搜索，也不能算作无网络请求 |
| `POST /api/v1/data/native/{key}` 及注册表中的微信专项路径 | 1,065 个固定合同 | Hub → TikHub／JustOne | 785／280 条；所有路径、上游 method 和操作名在逐项附表，不代表全部 active |

新闻发现的 5 个接口均是库存读取：`GET /api/v1/data/news/sources`、`GET .../source-options`、`POST .../search`、`POST .../facets`、`GET .../articles/{id}`。不会实时采集新闻或补抓正文。其数据可能来自 Night-All／Night-All-A 导入，这属于数据血缘。

依据：[HTTP 路由](../../server/app.mjs) L5661–6054；[电商搜索合同](../../server/contracts/justone.mjs) L170；[电商资源版本](../../server/contracts/justone-resources.mjs) L122；[账号搜索合同](../../server/contracts/social-accounts.mjs) L111；[小红书官方兼容](../../server/contracts/tikhub-xiaohongshu-official.mjs) L52；[企业派发](../../server/external-platforms/gateway.mjs) L1069；[IP 通道](../../server/external-platforms/ip-risk-channels.mjs)；[新闻库存](../../server/data/news-discovery.mjs)。

## 5. 全网搜索：8 个 Hub 直属供应商

入口：`POST /api/v1/data/web-search/search`、`POST /api/v1/data/web-search/compatible/baidu`。`GET /api/v1/data/web-search/capabilities` 只读授权／策略／就绪信息，不执行搜索。

| 供应商 | 直接上游 | Night-All |
| --- | --- | --- |
| 百度 | `POST https://qianfan.baidubce.com/v2/ai_search/web_search` | 无 |
| Exa | `POST https://api.exa.ai/search` | 无 |
| Tavily | `POST https://api.tavily.com/search` | 无 |
| Serper | `POST https://google.serper.dev/search` | 无 |
| You.com | `POST https://ydc-index.io/v1/search` | 无 |
| SearchAPI | `GET https://www.searchapi.io/api/v1/search` | 无 |
| Firecrawl | `POST https://api.firecrawl.dev/v2/search` | 无 |
| SerpApi | `GET https://serpapi.com/search.json` | 无 |

在授权候选中派发前选择供应商并保存选择；已派发后不自动换源。依据：[供应商 URL](../../server/web-search/providers.mjs) L2；[执行工作流](../../server/web-search/runtime.mjs)；[适配器](../../server/adapters/web-search.mjs)。

## 6. 间接 Night-All 依赖、同步与 Night-All-A

| 入口／任务 | 实际调用 | 依赖类型和触发条件 |
| --- | --- | --- |
| `POST /api/v1/data/aggregate/search` | `mode=refresh` → 内部 `service.search`，可能继续 Night-All data/search | **条件 HTTP 依赖**；`mode=stored` 只查库存，`execution=hub_only` 只允许 Hub 已接管 recipe |
| `POST /internal/v1/admin/backfill` | 入队后 worker → `GET {NIGHT_ALL_BASE_URL}/api/v1/data/export?platform&since&cursor&limit` | **异步 HTTP 依赖**；读 Night-All 已存内容，不重新请求其供应商；默认允许小红书／抖音／Twitter |
| `POST /internal/v1/admin/pipelines/night-all-saved-records/discover` | 源 PostgreSQL 的分区目录／DEFAULT 分区类型 | **源数据库依赖**；发现后可写 Hub 注册状态，不是 Night-All HTTP |
| `PUT /internal/v1/admin/pipelines/night-all-saved-records` | 源 PostgreSQL 连接验证 | **数据库依赖**；保存连接／配置，不请求供应商 |
| `POST .../night-all-saved-records/status` | 启用时验证源表与游标合同 | **数据库依赖**；状态修改发生在 Hub |
| `POST .../night-all-saved-records/sync`；后台自动同步 | 源 `public.saved_records_<source_type>` → Hub Canonical／ES | **数据库增量同步**；不是调用 Night-All 搜索 API |
| `GET .../night-all-saved-records/progress` | 源分区计数 + Hub 检查点 | **数据库统计依赖** |
| `POST /internal/v1/admin/external-platforms/night-all-a/dispatch/:operation` | 独立 Night-All-A 服务，下表固定 18 项 | **在线 HTTP 依赖**；Admin 权限、enabled；写操作另需 writesEnabled／幂等键／原因 |

Night-All-A 与 `NIGHT_ALL_BASE_URL` 指向的历史 API 是不同服务。A 的代码允许目标为 `http://100.127.0.1:8100` 或 `:8101`；不是根据接口名推断 13141。

| `:operation` | Night-All-A 上游方法／路径 | 类型 |
| --- | --- | --- |
| health | `GET /api/health` | 读 |
| connectors | `GET /api/connectors` | 读 |
| sourceFamilies | `GET /api/source-families` | 读 |
| tasks / task | `GET /api/tasks`；`GET /api/tasks/{id}` | 2 项读 |
| runs / run | `GET /api/runs`；`GET /api/runs/{id}` | 2 项读 |
| runLogs / runSteps / runArtifacts | `GET /api/runs/{id}/logs`、`/steps`、`/artifacts` | 3 项读 |
| plans / plan | `GET /api/collection-plans`；`GET /api/collection-plans/{id}` | 2 项读 |
| occurrences | `GET /api/collection-plans/{id}/occurrences` | 读 |
| records / record | `GET /api/records`；`GET /api/records/{id}` | 2 项读 |
| recordMetrics | `GET /api/records/{id}/metrics` | 读 |
| createTask | `POST /api/tasks` | 写 |
| runPlan | `POST /api/collection-plans/{id}/run-now` | 写 |

依据：[聚合搜索](../../server/data/aggregate-search.mjs) L36、L215；[回填](../../server/ingest/backfill.mjs) L53；[Night-All 适配器](../../server/adapters/night-all.mjs) L219；[源库流水线](../../server/ingest/crawler/pipeline.mjs) L388、L513、L582、L667、L770；[Night-All-A 允许列表](../../server/external-platforms/night-all-a.mjs) L7。

### Night-All 内层继续调用什么

以下来自本机 `/Users/qpjoy/workspace/mingxi/Night-All` 源码，是默认／候选，不是线上实际选中结果。标准 data/search 会根据 `ready_only` 能力选择并绑定 provider／endpoint；部分账号资料候选来自 Night-All 数据库。本机部分 TikHub endpoint JSON 未提供，因此仅有 endpointId 的条目保持原 ID，不根据名字臆造 URL。

| Night-All 中的剩余用途 | 默认／候选供应商 | 代码可确认的上游 |
| --- | --- | --- |
| TikTok 标准／raw 搜索 | TikHub | `GET /api/v1/tiktok/web/fetch_general_search` |
| Reddit raw 搜索 | TikHub | `GET /api/v1/reddit/app/fetch_dynamic_search` |
| YouTube raw 搜索 | TikHub | `GET /api/v1/youtube/web_v2/get_general_search_v2` |
| 微博条件搜索 | TikHub | `GET /api/v1/weibo/web_v2/fetch_realtime_search` |
| 小红书条件搜索 | TikHub | `GET /api/v1/xiaohongshu/app_v2/search_notes` |
| Twitter 复杂 raw | RapidAPI | `GET /search/{encoded_term}` |
| 抖音旧 crawl | TikHub | endpointId `douyin_web_fetch_user_post_videos`；用户名解析 `douyin_web_handler_user_profile_v2` |
| Facebook 旧 crawl／user-info | JustOne | `GET /api/facebook/get-profile-id/v1`；内容 `GET /api/facebook/get-profile-posts/v1` |
| Instagram 旧 crawl | TikHub | `GET /api/v1/instagram/v3/get_user_posts`，另有 reels／stories／tagged 等活动 |
| LinkedIn 旧 crawl | TikHub | `/api/v1/linkedin/web_v2/get_user_profile` → `/api/v1/linkedin/web_v2/get_user_posts`；另有旧 endpoint 候选 |
| Reddit 旧 crawl | TikHub | endpointId `reddit_app_fetch_user_posts`；comments 为 `reddit_app_fetch_user_comments` |
| TikTok 旧 crawl | TikHub | endpointId `tiktok_app_v3_fetch_user_post_videos` |
| Twitter 旧 crawl | RapidAPI | `GET /user/{id}/tweets` 或 `/user/-1/tweets?username=…` |
| 微博旧 crawl | TikHub | endpointId `weibo_web_v2_fetch_user_posts`；原创 `weibo_web_v2_fetch_user_original_posts` |
| 小红书条件 crawl | TikHub | `user_posts` 动态候选，优先 `/api/v1/xiaohongshu/app_v2/get_user_posted_notes`；可先 search_users |
| YouTube 旧 crawl | TikHub | endpointId `youtube_web_v2_get_channel_id` → `youtube_web_v2_get_channel_videos` |
| Twitter 旧 user-info | RapidAPI | `/user/by/username/{name}`、`/user/{id}`、`/user/users/by/ids`；可补 `/user/about/{name}` |
| Instagram／LinkedIn 旧 user-info | TikHub | `user_profile` 候选分别为 `/api/v1/instagram/v3/get_user_profile`、`/api/v1/linkedin/web_v2/get_user_profile` |
| 抖音／微博／小红书／知乎旧 user-info | TikHub | `capability=user_profile` 动态候选；本次不能确认唯一固定路径 |

Night-All 内部同供应商的 endpoint 候选尝试，与跨供应商 fallback 是两件事；当前代码的 TikHub → JustOne 自动供应商 fallback 已禁用。Hub 的 Night-All 兼容错误可以回退到 **Hub 保存的历史快照**，不是再派发另一笔 Night-All 请求。

内层证据：`Night-All/lib/domains/search/providers/provider-registry.js:23`、`raw-search-service.js:54`、`paged-content-search-service.js:383`、`tikhub-user-activity-config.js:3`、`user-info-service.js:238`、`tikhub-endpoint-orchestrator.js:126`、`provider-fallback.js:34`，以及 `lib/integrations/social-providers/tikhub/curated-search-endpoints.js:48`。

## 7. 名称／数据血缘来自 Night-All，但当前请求不调用它

| Hub 入口／对象 | 实际依赖 | 说明 |
| --- | --- | --- |
| `GET /api/v1/data/capabilities` | 本地合同 + Hub 操作状态 | 不请求 Night-All capabilities；`night-all.data-search.v1` 是兼容合同名，不能据此推断物理上游 |
| `/health/ready`、`/health/dependencies`、`GET /internal/v1/admin/runtime` | Hub DB／本地运行状态 | 不探测 Night-All；本地健康不等于采集上游健康 |
| `GET /internal/v1/admin/external-platforms/night-all` | Hub 已保存 connector／usage 统计 | 不实时请求 Night-All；统计口径也不覆盖全部转发／回填流量 |
| `GET .../external-platforms/night-all-a`、`GET .../night-all-a/dispatches[/:id]` | 本地配置／目录／Hub 派发日志 | 与真正的 POST dispatch 分开 |
| `GET /internal/v1/admin/strategy-search`、`.../usage`、`.../data-statistics` | Hub 路由目录／用量／统计 | 不触发采集；当前目录与历史流量是不同证据 |
| `POST /api/v1/data/stored/search`、`POST /api/v1/data/canonical/search` | Hub PostgreSQL／Elasticsearch | 已存数据可含 Night-All 血缘，但查询不实时依赖 Night-All |
| Telegram 已存搜索、context／timeline、新闻发现、全国舆情、目录／分类读取 | Hub 已入库数据 | 不因读取而重新请求原采集器 |
| `POST /internal/v1/admin/data-browser/advanced/search` | PG／ES，词法可用 HanLP，语义用配置的 Embedding Sequence | 不经过 Night-All；实际模型服务 URL 由当前运行配置决定 |
| `POST /internal/v1/admin/data-browser/advanced/answer` | Hub 检索证据 + 配置的 Chat Sequence | 显式生成可能请求模型；不能从源码断言固定走 mx-embedding |
| native 注册表引用 `night-all-provider-inventory.json` | 本地静态合同定义 | 当前执行为 Hub → TikHub／JustOne，没有运行时 Night-All 跳转 |
| Adapter 中仍保留 `dependencies/capabilities/exportWatermarks` 方法 | 未找到当前运行入口调用点 | 不把仅有方法定义列成“当前被调用接口”；同样未发现独立转发 Night-All analytics／statistics／trends 的 Hub 路由 |

## 8. 上游地址与运行条件

| 上游 | 源码地址／选择方式 | 本次核实边界 |
| --- | --- | --- |
| Night-All | `NIGHT_ALL_BASE_URL`；代码默认 `http://127.0.0.1:13141`，Compose 示例另有 `18141` | 没有读取生产实际值；不能把默认值当作线上配置 |
| TikHub | `https://api.tikhub.io`，另允许 `https://api.tikhub.dev` | 实际选域／凭据／操作状态由配置决定 |
| JustOne | `https://api.justoneapi.com` | 固定 origin，逐操作 rollout／价格／凭据门槛 |
| RapidAPI | Twitter AIO、Facebook Scraper 对应允许 host | 业务合同固定，当前启用及订阅余量需运行证据 |
| 启信宝 | `https://api.qixin.com`，目录固定路径 | 14 个议价接口代码禁止派发，其余仍需授权／运行准入 |
| IP 数据 | ipdatacloud 与百度 IP 风险固定合同 | 通道选择与订阅／策略独立于 Night-All |
| HanLP／Embedding／Chat | 环境配置或 Hub 数据库的 LLM Sequence | 不读取密钥；不能将本机默认配置视为线上实际供应商 |

本次没有统计生产最近一段时间的实际调用次数。如果要确认“线上此刻哪些分支启用、最近实际调用了多少次”，需另用 Admin 路由／操作状态和保存的 usage、connector_calls、provider_calls 对账，并核对 Public 镜像版本；不能只看旧设计文档、管理端目录数量或本机代码推断。
