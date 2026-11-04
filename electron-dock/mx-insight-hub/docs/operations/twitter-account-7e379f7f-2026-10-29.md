# 人物画像 Twitter 账号采集失败：7e379f7f

日期：2026-10-29（Asia/Shanghai）。状态：已定位代码链路，待 Internal 原请求取证；未认定具体上游根因，未修改业务逻辑或部署。

## 已知证据

用户截图为 dev 人物画像 Agent Run #385336，`data_query_init / search_crawl / twitter`，第 1 页、目标 50。
Hub requestId 为 `7e379f7f-3ab6-460f-bb6c-57f1c79d3d89`，返回 HTTP 502、
`external_platform_response_unusable`、`outcome=succeeded_unusable`、`retryable=false`。
回退到 Night-All 后又报 `ValueError`，回退 requestId 为 `req_mvtbaxoi_8b2c3798`。

截图中的失败发生在采集阶段，尚无证据指向画像模型、SSO 或 MX-H2I 联网。
本机 kubeconfig 仅有 docker-desktop，没有 Internal 集群连接；本轮未取得该请求的生产账本或原始回执。

## 代码链路与证据边界

- Hub `server/external-platforms/social-account-workflow.mjs` 将资料查询或抓帖的
  `succeeded_unusable` 统一包装为这条 502；公共响应没有携带具体失败端点或底层 errorCode。
- 当前 Twitter RapidAPI 适配器 `server/adapters/rapidapi.mjs` 在 HTTP 成功但后续处理失败时
  可记录 `social_upstream_response_unusable`，其中包括 JSON/字符解码、响应结构、身份校验等问题；
  超时或大小上限也可能落入 `succeeded_unusable`。工作流的二次投影失败则记录 `invalid_social_contract`。
  所以 `succeeded_unusable` 既不等于可交付成功，也不能单独证明是供应商故障或 Hub 解析缺陷。
- 适配器和工作流均有 catch 丢弃原始解析异常原因。保存的错误码可缩小范围；确认具体字段仍可能需要
  在受限存储内用原始回执离线复现，不应重新采购来代替历史取证。
- 2026-10-20 另一笔账号请求曾是 `{"data":{},"userExists":false}`，当前代码对严格符合此结构的
  新账号查询已返回 `404 social_account_not_found`。本次不能套用旧事故结论，也未核实线上镜像版本。
- `retryable=false` 是不自动重试的处置标记，不证明账号永久不存在。`billed=null` 代表供应商计费未知。

Delta 的 `/Users/qpjoy/workspace/mingxi/po-infra/llm/twitter_crawl_fallback.py` 对确认终态的首页失败允许
一次独立 Night-All 回退。截图有回退 requestId，结合当前实现说明已取得 `_request` 返回的响应；
不能归因为回退尚未开始时的预算检查。后续非 200、错误响应、无可用帖子、结果或分页合同不合法等均可触发 ValueError。
提示只追加异常类型和 requestId，详细原因由 `llm/skill_runtime.py` 保存到
`AgentSkillRun.request_meta.twitter_crawl_fallback.message`，应读取这一字段而不是猜测原因。

## Internal 只读取证

将本次新增脚本同步到 Internal 仓库后，在仓库根目录运行；脚本通过 stdin 送入已有 Admin Pod，无需部署镜像：

```bash
kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- \
  node --input-type=module - 7e379f7f-3ab6-460f-bb6c-57f1c79d3d89 \
  < electron-dock/mx-insight-hub/server/ops/diagnose-twitter-account.mjs
```

脚本仅查询该 UUID，READ ONLY / REPEATABLE READ，语句超时 5 秒、锁超时 1 秒，最终回滚。
最多输出 50 条采购记录并标注截断；最多检查 3 份失败回执，每份不超过 8 MiB。
校验原始字节长度及 SHA-256 后只输出固定字段的类型、计数和明确否定标记，不输出账号、帖子、URL、游标、凭据或任意原始字段名。
不导入业务 gateway，不调用供应商，不清理预留、不重放、不修复历史账务。
`found=false` 仅表示当前连接数据库未找到，不证明没有派发。结构报告未运行解析器，不能把它当成解析恢复验收。

在 **dev Delta 对应数据库** 查询回退诊断（只读，不需要调用 Night-All）：

```sql
BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '5s';
SELECT id, status,
  request_meta #>> '{twitter_crawl_fallback,primary_request_id}' AS primary_request_id,
  request_meta #>> '{twitter_crawl_fallback,request_id}' AS fallback_request_id,
  request_meta #>> '{twitter_crawl_fallback,status_code}' AS fallback_http_status,
  request_meta #>> '{twitter_crawl_fallback,message}' AS fallback_message,
  request_meta #>> '{twitter_crawl_fallback,returned_posts}' AS returned_posts
FROM llm_agentskillrun
WHERE agent_run_id = 385336
  AND request_meta #>> '{twitter_crawl_fallback,primary_request_id}' = '7e379f7f-3ab6-460f-bb6c-57f1c79d3d89'
ORDER BY id DESC LIMIT 10;
ROLLBACK;
```

## 本地验证

诊断测试 3/3 通过，无跳过：校验回执损坏/大小/JSON，区分明确未找到与空资料，验证输出不包含任意业务字段或值，
使用 PGlite 执行实际查询并验证只读事务及按 requestId 隔离。`node --check`、`git diff --check` 通过。
这些是本地诊断工具验证，不是原请求根因或线上恢复证明。MX-H2I 登录、联网、Launcher、SSO 与 Pay 未改动。
