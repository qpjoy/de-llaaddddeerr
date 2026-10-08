# Hub 搜索的平台迁移与内容标题

2026-10-08。沿用 `POST /api/v1/search/raw`，保留 `POST /api/v1/night-all/search/raw` 为同一入口。没有新增 `/api/v1/data/search/raw`。Delta 无需修改 URL；以后可只把 URL 改为 `/api/v1/search/raw`，请求体、Key 和同次请求的幂等键不变。

## 本次路由

| 平台 / 请求形状 | 处理位置 |
| --- | --- |
| 微博，单个 `keyword` 或 `query`，不超过 500 字符，有效页大小至少 20（仍受原 Key 上限约束） | Hub 直连已注册的实时搜索接口，按需获取全文 |
| Instagram，同样的单关键词，有效页大小至少 20，不要求详情补取 | Hub 直连已注册的 general search；保留 caption、媒体和复合分页状态 |
| Twitter，同样的单关键词，有效页大小不超过 50，不要求详情补取 | Hub 复用现有 RapidAPI 适配器；标准 `raw_data[].title` 为空字符串，canonical title 为 null |
| Facebook | 采集仍用现有 Night-All 复杂处理；新交付的内容空标题规则由 Hub 执行 |
| 已支持的小红书、微信 | 保留原有路由和权限规则，包括旧 Night-All 微信入口的 410 |
| 批量关键词、未迁移平台、特殊筛选/工作量参数 | 保留历史处理，逐步迁移 |

新直连子集允许空 `params`，不支持非空 params、评论补取、缓存时长、并发参数；显式 `page>1` 和旧 `mxnc1` 游标继续走历史链路。普通首屏允许 `page=1`。`count/limit/pageSize` 沿用原解析优先级。

Hub 新分页使用绑定 consumer、Key、平台、查询与页大小的 `mxraw1` 游标，最多 15 页。下一页保持请求条件，提交顶层 `cursor`，每页使用新幂等键。新的 Hub 游标不会回退至 Night-All；已选择直连后，停用操作、凭据错误、限流、供应商异常或未知结果也不会改走旧通道。

微博分页兼容已经验证的上游 `pagination={}`：非空页提供续页游标，空页停止，仍限制 15 页。供应商不接收 Hub 的 pageSize，不能因返回不足 pageSize 就停止。若供应商明确返回布尔 `has_next_page`，按其值处理。Hub 不自动请求下一页；其余未知分页形状仍明确失败。实际响应证据与冷启动修复见 [微博搜索诊断](weibo-search-diagnostics.md)。

## 微博全文

搜索结果包含“展开c”“展开全文”等末尾标记或明确的长文标记时，Hub 调用已注册详情接口，固定 `is_get_long_text="true"`。只使用 ID、作者（搜索已提供时）和正文前缀一致、严格更长且不再带截断标记的全文，优先 `longText.content`，其次 `text_raw`。更新 `text/content/full_text`，普通帖子标题保持空，不再把正文复制为标题。保留搜索获得的指标、时间和媒体。

正文比较兼容已从归档确认的显示差异：`名称超话` / `#名称[超话]#`，以及搜索省略的 `[笑cry]`、`[打call]` 标签。只在比较中统一，完整正文原样保留话题和表情。未知括号内容和实质正文差异仍拒绝；详情展示文本匹配本身不代替全文匹配。归档诊断显示 `prefixComparison.policy=weibo_display_v1` 时，使用的是这套规则。

`includeDetails=true` 可请求详情；`disableAutoDetails=true` 保留原有禁止自动补取的语义。补取最多 `maxEnrichItems` 条，默认 20，同时受请求租约、供应商操作状态、限流和采购预算约束。每个详情请求都有独立采购成本与完整响应证据，但共用原搜索的一个客户用量/钱包身份。不会因为失败或响应未知而自动重试付费请求。

未补齐的摘要原文保留，并返回 `body_completeness=provider_preview`、`data.status=partial`、`WEIBO_FULL_TEXT_INCOMPLETE` 和不完整数量，不把删除“展开”当成全文修复。

## `/api/v1/data/search`

2026-10-08 后续修复：微博、Instagram 的普通查询（`pageSize=20–100`，仍受原 Key/套餐上限约束）首屏由 Hub 直接请求上游，不经过 Night-All。`platform=ins/ig/insta` 统一为 `instagram`。用户原来的 curl 请求体无需变化：

```json
{"platform":"weibo","query":"尊界V800 支架断裂","pageSize":20}
```

返回原 `night-all.data-search.v1` 严格结构：`data.items`、`data.pageInfo`、`status/warnings/meta`。普通微博/Instagram 帖子 `title=null`，正文仍在 `text`。微博默认进行上述受控全文补取；未验证全文时保留短文，返回 partial 与 warning。字段类型、内容 ID、平台授权、原平台客户计费 meter 和按结果条数记录的 usage 不变；补详情共用一个客户请求。raw 路径继续使用 raw meter 和一个 usage 单位，两套路径不是计费别名。

新 data-search 游标为 `mxds1`，绑定 consumer、Key、平台、查询、pageSize 和 type。最多 15 页，与 raw 的 `mxraw1` 不可互换。Instagram 同时保存 `next_max_id` 与 `rank_token`，只解析已知媒体网格/items；推荐词不当作帖子。重复游标停止续页。上游超出请求页大小、未知结构或缺少必要续页字段时，保留完整证据并明确失败，不截断结果、不重试或回退第二次付费调用。页大小小于 20 和旧 `mxnc1` 游标暂保持原采集链路。

保留 `type=fresh` 默认 120 秒重放窗口，以及 `type=stable` 永久重放语义。部署验收使用新幂等键，避免把旧交付当作新实现；保留旧键则按原规则重放。原请求 fingerprint 不因迁移改变。

标题治理同时覆盖新交付的历史 data-search/raw 响应与 canonical 入库：微博、Instagram、Twitter、Facebook 普通帖子不以正文/显示名称生成标题。raw 标题为空字符串，data-search/canonical 为 null。账号、地点、话题及明确标记的文章名称保留；其他平台不改。历史供应商原文、原始响应快照和已交付重放不改写；旧 canonical 数据在后续正常入库时生成修订，不做全库回填。

## 权限、账单与历史

迁移保持原平台授权和 `raw` 客户计费 meter，不自动发放 capability、修改限额、发布价格或启用供应商操作。内部执行仍经过已审核的操作控制、采购价格、凭据、预算、限流与出站策略。直接调用 native 接口仍需要其独立授权。

微博依赖已启用的 `native.t.weibo_web_v2_fetch_realtime_search`，补全文依赖 `native.t.api_4f35621a9c07e539`；Instagram 依赖 `native.t.instagram_v3_general_search`；Twitter 依赖 `social.content.search`。只有直连请求形状使用这些操作；历史处理保留原控制。未就绪的直连操作会明确报错，不绕过管理员暂停。部署不自动启用操作，也不修改已有采购价格。

两条 raw URL 共用旧的逻辑 fingerprint。已经成功交付的旧 raw 请求直接重放其原响应，即使当时还有短文或合成标题，也不重写、不再次采集、不重复计费。原始供应商响应与新交付响应分别存储。

## 部署与验证

部署 Hub API 和 ingest worker 即可，Delta、Luopan、Night-All 不需要同步发布。按现有 migrate 流程顺序执行 migration 132、133：前者保护 raw 的 `night-all.compat.v1`，后者扩展到 data-search 的 `night-all.search.v1`。只保护带有 Hub 全文验证标记的微博，阻止后来的同前缀“展开”短文覆盖全文；保留原始证据和观察，允许真正的内容编辑与删除。不回填旧记录，不改 migration 131，也不更新下游数据库中已经保存的摘要。

后续 migration 134 将这项保护扩展到带 `provider_preview` 标记且满足长度与同前缀条件的上述格式等价摘要及省略号摘要。仍只保护已由 Hub 验证的全文，无历史回填或旧幂等响应改写。需要正常 deploy 执行迁移并重建镜像；可用已保存响应离线验证新合并规则，无需再次付费。

本次未改 Launcher/MX-H2I 登录、联网或支付服务。最初的路由迁移未新增付费请求；后续空分页修复经用户授权新增一次微博搜索验证，其原始响应只用于离线重放。测试使用模拟供应商、原先已获授权保存的真实详情响应，以及独立 PGlite 数据库执行迁移。覆盖别名重放、旧响应重放、全文匹配、补取失败、采购成本、空标题、15 页与跨 Key 游标边界、原始证据和全文保护。

入口：`tests/server/raw-search-routing.test.mjs`、`tests/server/weibo-long-text-migration.test.mjs`。SQL 测试通过 `MX_INSIGHT_TEST_PGLITE_MODULE` 指向本机 PGlite 模块；测试不连接生产。
