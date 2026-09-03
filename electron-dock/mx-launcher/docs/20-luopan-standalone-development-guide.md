# Luopan Standalone 开发指南：V2 MX-H2I 工作原理走读与照做路线

> Luopan 与 MX-H2I 共存时，启动前应读取共享 network mode snapshot，并监听
> `visit:connect / staff:connect` 事件；staff 已连接时不得用默认 visit 初始化去断开或重启
> 系统数据面。完整契约见
> [21-network-mode-switch-events-and-performance.md](./21-network-mode-switch-events-and-performance.md)。
> Luopan 的匿名准入属于自己的 ProductNetwork，默认保持 `enabled + primary`，不继承
> MX-H2I 的开关；多应用策略与隔离验收见
> [28-mx-h2i-connection-operations-and-anonymous-governance.md](./28-mx-h2i-connection-operations-and-anonymous-governance.md)。
> Launcher Network Admin 的用户 ban 按 ProductNetwork 保存；ban `mx-h2i` 不得 release、阻止
> 或重新配置该用户的 `luopan` lease/WireGuard 路径。数据库 lease release 也不等于远端
> WireGuard peer 已移除。

给接手 Luopan 的开发者。目标：读完本文 + 跑通 `demos/luopan`，你能理解 V2 MX-H2I
的完整工作原理，并在此基础上独立开发 Luopan——**不管 Luopan 要不要承载 embed
应用都适用**（不承载：跳过 §6；要承载：按 §6 的流程找平台方）。

前置阅读顺序：`demos/luopan/HANDOFF.md`（红线与验收，最短）→ 本文 →
[docs/14](14-mx-h2i-standalone-launcher-architecture.md)（网络与共存的权威定义）→
[docs/17](17-mx-h2i-release-center-update-system.md)（更新系统状态机）。
[docs/19](19-formal-delivery-npm-packaging-and-luopan-handoff.md) 是平台侧交付方案，
可以只看 §3（下沉原则）和 §4（共存矩阵）。需要让 Luopan CI 自助发版时，再读
[docs/25](25-release-center-developer-api.md)（产品隔离的 Publisher API 与接入流程）。

一条贯穿全文的原则（docs/19 §3）：

> **`packages/*`（npm 包）是契约，`demos/mx-h2i` 是参考实现。**
> demo 行为与包 API 冲突时以包为准；遇到"demo 里有但包里没有"的能力，
> 找平台方下沉进包，**不要复制 main.cjs**。

## 0. 当前环境的最短独立启动路径

Luopan 已在现网 Internal 注册，不需要 SDK test mode。在
`demos/luopan` 执行：

```sh
cp .env.example .env
curl -fsS https://h2i.minsight-ai.com/bootstrap-healthz
curl -fsS https://h2i.minsight-ai.com/internal/v1/launcher-network/products/luopan
curl -fsS https://h2i.minsight-ai.com/internal/v1/app-center/apps/luopan
pnpm run setup
pnpm run dev
```

`.env` 的正式配置是两个阶段的地址：

```dotenv
LUOPAN_PRODUCT_ID=luopan
LUOPAN_BOOTSTRAP_URLS=http://116.62.51.154:18090,https://h2i.minsight-ai.com
# LUOPAN_LAUNCHER_BASE_URL=http://10.88.100.3:18090
```

- `LUOPAN_PRODUCT_ID` 对应 Admin/AppCenter 后台创建的应用和 ProductNetwork。
  其他 standalone 应用复制 Luopan 时只改这个 ID；VIP、CIDR、anonymous/user
  lease 段和 capabilities 都从后台 product/app 注册读取。
- bootstrap 是隧道建立前就可达的公网 facade，仅用于 `/healthz`、匿名 enroll、
  snapshot、peer sync 和无用户凭证的连网前请求。账号、密码与 bearer token
  只允许在 `network-ready` 后发往隧道内 VIP。多个候选可用逗号或空格
  排序，第一个 `/healthz` 成功的 URL 被选中。
- `LUOPAN_LAUNCHER_BASE_URL` 通常不需要配置；客户端会在 connect 前从
  `GET /internal/v1/launcher-network/products/{productId}` 读取 `serviceVip`
  并推导 `http://<serviceVip>:18090`。显式配置只用于开发覆盖，不得把
  MX-H2I/foundation 地址填进来。
- 不要设 `LUOPAN_SDK_TEST_MODE=1`；它会绕过正式 ProductNetwork /
  AppCenter entitlement 验收路径。
- MX-H2I `.env` 的 `HOST_RESOLVE`、`DNS_SERVERS`、`RESOLVE_MODE` 不是
  Luopan 配置项。MX-H2I 当前仍在 `main.cjs` 保留了更复杂的 Host/DNS
  解析；下沉的 `@qpjoy/electron-launcher/bootstrap` 2.3.2 是有序 URL
  `/healthz` 探测模型，不能整套复制 MX-H2I 的变量。

窗口出现后点 **Connect Internal**：bootstrap 探测 → registered anonymous
ProductNetwork resolve → registered anonymous lease → Domestic peer sync →
系统授权安装 `luopan.conf` → 路由与 resolved service VIP `/healthz` 验证。
终态必须是 `network-ready`。随后才登录
User Center；若要使用登录 lease 段，再执行一次 Disconnect → Connect Internal。

当前骨架直接覆盖网络 lease/WireGuard/VIP、User Center、内嵌 Oversea 和 Release
Center；还没有专用的 permission/grant 测试 IPC 或页面。登录与 `network-ready`
两项齐备后，主进程会自动确保当前用户的 Oversea 订阅，等待远端同步 ready，再启动
隔离测试 Session 的应用代理。独立网络的成功判据目前也是 VIP
`/healthz`：代码会登记 DNS ownership，但仍设置 `suppressWireGuardDns: true`，因此
`luopan.mxinfo-inc.cn` 的系统解析尚不属于这条已验证路径。这两项是后续功能接线，
不能把“窗口可启动 / VIP network-ready”误报为权限与域名链路也已验收。

旧版 demo 已经生成过 `<userData>/luopan-runtime.json` 时，CONFIG 面板可能保留旧
URL；显式的 process/`.env` 值优先于这些持久值。无 `.env` 运行时，应在 CONFIG
把 Base URL 改为 `10.88.100.3:18090`、Bootstrap URLs 改为
`116.62.51.154:18090`。不要只为修改 URL 删除 runtime；删除会同时更换
installId/deviceId，导致已有 Release Center 定向和证据链失去连续性。

## 1. V2 总体架构

### 1.1 三层结构

```text
┌─────────────────────────────────────────────────────────────┐
│ Internal server（控制面，k8s 部署）                            │
│   enroll/auth · lease 分配 · WG peer 管理 · ownership 仲裁     │
│   Release Center（/release/check 决策、artifact、灰度）        │
│   AppCenter catalog · Admin UI · SDK gateway（docs/15）       │
└──────────────────────────▲──────────────────────────────────┘
                           │ 每产品仅经由自己的 VIP（HTTP/WG）
┌──────────────────────────┴──────────────────────────────────┐
│ @qpjoy/* npm 包（契约层，2.3.14 lockstep）                    │
│   electron-launcher（网络/身份/Oversea ensure facade）         │
│   底层：electron-core-wireguard / electron-plugin-tunnel /    │
│         electron-core-mihomo（Luopan 的代理 runtime 直接消费） │
└──────────────────────────▲──────────────────────────────────┘
                           │ import
┌──────────────────────────┴──────────────────────────────────┐
│ 产品壳（每个产品自己写的部分）                                   │
│   mx-h2i：demos/mx-h2i（全量参考实现，含未下沉的平台逻辑）        │
│   luopan：demos/luopan（你的起点模板，Quasar + Electron）       │
│   产品壳只应包含：窗口/托盘、产品 UI 与 IPC、产品文案、            │
│   本地 runtime 状态、把包 API 串起来的编排代码                   │
└─────────────────────────────────────────────────────────────┘
```

Internal 是用户、权限、ProductNetwork、DNS/代理策略和 release policy 的 desired-state
中心；它不直接修改用户电脑。每个 standalone 仍负责在本机执行并回滚 UAC/LaunchDaemon、
WireGuard、route、平台 resolver 和 PAC，embed 只通过 broker 消费结果。

### 1.2 两个产品的网络坐标（Admin 已注册，不要改）

| 项 | MX-H2I | Luopan |
| --- | --- | --- |
| productId / componentId | `mx-h2i` | `luopan` |
| lease 段 | `10.89.0.0/16` | `10.91.0.0/16`（登录 `.0.1-.99.254`，匿名 `.100.1-.254.254`） |
| service VIP | `10.88.100.1` | `10.88.100.3` |
| 迁移期兼容地址 | `10.88.88.88/32`、`10.88.0.1/32` | **无，禁止使用** |
| internalBaseUrl | `http://10.88.100.1:18090`（迁移期 `10.88.88.88`） | `http://10.88.100.3:18090` |
| Internal 应用域名 | `h2i.mxinfo-inc.cn` | `luopan.mxinfo-inc.cn` |
| 公网 bootstrap | `h2i.minsight-ai.com` | `h2i.minsight-ai.com` |

VIP 是 Internal 把控制面/DNS/代理 materialize 给该产品 channel 的地址，是产品到
Internal 的**唯一路由**。VIP 不跨产品复用；`10.88.88.88` 只属于 MX-H2I 的历史迁移，
Luopan 的任何正式代码路径都不得使用它。demo 会通过 ProductNetwork registry
解析 `serviceVip=10.88.100.3`；这个值属于后端注册数据，不是新应用应复制的
客户端硬编码。

### 1.3 `@qpjoy/electron-launcher` 子路径地图

主入口 re-export 了全部子路径的符号，两种写法都可以；demo 中 luopan 用主入口，
mx-h2i 用子路径动态 import（CJS 环境）。

| 子路径 | 职责 | Luopan 用到 |
| --- | --- | --- |
| `.`（主入口） | `createElectronLauncher`（enroll/lease/snapshot）、`defineLauncherProduct`、下列全部 re-export | ✅ |
| `/bootstrap` | 首连 URL 解析、`/healthz` 探测与打包版 `.env` 加载 | ✅（经主入口） |
| `/standalone-data-plane` | WG 数据面 apply/stop/diagnose、ownership claim 构建/读写 | ✅ |
| `/network-ownership-registry` | 本机多产品共存仲裁（路由/DNS/PAC claim 的登记与合并） | ✅（经 data-plane 间接） |
| `/wireguard` | WG profile/service 底层操作（一般经 data-plane 间接使用） | 按需 |
| `/system-domain-proxy` | local edge/PAC；macOS dynamic supplemental DNS。Windows NRPT 由 `/wireguard` 安装，MX-H2I 默认同时启用 Windows local-edge PAC | MX-H2I 使用；Luopan 当前未接 |
| `/network-diagnostics` | healthz/DNS/路由探测 | ✅ |
| `/release-updater` | Release Center `check()`（服务端决策）+ `report()`（证据链） | ✅ |
| `/release-update-executor` | docs/17 状态机执行器：下载/校验/staged/激活/回滚/adoption | ✅ |
| `/local-ports` | 稳定哈希端口分配（按 productId 命名空间，冲突退避） | ✅ |
| `/oversea`（主入口 re-export） | 登录用户 ensure-subscription，Bearer 只用于换取 inline YAML | ✅ |

## 2. MX-H2I 工作原理走读

这一节是"理解用"的——`demos/mx-h2i/src/main.cjs` 约 1 万行，其中一部分是**尚未
下沉的平台逻辑**（§2.6），照抄它就是踩红线。按下面的地图读，你只需要理解每一步
"调了哪个包 API、维护了什么产品状态"。

### 2.1 启动序列

`app.whenReady()` 后依次（main.cjs:141）：

1. `loadRuntime()`：读 `<userData>/mx-h2i-runtime.json` → normalize → 合并
   独立持久化的 H2O 运行态。**要点：所有持久化状态过 normalize 层**，字段级容错，
   坏文件不致启动失败。
2. `initializeSystemDomainProxy()`：恢复系统域名代理归并面。
3. 启动网络诊断（异步、失败仅告警）。
4. `registerIpc()` → 托盘 → 主窗口。
5. `restoreH2oRuntimeAfterStartup()`：恢复 embed H2O。Luopan 不恢复旧用户代理，而是
   初始化隔离 tunnel runtime；重启后因 token 不落盘，必须重新登录再自动恢复。
6. `reportInstallCompletionAndAdoptPendingUpdates()`：**更新系统的启动期簿记**
   （§2.5 第 4 步），luopan demo 已有对应实现。
7. 三个 watcher：窗口 reveal、WG 恢复、网络变化（睡眠唤醒/切网自愈）。

模式：**所有非关键启动步骤都是 `void fn().catch(warn)`**——任何一步失败不能
阻塞窗口出现。

### 2.2 身份与登录

- 首启生成 `installation`（installId/deviceId/密钥对）并持久化；installId 是
  灰度分桶、ownership ownerId、更新上报的主键，**换了等于换机器**。
- 两种会话：guest（匿名 lease 段）与 employee（登录 lease 段）。Luopan 未登录时先拿
  anonymous lease；User Center 登录后，后续连接会带 `identityKind: 'user'` 和 `userId`
  申请登录 lease。不能再把当前 demo 描述成 anonymous-only。
- V1 → V2 迁移期可设置 `LUOPAN_LEGACY_HDO_BASE_URL`：正常登录仍先走隧道内 VIP；只有
  V2 明确返回账号未激活/不存在的 401 时，才用同一凭据向 V1 HDO 验证，并经 VIP 把账号
  以固定 `mx-user` 权限导入 V2 后重试。V1 token 不落盘，迁移完成应删除该配置。
- 对 server 的所有调用带 `requestedBy` 与 requestId，便于审计串链。

### 2.3 连接与数据面（connect 的完整链路）

```text
bootstrap resolve（域名→IP，可配 DNS server / hostResolve 表）
  → enroll / lease 请求（POST launcher network API，拿 leaseIp + routePlan）
  → WG 数据面 apply（profile 按产品命名：mx-h2i.conf / luopan.conf）
  → ownership claim 登记（routeCidrs + VIP/32 + DNS zones，见 §2.4）
  → 诊断探测（lease-ip / service-vip 可达）→ connected
  → watcher 持续保活：探测失败 N 次降级 → recover（只 repair 自己的路由）
```

对应包 API（luopan demo 全部已接）：`connectNetwork` →
`applyElectronLauncherStandaloneDataPlane`（内部完成 WG + ownership + 探测）→
`diagnoseElectronLauncherStandaloneDataPlane`。断开对称：
`stopElectronLauncherStandaloneDataPlane` 仅在本产品 WG/route/NRPT 清理验证成功后释放
自己的 claim；失败时保留 claim 供 repair，且**绝不触碰其他产品的**。

MX-H2I 额外有 Luopan 用不到的部分：domestic relay、split DNS 多域、bootstrap
DNS 重试链、迁移期 `10.88.88.88` 兼容路由。读到这些直接跳过。

### 2.4 系统面共存归并（红线 1、2 的机制）

系统级资源（路由表、Windows NRPT、WinINet/macOS PAC 和 macOS DNS）是全局的，目标架构
要求多产品经 **ownership registry** 仲裁：

- 每产品把自己的 claim（ownerId=`{productId}:{installId}`、routeCidrs、dnsZones、
  metadata）写进本机 registry（包 API：`upsertElectronLauncherStandaloneOwnershipClaim`
  / `releaseElectronLauncherStandaloneOwnershipClaim`）。包以规范化 state path 派生稳定
  跨进程队列；每个进程使用唯一候选文件，通过 ticket/token 在短租约内完成“读取、冲突
  检查、写 connecting claim”。活 owner 争用在有界等待后 fail closed；仅回收已确认 dead
  PID 的唯一候选，不删除稳定队列目录。状态写入使用临时文件、`fsync` 和原子 rename，
  不能用产品代码自行 read-modify-write。
- Windows NRPT 当前由每个产品的 `electron-core-wireguard` profile/service path 落地，
  规则带产品 Comment 标签并只增删自己的规则；registry 尚未成为统一的 NRPT writer。
  PAC/local edge 也只有实际创建 `system-domain-proxy` manager 的 owner 才会落地。
- 互不重叠的 product-scoped WG service/routes 可以由各 standalone owner 分别写入；
  ownership gate 必须拒绝重叠 AllowedIPs/routes。单写者约束针对 Windows
  `AutoConfigURL`/应用托管 `2053`、macOS shared PAC/resolver 和 machine-global NRPT
  baseline/回滚，不禁止两组隔离的 WG route 并存。
- **产品代码永远不直接调 `netsh`/`networksetup`/NRPT**。luopan demo 里
  `failOnOwnershipConflicts: true` 就是验收态：有冲突宁可失败也不抢。

当前 Luopan 调用 standalone data plane 时使用 `suppressWireGuardDns: true`，且没有创建
`system-domain-proxy` manager；它也不登记自己并未实际持有的 DNS namespace，不安装
Windows NRPT，也不接管系统 PAC。因此 Luopan 当前可验证 ProductNetwork、WG/route、
用户/权限、更新和 claim
隔离，不等于 NRPT/PAC E2E。需要验证这些系统面时，必须使用 MX-H2I 或先为 Luopan 显式接入
同等能力，再执行 docs/18、docs/19 的 Windows 真机矩阵。MX-H2I 的 Windows 完整 ready
同时要求 live NRPT/system DNS、WinINet PAC readback、Chromium `resolveProxy` 指向
`127.0.0.1:2053` 和实际 CONNECT；Luopan 的 route/claim green 不能替代其中任何一项。

因此，**当前 Luopan 与 MX-H2I 可以同时开启**：Luopan 不会写 NRPT/PAC，也不会占用
`2053`。但这不等于支持两个完整 network owner。若未来 Luopan 也启用 DNS/PAC，Windows
当前用户级 lease queue 会在任何 state/registry 修改前安全拒绝第二个进程，即使它改用不同的
PAC 端口或 state path；不得用两个进程分别写 `AutoConfigURL`。应先把
owner claim、PAC 合并、NRPT 全局状态和最后一个 owner 退出时的回滚下沉到单一、长生命周期
Launcher network broker。

验收工具：`scripts/coexist-check.mjs`（snapshot/assert/diff/run，内置 C1–C12
双产品矩阵，见 docs/19 §4.2 与 HANDOFF 验收标准）。

### 2.5 更新系统（docs/17，Luopan 必须完整复刻的部分）

这里的 `demos/luopan` 是验收壳，不是正式 Compass 项目。正式 Compass
使用 `packageName=compass` 解析已有平台身份：AppCenter `appId=luopan`、Release `productId=luopan`、
app installer/ASAR `componentId=luopan`、ProductNetwork `luopan`、生产 channel `stable`。
不要新建 `productId=compass`，也不要改名已有 ProductNetwork。`@qpjoy/luopan-demo`
只是后台存量 row 和历史客户端的 resolver 迁移兼容；正式项目始终使用 `compass`。

四个角色，前两个在服务端、后两个在包里：

1. **Release Center（server）**：Admin/CLI 或产品受限的 Publisher API 建 plan
   （版本 + release notes + 目标 userIds/installIds + feature flags），过 gate 后对外可见。
2. **决策端点** `POST /internal/v1/release/check`：单 install 决策——targets 显式
   圈选优先，percentage 走 sticky 分桶 `sha256(componentId:channel:installId)%10000`，
   gate 未过返回 blocked；响应带 releaseNotes、featureFlags、`rollout.matchedBy`、
   HMAC 签名。正式 Compass 先以 `packageName=compass` 解析发布身份，再发送服务端
   返回的 `productId=luopan`，避免把示例 ID 复制到其他产品，也避免派生组件名碰撞。
   旧版显式发送 `productId=luopan` 的路径保持不变。
   客户端**永远拿不到全量 plans**（旧端点已收敛 admin-only）。
3. **release-updater（包）**：`check()` 打决策端点（老 server 自动 fallback legacy），
   `report()` 上报证据链。
4. **release-update-executor（包）**：docs/17 状态机
   `idle→checking→downloading→verifying→staged→activating→reported`，按 artifact
   class 分四条管线：

Publisher 和 Consumer 必须分离。Luopan CI 使用 service account 的
`sdk.release.read/publish/approve` 和 `allowedProductIds=["luopan"]`，经
`/internal/v1/sdk/releases*` 上传与审批；用户电脑仍只调用现有
`release/check`、history、report 和 download URL。Publisher secret 不得进入
Electron 包或 renderer。完整契约见 [docs/25](25-release-center-developer-api.md)。

| artifact class | 激活方式 | 回滚 |
| --- | --- | --- |
| `config`（feature flag 快照） | 原子换 `<userData>/update-slots/config/` 指针 → `applyConfig` 回调 | `rollback('config')` 指针切回 previous |
| `renderer`（UI bundle） | 换 renderer 槽位指针 → `applyRenderer` 回调（reload 窗口） | 同上 |
| `npm-package` / `asar` | 只写 `launcher-packages/<componentId>/<version>` + `.pending.json`，**下次启动**由 `adoptPendingElectronLauncherPackages` 提升为 current | 保留上一版本目录 |
| `installer` | **永远手动**：staged 后由用户点确认 → `openStagedInstaller` 走 OS 打开 | 用户不装即回滚 |

稳定性边界（executor 内建，产品只需注入 `networkGate`）：连接
connecting/recovering/permission-required 时激活自动 defer 并上报
`artifact-activation-deferred`。证据链 report 状态：`download-started` →
`artifact-staged`/`installer-downloaded` → `artifact-applied`/
`artifact-staged-pending-restart` → 启动期 `installer-completed`（版本变化时），
失败路径 `download-failed`。**report 失败从不阻塞更新流程**，服务端把缺失当灰度
健康度缺口。

灰度取向（平台已确认）：以 targets 显式定向为主（可精确到 1 个用户），
percentage/ring 保留在数据模型不上 UI；"全量版 vs 部分功能版"= 同一个安装包 +
per-user feature flag 快照（config 管线热应用），**不打两个包**。

### 2.6 AppCenter host、broker 与 embed 应用（未下沉，Luopan 可选）

MX-H2I 除了自己是 standalone launcher，还承载 embed 应用（H2O 插件）：

- **AppCenter host**：从 `/internal/v1/app-center/apps` 同步目录、把应用安装到
  `<userData>/appcenter-cache/<appId>`、manifest 握手（protocolVersion 2、
  requiredCapabilities 校验）。
- **broker**：给 embed 应用分发 capability/token/网络上下文（embed 应用
  `networkScope: 'broker-session'`，`launchWithoutBroker: 'blocked'`——embed 的流量
  归因到宿主 channel，不占独立 lease）。
- embed 侧对应包是 `@qpjoy/mx-launcher-embed-sdk`（H2O 用它），但 **host 侧
  （appcenter-host、broker server）还在 main.cjs 里没有下沉**，包里没有
  `appcenter-host` 子路径。

对 Luopan 的含义见 §6。

这里的“未下沉”只指 **通用 AppCenter host/broker/第三方 embed 应用**。Luopan
现在内置的 Home to Oversea 不是把 `mx-app-h2o` 嵌入进来：身份/ensure 契约已下沉到
`@qpjoy/electron-launcher`，mihomo 生命周期/inline YAML/测试窗口复用
`@qpjoy/electron-plugin-tunnel`，产品壳只保留窄状态机与 `luopan:*` IPC。因此仍保持
`launcherActions.appCenter=false`，也没有复制 `mx-h2i/main.cjs`。

### 2.7 状态持久化与防回归快照

mx-h2i 的约定，建议 Luopan 照搬（luopan demo 已具备前两条）：

- 单文件 JSON runtime（`<userData>/luopan-runtime.json`），写入 normalize、读出
  normalize，任何字段缺失/损坏都有默认值。
- 客户端自有状态（用户配置的东西）在 merge/normalize 时**以本地为准**——mx-h2i
  曾因目录同步 merge 以服务端记录为底座，把用户的 H2O 订阅清空（已修）。凡是
  "服务端目录 + 本地运行态"合并的地方，服务端只拥有元数据。
- mx-h2i 另有 `<userData>/state-backups/` 快照环（最近 5 份去重快照 + 恢复 IPC，
  见 docs/18 附录）保护用户态数据；Luopan 出现同类"用户配置的持久化状态"时
  建议同样处理（或找平台方把快照环下沉成包工具）。

## 3. Luopan 骨架走读（demo 现状）

`demos/luopan/src-electron/electron-main.ts`（全部是产品壳 + 包 API
编排，无复制的平台逻辑），按块读：

| 块 | 内容 | 关键 API |
| --- | --- | --- |
| PRODUCT 定义 | `defineLauncherProduct({ productId: 'luopan', ... })` 是现有 ProductNetwork/ownership 的稳定身份；正式 Compass 的 Release updater 以 `packageName=compass` 解析到同一 `productId=luopan`，两类字段值不同且生命周期分离 | `defineLauncherProduct`、`createElectronLauncherReleaseUpdater` |
| runtime state | `RuntimeState`（installId/deviceId/config/connection/oversea/update/events），loadRuntime/saveRuntime/normalize 三件套 | — |
| lease 获取 | `luopan:connect-test-mode` → `launcherClient().connectNetwork(...)`（registered/test 模式由 `sdkTestMode` 决定，默认 registered；登录后自动带 `identityKind: 'user'` + userId 切登录 lease 段） | `createElectronLauncher` |
| 用户中心 | `network-ready` 后，`luopan:login` / `luopan:logout` 才经隧道内 VIP 执行 SDK gateway OAuth password grant（docs/15 `/internal/v1/sdk/oauth/token`）→ `principal.userId` 存入 runtime.identity；access token 只留内存。登录用户可命中 Release Center 按 userId 定向的发版 | SDK gateway |
| 数据面 apply | `luopan:apply-data-plane`：standalone 模式走 `applyElectronLauncherStandaloneDataPlane`（profile `luopan.conf`、ownerId `luopan:<installId>`、`failOnOwnershipConflicts: true`）；reuse 模式（`LUOPAN_DATA_PLANE_MODE=reuse`）尝试挂到已有共享数据面 | `/standalone-data-plane` |
| 一键连入 | `luopan:connect-internal` = lease + 数据面 + 隧道内 VIP healthz，成功即 `network-ready`（§4.5 客户端部分） | 同上 |
| 断开/退出 | standalone 调 `stopElectronLauncherStandaloneDataPlane`，仅在本产品 WG/route 清理证明成功后释放 claim；reuse 只 release `luopan:<installId>` attach claim，不停止 shared owner。`before-quit` 会阻止 Electron 直接退出并等待同一套清理，失败则保存错误并重新显示窗口 | 同上 |
| snapshot | `luopan:refresh-snapshot` → `createSnapshot` + `routePlanFromSnapshot` + diagnose | 主入口 |
| **Oversea** | 登录 + Internal ready 双门 → ensure ready → inline YAML → 应用级 mihomo → 隔离测试窗口；登出/断网停止 | launcher `/oversea` + `electron-plugin-tunnel` |
| **更新** | `luopan:check-updates` / `apply-update` / `open-staged-installer` / `rollback-update-slot` + 启动期簿记 | §5 逐段讲解 |

正式开发 = 保留这个骨架的结构，替换 UI 与产品逻辑，把 `connect-test-mode` 换成
产品真实的登录/连接流程。**不需要往骨架里加任何来自 main.cjs 的函数。**

开发/打包模式（红线 5）：

```sh
pnpm run setup        # local：workspace 直连，日常开发；不能省略 run
pnpm run setup:npm    # npm：按当前 package.json 版本从 registry 安装（正式打包前必须）
pnpm run dev          # quasar dev -m electron
pnpm run build        # quasar build -m electron --skip-pkg
```

## 4. 网络与共存：开发要点

- **routeCidrs 白名单心态**：连接成功后自查 `connection.routeCidrs` ⊆
  `{10.91.0.0/16, 10.88.100.3/32}`，超出即 bug。重连/恢复路径同样约束——
  "恢复"= 重建自己的 claim，不是 adopt 现场发现的路由。
- **诊断顺序**：control 面 `http://10.88.100.3:18090/healthz` → 数据面 route/ping VIP
  → DNS policy/materialization。当前 demo suppress WG DNS 且未接 system-domain-proxy，
  所以 `luopan.mxinfo-inc.cn → 10.88.100.3` 只能验证服务端 materialization/claim，不能
  证明客户端系统 resolver 已接管。平台侧交付前会给你验证过的 base URL；接入问题先区分
  route-ready 与 resolver-ready 再上报。
- **端口**：任何本地监听端口经 `/local-ports` 申请（productId 命名空间 + 稳定
  哈希 + 冲突重分配），不 hardcode。
- **验收节奏**：骨架连上 `10.88.100.3` 后，第一个里程碑就是
  `node ../../scripts/coexist-check.mjs run` 跑 C1–C12 双产品矩阵全绿
  （Windows 10/11 + macOS）。开发期建议每次动网络相关代码都跑
  `assert --product luopan --expect connected` 冒烟。

### 4.5 接入 Internal 的开通流程（平台侧 + 客户端）

一个新 standalone 产品从"代码能跑"到"真正连入 Internal"，服务端要过四道，客户端
一道。Luopan 平台侧已由我们完成，此节既是记录，也是未来新产品的模板。

#### 平台侧 ①：Admin 注册应用与 ProductNetwork（一次性）

Admin → Apps → 新建应用，选 **Luopan 模板**（或通用 `Standalone business app`
模板）。Save App 会一次创建：

- **AppCenter app**：`appId=luopan`、`launcherMode=standalone`、
  `productNetworkId=luopan`、`requiredCapabilities` 含
  `launcher-network` + `launcher-standalone`、`enabled=true`。
- **ProductNetwork**：二段位自动取下一个空闲值（跳过 88）——lease
  `10.<octet>.0.0/16`，登录段 `.0.1–.99.254`、匿名段 `.100.1–.254.254`；
  `serviceVip / internalControlIp / dnsServer / domesticGatewayIp` 四字段默认同一
  个 materialized VIP（Luopan = `10.88.100.3`）。**VIP 必须唯一**，不同产品不得
  复用（Admin 曾有默认沿用 `10.88.100.3` 的缺陷，新建其他产品时务必检查）。
- **DNS route + gateway upstream**：`luopan.mxinfo-inc.cn` A → VIP，gateway 按
  Host 反代到应用 targetUrl。

这四样就是服务端 lease 校验链逐条检查的东西（`enrollLease` →
`assertLauncherNetworkLeaseEntitlement`）：ProductNetwork 存在且 enabled → app
存在且 enabled → app 绑定该 ProductNetwork 且 mode 匹配 → capabilities 齐全。
少任何一样，客户端 enroll 会收到对应的明文错误（见下面对照表）。

#### 平台侧 ②：mx-internal-svc / Domestic relay 要不要设置？

**不需要手工编辑任何 WG conf，但注册后必须触发一次 reconcile。** 背景
（docs/14）：`mx-internal-svc` 是 Internal 侧的 WG service peer interface（固定
`10.88.88.88/32`），它生成配置里的 peer `AllowedIPs` = `10.88.0.1/32` +
`10.88.0.0/16` + **各产品 relay CIDR**。新产品的 lease `/16` 和 VIP `/32` 不进这
份配置，VIP 就不通。

操作：Admin → 该 App 详情 → Service VIP 面板 → **Reconcile**
（`POST /internal/v1/admin/launcher-service-vip-smokes/reconcile`）。一次完成：

1. productRelayCidrs 同步：把 `10.91.0.0/16` + `10.88.100.3/32` 写进 Domestic WG
   secret；
2. 重新 materialize Domestic WG artifact；
3. apply Domestic relay runtime（`mx-domestic`）；
4. apply Internal service peer（`mx-internal-svc`）；
5. domestic peer key sync。

分步版：先点 `Sync domestic CIDRs`
（`launcher-service-vip-smokes/domestic-product-cidrs/sync`），按返回的
nextActions 再做 re-materialize + apply。另外跑一次
`manage.sh ops internal-production deploy` 也会自动带出最新 productRelayCidrs
（docs/14：不要求手工改线上配置）。

#### 平台侧 ③：交付 base URL 前的三步自查

1. `http://10.88.100.3:18090/healthz` 通（经隧道，从一台已连接的机器验证）；
2. DNS：`luopan.mxinfo-inc.cn` 解析到 `10.88.100.3`；
3. gateway 反代该域名可达应用页面。
   工具：`node scripts/coexist-check.mjs assert --product luopan --expect connected`。

#### 客户端：首连语义

demo 默认 **registered 模式**（`sdkTestMode=false`），工具栏 **Connect Internal**
一键完成：注册 lease（匿名段）→ 本机 WG 数据面 apply → 隧道内 VIP healthz 探测，
`network-ready` 即证明产品到 Internal 的路径端到端可用。分步按钮
（Request lease / Apply data plane）保留用于教学与排障。

- **bootstrap 先有鸡还是先有蛋**：第一次 enroll 时 WG 还没起，`baseUrl` 必须是
  当下就可达的地址——同网/LAN 直达 server，或平台提供的公网 bootstrap 代理
  （转发 enroll/lease/snapshot，参照 mx-h2i 的 `h2i.minsight-ai.com` 公网 bootstrap 模式）。连上
  之后产品流量一律走自己的 VIP。
  这套语义已下沉进包（≥2.3.2）：`@qpjoy/electron-launcher/bootstrap` 提供
  `resolveElectronLauncherBootstrap`（候选 URL 顺序探测 `/healthz`，命中即钉住）、
  `parseElectronLauncherBootstrapUrls`（env 值解析）、`loadElectronLauncherEnvFiles`
  （打包版 .env 加载，真实 env 优先）。luopan demo 的接线：`.env` 写
  `LUOPAN_BOOTSTRAP_URLS`（或 CONFIG 面板填），匿名 enroll/bootstrap 在
  `network-ready` 前走解析出的 bootstrap URL；V2 登录只在网络就绪后走 VIP。显式配置的
  `LUOPAN_LEGACY_HDO_BASE_URL` 仅用于账号缺失时的一次性 V1 身份验证，不是 bootstrap。
  每次 Connect 重新
  探测以适应切网。新产品照抄 demo 的 `ensureBootstrapResolved` /
  `effectiveApiBaseUrl` 两个函数即可。
- **SDK test mode 的真实语义**：server 侧 `launcherNetworkSdkTestModeEnabled=true`
  **且**客户端显式传 `sdkTestMode: true` 才生效，作用是跳过 ProductNetwork/App
  注册校验（服务端现场造一个临时 product）。只用于未注册环境的本地开发；生产
  Internal 不开这个开关，正式构建禁止出现 `LUOPAN_SDK_TEST_MODE`。

#### enroll 常见错误对照

| 客户端报错 | 缺的东西 |
| --- | --- |
| `Launcher product luopan is not registered` | ProductNetwork 未创建（或 productId 拼错） |
| `Launcher product/channel ... is disabled` | ProductNetwork `enabled=false` |
| `Launcher app luopan is not registered in AppCenter` | AppCenter app 未创建 |
| `Launcher app ... lacks required capabilities: ...` | app 的 requiredCapabilities 缺 `launcher-network` / `launcher-standalone` |
| `Launcher app ... is bound to X, not luopan` | app 的 productNetworkId 绑错 |
| lease 拿到了但 VIP healthz 不通 | 平台侧 ② 的 reconcile 没跑（mx-internal-svc / Domestic 配置里没有产品 CIDR），或本机数据面 apply 失败（看 dataPlane probes） |

## 5. 更新执行器接线逐段讲解

demo 已带完整接线（本节代码都在 `src-electron/electron-main.ts`，搜索
"Release update wiring"）。下面的身份值是正式 Compass 接入值；demo 现有配置按其
测试用途保持不变。分层记住一件事：

> **updater = 问服务端"我该不该更新"（check/report）；
> executor = 把决策落地（下载/校验/staged/激活/回滚）。**
> 产品壳只做三件事：把两者实例化、注入产品回调、暴露 IPC 给面板。

### 5.1 实例化

```ts
function releaseUpdater(): ElectronLauncherReleaseUpdater {
  const state = requireRuntime();
  return createElectronLauncherReleaseUpdater({
    baseUrl: state.config.baseUrl,        // 10.88.100.3:18090——决策走产品自己的 VIP
    reportInstallId: state.installId,     // 证据链主键
    packageName: 'compass',
    channel: 'stable'
  });
}

function updateExecutor(updater: ElectronLauncherReleaseUpdater) {
  return createElectronLauncherReleaseUpdateExecutor({
    updater,
    baseDir: app.getPath('userData'),     // update-slots/ updates/ launcher-packages/ 都在这下面
    installId: requireRuntime().installId,
    networkGate: () => updateNetworkGate(),   // 5.3
    applyConfig: (activePath) => { ... },     // config 快照激活后：重载策略 + 广播
    applyRenderer: (activePath) => {          // renderer 激活后：reload 窗口
      mainWindow?.webContents.reload();
    },
    openInstaller: async (filePath) => {   // installer 手动确认后走 OS
      const message = await shell.openPath(filePath);
      if (message) throw new Error(message);
    }
  });
}
```

注入点就是产品差异所在：MX-H2I 的 `applyRenderer` 也是 reload、`networkGate` 看
WireGuard connecting 状态——**两个产品的更新行为差异只来自这些注入参数**
（docs/19 §3 的验收标准）。

### 5.2 检查（`luopan:check-updates`）

```ts
const checks = [];
for (const componentKind of ['app-asar', 'app-installer', 'renderer-ui']) {
  checks.push(await releaseUpdater().check({
    componentKind,                           // 组件 ID 由 package identity 派生
    currentVersion: runningElectronLauncherVersion(app.getVersion()),
    installId: state.installId,
    platform: process.platform,
    arch: process.arch
  }));
}
lastUpdateCheck = chooseUpdateCheck(checks); // 只留内存，见下
state.update = updateFromCheck(lastUpdateCheck);
```

- `check()` 优先打 `/release/check`（服务端单 install 决策），老 server 自动
  fallback。检查是**只读**的，不下载任何东西。
- demo 与 mx-h2i 同约定检查**三类制品**：ASAR 和 installer 计划 target
  `luopan`，renderer 热更计划 target `luopan-renderer`，择优取 update-available（发版时
  注意 componentId 对应）。登录态下 check 会带 `userId`，按用户定向的计划只对
  登录用户可见。
- 结果里给面板用的字段：`status`（up-to-date / update-available / blocked /
  failed）、`decision.targetVersion`、`releaseNotes`（markdown 原文）、
  `rollout.matchedBy`（如 `指定用户`——验收要求面板展示）、`featureFlags`。
- `lastUpdateCheck` **不持久化**：apply 必须基于一次新鲜决策，不能拿昨天存盘的
  check 去执行（服务端可能已撤版/改 targets）。重启后想 apply，先 check。

### 5.3 执行与激活门禁（`luopan:apply-update`）

```ts
if (!lastUpdateCheck || lastUpdateCheck.status !== 'update-available') return;  // 无票不执行
const result = await updateExecutor(releaseUpdater()).execute(lastUpdateCheck);
state.update.execution = executionSummary(result);   // 每个 artifact 的 phase/activated/deferredReason/error
```

`execute()` 内部对每个 artifact：下载到 `updates/<releaseId>/`（sha256 + 大小
双校验，临时文件原子 rename）→ report `artifact-staged` → 按 class 走 §2.5 的
四条管线。产品壳不用写任何下载/校验/槽位代码。

Release Center 的 `deliveryMode` 决定谁触发 execute：

- `prompt-download-restart`（旧 plan 的默认值）：连网后的自动 check 弹出更新提示；
  用户确认后下载并校验 ASAR，再询问“立即重启 / 下次启动”。面板中的
  “下载并应用”与“立即重启”提供同一条手动路径；
- `silent-download-next-start`：仅 ASAR 可用，连网后的自动 check 在后台 stage，
  不主动重启，下一次自然启动由 bootstrap 启用；
- installer 无论传什么值都由服务端强制为提示/人工安装。

门禁映射是 Luopan 自己的连接语义翻译成 executor 的通用状态：

```ts
function updateNetworkGate(): ElectronLauncherNetworkGateState {
  const status = requireRuntime().connection.status;
  if (status === 'connecting') return 'connecting';
  if (status === 'data-plane-pending') return 'recovering';
  return 'idle';
}
```

被 defer 的 artifact 会带 `deferredReason`（面板显示"网络恢复后重试"），且已
staged——网络稳定后再点一次 apply 即可激活，不重复下载（digest 命中直接复用属于
后续优化，当前重新下载也正确）。

### 5.4 installer 手动确认（`luopan:open-staged-installer`）

installer class **永远不会被 executor 自动激活**（`execute` 里直接 skip）。下载完成后
原生提示框或面板上的“立即安装”按钮触发本 IPC：从 `lastUpdateCheck` 找 installer artifact →
`executor.openStagedInstaller(artifact)` → OS 打开安装包 + report
`installer-opened`。安装完成的闭环由 §5.5 的启动簿记回报。

### 5.5 启动期簿记（`adoptUpdatesAndReportInstallCompletion`）

`app.whenReady` 里异步执行、失败仅告警（与 mx-h2i 同模式）：

1. 完整安装包的 `electron-bootstrap.cjs` 在主模块加载前调用
   `selectElectronLauncherAsar`，把 pending ASAR 提升为 current；窗口 ready 后调用
   `confirmElectronLauncherAsarLaunch`。未确认的崩溃启动会自动切回 previous。
2. `adoptPendingElectronLauncherPackages(baseDir)` 保留 npm-package 的通用启动簿记。
3. `reportElectronLauncherInstallCompletionIfUpgraded(...)`：对比本次启动版本与
   上次记录（`update-slots/app-version.json`），变了就 report
   `installer-completed`——Release Center 靠它把该 install 标记为升级完成，超时未
   回报计入灰度健康度。

### 5.6 回滚（`luopan:rollback-update-slot`）

`executor.rollback('config' | 'renderer')`：槽位指针切回 previous 并触发对应
apply 回调 + report `artifact-rolled-back`。面板给个二级菜单入口即可，不常用但
验收会检查存在。

### 5.7 面板要求（验收项）

renderer 侧消费 `runtime.update`（preload 已暴露
`checkUpdates/applyUpdate/restartApp/openStagedInstaller/rollbackUpdateSlot`），至少展示：
当前/目标版本、`status`、`releaseNotes` 原文、`matchedBy`（灰度命中原因）、每个
artifact 的 execution 状态（含 deferredReason/error），按钮四个对应四个 IPC。样式
随意（可用 `@qpjoy/ui-design-neon-void`），字段齐全即过验收。

### 5.8 端到端自测（对着真实 server）

复用 docs/18 Layer 6.6 的十分钟流程，把客户端换成 luopan。产品开发者通过
[docs/25](25-release-center-developer-api.md) 的 scoped Publisher API 发版；以下 CLI
只是该 API 的便捷包装，应运行在受保护的 Internal CI，不在 Luopan 客户端运行：

1. 平台方先提供 `svc_luopan_release_ci` 的账号独立 secret，并确保 scopes 包含
   `sdk.release.read/publish/approve`、`allowedProductIds` 只含 `luopan`。上传热更
   bundle，建立只圈自己 userId 的 `blocked`（待验证）计划。CLI 等价：

   ```sh
   export MX_RELEASE_CLIENT_ID=svc_luopan_release_ci
   # MX_RELEASE_CLIENT_SECRET 由 CI secret store 注入。
   pnpm --dir server release:publish -- \
     --base-url http://10.88.100.3:18090 --product luopan --kind asar \
     --artifact demos/luopan/dist/electron/release-asar/Luopan-0.1.2-darwin-arm64-app.asar \
     --version 0.1.2 --current-version 0.1.1 \
     --platform darwin --arch arm64 --channel shadow \
     --delivery-mode prompt-download-restart \
     --target-user <你的 userId> \
     --release-id luopan-asar-0.1.2-darwin-arm64 \
     --request-id luopan-asar-0.1.2-darwin-arm64-target-001
   # installer 类：--kind installer --platform darwin|win32 \
   #   --arch x64|arm64|universal（component 自动为 luopan，artifactKind=app-installer）
   ```

   新 plan 的 gate 对外为 blocked（内部 E2E run 仍在 running），Consumer 也返回
   blocked。先由 CI/受控验证机对同一 artifact 做 digest、签名、安装和启动 smoke，
   再由带 approve scope 的身份通过定向 gate；不要在创建时直接声称 passed。
2. Luopan 面板点检查更新 → 应显示 update-available + notes + `Matched by=指定用户`
   → 点应用 → 面板出现 execution 结果（renderer 类会看到窗口 reload）。
3. 换一个不在 targets 里的账号/installId 复查 → up-to-date，看不到计划信息。
4. installer 类再走一遍：staged 后点"立即安装"→ OS 打开；装完重启 →
   事件流出现 `installer completed <old> -> <new>`。
5. 服务端审计里按 installId 应能串出 `release-check → download-started →
   artifact-staged → artifact-applied / installer-completed` 完整链。
6. 定向客户端证据通过后，复用同一个 `artifactId`、换新 `requestId` 建立并审批
   `all / 100%` 的新计划；定向计划不会自动扩大 audience。

## 6. embed launcher（可选章节）

**Luopan 不承载 embed 应用**：§2.6 的 AppCenter host/broker 代码仍与 Luopan
无关，`defineLauncherProduct` 里 `appCenter: false` 保持。内嵌 Home to Oversea
是产品能力，不是 hosted `mx-app-h2o`，两者不要重新耦合。

**如果 Luopan 之后要承载 embed 应用**（在 Luopan 里跑第三方插件）：

- 你需要的能力是 host 侧三件套：目录同步 + 安装缓存、manifest 握手、broker
  （capability/token/网络上下文分发，embed 流量归因到 luopan channel）。
- 这三件套目前**只存在于 mx-h2i 的 main.cjs，尚未下沉成包**（没有
  `appcenter-host` 子路径）。这正是"demo 里有、包里没有"的典型情形——
  **流程：带着需求找平台方，平台方下沉出 `@qpjoy/electron-launcher/appcenter-host`
   后你消费包 API**。自己从 main.cjs 抄 host/broker 代码 = 两边行为漂移 +
  验收不过。
- embed 应用自身那侧的契约（`@qpjoy/mx-launcher-embed-sdk`）已经是包，第三方
  插件开发不受影响。

## 7. 从零到验收的里程碑

1. **跑通模板**：按 §0 配置 `LUOPAN_BOOTSTRAP_URLS`，`pnpm run setup && pnpm run dev`，
   registered 模式拿 lease、apply 数据面、snapshot 刷新全绿。
2. **连真实 VIP**：平台方自查 healthz/DNS/gateway 后给 base URL；enroll 成功、
   `routeCidrs` 只含自己的两段。
3. **共存矩阵**：与 MX-H2I 同机跑 `coexist-check.mjs run` C1–C12 全绿
   （Windows + macOS）。← **第一个正式验收里程碑**
4. **Oversea 链路**：先匿名连接 Internal，再登录；用户 ensure 返回 ready，mixed 端口监听，隔离测试窗口
   `resolveProxy` 命中；pending sync 不误报成功，登出后端口释放。
5. **更新链路**：§5.8 端到端自测全过；面板字段齐全。
6. **产品化**：换 UI/登录/业务；期间任何"想抄 main.cjs"的冲动 → 找平台方下沉。
7. **发布**：依次发布 tunnel engine `0.1.6`、core-mihomo `0.1.2`、tunnel `0.1.18`，
   再发布 launcher 六包 train `2.3.14`；随后 `pnpm run setup:npm` 构建正式包（红线 5）、签名
   （Windows 内部 CA / macOS Developer ID + notarize，见 docs/19 §7.1）、注册进
   Release Center 走灰度。

## 8. FAQ

- **demo 里有个函数包里没有，我能先复制吗？** 不能。开 issue/找平台方，等下沉。
  短期 workaround 也必须写在自己产品壳里、不 import demo 文件。
- **为什么我的 baseUrl 不能配 `10.88.88.88`？** 那是 MX-H2I 的迁移期兼容地址，
  不是"公共入口"。用了它 = 流量归因错乱 + 共存矩阵 C10 必挂。
- **check 返回 up-to-date 但我确实发了版？** 依次查：channel 是否 `shadow`
  一致、targets 是否圈了你的 userId/installId、gate 是否 Complete、installId 是否
  变过（重装/清 userData 会换 installId）。
- **更新执行到一半断网了？** executor 是幂等的：staged 文件带 digest 校验，
  激活被 gate defer 后再次 apply 即可；报表缺口服务端可见，不需要客户端补偿。
- **两个产品同时检查更新会互相干扰吗？** 不会：per-channel 独立 scheduler、
  独立 userData 目录、独立 installId（共存矩阵 C11 验证这一点）。
- **pnpm 版本**：仓库 `packageManager` 锁定 `pnpm@10.24.0`，优先通过
  Corepack 使用该版本。npm 模式生成的 workspace 同时兼容 pnpm 10 的
  `onlyBuiltDependencies` 与新版的 `allowBuilds`。
