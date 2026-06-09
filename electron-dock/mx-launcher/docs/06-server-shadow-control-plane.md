# MX Launcher Server Shadow Control Plane

本文档定义一套不影响现有 Domestic 中心的影子架构：

```text
H Endpoint -> Domestic Edge -> Internal API -> Internal PostgreSQL
```

目标不是立刻替换线上 `electron-server`，而是在同一仓库中新增
`mx-launcher/server` 边界，验证一套可按站点启停模块的平台后端。Internal 运行
大多或全部服务；Domestic 运行 edge/relay/proxy/cache 的组合服务；Oversea 运行
少数 access/site-agent 服务。

## 结论

建议新起 `mx-launcher/server`，两套后端并行运行，但不要复制完整
`electron-server`。

正确定位：

- `electron-server`: 当前 Domestic 生产中心，继续稳定承载线上 HDO、市场、DNS、
  runner 和 relay 相关能力。
- `mx-launcher/server`: 新平台后端。它不是只给 Internal 跑，而是同一套镜像按
  `MX_SITE_ROLE` 和 `MX_ENABLED_MODULES` 在不同站点启用不同服务组合。
- Internal profile: 用户中心、权限、配置中心、发版灰度、artifact、
  runner-controller、审计、观测、HDO 控制面、DNS 控制面、Postgres、Elastic、
  K8s。
- Domestic profile: edge API、relay facade、H2I proxy、snapshot cache、
  observability forwarder。`runner-edge` 和 `dns-edge-cache` 作为兼容可选模块。
  Domestic 4G 内存作为中转和轻量 edge 够用，不承载
  Elastic/Postgres/K8s 主控。
- Oversea profile: access node、site-agent、runner worker、observability
  forwarder，继续围绕 `hysteria2-mihomo-stack` 提供访问能力。

这样可以做到：

- 当前线上 Domestic 架构不变。
- 新架构可以完整重部署、清库、压测、回滚。
- H 端测试包可以选择 shadow channel，不影响正式 HDO 用户。
- 后续 Internal 成熟后，再逐个 flow 迁移，而不是一次性切换。

## 不影响线上原则

影子环境必须满足以下隔离：

| 资源 | 生产 | 影子 |
| --- | --- | --- |
| Domain | 当前正式域名 | `shadow-*` 或内部测试域名 |
| Domestic container | 当前 `electron-server` | `mx-launcher/server` domestic profile |
| Internal API | 无或未启用 | `mx-launcher/server` internal profile |
| Database | 当前 Domestic PG/JSON | 新 Internal PG shadow |
| WireGuard CIDR | 当前生产网段 | 新测试网段 |
| HDO mesh/profile | 当前生产组 | 新 shadow mesh/profile |
| Runner | 当前生产 runner | dry-run 或 shadow runner |
| Artifact channel | stable | shadow/beta/dev |
| Config channel | production | shadow |
| ELK index | prod-* | shadow-* |

强制要求：

- 影子环境默认不写生产 DB。
- 影子 runner 默认 dry-run。
- 影子 H 端必须使用独立 channel 或独立 server URL。
- 影子配置快照必须带 `environment=shadow`。
- 所有跨站请求都带 `requestId`、`siteId`、`environment`、`installId`。

## 目标拓扑

```mermaid
flowchart LR
  H["H Endpoint<br/>MX Launcher shadow channel"] --> D["mx-launcher/server<br/>Domestic profile"]
  D --> R["Domestic WG Relay<br/>shadow mesh"]
  D --> I["mx-launcher/server<br/>Internal profile"]
  I --> PG["Internal PostgreSQL<br/>shadow source of truth"]
  I --> CFG["Config Center<br/>snapshot builder"]
  I --> REL["Release/Rollout<br/>task planner"]
  I --> OBS["Observability Gateway<br/>logs + audit + metrics"]
  I --> RUN["Runner Controller<br/>site jobs"]
  RUN --> O["Oversea Access Site<br/>hysteria2-mihomo-stack"]
  H --> R
  R --> ISVC["Internal Peer Services<br/>private IP endpoints"]
```

Domestic 仍是 H 端公网入口和 relay 中心。Internal 一旦获得内网固定 IP，就可以
作为 peer server 对 H 端提供私有服务能力，但 bootstrap/fallback 仍保留
Domestic Edge。

## 组件职责

### Domestic Profile

部署位置：Domestic。

职责：

- 暴露 shadow bootstrap API。
- 继续借助 Domestic 的 WireGuard relay 和 H2I 路由能力。
- 将测试 H 端请求转发到 MX Launcher Server。
- 缓存 Internal 下发的 config snapshot。
- 在 Internal 短暂不可用时给已授权测试设备返回最后有效快照。
- 上报 relay session、H2I route、边缘错误和延迟指标。

不做：

- 不保存用户中心主数据。
- 不生成最终配置策略。
- 不执行生产 runner 写操作。
- 不改变当前生产 `electron-server` 逻辑。

Domestic 只有 4G 内存时的建议：

- 可以跑 `mx-launcher/server` domestic profile。
- 可以跑 relay facade、snapshot cache、小型队列/outbox、日志转发。
- 不跑 Elastic、Postgres 主库、K8s control plane、重型 analytics。
- runner 默认限制并发和内存，重任务交给 Internal 或 Oversea site-agent。
- DNS edge cache 是可选降级模块；默认 DNS authority 放 Internal CoreDNS。

### Internal Profile

部署位置：Internal，优先 K8s。

职责：

- 接收 Domestic Edge 的 enroll、identity link、snapshot、audit、runner 请求。
- 管理 Internal PG shadow 数据。
- 生成 H 端最终配置快照。
- 管理用户中心、权限、配置中心、发版灰度、artifact、runner、审计、日志发现。
- 为管理后台提供数据大盘和运维 API。
- 逐步吸收 `electron-server` 中已验证的通用能力。

模块建议：

| Module | 说明 |
| --- | --- |
| `site-registry` | Internal/Domestic/Oversea 站点注册、能力、健康 |
| `iam` | 用户、组织、角色、权限、session、SSO |
| `identity-bridge` | 匿名 install/device 到 user 的绑定 |
| `config-center` | 配置定义、配置值、策略、快照、资源 |
| `release-center` | 发版计划、灰度、回滚、平台通知 |
| `artifact-center` | 包、hash、签名、渠道、资源 manifest |
| `runner-controller` | 远程执行任务、site-agent job、dry-run |
| `audit-center` | 安全审计、操作审计、身份链路 |
| `observability` | 日志 sink 发现、trace、metric、ELK index 策略 |
| `launcher-network-control` | HDI/H2I mesh/profile/service/dns/route 控制面 |
| `hdo-compat` | legacy HDO API and product compatibility |
| `edge-sync` | Domestic Edge cache/outbox/snapshot 同步 |

默认模块 profile：

| Site Role | Default Modules |
| --- | --- |
| `internal` | `iam`, `app-center`, `config-center`, `deploy-center`, `release-center`, `artifact-center`, `runner-controller`, `test-center`, `audit-center`, `observability`, `sdk-gateway`, `launcher-network-control`, `hdo-compat`, `dns-control`, `edge-sync` |
| `domestic` | `edge-api`, `relay-facade`, `h2i-proxy`, `snapshot-cache`, `observability-forwarder`; `runner-edge` and `dns-edge-cache` are optional compatibility modules |
| `oversea` | `access-node`, `site-agent`, `runner-worker`, `observability-forwarder` |
| `h-endpoint-dev` | `launcher-dev-api`, `observability-forwarder` |

这些默认值可以通过 `MX_ENABLED_MODULES` 覆盖。这样同一个
`mx-launcher/server` 镜像可以在 Internal 启动全量，在 Domestic 启动轻量中转，在
Oversea 启动少数访问节点能力。

### Oversea Profile

部署位置：Oversea。

职责：

- 启动 access-node/site-agent/runner-worker 少数组合服务。
- 管理本机 `hysteria2-mihomo-stack`。
- 从 Internal 或 Domestic 拉取 runner job 和 signed snapshot。
- 上报节点健康、执行结果和访问能力指标。

不做：

- 不跑用户中心、权限中心、配置中心主版本。
- 不跑 Elastic/Postgres 主库。
- 不做平台发版决策。

### Internal PostgreSQL

部署位置：Internal。

影子环境使用独立 DB 或独立实例，不和生产 DB 混用。

推荐 schema：

| Schema | 内容 |
| --- | --- |
| `common` | tenant、site、environment、device base identity |
| `iam` | user、role、permission、session |
| `launcher` | install、product、heartbeat、device task |
| `config` | definition、value、policy、resource、snapshot |
| `artifact` | release artifact、hash、signature、channel |
| `release` | rollout plan、segment、task、report |
| `runner` | job、executor、site-agent、result |
| `hdo` | mesh、profile、dns、route、service、peer |
| `audit` | immutable audit event |
| `observability` | log sink、index policy、metric summary |
| `edge` | Domestic cache state、outbox、relay session |

### H Endpoint

H 端安装 MX Launcher。测试阶段通过以下方式进入 shadow：

- shadow 安装包；
- stable 包里的 shadow server URL；
- 设备级 feature flag；
- 测试账号/组织绑定 shadow channel。

H 端职责保持简单：

- 首次匿名 bootstrap。
- 接收 Domestic relay 配置。
- 使用配置快照建立到 Internal 的私网访问。
- 登录/注册后刷新身份绑定和配置快照。
- 上报日志、状态、任务结果。

## 匿名到登录的身份链路

你提到的关键点是：Launcher 安装时已经匿名连上 Internal，并且已经下发配置。
登录或注册之后，需要把之前的行为纳入审计。

推荐模型：

```text
anonymous_principal_id -> install_id -> device_id -> user_id
```

### Anonymous Enrollment

```mermaid
sequenceDiagram
  participant H as H Endpoint
  participant D as Domestic Edge
  participant I as MX Launcher Server
  participant PG as Internal PG
  participant WG as Domestic WG Relay

  H->>D: POST /api/v1/hdo/anonymous/bootstrap
  D->>I: POST /internal/v1/enrollments/anonymous
  I->>PG: create anonymous_principal/install/device
  I->>WG: request shadow peer allocation
  WG-->>I: overlay ip + relay config
  I->>PG: create config snapshot v1
  I-->>D: signed snapshot v1
  D-->>H: bootstrap response
  H->>WG: connect relay
  H->>I: optional private health via overlay ip
```

此时审计主体不是 user，而是：

```json
{
  "actorKind": "anonymous_install",
  "anonymousPrincipalId": "anon_...",
  "installId": "inst_...",
  "deviceId": "dev_..."
}
```

### Login or Register Link

```mermaid
sequenceDiagram
  participant H as H Endpoint
  participant D as Domestic Edge
  participant I as MX Launcher Server
  participant PG as Internal PG

  H->>D: login/register with install token
  D->>I: POST /internal/v1/identity/link
  I->>PG: bind anonymous_principal/install/device to user
  I->>PG: write audit identity.linked
  I->>PG: re-evaluate policies
  I-->>D: signed snapshot v2
  D-->>H: session + snapshot v2
```

绑定后所有日志和审计都能追溯：

- 登录前：匿名 install 做了什么。
- 登录时：哪个 user 认领了这个 install/device。
- 登录后：该 user 在该 device 上做了什么。

### 审计事件字段

```json
{
  "eventId": "aud_...",
  "eventType": "identity.linked",
  "environment": "shadow",
  "siteId": "domestic-main",
  "productId": "hdo",
  "installId": "inst_...",
  "deviceId": "dev_...",
  "anonymousPrincipalId": "anon_...",
  "userId": "usr_...",
  "requestId": "req_...",
  "traceId": "trace_...",
  "ip": "203.0.113.10",
  "overlayIp": "10.70.0.23",
  "configSnapshotId": "cfgsnap_...",
  "createdAt": "2026-06-06T12:00:00Z"
}
```

## Internal Peer Server 能力

Domestic 提供 WG relay 后，Internal 可以作为固定 IP peer server 对 H 提供私网
服务能力。

设计原则：

- 首次 bootstrap 仍走 Domestic 公网入口。
- 成功连入 WG 后，H 端可以访问 Internal private API。
- private API 只做增强和加速，不作为唯一生命线。
- Domestic Edge 始终保留 fallback。

推荐 endpoint 策略：

| 阶段 | Endpoint |
| --- | --- |
| 首次安装 | Domestic public API |
| relay 配置获取 | Domestic public API |
| 登录/配置刷新 | Domestic public API，成功后可切 Internal private API |
| 大资源下载 | Domestic public 或 Internal private，按 snapshot 策略选择 |
| 日志上报 | Domestic Edge 缓冲，Internal private 可直传 |
| Internal 不可达 | Domestic 返回最后有效配置，禁止高风险变更 |

客户端配置快照中可以带：

```json
{
  "endpoints": {
    "publicBaseUrl": "https://shadow-d.example.com",
    "internalBaseUrl": "https://10.70.0.2:8443",
    "preferredAfterRelay": "internal",
    "fallbackOrder": ["domestic", "internal"]
  }
}
```

所有 Internal private API 仍必须鉴权。不要因为已经在 WG 内网就跳过 token、证书
或设备身份校验。

## 统一日志和 ELK

Elastic 可以有多个实例，但所有应用通过配置中心发现日志 sink。

### 日志链路

```mermaid
flowchart LR
  App["App / Launcher / Service"] --> Agent["Fluent Bit or OTel Collector"]
  Agent --> Edge["Domestic log buffer"]
  Agent --> Internal["Internal observability gateway"]
  Internal --> ES1["Elastic shadow"]
  Internal --> ES2["Elastic prod"]
  Internal --> S3["Object storage archive"]
```

推荐采集方式：

- 服务端容器输出 JSON logs 到 stdout。
- K8s 内用 OpenTelemetry Collector 或 Fluent Bit 采集。
- Windows/Mac Launcher 和 Service 写本地 JSON rolling logs。
- Launcher 定期批量上报关键日志，不实时上传所有 debug。
- 审计事件写 PG，同时异步投递 ELK。

### 配置中心发现日志 Sink

配置中心下发：

```json
{
  "observability": {
    "level": "info",
    "sinks": [
      {
        "kind": "otlp-http",
        "environment": "shadow",
        "url": "https://obs-shadow.internal.example.com/v1/logs",
        "batchSize": 100,
        "flushIntervalMs": 30000
      }
    ],
    "redaction": {
      "maskFields": ["password", "token", "privateKey", "authorization"],
      "hashFields": ["email", "phone"]
    }
  }
}
```

### 日志字段标准

所有平台日志至少带：

| 字段 | 说明 |
| --- | --- |
| `timestamp` | ISO 时间 |
| `level` | debug/info/warn/error |
| `environment` | prod/shadow/dev |
| `siteId` | internal-main/domestic-main/oversea-* |
| `service` | mx-launcher-server/domestic-edge/mx-launcher-desktop/mx-service |
| `productId` | hdo/tunnel/future |
| `releaseId` | 当前服务版本 |
| `configSnapshotId` | 当前配置快照 |
| `requestId` | 请求幂等和排障 |
| `traceId` | 分布式追踪 |
| `installId` | 客户端安装实例 |
| `deviceId` | 设备 |
| `anonymousPrincipalId` | 匿名主体，登录前存在 |
| `userId` | 登录后存在 |
| `overlayIp` | WG 内网 IP |
| `wgSessionId` | relay session |

### Audit 和 Log 的区别

- Audit 是业务和安全真相，必须写 PG，尽量不可变，长期保存。
- Log 是排障和观测数据，写 ELK/对象存储，允许按周期降采样和归档。
- 登录、注册、授权、配置发布、runner 执行、服务安装、提权、回滚都必须有
  audit event。

## 配置中心

配置中心是 `mx-launcher/server` 的核心模块，负责让各平台按环境发现配置、env、
日志 sink、资源和发版策略。

### 配置层级

```text
global
environment
site
tenant
product
channel
user
device
install
runtime
```

### 配置类型

| 类型 | 用途 |
| --- | --- |
| static config | 普通业务配置 |
| secret ref | 指向 Secret 管理器，不直接下发明文 |
| resource | yaml、ruleset、证书、公钥、模板 |
| endpoint discovery | API、ELK、artifact、runner endpoint |
| rollout policy | 灰度规则 |
| runtime hint | 临时开关、降级、熔断 |

### Snapshot 是唯一客户端契约

H 端、Domestic Edge、Oversea agent 都只消费最终 snapshot。

```json
{
  "snapshotId": "cfgsnap_...",
  "environment": "shadow",
  "siteId": "domestic-main",
  "productId": "hdo",
  "installId": "inst_...",
  "version": 12,
  "config": {},
  "resources": [],
  "endpoints": {},
  "observability": {},
  "release": {},
  "signatures": {}
}
```

## 发版、部署和灰度通知

这些能力应该进入 `mx-launcher/server`，因为它们是平台通用能力，不属于单个 HDO。

### Site Slot Plan 模型

Domestic 和 Oversea 作为 Internal 的插槽纳入 Deploy/Runner 管理面：

| 对象 | 说明 |
| --- | --- |
| `site-slot-plan` | Internal 为 Domestic/Oversea 生成的接入计划 |
| `site-slot-execution` | 从 plan 派生的 preflight/apply 执行清单和审批门禁 |
| `site-slot-runner-session` | 从 execution 派生的 runner 会话、step result 和远程执行门禁 |
| `site-slot-worker-job` | 从 runner session 派生的 worker/site-agent 任务包 |
| `site-slot-worker-report` | worker/site-agent 回写的 step 状态、stdout/stderr、exit code 和失败信息 |
| `site-slot-rollback-execution` | 从 failed worker report 派生的回滚执行清单和确认门禁 |
| `site-slot-rollback-report` | 回滚 worker/site-agent 回写的恢复证据和 step 状态 |
| `preflightChecks` | SSH、root、Docker、WireGuard、外网、Internal reachability 等检查 |
| `deploymentPhases` | scp bundle、host WireGuard、Docker stack、snapshot sync、slot smoke 等阶段 |
| `network.mode` | `direct`、`oversea-assisted` 或 `offline-manual` |

V1 API 包括 `POST /internal/v1/site-slots/plans`、
`POST /internal/v1/site-slots/plans/:planId/preflight` 和
`POST /internal/v1/site-slots/plans/:planId/apply`。Runner V1.1 增加
`POST /internal/v1/site-slots/executions/:runId/runner-sessions`。它生成计划、执行清单、
runner 会话和审计记录，不直接远程执行。`remote-ssh` 需要服务端开关和请求确认；真实命令
执行应由 Admin action、runner worker 或 site-agent 承接。

Worker Contract V1 增加 `/runner-sessions/:sessionId/worker-jobs` 和
`/worker-jobs/:jobId/reports`。job 是执行器输入，report 是执行器输出；两者都写审计。
Worker State Machine V1 会在 report 写入时推进 job/session 状态，并在 failed report 中
生成 rollback plan。Rollback Contract V1 继续通过
`/worker-reports/:reportId/rollback-executions` 固化回滚清单，并通过
`/rollback-executions/:rollbackExecutionId/reports` 接收回滚结果，推进 rollback execution
状态。

Admin Management API V1 是 Internal 管理面的聚合层，不属于 SDK Gateway，也不直接执行
远程命令。`GET /internal/v1/admin/dashboard` 返回平台 overview、release plan 和最近
site-slot pipeline 摘要；`GET /internal/v1/admin/site-slots/pipelines` 返回流水线时间线；
`GET /internal/v1/admin/site-slots/pipelines/:planId` 返回单条 plan、execution、runner、
worker、rollback 的完整链路。
`GET /internal/v1/admin/actions` 返回 Admin Action Policy V1：principal、required
scopes、allowed、risk、gate、confirm fields 和 body template。Dashboard 和 pipeline
summary 会附带 action hints，供 CLI/Desktop/Admin UI 展示下一步动作；真正修改远端机器、
K8s 或发版状态时仍调用原领域 API，并继续经过确认、审计、变更窗口和 worker report。
`POST /internal/v1/admin/actions/execute` 是 V1 执行桥接入口：先校验 RBAC 和确认字段，
再把上下文 action 分发到 site-slot execution、runner session、worker job 或 rollback
execution。它不新增远程 SSH 能力；`remote-ssh` 仍受服务端开关和确认字段门禁限制。

### Release Center 模型

| 表/对象 | 说明 |
| --- | --- |
| `release.plans` | 发版计划 |
| `release.artifacts` | 绑定 artifact manifest |
| `release.segments` | 灰度人群、设备、站点、渠道 |
| `release.tasks` | 下发给 H 端、Domestic、Oversea 的任务 |
| `release.reports` | 客户端和站点执行结果 |
| `release.rollbacks` | 回滚策略和记录 |

V1 管理面先落到 `release-management-plan`：

- `POST /internal/v1/release-management/plans` 聚合 Launcher/App 更新策略、E2E
  test run、gate verdict、rollback 要求和下一步动作。
- `GET /internal/v1/release-management/plans` 给 Admin 列表页使用。
- `GET /internal/v1/release-management/plans/:planId` 给详情页和审计 drill-down 使用。
- plan 只回答“是否允许进入 shadow/canary rollout”，不直接执行发布。真实执行仍要经过
  Deploy Center、Runner 和 site-agent。

### 通知方式

优先级：

1. 客户端心跳 + jitter polling，最稳，适合 Launcher。
2. Domestic Edge 长轮询或 SSE，适合管理后台和在线站点。
3. site-agent outbound pull，适合 Domestic/Oversea 部署任务。
4. 消息队列，适合 Internal 内部服务。

不要让 H 端强依赖实时推送。桌面客户端可能休眠、断网、代理异常，polling + 签名
snapshot 更稳。

### 任务下发

```mermaid
sequenceDiagram
  participant Admin as Admin UI
  participant I as MX Launcher Server
  participant D as Domestic Edge
  participant H as H Endpoint

  Admin->>I: create release plan
  I->>I: select rollout segment
  I->>I: create signed artifact/config snapshot
  H->>D: heartbeat
  D->>I: fetch tasks for install
  I-->>D: update/config task
  D-->>H: task
  H->>H: verify signature/hash
  H-->>D: report
  D-->>I: report
```

### 灰度维度

- environment: shadow/prod/dev
- channel: stable/beta/canary
- site: domestic-main/internal-main/oversea-*
- product: hdo/tunnel/future
- tenant/org
- user
- device/install
- version range
- network capability
- failure budget

## Runner 和部署

当前 Domestic 远程 runner 部署 Oversea
`docker/hysteria2-mihomo-stack` 的方式可以保留，但要纳入统一 runner contract。

### Runner Job

```json
{
  "jobId": "job_...",
  "environment": "shadow",
  "siteId": "oversea-sg-1",
  "target": "hysteria2-mihomo-stack",
  "action": "reconcile",
  "mode": "dry-run",
  "desiredState": {
    "users": [],
    "limits": [],
    "routingMode": "cn-direct"
  },
  "snapshotId": "cfgsnap_...",
  "requestId": "req_...",
  "createdBy": "usr_admin"
}
```

### 演进顺序

1. Domestic shadow runner 继续通过 SSH/脚本 dry-run。
2. Domestic shadow runner 支持 apply，但只作用 shadow site。
3. Oversea 安装 site-agent，主动 pull job。
4. 生产 runner 迁移到同一套 runner contract。

## API 契约草案

Domestic Edge 面向 H 端保留兼容：

| API | 说明 |
| --- | --- |
| `POST /api/v1/hdo/anonymous/bootstrap` | 匿名 bootstrap |
| `POST /api/v1/auth/login` | 登录 |
| `GET /api/v1/hdo/device-tasks` | 客户端任务 |
| `POST /api/v1/hdo/task-reports` | 客户端任务结果 |

Domestic Edge 调 Internal：

| API | 说明 |
| --- | --- |
| `POST /internal/v1/enrollments/anonymous` | 创建匿名 install/device |
| `POST /internal/v1/identity/link` | 登录/注册后绑定身份 |
| `GET /internal/v1/config/snapshots/:installId` | 获取最终配置快照 |
| `POST /internal/v1/audit/events` | 写审计事件 |
| `POST /internal/v1/observability/logs` | 批量日志 |
| `GET /internal/v1/release/tasks` | 获取发版/配置任务 |
| `POST /internal/v1/release/reports` | 上报任务结果 |
| `POST /internal/v1/runner/jobs` | 创建站点执行任务 |
| `POST /internal/v1/sites/heartbeat` | site-agent 心跳 |

管理后台调 Internal：

| API | 说明 |
| --- | --- |
| `GET /internal/v1/sites` | 站点列表 |
| `GET /internal/v1/installs` | 安装实例 |
| `GET /internal/v1/audit/events` | 审计查询 |
| `GET /internal/v1/config/products/:productId` | 产品配置定义 |
| `POST /internal/v1/config/publish` | 发布配置快照 |
| `POST /internal/v1/releases` | 创建发版计划 |
| `GET /internal/v1/observability/sinks` | 日志 sink 配置 |

## K8s 影子部署

Internal shadow 推荐 namespace：

| Namespace | 内容 |
| --- | --- |
| `mx-internal-shadow` | mx-launcher/server API |
| `mx-data-shadow` | postgres/redis/object storage 测试实例 |
| `mx-observability-shadow` | elastic/kibana/otel collector |
| `mx-runner-shadow` | runner-controller |
| `mx-dns-shadow` | CoreDNS zone builder 测试 |

Domestic shadow 推荐容器：

| Container | 内容 |
| --- | --- |
| `mx-launcher/server-domestic-shadow` | Domestic profile: edge API / proxy / snapshot cache |
| `wg-relay-shadow` | shadow WireGuard relay |
| `dns-edge-shadow` | shadow DNS cache/zone |
| `runner-edge-shadow` | dry-run runner executor |
| `otel-edge-shadow` | log/metric buffer |

## 配置示例

`mx-launcher/server`：

```env
NODE_ENV=production
MX_ENVIRONMENT=shadow
MX_SITE_ID=internal-main
MX_SITE_ROLE=internal
MX_ENABLED_MODULES=
DATABASE_URL=postgres://mx_shadow:***@internal-pg:5432/mx_internal_shadow
CONFIG_SIGNING_KEY_REF=secret://mx/config-shadow
ARTIFACT_BASE_URL=https://artifact-shadow.internal.example.com
OBSERVABILITY_DEFAULT_SINK=otlp-shadow
RUNNER_DRY_RUN_DEFAULT=1
```

Domestic profile：

```env
NODE_ENV=production
MX_ENVIRONMENT=shadow
MX_SITE_ID=domestic-main
MX_SITE_ROLE=domestic
MX_ENABLED_MODULES=edge-api,relay-facade,h2i-proxy,snapshot-cache,observability-forwarder
INTERNAL_API_BASE_URL=https://10.70.0.2:8443
INTERNAL_API_MTLS_CERT=/etc/mx/certs/domestic-edge.crt
EDGE_CACHE_DATABASE_URL=postgres://edge_shadow:***@localhost:5432/mx_edge_shadow
WG_RELAY_PROFILE=shadow
ALLOW_PROD_WRITE=0
```

Oversea profile：

```env
NODE_ENV=production
MX_ENVIRONMENT=shadow
MX_SITE_ID=oversea-sg-1
MX_SITE_ROLE=oversea
MX_ENABLED_MODULES=access-node,site-agent,runner-worker,observability-forwarder
INTERNAL_API_BASE_URL=https://10.70.0.2:8443
LOCAL_STACK_PATH=/workspace/docker/hysteria2-mihomo-stack
RUNNER_DRY_RUN_DEFAULT=1
```

MX Launcher shadow snapshot：

```json
{
  "environment": "shadow",
  "productId": "hdo",
  "channel": "shadow",
  "serverBaseUrl": "https://shadow-d.example.com",
  "internalBaseUrl": "https://10.70.0.2:8443"
}
```

## 安全边界

- Domestic Edge 到 Internal API 使用 mTLS。
- H 端到 Domestic 使用普通 HTTPS + install/device token。
- H 端到 Internal private API 使用 HTTPS + device token，不能只依赖 WG 内网。
- site-agent 使用 mTLS 或签名 token。
- config snapshot、artifact manifest、runner job 都要签名。
- secret 不直接进入 snapshot，只下发 secret ref 或短期派生凭证。
- 所有登录、提权、安装服务、配置发布、runner apply 都写 audit。

## 落地阶段

### Phase 0: 文档和边界

- 建立 `mx-launcher/server` 项目边界。
- 明确不复制完整 `electron-server`。
- 定义 shadow environment、site、schema、API、日志字段。

### Phase 1: Parallel Backend Skeleton

- 新建最小 `mx-launcher/server` API。
- 支持 `MX_SITE_ROLE=internal/domestic/oversea`。
- 支持 `MX_ENABLED_MODULES` 按站点启停模块。
- 连接 Internal PG shadow。
- 实现 `/internal/v1/sites/heartbeat`、`/internal/v1/config/snapshots`、
  `/internal/v1/audit/events`。

### Phase 2: Domestic Profile Shadow

- Domestic 新起 `mx-launcher/server` domestic profile 容器。
- 暴露 shadow bootstrap URL。
- 转发匿名 enroll 到 Internal API。
- 缓存 signed snapshot。

### Phase 3: Shadow H Endpoint

- MX Launcher 支持 shadow channel/server URL。
- 测试匿名 bootstrap、WG relay、Internal private health。
- 不接入生产用户。

### Phase 4: Identity Link and Audit

- 支持注册/登录后绑定匿名 install。
- 建立 audit event 表和查询。
- ELK 接入 shadow logs。

### Phase 5: Config and Release Center

- 配置中心生成 HDO snapshot。
- 发版中心生成 update/config task。
- H 端通过 heartbeat 获取任务。

### Phase 6: Runner and Oversea

- runner job dry-run 管理 `hysteria2-mihomo-stack`。
- site-agent 模式试点。
- shadow oversea access node 执行 apply。

### Phase 7: Controlled Promotion

- 选择一个非核心 flow 从 production Domestic 代理到 Internal。
- 保留回滚开关。
- 指标和审计达标后再扩大范围。

## 需要避免的坑

- 不要把 `electron-server` 整体复制到 `mx-launcher/server` 后各改各的。
- 不要让 H 端直接理解 Domestic/Internal/Oversea 的复杂策略。
- 不要在影子环境写生产 DB。
- 不要让 Internal private API 因为在 WG 内网就免鉴权。
- 不要把 ELK 当审计真相，审计真相必须进 PG。
- 不要用实时推送作为桌面客户端唯一通知方式。
- 不要一开始就把所有模块拆微服务，先做模块化单体和清晰契约。

## 推荐下一步

1. 给 `mx-launcher/server` 加最小 API 和 Postgres migration。
2. 给 Domestic 增加 `mx-launcher/server` domestic profile compose 文件。
3. 给 MX Launcher 加 `shadow channel` 配置入口。
4. 先打通 anonymous enroll -> signed snapshot -> WG relay -> Internal private
   health。
5. 再接登录绑定、审计和 ELK。
