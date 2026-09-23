# MX Insight Hub：小红书 API 接入与演示指南

适用版本：2026-09-23。面向使用 Hub API Key 的应用开发者。

本文演示：**输入关键词 → 获取相关热门笔记列表 → 选择笔记 → 查看正文、阅读量及评论**。所有请求均发送到 Hub，使用同一把已授权的 Hub Key，无需登录小红书。

## 1. 演示要调用哪些接口

| 顺序 | 方法与 Hub 路径 | 用途 |
| --- | --- | --- |
| 准备 | `GET /api/v1/data/capabilities` | 查看当前调用身份可用的能力 |
| ① | `POST /api/v1/xiaohongshu/app_v2/search_notes` | 按关键词搜索笔记，可按点赞、评论等排序 |
| ② | `POST /api/v1/data/xiaohongshu/notes/detail` | 按笔记 ID 获取详情、阅读量、曝光量及互动指标 |
| ③ | `POST /api/v1/data/xiaohongshu/notes/comments` | 获取一页评论，可继续翻页 |
| 可选 | `POST /api/v1/data/post` | 按笔记链接获取正文、结构化标签和图片 |
| 排障 | `GET /api/v1/requests/by-idempotency-key` | 按原请求标识查询执行状态，不重新执行业务请求 |

步骤①返回的是**关键词相关笔记**；按点赞量排序可用于观察热点线索，但不等于全站热榜。搜索不会自动为列表中每条笔记读取详情或评论。步骤②、③按需调用。

详情和评论是两个独立请求。`/api/v1/data/post` 也不会同时替你调用这两个接口；需要阅读量请使用步骤②。

## 2. 调用前准备

服务方提供 Hub 地址和有效的 **Live API Key**。调用方及当前 Key 都需要有 `xiaohongshu` 平台授权，并具备相应操作权限：

| 功能 | 所需能力 |
| --- | --- |
| 搜索笔记 | `social.posts.search`、`compat.xiaohongshu.app_v2` |
| 详情与阅读量 | `social.posts.analytics` |
| 评论 | `social.comments.list` |
| 可选的正文与标签 | `social.posts.resolve` |

权限、服务运行状态、额度和余额共同决定能否调用。若服务提示“运行时未就绪”，请让服务方检查该操作；已有权限不代表该操作已经运行就绪。

以下示例在 Bash/Zsh 中执行，需要 `curl`、`jq` 和 `uuidgen`。也可以在 Postman 中使用相同 URL、Headers 和 JSON Body。示例中的 Key 为占位符；真实 Key 放在调用方服务端，演示或分享时隐藏 `Authorization` 的值。

```bash
export HUB_URL='https://hub.minsight-ai.com'
export HUB_KEY='替换为服务方提供的 Live Hub Key'

curl -sS "$HUB_URL/api/v1/data/capabilities" \
  -H "Authorization: Bearer $HUB_KEY"
```

`HUB_URL` 不包含 `/api/v1`；私有部署时替换成服务方给出的地址。机器调用使用 API Key，无需携带控制台登录 Cookie 或管理 Token。

每次新的业务查询生成一个 `Idempotency-Key`，请求发出前保存该值和请求体。**同一次请求的重试复用原值；更换笔记、筛选条件或页码时生成新值。** 以下将标识生成和发送拆成两段，避免重试时误生成新标识。

## 3. 第一步：按关键词搜索相关热门笔记

准备第一页请求，例如搜索近一周“春季穿搭”相关笔记，按点赞热度排序：

```bash
SEARCH_ID=$(uuidgen)
cat > search-request.json <<'JSON'
{
  "keyword": "春季穿搭",
  "page": 1,
  "sort_type": "popularity_descending",
  "note_type": "不限",
  "time_filter": "一周内"
}
JSON
```

发送请求，保存响应头和 JSON 响应：

```bash
curl -sS -X POST "$HUB_URL/api/v1/xiaohongshu/app_v2/search_notes" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $SEARCH_ID" \
  --data-binary @search-request.json \
  -D search-headers.txt -o search-response.json -w 'HTTP %{http_code}\n'
jq . search-response.json
```

确认 HTTP 为 `200` 且响应不是错误后再继续。该接口保留笔记列表字段结构，**列表位于 `data.data.items`，不同于详情接口的 `data.item`**。列表可能含非笔记条目，只处理其中具有有效笔记 ID 的 `note` 对象。

```bash
jq '[.data.data.items[]? | .note? | select(type == "object") |
  {note_id: (.note_id // .id), title: (.display_title // .title),
   author: .user.nickname,
   liked: (.interact_info.liked_count // .liked_count)}]' search-response.json

NOTE_ID=$(jq -er 'first(.data.data.items[]? | .note? |
  (.note_id // .id) | select(type == "string") |
  select(test("^[0-9a-fA-F]{24}$")))' search-response.json)
printf '选中的笔记 ID：%s\n' "$NOTE_ID"
```

这段示例选取第一条有效笔记。实际应用应让用户从列表选择；若没有有效 ID，停止后续详情和评论请求，先检查搜索结果。不要把空 ID 继续提交。

常用搜索参数：

| 参数 | 取值与含义 |
| --- | --- |
| `keyword` | 必填，1–500 字符 |
| `page` | 1–15，默认 1；一次只取一页 |
| `sort_type` | `general` 综合；`time_descending` 最新；`popularity_descending` 点赞最多；`comment_descending` 评论最多；`collect_descending` 收藏最多；`english_preferred` 英文优先 |
| `note_type` | `不限`、`普通笔记`、`视频笔记`、`直播笔记` |
| `time_filter` | `不限`、`一天内`、`一周内`、`半年内` |

搜索翻页时保持关键词、排序和筛选条件，递增 `page`，并原样带回返回的 `search_id` / `search_session_id`（存在时）。这些值可能位于 `data` 或 `data.data`。只有返回的 `has_more` / `hasMore` 或 `next_page` / `nextPage` 明确允许继续时才翻页；字段冲突、状态不明或已到第 15 页时停止。每页使用新的 `Idempotency-Key`，不要用评论接口的 `cursor` 给搜索翻页。

搜索内容可能是预览，互动数量可能以字符串表示。搜索结果没有阅读量不代表阅读量为零；阅读量使用下一步查询。

## 4. 第二步：获取所选笔记详情和阅读量

沿用上一步得到的 `NOTE_ID`。此接口只接收 `note_id`，不需要再传关键词、链接或 `deliveryMode`。

```bash
DETAIL_ID=$(uuidgen)
jq -n --arg id "$NOTE_ID" '{note_id: $id}' > detail-request.json
```

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/xiaohongshu/notes/detail" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $DETAIL_ID" \
  --data-binary @detail-request.json \
  -D detail-headers.txt -o detail-response.json -w 'HTTP %{http_code}\n'
jq . detail-response.json
```

成功响应的字段示意如下，数据为虚构示例、只展示部分字段：

```json
{
  "code": 200,
  "meta": {
    "status": "ok",
    "tagsAvailable": false,
    "recommendedIntervalSeconds": 5,
    "collectedAt": "2026-09-23T01:00:00.000Z"
  },
  "data": {
    "item": {
      "platform": "xiaohongshu",
      "externalId": "0123456789abcdef01234567",
      "title": "春季穿搭示例",
      "text": "这里是笔记正文。",
      "tags": [],
      "metrics": {
        "views": 12500,
        "impressions": 23000,
        "liked": 320,
        "collected": 85,
        "comments": 26,
        "shared": null
      }
    }
  }
}
```

| 读取位置 | 用途 |
| --- | --- |
| `data.item.title` / `text` | 标题和正文 |
| `data.item.author` | 作者 `id`、`name`、`avatarUrl` |
| `data.item.media[]` | 图片或视频，使用 `type`、`url` |
| `data.item.metrics.views` | 阅读量 |
| `data.item.metrics.impressions` | 曝光量，与阅读量分开 |
| `data.item.metrics.liked` / `collected` / `comments` | 点赞、收藏、评论总量 |
| `data.item.publishedAt` / `collectedAt` | 发布时间、此次数据采集时间 |

缺失指标返回 `null`，表示未提供，不应展示成 0。`meta.tagsAvailable=false` 表示这次未提供结构化标签；需要标签时可使用第 6 节的正文与标签接口。`meta.status=no_data`、`data.item=null` 表示此次确认无数据，不要自动重试。

建议两次**新的详情与阅读量查询间隔至少 5 秒**，频繁调用可能受限。这只是调用建议，Hub 不会替客户端自动等待、排队或重试，也不保证每条笔记都能提供阅读量。

## 5. 第三步：获取评论

获取热门评论第一页，`sort` 也可以设为 `latest`（最新，默认值）：

```bash
COMMENTS_ID=$(uuidgen)
jq -n --arg id "$NOTE_ID" '{note_id: $id, sort: "hot"}' > comments-request.json
```

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/xiaohongshu/notes/comments" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $COMMENTS_ID" \
  --data-binary @comments-request.json \
  -D comments-headers.txt -o comments-response.json -w 'HTTP %{http_code}\n'
jq . comments-response.json
```

| 读取位置 | 用途 |
| --- | --- |
| `data.items[]` | 本页评论 |
| `data.items[].id` / `text` / `liked` | 评论 ID、内容、点赞数 |
| `data.items[].author` / `publishedAt` | 评论者和发布时间 |
| `data.items[].replyCount` / `replies` | 回复总数及本次已返回的部分回复 |
| `data.nextCursor` | 下一页游标，必须原样传回 |
| `data.hasMore` | `true` 可继续，`false` 已结束，`null` 无法确认 |
| `meta.paginationStatus` | `continuable`、`exhausted`、`unknown` 或 `limit_reached` |

只有 `nextCursor` 非空且分页状态为 `continuable` 时再请求下一页。准备下一页请求：

```bash
NEXT_CURSOR=$(jq -er '
  select(.meta.paginationStatus == "continuable") |
  .data.nextCursor | select(type == "string" and length > 0)
' comments-response.json)
```

若上面的命令没有成功取到游标，停止翻页。取到后，保留相同笔记和排序，用新的请求标识发送：

```bash
COMMENTS_NEXT_ID=$(uuidgen)
jq --arg cursor "$NEXT_CURSOR" '. + {cursor: $cursor}' \
  comments-request.json > comments-next-request.json

curl -sS -X POST "$HUB_URL/api/v1/data/xiaohongshu/notes/comments" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $COMMENTS_NEXT_ID" \
  --data-binary @comments-next-request.json \
  -D comments-next-headers.txt -o comments-next-response.json -w 'HTTP %{http_code}\n'
jq . comments-next-response.json
```

后续页从最新一页响应继续取游标，最多 15 页。游标绑定当前 Key、笔记和排序，不可转交另一把 Key 使用。`unknown` / `limit_reached` 表示应停止，不代表全部评论已取完。评论总量不等于本页条数；内嵌 `replies` 也不保证包含全部回复。

## 6. 可选：补充正文与结构化标签

需要按链接读取完整正文、结构化标签和图片时，调用以下接口。已有分享链接时优先使用原链接，也可使用所选笔记的标准链接。

```bash
POST_ID=$(uuidgen)
jq -n --arg url "https://www.xiaohongshu.com/explore/$NOTE_ID" \
  '{platform: "xiaohongshu", url: $url, deliveryMode: "cache_first"}' \
  > post-request.json
```

```bash
curl -sS -X POST "$HUB_URL/api/v1/data/post" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H 'Content-Type: application/json' \
  -H "Idempotency-Key: $POST_ID" \
  --data-binary @post-request.json \
  -D post-headers.txt -o post-response.json -w 'HTTP %{http_code}\n'
jq '.data.item | {title, text, tags, author, media, metrics}' post-response.json
```

`cache_first` 优先复用可交付缓存，必要时获取数据；需要一次全新实时获取时，显式改为 `live_only` 并生成新的请求标识。此接口与 Hub 的 `/api/v1/xiaohongshu/app/get_note_info` 正文入口共享调用链，不是阅读量和评论的组合接口。当前正文入口面向图文笔记，视频展示优先使用步骤②实际返回的媒体。

标签和图片以实际返回为准。缓存交付不等于免费；同一逻辑请求不要为切换入口而另起一次收费查询。

## 7. 计费与重复请求

以下以租户已启用余额扣费、默认价格为 **￥0.10/次**，且这几个接口没有套餐单独价格覆盖为例：

| 演示动作 | 成功业务调用次数 | 示例费用 |
| --- | --- | --- |
| 搜索一页 | 1 | ￥0.10 |
| 查看一条笔记的详情与阅读量 | 1 | ￥0.10 |
| 查看一页评论 | 1 | ￥0.10 |
| 完成上述三步 | 3 | **￥0.30** |
| 再取一页搜索或评论 | 每页 1 | 每页再加 ￥0.10 |
| 可选的正文与标签查询 | 1 | 再加 ￥0.10 |

实际价格遵循：**已分配套餐的明确接口价格（包括 0 元）优先；未单独定价的接口使用租户默认单价。** 套餐价格按适用倍率计算，租户默认单价直接生效。定价不会授予访问权限；无权限的接口仍不能访问。

成功交付计费；详情/评论成功返回 `no_data` 也计一次。相同 Key、相同参数及相同 `Idempotency-Key` 的成功结果重放不会重复扣费。失败或网络超时不能一概视为未执行：明确失败会释放冻结，结果不确定时应先查状态。余额流水中的“请求冻结”和“成功扣费”是同一次请求的两个阶段，不是各收一次。

## 8. 超时、错误与状态查询

保留每次响应头中的 `x-mx-insight-request-id`。`idempotent-replay=true` 表示幂等重放；`x-mx-insight-source-mode` 与 `x-mx-insight-captured-at` 用于判断交付方式及数据采集时间。

错误响应格式：

```json
{
  "error": {"code": "capability_not_granted", "message": "所需操作未授权"},
  "requestId": "示例请求标识"
}
```

| 状态 | 处理方法 |
| --- | --- |
| `400` | 检查参数、24 位十六进制笔记 ID、分页条件；修改参数算新请求 |
| `401` | 检查 Hub Key 是否正确、有效 |
| `402 insufficient_credit` | 可用余额不足，联系服务方处理余额 |
| `403` | 检查调用方及当前 Key 的平台和操作授权、是否使用 Live Key |
| `409 idempotency_conflict` | 原标识已绑定其他参数；先确认哪一次请求才是本次意图 |
| `409 request_in_progress` / `request_outcome_unknown` | 保留原标识，先查状态；不要换新标识反复提交 |
| `429` | 已受配额、并发或频率限制，降低请求频率，按返回错误处理 |
| `502` / `503` | 获取失败、结果不确定或操作暂不可用；先查状态，必要时联系服务方 |

例如详情请求超时，但还保留 `DETAIL_ID`：

```bash
curl -sS "$HUB_URL/api/v1/requests/by-idempotency-key" \
  -H "Authorization: Bearer $HUB_KEY" \
  -H "Idempotency-Key: $DETAIL_ID"
```

状态查询不产生新的业务调用费用。`data.status=committed` 后可用原标识和原请求体重放步骤②；`reserved` / `unknown` 时等待或联系服务方，不重新发起业务请求；`released` 表示原请求已经结束并释放。查不到记录时也不要立即用新标识重复提交，应保留原请求信息排查。新的独立查询才使用新标识。

## 9. 现场演示顺序

1. 展示 Hub 地址及已隐藏密钥的认证配置，说明权限与单价已由服务方配置。
2. 输入一个关键词，发送搜索请求，展示笔记列表；说明排序表示点赞或评论等维度，不是全站热榜。
3. 从列表选择一条笔记，把 ID 传给详情接口，展示正文、媒体、阅读量、点赞量和采集时间；缺失指标显示“未提供”。
4. 点击“查看评论”再发送评论请求，展示当前页；用户选择“下一页”时才继续调用。
5. 需要标签时再演示可选的正文接口。展示请求标识和实际账单；按上述 ￥0.10 示例，前三项合计 ￥0.30。

在 Hub 控制台演示时，可进入“数据产品 → 小红书笔记画卷 → 接口调试”，选择演示用 Key，依次选择“搜索笔记”“详情与阅读量”“笔记评论”。下游程序使用的就是本指南里的 Hub API；控制台请求预览可用于对照参数。不要在现场反复刷新或自动遍历整页笔记，以免产生额外的新查询。

在列表或 Mobile 视图中，打开笔记先显示正文；点击详情顶部的“评论”才发送第一页评论请求。再次切换或关闭重开会保留本页会话的结果；点击“下一页评论”独立请求下一页。若只看到 `search_notes` 和 `get_note_info`，说明尚未调用评论，且本次正文使用的是正文与标签接口；它不会顺带查询阅读量或评论。评论入口会直接显示当前 Key 的授权或运行状态问题。
# 热门笔记与创作灵感

新增两个独立产品，均在「数据产品 → 小红书」，与原笔记画卷并列：

- `POST /api/v1/data/xiaohongshu/hot-notes/search`：`social.posts.hot_search`，关键词 / 类目 / 时间 / 指标筛选。
- `POST /api/v1/data/xiaohongshu/creator-inspirations`：`social.inspiration.list`，创作者热点灵感。

均需 xiaohongshu 平台授权及本操作的业务、Key 权限，必传 Idempotency-Key。首页不传 cursor，续页原样使用 `data.pageInfo.nextCursor`，每页新标识。业务结果在 `data.result`，未验证字段不当作归一化笔记或全站热榜。参数、未知分页、计费和上线流程见 [产品接入说明](product/xiaohongshu-discovery.md)；在线文档 `/docs/xiaohongshu-hot-notes` 与 `/docs/xiaohongshu-inspiration`。
