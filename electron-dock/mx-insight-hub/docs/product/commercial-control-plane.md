# 订阅、分组、Key、额度与商业控制面

状态：目标设计。当前 MVP 只实现 tenant、consumer、API key、平台 grant、请求窗口和 usage evidence；plan version、subscription、credit ledger、invoice 和 Launcher SSO 尚未实现。

## 1. 对象边界

| 对象 | 含义 | 权威系统 |
| --- | --- | --- |
| Launcher account/organization | 人员登录、MFA、组织选择、全局 AppCenter scope | MX Launcher User Center |
| Hub member/tenant membership | 人员在某 Hub tenant 内的产品角色 | Hub，绑定 Launcher principal |
| Consumer | 调用数据 API 的业务应用/服务身份 | Hub |
| Access group | 一组版本化 platform/capability/dataset/field entitlement | Hub |
| Plan version | 价格、周期额度、并发、保留、SLA 和可选 group | Hub |
| Subscription | tenant/consumer 在一段时间内订阅某个 plan version | Hub |
| API key | consumer 的可轮换凭据，绑定环境和 entitlement snapshot | Hub |
| Credit account/ledger | 预付、赠送、预占、结算、释放、退款和调整 | Hub |
| Provider quota/cost | Night-All 上游 credential 的容量和实际成本 | Night-All |

外部用户只登录 Launcher；Hub 不保存第二套密码。外部程序只维护 Hub API key（未来可增加 OAuth client credential），不需要同时维护 Launcher 用户 API 和 Night-All key。

## 2. “分组”定义

避免一个模糊 `group` 同时代表组织、角色、套餐和 provider channel。明确拆为：

- `access_group`：可使用哪些 platform/capability/dataset/field；
- `plan`：额度、价格、并发、SLA、retention、export/agent 权限；
- `tenant/team`：人员和业务归属；
- `consumer`：实际调用应用；
- `provider/channel`：只留在 Night-All，不暴露给客户。

Access group 每次发布生成不可变 `group_version`。订阅和 key 绑定具体 snapshot；“全部平台”在授权时展开为已批准模块列表，未来新增敏感平台不会自动进入旧订阅。

## 3. 推荐模型

```text
hub_members
external_identity_bindings
tenant_memberships

consumers
access_groups
access_group_versions
access_group_entitlements

plans
plan_versions
plan_limits
price_books
price_book_entries
subscriptions
subscription_entitlement_snapshots

api_keys
api_key_restrictions

quota_buckets
credit_accounts
credit_ledger_entries
usage_events
usage_allocations
invoices
invoice_lines
commercial_outbox
```

关键约束：

- plan/group 发布后不可原地改语义；变更创建新 version；
- subscription 保存 plan/group/price-book snapshot，续费时才切版本；
- API key 绑定一个 consumer、environment 和 subscription entitlement snapshot；
- 金额/credit 使用定点整数和明确 currency/unit，不用 float；
- ledger append-only，余额是 ledger projection；任何人工调整也有正反向流水和审批人；
- usage event 有唯一 `meter_event_id`，重复投递不重复计费；
- provider cost 与 customer price 分表，不向客户响应泄漏 provider/channel。

## 4. 角色与权限

Hub tenant 角色建议：

| Role | 权限 |
| --- | --- |
| `owner` | tenant 生命周期、成员、商业配置、密钥和账单 |
| `billing_admin` | plan/subscription/credit/invoice，不自动获得 raw 数据 |
| `data_admin` | dataset/group/field policy、导入、质量和发布 |
| `developer` | consumer/key、API 文档、测试环境和 usage |
| `analyst` | 已授权 BI/保存查询/报告，无 key/账单管理 |
| `viewer` | 只读 Dashboard/usage |

Launcher 的全局 `insight.admin` 只允许进入 Hub；进入后还要检查 tenant membership。不得让 `mx-admin` 或 gateway admission 直接绕过 Hub tenant、field、credit 或审计策略。

## 5. 订阅生命周期

```mermaid
stateDiagram-v2
  [*] --> trial
  trial --> active: activate/paid
  active --> past_due: renewal failed
  past_due --> active: recovered
  active --> suspended: policy/admin
  past_due --> suspended: grace expired
  active --> canceled: cancel at period end
  suspended --> active: approved restore
  canceled --> [*]
```

- `trial` 有明确 end time、额度和可用 group；
- `past_due` 的数据读取/refresh 行为由 plan policy 决定，不能隐式继续产生上游费用；
- suspension 立即阻止新 refresh/高成本任务，可按合规策略保留历史导出；
- cancel 不删除账本、usage、dataset 或审计；数据 retention 走独立策略；
- plan 升降级在周期边界或显式 proration transaction 生效，保存前后版本和审批证据。

## 6. API Key 生命周期

发行流程：

1. 验证成员 tenant role 和 consumer/subscription 状态；
2. 选择 `test|live` environment、expiry、IP/CIDR、allowed origin（若适用）；
3. 固化 entitlement snapshot 和最大 scope；
4. 只显示一次 plaintext，PG 保存 HMAC digest、prefix、last four；
5. audit 记录发行人、consumer、snapshot 和 reason，不保存 plaintext。

当前实现要求每把 key 都有明确到期时间：控制台和 API 默认 `180` 天，可在签发时通过
`expiresInDays` 设置 `1–730` 天。到达 `expiresAt` 后认证立即失败，列表保留原始
`status` 并以 `effectiveStatus=expired` 展示，不把过期误报成已撤销。升级前已存在且
没有期限的 key 在迁移时获得新的 180 天窗口，避免发布瞬间中断现有调用；仍应按轮换
流程逐步替换。过期和撤销都不会删除历史 usage 或审计证据。

当前平台授权和平台 Policy 绑定到 `consumer`，不是单把 key；因此一个调用者可授权
多个平台，它名下所有有效 key 共享这组平台权限和额度策略。若需要同一调用者下按 key
再细分平台，必须新增 key-scoped grant/entitlement，不能只在签发界面保存一个无执行力
的勾选列表。

轮换采用 overlap：先发第二把 key，验证流量，撤销旧 key。缓存鉴权必须有短 TTL 和主动失效。浏览器前端不长期保存 Admin token；公共 key 不进入 URL、日志、Kibana 或 Night-All。

## 7. 请求授权和额度顺序

```text
authenticate key
  -> tenant/consumer/key/subscription state
  -> entitlement snapshot: platform/capability/dataset/field
  -> IP/environment/request constraints
  -> concurrency + request/record/byte/job/agent-token quota
  -> idempotency record
  -> PG transaction reserve credits/quota
  -> cache delivery or refresh/job
  -> commit actual usage / release / unknown reconciliation
  -> immutable usage + ledger + commercial outbox
```

余额不足时必须在触达 Night-All 前失败。Night-All provider quota 充足不代表客户有余额；客户有余额也不代表某 provider ready。

## 8. Metering 与价格

支持多维 meter，但每个 plan 只启用明确维度：

- request、record、response byte、export byte；
- refresh job、platform fan-out、live provider operation；
- stored search/cache delivery；
- Agent model token、tool call、wall time；
- 人工报告/高成本 enrichment。

同一 refresh 被多个请求 singleflight 合并时：

- Night-All provider cost event 只出现一次；
- 每个客户 delivery usage 独立；
- 是否对 cache hit、stale、live、failed/partial 计价由 price-book entry 明确；
- 计费绝不从当前 `providerCalls`、HTTP 状态或 `items.length` 临时猜测；
- 未知 upstream outcome 保留 reservation，进入 reconciliation，不自动免费重试。

## 9. 管理后台与 Launcher 集成

Hub Admin 提供：

- tenant/member/identity binding；
- consumer、key、rotation/revoke；
- access group/version、dataset/field grant；
- plan/version、subscription、quota、credit、coupon/recharge（如需要）；
- usage、ledger、invoice/export；
- platform/capability readiness 和 refresh/cache evidence；
- audit、approval 和 reconciliation。

Launcher AppCenter 只展示入口和 offline-safe 摘要。未来 SSO 将短期 Launcher bearer 传到 Hub Admin，由 Hub 验证 JWKS 和 tenant membership；Launcher Server 的 service admin token 不发送到浏览器。可以新窗口打开或 shell 内嵌，但 URL、cookie origin、CSP 和 logout 必须独立评审。

## 10. 对外接口分面

- Public data API：consumer API key、稳定 schema、产品授权和 usage；
- Customer self-service API：成员 token，只操作自己 tenant 的 consumer/key/subscription/usage；
- Internal Admin API：Hub operator，高风险动作需要审批/audit；
- Service integration API：Launcher/Night-All workload identity，精确 method/scope；
- Billing webhook：签名、timestamp、nonce、重放保护和 idempotency。

public/admin listener 继续物理分离。任何 public wildcard route 都不能访问 Admin、invoice mutation、provider、Credential、Kibana 或 raw artifact。

## 11. 最小交付顺序

1. 版本化 access group + key entitlement snapshot，替代当前 consumer mutable grant 的生产语义。
2. plan/subscription 状态和多维 quota，不先做支付渠道。
3. append-only credit ledger、reserve/commit/release/refund 和 reconciliation。
4. Launcher JWKS identity binding、tenant roles 和 self-service UI。
5. price book、invoice line/export；需要在线支付时再接支付 provider。
6. coupon/recharge/reseller/多币种等商业能力按真实销售流程增加，不先复制 Sub2API 所有页面。

## 12. 上线门槛

- 同一 idempotency/meter event 重放不会重复扣费；
- reserve、usage 和 ledger 在并发下守恒，余额永不由可变 aggregate 直接改写；
- plan/group 版本更新不扩大既有 key 权限；
- key revoke、member suspend、subscription suspend 在定义的传播 SLO 内生效；
- test/live 数据、Key、配额和账本隔离；
- Launcher 登录不能绕过 Hub tenant role，Hub outage 不影响 Launcher/MX-H2I；
- 缓存命中、stale 回退、partial/unknown 和合并 refresh 的计费均有合同测试；
- 财务/usage/audit 导出可从 immutable evidence 复算。
