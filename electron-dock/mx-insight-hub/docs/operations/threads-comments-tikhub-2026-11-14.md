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
