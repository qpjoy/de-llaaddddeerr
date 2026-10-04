# 支付中心 SSO、应用接入与 Internal 运维

2026-10-04。代码实现与本地隔离验收；未部署服务器、未启用正式渠道、未切换 Hub 存量充值。

上线条件更新：用户已确认当前没有存量订单，可以按全新接入直接上线，无需安排历史订单迁移。发布时仍由原激活逻辑核验无正式旧单、旧收款已停用；保留这些检查，避免目标环境与预期不一致。支付 API 可以先使用内网地址；查询台 SSO 需要独立 HTTPS origin（可以是内网 IP + 独立端口或内网域名），不强制申请 pay 子域名。正式支付宝异步通知需另有渠道可访问的公网 HTTPS 入口，可由已有域名的固定通知路径转发。

2026-10-05 域名已确定为 `https://pay.minsight-ai.com`，用户已完成解析。两层 Nginx、独立证书及续期接入位于 `de-mingxi/compass/deploy/PAY.md`：Domestic TLS → WireGuard `10.88.88.88:80` → Internal Nginx → 支付集群 ClusterIP。公网仅开放查询台/SSO 与精确的支付宝通知路径，Hub 的机器 API 继续走内网。`internal-pay-install` 使用已固定支付集群的实际 API/console Service IP；`pay-enable` 在证书及两服务就绪后启用，不能照搬 Hub 的 hostNetwork 回环端口。`cert issue pay.minsight-ai.com` 首次签发之后，原 `install-timer`、默认 `renew` 和 `force-renew` 均包含 Pay；无需独立定时器。配置已准备，服务器执行与正式联调尚未进行。

## 三条独立链路

| 调用方 | 入口与凭据 | 数据和权限归属 |
| --- | --- | --- |
| Hub 等业务应用后端 | 18230 `/v1/*`，专用应用与 test/live 机器凭据 | mx-pay 保存付款事实；应用保存业务意图、客户、权益与交付 inbox |
| 支付查询台用户 | 独立 18231，Launcher Auth 托管 OIDC + PKCE | mx-pay 自己的加密会话与本地查看授权；不继承 Hub 租户或 Auth 管理员权限 |
| Launcher Internal 运维 | 现有独立执行器 → mx-pay `scripts/manage.sh` | 发布、状态、诊断、有限日志；不承接交易或直接修改支付账本 |

查询台是独立进程 / Deployment / Service，使用单独的限额连接池；付款 API 不导入 SSO、不挂载客户端配置，也不检查 Auth 健康。Auth 故障只影响人的新登录与会话复核；原机器 API、支付宝通知和应用事件交付继续工作。两个进程使用同一专用支付数据库，**不是独立数据库故障域**。查询池只读，会话池最多两条连接。

查询台支持登录、账号选择、账号安全链接、本地退出，按应用/环境筛选订单、付款状态、完整业务订单号和分页。订单列表不返回付款人、外部流水、checkout、渠道密钥、客户/发起人引用。没有确认到账、退款、入账、ACK 或配置写入路由。登录页面不自动重试登录，也不因查询失败清理原有效会话。

## 登记与配置

1. 在左侧导航继续向下滚动，打开 **平台设置 → 统一认证**，在「新增接入应用」填写：认证入口 **公网认证**，应用名称 **MX Pay**，应用标识 **mx-pay**，应用 HTTPS 地址 **https://pay.minsight-ai.com**，Audience 首次登记使用 **mx-pay**。依次「校验配置 → 保存应用 → 前往 Launcher 发布」，发布完成后刷新确认「Auth 已加载」。Client ID `mx-pay-web` 和 `/auth/sso/callback` 自动生成；运行与维护的 MX Pay 卡片只负责服务操作。沿用现有 Auth 发布流程使新增客户端生效；不会重建原用户或轮换 Hub、Launcher 凭据。
2. 将主机登记产物 `/var/lib/mx-launcher/identity/applications/{public|private}/mx-pay.json` 安全提供给支付项目，默认位置 `secrets/console/profile.json`。也可在支付 `.env` 用 `MX_PAY_SSO_SOURCE` 指定该固定私有文件。不能将内容粘贴到浏览器草稿、URL 或提交到 Git。
3. 创建私有 `secrets/console/access.json`。初次可为 `[]`：用户能登录，但看不到任何订单。它只支持明确的 `viewer` 授权，示例：

```json
[
  {
    "issuer": "https://auth.example.com/identity",
    "subject": "原 Launcher 用户的不可变 userId",
    "clientId": "mx-pay-web",
    "appId": "mx-insight-hub",
    "environment": "test",
    "role": "viewer"
  }
]
```

以上为占位示例，不是生产配置。`subject` 是 OIDC 的原始 subject / Launcher userId，不加 `user:` 前缀；以实际已验证身份为准。邮箱、显示名、企业名不能用于绑定。issuer/clientId 必须与 mx-pay 档案匹配；禁止 `*` 应用、环境或隐式管理员。文件使用 0600，包含文件的目录使用 0700；Kubernetes 只读 Secret 使用 0440 + fsGroup。

新授权在查询台配置发布后生效，撤权需确认全部旧查询台副本已退出。Launcher 上游禁用账号/应用沿用共享 SDK 会话复核机制。**当前未提供支付人员授权编辑页面**；该私有文件是首阶段明确授权入口，后续可接 Internal 的受审计业务权限管理，不能直接复用运维 Token 作为人的支付权限。

SSO 复用 `@qpjoy/mx-common/identity/sso`、`identity/postgres`、`identity/profile`，没有复制 Hub 的用户、租户、邀请或登录代码。迁移 `pay_005_console_sso.sql` 只增加通用会话表，沿用应用自己的迁移器。持久 sessionKey、会话 Cookie 与 Hub 隔离；新副本读取同一支付会话库。支付的机器凭据与渠道密钥不进入查询台 Secret。

## 部署与网络

Internal Nginx 支持自动查询上游：在 `de-mingxi` 执行 `bash scripts/manage.sh internal-pay-install --pay-root <mx-pay项目目录>`。脚本读取 `.deploy/target.json` 固定目标并校验集群 UID，随后通过 kubectl 查询 API/console Service 的当前 IPv4 ClusterIP 和约定端口；无需手工填 IP。保持与 Pay 部署一致的 `KUBECONFIG`，缺少目标、查询台或集群身份不符时会停止并保留现有 Nginx。每次执行均重新查询；Service 重建后重跑同一命令即可。它是独立的网关安装步骤，尚未由 Pay deploy 自动调用或后台监听。

```sh
# 支付项目目录；已有 .env / Secrets / 数据库身份优先
bash scripts/manage.sh deploy
```

- 默认 Kubernetes，支付 API 仍为 `mx-pay:18230`。配置齐全时再发布 `mx-pay-console:18231`，迁移先于两者，查询台发布在 API 就绪之后；查询台 rollout 失败返回非零，但不回滚已提交资金、不撤回已经就绪的交易 API。
- 不配置 SSO 时继续只发布原 API。已经部署的查询台缺失本地文件时从保留的独立 Secret 恢复，不能以文件丢失为由生成新客户端、会话密钥或空权限。
- 新增查询台 origin 的 HTTPS 反代应转发根路径、静态文件、`/auth/sso/*` 与 `/console/v1/*` 到 **console Service**。不要把 `/v1/*` 机器 API 公开到查询台域名；通知入口仍走原经过验签的支付通知路径。域名、证书与 Ingress 不自动选择或发布。
- 内网 Auth 档案包含原 CA，公共 HTTPS 档案使用系统信任。反代保留正确 Origin；Cookie 是 Secure / HttpOnly / SameSite=Lax。退出要求同源及 `x-mx-csrf`。
- Compose 使用可选 `deploy/console.compose.yml`，只在 SSO 档案存在时由管理脚本载入。Compose 不具备双节点滚动可用性。
- 现有 CLI 的 `start/stop/restart` 保持交易 API 范围；查询台独立运行。本次 Internal 只暴露 status / logs / doctor / deploy，不暴露停止交易、数据库迁移、备份删除或资金操作。
- `logs` 返回有限行，含已部署查询台；不会无限跟随占住运维任务。Secret 的恢复、支付库保护、渠道兼容 rollout 均保留。

Internal → 运行与维护新增 MX Pay 卡片，目录为 `mx-base/mx-pay`，调用该产品自己的脚本，不调用 Launcher/Hub 发布。已有执行器升级时只追加缺失的 Pay 实例，保留原路径/令牌/档案/任务；经任务排空重新载入。预检摘要包含支付 `.env`、凭据、渠道、SSO、人员授权、保留集群目标和 kubeconfig；内容不返回浏览器。文件路径须为固定配置，动态 shell 路径应在主机核对执行。

## Hub 是首个业务接入方

Hub 已有独立充值意图、事件 inbox、原钱包原子入账和提交后 ACK，继续按 [Hub 支付交付说明](../../../mx-insight-hub/docs/operations/payment-delivery.md)配置及审核启用。SSO 用户在 Hub 里充值不需要再登录 mx-pay 查询台。

公共能力位于支付包，支付语义不放进 mx-common：

| 模块 | 其他应用可复用的能力 |
| --- | --- |
| `@qpjoy/mx-pay/client` | 稳定请求键建单、查单、checkout、事件拉取/提交后 ACK；网络未知结果保留原请求身份 |
| `@qpjoy/mx-pay/integration` | `verifyPaymentSource` 校验固定 source/app/environment/features/scopes；`verifyPaymentOrder` 校验原业务订单、客户、金额、币种、发起人、渠道、付款 ID 与版本 |
| `@qpjoy/mx-pay/reporting` | 消费者自己的只读投影与游标事务；不 ACK 交付、不写余额 |

Hub 已实际调用新的 `integration` 导出，保留其原错误码、来源绑定、旧充值开关和入账事务。订单校验当前覆盖 Hub 已使用的 mock / Alipay 渠道；不能将它当作已支持任意支付渠道。业务应用仍须在自己的数据库保存 intent/inbox、提交权益后 ACK，不能把 SDK 验证通过当成交付完成。`initiatorRef` 是应用审计引用，不是 mx-pay 登录或授权依据。

后续应用可以按以下顺序接入：独立机器凭据 → 查询并持久绑定 source/app/environment → 本地稳定业务意图 → 原请求键建单 → 核对权威付款单 → 应用内事务提交 inbox 与权益 → ACK。新的业务钱包、会员等均属于该应用，不创建 Hub 租户或借用其钱包。业务失败不自动退回旧支付链路。

## 验证与上线前待定

本地验收使用临时 PostgreSQL 16、真实 Launcher OIDC HTTPS、隔离的 Auth / 支付 / Hub 数据库，覆盖无授权登录、跨应用/环境拒绝、Cookie 与机器凭据互不授权、callback 单次消费、会话重启、撤销/CSRF、Auth 故障期间机器 API 可用、支付事务故障与部署配置恢复。Chrome UI 验收另用本地合成数据，验证筛选、分页、空列表、退出和 Internal 命令预览；不代替生产联调。

本轮验证结果：mx-pay 全套 57 项通过、零跳过；最终部署/PG16 权限增量 18 项通过。Hub 支付交付、旧充值与身份定向 43 项通过（其中旧飞书导航测试适配现有中转页后单独复验通过）；运维目录/执行器/安装/脚本 25 项及服务端运维鉴权/网络身份隔离 8 项通过。Hub 与 Launcher 服务端类型检查、MX-H2I 完整 `check` 通过。桌面 1440×960、窄屏 390×844 使用现有 Playwright/Chrome 验收，页面身份、非空内容、无错误遮罩、相关控制台错误、截图和交互检查均通过；未接生产账户或真实资金。

可复用测试入口：

```sh
# 在 mx-pay；MX_PAY_TEST_DATABASE_URL / MX_SSO_TEST_DATABASE_URL 指向一次性本机库
# SSO 测试库名须包含 sso_test；tsx 来自相邻 Launcher 的已有依赖
node --import ../../mx-launcher/server/node_modules/tsx/dist/loader.mjs --test tests/*.test.mjs
# 独立 PG16 初始化/权限/恢复测试另外设置 MX_PAY_TEST_PG_BIN
# 在 mx-launcher/server
pnpm test:service-operations
# 在 mx-launcher/demos/mx-h2i
pnpm check
```

上线需要共同确定：

1. 域名与路由已确定：`pay.minsight-ai.com` 查询台，复用公共 `auth.minsight-ai.com/identity`。上线时按已固定的支付集群目标核对 Service IP，完成服务器签证、两层配置安装和真实 SSO 回调验收。
2. 首批按应用及环境授予的查看人员；后续资金操作角色、复核与审计如何在 Internal 配置。
3. Hub 的正式渠道配置及首次收款验收；用户已确认无存量订单，按全新正式接入启用，运行时保留无旧单与关闭旧收款的核验。
4. 支付专用数据库的备份、异机恢复与真实双节点发布验收。查询台页面上线不代表付款系统已具备完整 HA、退款或自动对账。

本轮没有修改 MX-H2I 用户登录、飞书账号、网络授权、VPN、路由、DNS 或 Hub 原账号绑定策略。
