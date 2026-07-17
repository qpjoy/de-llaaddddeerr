# MX-H2I 正式交付、npm 发布与 Luopan Handoff 方案

本文档回答四个问题：

1. 哪些包必须发布到 npm、按什么顺序和版本策略发布，开发态 workspace 引用和线上 npm 引用如何切换。
2. 把 mx-h2i demo 交付给其他开发者做 Luopan 时，交付物清单和对方必须遵守的边界。
3. 多个 standalone 产品（MX-H2I + Luopan）同机共存的不变量和冲突测试矩阵，覆盖 Windows/macOS。
4. 更新系统（安装包、asar、npm 热更、配置）和灰度发布还差什么，按什么阶段收尾，最终做到"只走版本更新、不再手动分发"。

前置阅读：[14-mx-h2i-standalone-launcher-architecture.md](14-mx-h2i-standalone-launcher-architecture.md)（共存与
materialization 规则）、[17-mx-h2i-release-center-update-system.md](17-mx-h2i-release-center-update-system.md)
（更新系统决策）、[18-mx-h2i-release-validation-runbook.md](18-mx-h2i-release-validation-runbook.md)（发布验证分层）。

## 现状 Gap 清单（2026-07）

已就绪：

- mx-h2i demo 基本功能（游客/员工连接、H2O embed、AppCenter、检查更新 UI）测试通过。
- Internal Release Center：plan 创建、artifact 上传（OSS/Internal store）、policy 区分 hot/installer、
  Admin drawer、`release:publish` CLI。
- `@qpjoy/electron-launcher` 的 `release-updater`：check、sha256 校验下载、staged、report。
- 本次待发布基线：`@qpjoy/electron-plugin-tunnel@0.1.18`、`@qpjoy/electron-core-wireguard@0.2.1`、
  `@qpjoy/electron-core-mihomo@0.1.2`，以及 Darwin ARM64 tunnel engine `0.1.6`；
  其他 wireguard/tunnel 平台 engine 包保持各自未变版本。

未完成（本文档要收敛的）：

| # | Gap | 影响 |
| --- | --- | --- |
| G1 | `@qpjoy/electron-launcher`、`@qpjoy/mx-launcher-core/-standalone/-embed-sdk` 未发布 npm（404） | Luopan 开发者拿不到依赖；正式打包只能靠 workspace |
| G2 | mx-h2i 的 `dev-mode.mjs` 只有 `local` 模式，没有 HDO 那样的 `npm` 模式 | 无法验证"正式包 = npm 安装"路径 |
| G3 | updater 执行器不做热替换（renderer/asar/config staged 后不 apply），installer 打开后无重启完成回报 | 达不到"只走版本更新" |
| G4 | `release-updater.check()` 拉全量 `/release-management/plans` 客户端过滤：percentage/ring/scope 不参与决策，任何客户端能看到所有 plan | 灰度实际不生效，且泄露发布计划 |
| G5 | 共存规则（doc 14）已写成设计，但没有可执行的双 standalone 冲突测试矩阵 | Luopan 上线后无法证明不打架 |
| G6 | standalone/embed 拆分粗：`demos/mx-h2i/src/main.cjs`（1 万行）里混着 broker、update 执行、ownership、
      AppCenter host 等应下沉到包的平台逻辑 | Luopan 会被迫复制粘贴 main.cjs，两边行为漂移 |
| G7 | Windows 签名 / macOS 公证在 CI 中未闭环 | 外发包触发 SmartScreen/Gatekeeper，手动分发无法消除 |

状态更新（2026-07-09）：

- G1 已解决：MX-H2I npm 包组 6 个包全部以 **2.0.0** lockstep 发布到 npmjs（`workspace:^`
  改写验证通过），本地版本已同步。luopan 在 npm 模式下从 registry 安装并 quasar build 成功。
- P1 已交付：`demos/luopan/HANDOFF.md`（注册网络值、红线、npm/local 模式、验收标准），
  README 顶部有指引。注意：Admin 新建 standalone 应用时 service VIP 必须唯一分配，
  不能沿用 `10.88.100.3` 默认值（服务端待加自动分配 + 重复拒绝）。
- G2 已解决：共享 `scripts/dev-mode.mjs` 支持 `local|npm|ensure` 三模式；mx-h2i 在 npm 模式下
  从 registry 安装并用 electron-builder 打出 win-unpacked 验证通过；demo 的 `package/make*`
  改用 `ensure`，不再在打包时悄悄切回 local。npm 模式会在 demo 目录生成独立的
  `pnpm-workspace.yaml`（承载 pnpm 11 的 `allowBuilds` 审批）和本地 lockfile，切回 local 时清理。
- 发布入口：`scripts/manage.sh prepare-mx-h2i`（统一 bump 版本 → build → pack 预览 → 一个 OTP
  发布全组，已发布版本自动跳过）；`electron-dock/mx-launcher/scripts/publish-packages.mjs` 是
  CI 侧非交互路径（默认 dry-run，`--publish` 才真发）。
- P2 进展：三个薄弱点摸底结果——(a) Windows NRPT 的 Add/Remove 原来只按 namespace 匹配、
  无视 Comment 归属，已在 `electron-core-wireguard` 修复为"只动自己标签（或完全无标签的
  legacy）规则"，并在 Add 时对外部同 namespace 规则写 `nrpt conflict` 审计；产品标签也不再
  让非 mx-h2i tunnel 一律伪装成 HDO（Luopan 会得到 `MX-LUOPAN / QPJoy Luopan` 标签和自己的
  ProgramData 目录）。(b) mihomo 端口 23457/23458 写死：`@qpjoy/electron-launcher/local-ports`
  新增按 productId+service 哈希的稳定端口分配器（21000–40999，探测+扫描），mx-h2i 的
  `prepareH2oRuntimePortsForStart` 在清理自家孤儿进程后仍冲突时改为重分配自己的端口，而不是
  报错放弃（孤儿匹配本就按自己 userData 的二进制全路径，不会误杀其他产品）。(c) macOS PAC
  合并早已在 `system-domain-proxy` 内实现（ownership claims 并入 PAC 域/路由），断开交接为
  运行时验证项。共存断言工具 `scripts/coexist-check.mjs`：`snapshot / assert / diff / run`
  四个命令，内置 C1–C12 半自动场景，已在真机对 mx-h2i 双向验证（connected PASS，
  disconnected 正确检出泄漏路由与 registry 残留）。
- P3 进展：`@qpjoy/electron-launcher/release-update-executor` 落地 doc 17 状态机与四条管线：
  config/flag 热应用（current/previous 槽位 + 回滚）、renderer 槽位 + applyRenderer 回调、
  npm 包 staged→next-start adoption（`adoptPendingElectronLauncherPackages`）、installer
  手动打开 + 新版本首启 `installer-completed` 回报
  （`reportElectronLauncherInstallCompletionIfUpgraded`）。激活门禁按 networkGate 注入，
  connecting/recovering/permission-required 时 defer 并回报。执行器已通过本地假 Release
  Center 的端到端 smoke（四条管线 + 门禁 defer + 回滚 + 9 类 report 链）。mx-h2i 接线完成：
  启动时 adoption + installer-completed 回报；下载分支通过 `executor.activateStaged` 热激活
  （config → 槽位替换 + 广播，renderer → 槽位 + reload，npm/asar → next-start 指针；
  WireGuard connecting 时自动 defer 并提示）。剩余（P3 收尾项）：renderer bundle 的产品侧
  解包约定（当前按单文件 bundle 处理）、真实发布一次热更走全链路验证（doc 18 Layer 6.5）。
- P4 核心落地（6.0–6.2 实现，2026-07-09）：服务端新增 `POST /internal/v1/release/check`
  （`server/src/modules/release/release-check.ts` 纯评估函数）——评估顺序 targets 显式列表
  （`rollout.audience.userIds/installIds`，给 1 个用户灰度就是列表里放 1 个人）→ percentage
  sticky 分桶（`sha256(componentId:channel:installId) % 10000`，series 级 sticky，扩量单调）
  → all；gate 未过返回 `blocked`；响应带 `releaseNotes`、`featureFlags`、
  `rollout.matchedBy/bucket`（可解释），HMAC-SHA256 签名（`MX_RELEASE_DECISION_SECRET`）。
  每次 check 记录 `release-check` report 供灰度健康度聚合。plan 创建入参新增
  `targetUserIds/targetInstallIds/releaseNotes`（postgres JSONB 自动落库，无迁移）；
  `release:publish` CLI 新增 `--target-user/--target-install/--notes`。plans 列表端点在设置
  `MX_RELEASE_PLANS_ADMIN_TOKEN` 后收敛 admin-only（未设置保持兼容）。客户端
  `release-updater.check()` 优先走新端点（旧服务器 404 时自动回退 legacy plans 流程，
  `checkSource` 字段标注路径）；mx-h2i 的 update 面板数据带上
  releaseNotes/rolloutMatchedBy/rolloutBucket/featureFlags。单测覆盖：单用户命中/未命中、
  5%→20%→100% 扩量 sticky 单调、gate blocked、平台过滤、签名校验、客户端新旧路径。
  剩余（P4 收尾项）：Admin UI 的"目标（全部/指定用户）+ release notes"表单（6.0 概念收敛）、
  签名的客户端校验（需分发验签密钥）、renderer 侧展示 releaseNotes。
- P4 收尾完成（2026-07-09，包已发 2.2.0）：Admin Release Center 的 Upload version 抽屉即
  三概念表单——版本/Current/Channel + **目标与发布说明**（目标用户/目标安装留空 = 全部用户，
  逗号分隔可只填 1 个；功能开关；Release notes textarea）；plan 抽屉 Rollout 区展示 Target
  （"全部用户"或"指定：N 个用户"）和 notes 原文。部署零配置：`MX_RELEASE_DECISION_SECRET`
  未设置时服务端首次使用自动生成 64 hex 密钥并持久化在 artifact store 的
  `decision-secret.json`（0600），env 设置则优先。已对真实 server 跑通端到端：Admin 表单体
  建 targeted plan（notes+audience 落库）→ 被圈中用户 check 得 update-available
  （matchedBy=target-list、带 notes/flags/签名）→ 未圈中用户 up-to-date → 密钥文件自动生成。
  仍待做：决策签名的客户端验签、renderer 更新弹窗渲染 notes。
- P5 接线完成（2026-07-09）：mx-h2i 的 electron-builder 签名/公证配置原已就绪（env 驱动），
  luopan 的 quasar builder 配置补齐到同等（hardenedRuntime + entitlements + env 驱动
  notarize + win signAndEditExecutable），运维步骤见 §7.1——Windows 配 `CSC_LINK` +
  `CSC_KEY_PASSWORD`（内部分发用内部 CA 即可，暂不需要买证书），macOS 需要 Apple
  Developer Program（$99/年）后配 `APPLE_ID`+`APPLE_APP_SPECIFIC_PASSWORD`+`APPLE_TEAM_ID`。
  mx-h2i 更新面板已渲染 releaseNotes 和 Matched by（指定用户/灰度命中 bucket/全部用户）。
  P5 剩余：拿到 Apple 账号后跑一次真机公证验收（§7.1 第 4 步）；决策签名客户端验签
  （需转非对称密钥再做）。

## 1. npm 发布规划

### 1.1 Registry 与 scope

延续 V1 现状：公网 npmjs、`@qpjoy` scope、`publishConfig.access=public`。代码包本身不含机密
（入网授权靠服务端 enrollment 校验，见 doc 14 "npm 包只提供 SDK 能力，不等于入网授权"）。
如果之后要求包本体也不可公开，再迁私有 registry（Verdaccio on Internal），交付流程不变，只改
`.npmrc`；第一阶段不引入这个变量。

### 1.2 发布集与拓扑顺序

按依赖拓扑分四层，低层先发。已发布的包只在有变更时递增 patch/minor。

| 层 | 包 | 现状 | 说明 |
| --- | --- | --- | --- |
| L0 平台二进制 | `@qpjoy/electron-plugin-tunnel-engine-{darwin-arm64,darwin-x64,linux-arm64,linux-x64,win32-x64}`、`@qpjoy/electron-core-wireguard-engine-*`（同 5 平台） | 已发布 | optionalDependencies 按平台落包；版本必须和宿主包 lockstep（宿主 `optionalDependencies` 用 `^` 对齐） |
| L1 插件核心 | `@qpjoy/electron-core-mihomo`、`@qpjoy/electron-core-wireguard`、`@qpjoy/electron-plugin-tunnel` | 已发布 | H2O/mihomo 与 WG 运行时 |
| L2 launcher SDK | `@qpjoy/mx-launcher-core` → `@qpjoy/mx-launcher-embed-sdk`、`@qpjoy/mx-launcher-standalone` | **未发布** | core 先发，其余两个依赖它 |
| L3 产品门面 | `@qpjoy/electron-launcher` | **未发布** | 对外唯一入口，隐藏 L2 拆分；Luopan 只装它 |
| L4 应用包 | `@qpjoy/electron-launcher-app-h2o`（demos/mx-app-h2o）、`@qpjoy/ui-design-neon-void`（如 Luopan UI 需要） | 未发布 | H2O 作为 AppCenter 内置 app 的默认 package；发布后 Release Center 才能从 npm 导入 app artifact |

不发布：`@qpjoy/mx-h2i-demo`、`@qpjoy/luopan-demo`（private，产品用 electron-builder 出安装包，不出 npm）。

### 1.3 版本与依赖协议策略

- `pnpm publish` 会把 `workspace:` 协议改写为真实版本：`workspace:*` → 精确 pin，`workspace:^` → `^x.y.z`。
- 统一规则：**同 release train 的 launcher 包之间用 `workspace:^`**（`electron-launcher` 对
  `mx-launcher-*` 目前是 `workspace:*`，发布前改成 `workspace:^`），跨 train 的 L1 依赖保持
  `workspace:^`。这样消费方可以吃到 patch 而不必等门面包重发。
- L2/L3 四个包版本 lockstep（同次发布同版本号），从 `0.2.0` 起步，避免和历史 `0.1.0` 混淆。
- 发布必须走 CI/脚本，不允许本机手工 `npm publish`：新增
  `electron-dock/mx-launcher/scripts/publish-packages.mjs`，职责是按拓扑
  build → `pnpm publish --filter` → 把 `包名@版本 + tarball sha` 回写 Release Center
  （对应 doc 17 "npm 是 Release Center 的输入源，不是客户端的 source of truth"）。

### 1.4 dev-mode 双模式（修 G2）

把 HDO 的 `local|npm` 双模式脚本抽成 workspace 共享脚本（建议
`electron-dock/mx-launcher/scripts/dev-mode.mjs`，demo 侧薄封装转发）：

- `local`：现状，build workspace 包直接引用。日常开发用。
- `npm`：把 `package.json` 中 `workspace:` 依赖改写为已发布 npm 版本（fallback 表维护在脚本里），
  干净 install 后再 `make`。**所有对外分发的安装包必须在 npm 模式下构建**，这是"正式线上通过
  npm 安装"的验证点；CI 的 release job 强制 `dev-mode npm`。
- 尚未发布期间的过渡：npm 模式支持 `--packs` 回退到本地 tarball（HDO 的 `.local-packs` 机制），
  L2/L3 一旦发布就删掉回退。

### 1.5 发布 checklist（每次发版）

1. `pnpm typecheck && pnpm build:packages`（workspace 根）。
2. `publish-packages.mjs --dry-run` 核对将发布的版本、被改写的依赖区间。
3. 按拓扑发布，验证 `npm view @qpjoy/electron-launcher version`。
4. mx-h2i / luopan 各跑一次 `dev-mode npm` + `make`，产物走 doc 18 Layer 4-5 注册进 Release Center。
5. Release Center 记录 npm 版本 ↔ artifact digest 映射（灰度回滚要靠它定位上一版）。

## 2. Luopan Handoff：交付给其他开发者

### 2.1 交付物清单

| 交付物 | 内容 |
| --- | --- |
| npm 依赖 | `@qpjoy/electron-launcher@^0.2.0`（唯一必装）、可选 `@qpjoy/ui-design-neon-void` |
| 参考实现 | `demos/mx-h2i`（standalone 全量参考）+ `demos/luopan`（Quasar 消费方式，964 行 electron-main.ts 是起点模板） |
| 文档 | 本文档 + doc 14（共存边界）+ doc 15（SDK gateway API）+ doc 18（发布验证） |
| 环境 | Internal base URL、测试账号、Luopan 的 ProductNetwork 注册结果（见 2.2） |
| 冲突测试矩阵 | 第 4 节，作为对方的验收标准之一 |

**demo 交付形式**：不给 zip 快照。给对方仓库访问权（或子树导出）+ 固定 tag（如
`mx-h2i-demo-v2.0.0`），并声明 `demos/mx-h2i` 是参考实现、`packages/*` 才是契约——
demo 里的行为如果和 npm 包 API 冲突，以包为准。这样后续 demo 演进不需要重新"分发"。

### 2.2 服务端预注册（我们做，不是对方做）

在 Internal Admin 完成，再把结果交给对方：

- Product Registry：`productId=luopan`，`launcherMode=standalone`，`networkScope=owner`。
- ProductNetwork：lease CIDR `10.91.0.0/16`，materialized VIP `10.88.100.3`，
  `serviceVip=internalControlIp=domesticGatewayIp=dnsServer=10.88.100.3`（doc 14 表格）。
- 服务端 materialization 验证：`http://10.88.100.3:18090/healthz`、DNS、gateway 反代全部通过后
  才把 base URL 给对方。**不允许对方以任何形式使用 `10.88.88.88` / `10.88.0.1`**——这两个是
  H2I/foundation 迁移期兼容地址，Luopan 从第一天就走 product materialization。
- enrollment 白名单：`luopan` app 具备 `launcher-network` + `launcher-standalone` capability。

### 2.3 对方必须遵守的硬边界

写进 handoff README 的红线，同时是第 4 节测试矩阵的断言来源：

1. `routeCidrs` 只含 `10.91.0.0/16` + `10.88.100.3/32`；不 adopt 其他 standalone 的 CIDR。
2. 系统 DNS/PAC 只通过 launcher 包的 ownership registry / system-domain-proxy 声明，
   不直接写 `networksetup` / NRPT / PAC URL。
3. 不自带 native helper、不自建更新器：更新一律走 `@qpjoy/electron-launcher/release-updater`，
   componentId=`luopan`。
4. 端口不 hardcode：mihomo/local edge 端口通过包 API 申请（带冲突退避），见 4.3。
5. 打正式包必须 `dev-mode npm` 构建，workspace/tarball 构建的包不得注册进 Release Center。

## 3. standalone/embed 拆分细化（修 G6）

原则：**demo 里任何 Luopan 也需要的逻辑，都必须下沉进 `@qpjoy/electron-launcher`**。
mx-h2i 的 `main.cjs` 应收敛为"产品壳"：窗口、产品 UI IPC、产品文案。下沉清单（按优先级）：

| 现在在 main.cjs | 下沉到 | 子路径建议 |
| --- | --- | --- |
| 更新检查/下载/staged/安装打开的编排与 IPC | `release-updater` 增加 executor 层（状态机 `idle→checking→downloading→verifying→staged→activating→reported`，doc 17） | `@qpjoy/electron-launcher/release-updater` |
| AppCenter host、app 安装缓存、manifest 握手 | 新 `appcenter-host` 模块 | `@qpjoy/electron-launcher/appcenter-host` |
| broker（embed app 的 capability/token/网络上下文分发） | `launcher-standalone` 的 broker server + `launcher-embed-sdk` 的 client | 已有包内 |
| 连接状态机与"更新激活门禁"（connecting/recovering 时禁 activate） | executor 依赖的 `NetworkStateGate` 接口，产品注入 | `release-updater` |
| ownership registry 读写、冲突诊断 | 已有 `network-ownership-registry`，把 demo 里散落的直接 fs 操作全部改为走包 API | 已有子路径 |

验收：Luopan 的 electron-main 不需要 copy main.cjs 任何函数；两个产品的更新/共存行为
差异只能来自注入的产品参数（productId、channel、CIDR、UI）。

## 4. 同机共存：不变量与冲突测试矩阵（修 G5）

### 4.1 不变量（doc 14 的可断言化）

- I1 路由隔离：任一产品 connect/disconnect 只增删自己 lease CIDR + 自己 VIP `/32`
  （H2I 迁移期额外 `10.88.88.88/32`、`10.88.0.1/32`）。
- I2 DNS/PAC 归并：系统级 DNS/PAC 由 ownership registry 合并生成；断开一个产品只释放它的
  claim，合并结果里其余产品条目原样保留。
- I3 无兜底 owner：关闭任意一个 standalone，另一个的连通性（控制面 healthz + 数据面 ping VIP）不受影响。
- I4 崩溃恢复：一个产品被 kill -9 后，重启的是它自己的 claim 清理/重建，不触碰对方。
- I5 端口无争抢：mihomo、local edge、broker socket 都按 `{standaloneChannelProductId}` 命名空间
  隔离（socket/目录布局见 doc 14），端口动态申请。

### 4.2 测试矩阵

每格在 Windows 10/11 和 macOS（arm64 + x64 至少各一台）各跑一遍；进 CI 前先做成
`manage.sh` 可驱动的半自动脚本，断言 = 路由表 diff + DNS 解析结果 + PAC 内容 + registry JSON。

| # | 场景 | 断言 |
| --- | --- | --- |
| C1 | 仅 MX-H2I 连接 | 基线：路由/DNS/PAC 快照 |
| C2 | 仅 Luopan 连接 | 只有 `10.91.*` + `10.88.100.3/32`；解析 Luopan 域名走 `10.88.100.3` |
| C3 | H2I 先连，Luopan 后连 | 两组路由并存；I2 合并正确 |
| C4 | Luopan 先连，H2I 后连 | 同上（顺序无关） |
| C5 | 双连后断开 H2I | Luopan 连通性不变（I3）；H2I 路由全清 |
| C6 | 双连后断开 Luopan | 对称 |
| C7 | 双连后 kill -9 Luopan，再重启 Luopan | I4；重启后 claim 重建，无重复条目 |
| C8 | 双连 + Clash/mihomo TUN 开启 | 两产品 VIP `/32` 与 CIDR 更具体路由压过 TUN；unmatched 流量仍归 Clash |
| C9 | 双连 + 系统代理(PAC)模式 | PAC 只把各自产品域名引到各自 VIP |
| C10 | H2O embed on H2I，同时 Luopan standalone 在线 | H2O 流量归因到 mx-h2i channel，不借用 `10.91.*` |
| C11 | 双产品同时"检查更新" | 单机 update 下载不互相干扰；激活门禁互不阻塞（每 channel 一个 scheduler） |
| C12 | 系统睡眠/网络切换（Wi-Fi→有线，或两个 Wi-Fi gateway/interface 相同但 DHCP source 不同）后双产品恢复 | network-change 按 gateway/interface/IFA 恢复且只 repair 自己的路由 |

### 4.3 已知薄弱点（矩阵预计会暴露的）

- Windows NRPT 规则合并：两个产品同时下发 split DNS 时，NRPT 是全局表，必须由 registry 合并
  后统一写入，谁最后写谁覆盖的现状要改。
- mihomo 端口：H2O 与 Luopan 若都拉起 mihomo，`external-controller`/mixed-port 需要动态分配 +
  registry 登记，当前 demo 有固定端口倾向。
- macOS PAC：`networksetup -setautoproxyurl` 全局只有一个 PAC URL，必须收敛到 launcher 的
  local edge 单点出 PAC、按 registry 聚合两产品规则。

## 5. 更新系统收尾（修 G3）

按 artifact class 分四条管线收尾，全部复用 doc 17 的状态机与稳定性边界（检查只读、
connecting/recovering 不激活、installer 永远手动确认）：

1. **Config snapshot / feature flag**（最先做，风险最低）：staged → 校验签名 → 原子替换 →
   通知 renderer 重载策略 → report `applied`。保留上一份快照做回滚位。
2. **Renderer UI bundle**：staged → 切换 bundle 目录指针 → `webContents.reload()` → toast。
   回滚 = 指针切回上一目录。
3. **npm 包热更（launcher npm class）**：客户端**不跑 npm install**。CI 把 L2/L3 包的 dist
   构建产物打成 artifact 上传 Release Center；客户端下载到
   `<userData>/launcher-packages/<name>/<version>/`，校验 digest 后写"下次启动生效"指针，
   main 进程启动时按指针解析模块路径（require 重定向），激活模式 `restart-auto`（空闲时提示
   重启）或随下次自然重启生效。主进程/native 相关变更不走此管线，归 installer。
4. **Installer**：补齐闭环的最后一步——新版本首次启动时上报
   `installer-completed`（带旧/新版本、installId），Release Center 才能把该 install 标记为
   已完成升级；超时未回报的 install 计入灰度健康度指标。

### 5.1 Luopan 的更新形态映射（一个安装包 + 两级 npm 热更）

Luopan 本体不是 npm 包，是 electron-builder 安装包；它依赖的 standalone launcher 和它
承载的 embed 子应用才是 npm 产物，可以热更：

| 层 | 载体 | 更新方式 | 存储 |
| --- | --- | --- | --- |
| Luopan 产品壳（Electron 运行时/主进程 breaking/native） | electron-builder DMG/EXE | 大版本：新建发布 → `installer-manual` | **强制 OSS**，不落 Internal server 磁盘 |
| standalone launcher（`@qpjoy/electron-launcher` 等 L2/L3） | npm dist artifact | 管线 3，`restart-auto` | 默认 Internal store，可配 OSS |
| embed 子应用（依赖 Luopan channel 的 app 包，如未来的 H2O-on-Luopan） | app npm artifact | 管线 2/3，app-scoped 热更 | 默认 Internal store，可配 OSS |
| 配置 / feature flag | 签名快照 | 管线 1，即时生效 | Internal |

### 5.2 存储策略：一条规则

**installer 类 artifact 必须走 OSS**——OSS 未配置时服务端拒绝创建 installer plan（报错
提示配置，而不是静默落到本地磁盘）；小体积高频的热更 artifact 默认 Internal store。
`release:publish` 的 `--storage auto` 语义相应改为"installer→oss（未配置即失败），
其余→internal"。OSS 凭据通过 `server/.env`（`MX_RELEASE_OSS_*`，字段见 doc 18 Layer 5）
或配置分发中心下发，k8s 环境走 `mx-release-oss` Secret；客户端永远只拿短时签名 URL，
不接触 OSS key。

测试计划：四条管线各做一个端到端用例（发布→灰度 100%→客户端自动完成→report 链路可查），
在 C11/C12 共存场景下重跑一遍。这些用例并入 doc 18 的 Layer 序列（作为 Layer 6.5）。

## 6. 灰度发布详细设计（修 G4）

### 6.0 概念收敛：管理员只需要三个概念

当前用户规模只有个位数，Admin UI 不应暴露 channel/ring/percentage/segment 全套模型。
k8s Admin 新建发布只填三样：

| 概念 | 含义 | 表单形态 |
| --- | --- | --- |
| 版本 | release + release notes | 版本号 + Markdown notes（客户端更新弹窗原文展示） |
| 目标 | 谁能拿到这个版本 | `全部用户` 或 `指定用户`（勾选 userId/installId，可以只选 1 个人） |
| 功能开关 | 拿到后开哪些功能 | per-user/per-group 的 feature flag 矩阵 |

channel/ring/percentage 保留在数据模型和 API 里（规模化时直接启用），UI 默认折叠进
"高级"不展示。客户端侧同样只有一个概念：检查更新/自动更新 + 更新提示。发布侧命令也
向运维单命令风格（`manage.sh ops internal-production deploy`）看齐：`release:publish`
收敛为 `bash scripts/manage.sh release publish --app luopan --version x.y.z --notes ... --targets ...`
一条命令完成上传 + 建 plan。

### 6.1 对点灰度：单用户定向 + 单包多形态

两个诉求合并解决，都不需要打第二个 Luopan 包：

- **版本对点**：release plan 的 `targets` 支持显式 userId/installId 列表。决策端点先评估
  targets：命中 → 下发；未命中且 plan 不是"全部用户" → 返回 `up-to-date`。给 1 个用户
  灰度就是 targets 里只放他一个人。
- **功能对点**：全版功能和部分功能是**同一个安装包 + 不同 feature flag 快照**。Admin 在
  k8s 后台给某个用户勾开/勾关 flag，服务端重新签名该用户的 flag 快照，客户端下次 check
  时热应用（第 5 节管线 1），无需发版、无需重装。功能灰度和版本灰度共用同一个 targets
  评估器。

评估顺序（服务端）：`targets 显式列表 → scope filter（site/OS/版本）→ percentage 分桶`。
percentage 缺省 100，当前阶段实际只用前两级；分桶（6.3）是规模化预留，不删。

### 6.2 决策必须服务端化

现状 `release-updater.check()` 拉全量 plans 客户端过滤，percentage/ring/targets 根本没参与，
且暴露全部发布计划。改为单一决策端点：

```text
POST /internal/v1/release/check
{ installId, userId?, productId, channel, platform, arch,
  components: { launcher: "0.2.0", app: "2.0.0", ... }, capabilities: [...] }
→ { decision, artifacts[], activation, releaseNotes, featureFlags,
    rollout: { matchedBy: "target-list" | "percentage" | "all", bucket? },
    signedAt, signature }
```

服务端完成 plan 选择、targets/rollout 评估、gate 检查，只返回**这一个 install 应得的**
决策，并对决策体签名（客户端校验，防中间人下发假 plan）。`releaseNotes` 由客户端更新
弹窗直接渲染；`featureFlags` 走 config artifact 管线热应用。`release-updater` 的
`check()` 切到该端点；旧的 plans 列表端点收回为 admin-only。

### 6.3 分桶算法（规模化预留；sticky、可扩量、可解释）

```text
bucket = sha256(releaseSeriesKey + ":" + installId) 的前 8 hex → uint32 % 10000
命中 ⇔ bucket < percentage * 100
```

- `releaseSeriesKey` 是发布系列（如 `mx-h2i-installer-0.3.x`）而非单个 plan id：同系列内
  percentage 从 5%→20%→100% 扩量时，已命中的 install 永远保持命中（单调扩量，不换池子）。
- ring 是分桶之前的硬过滤：`internal-dogfood`（Admin 显式圈定 installId/userId 名单）→
  `canary`（percentage 分桶）→ `stable`（100%）。ring 晋级是 Release Center 动作，带 gate
  evidence（doc 17 的 E2E gate + metric gate）。
- scope filter（site/OS/版本/角色/用户组）在 ring 之后、分桶之前做 AND 过滤。
- 决策响应回带 `{ matchedBy, bucket }`，客户端展示在"检查更新"面板里，做到"为什么我（没）
  拿到这个版本"可解释。

### 6.4 健康度与自动回滚

- 客户端 report 全链路事件（download/verify/apply/installer-completed/crash-on-first-run）。
- Release Center 按 releaseSeriesKey 聚合：完成率、失败率、首启崩溃率；`canaryMetricGate`
  阈值不达标时自动 pause（停止新命中，已升级的不动），rollback 仍是显式 admin 动作（doc 17）。
- feature flag 灰度复用同一套 ring/bucket 评估器，只是 artifact class 不同——功能开关先
  灰度、再全量、有问题热回滚，不动安装包。

## 7. Windows / macOS 平台闭环（修 G7）

| 项 | Windows | macOS |
| --- | --- | --- |
| 签名 | signtool + 内部/EV 证书，`after-sign` 全量签 exe/dll（doc 00 Phase 1） | Developer ID + notarytool 公证 + staple（doc 03） |
| 提权模型 | UI `asInvoker`；WG/NRPT/route 走服务/UAC wrapper（doc 01，HDO V1 hidden RunAs 模式） | LaunchDaemon helper |
| 更新激活 | installer 手动；npm/renderer 热更不触发 UAC | 同；公证过的增量 artifact 不触发 Gatekeeper（dist 产物非 bundle，注意 quarantine 属性清理） |
| CI 出包 | Windows worker：`ignored-builds` 无 pending 后 `make:win`（doc 18 Layer 4） | mac worker `make:mac:dmg` + 公证 |
| 验收 | 干净机安装→游客连接→一次提权→重启不再 UAC | 干净机安装→Gatekeeper 无警告→一次授权 |

灰度/更新的平台差异只体现在 artifact 的 `platform` 字段和激活方式，决策逻辑平台无关。

### 7.1 签名/公证运维指南（P5 落地步骤）

**先分清两件事**：包签名（SmartScreen/Gatekeeper/防篡改）和 UAC 弹窗显示是两回事。当前
Windows 提权走隐藏 RunAs 拉起 `powershell.exe`，UAC 显示"Windows PowerShell / Microsoft"
——这是借微软的签名，包签名不改变它；想让 UAC 显示产品名需要自带签名的 helper exe
（doc 00 Phase 1 的 `MxService.exe`，P5 之后的独立事项）。

**Windows（electron-builder 管线已就绪，配 env 即生效）**：

- 触发方式：设置 `CSC_LINK`（.pfx 路径或 base64）+ `CSC_KEY_PASSWORD`，`make:win` 会自动签
  所有 exe/dll（当前日志里的 `signing is skipped cscInfo=null` 就会消失）。
- 证书选择：
  - **内部分发（当前阶段推荐）**：内部 CA / 自签代码签名证书 + 组策略/手动分发根证书，
    零成本。正式渠道走 Release Center 更新器下载（Node http 不写 Mark-of-the-Web），
    SmartScreen 不触发；只有首次通过浏览器/IM 传包才可能弹，且首装本就走人工交付。
  - **对外公开分发**：OV 代码签名（年费低、SmartScreen 信誉需积累）或 EV / Azure Trusted
    Signing（即时信誉）。等 Luopan 面向外部用户时再买。

**macOS（配置已就绪，需要 Apple Developer Program $99/年，绕不开）**：

1. 公司主体注册 Apple Developer Program，创建 **Developer ID Application** 证书装入构建机
   钥匙串（一个账号覆盖 mx-h2i 和 luopan）。
2. 生成 App 专用密码，构建时设置 `APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` +
   `APPLE_TEAM_ID`（或 App Store Connect API key 三件套）。
3. `make:mac:dmg` 自动完成 codesign（hardened runtime + entitlements）→ notarytool 提交
   → staple。两个 demo 的 electron-builder 配置都已按此接好（env 缺省时跳过，纯本地构建
   不受影响）。
4. 验收：干净 Mac 从浏览器下载 DMG，直接双击打开无 Gatekeeper 警告；
   `spctl -a -vv MX-H2I.app` 显示 `accepted / Notarized Developer ID`。
   未公证的包用户必须右键打开或 `xattr -d com.apple.quarantine` 绕过——首装体验不可接受，
   所以 macOS 这 $99 是必须花的。

热更 artifact（renderer/config/npm dist）由更新器下载，不带 quarantine/MOTW，不需要
逐个公证；完整性由 Release Center 的 sha256 + 决策签名保障。

## 8. 阶段计划

| 阶段 | 内容 | 出口标准 |
| --- | --- | --- |
| P0 npm 就绪 | 1.2-1.4：改 `workspace:^`、发布 L2/L3（0.2.0）、共享 dev-mode `npm` 模式、publish 脚本 | `npm view @qpjoy/electron-launcher` 有版本；mx-h2i 与 luopan 均能在 npm 模式下 make 出可运行包 |
| P1 Handoff | 2.1-2.3：Luopan ProductNetwork 注册 + materialization 验证、handoff README、demo tag | 对方开发者在无 workspace 的干净环境跑起 Luopan 骨架并连上 `10.88.100.3` |
| P2 共存加固 | 第 4 节矩阵 C1-C12 双平台跑通，修 NRPT/PAC/mihomo 端口三个薄弱点 | 矩阵全绿，断言脚本进 manage.sh |
| P3 更新执行器 | 第 5 节四条管线 + doc 18 Layer 7 的 6 项 | 一次真实发布从 build 到客户端自动生效全程无人工传包 |
| P4 灰度服务端化 | 6.0-6.2 优先：/release/check、targets 单用户定向、feature flag 快照、release notes、installer 强制 OSS；分桶/ring（6.3）为规模化预留不实装 UI | 给 1 个真实用户定向发一版、热开/热关一个 flag 全程无需重打包；plans 列表端点收回 admin-only |
| P5 GA | 平台签名闭环（第 7 节）+ 停止一切手动分发 | doc 18 Layer 7 的目标流水线成为唯一发布方式 |

P0/P1 无前后依赖以外的耦合，可以立刻开始；P2 与 P3 可并行；P4 依赖 P3 的 report 链路。

## 附：与既有文档的关系

- doc 00 的 Phase 6/8 由本文档 P3/P4 具体化。
- doc 14 的共存设计是第 4 节的规范来源；本文档不改其结论，只把它变成可执行断言。
- doc 17 的 artifact class / 状态机 / 稳定性边界原样沿用；6.1 的服务端决策端点是对其
  "Client Flow 第 1-3 步"的实现修正（现实现不符，见 G4）。
- doc 18 的 Layer 1-6 不变；第 5 节测试并入 Layer 6.5，P5 完成即达成 Layer 7。
