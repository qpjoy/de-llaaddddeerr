# Hub 策略搜索单次返回接口说明

更新：2026-11-11

适用对象：调用 MX Insight Hub 内容搜索、账号内容和评论接口的下游服务。

## 一、新增内容

| 新增项 | 说明 | 下游是否要改 |
| --- | --- | --- |
| 单次返回开关 `fillPage` | 请求体加 `"fillPage": false` 后，Hub 每次请求最多取一页上游结果就返回，不再为凑满页连续调用上游 | 需要单次返回时，加这个字段并按本文调整翻页 |
| 快手搜索等待时间调整 | 快手搜索单次上游调用的最长等待时间，从 30 秒调整为 45 秒，减少偶发的 502 超时 | 不用改，建议客户端超时按第五节设置 |

不传 `fillPage` 或传 `true` 时，接口行为和原来一样，现有调用不受影响。

使用前提：Hub 需要升级到包含此功能的版本。旧版本收到 `fillPage` 会返回 400，这不是参数写错。

## 二、为什么需要单次返回

默认情况下，Hub 会连续调用上游，直到凑够 `pageSize` 条才返回。上游单次较慢、或者每页返回条数较少时，一次请求要调用上游多次，耗时叠加后可能超过调用方的超时时间。

使用单次返回后，一次请求的耗时基本等于一次上游调用，翻页节奏由调用方控制。

## 三、调用方式

路径、请求头、其他字段和返回结构都不变，只在请求体里多加一个字段。

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `fillPage` | boolean | 否 | 默认 `true`，凑满页后返回；`false` 表示单次返回 |

环境变量：

```bash
export HUB_URL="https://hub.minsight-ai.com"
export HUB_KEY="<Hub API Key>"
```

第一页：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "kuaishou", "query": "新能源", "pageSize": 20, "fillPage": false }'
```

返回示例：

```json
{
  "data": {
    "contractVersion": "night-all.data-search.v1",
    "platform": "kuaishou",
    "query": "新能源",
    "items": [],
    "pageInfo": {
      "pageIndex": 1,
      "pageSize": 20,
      "returnedCount": 8,
      "hasMore": true,
      "nextCursor": "mxds1.xxxxx",
      "cursorType": "opaque"
    },
    "status": "ok",
    "warnings": [],
    "meta": { "providerCalls": 1 }
  },
  "requestId": "0a3c1d7e-5b6f-4d2a-9c8e-1f2b3c4d5e6f"
}
```

示例省略了 `items` 的内容，`returnedCount` 是实际返回条数。

下一页：把上一页的 `nextCursor` 放进 `cursor`，其他字段不变，换一个新的 Idempotency-Key。

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "kuaishou", "query": "新能源", "pageSize": 20, "fillPage": false, "cursor": "上一页的 nextCursor" }'
```

## 四、下游切换要点

1. 在请求体加 `"fillPage": false`。
2. 本页条数可能少于 `pageSize`，也可能是 0，例如上游这一页全是重复内容或非内容卡片。不要因为条数少或为空就结束翻页。
3. 按下表判断是否继续：

| 返回 | 含义 | 下游处理 |
| --- | --- | --- |
| `hasMore=true` 且 `nextCursor` 非空 | 还有下一页 | 用 `nextCursor` 继续 |
| `hasMore=false` 或 `nextCursor` 为空 | 没有下一页，或已到翻页上限 | 结束 |
| `hasMore=null` 且 `nextCursor` 非空 | 上游无法确认还有没有，主要出现在部分评论接口 | 不要无限循环；需要更多数据时手动再取，并限制次数 |

4. `data.status` 为 `partial` 在单次返回下很常见，表示本页没有凑满或还有下一页，不代表请求失败。
5. 每一页都换新的 Idempotency-Key。同一页因网络问题重试时，用原来的 Key 和完全相同的请求体，不会重复调用上游，也不会重复计费。
6. 同一个 Idempotency-Key 不能同时用于单次返回和默认模式，否则返回 `409 idempotency_conflict`。
7. 两种模式的游标可以互相接着用，翻到一半去掉 `fillPage` 也能继续。
8. 每个查询最多翻 15 页、游标 24 小时有效，这些限制和原来一样。
9. 上一次多取的余量会在下一页直接返回，这时不调用上游，`data.meta.providerCalls` 为 0。

翻页示例：

```js
let cursor = null
for (let page = 1; page <= 15; page++) {
  const body = { platform: 'kuaishou', query: '新能源', pageSize: 20, fillPage: false }
  if (cursor) body.cursor = cursor
  // 网络重试时，这一页要复用同一个 Idempotency-Key 和同一个 body
  const result = await postToHub('/api/v1/data/search', body, crypto.randomUUID())
  saveItems(result.data.items) // items 可能为空，不要因此结束
  cursor = result.data.pageInfo.nextCursor
  if (!cursor) break
}
```

账号内容的游标在 `data.pageInfo.nextCursor` 或 `data.page.nextCursor`，帖子评论、评论回复和 YouTube 评论的游标在 `data.page.nextCursor`。

## 五、耗时和超时设置

| 项目 | 时间 |
| --- | --- |
| 快手搜索单次上游调用 | 最长 45 秒 |
| 其他接口单次上游调用 | 通常最长 30 秒 |
| 并发名额已满时排队 | 最长约 30 秒 |

建议客户端超时不低于 90 秒。微博、小红书需要补全文时，以及账号内容需要先解析账号时，一次请求会有额外调用，请多留一些时间。

客户端超时不代表 Hub 没有调用上游，也不代表没有计费。超时后先查询请求状态，不要直接换新的 Key 重发：

```bash
curl -sS "$HUB_URL/api/v1/requests/by-idempotency-key" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Idempotency-Key: 原来的 Idempotency-Key"
```

## 六、用量记录

| 接口 | 用量记录方式 | 拆成多次请求的影响 |
| --- | --- | --- |
| 内容搜索 | 按返回条数 | 总条数相同时，用量基本不变 |
| 账号内容、账号资料、帖子评论、评论回复、YouTube 评论 | 每次成功返回记 1 次 | 单次返回的请求次数更多，用量会增加 |

## 七、内容搜索支持情况

接口：`POST /api/v1/data/search`。固定时间窗接口 `POST /api/v2/data/search` 同样支持，v2 按时间窗过滤后，本页为空的情况会更多。

| 平台 | 默认行为 | fillPage=false | 仍可能发生的额外调用 |
| --- | --- | --- | --- |
| bilibili、douyin、kuaishou、zhihu、reddit、youtube、tiktok | 凑满 pageSize，可能多次调用上游 | 最多调用 1 次上游 | 无 |
| weibo | pageSize 小于 20 时凑页；20 及以上本来只取一页 | 最多调用 1 次搜索 | 正文不完整时调用详情补全文 |
| xiaohongshu | pageSize 为 20 时本来只取一页；其他值凑页 | 最多调用 1 次搜索 | 正文不完整时调用详情补全文 |
| twitter | 凑满 pageSize，单次上游最多 50 条 | 最多调用 1 次上游 | 首页被主上游明确拒绝时，按路由配置改用备用上游，再调用 1 次 |
| facebook | 凑满 pageSize | 最多调用 1 次上游 | 主上游限流（429）时，按路由配置改用备用上游，再调用 1 次 |
| instagram | 本来只取一页 | 无变化 | 无 |
| wechat_search、wechat_mp | 本来只取一页 | 无变化，字段会被接受 | 无 |
| telegram | 查询 Hub 已收录数据，不调用上游 | 无变化，字段会被接受 | 无 |
| 其他平台 | — | 返回 `400 fill_page_unsupported` | — |

## 八、账号和评论支持情况

| 接口 | 平台 | 默认行为 | fillPage=false | 仍可能发生的额外调用 |
| --- | --- | --- | --- | --- |
| `POST /api/v1/data/social/crawl` 账号内容 | twitter、facebook、instagram、bilibili、douyin、kuaishou、weibo、xiaohongshu、youtube、zhihu、tiktok、linkedin、reddit | 凑满 count | 每个账号最多取 1 页内容 | 需要时先解析账号；批量请求时每个账号各取 1 页 |
| `POST /api/v1/data/social/user-info` 账号资料 | 同上 | 本来就是单次 | 无变化 | 需要时先解析账号 |
| `POST /api/v1/data/social/post-comments` 帖子评论 | twitter、reddit、kuaishou、instagram、weibo、douyin、tiktok、zhihu、linkedin、bilibili、facebook、xiaohongshu、youtube | 凑满 count；twitter、reddit、kuaishou、weibo 本来只取一页 | 最多取 1 页 | 无 |
| `POST /api/v1/data/social/comment-replies` 评论回复 | twitter、weibo、douyin、zhihu、reddit、xiaohongshu、instagram、bilibili、kuaishou | 凑满 count；twitter、weibo、reddit、kuaishou 本来只取一页 | 最多取 1 页 | 无 |
| `POST /api/v1/data/youtube/comments` 视频评论 | youtube | 凑满 maxComments | 最多取 1 页 | 无 |
| `POST /api/v1/data/youtube/channel-comments` 频道评论 | youtube | 凑满 maxComments | 最多取 1 页评论 | 先解析频道、列出视频 |
| `POST /api/v1/data/social/search` Twitter 搜索 | twitter | 本来就是单次 | 无变化，字段会被接受 | 无 |

旧客户端的兼容接口 `POST /api/v1/search/{operation}` 和 `POST /api/v1/night-all/search/{operation}` 不支持 `fillPage`，传了返回 400。需要单次返回时，请改用上面的接口。

## 九、其他接口调用示例

固定时间窗搜索：

```bash
curl -sS -X POST "$HUB_URL/api/v2/data/search" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "kuaishou", "query": "新能源", "pageSize": 20, "fillPage": false, "timeWindow": { "from": "2026-11-10T00:00:00.000+08:00", "to": "2026-11-11T00:00:00.000+08:00", "timezone": "Asia/Shanghai", "boundary": "[from,to)" } }'
```

账号内容：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/crawl" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "douyin", "username": "平台账号", "count": 20, "activityTypes": ["posts"], "fillPage": false }'
```

帖子评论：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/post-comments" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "platform": "douyin", "contentId": "7290000000000000000", "count": 20, "fillPage": false }'
```

评论回复：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/social/comment-replies" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "replyRef": { "platform": "douyin", "commentId": "7300000000000000001", "contentId": "7290000000000000000" }, "count": 20, "fillPage": false }'
```

YouTube 视频评论：

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/youtube/comments" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: $(uuidgen)" \
  -d '{ "videoId": "dQw4w9WgXcQ", "maxComments": 20, "fillPage": false }'
```

## 十、错误码

| HTTP | `error.code` | 含义 | 处理 |
| --- | --- | --- | --- |
| 400 | `invalid_fill_page` | `fillPage` 不是布尔值，例如传了字符串 `"false"` | 改成 `true` 或 `false` |
| 400 | `fill_page_unsupported` | 该平台不支持单次返回 | 去掉 `fillPage` |
| 409 | `idempotency_conflict` | 同一个 Idempotency-Key 用于不同的请求或不同的模式 | 换新的 Key，或用原请求体重试 |

其他错误码和原接口相同。遇到问题时，请提供 `requestId`（响应头 `x-mx-insight-request-id`）、Idempotency-Key 和完整请求体。
