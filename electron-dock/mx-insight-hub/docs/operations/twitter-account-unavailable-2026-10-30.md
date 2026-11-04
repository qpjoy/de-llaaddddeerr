# Twitter 账号不可用的明确错误合同

## 原请求证据

请求 `8a128b3b-6b25-4317-beec-623b75c72f83` 在北京时间 2026-10-30 17:06:33–17:06:36 调用一次 RapidAPI `social.profile.get` / `twitter-aio.user-info`，调用 ID `55a1df96-8602-4695-9bb6-46633cce1c90`。上游 HTTP 200，115 字节回执通过长度、SHA-256 与 JSON 校验；`data.users` 唯一候选为 `UserUnavailable`，没有 legacy/core。诊断未展示另外两个字段，不能断言具体是封禁、删除或暂时不可读。供应商计费未知，Hub 已保存 502；帖子抓取没有开始。

## 修改

- 新账号工作流只在 Twitter 资料查找阶段识别明确否定结果。`userExists:false` 且空 data 保持 `404 social_account_not_found`；唯一有效候选位置的 `UserUnavailable` 返回 `422 social_account_unavailable`。
- `details` 包含 `platform=twitter`、`stage=account_lookup`、`outcome=rejected`、`retryable=false`。不可用结果的 `reason` 仅从明确枚举归一化：suspended、deactivated、deleted、protected、not_found；其他值为 unavailable，不输出供应商任意 message，不靠自由文本猜测。
- 不继续时间线、不计入供应商故障熔断或解析隔离。保持原始回执、billed=null 与现有客户计费规则，不重写旧 502，不自动重新采购。
- 多候选、冲突的有效资料/时间线、上游错误、格式异常仍走原验证；旧 social/search 与帖子解析不改。
- 管理诊断说明明确账号状态。独立只读脚本升级 v2，报告允许列表中的 unavailableReason，可检查新拒绝与历史不可用回执，不显示账号或任意消息。
- Delta（`/Users/qpjoy/workspace/mingxi/po-infra`）严格匹配 HTTP、错误码和详情，显示中文原因，标记不可自动重试，阻止 Night-All 回退；SDK 异常、Skill 异常和任务 request_meta.social_account_error 保留分类及原 Hub ID。直接采集器在步骤 params._collector.social_account_error 保存同样分类。检查点保持失败，不变成成功空列表。其他终态失败保留原回退行为。

例如供应商只明确返回 `UserUnavailable`、未提供可识别 reason 时，新请求返回：

```json
{"error":{"code":"social_account_unavailable","message":"The upstream provider reported that the Twitter account is unavailable","details":{"platform":"twitter","stage":"account_lookup","reason":"unavailable","outcome":"rejected","retryable":false}}}
```

HTTP 为 422，实际接口另附原 Hub requestId；此示例不代表原历史请求已被改写，也不将原请求归为 suspended。

## 发布边界

本次本地修改，未部署、未调用真实供应商，无数据库迁移。建议先发布 Delta 错误识别，再发布 Hub；旧 Delta 尚未更新时可能把新 422 当作普通客户端拒绝继续回退。Hub-only 发布时禁用 Launcher 同步，不涉及 MX-H2I 登录或联网。历史 502 不从错误码反推新分类，须按原 ID 读取证据。

## 验证

- Hub 定向回归 148 项通过：适配器、错误分类、账号工作流、真实本机 HTTP 422 与幂等回放、旧 social 合同、传输错误、诊断与公开文档。类型检查通过。
- Hub 全量服务端测试 4456 通过、48 失败、177 跳过。47 项与上轮既有失败匹配；另 1 项 JustOne 账号搜索容量错误的旧 reasonCode 断言在恢复修改前模块后也复现。该路径不执行本次 Twitter 账号工作流；不修改其预期。本轮 300 并发用例通过。
- Delta 最终 Python 3.13、独立临时 PostgreSQL 环境运行相关 69 项，全部通过，包含停止 Night-All 回退、错误原因/ID 透传、失败检查点、Skill 诊断及直接采集步骤。所有采购均 mock。测试禁用媒体下载；本机缺少 libmagic，测试启动器仅对 MIME 模块放置调用即失败的桩（未触发），不将本次验证表述为媒体功能验收。
- 两仓库本次改动的差异检查通过。保留用户已有未提交修改；未提交、部署、改写历史、修改费用或发起付费请求。
