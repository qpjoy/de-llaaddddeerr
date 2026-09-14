# IP 风险画像

仓库实现：`POST /api/v1/data/ip/risk` 和 `POST /api/v1/data/ip/risk/batch`，产品页面 `#/data-products/ip-risk`，接口说明 `/docs/ip-risk`（沿用控制台登录保护）。

## 接入与权限

以 `/tmp/ipsearch` 交付的 Python SDK 0.1.0 为接口证据，移植固定 HTTPS POST 表单封装，不执行 Python 子进程。单条接受一个 IPv4，批量接受 1–100 个 IPv4；域名、IPv6、供应商选择、额外字段和自定义目标地址均拒绝。

管理员显式开通 `ip_risk` 数据域及 `ip.risk.query` 操作，调用 Key 也必须包含两者。新增能力不会隐式授予旧租户或旧 Key。租户页面复用现有短期 Key 引用和成员资格检查；不新增登录或认证方案。

## 部署

1. 按现有 Hub 流程执行 `npm run migrate`，包含 081（provider/HTTP 事件）、082（私有批次快照与事件关联）及 083（Key 次数/频率限制与审计）。凭据复用 migration 052 已有的通用表，无需新增密钥表。迁移不授予任何租户/Key 新权限。
2. 登录 Admin 控制台，在“数据清洗中心 → 外部数据平台 → ipsearch → API Key 管理”填写并保存 key。成功保存到数据库后，已授权 Live Key 即可调用，不需要再修改环境变量。保存和轮换均要求 expectedRevision，防止并发覆盖。
3. “查看 API Key”要求再次输入 Admin Token；列表/统计只返回配置状态。Public 运行时每次派发读取同一个凭据版本快照，轮换不需要重启，正在执行的请求继续使用自己的版本。凭据沿用其他 provider 的数据库明文存储约定，备份和数据库访问按密钥资料保护。
4. 环境变量 `MX_INSIGHT_IPSEARCH_API_KEY` + `MX_INSIGHT_IPSEARCH_ENABLED=1` 仅作为可选旧式配置；数据库凭据优先。Admin 的环境配置状态可用 `MX_INSIGHT_IPSEARCH_CONFIGURED`，不会通过普通详情回传 key。删除/停用租户授权即时阻止后续派发；本期不提供 provider 全局暂停控件。
5. 用户登录、DNS、WireGuard、Internal/Domestic 和 Launcher 部署不变。用户将在服务器执行 `bash scripts/manage.sh ops internal-production deploy`；Dockerfile 会打包整个 migrations 目录，现有 migration Job 会按校验和顺序应用 081/082/083，再更新 Public/Admin 工作负载，本次无需修改 deploy 脚本。当前尚未执行服务器迁移或生产上线。

开发 memory store 的凭据与批次记录在重启后消失，仅适用于本地模拟验证；真实使用必须部署 PostgreSQL。

## 调用

```http
POST /api/v1/data/ip/risk
Authorization: Bearer <Hub Live API Key>
Content-Type: application/json

{"ip":"1.1.1.1"}
```

响应包含 `contractVersion`、`requestId`、`data` 和 `meta`。`data.status` 为 success、partial、no_data；画像位于 `data.data`。保持 SDK 的 `proxy_type`、`risk_score`、`risk_level`、`rapid_rotation_probability_percent`、`human_probability_percent`、`risk_tags` 字段。概率单位为百分数，0 为有效数据；缺失为 null。标签最后出现时间保留原值，不猜测时区。observed/captured 时间不是上游事件时间。

普通调用无需 Idempotency-Key；Hub 为每次请求生成新身份，重复发送也属于新的查询并计数。为兼容已有程序，显式提供 Idempotency-Key 时仍保留精确重放能力。同一 Key/调用者的相同幂等身份复用已完成响应。改参数不能复用原键；不同 Key 的行为服从 Hub 现有幂等作用域。处理中返回 409。结果未知保留 unknown，限制窗口内即使更换幂等键也不能再次派发相同请求。没有自动重试、自动分页、缓存刷新或跨供应商回退。默认最多每 provider 60 次/分钟（PG 共享速率桶）、每进程 3 个并发、每次总超时 15 秒、响应上限 1 MiB。多副本并发上限为进程数乘 3；不是集群并发上限。

## 批量调用

`POST /api/v1/data/ip/risk/batch` 使用同样的两项授权和 Live Key；无需幂等请求头，body 为 `{"ips":["1.1.1.1","8.8.8.8"]}`。此接口覆盖 SDK 的 query_many/AsyncIPSearchClient.query_many；单条接口覆盖 query_ip/AsyncIPSearchClient.query。SDK 没有其他上游 HTTP 接口。

保留输入顺序及重复 IP；成功的重复项是独立调用、独立用量。最多 3 并发，60 秒预算，在剩余时间不足单次 15 秒超时时不再派发。逐项重新核验授权与配额；未知结果的重复 IP 仍受防重复调用保护，返回独立 409。返回 200 只代表批次已完成，须查看每项 status/response/error；meta 汇总请求数和成功数。

Hub 自动为普通请求生成新的批次身份。对于显式使用幂等请求头的程序，批次先持久化身份，再执行各项，最后保存完整响应。重放已完成批次不派发任何子项，也不会重新执行失败项；修改列表、顺序或重复次数须使用新幂等键。处理中/进程中断/批次保存失败保留 pending，返回 409 待人工核对，禁止自动恢复重派。子项请求 ID 由 batchId 和 index 确定，可从用量及上游调用记录核对。幂等范围是 consumer，重放仍需当前有效授权。

## 持久化和计量

- 每次认证后的调用先写 request event，记录 HTTP 状态、错误码、耗时、重放和关联的逻辑请求或 batchId；不保存 key 或输入 IP。批次 HTTP 仅计一条，其子项分别计逻辑用量和真实调用。未完成记录保持 pending 可核对。匿名身份失败由既有认证路径处理，不分配给租户。
- 复用 `usage_requests`、provider_calls、response_archives、restricted_response_archives 和 consumer-scoped response_snapshots。成功响应和用量在 PG 同一事务提交；归档保留完整 bytes/hash，公共输出只含业务白名单。
- 响应过大、网络中断等不能取得完整响应的情况为 unknown，不伪造完整 archive。持久化异常返回结果未知，不能自动再次消费上游；记录可能需要人工核对。
- 首期结果已落 PostgreSQL 原始证据及响应快照，但**不自动写共享 canonical/ES**。IP 查询结果可能带租户业务意图，后续须先定义 observation 授权、保留周期及发布规则，再接 canonical worker。重新规范化应使用 archive，不重新调用上游。
- 仅计量：不预占客户 billing meter；响应 `pricingStatus=unpriced`、`chargeStatus=not_charged`。采购金额、币种、是否计费为 null/unknown。不能把 unknown 展示为免费，也不会将后续价格追溯到本期请求。
- “外部数据平台 → ipsearch”显示 HTTP 尝试、逻辑交付/回放、实际调用、可用响应、未知结果。租户只看到 Hub 产品、接口和自己的 usage。

## 验证边界

`tests/server/ip-risk.test.mjs` 覆盖请求白名单、字段语义、授权、幂等、结果未知、证据落地及关闭隔离。离线 HTTP 响应不代表真实上游联调。本次增加单条/批量、凭据保存及热轮换、二次 Admin Token 查看、重放/授权拒绝的模拟 HTTP 验证。按用户最新要求，不使用真实 key、不发扣费请求；服务器 PostgreSQL 迁移由上述 deploy 命令执行，真实查询由用户在界面填写 key 后验收。

长期接入规范见 [多语言接入设计](../architecture/connector-contract-and-ipsearch.md)。


## 按 Key 的次数与频率限制

开放能力页选择调用者后，在“指定 Key 的次数与频率”选择 Key、数据域或业务操作。累计次数和窗口次数留空表示不额外限制；现有调用者策略、旧 Key 的签发额度、套餐限制、供应商容量保护仍然保留，不自动改成无限。设置仅 Admin Token 可修改，使用修订号和审计事件，不修改授权范围。

累计上限按此 Key 该范围的历史逻辑请求计数（reserved/committed/unknown）；正在执行和未知结果占用额度，失败 released 不占累计额度。频率按窗口内已受理的逻辑请求计数，包括最终失败项；精确幂等回放不新增用量。批量逐 IP 检查；达到上限后未派发的项独立返回 429。修改额度不清零历史，新额度低于已用时下一项即拒绝。

PostgreSQL 在现有 usage reservation 事务和调用者锁内核验上限，配置更新使用同一锁，多实例并发共享计数；不能只依赖浏览器按钮限制。没有客户端请求编号也仍然按真实 Key ID 限制频率，临时调用凭据轮换不改变 Key 身份。此处限制数据查询用量，不替代网关层对匿名请求、无效认证或 HTTP 洪泛的流量防护。
