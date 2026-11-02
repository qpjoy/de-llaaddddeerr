# 帖子评论迁移到 Hub

2026-11-02：本地实现完成，尚未部署或执行生产付费验收。此前的兼容桥仍转发 Night-All，不能视为原生迁移完成。事件 af456ad4-2523-4f73-a1fc-c95104b329a4 的保存证据是 Hub 预留 released、Night-All connector HTTP 404；不能据此推断供应商收到请求或评论为空。

## 当前发布阻塞：JustOne 余额为零

用户已确认 JustOne 当前无余额。下表仍是现有代码的固定路由事实；其中十个平台不能按可用功能上线，上一版“13 平台已接入”只代表实现与离线格式覆盖。小红书、Instagram、YouTube 已走 TikHub。其余九个平台在目录中有 TikHub 单帖评论候选；Facebook 暂无已登记的非 JustOne 替代，不将 Facebook 搜索爬虫冒充评论能力。

下一步先通过 Hub 已有原生入口对 Twitter、Reddit、快手各最多采样一页，使用更新后的 [TikHub 校验脚本](../operations/post-comment-contract-calibration.md)。核对实际字段和游标后再替换统一评论对应投影与采购路由，保留幂等历史和既有成本门禁；不盲切供应商或要求先给 JustOne 充值。RapidAPI 的旧 Twitter 评论代码在 Night-All，Hub 当前 RapidAPI 适配器只实现 search/crawl/user-info，不能靠改配置直接调用评论。

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
| Twitter | JustOne `j.api_bcedccd1a73cc8f2` |
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

JustOne 曾有余额不足记录；保留现有控制，不隐式充值、改价、启用或换渠道。小红书新统一入口采购操作为 native.t.api_327bbf0cae41de55，与旧 research 的采购身份不同，旧价格/开关不自动覆盖；客户计费仍统一为 social.comments.list。

标识边界：Instagram 数字媒体 ID 无损转换 shortcode（依据 [Instaloader 原始接口说明](https://instaloader.github.io/module/structures.html)），也接受 shortcode/URL；Bilibili 使用数字 AID/av URL，BV-only 暂不解析；知乎为回答；LinkedIn 为 activity ID/URN/URL，share/ugcPost URN 暂不解析。微博 base62 URL-only 暂不解析。有明确 ID 时，可接受固定平台域名的原始分享链接，不访问短链、不以其替换 ID。

## 分页、计费和存储

新调用要求目标平台和 social.comments.list 双重授权。旧仅平台授权的 Key 不静默扩权，需按现有流程取得评论能力。保留租户、消费者、Key、采购策略、预算、审核价格、余额和并发限制。成功交付页结算一次，供应商调用逐次记录；精确重放不二次收费。

复用现有 PG 受限原始响应、供应商调用/成本账本、socialSearch 分页清单和 social.comments.v1 规范化入库，无新数据库或表。完整已取得页先归档，超过 count 的余量保留，下一页先交付余量再采购。评论按 comment 类型入库。

page.paginationStatus 区分 continuable、exhausted、unknown、limit_reached；hasMore 可为 true/false/null，不把缺失分页字段当作结束。继续时传返回的 nextCursor（params.cursor 同义），保持 Key、帖子、count、排序不变。游标 24 小时有效，最多 15 个供应商数据页和 15 个交付页。新页用自己的幂等键，同页重试保持原键和请求体。

当前固定供应商的原生续页字段可作为新遍历起点，返回 imported_continuation 警告，之前的页不在此遍历范围。不是任意 params 透传，也不保证 Night-All 不同供应商的旧游标可混用。旧 mxnc1 及其他合同的 Hub 游标必须显式重开，不能藏在 params 中绕过检查。

## 发布与验收

当前先用已有原生入口校准 TikHub 替代通道，统一评论改造等待对应字段映射和分页通过验证后发布。届时沿用既有发布流程，保持 MX_INSIGHT_SYNC_LAUNCHER=0、MX_SMOKE_DATA=0。本次无需数据库迁移，不操作 Launcher、SSO 或 MX-H2I 网络。

确认 Key 的平台+评论能力、用于采样的 TikHub 原生操作审核价格/开关、供应商凭据与余额。表内十个 JustOne 路由当前仍不可用；文档可见不代表已就绪。按 [限定次数校验](../operations/post-comment-contract-calibration.md) 使用已有样本做 Twitter、Reddit、快手各最多一次原生调用，再只读输出归档结构；不自动重试/续页。核对精简结果后，以新业务幂等键验收统一入口。离线测试不能作为线上已恢复的证据。
