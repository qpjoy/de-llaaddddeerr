# 通用 SSO 接入模块与 Hub 业务适配

后续增量：mx-pay 已使用本文共享 SDK 接入独立支付查询台，Hub 也复用支付业务接入校验，详见 [49 · 支付中心接入](49-payment-center-sso-and-operations.md)。本文后续提到 mx-pay 尚未接入，指此次共享模块抽取时的历史边界。

2026-10-04。状态：代码实现与本地隔离验收；未执行生产部署。承接 [45 应用原生账号接入](45-application-account-sdk-and-hub.md)和 [46 账号选择](46-browser-account-chooser.md)。本次改造 mx-common、Hub 适配层和应用登记配置，不改 mx-pay 交易实现、Launcher 用户中心、MX-H2I 登录或网络路径。

## 已交付的边界

| 模块 | 职责 |
| --- | --- |
| Auth / Launcher User Center | 原账号与密码、注册策略、飞书、浏览器统一会话和账号选择 |
| `@qpjoy/mx-common/identity` | 保持原来的服务端账号操作 SDK 入口 |
| `@qpjoy/mx-common/identity/sso` | `createApplicationSso`：OIDC 授权码、PKCE/state/nonce、签名及 UserInfo 校验、原生账号流程、应用 Cookie、CSRF、退出与会话失效处理 |
| `@qpjoy/mx-common/identity/postgres` | `PostgresSsoStore`：应用库内加密会话、原子消费登录事务、过期清理；不创建数据库、不执行迁移 |
| `@qpjoy/mx-common/identity/profile` | 新应用配置读取与 HTTPS/固定回调/私密文件/会话密钥检查 |
| Hub `server/identity/sso.mjs` / `sso-store.mjs` | 原身份绑定、成员、个人空间、租户邀请及接受、Hub 角色与资源范围 |

普通应用使用 `openid mx:identity`。Hub 保留 `openid mx:hub`，并继续严格核对旧 `legacyIssuer`。新应用不需要 Hub 的成员表、租户表或 legacyIssuer。

## 新应用的最小接入

1. 沿用 `ops identity app` 登记第一方应用，取得独立 clientId/clientSecret/origin/audience。固定回调 `/auth/sso/callback`，原生交互接收 `/auth/sso/interaction`。新增客户端后按原部署流程更新 Auth。
2. 将登记输出作为应用的私有 Secret。现在包含独立、持久的 `sessionKey`；重复登记保留它。旧版普通应用配置缺少此字段时，重新登记仅补充该字段，不改变客户端凭据；已有损坏密钥拒绝覆盖。Hub 原配置和密钥保持原样。
3. 在应用自己的数据库迁移中应用 `@qpjoy/mx-common/identity/schema.sql`，为运行角色授权。也可以提供自己的存储适配器。不要对原 Hub 运行这份模板：Hub 继续使用已有 `iam.browser_sso_records`。
4. 在人的管理入口挂载 SSO handler，业务路由另行执行应用授权。普通登录按钮访问 `/auth/sso/login`，切换账号访问 `/auth/sso/login?select=1`，要求重新验证时使用 `switch=1`。

```js
import { createApplicationSso } from '@qpjoy/mx-common/identity/sso'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'
import { readApplicationSsoProfile } from '@qpjoy/mx-common/identity/profile'

const settings = readApplicationSsoProfile(process.env.APPLICATION_SSO_PROFILE)
const sso = settings && createApplicationSso({
  settings,
  store: new PostgresSsoStore(applicationPool, settings.sessionKey),
  // 此函数由应用提供：按已验证身份查本地角色，禁止按显示名/邮箱自动合并。
  resolvePrincipal: identity => applicationMembers.resolve({
    issuer: identity.issuer,
    subject: identity.subject,
    clientId: identity.clientId,
    displayName: identity.displayName,
  }),
})

// 放在应用自己的请求处理与错误处理范围内。
if (sso && await sso.handle(request, response, new URL(request.url, settings.origin))) return
const principal = sso && await sso.principal(request)
// 之后必须按业务路由检查 principal 的本地角色和资源范围。
```

`applicationPool`、`applicationMembers` 和业务 HTTP 路由由接入应用提供。SDK 不创建用户权限、不把 Auth scope 自动映射成产品管理员。未提供 resolvePrincipal 时仅返回已验证身份（issuer/subject/clientId/displayName/mxIdentity），不能把存在身份当成管理授权。

客户端 Cookie 默认是 `__Host-<appId>_sso` 和 `__Host-<appId>_login`，都是 Secure/HttpOnly/SameSite=Lax。会话最长 30 天且不超过上游令牌有效期。多个副本使用同一个应用会话库与 sessionKey；不同应用使用不同密钥、Cookie 与存储边界。密钥不要在每次启动时生成。

写请求必须携带自身 Origin 及 `/auth/sso/session` 返回的 csrf，请求头默认为 `x-mx-csrf`。代理必须正确传递 HTTPS origin；SDK 默认从 socket 取客户端 IP，不信任任意 X-Forwarded-For。只有已经建立可信代理边界的应用才提供 clientIp 回调。

标准托管登录可直接使用；原生登录仍需应用提供表单和账号页面，以 `surface=application` 发起流程。通用模块已提供 `/form`、`/account`、`/interaction` 后端处理。页面协议参考 Hub `src/account.jsx`；无需复制 Hub 服务端登录实现。UI 挂载路径由 navigation.mounts 明确允许，默认只有 `/`。

## 应用扩展点与存储契约

- `resolvePrincipal(identity)`：每次业务请求根据已验证身份解析本地权限，权限不缓存到浏览器会话。
- `validateIdentity(identity)`：额外身份兼容校验。Hub 用来核对 legacyIssuer；失败停止登录/会话验证。
- `prepareLogin({ request, url, transaction })`：保存服务端业务上下文，并返回授权扩展参数。Hub 在这里核验邀请并提供 mx_invitation；不能从浏览器复制任意授权参数。
- `onAuthenticated({ identity, session, transaction })`：标准回调和身份验证之后执行幂等业务绑定，可返回应用内 returnUrl 和业务 Cookie。Hub 在这里复用旧 member_id、按原策略创建个人空间。外部域名的返回地址被拒绝。此回调不代表用户已接受企业邀请。
- `navigation.formContext(transaction)`：添加应用原生表单的公开展示信息，不放令牌、密码或内部身份凭据。Hub 仅添加 invited。
- `ErrorClass`：可接入应用原有错误处理；默认 SsoError 提供 status/code/message。Hub 继续使用 AppError，既有业务错误不会变成匿名 500。

存储接口为 `put(kind,id,value,ttlSeconds)`、`get(kind,id,consume)`、`update(kind,id,value)`、`remove(kind,id)`。`consume=true` 必须原子读取并删除，禁止多个副本各自通过同一个 callback；update 不能延长原登录期限。内存 Map 只适合测试，不适合多副本或重启后恢复。

## Hub 升级与故障语义

保留 `__Host-mx_hub_sso`、`__Host-mx_hub_login`、`__Host-mx_hub_invitation`、`x-mx-hub-csrf`、既有回调 URL、`/` 与 `/admin/`、数据库表和加密格式。旧会话/正在进行的登录事务继续读取原记录；不执行成员或数据迁移。

通用模块读取会话后会验证 Auth：读请求最多缓存 30 秒，写请求和会话检查实时复核。上游明确失效返回 401；上游网络/服务故障返回 503 并保留本地会话，不自动降级、不自动重启登录循环。应用本地退出只删除本应用会话；统一撤销沿用已有 Auth 账号安全能力。

Hub 自身部署包含新版 mx-common 即可使用此次抽取，不需要更新原 Auth 协议、不需要重登/重建配置。给新应用登记后仍需部署 Auth 使新增客户端生效。mx-common 的 SSO 是库，不新增常驻服务或共享认证数据库；不要为接入 SSO 启动 common 的 ES/Redis/共享 PG。

## 支付中心及后续应用

mx-pay 的交易服务、应用凭据、渠道通知、订单/事件和部署实现保持原样。本次没有创建另一套支付中心，也没有给它默认授予任何人的管理权限。支付管理入口可以消费这个 SDK，再实现本地角色与 app/商户资源范围；付款用户在 Hub 内完成操作时无需再登录支付中心。

人的登录校验不应挂到机器支付 API 或渠道通知链路中。后续接入仍需要应用自己的授权路由、管理页面、配置挂载和部署验收；本次交付不宣称支付中心已完成 SSO 上线。

## 验证方式

- `mx-common/tests/identity-sso.test.mjs`：原 Hub 密文兼容、密钥/记录篡改拒绝、配置与固定回调边界。
- `mx-common/tests/identity-sso-integration.test.mjs`：真实本地 HTTPS Auth + 临时 PostgreSQL，两个非 Hub 应用无租户表完成登录，验证统一会话复用、独立权限、跨客户端令牌拒绝、重启恢复、原子消费、过期、撤销和故障保留。
- Hub 原 `browser-sso` / `browser-sso-routes` / `identity` 及 `native-account-journey` 回归；后者同时覆盖 `/` 和 `/admin/`，真实 Chrome 操作注册、邀请、绑定、密码、账号选择与退出。
- Launcher 应用登记/旧 Hub 与公网登记/部署保持，Hub 构建及类型检查、Launcher 类型检查、MX-H2I check。

真实数据库测试需要 `MX_SSO_TEST_DATABASE_URL` 指向临时本机测试库（库名包含 sso_test），并由支持 TypeScript 的 Node/tsx 运行；浏览器测试需要 `MX_SSO_BROWSER_MODULE` 指向已安装的 Playwright 模块。缺少环境时集成测试会跳过，不能把跳过当作通过。以上验证不代替生产 DNS/TLS、代理及在线用户验收。

本次隔离验收：common/SDK/应用登记与部署兼容共 86 项、Hub 身份与真实 OIDC 回归 29 项、两个普通应用的真实接入 1 项、Hub 双挂载完整 Chrome 旅程 2 项，均通过且没有跳过。Hub 构建、Hub/Launcher 类型检查和 MX-H2I check 通过。还检查了 mx-pay 的 npm ci 安装计划兼容性，没有修改其源代码或锁文件；未执行支付或生产部署。
