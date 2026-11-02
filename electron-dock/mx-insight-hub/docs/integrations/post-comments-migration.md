# 帖子评论迁移到 Hub

2026-11-02：Twitter 旧 URL `/api/v1/search/post-comments` 的生产首屏验收已通过，usage `d167ad9e-48b4-4668-bcd3-8b1d6ef2aeb0` 返回 20 条评论，合同、标识、正文/作者/时间/互动字段、单次采购与分页检查全部通过。同一 usage 已 committed，账本恰好一条成功且计费的 TikHub `native.t.api_3cd88a6621a01120` 调用，原始归档已核验。此前运行容器路由检查和两份原生样本校准也已完成；不再追加 Twitter 探测。事件 af456ad4-2523-4f73-a1fc-c95104b329a4 的旧 Night-All HTTP 404 回执仍保留，不能据此推断供应商曾收到请求或评论为空。

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
| 微博 | JustOne `j.api_19390f4ea0fef847` |
| 抖音 | JustOne `j.api_cfe7c89d64177567` |
| TikTok | JustOne `j.api_9302e45524da8400` |
| 知乎 | JustOne `j.api_b221354f6d520f65` |
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
