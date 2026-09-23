# 下游调用 Hub 的游标标准

适用：Hub 历史采集兼容接口 `/api/v1/night-all/search/raw`、`/crawl`、`/user-info`。
本文以单平台关键词 raw 搜索为例。业务数据、鉴权、计费和幂等规则保持原有契约。
这是现有统一入口的调用规范，不新增供应商参数或另一个接口版本。

## 1. 唯一续页入口

- 首屏不传 `cursor`、`page` 或上游续页参数。
- 下一页读取 `data.page.nextCursor`，原样放入下一次请求的顶层 `cursor`。
- cursor 是不透明字符串：不得解码、修改、截短、转成数字、从内容 ID 推导或自行递增。
- 不根据平台分支拼装 search_id、backtrace、offset、page、pcursor 等参数。
- 下一页沿用相同接口、调用身份、平台、查询/账号、count 和静态筛选条件。
  即使底层以 consumer 绑定游标，也不要依赖跨 Key 重用；Key 授权每次仍会检查。
- 改关键词、平台、筛选条件或 count，应开始新首屏，使用新的幂等键；不要复用旧游标。
- 原有 `data.page.nextParams.cursor` 是兼容别名，新接入只使用 nextCursor。
  不同时提交多个续页入口，不依赖 token 前缀或 `paginationMode` 编写客户端分支。

`POST /api/v1/data/search` 的读取位置是 `data.pageInfo.nextCursor`，请求同样使用
顶层 cursor，但业务请求字段与终止字段遵循该接口自身的版本契约。
不同接口的游标不能互换。原生供应商接口和存量数据浏览接口不因本文自动变成相同包络。

特别注意页大小字段：兼容 `/night-all/search/raw` 使用 `count`，标准 `/data/search`
使用 `pageSize`。标准接口不接收 `count` 或 `params`，直接复制兼容请求体会得到
`400 unsupported_fields`；统一的是 cursor 调用方式，不是两个接口的所有请求字段。
例如标准首屏为 `{"platform":"douyin","query":"受害企业 赔偿回收率","pageSize":20}`，
续页仅追加顶层 cursor，值来自 `data.pageInfo.nextCursor`。

## 2. 首屏和下一页示例

两次均调用 `POST /api/v1/night-all/search/raw`，使用已授权的 Hub API Key。
HTTP headers：`Authorization: Bearer <HUB_API_KEY>`、`Content-Type: application/json`。

首屏：`Idempotency-Key: <为首屏生成并保存的唯一值>`。

```json
{
  "platform": "douyin",
  "query": "受害企业 赔偿回收率",
  "count": 20
}
```

响应的分页部分（示意，不是完整响应）：

```json
{
  "data": {
    "page": {
      "returnedCount": 8,
      "hasMore": true,
      "nextCursor": "<Hub 返回的不透明字符串>"
    }
  }
}
```

第二页：`Idempotency-Key: <为第二页生成并保存的另一个唯一值>`。

```json
{
  "platform": "douyin",
  "query": "受害企业 赔偿回收率",
  "count": 20,
  "cursor": "<原样复制首屏的 data.page.nextCursor>"
}
```

不传 `page: 2`，不传供应商 `search_id/backtrace`。第三页使用第二页返回的新 cursor。
同样的调用方式适用于本兼容接口支持的其他平台；只改变首屏业务参数，不改变翻页算法。

## 3. 终止与异常

- count 是请求上限，不承诺填满。返回 1–19 条且存在有效续页信息时，不能因为少于 20 条终止。
- returnedCount=0 表示空结果，应停止；明确 hasMore=false 时也必须停止，即使残留旧 cursor。
- nextCursor 为 null、空或缺失时停止，不能猜下一页。若 hasMore=true 却无 cursor，记录
  为不可继续的分页契约异常，而不是宣称已获取全部数据。
- 若 nextCursor 与当前请求 cursor 相同，停止并记录分页无进展；不同 token 仍可能承载相同
  上游状态，因此客户端还应有明确的请求页数/费用预算，不能无界循环。
- 当前兼容接口最多 15 页。page_limit_reached 表示达到 Hub 采集边界，不证明上游数据耗尽。
- 上述判定在请求成功且业务成功之后执行；不能把 4xx/5xx、失败包络或字段缺失当成空结果。
- 持久化每页的请求体、幂等键、Hub requestId 与成功返回的 nextCursor；失败时不推进检查点。
  凭据与游标不要写入公共日志，错误上报提供 requestId 即可。

## 4. 幂等、失败与重新开始

| 情况 | 行为 |
| --- | --- |
| 请求下一页 | 使用上一页新 cursor，并生成该页自己的幂等键 |
| 同一页发生网络超时/连接断开 | 保留原 body 和原幂等键，按错误契约查询/处理结果，不能换键盲重试 |
| 结果为 unknown/in-progress | 保留检查点，等待核对；不能作为确定失败继续新付费请求 |
| 已明确失败 | 停止并保留证据；是否重试及是否使用新键取决于故障处理，不自动无限重试 |
| 409 idempotency_conflict | 同一键对应了不同请求，修正客户端状态管理，不能靠随机换键掩盖问题 |
| 400 invalid_cursor / 查询条件改变 | 不修补 token；明确开始新首屏、新键和新的游标链 |
| 服务升级前生成的缺上下文游标 | 升级不会修复 token 内容；受影响查询需要新首屏，不能重放旧首屏交付来生成上下文 |

新首屏意味着可能重新付费，不应自动批量重启全部任务。读取历史 requestId 或复现已交付
结果是只读操作，不会向供应商重新查询，也不会重写旧交付的游标。

## 5. Hub 与 Night-All 的实现边界

Hub 负责统一公共 cursor、作用域/身份校验、页数边界、完整状态封装和计费。
供应商参数适配可以实现在 Hub 原生 adapter 或 Night-All；下游规则不随实现位置改变。
适配粒度应为供应商 + 平台 + 操作 + 端点版本，不能仅按平台推断所有接口的参数。

抖音当前搜索端点需要保留上游实际提供的 cursor、search_id、backtrace；TikTok 的
offset/search_id、YouTube 的 continuation token 等也必须完整保存。
这些是内部字段，客户端不直接处理。游标没有包含的上游上下文不能凭空补造。
跨端点 fallback 是否能复用 session 需要单独验证，不能默认 V1 和 V2 搜索上下文通用。

本次故障的当前 Hub 本地源码已包含 compound 修复（d2cceed8）。服务器诊断却显示
preservesCursor=true、preservesSearchId=false、preservesBacktrace=false，证明所测运行
实例缺少该处理；历史游标认证解密也确认只有 cursor=8。应先更新实际服务及全部副本，
验证三项均为 true，再处理受影响旧游标。此证据确认上下文丢失，但供应商 400 的精确
解释仍缺原始错误响应。参见 [事件证据](../operations/douyin-second-page-502.md)。
