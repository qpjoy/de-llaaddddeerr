# MX Insight Hub 与 MX Launcher 集成架构

本文记录从 HDO V1 到 MX-H2I V2 的边界，并定义 MX Insight Hub 的最新接入原则。目标是在不改变现有 MX-H2I 用户联网行为的前提下，把数据产品、订阅、权限、稳定 API、ETL/ELT、BI 和 Data Agent 作为独立模块纳入 Launcher 运维与用户入口。

## 1. 三代产品边界

| 系统 | 中心 | 网络/用户真相 | 在本设计中的角色 |
| --- | --- | --- | --- |
| HDO V1：`electron-demo/hdo` + `electron-server` + HDO/WireGuard plugins | Domestic | V1 用户、JWT、DNS、mesh、WG 和服务集中在 Domestic，使用 `100.*` 地址 | 线上兼容系统，不迁入 Hub |
| MX-H2I V2：`demos/mx-h2i` standalone | Internal control plane + endpoint network owner | Internal 保存用户/权限/配置/发版/DNS desired state；客户端执行并回滚 WG/route/PAC/NRPT/resolver，使用 `10.*` 地址 | 当前 Launcher 主通道，必须保持不变 |
| Luopan standalone | 独立 ProductNetwork | 独立 `10.91/16` lease 与 `10.88.100.3` service VIP；当前不拥有 PAC/2053/system DNS | 网络/权限/用户测试项目，不是 Hub runtime |
| MX Insight Hub | 独立数据产品模块 | Hub 保存 tenant、consumer、API key、grant、subscription、usage、dataset 和查询发布；不拥有系统网络 | AppCenter 私有应用 + 独立 API/data plane |

V1 `100.*` 与 V2 `10.*` 继续共存；Hub 不参与两者地址、DNS 或用户迁移。Luopan 也不能被当作 Hub 的网络 owner。

## 2. 已有安全接入点

当前代码已经提供最小薄集成：

- Launcher Server 注册 `server/src/modules/insight-hub`；
- `/internal/v1/insight-hub/overview` 在短 timeout 内读取 Hub Admin readiness/dashboard，失败归一成 offline；
- AppCenter 内建 `mx-insight-hub`，采用 `embed + private + permission grant`；
- Launcher 生命周期可以显式委托到 sibling `mx-insight-hub/scripts/manage.sh`；
- Hub 默认不随 Launcher production deploy 启动，只有显式 `MX_INSIGHT_HUB_DEPLOY=1` 才联合部署；
- Hub Admin 可选接入 Launcher opaque token introspection，并在 Hub 本地保存
  member/tenant membership；这条身份路径与 overview 使用的 service admin
  token 是两条独立链路；
- Hub 已有 PostgreSQL canonical/revision/outbox、外部 PostgreSQL 拉取 worker，
  以及 Telegram monitor 的固定数据集读取 API。

这证明运维隔离和可选的 Launcher 身份内省已经落地，但不代表 OIDC/JWKS、
共享用户库、Launcher organization 自动等同 Hub tenant，或公共 DNS/TLS 路由已经
上线。

## 3. 目标拓扑

```mermaid
flowchart LR
  U["Operator / Launcher user"] --> IAM["Launcher User Center\nlogin + org + global app scope"]
  IAM --> APP["Launcher AppCenter\nMX Insight private entry"]
  APP --> HA["Hub Admin listener\nHub tenant role + dataset policy"]

  C["Internal/external API consumer"] --> EDGE["Launcher/Domestic edge\nTLS + exact host/path route"]
  EDGE --> HP["Hub public listener\nAPI key + subscription + quota"]
  HP --> HD["Hub data/query/serving plane"]
  HD --> NF["Authenticated Night-All facade"]
  NF --> N["Host Night-All\nsingle writer/providers"]

  L["Launcher ops"] -. "bounded health/lifecycle" .-> HA
```

Launcher 只做：

- 人员/组织身份、AppCenter 可见性和全局 scope；
- K8s 生命周期、DNS/TLS 和 host/method/path 路由；
- offline-safe 健康摘要和 Admin 入口。

Hub 自己做：

- tenant membership、consumer/service app、API key；
- 平台/能力/字段/数据集授权；
- 套餐、订阅、额度、余额、幂等和 usage/billing evidence；
- Night-All/文件/未来来源接入、规范化、数据发布、查询缓存和 stale 回退；
- 用户侧稳定 API、Hub Admin、BI/Data Agent 治理。

Night-All 继续做 provider、抓取、上游凭据、source contract、raw/normalized evidence 和 provider quota。

## 4. 人员账号与影子身份

外部用户只登录 Launcher User Center，不在 Hub 再维护密码。Hub 保存的是产品授权所需的本地 member 和绑定，而不是第二套认证真相。

当前 opaque-token introspection 绑定：

```text
(trusted issuer, stable subject, hub audience)
  -> external_identity_binding
  -> Hub member
  -> tenant_membership(role, status)
```

Launcher organization/tenant ID 作为观测元数据保存，不自动创建、选择或授权 Hub
tenant。

规则：

- `sub` 使用稳定不透明 ID，不能用 email 作为身份 key；
- Launcher User Center 校验 opaque token；Hub 只信明确的 introspection contract，
  并再次核对 active user、`issuer/subject/audience`，不能只信 gateway header。若未来
  改成 JWT，再单独落地签名、`exp/nbf/kid/algorithm` 和 JWKS 轮换契约；
- Launcher 账号停用与 Hub tenant membership suspension 是两个显式生命周期；
- Hub 不复制 Launcher password/MFA/session 表，也不共享数据库；
- API consumer key 仍由 Hub 发行、hash、轮换和吊销，不由 Launcher 用户 token 替代；
- Hub Admin Token 是不受 tenant 限制的全局 break-glass/自动化凭据；当前管理台
  可以显式使用它，但它不是普通用户身份，也不能当交互式 SSO 分发。Launcher
  overview 的 service 调用和 Launcher 用户 token introspection 不能混为一条会话。

Hub 当前是多租户，而不是“登录一次只能有一个 tenant”：

- tenant 是 Hub 的独立产品授权命名空间，可以有多个；
- consumer 只属于一个 tenant，其 API key、grant、policy 和 usage 随 consumer
  归属；
- 同一 Launcher 人员可以在多个 Hub tenant 拥有不同 membership role；每次操作
  按目标 tenant 的 role 校验，不能把 A tenant 的 owner 权限合并到 B tenant；
- 新建顶层 tenant 只允许 platform admin；tenant owner 只能重命名和管理自己拥有
  的 tenant；
- Admin Token 与显式 Launcher platform-admin scope 可以管理所有 tenant。普通
  tenant 用户只看到自己有有效 membership 的 tenant。

## 5. 数据 API 路由

建议入口：

| Host | Reachability | Upstream |
| --- | --- | --- |
| `insight.mxinfo-inc.cn` | MX-H2I private | Hub Admin Service only |
| `gate.night-all.mxinfo-inc.cn` 或评审后一级私网名称 | MX-H2I private | Hub public Service only |
| 独立 `minsight-ai.com` 公共 API 名 | future public TLS | Domestic edge → WireGuard → Hub public Service |

不得创建到 Night-All `13141/18141` 的同名临时 route。公共/私有 data route 都只做粗粒度 admission；Hub 仍逐请求校验 API key、tenant、consumer、platform、dataset、quota 和 balance。

`gate.night-all.mxinfo-inc.cn` 是两级子域，普通 `*.mxinfo-inc.cn` 证书不覆盖。启用 HTTPS 前使用 exact SAN/子域 wildcard，或改成一级名称。Kibana、Elasticsearch、Hub Admin 和 Night-All 原始 route 都不进入公共 data allowlist。

### Telegram monitor 数据路径

外部程序写入的
`night_all.public.tg_monitor_chats` / `tg_monitor_messages` 不是 Hub 直接公开的
表 API。Hub 以只读 PostgreSQL 会话分批拉取，写入固定 canonical 数据集：

| Public resource | Hub dataset | 授权 |
| --- | --- | --- |
| `GET /api/v1/data/telegram/chats` | `telegram.monitor.chats.v1` | consumer 显式 `telegram` grant |
| `GET /api/v1/data/telegram/messages` | `telegram.monitor.messages.v1` | consumer 显式 `telegram` grant |

外部真实 schema 不由当前 Night-All repository migration 定义，所以 Hub migration
只把两个 source 注册成 `paused` 并创建未批准的候选 mapping。生产必须先用
Admin-only schema/3-row value-free shape preview 加 writer contract 核对稳定 ID、
timestamp watermark、复合索引、映射和数据最小化，再逐表启用 full pull。候选字段名不能写成生产事实；硬删除也不会
由当前前向游标自动传播。详细门禁见
[Telegram monitor ingestion](../../mx-insight-hub/docs/operations/telegram-monitor-ingestion.md)。

### Telegram SQLite 只读 API 数据路径

当独立采集端只在本地 SQLite 留有 PostgreSQL 故障回退数据时，Hub 通过 Admin
管理的固定 `telegram-sqlite` 管线在服务端调用 GET-only HTTP API。Token 不进入
Launcher、浏览器、MX-H2I 登录或网络配置；两个子任务分别写入
`telegram.sqlite.chats.v1` 与 `telegram.sqlite.messages.v1`，不会与现有
`telegram.monitor.*` canonical 行互相覆盖。

当前源 API 只有 `message_at DESC` 的页码分页，没有覆盖编辑、软删除和迟到回填的
单调 change cursor。因此该管线采用首次/换库时人工全量对齐，平时只按高水位做 2 小时
重叠读取，并在上海时区凌晨 02:00 后只复扫上一自然日窗口，不会定时扫描整个历史库；只把显式 `deleted_at` 当作删除，管理面必须标为
append-only 最终一致而不是精确 CDC。带删除标记的源行
仍完整进入 Hub raw、canonical 与 revision；公共 Elasticsearch 只是可重建的 current-state
投影。正文不做词汇过滤，chat/media 等结构化字段进入确定性 mapping 与专用索引，检索
投影继续优先 HanLP 并按既有链路降级。操作细节见
[Telegram SQLite read-API ingestion](../../mx-insight-hub/docs/operations/telegram-sqlite-api-ingestion.md)。

公共响应只返回严格 allowlist 的 normalized chat/message 字段和 opaque keyset
cursor，不返回 DSN、source table、raw/extensions、provider、endpoint 或
`businessId`。Hub public Service 只读 Hub 自己的 PostgreSQL，不获得 Night-All 通用
数据库路由。

这里的多租户隔离是 identity、consumer ownership、grant、quota 和 usage 的控制面
隔离，不是 Telegram 行级隔离。两个 canonical dataset 当前没有 `tenant_id`；任何
获得 `telegram` grant 的 consumer 都读取同一份完整 chats/messages corpus。若后续
要求不同 tenant 看不同子集，必须新增显式 dataset/row-scope 模型和迁移，不能从
membership 自动推导。

## 6. 绝不能影响的 MX-H2I 链路

Hub 不获得 Launcher network lease，不注册 endpoint ProductNetwork，不创建 WireGuard peer，不修改 route plan，也不拥有系统 PAC/DNS/NRPT/resolver。AppCenter 中的 `mx-insight-hub` 必须继续保持数据应用身份：不得为它新增 ProductNetwork、`launcher-network` capability、网络类 permission 或独立/复用的本机 data-plane owner；现有 `productNetworkId` 展示元数据也不能作为补注册 ProductNetwork 的理由。

以下文件和状态机属于联网红线，Hub 功能不应修改：

- `demos/mx-h2i/src/main-runtime.cjs` 的 connect/disconnect/recovery；
- `packages/electron-launcher/src/wireguard.ts`；
- `standalone-data-plane.ts`、`system-domain-proxy.ts`、`network-ownership-registry.ts`；
- `electron-plugin/packages/electron-core-wireguard`；
- Launcher Server 的 lease/route、Domestic peer sync、CoreDNS/gateway；
- HDO V1 DNS 与 `100.*` 路径。

尤其 Windows disconnect 顺序不能因为 Hub 页面或 health call 改变：保留 WG/local edge 时恢复 PAC，停止 WG，验证 route/NRPT 清理，再关闭 local edge，最后释放 ownership。Hub offline/timeout 不能插入这个状态机或阻止 teardown。

## 7. 部署隔离

- Hub 使用 sibling project、独立 namespace、ServiceAccount、Secret 和 release；
  Hub 在共享 `mx-common` PostgreSQL 实例中拥有独立 database/role，不再部署自己的
  PostgreSQL StatefulSet/PVC；
- public/admin listener 使用不同 Deployment/Service，公共路由永远不能到 admin；
- ingest/search/ES/Kibana 都是 Hub 自己的 optional workload，不加入 Launcher readiness；
- Launcher health proxy 使用短 timeout，Hub down 返回 offline summary；
- 普通 Hub 发布必须显式保持 `MX_INSIGHT_SYNC_LAUNCHER=0`，只更新 Hub namespace，
  不同步 Launcher Secret/ConfigMap，也不 rollout Launcher；
- `MX_INSIGHT_SYNC_LAUNCHER=1` 是 managed sync，而不是普通 deploy。当前实现会同步
  `mx-insight-hub-admin`/可选 Admin entrypoint，并执行
  `rollout restart deployment/mx-launcher-internal`；只能在 token/entrypoint 确有变化、
  已安排维护窗口且登录/联网回归可立即执行时使用；
- 当前 Hub `down` 只把 public/admin API 缩容为零，不停止 ingest/projector，也不停止
  PostgreSQL、Night-All 或 Launcher。验证“Hub 完全不运行”或资源隔离时，必须另外显式
  检查并缩容 worker，不能把 `down` 的成功输出当成全部 workload 已停止；
- 路由变更 additive、host-specific，可独立回滚；不修改现有 MX-H2I host/route。

### 7.1 兼容 API 发布硬门禁

本次 `/api/v1/night-all/search/raw`、`/api/v1/night-all/search/crawl`、
`/api/v1/night-all/search/user-info` 及其 Hub 聚合/缓存回退实现都属于 Hub 数据面发布；
接口兼容要求不能扩大为 Launcher 网络、身份数据库或 endpoint 系统配置变更。

| 边界 | 必须满足 | 直接拒绝发布的情况 |
| --- | --- | --- |
| Launcher 变更面 | 普通发布只变更 `mx-insight-hub` namespace，`MX_INSIGHT_SYNC_LAUNCHER=0`；发布前后 Launcher Deployment generation/ReplicaSet/Pod UID 无变化 | 普通 Hub deploy 触发 Launcher Secret/ConfigMap patch、rollout 或 migration |
| 网络 owner | Hub 只使用数据 API，不申请 lease，不写 WG/route/PAC/NRPT/resolver/ownership | 新增 Hub ProductNetwork、`launcher-network` capability、network permission 或第三个 endpoint owner |
| 端口 | Hub 生产只占 `18150` public、`18151` admin；本地 combined 模式只用 `18180`。保留 MX-H2I `17891`、`18090`、`2053`、Internal host runner `19190` 和 Domestic WG UDP `51280` | Hub 或其 sidecar/listener 占用保留端口，或把 Night-All `13141/18141` 直接暴露成平台路由 |
| Admin ingress | `18151` 只能由受控 Internal edge/Launcher 访问；edge 必须丢弃外来 `X-Forwarded-For` 并重写可信 client IP；主机防火墙是必需控制 | 仅依赖 Kubernetes NetworkPolicy 保护 `hostNetwork` Pod、允许客户端直连 `18151`，或透传任意 XFF |
| 登录隔离 | Hub Admin sign-in 对 Launcher `/internal/v1/sdk/oauth/token` 的调用有独立暴露面、速率预算和审计，不能耗尽 MX-H2I 密码登录的 source/subject bucket | Hub sign-in 压测或恶意请求能让 MX-H2I 用户收到 429/无法登录 |
| 资源隔离 | 发布前记录节点 CPU、内存、磁盘 IO 和 Launcher API P50/P95；ingest/backfill/reindex 有并发与速率上限，Launcher 保留资源余量 | ES/projector/ingest 压力导致 Launcher readiness 抖动、OAuth/Feishu/lease 超时或节点 memory/disk pressure |
| 故障隔离 | Hub、Night-All、ES、Redis 和任一平台失败只降级 Hub，Launcher 登录、租约和 endpoint 网络状态不变 | 任一 Hub 依赖进入 Launcher readiness/connect gate，或 Hub 故障触发 MX-H2I 网络修复/teardown |

Public/Admin Pod 当前使用 `hostNetwork` 并监听 `0.0.0.0:18150/18151`。NetworkPolicy
是否覆盖 host-network 流量取决于 CNI，因此它只能作为纵深控制，不能替代节点防火墙、
精确 host/method/path 路由和受控代理的 XFF 重写。尤其 Admin sign-in 会把密码认证转发到
Launcher，并与 MX-H2I 密码登录共享 Launcher 的认证限流存储；`18151` 的边界错误会直接
扩大登录可用性风险。

Hub 与 Launcher 虽不共享数据库，但当前可部署在同一控制平面节点。`mx-common`
Elasticsearch、Hub projector、ingest/backfill/reindex 的资源峰值仍可能通过 CPU、内存、
磁盘或连接数争抢间接影响 Launcher。数据库逻辑隔离不能代替节点容量和 workload 资源隔离。

生产 Night-All 继续宿主单写者，Hub 经 workload-authenticated host facade 访问。Docker full Night-All 只用于本地受控快照和解析测试，不能作为第二个生产 writer。

## 8. 故障语义

| 故障 | Launcher/MX-H2I | Hub |
| --- | --- | --- |
| Hub namespace 不存在 | 启动和联网成功；AppCenter card offline | 不可用 |
| Hub Admin down | 其他 Admin/用户/网络正常，overview 快速 offline | data public 可独立健康 |
| Hub public down | 只有 Hub data host 失败 | Admin/已发布数据存储可诊断 |
| Night-All down | MX-H2I 正常 | Hub 返回明确 fresh/stale/历史或 202/503 |
| ES/Kibana down | MX-H2I 正常 | PG 精确查询/已有数据继续，全文 degraded |
| 单一平台 down | MX-H2I 正常 | 只隔离该 capability，其他数据可用 |

任何 Hub 依赖失败都不能让 Launcher connect gate、route plan、WG、PAC、DNS 或 ownership 状态变化。

## 9. 发布顺序

1. 保持现有 overview/lifecycle 集成，验证 Hub absent/offline 不影响 MX-H2I。
2. 完成 Hub PG 权限角色、PITR、API pagination、SLO/metrics 和 Night-All workload identity。
3. 按 Telegram 运行手册验证真实 schema、水位/ID/索引和三行 shape preview；一次
   只启用一个 source，保留候选 mapping 未批准/来源 paused 的默认安全状态。
4. 在 Internal 验证已实现的 Launcher opaque-token introspection、Hub identity
   binding、多 tenant membership、登出/吊销与 Admin Token break-glass；不要把它
   宣称为 JWKS。
5. 开私网 Admin/data route，做 exact host/path、NetworkPolicy、TLS 和跨租户测试。
6. 在已实现的 Telegram GET request/unit evidence 基础上补齐 price-book、对账、
   append-only 商业账本、缓存/回退，再评审公共 API。
7. BI/Data Agent 只消费 Hub dataset/tool contract，不获得 Night-All 通用 route 或 provider credential。

## 10. 回归门槛

- 以下矩阵必须在隔离/预发布环境执行并保留机器可读证据；不能在生产通过删除 namespace、
  伪造登录攻击或无上限压测来验证：

| 场景 | 必须通过的 MX-H2I 行为 | 必须保存的证据 |
| --- | --- | --- |
| 发布前基线；Hub namespace 不存在 | guest connect、密码 staff login、飞书 login、guest → staff、reconnect、disconnect、正常退出 | Launcher `/healthz`/`readyz`、OAuth/Feishu/lease 响应，网络状态基线快照 |
| 普通 Hub deploy，`MX_INSIGHT_SYNC_LAUNCHER=0` | 上述全流程连续可用；已有 staff/guest 会话不断开 | Launcher Deployment generation/ReplicaSet/Pod UID 前后相同；Hub 仅自身 namespace 发生变化 |
| managed sync，`MX_INSIGHT_SYNC_LAUNCHER=1` | 明确认知会 rollout Launcher；旧 Pod 排空、新 Pod ready 后，密码/飞书登录、lease 和 connect 全部通过；受控的在途 OAuth/Feishu exchange 不丢失或能按既有契约安全重试 | rollout 时间线、ready endpoint、在途请求结果、登录与联网回归报告；失败则回滚并停止联合发布 |
| Hub Admin timeout/down；Hub public down | Launcher overview 快速 offline；MX-H2I 全流程和已有连接不变 | overview timeout、Launcher readiness、connect/disconnect 结果，网络状态 diff |
| Night-All、ES、Redis、单平台分别 down | 只有 Hub 对应 capability fresh/stale/202/503 语义变化；MX-H2I 登录和联网不变 | Hub 降级响应、Launcher 零 5xx/429、网络状态 diff |
| `Hub down` 后 | public/admin 为零；先确认 ingest/projector 是否仍运行。API down 与 worker 继续运行两种状态下 MX-H2I 均正常 | 各 Deployment replica/Pod 清单、节点资源、Launcher 登录/联网结果 |
| `18151` 直连、伪造 XFF、Admin sign-in 限流测试 | 非受控来源在 edge/防火墙被拒绝；Hub 尝试不能耗尽同一测试用户的 MX-H2I password subject/source bucket | 防火墙/edge 日志、Hub/Launcher 限流审计、随后 MX-H2I 成功登录；只能使用隔离测试账号 |
| ingest/backfill/reindex 与 ES 压力 | 已有连接不断开；guest/staff/飞书/lease 无超时或 5xx/429，Launcher P95 不越过发布前约定 SLO | 节点 CPU/内存/disk/conn、Pod throttling/OOM、Launcher P50/P95/错误率 |
| MX-H2I staff 在线时 Luopan connect/disconnect | MX-H2I 保持 staff；Luopan 仅拥有 `10.91/16` 与 `10.88.100.3/32`，不接管 PAC/2053 | 两个 owner、WG profile、route 和 lease 快照 |
| Windows/macOS teardown | Windows 保持 PAC → WG → route/NRPT → local edge → ownership；macOS LaunchDaemon/resolver/route 完整回滚 | 按阶段时间线与 live readback，任一步失败不得误报 idle/disconnected |

- Hub namespace absent、Hub Admin 超时、Night-All/ES/Redis down 时，MX-H2I guest/staff connect/disconnect 全部通过；
- route plan、lease、WireGuard config、PAC、NRPT、resolver、2053 listener 在 Hub 发布前后 diff 为零；
- Windows PAC → WG → route/NRPT → local edge → ownership teardown 顺序测试通过；
- macOS LaunchDaemon、supplemental resolver 和 route 回滚通过；
- HDO V1 `100.*` DNS/联网和 MX-H2I V2 `10.*` 同时通过；
- Luopan 保持独立 `10.88.100.3` VIP/`10.91/16` lease，Hub 不创建第三个本机 network owner；
- Hub AppCenter 可见性、SSO/tenant role 和 API consumer grant 是三道独立授权；
- 同一用户在 tenant A 为 owner、tenant B 为 viewer 时，不能在 B 重命名 tenant、
  新建 consumer/API key、改 grant 或成员；Admin Token/platform admin 的全局操作仍
  可用；
- Telegram source schema/preview/sync 只允许 platform admin；tenant owner 返回
  403；public chats/messages 无 `telegram` grant 返回 403，任意 `q`/raw/source
  参数返回 400；
- Telegram pull/Hub public API 的超时、失败或下线不能改变 Launcher login、
  connect/disconnect、route、WG、PAC、NRPT、resolver 或 ownership 状态；
- 公共 route 不能访问 Hub Admin、Kibana、Elasticsearch、Night-All raw/provider/credential route。

Hub 的详细数据架构位于 sibling `../../mx-insight-hub/docs/`，重点参考 [数据存储与服务](../../mx-insight-hub/docs/architecture/data-platform-storage-and-serving.md)、[增量接入与缓存回退](../../mx-insight-hub/docs/architecture/ingestion-cache-and-fallback.md)、[Telegram monitor ingestion](../../mx-insight-hub/docs/operations/telegram-monitor-ingestion.md)、[Telegram SQLite read-API ingestion](../../mx-insight-hub/docs/operations/telegram-sqlite-api-ingestion.md) 和 [`/shared_dir` 导入](../../mx-insight-hub/docs/operations/shared-directory-ingestion.md)。

## 11. 2026-08-12 Hub 管理台口径与文件源入口

- Neon Void 已在 `demos/ui-design-neon-void` 和 `mx-launcher/ui-design`
  沉淀 `qp-dropdown` 的 trigger/menu/option 规范。Hub 数据中心应使用该
  自定义 listbox，不依赖 macOS/Chromium 无法稳定换肤的原生
  `<select>` 展开层。该阶段只在 Hub 页面内复用既有样式；后续共享扩展
  见第 13 节，身份会话和 MX-H2I 网络状态机始终不在此组件范围内。
- 数据中心的“已删除记录”是 Hub PostgreSQL current truth 中
  `deleted_at IS NOT NULL` 的当前逻辑记录数，不是 Hub 物理删除次数，
  也不是 Elasticsearch delete 请求或 import-run 累计。当时的源库
  semantic probe 记录 `tg_monitor_messages` 163,401 行中 7,480 行
  `deleted_at` 非空，且均在首次采集后标记。Hub 保留 raw/revision/
  canonical 证据，只从 current search projection 隐藏 tombstone。当前源
  schema 没有已证明的 `delete_reason/deleted_by`，因此不能从 Hub 推断
  是作者、管理员、Telegram 还是 collector 对账行为。
- 当前可立即使用的文件源是 Admin Console 单文件直传：“外部数据源”
  注册 file source，上传小样预览，审核并批准版本化 mapping，再选文件
  正式导入。支持 `xlsx/xlsm` 首个工作表、`csv/tsv`、`jsonl/ndjson`
  和 `txt/md`；HanLP 在 canonical 入库后的 ES 投影阶段运行，不是文件导入
  前置条件。`/shared_dir` watcher/landing agent 仍是设计，不得将手册中的
  拟议批量命令当作已实现入口。

## 12. 2026-08-16 Data Center 分页组件

- Neon Void 设计包新增隔离命名的 `qp-pagination` 视觉契约，包含
  总记录/总页数、页码邻域与省略号、上一页/下一页、跳转输入和
  首末页 disabled 状态；`demos/ui-design-neon-void/buttons` 保留可交互样例。
- Hub Data Center 的 React `Pagination` 复用该类名与 token，但数据请求、
  Admin 授权和 ES 10,000 条直达窗口仍由 Hub 自己负责。这是纯增量
  CSS/类名合同，不改 Launcher 登录会话、Internal 配置中心或 MX-H2I
  联网状态机。

## 13. 2026-08-27 Hub 下拉框与 light theme

- Hub 所有 popup value selector 统一使用共享 React `DropdownField`，菜单
  anatomy 由 Neon Void 的 additive `qp-dropdown--searchable`、search、options、
  group、empty 和 check 类名约束。原生 `qp-select` 只保留为设计包 fallback，
  不再用于 Hub 产品控件；地区选择 dialog 和左侧导航 accordion 不属于下拉值
  选择器，不强行收窄成 popup。
- `qp-theme-neon-void-light` 是 opt-in 冷白蓝灰主题，使用适合白底可读性的深 teal，
  不改 `:root` 与 `qp-theme-neon-void` 的 dark 默认值。Hub 新浏览器默认 light，
  用户可持久切换回 dark；Chart.js 在主题变化时重新读取 tokens。
- 这次只改 Hub UI、Neon Void CSS/token 合同与 demo specimen，不改 Hub sign-in
  请求、Launcher token/session、Internal 配置、ProductNetwork、WireGuard、route、
  PAC、DNS、NRPT、resolver 或 MX-H2I ownership 状态机。共享包的 dark 合同保持
  兼容，Luopan 仅需构建/视觉回归。
