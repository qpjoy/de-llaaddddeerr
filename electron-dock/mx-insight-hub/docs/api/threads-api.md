# Threads 接口手册

更新于 2026-11-13

策略搜索支持按关键词找帖子、按账号取发帖或资料、按标识取单帖，以及读取评论和回复。策略接口统一使用 `platform: "threads"`。持有该平台授权的 Key 可通过 `GET /api/v1/data/capabilities` 查询平台条目的 `search.ready`。同时拥有 `social.posts.resolve` 授权的 Key 还可读取 `postDetail.ready`。它表示当前 Hub 的搜索路由及操作就绪情况。供应商订阅和上游实时响应要按实际调用核对。

2026-11-13 在 Threads Scraper 实测了三个上游接口。查询 `@threads` 的账号资料成功，账号帖子首页的 24 条会话记录展开为 30 条该作者的帖子，响应含下一页游标。使用该页一个实际短码也成功取得了同一篇帖子的详情。其余六个 Scraper 接口已按公布的参数和本地测试校验，本次未发起真实调用。真实上游验收与整套 Hub 在目标环境部署后的端到端验收是两个步骤。

## 一、接口总览

| 用途 | 接口 | 所需授权（同一个 Key） | 分页 |
| --- | --- | --- | --- |
| 内容搜索 | `POST /api/v1/data/search` | `threads` | `data.pageInfo.nextCursor` |
| 内容搜索（固定时间窗） | `POST /api/v2/data/search` | `threads` | `data.pageInfo.nextCursor` |
| 账号内容 | `POST /api/v1/data/social/crawl` | `threads` + `social.content.crawl` | `data.pageInfo.nextCursor` |
| 账号资料 | `POST /api/v1/data/social/user-info` | `threads` + `social.profile.get` | 无 |
| 帖子详情 | `POST /api/v1/data/social/post-detail` | `threads` + `social.posts.resolve` | 单条 `data.item`，无分页 |
| 帖子评论 | `POST /api/v1/data/social/post-comments` | `threads` + `social.comments.list` | `data.page.nextCursor` |
| 评论回复 | `POST /api/v1/data/social/comment-replies` | `threads` + `social.comments.list` | `data.page.nextCursor` |

通用请求头：`X-API-Key`、`Content-Type: application/json`、`Idempotency-Key`（8–128 位安全字符，同键重放不重复采购）。

每个查询目标和活动每次最多取一个来源内容页。Threads Scraper 按用户名直接读取帖子，旧 Threads API 按用户名查帖子可能另需一次身份解析。可继续读取已购余量或上游提供了有效后续游标时，使用 Hub 返回的 `nextCursor`。供应商未明确说明是否还有下一页、声明有下一页却缺少可用游标，或出现重复游标时，读完已购余量后返回 `hasMore: null` 和 `nextCursor: null`，并附分页警告。达到 Hub 的 15 页上限同样会停止续页。明确结束时返回 `hasMore: false`。TikHub 的 Threads 接口仅提供单页。

## 二、内容搜索

请求字段：

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `query` | string | 是 | 关键词，1–500 字 |
| `pageSize` | integer | 否 | 1–100，默认 20，是上限不是保证 |
| `cursor` | string | 否 | 上一页 `data.pageInfo.nextCursor` |
| `type` | string | 否 | `fresh`（默认）或 `stable` |
| `fillPage` | boolean | 否 | 可传，Threads 始终按单页返回 |

不支持 `params`，传了返回 400。Threads API 使用最新内容搜索；Threads Scraper 保留供应商返回的顺序，不保证按发布时间排序。`/api/v2/data/search` 另需 `timeWindow`，见策略搜索手册。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/search" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-search-$(date +%s)" \
  -d '{"platform":"threads","query":"bitcoin","pageSize":20}'
```

返回：

```json
{
  "data": {
    "contractVersion": "night-all.data-search.v1",
    "platform": "threads",
    "query": "bitcoin",
    "items": [{
      "id": "3587657939753764305",
      "externalId": "3587657939753764305",
      "platform": "threads",
      "contentType": "post",
      "url": "https://www.threads.com/@sample_author/post/DHJ6-NSogXR",
      "title": null,
      "text": "bitcoin sample post",
      "publishedAt": "2025-03-13T21:42:55.000Z",
      "collectedAt": "2026-11-11T00:00:00.000Z",
      "author": { "id": "33022838", "name": "sample_author", "avatarUrl": "https://example.invalid/avatar.jpg" },
      "metrics": { "likes": 7, "comments": 2, "shares": 3, "views": null, "bookmarks": null },
      "media": { "coverUrl": "https://example.invalid/photo.webp", "images": ["https://example.invalid/photo.webp"], "videos": [] },
      "source": { "provider": null, "endpointId": null }
    }],
    "pageInfo": { "pageIndex": 1, "pageSize": 20, "returnedCount": 1, "hasMore": false, "nextCursor": null, "cursorType": "none" },
    "status": "ok",
    "warnings": [],
    "meta": { "capability": "search_posts", "capabilityStatus": "ready", "paginationMode": "cursor", "providerCalls": 1 }
  },
  "requestId": "…"
}
```

字段来源：

| Hub 字段 | Threads 字段 | 说明 |
| --- | --- | --- |
| `externalId` | `post.pk` | 数字帖子 ID，也是评论接口的 `contentId` |
| `text` | `post.caption.text` | 缺失时拼接 `text_post_app_info.text_fragments` |
| `title` | — | Threads 没有标题，恒为 null |
| `url` | `post.code` + `user.username` | `https://www.threads.com/@用户名/post/短码` |
| `publishedAt` | `post.taken_at` | 秒级时间戳转 ISO |
| `author.id` / `author.name` | `user.pk` / `user.full_name` 或 `user.username` | 帖子里通常只有用户名 |
| `author.avatarUrl` | `user.profile_pic_url` | 带签名，会过期 |
| `metrics.likes` | `post.like_count` | |
| `metrics.comments` | `text_post_app_info.direct_reply_count` | |
| `metrics.shares` | `text_post_app_info.repost_count` | |
| `metrics.views` / `metrics.bookmarks` | — | 供应商不提供，恒为 null，不代表 0 |
| `media.images` | `image_versions2.candidates[0]`、`carousel_media` | 视频的海报图不算图片 |
| `media.videos` | `video_versions[0]` | |
| `media.coverUrl` | 首个媒体的图片 | |

## 三、账号内容

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `username` | string | 账号字段至少一个 | 用户名，可带 `@`，大小写不敏感 |
| `userId` / `user_id` / `uid` | string | 同上 | 数字用户 ID，用字符串传 |
| `url` / `profileUrl` | string | 同上 | `https://www.threads.com/@用户名`（`threads.net` 也可） |
| `activityTypes` | array | 否 | 默认 `["posts"]`，可选 `posts`、`replies`、`reposts` |
| `count` | integer | 否 | 1–500，默认 20（别名 `pageSize`、`page_size`、`limit`） |
| `cursor` | string | 否 | 上一页 `data.pageInfo.nextCursor` |

默认 Threads Scraper 接受用户名或公开主页链接，每个账号按用户名读取 `posts`。Hub 展开作者在同一会话中的多条帖子，核对作者并按帖子 ID 去重。请求含数字账号 ID、`replies` 或 `reposts` 时，管理员可配置支持这些条件的 Threads API 或 TikHub。固定 Scraper 时返回 400 `threads_account_input_unsupported`；配置优先与保底时按整批输入检查是否可在派发前改用保底。旧 Threads API 查单个数字 ID 的一种活动通常只需一次上游调用，用户名可能增加一次精确账号解析。`replies` 返回该账号自己发表的回复。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/crawl" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-crawl-$(date +%s)" \
  -d '{"platform":"threads","username":"threads","activityTypes":["posts"],"count":20}'
```

返回 `data.items`（每项结构同其他平台账号内容）、`data.raw_info`、`data.raw_data`（JSON 字符串）、`data.page`、`data.pageInfo`。每项主要字段：

```json
{
  "id": "threads:3423248872904765000",
  "externalId": "3423248872904765000",
  "content_id": "3423248872904765000",
  "platform": "threads",
  "platform_name": "threads",
  "type": "post",
  "objectType": "post",
  "activityType": "posts",
  "text": "own post",
  "content": "own post",
  "url": "https://www.threads.com/@owner_account/post/C-BaaaaaaaA",
  "publishedAt": "2024-07-30T13:59:14.000Z",
  "published_at": 1722347954,
  "collectedAt": "2026-11-11T00:00:00.000Z",
  "collected_at": 1794355200,
  "author": { "id": "60762270900", "name": "owner_account", "avatarUrl": "https://example.invalid/owner.jpg" },
  "metrics": { "likes": 10, "comments": 4, "shares": 5, "views": null, "bookmarks": null },
  "like_count": 10, "comment_count": 4, "share_count": 5, "quote_count": 0,
  "image_urls": "[]", "video_urls": "[]", "coverUrl": null,
  "metadata": "{\"code\":\"C-BaaaaaaaA\",\"isReply\":false,\"replyToUsername\":null}"
}
```

## 四、账号资料

字段同账号内容的账号字段。默认 Threads Scraper 接受用户名或主页链接。按数字 ID 查询须使用 Threads API 或 TikHub。

Threads Scraper 返回 `status: "ok"` 且 `data.user` 为 `null` 表示未找到该账号。单账号查询成功返回空的 `data.items`，批量查询中该账号的 `results[].items` 为空，其他账号的资料照常返回。供应商返回 `status: "error"` 时，业务接口将此次调用记录为上游拒绝。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/user-info" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-profile-$(date +%s)" \
  -d '{"platform":"threads","username":"zuck"}'
```

`data.items[0]` 主要字段：

```json
{
  "id": "threads:63625256886",
  "userId": "63625256886",
  "user_id": "63625256886",
  "username": "sample_news",
  "displayName": "Sample News",
  "name": "Sample News",
  "description": "bio",
  "avatarUrl": "https://example.invalid/profile.jpg",
  "profileUrl": "https://www.threads.com/@sample_news",
  "verified": true,
  "follower_count": 1083901,
  "metrics": { "followers": 1083901, "following": null, "posts": null, "likes": null }
}
```

供应商缺少的指标返回 null，例如该样本中的 `following`、`posts`。保留供应商给出的真实零值。

## 五、帖子详情

`POST /api/v1/data/social/post-detail` 接受一个 `contentId` 或一个 `url`。`contentId` 可以是字符串形式的数字帖子 ID 或 5–32 位短码。`url` 可以是 `threads.com` 或 `threads.net` 的 HTTPS 帖子链接。参数歧义、非 Threads 链接和多余字段返回 400 `invalid_threads_post`。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/post-detail" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{"platform":"threads","contentId":"C8O-JbtAKrp"}'
```

成功响应读取 `data.platform`、`data.item` 和 `requestId`。`data.item` 使用第二节搜索结果的字段，包含帖子 ID、文本、链接、作者、发布时间、指标与媒体。此接口不接受 `cursor` 或 `pageSize`。Scraper 的详情位于 `data.post`，Hub 核对返回的帖子标识后才交付。旧版 Threads API 的详情路径已登记，其详情响应结构仍待该渠道的真实样本验证。

## 六、帖子评论

此业务目前使用 Threads API（threads-api4）或 TikHub，独立于内容搜索的渠道选择。2026-11-14 重新读取 [Threads Scraper 官方当前版本目录](https://rapidapi.com/premium-apis-oanor/api/threads-scraper/playground/apiendpoint_6da30740-4df1-44ab-8341-27877aa001cc)，完整目录仍为第八节的九项操作，没有帖子评论或评论回复接口。`posts/detail` 的互动计数不是评论列表，不能据此提供评论正文或分页。仅订阅 Scraper 不代表已开通这两个评论渠道。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `contentId` | string | contentId 或 url 二选一 | 数字帖子 ID、`pk_用户ID` 或短码（`C8O-JbtAKrp`） |
| `url` | string | 同上 | `https://www.threads.com/@用户/post/短码`，`threads.net` 也可 |
| `count` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |
| `includeRaw` | boolean | 否 | true 时每条附带来源对象 `raw` |

短码和数字 ID 是同一个值的两种写法，Hub 在本地换算。RapidAPI 的非空首页包含被查询的帖子，Hub 会核对其 ID 并从评论中剔除。若供应商返回了另一篇帖子的首页，整页按来源数据错误处理。TikHub 的评论列表可以省略原帖。

TikHub `fetch_post_comments` 的实际返回可以是 `code: 200`、`data.edges[].node.thread_items[].post`，并非只有文档描述的 `comments` 数组。Hub 同时兼容两种格式；按 `node.id` 选择会话条目中的目标回复，过滤被查询的帖子及已识别的上级帖子，再映射正文、作者、发布时间、互动指标与媒体。该结构依据 2026-11-14 已保存响应的字段摘要确认，完整原响应与实际楼中楼数据的线上验收需分别核对。

TikHub 此接口不支持来源分页。即使返回 `page_info.has_next_page: true`，也不会据此发送后续采集；已购页面可按 `count` 分批交付，余量读完后 `hasMore: false`、`nextCursor: null` 只表示本渠道无法继续，并不保证已取得帖子的全部评论。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/post-comments" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-comments-$(date +%s)" \
  -d '{"platform":"threads","contentId":"3390920896561588969","count":20}'
```

`data.items[]`：

```json
{
  "id": "threads:comment:3390930071274677885",
  "commentId": "3390930071274677885",
  "contentId": "3390920896561588969",
  "postId": "3390920896561588969",
  "platform": "threads",
  "type": "comment",
  "text": "first level comment",
  "url": "https://www.threads.com/@commenter/post/C8PAO8UhGZ9",
  "publishedAt": "2024-06-15T11:19:46.000Z",
  "author": { "id": "2116739155", "name": "commenter", "avatarUrl": "https://example.invalid/c.jpg", "handle": "commenter" },
  "parentCommentId": null,
  "likeCount": 3,
  "replyCount": 1,
  "metrics": { "likes": 3, "replies": 1, "shares": 0, "quotes": 0, "views": null, "bookmarks": null },
  "media": [],
  "replyRef": { "platform": "threads", "commentId": "3390930071274677885", "contentId": "3390920896561588969" }
}
```

## 七、评论回复

渠道限制同帖子评论：目前没有已公布的 Scraper 评论回复契约。账号自己发表的回复、帖子的回复数量与某条评论的回复列表是不同数据，不能互相替代。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `replyRef` | object | replyRef 或 commentId 二选一 | 评论条目返回的对象，原样传回 |
| `commentId` | string | 同上 | 评论的数字 ID |
| `contentId` | string | 否 | 所属帖子 ID；提供后回复才会入库 |
| `count` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |

Threads 的回复本身也是帖子，所以用同一个评论接口查询，查询对象和它的上级帖子已剔除。供应商回显直接父级或会话根时，Hub 会用它们核对归属；父级与目标不符或上下文矛盾的页面会被拒绝。返回结构同评论，另有 `type: "reply"`、`rootCommentId`（被查询的评论）、`parentCommentId`（同 `rootCommentId`）。

TikHub 评论和回复共用同一解析器，均支持上述 `data.edges` 结构；查询回复时上游 `post_id` 使用被查询的 `commentId`，并保留 `contentId` 作为所属帖子的上下文。回复同样受 TikHub 单来源页限制。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/comment-replies" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-replies-$(date +%s)" \
  -d '{"platform":"threads","replyRef":{"platform":"threads","commentId":"3390930071274677885","contentId":"3390920896561588969"},"count":20}'
```

## 八、Threads Scraper 原生接口

九项操作均通过同一组 Hub 原生路径调用。将下表的完整后缀分别接在 Hub 路径 `POST /api/v1/data/native/r.threads_scraper_` 和权限名 `native.r.threads_scraper_` 后。同一个 Hub Live Key 需要 `social` 平台授权以及对应的**单项原生权限**。业务接口使用第一节列出的独立业务授权。供应商主机为 `threads-scraper.p.rapidapi.com`，下表路径均为 HTTPS GET。[供应商接口目录](https://rapidapi.com/premium-apis-oanor/api/threads-scraper)

| 原生操作后缀 | 上游路径 | Hub 请求体的 `params` 示例 | 用途与边界 |
| --- | --- | --- | --- |
| `search_posts` | `/api/v1/posts/search` | `{"query":"张婧怡"}` | 关键词找帖子，`results`、可选续页 `cursor`。保持供应商顺序 |
| `user_detail` | `/api/v1/users/detail` | `{"username":"threads"}` | 精确用户名的账号资料。真实样本见 `user` 对象 |
| `user_detail_with_biolink` | `/api/v1/users/detail-with-biolink` | `{"username":"threads"}` | 带简介链接的账号资料。返回的可选字段依账号而异 |
| `search_users` | `/api/v1/users/search` | `{"query":"threads","count":10}` | 搜公开账号。正整数 `count` 可省略，上游默认 10，受 Key 页大小限制 |
| `user_posts` | `/api/v1/users/posts` | `{"username":"threads"}` | 账号帖子，`posts`、可选续页 `cursor`。一条会话记录可能含多个帖子 |
| `post_detail` | `/api/v1/posts/detail` | `{"code":"C8O-JbtAKrp"}` | 按短码或 HTTPS 帖子 `url` 查单帖，数据在 `post` 内 |
| `resolve_post` | `/api/v1/explore/resolve` | `{"reference":"C8O-JbtAKrp"}` | 按短码或完整帖子链接转换标识；成功转换不能证明帖子存在 |
| `post_media` | `/api/v1/explore/post-media` | `{"url":"https://www.threads.com/@example/post/C8O-JbtAKrp"}` | 按短码或 HTTPS 帖子 `url` 获取媒体版本。媒体链接可能过期 |
| `profiles_batch` | `/api/v1/explore/profiles` | `{"usernames":"threads,instagram"}` | 1–3 个不含 @ 的用户名，用逗号分隔。按条检查结果与错误 |

原生用户名使用字母、数字、点和下划线，长度 1–64，不带 @。详情和媒体至少提供一个 `url` 或 `code`；两者均传时供应商优先使用 URL。帖子链接使用 `https://www.threads.com/@用户名/post/短码` 或对应的 `threads.net` 链接。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/native/r.threads_scraper_user_posts" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" -d '{"params":{"username":"threads"}}'
```

Hub 返回 `contractVersion`、`endpoint`、`data`、`meta.capturedAt`、`requestId`。`data` 保留供应商 JSON，所以先判断 `data.status`。HTTP 200 也可能带有 `data.status: "error"`。仅当 `data.status === "ok"` 时读取 `data.data`。以下空列表用于说明结构。

```json
{"contractVersion":"mx-insight-hub.native-forwarding.v1","endpoint":"r.threads_scraper_user_posts","data":{"status":"ok","data":{"posts":[],"cursor":null}},"meta":{"projection":"native","pagination":"explicit_parameters"},"requestId":"…"}
```

只有帖子搜索和账号帖子这两项原生操作接受显式 `params.cursor`。传入上页外层 `data.data.cursor`，保留原查询条件并为新页指定新的幂等键。会话内部的 `edge.cursor`、策略接口的 `nextCursor` 均不能代用。其余七项无游标；`search_users.count` 只限制返回数量。

通过 `GET /api/v1/data/services/pricing?path=/api/v1/data/native/r.threads_scraper_user_posts` 可用当前 Key 查看该操作的 Hub 官方价与账户执行价；查询价格不发起采购。九项操作各有启停、采购价、预算和授权。空列表或供应商在 HTTP 200 中返回业务错误时，按实际账单和原请求收据核对。HTTP 400 检查参数，403 检查 Hub Key 的平台及单项授权，402 检查余额，429 检查限额；502/503 查看请求 ID、实际操作和上游证据。

## 九、渠道、升级与故障诊断（管理端）

| 业务接口 | 默认路由 | Threads Scraper | Threads API（threads-api4） | TikHub |
| --- | --- | --- | --- | --- |
| 内容搜索 | 固定 Scraper | `posts/search` | `/api/search/recent` | `search_posts` |
| 账号内容 | 固定 Scraper | `users/posts`，用户名，仅 posts | `/api/user/{posts,replies,reposts}` | `fetch_user_{posts,replies,reposts}` |
| 账号资料 | 固定 Scraper | `users/detail`，用户名 | `/api/user/info`，按 ID，用户名先精确解析 | `fetch_user_info` / `fetch_user_info_by_id` |
| 帖子详情 | 固定 Scraper | `posts/detail` | `/api/post/detail` | — |
| 帖子评论 | Threads API 优先、TikHub 保底 | — | `/api/post/comments` | `fetch_post_comments` |
| 评论回复 | Threads API 优先、TikHub 保底 | — | `/api/post/comments` | `fetch_post_comments` |

Scraper 在管理端的路由值是 `rapidapi-threads-scraper`，Threads API 是 `rapidapi`，TikHub 是 `tikhub`。标注为默认的路由适用于新建配置和符合条件的升级。两个 RapidAPI 产品共用 Hub 中的 RapidAPI 凭据，但须分别订阅，操作、采购价和诊断记录也分别核对。Scraper 的搜索保留返回顺序，没有“最新优先”排序承诺。评论与回复在另两个渠道购买，Scraper 订阅不包含这些接口。

渠道选择要求（2026-11-14）：Scraper 若提供帖子评论和评论回复，完成官方参数、返回结构与分页校验并接入后，两项均默认使用 Scraper，原渠道保留供管理端切换。当前官方目录不含这两项，因此本次复核没有新增 Scraper 评论选项或修改现有评论策略；这也不代表之后会自动切换生产配置。

1. 迁移 188 建立原有五条业务路由。迁移 189 登记 Scraper 搜索操作。迁移 190 补齐其余八项并登记单帖详情；只将仍为迁移 188 原始 revision 1 的搜索、账号内容和账号资料改为固定 Scraper。人工保存过的策略、暂停状态和采购价保留。新详情以固定 Scraper 建立。历史幂等重放读取原记录，已有游标沿原渠道继续。
2. 在「上游供应商 → RapidAPI」核对应用凭据和对应原生操作的启用状态、采购价及预算。部署脚本可以填充缺省采购估价，供应商实扣和租户扣款分别在诊断中心列示。账单记录的数值以最小货币单位计，CNY 的 1 个最小单位是 ¥0.01。
3. 在「策略搜索 → 管理」按接口选择「固定供应商」「优先与保底」或「暂停新采购」。优先模式在第一笔采购派发前检查渠道可用性；已派发后出现 403、超时或不可用响应，不会再向第二渠道重复采购。
4. 改订阅、凭据或路由后，如需验证当前权限，使用新的幂等键或页面的「新建相同查询」明确发起一次新请求，可能计费。原请求 ID 仍可查看此前响应。

**已经开通但内容搜索返回 403：** 在诊断中心按 Hub 请求 ID 核对当次操作及归档。只有匹配固定的未订阅消息，才能确认 RapidAPI 当时是以未订阅为由拒绝。检查「上游供应商 → RapidAPI → API Key 管理」的来源和更新时间，再到该应用所属账号或团队核对对应产品和订阅生效时间。`native.r.threads_search_recent` 对应 [Lundehund 的 Threads API](https://rapidapi.com/Lundehund/api/threads-api4)，`native.r.threads_scraper_search_posts` 对应 Threads Scraper。如果订阅晚于原请求，重放已保存的失败不能验证新权限。

**内容搜索显示“原请求结果待核实”：** 点击“只读核对原请求状态”。当记录匹配原请求 ID、Threads 平台且为带结束时间的 `unknown` 时，可点击“准备新查询（再次发送会计量）”，再明确点击搜索。准备不会发送请求，旧请求及可能已产生的费用保留；新请求使用新的幂等键并按当前规则计量，可能产生重复费用。仍在执行、查不到记录或核对失败时，不开放该入口。此流程只适用于 Threads 标准内容搜索首页（不带 `cursor`），不自动重试，也不改变分页、账号、详情接口的恢复规则。

旧版诊断中心只显示“受限响应已保存”。可在有生产 kubectl 权限的服务器执行以下只读查询，把第一行替换为 Hub 请求 ID。它只返回固定分类，不输出正文或凭据，不发起采购，无需部署新版 Hub：

```bash
hub_request_id='替换为 Hub 请求 ID'
kubectl -n mx-common exec -i statefulset/mx-common-postgres -- \
  psql -X -U mx_common -d mx_insight_hub -v ON_ERROR_STOP=1 -v rid="$hub_request_id" <<'SQL'
BEGIN READ ONLY;
SET LOCAL statement_timeout = '3s';
SELECT p.operation, CASE
  WHEN r.id IS NULL THEN 'archive_missing'
  WHEN r.parsed_payload->>'message' = 'You are not subscribed to this API.' THEN 'not_subscribed_at_call'
  ELSE 'unclassified_403' END AS saved_reason
FROM external_platform.provider_calls p
LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id = p.id
WHERE p.usage_request_id = :'rid'::uuid AND p.provider_key = 'rapidapi'
  AND p.operation IN ('native.r.threads_search_recent', 'native.r.threads_scraper_search_posts')
  AND p.outcome = 'rejected' AND p.http_status = 403;
ROLLBACK;
SQL
```

`unclassified_403` 表示未匹配此消息；`archive_missing` 或零行表示缺少对应证据。均不能证明订阅有效或无效。可用诊断中心显示的**上游 requestId** 核对 RapidAPI 记录。确认权限后，用「新建相同查询」再发送一次验证，可能再次计费。

**管理端切换或暂停：** 「策略搜索 → 管理」，六个接口都可单独设置固定供应商、优先与保底、暂停新采购。也可调接口：

```bash
curl -sS -X PUT "$HUB_ADMIN_URL/internal/v1/admin/strategy-search/search/threads" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"paused","primaryProvider":"rapidapi","fallbackProvider":null,"expectedRevision":1,"reason":"暂停 Threads 搜索"}'
```

`{interface}` 为 search、crawl、user-info、post-detail、post-comments、comment-replies。先读取管理目录中该路由的 revision，再作为 expectedRevision 提交。暂停时已完成响应的重放仍可读。新采购返回 HTTP 503，搜索、账号及帖子详情接口的错误码为 `threads_acquisition_paused`，两类评论接口为 `comment_acquisition_paused`。
