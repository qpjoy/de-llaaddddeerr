# Luopan 开发者 Handoff

给接手 Luopan 正式开发的同学。本目录是可运行的起点模板；全量参考实现在
`../mx-h2i`（standalone launcher 的完整形态）。**demo 行为与 npm 包 API 冲突时，
以 npm 包为准**——`packages/*` 才是契约，demo 只是消费示例。

总体设计见 [docs/19](../../docs/19-formal-delivery-npm-packaging-and-luopan-handoff.md)
（交付方案）与 [docs/14](../../docs/14-mx-h2i-standalone-launcher-architecture.md)
（共存与网络边界）。**开发指南（从零到验收的完整走读，先读这份）：
[docs/20](../../docs/20-luopan-standalone-development-guide.md)。**

## 依赖

只需要从 npm 安装（当前 **2.3.3**，全组 lockstep 发布。bootstrap URL
解析与打包版 `.env` 加载从 2.3.2 起提供，不要降级）：

| 包 | 用途 |
| --- | --- |
| `@qpjoy/electron-launcher@^2.3.3` | bootstrap、WG/网络、ownership registry、release、local-ports，以及登录用户 `ensure-subscription` 客户端 |
| `@qpjoy/electron-plugin-tunnel@^0.1.18` | mihomo 生命周期、inline YAML、隔离 Session 代理和测试窗口；传递安装当前平台 engine |
| `@qpjoy/ui-design-neon-void@^2.3.3` | 可选，UI 组件库 |

表中版本是当前 workspace 基线。正式切 `setup:npm` 前，必须先发布包含本次
Oversea API（inline YAML、`openTestWindow`、可关闭通用 IPC、四端口持久化）的下一批
npm 包；不能拿 registry 上同版本的旧产物冒充本次 workspace 实现。

开发/打包双模式（仓库内开发时）：

```sh
pnpm run setup        # local: workspace 包直连（日常开发；不能省略 run）
pnpm run setup:npm    # npm: 从 registry 安装已发布版本（正式打包前必须切到此模式）
pnpm run dev          # quasar dev -m electron
pnpm run build        # quasar build -m electron --skip-pkg
```

**红线：对外分发的安装包必须在 npm 模式下构建**；workspace/tarball 构建的包不得注册进
Release Center。

## 网络注册（平台方已完成，不要自己改）

Luopan 已在 Internal Admin 注册为 standalone launcher 产品：

| 项 | 值 |
| --- | --- |
| lease 段（登录用户） | `10.91.0.1 – 10.91.99.254` |
| lease 段（匿名用户） | `10.91.100.1 – 10.91.254.254` |
| service VIP（control/DNS/proxy） | `10.88.100.3` |
| `internalBaseUrl` | `http://10.88.100.3:18090` |
| 应用域名 | `luopan.mxinfo-inc.cn`（CoreDNS A → 10.88.100.3，gateway 反代） |

`10.88.100.3` 是 Internal 把控制面/DNS/代理 materialize 给 Luopan channel 的产品
VIP——它是 Luopan 到达 Internal 的**唯一路由**，不是装饰性标签。`10.88.88.88` 和
`10.88.0.1` 是 MX-H2I/foundation 的迁移期兼容地址，**Luopan 一律不得使用**（包括
默认 base URL、诊断、兜底逻辑）。

**Bootstrap 首连（开发与打包版通用）**：注册的 base URL（`10.88.100.3`）是隧道内
VIP，首次 enroll 时不可达。把 bootstrap 可达入口写进 `.env`
（当前可用 `LUOPAN_BOOTSTRAP_URLS=http://116.62.51.154:18090`，也可按优先级
追加 LAN 入口，逗号分隔，见 `.env.example`）：
`network-ready` 之前仅匿名 enroll/bootstrap 与无凭证请求走首个探测通过的
bootstrap URL；账号、密码和 bearer token 必须等 Internal 就绪后才发往 VIP。加载顺序：真实 env > `<userData>/.env`（每台机器可覆盖）> 打包内
`Resources/.env`（构建时项目根有 `.env` 会自动带入）> 开发目录 `.env`。能力由
`@qpjoy/electron-launcher/bootstrap`（≥2.3.2）提供：`resolveElectronLauncherBootstrap`
/ `parseElectronLauncherBootstrapUrls` / `loadElectronLauncherEnvFiles`，其他产品
照此接入即可。

开发期未注册时才允许用非 VIP 的 `LUOPAN_LAUNCHER_BASE_URL=<lan-admin-url>` 覆盖
base URL，并配合 `LUOPAN_SDK_TEST_MODE=1` 走服务端测试模式；两者都不允许进入正式
构建。正式 `.env` 可以显式把 base URL 固定为注册 VIP `10.88.100.3`，bootstrap URL
则本来就是产品的公开入口配置。
demo 默认 registered 模式，工具栏 **Connect Internal** 一键完成
lease → 数据面 → VIP healthz。平台侧开通的完整操作（Admin 注册、Service VIP
Reconcile、`mx-internal-svc` 语义、enroll 报错对照）见 docs/20 §4.5。

用户中心：先匿名 **Connect Internal**，侧栏面板才允许 `luopan:login` 通过隧道内
VIP 走 SDK gateway OAuth password grant（docs/15）。登录后下一次 Connect 才把 lease 切到登录段
（`10.91.0.1-.99.254`）；检查更新立即携带 userId。access token 只留内存，登出或
重启即失效。

Oversea：登录与 `network-ready` 是一个双条件门，但安全顺序固定为先匿名连接
Internal、再登录。登录成功后主进程自动调用
`POST /internal/v1/user-center/users/:userId/oversea/ensure-subscription`。只有服务端返回
`ensure.ready=true` 才将 inline YAML 写入 tunnel runtime 并启动应用级代理；
`pending-runtime-sync` 只显示等待/刷新，不做假成功。测试窗口使用
`persist:luopan-oversea` 隔离 Session，首版只允许 `app-global | app-rule`，禁止
system TUN 抢 Internal WireGuard。登出和断开 Internal 都会停止代理。

## 五条红线（验收会逐条检查）

1. **路由只装自己的**：`routeCidrs` 仅含 `10.91.0.0/16` + `10.88.100.3/32`。不 adopt
   其他 standalone（如 MX-H2I 的 `10.89.*`、`10.88.100.1/32`）的任何 CIDR，重连时也不行。
2. **系统 DNS/PAC 不直写**：一律通过 `@qpjoy/electron-launcher` 的 ownership registry /
   system-domain-proxy 声明，由本机合并面统一落地。不直接调 `networksetup`、NRPT、
   PAC URL 设置。
3. **不自建更新器、不带 native helper**：更新走
   `@qpjoy/electron-launcher` 的 release-updater（检查/上报）+
   release-update-executor（下载/staged/激活/回滚），`componentId=luopan`。大版本
   安装包由 Release Center 下发（installer-manual，永远手动确认），热更
   （npm artifact / 配置 / feature flag）自动生效。**本 demo 的
   `src-electron/electron-main.ts` 已带完整接线**（`luopan:check-updates` /
   `apply-update` / `open-staged-installer` / `rollback-update-slot` 四个 IPC +
   启动期 adoption/installer-completed 回报），逐段讲解见 docs/20 §5。
4. **端口不 hardcode**：mihomo、local edge、broker socket 等经包 API 申请，带冲突退避；
   本机目录/socket 按 `luopan` 产品命名空间隔离。
5. **正式包 = npm 模式构建**（见上）。

## 验收标准

- 干净机器（无 workspace）上 `pnpm run setup:npm && pnpm run build` 成功，应用能连上
  `10.88.100.3` 完成 enroll。
- 与 MX-H2I 同机共存矩阵（docs/19 §4，C1–C12）全绿：双连、任意顺序、断开/杀进程互不
  影响、与 Clash TUN / 系统 PAC 共存。Windows 10/11 与 macOS 都要过。断言用仓库里的
  半自动工具跑（操作员连/断，工具快照并断言路由/NRPT/PAC/registry）：

  ```sh
  node ../../scripts/coexist-check.mjs run              # 全矩阵 C1–C12
  node ../../scripts/coexist-check.mjs run --scenario C5
  node ../../scripts/coexist-check.mjs assert --product luopan --expect connected
  ```
- 检查更新面板能显示 Release Center 决策；被 targets 圈中的测试用户能收到定向版本。
- 登录用户在 Internal ready 后能达到 `oversea.status=running`，mixed 端口监听，测试
  窗口 `resolveProxy` 命中 `127.0.0.1:<mixed>`；登出后端口释放且测试 Session 回 DIRECT。

## 参考

- [docs/20](../../docs/20-luopan-standalone-development-guide.md)：**Luopan 开发指南**——
  V2 MX-H2I 工作原理走读 + 照着开发 Luopan 的完整路线（含更新执行器接线逐段讲解、
  embed launcher 可选章节）。
- `../mx-h2i`：standalone 全量参考（连接状态机、AppCenter host、更新检查 UI）。
  注意 main.cjs 里 AppCenter host / broker 属于**尚未下沉**的平台逻辑——遇到
  "demo 里有但包里没有"的能力，找平台方下沉，不要复制 main.cjs。
- [docs/15](../../docs/15-sdk-gateway-api.md)：SDK gateway API。
- [docs/18](../../docs/18-mx-h2i-release-validation-runbook.md)：发布验证 runbook。
- Internal base URL、测试账号：向平台方索取。
