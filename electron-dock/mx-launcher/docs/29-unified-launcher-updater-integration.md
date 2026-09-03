# MX Launcher 通用应用更新器接入指南

本文说明 Electron 产品如何统一接入 MX Launcher Release Center，同时保留产品自己的
构建、界面和安装策略。当前公开入口仍是 `@qpjoy/electron-launcher`；本轮不新增独立的
`launcher-updater` npm 包，也不把 Node/Electron 更新运行时放入纯协议包
`@qpjoy/mx-launcher-core`。

本文适用于 Luopan、MX-H2I 以及后续接入 AppCenter/ProductNetwork 的 Electron 产品。
服务端发布操作见 [Release Center 全量安装包发版操作手册](./23-release-center-full-installer-operations.md)，
产品 CI 接口见 [Release Center 开发者 API](./25-release-center-developer-api.md)。

本轮 L3 供新产品接入和 Luopan 一次性切换。MX-H2I 继续使用已经上线的 L1/L2 与其自身
macOS/Windows 更新状态机；本轮不替换 MX-H2I 的更新编排、用户登录或联网逻辑。Luopan
是否使用 L3 不会改变 MX-H2I 的 import、运行状态或 Release Center 决策。本次应发布新的
不可变 SDK semver，只升级 Luopan 的 package 与 lockfile，不创建新的 MX-H2I desktop plan。
未来若让 MX-H2I 重打包并带入新版 L1/L2，必须作为独立发版重新验收。

## 1. 结论与边界

应用不应各自实现 HTTP 下载、摘要校验、暂存目录、并发去重和更新状态机。通用部分由
`@qpjoy/electron-launcher` 提供，产品只注入受类型约束的运行时能力：

- 当前 Internal base URL、安装 ID、用户 ID；
- 当前产品版本、发行形态和网络状态；
- ASAR 与 installer 的选择偏好；
- 打开安装器、重启/退出、安装前资源清理；
- 状态、进度和执行阶段信息如何送到产品 UI。

统一 updater **不**负责以下内容：

- 编译、代码签名、macOS notarization、Windows Authenticode；
- 替产品决定是否关闭 WireGuard、Mihomo、SSH 或业务进程；
- 替 renderer 创建 UI、IPC 或本地化文案；
- 绕过 Release Center 的 gate、灰度、平台和架构选择；
- 把 Publisher/Approver credential 放进客户端。

更新检查和下载不得修改已连接的 ProductNetwork。只有用户确认安装或产品明确允许激活时，
才调用产品注入的清理/重启能力。取消更新也只取消 updater 当前操作，不断开用户会话、
WireGuard、PAC 或 DNS。

## 2. 当前三层 API

| 层 | 公开入口 | 职责 | 适用方 |
| --- | --- | --- | --- |
| L1 Release Consumer | `createElectronLauncherReleaseUpdater` | 按 `packageName` 解析产品；check/report；规范化 artifact URL；低层文件下载 | 需要自定义编排或测试协议的产品 |
| L2 执行器 | `createElectronLauncherReleaseUpdateExecutor` | 下载、进度、size/sha256 校验、staging、slot/pending pointer、激活门禁、installer 打开、回滚和上报 | 特殊制品管线或已有状态机 |
| L3 应用 controller | `createElectronLauncherApplicationUpdater` | 统一候选检查、ASAR/installer 选择、并发去重、状态机、自动检查、取消、下载和安装编排 | 新产品默认入口；Luopan 直接切换目标 |

三层都从 `@qpjoy/electron-launcher` 发布。L3 组合 L1 和 L2，不复制它们；L1/L2 继续保留，
用于兼容当前应用和高级场景。`launcher-core` 只保存跨运行时协议、DTO 和纯函数，不能依赖
`node:fs`、Electron `app` 或 `shell`。

当前发布组已经包含 `@qpjoy/electron-launcher` 及其 core/standalone/embed 依赖：

```bash
./scripts/manage.sh prepare-mx-h2i-npm <version>
# 等价短名：./scripts/manage.sh mx-h2i <version>
# 交互菜单中的显示名称是 prepare-mx-h2i
```

因此本次 controller 随现有 Electron Launcher 包发布，不需要增加另一个包的发布顺序。

## 3. Standalone 与 Internal 相对 URL

### 3.1 base URL 来自当前会话

standalone 产品连接成功后，应从自己的 `LauncherNetworkSession.routePlan.internalBaseUrl`
取得 Release Center base URL。不要把 MX-H2I 的 `10.88.88.88`、Luopan 的
`10.88.100.3` 或其它产品的 Service VIP 当成全平台常量。

```text
Luopan network session
  -> routePlan.internalBaseUrl = http://10.88.100.3:18090
  -> POST /internal/v1/release/check
  -> artifact.url = /internal/v1/release-artifacts/.../download/Compass.asar
  -> 实际下载 = http://10.88.100.3:18090/internal/v1/release-artifacts/.../download/Compass.asar
```

注册 `serviceVip` 还不等于完成接入。ProductNetwork 必须已经物化 route plan，并且该 VIP
的 `:18090` gateway 能转发以下 Consumer 路径：

- `/internal/v1/releases/products/resolve`；
- `/internal/v1/release/check`；
- `/internal/v1/release/reports`；
- `/internal/v1/release-artifacts/...`。

### 3.2 URL 规范

平台托管的 Internal artifact 应返回根相对地址：

```text
/internal/v1/release-artifacts/<artifactId>/download
/internal/v1/release-artifacts/<artifactId>/download/<fileName>
```

L1 updater 以**本次检查使用的 base URL**解析相对地址。兼容现有数据时，即使数据库保存的是旧
origin 的绝对 URL，只要 pathname 严格匹配上述平台 artifact download 路径，SDK 也会把
它重新绑定到当前 base origin。这个兼容仅用于 MX Launcher 托管路径：

- `https://cdn.example.com/releases/app.zip` 等外部 CDN/公开 OSS 绝对 URL 保持不变；
- `//host/path` 这类 protocol-relative URL 被拒绝；
- 下载协议只允许 HTTP/HTTPS；
- 默认重定向次数有上限；私有 OSS 可以由 Internal download endpoint 302 到短期签名 URL；
- 客户端不能把短期签名 URL 缓存成永久地址。

相对 URL 支持存在于 `@qpjoy/electron-launcher` 2.3.13 及之后版本；使用旧版本的产品不能
直接参加全局切换。旧的 2.3.13+ L1 能解析相对 URL，本次 L3、取消和旧 origin 重绑定则要求
使用包含 `application-updater` 的新发布版本；本次首次交付版本为 `2.3.18`。

### 3.3 Luopan 直接切换与 MX-H2I 隔离

Compass/Luopan 当前正式身份是一组已有契约，不在 updater 切换中改名：

| 身份边界 | 正式值 |
| --- | --- |
| Electron `packageName` | `compass` |
| AppCenter `appId` / Release `productId` | `luopan` |
| app installer / ASAR `componentId` | `luopan` |
| renderer `componentId` | `luopan-renderer` |
| ProductNetwork | `luopan` |
| 生产 channel | `stable` |

`@qpjoy/luopan-demo` 是后台已持久化旧 AppCenter row 和历史客户端的迁移兼容 alias，
不是正式 Compass package name。即使后台页面暂时仍显示该旧值，正式客户端也始终以
`packageName=compass` 解析到同一个 `luopan` release/ProductNetwork 身份；不需要为此新建
`compass` product 或改名 ProductNetwork。

发布顺序必须是 **Internal 服务端先、Luopan 客户端后**。所有 Internal 实例先升级到同时
识别 `compass` 与历史 alias 的版本；服务启动时会把内置 `appId=luopan` 的 AppCenter
元数据规范为 `packageName=compass`，而 resolver 兼容仍保证旧持久化 row 在滚动升级期间
可解析。只有在 `compass/stable` resolver 已返回下述 `luopan` 身份后，才发布不再使用
legacy fallback 的 L3 客户端。不能先发客户端，再依赖数据库迁移或后台手工改名补救。

Luopan 从当前版本直接升级到唯一的最终 L3 版本，不创建中间桥接版本。最终 Luopan 直接打入
包含 L3 的 `@qpjoy/electron-launcher`，并把自己的 `AppUpdateManager` 改为 L3 adapter。
数据库中若仍有指向旧 origin 的平台 artifact，最新版 SDK 会对精确匹配的 Internal download
pathname 绑定当前 Luopan base；外部 CDN/公开 OSS 绝对 URL 不会被改写。

服务端本实现已在 release check 输出边界提供 Luopan-only 相对 URL 投影：只有请求中的
`productId=luopan`，且 artifact URL pathname 精确匹配该 `artifactId` 的以下任一路径时，才把
URL 转为根相对地址：

```text
/internal/v1/release-artifacts/<artifactId>/download
/internal/v1/release-artifacts/<artifactId>/download/<fileName>
```

该投影在 release decision 签名前完成；MX-H2I、外部 CDN/OSS URL，以及 pathname 中
`artifactId` 不匹配的 URL 都保持原样。这是 check 响应的产品隔离投影，不会重写数据库中的
artifact URL，也没有修改全局 `MX_PUBLIC_BASE_URL`。

因此，先部署包含该实现的 Internal 服务端并完成真实链路验证后，现有 2.0.2 可以使用其内置
2.3.15 updater，把相对 URL 解析到当前 Luopan session base，直接下载并安装**同一个最终 L3
版本**；无需中间客户端版本。通过外部分发完整安装包仍然可用，但不再是绕过旧 updater 的必要
条件。服务端代码已提供不等于发布门禁已完成：必须先部署并用真实 2.0.2 实测 check、签名校验
和下载，再发布最终 plan。

直接切换前必须验证：

1. `packageName=compass&channel=stable` 的 product resolver 返回
   `appId=luopan/productId=luopan/componentId=luopan/networkProductId=luopan`；
2. Luopan session 的 `routePlan.internalBaseUrl` 为自己的当前 Internal origin；
3. 该 origin 可访问 resolve、check、report 和 artifact download；
4. 发布计划中的 Luopan artifact 具有目标 OS/arch、非空 SHA-256 和准确 `sizeBytes`；
5. 最新完整安装包包含新 SDK、ASAR bootstrap 与对应目标平台的 native runtime；
6. 已部署的 check 对 Luopan 精确平台路径返回根相对 URL，真实 2.0.2 能校验响应并从当前
   session base 下载；MX-H2I、外部 URL 和 artifactId 不匹配样本均保持原值。

本轮不全局修改现有 Release Center `check/history` 响应，也不让 MX-H2I import L3。当前线上
MX-H2I 的 macOS/Windows 更新编排、历史版本下载和 ASAR bootstrap 因而保持原路径。后续若
要让 Release Center 新写入的 Internal artifact 全部保存为相对 download path，必须先盘点所有
consumer；不能为了 Luopan 直接切换而顺手改变 MX-H2I 的服务端响应契约。

隔离成立的原因是：`application-updater` 是新增子路径，只有调用
`createElectronLauncherApplicationUpdater()` 才创建产品内 controller；它没有跨应用 singleton，
staging 也只写调用方传入的 `baseDir`。L1/L2 原导出和旧调用签名继续保留。Luopan 修改自己的
依赖和 adapter 不会让已经发布的 MX-H2I 自动加载 L3，也不会改变 MX-H2I 的用户目录或网络 owner。

## 4. 通用 controller 接入

新产品优先使用 L3；只有当通用状态机不能表达明确需求时，才直接组合 L1/L2。controller
默认依次检查 `app-asar`、`app-installer`，并从所有命中的 typed candidates 中选取制品。
产品可注入选择函数，但不能制造 Release Center 没有返回的 URL 或 artifact。

创建 controller 时四项必填：

| 选项 | 要求 |
| --- | --- |
| `baseDir` | Electron `app.getPath('userData')`，用于 staging、slot 和版本 pointer |
| `packageName` | 应用构建元数据中的真实稳定名称；Luopan 当前是 `compass` |
| `currentVersion` | 当前真正运行的版本；ASAR 基座应使用 `runningElectronLauncherVersion(...)` |
| `getContext` | 每次返回当前 `baseUrl/installId/userId`；`installId` 必须是稳定的单安装身份，网络未 ready 返回 `null` |

常用可选项为 `channel/distribution/platform/arch/componentCandidates` 和 `downloadTimeoutMs`。
`platform/arch` 默认使用 `process.platform/process.arch`；`fetchImpl` 主要用于测试或 main-process
HTTP 观测，不能因此把请求转交 renderer。`productId/allowLegacyProductFallback` 与
`componentCheckFailureMode='best-effort'` 只属于旧产品兼容面，不是 Luopan 直接切换配置。

以下是与当前 API 一致的 Luopan 风格 main-process 接入。默认候选顺序本来就是
`app-asar -> app-installer`；示例显式列出候选，使 Luopan 的现有优先级一目了然。

```ts
import { app, shell } from 'electron';
import {
  createElectronLauncherApplicationUpdater,
  type ElectronLauncherApplicationUpdateState
} from '@qpjoy/electron-launcher/application-updater';
import { runningElectronLauncherVersion } from '@qpjoy/electron-launcher/asar-bootstrap';

import { luopanLauncherManager } from './luopan-launcher-manager.js';

declare const __ELECTRON_DISTRIBUTION__: 'installed' | 'portable' | 'development';
declare const __ELECTRON_APP_VERSION__: string;

const controller = createElectronLauncherApplicationUpdater({
  baseDir: app.getPath('userData'),
  packageName: 'compass',
  currentVersion: runningElectronLauncherVersion(__ELECTRON_APP_VERSION__),
  channel: 'stable',
  distribution: __ELECTRON_DISTRIBUTION__,
  componentCandidates: [
    { componentKind: 'app-asar' },
    { componentKind: 'app-installer' }
  ],
  getContext: () => {
    const runtime = luopanLauncherManager.getRuntime();
    const baseUrl = luopanLauncherManager.getReleaseCenterBaseUrl();
    if (runtime.connection.status !== 'network-ready' || !baseUrl) return null;
    return {
      baseUrl,
      installId: runtime.installId,
      userId: runtime.connection.userId
    };
  },
  networkGate: () => {
    const status = luopanLauncherManager.getRuntime().connection.status;
    if (status === 'network-ready') return 'connected';
    if (status === 'connecting') return 'connecting';
    if (status === 'lease-active' || status === 'data-plane-pending') return 'recovering';
    if (status === 'error') return 'permission-required';
    return 'idle';
  },
  downloadTimeoutMs: 10 * 60 * 1000,
  openInstaller: async (filePath) => {
    const message = await shell.openPath(filePath);
    if (message) throw new Error(`无法打开安装程序：${message}`);
  },
  beforeInstallCleanup: async ({ signal }) => {
    if (signal.aborted) return;
    await cleanupRuntimeForUpdate(); // Luopan 自己实现，只清理自己持有的资源
  },
  relaunch: () => app.relaunch(),
  exit: (code) => app.exit(code),
  onState: (state: ElectronLauncherApplicationUpdateState) => {
    publishPublicUpdateState(state); // 产品 adapter 先移除 raw check/URL/stagedPath/reason/error
  },
  onProgress: ({ bytesReceived, totalBytes, percent }) => {
    console.debug('[AppUpdate] progress', { bytesReceived, totalBytes, percent });
  }
});

// 网络首次 ready：上报 installer 首启完成、去重检查；silent ASAR 只自动下载和暂存。
await controller.handleNetworkReady();

// renderer IPC 分别调用：
await controller.check();
await controller.download();
await controller.install();
controller.cancel('user-requested');
```

`cleanupRuntimeForUpdate` 与 `publishPublicUpdateState` 是产品函数，不属于 SDK。新应用可
在 main process 直接使用 controller state，但传给 renderer 前仍要投影；Luopan 应在 adapter
中映射回既有 `AppUpdateState`，从而不改动其它业务页面和现有更新 IPC。

### 4.1 生命周期规则

- `handleNetworkReady()`：先尽力上报新 installer 首次启动完成，再执行一次自动检查；相同
  base/install/user/channel/version 上下文不会重复自动检查。
- `check()`：显式检查候选；没有 Internal context 时进入 `needs-network`。
- `download()`：下载并验证已选择制品。`silent-download-next-start` 只允许自动暂存 ASAR，
  不自动重启、退出或打开 installer。
- `install()`：用户确认后的激活动作。installer 到这里才调用 `openInstaller`；ASAR 到这里
  才执行产品的清理/重启动作。
- `cancel(reason)`：取消当前 check/download/后续动作；也可给单次调用传入 `AbortSignal`。
  artifact stream 会被中断并清理临时文件。package identity resolve 可能作为共享缓存请求在
  后台完成，但其结果不能再推进已取消操作。它不负责关闭网络恢复流程已经显示的操作系统
  权限框；网络流程仍应使用自己的停止入口。
- `getState()`：返回可序列化的 main-process 完整快照。它包含 raw check、artifact URL、
  staged path、`reason` 和 `error`，必须由产品 adapter 投影成公开 UI state 后再通过 preload
  暴露。

controller phase 为：

```text
idle | unsupported | needs-network | checking | up-to-date | blocked |
available | downloading | verifying | staged | ready | installing |
cancelled | error
```

state 还包含四组字段：

- 决策：`currentVersion/targetVersion/updateAvailable/checkedAt/releaseId/releaseNotes/deliveryMode`；
- 原始 main-process 数据：`check/selectedArtifact/artifactKind/artifactClass`；
- 暂存与进度：`stagedPath/staged/progress/bytesReceived/totalBytes/percent`；
- 结果说明：`reason/error`。

controller 返回的是 immutable snapshot；renderer 不应修改它，main-process adapter 也不应把
其中的原始 URL、本机路径或 `reason/error` 直接透传出去。`reason/error` 可能包含 Internal URL、
HTTP 详情或本机路径；原始值只允许写入受控的 Electron main-process 日志，公开状态必须按 phase
映射为稳定、不含诊断细节的产品文案。

`development`、`portable` 等非 installed distribution 默认进入 `unsupported`，避免开发包
误装正式制品。需要在开发模式测试更新时，应由专用测试入口显式模拟 installed context，
不能在产品代码里删除发行形态门禁。

所有 `handleNetworkReady/check/download/install` 共用一条 controller workflow queue：不同
动作按调用顺序串行，同一种正在执行的动作返回同一个 in-flight Promise。因此 renderer
无需再自己维护第二套锁。download 和 install 之前还会重新读取 `getContext`；只要
base URL、installId 或 userId 与 check 时不同，就报错并要求重新 check，不能把前一用户或
前一 Service VIP 的决策带到新会话。

默认 `componentCheckFailureMode='fail-fast'`，任一候选检查失败即停止，避免部分服务端错误
被另一个候选掩盖。Luopan 当前循环本身也是 fail-fast，直接切换时不要设置 `best-effort`。

### 4.2 Renderer / preload 建议

renderer 只接收状态快照和发出用户动作，不持有 updater 实例、文件路径、Internal token
或 Publisher credential。建议保留产品已有 IPC 命名，在 main process 内替换实现：

```text
app-update:get-state  -> publicState(controller.getState())
app-update:check      -> publicState(await controller.check())
app-update:download   -> publicState(await controller.download())
app-update:install    -> publicState(await controller.install())
app-update:cancel     -> publicState(controller.cancel('user-requested'))
app-update:state      <- onState(publicState(state))
```

公开 state 通常只保留 phase、version、notes、delivery mode、artifact kind/class、进度，以及
由 phase 生成的稳定 `message/error`；不要把 `check`、`selectedArtifact.url`、`stagedPath` 或
controller 的原始 `reason/error` 交给 renderer。

UI 至少区分 checking、downloading、verifying、ready、installing、cancelled 和 error。
`bytesReceived/totalBytes/percent` 中 `totalBytes` 或 `percent` 可能为 `null`，此时显示不定进度，
不能把它误报为 0%。

## 5. Typed hooks 与固定安全边界

### 5.1 可以由产品适配的行为

| hook/输入 | 产品应提供什么 | Luopan 示例 |
| --- | --- | --- |
| `getContext` | 当前可用的 `baseUrl`、非空稳定 `installId` 和可选 `userId`；网络未 ready 返回 `null` | 从 `luopanLauncherManager` 读取 network-ready session |
| `componentCandidates` | 允许检查的 component kind 顺序 | `app-asar` 优先，`app-installer` fallback |
| `componentCheckFailureMode` | 多候选检查的失败策略；默认 `fail-fast` | 直接切换保持默认值 |
| `selectArtifact` | 在已验证候选集合中应用产品偏好 | 同版本优先 ASAR；没有兼容 ASAR 才选 installer |
| `networkGate` | 把产品状态映射为 idle/connected/connecting/recovering/permission-required | `connecting` 与 `data-plane-pending` 阻止激活 |
| `beforeActivate` | config/renderer/ASAR 写 active slot 或 pending pointer 前的产品门禁 | 可复核业务空闲状态；不要在下载完成前清理网络 |
| `beforeInstallCleanup` | installer 已成功打开后，或 ASAR relaunch 前的产品资源清理 | 关闭 Luopan 持有的 SSH/Mihomo 等；不要清理别的 launcher owner |
| `openInstaller` | 调用操作系统打开已暂存安装包 | Electron `shell.openPath` |
| `relaunch` / `exit` | 用户确认 ASAR 后安全重启/退出 | `app.relaunch()`、`app.exit(0)` |
| `applyConfig` / `applyRenderer` | config/renderer 制品的产品内应用动作 | Luopan 当前 app 更新可不提供 |
| `onState` / `onExecutorPhase` / `onProgress` | 只读观测并更新 UI/日志 | 通过 `webContents.send` 发状态 |

观察 hook 抛错不能破坏已经校验的更新事务。产品选择 hook 只能从 controller 给出的 typed
candidate 中返回值；不能自行拼 URL、改 digest、扩大 rollout 或把其它平台制品塞进结果。

### 5.2 产品不能覆盖的规则

以下规则属于平台固定边界：

1. 新接入默认按真实、唯一的 `packageName` 解析 `productId/component/channel`。Luopan 最新版
   不设置 `allowLegacyProductFallback`；resolver 身份错误应先修 AppCenter，不能在客户端降级
   读取完整 plans。其它仍处于兼容期的旧产品只有在显式开启且 resolver 确实返回 404/405 时，
   才允许使用旧 `productId`；认证失败、网络失败、5xx 或畸形响应不能降级。
2. gate、目标用户/安装、灰度 bucket、platform、arch 和 artifact kind 均由服务端决策；
   客户端 hook 不能改写。
3. Internal artifact 路径绑定当前 ProductNetwork origin；非平台绝对 URL 保留其 origin。
4. 下载先写唯一临时文件，失败或取消后清理临时文件；校验完成后才提交 target。Windows
   目标已存在时先保存旧文件，提交失败应恢复旧文件。
5. L3 对选中的 artifact 强制要求有效 SHA-256 和非负安全整数 `sizeBytes`；缺失时在下载前
   fail closed。下载器把声明 size 与 Content-Length/实际字节数比较并校验 digest，不匹配
   不能 staging/activation。L1/L2 为兼容历史记录仍只在字段存在时校验；新接入和正式发版
   应使用 L3，Admin/CI gate 也必须断言两字段非空。
6. 接入方必须把 `baseDir` 固定为 Electron `app.getPath('userData')`。其下的
   release/component/version/fileName 经过安全 segment/basename 检查，hook 不接收任意
   target path。ASAR/npm 只写 pending pointer，在下次启动由 bootstrap 接管。
7. connecting、recovering、permission-required 时不能激活；installer 永远需要显式安装动作。
8. download/install 前必须确认当前 base/install/user 与 check 上下文完全一致；身份或网络
   origin 漂移后只能重新 check。
9. ASAR 安装必须同时注入 `relaunch` 和 `exit`，不能只 relaunch 后把旧进程留在运行。
10. 可逆阶段的 `cancel()` 或 AbortSignal 生效后，不能继续 commit、activate、open installer、
    relaunch 或 exit。取消/失败不得删除已经验证并正在使用的旧版本。一旦 active/pending commit、
    installer handoff 或 relaunch 已开始，操作不可安全撤销；此时 `cancel()` 保持当前 phase，
    明确返回 `cancellation cannot undo it`，不会伪装成 cancelled。

当前 Release Center 响应携带服务端 decision signature；客户端传输完整性仍以 Internal
信任边界和 artifact 的 size/sha256 校验为准。不要在接入说明或 UI 中声称客户端已经完成
独立公钥验签，除非后续确实增加并验证了客户端信任根。

## 6. Admin、CI、服务端与客户端职责

| 角色 | 必须负责 | 不应该做 |
| --- | --- | --- |
| 平台 Admin/AppCenter | 注册唯一 `appId/productId/packageName`、launcherMode、channels；创建并物化 ProductNetwork；管理 gate/灰度/回滚 | 把 ops token 或数据库权限交给产品 |
| 产品 CI | 构建、测试、OS 签名/公证；计算/核对摘要；用 product-scoped Publisher 上传；用独立 Approver 过 gate | 在应用中保存 client secret；手工覆盖已发布 artifact |
| Release Center | 按单安装返回决策；生成平台相对 download URL；保存证据和报告；私有 OSS 短期重定向 | 用全局 `MX_PUBLIC_BASE_URL` 固化某个产品 VIP |
| 产品客户端 | 从当前 session 获取 base；resolve/check/download/verify/stage；用户确认；首启报告 | 调 Admin/Publisher API；访问 OSS AccessKey；读取完整发布计划 |

新应用要复用 Admin 发版，至少完成：

1. AppCenter 中登记真实 package name，启用产品和 channel；
2. standalone 应用登记 ProductNetwork；embed 应用绑定其 standalone network product；
3. 验证其 Internal base 能访问 Consumer API 与 artifact download；
4. CI 使用只允许该 `productId` 的 Publisher credential；Approver credential 独立；
5. 客户端接入本 controller，按 `process.platform/process.arch` 检查；
6. 定向 plan 真机通过后再创建/批准全量 plan。

## 7. Luopan 一次性切换交接清单

真实 Luopan 当前位于 `/Users/qpjoy/workspace/mingxi/luopan/po-frontend`。其
`src-electron/app-update-manager.ts` 已经使用 L1/L2，因此切换到 L3 是收薄产品适配层，
不是替换 Luopan 的构建、界面、网络或发布能力。负责 Luopan 的开发者只应修改版本更新这条
边界，不应顺手改变登录、Launcher 连接、PAC/DNS、WireGuard、Mihomo、SSH 或业务页面。

### 7.1 保留

- Quasar/electron-builder、Windows/macOS 签名、公证和安装包输出；
- `src-electron/electron-bootstrap.cjs`，以及 Quasar 中
  `json.main='./electron-bootstrap.cjs'`、`beforePackaging`/`beforePack` copy 和
  `extraMetadata.main='electron-bootstrap.cjs'`；
- `build-electron-hot-update.mjs`、`build-electron-asar-update.mjs`、release metadata 等
  构建侧脚本；
- `runningElectronLauncherVersion`、ASAR 启动确认和失败回退；必须继续在 renderer 和网络启动
  成功后调用 `confirmElectronLauncherAsarLaunch`，不能提前确认一个尚未健康启动的 slot；
- `luopanLauncherManager.getReleaseCenterBaseUrl()` 及当前 session/install/user 上下文；
- installed/portable/development 发行形态；
- 安装前 `cleanupRuntimeForUpdate`、`shell.openPath`、`app.relaunch/app.exit`；
- 当前 renderer 的中文文案、release notes 展示、确认框和 IPC 兼容面；
- Luopan 的网络 owner 边界。更新检查/下载期间不能断开用户或改 PAC/DNS/WireGuard。

### 7.2 在 `app-update-manager.ts` 中替换

- 把 `createElectronLauncherReleaseUpdater`、`createElectronLauncherReleaseUpdateExecutor` 和
  `reportElectronLauncherInstallCompletionIfUpgraded` 的直接编排替换为
  `createElectronLauncherApplicationUpdater`；
- 删除两次 `updater.check()` 循环和本地 `chooseUpdateCheck()`；
- 删除 `checkInFlight/downloadInFlight`、`automaticCheckIdentity` 的重复并发状态；
- 删除 `lastUpdater/lastExecutor/lastCheck/selectedArtifact` 生命周期；
- 删除自己拼装 executor、转译 executor phase、查找 staged installer 和重复错误态；
- 保留 `AppUpdateManager` 类名和以下 public method，内部一一代理 L3，从而不改现有调用者：

```text
initialize(window)     -> 创建 controller，注册 onState 并发送公开状态
getState()             -> publicState(controller.getState())
handleNetworkReady()   -> controller.handleNetworkReady()
checkNow()             -> controller.check()
downloadUpdate()       -> controller.download()
installUpdate()        -> controller.install()
cancelUpdate()         -> controller.cancel('user-requested')
setBeforeInstallCleanup(fn) -> 保存并由 beforeInstallCleanup hook 调用
```

controller 应在 Electron `app.whenReady()` 之后创建，`baseDir` 固定为
`app.getPath('userData')`。`getContext` 每次从 `luopanLauncherManager` 读取，只有
`connection.status==='network-ready'` 时返回 `{baseUrl, installId, userId}`。不要在 manager
内部缓存 Service VIP，也不要把 `10.88.100.3` 写进 artifact URL。

Luopan 的公开状态需要做窄映射，不能把 L3 的 raw `check`、artifact URL、本机 `stagedPath` 或
原始 `reason/error` 发送给 renderer：

| L3 | 现有 Luopan 状态 |
| --- | --- |
| `needs-network` | `needs-connection` |
| `unsupported` | `error`，沿用便携版/开发版不自动升级文案 |
| `staged` | 映射为 `available`/“已下载，点击继续准备更新”；不得提前启用安装按钮 |
| `cancelled` | 新增同名公开 phase，并显示“已取消更新” |
| 其它 phase | 同名透传 |

公开字段继续使用 `currentVersion/latestVersion/notes/updateKind/restartRequired/message/error`；
`updateKind` 由 `artifactClass==='asar' ? 'hot' : 'installer'` 生成。进度只公开
`bytesReceived/totalBytes/percent`。其余业务状态不应进入 updater adapter。

可按下面的窄投影实现，字段名与 Luopan 当前 UI 保持一致：

```ts
function safePublicMessage(
  state: ElectronLauncherApplicationUpdateState
): string | undefined {
  switch (state.phase) {
    case 'idle': return '可检查客户端更新。';
    case 'unsupported': return '当前发行形态不支持自动更新。';
    case 'needs-network': return 'Launcher 网络未连接，暂时无法检查更新。';
    case 'checking': return '正在检查最新版本…';
    case 'up-to-date': return '当前已是最新版本。';
    case 'blocked': return '当前更新暂不可用。';
    case 'available': return '发现可用更新。';
    case 'downloading': return '正在下载客户端更新…';
    case 'verifying': return '正在校验更新包…';
    case 'staged': return '更新包已下载，点击继续准备更新。';
    case 'ready': return '更新包已准备完成。';
    case 'installing': return '正在应用客户端更新…';
    case 'cancelled': return '已取消更新。';
    case 'error': return '更新失败，请稍后重试。';
  }
}

function safePublicError(
  state: ElectronLauncherApplicationUpdateState
): string | undefined {
  switch (state.phase) {
    case 'unsupported': return '当前发行形态不支持自动更新。';
    case 'error': return '更新失败，请稍后重试。';
    default: return undefined;
  }
}

function publicState(state: ElectronLauncherApplicationUpdateState): AppUpdateState {
  const phase = state.phase === 'needs-network'
    ? 'needs-connection'
    : state.phase === 'unsupported'
      ? 'error'
      : state.phase === 'staged'
        ? 'available'
        : state.phase;
  const updateKind = state.artifactClass === 'asar'
    ? 'hot'
    : state.artifactClass === 'installer'
      ? 'installer'
      : undefined;
  return {
    success: !['error', 'blocked', 'needs-network', 'unsupported', 'cancelled'].includes(state.phase),
    mode: 'installed',
    phase,
    updateAvailable: state.updateAvailable,
    currentVersion: state.currentVersion,
    latestVersion: state.targetVersion || undefined,
    checkedAt: state.checkedAt || undefined,
    releaseId: state.releaseId || undefined,
    notes: state.releaseNotes || undefined,
    updateKind,
    restartRequired: updateKind === 'hot' || state.selectedArtifact?.restartRequired === true,
    message: safePublicMessage(state),
    error: safePublicError(state),
    bytesReceived: state.bytesReceived,
    totalBytes: state.totalBytes,
    percent: state.percent
  };
}
```

这里读取 `selectedArtifact.restartRequired` 只发生在 Electron main process；返回对象没有包含
`selectedArtifact` 本身。原始 `state.reason/state.error` 也不进入这个 mapper 的返回值，只能由
main process 写入受控日志；日志导出还应脱敏 URL query、token 和用户路径。Luopan 的
`AppUpdateState` 类型需要加入 `cancelled` phase 和三个进度字段。

### 7.3 其它 Luopan 文件只做配套接线

1. `package.json` 与 lockfile：升级到本次发布的 `@qpjoy/electron-launcher@2.3.18`，删除对旧版本号的
   静态断言；不要新增 `electron-updater`。
2. `src-electron/electron-main.ts`：保留现有 `initialize`、`setBeforeInstallCleanup`、
   `handleNetworkReady` 的调用位置，以及 check/get-state/download/install IPC；只新增
   `app-update:cancel -> cancelUpdate()`。不要调整 `cleanupRuntimeForUpdate()` 的资源边界。
3. `src-electron/electron-preload.ts` 与 `src/types/electron.d.ts`：只增加 `cancel()` 和
   `cancelled`/进度字段；其余 API 名称保持兼容。
4. `src/layouts/MainLayout.vue` 与 `src/features/Setting/SystemSettingsPage.vue`：两处都在消费
   app-update 状态；保留当前页面和中文文案，只补下载中取消按钮、`cancelled` 展示和可空
   总字节进度；不要改其它导航或 Settings 功能。
5. `src-electron/app-update-manager.test.js`：从 L1/L2 源码形状断言改为 L3 adapter 行为断言；
   必测相对 URL 使用 session base、ASAR 优先/installer fallback、取消不清网络、重复点击去重、
   context drift、installer 精确打开一次、ASAR 重启回退。
6. 保留并继续运行 bootstrap、Quasar main/copy 和 ASAR build 的现有断言；为 Windows x64 与
   macOS 目标分别构建制品，不允许用构建宿主的 native runtime 代替目标 runtime。

直接切换使用默认 `app-asar -> app-installer` 和默认 fail-fast；不要设置
`allowLegacyProductFallback` 或 `componentCheckFailureMode='best-effort'`。如果 package resolver
不能返回 Luopan 身份，应修 AppCenter 注册，而不是在客户端恢复旧计划读取。

## 8. Luopan 配置：生产不依赖 `.env` 固定 VIP

直接切换后的正式包不需要设置这两个变量：`stable` 已是 controller 配置，Internal base 从
当前 session 读取。也就是说，生产推荐值是“不设置 `LUOPAN_RELEASE_BASE_URL`”，而不是把
`10.88.100.3` 编译成新的永久常量。

Luopan 源码当前识别以下运行时环境变量（这不代表它们会自动打入安装包）：

```dotenv
LUOPAN_RELEASE_CHANNEL=stable
LUOPAN_RELEASE_BASE_URL=http://10.88.100.3:18090
```

`LUOPAN_RELEASE_BASE_URL` 只用于本地开发或客户现场应急；生产默认应取
`session.routePlan.internalBaseUrl`。否则 Service VIP 变化后需要重新改环境或打包，并可能
把流量归到错误产品。

当前 Luopan 的 `quasar.config.ts` 只把 bootstrap URL 编译为
`__ELECTRON_LUOPAN_BOOTSTRAP_URLS__`；`luopan-launcher-manager.ts` 虽读取运行时
`process.env.LUOPAN_RELEASE_BASE_URL`，但把同名值写进 `.env.production/.env.h2i` 并不会
自动留在客户双击启动的 Electron 进程里。直接切换方案不新增 packaged VIP override；正式包
始终以 session `routePlan.internalBaseUrl` 为权威。不要复用 `MX_H2I_INTERNAL_BASE_URL`。

还需要注意：

- base value 必须是带 scheme/port 的 origin，不是 artifact 相对 path；
- 确认变量确实注入 Electron main process；renderer 的构建变量不会自动变成 main process
  的 `process.env`；
- `.env` 只能选择 check/download 的 base 和 channel，不能绕过 ProductNetwork ready、gate、
  rollout 或平台/架构；
- check 后改变 `LUOPAN_RELEASE_BASE_URL`、用户或 installId 会触发 context drift，必须重新
  check，不能直接继续下载/安装；
- 最新 SDK 会把精确匹配的平台旧 Internal artifact URL 重新绑定到当前 session base；仅修改
  `.env` 既不需要，也不能代替 AppCenter/ProductNetwork 配置；
- 服务端已按 §3.3 为 Luopan 精确平台路径提供 check 相对 URL 投影；部署后旧 2.0.2 可直接
  自举最终 L3 版本，无需中间版，但发布 plan 前仍须用真实客户端验证签名和下载链路；
- 不要在 `.env` 放 Publisher secret、Approver secret、ops token、OSS AccessKey；
- 客户端不要设置服务端的 `MX_PUBLIC_BASE_URL`。

## 9. 验收矩阵

| # | 场景 | 预期 |
| --- | --- | --- |
| U1 | AppCenter 登记真实 package/channel | resolver 返回自己的 product/component；不存在、重复或 channel 未启用时 fail closed |
| U2 | 已部署新服务端 + 真实 Luopan 2.0.2 + 数据库旧 Internal 绝对 artifact URL | check 在签名前返回根相对 URL；2.0.2 校验响应后从当前 `10.88.100.3:18090` 直接下载最终 L3 版本，不访问 `10.88.88.88`，无需中间版 |
| U3 | 数据库残留旧 Internal 绝对 artifact URL | 严格匹配平台 download path 时重绑定到当前 base；其它绝对 CDN URL 不改写 |
| U4 | protocol-relative、非 HTTP(S)、超出 redirect 上限 | 下载拒绝，不产生可激活文件 |
| U5 | sha256/size 缺失，或 digest、size、Content-Length 不匹配 | L3 fail closed；临时文件清理，旧 target 保留，不能 install |
| U6 | Windows x64 installer | 下载到 `userData/updates/...`；用户确认前不打开；确认后 `shell.openPath` 一次 |
| U7 | macOS arm64/x64/universal installer | 只选择匹配架构制品；确认前不打开 DMG/PKG |
| U8 | ASAR `silent-download-next-start` | 自动下载、校验、写 pending；不自动重启/退出；下次启动 bootstrap 成功后确认 |
| U9 | ASAR 启动失败 | bootstrap 回退上一 ASAR 或安装包基座；网络会话不被 updater 清理 |
| U10 | connecting/recovering/permission-required | 可以保留既有会话/已下载文件，但不得激活、打开安装器或退出应用 |
| U11 | 下载中点击取消或外部 AbortSignal | 请求/流中断，临时文件清理，进入 cancelled；不执行后续 hook，不断网 |
| U12 | 可逆阶段与不可逆 handoff 后分别取消 | handoff 前停止后续动作；active/installer/relaunch 已开始时报告无法撤销，不伪装 cancelled |
| U13 | 重复/交叉点击 check/download/install | 同类动作共享 in-flight；不同动作全局串行；installer 不会打开两次；状态顺序稳定 |
| U14 | Internal 不 ready | `needs-network`，不回退到其它产品 VIP，不读取 admin plans |
| U15 | Luopan package resolver 返回 404/405 | fail closed 并修复 AppCenter；Luopan 最新版不启用 legacy fallback |
| U16 | 定向、百分比灰度和 blocked gate | 未命中显示 up-to-date；blocked 不下载；客户端不能通过 hook 强制选择 |
| U17 | 下载/状态 observer 自己抛错 | 不破坏下载、状态机或已验证 commit |
| U18 | 新 installer 首次启动 | 上报 `installer-completed`，包含 installId 和 from/to；上报失败不阻塞启动 |
| U19 | Luopan 与 MX-H2I 同机 | 每个产品使用自己的 Internal origin、安装目录和网络 owner；任一更新不改变另一方连接 |
| U20 | development/portable | 默认 unsupported，不下载正式更新 |
| U21 | check 后切用户、installId 或 Internal base | download/install 拒绝并要求重新 check；旧决策不能跨上下文使用 |
| U22 | ASAR 只提供 relaunch 或只提供 exit | install fail closed；同时提供后才允许 handoff |
| U23 | 候选 check 部分失败 | Luopan 保持默认 fail-fast；通用 best-effort 不在 Luopan 直接切换中启用 |
| U24 | L3 `reason/error` 含 Internal URL、HTTP 详情或本机路径 | 原始诊断只进入 main-process 受控日志；preload/renderer 仅收到按 phase 生成的固定安全文案，公开 state 与 IPC payload 不含原始值 |
| U25 | 分别用 MX-H2I、Luopan 外部 CDN/OSS、Luopan artifactId 不匹配 URL 调用 check | URL 均保持原样；只有 `productId=luopan` 且 pathname 精确匹配当前 artifactId 的平台 download 路径被相对化，响应签名覆盖投影后的结果 |

自动化至少运行：

```bash
pnpm --dir electron-dock/mx-launcher/packages/electron-launcher typecheck
pnpm --dir electron-dock/mx-launcher/packages/electron-launcher test:updater
pnpm --dir electron-dock/mx-launcher/packages/electron-launcher test:asar-bootstrap
pnpm --dir electron-dock/mx-launcher/demos/mx-h2i check
```

发布前还要在已部署的 Internal 环境用真实 2.0.2 做 U2，并验证 U25 的隔离样本；同时在真实
Windows/macOS 做 U6-U13、U18-U19。只有 mock HTTP 测试通过，
不能证明 `shell.openPath`、ASAR bootstrap、Windows 文件替换和双 standalone 共存已经通过。
Luopan 的 ASAR 还必须在目标 OS/arch 检查 native runtime：当前 runtime-module 脚本按构建宿主
的 `process.platform/process.arch` 选择 WireGuard/native 模块，不能用 macOS arm64 上生成的
结果替代 Windows x64 真机构建与启动验证。
