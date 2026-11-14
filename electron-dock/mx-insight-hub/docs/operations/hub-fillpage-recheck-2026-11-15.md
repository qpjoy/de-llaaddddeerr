# Hub 接口线上复测清单（12 项，含输入、输出与复制命令）

整理日期：2026-11-15（北京时间）。

范围：10 个平台内容搜索、Twitter 账号内容、Twitter 帖子评论。Facebook 不在本清单范围。

- 公网地址：`https://hub.minsight-ai.com`
- 请求方式：`POST`，JSON 请求体。
- 本轮原始验证身份：`LCY-delta`。开发测试可使用具有相应授权和余额的自己的 Hub Live API Key，结果受该 Key 的权限、套餐和限额约束。
- 所有请求均传 `"fillPage": false`，取一个来源内容页后返回；仍可能有账号解析、正文补全等额外调用。
- 这 12 项均已实际返回非空数据。批量回执时间为 2026-11-14 22:59–23:01；Twitter 评论采用随后单独复测的 20 条结果，该回执未附执行时间。
- 每项“实测输出摘要”来自已回传日志，**不是完整原始 API 响应**。完整业务字段和 `items` 内容由下面命令保存到各用例的 `response.json`，便于开发测试复核。
- 本文命令适用于 **Bash + curl + Python 3**。Windows 可在 WSL 或 Git Bash 中执行；Apifox / Postman 可直接复制各项 JSON，配置同样的 URL、方法和请求头。

## 一、实测结果总览

| 编号 | 功能／平台 | HTTP | data.status | 返回条数 | 上游调用数 | 耗时 |
| --- | --- | ---: | --- | ---: | ---: | ---: |
| 01 | Bilibili 搜索 | 200 | `ok` | 1 | 1 | 3.55 s |
| 02 | 抖音搜索 | 200 | `partial` | 1 | 1 | 8.78 s |
| 03 | 快手搜索 | 200 | `partial` | 1 | 1 | 7.51 s |
| 04 | Reddit 搜索 | 200 | `partial` | 1 | 1 | 5.22 s |
| 05 | TikTok 搜索 | 200 | `ok` | 1 | 1 | 13.93 s |
| 06 | Twitter / X 搜索 | 200 | `ok` | 1 | 1 | 5.13 s |
| 07 | 微博搜索 | 200 | `ok` | 1 | 2 | 8.92 s |
| 08 | 小红书搜索 | 200 | `ok` | 1 | 2 | 15.07 s |
| 09 | YouTube 搜索 | 200 | `ok` | 1 | 1 | 5.84 s |
| 10 | 知乎搜索 | 200 | `ok` | 1 | 1 | 6.26 s |
| 11 | Twitter / X 账号内容 | 200 | `ok` | 1 | 2 | 12.14 s |
| 12 | Twitter / X 帖子评论 | 200 | `partial` | 20 | 1 | 3.34 s |

耗时和返回条数是这次回执的观测值；新采集结果会随平台内容变化。上游调用数与 Hub 请求次数是不同指标：本表微博、小红书、Twitter 账号内容各报告 2 次上游调用，仍符合单页内容返回模式。

## 二、一次性初始化

### 2.1 请求头和权限

| 请求头 | 值／要求 |
| --- | --- |
| `Authorization` | `Bearer <Hub Live API Key>`，这里使用 Hub Key |
| `Content-Type` | `application/json` |
| `Idempotency-Key` | 每个新业务请求独立；下面函数自动生成并保存 |

| 业务 | Key 所需授权 |
| --- | --- |
| 内容搜索 | 对应目标平台；小红书另外需要 `social.posts.search` |
| Twitter 账号内容 | `twitter` + `social.content.crawl` |
| Twitter 帖子评论 | `twitter` + `social.comments.list` |

这会按当前 Key 的计量与价格规则执行。以下函数每次只发送一个 Hub 业务请求，不自动续页。

### 2.2 配置环境

在同一个 Bash 终端中先执行。输入 Key 时不会回显；本段只配置环境，不发送业务请求。

```bash
export HUB_URL='https://hub.minsight-ai.com'
read -r -s -p 'Hub Live API Key: ' HUB_KEY
printf '\n'
export HUB_KEY
umask 077
export HUB_OUT="${HUB_OUT:-$PWD/hub-api-recheck-$(date +%Y%m%d-%H%M%S)}"
mkdir -p "$HUB_OUT"
printf '本轮输出目录：%s\n' "$HUB_OUT"
```

### 2.3 定义调用函数

复制执行一次。每个用例保存 `request.json`、`path.txt`、`idempotency-key.txt`、`response.headers.txt`、`response.json`、`metrics.txt`；不会把 Key 写入这些文件。

同一输出目录下重复粘贴同一用例会停止发送，保留原回执。确需启动新一轮测试时，显式设置新的 `HUB_OUT` 并创建目录，新的请求可能再次计量。遇到未知结果时先按第五节查询。

```bash
hub_post() {
  if [ "$#" -ne 3 ]; then
    printf '用法：hub_post 用例名 接口路径 JSON请求体\n' >&2
    return 2
  fi
  if [ -z "${HUB_KEY:-}" ] || [ -z "${HUB_URL:-}" ] || [ -z "${HUB_OUT:-}" ]; then
    printf '请先完成环境初始化。\n' >&2
    return 2
  fi
  local case_id="$1" api_path="$2" body="$3"
  local dir="$HUB_OUT/$case_id" idem curl_rc
  # 目录创建成功才发送：同一用例重复粘贴时停止，先检查原回执。
  if ! mkdir "$dir"; then
    printf '此用例已有执行目录：%s\n请先查看原结果或按第五节查询状态。\n' "$dir" >&2
    return 1
  fi
  idem="hub-recheck-$(python3 -c 'import uuid; print(uuid.uuid4())')" || return 1
  printf '%s\n' "$body" > "$dir/request.json"
  printf '%s\n' "$api_path" > "$dir/path.txt"
  printf '%s\n' "$idem" > "$dir/idempotency-key.txt"
  printf '用例：%s\nIdempotency-Key：%s\n' "$case_id" "$idem"
  # 不自动重试、不自动跟随重定向、不自动续页；保留错误响应体。
  curl -q --silent --show-error --connect-timeout 10 --max-time 180 \
    --request POST "$HUB_URL$api_path" \
    --header "Authorization: Bearer $HUB_KEY" \
    --header 'Content-Type: application/json' \
    --header "Idempotency-Key: $idem" \
    --data-binary "@$dir/request.json" \
    --dump-header "$dir/response.headers.txt" \
    --output "$dir/response.json" \
    --write-out 'HTTP %{http_code}\n耗时 %{time_total} s\n' > "$dir/metrics.txt"
  curl_rc=$?
  cat "$dir/metrics.txt"
  printf 'curl_exit_code=%s\n' "$curl_rc" >> "$dir/metrics.txt"
  printf '完整输入输出保存于：%s\n' "$dir"
  if [ "$curl_rc" -ne 0 ]; then
    printf '传输结果待核实，请保留本目录并按第五节查询，先不要新建请求。\n' >&2
    return "$curl_rc"
  fi
  printf '查看响应：python3 -m json.tool "%s/response.json"\n' "$dir"
}
```

## 三、逐项复制验证

每项先列精确输入，再给可执行命令，最后列历史实测输出摘要。运行前须完成第二节初始化。

### 01. Bilibili 搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "bilibili",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '01-bilibili' '/api/v1/data/search' \
  '{"platform":"bilibili","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 3.55,
  "requestId": "5c9cda14-d020-40fc-b4a3-b9f47c02a324"
}
```

### 02. 抖音搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "douyin",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '02-douyin' '/api/v1/data/search' \
  '{"platform":"douyin","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "partial",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [
    "non_post_items_excluded"
  ],
  "providerCalls": 1,
  "seconds": 8.78,
  "requestId": "84137cdb-7372-43f4-b38e-31605960ab9d"
}
```

本次 `partial` 对应 `non_post_items_excluded`：排除了非内容条目，已经交付 1 条有效内容。

### 03. 快手搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "kuaishou",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '03-kuaishou' '/api/v1/data/search' \
  '{"platform":"kuaishou","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "partial",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [
    "non_post_items_excluded"
  ],
  "providerCalls": 1,
  "seconds": 7.51,
  "requestId": "714c978e-894f-4aec-9f71-60040c9611ac"
}
```

本次 `partial` 对应 `non_post_items_excluded`：排除了非内容条目，已经交付 1 条有效内容。

### 04. Reddit 搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "reddit",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '04-reddit' '/api/v1/data/search' \
  '{"platform":"reddit","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "partial",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [
    "non_post_items_excluded"
  ],
  "providerCalls": 1,
  "seconds": 5.22,
  "requestId": "0212cf13-49a0-4f1b-b822-baadac2de9b8"
}
```

本次 `partial` 对应 `non_post_items_excluded`：排除了非内容条目，已经交付 1 条有效内容。

### 05. TikTok 搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "tiktok",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '05-tiktok' '/api/v1/data/search' \
  '{"platform":"tiktok","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 13.93,
  "requestId": "ea15a847-3614-4637-b67f-30316d2d3c95"
}
```

### 06. Twitter / X 搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "twitter",
  "query": "from:NASA",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '06-twitter-search' '/api/v1/data/search' \
  '{"platform":"twitter","query":"from:NASA","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 5.13,
  "requestId": "8d97903f-009f-4aa9-ade4-d71ca84bc805"
}
```

保留本次原查询 `from:NASA`；这里使用平台搜索表达式，不把它改成普通关键词。

### 07. 微博搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "weibo",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '07-weibo' '/api/v1/data/search' \
  '{"platform":"weibo","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 2,
  "seconds": 8.92,
  "requestId": "9fe01f02-f75e-415f-bfe8-3b8ed14af203"
}
```

### 08. 小红书搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "xiaohongshu",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '08-xiaohongshu' '/api/v1/data/search' \
  '{"platform":"xiaohongshu","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 2,
  "seconds": 15.07,
  "requestId": "c080bf57-6c72-46ee-a7f5-70eda4bad2fb"
}
```

### 09. YouTube 搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "youtube",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '09-youtube' '/api/v1/data/search' \
  '{"platform":"youtube","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 5.84,
  "requestId": "26d0ed73-0ce8-43e1-a017-d3341129aeac"
}
```

### 10. 知乎搜索

- 方法与路径：`POST /api/v1/data/search`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "zhihu",
  "query": "新能源",
  "pageSize": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '10-zhihu' '/api/v1/data/search' \
  '{"platform":"zhihu","query":"新能源","pageSize":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "night-all.data-search.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 6.26,
  "requestId": "67324932-8063-4eac-a000-b3b7e8a088ad"
}
```

### 11. Twitter / X 账号内容

- 方法与路径：`POST /api/v1/data/social/crawl`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "twitter",
  "username": "NASA",
  "count": 1,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '11-twitter-crawl' '/api/v1/data/social/crawl' \
  '{"platform":"twitter","username":"NASA","count":1,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "ok",
  "count": 1,
  "contractVersion": "mx-insight-hub.social-compat.v1",
  "warnings": [],
  "providerCalls": 2,
  "seconds": 12.14,
  "requestId": "39b46f64-856a-451b-912f-246d95f4a8b2"
}
```

账号 `NASA` 不带 `@`；`count: 1` 是本次内容返回上限，实际需要的账号解析会计入上游调用数。

### 12. Twitter / X 帖子评论

- 方法与路径：`POST /api/v1/data/social/post-comments`
- [ ] 重新验证 HTTP 200、合同版本正确，并检查业务列表和分页状态。

**输入 JSON**

```json
{
  "platform": "twitter",
  "contentId": "2116983579343253696",
  "count": 20,
  "fillPage": false
}
```

**复制调用**

```bash
hub_post '12-twitter-comments' '/api/v1/data/social/post-comments' \
  '{"platform":"twitter","contentId":"2116983579343253696","count":20,"fillPage":false}'
```

**实测输出摘要（非完整响应）**

```json
{
  "http": 200,
  "status": "partial",
  "count": 20,
  "contractVersion": "mx-insight-hub.post-comments.v1",
  "warnings": [],
  "providerCalls": 1,
  "seconds": 3.34,
  "requestId": "1216ed05-bf71-4d12-a70a-8cbf362f5692",
  "replay": false,
  "contractValid": true,
  "commentsObserved": true,
  "pagination": {
    "hasMore": true,
    "nextCursorPresent": true,
    "continuationAvailable": true,
    "paginationStatus": "continuable"
  }
}
```

此帖子在历史验收和本次复测中均返回过 20 条评论。帖子 ID 必须保留为字符串。当前 `partial` 伴随可继续分页，`warnings` 为空；本页成功不代表全帖评论已获取。

## 四、参数和响应字段怎么读

### 4.1 本清单涉及的输入字段

| 业务 | 字段 | 类型 | 说明 |
| --- | --- | --- | --- |
| 全部 | `platform` | string | 平台标识；评论和账号用例固定为 `twitter` |
| 全部 | `fillPage` | boolean | 本清单固定为 `false`；字符串 `"false"` 会报错；不传默认 `true` |
| 搜索 | `query` | string | 1–500 字符；本清单除 Twitter 外为“新能源”，Twitter 为 `from:NASA` |
| 搜索 | `pageSize` | integer | 本次为 1；公开范围 1–100、默认 20，另受当前 Key 限制 |
| 搜索 | `type` | string | 本次未传，保持默认 `fresh`；可选 `stable`，不要在复现原请求时悄悄改变参数 |
| 账号内容 | `username` | string | 本次为 `NASA`；目标活动默认 `posts` |
| 账号内容 | `count` | integer | 本次为 1；默认 20，范围 1–500，另受 Key 限制 |
| 帖子评论 | `contentId` | string | 本次为 `2116983579343253696`；Twitter 为 1–30 位数字字符串 |
| 帖子评论 | `count` | integer | 本次为 20；默认不超过 20，最大不超过 100，均受 Key 上限限制 |
| 续页 | `cursor` | string | 原样使用上一页返回的 Hub `nextCursor`；新页另用一个新幂等键 |

### 4.2 三类响应的位置不同

| 内容 | 搜索 `/data/search` | 账号内容 `/social/crawl` | 帖子评论 `/social/post-comments` |
| --- | --- | --- | --- |
| 合同字段 | `data.contractVersion` | 顶层 `contractVersion` | 顶层 `contractVersion` |
| 合同值 | `night-all.data-search.v1` | `mx-insight-hub.social-compat.v1` | `mx-insight-hub.post-comments.v1` |
| 结果数组 | `data.items` | `data.items` | `data.items`；`data.comments` 为同一评论列表 |
| 结果 ID | `data.items[].id` / `externalId` | `data.items[].content_id` | `data.items[].commentId` |
| 对应原帖 | 搜索项本身 | 账号内容项本身 | `data.postId`、`data.items[].contentId` / `postId` |
| 业务状态 | `data.status` | `data.status` | `data.status` |
| 警告 | `data.warnings[]` | `data.warnings[]` | `data.warnings[]` |
| 分页 | `data.pageInfo` | `data.page`，同时提供 `data.pageInfo` | `data.page`，同时提供 `data.pageInfo` |
| 返回数量 | `data.items.length`、`data.pageInfo.returnedCount` | `data.items.length`、`data.page.returnedCount` | `data.items.length`、`data.page.returnedCount` |
| 续页游标 | `data.pageInfo.nextCursor` | `data.page.nextCursor` | `data.page.nextCursor` |
| 来源调用数 | `data.meta.providerCalls` | `data.meta.providerCalls` / `upstreamCallCount` | `data.meta.providerCalls` / `upstreamCallCount` |
| 请求 ID | 顶层 `requestId`；响应头 `x-mx-insight-request-id` | 同左 | 同左 |

不要把摘要脚本生成的顶层 `count`、`http`、`seconds` 当成 API 原始响应字段；它们分别来自结果数组、HTTP 状态码和客户端计时。

### 4.3 查看完整响应

例如查看 Twitter 评论：

```bash
python3 -m json.tool "$HUB_OUT/12-twitter-comments/response.json"
cat "$HUB_OUT/12-twitter-comments/response.headers.txt"
cat "$HUB_OUT/12-twitter-comments/metrics.txt"
```

针对重新验证的结果，逐项核对：

- [ ] HTTP 200，且没有顶层 `error`。
- [ ] 合同版本、目标平台与对应接口一致。
- [ ] `data.items` 是数组，数量与分页返回数量一致。
- [ ] 本次非空交付验收要求 `data.items.length > 0`；合法空页需单独标记为“尚未验证非空数据”，而非直接认定该平台没有内容。
- [ ] Twitter 评论的 `data.postId` 与请求 `contentId` 一致；抽查评论 ID、正文、作者和时间。
- [ ] 阅读 `data.status`、`warnings` 和分页信息；`partial` 本身不等于失败。
- [ ] 保存 Request ID、原请求 JSON、幂等键、HTTP 状态、耗时和完整响应。

分页判读：

| 本页信号 | 解释 |
| --- | --- |
| `hasMore: true` 且 `nextCursor` 非空 | 可显式请求下一页；其中可能包含已购缓冲余量 |
| `hasMore: null` / `paginationStatus: "unknown"` | 完整性未知；有游标也不能保证下一页非空 |
| `nextCursor` 为空 | 当前没有可使用的续页入口；结合警告判断，不单凭空游标声称评论已取完 |
| `providerCalls: 0` | 可能是已有缓冲或回放；结合 `idempotent-replay` 响应头判断 |

本清单只验证首页，不自动发起第二页请求。

## 五、超时、失败与回执查询

### 5.1 传输超时先查原请求状态

下面是只读 GET，不触发新采集。以评论用例为例：

```bash
CASE_DIR="$HUB_OUT/12-twitter-comments"
ORIGINAL_KEY="$(cat "$CASE_DIR/idempotency-key.txt")"
curl -q --silent --show-error --connect-timeout 10 --max-time 30 \
  "$HUB_URL/api/v1/requests/by-idempotency-key" \
  --header "Authorization: Bearer $HUB_KEY" \
  --header "Idempotency-Key: $ORIGINAL_KEY" \
  --output "$CASE_DIR/request-status.json"
python3 -m json.tool "$CASE_DIR/request-status.json"
```

- 原业务请求 ID 位于 **`data.id`**，顶层 `requestId` 是本次状态查询的 ID。
- `data.status: reserved` / `unknown`：保留原标识并排查，不自动重发或换键。
- `data.status: committed`：已有保存响应，不保证原业务 HTTP 为 200。继续读取已有交付记录。
- 状态查询 404 或失败时，先核对 Key 所属 consumer、幂等键和连通性，不把它直接当成未发生采集。

### 5.2 读取已有完整交付记录

取得上述 `data.id` 后执行，仍为只读：

```bash
REQUEST_ID="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["data"]["id"])' "$CASE_DIR/request-status.json")"
curl -q --silent --show-error --connect-timeout 10 --max-time 30 \
  "$HUB_URL/api/v1/acquisitions/$REQUEST_ID" \
  --header "Authorization: Bearer $HUB_KEY" \
  --output "$CASE_DIR/delivery.json"
python3 -m json.tool "$CASE_DIR/delivery.json"
```

原响应位于 `data.delivered.responseBody`，原 HTTP 状态位于 `data.delivered.responseStatus`。此接口须使用原请求所属的 API Key 身份，同时匹配 consumer 和 API Key；同一 consumer 的另一把 Key 不足以读取该交付记录。前面的状态查询可以使用同 consumer 的有效 Key。

同一请求重试必须保持原请求体和幂等键，但这不是跨任意时间无限回放的保证：搜索默认 `fresh` 的回放窗口有限（当前为 120 秒）。优先通过上述 GET 查看保存状态和响应，避免把重复 POST 当成长期只读查询。

### 5.3 常见判读

| 返回 | 判读 |
| --- | --- |
| `400 invalid_fill_page` | `fillPage` 类型不对，检查是否写成了字符串 |
| `400 unsupported_fields` / `invalid_post_comments_request` | 查看错误消息涉及的字段；需区分旧版本与其他参数问题 |
| `400 fill_page_unsupported` | 当前平台或路径不支持该模式 |
| `401` / `403` | 分别核对 Key 有效性、平台和 capability 授权 |
| `409 idempotency_conflict` | 同一个幂等键对应了不同请求；先核对原请求 |
| `429` / `502` / `503` | 保留 `error.code`、`error.details`、Request ID，再按限流、上游或服务状态排查 |
| `200` + `partial` | 阅读警告与分页；不可仅凭 partial 认定失败 |

## 六、给开发测试回传的最小材料

1. 用例编号、执行时间、访问地址和调用身份名称（不含 Key）。
2. `request.json` 与 `idempotency-key.txt`。
3. `response.json`、`response.headers.txt` 和 `metrics.txt`。
4. 有异常时补上 `request-status.json` 与已有交付记录；无需重复全组采集。

完整响应可能含业务内容，按团队既有权限共享；不要附上 API Key。

相关契约：[单次返回接口说明](../api/strategy-search-single-page.md)、[策略搜索使用手册](../api/strategy-search-api.md)。
