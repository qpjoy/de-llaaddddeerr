# Threads 接口手册

更新于 2026-11-12

Hub 已实现 Threads 的五类策略搜索接口。调用方使用现有业务路径，并传入 `platform: "threads"`。持有平台授权的 Key 可通过 `GET /api/v1/data/capabilities` 查看 `threads.search.ready`，租户 OpenAPI 和策略搜索指南也会显示相应入口。就绪值来自 Hub 配置与操作控制，供应商订阅需另行验证。

> **生产验收待完成。** 2026-11-12 18:26（上海时间），使用项目样例 Key 对 `threads-api4` 发起一次 `GET /api/search/recent`，返回 HTTP 403 和 `You are not subscribed to this API.`。生产 Hub 从数据库读取 RapidAPI 凭据，尚未确认是否与样例 Key 相同。当天生产策略目录中未见 Threads 五个入口。五类接口均已通过使用固定供应商样例的本地 Hub HTTP 交付和重放测试。

## 一、接口总览

| 用途 | 接口 | 所需授权（同一个 Key） | 分页 |
| --- | --- | --- | --- |
| 内容搜索 | `POST /api/v1/data/search` | `threads` | `data.pageInfo.nextCursor` |
| 内容搜索（固定时间窗） | `POST /api/v2/data/search` | `threads` | `data.pageInfo.nextCursor` |
| 账号内容 | `POST /api/v1/data/social/crawl` | `threads` + `social.content.crawl` | `data.pageInfo.nextCursor` |
| 账号资料 | `POST /api/v1/data/social/user-info` | `threads` + `social.profile.get` | 无 |
| 帖子评论 | `POST /api/v1/data/social/post-comments` | `threads` + `social.comments.list` | `data.page.nextCursor` |
| 评论回复 | `POST /api/v1/data/social/comment-replies` | `threads` + `social.comments.list` | `data.page.nextCursor` |

通用请求头：`X-API-Key`、`Content-Type: application/json`、`Idempotency-Key`（8–128 位安全字符，同键重放不重复采购）。

**每个查询目标和活动每次最多取一个来源内容页。** 账号按用户名查询可能另需一次身份解析。可继续读取已购余量或上游提供了有效后续游标时，使用 Hub 返回的 `nextCursor`。RapidAPI 未明确说明是否还有下一页、声明有下一页却缺少可用游标，或重复游标时，读完已购余量后返回 `hasMore: null` 和 `nextCursor: null`，并附分页警告。达到 Hub 的 15 页上限同样会停止续页。明确结束时返回 `hasMore: false`。TikHub 的 Threads 接口仅提供单页。

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

不支持 `params`，传了返回 400。结果按最新排序。`/api/v2/data/search` 另需 `timeWindow`，见策略搜索手册。

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

单个数字 ID 查询一种活动只需一次上游调用，传用户名时还需解析账号。Hub 按请求中所有账号的标识类型和所有活动检查所需操作，例如只查数字 ID 的回复只需回复操作。用户名按精确匹配解析。`replies` 只返回该账号自己发的回复。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/crawl" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-crawl-$(date +%s)" \
  -d '{"platform":"threads","userId":"63625256886","activityTypes":["posts"],"count":20}'
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

字段同账号内容的账号字段，不需要 `activityTypes`。

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

`following`、`posts` 供应商不提供，恒为 null。

## 五、帖子评论

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `contentId` | string | contentId 或 url 二选一 | 数字帖子 ID、`pk_用户ID` 或短码（`C8O-JbtAKrp`） |
| `url` | string | 同上 | `https://www.threads.com/@用户/post/短码`，`threads.net` 也可 |
| `count` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |
| `includeRaw` | boolean | 否 | true 时每条附带来源对象 `raw` |

短码和数字 ID 是同一个值的两种写法，Hub 在本地换算。RapidAPI 的非空首页包含被查询的帖子，Hub 会核对其 ID 并从评论中剔除。若供应商返回了另一篇帖子的首页，整页按来源数据错误处理。TikHub 的评论列表可以省略原帖。

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

## 六、评论回复

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `platform` | string | 是 | `threads` |
| `replyRef` | object | replyRef 或 commentId 二选一 | 评论条目返回的对象，原样传回 |
| `commentId` | string | 同上 | 评论的数字 ID |
| `contentId` | string | 否 | 所属帖子 ID；提供后回复才会入库 |
| `count` | integer | 否 | 1–100，默认 20 |
| `cursor` | string | 否 | 上一页 `data.page.nextCursor` |

Threads 的回复本身也是帖子，所以用同一个评论接口查询，查询对象和它的上级帖子已剔除。供应商回显直接父级或会话根时，Hub 会用它们核对归属；父级与目标不符或上下文矛盾的页面会被拒绝。返回结构同评论，另有 `type: "reply"`、`rootCommentId`（被查询的评论）、`parentCommentId`（同 `rootCommentId`）。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/comment-replies" \
  -H "X-API-Key: $HUB_KEY" -H "Content-Type: application/json" \
  -H "Idempotency-Key: threads-replies-$(date +%s)" \
  -d '{"platform":"threads","replyRef":{"platform":"threads","commentId":"3390930071274677885","contentId":"3390920896561588969"},"count":20}'
```

## 七、启用与校验（内部，对外分享时删去）

**供应商对应：**

| 接口 | RapidAPI（`threads-api4`） | TikHub（保底） | 校准 |
| --- | --- | --- | --- |
| 内容搜索 | `/api/search/recent` | `/api/v1/threads/web/search_posts` | RapidAPI 官方样例 / TikHub 文档 |
| 账号内容 posts | `/api/user/posts` | `/api/v1/threads/web/fetch_user_posts` | 同上 |
| 账号内容 replies | `/api/user/replies` | `/api/v1/threads/web/fetch_user_replies` | 同上 |
| 账号内容 reposts | `/api/user/reposts` | `/api/v1/threads/web/fetch_user_reposts` | 同上 |
| 账号资料 | `/api/user/info`（`id`） | `fetch_user_info` / `fetch_user_info_by_id` | 同上 |
| 用户名解析 | `/api/search/profiles` 精确匹配 | `fetch_user_info` | 同上 |
| 帖子评论、评论回复 | `/api/post/comments` | `/api/v1/threads/web/fetch_post_comments` | 同上 |

帖子详情、相关帖子、链接转 ID、热门搜索等其余 RapidAPI 接口可通过 `POST /api/v1/data/native/r.threads_*` 原样调用。

**上线顺序（顺序很重要）：**

1. 在 RapidAPI 控制台切换到生产 Key 对应的账号或团队，在订阅列表核对 `threads-api4`。也可在该服务的 Endpoints 页面选用生产应用，对 `/api/search/recent` 发起一次最小查询。HTTP 200 且响应含可解析的搜索结果可验证该 Key 的搜索访问权。HTTP 403 且明确提示未订阅，可确认该 Key 缺少该服务的访问权。[RapidAPI 官方测试说明](https://docs.rapidapi.com/docs/connecting-to-an-api)
2. 准备包含迁移 188 的 Hub 发布。迁移写入五个路由、十一项默认禁用的 RapidAPI 操作；现有部署脚本中的默认定价步骤可随即启用这些操作。开放租户流量前核对实际采购价、预算、路由模式和目标租户的授权。
3. 通过部署后的 Hub 做五类业务验收，含账号 ID 与用户名、三种账号活动、两级评论归属，以及带有效游标的后续页。TikHub 作为保底时也需以实际凭据校验。完成后再按已验收的接口开放流量。

未订阅就部署时，默认的 RapidAPI 优先路由会把请求发给 RapidAPI 并得到 403，返回 502 `external_platform_rejected`，**不会**自动转 TikHub（保底只在派发前生效）。这种情况请先把策略改为固定 TikHub 或暂停。

**管理端切换或暂停：** 「策略搜索 → 管理」，五个接口都可单独设置固定供应商、优先与保底、暂停新采购。也可调接口：

```bash
curl -sS -X PUT "$HUB_ADMIN_URL/internal/v1/admin/strategy-search/search/threads" \
  -H "x-mx-insight-admin-token: $HUB_ADMIN_TOKEN" -H "Content-Type: application/json" \
  -d '{"mode":"paused","primaryProvider":"rapidapi","fallbackProvider":null,"expectedRevision":1,"reason":"暂停 Threads 搜索"}'
```

`{interface}` 为 search、crawl、user-info、post-comments、comment-replies。暂停时已完成响应的重放仍可读。新采购返回 HTTP 503，搜索及账号接口的错误码为 `threads_acquisition_paused`，两类评论接口为 `comment_acquisition_paused`。

**首页核对清单：**

- 内容搜索、账号内容、评论各发一次，`data.items` 的 `text`、`author`、`publishedAt` 有值。
- 账号内容或评论拿到 `nextCursor` 后续一页，确认内容不同。若重复，说明 `end_cursor` 无效，翻页需要关闭。
- 确认 RapidAPI 的响应结构仍与 `tests/fixtures/threads-rapidapi-samples.json` 一致；TikHub 响应首次使用时同样核对。
