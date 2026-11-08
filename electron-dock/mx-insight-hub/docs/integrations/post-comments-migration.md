# 帖子评论迁移到 Hub

2026-11-02：Twitter 旧 URL `/api/v1/search/post-comments` 的生产首屏验收已通过，usage `d167ad9e-48b4-4668-bcd3-8b1d6ef2aeb0` 返回 20 条评论，合同、标识、正文/作者/时间/互动字段、单次采购与分页检查全部通过。同一 usage 已 committed，账本恰好一条成功且计费的 TikHub `native.t.api_3cd88a6621a01120` 调用，原始归档已核验。此前运行容器路由检查和两份原生样本校准也已完成；不再追加 Twitter 探测。事件 af456ad4-2523-4f73-a1fc-c95104b329a4 的旧 Night-All HTTP 404 回执仍保留，不能据此推断供应商曾收到请求或评论为空。

## 2026-11-07 评论回复（楼中楼）与评论供应商策略

本地实现，未部署，未发起付费调用。评论放在「策略搜索」里，不新建数据产品：业务接口新增「帖子评论」「评论回复」两项，管理页按平台切换供应商，产品展示可从内容搜索结果点「查看评论」，再从评论点「查看回复」。

### 接口

- `POST /api/v1/data/social/post-comments`：不变。每条评论新增 `replyRef: { platform, commentId, contentId }`。
- `POST /api/v1/data/social/comment-replies`：新接口。传 `platform` + `commentId`；Reddit、小红书、Instagram、抖音、B站、快手还要 `contentId`。直接传评论返回的 `replyRef` 即可。与帖子评论共用 `social.comments.list` 授权和计费；游标只能续同一供应商。每条回复有 `rootCommentId`（被查询的评论）和 `parentCommentId`（直接回复对象，未知为 null）。
- B站接受 BV 号（本地换算为 AID，作为同一身份）。

### 供应商与校准状态（`server/contracts/comment-routes.mjs`）

2026-11-07 已按用户授权做付费校准（每个平台约 5 次，TikHub；凭据取自 Night-All `config.json`，只在进程内使用）：共 37 次请求，34 次成功，3 次 TikHub 返回 400 且声明不扣费。原始页面存于仓库外，测试使用匿名化的同结构样例。工具：`server/ops/calibrate-comment-replies.mjs`。

| 平台 | 帖子评论 | 评论回复 |
| --- | --- | --- |
| Twitter | TikHub（已验证）/ JustOne（样例） | TikHub 已验证（36 条） |
| Reddit | TikHub（已验证，**现可续页**）/ JustOne（样例） | TikHub 沿用结构（展开游标的接口已验证，评论内嵌游标未遇到） |
| 小红书 | TikHub（已验证，**修复时间、作者与续页**） | TikHub 沿用结构（实测为空页） |
| 微博 | TikHub（已验证，**修复 rootid 误判**）/ JustOne（样例） | TikHub 沿用结构（实测为空页） |
| Instagram | TikHub（已验证） | TikHub 已验证（两种页面结构，17/17） |
| 抖音 | TikHub（已验证）/ JustOne（样例） | TikHub 已验证（5/5） |
| B站 | JustOne（样例，默认）/ TikHub（第 1 页只返回 3 条，可选） | TikHub 已验证（20 条/页，按页码续） |
| 快手 | TikHub（已验证）/ JustOne（样例） | TikHub 已验证（4/4） |
| 知乎 | TikHub（校准时供应商 400，未能实测）/ JustOne（样例） | TikHub 沿用 comment_v5 结构（同上） |

本次修复的生产问题：

- 微博评论：实测一级评论的 `rootid` 是评论自身 ID，原解析器要求等于帖子 ID，导致这类页面全部返回 502。现接受空、帖子 ID 或自身 ID。
- 小红书评论（含 `/api/v1/data/xiaohongshu/notes/comments`）：TikHub app_v2 现在用 `time` 和 `user.userid/images`，原先发布时间和作者 ID 为空；下一页位置打包在 JSON 字符串 `cursor` 里，原先从未续页。把其中 `cursor/index/pageArea` 回传后实测拿到 15 条新评论。
- Reddit 评论：评论树末尾的 depth 0 占位节点 `more.cursor` 交给 `fetch_comment_replies`（`native.t.api_e0a2654e9c191a80`）即返回下一批一级评论。帖子评论第 2 页起使用该接口，需在 TikHub 操作中启用并定价。评论内嵌的未展开回复占位会写入该评论的 `replyCursor` 和 `replyRef.cursor`。

知乎（2026-11-08 排查）：TikHub 官方文档的参数与 Hub 一致，但用 TikHub 自己的文档示例调用 `fetch_comment_v5`、`fetch_sub_comment_v5`、`fetch_article_search_v3`、`fetch_user_info`、`fetch_answer_detail` 都返回 400（声明不扣费），同时 `fetch_user_answers` 正常返回 200，是供应商侧部分接口故障，与 Hub 参数或新式 19 位回答 ID 无关。期间 Hub 的知乎关键词搜索、评论/回复和账号资料返回 502 `external_platform_rejected`（不向客户计费，不触发 TikHub 共享熔断）；知乎账号内容已改为资料步骤被明确拒绝时继续取内容并给出 `account_profile_unavailable` 警告。可提交 TikHub 支持的请求 ID：`b4c99c96-66ef-43e8-9006-08f8ae845091`、`7a2a3700-79a3-4a2f-ade1-14031b6d059a`、`5242fa9f-21b4-4edf-8cf9-710b38b3aeeb`。

### 策略

迁移 181 把 `control.strategy_search_routes` 扩展到 `post-comments`（13 个平台）和 `comment-replies`（9 个平台），只补缺失行：TikHub 优先、JustOne 保底（两者都有解析器时）；B站评论固定 JustOne；回复固定 TikHub。管理页可改为固定、优先与保底或暂停。优先与保底只在首请求派发前、优先供应商凭据、操作开关或价格未就绪时切换；已派发后的拒绝、超时、未知结果或不可解析响应不会换供应商重买。暂停只停新采购，精确重放与已购缓冲仍可交付。上线前提：部署运行迁移 181；新增 TikHub 操作（抖音评论/回复、微博/知乎/Twitter 回复等）需启用且有价（部署补价脚本会为仅迁移/补价过的操作补 0.01 估价）。

抖音帖子评论（2026-11-08 用户确认）：已上线功能里，只有抖音帖子评论的供应商会因这次部署改变，由原来的固定 JustOne 改为 TikHub 优先、JustOne 保底。两家共用同一字段映射，返回结构不变；部署前签发的 JustOne 游标仍在 JustOne 续页。之后要切换，在管理 → 策略搜索 → 帖子评论 → 抖音中修改：可改为固定 JustOne、改回 TikHub 优先，或暂停。保存后对新请求立即生效，不需要重新部署，其他平台的策略不受影响。HTTP 管理接口与选路联动由 `tests/server/strategy-search-api.test.mjs` 覆盖。

### 文档

`shared/comment-fields.mjs` 是评论/回复字段的唯一登记，生成 OpenAPI 结构、示例和指南字段表；测试保证解析器输出的每个字段都已登记。`shared/field-descriptions.mjs` 为策略搜索各接口补齐返回字段说明。接口调试新增「返回字段」表，发送后逐项标出已返回、为空或未返回，并列出响应中有但文档未登记的字段。

## 当前发布阻塞：JustOne 余额为零

用户已确认 JustOne 当前无余额。下表是现有代码的固定路由事实；其中七个 JustOne 平台不能按可用功能上线，快手统一入口验收已通过，上一版“13 平台已接入”只代表实现与离线格式覆盖。Twitter、Reddit、快手已完成 TikHub 统一入口首屏验收，小红书、Instagram、YouTube 原已走 TikHub。剩余六个平台在目录中有 TikHub 单帖评论候选；Facebook 暂无已登记的非 JustOne 替代，不将 Facebook 搜索爬虫冒充评论能力。

Twitter 首屏统一入口现已完成实际验收，下游继续使用原 URL 和平台+评论能力授权。Reddit usage `7eb265f4-5c2c-4d15-91d5-7dc7fed83b61` 的 9844 字节原生归档、保存请求目标及完整 3 条评论均已验证，正文、作者 ID、发布时间各 3 条，score 2 条，直接父关系均未知。该纯解析器已接入 Hub，运行容器路由和旧统一 URL 的真实业务验收均已通过。验收 usage `6fbf167b-9d1c-44f6-8ac0-5cd90fd3100b` 返回 3 条，全部合同检查通过、当前页 exhausted；同 usage committed，恰好一次 TikHub c7 成功计费调用，归档已核验。保留原生及 reddit.unified-acceptance.json 回执，不再追加 Reddit 探测。复用现有 PG 存储，无新的架构或存储决策。

快手 usage `ce942beb-a379-4e18-b62f-ee69cc24b3d3` 已确认是 TikHub Web 评论上游 HTTP 400，Hub 保存 committed 502，835 字节错误归档 SHA 校验通过。`billed:null` 表示供应商计费未知；上游错误声称未扣费，不据此改写账本。`photo_id` 为 15 位字符串，首屏缺少 `pcursor` 本身不构成参数错误。保留原 Web 回执。独立 App 样本 `16eb4f8e-7d1d-40e2-8593-02570ee3fd37` 已成功：唯一 TikHub `native.t.api_bc64c9d98dbf724c` 调用，committed、HTTP/business 200、billed=true，13227 字节归档已校验，rootComments 共 11 条。后续服务器全量验证已通过：11 个唯一评论，正文/作者/发布时间/点赞/回复数各 11 条；评论与作者数值 ID 均安全，内部 photo_id 均超出安全整数范围，未用于身份；2 条回复预览不混入根评论。顶层 pcursor 实际为 no_more，按当前保守合同返回 unknown/不可继续。本轮接入同一纯解析器和固定 App 配方，部署与统一入口验收均通过，不再购原生样本。见 [本轮操作](../operations/post-comment-contract-calibration.md#reddit-已验收快手发布与单次统一入口验收)；快手宿主机/Public/Admin 六文件 SHA 已对齐 TikHub App，发布版本差异已解决。其他平台取得实际字段和游标证据后逐项迁移，不隐式重试或改写历史。RapidAPI 的旧 Twitter 评论代码在 Night-All，Hub 当前适配器只实现 search/crawl/user-info，不能靠改配置直接调用评论。

快手统一入口验收 usage `2274fe73-43e4-4914-9f21-a3629b188d09` 已通过：HTTP200、返回 11 条、六项检查均 true；同 usage committed、唯一 TikHub bc64 调用成功且 billed=true，归档校验通过。分页 hasMore=null、continuationAvailable=false、paginationStatus=unknown，表示当前没有可证实的续页，不表示全帖评论已取完。保留 `kuaishou.unified-acceptance.json` 及原 Web/App 标记，不重复购买或验收。见 [快手验收记录](../operations/post-comment-contract-calibration.md#快手统一入口首屏验收已通过)。

微博替代接入进行中：TikHub 主评论 usage `fedbc7e0-e9fa-4fe3-a3e3-5107fcb13849` 已成功计费，归档 137665 字节完整校验，响应根数组有 22 条。新增纯解析器和只读投影验收，逐条验证 ID/作者/正文/时间/互动字段，回复预览不混入主评论，并保守判断 `max_id` 分页；待服务器回传全量验收。尚未切换微博统一路由，仍为 JustOne。

## 入口与交付

三个 POST 入口共用新 Hub 原生执行、计费与幂等身份：

- `/api/v1/data/social/post-comments`
- `/api/v1/search/post-comments`
- `/api/v1/night-all/search/post-comments`

新请求不调用 Night-All，不在失败后换供应商。已保存旧响应保持原样重放，包括已保存的 404；unknown/reserved 继续隔离，不因升级重买。确认旧请求结果后，调用方才显式使用新幂等键发起新采集。

```json
{"platform":"twitter","postId":"2117082385997250767","count":20,"includeRaw":false}
```

postId、contentId、平台专用 ID、规范 URL 至少一项；多项能解析为确定 ID 时必须一致。businessId 可省略，提交时须等于消费者绑定值，不能用随意策略标签替代身份。count/pageSize/limit 默认 20、最多 100，仍受 Key 页大小限制。includeRaw 默认 false。

响应版本为 `mx-insight-hub.post-comments.v1`。data.items/comments 是本页评论，raw_data 是同一数组的 JSON 字符串，raw_info 为 `"[]"`。commentId/content_id 是评论 ID；postId/contentId 是规范化原帖 ID。保留正文、作者、时间证据、互动量和实际父评论关系。未知指标/确定时间为 null，相对时间保留 publishedTime；Reddit score、Facebook reactions 不冒充 likes。贴纸评论允许 text=null 并附媒体。不自动展开回复；当前页已有回复可保留，meta.repliesFetched=false。商品评价、搜索附带评论、YouTube 频道评论仍是独立合同。

## 固定供应商与证据

| 平台 | 供应商 / 原生 Key |
| --- | --- |
| Twitter | TikHub `t.api_3cd88a6621a01120` |
| Reddit | TikHub `t.api_c7f50cf300d63960`（统一入口验收通过） |
| 快手 | TikHub `t.api_bc64c9d98dbf724c`（统一入口验收通过） |
| 微博 | TikHub `t.api_631f7f6fd007cba9`（2026-11-03 起） |
| 抖音 | JustOne `j.api_cfe7c89d64177567` |
| TikTok | JustOne `j.api_9302e45524da8400` |
| 知乎 | TikHub `t.api_6a6b1264eaeadebe`（`fetch_comment_v5`，2026-11-05 起；原 JustOne `j.api_b221354f6d520f65`） |
| LinkedIn | JustOne `j.api_c8002ed17df8381a` |
| Bilibili | JustOne `j.api_f5a166f0a03822f8` |
| Facebook | JustOne `j.api_471d1e0392427a79` |
| Instagram | TikHub `t.api_4167d40172ce25ef` |
| 小红书 | TikHub `t.api_327bbf0cae41de55` |
| YouTube | TikHub `t.api_4a6f21264dc0b4a1` |

JustOne 字段来自官方文档使用的免费示例接口 `https://api.justoneapi.com/status/api-example/detail?api=<供应商路径>`，读取于 2026-11-02。十份完整例子离线投影通过，仓库回归使用匿名构造字段；这不是付费采集，也不证明生产可用。Instagram 复用已归档评论样本；小红书和 YouTube 复用已发布解析。没有把 TikHub 通用 ResponseModel 猜成 JustOne 响应。

Twitter 当前使用已验证字节归档 `f33e6d06-97f0-46c2-a049-c69ccfabf41d`（2516 字节、空 thread）与 `7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b`（54697 字节、thread 36 条）。取 `data.thread`，排除请求帖子和会话根帖；映射 id、text、created_at、author.rest_id/name/screen_name、likes/replies/retweets/bookmarks/quotes/views。实际直接父评论字段未取得，parentExternalId/parentCommentId=null、parentRelationship=unknown，不把 conversation_id 当作直接父帖；conversationId 保留实际会话归属。未校准的头像和媒体字段完整保留在受限原始数据，暂不猜测统一映射。生产结构摘要最初仅抽样前 3 条；后续服务器完整校验确认 36 条均通过、36 个唯一 ID、正文/作者 ID/发布时间各 36 条、rootIncluded=false，验证过程无 HTTP 或数据库写入。

JustOne 曾有余额不足记录；保留现有控制，不隐式充值、改价、启用或换渠道。小红书新统一入口采购操作为 native.t.api_327bbf0cae41de55，与旧 research 的采购身份不同，旧价格/开关不自动覆盖；客户计费仍统一为 social.comments.list。

标识边界：Instagram 数字媒体 ID 无损转换 shortcode（依据 [Instaloader 原始接口说明](https://instaloader.github.io/module/structures.html)），也接受 shortcode/URL；Bilibili 使用数字 AID/av URL，BV-only 暂不解析；知乎为回答；LinkedIn 为 activity ID/URN/URL，share/ugcPost URN 暂不解析。微博 base62 URL-only 暂不解析。有明确 ID 时，可接受固定平台域名的原始分享链接，不访问短链、不以其替换 ID。

### 知乎改为 TikHub（2026-11-05）

- 配方：`GET /api/v1/zhihu/web/fetch_comment_v5`，`answer_id` = 回答 ID，续页 `offset`，排序 `order_by` 只接受 `score`、`ts`。原 JustOne 名称 `answerId`、`orderBy` 不再接受（400）。每页用 TikHub 默认 20 条，与原来一致。
- 依据：两家都转的是知乎自己的 `comment_v5/answers/{id}/root_comment` 页。TikHub 文档里 offset 示例 `1739257701_11108372663_0` 就是知乎原格式；字段沿用 11-02 按 JustOne 官方样例校准的投影（id、content、created_time、author、like_count、child_comment_count、dislike_count，`paging.is_end`/`paging.next`）。TikHub 文档只有通用 ResponseModel，**没有响应示例，尚无付费样本核对**。
- 只接受两种外壳：`data` 直接是知乎页，或多一层 `data.data`（与 TikHub 知乎搜索相同）。请求回显 `params.answer_id` 与请求不一致、`paging.next` 不是本回答的知乎 root_comment 地址、条目不是对象时一律 502 `invalid_upstream_contract`，不猜字段。
- 切换前签发的 Hub 游标（JustOne 配方）不能在 TikHub 上续页，返回 `invalid_cursor`，需显式从第一页重来。原始 `offset` 本身是知乎值，仍可导入为新遍历起点。
- 分页：知乎有可信的 `is_end`，所以知乎**不**改成 Twitter/Reddit/快手/微博那样每次请求只买一页，count 大于 20 时照旧自动补页（最多 15 个供应商页）。
- 启用前提：TikHub 操作 `native.t.api_6a6b1264eaeadebe` 需在「上游供应商 → TikHub」为启用状态并有采购价（部署补价只补缺失价、按 0.01 USD 暂估；TikHub 官方价 0.001 USD/次）。第一次生产调用后只读核对归档结构（不发 HTTP、不写库；没有知乎专用的 `--verify-*` 模式，看通用结构输出）：

  ```bash
  kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
    node --input-type=module - --request-id <usage UUID> \
    < server/ops/inspect-post-comment-contract.mjs
  ```

## 分页、计费和存储

新调用要求目标平台和 social.comments.list 双重授权。旧仅平台授权的 Key 不静默扩权，需按现有流程取得评论能力。保留租户、消费者、Key、采购策略、预算、审核价格、余额和并发限制。成功交付页结算一次，供应商调用逐次记录；精确重放不二次收费。

复用现有 PG 受限原始响应、供应商调用/成本账本、socialSearch 分页清单和 social.comments.v1 规范化入库，无新数据库或表。完整已取得页先归档，超过 count 的余量保留，下一页先交付余量再采购。评论按 comment 类型入库。

page.paginationStatus 区分 continuable、exhausted、unknown、limit_reached；hasMore 可为 true/false/null，不把缺失分页字段当作结束。继续时传返回的 nextCursor（params.cursor 同义），保持 Key、帖子、count、排序不变。游标 24 小时有效，最多 15 个供应商数据页和 15 个交付页。新页用自己的幂等键，同页重试保持原键和请求体。

Twitter 每次仅消费一份已保存或新取得的供应商页，不为了填满 count 自动追加采购。36 条、count=20 时先返回 20 条，下一请求返回余下 16 条且不新增供应商调用；再下一请求才可按返回游标显式采购。已有缓存余量时 hasMore=true；余量耗尽后，仅凭 cursor 返回 hasMore=null、paginationStatus=unknown、continuationAvailable=true，不保证有更多评论。空页、缺失游标、重复游标都不推定 exhausted。旧 JustOne 签名游标不能开启新的 TikHub 采集，但原幂等键的旧回执仍原样重放；旧已排队的 JustOne 评论入库任务保留原供应商归属。

Reddit 同样每个请求最多消费一个供应商页，不为了补足 count 购买后续页。实际样本明确结束且没有未取得的子节点，可返回 exhausted；`hasNextPage` 缺失/为真、有 `more` 或未取得子回复时返回 unknown。尚无已校准的供应商响应 token，不能把 `more.cursor` 猜为 `after`；已购余量耗尽后不制造 nextCursor。旧 JustOne 的签名游标以及原生 body.cursor/params.cursor 只允许原幂等键、原指纹回执重放，新键不能跨供应商继续。新供应商原生起点须显式用 params.after；旧已排队入库保留 JustOne 归属。

当前固定供应商的原生续页字段可作为新遍历起点，返回 imported_continuation 警告，之前的页不在此遍历范围。不是任意 params 透传，也不保证 Night-All 不同供应商的旧游标可混用。旧 mxnc1 及其他合同的 Hub 游标必须显式重开，不能藏在 params 中绕过检查。

## 发布与验收

Twitter 字段映射、单页采购和分页缓存已本地验证，服务器完整归档解析、运行容器路由检查及旧 URL 的真实首屏业务验收均已通过。此次 Hub 发布使用 MX_INSIGHT_SYNC_LAUNCHER=0、MX_SMOKE_DATA=0；验收完成后无需重新部署或重复采购。本次改动没有新增 DDL，标准发布仍会运行其既有迁移/索引维护。两个显式开关会覆盖 .env.internal，分别跳过 Launcher Secret/配置同步与重启，以及真实数据 POST smoke；不操作 MX-H2I 登录和联网配置。

本轮验收 Key 的 twitter、social.comments.list 授权与 TikHub 就绪预检均通过；其他业务 Key 仍须具有平台+评论能力，并满足现有价格/开关、预算和余额门禁。表内七个 JustOne 路由仍受余额阻塞，Twitter、Reddit、快手已完成统一入口首屏验收；文档可见不代表已就绪。Twitter 的 [单次验收记录](../operations/post-comment-contract-calibration.md#twitter-统一入口首屏验收已通过) 已闭环，保留原验收标记和幂等键。

本次首屏返回 hasMore=true、continuationAvailable=true、paginationStatus=continuable；按当前 Twitter 手动分页实现，这表示已取得的供应商页还有缓存余量。不能据此把本次新归档也写成 36 条，或保证后续供应商页非空。线上只验收了首屏；余量交付、续页和精确回放仍以已有本地回归为证据，未追加线上验收调用。第二份诊断中的 supplierHttpCallsMade=0、databaseWritesMade=0 仅指只读核对过程，前面的真实业务请求已正常计费一次。

当前 capabilities 的 social.comments.list.ready 仍基于小红书旧操作，Twitter 顶层 ready 及 search.ready 也不代表评论就绪。验收脚本只用 social.comments.list 条目的存在判断授权，再用本轮已有原生授权的 Key 查询 native.t.api_3cd88a6621a01120.ready；这是采样预检便利条件，不是要求所有业务 Key 增加原生权限。业务调用本身仍仅需 twitter + social.comments.list，采购控制由网关独立校验。预检不保证实时余额、限流或预算充足。

Reddit 运行映射按完整验证后的真实结构处理 commentForest.trees，完整 Markdown/作者/时间与 signed score 保留；parentId=null 表示关系未知，不制造父评论。样本未证明帖子下一页 token 的位置，先明确报告未证实的续页，不把回复端点的 more.cursor 当作 after。负 score 与隐藏值 null 同时保留在统一响应和规范化 JSON 指标中。运行配方固定 `post_id`、`need_format=false`，不新增默认排序/语言字段改变旧指纹。详见 [本轮发布](../operations/post-comment-contract-calibration.md#reddit-运行接入与快手-app-单次采样)。

快手 App 运行解析只投影 rootComments；subCommentsMap 属于回复预览，保存在原始归档，不作为完整回复列表或回复数量。全量只读验证同时报告评论/作者 ID 的安全整数或字符串计数；内部数字 photo_id 不冒充请求中的公开帖子 ID。解析器核对保存请求 photo_id 与响应 params 回显，分页缺失/重复/未证实哨兵均保持 unknown。本地运行配方固定 App `photo_id`，每请求最多消费一个供应商页，已购余量先交付。未耗尽余量时 hasMore=true；只持有推进 pcursor 时 hasMore=null、continuationAvailable=true，需下一次显式请求且可能计费。no_more、缺失/重复游标保持 unknown 且不再采购。

快手切换保留首屏和历史请求指纹、旧排队 JustOne 入库归属。两家供应商都叫 pcursor，无法仅凭原生 token 判明来源；非空 body.cursor/params.pcursor 只允许原键历史回执重放，新键不得跨供应商续采。空 pcursor 保留原首请求兼容；新 TikHub 遍历只能用本接口签发、绑定供应商与 Key 的 Hub nextCursor 继续。
