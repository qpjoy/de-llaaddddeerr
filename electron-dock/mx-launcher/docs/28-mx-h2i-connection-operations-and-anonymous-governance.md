# Launcher Network 多产品连接运营、MX-H2I 匿名准入与安全下线设计

> 状态：仓库当前实现基线 + 后续目标架构与分阶段实施约束。
>
> 本文定义 Launcher Network 多 standalone channel 运营工作区、按 ProductNetwork
> 管理的匿名准入策略、实时连接观测、3D 拓扑，以及未来批量下线匿名
> WireGuard peer 时必须满足的安全状态机。MX-H2I 仍是一个独立网络产品，不等于
> Launcher Network 平台本身。
> 截至 2026-08-22，Launcher Network Dashboard、静态连接表/抽屉、ProductNetwork 匿名策略、
> 产品级用户 ban/unban 与 blocked inventory 已进入仓库实现；runtime collector、真实在线
> 拓扑、peer-safe revoke、流量与端口策略仍是目标能力。实现与目标在下文分别说明。
>
> V1/V2、standalone/embed、IP 与系统网络 owner 的权威边界仍以
> [14-mx-h2i-standalone-launcher-architecture.md](./14-mx-h2i-standalone-launcher-architecture.md)
> 为准；访客与员工切换的不回归行为以
> [21-network-mode-switch-events-and-performance.md](./21-network-mode-switch-events-and-performance.md)
> 为准。

## 1. 决策摘要

本设计固定以下决策：

1. 匿名准入策略属于 standalone channel 的 `LauncherProductNetwork`，不属于 Launcher
   全局开关，也不属于 Domestic，不通过修改 AppCenter `app.enabled` 实现。
2. 正式准入字段为：
   - `anonymousEnrollmentPolicy = enabled | drain | disabled`；
   - `anonymousUiVisibility = primary | advanced | hidden`。
3. 准入与 UI 展示正交。隐藏入口不等于禁止服务端 enroll；禁止服务端 enroll 也不允许
   客户端通过旧 UI、旧版本或 CLI 绕过。
4. `mx-h2i` 的默认 UI visibility 是 `advanced`；其他 standalone ProductNetwork 默认
   `primary`，保证 Luopan 和后续应用在未显式配置时维持当前匿名体验。
5. embed 应用不拥有 endpoint lease。它们只读地继承
   `standaloneChannelProductId` 对应 ProductNetwork 的有效策略。
6. `qp-tunnel-cli h2i enroll --anonymous` 已存在；`requestedBy` 是客户端声明，不可信，
   不得用于构造 `cli-only` 安全旁路。
7. 本期切换 `disabled` 不自动删除已有 WG peer，也不把数据库 `released` 当成实际 peer
   已删除。Admin 必须明确提示仍需对账与后续受控下线。
8. 未来 bulk revoke 必须使用 `revoking` 状态、幂等 saga、Domestic/Internal 双平面确认
   和共享 public key 引用保护；不允许“一次循环 release 所有 lease”。
9. 数据库中的 active lease 不是在线证据。在线状态必须把 lease 与 WireGuard runtime 的
   endpoint、latest handshake 和 transfer 观测关联。
10. enrollment `sourceIp` 只能由服务端从可信 HTTP 请求上下文捕获，不能接受请求体伪造；
    当前 WG endpoint 应另建字段，并标为“观测到的 NAT endpoint”。
11. 产品级用户 ban 只改变指定 ProductNetwork 的 admission，并 release 该产品匹配的
    active 控制面 lease；它不禁用全局用户、不撤销用户 token，也不表示 WG peer 已移除。
12. 匿名连接没有 `userId`，当前连接抽屉不得把用户 ban 伪装成匿名单客户端封禁；匿名新
    准入使用 ProductNetwork 策略，已有 peer 的安全下线仍走后续 revoke saga。
13. Dashboard 的网络归属以 lease `productId` 为准；该字段是服务端解析后的实际
    standalone channel。`appId` 只表示请求 lease 的 app，旧记录可能缺失；
    `launcherMode` 不能用来判断是否由 embed app 发起。
14. 产品 `serviceVip` 是 channel 共享的 Internal 服务地址，不是每个用户或安装实例的
    lease IP；客户端实例拿到的是 `leaseIp`。拓扑和文案必须分开这两种地址。
15. Domestic relay fabric 和 Internal service peer 是可由多个 standalone 产品共用的
    站点基础设施；客户端 lease CIDR、产品 VIP、AllowedIPs/materialization 和策略仍按
    ProductNetwork 隔离。界面不得画成每个产品都有一套物理 Domestic/Internal。

## 2. 本期范围与明确非目标

### 2.1 仓库当前实现基线

- ProductNetwork 已保存并返回 `anonymousEnrollmentPolicy` 与
  `anonymousUiVisibility`；服务端在匿名 enrollment/renewal 边界强制执行。
- MX-H2I 默认把新建访客入口放在高级选项；员工密码、飞书登录和已连接访客的断开路径
  保持原行为。
- Desktop 左侧将连接运营入口命名为 `Launcher Network`。工作区以全部已注册
  standalone ProductNetwork 为总览，可切换 MX-H2I、Luopan 及后续 channel；产品策略和操作
  始终绑定当前选中的 `productId`。
- Dashboard 汇总静态 active lease、employee/Feishu/anonymous/source IP/blocked-user 数量，
  提供多产品静态 3D lease 路径和 table fallback；它不把它们称为实时在线客户端。
- Connections 表支持完整静态 inventory 的搜索、身份过滤和每页 100 条分页；行可打开
  连接抽屉。抽屉明确区分 HTTP source IP、数据库更新时间和尚未观测的 WG runtime。
- 员工连接抽屉可执行当前选中 ProductNetwork 范围的用户 ban/unban；被 ban 的用户保留
  在对应产品的 blocked inventory 中，即使其 active lease 已被 release，仍可从 Admin unban。
- Dashboard 的匿名快速开关写入当前选中的 standalone `productId`；选中
  MX-H2I 时只写 `mx-h2i`，选中 Luopan 时只写 `luopan`，两者不是 Launcher
  全局开关。全部产品总览不提供模糊的全局 anonymous toggle。
- 当前产品级 ban、lease release 与匿名策略切换都不会执行或确认 Domestic/Internal
  WireGuard peer removal；API 与 UI 均返回/显示该边界。

当前 Dashboard 数据仍是 Internal DB 静态记录，不是实时在线面。runtime collector、真实
handshake/RX/TX/endpoint、peer-safe revoke、细粒度敏感字段 RBAC/掩码以及流量/端口控制
仍按 §8–§12 的目标设计实施。

### 2.2 本期明确不做

- 切换 `anonymousEnrollmentPolicy=disabled` 时自动批量 release lease 或删除 WG peer。
- 因为隐藏匿名入口而断开当前已连接的访客。
- 用 `app.enabled=false`、`product.enabled=false` 或禁用 Launcher channel 代替匿名策略。
- 修改 V1 HDO、`electron-server`、`electron-plugin-hdo` 或其 `100.*` 网络。
- 让 MX Insight Hub、H2O、AppCenter 等 embed 应用拥有独立 standalone 网络 owner、
  endpoint lease 或 peer。embed registry 记录即使带有应用级 VIP 字段，也不改变其
  `broker-session` 语义。
- 立即实现客户端级限速、端口 ACL、流量计费或深度包检测。
- 把 Three.js 动画、数据库 lease 数量或 HTTP source IP 当作实时在线证明。

### 2.3 为什么下线动作必须后置

当前 Launcher Network release 语义只更新 lease 记录；它不能证明 Domestic 或 Internal
direct 上的对应 peer/AllowedIPs 已经移除。直接把“禁用匿名”与“批量删除 peer”绑定，会把
策略发布、数据库状态和远端 WG 变更压进一个不可恢复动作，并可能误删：

- 正在执行 guest → employee/Feishu handover 的旧 peer；
- 被另一个 active lease 或 handover transition 引用的 public key；
- Luopan 或其他 standalone 产品的 peer；
- 只在一个平面删除、另一个平面仍残留的半完成连接。

因此本期先建立准入、可见性、观测和 dry-run 证据；真正 bulk revoke 作为单独维护窗口功能
实施和验收。

## 3. 边界与所有权

### 3.1 V1 HDO 与 V2 MX-H2I

| 范围 | V1 HDO | V2 MX-H2I |
| --- | --- | --- |
| 主代码 | `electron-demo/hdo`、`electron-server`、`electron-plugin-hdo`、`electron-core-wireguard` | `electron-dock/mx-launcher`、`demos/mx-h2i`、Launcher packages |
| 控制中心 | Domestic 中心的用户、DNS、VPN 模型 | Internal 的用户、权限、ProductNetwork、配置和审计 |
| 地址 | `100.88/100.89/100.90/100.91` | `10.88` fabric、`10.89/16` MX-H2I lease |
| 匿名 | V1 anonymous bootstrap 与 `100.91/16` | V2 ProductNetwork anonymous profile 与 `10.89.100.1-.254.254` |
| 本文策略 | 不适用，不修改 | 仅对指定 V2 ProductNetwork 生效 |

V2 的策略发布不得写入 V1 数据表、调用 V1 anonymous bootstrap、改写 V1 DNS zone 或操作
V1 WireGuard interface/service。V1/V2 的同名“anonymous”是两套独立生命周期。

### 3.2 Internal、Domestic 与 endpoint

- Internal 保存策略、lease、用户身份、审计、revoke intent 和最终 evidence，是 desired
  state 的唯一真相。
- Domestic 负责 bootstrap/relay 和 `mx-domestic` peer materialization，不决定匿名是否
  有权 enroll。
- 可选 Internal direct 是第二个数据面；它同样不能自行放宽 Internal 的 admission。
- MX-H2I standalone endpoint 执行并恢复本机 WireGuard、route、PAC、DNS/NRPT。
- UI 只是策略编辑器和观测面；renderer 不直接 SSH、执行 `wg` 或删除远端 peer。

### 3.3 standalone 多应用

每个正式 standalone 产品拥有自己的 ProductNetwork：

| 产品 | ProductNetwork | lease 段 | 匿名策略来源 |
| --- | --- | --- | --- |
| MX-H2I | `mx-h2i` | `10.89/16` | `mx-h2i` ProductNetwork |
| Luopan | `luopan` | `10.91/16` | `luopan` ProductNetwork |
| 后续 standalone | 自己的 product id | 独立、不重叠 | 自己的 ProductNetwork |

Admin 可以在“应用”页面提供开关，但保存目标必须解析为该 standalone app 绑定的
ProductNetwork。禁止建立一个 Launcher 全局 `anonymousEnabled`，也禁止把 MX-H2I 的值
复制到所有产品。

### 3.4 embed 应用

embed 应用使用 `standaloneChannelProductId` 指向已有通道：

- 不创建独立 endpoint lease；
- 不拥有匿名地址池；
- 不显示可编辑的匿名准入开关；
- 可以显示“继承自 mx-h2i / enabled”等只读状态；
- 若需要控制匿名用户能否使用某个业务应用，应使用 AppCenter access policy、RBAC 或
  Hub tenant/grant，不应伪装成 VPN lease 策略。

MX Insight Hub 必须继续是 embed/private 数据应用：没有 ProductNetwork、WG peer、
route plan、PAC/DNS/NRPT owner。它的 API key、tenant、quota 和数据字段授权不属于本文
匿名网络策略。

### 3.5 VIP、lease 与多产品归属的精确语义

“每个 standalone launcher 有自己的 VIP/lease”需要分三层理解：

| 层 | 权威字段 | 基数 | 语义 |
| --- | --- | --- | --- |
| standalone channel | `LauncherProductNetwork.productId` | 每个正式 standalone 产品一条 | 网络策略、地址池和运行时归属边界 |
| 产品服务地址 | `LauncherProductNetwork.serviceVip` | 每个 channel 一个当前配置值 | 产品共享的 Internal control/DNS/proxy/service 地址，不属于某个用户 |
| 客户端租约 | `LauncherNetworkLease.leaseIp` | 每个 install/identity/profile 可有一条 active 记录 | 从当前 channel 的 employee/Feishu/anonymous 池分配的 overlay IP |

因此，不应说“每台 Luopan 有一个 VIP”。更准确的表述是：Luopan ProductNetwork
当前配置产品 VIP `10.88.100.3`；每个 Luopan 安装实例从 `10.91/16` 的相应
profile 池拿到 `leaseIp`。MX-H2I 对应的当前内置值是 VIP `10.88.100.1` 和
`10.89/16` lease 段。ProductNetwork 记录存在只证明 desired state 已注册；在
Domestic `productRelayCidrs`、Internal service peer 和 gateway/DNS 没有 reconcile 证据前，
Dashboard 不得声称该 VIP 已可达。

当前服务端会在 ProductNetwork upsert 时拒绝 enabled standalone 之间重叠的 lease
range，但还没有等价的跨产品 `serviceVip` 唯一性强校验。因此“每个 standalone
有自己的 VIP”是正式注册契约，不是对任意手工写入记录的已证明事实。内置
MX-H2I/Luopan 当前值相互独立；对后续产品，onboarding 和 Dashboard 应检测重复
VIP 并标为 conflict，在服务端唯一性约束落地前不宣称隔离健康。

Internal 全量 lease inventory 的归属规则如下：

| 需求 | 应使用的字段 | 不应使用 |
| --- | --- | --- |
| 列出通过 Luopan channel 获取内网 lease 的记录 | `lease.productId === "luopan"` | IP 前缀猜测、device label 文案 |
| 列出其中的登录用户 | 再限定 `identityKind === "user"`，并以 `userId` 关联 User Center | 把 anonymous install 推断成用户 |
| 区分 employee / Feishu / anonymous | `leaseProfile` | 仅根据 `leaseIp` 手工切段 |
| 区分哪个 app 发起请求 | `appId` | `launcherMode` |
| 识别 embed 借用哪个 channel | lease `productId` + AppCenter/ProductNetwork 绑定 | 为 embed 创建虚假 endpoint lease |

服务端在 enrollment 时会把 lease `productId` 规范化为实际 standalone channel；即使
请求来自绑定 Luopan 的 embed app，lease `productId` 仍是 `luopan`，`appId` 保留发起
app。旧 lease 可能没有 `appId`，此时 UI 只能标为 `legacy / requesting app unknown`，
不能回填成 MX-H2I 或 Luopan。`launcherMode` 在 lease 建立时会跟随实际 channel 模式，
因此不是 embed 请求者的可靠识别字段。

同一个已认证 Internal 用户同时拥有 MX-H2I 和 Luopan lease 时，可以用相同
`userId` 做跨产品关联。匿名 lease 没有 `userId`；`installId/deviceId` 也可能是应用内
独立生成，不得用它们将 MX-H2I 和 Luopan 的匿名记录合并成“同一人”。

Domestic/Internal 的可视化同样需要分开物理面和产品面：

- 当前主线上，MX-H2I 与 Luopan 可以共用 `mx-domestic` relay fabric、站点 Domestic
  gateway 和 `mx-internal-svc` Internal service peer；
- 每个 standalone 的 lease CIDR、service/control/DNS VIP `/32`、ProductNetwork 策略和
  客户端 WG profile 仍独立；
- shared Internal service peer 的 route/AllowedIPs 是所有已 reconcile channel 网段的并集，
  不代表这些产品共用 VIP 或 admission；
- embed app 只沿其 `standaloneChannelProductId` 所属分支显示，不另画 Domestic/Internal peer。

## 4. ProductNetwork 策略模型

### 4.1 正式字段

概念契约如下：

~~~ts
type LauncherAnonymousEnrollmentPolicy =
  | 'enabled'
  | 'drain'
  | 'disabled';

type LauncherAnonymousUiVisibility =
  | 'primary'
  | 'advanced'
  | 'hidden';

interface LauncherProductNetwork {
  productId: string;
  anonymousEnrollmentPolicy: LauncherAnonymousEnrollmentPolicy;
  anonymousUiVisibility: LauncherAnonymousUiVisibility;
  // 其他既有网络字段保持不变
}
~~~

字段命名可以在代码评审时与既有类型风格统一，但枚举语义不得合并或扩展成未经设计的
`cli-only`。

每次策略变更还应形成不可变审计记录：

- `productId`；
- before/after；
- policy revision；
- actor、actor kind；
- reason；
- requestId / idempotency key；
- changedAt；
- 变更时 active anonymous lease 数量；
- 是否执行过 dry-run；
- rollout/change-window 信息。

### 4.2 Admission 语义

| admission | 新 anonymous install | 精确续租既有 anonymous lease | 新 key/device | user/employee/Feishu |
| --- | --- | --- | --- | --- |
| `enabled` | 允许 | 允许 | 按现有约束允许 | 不受影响 |
| `drain` | 拒绝 | 仅允许 drain cohort 且 capability/identity 完全匹配 | 拒绝 | 不受影响 |
| `disabled` | 拒绝 | 拒绝 | 拒绝 | 不受影响 |

`drain` 不是“客户端自报 renewal=true”。进入 drain 时必须记录 policy revision 和 cohort。
续租资格至少同时满足：

1. lease 在 drain revision 生效前已经 active；
2. productId、installId、deviceId、public key 和 anonymous profile 完全一致；
3. 请求持有该 lease 的有效 capability；
4. lease 未 released、未 revoking，且未被管理员排除；
5. 不执行 key rotation、设备迁移或地址段迁移。

一旦 lease 被 release/revoke、丢失 capability，或不再属于 drain cohort，就不能重新获得
匿名资格。这样 drain 才能使匿名数量单调下降，而不是成为另一种公开 enrollment。

### 4.3 UI visibility 语义

| visibility | 新建匿名入口 | 已连接访客状态/断开 | 服务端 admission |
| --- | --- | --- | --- |
| `primary` | 主连接页可见 | 始终可见 | 无影响 |
| `advanced` | 仅高级选项可见 | 始终可见 | 无影响 |
| `hidden` | 不展示新建入口 | 始终可见，避免用户无法断开 | 无影响 |

visibility 只决定产品 UI 的入口位置。它不能：

- 让服务端放行被 disabled 的请求；
- 自动断开当前访客；
- 隐藏当前真实连接状态；
- 阻止 CLI 或旧客户端发请求；
- 代替 AppCenter/RBAC 的业务授权。

### 4.4 默认值与兼容读取

为避免升级影响现有联网：

- `productId=mx-h2i`：`anonymousEnrollmentPolicy=enabled`，
  `anonymousUiVisibility=advanced`；
- 其他 standalone ProductNetwork：
  `anonymousEnrollmentPolicy=enabled`，`anonymousUiVisibility=primary`；
- embed：读取 standalone channel 的 effective admission；visibility 只作为继承信息，
  embed 自身通常没有匿名连接入口；
- 历史记录缺字段时按上述 product-aware 默认值读取，不能把所有缺字段记录一律变成
  `advanced` 或 `disabled`；
- 升级 migration 只补配置，不修改任何现有 lease、peer、route 或客户端 key。

Luopan 因而继续默认 primary + enabled。关闭 MX-H2I 匿名不会影响 Luopan。

## 5. 服务端强制执行

### 5.1 决策点

服务端必须在形成或续租 anonymous lease 之前：

1. 解析请求 app 和 requested ProductNetwork；
2. 解析实际 standalone lease channel；
3. 执行既有 app/product entitlement；
4. 根据服务端认证结果确定 identityKind/profile，不能仅信请求体；
5. 对 anonymous 执行 channel ProductNetwork admission；
6. 通过后才分配地址、写 lease、生成 snapshot 或触发 peer sync。

user/employee/Feishu 请求继续走既有 token introspection、profile 和地址池约束，不经过匿名
拒绝分支。不得先统一拒绝 product，再尝试区分身份。

### 5.2 稳定拒绝语义

客户端需要可区分、可本地化且不可重试风暴的错误：

| code | HTTP 建议 | 含义 | 客户端行为 |
| --- | --- | --- | --- |
| `launcher_anonymous_enrollment_draining` | 403 | drain 中且不是合格续租 | 不自动重试；引导员工登录 |
| `launcher_anonymous_enrollment_disabled` | 403 | 匿名已禁用 | 不自动回退匿名；引导员工登录 |
| `ANONYMOUS_RENEWAL_NOT_ELIGIBLE` | 403 | capability/cohort/device/key 不匹配 | 保留诊断，不尝试创建新匿名身份 |
| `ANONYMOUS_POLICY_REVISION_CONFLICT` | 409 | 管理员编辑基于旧 revision | 刷新后重新确认 |

错误响应不得包含完整 public key、capability、ops token 或其他用户的 lease 信息。

### 5.3 CLI 不构成旁路

当前 CLI 已显式支持：

~~~sh
qp-tunnel-cli h2i enroll \
  --bootstrap-url https://h2i.example.com \
  --product-id mx-h2i \
  --anonymous
~~~

CLI 与 GUI 使用同一 V2 Launcher Network enrollment。`requestedBy`、User-Agent、二进制名、
命令行参数和自报 `cli=true` 都可以伪造，只能用于审计提示，不能用于授权。

因此：

- enabled：CLI 可新建/续租；
- drain：只有带原 capability 且属于 cohort 的 CLI state 可精确续租；
- disabled：CLI 与 GUI 一样被拒绝；
- 不定义 `cli-only` admission；
- 如果未来需要 break-glass，使用 Internal 签发、短时、单 product、单 install、单次消费的
  enrollment grant，并单独审计；不能复用普通 Internal ops token，更不能本期暗中加入。

### 5.4 sourceIp 捕获

`sourceIp` 是 enrollment 时的 HTTP 观测值，必须：

- 由 controller/framework 从请求上下文捕获；
- 只信任明确配置的一跳或固定拓扑 proxy；
- 不接受 body 中的 `sourceIp`；
- 对未经信任的 `X-Forwarded-For` 忽略或拒绝；
- 保存规范化地址和采集时间，可选保存可信 proxy chain 摘要；
- 通过 ops RBAC 读取，普通 AppCenter/客户端响应不返回；
- 默认在 UI 中掩码，按权限显式展开，并产生审计。

HTTP sourceIp 只说明 enrollment 请求来自哪里，不证明 WireGuard 当前 endpoint，更不能作为
稳定设备身份、授权条件或未来流控主键。

### 5.5 当前产品级用户访问 API

当前 Admin 使用以下 Internal ops 接口；三条接口都必须携带有效 `x-mx-ops-token`：

| 接口 | 语义 |
| --- | --- |
| `GET /internal/v1/launcher-network/products/{productId}/user-access` | 列出该 ProductNetwork 的 blocked users inventory |
| `GET /internal/v1/launcher-network/products/{productId}/users/{userId}/access` | 读取指定用户在该 ProductNetwork 的 admission 状态与最近 lease 摘要 |
| `POST /internal/v1/launcher-network/products/{productId}/users/{userId}/access` | 以严格 boolean `blocked` 设置 ban/unban；可带 `reason`、`requestId` |

inventory 与单用户响应都返回 `controlPlane` 和 `runtimePeerRemoval`；即使最近 lease 已是
`released`，也必须继续明确 `runtimePeerRemoval=not-performed`，不能让 API 消费者推断 peer 已删除。

ban 使用独立的 `LauncherProductUserAccess` generic record 保存精确 `productId + userId`、
`blocked`、reason 和 revision，并在 enrollment、snapshot 与用户持有的 peer 操作入口执行。
正常读写不读取或修改 `UserCenterUser.appAccess.deniedAppIds`；后者继续表达 AppCenter 应用访问。
升级兼容 backfill 也绝不只凭 `deniedAppIds` 推断 Network ban：只有同一 top-level
`productId + userId` 存在 provenance=`server` 且 eventType 精确为 blocked/allowed 的历史 audit，
才形成一次性候选。拒绝为 HTTP 403，稳定 code 是
`launcher_product_user_access_denied`，响应包含被拒绝的 `productId` 与 `userId`。

Postgres 首次启动的兼容 backfill 在一个 transaction 与全局 advisory xact lock 内执行，并按
`product -> product+user` 获取与正常写入相同的锁，锁后重读 user/access；已有独立 access 永不
覆盖，缺 user/product 跳过，明确 allowed 也写入 `blocked=false` marker。最新可信 audit 与当前
`deniedAppIds` membership 冲突时，记录 conflict 并以 membership 写 marker，因为它是旧版本
实际执行 admission 的状态，从而不在升级瞬间静默放行或误封。完成 counts 保存到确定性 migration
summary；仅存在 candidate 时额外写一次 completed audit，多副本启动不会重复扫描全量 audit 或
重复写 completion。

这是单阶段旧数据转换，不是新旧 writer 的在线协调协议。虽然 Internal API 默认只有一个 replica，
RollingUpdate 仍可能让 surge 新 Pod 与旧 Pod 同时接流量。若可信历史 audit 的
`candidatePairs > 0`，首次切换前必须二选一：在维护窗口 quiesce 旧 API writer，或先发布同时写
旧 membership 与新 access 的双写版本；只有已确认历史候选为 0 时才可直接滚动。这里不通过修改
Deployment strategy 制造登录停机。

`blocked=true` 的当前语义是：

1. 只更新目标 ProductNetwork 的独立 `LauncherProductUserAccess` admission record；
2. release 该用户在目标 ProductNetwork 的 active 控制面 leases；
3. 不修改 User Center 用户 `status`、token 或 `appAccess`，也不改变 AppCenter 登录/授权；
4. 不 release 其他 ProductNetwork 的 lease；
5. `runtimePeerRemoval.status/domestic/internalDirect` 明确为 `not-performed`。

`blocked=false` 只恢复该 ProductNetwork 的 admission，不重新创建 lease、capability 或 peer。
重复 ban/unban 必须幂等并写 audit。对 `mx-h2i` 执行 ban 后，同一用户仍可使用 Luopan；
反向亦然。这里的作用域是 standalone channel ProductNetwork：共享 `mx-h2i` channel 的 embed
网络 lease 仍属于 `mx-h2i`，业务应用自身授权应继续使用 AppCenter/RBAC。

匿名 lease 没有 User Center `userId`，所以当前接口不提供匿名单客户端 ban。Admin 对匿名
行只引导到 MX-H2I anonymous policy，不得声称已经封禁或移除该客户端 peer。

## 6. MX-H2I 客户端体验

### 6.1 主连接页

MX-H2I 默认 `advanced` 后：

- 未连接时主按钮优先呈现员工登录/连接；
- “新建访客连接”移动到高级选项；
- 员工密码与飞书登录入口保持主路径；
- 已连接访客仍显示模式、分配 IP、健康、断开、升级为员工等状态；
- guest → employee/Feishu 仍先认证并准备新 peer，成功后再切换；
- 登录失败、取消、超时继续保留已有 guest，除非管理员另行执行受控 revoke；
- visibility 变化不触发本机 WG、route、PAC、DNS/NRPT 写操作。

### 6.2 高级选项

高级页应显示：

- effective admission 和来源 ProductNetwork；
- `enabled/drain/disabled` 的用户可理解说明；
- 新建访客按钮，仅在 visibility 允许且 admission=enabled 时可用；
- drain cohort 的当前设备若可续租，显示“续用现有访客连接”，不显示“创建新访客”；
- disabled 时显示稳定错误和员工登录入口；
- disabled 且 guest 已不再完整 ready 时，不显示“正在原位恢复连接”或“修复网络”，也不再调度
  WireGuard、route、PAC、DNS 的自动/手动修复；已经完整 ready 的 guest 不被开关主动断开，仍保留
  状态与主动断开入口；
- install/device 标识的脱敏摘要；
- 复制诊断信息，不包含 capability/private key/token。

### 6.3 hidden 与现有连接

`hidden` 隐藏的是“获取新匿名身份”的入口，不是连接状态。若旧客户端或管理员策略变更时
设备已经 guest connected，用户仍必须能：

- 看见自己处于访客模式；
- 主动断开；
- 登录并切换员工；
- 查看不含秘密的诊断；
- 理解“服务端已禁止续租，但现有数据面可能暂时仍存在”。

## 7. Launcher Network 多产品 Admin 工作区

### 7.1 导航命名、选择作用域与当前 Dashboard

Desktop 左侧一级入口使用 `Launcher Network`，而不是 `MX-H2I Dashboard`。
原因是该工作区的 inventory 来自所有 standalone ProductNetwork；MX-H2I 只是其中一个
channel。左侧导航不应与通用 Apps 树重复枚举产品，产品切换由 Dashboard 内的
ProductNetwork selector/filter 承担。

工作区必须始终显示当前作用域：

- `All standalone channels`：跨产品只读运营总览；不显示全局 anonymous/ban 操作；
- `MX-H2I / productId=mx-h2i`：显示 MX-H2I 租约、VIP、策略和产品级操作；
- `Luopan / productId=luopan`：显示 Luopan channel 的同类数据；MX-H2I 匿名策略不带入；
- 后续 standalone：从已注册且 `mode=standalone` 的 ProductNetwork 动态生成，不写死产品名单。

当前 Dashboard 包含：

- 显式标注当前 `productId` 的匿名 admission 状态和 enable/disable 快速操作；
  `All` 作用域下仅展示各产品状态，不提供批量改写；
- 静态 active lease、employee、Feishu、anonymous、已记录 source IP、blocked-user
  指标，且指标必须跟随当前 product filter；
- `Client lease record -> product-scoped identity group -> ProductNetwork/channel (VIP) -> shared Domestic -> shared Internal`
  交互式静态 3D 图；可选显示 identity group 聚合层。每个 client
  节点代表一条静态 lease，不冒充一台物理机器；每个视窗
  最多渲染 48 条 lease，通过全量搜索、身份过滤和分页覆盖所有记录，不再用含义不明的
  `+N more` 节点隐藏剩余集合；
- 拖拽旋转、Shift/右键拖拽平移、滚轮缩放、reset/fit、标签开关，以及等价键盘操作；
- client、identity group、ProductNetwork/VIP、Domestic、Internal 都支持
  hover/select；client 可进入 Connections 抽屉，group/ProductNetwork 可直接套用过滤，
  Domestic/Internal 只提供安全基础设施导航，不在 3D 内伪造 destructive action；
- 选中 client 后按 exact lease ID 读取最多 50 条服务端可信、脱敏的控制面审计活动；该活动不是
  runtime log、流量、handshake 或在线证明；
- 始终保留可键盘操作的列表 fallback；
- 可搜索，按 product/channel、requesting app、identity/profile 过滤并分页的 Connections 表；
- 按当前 ProductNetwork 列出的 blocked users inventory；
- 完整 `enabled | drain | disabled` 与 `primary | advanced | hidden` 策略编辑器；
- 回到通用 Product settings、shared Domestic/Internal infrastructure 和刷新入口。

Dashboard 的 `STATIC DATA`、`Static lease != real-time online` 提示是平台契约，不得为了
视觉“大屏”效果去掉。Three.js 节点和动画不能产生在线、已断开或 peer 已删除的结论。

### 7.2 当前 Connections 抽屉与用户控制

Connections 行支持点击、Enter 和 Space 打开 `role=dialog` 的抽屉；抽屉支持 Close、
backdrop 和 Escape 关闭，并应把焦点还给触发行。后续修改必须继续验证焦点约束和键盘
可达性，不能只验鼠标路径。

抽屉展示 identity/user、assigned IP、source IP、lease/install/device、platform、记录时间
和 expiry；Admin 抽屉与拓扑不展示 capability、private key 或完整 public key。当前
internal ops lease DTO 仍包含 `publicKey`，不能把“UI 未展示”写成“API 未返回”；后续应按
用途拆分最小 DTO，并用独立 sensitive-read RBAC 控制密钥标识。当前 source IP 仅在持有
ops token 的 Admin 中显示；默认掩码与独立 sensitive-read 权限仍是 §13 的目标能力。

lease 持久记录只保存 `userId`，不保存人类可读姓名。Internal ops-only
lease list/get 在服务端用 `userId` 精确关联 User Center，返回临时展示字段
`userDisplayName` 和 `userAccount`；它们不写回 lease，普通 enroll/renew 响应也不包含。
Admin 显示优先级为：

1. `userDisplayName`（来自 `UserCenterUser.displayName`）作为主标题；
2. `userAccount` 和 `userId` 作为次级、可审计技术标识；
3. 无法 exact join 时主标题显示“姓名不可用”，仍保留 `userId` 技术标识，但不把它伪装成姓名。

对 Feishu profile，自动开通时的 `displayName` 来自 Feishu user-info 的 `name`，其次
`en_name`，再次才是带短哈希的稳定 fallback。因此拓扑、表格、tooltip 和抽屉应以
例如“张三”的 User Center display name 为主标题，以 `usr_feishu_*` 为次级技术标识。
`profile.externalIds.feishuSubject` 是身份绑定字段，不应作为姓名展示或返回到普通前端。

当前 Feishu 已绑定用户在每次 OAuth 登录时不会自动覆盖 User Center `displayName`。
该值可能是首次开通时的 Feishu 姓名，也可能是管理员后续修改的显示名，不应标成
“实时 Feishu 目录名”。如果后续需要跟随 Feishu 改名，应建立独立的目录同步、来源
优先级和人工 override 规则。User Center 暂时不可用时，UI 显示“姓名不可用”
和 `userId`，不根据 Feishu ID 哈希猜测姓名。

拓扑所称“device identities”是以 `deviceId/installId` 为主、以现有租约身份作降级的 best-effort
去重，不等于可靠硬件资产数。`sourceIp` 是 enrollment/renewal HTTP 来源，不得映射成“登录地点”。
当前没有客户端 GPS/GeoIP 证据，也没有客户端 runtime log；UI 必须显示 `not collected`，不能用
私网/NAT/代理地址推断城市或国家。

登录用户行的 ban/unban confirmation 必须同时写明：

- 作用域只有当前明确选中的 ProductNetwork，并显示精确 `productId`；
- 例如 ban `mx-h2i` 时 Luopan 不受影响，ban `luopan` 时 MX-H2I 不受影响；
- ban 会 release 匹配的 active 控制面 leases；
- token 和全局用户状态不变；
- WireGuard peer removal 未执行、未确认；
- unban 只恢复 admission，不重建 lease/peer。

匿名行不展示伪造的“Ban user”动作，只能打开当前 ProductNetwork 的
anonymous policy。未来 Revoke WG
peer、Traffic limits、Port policy 在没有后端 reconcile/evidence 前只能是 disabled planned
controls，不能成为无效或误导性的按钮。

blocked inventory 是产品级可恢复操作面：ban 后 active row 会从当前产品的
active Connections 消失，但用户仍必须在同一 `productId` inventory 中可打开并
unban；即使用户从未拥有该产品 lease，也不能要求数据库手工恢复。

### 7.3 多产品信息架构与操作边界

Launcher Network 不应只埋在通用 Apps 树下。顶层工作区使用统一 product/channel
filter，再提供：

1. `Overview`：全部/单产品关键指标、策略、站点健康、异常摘要；
2. `Connections`：精确客户端 lease 表、跨产品搜索、过滤、排序、导出；
3. `Topology`：3D lease—product-scoped identity—ProductNetwork/VIP—shared Domestic—shared Internal 拓扑；
4. `Product Policies`：仅在选定一个 standalone channel 后编辑 anonymous admission、
   visibility 与 blocked users；
5. `Leases & Revocation`：静态 lease、handover、未来 revoke saga；
6. `Infrastructure`：Domestic/Internal 共享基础设施和各产品 materialization 证据；
7. `Diagnostics`：单连接、单产品与站点证据；
8. `Traffic & Port Policies`：未来能力占位，未实现时不出现可执行按钮。

通用 Apps 页面继续负责 app 注册、mode、channel、capabilities、RBAC 和发布；MX-H2I
与 Luopan 的连接运营收敛在 Launcher Network 工作区。

操作必须按节点类型收敛：

| 节点/对象 | 拓扑内允许 | 详细抽屉/页允许 | 禁止语义 |
| --- | --- | --- | --- |
| lease/client | select、focus、打开 connection drawer | 查看脱敏细节、服务端 audit；对登录用户进入产品级 ban | 匿名行伪造 Ban user；把 release 说成 peer 已删 |
| identity/profile group | 套用过滤 | 查看统计和过滤后 inventory | 直接批量 revoke |
| ProductNetwork/channel + VIP 属性 | 切换 product filter、查看 VIP/CIDR/policy 摘要 | 单 `productId` 匿名策略、blocked inventory、reconcile 证据、VIP smoke | 不明确 productId 的全局开关；把 VIP 伪造成 Internal 后的物理节点 |
| requesting embed app | 应用过滤、导航 AppCenter | AppCenter/RBAC/service dependency | 独立 endpoint lease 或 peer 操作 |
| Domestic/Internal | 查看 shared infrastructure 摘要 | 基础设施详情和带 blast-radius 的 reconcile 工作流 | 伪装成只影响当前产品的操作 |

Domestic/Internal reconcile 可能重新 materialize 共享 interface 及所有
`productRelayCidrs`，不是普通的 product-local action。执行前必须展示所有受影响
channel、目标 CIDR/VIP 并走现有 Admin 确认/证据链，不能把它塞进单个客户端节点的
快捷菜单。

### 7.4 目标 Overview

建议至少显示：

- standalone channel 数、当前 product filter、每产品 service VIP 与 materialization 状态；
- employee / Feishu / anonymous active lease 数；
- runtime online / idle / offline / stale 数；
- Domestic 与 Internal direct 的 peer/materialization 健康；
- anonymous admission、UI visibility、policy revision；
- drain cohort 初始值、当前值、下降速度；
- orphan lease、orphan peer、released-but-present、active-but-missing 数；
- 最近策略变更、失败 saga、采集 freshness；
- 用户登录与 enrollment 错误率。

所有卡片必须标注 product 作用域、数据时间和来源，不能把不同 ProductNetwork
或不同 freshness 的数字拼成同一个“实时”总数。`All` 可汇总只读统计，但必须能下钻
到每个 `productId`。

### 7.5 目标 Connections 表

表格是运维事实的主要入口，3D 不是表格替代品。建议字段：

- product/channel、requesting app、leaseId；
- identity/profile、user/display name；
- installId、deviceId、device label；
- platform、model、OS、app version；
- assigned overlay IP；
- public key fingerprint；
- enrollment sourceIp（默认掩码）；
- observed WG endpoint IP/port（默认掩码）；
- lease status/expiry；
- peer configured planes；
- latest handshake；
- RX/TX；
- derived online state；
- site、采集时间、stale 标记；
- handover/revoke operation 状态。

支持按 product/channel、requesting app、identity/profile、site、online state、异常类型、
客户端版本、legacy `appId` 缺失过滤。文本搜索索引 User Center display name、account、
userId、source/assigned IP、install/device/lease ID，但归属筛选仍以结构化字段为准。
“Luopan 网络上的登录用户”等价于 `productId=luopan AND identityKind=user`；如需只看 Feishu，
再加 `leaseProfile=feishu`。大量连接使用
virtualized table；导出同样受 RBAC、脱敏和审计约束。

## 8. 静态 lease 与实时连接模型

### 8.1 三种不同事实

| 事实 | 来源 | 能回答 | 不能回答 |
| --- | --- | --- | --- |
| ProductNetwork | Internal registry | channel 的 mode、VIP、lease pool、site 和 desired policy | 该 VIP 当前已 materialize/可达 |
| lease | Internal DB | 谁被分配了哪个 IP、identity/profile、期限 | 当前是否在线 |
| requesting app | lease `appId` + AppCenter | 哪个 app 请求该 channel lease（新记录） | legacy `appId` 缺失时的原始 app |
| user presentation | User Center exact `userId` join | display name、account、用户状态 | 实时 Feishu 目录名、匿名记录的人类身份 |
| enrollment sourceIp | Internal HTTP 请求上下文 | enroll 时看到的来源 | 当前 NAT endpoint |
| WG runtime | Domestic/Internal direct `wg show` | peer、endpoint、handshake、流量 | 用户/RBAC 真相 |

必须按 public key fingerprint、assigned `/32`、product 和 plane 关联这些事实。产品归属先用
lease `productId`，再关联 ProductNetwork；不从 VIP 或 IP 前缀反向猜产品。任何一个来源
缺失都应成为可解释状态，不能默认为 offline 或 healthy。

### 8.2 实时采集

当前已提供 ops-only 的手动单节点观测：

`POST /internal/v1/launcher-network/leases/{leaseId}/runtime-observation`

它只接受 active lease，在服务端读取 Domestic relay 的目标 peer，并以严格白名单返回
`leaseId/productId/observedAt/source/plane/status/stale/peerConfigured/latestHandshakeEpoch/`
`rxBytes/txBytes`。它不返回 raw stdout/stderr、完整 public key、endpoint 或其他 peer 数据，
也不推导 online。Admin 只在操作员选中节点并点击刷新时调用；同一 lease 的两次合法累计
counter 可计算区间平均 RX/TX，但必须标为 Domestic 手动区间估算，而不是实时或端到端网速。
`observedAt` 以远端 `wg` counter 读取完成时刻为准，不使用 SSH 请求开始时刻，
避免两次查询延迟不同时扭曲差分速率。

这条手动路径用于当前节点排障，不替代后续批量采集。规模化实时展示仍应由服务端或受控
site-agent 每 5–15 秒批量采集一次：

- `wg show mx-domestic dump` 或等价的 peers/endpoints；
- allowed IPs；
- latest handshakes；
- transfer RX/TX；
- interface/config generation；
- 可选 Internal direct 对应 interface。

不允许 Admin 浏览器为每行 lease 发起一次 SSH/runner job。采集失败只让 snapshot stale，
不得影响 enrollment、token introspection、连接 readiness 或本机网络。

### 8.3 派生状态

| 状态 | 判定 |
| --- | --- |
| `online` | active lease、目标 plane 已配置、latest handshake 在新鲜窗口内 |
| `idle` | peer 已配置但 handshake 超过 online 窗口，lease 仍 active |
| `never-seen` | peer 已配置但无有效 handshake |
| `not-materialized` | active lease 在要求的 plane 找不到 peer/AllowedIP |
| `released-present` | lease released，但 runtime 仍存在 |
| `unknown-peer` | runtime peer/AllowedIP 无法关联任何 lease/handover |
| `revoking` | future revoke saga 正在收敛，至少一个 plane 未确认 |
| `stale` | runtime snapshot 超过 freshness SLA，禁止声称 online/offline |

在线窗口应配置并展示，不把“有累计 transfer”当作当前在线。

### 8.4 observed endpoint

WireGuard `endpoint` 是 relay 当前看到的公网 IP:port，往往是 NAT 出口：

- UI 标签使用“Observed NAT endpoint”；
- 与 enrollment sourceIp 并排但不合并；
- endpoint 变化是正常网络事件，不自动判定设备冒用；
- endpoint/IP 不是限速、授权或 revoke 主键；
- IPv4/IPv6、端口和采集时间分别存储；
- 普通用户不可查询其他用户 endpoint。

## 9. 3D 实时拓扑

### 9.1 复用与分离

desktop 已有 Three.js H/D/I/O 场景，适合继续作为部署与站点健康入口。但客户端连接拓扑
需要单独的数据层：

- 原 H/D/I/O 图：部署流水线、site slot、Domestic/Internal/Oversea 健康；
- Launcher Network graph：lease/用户 → product-scoped identity group → standalone
  ProductNetwork（VIP 是该节点属性）→ shared Domestic → shared Internal；
- 两者可以共享视觉 token、相机和 Inspector，不共享“online”判定。

在 `All` 视图中，Domestic 和 Internal 基础设施节点只画一次；MX-H2I、Luopan 等
ProductNetwork 作为独立产品分支连入共享 fabric。切换到单产品时，可聚焦该分支，
但不应复制一套虚假 Domestic/Internal 节点让人误以为物理隔离。

### 9.2 图模型

建议节点：

- client cluster：按 site、profile、状态、版本聚合；
- selected client：展开 user/install/device/assigned IP；
- identity/profile group：employee、Feishu、anonymous；
- standalone ProductNetwork/channel：`productId`、display name、lease count、策略摘要；
  `serviceVip` 是该节点的属性，同一节点内分开显示 configured 和 materialized/reachable evidence；
- shared Domestic relay fabric；
- shared Internal service peer/gateway；
- Internal direct（如为某产品/租约配置）；
- embed services/app routes：挂在所选 channel/VIP 下，只显示服务依赖，不伪造 endpoint peer。

建议边：

- enrollment/bootstrap；
- lease 到 product-scoped identity group，再到 ProductNetwork/channel 的归属；
- ProductNetwork 的 Domestic relay WG 路径；
- 可选 Internal direct WG；
- shared Internal service peer 对产品 CIDR/VIP 的 materialization/reachability；
- app/service dependency。

边颜色必须来自 runtime/evidence，而不是硬编码动画：

- green：fresh confirmed；
- amber：idle/degraded/draining；
- red：missing/orphan/revoke failed；
- gray dashed：stale/unknown/not applicable。

### 9.3 交互与可访问性

- hover 只显示脱敏摘要；click 选中节点，double-click/Enter 执行该节点的安全主操作；
- 拖拽旋转、Shift/右键拖拽平移、滚轮或 `+/-` 缩放，并提供 reset/fit；
- client 节点打开 Inspector/Connections 抽屉，identity group 节点切换身份过滤，
  ProductNetwork 节点切换 product filter，requesting app 节点打开 AppCenter；基础设施节点
  只做安全导航；
- search、product/app/identity filter 与 48 条窗口分页覆盖完整 lease inventory；
  selected path 高亮，但不以
  动画或颜色伪造在线状态；
- 选中 client 节点的右侧 Inspector 提供静态信息、exact lease audit、手动 Domestic WG
  观测和进入产品级 Ban/Unban 抽屉；匿名节点不伪造单用户 ban；
- 尚无双平面 peer-safe reconcile 或 tc/nft enforcement 时，Disconnect、持续 Live speed、
  Traffic limit 与 Port policy 必须保持 disabled，并说明缺少的 backend；
- 大规模客户端先窗口化/cluster，禁止一万台设备各建高面数 sphere；
- 提供 2D/table fallback、键盘操作和 reduced-motion；WebGL 失败只降级视图；
- 选中 lease 的 activity 只展示服务端 provenance 的字段白名单审计事件，exact match
  `metadata.leaseId`，并处理 loading/empty/error/stale response；
- WebGL 初始化或渲染失败不影响 Admin 其他操作；
- 3D 场景不直接承载 destructive action，revoke 必须进入独立确认流程。

## 10. 匿名策略变更工作流

### 10.1 变更前预览

Admin 保存前展示：

- 目标 app 和解析后的 ProductNetwork；
- 当前/目标 admission 与 visibility；
- active anonymous lease 数；
- drain cohort 数；
- employee/Feishu lease 数，明确“不会受影响”；
- Domestic/Internal runtime 中可关联与不可关联 peer 数；
- Luopan/其他产品数量，明确“不在本次范围”；
- visibility-only 或 admission change；
- 本期 `disabled` 不删除 peer 的强提示。

保存使用 revision/ETag，避免两个管理员覆盖策略。

### 10.2 允许的转换

| from | to | 要求 |
| --- | --- | --- |
| enabled | drain | 建立 cohort、填写 reason、记录 dry-run |
| enabled | disabled | 允许但强警告；推荐先 drain |
| drain | disabled | 展示剩余 cohort 和 runtime peer |
| drain | enabled | 审计恢复原因 |
| disabled | enabled | 不复活 released/revoked lease；客户端重新按规则 enroll |
| 任意 | visibility-only | 不触发 lease/peer/network side effect |

策略 API 成功只表示新 admission 已生效，不表示旧 peer 已消失。

### 10.3 客户端一致性

- 新客户端可读取 policy，用于优化 UI；
- 旧客户端即使仍显示访客按钮，也由服务端拒绝；
- `disabled` 下非 ready guest 不进入 retained repair，不调度自动重试，也不显示手动修复；
- policy 切换本身不 `stop` 已完整 ready 的 guest，本期也不自动 release lease/remove peer；
- `drain` 仍仅允许持有匹配 active lease capability 的既有设备续租/恢复；
- 客户端收到 disabled/drain 拒绝后不自动匿名重试；
- 员工登录失败不能偷偷 fallback 为 guest；
- 已连接 guest 在本期可能继续传输，直到自然失效、手工处理或未来 revoke；
- Admin 页面必须把“admission blocked”和“runtime peer removed”显示成两个独立状态。

## 11. 未来 bulk revoke 安全设计

> 本节定义后续实现门槛。本期不得因实现了策略开关就自动执行本节动作。

### 11.1 状态机

目标 lease/revoke operation 状态：

~~~text
active
  -> revoking
       -> revoked
       -> revoke-failed -> revoking (retry)
~~~

不能从 `active` 直接写 `released` 后假定完成。`revoking` 期间：

- admission 不允许该 lease 建立新匿名 session；
- UI 显示部分完成平面；
- reconcile 可按同一 idempotency key 重试；
- 不因 worker 重启丢失目标集合；
- 默认 forward-recovery，不能在一个平面已删除后静默补回 peer。

### 11.2 Batch 冻结与确认

bulk 操作先生成不可变 dry-run：

- batch id、productId、policy revision；
- 精确 leaseId/generation 列表；
- public key fingerprint 与 assigned `/32`；
- identity/profile 必须都是 anonymous；
- expected Domestic/Internal planes；
- shared-key/handover 引用图；
- blocked 项及原因；
- 创建人、审批人、维护窗口和过期时间。

执行时使用冻结列表，不能再次用“当前所有 anonymous”动态查询，避免把预览后新出现或发生
handover 的 lease 卷入。

### 11.3 单 lease saga

每个 lease 独立、幂等地执行：

1. 获取 product/lease/public-key 范围锁；
2. 重新验证 generation、identity/profile、policy revision；
3. 查询全部 product、active lease、handover transition 和 runtime AllowedIPs 引用；
4. 标记 `revoking` 并持久化 saga intent；
5. 从 Domestic desired peer set 排除目标 `/32`，materialize/apply；
6. 读取 Domestic runtime，确认目标 AllowedIP 不存在；
7. 对 Internal direct 执行相同收敛；未部署时记录 `not-applicable` 证据；
8. 再次读取两平面，确认 `confirmed-absent | not-applicable`；
9. 最后将 lease 标为 revoked/released，写 evidence 与 audit；
10. 任一步失败保留 revoking/failed 和已完成平面，等待安全重试。

“命令返回 0”不是确认；必须读取 runtime。数据库状态也不是确认。

### 11.4 双平面确认

完成条件：

| plane | 合格结果 |
| --- | --- |
| Domestic relay | `confirmed-absent` |
| Internal direct | `confirmed-absent`，或配置证明该产品/lease 的 direct 为 `not-applicable` |
| Internal DB | saga/evidence 完整且 generation 未变化 |

如果一侧 unreachable，操作保持 revoking，不得标记成功。Admin 显示已完成面、失败面、最后
错误、重试次数和下一步。

### 11.5 共享 public key 保护

public key 不能假设一 lease 一 peer。guest → staff handover、迁移或异常历史数据可能产生同
key 多引用。删除前必须构建引用图：

- 所有产品的 active/revoking lease；
- 同 install/device 的旧新 lease；
- active handover transition；
- Domestic 和 Internal runtime 的全部 AllowedIPs；
- pending materialization generation。

规则：

1. 只删除目标 `/32`，不默认执行整 peer `remove`；
2. 同 key 仍有非目标 active AllowedIP 时保留 peer；
3. 只有引用计数为零，且两个平面的 desired/runtime 都无保留 AllowedIP，才能删除 peer；
4. 无法解释共享引用时阻塞并要求人工对账；
5. 日志和 UI 只显示 fingerprint，不暴露完整 key；
6. 任何跨 product 引用都视为高危异常，绝不“顺便清理”。

### 11.6 与 release 的区别

- disconnect：停止本机当前使用，不必释放稳定 lease；
- release：控制面不再把 lease 视为 active；
- revoke：控制面 intent + 两平面数据面删除 + runtime 确认；
- bulk revoke：冻结目标集合、逐项 saga、汇总 evidence。

只有 revoke 完成才能向管理员声明“连接已下线”。

## 12. 未来流量、端口与客户端控制

本期只预留模型，不执行规则。未来策略应绑定稳定身份：

- productId；
- leaseId/generation；
- public key fingerprint；
- userId/installId/deviceId；
- assigned overlay `/32`。

不得以 enrollment sourceIp 或 observed NAT endpoint 作为主键。

建议 desired/effective 分离：

~~~text
Internal desired policy
  -> reviewed plan
  -> Domestic/Internal agent apply
  -> tc/nftables/eBPF or equivalent
  -> runtime evidence
  -> Internal effective status
~~~

候选能力：

- per-client up/down rate；
- destination CIDR/domain/service allowlist；
- TCP/UDP 端口策略；
- session/connection 上限；
- maintenance quarantine；
- usage counters 与告警。

每项都需要 preview、作用域、优先级、过期时间、回滚、冲突检测和 evidence。流控失败不能
修改登录身份或自动删除 peer。

## 13. RBAC、隐私与审计

建议权限拆分：

- `mx-h2i.connections.read`：读取脱敏连接；
- `mx-h2i.connections.sensitive.read`：展开 sourceIp/endpoint；
- `mx-h2i.policy.write`：修改 admission/visibility；
- `mx-h2i.revoke.preview`：生成 dry-run；
- `mx-h2i.revoke.execute`：未来执行 batch；
- `mx-h2i.diagnostics.run`：运行受控诊断；
- `mx-h2i.traffic-policy.write`：未来流控。

敏感规则：

- capability、private key、access token、ops token 永不返回 renderer；
- public key 默认 fingerprint；
- sourceIp/endpoint 默认掩码；
- 查看敏感值、导出、策略修改、dry-run、执行和重试都写 audit；
- topology snapshot 设置短 TTL，不进入公开 AppCenter API；
- 诊断脚本使用 allowlist，不能接受浏览器传入任意 shell；
- Admin 失去 ops auth 时退化为不可操作，不缓存可复用秘密。

## 14. 可观测性与告警

指标建议：

- enrollment result by product/profile/policy/error code；
- active/drain cohort/revoking/revoked lease；
- live peer by plane；
- handshake freshness histogram；
- released-present、active-missing、unknown-peer；
- sourceIp/endpoint mismatch 计数，只作风险信号；
- policy changes and revision conflicts；
- collector freshness/failure；
- revoke saga duration/retry/failure；
- employee/Feishu login success and guest→staff handover success。

高优先级告警：

- 修改 MX-H2I 策略后 employee/Feishu enrollment 错误率上升；
- Luopan anonymous enrollment 同时下降；
- V1 HDO 健康变化；
- disabled 后仍有大量匿名 peer 且无已知维护计划；
- revoke 在单平面完成后长时间卡住；
- shared key 跨产品；
- runtime snapshot stale 但 UI 仍声称 online。

## 15. 分阶段交付

### Phase A：策略与 UI，不删除 peer

- ProductNetwork 字段、默认值、revision 和 audit；
- server-side admission；
- MX-H2I advanced 入口；
- Admin 策略展示和修改；
- CLI/旧客户端拒绝行为；
- sourceIp 服务端捕获；
- 不执行 bulk peer 删除。

### Phase B：只读连接观测

- 批量 runtime collector；
- live connection snapshot；
- Connections 表和 Inspector；
- 3D client topology；
- stale/failure isolation；
- orphan/released-present 报告。

### Phase C：drain 与 dry-run

- drain cohort；
- 单调下降验证；
- immutable bulk preview；
- shared-key/handover 图；
- 审批与维护窗口；
- 仍不自动执行删除。

### Phase D：受控 bulk revoke

- revoking 状态和持久 saga；
- Domestic/Internal 双平面 reconcile；
- shared-key protection；
- idempotency/retry/evidence；
- 小批 canary 后再扩大。

### Phase E：流量与端口控制

- desired/effective policy；
- agent apply/rollback；
- rate/port/capability；
- 资源与性能验证。

## 16. 不回归矩阵

### 16.1 身份与策略

| 场景 | 必须结果 |
| --- | --- |
| MX-H2I enabled + advanced | 高级页可新建访客，主页面员工登录正常 |
| MX-H2I drain，新 install | 稳定拒绝，不分配 lease/peer |
| MX-H2I drain，精确 cohort capability | 保留原 identity/key/IP 续租 |
| MX-H2I disabled，non-ready GUI guest | 稳定拒绝，不自动重试/修复，也不通过“重新诊断”重写 Domestic/Internal peer |
| MX-H2I disabled，已有 fully-ready guest | 开关不主动 stop；状态与主动断开仍可见，后续降级后不再修复 |
| MX-H2I disabled，CLI `--anonymous` | 同样拒绝，`requestedBy` 无法绕过 |
| MX-H2I disabled，员工密码 | 登录和 employee lease 正常 |
| MX-H2I disabled，飞书 | 可信 HTTPS bootstrap 下可直接登录并取得 Feishu lease |
| visibility=hidden，已有 guest | 状态与断开仍可见，不新建 |

### 16.2 产品隔离

| 产品 | 必须结果 |
| --- | --- |
| Luopan | 匿名默认 primary + enabled，`10.91/16` lease/VIP/routes 不变 |
| H2O/AppCenter | 继续 embed，不创建独立 peer |
| MX Insight Hub | 继续 private embed/data product，不获得 ProductNetwork |
| V1 HDO | `100.*` 用户、匿名、DNS、插件和在线连接不变 |
| 后续 standalone | 只读取自己的 ProductNetwork 策略 |

Launcher Network 归属、显示名与基础设施还必须覆盖：

| 场景 | 必须结果 |
| --- | --- |
| product filter=`luopan` | 只出现 `lease.productId=luopan` 记录；MX-H2I 记录不依赖 IP 前缀猜测被排除 |
| `luopan` + `identityKind=user` | 列出通过 Luopan channel 取得 lease 的登录用户；anonymous 不被误归为用户 |
| embed app 绑定 Luopan 发起 lease | lease 归属 `productId=luopan`，`appId` 显示 requesting app；不创建 embed peer |
| legacy lease 缺少 `appId` | 显示 requesting app unknown；不由 `launcherMode`、label 或 IP 伪造 app |
| 同一 Internal user 同时有 MX-H2I/Luopan lease | 可按 exact `userId` 跨产品查看；两条 lease 和两个策略作用域仍独立 |
| MX-H2I/Luopan anonymous install 拥有相似设备文案 | 不根据 label/installId/deviceId 跨产品合并为同一人 |
| Feishu lease 能 exact join User Center | 主标题显示 `displayName`，account/userId 作为次级标识；搜索能命中姓名 |
| Feishu lease 无用户记录/目录暂时不可用 | 显示“姓名不可用”和次级 `userId`，不猜测或泄露 `feishuSubject` |
| 用户在 Feishu 改名但 User Center 未同步 | 标为 User Center display name，不声称实时 Feishu 目录名 |
| All channels topology | Domestic/Internal 共享节点只画一次；产品分支显示各自 lease CIDR/VIP |
| ProductNetwork 已配 VIP 但 reconcile/smoke 无证据 | 显示 configured/unknown 或 blocked，不显示 reachable/healthy |
| 从 Domestic/Internal 节点执行 reconcile | 进入显示所有受影响 channel/CIDR/VIP 的 shared-infrastructure 确认流程 |

产品级用户访问还必须覆盖：

| 场景 | 必须结果 |
| --- | --- |
| 同一用户同时有 MX-H2I 与 Luopan active lease，ban `mx-h2i` | 只 release MX-H2I 控制面 lease；Luopan lease/renew/enroll 保持可用 |
| ban `mx-h2i` 后重新登录/换设备 enroll | MX-H2I 返回 `launcher_product_user_access_denied`；用户 token 与全局 `status` 仍 active |
| MX-H2I password 与 Feishu 身份 | 同一 Internal userId 都受该产品 ban；未 ban 用户的两类登录不回归 |
| unban `mx-h2i` | admission 恢复；不自动创建 lease、capability 或 WG peer |
| 重复 ban / 重复 unban | 幂等、有 audit，不重复影响 Luopan 或其他用户 |
| 匿名 Connections 行 | 不显示用户 ban 成功语义；只进入 ProductNetwork anonymous policy |
| blocked inventory 无 active/历史 lease | 仍可读取状态并 unban，不依赖 active row |

### 16.3 网络与切换

- guest → employee/Feishu 认证失败、取消、超时保留 guest；
- 成功切换遵守既有 handover，不先删旧 peer；
- employee reconnect/renew 不受 anonymous admission 影响；
- Windows WG/route/NRPT/PAC/2053 不回归；
- macOS WG/route/PAC/supplemental resolver 不回归；
- 一个产品断开或改策略不清理另一产品 routes/claims；
- visibility-only 变更不产生任何系统网络写操作。

### 16.4 观测与安全

- active DB lease 无 fresh handshake 时不能显示 online；
- collector down 时显示 stale，连接/login/readiness 不受影响；
- sourceIp 请求体伪造无效；
- proxy hop 配错时 fail safe，不信任任意 X-Forwarded-For；
- 普通权限看不到完整 sourceIp/endpoint/public key；
- Three.js/WebGL 失败时表格与策略编辑仍可用；
- disabled 开关成功后 UI 不宣称 peer 已删除。

### 16.5 未来 revoke

- dry-run 与执行目标集合完全一致；
- batch 重试幂等；
- staff/Feishu、Luopan、V1 peer 零变化；
- shared key 有保留引用时不删除 peer；
- 两平面未确认前不标记 revoked；
- worker/API 重启后 saga 可恢复；
- 部分失败可见、可重试、有 evidence。

## 17. 验收标准

本期验收至少满足：

1. 左侧存在清晰、独立的 `Launcher Network` 入口，Dashboard 可在 All、MX-H2I、
   Luopan 及其他已注册 standalone ProductNetwork 间切换；
2. Connections 行可用鼠标与键盘打开抽屉；product 是全工作区作用域，同时影响表格、
   拓扑、指标和 blocked inventory；Connections 的 requester app 与 identity/profile
   过滤只影响表格，Topology 使用独立的 query/identity 过滤；ban 后可从同 product
   inventory unban；
3. MX-H2I 新建访客入口默认只在高级选项；
4. ProductNetwork 可独立保存 admission 与 visibility；Dashboard 快速开关只能在选定
   单一 product 后写入该精确 `productId`，All 视图不存在全局 anonymous toggle；
5. MX-H2I 与 Luopan 的匿名策略及用户 ban 互不影响；
6. disabled 在服务端拒绝 GUI、旧客户端和 CLI anonymous enrollment；
7. product user ban 使用独立 `LauncherProductUserAccess`，在服务端拒绝目标产品的
   enrollment/snapshot/peer action，但保持用户 status/token、AppCenter `appAccess` 与
   Luopan 可用；
8. employee/Feishu 登录和现有连接切换测试全部通过；
9. Admin 明确区分 policy、lease、控制面 release 和 live peer；
10. sourceIp 由服务端捕获，body 无法覆盖；
11. UI/API 的 `controlPlane` 与 `runtimePeerRemoval` 不宣称数据库 release 已删除 peer；
12. 匿名行不提供虚假的用户 ban；
13. 未来 bulk revoke 设计具备 revoking、saga、双平面确认和共享 key 保护；
14. V1 HDO、Luopan、embed apps、MX Insight Hub 的不回归证据完整。
15. Luopan 网络用户可用 `productId=luopan AND identityKind=user` 精确列出；旧
    `appId` 缺失不会被误归属。
16. Feishu lease 通过 exact `userId` join 优先显示 User Center `displayName`，并保留
    account/userId 作为可审计次级标识。
17. All topology 只画一套 shared Domestic/Internal 基础设施，每个 standalone
    分支独立显示 channel、lease CIDR 和 VIP；配置值不伪装成 runtime reachability。
18. 选中 active lease 可手动读取严格脱敏的 Domestic WG peer/handshake/累计 RX/TX；两次
    合法样本只显示区间平均值，不声称 online、实时或端到端网速。
19. 无 peer-safe 双平面 reconcile 与 tc/nft enforcement 时，Disconnect、持续 Live speed、
    Traffic/Port policy 不可执行，也不得伪造成功。

## 18. 相关文档

- [13-platform-ops-and-admin-design-system-roadmap.md](./13-platform-ops-and-admin-design-system-roadmap.md)：
  Admin editor shell、Three.js 与运维设计系统。
- [14-mx-h2i-standalone-launcher-architecture.md](./14-mx-h2i-standalone-launcher-architecture.md)：
  V1/V2、ProductNetwork、standalone/embed 与系统网络 owner。
- [20-luopan-standalone-development-guide.md](./20-luopan-standalone-development-guide.md)：
  第二个 standalone 产品与网络隔离验收。
- [21-network-mode-switch-events-and-performance.md](./21-network-mode-switch-events-and-performance.md)：
  guest/staff 切换、事件与性能基线。
- [24-mx-h2i-feishu-login.md](./24-mx-h2i-feishu-login.md)：
  密码/飞书/访客 profile、安全 bootstrap 与 handover。
- [26-mx-insight-hub-integration-architecture.md](./26-mx-insight-hub-integration-architecture.md)：
  Hub 作为 embed 数据产品的硬边界。
