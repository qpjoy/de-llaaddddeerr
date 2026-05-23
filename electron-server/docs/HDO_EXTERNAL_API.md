# HDO External API Plan

本文规划 HDO 后台给第三方系统调用的权限模型和 API 边界。当前代码已经有
`/api/v1/hdo/*` 和 `/api/v1/hdo/admin/*`，但主要面向 Electron 市场登录态和
管理员面板。后续对外开放时，不建议让外部系统直接持有用户 session JWT。

## Goals

- 允许外部系统管理用户、mesh 组、许可、设备和服务目录。
- 允许 CI、运维平台或企业后台发放一次性 Internal/Linux 入网命令。
- 所有写操作都有明确 scope、审计记录和可撤销 token。
- 用户 session、service token、enrollment token 分开管理。

## Token Types

`user_session`

- 现有登录态 JWT。
- 用于普通用户和管理员 UI。
- 不适合长期放在 Linux server 或第三方后台。

`service_token`

- 面向第三方系统或企业后台。
- 绑定 owner、scope、可选 mesh group、过期时间和最后使用时间。
- 适合调用用户、mesh、许可、设备任务等管理 API。

`enrollment_token`

- 一次性或短期 token。
- 只允许某台新设备注册、领取 mesh 配置、换取 agent token。
- 适合 `qp-tunnel-cli hdo enroll` 安装命令。

`agent_token`

- 入网后保存在 `/etc/qpjoy/hdo/client.json` 或后续 agent state 中。
- 只允许对应 device/node 心跳、刷新 manifest、上报状态和执行被授权任务。

## Scope Model

建议用细粒度 scope，而不是只区分 admin/user：

- `hdo:users:read`
- `hdo:users:write`
- `hdo:mesh:read`
- `hdo:mesh:write`
- `hdo:licenses:read`
- `hdo:licenses:write`
- `hdo:devices:read`
- `hdo:devices:write`
- `hdo:services:read`
- `hdo:services:write`
- `hdo:tasks:write`
- `hdo:enrollment:create`
- `hdo:audit:read`

service token 还应支持资源边界：

- `meshGroupIds`: token 只能管理指定 mesh。
- `userIds`: token 只能管理指定用户集合，或只允许企业 tenant 内用户。
- `expiresAt`: 默认必须有过期时间，长期 token 需要显式标记。

## Proposed APIs

Service token management:

```text
GET  /api/v1/hdo/admin/api-tokens
POST /api/v1/hdo/admin/api-tokens
POST /api/v1/hdo/admin/api-tokens/:id/revoke
```

Enrollment:

```text
POST /api/v1/hdo/admin/enrollment-tokens
POST /api/v1/hdo/enroll
POST /api/v1/hdo/agents/:deviceId/heartbeat
GET  /api/v1/hdo/agents/:deviceId/manifest
```

User and license management:

```text
GET  /api/v1/hdo/admin/users
POST /api/v1/hdo/admin/users
GET  /api/v1/hdo/admin/mesh-groups
POST /api/v1/hdo/admin/mesh-groups
GET  /api/v1/hdo/admin/mesh-memberships
POST /api/v1/hdo/admin/mesh-memberships
GET  /api/v1/hdo/admin/device-mesh-states
POST /api/v1/hdo/admin/device-mesh-states
```

The existing mesh membership and device mesh state tables already map well to
license semantics:

- membership = user has a license for a mesh group
- device mesh state = this device is active/disabled/kicked inside that mesh

## Rollout Order

1. Keep the MVP CLI using `--token` against the existing authenticated HDO API.
2. Add `enrollment_token` issuance in the admin API and make CLI prefer it.
3. Add `agent_token` exchange during enrollment so Linux machines stop storing
   user session tokens.
4. Add `service_token` scopes for external system management.
5. Split admin routes so each route can require either role-based auth or a
   matching service-token scope.

## Audit Requirements

Every external API mutation should write `auditStore.insert` with:

- token id / actor user id
- source IP
- action
- target kind and id
- mesh group boundary when applicable
- before/after summary for license and device state changes
