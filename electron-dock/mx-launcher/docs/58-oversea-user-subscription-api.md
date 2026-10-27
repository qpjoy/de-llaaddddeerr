# Oversea 用户订阅接口：下游适配契约

本文核对日期为 **2026-10-27**，依据当前工作区的 Controller、Postgres/Memory Store、类型和 Electron Launcher SDK。它描述源码行为，不表示这些接口、网关规则、站点配置或 SSH 能力已部署到某个环境。本次只补文档，不修改登录、MX-H2I 联网或服务运行行为。

统一用户创建、登录、稳定 `userId`、凭据和业务账号映射先读 [57 · 下游用户接入](57-downstream-user-integration.md)。本文中的 `userId` 始终是 **Launcher User Center 的用户 ID**，不能换成 Luopan/Hub 的本地数字账号 ID、邮箱或账号名。

## 1. 先选择接入方式

| 需求 | 使用方式 | 关键区别 |
| --- | --- | --- |
| 已登录 Launcher 的客户端获得自己的出海配置 | Bearer 调 `ensure-subscription`；确认 ready 后使用 inline YAML，必要时 Bearer 下载 `subscription.yaml` | 不把登录 token 拼入 URL；通常不需要生成公开链接 |
| Clash 等第三方客户端需要可粘贴的订阅地址 | 先确认用户订阅就绪，再 POST `subscription-link`，将返回 path 拼到已部署的 HTTPS 公网入口 | URL 本身是长期凭据，独立于用户登录 token |
| 管理端调整用户站点分配 | ops 调 POST 用户 `/oversea`，再显式 `sync-runtime` | 写入 Internal 不等于远端账号可用 |
| 保存 H2O 用户的订阅列表、模式、端口和规则 | GET/POST `/h2o/runtime-profile` | 保存配置数据；不启动本机代理、不探活、不执行 Oversea 同步 |
| 运维人员获取独立系统订阅 | `system-subscriptions` 运维接口 | 使用专门的非登录系统账号，不能当成某个用户的 entitlement |

不要把“HTTP 成功”“有 YAML”“订阅可下载”“远端同步成功”“用户当前网络可达”合并成一个状态。它们是不同层次的证据。

## 2. 地址、鉴权与 HTTP 约定

### 2.1 路径与入口

下列路径是 Internal API 路径。Base URL 由部署方提供，客户端必须能够访问该入口。管理台公网域名可访问，不代表整个 `/internal/v1/user-center/` 已对公网开放。

当前 Domestic 模板专门转发公开 token 订阅路径 `/internal/v1/oversea-subscriptions/{token}.yaml`；它不把用户中心 Bearer 订阅路径变成公开地址。第三方客户端使用部署方确认的 HTTPS 域名及返回的 path；不要猜 IP、站点域名或自行去掉 `/internal` 前缀。

`userId`、`siteId` 等路径参数须 URL 编码。请求 JSON 使用 `Content-Type: application/json`。JSON 返回体没有统一外层 `code: 200`，直接读取 `entitlement`、`ensure`、`sync`、`link` 或 `profile`。

### 2.2 权限矩阵

表中 “self Bearer” 要求 token audience 为 `mx-sdk`、仍 active、tokenKind 为 `jwt` 或 `service-token`，且 principal 是与路径 `userId` 相同的用户。只有名字包含 admin 的角色或用户名不够，最终检查的是有效 scopes。

| 接口 | self Bearer scope | 跨用户管理 Bearer | `x-mx-ops-token` 单独调用 |
| --- | --- | --- | --- |
| GET `/users/{userId}/oversea` | `oversea.subscription.ensure` | 同时有 `site-slot.manage` 和 `site-slot.execute` | 可以 |
| POST `/users/{userId}/oversea` | 不接受普通用户 Bearer | 不以该 Bearer 替代 ops | 必需 |
| POST `/users/{userId}/oversea/ensure-subscription` | `oversea.subscription.ensure` | 同时有上述两个 scope | **不可以** |
| POST `/users/{userId}/oversea/sync-runtime` | `oversea.subscription.ensure` | 同时有上述两个 scope | 可以 |
| GET `/users/{userId}/oversea/subscription.yaml` | `oversea.subscription.ensure` | 同时有上述两个 scope | **不可以** |
| GET/POST/DELETE `/users/{userId}/oversea/subscription-link` | `oversea.subscription.ensure` | 同时有上述两个 scope | 可以 |
| GET/POST `/users/{userId}/h2o/runtime-profile` | `auth.read` | 同时有上述两个 scope | 可以 |
| GET `/oversea-entitlements`；POST其 `/migrate`、`/rollout` | 不接受 | 不以该 Bearer 替代 ops | 必需，仅运维 |
| `system-subscriptions` 管理接口 | 不接受 | 不以该 Bearer 替代 ops | 必需，仅运维 |
| GET `/internal/v1/oversea-subscriptions/{token}.yaml` | 不使用登录 Bearer | 不使用管理 Bearer | 不使用；凭证在路径中 |

上表除最后一行均省略公共前缀 `/internal/v1/user-center`。配置正确的管理台 SSO 中间件可以建立受信任 Internal admin context；这不是下游可以自行设置的请求字段，也不能拿普通应用 Cookie 代替 ops 凭据。机器集成按表中明确的 Bearer/ops 方式调用。

其他细节：

- 两个管理 scope 必须同时具备；具备后不再受 self 和单项 required scope 限制，因此属于高权限凭据。
- `mx-shadow-` token 明确被拒绝。公开订阅 token 不是登录 Bearer，不能倒过来调用这些接口。
- `requestedBy` 和 `requestId` 是操作归属/追踪信息，不能授予权限，`requestId` **不是幂等键**。
- `ensure` 的 Controller 仍接收 self 用户传入 `siteIds` 和 `assignmentMode`；当前没有在这里实现“只有管理员能改变站点列表”的额外校验。下游正常刷新应省略它们，不能声称服务端已经禁止 self 调整分配。H2O 产品 UI 不提供分配按钮与 API 是否校验是两回事。
- CORS 当前配置只列出 `GET, POST, OPTIONS`。跨域浏览器直接调用 DELETE 可能预检失败；采用同源后端/BFF，不在浏览器内下发 ops token。

### 2.3 成功状态不等于 ready

这些 Controller 的 POST 没有显式 `@HttpCode(200)`，当前 Nest 默认返回 **201**；GET/DELETE 通常为 200。客户端应接受正常 **2xx** 并解析响应，不要只硬编码 200。即使某层返回 HTTP 200，`ensure.ready: false`、`sync.status: blocked/failed` 依然是未就绪状态。

当前服务启动入口对 `/internal/` 响应设置 `Cache-Control: no-store`；公开 token YAML 另外设置 `Referrer-Policy: no-referrer`。不要假定下游日志或额外代理会自动遵守这些要求。

## 3. 用户 entitlement：GET/POST `/users/{userId}/oversea`

### 3.1 GET：读取分配及同步证据

返回 `{ "entitlement": null }` 表示尚未有 entitlement；不是调用成功后自动开通。非空对象完整字段如下：

| 字段 | 类型与含义 |
| --- | --- |
| `entitlementId` | string；Internal 生成的分配记录 ID |
| `userId` | string；稳定 Launcher 用户 ID |
| `environment` | string；服务环境 |
| `service` | 固定 `hysteria2` |
| `siteIds` | string[]；该用户已分配的站点集合 |
| `accounts` | 下表中的站点账号引用数组，不包含 `authToken` |
| `status` | `active` / `disabled`；空站点分配为 disabled |
| `subscriptionPath` | 用户聚合 Bearer YAML 相对路径 |
| `createdBy`, `updatedBy` | string；操作归属 |
| `createdAt`, `updatedAt` | ISO 时间字符串；记录时间，不是连接探测时间 |

每个 `accounts[]`：

| 字段 | 类型与含义 |
| --- | --- |
| `siteId`, `username`, `accountId` | string；站点与运行账号标识 |
| `status` | 运行账号状态，通常 `active` / `paused` |
| `subscriptionPath` | 单站点账号 YAML 的 Internal 相对路径 |
| `siteSubscriptionUrl` | 按站点 subscriptionBaseUrl 生成的直接地址；不是用户公开聚合链接，也不是“已探活”的结果 |
| `runtimeSync.status` | `synced` / `pending-sync` / `no-runtime-evidence` / `disabled` |
| `runtimeSync.checkedAt` | 本次计算同步状态的时间 |
| `runtimeSync.accountUpdatedAt` | 账号运行材料更新时间 |
| `runtimeSync.lastSyncedAt` | 最近成功单账号同步或全站 configure 证据时间；可为 null |
| `runtimeSync.requiredAction` | `none` / `run-user-oversea-remote-sync`；类型也预留 `run-oversea-install-sync`，当前状态计算未主动产生此值 |
| `runtimeSync.reason` | 人可读原因；不能作为稳定机器错误码 |

同步状态来自持久化报告，**不是每次 GET 都 SSH 探测**。成功证据时间加 60 秒容差不早于账号材料更新时间时判作 synced。最新失败报告不自动抹掉更早仍满足材料时间条件的成功证据。

### 3.2 POST：创建或替换分配

仅 ops。请求字段：

| 字段 | 必需 | 行为 |
| --- | --- | --- |
| `siteIds` | 否 | 推荐 string[]。省略/null：保留已有分配；新 entitlement 才选择默认站点。显式非空数组：替换整个集合；`[]`：清空分配并置 disabled |
| `assignmentMode` | 否 | 仅 `platform-default` 有意义；明确重设为当前默认单站点，优先于 `siteIds`；默认站点不具备可服务配置时失败 |
| `requestedBy` | 否 | 操作来源；默认 `user-center` |
| `requestId` | 否 | 追踪 ID；不去重 |

Controller 也接受逗号/分号/换行分隔的站点字符串，但下游应发送数组。站点集合去重、排序。路径决定用户，body 中 `userId` 不覆盖路径。`status`、速率、有效期、流量配额、`authToken` 都不是此请求可设置的字段。

例：

```json
{
  "siteIds": ["oversea-example-a", "oversea-example-b"],
  "requestedBy": "partner-admin",
  "requestId": "partner-user-assignment-001"
}
```

响应是 `{ "entitlement": { ... } }`。副作用是保存用户 entitlement、签发/复用每站 access account、保存审计；**不远程执行同步**。账号名由站点与用户 account/email/userId 生成并归一化，下游应读取返回值，不复制命名算法。已有相同账号一般复用 authToken；重复 POST 仍更新 entitlement 时间及审计。

显式移除站点或 `siteIds: []` 只改变这份分配和之后的聚合订阅，不会由此接口删除远端账号、轮换已分发的节点密码或断开既有隧道。不能把它当成“立即收回所有已下载 YAML 的联网能力”。归档站点的账号保留 paused；普通分配更新不会重新启用已归档站点。

当前账号构建逻辑会将**非归档站点**的已有 paused access account 重新构建为 active；不要假定 ensure/upsert 对这类暂停记录完全无副作用，或把一次暂停账号作为不会被刷新触动的永久禁用边界。

### 3.3 默认站点不是固定 `oversea-main`

默认选择读取产品网络配置，优先考虑 `mx-h2i` 的显式配置；显式配置必须有未归档、带 publicHost 的站点记录。否则从未归档且有 publicHost 的站点中，按 siteId 排序优先选有 active 账号者，再选第一站；都没有时保留历史配置/`oversea-main` 兜底。

这里“可服务”仅指上述配置条件，不证明 SSH、TLS、远端 Hysteria 或用户网络已可用。尤其历史兜底可能仍无法成功同步，调用方必须继续检查实际结果，不能把默认站点存在视为 ready。显式 `assignmentMode: platform-default` 会额外拒绝不满足配置条件的默认站点。

已有用户普通刷新保留分配，即使平台默认站点改变也不自动迁移。默认站点在已分配集合中时会在渲染 YAML 中优先排列；多节点使用有顺序的 fallback 组，并非保证选中最低延迟节点。管理员批量迁移/扩展分配另有 ops `/oversea-entitlements/migrate`、`/rollout`，默认 dry-run、`confirm: true` 才写，不应塞进普通登录或刷新链路。

## 4. 必读：POST `/users/{userId}/oversea/ensure-subscription`

这是已登录下游客户端的主要入口，**必须 Bearer，不能仅用 ops token**。它按顺序完成：授权 → upsert entitlement → 可选远端同步 → 重新读同步证据 → 渲染 YAML → 汇总 ready。它不是只读“检查订阅”。

### 4.1 请求

| 字段 | 默认/约束 | 用途 |
| --- | --- | --- |
| `siteIds`, `assignmentMode` | 同第 3 节 | 普通刷新均省略；ensure 中 `siteIds` 还会过滤本次远端同步的站点 |
| `syncRuntime` | 默认 true | false 时只执行分配/渲染并回 `sync.status: skipped`，不执行 SSH |
| `confirmRemoteExecution` | 默认不确认 | 必须显式 true 才会执行本次远程账号同步；省略通常得到 blocked 报告 |
| `includeYaml` | 默认 false | true 时返回 `subscription.yaml`；含节点密码 |
| `timeoutSeconds` | 默认 180，截为整数，限制 10–600 | **每个站点** SSH 子进程超时；不等于整个 HTTP 请求超时 |
| `requestedBy` | 默认 `user-oversea-ensure` | 操作归属 |
| `requestId` | 默认生成时间戳 ID | 同步内部追踪 ID 会追加 `-sync` |

兼容字段 `ensureRuntime`、`remoteSync` 仅在前面字段为 null/未提供时参与 `syncRuntime ?? ensureRuntime ?? remoteSync`。新接入统一使用 `syncRuntime` 和 JSON boolean，不依赖兼容转换。

建议的正常请求：

```json
{
  "syncRuntime": true,
  "confirmRemoteExecution": true,
  "includeYaml": true,
  "requestedBy": "partner-desktop",
  "requestId": "partner-oversea-001"
}
```

### 4.2 完整响应字段

| 字段 | 说明 |
| --- | --- |
| `ensure.ready` | boolean；判定规则见下文 |
| `ensure.status` | `ready` / `pending-runtime-sync` / `blocked` |
| `ensure.reason` | 人可读说明，不作为错误码匹配 |
| `ensure.generatedAt` | 本次汇总时间 |
| `entitlement` | 第 3 节对象，通常非 null |
| `sync` | 第 5 节对象；跳过时为 `{status:"skipped", reports:[], generatedAt, reason:"syncRuntime=false"}` |
| `subscription` | null 或 `{path, contentType, generatedAt, yamlBytes, yaml?}` |
| `subscription.path` | Bearer YAML 路径，不包含登录 token，不能直接当第三方公开链接 |
| `subscription.contentType` | `text/yaml` |
| `subscription.generatedAt` | 渲染时间 |
| `subscription.yamlBytes` | UTF-8 字节数，不是节点数 |
| `subscription.yaml` | 只在 `includeYaml: true` 时存在，须按秘密配置处理 |

未就绪示意，省略 entitlement、报告的完整字段：

```json
{
  "ensure": {
    "ready": false,
    "status": "pending-runtime-sync",
    "reason": "Subscription YAML is renderable, but 1 account(s) still require runtime sync.",
    "generatedAt": "2026-10-27T00:00:00.000Z"
  },
  "sync": {
    "status": "blocked",
    "reports": [{
      "siteId": "oversea-example-a",
      "status": "blocked",
      "exitCode": null,
      "diagnosis": {
        "category": "gate",
        "summary": "confirmRemoteExecution=true is required",
        "gateFailures": ["confirmRemoteExecution=true is required"]
      }
    }],
    "generatedAt": "2026-10-27T00:00:00.000Z"
  },
  "subscription": {
    "path": "/internal/v1/user-center/users/usr_example/oversea/subscription.yaml",
    "contentType": "text/yaml",
    "generatedAt": "2026-10-27T00:00:00.000Z",
    "yamlBytes": 1200
  }
}
```

`ready = YAML 可渲染 && active 账号数 > 0 && 所有 active 账号 runtimeSync.status == synced`。YAML 可渲染但不满足 ready 时是 `pending-runtime-sync`；不能渲染时为 `blocked`。极端情况下无 active 节点仍可能渲染出空代理列表，所以不能仅凭有 YAML 或 reason 中的未同步数量判断成功。

`ensure.ready` 与“本次 `sync.status`”独立计算：已有合格历史成功证据时，本次 sync blocked/failed 仍可能出现 ready=true；应将本次同步失败作为诊断信息保留。ready 也不保证客户端到海外 UDP 可达、DNS 可用或本机代理已启动。

**已 disabled 的 entitlement 有一个易错边界**：正常 ensure 默认会继续尝试 sync，后者发现 entitlement 非 active 时返回 404；不能保证一定返回 2xx + blocked。若只是展示已禁用状态，用只读 GET，不反复 ensure。

## 5. POST `/users/{userId}/oversea/sync-runtime`

用户 self scope、双 scope 管理 Bearer 或 ops 均可。它要求已有 **active entitlement**，不会替调用方创建分配。

请求字段为 `siteIds?: string[]`、`confirmRemoteExecution?: boolean`、`timeoutSeconds?: number`、`requestedBy?: string`、`requestId?: string`。后两者默认 `desktop-admin` / 时间戳 ID；超时同第 4 节。此处 `siteIds` 只是同步过滤条件，不改变 entitlement；省略或空数组表示全部 active 账号。没有匹配账号时返回 2xx + `sync.status: blocked` 和原因。

响应 `{ sync, entitlement }`，`sync` 包括：

| 字段 | 说明 |
| --- | --- |
| `status` | 任一报告 failed → `failed`；否则任一 blocked → `blocked`；否则 `passed` |
| `reports` | 完整 `UserOverseaAccountSyncReport[]`，逐站报告 |
| `generatedAt` | 汇总时间 |
| `reason` | 无 active/匹配账号等情况才出现 |

每份报告全部字段：`reportId`、`userId`、`siteId`、`accountId`、`username`、`status`（passed/failed/blocked）、`exitCode`（number/null）、`command`（string/null）、`stdout`、`stderr`、`diagnosis`（object/null）、`requestedBy`、`requestId`（string/null）、`startedAt`（string/null）、`finishedAt`、`createdAt`。

`diagnosis` 是非固定结构。gate 阻断通常有 `category: gate`、`summary`、`gateFailures[]`；SSH 失败可能有分类、后续建议及 `tcpProbe`。客户端可显示筛选后的站点、status、summary，不要整段输出 command/stdout/stderr。报告中的 command 会替换 authToken 为 `<redacted>`，但不能据此认定整个诊断对象不含敏感环境信息。

执行门槛及副作用：

1. 账号 active、站点存在 active `kind=oversea` SSH profile、SSH host/本机凭据文件可用。
2. `confirmRemoteExecution: true`；`SITE_SLOT_WORKER_REMOTE_SSH` 未明确关闭。当前 helper **未设置时默认允许**，`0/false/no/off/disabled` 才关闭；某些错误提示仍写“需要 =1”，不能按提示推断默认值。
3. 在已安装的 `/opt/mx/current/hysteria2-access-stack` 或兼容路径执行 `manage.sh add-user`，使用 Internal 保存的 authToken，当前上/下行均设为 `30 Mbps`，然后验证运行容器认证。
4. 栈缺失或太旧时不会自动安装完整 Oversea，需运维运行全量 Install/Sync。运行容器不存在/材料漂移时可能执行 `manage.sh start hysteria` 启动或重建服务；因此不要在每次状态轮询时触发远程同步。
5. 每个站点顺序执行，保存同步报告及审计；返回不是异步 job，没有本接口的 jobId/status-poll URL。

### 5.1 超时、轮询与重试

- 普通状态轮询使用 GET `/users/{userId}/oversea`。该 GET 本身不会推进远端同步；配置缺失类 blocked 需要运维处理，不能靠无限轮询修复。
- 推荐下游自行设置有限等待窗口和退避，例如只读轮询 2s、5s、10s，达到产品期限后展示“等待同步/需管理员处理”。这是调用方策略，不是服务器保证的完成时间。
- 一次正在处理的 ensure/sync 超时，可能已经部分写入或仍在服务端执行。客户端取消 fetch 不等于远端 SSH 已取消，也没有回滚保证。先 GET 复查，再决定是否重试；不要并发重试同用户/同站点。
- 重复 ensure 通常复用已有 access account/authToken，省略分配字段会保留站点；但会重复写审计和可能重复 SSH。`requestId` 相同不会去重。显式站点列表可能覆盖管理员刚更新的分配，常规重试必须省略它。
- 401 应处理 token 失效/错误 audience；403 应修正用户或 scope；固定 gate blocked 应修复配置；不能统一解释为需要重新登录。临时网络/5xx 可有界重试，保留原有效配置和登录状态。
- 默认 180s 是单站 SSH 上限，失败后 TCP 诊断还会耗时，多站串行总时间可能更长。客户端/网关 timeout 要按站点数和部署预算设置，不能假定 195s 一定覆盖所有站点。

## 6. 三种 YAML 交付方式

### 6.1 inline YAML 与 Bearer 下载

优先在 ready 的 ensure 响应里使用 `includeYaml: true` 返回的 YAML，减少一次请求。如未包含 YAML，再 GET 返回的 `subscription.path`，仍带原用户 Bearer。路径须限定在最初认证的 Internal origin；SDK 也拒绝把 Authorization 发到不同 origin。

GET `/users/{userId}/oversea/subscription.yaml` 返回 `text/yaml; charset=utf-8`；通过 Bearer 授权后，目标用户非 active、entitlement 缺失/disabled、无法构建订阅时为 404。普通用户被 disabled 后，其自己的 Bearer 会先因 inactive 被拒绝为 401；管理 Bearer 访问 disabled 目标才可能进入上述 404 渲染分支。该 GET **不要求运行时已 synced**，不会替代 ensure 的就绪判定。

当前用户 YAML 为 mihomo/Hysteria2，含节点 password、用户 ID/账号/邮箱注释，默认 mixed-port 7788、DNS 1053、CN/保留内网直连规则、30 Mbps 速率提示；多个节点有 `Oversea-Auto` fallback，单节点无 Auto 层。应用该配置可能影响本机端口与路由，应沿用现有 Launcher/H2O 的配置应用流程，不直接覆盖共享 MX-H2I 实例。

### 6.2 GET/POST/DELETE `subscription-link`

同一个用户的公开聚合链接属于独立凭据：audience=`mx-oversea-subscription`、scope=`oversea.subscription.read`；新链接有效期固定 **3650 天**，当前接口没有自定义 TTL 字段。

独立凭据不表示免受账号安全操作影响：当前专用用户改密/管理员重置密码流程 `updateUserCenterPassword` 会撤销该用户全部未撤销的 `iam-token`，没有排除公开订阅 audience。因此通过这些接口改密后，原第三方订阅链接也失效，需在重新认证后重新签发；不能向用户保证链接一定可用 3650 天。单独撤销订阅链接则不会反向注销登录会话。

**POST** body 仅消费可选 `requestedBy`、`requestId`。返回全部字段：

```json
{
  "link": {
    "path": "/internal/v1/oversea-subscriptions/mx-v1-<本次随机值>.yaml",
    "token": "mx-v1-<本次随机值>",
    "tokenId": "tok_<记录标识>",
    "issuedAt": "2026-10-27T00:00:00.000Z",
    "expiresAt": "2036-10-24T00:00:00.000Z",
    "note": "Copy this URL now; only its metadata is retrievable afterwards."
  }
}
```

示例占位值不可直接使用。每次 POST 都生成新 token，并吊销该用户此前未吊销的公开订阅链接。Store 保存 hash，明文只在这次响应返回；返回的是 `path` 而不是完整 `url`。签发链接不要求 entitlement 已就绪，也不自动 ensure；建议先确认 ready 再签发，避免生成一个只能返回 404 的链接。

**GET** 仅返回 `{ "link": { "issuedAt": "...", "expiresAt": "..." } }` 或 `{ "link": null }`，没有 token/path/tokenId，不能取回丢失的链接。它也不是链接可下载探测：比如用户 disabled 后，元数据仍可能存在，而公开下载会拒绝。

**DELETE** 返回 `{ "revoked": 1 }`，值是本次吊销记录数；重复删除通常为 0。它吊销的是公开订阅链接，不是登录 token，不影响 Bearer 方式读取或当前 H2O 会话。

不要把 POST 当成“每次页面加载获取链接”：它是轮换操作。响应丢失时无法通过 GET 恢复明文，再 POST 会再次轮换；同用户轮换调用也应串行处理，当前实现没有按 requestId 去重或对整个轮换过程提供并发幂等保证。

### 6.3 公开 token 路径

GET `/internal/v1/oversea-subscriptions/{token}.yaml` 无 Authorization 要求，token 路径即凭证。有效用户链接读取当前 entitlement，因此之后调整分配会反映在后续下载中。无效、过期、吊销、所属用户不 active 或订阅不可渲染均为 404，不区分是否曾存在。

此接口不会同步运行账号，也不以 synced 为下载前提。用户链接不支持通过 `?bandwidth=` 改速率；该参数仅属于运维系统聚合 token 分支。不要把登录 Bearer 放入 `?token=` 或 path，也不要把 token URL 作为普通公开资源。

撤销链接只阻止后续下载，不会收回第三方客户端已经缓存的 YAML/节点密码，不保证终止现有连接。需要远端账号失效的场景必须另行按运维流程处理。

`accounts[].subscriptionPath` 还是另一种单站点入口 `/internal/v1/site-slots/{siteId}/subscriptions/hysteria2/{username}.yaml`。当前普通账号分支在 Controller 内没有用户 Bearer 校验，路径可返回该账号 YAML；它不提供用户聚合链接的独立可轮换 token 语义。新下游优先选择 Bearer 聚合下载或 `subscription-link`，不要将普通单站点路径当作无敏感性的元数据公开。系统专用 `*-subscriptions` 账号分支另有严格 Basic 和部署证据检查，不能推而广之到所有账号路径。

## 7. H2O runtime profile

GET/POST `/users/{userId}/h2o/runtime-profile` 使用 self `auth.read`、双管理 scope 或 ops。路径强制 `appId: h2o`，body 中其他 appId 不生效。一个用户的这份配置由 Internal 持久化，不按设备分别存储；没有 revision/CAS 字段，并发全量保存应由调用方协调。

GET 返回 `{ "profile": null }` 或以下结构；POST 返回保存后的同结构：

| 字段 | 请求/响应及规范 |
| --- | --- |
| `profileId`, `userId`, `appId` | 响应；appId 固定 h2o |
| `mode` | 请求可选；输出 `app-rule` / `app-global` / `system-tun`。`rule`→app-rule，`global`/`direct`→app-global，`tun`→system-tun；未知值→app-global |
| `activeSubscriptionId` | 可选 string/null；列表非空时返回实际选中条目 ID；空列表时可能保留请求 ID，须以 activeSubscription 非 null 判断是否有可用条目 |
| `activeSubscription` | 可选订阅对象，输出 object/null；不能仅靠它创建一个不在 subscriptions 列表里的条目 |
| `subscriptions` | 可选数组；省略保留旧值，`[]` 清空；按规范化 id 去重，最多 24 条 |
| `ports` | 可选对象；仅保留 mixed/dns/controller/admin，默认 23458/1053/23457/23456；整数 1–65535，非法用默认。传入部分对象时其余端口回默认，不是逐字段继承旧值 |
| `rules` | 可选对象数组；省略保留，`[]` 清空；当前没有更强业务 schema 校验 |
| `requestedBy`, `requestId` | 请求可选；updatedBy 默认 mx-h2i-h2o；requestId 追踪用途 |
| `createdBy`, `createdAt`, `updatedBy`, `updatedAt`, `requestId` | 响应审计元数据 |

`subscriptions[]` 完整字段：

| 字段 | 规范/默认 |
| --- | --- |
| `id` | 归一化为安全小写 ID；未给时由 URL 生成 custom ID |
| `name`, `url` | URL 必须 http/https，否则条目被丢弃；name 默认 URL |
| `nodes`, `latencyMs`, `yamlBytes` | 非负整数，否则 0；为保存值，不由此 API 测量 |
| `status`, `source` | 默认 ready/custom；为保存值，不代表服务器确认可用 |
| `requiresUser`, `assignable` | 前者只有 true 才为 true；后者只有 false 才为 false |
| `entitlementId`, `syncStatus`, `errorMessage`, `pinnedAt` | string/null |
| `siteIds` | 去重 string[] |
| `auth` | `{type:"basic", username, password}`；其他 type 规范成 `{type:"none",username:null,password:null}` |
| `headers` | string 字典；可能含秘密，不会自动替调用者剔除 Bearer |
| `lastUpdatedAt` | 未给时生成当前时间 |

示例保存空配置，不创建订阅、不启动代理：

```json
{
  "mode": "app-rule",
  "subscriptions": [],
  "ports": { "mixed": 23458, "dns": 1053, "controller": 23457, "admin": 23456 },
  "rules": [],
  "requestedBy": "partner-desktop",
  "requestId": "partner-h2o-profile-001"
}
```

此 API 会保存并返回 basic 密码、headers 等传入数据；它不是凭据保险库，也不是自动脱敏接口。下游不要将登录 accessToken 保存进 `headers`/`rules`，不要默认输出整个 profile。这里只持久化用户配置，实际本机代理应用、端口冲突处理、连通性验证由既有运行模块负责。

## 8. 可复用调用示例

以下示例由可信后端/本机进程执行，预先安全设置 `MX_INTERNAL_ORIGIN`、`MX_USER_ID`、`MX_USER_ACCESS_TOKEN`；均须来自目标环境和本次登录。命令不获取密码或发起登录，前置流程见文档 57。不要开 `set -x`、`curl -v/--trace`；响应和头文件仅存入权限受限临时目录，示例只打印筛选后的状态。

```bash
set -e
umask 077
work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
printf 'Authorization: Bearer %s\n' "$MX_USER_ACCESS_TOKEN" > "$work_dir/user.headers"
user_path="$(jq -rn --arg value "$MX_USER_ID" '$value|@uri')"
user_api="${MX_INTERNAL_ORIGIN%/}/internal/v1/user-center/users/$user_path"

# 只读：不存在时 entitlement 为 null，不会自动签发账号。
curl --silent --show-error --fail-with-body \
  --header @"$work_dir/user.headers" \
  "$user_api/oversea" --output "$work_dir/entitlement.json"
jq '{status:.entitlement.status,sites:.entitlement.siteIds,
     runtime:[.entitlement.accounts[]?|{siteId,status,runtimeSync}]}' \
  "$work_dir/entitlement.json"

# 正常开通/刷新：会做远端同步。示例 210s 仅是单站调用方预算，多站需调整。
curl --silent --show-error --fail-with-body --max-time 210 \
  --header @"$work_dir/user.headers" --header 'Content-Type: application/json' \
  --data '{"syncRuntime":true,"confirmRemoteExecution":true,"includeYaml":true,"requestedBy":"partner-adapter","requestId":"partner-oversea-001"}' \
  "$user_api/oversea/ensure-subscription" --output "$work_dir/ensure.json"
jq '{ensure, syncStatus:.sync.status,
     sites:[.sync.reports[]?|{siteId,status,exitCode}]}' "$work_dir/ensure.json"

# 只有 ready 才将 YAML 交给现有应用配置流程；不将 YAML 打印到终端。
if jq -e '.ensure.ready == true and .ensure.status == "ready"' "$work_dir/ensure.json" >/dev/null; then
  jq -er '.subscription.yaml | select(type=="string" and length>0)' \
    "$work_dir/ensure.json" > "$work_dir/subscription.yaml"
fi
```

若选择 `includeYaml: false`，ready 后使用 Bearer 下载到文件：

```bash
curl --silent --show-error --fail-with-body \
  --header @"$work_dir/user.headers" --header 'Accept: text/yaml' \
  "$user_api/oversea/subscription.yaml" --output "$work_dir/subscription.yaml"
```

只重试已存在 entitlement 的单站同步时，以下 `siteIds` 仅过滤同步，不重设分配：

```bash
curl --silent --show-error --fail-with-body --max-time 210 \
  --header @"$work_dir/user.headers" --header 'Content-Type: application/json' \
  --data '{"siteIds":["oversea-example-a"],"confirmRemoteExecution":true,"timeoutSeconds":180,"requestedBy":"partner-adapter","requestId":"partner-oversea-sync-002"}' \
  "$user_api/oversea/sync-runtime" --output "$work_dir/sync.json"
```

需要第三方链接时才签发/轮换，响应文件含秘密；拼接后的 URL 交给用户选择的客户端或安全存储，不写普通日志：

```bash
curl --silent --show-error --fail-with-body \
  --header @"$work_dir/user.headers" --header 'Content-Type: application/json' \
  --data '{"requestedBy":"partner-adapter","requestId":"partner-link-001"}' \
  "$user_api/oversea/subscription-link" --output "$work_dir/link.json"

# MX_PUBLIC_SUBSCRIPTION_ORIGIN 是部署方确认可转发该路径的 HTTPS 域名。
jq -er --arg origin "${MX_PUBLIC_SUBSCRIPTION_ORIGIN%/}" \
  '$origin + .link.path' "$work_dir/link.json" > "$work_dir/subscription-url.txt"

# 元数据读取不会重新签发，也取不回明文链接。
curl --silent --show-error --fail-with-body --header @"$work_dir/user.headers" \
  "$user_api/oversea/subscription-link" --output "$work_dir/link-metadata.json"

```

下面是单独的撤销操作，不接在签发流程后自动执行；只在用户明确要撤销该公开链接时调用，不会撤销其登录会话：

```bash
curl --silent --show-error --fail-with-body --request DELETE \
  --header @"$work_dir/user.headers" \
  "$user_api/oversea/subscription-link" --output "$work_dir/revoked.json"
```

以上每个命令需要检查退出码后再继续依赖步骤。生产实现更适合使用受控 HTTP 客户端、持久化受保护配置、显式的错误分支。

管理端单独修改分配的写法（`MX_INTERNAL_OPS_TOKEN` 只存在可信后端；不会执行远端同步）：

```bash
printf 'x-mx-ops-token: %s\n' "$MX_INTERNAL_OPS_TOKEN" > "$work_dir/ops.headers"
curl --silent --show-error --fail-with-body \
  --header @"$work_dir/ops.headers" --header 'Content-Type: application/json' \
  --data '{"siteIds":["oversea-example-a"],"requestedBy":"partner-admin","requestId":"partner-assign-001"}' \
  "$user_api/oversea" --output "$work_dir/assigned.json"
```

读取 H2O profile，然后按用户选择只更新模式；这里省略 subscriptions/ports/rules，保留旧值，初次记录则使用默认值：

```bash
curl --silent --show-error --fail-with-body --header @"$work_dir/user.headers" \
  "$user_api/h2o/runtime-profile" --output "$work_dir/profile.json"
curl --silent --show-error --fail-with-body \
  --header @"$work_dir/user.headers" --header 'Content-Type: application/json' \
  --data '{"mode":"app-rule","requestedBy":"partner-desktop","requestId":"partner-profile-001"}' \
  "$user_api/h2o/runtime-profile" --output "$work_dir/profile-saved.json"
```

该示例要求用户 token 另外包含 `auth.read`；只有 `oversea.subscription.ensure` 的窄 token 不足以调用 profile。

### 8.1 Electron Launcher SDK

包源码 `packages/electron-launcher/src/oversea.ts` 导出的 `ensureElectronLauncherUserOverseaSubscription` 已处理 Bearer、URL 编码、同 origin 下载、响应 userId 核对和诊断投影：

```ts
const result = await ensureElectronLauncherUserOverseaSubscription({
  baseUrl: internalOrigin,
  userId: launcherUserId,
  accessToken: launcherAccessToken,
  requestedBy: 'partner-desktop',
  requestId: operationId,
  signal: abortController.signal
});
if (result.ready && result.status === 'ready' && result.subscription) {
  // 用现有 Launcher/H2O 配置流程应用 result.subscription.yaml。
}
```

函数默认发送 `syncRuntime:true, confirmRemoteExecution:true, includeYaml:true`；未传非空 `siteIds` 就不发送站点字段。它只做一次请求，不自动轮询或重试；timeoutMs 默认 195000，每次 fetch/读取 response body 都受超时限制，ready 但未收到 inline YAML 时另做同 origin Bearer 下载。输入没有 `timeoutSeconds`、`assignmentMode` 或公开链接签发选项。

输出为 `ready/status/reason/generatedAt/entitlementId/entitlementStatus/siteIds/syncStatus/syncSites/subscription`。`syncSites` 仅保留 siteId/status/category/summary/gateFailures/exitCode，避免转发 command/stdout/stderr。即使 `subscription` 有 YAML，也必须同时检查 ready；非 2xx、非 JSON、响应用户不匹配会 throw。下游已安装包版本是否包含此 helper，需核对实际 lockfile/产物，不能仅凭当前仓库源码判断。

## 9. System subscriptions：单独的运维能力

这些接口全部要求 ops（或受信任管理台上下文），不能在普通用户注册/登录/ensure 中自动调用。系统目录中的 `Subscriptions` 是固定、不可登录的系统入口，不是普通用户或可代登录账号。

| 方法与路径（前缀 `/internal/v1/user-center`） | 请求/响应 | 副作用与边界 |
| --- | --- | --- |
| GET `/system-subscriptions` | `{catalog}`；含 account、aggregate、subscriptions、summary、generatedAt | 返回掩码 URL/状态，不返回明文 authToken；含站点/SSH/部署证据聚合 |
| POST `/system-subscriptions/ensure` | 可选 siteIds/requestedBy/requestId；`{ensure:{status,accounts,missingSiteIds,nextAction},catalog}` | 仅签发/复用专用运行账号；不远端部署。siteIds省略/空数组选全部 active 站点；未知项进入 missingSiteIds |
| POST `/system-subscriptions/sites/{siteId}/reveal` | `{subscription:{subscriptionId,siteId,url,urls:{directIp,domain},note}}` | 必须该站点 catalog ready；返回含 Basic 用户名/密码的 URL，仅明确展示时调用；domain 可为 null |
| POST `/system-subscriptions/subscription-link` | `{link:{path,url,issuedAt,expiresAt}}` | 生成系统聚合 token 并替换旧链接；需要 active 的 HTTPS Domestic 域名配置；与用户公开链接不是同一种归属 |
| DELETE `/system-subscriptions/subscription-link` | `{revoked:true}` | 吊销系统聚合链接，不调整用户 entitlement |

系统 catalog ready 比用户 `runtimeSync.synced` 检查更严格：需要专用 active 账号、对应当前运行材料的最新 Oversea plan、真实非 dry-run remote job/worker 成功证据、主机未漂移、TLS fingerprint 等；创建账号不等于通过这些检查。缺失时先按运维 Install/Sync 流程处理。

专用账号单站点域名路径需要 `Basic subscriptions:<该站点 active authToken>`；Bearer/ops 不能代替 Basic 下载。直接 IP URL 的协议、端口及密码来自 reveal，不手工拼造。系统聚合 token 也使用 `/internal/v1/oversea-subscriptions/{token}.yaml`，但服务端走独立 publication 分支，返回运维手选配置；其 `bandwidth` 查询参数和用户订阅无关。不要把系统共享凭据发给普通用户来规避权限或同步失败。

## 10. 错误、日志与验证清单

| 结果 | 当前来源与处理 |
| --- | --- |
| 401 | 缺 Bearer、shadow、token inactive/类型不符；或 ops-only 接口凭据错误。恢复相应授权，不盲重建用户 |
| 403 | 用户不匹配/非 user principal 且无双管理 scope；缺 required scope |
| 404 | sync 缺 active entitlement；YAML 不可渲染；公开链接无效等。查询状态并区分入口/用户，不统一当成 API 未部署 |
| 2xx + ready=false / sync blocked/failed | 已处理请求但业务未就绪；按站点诊断继续，不能标记已可用 |
| 400 | 明确 BadRequest，例如系统链接缺 HTTPS Domestic 域名、系统 reveal 未 ready、系统 bandwidth 参数非法 |
| 503 | ops-only 接口服务端未配置 ops 验证；`/readyz` 未通过；其他依赖可用性问题按实际响应处理 |
| 500/网关 5xx/超时 | 若 Store 抛普通 Error 而该 Controller 未映射，Nest 可能返回通用 500；此处不存在统一稳定业务 code 契约。保留脱敏 requestId、HTTP 状态，按读后重试策略处理 |

特别是 entitlement upsert、ensure、profile upsert、用户链接签发没有统一捕获并把所有 `User not found`/默认站点异常转换为 400/404；下游不得写死“用户不存在必然 404”。典型 Nest 错误结构是 `{statusCode,message,error}`，代理错误还可能不是 JSON。

推荐日志字段只有：脱敏的用户/站点标识、operation/requestId、HTTP 状态、ensure.status/ready、sync.status、耗时、筛选后的诊断类别。**不要记录** Authorization、ops token、公开 token URL 完整路径/Referer、link 响应、YAML、profile 中 auth/headers、完整 command/stdout/stderr。公开订阅路径本身含秘密，网关访问日志也应使用路由模板或遮蔽 token；no-store 不会替日志系统完成脱敏。

服务健康与订阅就绪分开检查：`GET /healthz` 是进程存活；`GET /readyz` 是存储可用性门槛，首次成功前失败，成功后 60 秒容差内可能返回 `{ok:true,degraded:true,...}`，不检查用户账号/SSH/节点网络。平台 ready 不能代替 ensure ready；ensure ready 不能代替真实客户端连通性验收。

下游联调至少覆盖：

1. 正确 self、缺 scope、跨用户、失效 Bearer、ops-only 与 Bearer-only 差异。
2. 新 entitlement 默认分配、已有分配普通刷新不变、disabled 用户/分配、未知或已归档站点。
3. 无 SSH profile/未确认远程执行、单站成功、多站部分失败、超时后 GET 复查；不清除用户原登录或可用配置。
4. ready=true 才应用 YAML；inline 与 Bearer 下载相同归属；不可跨 origin 发送 Authorization。
5. 链接首次签发、GET 只能读元数据、轮换后旧 URL 404、DELETE 后 404；已缓存配置不会被本接口自动收回。
6. profile 的模式/端口归一化、空列表清除、敏感字段不入日志；system subscriptions 不混入用户流程。

## 11. 源码索引与已知契约差异

优先读取实现，再读自动 API 示例：

- [user-center.controller.ts](../server/src/modules/user-center/user-center.controller.ts)：所有本文用户路由、授权检查、ensure/sync、SSH 命令及输入转换。
- [types.ts](../server/src/types.ts)：`UserOverseaEntitlement`、`UserOverseaEntitlementAccount`、`UserOverseaAccountSyncReport`、`UserH2oRuntimeProfile`。
- [postgres.ts](../server/src/store/postgres.ts) 与 [memory.ts](../server/src/store/memory.ts)：分配保留、用户/站点锁、账号复用、同步证据、链接轮换/撤销/解析；生产持久化以实际 storeDriver 为准。
- [domain.ts](../server/src/store/domain.ts)：scope、3650 天链接、默认站点排序、runtime profile 规范化、YAML 渲染。
- [oversea.ts](../packages/electron-launcher/src/oversea.ts)：Electron SDK 请求体、195s 默认值、同 origin 下载和精简诊断。
- [system-subscriptions.ts](../server/src/modules/user-center/system-subscriptions.ts)、[site-slots.controller.ts](../server/src/modules/site-slots/site-slots.controller.ts)：系统目录证据、reveal、单站点下载分支。
- [index.ts](../server/src/index.ts)、[internal-ops-auth.ts](../server/src/lib/internal-ops-auth.ts)、[platform.controller.ts](../server/src/modules/platform/platform.controller.ts)、[readiness-gate.ts](../server/src/lib/readiness-gate.ts)：no-store/CORS、ops 和健康语义。
- [user-oversea-entitlement-assignment.test.ts](../server/src/modules/user-center/user-oversea-entitlement-assignment.test.ts)、[oversea-subscription-link.test.ts](../server/src/modules/user-center/oversea-subscription-link.test.ts)、[user-oversea-auth-smoke.ts](../server/scripts/user-oversea-auth-smoke.ts)、[oversea-ensure.test.mjs](../packages/electron-launcher/scripts/oversea-ensure.test.mjs)：已有行为用例。

现有 [api-docs.contract.ts](../server/src/modules/api-docs/api-docs.contract.ts) 某些示例仍将 `siteIds` 列成必填、H2O mode/ports 写成旧值，且 ensure 示例未显式确认远程执行。本文以当前 Controller/Store 的实际默认与归一化为准；未因编写文档改变这些接口或自动 API 合约。部署入口、实际包版本、权限配置、站点状态、网关 timeout 和线上运行证据仍需各环境单独确认。
