# 桌面交付：Launcher 产品化、统一账号登录与按需组网（方案，2026-10-16）

## 1. 你的要求

- 桌面端改回 **Launcher 包**：基于 mx-launcher 的 standalone 产品，可以获得入网资格。
- 直接接入 Launcher 的统一认证（SSO），用平台账号登录。
- 需要组网时，在 Rig 界面里安装，得到和罗盘（Compass / Luopan）一样的内网与外网能力。
- 先手动验收现有功能，再交付 Windows 和 macOS。

这推翻了 2026-09-25 的决定（Rig 完全不依赖 Launcher 登录、不做 standalone，见 docs/12 §0）。同一天定下的底线不变：**任何改动不影响 MX-H2I 现有的用户登录和联网**。

## 2. 现状

| 方面 | 现在 |
| --- | --- |
| 账号 | Rig 自有账号。服务端配置 `MX_RIG_LAUNCHER_URL` 后，Launcher 统一账号也能用账号密码登录：服务端代换 SDK token 并内省，首次登录是查看者。代码已有：`packages/test-platform/server/identity/launcher-client.mjs` |
| 浏览器 SSO | 没有 |
| 桌面端 | 独立的 Electron 应用（`dev.qpjoy.mx-rig`），只连 Rig 服务。不申请 lease，不碰网络 |
| 更新 | 没有自动更新，要重新装包 |
| 组网 | 没有。「出网与通道」只管 Rig 自己的模型调用和隔离浏览器 |

可以参考的现成做法：

- **Luopan**：standalone 产品。用 User Center 密码换 SDK token（`/internal/v1/sdk/oauth/token`，audience `mx-sdk`），登录后申请登录段 lease；还有 Release Center 更新和海外订阅。
- **范围**：所有服务端、网页端、桌面端和部署都在 mx-rig 里。旧的 `mx-launcher/demos/mx-autotest` 原型以后会废弃，Rig 不依赖它，也不以它为准。
- **统一认证**（launcher docs/45–49）：Auth 基于 oidc-provider；应用后端用 `@qpjoy/mx-common/identity/sso` 接入，Hub 和 Pay 已经这样接了。
  - 应用在 Internal →「平台设置 → 统一认证 → 接入应用」登记；
  - **回调只能是 `https://<应用域名>/auth/sso/callback`**，所以桌面端不能自己当 OIDC 客户端，要经过 Rig 服务。

## 3. 决定（2026-10-16 与你确认）

### 3.1 独立端（standalone），同时在 AppCenter 里列出

| | 放进 MX-H2I 的 AppCenter（embed） | 独立端（standalone，像 Luopan） |
| --- | --- | --- |
| 联网 | 借 MX-H2I 的隧道，不用自己装 | 自己的 lease 和 VIP，第一次要系统授权 |
| 登录 | 跟着 MX-H2I 的会话 | 统一账号登录一次 |
| 前提 | **必须装着并运行 MX-H2I** | 不需要 MX-H2I，也可以和它同时运行 |
| 故障范围 | Rig 走 MX-H2I 的 broker 和宿主逻辑（这部分还在 MX-H2I 的 main.cjs 里，没有下沉），出问题可能牵连 MX-H2I | 互不影响 |
| 测试流量 | 用你个人的 MX-H2I 身份和网络策略 | 用 Rig 自己的产品网络和策略 |
| 发版 | 跟 MX-H2I 的 embed 发版策略走 | 自己的 Release Center 节奏 |

**选独立端。** 决定性的一条：罗盘桌面端的测试必须在**不装 MX-H2I** 的专用测试机上跑，因为罗盘会初始化 Launcher、代理和隧道（docs/22 E2）。做成 embed 就要求这些机器装 MX-H2I，自相矛盾。Rig 还要带 Chromium、执行机和工位，也不适合做成 AppCenter 的插件包。

同时在 AppCenter 目录里列出 Rig：登记成 `launcherMode: standalone` 的应用，和 Luopan 一样。MX-H2I 的用户在 AppCenter 里能看到它并安装，但它是独立运行的。

### 3.2 先走内网 IP，以后再绑域名

参照罗盘的 `.env.h2i`：

```text
bootstrap        http://116.62.51.154:18090（公网中继，IP，与各产品共用；必须是 http，裸 IP 的 https 会握手失败）
                 https://h2i.minsight-ai.com（备选）
Launcher Internal  http://<Rig 的 VIP>:18090
Rig 服务           http://<Rig 的 VIP>          ← Internal 网关按 Host 反代到 Rig 服务
```

- Rig 的 VIP 在 Launcher Admin 登记 ProductNetwork 时由平台分配。**桌面端不写死 VIP**：运行时向 Launcher 查自己的 ProductNetwork（`getProduct('mx-rig')`）得到。
- Internal 网关按 Host 转发。罗盘生产环境的接口地址就是 `http://10.88.100.3`，靠的是一条 host 为该 VIP 的反代路由。Rig 也登记一条：host 为 Rig 的 VIP，目标为 Rig 服务在集群里的地址。
- 以后绑域名（内网 `rig.mxinfo-inc.cn` 走 split DNS，或公网 `rig.minsight-ai.com` 经跳板机）只改配置和路由，不改代码。浏览器 SSO（原 L2）也等那时再做。

### 3.3 连接与登录：登录一次

直接用 `@qpjoy/electron-launcher` SDK 的公开合同（产品网络查询、lease、standalone 数据面），代码全部写在 mx-rig 的桌面端里：

1. **打开桌面端**：经 bootstrap 申请匿名 lease，WireGuard 只路由 Rig 自己的 lease 段和 VIP，**不设系统 DNS / PAC / NRPT**。第一次连接要系统授权：macOS 上装 LaunchDaemon，Windows 上是 UAC。
2. **VIP 通了以后**，Rig 服务已经能访问。登录页只要一个统一账号：
   - 账号密码**经隧道**发给 Rig 服务（`/api/rig/v1/native-login`）。Rig 服务用 Launcher 账号登录，这一步已经实现，见 §2。
   - 同时经 VIP 向 User Center 换桌面端自己用的 token，用来换用户 lease，以后还要申请海外订阅。这个 token 不离开桌面端主进程，也不落盘。
3. **换成用户 lease**，用户身份的网络策略和定向发版从这里生效。

本地 Rig 账号保留：应急管理员，以及开发和局域网环境下「直接填服务地址」的模式。

### 3.4 尽量少手动配置

| 在哪 | 怎么做 | 手动？ |
| --- | --- | --- |
| Rig 服务 | `scripts/manage.sh deploy` 在集群里找到 `mx-launcher-internal.mx-internal-shadow:18090`，自动作为 `MX_RIG_LAUNCHER_URL`；网络策略只多放行这一个端口 | 否 |
| Rig 服务 | deploy 结束时打印要登记的网关路由（host = Rig 的 VIP，目标 = Rig 服务的 NodePort 地址） | 复制一次 |
| 桌面端 | 产品标识、bootstrap 地址打进安装包；VIP 和服务地址运行时取 | 否 |
| Launcher 侧登记 | mx-rig 自己带登记清单（`deploy/launcher/`）和 `scripts/manage.sh launcher plan / apply`：先预览，确认后写入。SDK 公开了 ProductNetwork 的登记接口（`upsertProduct`），这一项由命令完成；应用目录、网关路由和 Release Center 组件如果没有公开接口，命令打印要填的确切内容 | 一次（运维确认） |

登记清单和命令都在 mx-rig 里，和 Rig 的其他部署放在一起；Launcher 的代码和部署不动。

## 4. 交付顺序

| 阶段 | 内容 | 前置 | 验收 |
| --- | --- | --- | --- |
| **P1** | 服务端：自动接 Launcher、网络策略、打印路由。桌面端：Launcher 模式（匿名 lease → WireGuard → VIP → 统一账号登录 → 用户 lease）、网络状态和断开 / 卸载、打包带上 WireGuard 引擎 | Launcher Admin 登记 ProductNetwork 和网关路由；一台装着 MX-H2I 的测试机做并存检查 | 测试机上装包 → 授权 → 登录 → 用 Rig；MX-H2I 照常（C1–C12） |
| **P2** | Release Center 自动更新（安装包和热更新、回滚）；Windows / macOS 两端的签名与交付 | Release Center 组件；证书（可选） | 装旧版后检查、更新、回滚 |
| **P3** | 外网：海外订阅 → 隔离代理 → Rig 出网通道 | 账号有海外订阅权限 | 测试浏览器经通道打开海外站点，系统代理不变 |
| **P4** | 绑域名后的浏览器 SSO（网页端和桌面端） | 域名、Auth 登记 `mx-rig` | 浏览器已登录时一键进入，飞书可用 |

## 5. 不变的边界

- 不改 MX-H2I 和 Luopan 的代码；不复用它们的 VIP、lease 或凭据；不设系统级 DNS / PAC。
- Rig 的任何故障不能进入 Launcher 或 MX-H2I 的登录关键路径。
- Rig 本地账号保留：用于应急管理员和没有 Launcher 的环境。
- Launcher 生产环境里的登记由你或运维在 Launcher Admin 里操作；Rig 这边不写线上 Launcher。

## 6. 手动验收

现有功能的逐步验收清单单独做成了一个页面：每一步写明怎么做、应该看到什么，可以逐条标「通过 / 有问题 / 跳过」并写反馈。最后一组是 Windows / macOS 交付，其中依赖本方案的步骤标了「等 L1–L4」，按 §4 对应到 P1–P4。

## 7. P1 交付记录（2026-10-16）

**已在 mx-rig 里实现**

- **桌面端 Launcher 模式**（`apps/desktop/launcher-network.mjs`），依赖 `@qpjoy/electron-launcher` 2.3.19：
  - 打开桌面端后先连接自己的产品网络：经 bootstrap 申请匿名 lease，WireGuard 只路由 Rig 自己的 lease 段和 VIP，不设系统 DNS / PAC / NRPT，然后确认 VIP 和 Rig 服务都能访问；
  - 登录页先显示「内网」状态：没有服务地址可填，网络通了才能登录；第一次连接前说明要装什么（系统授权）；连接过一次以后，启动时自动重连；
  - 统一账号登录：账号密码经隧道交给 Rig 服务，同时经 VIP 换桌面端自己的 token，换成用户 lease。token 只在内存里；网络凭据用系统钥匙串加密存放；
  - Rig 的本地账号仍可登录，网络保持匿名 lease；
  - 只有真正建立过隧道才会去停它。连接在建立隧道之前就失败了，退出时不碰系统，也就不会弹管理员授权。
  - 没有登记时给出明确提示，告诉管理员该做什么。
- **服务端**：`scripts/manage.sh deploy` 在集群里找到 Launcher Internal，自动设置统一账号登录；网络策略只多放行 Launcher Internal 的 18090 端口；deploy 结束时打印要登记的网关路由。
- **登记**：`deploy/launcher/mx-rig.json` 是登记清单。`scripts/manage.sh launcher plan` 只读，按 Launcher 的公式挑出空闲的 lease 段和 VIP（见下）；`launcher apply` 用 Launcher 的 Internal Ops Token 写入 ProductNetwork 和 AppCenter 条目，并列出只能在 Launcher Admin 里做的两步：在 Domestic 中继上对齐 VIP，以及网关反代路由。
- **打包**：`scripts/manage.sh desktop --launcher` 打出 Launcher 独立端，带上目标平台的 WireGuard 引擎，放在 `Resources/wireguard/<平台>`。其他平台或架构的引擎会自动取一次。
- **仓库自检**：`scripts/check.mjs` 原来禁止桌面端出现任何数据面代码，现在只允许 `launcher-network.mjs` 这一个文件，并且它不能出现别的产品的名字；驱动 MX-H2I runtime、手工改路由仍然在任何地方都禁止。

按现有产品推算，Rig 会拿到 product index 3：VIP `10.88.100.5`，lease 段 `10.93.0.0/16`。实际以 `launcher plan` 读到的线上数据为准。

**验证**

- `tests/launcher-network.test.mjs`（7 项，用模拟的 SDK）：
  - 匿名连接只路由自己的 lease 段和 VIP，不设 DNS，状态文件里没有明文密钥；
  - 未登记、登记成 embed、Rig 服务没有反代路由时，分别给出说明；
  - 拒绝别的产品的路由；
  - 登录只走 VIP，token 不落盘，换成用户 lease 时出示原 lease；
  - 没有钥匙串就不连接，和其他网络冲突时报告而不是强行接管；
  - 隧道没建起来时退出不碰系统；断开时只停自己并释放 lease。
- `tests/launcher-register.test.mjs`：
  - 挑空闲 index（1 是 Luopan，2 与 AppCenter 的 `10.92` 冲突）；
  - 已经登记好的不再改动，登记错了要更正；
  - 命令 `plan` 只读，`apply` 没有 token 就拒绝；有 token 时只写两处，token 不出现在输出里。
- `npm run test:desktop` 新增：同一个应用以 Launcher 模式启动，连本地的替身入口：登录页先显示网络、没有地址输入框、未连接时不能登录；点「连接内网」走真实的 SDK，到「未登记」为止，提示管理员运行 `manage.sh launcher plan`。截图：`.runtime/qa/desktop-launcher-login.png`。这台开发机上没有装任何 WireGuard。
- `npm run package -- --dir --launcher`：应用里带上了 WireGuard 引擎（`wg`、`wg-quick`、`wireguard-go`），SDK 和 Launcher 模式的默认配置都在。

**还没有验证的**：真实 Launcher 上的连接。要先登记，再在一台装着 MX-H2I 的测试机上验收：

1. 在 Internal 节点上 `scripts/manage.sh deploy`，确认打印了统一账号登录和网关路由；
2. `scripts/manage.sh launcher plan` 看计划，`MX_LAUNCHER_OPS_TOKEN=… scripts/manage.sh launcher apply` 写入；
3. 按 apply 的提示，在 Launcher Admin 里对齐 VIP，并登记网关路由；
4. `scripts/manage.sh desktop --launcher` 打包，在测试机上安装；
5. 打开 →「连接内网」→ 系统授权 → 已连接 → 用统一账号登录 → 「内网 · 用户网络」；
6. 同时检查 MX-H2I：登录、已有连接、断开、退出都照常（Launcher 的并存检查 C1–C12）；
7. 退出 MX Rig，隧道随之停止；再打开时自动重连，不再要授权。
