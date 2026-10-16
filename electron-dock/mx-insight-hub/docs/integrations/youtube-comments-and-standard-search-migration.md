# YouTube 评论与剩余标准搜索迁移（2026-10-17）

本文记录源码实现和离线验证，不代表生产已部署、供应商已启用或付费实测成功。
历史审计见 [2026-10-16 上游清单](../operations/hub-upstream-inventory-2026-10-16.md)。

## 路由变化

| 下游用途 | Hub 入口（POST） | 当前源码执行链 | 迁移边界 |
| --- | --- | --- | --- |
| YouTube 单帖子/视频评论 | `/api/v1/data/youtube/comments` | Hub → 固定视频评论合同 | 由 videoId/postId/contentId 或视频 URL 标识；只取一级评论，不自动展开回复 |
| `youtube_channel_comments` | `/api/v1/data/youtube/channel-comments` | Hub → 可选频道解析 → 频道视频 → 选中视频评论 | 频道入口不接受视频 URL；maxVideos 默认5、上限20，定义本轮视频窗口 |
| TikTok 标准搜索 | `/api/v1/data/search`，`platform=tiktok` | Hub → 固定内容搜索合同 | raw 两个兼容入口仍保留原链 |
| 微博标准搜索 | 同上，`platform=weibo` | Hub → 固定搜索；小于20条的页使用已取得余量缓冲 | 大页及已签发 Hub 游标保留原链；不再因小页转 Night-All |
| 小红书标准搜索 | 同上，`platform=xiaohongshu` | Hub → 已有 `social.posts.search` 操作 | 20条及已签发 mxec2 保持既有链；其他页大小使用缓冲；不再按旧 rollout gate 或 Test Key 分流至 Night-All |
| 微信搜索/公众号 | 同上，`platform=wechat_search/wechat_mp` | Hub → 微信专项新合同 | 返回专项原生响应；需要 `social + native.wechat.search.search`，旧游标不可复用 |

新版标准内容搜索支持的平台已不需要实时经过 Night-All。旧 raw/crawl/user-info、数据回填、源库同步及 Night-All-A 管理仍是独立依赖，不能据此删除整个旧服务。
微信旧 `/api/v1/night-all/search/raw` 仍返回410；迁到 `/api/v1/data/search` 可避开退役入口，但也必须按新参数、授权、响应和游标切换，不能只改 URL。

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
- `sortBy` 支持 `top/newest`；`languageCode` 默认 `zh-CN`，`countryCode` 默认 `US`，也接受对应 snake_case。`params` 仅包含这三类选项；禁止 provider、路径、凭据、原生 continuation_token 和工作量覆盖。
- 顶层是 `contractVersion=mx-insight-hub.youtube-comments.v1`、`data`、`requestId`。`data.items` 是评论数组；`raw_data` 是相同数组的 JSON 字符串。单视频另有 comments；频道另有 channel/videos/videoIds/results，results 中的 comments 只描述本响应页，不表示该视频全部评论。
- `videoId` 关联所属视频；规范化记录为 `objectType=comment`，dataset 为 `social.comments.v1`。供应商已取得的完整页归档并入队，频道视频发现记录也按 post 入库。缺失指标为 null，明确的零保留0；相对发布时间保留原文。
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
