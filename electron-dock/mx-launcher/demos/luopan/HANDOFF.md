# Luopan 开发者 Handoff

给接手 Luopan 正式开发的同学。本目录是可运行的起点模板；全量参考实现在
`../mx-h2i`（standalone launcher 的完整形态）。**demo 行为与 npm 包 API 冲突时，
以 npm 包为准**——`packages/*` 才是契约，demo 只是消费示例。

总体设计见 [docs/19](../../docs/19-formal-delivery-npm-packaging-and-luopan-handoff.md)
（交付方案）与 [docs/14](../../docs/14-mx-h2i-standalone-launcher-architecture.md)
（共存与网络边界）。

## 依赖

只需要从 npm 安装（当前 2.0.0）：

| 包 | 用途 |
| --- | --- |
| `@qpjoy/electron-launcher@^2.0.0` | 唯一必装。WG/网络、ownership registry、release-updater、诊断都从它的子路径导入 |
| `@qpjoy/ui-design-neon-void@^2.0.0` | 可选，UI 组件库 |

开发/打包双模式（仓库内开发时）：

```sh
pnpm setup        # local: workspace 包直连（日常开发）
pnpm setup:npm    # npm: 从 registry 安装已发布版本（正式打包前必须切到此模式）
pnpm dev          # quasar dev -m electron
pnpm build        # quasar build -m electron --skip-pkg
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

开发期未入网时：`LUOPAN_LAUNCHER_BASE_URL=<lan-admin-url>` 覆盖 base URL，
`LUOPAN_SDK_TEST_MODE=1` 走服务端测试模式；两者都不允许出现在正式构建里。

## 五条红线（验收会逐条检查）

1. **路由只装自己的**：`routeCidrs` 仅含 `10.91.0.0/16` + `10.88.100.3/32`。不 adopt
   其他 standalone（如 MX-H2I 的 `10.89.*`、`10.88.100.1/32`）的任何 CIDR，重连时也不行。
2. **系统 DNS/PAC 不直写**：一律通过 `@qpjoy/electron-launcher` 的 ownership registry /
   system-domain-proxy 声明，由本机合并面统一落地。不直接调 `networksetup`、NRPT、
   PAC URL 设置。
3. **不自建更新器、不带 native helper**：更新走
   `@qpjoy/electron-launcher/release-updater`，`componentId=luopan`。大版本安装包由
   Release Center 下发（installer-manual），热更（npm artifact / 配置 / feature flag）
   自动生效。
4. **端口不 hardcode**：mihomo、local edge、broker socket 等经包 API 申请，带冲突退避；
   本机目录/socket 按 `luopan` 产品命名空间隔离。
5. **正式包 = npm 模式构建**（见上）。

## 验收标准

- 干净机器（无 workspace）上 `pnpm setup:npm && pnpm build` 成功，应用能连上
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

## 参考

- `../mx-h2i`：standalone 全量参考（连接状态机、AppCenter host、更新检查 UI）。
- [docs/15](../../docs/15-sdk-gateway-api.md)：SDK gateway API。
- [docs/18](../../docs/18-mx-h2i-release-validation-runbook.md)：发布验证 runbook。
- Internal base URL、测试账号：向平台方索取。
