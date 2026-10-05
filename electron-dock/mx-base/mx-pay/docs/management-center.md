# 支付中心管理与授权

2026-10-05：支付查询台升级为支付管理中心。页面使用原 `https://pay.minsight-ai.com/`、原 mx-pay SSO 客户端和独立会话库；本轮新增 Launcher 界面应用授权，需要 Launcher、Hub、Pay 各更新部署一次；之后角色变更不需要部署。不修改 MX-H2I 登录或联网。

## 账号与权限边界

Launcher 管账号、邀请注册、停用和统一登录。mx-pay 以已验证的 `issuer + subject(userId) + clientId` 为身份键，独立决定模块权限与应用/环境范围。Launcher 登录成功、账号名为 root、Launcher 管理员或 Hub 管理员都不会自动取得支付管理员权限。只有明确分配的 Pay 应用角色通过已验证 SSO 映射成支付权限，与 Pay 本地授权合并；两种来源分别撤销。

| 角色 | 范围 | 能力 |
| --- | --- | --- |
| administrator | 整个支付中心 | 渠道草稿/发布、来源应用与服务端凭据、成员授权/邀请、全部只读订单和日志 |
| channel_manager | 整个支付中心 | 查看、编辑与发布渠道，不管理成员或付款事实 |
| auditor | 整个支付中心 | 查看渠道配置摘要、成员、应用、订单、财务概览和日志 |
| viewer | 指定应用 + test/live | 查询订单、客户收款与交付日志 |
| finance_viewer | 中心或指定应用 + test/live | 收款金额与状态汇总 |

所有角色均不能在网页把自动支付订单改成已付款，也没有退款、会计记账、钱包改余额权限。未来财务模块需定义新的动作、审批和资源范围后再发布，不能因为有现有角色就推定可操作资金。

## 首个 root 管理员：通过 Launcher 界面

1. 更新并部署 Launcher、Hub、Pay。本轮第一次需要部署三个服务；更新代码不会自动创建线上账号或启用收款。
2. 使用现有 Internal Ops Token 或 Launcher 管理员进入「成员与访问 → 用户与账号」。创建 `root` 并设置密码，或签发原注册邀请码、待 root 注册完成后打开该用户详情。
3. 在「角色与应用授权（可多选）」中保留原有基础角色，按需勾选 **MX Admin**、**Hub 管理员**、**Pay 管理员**，保存。MX Admin 仅用于 Launcher 管理；应用角色各自授权。
4. 原应用准入仍生效；如果明确禁止列表有 Hub/Pay，需要由管理员明确解除禁止。额外允许应用只决定准入，不能代替模块角色。
5. 用 root 访问 Hub 和 Pay，登录后即可管理当前已实现的模块。无需复制 userId、编辑 access.json 或执行 bootstrap-admin。现有会话只读信息最多缓存 30 秒；管理写操作每次重新验证上游身份和角色。

| Launcher 角色 | SSO scope | 子应用权限 |
| --- | --- | --- |
| mx-hub-admin | mx:hub:admin | Hub platformAdmin；全租户管理，保留原敏感操作的二次验证 |
| mx-pay-admin | mx:pay:admin | Pay administrator |
| mx-pay-channel-manager | mx:pay:channels | Pay channel_manager |
| mx-pay-auditor | mx:pay:audit | Pay auditor |
| mx-pay-finance-viewer | mx:pay:finance | Pay 中心 finance_viewer |

这些应用 scope 不会加入已有 mx-admin/mx-user。普通注册、可转发邀请码、用户名 root 都不会自动取得它们。角色保存绑定 Launcher 的实际用户记录；不使用浏览器提交的身份声明来授权。

Pay 的 Launcher 权限按当前已验证身份动态计算，不写入本地成员授权。撤销 Launcher 角色不会被部署、重启或接受 Pay 邀请重新导入。如果同一用户另有 Pay 本地授权，要在 Pay 分别移除。旧 `bootstrap-admin.mjs` 仅保留为兼容/应急工具，不是正常部署步骤；旧授权种子仍只消费一次。

迁移需要恢复 Launcher 用户/角色数据库、原 SSO 接入档案与密钥，以及 Hub/Pay 各自数据库。扩容复用各服务原数据库与保留的 Secret。不要因迁移重建同名账号、重新生成会话密钥或重放授权种子；数据库不可用时拒绝授权，不授予临时超级权限。

## 支付访问邀请

支付管理员在「成员与邀请」选择角色、范围，生成一次性链接，48 小时有效，可以撤销。链接的 token 使用 URL fragment，页面进入后转入当前浏览器 sessionStorage 并清除地址 fragment；数据库只保存 SHA-256，不记录明文 token。收件人统一登录后点击「接受支付邀请」，绑定实际身份并原子消费邀请。重复请求不会重复授权。

**Launcher 注册邀请码和 Pay 访问邀请是两件事**：前者创建身份，后者授予支付模块权限。未注册的收件人先使用 Launcher 邀请码注册，再接受 Pay 链接。此版本不自动发邮件，不把业务邀请当成绕过 Launcher 注册策略的凭据。中心管理员不能通过可转发的支付邀请授予。优先在 Launcher 的具体用户详情勾选 Pay 管理员；也保留 Pay 本地按精确 userId 添加的方式。

## 支付宝配置迁入与发布

提供了私有导入工具，只读取明确指定的 Luopan `application.yml` 默认配置，不读取或变更正在运行的 Luopan：

```bash
node scripts/import-luopan-alipay.mjs --source /path/to/po-backend-java/src/main/resources/application.yml
```

输出为 `secrets/channel-drafts.json`，模式 0600、默认禁用、仅允许 mx-insight-hub。转换并校验 PKCS8 私钥 / SPKI 公钥，回调改为 Pay 的精确通知路径，返回地址为 Hub；不会复用 Luopan 的业务回调。私有文件不进入 Git、镜像或迁移 Pod。实际线上环境变量可能覆盖这些默认值，因此不能把本地默认配置视为已验证线上商户身份。

本次本地已导入 APPID、应用私钥和支付宝公钥；源配置没有 `sellerId`，所以保持草稿。同步代码到服务器**不会同步 secrets**，需要通过已有可信 SSH/文件传输把私有草稿送到服务器同一路径，保持 0600，再 deploy。已在数据库中导入的同名草稿不会被文件覆盖；后续用页面修改。

### Seller ID 与直接商户收款

目前代码调用 `alipay.trade.page.pay`，没有传 `seller_id`，也没有 `app_auth_token`，采用应用自身签约商户收款。**下单请求省略 seller_id 与本地不核验收款人是两回事**：渠道配置的 Seller ID 用于签名通过后的收款人核对、不可变订单商户绑定及到账流水去重，因此此版本不能留空发布，也不能从 APPID 推算 PID。

可从该应用对应的支付宝商户账户获取其真实 2088 开头 UID/PID，或从已有成功交易的可信后台记录核对；不得直接采用未验签的通知中的值。异步通知须同时核对签名、APPID、订单号、金额与收款方。参考 [支付宝异步通知验证说明](https://developer.alibaba.com/docs/doc.htm?articleId=106448&docType=1&treeId=204)。页面字段已改名为「到账核验 Seller ID」，避免误认为是在下单时指定另一收款方。

部署后，root 打开「支付渠道 → 编辑草稿」：

1. 补齐真实的 `2088` 开头商户 ID，核对 APPID 与该收款商户、签约产品、生产/沙箱密钥是否对应。
2. 通知地址为 `https://pay.minsight-ai.com/v1/notifications/alipay/alipay-live`；允许应用包含 `mx-insight-hub`；返回地址为 `https://hub.minsight-ai.com/admin/`。
3. 若准备开始收款，选择启用，先「保存」，再「发布草稿」。未通过完整校验的草稿不能发布。

私钥/支付宝公钥只接受写入，GET、页面、审计不返回原文。编辑时留空保留已有密钥。数据库使用独立 control.key 做 AES-256-GCM 加密。多个副本自动读取已发布版本，不必因网页配置变更重新部署。已发布商户身份不能改绑；停用渠道保留验签和历史订单查询能力。

目前自动通道实现是**支付宝电脑网站支付**，支持多商户与 test/live 配置、应用白名单。原 mock 测试和人工扫码 API 保留兼容；本次未新增微信、银行卡或手工退款通道。没有静态收款码也可走支付宝收银台。

## 来源、商品、用户、日志与财务

- 来源应用：应用 ID + 环境是隔离边界，服务端凭据只能操作自己的订单。
- 商品/业务订单：订单保留 `businessOrderId` 和自动支付的 `subject`，在业务应用中映射商品、套餐和购买意图。
- 客户：保留应用提供的 `customerRef`，以及可选不可变 `initiatorRef`；它们是业务引用，不能当成 SSO 授权。
- 支付订单详情：查看创建/状态审计、渠道核验结果和付款事件 ACK。
- 渠道记录：查看通知/主动查单的结果及待核查原因，包含无法匹配业务订单的记录。没有伪造“异常已解决”按钮。
- 管理审计：只追加操作者、目标、动作与非敏感变更摘要；不输出请求原文或密钥。
- 财务概览：按应用、环境、渠道、状态汇总订单金额。不是钱包余额、结算到账、退款净额或会计总账。

Pay 负责支付事实。Hub 继续负责充值意图、幂等事件 inbox、原钱包账本和 ACK。商品目录、购买后发放产品/API 权限、路由、示例和文档归 Hub；此管理功能不代表已完成通用商品商城或自动权益发放。

## 其他应用接入

1. 「应用接入」登记稳定 appId 和显示名称。
2. 分别签发测试/正式的“下单与付款事件”凭据，明文只显示一次，保存到业务服务的私有配置。已有 Hub 凭据不会自动旋转。
3. 在支付宝渠道中加入 appId 白名单并发布。
4. 后端使用 `@qpjoy/mx-pay/client` 创建订单，调用 checkout 打开支付宝收银台。`businessOrderId`、`customerRef` 和幂等键必须稳定。
5. 消费 events，业务应用提交自己的 inbox + 钱包/权益事务之后再 ACK。收到支付页面跳转不等于付款成功。使用 `@qpjoy/mx-pay/integration` 现有 guard/consumer，不重新实现通知验签。
6. `reports.read` 单独签发给只读报表消费者，不发放收款确认权限。凭据轮换要先发布新凭据，再撤销旧凭据。

机器 API 继续用内网 `http://mx-pay.mx-pay.svc.cluster.local:18230`（同集群），或已有受限内网代理；不把服务凭据放入浏览器。公网只开放控制台/SSO 和支付宝通知路径。

## Launcher 全局权限管理契约

模块定义与本地授权数据留在 Pay；Launcher 已通过上述明确 SSO 应用角色分配中心级权限，无需直连 Pay 数据库。更细的按应用/环境授权仍由 Pay 管理。为 Launcher 在「应用接入」登记 `mx-launcher`，签发正式环境“Launcher 权限汇总（只读）”凭据，得到 `permissions.read`，通过内网访问：

- `GET /v1/permissions/catalog`：版本化角色、范围、身份键和未来模块状态。
- `GET /v1/permissions/members`：每页最多 100 个成员及其授权、revision；有 `nextAfter` 时继续 `?after=<nextAfter>`。

该凭据没有订单、渠道密钥或修改付款的权限。后续 Launcher 可以使用该契约收集权限目录和投影授权；不需要接入 Pay 数据库。当前没有自动同步线程，机器 API 不支持代写 Pay 本地授权；Launcher 中心角色已通过 SSO 委派生效。后续远程授权写入应走单独 scope、精确主体、revision 乐观锁、操作者审计与最后管理员保护，不能直接修改数据库或把 Launcher admin claim 无条件提升。

## 部署、备份与验收

`deploy` 自动增加 pay_006 迁移、首次生成独立 `secrets/control.key`、导入旧机器凭据/渠道与私有草稿、运行 API/控制台。数据和原有凭据保留。control.key 丢失优先从原 Secret 恢复；与原 key 不一致就停止，不能重生成替代。控制台和 API 的 pool、进程与 listener 分开，SSO 不可用不影响机器支付/通知。网页授权写操作使用现有共享 SSO 的 Origin + CSRF 校验。

checkout 升级暂停通过 API Pod 的 `MX_PAY_CHECKOUT_PAUSED` 生效，不改写数据库中的已发布配置。所有新读者就绪后再解除暂停；失败需排查后重试。备份包含支付数据库、原 control.key、SSO 身份/会话 Secret 及仍运行的版本 Secret。保留 key 与数据库是一套恢复要求。

上线后依次验证：root 登录/角色、补齐草稿发布、Hub 测试充值与重复通知/事件、正式小额付款的 Pay paid → Hub 余额一次入账 → ACK。当前本地临时数据库/浏览器测试不能替代真实支付宝回调、TLS 和线上商户验收。


本轮本地验证：Pay 全套 101 项通过（含真实 Launcher OIDC、授权/撤权、邀请不固化中央权限及支付事务）；Hub 定向身份/SSO 29 项通过；Launcher 应用角色与网络隔离 9 项、注册/管理会话用例及类型检查通过。用户编辑器桌面/390px、Pay 委派管理员管理流程使用本地 Chrome/Playwright 验收。测试仅使用临时数据库、合成账号和 RSA 测试密钥，未部署生产或发起真实付款。
