# SDK Gateway API

SDK Gateway 是 Internal 对外部系统开放的稳定集成面。外部系统不要直接复制
User Center、Permission Center 或 Config Center 的内部表结构；优先调用
`/internal/v1/sdk/*`。

## Online Delivery

Internal 18090 服务直接交付在线版与两种可导出格式：

```text
http://<internal-host>:18090/docs/api/
http://<internal-host>:18090/docs/api/openapi.json
http://<internal-host>:18090/docs/api/mx-launcher-api.md
```

在线页面支持搜索、复制 curl 和打印为 PDF。Internal gateway 的 18090 listener 会原样
reverse proxy 到 mx-launcher server，因此不需要额外增加 gateway path；SDK Gateway
manifest 的 `sdk.documentationUrl`、`sdk.openApiUrl`、`sdk.markdownUrl` 也可用于运行时发现。

### 换一个好记的域名（`h2i.api.mxinfo-inc.cn`）

`/docs/api/` 由 mx-launcher server 自己挂载，**不存在单独的文档站**：换域名等于给
Internal API 加一条内网 DNS 反代路由，而不是部署新服务。所以直接访问
`http://h2i.api.mxinfo-inc.cn/docs/api/` 打不开是正常的——那条记录还没建。

```bash
curl -sS -X POST "$MX_INTERNAL/internal/v1/dns/reverse-proxy/routes" -H "x-mx-ops-token: $MX_OPS_TOKEN" -H 'content-type: application/json' -d '{"host":"h2i.api.mxinfo-inc.cn","dnsTarget":"10.88.88.88","targetUrl":"http://10.88.88.88:18090","tlsMode":"internal","authRequired":false,"requestedBy":"ops"}'
```

建完要 `POST /internal/v1/dns/zones/build` 重建 zone，再让 gateway 生效；`10.88.88.88`
按实际 serviceVip 替换。两个注意点：

- **别用 `api.mxinfo-inc.cn`**：那条是 V1 HDO 的记录（指向 `100.89.0.12`），动它会断线上用户。
  `h2i.api.` 是新的三级域名，互不影响。
- **文档站只走内网。** 18090 属于 Internal/Domestic relay 面，公网 edge 的 allowlist 里
  没有也不应该有 `/docs/*`；接入方要看文档就得先连上 WG。

### 覆盖范围

契约目前收录 44 条 path / 53 个 operation，覆盖 SDK Gateway、OAuth、User Center、
AppCenter、Release Center、Oversea 订阅和 Launcher Network bootstrap。服务端实际路由
远多于此（约 200 个 handler），未收录的基本是 admin/运维专用面——**它们刻意不进契约**，
避免第三方按内部运维接口集成。新增对外接口时，同时改
`server/src/modules/api-docs/api-docs.contract.ts`，`pnpm run test:api-docs` 会校验
operationId 唯一、tag 声明与使用一致、path 参数齐全，以及 Bearer 保护的用户订阅没有被
误标成 public。

该入口属于 Internal/Domestic relay 网络面，不得直接暴露到公网。用户调用使用 active
`mx-sdk` Bearer；users/roles/service-accounts 管理接口以及 AppCenter 应用写入/删除还要求
Internal 运维凭据 `x-mx-ops-token`。仍有部分 V1 shadow SDK route 依赖 gateway access
evaluate 而没有统一 Bearer guard，因此生产集成必须继续保留网络隔离，并先按 `routeId`
调用 access evaluate。

## Base URL

开发机可继续使用 port-forward：

```bash
bash scripts/manage.sh ops internal-local port-forward 18090 0.0.0.0
```

正式 Internal CentOS/Ubuntu 使用长驻 gateway：

```bash
bash scripts/manage.sh ops internal-production deploy
```

默认 base URL：

```text
http://<internal-host-or-10.88.88.88>:18090
```

## Auth Flow

1. 用户使用 password/飞书流程获取 `mx-sdk` token；service account 使用
   `POST /internal/v1/sdk/oauth/token` 的 `client_credentials`，其 `client_secret` 由
   Internal 为该 service account 独立配置。
2. 调用 `POST /internal/v1/sdk/gateway/access/evaluate` 判断 token 是否可调用某个
   `routeId`。
3. 调用具体 SDK route。

当前 V1 shadow 以 gateway manifest 和 access evaluate 作为稳定契约；后续会把
Bearer header gate 收紧到每个 SDK route。

### Internal ops bootstrap

Internal 进程从 `MX_INTERNAL_OPS_TOKEN` 读取高权限 bootstrap 凭据；管理请求通过
`x-mx-ops-token` header 传入。服务端未配置时受保护接口 fail closed，不能用任意
`client_secret`、普通用户 token 或“只在内网”替代。Kubernetes 中的 source of truth 是：

```text
namespace: mx-internal-shadow
Secret:    mx-internal-ops
key:       token
```

`manage.sh` 会复用该 Secret；首次部署时若没有显式 `MX_INTERNAL_OPS_TOKEN`，会生成随机
token。Admin UI 的 `Internal Ops Token` 输入只存在当前页面会话，刷新/重启后清空。以下
curl 示例假设受控 shell 已从 Secret Manager 加载 `MX_INTERNAL_OPS_TOKEN`；不要把实际值
写入脚本、Git、CI 日志或聊天记录。

`MX_INTERNAL_OPS_TOKEN` 只用于平台管理接口。新建 AppCenter 应用会自动 ensure 一个
`svc_<appId>_release_publisher`；显式创建 service account 时也会在该账号尚无 credential
时签发独立 `client_secret`。API 只在首次签发或显式轮换时返回一次明文，PostgreSQL 只保存
不可逆 scrypt hash。调用方必须立即把明文写入对应应用的 CI/Vault；列表、查询和后续幂等
upsert 都不会再次返回原值。

旧 `MX_SDK_SERVICE_ACCOUNT_SECRETS_JSON` /
`MX_SDK_SERVICE_ACCOUNT_SECRETS_FILE` 和
`mx-sdk-service-account-secrets/secrets.json` 只保留一版迁移兼容：启动时仅把数据库中
尚无 credential 的旧账号导入为 hash；数据库已有 credential 时绝不覆盖，OAuth 也不会
回退接受 map 中的另一个旧值。正常 deploy
不需要配置这两个变量，也不要求该 K8s Secret 存在。迁移输入仍必须是完整旧 map，迁移完成
并验证所有 CI 后，先删除 `.env` 中的迁移变量，再显式执行：

```bash
kubectl -n mx-internal-shadow delete secret mx-sdk-service-account-secrets
```

仅删 `.env` 不会删除已有 Secret，因为 deploy 默认保留未配置的集群值。不得把平台运维
token 交给产品开发者或产品 CI。

## Manifest

```bash
curl -sS "$BASE/internal/v1/sdk/gateway/manifest"
```

返回值中的 `gateway.routes[]` 是外部系统可发现的 route registry，包含 `routeId`、
`path`、`audience`、`authRequired` 和说明。

## Token

用户密码模式：

```bash
curl -sS "$BASE/internal/v1/sdk/oauth/token" \
  -H 'content-type: application/json' \
  -d '{
    "grant_type": "password",
    "username": "<user-account>",
    "password": "<password>",
    "scope": "sdk.identity.read sdk.user.read permission.request",
    "audience": "mx-sdk"
  }'
```

`username` 可以匹配 `userId`、`account`、`email`、`displayName` 或 legacy external id。
密码模式会校验 User Center 保存的 `local-password` credential；导入旧系统账号时应把
旧 `account/password/user_name` 写入 User Center，而不是继续让 Domestic 保存登录真相。

password grant 签发的用户 access token 默认有效 `604800` 秒（7 天），并以 7 天为上限；
MX-H2I、Luopan 和其他未显式传入更短 `expires_in` 的 standalone 都使用这个周期。当前尚未
实现 refresh token grant，token 到期、被撤销或用户修改密码后需要重新登录。修改默认值
不会延长已经签发的 token，客户端应重新登录以获得新的 7 天 token。

password grant 在执行同步密码哈希前，使用 PostgreSQL 原子固定窗口同时消费来源 IP、
canonical user 和 IP+user 三类 SHA-256 bucket；窗口为 5 分钟，限额分别为 60、25、10。
同一用户的 `userId`、account、email、display name 和 legacy alias 归入同一 user bucket，
原始 IP、账号和密码不写入 limiter state。任一 bucket 超限统一返回 `429`，不存在、禁用和
错误密码统一返回 `invalid credentials`。这份状态跨进程重启和 RollingUpdate 双 Pod 共享。

Service account 模式：

```bash
jq -n '{
  grant_type: "client_credentials",
  client_id: env.MX_SDK_CLIENT_ID,
  client_secret: env.MX_SDK_CLIENT_SECRET,
  scope: "sdk.identity.read sdk.user.read sdk.user.write sdk.permission.request",
  audience: "mx-sdk"
}' | curl -sS "$BASE/internal/v1/sdk/oauth/token" \
  -H 'content-type: application/json' \
  --data-binary @-
```

client credentials access token 默认仍为 `3600` 秒（1 小时），不随 Electron 用户登录
周期延长。`client_secret` 必须匹配该 client ID 在数据库中的独立 credential；它不是
`managed-by-internal` 之类的占位字符串。轮换某个账号只更新该账号的 CI/Vault
凭据，不需要修改 `server/.env` 或重新部署 API。`client_credentials` 只允许在 Internal
控制面调用；带受控
`X-MX-Forwarded-By: domestic-edge` 标记的公网请求会在比较 secret 前拒绝。Internal
调用也受 5 分钟的 IP/client/IP+client 原子限速。

## Identity

Token introspection：

```bash
curl -sS "$BASE/internal/v1/sdk/identity/introspect" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"audience\":\"mx-sdk\"}"
```

Principal context：

```bash
curl -sS "$BASE/internal/v1/sdk/identity/context" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"audience\":\"mx-sdk\"}"
```

Access evaluate：

```bash
curl -sS "$BASE/internal/v1/sdk/gateway/access/evaluate" \
  -H 'content-type: application/json' \
  -d "{\"token\":\"$TOKEN\",\"audience\":\"mx-sdk\",\"routeId\":\"sdk.users.list\",\"appId\":\"h2o\",\"sourceAppId\":\"mx-h2i\"}"
```

如果传入 `appId`，SDK Gateway 会先按 route scope 判断，再按 AppCenter `accessPolicy`
判断用户是否可访问该应用。返回里的 `appAccess.reason` 会区分 scope 不足、未登录、
私有应用未授权、显式 deny 等情况。

## User Center

List roles:

```bash
curl -sS "$BASE/internal/v1/sdk/roles" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"
```

List users:

```bash
curl -sS "$BASE/internal/v1/sdk/users" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"
```

Create user:

```bash
curl -sS "$BASE/internal/v1/sdk/users" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{
    "account": "external-user",
    "email": "external-user@mx.local",
    "displayName": "External User",
    "password": "change-me-after-import",
    "roleIds": ["mx-user"],
    "orgIds": ["org_default"],
    "profile": {
      "department": "Partner",
      "location": "remote",
      "attributes": {
        "sourceSystem": "external"
      }
    },
    "homeAppId": "mx-h2i",
    "registeredByAppId": "mx-h2i",
    "allowedAppIds": ["mx-h2i", "appcenter", "h2o"],
    "requestId": "ext-user-create-001"
  }'
```

可信外部系统更新单个用户密码时使用 SDK Gateway，不直接调用 User Center 运维路由。
调用 token 必须具备 `sdk.user.write` 或 `rbac.manage`。改密成功会撤销目标用户全部 active
token，用户需要用新密码重新登录：

```bash
curl -sS "$BASE/internal/v1/sdk/users/usr_partner_alice/password" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $TOKEN" \
  -d '{
    "password": "new-password",
    "requestId": "partner-password-update-001"
  }'
```

服务端从 Bearer principal 记录实际调用方，忽略 body 中伪造的 `requestedBy`。普通
`mx-user` token 没有用户写权限，不能借该接口修改自己或其他用户。

登录用户从自身 User Center 修改密码时使用 `me` 路由。服务端从 Bearer 解析当前
`userId`，校验旧密码，不接受 body 指定目标用户；成功后同样撤销该用户全部 active token：

```bash
curl -sS "$BASE/internal/v1/sdk/users/me/password" \
  -H 'content-type: application/json' \
  -H "Authorization: Bearer $USER_TOKEN" \
  -d '{
    "currentPassword": "old-password",
    "newPassword": "new-password",
    "requestId": "user-password-change-001"
  }'
```

Luopan 的 User Center 使用这条自助路由作为 Launcher 集成测试面；改密成功后会清除本地
登录态与 Oversea 用户会话，并要求使用新密码重新登录。

Internal User Center 还提供批量导入接口，供平台运维把旧 HDO 或外部账号一次性导入：

```bash
curl -sS "$BASE/internal/v1/user-center/users/import" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{
    "users": [
      {
        "account": "bmyq",
        "password": "existing-password",
        "user_name": "报名园区"
      }
    ],
    "defaultRoleIds": ["mx-user"],
    "defaultOrgIds": ["org_default"],
    "defaultHomeAppId": "mx-h2i",
    "defaultRegisteredByAppId": "mx-h2i",
    "defaultAllowedAppIds": ["mx-h2i", "appcenter", "h2o"],
    "defaultOverseaSiteIds": ["oversea-main"],
    "provisionOversea": true,
    "requestId": "legacy-hdo-import-001"
  }'
```

导入是按用户标识 upsert：匹配到已有账号时，row 中显式提供 `password` 会覆盖当前密码；
省略 `password` 会保留当前 credential。单用户日常改密优先使用下面的专用接口，以便同时
撤销既有 token。

用户资料保存、密码更新和删除是三个独立操作。更新密码会撤销该用户已有 token，但不会改变
profile、角色或应用权限。k8s Admin 的 User Center 用户抽屉使用这条运维接口；它要求
当前 Internal origin 绑定的 session-only ops token：

```bash
curl -sS "$BASE/internal/v1/user-center/users/usr_partner_alice/password" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{"password":"new-password","requestedBy":"internal-admin"}'
```

删除用户使用 `DELETE`。内置用户、最后一个 active `mx-admin`、有关联设备或活动网络 lease、
以及仍启用 Oversea access 的用户会返回拒绝；先断开客户端并禁用 Oversea access。历史
seed 用户删除后会记录墓碑，Bootstrap 不会自动恢复：

```bash
curl -sS -X DELETE "$BASE/internal/v1/user-center/users/usr_partner_alice" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{"requestedBy":"internal-admin"}'
```

导入行只要求能推导出 `account` 或 `email`；`profile`、`attributes`、`externalIds`、地址、
部门、来源系统等扩展字段都会保存到 User Center profile，供 AppCenter、DNS、H2I、
第三方系统和审计 read model 按需消费。`provisionOversea=true` 时，Internal 会在创建或更新
用户后为默认 Oversea site 生成 entitlement 和订阅运行态，后续仍可在 Admin UI 手动调整节点。

AppCenter 应用访问策略通过 app 记录保存。自定义应用不传策略时默认 private：

```bash
curl -sS "$BASE/internal/v1/app-center/apps/luopan" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{
    "appId": "luopan",
    "displayName": "Luopan",
    "launcherMode": "standalone",
    "accessPolicy": {
      "defaultDecision": "private",
      "allowAdmin": true,
      "allowRoles": [],
      "allowUserIds": ["usr_test"],
      "allowRegisteredByAppIds": ["luopan"],
      "allowHomeAppIds": ["luopan"],
      "requirePermissionGrant": true
    }
  }'
```

首次创建应用（或为尚无 credential 的旧应用执行一次幂等 upsert）返回：

```json
{
  "app": {},
  "publisher": {
    "serviceAccount": {},
    "credential": {
      "clientSecret": "<仅本次响应可见>"
    }
  }
}
```

Publisher ID 会先把 `appId` 转成小写，保留字母、数字、`.`、`_`、`-`，仅把其他字符
归一为 `_`。若最终 ID 会超过 160 字符，平台会稳定截断并附加 12 位 SHA-256 摘要，避免
不同长 ID 冲突。因此 Luopan 是 `svc_luopan_release_publisher`，`mx-h2i` 则是
`svc_mx-h2i_release_publisher`。该账号只绑定 `mx-release-publisher` 角色并只含
`sdk.release.read`、
`sdk.release.publish`，`allowedProductIds` 只含 `luopan`。立刻把
`publisher.credential.clientSecret` 写入 Luopan CI/Vault；再次提交相同应用时
`publisher.credential` 为 `null`，不会读取或轮换现有 secret。

把应用更新为 `enabled=false` 会禁用自动 Publisher 并撤销其 active token，但保留
credential，重新启用后 CI 可继续使用原 secret 获取新 token；被撤销的旧 token 不会复活。
删除非内置应用则会同时禁用 Publisher、撤销 token 并删除 credential verifier；以后重建
同一 `appId` 必须领取新的单次 secret。

查询用户可见应用：

```bash
curl -sS "$BASE/internal/v1/app-center/apps?userId=usr_test&sourceAppId=luopan&includeHidden=false"
```

List service accounts:

```bash
curl -sS "$BASE/internal/v1/sdk/service-accounts" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"
```

Create service account:

```bash
curl -sS "$BASE/internal/v1/sdk/service-accounts" \
  -H 'content-type: application/json' \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN" \
  -d '{
    "serviceAccountId": "svc_external_system",
    "displayName": "External System",
    "roleIds": ["mx-service-account"],
    "scopes": ["sdk.identity.read", "sdk.user.read", "sdk.permission.request"],
    "allowedProductIds": [],
    "requestId": "ext-svc-create-001"
  }'
```

创建响应为 `{serviceAccount, credential}`；仅当账号原先没有 credential 时，
`credential.clientSecret` 才包含一次性明文。相同请求幂等重放不会轮换。
`allowedProductIds` 只约束产品级 SDK 资源。Release Publisher 的创建示例、独立 secret
和最小权限见 [docs/25](./25-release-center-developer-api.md)。

若一次性响应丢失或需要主动轮换，不能查询旧 secret；应在受控终端调用：

```bash
curl -sS -X POST \
  "$BASE/internal/v1/sdk/service-accounts/svc_external_system/credentials/rotate" \
  -H "x-mx-ops-token: $MX_INTERNAL_OPS_TOKEN"
```

响应 `{credential}` 中的 `credential.clientSecret` 同样只出现一次。先把新值写入该账号
的 CI/Vault，再让新作业重新获取短期 token；其他应用 credential 不受影响。

## Permissions

Request permission grant:

```bash
curl -sS "$BASE/internal/v1/sdk/permissions/requests" \
  -H 'content-type: application/json' \
  -d '{
    "appId": "h2o",
    "installId": "inst_mxh2i_xxx",
    "userId": "usr_demo_user_mx_local",
    "scopes": ["network.proxy.app", "network.dns.policy"],
    "requestedBy": "external-system",
    "requestId": "ext-permission-001"
  }'
```

## Route IDs And Scopes

| routeId | Path | Accepted scopes |
| --- | --- | --- |
| `sdk.oauth.token` | `/internal/v1/sdk/oauth/token` | password 可经可信 HTTPS bootstrap；client_credentials 仅限 Internal |
| `sdk.identity.introspect` | `/internal/v1/sdk/identity/introspect` | `sdk.identity.read` or `auth.read` |
| `sdk.users.password.self` | `/internal/v1/sdk/users/me/password` | active user Bearer + current password |
| `sdk.users.password.update` | `/internal/v1/sdk/users/{userId}/password` | `sdk.user.write` or `rbac.manage` |
| `sdk.identity.context` | `/internal/v1/sdk/identity/context` | `sdk.identity.read` or `auth.read` |
| `sdk.gateway.access.evaluate` | `/internal/v1/sdk/gateway/access/evaluate` | `sdk.identity.read` |
| `sdk.roles.list` | `/internal/v1/sdk/roles` | `sdk.user.read` or `rbac.manage` |
| `sdk.users.list` | `/internal/v1/sdk/users` | `sdk.user.read` or `rbac.manage` |
| `sdk.users.create` | `/internal/v1/sdk/users` | `sdk.user.write` or `rbac.manage` |
| `sdk.permissions.request` | `/internal/v1/sdk/permissions/requests` | `sdk.permission.request` or `permission.request` |
| `sdk.config.snapshot` | `/internal/v1/sdk/config/snapshot` | `sdk.config.snapshot`, `sdk.identity.read`, or `auth.read` |
| `sdk.dns.*` | `/internal/v1/sdk/dns/*` | `sdk.dns.evaluate` or `network.dns.policy` |
| `sdk.releases.list/get` | `/internal/v1/sdk/releases[/{planId}]` | `sdk.release.read`, `sdk.release.publish`, `sdk.release.approve`, or `release.manage`；另校验 `allowedProductIds` |
| `sdk.release_artifacts.get` | `/internal/v1/sdk/releases/artifacts/{artifactId}` | `sdk.release.read`, `sdk.release.publish`, `sdk.release.approve`, or `release.manage`；另校验 `allowedProductIds` |
| `sdk.release_artifacts.upload` | `/internal/v1/sdk/releases/artifacts` | `sdk.release.publish` or `release.manage`；另校验 `allowedProductIds` |
| `sdk.releases.create` | `/internal/v1/sdk/releases` | `sdk.release.publish` or `release.manage`；另校验 `allowedProductIds` |
| `sdk.releases.gate` | `/internal/v1/sdk/releases/{planId}/gate` | `sdk.release.approve` or `release.manage`；另校验 `allowedProductIds` |
| `sdk.audit.write` | `/internal/v1/audit/events` | `sdk.audit.write` |
| `sdk.observability.logs` | `/internal/v1/observability/logs` | `sdk.observability.write` or `observability.write` |

`GET/POST /internal/v1/sdk/service-accounts` 与
`POST /internal/v1/sdk/service-accounts/{serviceAccountId}/credentials/rotate`
属于 `x-mx-ops-token` 管理面，不接受产品 Bearer，也不会出现在 SDK Gateway manifest。
它们仍记录在在线 API 文档中，供 Internal 管理员开通和轮换集成凭据。
