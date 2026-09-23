# 管理员请求诊断

入口：数据浏览中心 → 请求诊断。只有 Admin Token 会话可见且可调用；
Launcher 用户（包括 Launcher 平台管理员）和 Public listener 均不可访问。
不修改 MX-H2I 登录、联网、采集分发、客户结算或交付复现。

## 查询行为

`GET /internal/v1/admin/request-diagnostics/:identifier` 显式只读查询。
先匹配 Hub UUID；不存在时按 provider/connector 账本中的 `upstream_request_id`
精确反查。支持 Night-All `req_…`；不搜索任意响应正文，也不直接查询 Night-All 服务。
输入最多 191 字符，参数化查询，不支持模糊检索。

响应 `private, no-store`；PostgreSQL 采用 REPEATABLE READ / READ ONLY 事务，
单语句超时 3 秒、锁等待 1 秒。最多返回 20 条关联请求，每条最多 50 条供应商调用和
50 条连接器调用，达到上限时明确提示截断。只查询当次调用，不把旧缓存来源的调用
计入当次采购。切换标签保留页面内查询状态，但不自动发送；离开诊断时中止浏览器等待。

可查看 released/reserved/unknown/committed 状态、Hub HTTP/错误码、交付来源、
上游 HTTP/业务码、关联 ID、UTC 毫秒级时间、耗时、归档是否存在、客户结算和采购证据。
保留失败与成功回退的区别。`billed=null` 显示未知；`estimated` 不是实际采购扣款；
`shadow` 客户结算不表示钱包实际扣款。无记录不证明请求没有执行。

## 受限归档边界

诊断不返回请求参数、响应正文、签名、Headers、凭据、堆栈、URL 或任意供应商文本。
Qixin 非成功调用的受限归档仅允许 SQL 投影两条已核实的固定消息：
“未授权调用该接口”和“未添加IP白名单”，且只对 `provider=qixin/outcome=rejected`
生效；应用层再次白名单校验。其他消息显示“受限响应已保存，消息未开放”，保留业务码。
这不是通用 raw-response 接口，也不解除已有受限原始响应访问规则。

Night-All legacy 兼容调用的明确 HTTP 拒绝，自 migration 102 起补充结构化错误链：
顶层/候选端点错误码、内层 HTTP 状态（仅上游提供时）、端点 ID、关联 ID 和层级位置。
只遍历 error/details/cause/errors/endpointTrace/attempts，最多 16 项、6 层，超限明确标记。
错误说明由固定错误码映射，不是原始 message；不保存任意 message、stderr、正文或凭据。
原错误缺少的字段不会推断补齐，也不会把多个候选端点失败解释为唯一根因。

非 JSON 或损坏 JSON 的 HTTP 拒绝也保留响应头 requestId/traceId。
结构化错误链仅记录证据。公共错误仍为 `night_all_rejected`；2026-09-23 起，
响应 envelope 自身的有效 code 另补充到 `error.details.upstreamCode` 和 message，
嵌套候选诊断仍不透传。HTTP 状态映射、回退与扣费不变。
证据独立限时写入（SQL 1 秒、锁等待 500 毫秒），写入失败不阻止原有结算；
未迁移时原调用继续原有行为，诊断显示证据缺失。读取兼容 migration 102 之前的表结构。
旧请求不会补回内层错误。po-infra 入库校验、采集 Run 和平台隔离仍不在 Hub 请求账本中。

## 部署

正常构建并更新 Hub Admin API 与前端，无须重启或改动 Launcher。
migration 102 增加可空的 connector failure_evidence 字段，不回填历史记录；
约束使用 NOT VALID 避免部署时扫描历史账本，仍检查新写入。
已有数据库需具备当前 Hub migrations，诊断所用
数据库角色须可读取账本与受限归档；权限不足时返回 503，不扩大数据库授权。

大型账本上线前，由运维使用既有安全数据库连接方式执行：

```bash
psql -v ON_ERROR_STOP=1 -f scripts/request-diagnostics-indexes.sql
```

该脚本独立运行，不放在事务内；并发创建两个上游 ID 索引，不阻断正常账本写入。
不自动调用生产数据库或执行部署。缺少索引时上游 ID 查询可能超时，界面会提示；
已存在的 Hub UUID 优先走主键，不依赖反查索引。
若并发建索引被中断，应由运维检查索引有效性后重试，`IF NOT EXISTS` 不会修复无效索引。

建议验收：查询已知 Qixin 105 失败，确认 Hub released/502、上游 HTTP 200/105、
客户 released/扣款 0；再查 Night-All 关联 ID、未匹配 ID，以及非管理员访问。
不要通过发起付费查询生成验收样本。
