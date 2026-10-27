# 下游浏览器 SSO、注册与账号自助接口

版本：2026-10-27，文档 v1。本文按当前仓库源码整理，不代表目标服务器已部署相同版本。本次只增加文档，不新增接口、不运行 migration、不修改既有用户或 MX-H2I 行为。

接入总入口见 [57 · 下游用户接入](57-downstream-user-integration.md)，Oversea 见 [58 · 用户订阅接口](58-oversea-user-subscription-api.md)。本文面向浏览器应用；已使用 SDK 密码登录的 Luopan/Electron 可以继续原路径，无须为使用这份文档切换认证协议。

## 1. 选用哪套接口

| 场景 | 接口与凭据 | 不要混用 |
| --- | --- | --- |
| 后端管理创建账号、目录与运维 | Launcher Internal 用户接口；见 57 | OIDC clientSecret 不能代替 Internal Ops Token |
| Electron/既有业务后端密码登录 | `/internal/v1/sdk/oauth/token`，得到 Launcher SDK token | 不能把 OIDC access token 当成 `mx-sdk` token |
| 网页统一登录 | 已登记应用的 OIDC Authorization Code + PKCE | 当前 Auth 不开放动态客户端注册或 OIDC password grant |
| 应用自有登录/注册/账号页面 | 应用 BFF → Auth `/identity/app-account` | 浏览器不能直接携带 clientSecret 调用 Auth |
| 用户生成 Oversea 订阅 | 58 中的 Launcher Bearer 接口 | 本文的 Cookie/OIDC token 不自动兑换成 SDK Bearer |

`BFF` 指应用自己的后端。账号密码、浏览器统一会话归 Auth/Launcher；本地业务用户、租户、角色、余额和数据归应用。登录成功不代表已获得业务权限。

应用必须由平台预先登记 `appId/clientId/clientSecret/origin/audience/issuer`；回调固定为 `${origin}/auth/sso/callback`，原生交互接收地址固定为 `${origin}/auth/sso/interaction`。不要自填生产 issuer，也不要将某个应用的凭据复制给另一个应用。部署登记步骤见 [48 · Identity 应用管理](48-identity-application-management.md)。

## 2. 推荐使用现有服务端 SSO 模块

仓库提供 `@qpjoy/mx-common/identity/sso`，用于复用授权码、PKCE、state/nonce、UserInfo 校验、Cookie、CSRF 和账号表单处理。当前 mx-common package 标记为 `private: true`；由平台提供仓库/构建依赖，不假定它已在公共 npm 发布。

```js
import { createApplicationSso } from '@qpjoy/mx-common/identity/sso'
import { PostgresSsoStore } from '@qpjoy/mx-common/identity/postgres'
import { readApplicationSsoProfile } from '@qpjoy/mx-common/identity/profile'

const settings = readApplicationSsoProfile(process.env.APPLICATION_SSO_PROFILE)
if (!settings) throw new Error('应用 SSO profile 未配置')
const sso = createApplicationSso({
  settings,
  store: new PostgresSsoStore(applicationPool, settings.sessionKey),
  resolvePrincipal: identity => applicationMembers.resolve({
    issuer: identity.issuer,
    subject: identity.subject,
    clientId: identity.clientId,
    displayName: identity.displayName,
  }),
})

// 放入应用现有 HTTP handler 和异常处理器；以下两个对象由应用提供。
if (sso && await sso.handle(request, response, new URL(request.url, settings.origin))) return
const principal = sso && await sso.principal(request)
// 继续执行本应用的角色、租户、资源权限检查。
```

上例中的 `applicationPool/applicationMembers/request/response` 是应用适配代码，不是 SDK 自动创建的对象。完整存储与扩展钩子契约见 [47 · 通用 SSO 接入](47-shared-sso-and-hub-adapter.md)。

- Node 运行版本按当前 mx-common 的 `engines` 为 `>=22`。
- 普通应用 scope 为 `openid mx:identity`；Hub 保持 `openid mx:hub`。
- `sessionKey` 为持久的 32 字节密钥，不要随启动重新生成。多副本共用该应用的会话库和密钥。
- 如选用 `PostgresSsoStore`，由下游在**自己的新应用库**初始化该模块所需 schema；模块不自动运行 migration。复用现有 Hub 时不要另套新应用模板。本文交付不执行任何数据库操作。
- 必须保留 `issuer + subject` 身份边界。当前 OIDC `sub` 是 MX 用户 ID；`mx_identity.subject` 是 `user:<MX用户ID>`，不要把带前缀的字符串直接写入要求纯 MX userId 的字段。
- 依业务策略在 `onAuthenticated` 中执行幂等的本地关联；已有绑定不一致应停止并核对，不能按显示名/邮箱自动合并。详见 57 的 409 处理。

## 3. 应用 BFF 对浏览器的路由

以下路径是在**下游应用自己的 origin** 挂载上述模块后提供的，不是 Launcher Internal API。默认响应 `Cache-Control: no-store`、`Referrer-Policy: no-referrer`。写请求要求同源 `Origin`，默认 CSRF 请求头为 `x-mx-csrf`；定制 `csrfHeader` 后以应用约定为准。

| 方法与路径 | 作用 | 输入及响应 |
| --- | --- | --- |
| `GET /auth/sso/login` | 开始标准托管登录 | 303 到授权端点；`surface=application` 使用应用原生表单；`select=1` 选择账号；`switch=1` 要求重新验证 |
| `POST /auth/sso/start` | 原生表单应用的登录启动 | 仅 `navigation.applicationForm=true` 时存在；要求同源 Origin；返回 `{redirect}` |
| `GET /auth/sso/interaction` | Auth 回到应用的中间步骤 | `flow/state` 由 Auth 产生；BFF 验证事务 Cookie 和 state、保存 flow，303 到应用干净页面 |
| `GET /auth/sso/form` | 读取当前登录表单 | 事务 Cookie 必须有效；返回 options 加 `csrf/formId/view` |
| `POST /auth/sso/form` | 登录、注册或飞书交互 | JSON `action/formId` 及下表字段；请求头使用 **form 响应中的 csrf**；成功 `{redirect}` |
| `GET /auth/sso/callback` | OIDC 授权码回调 | SDK 验证 code/state/nonce/PKCE/issuer/UserInfo，建立应用 Cookie 后303；不是前端自行拼接的跳转 |
| `GET /auth/sso/session` | 当前应用会话与 CSRF | `{active,csrf,securityUrl}`；未登录时 `active:false,csrf:null` |
| `GET /auth/sso/account` | 当前账号及浏览器设备 | `{account,displayName,feishuLinked,sessions}`；需有效会话 |
| `POST /auth/sso/account` | 账号自助变更 | JSON `action/currentPassword` 及动作字段；使用 **session 响应中的 csrf** |
| `POST /auth/sso/logout` | 退出当前应用 | 同源 Origin；有会话时验证 session csrf；成功204无 body；不等于退出所有应用 |

`login/start` 的可选 `ui` 必须在应用配置的 `navigation.mounts` 白名单内，默认只有 `/`；`return=account` 用于返回账号设置。应用的业务邀请上下文由后端钩子校验，不把任意浏览器参数直接送到 Auth。

### 3.1 登录与注册表单

`GET /auth/sso/form` 的示意响应：

```json
{
  "policy": { "mode": "invite_code", "version": 3 },
  "admissionRequired": false,
  "feishu": true,
  "pending": false,
  "enterprise": false,
  "invitationError": "",
  "loginHint": "",
  "csrf": "<opaque-form-csrf>",
  "formId": "<flow-fingerprint>",
  "view": "login"
}
```

| action | POST JSON 业务字段 | 说明 |
| --- | --- | --- |
| `login` | `login`, `password` | `login` 是账号输入；不是 `username/account` 字段名 |
| `register` | `login`, `password`, `passwordConfirm`, `policyVersion`, `inviteCode`（按策略） | `policyVersion` 取最新 options 的 `policy.version` |
| `feishu` | 无额外账号字段 | 仅在 options 表明飞书可用时展示 |
| `feishu-link` | 无额外账号字段 | 由 Auth 完成飞书证明与绑定交互；不能自行传飞书 subject |

上述动作都要带当前 `formId`。示例仅表示表单结构，不是已取得有效会话的完整脚本：

```js
const form = await fetch('/auth/sso/form', { credentials: 'same-origin' }).then(r => r.json())
const response = await fetch('/auth/sso/form', {
  method: 'POST',
  credentials: 'same-origin',
  headers: { 'Content-Type': 'application/json', 'x-mx-csrf': form.csrf },
  body: JSON.stringify({
    action: 'login', formId: form.formId,
    login: accountFromInput, password: passwordFromInput,
  }),
})
const result = await response.json()
if (!response.ok) throw new Error(result.message || '登录未完成')
window.location.assign(result.redirect)
```

应先从应用登录入口完成 Auth→interaction 跳转，再读取 form；直接调用 form 不会自动创建登录事务。密码只在表单提交时传送，不存入 Web Storage、业务数据库、URL 或日志。Auth 的完成地址必须由同一浏览器访问，拿到 `{redirect}` 不等于已经建立本地会话。

浏览器自助注册当前校验：账号 3–64 字符，以字母开头，之后只允许字母、数字、点、下划线、短横线；密码去首尾空白后长度至少8，原字符串长度最多128；两次输入一致。此规则属于自助注册，不应误套为 57 中管理 upsert 的实际校验规则。

`policy.mode` 为 `closed/invite_code/open`。`policy` 可能因上游不可用而为 null，此时不能推断开放注册。已有账号登录与新注册是不同分支。Hub 企业邀请与平台注册邀请码不是同一对象；DataPort (`mx-harbor`) 有专门的密码登录/邀请准入边界，不作为普通应用通用授权范例。

当前从 `mx-insight-hub` 或 `mx-harbor` 自助注册的新账号，服务端默认设置 `deniedAppIds:["mx-h2i","luopan"]`；邀请码的 allowedAppIds 不能覆盖明确禁止。这是按可信注册来源应用的现有规则，不影响旧账号。普通身份注册本身不创建网络 entitlement、下游业务租户成员或付费权益；业务应用仍需完成自己的开通与授权。

### 3.2 账号资料、密码、飞书与设备

`GET /auth/sso/account` 的 `sessions` 每项包含：

| 字段 | 类型与含义 |
| --- | --- |
| `id` | 64位十六进制 opaque 设备标识，供 revoke 使用 |
| `current` | 是否当前 Auth 浏览器会话 |
| `agent` | 浏览器描述；历史记录可能为“历史浏览器会话” |
| `authTime` | 登录时间，Unix 秒 |
| `expiresAt` | ISO 到期时间 |
| `apps` | 该浏览器会话关联的客户端 ID 数组，不一定是产品显示名 |

当前最多列出100条未过期且有效的浏览器会话。它不是 WireGuard 设备/租约列表。

`POST /auth/sso/account`：

| action | 业务字段 | 成功响应及副作用 |
| --- | --- | --- |
| `profile` | `currentPassword`, `displayName` | `{ok:true}`；只改显示名，trim 后1–80字符，不改登录账号/MX userId |
| `password` | `currentPassword`, `password` | `{ok:true,signedOut:true}`；新密码8–128位，撤销该用户原 SDK token、使旧网页登录失效，并清除当前应用会话 |
| `unlink-feishu` | `currentPassword` | `{ok:true}`；移除飞书关联，保留本地密码，不重建用户 |
| `revoke` | `currentPassword`, `target` | `{ok:true,signedOut}`；target 是 sessions.id 或 `all`，只处理该用户自己的网页登录 |

这里的新密码字段是 `password`；57 中 SDK 自助改密字段是 `newPassword`，两套接口不要混用。账号动作的用户身份从已验证 token 推导，浏览器不要提交可替换的 userId。当前没有通用邮箱/短信自动找回密码接口；无法验证当前密码时交管理员走57的重置流程。

`revoke all` 与普通应用 logout 不同：前者撤销统一网页登录，后者只清理当前应用 Cookie/会话。revoke 不直接撤销 Launcher SDK token、Oversea 链接或移除网络 peer；主动改密则沿用上述更广的认证失效语义。改密撤销所有该用户的 iam-token，**包括公开 Oversea 订阅链接**，既有第三方订阅 URL 随之失效，需重新认证后按 58 重新签发。应用应根据 `signedOut` 展示登录入口，不把 503 当成账号退出。

## 4. Auth 服务端账号 API（适用于不用现有 BFF 模块的下游）

### 4.1 地址、认证与信封

`POST ${issuer}/app-account`。已登记 issuer 包含 `/identity`，例如 `https://auth.example.com/identity`，因此实际路径为 `/identity/app-account`。

```http
POST /identity/app-account
Authorization: Basic <base64(clientId:clientSecret)>
Content-Type: application/json

{"action":"account","input":{"accessToken":"<该OIDC客户端签发的用户令牌>"}}
```

仅应用后端调用，不带浏览器 `Origin` 请求头；服务端会拒绝有 Origin 的直接请求。最大请求 body 为16384字节。必须用已登记应用凭据，不接受 Internal Ops 或 Launcher service-account clientSecret 代替。

现有服务端客户端：

```js
import { createIdentityAccountClient } from '@qpjoy/mx-common/identity'

const accountApi = createIdentityAccountClient({
  issuer: profile.issuer,
  clientId: profile.clientId,
  clientSecret: profile.clientSecret,
})
const capabilities = await accountApi('capabilities')
// capabilities: {nativeForm:true, appId, origin, audience}
```

客户端强制 HTTPS、拒绝重定向、单次超时15秒，不自动重发写请求；失败抛出带 `status/code` 的 Error，网络异常另行处理。内部 CA 使用受控 fetch/CA 配置，不关闭 TLS 校验。

### 4.2 action 完整输入表

| action | input | 返回 |
| --- | --- | --- |
| `capabilities` | `{}` | `{nativeForm:true,appId,origin,audience}`；需客户端认证，无用户数据 |
| `options` | `flow` | 第3节 options 字段，不含 BFF 添加的 csrf/formId/view |
| `login` | `flow,login,password`；可带可信 `clientIp,expectedSubject,inviteCode` | `{redirect}` |
| `register` | `flow,login,password,passwordConfirm,policyVersion,inviteCode`；可带可信 clientIp | `{redirect}` |
| `feishu` / `feishu-link` | `flow` | `{redirect}`，先回 Auth 建立其自己的飞书事务 Cookie |
| `account` | `accessToken` | `{account,displayName,feishuLinked}` |
| `sessions` | `accessToken` | `{sessions:[...]}` |
| `profile` | `accessToken,currentPassword,displayName`；可带可信 clientIp | `{ok:true}` |
| `password` | `accessToken,currentPassword,password`；可带可信 clientIp | `{ok:true}`；BFF 清本地会话后才额外加 signedOut |
| `unlink-feishu` | `accessToken,currentPassword`；可带可信 clientIp | `{ok:true}` |
| `revoke` | `accessToken,currentPassword,target`；可带可信 clientIp | `{ok:true,signedOut}` |

`flow` 是已存在 OIDC interaction 派生的43字符 opaque handle，与 clientId、Auth interaction、同浏览器事务关联。它不是前端随机生成的业务 requestId。`accessToken` 必须是该 OIDC client 的用户令牌；Auth 重新检查用户活动状态与应用准入。

`expectedSubject` 只能取自应用后端原有已验证会话，用于“同一账号完成绑定”，不能取浏览器提交的 userId。clientIp 由可信入口推导，不能无条件照抄任意 X-Forwarded-For。

### 4.3 错误与重试

Auth `/app-account` 失败 body 是 `{"code":"account_request_failed","message":"..."}`，用 **HTTP status + 当前 action/阶段** 判断，不能依赖解析中文文案中的关键词。

| HTTP | 典型情况 | 下游行为 |
| --- | --- | --- |
| 400 | 无效 flow/动作/字段/设备 ID，注册字段不合规 | 修正输入；失效 flow 重新从登录入口开始 |
| 401 | 客户端凭据错误、用户 token 不属于该客户端、当前密码错误 | 分清机器配置和用户交互；不要自动切换其他凭据 |
| 403 | 带 Origin 直接调用、用户停用/无应用准入、注册关闭 | 按权限/策略处理，不循环重试 |
| 409 | 已提交/已消费、绑定账号变化、注册策略变化或账号冲突 | 刷新最新状态或重新登录；不删除已创建账号作补偿 |
| 410 | flow/interaction 过期或客户端不匹配 | 丢弃旧表单，重新发起 OIDC |
| 413 | 请求超出16KiB | 缩小请求 |
| 429 | 登录/注册/再验证限流 | 退避并提示用户稍后操作 |
| 503 | Auth/账号后端不可用，或未知内部异常 | 保留原应用会话，允许用户重试；不当作凭据失效 |

BFF 层还有独立代码，如 `account_form_changed`、`account_flow_expired`、`sso_csrf`、`sso_unavailable`、`sso_identity_invalid`。这些通过模块抛出的 `SsoError(status,code,message)` 交应用自己的错误中间件序列化；模块不替应用建立统一 JSON 异常响应。

默认应用登录事务5分钟；应用 Cookie 会话最长30天且不超过 token 有效期。业务只读请求的身份验证最多缓存30秒；写请求、session和账号设置会实时复核。明确失效与临时上游故障要分开处理。当前 OIDC provider 不启用标准 introspection/revocation endpoint，也不提供 refresh_token grant；设备撤销使用上述账号动作，重新登录使用授权码流程。

## 5. 注册策略与邀请码管理（平台/受信任后端）

这些是 Launcher Internal 管理接口，使用57所述 `x-mx-ops-token` 或现有个人管理 SSO 上下文；**不是普通用户或 OIDC client 的权限**。依赖已启用托管身份服务与 PostgreSQL，不满足时503；下游不能为了接入擅自开启全局注册。

| 方法与路径 | 请求 | 响应 |
| --- | --- | --- |
| `GET /internal/v1/user-center/registration` | 无body | `{policy,invitations,apps,scope:"mx-account"}` |
| `POST /internal/v1/user-center/registration/policy` | 下表策略对象 | `{policy}`；version增加1 |
| `POST /internal/v1/user-center/registration/invitations` | 下表邀请对象 | `{invitation,code}`；明文code只在创建时返回 |
| `POST /internal/v1/user-center/registration/invitations/revoke` | `{id:"<invitation UUID>"}` | `{ok:true}` |

策略字段：

| 字段 | 要求 |
| --- | --- |
| `mode` | 必填 `closed/invite_code/open`；关闭全局注册优先 |
| `version` | 必填当前整型修订号；与服务端不同返回409 `policy_changed` |
| `hubMode` | 可选 `inherit/closed/invite_code/open`，只影响 Hub 注册策略 |
| `applicationModes` | 当前只接受 `mx-harbor` 的 `closed/invite_code`，不是任意应用策略配置能力 |

邀请字段：

| 字段 | 要求 |
| --- | --- |
| `label` | 必填，trim后1–80字符 |
| `maxUses` | 必填整数1–1000 |
| `days` | 必填整数1–90 |
| `appGrant` | 可选 `{mode,appIds}`；省略等于 `{"mode":"policy","appIds":[]}` |
| `admissionAppId` | 可选且仅支持 `mx-harbor`，代表 DataPort 专用邀请 |

appGrant 三种模式：`policy` 不额外授予应用；`selected` 显式列出已登记启用的应用；`all_current` 在创建邀请时快照当前启用应用（排除 mx-harbor），不是授权未来新应用的通配符。非 selected 模式传入 appIds 必须为空。普通邀请不能夹带 mx-harbor，须使用专用 admission 邀请。

示例请求（通过受信任管理后端提交，不在浏览器持有 Ops 凭据）：

```json
{
  "label": "Partner onboarding batch 01",
  "maxUses": 10,
  "days": 7,
  "appGrant": { "mode": "selected", "appIds": ["partner-portal"] }
}
```

`partner-portal` 须事先登记并启用，否则400。列表最多返回最近100条邀请，包含使用次数/起止时间/撤销状态/应用快照，不含code及codeHash；创建请求没有通用幂等键，超时后不要无限自动重发生成多张邀请。

注册管理错误为 HTTP 错误加 `{code,message}`，如 `invalid_policy/invalid_invitation/invalid_app_grant/policy_changed`；鉴权拒绝与基础设施故障仍按真实HTTP状态处理。成功 POST 当前未显式覆盖 Nest 默认201，下游接受2xx，不仅检查200。

Auth 调用的 `/identity-backend/registration` 是签名 backchannel，由已登记 Auth 执行。它不是给业务应用使用的注册捷径，不向下游分发其签名密钥。普通业务注册通过第3/4节，管理代建走57。

## 6. 下游验收清单

1. 预先确认目标 Auth 已登记该应用，issuer/origin/audience 与交付 profile 一致；测试托管与原生两种入口的选择符合产品需求。
2. 使用同一测试账号核对 MX userId、本地业务绑定、OIDC sub 与 `mx_identity`；重登/改显示名不会新建本地业务用户。
3. 正确处理过期flow、多标签页更换formId、错误密码、关闭注册、邀请码用尽和客户端凭据错误。
4. 业务写入校验Origin与CSRF，不把SDK scopes自动当本地管理员。
5. 登录后可读取资料、单设备/全部网页登录撤销，正确区分本地logout与统一revoke。
6. 改密只在明确用户动作触发，并验收SDK token与网页登录失效的预期；接入/发版本身不主动改密或批量撤销会话。
7. Auth临时不可用返回可恢复错误，不清空既有身份、不循环重定向、不降级到其他账号。
8. 如还要Oversea，用58的独立SDK认证与ready流程验收；SSO成功不被当成网络已经准备好。

## 7. 源码依据

- [Auth 账号接口](../server/src/identity/app-account.ts)：actions、客户端认证、flow归属、状态码。
- [OIDC Provider](../server/src/identity/provider.ts)：静态应用、PKCE、token/会话时效、`mx_identity`。
- [浏览器会话仓储](../server/src/identity/repository.ts)：设备字段、范围与撤销。
- [注册控制器](../server/src/registration/controller.ts)与[注册仓储](../server/src/registration/repository.ts)：注册字段、策略、邀请码、账号写入。
- [账号操作客户端](../../mx-common/src/identity/client.mjs)、[SSO模块](../../mx-common/src/identity/sso.mjs)、[profile校验](../../mx-common/src/identity/profile.mjs)：BFF路由、Cookie、CSRF、上游故障语义。

此文档只声明以上源码当前具备的协议。目标环境可用性、凭据发放、真实飞书以及业务本地绑定仍需由接入双方验收，本文不声明这些部署动作已经执行。
