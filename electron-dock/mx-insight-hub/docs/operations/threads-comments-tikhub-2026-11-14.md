# Threads TikHub 评论：HTTP 200 后投影失败

日期：2026-11-14。状态：已根据原归档结构定位集合路径不匹配，并完成本地共用解析器修复；尚未部署或完成生产验收。

## 已有证据

- Hub 请求：`09a1566b-22e1-4aa9-b159-8649b91844a1`。
- 查询帖子：`4026682943628068563`。
- 供应商操作：`tikhub / native.t.api_fe58186e16adc3bb`，对应 `/api/v1/threads/web/fetch_post_comments`。
- 上游请求：`00d4d51c-2952-4677-ae82-3bc23addd739`，调用开始于 `2026-11-14 11:40:50.989 UTC`。
- HTTP 与业务码均为 200；Hub 保存 `succeeded_unusable / invalid_social_contract`，耗时 3156 ms。
- 已保存受限响应，供应商计费为 true，客户结算已扣款。界面金额单位为最小货币单位，不能把 `1 CNY` 或 `1 USD` 的数字直接解读为一元或一美元。

工作流从受限响应的原始字节解析完整 JSON；后续解析、业务投影或 canonical 映射异常都会产生同一错误码。
因此截图足以定位阶段，不足以区分集合路径、帖子标识、父子关系、时间或其他字段问题。

修复前 TikHub 分支要求 `code: 200`，在连续 `data` 层仅查找 `comments` 数组；评论和回复共用
`parseThreadsCommentPage`。旧测试使用从原 Threads API 样例派生的形状，未覆盖本次实际集合路径。

[TikHub 官方接口文档](https://docs.tikhub.io/381269440e0)说明该接口不支持来源分页，`end_cursor` 无效；
其公开响应样例中的 `data` 为 null，没有提供实际评论字段样本。这个示例不能作为成功空列表处理。

## 只读原归档

同步更新后的 `server/ops/inspect-post-comment-contract.mjs` 到服务器仓库，然后在
`electron-dock/mx-insight-hub` 目录执行，无需部署镜像：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - --request-id 09a1566b-22e1-4aa9-b159-8649b91844a1 \
  < server/ops/inspect-post-comment-contract.mjs
```

脚本只读取此请求的已有调用与受限响应，先验证字节长度和 SHA-256，再输出有界结构摘要。
不输出正文、作者、ID 值、媒体链接或凭据；未知字段名匿名化。它不请求 TikHub、不重新计费、
不变更原响应、账本或策略。原归档缺失或结构取样不足时，应说明证据限制。

本次首次回执为 `post-comment-contract-inspection.v2`，平台和端点均为 `other`，
归档状态为 `unrecognized_comment_endpoint`。这是旧检查器尚未识别 Threads，因而跳过归档读取；
不能据此认定归档缺失。包含 Threads 映射的检查器现在使用 `post-comment-contract-inspection.v3`，
并可识别 `invalid_social_contract`。已提供内存补丁命令供旧文件执行同样的只读检查，
无需修改服务器文件或部署镜像；补丁分别通过旧版与当前版的离线校验。

## 实际结构与修复

操作者返回的 v3 回执确认归档校验通过（65,207 字节），实际为
`data.edges`，共有 13 个条目。前三项采样显示 `node.thread_items[].post`，带字符串 `id` / `pk`、
`user`、`caption.text`、`taken_at`、`like_count` 及 `text_post_app_info` 的回复、转发、引用计数。
`page_info.has_next_page` 为 true，`end_cursor` 为 null。结构采样只遍历每个数组的前三项，
因此不是全部 13 条原始标量或真实回复归属验证。

旧解析器在查找 `comments` 时触发 `comment_collection`，随后工作流将其归为
`invalid_social_contract`。现在明确识别 `edges` 与原兼容的 `comments`，没有任意数组兜底。
`edges` 按 `node.id` 聚焦对应帖子，继续保留原帖、祖先排除及显式父级和会话根冲突校验。
RapidAPI 原有首页目标校验保持；TikHub 没有新增未经真实标量证实的首项必须为目标的限制。
两类业务共用此修复。TikHub 仍只取一个来源页，不因 `has_next_page: true` 发起无游标续采。

本地回归使用按实际字段结构构造的合成样本，正文、身份和关系不是生产原文。
生产完整原档和真正楼中楼的验收仍待部署环境核对；不会把结构采样或合成测试表述成真实请求成功。
原失败记录、幂等回放和费用保留，部署不会改写历史结果。

## 本地验证与发布

- 从 Git HEAD 读取旧解析器，以同一合成 `data.edges` 页面复现 `comment_collection`；修复后返回评论并排除原帖。
- 新增 TikHub 评论/回复测试及现有 Threads 归属、集成测试共 31 项通过，覆盖完整 `projectPage`、规范记录、两业务各一次模拟采购、幂等重放及已购余量交付。
- 原 Threads 公共 HTTP 交付测试 5 项通过；检查脚本相关 51 项测试通过；`npm run typecheck` 通过。
- 测试未请求供应商，未修改生产数据。将代码同步并部署 Hub 后才会影响新查询；原请求 ID 的已提交失败仍会原样回放。
- 线上验收须使用新请求，或先在部署环境只读校验完整原档；重新查询可能再次计费，不自动重发或改写已扣款记录。

## 后续 HTTP 400 事件

用户随后提供新请求 `cafa1af9-ffae-4f39-9545-e317a64affe6`：同一帖子
`4026682943628068563`，界面为 `external_platform_rejected`，HTTP 与业务码均为 400。
原调用回执已确认评论渠道为 TikHub。这与上面的 200 后解析失败是不同失败阶段，
不能用解析修复解释供应商拒绝，也不能仅凭 400 推断必须购买 RapidAPI 订阅。

已用纯本地链路核对 Scraper 搜索投影、评论表单及 TikHub / Threads API 两种派发，
该长 ID 全程保持字符串且 `post_id` 不变；这不是该生产调用的参数回执。
重新读取官方目录后，Scraper 仍为九项操作且没有评论；Threads API 的
`GET /api/post/comments` 仍存在，Hub 已接入，并以目标评论 ID 复用于回复业务。

操作者通过 `diagnose-tikhub-rejection.mjs` 的内存白名单补丁返回了已验证原档：

- Hub 路径为 `/api/v1/data/social/post-comments`，count 20，无 cursor；状态 committed，Hub HTTP 502。
- 当次调用为 `native.t.api_fe58186e16adc3bb`，call ID `f5dfb86b-54c9-47df-a1c3-577c225bea8c`，outcome rejected，HTTP / businessCode 均为 400。
- 原档 823 字节，SHA 校验通过；根层无 code/message，`detail.code` 为 400，`detail.message` 为 194 字符，精确匹配 `request_failed_no_charge_claim`。
- TikHub 请求 ID 为 `c305e565-a287-42d7-8607-0edb60c135ad`；`billed` 为 null，不是 false。

该固定消息只有请求失败、检查文档与联系支持的通用提示及供应商“不收费”声明，没有具体的订阅、
参数或目标失败原因。不能把它提升为免计费账本事实，也不能由此证明请求参数一定正确、
供应商内部采集异常或必须改买 RapidAPI。HTTP 400 在进入成功评论投影之前被适配器归为上游拒绝，
继续修改字段映射不能消除这次拒绝。本次 HTTP 回执也不同于之前未获取响应的 DNS 错误；
实际代理路径未由此证明，无需据此继续盲目切换代理。

未发现此回执能证明的新增本地实现缺陷。下一步应由 TikHub 按上述上游请求 ID 核查内部失败原因；
已准备如下工单信息供操作者发送，尚未代发：

> Threads `GET /api/v1/threads/web/fetch_post_comments` 查询帖子 `4026682943628068563`，
> 返回 HTTP 400 / detail.code 400，消息为通用请求失败。上游 request_id：
> `c305e565-a287-42d7-8607-0edb60c135ad`。同一帖子此前一次请求
> `00d4d51c-2952-4677-ae82-3bc23addd739` 返回 200。请核查本次具体失败原因、
> 是否需要调整参数，以及本次实际计费结果。

无需继续重复通用归档查询或未经授权的新采集。若操作者选择替代渠道，Threads API 的评论/回复实现已存在，
订阅与策略配置按接口文档核对；仍需独立真实验收，不能承诺切换后一定成功。

## 2026-11-15：评论和回复增加有界退避

用户随后明确要求为 Scraper + TikHub 的评论和回复增加退避重试。本地实现现已针对上述精确 HTTP 400 拒绝加入最多两次重试，间隔 1–1.25 秒、2–2.5 秒；适用 TikHub 的两类业务接口，不改变 Scraper 或原生透传路由。输入、幂等键和请求截止时间不变。

每次调用独立归档并保留 `billed: null` 与原采购估价；成功只交付一次，同页重试不累计为多页。等待期间释放采购预留、派发租约和供应商并发槽，保留父请求去重租约；下一次派发重新检查准入。若取消、暂停、预算或截止时间阻止下一次派发，终结为最后一次已知拒绝，不能把它改成未知结果。新的派发发生超时、未知结果或证据持久化失败时，仍走原有未知结果保护，不回放旧拒绝。

具体匹配范围、计数与限制见 [Threads API 的帖子评论说明](../api/threads-api.md#六帖子评论)。本次实现与测试使用本地夹具；未进行供应商真实请求或生产部署，旧失败记录保持原样。

验证：新增策略单测、TikHub 评论/回复交付、Threads 集成与归属、评论原生路由、评论回复、账号工作流和 Twitter 评论共 160 项通过；`npm run typecheck` 通过。覆盖两次拒绝后恢复、三次耗尽、取消/暂停/截止阻断、每次独立归档、一次客户扣费、幂等重放及第二次派发变为未知结果。HTTP 回归只监听本机，供应商调用均为测试夹具。
