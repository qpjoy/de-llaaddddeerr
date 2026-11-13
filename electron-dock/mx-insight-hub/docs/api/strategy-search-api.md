# 策略搜索使用手册

更新：2026-11-11

策略搜索提供监测策略要用的数据接口：内容搜索、账号内容、账号资料、帖子评论、评论回复，以及旧客户端的兼容入口。调用方只传业务字段，不传供应商；走哪个供应商由管理端配置（见第九节）。

## 一、接口总览

| 用途 | 接口 | 所需授权（同一个 Key） | 响应与范围 |
| --- | --- | --- | --- |
| 统一内容搜索 | `POST /api/v1/data/search` | 目标平台；小红书另需 `social.posts.search` | 按关键词搜单个平台。返回 `data.items` 数组、`data.pageInfo` 分页；微信返回专用结构 |
| 内容搜索（固定时间窗） | `POST /api/v2/data/search` | 同上 | 同 v1，另需 `timeWindow` |
| 社交内容搜索（Twitter） | `POST /api/v1/data/social/search` | twitter + `social.content.search` | 只支持 Twitter，每次一页。返回 `data.items` 与 `raw_info`、`raw_data` 字符串 |
| 账号内容 | `POST /api/v1/data/social/crawl` | 目标平台 + `social.content.crawl` | 按已知账号取内容。返回 `data.items` 数组、`raw_info`、`raw_data` 字符串、`data.pageInfo` |
| 账号资料 | `POST /api/v1/data/social/user-info` | 目标平台 + `social.profile.get` | 按已知账号取资料（不是按关键词搜账号） |
| 帖子评论 | `POST /api/v1/data/social/post-comments` | 目标平台 + `social.comments.list` | 按帖子 ID 取一级评论，每条带 `replyRef`；分页在 `data.page` |
| 评论回复 | `POST /api/v1/data/social/comment-replies` | 目标平台 + `social.comments.list` | 按评论 ID 取楼中楼回复；分页在 `data.page` |
| 兼容业务接口 | `POST /api/v1/search/{operation}`、`POST /api/v1/night-all/search/{operation}` | 目标平台；小红书另需对应能力 | operation 为 raw、crawl、user-info、post-detail、post-comments。`data.raw_info`、`data.raw_data` 是 JSON 字符串，分页在 `data.page` |
| 微信搜索（旧路径） | `POST /api/v1/search/raw`，platform 为 wechat_search 或 wechat_mp | `social` + `native.wechat.search.search` | 返回微信专用结构，不返回 raw_data 字符串 |

平台支持：

| 平台 | 内容搜索 | 账号内容 | 账号资料 | 帖子评论 | 评论回复 |
| --- | --- | --- | --- | --- | --- |
| twitter | ✓ | ✓ | ✓ | ✓ | ✓ |
| facebook | ✓ | ✓ | ✓ | ✓ | — |
| instagram | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| tiktok | ✓ | ✓ | ✓ | ✓ | — |
| youtube | ✓ | ✓ | ✓ | ✓ | — |
| reddit | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| linkedin | — | ✓ | ✓ | ✓ | — |
| threads | ✓ | ✓ | ✓ | ✓ | ✓ |
| douyin | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| kuaishou | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| xiaohongshu | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| weibo | ✓ | ✓ | ✓ | ✓ | ✓ |
| bilibili | ✓ | ✓ | ✓ | ✓ | ✓（需 contentId） |
| zhihu | ✓ | ✓ | ✓ | ✓ | ✓ |
| wechat_search、wechat_mp | ✓（专用结构） | — | — | — | — |
| telegram | ✓（Hub 已收录数据） | — | — | — | — |

「✓」表示接口已实现，某个 Key 能不能调用以它的授权为准。

## 二、调用方式

### 1. 环境变量

```bash
export HUB_URL="https://hub.minsight-ai.com"
export HUB_KEY="<Hub API Key>"
```

### 2. 请求头

| 请求头 | 必填 | 说明 |
| --- | --- | --- |
| `Authorization: Bearer $HUB_KEY` | 是 | 也可用 `x-api-key`，两者只传一个 |
| `Content-Type: application/json` | 是 | |
| `Idempotency-Key` | 是 | 8–128 字符。新请求（包括下一页）用新键；同一请求重试用原键和完全相同的请求体，不重复采集、不重复扣费 |

### 3. 关键规则

- 一次请求只查一个平台。
- 首页不传 `cursor`；下一页把返回的 `nextCursor` 原样放进顶层 `cursor`，其他字段不变，换新的 Idempotency-Key。
- 游标 24 小时有效，最多 15 页，绑定 Key 和查询条件，不同接口之间不能互换。
- 页大小是上限，不保证条数。只在 `nextCursor` 非空时继续翻页；`hasMore=null` 表示不确定，不要自动循环。
- 默认会连续调用上游直到凑满页大小。请求体加 `"fillPage": false` 后，每次请求最多取一页上游结果就返回，见第三节第 4 小节。
- 指标未提供为 `null`，真实为 0 才是 `0`。
- 超时或 5xx 不代表没扣费、没调用上游。先查请求状态（第八节），不要直接换新键重发。

### 4. 错误响应

所有接口相同，判断看 `error.code`：

```json
{
  "error": { "code": "comment_acquisition_paused", "message": "Comment acquisition is paused for this platform", "details": { "platform": "douyin" } },
  "requestId": "0a3c1d7e-5b6f-4d2a-9c8e-1f2b3c4d5e6f"
}
```

响应头 `x-mx-insight-request-id` 是本次请求的 ID；429、503 可能带 `retry-after`（秒）。

## 三、内容搜索

### 1. 统一内容搜索 `POST /api/v1/data/search`

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 单个平台，见平台表 |
| `query` | string | 是 | 关键词，1–500 字 |
| `pageSize` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.pageInfo.nextCursor` |
| `type` | string | 否 | `fresh`（默认，同键 120 秒内重放）或 `stable`（同键永久重放第一次结果） |
| `params` | object | 否 | 平台筛选条件，见下表 |

params：

| 平台 | 字段 | 说明 |
| --- | --- | --- |
| twitter | `category`、`filters`、`includeTimestamp` | category：Top、Latest（默认）、Photos、Videos；filters 最多 2048 字；includeTimestamp 默认 false |
| facebook | `startTime`、`endTime` 或 `startDate`、`endDate` | 按日期精度过滤 |
| bilibili | `order`、`duration`、`pubtime_begin_s`、`pubtime_end_s` | 时间为秒级时间戳 |
| douyin | `sort_type`、`publish_time`、`filter_duration`、`content_type` | |
| kuaishou | `sort_type`、`publish_time`、`duration` | |
| zhihu | `show_all_topics`、`search_source`、`sort` | |
| reddit、youtube、tiktok、threads | 不支持 | 传 params（包括空对象）返回 400 |

cURL：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "platform": "twitter",
    "query": "AI agent",
    "pageSize": 20,
    "type": "stable",
    "params": { "category": "Latest" }
  }'
```

翻页（同一查询的下一页）：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "platform": "twitter",
    "query": "AI agent",
    "pageSize": 20,
    "type": "stable",
    "params": { "category": "Latest" },
    "cursor": "<上一页 data.pageInfo.nextCursor>"
  }'
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `requestId` | 请求 ID，排查用 |
| `data.contractVersion` | 固定 `night-all.data-search.v1` |
| `data.platform`、`data.query` | 平台、规范化后的关键词 |
| `data.items[]` | 本页内容 |
| `data.pageInfo.returnedCount` | 本页条数 |
| `data.pageInfo.hasMore` | true 有下一页；false 已结束；null 不确定 |
| `data.pageInfo.nextCursor` | 下一页游标，没有时为 null |
| `data.status` | `ok` 完整；`partial` 有下一页或有 warnings |
| `data.warnings[]` | 非致命提示 `{code, message}` |
| `data.meta.providerCalls` | 本次实际调用外部接口次数；0 表示来自已采购余量或重放 |

`data.items[]`：

| 字段 | 说明 |
| --- | --- |
| `id` | Hub 内条目 ID |
| `externalId` | 平台原始 ID |
| `contentType` | post、video、note、article 等 |
| `url` | 原文链接 |
| `title` | 标题；twitter、facebook、weibo、instagram 普通帖子为 null |
| `text` | 完整正文 |
| `publishedAt` | 发布时间 ISO 8601（UTC）；只有相对时间时为 null |
| `collectedAt` | 采集时间 |
| `author` | `id`、`name`、`avatarUrl` |
| `metrics` | 常见 `likes`、`comments`、`shares`、`views`、`bookmarks` |
| `media` | `coverUrl` 封面、`images` 图片、`videos` 视频 |

要点：

- 微信（wechat_search、wechat_mp）返回专用结构：顶层 `contractVersion`、`endpoint`、`data`、`meta`、`requestId`。传 `params.raw=false` 后读 `data.items`；`data.categories` 是分类导航不是结果；翻页读 `data.continue_flag` 和 `data.cursor`。
- telegram 检索 Hub 已收录的数据，不实时采集。
- 旧 `mxnc1` 游标返回 `409 search_restart_required`，去掉 cursor、换新键从第一页查。

### 2. 固定时间窗 `POST /api/v2/data/search`

字段同 v1，另外必填 `timeWindow`：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `timeWindow.from` | 是 | 开始时间，ISO 8601，带时区 |
| `timeWindow.to` | 是 | 结束时间，晚于 from |
| `timeWindow.timezone` | 是 | IANA 时区，如 `Asia/Shanghai` |
| `timeWindow.boundary` | 是 | 固定 `[from,to)` |

```bash
curl -sS -X POST "$HUB_URL/api/v2/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "platform": "facebook",
    "query": "regional cooperation",
    "pageSize": 20,
    "type": "stable",
    "timeWindow": {
      "from": "2026-10-16T08:00:00.000+08:00",
      "to": "2026-10-17T08:00:00.000+08:00",
      "timezone": "Asia/Shanghai",
      "boundary": "[from,to)"
    }
  }'
```

要点：v2 游标与 v1 不能互换。平台不支持时间窗返回 `422 search_v2_platform_unsupported`；同一查询仍在执行返回 `409 search_admission_blocked`，`details.retrySameRequest=true` 时可在 `retryAfterSeconds` 后用原键重试。

### 3. 社交内容搜索（Twitter）`POST /api/v1/data/social/search`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `twitter` 或 `x` |
| `query` | string | 是 | 关键词或 Twitter 查询表达式（可用 `keyword`，两者同时传须相同） |
| `sort` | string | 否 | `latest`（默认）或 `top` |
| `count` | integer | 否 | 1–50，默认 20（别名 `pageSize`、`limit`） |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "twitter", "query": "AI feature update", "sort": "latest", "count": 20 }'
```

返回 `contractVersion=mx-insight-hub.social-data.v1`，`data` 含 `items`、`raw_info`、`raw_data`、`page`、`pageInfo`、`meta`、`status`，字段同账号内容（第四节）。要点：每次只采一页，不自动补页；游标不能与 `/data/search` 互换。新接入建议用统一内容搜索。

### 4. 单次返回（`fillPage=false`，2026-11-11）

内容搜索（v1、v2）、账号内容、帖子评论、评论回复、YouTube 评论都支持在请求体里加 `"fillPage": false`。加了以后，Hub 每次请求最多取一页上游结果就返回，避免为凑满页连续调用上游而超时；不传或传 `true` 时行为不变。

- 本页条数可能少于 pageSize，也可能为 0；只按 `nextCursor` 是否为空决定是否继续翻页。
- 两种模式的游标可以互相接着用；同一个 Idempotency-Key 不能同时用于两种模式，否则返回 `409 idempotency_conflict`。
- 非布尔值返回 `400 invalid_fill_page`；走旧兼容通道的平台返回 `400 fill_page_unsupported`；兼容接口（第六节）不支持此字段。
- 各接口、各平台的具体行为和仍会发生的额外调用，见《Hub 策略搜索单次返回接口说明》。

## 四、账号

### 1. 账号内容 `POST /api/v1/data/social/crawl`

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 单个平台 |
| `username` / `usernames` | string / array | 账号字段至少一个 | 用户名，列表最多 100 个且同平台 |
| `userId` / `userIds` / `user_id` / `uid` | string / array | 同上 | 平台账号 ID，数字 ID 用字符串传 |
| `url` / `urls` / `profileUrl` / `profile_url` | string / array | 同上 | 平台公开主页链接 |
| `channelId` / `channel_id` / `channelUrl` / `channel_url` | string | 同上 | 频道 ID 或链接（YouTube 等） |
| `activityTypes` | array | 否 | 默认 `["posts"]`，可选值见下表 |
| `count` | integer | 否 | 1–500，默认 20，受 Key 上限约束（别名 `pageSize`、`page_size`、`limit`） |
| `cursor` | string | 否 | 上一页 `data.pageInfo.nextCursor` |
| `params` | object | 否 | 仅该平台已声明的业务参数 |

activityTypes：

| 平台 | 可选值 |
| --- | --- |
| twitter | `posts`、`replies`（该账号自己发的回复） |
| threads | `posts`、`replies`（该账号自己发的回复）、`reposts` |
| instagram | `posts`、`reels`、`stories`、`tagged_posts`、`highlights`、`followers`、`following` |
| tiktok | `posts`、`likes`、`reposts` |
| reddit | `posts`、`comments` |
| linkedin | `posts`、`company_posts` |
| douyin、xiaohongshu | `posts`、`likes` |
| weibo | `posts`、`original_posts` |
| zhihu | `posts`、`answers` |
| facebook、youtube、kuaishou、bilibili | `posts` |

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/crawl" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "douyin", "username": "<平台账号>", "count": 20, "activityTypes": ["posts"] }'
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `contractVersion` | `mx-insight-hub.social-compat.v1` |
| `requestId` | 请求 ID |
| `data.items[]` | 本页条目数组。posts 等为内容；followers、following 为账号 |
| `data.raw_info` | 账号资料数组的 JSON 字符串 |
| `data.raw_data` | 本页条目数组的 JSON 字符串（兼容旧接口） |
| `data.pageInfo` | `page`、`pageSize`、`returnedCount`、`hasMore`、`nextCursor`（`data.page` 相同） |
| `data.status` | `ok` 或 `partial` |
| `data.warnings[]` | 非致命提示 |
| `data.meta.providerCalls` | 本次外部调用次数 |
| `data.mode`、`data.results[]` | 多账号或多活动时出现：`mode=batch`，results 为逐个账号/活动的结果 |

内容条目常用字段：

| 字段 | 说明 |
| --- | --- |
| `id`、`content_id` | 内容 ID |
| `text`、`content`、`full_text` | 正文 |
| `title` | 标题，可为 null |
| `content_type`、`activityType` | 内容类型、来源活动 |
| `author_id`、`author_name`、`author_avatar_url` | 作者 |
| `url` | 链接 |
| `like_count`、`comment_count`、`share_count`、`view_count`、`collect_count` | 指标，未提供为 null |
| `image_urls`、`video_urls` | 图片、视频 URL 数组的 JSON 字符串，空为 `"[]"` |
| `collected_at` | 采集时间 |

要点：

- `items` 已是数组，直接用；`raw_info`、`raw_data` 是字符串，要先 `JSON.parse`。
- Twitter 账号识别：1–19 位纯数字先按 ID 查，查无账号再按同名用户名查一次；只想按数字用户名查请加 `@`。
- 条数少于 count 不代表结束，看 `nextCursor`。

### 2. 账号资料 `POST /api/v1/data/social/user-info`

字段同账号内容，没有 `activityTypes`。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/user-info" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "twitter", "username": "openai" }'
```

资料在 `data.items[]` 和 `data.raw_info`，`data.raw_data` 固定 `"[]"`：

| 字段 | 说明 |
| --- | --- |
| `user_id` | 平台账号 ID |
| `username`、`name`、`nickname` | 用户名、显示名 |
| `description` | 简介 |
| `avatar_url` | 头像 |
| `url` | 主页链接 |
| `followers_count` | 粉丝数 |
| `following_count` | 关注数 |
| `statuses_count` | 发帖数 |
| `verified` | 是否认证，可为 null |
| `location` | 所在地 |
| `collected_at` | 采集时间 |

要点：Twitter 账号不存在返回 `404 social_account_not_found`；被封、注销、受保护返回 `422 social_account_unavailable`，原因看 `error.details.reason`。都不是空结果，不要重试。

## 五、评论

帖子评论和评论回复遇到 `502 external_platform_rejected` 时，原 `Idempotency-Key` 会回放已保存的失败。新回执的 `error.details.upstream` 提供数据源的 `httpStatus` 和 `businessCode`，缺失的值为 `null`。管理员可以从产品展示打开原请求诊断。页面提供「重新查询（按新请求计费）」时，点击会用相同参数和新标识发送一次查询，按当前账户价格计量。对于结果未知的请求，请保留原标识核对状态。

### 1. 帖子评论 `POST /api/v1/data/social/post-comments`

旧路径 `/api/v1/search/post-comments`、`/api/v1/night-all/search/post-comments` 是同一个接口。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | 支持别名 x、xhs、小红书、抖音、快手、知乎、微博、b站 |
| `contentId` | string | contentId 或 url 二选一 | 帖子 ID（推荐），格式见下表 |
| `url` | string | 同上 | 规范帖子链接；短链接不解析 |
| `count` | integer | 否 | 1–100，默认 20（别名 `limit`、`pageSize`） |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |
| `includeRaw` | boolean | 否 | 默认 false；true 时每条附带来源原始对象 `raw` |

`postId`、`noteId`、`awemeId`、`tweetId`、`videoId`、`content_id` 等都是 contentId 的别名，同时传多个时必须指向同一帖子。

contentId 格式：

| 平台 | contentId |
| --- | --- |
| bilibili | AV 号或 BV 号 |
| instagram | shortcode 或数字媒体 ID |
| zhihu | 回答 ID |
| reddit | 帖子 ID，可带 `t3_` |
| linkedin | activity ID |
| threads | 数字帖子 ID 或短码 |
| 其他 | 平台帖子、视频或笔记 ID |

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/post-comments" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "douyin", "contentId": "7290000000000000000", "count": 20 }'
```

返回示例：

```json
{
  "contractVersion": "mx-insight-hub.post-comments.v1",
  "requestId": "0a3c1d7e-5b6f-4d2a-9c8e-1f2b3c4d5e6f",
  "data": {
    "platform": "douyin",
    "postId": "7290000000000000000",
    "items": [
      {
        "id": "douyin:comment:7300000000000000001",
        "commentId": "7300000000000000001",
        "contentId": "7290000000000000000",
        "type": "comment",
        "text": "完整评论正文",
        "author": { "id": "1234567890", "name": "评论作者", "avatarUrl": "https://example.com/avatar.jpg" },
        "publishedAt": "2026-11-06T08:00:00.000Z",
        "likeCount": 12,
        "replyCount": 3,
        "metrics": { "likes": 12, "replies": 3 },
        "replyRef": { "platform": "douyin", "commentId": "7300000000000000001", "contentId": "7290000000000000000" }
      }
    ],
    "page": { "page": 1, "pageSize": 20, "returnedCount": 1, "hasMore": true, "nextCursor": "mxds1.…", "paginationStatus": "continuable" },
    "status": "partial",
    "warnings": [],
    "meta": { "providerCalls": 1, "upstreamPages": 1, "maxUpstreamPages": 15 }
  }
}
```

评论条目字段：

| 字段 | 说明 |
| --- | --- |
| `id` | Hub 稳定 ID，`{platform}:comment:{commentId}` |
| `commentId` | 平台评论 ID，查回复用 |
| `contentId`、`postId` | 所属帖子 ID |
| `parentCommentId` | 一级评论为 null |
| `type` | 固定 `comment` |
| `text` | 完整正文；纯图片或贴纸评论可能为 null |
| `author` | `id`、`name`、`avatarUrl`，部分平台有 `handle`、`profileUrl` |
| `publishedAt` | 发布时间 ISO 8601（UTC）；只有相对时间时为 null，原文在 `publishedTime` |
| `likeCount` | 点赞数，未提供为 null |
| `replyCount` | 平台显示的回复总数，不是本页返回的回复 |
| `metrics` | `likes`、`replies`；Reddit 另有 `score`，Twitter 另有 `shares`、`views`、`bookmarks`、`quotes` |
| `media` | 评论图片或贴纸 `{type, url}` |
| `replyRef` | `{platform, commentId, contentId}`，原样传给评论回复接口 |
| `raw` | 仅 `includeRaw=true` |

分页 `data.page`：

| 字段 | 说明 |
| --- | --- |
| `returnedCount` | 本页条数 |
| `duplicateCount` | 跨页去重丢掉的条数 |
| `hasMore` | true 有下一页；false 已结束；null 不确定 |
| `nextCursor` | 下一页游标 |
| `paginationStatus` | `continuable` 可继续；`exhausted` 已结束；`unknown` 不确定；`limit_reached` 已到 15 页上限 |

要点：

- Twitter、Reddit、快手、微博每次只取一个来源页，条数可能少于 count。
- 只有 `paginationStatus=exhausted` 才是确认结束。
- 每个成功返回的页计费一次，同键重放不重复计费。

### 2. 评论回复 `POST /api/v1/data/social/comment-replies`

最简单的用法：把帖子评论返回的 `replyRef` 原样传入。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `replyRef` | object | 推荐 | 帖子评论返回的 `replyRef` |
| `platform` | string | 不传 replyRef 时必填 | |
| `commentId` | string | 不传 replyRef 时必填 | 要查回复的评论 ID |
| `contentId` | string | reddit、xiaohongshu、instagram、douyin、bilibili、kuaishou 必填 | 所属帖子 ID |
| `count` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |
| `includeRaw` | boolean | 否 | 默认 false |

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/comment-replies" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{
    "replyRef": { "platform": "douyin", "commentId": "7300000000000000001", "contentId": "7290000000000000000" },
    "count": 20
  }'
```

返回结构同帖子评论，区别：

| 字段 | 说明 |
| --- | --- |
| `contractVersion` | `mx-insight-hub.comment-replies.v1` |
| `data.commentId` | 被查询的评论 ID |
| `items[].type` | 固定 `reply` |
| `items[].rootCommentId` | 被查询的评论 ID |
| `items[].parentCommentId` | 直接回复的那条评论 ID，未知为 null |
| `items[].replyRef` | 回复条目没有 |

## 六、兼容业务接口（旧客户端）

`POST /api/v1/search/{operation}` 与 `POST /api/v1/night-all/search/{operation}` 是同一个服务：换路径不会多采一次，也不要换 Idempotency-Key。新接入请用前面的接口。

| operation | 核心字段 | 平台 |
| --- | --- | --- |
| `raw` | `platform` + `keyword`（或 `query`；批量用 `keywords`） | bilibili、douyin、facebook、instagram、kuaishou、reddit、tiktok、twitter、weibo、xiaohongshu、youtube、zhihu |
| `crawl` | `platform` + 账号字段（同第四节），可选 `activityTypes` | douyin、facebook、instagram、linkedin、reddit、tiktok、twitter、weibo、xiaohongshu、youtube |
| `user-info` | `platform` + 账号字段 | douyin、facebook、instagram、linkedin、twitter、weibo、xiaohongshu、zhihu |
| `post-detail` | `platform` + `postId`、`contentId` 或 `url` | douyin、weibo、zhihu、xiaohongshu、twitter、reddit、tiktok、instagram、facebook、linkedin、youtube、xianyu |
| `post-comments` | 同第五节帖子评论 | 同第五节 |

通用字段：`count`（别名 `pageSize`、`limit`，受 Key 上限约束）、`cursor`（上一页 `data.page.nextCursor`）、`params`（首页可带平台筛选）、`businessId`（可省略，传了必须等于 Key 绑定值）。`includeRaw` 只接受 false。

```bash
curl -sS -X POST "$HUB_URL/api/v1/night-all/search/raw" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "xiaohongshu", "keyword": "AI Agent", "count": 20 }'
```

返回字段：

| 字段 | 说明 |
| --- | --- |
| `data.raw_info` | JSON 字符串，账号资料数组 |
| `data.raw_data` | JSON 字符串，内容或评论数组 |
| `data.page` | `hasMore`、`nextCursor`、`returnedCount`、`nextParams` |
| `data.meta` | `resultCount` 本页条数、`duplicateCount` 去重条数 |
| `data.warnings[]` | 提示；`COUNT_DECLARATION_MISMATCH` 表示声明条数与实际不符，以 raw_data 数组长度为准 |

要点：

- `raw_info`、`raw_data` 是字符串，要先 `JSON.parse`，不能整个当成一条内容。
- 显式要求补详情或补评论（`includeDetails`、`includeComments` 等）返回 `400 content_search_option_unsupported`。
- 微信：`/api/v1/search/raw` 的 wechat_search、wechat_mp 进入微信新结构（同第三节微信说明）；`/api/v1/night-all/search/raw` 的微信分支已退役，返回 `410 wechat_search_route_retired`。

## 七、错误码

### 1. 按状态码

| HTTP | 含义 | 是否已调用上游 | 处理 |
| --- | --- | --- | --- |
| 400 | 参数、游标或幂等键错误 | 否 | 改请求，不要原样重试 |
| 401 | Key 缺失或无效 | 否 | 检查 Key |
| 402 | 余额不足 | 否 | 充值后再请求 |
| 403 | 缺平台或接口授权 | 否 | 申请授权 |
| 404、422 | 账号不存在或不可用 | 是 | 按业务处理，不要重试 |
| 409 | 幂等冲突、同键请求仍在执行或结果未知 | 视情况 | 查请求状态，不要换键盲重试 |
| 410 | 游标失效或入口已退役 | 否 | 从第一页重查或换接口 |
| 429 | 配额、限流或预算用尽 | 多数否 | 按 `retry-after` 等待 |
| 502 | 上游拒绝、返回不可用或结果未知 | 是 | 查请求状态；是否结算以请求状态和账单为准 |
| 503 | 暂停、未配置、未校准、缺价、熔断、超时，大多在派发前返回 | 多数否 | 看 `error.code` |

计费：200 成功计费（内容搜索按请求，评论和回复按页），同键重放不重复计费；400、401、402、403、429 和派发前的 503 不计费；502 和结果未知以请求状态和账单为准。

### 2. 通用错误码

| HTTP | 错误码 | 含义 | 处理 |
| --- | --- | --- | --- |
| 400 | `idempotency_key_required` | 没传 Idempotency-Key | 加请求头 |
| 400 | `invalid_idempotency_key` | 键不是 8–128 字符 | 改键 |
| 400 | `invalid_request` | 请求体不合法 | 对照字段表 |
| 400 | `unsupported_fields` | 有不认识的字段（如把旧接口的 count 传给 data/search） | 删掉多余字段 |
| 400 | `invalid_platform` | 平台名无效 | 改平台名 |
| 400 | `platform_operation_unsupported` | 该平台不支持此接口 | 看平台表 |
| 400 | `invalid_page_size`、`page_size_exceeded` | 页大小越界或超过 Key 上限 | 调小 |
| 400 | `invalid_cursor` | 游标跨接口、跨 Key、被改写，或是只能重放的历史游标 | 原样用本接口的 nextCursor；不行就从第一页查 |
| 400 | `cursor_scope_mismatch` | 游标与本次平台、查询或页大小不一致 | 翻页时其他字段保持不变 |
| 400 | `business_id_mismatch` | businessId 与 Key 绑定值不一致 | 去掉 businessId |
| 400 | `work_budget_exceeded` | 批量账号或关键词太多 | 拆成多个请求 |
| 401 | `api_key_required`、`invalid_api_key` | 没传 Key 或 Key 无效 | 检查 Key |
| 402 | `insufficient_credit` | 余额不足 | 充值 |
| 403 | `platform_not_granted` | 没有平台授权 | 申请授权 |
| 403 | `capability_not_granted` | 没有接口授权（如 `social.comments.list`） | 申请授权 |
| 403 | `test_key_not_supported` | 测试 Key 不能实时采集 | 用正式 Key |
| 409 | `idempotency_conflict` | 同一键用于不同请求体或路径 | 新请求换新键 |
| 409 | `request_in_progress` | 同键请求还在执行 | 稍后用原键重试，或查状态 |
| 409 | `request_outcome_unknown` | 同键前次结果未知 | 查状态，不要换键重发 |
| 409 | `search_page_unavailable` | 保存的页面已丢失 | 从第一页重查 |
| 409 | `external_platform_response_unusable` | 相同请求上游已接受但解析失败，不再自动重试 | 带 requestId 找开发 |
| 429 | `consumer_quota_exceeded`、`api_key_quota_exceeded` | 用户或 Key 配额用尽 | 等配额恢复 |
| 429 | `plan_window_quota_exceeded`、`plan_month_quota_exceeded`、`plan_burst_exceeded` | 套餐时间窗、月度或突发上限 | 等待或升级套餐 |
| 429 | `external_platform_rate_limited` | 上游共享限流 | 按 retry-after 等待 |
| 429 | `external_platform_capacity_exceeded` | 并发已满 | 稍后重试 |
| 429 | `external_platform_cost_budget_exhausted`、`external_platform_subsidy_budget_exhausted` | 采购或补贴预算用尽 | 联系管理员 |
| 429、503 | `external_platform_busy` | 排队满或等待超时 | 按 retry-after 等待 |
| 502 | `external_platform_rejected` | 上游明确拒绝 | 查请求状态与诊断 |
| 502 | `external_platform_outcome_unknown`、`upstream_outcome_unknown` | 上游结果未知，可能已产生成本 | 查状态，不要自动重发 |
| 502 | `external_platform_response_unusable` | 上游返回无法解析 | 查诊断 |
| 503 | `external_platform_not_configured` | 没有可用凭据 | 管理端配置凭据 |
| 503 | `external_platform_contract_unverified` | 当前供应商未校准，派发前拒绝、不计费 | 管理端换已校准供应商 |
| 503 | `external_platform_circuit_open` | 熔断中 | 等待恢复 |
| 503 | `external_platform_unavailable`、`external_platform_capacity_unavailable` | 供应商或账号容量不可用 | 看 `error.details.reasonCode` |
| 503 | `external_platform_cost_control_unavailable`、`external_platform_cost_evidence_incomplete` | 该操作没有价格或成本证据 | 管理端补价格 |
| 503 | `external_platform_operation_disabled`、`_shadow`、`_paused`、`_canary`、`_blocked` | 操作被停用、影子、暂停、灰度或前置条件拦截 | 管理端「上游平台操作控制」 |
| 503 | `strategy_search_route_unavailable` | 路由配置读不到，或所选供应商不支持该平台 | 管理端检查策略 |

### 3. 各接口专有错误码

| HTTP | 错误码 | 接口 | 含义 | 处理 |
| --- | --- | --- | --- | --- |
| 400 | `invalid_query` | 内容搜索 | query 为空或超长 | 改关键词 |
| 400 | `invalid_twitter_search_parameters` | 内容搜索 | Twitter params 有未知字段、People 或非法值 | 对照 params 表 |
| 400 | `twitter_search_parameters_unsupported` | 内容搜索 | 当前路由无法保留所选条件，派发前拒绝 | 去掉该条件 |
| 400 | `content_search_option_unsupported` | 内容搜索、兼容 | 平台不支持此筛选或补详情/补评论 | 删掉该字段 |
| 400 | `content_search_pagination_unsupported` | 内容搜索、兼容 | 不支持此分页方式 | 用 cursor 翻页 |
| 409 | `search_restart_required` | 内容搜索、兼容 | 旧游标不能发起新采集 | 去掉 cursor、换新键从第一页查 |
| 409 | `search_admission_blocked` | 内容搜索 v2 | 同一查询仍在执行 | 按 `retryAfterSeconds` 用原键重试 |
| 410 | `search_cursor_expired` | 内容搜索 | 游标过期 | 从第一页重查 |
| 410 | `wechat_search_route_retired` | 兼容 | `/night-all/search/raw` 微信分支已退役 | 改用 `/data/search` |
| 422 | `search_v2_platform_unsupported` | 内容搜索 v2 | 平台不支持时间窗 | 改用 v1 |
| 502 | `social_upstream_rejected`、`social_upstream_outcome_unknown`、`social_upstream_response_unusable` | 社交内容搜索 | 上游拒绝、结果未知或无法解析 | 查请求状态 |
| 502 | `night_all_rejected` | 兼容 | 旧链路明确拒绝（也可能是 400/404/409/422/429） | 看 status 与 details |
| 503 | `strategy_search_paused` | 内容搜索 | 管理端暂停了该平台（Instagram、Twitter） | 管理端恢复 |
| 503 | `facebook_search_paused`、`facebook_quota_state_unavailable` | 内容搜索 | Facebook 搜索暂停或额度状态读不到 | 管理端处理或稍后重试 |
| 503 | `content_search_deadline`、`twitter_fill_deadline` | 内容搜索 | 截止时间内未完成 | 稍后用原键重试 |
| 503 | `content_search_unavailable`、`search_cursor_unavailable` | 内容搜索 | 暂不可用 | 稍后用原键原游标重试 |
| 503 | `platform_operation_unavailable`、`compatibility_store_unavailable`、`compatibility_capabilities_unavailable` | 兼容 | 兼容链路暂不可用 | 稍后重试 |
| 400 | `invalid_social_request` | 账号 | 账号参数不合法，看 `details.field`、`details.reason` | 改参数 |
| 400 | `invalid_user_profile_url` | 账号、兼容 | 小红书主页链接不是官方域名 | 用官方主页链接 |
| 404 | `social_account_not_found`、`user_not_found` | 账号、兼容 | 账号不存在 | 核对账号 |
| 422 | `social_account_unavailable` | 账号 | 账号被封、注销、受保护等，看 `details.reason` | 按业务处理 |
| 503 | `facebook_account_paused` | 账号 | Facebook 账号内容或资料被暂停 | 管理端恢复 |
| 503 | `social_data_unavailable`、`social_search_deadline` | 账号 | 未就绪，或截止时间内一页都没取到 | 稍后重试 |
| 503 | `request_outcome_unknown` | 账号 | 账号采集结果未知 | 查请求状态 |
| 400 | `invalid_post_comments_request` | 帖子评论 | 缺 contentId、多个 ID 不一致、count 越界等 | 改参数 |
| 400 | `invalid_comment_replies_request` | 评论回复 | 缺 commentId，或需要 contentId 的平台没传 | 直接传 replyRef |
| 502 | `invalid_upstream_contract` | 评论、回复 | 来源结构不符合合同，不计费 | 带 requestId 找开发 |
| 503 | `comment_acquisition_paused` | 评论、回复 | 管理端暂停了该平台；已保存结果仍可重放 | 管理端恢复 |

## 八、排查

先记下三样：`requestId`（或响应头 `x-mx-insight-request-id`）、发送时的 `Idempotency-Key`、完整请求体。以下查询只读，不计费、不调用上游。

查请求状态：

```bash
curl -sS "$HUB_URL/api/v1/requests/<requestId>" \
  -H "Authorization: Bearer $HUB_KEY"
```

没拿到 requestId 时用幂等键查：

```bash
curl -sS "$HUB_URL/api/v1/requests/by-idempotency-key" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Idempotency-Key: <原 Idempotency-Key>"
```

取回当时交付的原始响应（必须用创建请求的同一把 Key）：

```bash
curl -sS "$HUB_URL/api/v1/acquisitions/<requestId>" \
  -H "Authorization: Bearer $HUB_KEY"
```

`data.status` 含义：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `reserved` | 还在执行，或中断后未清理 | 等待，不要重发 |
| `committed` | 已完成（可能是错误响应，看 `errorCode`） | 同键同请求体可重放；用 acquisitions 取原响应 |
| `released` | 没有交付，预留已释放 | 需要的话换新键重发 |
| `unknown` | 结果未知，可能已调用上游 | 不要自动重发；确需重采时换新键（Twitter 内容搜索另带 `X-MX-Insight-Retry-Of: <原 requestId>`） |

管理端可查上游调用、供应商与失败证据（requestId 或上游请求 ID 都可以）：

```bash
curl -sS "$HUB_ADMIN_URL/internal/v1/admin/request-diagnostics/<requestId>" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN"
```

常见现象：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 条数少于 pageSize 或 count | 页大小是上限；部分平台每次只取一个来源页 | 有 nextCursor 就继续翻 |
| `hasMore=null` 或 `paginationStatus=unknown` | 无法确认还有没有 | 不要自动循环 |
| 指标是 null | 平台没提供 | 显示「未知」，不要当 0 统计 |
| 评论 `publishedAt` 为 null | 平台只给相对时间 | 看 `publishedTime` |
| 换接口后 `invalid_cursor` | 游标不能跨接口、跨 Key | 从第一页查 |
| `raw_data` 解析不出列表 | 它是 JSON 字符串 | 先 `JSON.parse`，新代码用 `items` |
| 评论 503 `external_platform_contract_unverified` | 当前选中的供应商待校准 | 管理端换已校准供应商 |
| 评论 503 `comment_acquisition_paused` | 策略设为暂停 | 管理端恢复 |
| 503 `external_platform_cost_control_unavailable` | 新操作没配价格 | 管理端补价，或重新部署补默认价 |
| 连续 409 `request_in_progress` | 原请求还在执行 | 等它结束再查状态 |

## 九、管理端策略路由（内部，对外分享时删去）

需要 Admin Token，只影响新的首页请求；已有分页固定在原供应商，不改历史响应和账单。

```bash
export HUB_ADMIN_URL="<Hub 管理端地址>"
export HUB_ADMIN_TOKEN="<Admin Token>"
```

查看全部策略（每个组合的当前路由、可选供应商、校准状态、revision）：

```bash
curl -sS "$HUB_ADMIN_URL/internal/v1/admin/strategy-search" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN"
```

Threads 的五个接口都可切换或暂停，默认 RapidAPI 的 Threads API 优先、TikHub 保底。内容搜索还可单独选用 RapidAPI 的 Threads Scraper；两项订阅和采购价独立，管理端操作见 [Threads 接口手册](threads-api.md)。

修改一个组合（`{interface}` 为 search、crawl、user-info、post-comments、comment-replies）：

```bash
curl -sS -X PUT "$HUB_ADMIN_URL/internal/v1/admin/strategy-search/post-comments/douyin" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "mode": "priority",
    "primaryProvider": "tikhub",
    "fallbackProvider": "justone",
    "expectedRevision": 3,
    "reason": "抖音评论 TikHub 优先，JustOne 保底"
  }'
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `mode` | 是 | `fixed` 只用主供应商；`priority` 主供应商派发前未就绪（凭据、开关、价格）时改用保底，已派发的失败不换；`paused` 停止新采购，已保存结果仍可交付 |
| `primaryProvider` | 是 | 主供应商 |
| `fallbackProvider` | priority 时必填 | 保底供应商，不能与主供应商相同；fixed、paused 传 null |
| `expectedRevision` | 是 | 当前 revision（从 GET 取），防止并发覆盖 |
| `reason` | 是 | 修改原因，1–1000 字 |

调用统计（days 为 1–31）：

```bash
curl -sS "$HUB_ADMIN_URL/internal/v1/admin/strategy-search/usage?days=7" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN"
```

可切换的组合与默认路由（没保存过配置时的路由，线上以 GET 为准）：

| 接口 | 平台 | 可选供应商 | 默认 |
| --- | --- | --- | --- |
| search | instagram | justone、tikhub | fixed：justone |
| search | twitter | rapidapi、tikhub | priority：rapidapi → tikhub |
| crawl、user-info | facebook | justone | fixed：justone |
| post-comments | twitter、reddit、kuaishou、weibo、douyin | tikhub（已验证）、justone（官方样例） | priority：tikhub → justone |
| post-comments | zhihu | tikhub（新接入）、justone（官方样例） | priority：tikhub → justone |
| post-comments | bilibili | justone（官方样例）、tikhub（新接入） | fixed：justone |
| post-comments | instagram、xiaohongshu、youtube | tikhub（已验证） | fixed：tikhub |
| post-comments | tiktok、linkedin、facebook | justone（官方样例） | fixed：justone |
| comment-replies | twitter、douyin、kuaishou、bilibili、instagram | tikhub（已验证） | fixed：tikhub |
| comment-replies | reddit、weibo、xiaohongshu、zhihu | tikhub（新接入） | fixed：tikhub |

「新接入」表示沿用同平台已校准的结构，首个生产页需人工核对。Facebook 内容搜索是独立策略（auto、rapidapi、justone、selfhosted、paused），用 `GET /internal/v1/admin/platform-search-policies` 查看。其他平台的内容搜索是固定路由。

管理端错误码：

| HTTP | 错误码 | 含义 |
| --- | --- | --- |
| 400 | `strategy_search_route_read_only` | 该组合不能切换 |
| 400 | `invalid_strategy_search_route` | 模式、供应商、revision 或原因不合法 |
| 403 | `admin_token_required` | 需要 Admin Token |
| 409 | `strategy_search_route_revision_conflict` | 已被别人改过，刷新后再保存 |
| 503 | `strategy_search_route_unavailable` | 路由配置暂不可用 |
