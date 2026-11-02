# 帖子评论迁移到 Hub

2026-11-02：统一接口本地实现完成，尚未部署或完成统一入口生产验收。Twitter 已通过现有 TikHub 原生入口取得两份实际付费样本，空 thread 与 36 条 thread 的归档均完整。此前的兼容桥仍转发 Night-All，不能视为原生迁移完成。事件 af456ad4-2523-4f73-a1fc-c95104b329a4 的保存证据是 Hub 预留 released、Night-All connector HTTP 404；不能据此推断供应商收到请求或评论为空。

## 当前发布阻塞：JustOne 余额为零

用户已确认 JustOne 当前无余额。下表是现有代码的固定路由事实；其中九个平台不能按可用功能上线，上一版“13 平台已接入”只代表实现与离线格式覆盖。Twitter 本次改为 TikHub，小红书、Instagram、YouTube 原已走 TikHub。剩余八个平台在目录中有 TikHub 单帖评论候选；Facebook 暂无已登记的非 JustOne 替代，不将 Facebook 搜索爬虫冒充评论能力。

Twitter 本轮已取样完成，不再采样或自动续页；先用同一解析器只读校验已归档的全部 36 条，再发布。Reddit、快手可按原限定次数流程分别校准，见 [TikHub 校验脚本](../operations/post-comment-contract-calibration.md)。其他平台核对实际字段和游标后再替换对应投影与采购路由，保留幂等历史和既有成本门禁。RapidAPI 的旧 Twitter 评论代码在 Night-All，Hub 当前 RapidAPI 适配器只实现 search/crawl/user-info，不能靠改配置直接调用评论。

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
| Reddit | JustOne `j.api_9f1806a48fde0794` |
| 快手 | JustOne `j.api_e0c0bbd6b8e0784c` |
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

Twitter 当前使用已验证字节归档 `f33e6d06-97f0-46c2-a049-c69ccfabf41d`（2516 字节、空 thread）与 `7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b`（54697 字节、thread 36 条）。取 `data.thread`，排除请求帖子和会话根帖；映射 id、text、created_at、author.rest_id/name/screen_name、likes/replies/retweets/bookmarks/quotes/views。实际直接父评论字段未取得，parentExternalId/parentCommentId=null、parentRelationship=unknown，不把 conversation_id 当作直接父帖；conversationId 保留实际会话归属。未校准的头像和媒体字段完整保留在受限原始数据，暂不猜测统一映射。生产结构摘要仅抽样前 3 条；完整 36 条解析须用只读校验命令确认，离线构造样本不能替代它。

JustOne 曾有余额不足记录；保留现有控制，不隐式充值、改价、启用或换渠道。小红书新统一入口采购操作为 native.t.api_327bbf0cae41de55，与旧 research 的采购身份不同，旧价格/开关不自动覆盖；客户计费仍统一为 social.comments.list。

标识边界：Instagram 数字媒体 ID 无损转换 shortcode（依据 [Instaloader 原始接口说明](https://instaloader.github.io/module/structures.html)），也接受 shortcode/URL；Bilibili 使用数字 AID/av URL，BV-only 暂不解析；知乎为回答；LinkedIn 为 activity ID/URN/URL，share/ugcPost URN 暂不解析。微博 base62 URL-only 暂不解析。有明确 ID 时，可接受固定平台域名的原始分享链接，不访问短链、不以其替换 ID。

## 分页、计费和存储

新调用要求目标平台和 social.comments.list 双重授权。旧仅平台授权的 Key 不静默扩权，需按现有流程取得评论能力。保留租户、消费者、Key、采购策略、预算、审核价格、余额和并发限制。成功交付页结算一次，供应商调用逐次记录；精确重放不二次收费。

复用现有 PG 受限原始响应、供应商调用/成本账本、socialSearch 分页清单和 social.comments.v1 规范化入库，无新数据库或表。完整已取得页先归档，超过 count 的余量保留，下一页先交付余量再采购。评论按 comment 类型入库。

page.paginationStatus 区分 continuable、exhausted、unknown、limit_reached；hasMore 可为 true/false/null，不把缺失分页字段当作结束。继续时传返回的 nextCursor（params.cursor 同义），保持 Key、帖子、count、排序不变。游标 24 小时有效，最多 15 个供应商数据页和 15 个交付页。新页用自己的幂等键，同页重试保持原键和请求体。

Twitter 每次仅消费一份已保存或新取得的供应商页，不为了填满 count 自动追加采购。36 条、count=20 时先返回 20 条，下一请求返回余下 16 条且不新增供应商调用；再下一请求才可按返回游标显式采购。已有缓存余量时 hasMore=true；余量耗尽后，仅凭 cursor 返回 hasMore=null、paginationStatus=unknown、continuationAvailable=true，不保证有更多评论。空页、缺失游标、重复游标都不推定 exhausted。旧 JustOne 签名游标不能开启新的 TikHub 采集，但原幂等键的旧回执仍原样重放；旧已排队的 JustOne 评论入库任务保留原供应商归属。

当前固定供应商的原生续页字段可作为新遍历起点，返回 imported_continuation 警告，之前的页不在此遍历范围。不是任意 params 透传，也不保证 Night-All 不同供应商的旧游标可混用。旧 mxnc1 及其他合同的 Hub 游标必须显式重开，不能藏在 params 中绕过检查。

## 发布与验收

Twitter 字段映射、单页采购和分页缓存已本地验证；先对已购归档做完整只读解析，再沿用既有发布流程，保持 MX_INSIGHT_SYNC_LAUNCHER=0、MX_SMOKE_DATA=0。本次无需数据库迁移，不操作 Launcher、SSO 或 MX-H2I 网络。

确认 Key 的平台+评论能力、TikHub 原生操作审核价格/开关、供应商凭据与余额。表内九个 JustOne 路由当前仍不可用；文档可见不代表已就绪。Twitter 两次样本已经成功，不重购；剩余平台按 [限定次数校验](../operations/post-comment-contract-calibration.md) 执行，不自动重试/续页。发布后才以新业务幂等键验收统一入口。原生端点采样成功和离线测试不能作为统一入口线上已恢复的证据。
