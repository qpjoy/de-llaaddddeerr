# YouTube 评论与剩余标准搜索迁移（2026-10-17）

本文记录源码实现和离线验证，不代表生产已部署、供应商已启用或付费实测成功。
历史审计见 [2026-10-16 上游清单](../operations/hub-upstream-inventory-2026-10-16.md)。

## 路由变化

| 下游用途 | Hub 入口（POST） | 当前源码执行链 | 迁移边界 |
| --- | --- | --- | --- |
| YouTube 单帖子/视频评论 | `/api/v1/data/youtube/comments` | Hub → 固定视频评论合同 | 由 videoId/postId/contentId 或视频 URL 标识；只取一级评论，不自动展开回复 |
| `youtube_channel_comments` | `/api/v1/data/youtube/channel-comments` | Hub → 可选频道解析 → 频道视频 → 选中视频评论 | 频道入口不接受视频 URL；maxVideos 默认5、上限20，定义本轮视频窗口 |
| TikTok 标准搜索 | `/api/v1/data/search`，`platform=tiktok` | Hub → 固定内容搜索合同 | raw 两个兼容入口 2026-10-31 起也改由 Hub 执行，见下文 |
| 微博标准搜索 | 同上，`platform=weibo` | Hub → 固定搜索；小于20条的页使用已取得余量缓冲 | 大页及已签发 Hub 游标保留原链；不再因小页转 Night-All |
| 小红书标准搜索 | 同上，`platform=xiaohongshu` | Hub → 已有 `social.posts.search` 操作 | 20条及已签发 mxec2 保持既有链；其他页大小使用缓冲；不再按旧 rollout gate 或 Test Key 分流至 Night-All |
| 微信搜索/公众号 | 同上，`platform=wechat_search/wechat_mp` | Hub → 微信专项新合同 | 返回专项原生响应；需要 `social + native.wechat.search.search`，旧游标不可复用 |

新版标准内容搜索支持的平台已不需要实时经过 Night-All。旧 raw/crawl/user-info、数据回填、源库同步及 Night-All-A 管理仍是独立依赖，不能据此删除整个旧服务。
### 2026-10-31：TikTok、Reddit、YouTube raw 改为 Hub 直连

Delta 的 TikTok 冷启动走 `POST /api/v1/night-all/search/raw`（`operation=raw`，请求体 `{platform, keyword, page, count}`）。按 10-17 的边界它仍转发 Night-All `POST /api/v1/search/raw`，而 Night-All 对它返回非 JSON 的 HTTP 404（Hub 记为 `night_all_rejected` / `invalid_upstream_content_type`），整条 raw 链路近 7 天 1452 次失败、2 次成功。

现在 TikTok、Reddit、YouTube 配方都是 `rawCompatibility: true`（`server/contracts/tikhub-content-search.mjs`），两个 raw 入口与 B站、抖音、快手、知乎一样由 Hub 调固定 TikHub 端点（TikTok 现为 `/api/v1/tiktok/app/v3/fetch_video_search_result`，见下文 11-05；Reddit `/api/v1/reddit/app/fetch_dynamic_search`、YouTube `/api/v1/youtube/web_v2/get_general_search_v2`），不回退 Night-All：

- 响应仍是 raw 信封：`contractVersion=mx-insight-hub.raw-search.v1`，`raw_data` / `raw_info` 为 JSON 字符串，`page` 给出 Hub 签发的续页游标。一页不够时在本次请求内继续向 TikHub 取（每请求最多 3 次实际调用）。
- `params` 只接受各端点声明的字段（如 TikTok 的 `offset`、`count`、`sort_type`、`publish_time`、`region`），其余字段在采购前返回 400；详情／评论附采参数同样在采购前拒绝。`publicParams` 仍为 false，标准搜索不开放 params。
- Night-All 签发的旧 `mxnc1` 游标返回 `409 search_restart_required`，需带新幂等键从第 1 页重开；标准搜索的游标不能续 raw。
- 计量、授权与 B站等 raw 直连一致；同幂等键在两个 raw 别名之间重放同一交付。

Reddit raw 使用与标准搜索相同的严格解析：响应里出现无法识别、但疑似含帖子的组件时整页判为 `invalid_content_search_contract`，同一查询随后 5 分钟返回 `409 external_platform_response_unusable`。这类失败需要用 `server/ops/diagnose-reddit-search.mjs` 读取结构后补解析规则，与本次路由调整无关。

仍可能转发 Night-All 的 raw 只剩微博、Twitter、小红书的非简单请求（多关键词、附采参数、非 Hub 游标等）。

微信旧 `/api/v1/night-all/search/raw` 仍返回410；迁到 `/api/v1/data/search` 可避开退役入口，但也必须按新参数、授权、响应和游标切换，不能只改 URL。

### 2026-11-05 TikTok 改用 App V3 视频搜索

生产请求 `87c45dbc-06fb-4a1f-8f36-5391438bac6d` 在首页失败：TikHub `GET /api/v1/tiktok/web/fetch_general_search` 返回 HTTP 400、业务码 400，上游请求 ID `9dfe3fab-b904-4400-9e7a-74212cfbdce2`。回显关键词与 Hub 一致，`offset=0`，`search_id=""`，供应商只给通用失败文案（400 不计费）。

同日用本地 Night-All 配置的 TikHub 凭据直连对照（每次成功调用约 0.001 USD）：

| 端点 | 请求 | 结果 | TikHub 请求 ID |
|---|---|---|---|
| `web/fetch_general_search` | 官方示例 `TikTok`，`offset=0`，显式空 `search_id` | 400 | `967cd4cd-64eb-4ef3-b672-d79c53a66260` |
| `web/fetch_general_search` | 同上，省略 `search_id` | 400 | `902cf724-b80e-41d8-bc7d-1ca8908712ef` |
| `web/fetch_general_search` | 同上，稍后复测 | 400 | `82f4c88f-1e94-4a00-bcd4-44c69b7a8989` |
| `web/fetch_search_video` | `TikTok`，`count=20`，`offset=0` | 400 | `965eaf09-59b5-4737-af16-e909c7a0f0a0` |
| `app/v3/fetch_video_search_result` | `cat`，`offset=0`，`count=20` | 200，20 条，`cursor=20`，`has_more=1` | `6b9e8263-633a-4972-92f6-ea38ff80f34c` |
| `app/v3/fetch_video_search_result` | `cat`，`offset=20` | 200，空页（`search_nil_info.search_nil_item=federation_empty`），`has_more=0` | `59739712-b671-4676-94f2-b0fd6d09f41a` |
| `app/v3/fetch_video_search_result` | `城市`，`offset=0`，`count=30` | 200，30 条，`cursor=30`，`has_more=1` | `3f8e4153-8a70-4805-b3e6-42fe0a17275e` |
| `app/v3/fetch_video_search_result` | `城市`，`offset=30` | 200，30 条（与首页重复 7 条），`cursor=60`，`has_more=1` | `9803a398-b585-4e27-9a9f-6ecfc6262e0c` |
| `app/v3/fetch_video_search_result` | `TikTok`，`offset=0` | 200，2 条，`has_more=0` | `2eae8534-53af-40b9-a578-cfe996d2b94d` |

web 搜索连官方示例都失败，问题在供应商侧，改参数无效。TikTok 标准搜索和两个 raw 入口改用已发布的官方键 `t.api_e806cdfabc136655`（`native.t.api_e806cdfabc136655`，迁移 114 已 released，官方价 0.001 USD，与旧端点相同）：

- 请求：`keyword`、`offset`（首页 0）、`count=20`、`sort_type=0`（相关度）、`publish_time=0`（不限）、`region=US`，按官方合约做整数/字符串类型校验。
- 响应：作品在 `search_item_list[].aweme_info`（旁边的 `aweme_list` 为空数组）。空页把两个列表都置为 `null` 并附 `search_nil_info`，只有这种组合按空页结束；其余缺列表的情况仍按结构异常处理。分享链接去掉 `u_code`、`_d` 等分享者追踪参数；图文作品读取 `image_post_info.images[].display_image`。
- 翻页：该接口没有 `search_id`，下一页只用响应的 `cursor` 作为 `offset`，必须递增；按 `has_more` 决定是否续页。部分关键词第二页即为空页，属正常结束。跨页重复由 Hub 去重。
- 旧游标：Hub 游标里带配方键，旧 web 配方签发的 TikTok 游标统一返回 `400 invalid_cursor`，需从第 1 页重新开始。上一版为 web 接口加的 `search_id` 续页守卫与 `tiktok_search_id_unavailable` 提示已删除。
- raw 调用方若在 `params` 里带旧接口的首页默认值（`offset=0`、`search_id=""`）照常接受；非空 `search_id` 返回 400。
- 上线前提：`native.t.api_e806cdfabc136655` 需为 active 且有价。部署脚本的 `seed_default_price_books` 会为缺价的已发布操作补 0.01 USD 预估价并激活（需 `MX_INSIGHT_ADMIN_TOKEN`）；若运营手动暂停过该操作，需要在管理端恢复。旧键 `native.t.tiktok_web_fetch_general_search` 的原生转发保持不变。

## YouTube 请求与响应

```bash
curl "$HUB_URL/api/v1/data/youtube/comments" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: youtube-video-comments-page-001' \
  -d '{"videoId":"dQw4w9WgXcQ","maxComments":50}'

curl "$HUB_URL/api/v1/data/youtube/channel-comments" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: youtube-channel-comments-page-001' \
  -d '{"channelUrl":"https://www.youtube.com/@example","maxVideos":5,"maxComments":50}'
```

- Key 需要 `youtube` 平台和 `social.comments.list` 能力。不要求给客户额外开通内部采购 native 权限；独立 native 调用另遵循自己的权限。
- `maxComments` 默认50、上限100，并受 Key 页大小限制。它是**本响应所有视频合计**的评论上限，不是每视频上限。旧 Night-All schema 会丢弃下游传入的 maxComments；新接口会真正执行限制。
- `count/pageSize/limit/max_comments` 是 maxComments 同义字段，同时提交必须相同。不要原样携带旧 persona 中冲突的 `maxComments=50,count=20,limit=20`。
- `channelId` 与 `@handle`、`/c/`、`/user/` 频道 URL 可同时传入，此时以稳定 ID 为准，不另购 URL 解析来验证二者对应关系；如果 URL 本身是 `/channel/ID` 且两个 ID 不同，仍返回400。只传 URL 时沿用频道解析步骤。
- `sortBy` 支持 `top/newest`；`languageCode` 默认 `zh-CN`，`countryCode` 默认 `US`，也接受对应 snake_case。`params` 仅包含这三类选项；禁止 provider、路径、凭据、原生 continuation_token 和工作量覆盖。
- 顶层是 `contractVersion=mx-insight-hub.youtube-comments.v1`、`data`、`requestId`。`data.items` 是评论数组；`raw_data` 是相同数组的 JSON 字符串。单视频另有 comments；频道另有 channel/videos/videoIds/results，results 中的 comments 只描述本响应页，不表示该视频全部评论。
- `videoId` 关联所属视频；频道聚合的 `items`、`raw_data`、`results[].comments` 中每条评论以及 `videos`、`results[].video` 都携带所属频道的 `channelId/channelUrl`，URL 为规范 `/channel/ID` 地址。`author.channelId` 仍是评论作者，不能用来判断视频所属频道；单视频接口不会凭评论作者猜测频道。规范化记录为 `objectType=comment`，dataset 为 `social.comments.v1`。供应商已取得的完整页归档并入队，频道视频发现记录也按 post 入库。缺失指标为 null，明确的零保留0；相对发布时间保留原文。
- 读取 `data.pageInfo.hasMore/nextCursor`。下一页保持原参数、原 Key，传回游标并使用新的 Idempotency-Key；同页重试保持原标识与请求体。旧 Night-All/provider 游标不可导入。
- 每轮最多15个公开响应页、15个数据采购页（视频发现也占用），另允许最多一次频道解析；视频发现最多5页。游标有效期24小时。`partial/warnings` 表示限额、未证实分页等不完整情况，不能把短页或 `hasMore=false` 一概理解为完整耗尽。
- 不自动重试、不回退 Night-All。unknown 必须先通过 Hub 请求记录只读核对。每个成功响应按 `social.comments.list` 结算一次，内部实际采购调用独立记账；仅消费缓冲或幂等重放不会重复采购已取得的评论页。

## 采购注册与部署

迁移 `155_youtube_comments.sql` 仅注册已审核的评论操作，默认 disabled，不改既有操作、客户授权、凭据或价格。按项目已有部署流程运行迁移并重启 API/ingest worker 后，还需通过现行管理流程核实：

| 阶段 | 内部采购操作 | 固定上游路径 |
| --- | --- | --- |
| 单视频/频道评论 | `native.t.api_4a6f21264dc0b4a1` | `GET /api/v1/youtube/web_v2/get_video_comments` |
| 频道URL解析（传channelId可省） | `native.t.api_43f6d9ff14e87159` | `GET /api/v1/youtube/web_v2/get_channel_id` |
| 频道视频 | `native.t.api_9b22e07d1e1b2842` | `GET /api/v1/youtube/web_v2/get_channel_videos` |

这些操作各自需要已审核价格、当前凭据、可用运行策略与现有采购准入。接口存在不等于线上 active；未开放时明确拒绝。官方评论参数的 `sort_by` 是 `top/newest` 枚举，本次只补齐这一经过核对的引用类型，未改写保留的官方快照。

下游必须部署数据动作路由适配：`post_comments + youtube` 指向单视频入口，`youtube_channel_comments` 指向频道入口。保留其他平台动作；不要通过修改历史 agent_sources 文件假定线上激活包已经更新。旧 comments 自动分页并未纳入通用检查点，本次不增加隐式自动翻页；调用方根据新游标显式继续。

本机 po-infra 已在 `llm/data_query.py` 和 `llm/skill_runtime.py` 增加此接管，优先于数据库中旧 HTTP 动作路径执行，继承业务默认值但不继承旧地址或 token。`llm/result_errors.py` 保留新评论错误的禁止自动重试语义；旧平台路由、数据库激活版本及 agent_sources 均未修改。部署顺序为 Hub API/worker及迁移、核实采购启用与客户授权、再部署下游适配，避免下游先访问尚不存在的路由。

## 验证范围

使用固定响应和本地数据库验证参数、数量上限、频道分阶段采集、全量归档、评论入库任务、缓冲续页、Key/路径/版本隔离、单次客户结算、重放、暂停/权限拒绝、未知结果保护及异常成功响应。没有付费实测回执；部署后首次业务调用仍需核对真实响应和入库结果。

最终相关 Hub 回归512项全部通过，0失败、0跳过，包含真实 PGlite 持久化与迁移测试。另通过 `npm run typecheck` 和 `npm run build`。专门覆盖源第15页仍有更多时返回 partial，以及搜索后/详情准入等待后撤销平台、Key或套餐时禁止追加采购。

po-infra 的17项离线适配测试已运行，真实网络运输被禁止；本机无 Django 环境，未运行 Django 全栈测试。目标环境可执行 `python manage.py test llm.tests_youtube_hub_migration --verbosity 2`。

MX-H2I 登录、联网、Launcher SSO、支付实现及已有历史交付均不在本次代码改动范围。

## 2026-11-01 频道聚合参数与关联修复

本地代码核对发现：Delta 已接管旧 `youtube_channel_comments` 动作并转到 Hub，
但会同时保留已知 `channelId` 和 `channelUrl`。Hub 原先把非 `/channel/ID` URL
解析出的空 ID 当作冲突，导致有效的 ID + handle 请求在采购前返回
`400 invalid_youtube_comments_request`。现以显式 ID 为准，只拒绝可确定的两个 ID 冲突。

Agent 可继续使用原参数：

```json
{"businessId":"agent:<Agent标识>:data_query:youtube_channel_comments:youtube","platform":"youtube","channelUrl":"https://www.youtube.com/@example","channelId":"UCaaaaaaaaaaaaaaaaaaaaaa","maxVideos":5,"maxComments":50,"limit":20,"includeRaw":false}
```

Delta 的 `llm/data_query.py::normalize_hub_youtube_comments` 已优先取 `maxComments`，
去掉旧 `limit/count` 和 Agent `businessId` 后发送至
`POST /api/v1/data/youtube/channel-comments`。Hub 的 `businessId` 是消费者绑定校验字段，
不能把 Agent 业务归因值直接当作 Hub 消费者身份；直连 Hub 时应发送上述归一化后的请求。
默认5个视频、每响应合计50条评论；调用参数可覆盖，仍受既有上限约束。

原响应虽可通过顶层 channel 和 videoId 关联，但单独使用评论数组时缺少直接的频道上下文。
现于最终响应组装阶段补齐每条评论和视频的频道 ID 与规范 URL；不修改采购投影、入库记录、
缓冲哈希或旧游标。已保存交付依然原样重放，因此历史响应不会补写新增字段。
没有新增迁移，也不变更客户授权、价格、采购开关或 MX-H2I 登录/联网。

本轮验证使用本地合成供应商响应。实际 Delta 归一化函数已离线提取执行，确认原参数、
数量覆盖和游标可传给 Hub；这不等于 Django 全栈或线上部署验证。
评论合同、实际 HTTP runtime、费用域、迁移和公开文档共41项测试通过，0失败、0跳过，
包含真实 PGlite；`npm run typecheck` 通过。
生产版本、操作启用状态及首次真实业务成功回执尚待核对，不据此声称已上线。

## 2026-10-17 评论入口授权域修复

Luopan 人物画像经 Delta 调用频道评论返回 `409 external_platform_usage_scope_mismatch`，
关联请求 `e8514090-4e50-47bf-992e-9f9042b9b381`，幂等键
`delta-youtube-comments-997e09db-9181-4c65-9927-1b4c30736f0c`。
源码确认生产组装将两个评论入口接到了 `socialAccountTikHubGateway`：其采购存储固定要求
usage 平台为 `social`，而评论合同按正确的 `youtube` 平台预留 usage。
两者不一致，在第一次采购费用预留时触发截图中的错误。
原工作流单测直接创建 `youtube` 存储，因此未覆盖这个启动组装问题。

修复仅将两个公开评论入口显式注入 `youtubeCommentsGateway`，复用已有的
`socialAccountDataGateways.youtube`。凭据、代理、采购操作控制仍沿用既有 TikHub 配置，
评论与该平台账号采集共享此网关的进程并发控制；账号搜索继续使用原 `social` 网关。
缺少评论网关时返回503，不回退到授权域不符的网关。
不修改存储的身份、平台、fingerprint、状态或租约校验，也不扩大客户权限。
Delta 仅提交公开业务参数和幂等键，此次不需要修改 Luopan、Delta、Launcher 或 Pay。

新增 `createRuntime → HTTP → 实际适配器` 回归，修复前两个入口均复现相同409且没有上游调用，
修复后覆盖正常交付、全量归档、入库、幂等重放、无权限拒绝、缺少专用网关和原幂等键恢复。
另用 Memory/PGlite 验证32项错误域、身份、状态及租约拒绝断言，并验证正确域的采购预留与调用。
本轮上述新增测试及评论、账号、原生转发、Reddit/YouTube 搜索相关回归共108项通过，0跳过；
类型检查通过。全部使用合成上游响应和隔离存储，不代表生产付费调用已经验证。

本轮修复没有新增数据库迁移。将完整源码同步到服务器后，在 Hub 项目目录按现有流程发布：

```bash
MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0 bash scripts/manage.sh ops internal-production deploy
kubectl -n mx-insight-hub rollout status deployment/mx-insight-hub-public --timeout=300s
```

该发布不联动 Launcher。这里记录的是本地修复；尚未取得本次生产发布或业务成功回执。
旧请求状态和费用以账本为准：本缺陷的本地路径在派发前释放预留，未保存 HTTP 失败响应，
显式重试原请求及原幂等键时可按既有逻辑重新预留；已保存失败响应仍按原规则重放，
`unknown` 仍阻止重试。不要清账、改历史状态或自动换幂等键重跑人物画像。

同批另有 Delta `dev` 人物画像 Run34595，HTTP请求
`63d10b02-4ca8-4ca6-a511-7687570be88f`，幂等键
`delta-youtube-comments-b3575167-c965-469e-bc8b-a477d54491f4`，返回相同的
`409 external_platform_usage_scope_mismatch` 和 `Cost reservation does not match its reserved usage request`。
该消息定位到采购费用预留校验，与上述错误网关问题吻合；校验也会拒绝失效租约、非reserved状态、
身份或fingerprint不一致，不能仅凭同码认定该历史请求的精确原因。

Delta的 `dev` 标签来自自身环境名或公开地址，不表示使用独立的Hub；YouTube评论统一读取
`DATA_QUERY_HUB_API_BASE_URL`，默认 `https://hub.minsight-ai.com`，不沿用旧Skill的base_url。
评论网关修复提交 `6c20b2ed` 早于专题报告迁移156，完整发布最新代码应同时包含两项修复；
156的生产数据库回执只证明数据库约束已更新，尚不能证明实际承接该评论请求的API代码版本。
同批历史告警不代表修复后再次失败。下一步只读核对Public容器中的专用网关绑定；若当前代码已更新，
通过原人物画像任务的恢复入口进行业务验收，保留原幂等语义，并记录新请求结果。
