# Hub 充值接入独立 mx-pay

2026-10-04 更新：Hub 已接 Launcher SSO；mx-pay 也提供独立、仅查看的 SSO 查询台，两者的人会话不参与机器支付认证。Hub 的支付源/订单一致性校验已抽取并实际复用 `@qpjoy/mx-pay/integration`，钱包事务、旧充值兼容和切换门槛保持。见 [支付中心 SSO、应用接入与运维](../../../mx-base/mx-pay/docs/sso-and-application-onboarding.md)。下文 10-03 的“SSO 暂不改动”描述当时交付边界。

2026-10-03。已实现独立支付订单到原租户钱包的交付、账务权限及页面。默认继续使用原人工充值，部署不会自动切换正式收款。SSO 暂不改动，后续由 Hub 接入 Launcher SSO。

## 账户与业务边界

- 人通过现有 Launcher 登录 Hub；原 Hub member、租户、membership、Key 和钱包身份保持不变。平台 Admin Token 仍可管理和排障。
- 租户 owner/admin 保留充值能力；新增可单独授予的 `billing`（租户账务员），只有 `tenant.read`、`billing.read`、`recharge.create`、`invoice.request`。不能管理 Key、确认收款、切换支付源或查看其他租户。已有角色不自动转换。
- 浏览器只调用 Hub。Hub 使用专属于该应用和 test/live 的机器凭据调用 mx-pay，不转发 Launcher token，也不把支付 secret 放进浏览器。
- Hub 决定充值金额、产品类型 `wallet_topup`、受益租户、发起人、开票申请和钱包入账；mx-pay 决定支付单、渠道收款事实和付款事件。`initiatorRef` 是 Hub 从已认证 member 生成的审计引用，不能用于给 mx-pay 用户授权。
- 支付主体的 `createdBy` 仍记录机器凭据 ID；Hub 意图中的 `createdBy` 和支付单的 `initiatorRef` 保留人的引用。Admin Token 操作只能识别为管理员凭据，不能伪称已识别具体员工。

## 接入与一键更新

先用 mx-pay 的 `bash scripts/manage.sh deploy` 部署或更新支付服务。保留原数据库和渠道身份；在其私有 `secrets/credentials.json` 中配置专用应用凭据，至少包含 `orders.read`、`orders.write`、`events.read`、`events.ack`。不要给业务凭据 `receipts.confirm`、`settings.write`；报表继续使用独立的 `reports.read` 凭据。

`GET /v1/identity` 使用业务凭据返回源数据库 UUID、appId、environment、协议特性与该凭据 scopes，不返回密钥。Hub 在激活以及后续调用前核对这些字段。升级期间旧实例若尚不支持该接口，接入暂不可用，不会退回人工收款。

用支付服务的 `bash scripts/manage.sh discover` 获取入口。同集群可以使用 Service DNS；跨集群使用已配置的私网 HTTPS 网关。Hub 不直连支付数据库。不要把另一个集群的 Service DNS 当成可跨集群访问的域名。

Hub 的 `secrets/payment-delivery.env` 使用权限 0600，JSON 单行、不加 shell 引号，例如：

```dotenv
MX_INSIGHT_PAYMENT_DELIVERY_SOURCES=[{"environment":"test","appId":"mx-insight-hub","channelId":"mock","baseUrl":"http://mx-pay.mx-pay.svc.cluster.local:18230","token":"REPLACE_WITH_THE_BUSINESS_SERVICE_SECRET"}]
```

最多配置两个环境，每个环境一个固定 source/app/channel。支付宝沙箱把 test 的 channelId 设为 mx-pay 中已配置的沙箱渠道；正式支付宝使用另一条 live 配置和 live 凭据。当前 Hub 独立适配支持 mock 和支付宝收银台，原静态收款码流程保持兼容。

```sh
# 在 electron-dock/mx-insight-hub 目录
chmod 600 secrets/payment-delivery.env
bash scripts/manage.sh deploy
```

脚本校验配置并生成专用 Kubernetes Secret，执行正常 Hub 迁移（包含 123），再发布应用。该 Secret 只进入 Admin API，Public API、迁移 Job 不需要支付凭据。迁移不访问支付服务。默认文件缺失时保留集群中已有 Secret；显式设置 `MX_INSIGHT_PAYMENT_DELIVERY_ENV_FILE` 却找不到文件则失败。`.gitignore` 和 `.dockerignore` 排除私有文件。

Compose/本地运行使用同名 `MX_INSIGHT_PAYMENT_DELIVERY_SOURCES` 环境变量。设成 `[]` 只暂停远端连接和事件交付，保留已绑定路由与订单，不会自动改回原收款方式。

## 显式切换与旧订单

平台管理员在「充值与财务 → 支付服务接入」查看源 UUID、应用和环境，并确认启用。该步骤决定钱由哪一条链路处理，配置文件和 deploy 都不代替这项操作。

1. 先启用 test，验证建单、查单、入账及开票。mock 付款由支付中心的 test 财务凭据核实，不能用 live 凭据、不能增加真实可消费余额。
2. 正式激活要求旧人工收款已停用，并且旧 `mx_pay.orders` 没有任何 live 历史记录。即使只是已取消订单，也不能跳过核对。
3. 已有正式记录的 Hub 本轮保持原路径；存量导入、渠道流水全局去重与交付证据迁移仍需专项交接。本轮没有通过“忽略存量”开关绕过这个要求。
4. 激活锁住数据库环境路由；旧订单 INSERT 触发器持有同一路由共享锁。因此在途旧建单必须先结束，旧副本也无法在切换后继续新建该环境的旧订单。
5. 已激活 source/app/channel 不能普通修改；移除本地配置、服务故障和代码回滚都不会解除数据库隔离。旧版本程序即使恢复，也会被旧建单触发器阻止。要回退支付路径，需保留已有付款和交付证据并做专门交接。

统一充值列表保留旧、新两类订单。旧订单继续使用原规则查询和处理；新订单不能在 Hub 人工确认收款或本地取消支付宝交易。

## 事务及异常恢复

流程为：Hub 保存充值意图 → 用固定身份创建 mx-pay 订单 → mx-pay 确认付款并保存 outbox → Hub 拉取事件和权威支付单 → 本地事务写 inbox、钱包账本、交付状态和审计 → 提交成功后 ACK。

| 情况 | 处理与保证 |
| --- | --- |
| 点击重复、HTTP 响应丢失 | Hub 以租户/环境/幂等键保留意图；远端业务单号和幂等键固定为 `hub-recharge:<意图 UUID>`。金额或环境不一致拒绝重用。 |
| 支付建单成功但 Hub 未得到订单号 | 显示“支付订单尚待确认”，重试找回同一笔；若付款事件先到，也可以通过固定业务引用关联原意图，不依赖浏览器回跳。 |
| 付款未完成、支付宝查单超时 | 不加余额，不把超时认定成支付失败。保留订单供原身份查证。 |
| mx-pay 已 paid，Hub 尚未入账 | 页面独立显示“付款已确认 · 待入账”，不开放开票；报表读取和订单 GET 都不能触发入账。 |
| 入账 SQL、审计或 inbox 写入失败 | 原钱包 journal、余额投影、inbox、交付状态和审计同一 Hub PostgreSQL 事务回滚，事件不 ACK。 |
| COMMIT 成功但响应丢失 | 返回结果未知；后续事件重放查到 inbox，返回同一交付回执，不重复加钱。 |
| 入账成功、ACK 丢失或进程重启 | 源端未 ACK 事件会再次发送；已提交 inbox 返回稳定回执。此后钱包停用也不阻碍 ACK 已完成交付。 |
| 多副本消费同一事件 | 本地订单行锁、inbox 唯一键及原钱包幂等引用保证同一交付只落账一次。 |
| 金额、币种、源 UUID、应用、环境、租户、发起人或渠道不匹配 | 不入账、不 ACK。保留原意图和异常；不能猜测受益人或另建租户。 |
| 租户/钱包停用 | 保留已付款事实，暂缓交付；恢复原受益账户后重试原事件，不自动启用账户。 |
| 单笔坏事件 | 持久记录错误码和尝试次数，分页继续处理其他事件，再回头重试。不会把扫描游标当作永久 ACK 水位。 |
| 支付中心离线、凭据错误或换成其他库 | 新建意图仍可保留，远端操作暂停；不退回旧链路。现有登录和订单本地查询不依赖 mx-pay 在线。 |

正式账本沿用 `billing.credit_ledger_entries`、原 wallet projection 触发器，幂等引用为 `mx-pay:<支付 UUID>`；测试仅写 `hub_recharge.test_credits`。开票沿用人工申请/登记流程，与入账后的已付金额关联，不生成或发送真实发票。

每个进程最多 4 个并发的前台建单找回、收银台或查证操作；单次 HTTP 超时 5 秒且无隐藏重试。后台每轮每环境最多 10 个事件，按顺序交付，约每 2 秒继续；源故障逐步退避至 60 秒。Hub 事务内不调用远端，锁等待 3 秒、语句 10 秒上限。消费者使用原 Hub 钱包连接池，尚未做大规模吞吐或多节点故障 SLA 验收；它与支付 PostgreSQL 分离，但不能据此宣称所有 Hub 资源已物理隔离。

## 运维、报表与恢复

- 平台管理员 `GET /internal/v1/admin/payments/integration` 查看启用状态、旧正式订单数、后台源故障和最近 20 条交付异常；不返回连接地址或 secret。页面支持查看事件 ID、错误码与次数。
- `POST /internal/v1/admin/payments/integration/{test|live}/activate` 接受 `{sourceId, acknowledge:true}`，仍执行全部服务端检查；租户账务员无此权限。
- 订单操作新增 `retry`、`checkout`、`refresh`，路径仍为 `/internal/v1/admin/payments/tenants/{tenantId}/orders/{id}/{action}`。开票保留 `invoice-request` / 管理员 `invoice-resolve`。
- 发现已付未入账，应核对源、意图、事件和 inbox，修复原依赖后重试。不要直接人工加同一笔余额，否则恢复交付后可能重复补款。
- 支付报表继续走[独立投影同步](payment-reporting.md)，不使用业务 ACK 进度，也不能修改钱包。跨 Kubernetes/数据库部署不影响这条 HTTP 契约；网络中断时投影应显示过期。
- Hub 备份必须包含原 wallet/ledger、iam、旧 mx_pay 以及新 hub_recharge 整库数据。支付中心使用自己的备份。不得只还原充值意图或 inbox 的部分表，更不能清空路由以重新启用旧写入。
- **跨库恢复仍需核对恢复时点**：如果 Hub 回退到了入账前、支付中心却保留已 ACK 事件，仅拉取“未 ACK”不能修复这类历史缺口。恢复后先冻结新充值，核对支付事实与 Hub 账本/inbox，通过专门恢复流程重交付确实缺失的业务记录。当前没有自动跨库恢复或自动回放已 ACK 事件的命令。

本轮未接 SSO、未迁移任何生产身份/余额、未启用正式渠道或进行真实付款。退款执行、存量支付交接、自动渠道对账、总账/关账和发票自动化继续按原设计分阶段实现。

## 本地验收证据

- mx-pay 全套 51 项通过、零跳过；Hub 支付交付/部署、报表、旧充值和原身份认证定向回归 41 项通过、零跳过。使用临时 PostgreSQL 16，支付库与 Hub 库分离，通过真实本地 HTTP 调用；支付宝通知使用生成的测试 RSA 密钥签名并由官方 SDK 验签，未连接支付宝真实账户。
- Hub `npm run build`、`npm run typecheck`、`npm run test:ops` 和修改脚本的 Bash 语法检查通过。打包仍有现有大 chunk 提示。
- Playwright 在 1440×1000、390×844 验证管理员审核 test 接入、账务员默认入口/权限、建单、付款与入账分离、到账后申请发票；无页面运行异常或框架覆盖层、无移动端横向溢出。测试预览只有既有 `/favicon.ico` 404，未发现业务接口错误。
- 测试是应用事务、权限与交互证据，不是生产 Kubernetes 发布、真实渠道资金结算、数据库主备切换或跨库恢复验收。
