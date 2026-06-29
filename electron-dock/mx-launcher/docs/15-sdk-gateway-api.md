# SDK Gateway API

SDK Gateway 是 Internal 对外部系统开放的稳定集成面。外部系统不要直接复制
User Center、Permission Center 或 Config Center 的内部表结构；优先调用
`/internal/v1/sdk/*`。

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

1. 调用 `POST /internal/v1/sdk/oauth/token` 获取 token。
2. 调用 `POST /internal/v1/sdk/gateway/access/evaluate` 判断 token 是否可调用某个
   `routeId`。
3. 调用具体 SDK route。

当前 V1 shadow 以 gateway manifest 和 access evaluate 作为稳定契约；后续会把
Bearer header gate 收紧到每个 SDK route。

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
    "username": "admin",
    "password": "adminsj8kx1sq6xc",
    "scope": "sdk.identity.read sdk.user.read permission.request",
    "audience": "mx-sdk"
  }'
```

`username` 可以匹配 `userId`、`account`、`email`、`displayName` 或 legacy external id。
密码模式会校验 User Center 保存的 `local-password` credential；导入旧系统账号时应把
旧 `account/password/user_name` 写入 User Center，而不是继续让 Domestic 保存登录真相。

Service account 模式：

```bash
curl -sS "$BASE/internal/v1/sdk/oauth/token" \
  -H 'content-type: application/json' \
  -d '{
    "grant_type": "client_credentials",
    "client_id": "svc_sdk_gateway",
    "client_secret": "managed-by-internal",
    "scope": "sdk.identity.read sdk.user.read sdk.user.write sdk.permission.request",
    "audience": "mx-sdk"
  }'
```

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
curl -sS "$BASE/internal/v1/sdk/roles"
```

List users:

```bash
curl -sS "$BASE/internal/v1/sdk/users"
```

Create user:

```bash
curl -sS "$BASE/internal/v1/sdk/users" \
  -H 'content-type: application/json' \
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

Internal User Center 还提供批量导入接口，供平台运维把旧 HDO 或外部账号一次性导入：

```bash
curl -sS "$BASE/internal/v1/user-center/users/import" \
  -H 'content-type: application/json' \
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

导入行只要求能推导出 `account` 或 `email`；`profile`、`attributes`、`externalIds`、地址、
部门、来源系统等扩展字段都会保存到 User Center profile，供 AppCenter、DNS、H2I、
第三方系统和审计 read model 按需消费。`provisionOversea=true` 时，Internal 会在创建或更新
用户后为默认 Oversea site 生成 entitlement 和订阅运行态，后续仍可在 Admin UI 手动调整节点。

AppCenter 应用访问策略通过 app 记录保存。自定义应用不传策略时默认 private：

```bash
curl -sS "$BASE/internal/v1/app-center/apps/luopan" \
  -H 'content-type: application/json' \
  -d '{
    "appId": "luopan",
    "displayName": "Luopan",
    "launcherMode": "embed",
    "standaloneChannelProductId": "mx-h2i",
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

查询用户可见应用：

```bash
curl -sS "$BASE/internal/v1/app-center/apps?userId=usr_test&sourceAppId=luopan&includeHidden=false"
```

List service accounts:

```bash
curl -sS "$BASE/internal/v1/sdk/service-accounts"
```

Create service account:

```bash
curl -sS "$BASE/internal/v1/sdk/service-accounts" \
  -H 'content-type: application/json' \
  -d '{
    "serviceAccountId": "svc_external_system",
    "displayName": "External System",
    "roleIds": ["mx-service-account"],
    "scopes": ["sdk.identity.read", "sdk.user.read", "sdk.permission.request"],
    "requestId": "ext-svc-create-001"
  }'
```

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
| `sdk.oauth.token` | `/internal/v1/sdk/oauth/token` | public token endpoint |
| `sdk.identity.introspect` | `/internal/v1/sdk/identity/introspect` | `sdk.identity.read` or `auth.read` |
| `sdk.identity.context` | `/internal/v1/sdk/identity/context` | `sdk.identity.read` or `auth.read` |
| `sdk.gateway.access.evaluate` | `/internal/v1/sdk/gateway/access/evaluate` | `sdk.identity.read` |
| `sdk.roles.list` | `/internal/v1/sdk/roles` | `sdk.user.read` or `rbac.manage` |
| `sdk.users.list` | `/internal/v1/sdk/users` | `sdk.user.read` or `rbac.manage` |
| `sdk.users.create` | `/internal/v1/sdk/users` | `sdk.user.write` or `rbac.manage` |
| `sdk.service_accounts.list` | `/internal/v1/sdk/service-accounts` | `sdk.user.read` or `rbac.manage` |
| `sdk.service_accounts.create` | `/internal/v1/sdk/service-accounts` | `sdk.user.write` or `rbac.manage` |
| `sdk.permissions.request` | `/internal/v1/sdk/permissions/requests` | `sdk.permission.request` or `permission.request` |
| `sdk.config.snapshot` | `/internal/v1/sdk/config/snapshot` | `sdk.config.snapshot`, `sdk.identity.read`, or `auth.read` |
| `sdk.dns.*` | `/internal/v1/sdk/dns/*` | `sdk.dns.evaluate` or `network.dns.policy` |
| `sdk.audit.write` | `/internal/v1/audit/events` | `sdk.audit.write` |
| `sdk.observability.logs` | `/internal/v1/observability/logs` | `sdk.observability.write` or `observability.write` |
