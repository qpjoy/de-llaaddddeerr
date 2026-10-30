# Hub 账号内容与资料接入指南

更新：2026-10-21。当前源码与离线验证说明；不表示生产已经发布。

本轮接管 `/api/v1/data/social/crawl` 和 `/api/v1/data/social/user-info`，保留 `/api/v1/night-all/search/crawl|user-info` 及 `/api/v1/search/crawl|user-info` 原有转发行为。下游逐步切换前不删除旧入口，不改 `/data/search` 的既有供应链，也不扩展 Twitter 专用 `/data/social/search`。

新账号接口的源码平台清单为 `twitter、facebook、instagram、bilibili、douyin、kuaishou、weibo、xiaohongshu、youtube、zhihu、tiktok、linkedin、reddit`。这表示已有固定适配合同，不表示各平台已在生产部署、正式操作已启用或实时请求已验证成功。账号资料是查询已知账号，不是关键词搜索账号。

调用须同时具有所选平台和 `social.content.crawl`（账号内容）或 `social.profile.get`（账号资料）授权。原 Key 的平台授权不自动增加这两个 capability。内部供应商原生操作仍须通过各自的合同、操作状态、凭据、采购价格及准入检查；拥有公共账号 capability 不会绕开这些门禁，也不要求调用方提交内部端点名。上线、浏览目录和打开文档不会自动扩权、启用操作或发起付费验证。

## 参数兼容

一次请求选择一个平台。支持 `username/usernames`、`userId/userIds/user_id/uid`，以及 `url/urls/profileUrl/profile_url`；频道使用 `channelId/channel_id/channelUrl/channel_url`。`usernames/userIds/urls` 可为同平台列表，平台账号、主页域名和标识格式仍需合法。常见旧账号别名可放在对应 `params` 中；具体额外业务参数由固定平台合同验证，未知参数在执行前拒绝，不任意透传。

历史 `businessId/business_id` 可省略；保留该字段的旧调用方必须提交与当前认证消费者绑定的原值，不能用它切换消费者身份或跨租户查询。

Twitter 的 `x/tw` 归一为 `twitter`。业务调用方不必区分 `username` 与 `userId`：顶层 `username/usernames/userId/userIds/user_id/uid`，以及对应 `params` 账号别名（包括 `screen_name/screenName`），都根据账号字符串内容自动识别。非数字值按用户名解释，例如 `ui_batch_019`；但它可能只是下游任务编号，不能由参数形状推断该平台账号存在。没有可确认账号时应返回明确失败，不把资料对象算成一条内容或把解析失败伪装成分页耗尽。

无 `@` 的纯 ASCII 数字字符串按用户 ID 查询，须符合 [X 官方 ID 查询 API](https://docs.x.com/x-api/users/get-user-by-id) 的 `[0-9]{1,19}`。例如 `username: "1234567890123456789"` 和 `userId: "1234567890123456789"` 均调用 ID 查询，不再受用户名 15 字符限制。数字 ID 使用字符串传输，避免 JavaScript 数值精度丢失；不能使用科学计数法或格式化后的数值代替原始 ID。

账号值显式带 `@`，或通过 `url/urls/profileUrl/profile_url` 字段提交 Twitter / X 主页 URL，表示用户名，即使账号名全部由数字组成。例如 `username: "@12345"` 或 `url: "https://x.com/12345"` 查询用户名 `12345`；裸字符串 `"12345"` 则查询用户 ID。产品展示中 Twitter 使用一个用户名 / ID 输入框自动识别，不要求选择字段，数字用户名请加 `@`；主页 URL 可通过接口调试的 URL 字段提交；其他平台保留原账号字段选择。

用户名去掉 `@` 后仍须满足 `[A-Za-z0-9_]{1,15}`，与 [X 官方账号查询 API](https://docs.x.com/x-api/users/get-user-by-username) 一致；此规则不套用到显示名称或数字用户 ID。格式错误保留 HTTP 400 / `invalid_social_request`，消息说明长度或字符问题，`error.details` 返回 `platform: "twitter"`、`field: "username"`、`reason`、`actualLength`、`maxLength: 15`。其中 `reason` 为 `username_too_long` 或 `username_invalid_characters`，不会回显整个输入。以 22 字符账号为例，消息是 `Twitter username exceeds the 15-character limit (received 22 characters, excluding @)`。这是请求参数错误，不能按空数据或瞬时供应商故障处理。

历史请求只能在原 Key、路径、原始请求体及旧指纹均匹配时回放已保存的回执；自动识别规则更新不会重写历史响应，也不会按旧规则重新调用供应商。旧 `mxds1` 游标不能用于身份解释发生变化的新请求；调用方应先核对目标账号，再显式决定是否使用新幂等键从第一页重新查询，不能自动换键重跑。未发生身份变化的已有游标仍须满足原绑定和分页规则。

`count/pageSize/page_size/limit` 支持 1–500，仍受 Key entitlement 和批量总工作量限制。crawl 优先 `count > pageSize > page_size > limit`；user-info 优先 `limit > count > pageSize > page_size`。`pageSize` 与 `page_size` 同时提交须一致。`pageSize` 是每个工作项逻辑页上限，批量请求的总条数还受当前 Key 允许的工作量约束，不能用多账号绕开上限。

`includeRaw` 仅允许 `false` 或省略；现有业务 `raw_info/raw_data` 字符串仍保留。`concurrency`（1–20）及 `cacheMaxAgeHours`（0–720）作为历史提示接收，不覆盖 Hub 并发、幂等和准入规则，也不承诺强制缓存命中。不得提交任意供应商、端点、请求凭据、原生游标或扩大采购的控制参数。

账号内容默认 `activityTypes: ["posts"]`。固定合同当前声明：

| 平台 | activityTypes |
| --- | --- |
| Twitter、Facebook、哔哩哔哩、快手、YouTube | `posts` |
| Instagram | `posts`、`reels`、`stories`、`tagged_posts`、`highlights`、`followers`、`following` |
| 抖音、小红书 | `posts`、`likes` |
| 微博 | `posts`、`original_posts` |
| 知乎 | `posts`（文章）、`answers` |
| TikTok | `posts`、`likes`、`reposts` |
| LinkedIn | `posts`、`company_posts` |
| Reddit | `posts`、`comments` |

接口调试可提交完整请求；产品展示提供单账号 `posts` 和单账号资料，按当前 Key 对平台及操作授权过滤。

## 请求与返回

账号内容示例（参数示例，不代表真实账号或已验证的在线数据）：

```http
POST /api/v1/data/social/crawl
Authorization: Bearer <HUB_API_KEY>
Idempotency-Key: <NEW_PAGE_REQUEST_KEY>
Content-Type: application/json

{"platform":"twitter","user_id":"example","page_size":20,"activityTypes":["posts"]}
```

账号资料使用 `POST /api/v1/data/social/user-info`，请求示例为 `{"platform":"twitter","username":"example"}`。批量资料示例为 `{"platform":"instagram","usernames":["account_a","account_b"]}`。批量返回额外的 `data.results` 保存工作项关联，顶层 `data.items` 仍为本页交付数组。

| 响应字段 | 下游处理 |
| --- | --- |
| `contractVersion/requestId` | 保存合同及该业务请求标识，用于核对；不要用 HTTP 相关 ID 替代账本 ID |
| `data.items` | 已适配业务条目数组；posts 等返回内容，followers/following 及资料查询返回账号条目，保留既有扁平字段 |
| `data.raw_info` | JSON 字符串，账号资料列表；按字符串解析一次 |
| `data.raw_data` | JSON 字符串，crawl 的本页业务条目列表，关系活动为账号条目；资料查询为 `"[]"` |
| `data.page/pageInfo` | 同步的 `hasMore/nextCursor/pageSize/returnedCount`；returnedCount 仅描述本页 |
| `data.status/warnings` | 展示 partial 与边界原因；不能将 404、429、502、未知结果解释为空数据 |

内容常用字段继续包含 `content_id/content/full_text/platform_name/created_at`、作者、互动和媒体字段；资料常用字段为 `user_id/user_name/nickname/description/avatar_url`、粉丝和关注数等。标准化时不从缺失值制造实测零值，`0` 与 `null` 分开。展示层仅读取别名，不改写完整响应。特别注意：`raw_data` 是序列化数组，不能把整个字符串包进数组当作一条内容。

`followers/following` 活动返回 `objectType: "user"` 的关系账号条目，使用 `user_id`，不生成 `content_id`。此时 `raw_info` 包含目标账号资料和本页实际交付的关系账号资料；上游多取的关系账号留到后续页，不提前出现在当前返回中。

新账号接口在查找 Twitter 账号时，若上游以 HTTP 200 返回 `{"data":{},"userExists":false}` 且没有同时返回错误，Hub 返回 HTTP 404 / `social_account_not_found`。`error.details` 包含 `platform: "twitter"`、`stage: "account_lookup"`、`outcome: "rejected"`、`retryable: false`。消息说明“上游报告未找到该账号”，不据此断定账号永久不存在；账号当前是否实际存在须单独核实。crawl 在此处停止，不再调用该账号的内容时间线，也不将失败伪装为成功空列表。未明确报告未找到的空对象、格式异常或资料解析失败仍按原错误合同处理。

修正仅影响新执行的账号查找。同一 Key、路径、原请求体与原幂等键命中的历史失败仍回放原回执：已经保存为 502 的结果不会改写为 404，也不会因为回放而再次调用上游。`retryable: false` 不授权自动换键、改 URL 或回退到旧接口重跑；如需重新查找，应先核对账号并单独决定是否发起可能再次计费的新请求。

已保存回执及修复验证见 [2026-10-20 Twitter 账号查找故障](../operations/twitter-account-not-found-2026-10-20.md)。

## 分页与原请求保护

首页省略 `cursor`，`page` 为 1。后续原样传回 `data.pageInfo.nextCursor` 或相同的 `data.page.nextCursor`，保持账号、平台、活动、过滤条件和页大小，并使用新的 `Idempotency-Key`。Hub 游标将完整采购页余量、已交付身份和后续工作关联到同一遍历；最多 15 个公开页，有效 24 小时，仍受上游页数、期限、归档大小和准入限制。资料批量遇到中断也可通过返回的游标继续。

短页、空页或 `partial` 不代表耗尽；检查 `hasMore/nextCursor/warnings`。没有可用游标时停止自动续页；若同时出现 `pagination_completeness_unknown`，即使 `hasMore=false`、`nextCursor=null` 也只表示当前无法继续，不能确认数据耗尽。遇到服务限流或未知请求，保存原请求标识并先只读核对，不自动新建请求绕过保护。已有旧 Twitter `mxec2` 游标与精确旧幂等请求由原合同继续处理；新账号游标不与旧 Night-All、`data/search` 或其他操作互换。切换旧转发调用方时从第一页明确开始。

`409 request_in_progress` 表示并发保护拒绝，不能解释为空结果或自动换键重试。
`An equal request is already in progress` 来自同幂等键预留检查；
`An equal account delivery is in progress` 来自同消费者、平台和请求指纹的账号交付锁，
不同幂等键的相同账号/同页请求也会命中。后者错误里的 `requestId` 是被拒绝请求的账本ID，
不是正在执行的锁持有者ID。先核对该请求的调用记录、同指纹请求和当前锁，再决定恢复方式；
历史锁已释放时，当前查不到锁不表示过去没有并发。排查示例见
[账号迁移运行记录](../operations/social-account-direct-migration-2026-10-15.md#2026-10-17-同批账号采集并发拒绝)。

迁移不是旧 unknown 的自动重试授权。已有 `request_outcome_unknown` 的任务须保留原请求关联并先核对；不能因更换接口 URL、幂等键或 checkpoint 而自动重新采集。Twitter 的标准搜索人工重试能力不适用于旧账号 `crawl`。已确认的旧链路 30 秒超时案例见 [Twitter 账号采集故障](../operations/twitter-crawl-timeout-2026-10-16.md)。

本轮保留平台与供应商的独立运行状态；没有执行线上付费探测或部署，也不根据离线 fixture 宣称所有平台实时可用。下游接入时应核对其原 Key 新能力授权、已启用操作及真实客户端解析；旧入口的删除需要等待迁移流量和请求证据验证。

运行时 HTML 文档：`/docs/strategy-search`；下载 OpenAPI：`/docs/openapi.json`。两者按当前调用身份的有效 scope 过滤平台及操作。产品入口为《策略搜索》的接口调试、产品展示、接入指南及 Admin 管理页。

### 2026-10-30：明确的 Twitter 账号不可用

账号查找响应的唯一候选若为 `UserUnavailable`，新版 Hub 返回 HTTP 422 / `social_account_unavailable`，详情为 `platform=twitter`、`stage=account_lookup`、`outcome=rejected`、`retryable=false`。`reason` 只归一化明确枚举：`suspended`、`deactivated`、`deleted`、`protected`、`not_found`；未识别的原因统一为 `unavailable`，不解析自由文本或推断账号永久状态。原 `userExists:false` 的 404 合同保留。

Delta 对这两类明确账号状态停止自动重试及 Night-All 回退，保留失败检查点、请求 ID、原始错误体，输出中文原因；不会伪装为成功空列表。普通格式异常、上游 HTTP 错误、授权与限流仍遵循各自原规则。供应商回执、幂等结果和客户计费规则不变；旧 502 不改写，不从旧错误码反推账号状态。
