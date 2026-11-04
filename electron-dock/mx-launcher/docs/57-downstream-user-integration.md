# 下游用户、身份与 SDK 接入手册

版本日期：2026-10-27。本文按本地 `82044687` 基线的实际 Controller、Store 和 Identity 实现整理，仅说明当前源码契约，不保证某个线上地址已部署该版本。本文不执行迁移、账号操作、接口请求或部署。示例中的域名、账号、ID、口令和令牌全部为虚构值或占位符。

## 1. 接入路径与职责

MX Launcher User Center 是统一用户、密码和 SDK token 的权威来源；配套 Auth 提供浏览器 OIDC/SSO。下游仍保留自己的本地账号、成员、组织、有效期、业务角色和数据权限。统一认证成功，不等于下游已建账号、已完成绑定或已获业务授权。

按需求选择入口：

| 需求 | 接口/文档 | 执行方 |
| --- | --- | --- |
| 受控创建、导入、更新统一用户 | 本文的 User Center/SDK 用户接口 | Internal 运维或受控平台后端 |
| 现有客户端账号密码登录 | SDK `oauth/token` 的 password grant | 下游登录后端/已受控客户端 |
| 后端机器身份、授权改密 | 独立服务账号 + client_credentials | 下游服务端 |
| 浏览器统一登录、注册和账号自助 | [59-browser-account-api.md](59-browser-account-api.md) | 应用 BFF + Auth |
| 用户出海权益、订阅与运行态 | [58-oversea-user-subscription-api.md](58-oversea-user-subscription-api.md) | 独立按该文鉴权 |

不要为了接入下游用户而修改已有 MX-H2I 用户的 ID、密码、状态或网络配置。一般业务账号同步不应附带 `provisionOversea:true`；需要网络权益时另行按 58 的边界开通。

### 1.1 创建用户到获取订阅的最小调用顺序

1. 平台提供目标环境的 API 根地址、已登记 appId、受控的账号开通入口；需要网络时确认用户角色具有 `oversea.subscription.ensure`。创建用户当前要求 Ops，不能把普通服务账号 Bearer 当成替代凭据。
2. 受控后端按第 5 节创建用户，显式 `provisionOversea:false`，保存响应 `user.userId`，按第 6 节关联下游本地账号。重复请求先核对记录，不能新造 ID 再开一次。
3. 用户按第 7 节登录。若需要自己的 Oversea 订阅，请求 `scope:"auth.read oversea.subscription.ensure"`；核对实际 token 权限，写请求中的 scope 不会给用户新增权限。
4. 下游验证真实用户 token、固定 appId 的准入和本地业务权限后建立自己的登录态。
5. 按 58 第 4/8 节单独调用 `ensure-subscription`，普通刷新省略 siteIds，只在 `ensure.ready=true` 时应用 YAML。订阅暂未就绪不应被包装成身份绑定冲突或清除已有登录。
6. 仅在第三方客户端需要 URL 时签发 `subscription-link` 并保存本次返回值；后续 GET 只读元数据，POST 会轮换旧链接。

第 3 步适用于既有 SDK 密码登录链路。浏览器应用按 59 接 SSO；OIDC 登录不自动产生可调用 Oversea API 的 Launcher SDK token。

## 2. 身份标识必须分开保存

| 字段 | 含义与使用方法 |
| --- | --- |
| 下游 `localUserId` | 下游自己的主键；不是 Launcher 的 `userId` |
| `user.userId` / `principal.userId` | Launcher 用户主键，例如 `usr_partner_alice`；从已验证响应保存，不自行推导 |
| SDK `principal.principalId` / `subject` | 当前用户格式为 `user:usr_partner_alice`，包含主体类型前缀；不直接写入期待裸 `userId` 的字段 |
| SDK `issuer` | 当前格式 `mx-user-center:<environment>`；与部署环境一起固定校验 |
| OIDC `issuer` + `subject` | 浏览器 SSO 身份键；按 OIDC SDK 验证后的值建立绑定，不与 SDK subject 字符串直接混用 |
| `account`、`email`、`displayName` | 登录/展示属性；会变化，也可能碰到别名冲突，不应作为永久跨系统身份主键 |
| `profile.externalIds` | 外部系统参考 ID；不是认证证据，也不会自动创建下游账号绑定 |
| `appId` | 应用访问策略上下文，例如 `luopan`；应由下游后端固定，而非接受浏览器任意指定 |
| `homeAppId`、`registeredByAppId` | 应用归属/兼容来源字段；不是可信的首次注册凭据，也不是业务管理员权限 |
| `registration` | Auth 注册流程记录的首次注册来源；旧账号可缺省，普通用户 upsert 不接受覆盖 |
| `roleIds` / `scopes` | Launcher 平台权限；下游业务角色仍由自己的授权规则决定 |

SDK 用户身份由 `createUserPrincipalFromRecord` 直接从已有用户记录构造。登录本身不创建用户，不更换主键。浏览器 SSO 通过同一权威账号体系验证，但协议、令牌和会话不能与 SDK password grant 混用。

## 3. 地址、鉴权与通用约定

`BASE` 指运维为当前环境提供的可访问 Launcher API 根地址，例如虚构的 `https://launcher-api.example.invalid`。不要根据浏览器 Admin 域名猜 API 根地址；公网代理、Domestic 转发和 Internal API 的开放路径不同。SSO 的 issuer 另行配置。

请求使用 JSON 和 `Content-Type: application/json`，路径参数按 URL segment 编码。返回采用 `{user:...}`、`{token:...}` 等包裹对象，没有统一的 `code:200` 外壳。客户端应同时处理 HTTP 状态和响应体，接受成功的 2xx，不假设所有 POST 固定返回 200。Internal 响应由入口设置 `Cache-Control: no-store`。

`requestId` 在这些用户、登录、改密、导入接口中用于追踪/审计，**不是幂等键**。同一 requestId 再调用会再次执行；可能再次改密、撤销 token、记录审计或更新 `updatedAt`。超时后先查状态，不盲目重复写请求。不要把密码、token、clientSecret 放入 requestId、URL 或日志。

### 3.1 当前实际鉴权矩阵

| 方法与路径（省略 `/internal/v1`） | 当前实际鉴权 | 说明 |
| --- | --- | --- |
| `GET /sdk/gateway/manifest` | Controller 无额外凭据检查 | 发现契约，不代表接口已获授权 |
| `POST /sdk/oauth/token` password | 请求中的账号密码 | 无需 Ops token；用户和口令仍受状态及限流校验 |
| 同路径 client_credentials | 请求中的 client_id/client_secret | 仅 Internal 控制面；拒绝受控 Domestic edge 转发 |
| `POST /sdk/identity/introspect` | JSON body 中的被检查 token | Controller 不要求独立的管理 Bearer，也不额外检查调用者 scope |
| `POST /sdk/identity/context` | JSON body 的身份上下文 | 不是可以信任任意 userId 的登录接口 |
| `POST /sdk/gateway/access/evaluate` | JSON body 的 token + 目标 routeId/appId | 返回决策，不执行目标 API，也不授予 Ops 权限 |
| `GET /sdk/roles`、`GET /sdk/users`、`POST /sdk/users` | `x-mx-ops-token` | **当前实现不是 Bearer + sdk.user.* 即可调用** |
| `GET/POST /sdk/service-accounts`、凭据 rotate | `x-mx-ops-token` | 仅管理面，不能把凭据管理委托给产品 Bearer |
| `POST /sdk/users/me/password` | active `mx-sdk` 用户 Bearer + 旧密码 | 从 Bearer 取目标用户，拒绝服务账号和 shadow token |
| `POST /sdk/users/:userId/password` | active `mx-sdk` Bearer，`sdk.user.write` **或** `rbac.manage` | 可为用户或服务账号主体；是跨目标用户的写权限 |
| User Center 的 users/roles、upsert、import、password、delete、service-accounts | `x-mx-ops-token` | Internal 运维面 |
| `POST /user-center/tokens/issue` | `x-mx-ops-token` | 管理员直接签发能力；不是下游正常登录方式 |
| `POST /user-center/token/introspect` | JSON body 中的被检查 token | 返回 `{introspection}` |

`assertInternalOpsToken` 还接受服务端建立的 Internal Admin SSO 上下文。那是 Admin BFF 完成会话、角色和 CSRF 校验后的内部机制，不是给下游传一个自造 header 的替代方式。普通应用不能获得或分发全局 Ops token；如果下游需要自行开通账号，应由受控平台后端执行管理操作，而不是把 Ops token 下发给浏览器或桌面应用。

### 3.2 scope 的 OR 语义与权限边界

`access/evaluate` 对一个已知 route 的 accepted scopes 使用 OR：具备任意一个即可通过该 route 的 scope 判断。例如：

| routeId | accepted scopes（任一） |
| --- | --- |
| `sdk.identity.introspect`、`sdk.identity.context` | `sdk.identity.read`、`auth.read` |
| `sdk.gateway.access.evaluate` | `sdk.identity.read` |
| `sdk.roles.list`、`sdk.users.list` | `sdk.user.read`、`rbac.manage` |
| `sdk.users.create`、`sdk.users.password.update` | `sdk.user.write`、`rbac.manage` |
| `sdk.users.password.self` | manifest 决策列 `auth.read`；实际接口另校验用户 Bearer 和旧密码 |

这个表描述决策函数，不会替代上面的 Controller 鉴权。特别是 `sdk.users.create` 的 `decision.allowed=true`，仍不能让服务账号 Bearer 绕过 `POST /sdk/users` 的 Ops 校验。不要将 scope 清单当作自动执行的 API 网关策略。

应用代码必须固定合法 routeId。未知 routeId 在当前通用决策函数中可能得到空 scope 集，不能用拼写错误或任意字符串的 `allowed` 结果作为保护。

## 4. 服务账号与机器登录

### 4.1 开通与查询

管理端调用 `POST /internal/v1/sdk/service-accounts`；User Center 同名管理接口也可用。请求字段：

| 字段 | 类型/行为 |
| --- | --- |
| `serviceAccountId` | 必填；1–160 字符，匹配 `[A-Za-z0-9][A-Za-z0-9_.:-]*` |
| `displayName` | 可选，默认 serviceAccountId |
| `roleIds` | 字符串数组，缺省或空时为 `['mx-service-account']` |
| `scopes` | 额外 scope 字符串数组，默认空 |
| `allowedProductIds` | 产品资源边界数组，默认空；不是用户应用白名单 |
| `requestId` | 审计关联值 |

有效主体 scope 是**角色 scopes 与直接 scopes 的并集**。传较短的 `scopes` 并不会收窄角色权限；内置 `mx-service-account` 本身包含用户读写等 SDK 权限。开通前核对 `GET /sdk/roles` 的当前角色内容，不把默认角色误称为只读账号。

```json
{
  "serviceAccountId": "svc_example_directory",
  "displayName": "示例目录服务",
  "roleIds": ["mx-service-account"],
  "scopes": ["sdk.identity.read"],
  "allowedProductIds": [],
  "requestId": "example-service-create-001"
}
```

返回 `{serviceAccount,credential}`。仅在此前没有 credential 时签发一次明文：

```json
{
  "serviceAccount": {
    "serviceAccountId": "svc_example_directory",
    "tenantId": "tenant_default",
    "displayName": "示例目录服务",
    "roleIds": ["mx-service-account"],
    "scopes": ["sdk.identity.read"],
    "allowedProductIds": [],
    "status": "active",
    "createdAt": "2026-10-27T00:00:00.000Z"
  },
  "credential": {
    "clientId": "svc_example_directory",
    "clientSecret": "<仅本次响应返回的独立密钥>",
    "credential": {
      "credentialId": "<服务端生成>",
      "serviceAccountId": "svc_example_directory",
      "version": 1,
      "source": "issued",
      "issuedAt": "2026-10-27T00:00:00.000Z",
      "updatedAt": "2026-10-27T00:00:00.000Z"
    }
  }
}
```

已有凭据时 `credential:null`，不会再次读取旧密钥。再次 POST 是服务账号记录 upsert，不是无副作用的幂等重放：角色、直接 scopes、产品列表等按本次输入重建，当前构造函数还会设置 status=active 和新的 createdAt，不能用不完整请求“查询”账号。`GET /sdk/service-accounts` 返回 `{serviceAccounts,credentials}`，credentials 只含版本/时间等安全元数据。

### 4.2 获取机器 token 与轮换

```http
POST /internal/v1/sdk/oauth/token
Content-Type: application/json

{
  "grant_type": "client_credentials",
  "client_id": "svc_example_directory",
  "client_secret": "<独立服务账号密钥>",
  "audience": "mx-sdk",
  "scope": "sdk.identity.read sdk.user.write",
  "expires_in": 3600,
  "requestId": "example-machine-login-001"
}
```

默认且最大 3600 秒，显式时长最小按 60 秒处理。`clientId`/`clientSecret` 是兼容别名；优先使用上面的 snake_case 字段。`scopes` 数组优先于 `scope` 空格分隔字符串。请求非空 scopes 时，签发记录中的 scope 为请求与主体当前权限的交集；省略/空集会使用主体的全部当前 scopes。

当前还有一个需要明确的边界：若非空请求与主体权限的交集为空，记录为 `scopes:[]`，但 introspection 对空记录 scopes 会回退到主体当前全部 scopes。因此 **空 scope 不能当作零权限 token，requested scope 也不是独立的强制最小权限边界**。应先限制服务账号本身的角色/直接权限，再显式请求 scope，并按实际 introspection 的 scopes 与业务规则校验；不要向低信任组件发放一个“看起来 scope 为空”的高权限账号 token。

token 响应结构与第 7 节相同，但 `subject=service-account:<id>`、`principal.kind=service-account`、`principal.userId=null`。机器 token 不可用于人类账号绑定。

轮换：`POST /internal/v1/sdk/service-accounts/:serviceAccountId/credentials/rotate`，Ops 鉴权，可传 `{requestId}`，返回 `{credential}`。轮换只影响该服务账号，返回新密钥一次，并撤销该账号已有 token。若首次返回丢失，不能查询旧明文，应由运维重新轮换后更新该应用的私有配置。

当前兼容代码仅在数据库凭据不存在时尝试旧配置 secret；内置 `svc_sdk_gateway` 还有迁移期 Ops token 兼容。新接入不使用这些后门式兼容路径，不共享内置账号或全局 Ops token。

## 5. 创建/更新用户：两条路由不是同一参数集合

`POST /internal/v1/user-center/users` 提供完整运维参数；`POST /internal/v1/sdk/users` 当前同样要求 Ops 鉴权，但只转换参数子集。两者都调用 `createUserCenterUser`，行为是 upsert，不是“只新增”。

### 5.1 请求字段完整对照

所有字段在 Controller 层大多可缺省；**接入方应强制新建账号提供 account，并更新时提供已保存的 userId**。空对象会走内部默认账号回退，不应当作合法业务请求。

| 字段 | 类型与语义 | User Center | SDK users |
| --- | --- | --- | --- |
| `userId` | 已有 Launcher ID；新建通常省略，由响应取回 | 支持 | 支持 |
| `account` | 账号，建议显式必填且固定大小写 | 支持 | 支持 |
| `username` / `user_name` | account 的回退输入；username 优先 | 支持 | 支持 |
| `email` | 可选邮件属性；不是已验证邮箱或找回能力 | 支持 | 支持 |
| `displayName` | 显示名 | 支持 | 支持 |
| `password` | 可选明文，仅通过受控 TLS 请求传入；缺省保留旧凭据 | 支持 | 支持 |
| `roleIds` | Launcher 角色列表 | 数组或逗号/分号/换行字符串 | 仅字符串数组 |
| `orgIds` | Launcher 组织列表 | 同上 | 仅字符串数组 |
| `status` | 当前只有传 disabled 会主动禁用；见覆盖规则 | 支持 | **忽略** |
| `profile` | 下表的资料对象 | 支持 | **忽略** |
| `attributes` | `profile.attributes` 的顶层便捷输入 | 支持 | **忽略** |
| `externalIds` | `profile.externalIds` 的顶层便捷输入 | 支持 | **忽略** |
| `appAccess` | `{homeAppId,registeredByAppId,allowedAppIds,deniedAppIds}` | 支持 | 支持 |
| `homeAppId` | 顶层应用归属，优先于 appAccess 同名值 | 支持 | 支持 |
| `registeredByAppId` / `sourceAppId` | 前者优先；写入兼容归属，不写 registration | 支持 | 支持 |
| `allowedAppIds` | 额外允许应用 | 数组或分隔字符串 | 仅字符串数组 |
| `deniedAppIds` | 明确禁止应用，优先于允许规则 | 数组或分隔字符串 | 仅字符串数组 |
| `replaceAppAccess` | 仅严格 boolean true 启用替换；必须同时提供两个顶层数组 | 支持 | **忽略，始终追加合并** |
| `defaultOverseaSiteIds` | 出海站点列表 | 数组或分隔字符串 | **忽略** |
| `overseaSiteIds` / `siteIds` | defaultOverseaSiteIds 的回退别名 | 支持 | **忽略** |
| `provisionOversea` / `defaultOverseaAccess` | 创建/更新用户后开通出海权益；前者优先 | 支持，建议严格 boolean | **忽略** |
| `requestedBy` | 管理操作的审计标记，不是鉴权依据 | 支持 | 支持 |
| `requestId` | 审计关联，不是幂等键 | 支持 | 支持 |

`profile` 支持 `title`、`department`、`location`、`address`、`phone`（字符串），`tags`（字符串数组），`attributes`（JSON 对象），`externalIds`（字符串映射）。顶层 attributes/externalIds 与 profile 内同名对象合并，profile 内的值优先。不要把 password/token/secret 放进扩展资料。

`tenantId`、`registration`、`credential`、`webSessionsInvalidBefore`、`createdAt`、`updatedAt` 不是这两条路由接受的写参数。当前创建结果固定使用 `tenant_default`；业务租户不应塞到这个字段。

### 5.2 推荐的新建请求及返回

以下使用完整的 User Center 管理路由；示例不开通网络，只显式添加 Luopan 授权。其他应用仍按各自策略判定，空 deniedAppIds 不代表禁止其他应用。

```http
POST /internal/v1/user-center/users
Content-Type: application/json
x-mx-ops-token: <仅受控管理后端持有>

{
  "account": "partner_alice",
  "displayName": "示例 Alice",
  "email": "alice@example.invalid",
  "password": "<通过安全渠道设置的初始口令>",
  "roleIds": ["mx-user"],
  "orgIds": ["org_default"],
  "profile": {
    "department": "示例部门",
    "tags": ["partner"],
    "attributes": {"sourceSystem": "example-crm"},
    "externalIds": {"exampleCrmUserId": "local-2048"}
  },
  "homeAppId": "luopan",
  "registeredByAppId": "luopan",
  "allowedAppIds": ["luopan"],
  "deniedAppIds": [],
  "provisionOversea": false,
  "requestedBy": "example-directory-operator",
  "requestId": "example-user-create-001"
}
```

```json
{
  "user": {
    "userId": "usr_partner_alice",
    "tenantId": "tenant_default",
    "orgIds": ["org_default"],
    "account": "partner_alice",
    "email": "alice@example.invalid",
    "displayName": "示例 Alice",
    "roleIds": ["mx-user"],
    "status": "active",
    "profile": {
      "title": null,
      "department": "示例部门",
      "location": null,
      "address": null,
      "phone": null,
      "tags": ["partner"],
      "attributes": {"sourceSystem": "example-crm"},
      "externalIds": {"exampleCrmUserId": "local-2048"}
    },
    "credential": {
      "hasPassword": true,
      "passwordUpdatedAt": "2026-10-27T00:00:00.000Z",
      "providers": ["local-password"]
    },
    "appAccess": {
      "homeAppId": "luopan",
      "registeredByAppId": "luopan",
      "allowedAppIds": ["luopan"],
      "deniedAppIds": []
    },
    "createdAt": "2026-10-27T00:00:00.000Z",
    "updatedAt": "2026-10-27T00:00:00.000Z"
  }
}
```

保存响应 `user.userId`，不要把示例的 ID 推导公式当作客户端生成规则。返回不含密码或密码哈希；已有用户可能还带 `registration`、`webSessionsInvalidBefore`。缺省 password 的新账号可能 `credential.hasPassword=false`，不能因此假定已可密码登录。

### 5.3 upsert 的匹配、覆盖与副作用

1. 有 userId 时先找该 ID；没有找到，仍会用 account/username/email 查已有用户。这个查找还比较 userId、account、email、displayName、legacyUserId、legacyId 等别名，并且**不区分大小写**。不要同时传一个新造 userId 和一个既有账号：当前即使按别名找到旧记录，构造结果仍优先采用传入的新 ID，可能复制资料形成另一条同别名记录，原用户并不删除；不是 ID 重命名 API，也不保证拒绝该冲突。下游同步先保存并沿用已有 Launcher ID，发现冲突停止人工核对。
2. 新建未提供 ID 时服务端按账号生成；已有记录正常更新保留 ID。account 优先于 username、email；没有这些输入时沿用旧 account。displayName/email 的 null 或空值通常保留旧值，不是清空指令。
3. **roleIds/orgIds 缺省或空数组时分别重设为 mx-user/org_default，并非保留原值。** 更新资料时应读当前记录，明确传回需保留的完整角色/组织集合。当前没有版本号/CAS 的通用用户更新协议，并发编辑需要下游串行化或重新核对。
4. `status:"disabled"` 会禁用；省略保留。当前实现中给已有 disabled 用户传 `status:"active"` 仍保留 disabled，不能把这条接口当作已支持解禁。不要为解禁删除重建用户。
5. 默认 appAccess 为追加合并、去重；空数组不撤销旧允许/禁止。仅 User Center `replaceAppAccess:true` 才替换两个列表，且要求顶层 allowedAppIds 与 deniedAppIds 都是数组；appAccess 内的列表仍参与合并，避免带入旧值。更新 Luopan 时必须保留其他应用的列表成员。
6. profile 文本字段非空新值覆盖，null/空值保留；tags 追加去重；attributes/externalIds 按键合并，不能用空对象删除旧键。profile 中未列明的任意顶层键不会自动持久化，扩展值应放 attributes。
7. 显式非空 password 会写新凭据；口令 trim 后必须非空且最多 200 字符。普通 upsert/导入**不会像专用改密接口一样撤销所有 SDK token**；对已有用户会推进网页登录失效时间。日常改密应使用第 8 节专用接口，不用资料同步携带 password。
8. `provisionOversea:true` 的开通发生在账号事务完成之后，不是账号+网络的单一原子事务。**此快捷开通路径会将未传的 defaultOverseaSiteIds 转成显式空数组**，产生 disabled 分配，或清空已有用户分配；它不同于 58 中省略 siteIds 的默认/保留语义。确需此快捷路径时必须传经确认的完整非空站点列表；推荐分开创建用户和 ensure。若权益开通失败，用户可能已经创建成功；先读取状态再重试，不能按请求失败直接删除用户补偿。详见 58。

读取接口 `GET /internal/v1/user-center/users` 和 `GET /internal/v1/sdk/users` 均返回 `{users:[...]}`，当前无分页/过滤参数并包含 disabled 用户。没有对外的单用户 `GET /sdk/users/:id` 契约。目录包含用户资料，应只在受控后端使用，不转发整份目录给登录页面。

## 6. 绑定下游本地账号，避免误报 409

推荐永久关联为“下游 localUserId ↔ 经验证的 Launcher userId”，并保留环境/issuer 边界。下游登录可先向 Launcher 验证，再在本地事务中按已确认的业务账号检查绑定：

```text
验证上游成功，且 principal.kind == user，取 principal.userId
锁定当前本地账号行
若已绑定同一 MX userId：视为成功，无需再写
若未绑定：检查该 MX userId 没有绑定到其他本地账号，再设置并验证结果
若已有不同绑定，或 MX userId 已被其他账号占用：返回冲突，保持原绑定
提交后才创建下游登录态
```

不能仅凭用户输入的 userId、显示名、邮箱或客户端缓存做绑定。首次绑定也不能把“用户名相同”自动解释为同一人；需采用下游已定义的迁移/开通策略。不同发行环境的数据不能混绑。

数据库 UPDATE 的返回值要按驱动定义解释：某些 MySQL/JDBC 配置报告“实际改变行数”，重复写同一个 `mx_user_id` 为 0，并不代表关联冲突。先读取当前绑定；同值重复登录应幂等成功。即使使用条件 UPDATE 防并发，也应在返回 0 时复查“同值已经绑定 / 账号不存在 / 不同值冲突”，不要直接统一映射 409。唯一约束和事务应防止两个本地账号争抢同一 MX 身份。这是通用接入注意事项，不能据此认定当前 Luopan 的 PostgreSQL 409 是同值 UPDATE 导致。

已有 Luopan Java 的 `AccountController` 在 Launcher 登录成功后调用 `bindMxUserId`，返回 null/0 时输出业务 `code:409`、文案“MX Launcher 用户与本地账号关联冲突，请联系管理员”；这是下游响应体，不是 Launcher 原生身份接口的统一错误。其 Mapper 限制目标原值为 null/同一 MX ID，且其他本地账号未占用该 MX ID；原绑定不同或已被另一账号占用都可导致 0 行。处理时分别记录脱敏的本地账号 ID、既有 MX ID、新验证 MX ID、绑定分支与数据库返回语义；不要记录密码/token。不要通过清空全部绑定、删统一用户或覆盖不同 ID 来“修复”409。

## 7. 密码登录、token 校验和应用访问

### 7.1 用户 password grant

```http
POST /internal/v1/sdk/oauth/token
Content-Type: application/json

{
  "grant_type": "password",
  "username": "partner_alice",
  "password": "<用户本次输入的口令>",
  "audience": "mx-sdk",
  "appId": "luopan",
  "scope": "auth.read",
  "requestId": "example-login-001"
}
```

输入支持 `grantType` 别名；未传 grant 时默认 password。账号按 `username → account → email` 取值，精确区分大小写，多个用户匹配同一别名时拒绝登录；这与 upsert 的不区分大小写匹配不同。

当前人类用户默认及最大有效期来自 `USER_SESSION_TTL_SECONDS=2592000`，即 30 天。`expires_in` 优先于 `ttlSeconds`，接受有限数字/数字字符串，取整并限制在 60 秒至 30 天。以响应 expires_in/expires_at 为准，历史 token 的到期时间不会因源码常量变更自动延长。

scope 的选择、交集及空记录回退规则与机器登录一致。角色里没有的权限不会因写在请求中获得；不能把 HTTP 成功当作请求的全部权限均获准，也不能把响应 scope 为空视为 token 没有权限。当前内置 mx-user 有 auth.read，但没有 sdk.identity.read，故普通用户身份检查可用 route 接受的 auth.read。

响应示例只列示意 scope；实际 scope 是服务端计算结果：

```json
{
  "token": {
    "access_token": "<opaque MX access token>",
    "token_type": "Bearer",
    "issued_token_type": "urn:ietf:params:oauth:token-type:jwt",
    "expires_in": 2591999,
    "scope": "auth.read",
    "issuer": "mx-user-center:example-environment",
    "audience": "mx-sdk",
    "subject": "user:usr_partner_alice",
    "principal": {
      "principalId": "user:usr_partner_alice",
      "kind": "user",
      "tenantId": "tenant_default",
      "orgIds": ["org_default"],
      "displayName": "示例 Alice",
      "userId": "usr_partner_alice",
      "anonymousPrincipalId": null,
      "serviceAccountId": null,
      "roles": ["mx-user"],
      "scopes": ["auth.read"]
    },
    "auth_provider": "local-password",
    "expires_at": "2026-11-26T00:00:00.000Z"
  }
}
```

虽然兼容字段叫 jwt，当前 `mx-v1-...` 是服务端存储并校验的 opaque token，不能当作可本地验签的三段 JWT，也不能用字符串前缀判断已登录。不得接受调试用 `mx-shadow-*` 作为正式用户身份。

### 7.2 introspection 是身份校验，不是完整业务授权

```http
POST /internal/v1/sdk/identity/introspect
Content-Type: application/json

{"token":"<MX access token>","audience":"mx-sdk","requestId":"example-check-001"}
```

返回 `{introspection:{active,tokenKind,issuer,audience,subject,principal,scopes,expiresAt,reason,authProvider?}}`。身份无效常通过正常 HTTP 响应中的 `active:false` 表达，不能只检查 2xx。用户登录至少检查 active、tokenKind=jwt、预期 issuer/audience、principal.kind=user/非空 userId、到期及本地账号状态，并明确拒绝 mx-shadow 输入。服务端会检查记录存在、撤销、过期、audience、主体状态；非空记录 scopes 与当前权限取交集，空记录 scopes 按第 4 节所述回退。

body 的 audience 省略可能使用 token 原 audience；接入方必须显式传固定预期 audience。不能在失败后不带 audience 重试以绕过不匹配。

`POST /sdk/identity/context` 还接受 userId、serviceAccountId、installId 等兼容上下文输入，能够返回非 token 来源的上下文；不要拿“context.principal 存在”替代 token 验证。对真实登录使用 introspection 或下面的固定应用访问校验。

### 7.3 固定应用入口执行 appAccess 校验

password grant 的 `appId` 会检查用户是否明确 denied，并写入 token 上下文；带 appId 的 token 在 introspection 时也重验 denied。它**不会在签发阶段完成全部 AppCenter 私有应用授权**。旧通用 token 未带 appId 时，introspection 也不能代替实际目标应用检查。

```http
POST /internal/v1/sdk/gateway/access/evaluate
Content-Type: application/json

{
  "token": "<MX user access token>",
  "audience": "mx-sdk",
  "routeId": "sdk.identity.context",
  "appId": "luopan",
  "requestId": "example-luopan-admission-001"
}
```

先完成 7.2 的真实用户 token 校验；`decision` 本身不返回 tokenKind，不能单靠 principal.kind 排除兼容 shadow 身份。下游再要求 `decision.allowed===true`、`decision.principal.kind==='user'`、非空且与已校验身份一致的 userId，且 `decision.appAccess.appId==='luopan'`、`decision.appAccess.allowed===true`，再执行本地绑定与业务授权。routeId/appId/audience 由服务端常量提供；若业务需要 sourceAppId，也必须来自可信配置。

应用判定顺序包括：应用存在/启用 → 用户 denied → 可配置的管理员通行 → public → 已认证要求及用户/角色/组织/应用来源/授权记录匹配。明确 denied 优先于 public、allowedAppIds 和管理员通行；private 不代表必须同时具备所有匹配条件，当前有效匹配之一即可。AppCenter allowed 也不授予该应用的本地管理员、Hub 租户、支付或网络权限。

`decision` 的主要字段为 `routeId,allowed,principal,matchedScopes,missingScopes,appAccess,reason`。应用拒绝时 HTTP 仍可为 2xx，应读 allowed。当前 reason 在 route 和 app 同时失败时措辞可能不够精确，判断依据是结构化字段，不解析提示字符串。

## 8. 修改密码

| 场景 | 请求 | 权限与目标 |
| --- | --- | --- |
| 用户自助 | `POST /sdk/users/me/password`，`{currentPassword,newPassword,requestId?}` | active mx-sdk 用户 Bearer；目标来自 principal，不接受 body userId |
| 可信系统重置 | `POST /sdk/users/:userId/password`，`{password,requestId?}` | active mx-sdk Bearer + sdk.user.write 或 rbac.manage |
| Internal 运维重置 | `POST /user-center/users/:userId/password`，`{password,requestedBy?,requestId?}` | Ops；路径为目标 Launcher userId |

路径均以 `/internal/v1` 为前缀。自助接口不要求 sdk.user.write，但必须校验旧密码；服务账号不能调用 me。SDK 两条改密路由从已验证 principal 写 requestedBy，忽略伪造的 body actor。

此处新密码按当前 Store 规则去首尾空白后必须非空且不超过 200 字符；这不是 59 中网页自助界面的 8–128 字符校验。下游可在产品侧要求更强口令，但不能宣称这三条接口已统一执行网页规则。

成功返回：

```json
{
  "password": {
    "user": {"userId":"usr_partner_alice","credential":{"hasPassword":true,"providers":["local-password"],"passwordUpdatedAt":"2026-10-27T00:00:00.000Z"}},
    "tokensRevoked": 2,
    "updatedAt": "2026-10-27T00:00:00.000Z"
  }
}
```

上例 user 为节选；实际返回完整用户。Store 更新凭据、推进 webSessionsInvalidBefore，并撤销该用户所有尚未标记撤销的 `iam-token`，不限于当前应用；计数可能包括尚未标记撤销的已过期记录。**这会让同一用户的 MX-H2I 等既有登录凭据需要重新认证**，不能把全局改密用于仅禁用某个下游业务的需求。它不直接修改网络 lease/peer，但现有认证失效会影响后续认证请求。下游清除自己的旧登录态并要求重新登录。

账号不存在返回 404；缺失/不合规则通常 400；无效 Bearer/旧密码为 401，主体或 scope 不符为 403。自助旧密码校验还有登录同等级的限流。

## 9. 批量导入

`POST /internal/v1/user-center/users/import`，Ops 鉴权。支持整个 body 为行数组，或 `{users:[...],...defaults}`；推荐对象形式明确默认权限。

| 顶层字段 | 规则 |
| --- | --- |
| `users` | 必须为数组；每项按行标准化 |
| `defaultRoleIds` / `roleIds` | 前者优先，缺省 mx-user；应用到每行，行自身 roleIds 不读取 |
| `defaultOrgIds` / `orgIds` | 缺省 org_default；行自身 orgIds 不读取 |
| `defaultHomeAppId` | 行 homeAppId 未提供时使用 |
| `defaultRegisteredByAppId` / `sourceAppId` | 行 registeredByAppId 未提供时使用 |
| `defaultAllowedAppIds` / `allowedAppIds` | 行 allowedAppIds 未提供时使用 |
| `defaultOverseaSiteIds` / `overseaSiteIds` / `siteIds` | 批次出海站点列表 |
| `provisionOversea` / `defaultOverseaAccess` | 批次开通权益开关，建议 false/省略 |
| `requestedBy` | 默认 user-import |
| `requestId` | 批次审计关联，不是批次/行幂等键 |

行支持 `id,userId,account,username,user_name,email,displayName,display_name,password,profile,attributes,externalIds,appAccess,homeAppId,registeredByAppId,allowedAppIds,deniedAppIds`。账号推导顺序为 account → username → user_name → email → String(id)，全部缺失则该行失败。显示名为 displayName → display_name → user_name → account。

行 `id` 是旧系统 ID，自动存入 `externalIds.legacyUserId`；**它不等于 Launcher userId**。`user_name` 还写入 legacyUserName。需要保留既有 Launcher 身份时传已确认的 `userId`，不要拿旧系统数字 ID 覆盖它。行 status、roleIds、orgIds、replaceAppAccess 当前不作为行级配置读取。

```json
{
  "users": [{"id":2048,"account":"partner_alice","user_name":"示例 Alice","externalIds":{"exampleCrmUserId":"2048"}}],
  "defaultRoleIds": ["mx-user"],
  "defaultOrgIds": ["org_default"],
  "defaultHomeAppId": "luopan",
  "defaultRegisteredByAppId": "luopan",
  "defaultAllowedAppIds": ["luopan"],
  "provisionOversea": false,
  "requestId": "example-import-001"
}
```

返回 `{import:{imported,updated,failed,users,entitlements,failures,generatedAt}}`。failures 项为 `{index,account,reason}`，index 从 0 起；users 仅包含成功返回的用户。逐行执行，**不是整个批次的原子事务**；有失败不会回滚已成功行，HTTP 成功也不表示 failed=0。如果行的权益开通失败，该行用户本身仍可能已保存。失败后按 index/权威用户状态核查并定向重试。

对已存在用户，显式 password 会覆盖密码，省略则保留；默认角色/组织也会应用到旧用户。不要把全量资料导入当成无副作用刷新。日常单用户改密走第 8 节。

批量导入的 `provisionOversea:true` 同样必须配套完整非空的批次站点列表；未提供列表会显式写空分配，不能用来“默认开通”或保留旧分配。普通目录导入保持 false，需要网络时另行调用 58 的流程。

## 10. 删除与权限撤销的区别

`DELETE /internal/v1/user-center/users/:userId`，Ops 鉴权，请求可为 `{requestedBy,requestId}`。当前没有 SDK Bearer 删除用户接口。

拒绝条件包括：内置 bootstrap 用户、最后一个 active mx-admin、活动 Launcher network lease、已关联的 device enrollment，以及仍 active 或仍分配 siteIds 的 Oversea entitlement。业务删除不能自行拆现有设备/网络来满足条件，应先确认真正需要全局删除。

成功返回：

```json
{
  "deletion": {
    "deleted": true,
    "userId": "usr_partner_alice",
    "account": "partner_alice",
    "deletedRecords": {"credential":1,"tokens":2,"overseaEntitlements":0,"h2oRuntimeProfiles":0,"appInstallations":0,"permissionGrants":0},
    "deletedAt": "2026-10-27T00:00:00.000Z"
  }
}
```

删除移除用户、对应凭据/token/相关应用安装/权限记录等，并记录 tombstone 防止历史 seed 自动恢复；不自动删除 Luopan/Hub/Pay 等下游业务数据。重复删除返回不存在，不是幂等 200。仅停止一个下游产品的业务使用，应使用该产品本地授权或经过确认的应用策略，不能删除共享账号或重置共享密码。

## 11. 浏览器 SSO 的选择与导航

新浏览器应用优先用 `@qpjoy/mx-common/identity/sso`，以独立 OIDC client、固定 callback、PKCE/state/nonce 和应用自己的服务端会话接入。普通应用 scope 为 `openid mx:identity`，Hub 有自己的 `openid mx:hub` 兼容契约。OIDC client 凭据不是第 4 节的 SDK 服务账号凭据；OIDC access token 也不能直接交给 SDK `/identity/introspect` 当 mx-v1 token 使用。

通用 SSO 入口包括应用自己的 `/auth/sso/login`、`/auth/sso/callback`、`/auth/sso/session`、`/auth/sso/logout`。账号自助由服务端 `createIdentityAccountClient` 调 Auth issuer 的 `/app-account`。当前 oidc-provider 的标准 introspection/revocation 功能未开启，不应按其他 OIDC 产品的惯例猜 `/introspect` 或 `/revoke` 接口。

详细请求、返回及浏览器交互要求见 [59-browser-account-api.md](59-browser-account-api.md)。实现与历史背景按顺序参考：

1. [47-shared-sso-and-hub-adapter.md](47-shared-sso-and-hub-adapter.md)：共享应用 SSO 与本地授权适配。
2. [45-application-account-sdk-and-hub.md](45-application-account-sdk-and-hub.md)：原生账号页面、表单和服务端账号 SDK。
3. [48-identity-application-management.md](48-identity-application-management.md)：第一方应用登记与配置管理。
4. [44-hub-registration-policy-and-provenance.md](44-hub-registration-policy-and-provenance.md)：注册来源与 Hub 业务邀请边界。

以上历史文档中的部署结果、日期和示例不能替代当前环境的配置验收；接入方仍需提供自己的本地角色/资源权限解析。

## 12. 错误、限流与接入验收

| 现象 | 应检查的层次 |
| --- | --- |
| OAuth 400 | 不支持的 grant_type；只支持 password/client_credentials，不支持 refresh_token |
| OAuth 401 | 凭据、账号状态、大小写/重复别名；client_credentials 是否经 Domestic edge |
| OAuth 403 `app_access_denied` | 此用户被明确禁止 appId，不能用通用 token 绕过应用入口 |
| 429 + retryAfterSeconds | 认证尝试限流；按秒退避，不换账号/来源绕过 |
| introspection 2xx + active:false | token 缺失/无效/过期/撤销、audience、主体或应用 deny |
| evaluate 2xx + allowed:false | scope、应用是否注册/启用、用户/应用策略；再检查本地授权 |
| 用户管理 401/503 | Ops token 不正确/未配置；拥有 SDK Bearer 不等于 Ops |
| 下游业务 code:409 | 先识别响应来源，再核对本地绑定；不是统一 Launcher 错误语义 |
| 请求超时/5xx | 不确定是否已写成功，先查询并关联 requestId；不要自动删号补偿 |

当前 password 与自助改密采用 5 分钟窗口：账号桶 25 次、来源+账号桶 10 次，无所有用户共用的来源 IP 桶。client_credentials 另外有来源 IP 桶 30 次、client 桶 25 次、来源+client 桶 10 次。计数在验证前执行，成功请求也计入，不应给每个普通业务请求重新请求 OAuth token。

用户 upsert 等部分管理方法没有统一把所有 Store 异常转换为 4xx；不要假设每个输入冲突都有稳定的 409 或固定机器错误码。保持失败关闭、记录脱敏诊断，按响应状态和当前契约处理。

交付下游前至少验证：新建返回 ID 与本地绑定一致；同账号重复登录/同值绑定成功；不同身份争抢绑定被拒绝；更新资料未意外重设角色/应用列表；请求 scope 被削减时不会误放行；active=false 与 appAccess 拒绝生效；网络/认证服务暂不可用不被误判为绑定冲突；改密与删除的全局影响得到业务确认。验证使用隔离测试账号，不以 MX-H2I 现有用户作破坏性试验。

## 13. 当前源码与旧文档/生成契约的差异

这些是接入时必须遵守的当前实现事实；本次只补文档，没有修运行代码或改在线 OpenAPI。

当前自动文档入口为 API 根地址下的 `/docs` 或 `/docs/api`，可导出 `/docs/api/openapi.json`、`/docs/api/mx-launcher-api.md`。它们由现有 contract 生成，不会自动包含本次新增的 57–59；下游交接应同时提供这三篇文档，避免继续沿用下表中的旧示例。

| 容易误读的内容 | 当前源码事实 |
| --- | --- |
| 旧 API contract 将 sdk/users、sdk/roles 标成 Bearer + scope | Controller 实际要求 Ops；manifest/evaluate 不是通用鉴权中间件 |
| 旧 SDK 用户创建示例带 profile/attributes | SDK converter 没有读取；要保存完整资料使用 User Center 路由 |
| OAuth 描述仍写用户 token 7 天 | 当前共享常量是 30 天；旧 token 仍遵守旧 expiresAt |
| issued_token_type 标为 jwt | mx-v1 token 为 opaque，必须服务端校验 |
| token 响应 scope 为空即无权限 | 空记录 scopes 在 introspection 会回退到主体全部当前 scopes；不能据此收窄授权 |
| requestId/重复 POST 被笼统称为幂等 | 无通用请求去重；用户资料、密码、审计及账号 upsert 会再执行 |
| status active 可解除 disabled | 当前 createUserCenterUser 不能以 active 覆盖旧 disabled |
| 用户创建/导入自动完成下游开户 | 仅写 Launcher；本地业务账号与绑定由下游负责 |

## 14. 源码依据与未验证范围

主要依据（相对于 mx-launcher 根目录）：

| 源码 | 本文对应内容 |
| --- | --- |
| [sdk-gateway.controller.ts](../server/src/modules/sdk-gateway/sdk-gateway.controller.ts) | 实际 SDK 路由鉴权、OAuth 参数、用户子集转换、改密、服务账号开通/轮换 |
| [user-center.controller.ts](../server/src/modules/user-center/user-center.controller.ts) | 完整 upsert/import/delete/password 请求转换、Ops 鉴权 |
| [store/domain.ts](../server/src/store/domain.ts) | 身份 ID、匹配、资料合并、scope OR、AppCenter 访问规则、密码与服务账号构造 |
| [store/postgres.ts](../server/src/store/postgres.ts) | upsert 查找与事务、导入逐行执行、改密撤销、删除保护、token 与访问决策 |
| [types.ts](../server/src/types.ts) | 请求/响应字段定义 |
| [internal-ops-auth.ts](../server/src/lib/internal-ops-auth.ts)、[index.ts](../server/src/index.ts) | Ops/管理会话边界、no-store 与服务器入口 |
| [session-lifetime.ts](../server/src/lib/session-lifetime.ts) | 当前用户会话有效期 |
| [identity/provider.ts](../server/src/identity/provider.ts)、[identity/repository.ts](../server/src/identity/repository.ts) | OIDC 与共享账号权威边界 |
| [mx-common identity client](../../mx-common/src/identity/client.mjs)、[SSO adapter](../../mx-common/src/identity/sso.mjs) | 浏览器应用接入导航 |

没有验证线上实际部署版本、入口开放路径、真实服务账号/用户、数据库绑定或第三方登录配置。文档中的“支持”表示这份源码存在相应契约；上线前由维护方用目标环境配置和隔离账号验证。所有业务错误归因均须区分 Launcher 返回与下游自行包装的返回。
