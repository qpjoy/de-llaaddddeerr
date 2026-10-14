# 统一内容搜索接入与旧接口兼容

更新：2026-10-15。本文说明当前源码合同与本地合成 HTTP 回归，不表示已经发布或供应商实时可用。产品操作指南也可在登录后的 `/docs/strategy-search` 查看，其内容按当前授权过滤。

## 路径与响应

TikTok 与微信都可使用 `POST /api/v1/data/search`。统一的是 Hub 入口、调用身份和管理方式，已发布的响应合同继续保留：

| 场景 | 请求核心字段 | 响应解析 | 分页 |
| --- | --- | --- | --- |
| TikTok 标准搜索 | `platform=tiktok`、`query`、`pageSize` | `data.contractVersion=night-all.data-search.v1`；`data.items` 数组 | `data.pageInfo.nextCursor` |
| TikTok 旧 raw 搜索 | `platform=tiktok`、`keyword/query`、`count` | `data.raw_info`、`data.raw_data` 为 JSON 字符串 | `data.page.nextCursor` |
| 微信标准入口 | `platform=wechat_search/wechat_mp`、`query`、可选 `params` | 顶层 `endpoint=wechat.search.search`；保留专项 `contractVersion/endpoint/data/meta/requestId` | `data.continue_flag` 与 `data.cursor` |
| 微信专项接口 | `/api/v1/data/wechat/search/search`，参数放在 `params` | 同上，专项合同 | 同上 |

TikTok 的 `/api/v1/search/raw` 与 `/api/v1/night-all/search/raw` 继续保留原格式，共用同一逻辑请求与幂等身份；账号内容等其他系列接口不变。标准与 raw 是不同合同，不能只替换 URL；不能把标准游标交给 raw，或反过来。

微信 `/api/v1/search/raw` 仍映射到专项新合同，与标准入口和专项路径共享业务指纹。此前已经退役的 `/api/v1/night-all/search/raw` 微信分支继续返回 `410 wechat_search_route_retired`；本轮不恢复旧格式，也不回退 Night-All。其他微信数据产品的专项接口继续保留。

## TikTok 标准请求

```bash
curl -sS "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: tiktok-search-page-1' \
  --data '{"platform":"tiktok","query":"城市观察","pageSize":20,"type":"stable"}'
```

需要原 consumer 与 Key 交集内的 `tiktok` 平台授权，并通过当前额度、客户价格与余额检查。`pageSize` 受当前平台策略限制，是上限提示，不保证补满结果。标准结果保留字符串 ID、完整已获取正文、媒体链接与零值指标；未知指标为 null，不能显示成零。公开标准响应中的 `source.provider/endpointId` 保留为 null，不能用它判断具体执行渠道。

下一页保持原查询、页大小、type 和调用身份，原样返回 `data.pageInfo.nextCursor`，换用新的 Idempotency-Key。Hub 包装的 `mxnc1` 游标绑定操作、consumer 和查询形状，并保留 15 页边界；不解析或自行拼接供应方 continuation。首屏重新开始时去掉 cursor，显式使用新键。

同一请求体与键在原重放窗口内返回原交付，不再采集或扣款。`type=fresh` 的重放窗口仍为 120 秒，`type=stable` 沿用永久重放；不能把 fresh 的相同键当成永久免采集查询。每个明确的新页面仍按现行客户规则独立计费。

## 微信标准入口

```bash
curl -sS "$HUB_URL/api/v1/data/search" \
  -H "Authorization: Bearer $HUB_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: wechat-search-page-1' \
  --data '{"platform":"wechat_search","query":"城市观察","pageSize":20,"params":{"raw":false}}'
```

`wechat/weixin` 是 `wechat_search` 的兼容别名。公众号内容使用 `wechat_mp`，映射为 `business_type=article`；综合分类、排序、时间等条件遵循专项接口声明。实时请求需要同一 consumer 和 Key 内的 `social + native.wechat.search.search` 精确授权，旧 `wechat_mp/wechat_search` 平台权限仅用于相应已收录数据，不授予新的实时权限。

需要结果列表时显式传 `params.raw=false`，读取 `data.items`；`data.categories` 是分类导航，不能当作内容。微信响应保留专项字段及其值，不改成 TikTok 的 v1 投影；前端应先识别 `endpoint=wechat.search.search`。使用其他 raw 模式时按专项合同展示原业务响应，不能在任意嵌套数组中猜测结果。

专项接口没有页大小控制。标准入口的 `pageSize` 和兼容入口的 `count/limit` 仅接受旧默认提示 20；它不保证返回 20 条，也不截断或自动补页。微信关键词最多 100 字，不能把普通标准平台的 500 字限制套到该分支。

有继续标识 `continue_flag=true/1`、没有 `no_more`，并有新的非空 `data.cursor` 时，原样传到标准入口的 `cursor` 或专项接口的 `params.cursor`，新页面使用新 Idempotency-Key。不要使用 TikTok 的 `data.pageInfo` 逻辑，不要靠 page/offset 另造翻页，也不能复用旧 `mxnc1` 微信游标。批量词、自动补详情和不能映射的旧控制会明确拒绝，不能静默丢弃。

下面两个请求与上述微信标准请求在相同业务参数和相同 Idempotency-Key 下共享交付，不重复采集或结算：

```json
{"params":{"keyword":"城市观察","raw":false}}
```

用于 `POST /api/v1/data/wechat/search/search`。

```json
{"platform":"wechat_search","keyword":"城市观察","params":{"raw":false}}
```

用于 `POST /api/v1/search/raw`。公众号的专项参数还需保留 `business_type=article`。微信标准入口兼容 `type=fresh/stable`，两者都保留专项永久重放；新采集需由调用方显式使用新键。已用于退役旧合同的键冲突时返回 409，不覆盖原历史记录或再次购买。

## 展示与故障处理

Hub 产品展示识别实际响应合同后展示平台、正文、原链接、作者、媒体、已有指标、交付状态和请求 ID。微信分类导航、未知指标或缺失媒体不构成搜索结果或完整度证明。多平台展示应使用 `/api/v1/data/aggregate/search`；一次普通 `/data/search` 仍只查询一个明确平台。

保存 HTTP `x-mx-insight-request-id` 与响应 requestId，用原调用身份读取请求状态。结果未知或请求仍处理中时，只读核对；不要自动新建键、切换路径或再次 POST 来探测是否恢复。参数、授权、余额、额度和运行状态分别处理，接口目录和迁移状态不证明当前上游健康。

本轮测试使用本地内存存储、合成响应与 loopback HTTP：TikTok 标准/旧 raw 格式、跨别名重放、独立页面计费、游标隔离、授权和未知结果保护；微信别名、原生分页字段、跨路径重放、fresh/stable 重放语义，以及指南的同 consumer 权限过滤。未发起生产采集、付费探测、数据库迁移，也未改变 Launcher 或 MX-H2I 登录与联网。
