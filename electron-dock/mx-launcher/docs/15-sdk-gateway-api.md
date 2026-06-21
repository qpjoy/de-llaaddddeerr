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
    "username": "demo-user@mx.local",
    "password": "unused-in-shadow",
    "scope": "sdk.identity.read sdk.user.read permission.request",
    "audience": "mx-sdk"
  }'
```

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
  -d "{\"token\":\"$TOKEN\",\"audience\":\"mx-sdk\",\"routeId\":\"sdk.users.list\"}"
```

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
    "email": "external-user@mx.local",
    "displayName": "External User",
    "roleIds": ["mx-user"],
    "orgIds": ["org_default"],
    "requestId": "ext-user-create-001"
  }'
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
