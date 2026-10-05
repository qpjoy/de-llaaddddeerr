# 多渠道支付与支付宝首期接入

> 2026-10-05 管理中心升级：渠道草稿/发布、成员角色与邀请、应用凭据、订单/客户/财务概览和日志已接入。以 [管理中心部署与授权说明](management-center.md) 为当前操作入口；下文只读查询台及文件渠道配置说明保留作旧版兼容背景。
2026-10-03。独立 mx-pay 现在支持 `mock`、`manual_alipay` 和 `alipay`，可配置多个环境/支付宝应用，按接入应用授权使用。微信、Creem 等需要新增适配器及各自的协议测试；不能仅改 provider 字符串上线。Hub 现有内嵌充值、租户钱包、Launcher/MX-H2I 登录没有切换。

## 参考与实现边界

已只读检查 `/Users/qpjoy/workspace/mingxi/luopan` 的 `feat/yjj/hdo_v2`，提交 `a4cc5de`。其中 `po-frontend/src/features/AgentToolbox/AgentToolboxPage.vue` 使用 `/api/agent-toolbox/payments/alipay/page-pay` 创建充值订单，打开 `pay_url`，再查后台付款状态；`AlipayReturnPage.vue` 明确以异步通知或后台查单为准。随后在 `/Users/qpjoy/workspace/mingxi/po-backend-java` 同名分支、提交 `e86be9c0` 找到对应后端，使用官方 Java SDK `4.40.865.ALL`。接口对照、业务边界和本次修正见[Java 后端核对记录](alipay-java-reference-review.md)；未读取或复用其商户密钥。

mx-pay 采用同样的收银台流程，服务端使用[支付宝官方 Node.js SDK](https://github.com/alipay/alipay-sdk-nodejs-all)，锁定 `alipay-sdk@4.14.0`。`pageExecute` 在本地生成签名链接，`checkNotifySignV2` 验证通知，`exec('alipay.trade.query', ..., {validateSign:true})` 查单并验证响应。这里采用与电脑网站支付一致的 v2 协议；SDK 将 `exec` 标为兼容入口，将来迁移 v3 时应单独验证响应与错误语义。

首期是电脑网站收银台，支付宝页面提供实际付款交互；没有实现面当面 `precreate` 动态二维码、小程序、自动退款或自动关单。应用负责商品、套餐、优惠计算、业务订单与交付；mx-pay 固定支付金额、展示标题、商户和渠道，不因应用后来修改商品而改变已下单金额。

## 配置与一键发布

首次 `bash scripts/manage.sh deploy` 自动创建 `secrets/channels.json` 为 `[]`；既有人工渠道行为不变。文件丢失时从当前部署引用的 Secret 恢复，绝不寻找备份数据库或换商户。正式支付宝不会被自动开启。

准备好支付宝应用后，提供如下私密文件（示例不是可用凭据）：

```json
[
  {
    "id": "alipay-sandbox",
    "provider": "alipay",
    "environment": "test",
    "enabled": true,
    "appId": "2021000000000001",
    "sellerId": "2088000000000001",
    "allowedApps": ["mx-insight-hub"],
    "keyType": "PKCS8",
    "privateKey": "完整应用 RSA 私钥 PEM，含头尾及换行",
    "alipayPublicKey": "完整支付宝公钥 PEM，不能填应用公钥",
    "notifyUrl": "https://pay.example.com/v1/notifications/alipay/alipay-sandbox",
    "returnUrl": "https://app.example.com/payment/result"
  }
]
```

1. 私钥至少 RSA 2048；支持普通公钥模式、PKCS8/PKCS1，暂不支持支付宝证书模式。`keyType` 必须匹配 PEM。沙箱需使用沙箱应用、卖家与买家账号。配置为 test 时只能使用沙箱网关；live 只能使用正式网关，调用方不能传入任意 gateway。
2. `appId` 是支付宝应用 ID；`allowedApps` 是 mx-pay 机器凭据的应用 ID，两者不同。只允许明确列出的应用，不支持 `*`。
3. `notifyUrl` 必须为公网可达 HTTPS、精确路径 `/v1/notifications/alipay/<id>`；`returnUrl` 是固定展示页，不能由下单方随意提供。入口代理只需将通知路径送往 mx-pay，并保留表单内容；不能加 Launcher 登录重定向。业务 `/v1/orders` 等仍要求机器凭据。当前 deploy 不自动申请域名、TLS 或创建公网 Ingress。
4. 保存为 `0600` 的 `secrets/channels.json`，再执行 `bash scripts/manage.sh deploy`。脚本校验配置、写入不可变版本 Secret、执行全部新增迁移（包括 `pay_003`、`pay_004`）、滚动发布；密钥只挂载到 API，不进入迁移 Pod、镜像、报告或浏览器。备份中的私密运行 Secret 会包含此配置，须按密钥级别保护。
5. 新增官方渠道建议先 `enabled:false` 完成所有副本和报表消费者升级，再启用沙箱验收。正式应用产品签约、资质、密钥和回调可达性需在支付宝控制台核实；不能用个人静态收款码代替开放平台应用配置。

`channel_bindings` 固定渠道 ID 对应的 provider/环境/支付宝应用/卖家身份。禁止覆盖已有渠道身份。停止新收款用 `enabled:false`，保留通知验签和查单；不要删除旧配置，否则新实例启动会拒绝，以免丢失待付款通知的处理能力。公钥/私钥轮换须与支付宝控制台及在途交易协调，当前未实现多代验签公钥轮换协议。

同一支付宝账户在人工和官方渠道应使用相同真实 `sellerId` 作为 `merchantAccountId`，数据库按环境、卖家、流水跨两种 provider 去重。历史人工账户若用了任意别名，系统无法推断它与真实卖家的关系；不可另造别名并同时认领同一账户来款。旧 Hub 与独立服务更不能依靠各自唯一索引实现跨库去重，仍需完成唯一写入方交接。

## 应用接入契约

所有应用调用来自自己的服务端。浏览器只取得收银台 URL 和业务侧可见订单状态，不持有 mx-pay Bearer 凭据。

```js
import { PaymentClient } from '@qpjoy/mx-pay/client'
const pay = new PaymentClient({ baseUrl: paymentOrigin, token: serverOnlyToken })
const channels = await pay.channels() // items：当前应用/环境允许的渠道
const order = await pay.create({
  businessOrderId: 'recharge-stable-business-id',
  customerRef: 'tenant-opaque-reference',
  amountMinor: 1200,
  channelId: 'alipay-sandbox',
  subject: '账户充值'
}, 'recharge-stable-request-key')
const checkout = await pay.checkout(order.id) // POST /v1/orders/:id/checkout
// 业务前端打开 checkout.payUrl；打开失败时重新打开同一订单，不重建单。
const local = await pay.order(order.id)
const checked = await pay.refresh(order.id) // POST /v1/orders/:id/refresh
```

- 不传 `channelId` 保持旧行为：test 为 mock，live 为人工收款。`GET /v1/channels` 保留原顶层字段并新增 `items`。
- 新渠道下单必须提供 `subject`（最多 128 字符；不接受 `/`、`=`、`&` 和控制/格式字符）。渠道、金额、标题与业务单一起参与请求指纹；更换渠道不能复用原请求键覆盖订单。
- 先提交本地订单，再取得签名链接；此过程没有服务器向支付宝创建扣款的网络调用。内部 ID 仍是 UUID，新支付宝单的 `checkout.outTradeNo` 为 `MXP` 加去掉连字符的 UUID；签名、查单和回调必须使用同一渠道编号。历史无此字段的订单仍以原 UUID 查单/收通知，不更名，也不再签发新链接；未查清前不能因此重新付款。
- 链接绝对付款窗口为下单后 30 分钟，按秒固定，重新打开不会延长；剩余不足一分钟时停止生成链接，但订单不被自动判失败或取消，仍可收通知和查单。
- `order()` 只读本地数据库，不暗中调用支付宝。`refresh()` 单次请求、5 秒渠道超时；跨副本每单最多一个 20 秒租约、完成后 3 秒冷却，每实例最多 4 个渠道查询。失败/交易暂未找到返回 `payment_channel_query_unknown`，不修改付款事实；429 时继续读本地状态并退避。
- 支付宝订单禁止 `submit/confirm/reject/cancel`；官方关单尚未接入，不接受本地取消伪装渠道已关闭。用户浏览器返回或关闭付款页都不是成功/失败证据。
- 付款成功仍由 `payment.paid` outbox 交给应用。应用自己的 inbox 与钱包入账必须同事务后才 ACK；看到 paid 不能直接声称租户余额已经到账。Hub 已实现独立消费者，但只有配置连接并按环境显式激活后才启用，部署不会自动切换；首次配置及验收见 [Hub 支付接入](../../../mx-insight-hub/docs/operations/payment-delivery.md#首次正式收款页面提示未开通时)。

## 通知、异常与资金事实

通知只接收有界 `application/x-www-form-urlencoded`，拒绝重复字段，URL 解码一次后使用 RSA2 验签，再校验配置的支付宝应用与卖家。无效签名或错误身份返回非成功，不能写成功流水。表单或公钥错误不会泄漏私钥、原始 SDK 响应到日志。

通过验签的通知进入统一核验函数；查单通过响应验签后也走该函数。核验商户订单、渠道绑定、金额、币种、支付宝交易号和付款时间。金额按十进制字符串转整数分，不用浮点数乘 100。当前不自动处理导致实收与订单金额不等的渠道优惠，差额进入 review；手续费未知为 null，不猜测为零。

成功路径在同一个 PostgreSQL 事务内提交：订单 paid + settlement → 不可变审计 → 唯一 outbox → 报表增量 → 不可变渠道观察记录。事务回滚时这些记录均无残留；COMMIT 应答丢失返回可重试错误，同一通知重放只保留一份资金事实。HTTP 只有在事务可靠提交后才返回字面 `success`。

| 输入/异常 | 处理 |
| --- | --- |
| 重复或乱序成功通知、查单与通知并发 | 相同收款只产生一次成功事件，不倒退 paid |
| 金额/实收不等、非法付款时间/流水 | 留 review，不入账 |
| 成功报文另带未收款等附加状态、信用支付模式 | 留 review；待进一步核实资金，不自动交付 |
| 同一卖家流水已属于另一单 | 留 review；数据库唯一约束兜底 |
| `WAIT_BUYER_PAY` | 留观察记录；不撤销已确认付款 |
| `TRADE_CLOSED` | 留 review；它也可能涉及退款，不自动改为未支付或冲销历史付款 |
| 已付款订单出现另一条成功流水 | 留 review，不生成第二笔业务入账 |
| 查不到本地订单或渠道不对应 | 留 unmatched review，不挂到其他应用订单上 |
| 数据库不可用、提交结果未知 | 不回应 success；支付宝重试或后续主动查单补证据 |

`GET /v1/channel-reviews?page=1` / SDK `channelReviews()` 需要本应用的 `receipts.confirm`，返回已关联该应用的异常，不能越权查看其他应用。没有本地订单的记录尚无可信应用归属，当前仅支付数据库运维可查 `pay.channel_observations WHERE order_id IS NULL`；不会向任意应用曝光。

异常记录包含核验所需字段和报文哈希，过滤买家姓名、账号等 PII；并非完整原始签名报文归档。`success` 对 review 只表示已持久接收，**不表示已完成入账或异常处理**。人工应查询支付宝账单及原业务单，记录证据，按正式财务流程退款/补账；不能直接改订单金额、状态或数据库余额。自动案件分派/告警、异常解决 API、原始证据归档、日账单对账和后台定时补单尚未实现；仅靠此 API 不能宣称财务闭环完成。

## 验证与升级

`tests/alipay.test.mjs` 使用临时 RSA 密钥、官方 SDK 验签、真实临时 PostgreSQL/HTTP，覆盖签名篡改、重复字段、商户与应用隔离、重复/乱序通知、差额、流水竞争、提交失败/提交应答丢失、查询失败、停用后收通知、最小权限和独立报表库。部署测试覆盖渠道 Secret 的版本化、恢复和配置失败阻止 rollout。

`pay_001`–`pay_003` 保持原校验和；第三次迁移扩展渠道约束，第四次约束新渠道订单号与内部 ID 的对应关系，不重写历史身份。保留 paid 必须有交易流水的约束。迁移锁等待上限 3 秒、语句上限 30 秒，锁冲突/大表索引未完成则回滚并阻止新 API 发布，需在适当维护窗口再执行；不宣称所有规模下无阻塞 DDL。旧报表消费者仅识别 mock/manual_alipay，开启 Alipay 前须更新 `@qpjoy/mx-pay/reporting` 消费端。

已有 Kubernetes Deployment 且目标启用了官方渠道时，deploy 自动两阶段发布：先以新代码、官方渠道 `enabled:false` 完成全部副本更新，再恢复目标配置。暂停期间新建官方订单/收银台会返回渠道停用，应用应保留原业务单与请求键；旧单通知和查证仍可用。屏障失败不会自动重新启用新收款，重试会重新完成屏障；私密源配置不改写。不支持直接退回不认识新渠道订单号的旧镜像。

本机测试不包含真实沙箱/正式收款、真实公网通知、支付宝商户签约、真实 Kubernetes 故障切换或数据库 HA 验收。

对照 Java 后端及官方模型修正后的完整结果：mx-pay **51/51**、Hub 身份/原充值/报表兼容 **31/31**，均无跳过；其中支付宝专项 **17/17**。支付完整测试在 `TZ=UTC` 下执行，渠道请求时间显式使用东八区，不依赖容器本地时区。升级顺序、失败停止和重试屏障由部署命令替身验证，未代表真实 Kubernetes 验收。
