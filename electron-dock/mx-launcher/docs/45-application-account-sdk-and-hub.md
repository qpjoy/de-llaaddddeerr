# 应用原生账号接入与 Hub 完整样例

状态：2026-10-04，本地实现与隔离验收；不代表生产已部署。延续 40–44，不迁移原用户、Hub 成员、租户、Key、钱包或网络记录。

## 产品边界

Auth 是自有服务，使用 oidc-provider；原 Launcher 用户中心仍是账号及密码的唯一写入方。应用可以继续使用默认托管登录，也可以提供自己的登录、注册和账号设置页面。Hub 是第一份完整原生接入样例，不是 Auth 的账号模型。

- 通用能力：原账号登录、注册策略与邀请码、飞书登录/绑定、账号资料、修改密码、解绑飞书、查看/退出浏览器会话。
- 应用能力：成员、租户、企业邀请及其角色、产品权限、消费、钱包。Hub 保留这些数据和判断，不将其搬到 Auth。
- 没有已验证邮箱/手机号恢复体系时，「忘记密码」明确引导联系管理员重置；没有伪造邮件、短信发送或自动找回成功。真实飞书仍需部署环境验收。
- App ID 表示可信的注册来源，不自动授予管理、支付、网络或其他应用的业务权限。

## 浏览器过程

1. 应用后端保存 5 分钟登录事务、随机 state/nonce、PKCE verifier 和表单 CSRF，向标准授权端点发送 `mx_surface=application`。不传此参数继续使用原托管登录。
2. 有有效 Auth 会话时直接按原 OIDC 返回。需要交互时 Auth 先建立自己的浏览器交互 Cookie，再将短期 opaque flow 与原 state 送到登记应用的 `/auth/sso/interaction`。
3. 应用用自己的 HttpOnly 事务 Cookie 校验 state，将 flow 保存在服务端，然后跳到自己的干净登录页面。原事务到期时间不延长。
4. 应用表单 POST 到同源后端，后端检查 Origin、CSRF、当前 formId，再用 SDK 调用 Auth。账号密码仅在此请求中经过应用后端，不进入数据库、日志、URL 或 Web Storage。
5. Auth 校验注册应用、仍有效的交互事务、应用匹配、注册策略、邀请证明及账号状态。成功后保存不含密码的一次性结果，返回浏览器完成地址。
6. 浏览器短暂回到 Auth；Auth 核对自身 Cookie 对应的 interaction、活动 flow，并消费一次性结果，再完成标准授权码回调。只有 flow 或完成 URL，不能给另一个浏览器建立登录。
7. 应用继续校验 state/nonce/PKCE/issuer，建立自身会话。Hub 先绑定原成员；企业邀请仍需显示目标租户并明确接受，登录不等于加入。

应用账号设置的访问令牌只在后端保存。Auth 校验 token 的 clientId 与调用 SDK 的客户端一致，用户 ID 从 token 推导，忽略浏览器提交的身份。资料、密码、解绑和退出设备要求当前密码再验证，且有账号/来源限流。

普通 Hub 退出只清除 Hub 会话，下一次可能复用 Auth 登录。「退出所有网页登录」明确撤销浏览器会话。主动修改密码沿用原用户中心的失效策略，撤销该账号原 SDK token 和浏览器会话；没有批量修改历史用户，也不直接写 lease/peer。只因升级或登录不会改密码、撤销网络 token 或改变产品权限。

## 服务端 SDK

`@qpjoy/mx-common/identity` 是零额外依赖的服务端入口，随现有 mx-common 发布。禁止放入浏览器 bundle。

```js
import { createIdentityAccountClient } from '@qpjoy/mx-common/identity'

const account = createIdentityAccountClient({
  issuer: profile.issuer,
  clientId: profile.clientId,
  clientSecret: profile.clientSecret,
  // 内网 CA 环境可注入受控 HTTPS fetch；不要关闭 TLS 校验。
})
const options = await account('options', { flow: serverTransaction.flow })
```

SDK 只请求固定 issuer 的 `/app-account`，使用 HTTPS、服务端客户端认证、POST、15 秒超时，拒绝重定向。SDK 自身不持有应用会话，不负责页面、租户或数据库迁移。

| 操作 | 服务端传入 | 返回 / 限制 |
| --- | --- | --- |
| options | flow | 注册策略、飞书可用性、待绑定状态、邀请资格 |
| login / register | flow、账号密码、表单字段、可信客户端 IP | 一次性浏览器完成地址；新用户 ID 不直接交给浏览器换会话 |
| feishu / feishu-link | flow | 回到 Auth 设置 OAuth state Cookie，再进行外部授权 |
| account / sessions | 当前应用的 accessToken | 当前账号资料 / 自有登录设备 |
| profile | accessToken、当前密码、displayName | 只修改显示名称 |
| password | accessToken、当前密码、新密码 | 原身份保留，旧凭据及会话失效 |
| unlink-feishu | accessToken、当前密码 | 解除关联，保留本地密码 |
| revoke | accessToken、当前密码、设备 ID 或 all | 只撤销当前账号拥有的网页登录 |

`expectedSubject` 是已登录账号从「账号设置」发起绑定时的可选限制，只能由应用后端取自原会话，不能采用浏览器用户 ID。Hub 在操作与最终回调都检查同一账号。

客户端收到 409/410 应提示页面已变化或过期，重新发起登录；密码错误允许在当前有效事务重试。注册/绑定写入已成功但回跳失败时，不删除账号补偿；可用原账号重新登录。SDK 不自动重发写请求，也不因认证失败退回管理员或旧密码权限路径。

## 新应用登记

现有 Hub 和 Launcher 登记方式不变。新增第一方应用可以在部署主机生成独立客户端配置，命令复用部署锁，只保存配置，不自动部署：

```sh
bash scripts/manage.sh ops identity app \
  --app mx-example \
  --origin https://example.example.com \
  --audience mx-example \
  --entry public \
  --output /private/application-secrets/mx-example/profile.json
```

应用配置放在私有目录（700），文件为 600，不输出 clientSecret。重复登记复用密钥，地址或 audience 改变会拒绝覆盖，需要单独迁移。Auth 档案允许增量登记应用，部署检查仍拒绝删除旧客户端、改旧凭据、issuer 或核心密钥。普通应用使用 `openid mx:identity`；Hub 保留原 `openid mx:hub`，避免破坏现有回调和会话。

应用须实现标准 OIDC 回调及上面的交互接收端，参考 Hub `server/identity/sso.mjs` 和 `src/account.jsx`。企业邀请证明目前是 Hub 的业务适配器；其他应用的组织邀请应实现自己的业务适配，不能拿 Hub 邀请当通用租户授权。开放给外部不可信第三方的动态注册、任意回调地址和任意跨域密码 API 不在本批范围。

## 发布、回退与验收

先部署 Launcher API 和全部 Auth 副本，再部署包含新版 mx-common 的 Hub。沿用既有服务、密钥与数据库，本批不新增 migration、环境变量或常驻进程。老 Auth 不识别原生页面参数时仍按原托管登录完成；原 Hub 密码 API、SDK 和原托管 SSO 保留。

Hub 原生表单入口：`/auth/sso/login?surface=application`；原托管入口：`/auth/sso/login`；应急管理员入口：`/?admin=1`。回退 Hub 可继续使用原 Auth；若已登记多个应用，不应回退到仅允许一个 Hub 客户端的旧配置校验版本，更不能恢复旧档案抹掉新客户端。

隔离验收使用临时 PostgreSQL、真实 OIDC、不同主机名的本地 HTTPS issuer/application 和 Chrome。覆盖原成员/租户/角色不变、注册来源、无默认管理或网络权益、邀请码与企业邀请、CSRF/跨应用 token 与 flow 拒绝、过期与被盗回跳、资料/密码、飞书模拟授权绑定解绑、会话复用及撤销。另跑原身份/注册/SDK/网络回归与 MX-H2I check。浏览器检查含桌面、390px、亮暗主题和无页面异常；真实飞书、线上 DNS/TLS、现有在线网络连接属于上线环境验收，不以本地测试代替。

2026-10-04 验收结果：Launcher 63 项、Hub 37 项、应用登记/部署兼容与 SDK 9 项测试通过，无跳过；Launcher/Hub 类型检查与构建、MX-H2I check 通过。Hub 账号路由经过正式 createApp 错误处理，验证错误密码保留业务提示、上游 HTML/网络异常转成可重试的 503、公共 API listener 拒绝账号路径。飞书取消后回到 Hub 并重新绑定通过模拟授权验收。应用增量登记及重新排列后再次登记 Hub 均保持原密钥和其他客户端。
