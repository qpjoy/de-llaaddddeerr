# 桌面交付：Launcher 产品化、统一账号登录与按需组网（方案与交付记录，更新至 2026-10-17）

## 1. 你的要求

- 桌面端改回 **Launcher 包**：基于 mx-launcher 的 standalone 产品，可以获得入网资格。
- 直接接入 Launcher 的统一认证（SSO），用平台账号登录。
- 需要组网时，在 Rig 界面里安装，得到和罗盘（Compass / Luopan）一样的内网与外网能力。
- 先手动验收现有功能，再交付 Windows 和 macOS。

这推翻了 2026-09-25 的决定（Rig 完全不依赖 Launcher 登录、不做 standalone，见 docs/12 §0）。同一天定下的底线不变：**任何改动不影响 MX-H2I 现有的用户登录和联网**。

## 2. 现状（2026-10-17，以当前实现为准）

| 方面 | 现在 |
| --- | --- |
| 账号 | Rig 自有账号。服务端配置 `MX_RIG_LAUNCHER_URL` 后，Launcher 统一账号也能用账号密码登录：服务端代换 SDK token 并内省，首次登录是查看者。代码已有：`packages/test-platform/server/identity/launcher-client.mjs` |
| 浏览器 SSO | 尚未实现；统一账号密码登录不等于浏览器 OIDC SSO，见 P4 |
| 桌面端 | 独立的 Electron 应用（`dev.qpjoy.mx-rig`）。Launcher 模式已实现匿名 lease、自己的 WireGuard 隧道和登录后的用户 lease；普通模式仍直接连接指定的 Rig 服务 |
| 更新 | Launcher 安装包已接 Release Center 完整安装包更新；源码和 `--dir` 运行不自动更新。真实定向更新闭环仍待验收，见 §8 |
| 组网 | Launcher 模式已有产品内网及按需海外通道；只管理 Rig 的网络和测试浏览器，真实桌面连接与海外线路仍待验收，见 §7、§9、§10 |

可以参考的现成做法：

- **Luopan**：standalone 产品。用 User Center 密码换 SDK token（`/internal/v1/sdk/oauth/token`，audience `mx-sdk`），登录后申请登录段 lease；还有 Release Center 更新和海外订阅。
- **范围**：所有服务端、网页端、桌面端和部署都在 mx-rig 里。旧的 `mx-launcher/demos/mx-autotest` 原型以后会废弃，Rig 不依赖它，也不以它为准。
- **统一认证**（launcher docs/45–49）：Auth 基于 oidc-provider；应用后端用 `@qpjoy/mx-common/identity/sso` 接入，Hub 和 Pay 已经这样接了。
  - 应用在 Internal →「平台设置 → 统一认证 → 接入应用」登记；
  - 当前平台的**公网应用登记合同**要求 `https://<应用域名>/auth/sso/callback`；Rig 计划通过自己的后端接入，再把登录结果安全交给桌面端。这是现有平台的接入方案，不是 OIDC 协议禁止原生客户端。

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
- 以后可以绑域名（内网 `rig.mxinfo-inc.cn` 走 split DNS，或公网 `rig.minsight-ai.com` 经跳板机）。仅更换服务访问地址属于配置和路由工作；**浏览器 SSO 还需要实现 Rig 的回调、会话和桌面交接，不能只配 DNS / TLS 就获得免登录**，见 P4 和 §10.2。

### 3.3 连接与登录：登录一次

直接用 `@qpjoy/electron-launcher` SDK 的公开合同（产品网络查询、lease、standalone 数据面），代码全部写在 mx-rig 的桌面端里：

1. **打开桌面端**：经 bootstrap 申请匿名 lease，WireGuard 只路由 Rig 自己的 lease 段和 VIP，**不设系统 DNS / PAC / NRPT**。第一次连接要系统授权：macOS 上装 LaunchDaemon，Windows 上是 UAC。
2. **VIP 通了以后**，Rig 服务已经能访问。登录页只要一个统一账号：
   - 账号密码**经隧道**发给 Rig 服务（`/api/rig/v1/native-login`）。Rig 服务用 Launcher 账号登录，这一步已经实现，见 §2。
   - 业务登录和本地 Runtime 初始化完成后，主进程在后台经 VIP 向 User Center 再换桌面端自己用的 token，用来换用户 lease、申请海外订阅。用户只输入一次密码，但当前代码会验证两次；网络 token 不离开桌面端主进程，也不落盘。
3. **后台换成用户 lease**，用户身份的网络策略和定向发版从这里生效。进入工作台和完成用户网络接管是两个验收点：当前 SDK 默认重新应用 Rig 隧道，可能与首屏请求重叠；待优化项见 §10.3。

本地 Rig 账号保留：应急管理员，以及开发和局域网环境下「直接填服务地址」的模式。

### 3.4 尽量少手动配置

| 在哪 | 怎么做 | 手动？ |
| --- | --- | --- |
| Rig 服务 | `scripts/manage.sh deploy` 在集群里找到 `mx-launcher-internal.mx-internal-shadow:18090`，自动作为 `MX_RIG_LAUNCHER_URL`；网络策略只多放行这一个端口 | 否 |
| Rig 服务 | deploy 结束时打印要登记的网关路由（host = Rig 的 VIP，目标 = Rig 服务的 NodePort 地址） | 复制一次 |
| 桌面端 | 产品标识、bootstrap 地址打进安装包；VIP 和服务地址运行时取 | 否 |
| Launcher 侧登记 | mx-rig 自己带登记清单（`deploy/launcher/`）和 `scripts/manage.sh launcher plan / apply`：先预览，确认后写入。命令写入 ProductNetwork、AppCenter 条目（Release Center 靠它的包名认出 Rig）和两个发版账号，发版凭据直接存进 Secret `mx-rig/mx-rig-release`；VIP 对齐和网关路由没有公开接口，命令打印要填的确切内容 | 一次（运维确认） |

登记清单和命令都在 mx-rig 里，和 Rig 的其他部署放在一起；Launcher 的代码和部署不动。

`launcher plan` 不需要 Ops Token；`launcher apply` 才需要 `MX_LAUNCHER_OPS_TOKEN`。它的值是 **Launcher 已有的 `MX_INTERNAL_OPS_TOKEN`**，Kubernetes 中保存在 `mx-internal-shadow/mx-internal-ops` Secret 的 `token` 键，不是 Rig 的管理员密码，也不需要重新生成或轮换。

可以写入部署节点的 `mx-rig/.env`（已忽略入库，设为 `chmod 600 .env`）：

```bash
MX_LAUNCHER_OPS_TOKEN='<现有 Launcher Ops Token>'
```

`launcher` 和 `release` 命令先读取 `.env`（可用 `MX_RIG_ENV_FILE` 指定文件），再解析地址和凭据。`MX_LAUNCHER_URL`、`MX_LAUNCHER_OPS_TOKEN` 的显式 shell 值优先于文件；显式空 token 也不会被文件补回。Ops Token 不写入 Rig 服务 Secret，也不打入桌面包。

也可以只在当前终端提供，不落到 Rig 配置文件：

```bash
export MX_LAUNCHER_OPS_TOKEN="$(kubectl -n mx-internal-shadow get secret mx-internal-ops -o jsonpath='{.data.token}' | base64 -d)"
bash scripts/manage.sh launcher apply
unset MX_LAUNCHER_OPS_TOKEN
```

这只读取已有凭据；Rig 不自动读取或轮换 Launcher 的 Ops Secret。普通 `deploy` 不要求这个 token，后续 `release` 使用 Rig 自己的 Publisher / Approver 凭据。

## 4. 交付顺序

| 阶段 | 内容 | 前置 | 验收 |
| --- | --- | --- | --- |
| **P1** | 服务端：自动接 Launcher、网络策略、打印路由。桌面端：Launcher 模式（匿名 lease → WireGuard → VIP → 统一账号登录 → 用户 lease）、网络状态和断开 / 卸载、打包带上 WireGuard 引擎 | Launcher Admin 登记 ProductNetwork 和网关路由；一台装着 MX-H2I 的测试机做并存检查 | 测试机上装包 → 授权 → 登录 → 用 Rig；MX-H2I 照常（C1–C12） |
| **P2** | Release Center 自动更新（完整安装包；热更新另议，见 §8）；Windows / macOS 两端的交付 | AppCenter 条目与发版账号（`launcher apply`）；证书（可选） | 装旧版后检查、下载、安装；定向 → 全量 |
| **P3** | 外网：海外订阅 → 本机回环代理 → 测试浏览器的出网通道（见 §9） | 账号有海外订阅权限 | 测试浏览器经通道打开海外站点，系统代理不变 |
| **P4** | 绑域名后的浏览器 SSO（网页端和桌面端） | 域名、Auth 登记 `mx-rig` | 浏览器已登录时一键进入，飞书可用 |

## 5. 不变的边界

- 不改 MX-H2I 和 Luopan 的代码；不复用它们的 VIP、lease 或凭据；不设系统级 DNS / PAC。
- Rig 的任何故障不能进入 Launcher 或 MX-H2I 的登录关键路径。
- Rig 本地账号保留：用于应急管理员和没有 Launcher 的环境。
- Launcher 生产环境里的登记由你或运维完成：要么在 Launcher Admin 里操作，要么由运维带着 ops token 运行 `scripts/manage.sh launcher apply`。除此之外 Rig 不写线上 Launcher；发版只用 Rig 自己的 Publisher / Approver 账号，只能动 `mx-rig` 这个产品。

## 6. 手动验收

现有功能的逐步验收清单单独做成了一个页面：每一步写明怎么做、应该看到什么，可以逐条标「通过 / 有问题 / 跳过」并写反馈。最后一组是 Windows / macOS 交付，其中依赖本方案的步骤标了「等 L1–L4」，按 §4 对应到 P1–P4。

## 7. P1 交付记录（2026-10-16）

**已在 mx-rig 里实现**

- **桌面端 Launcher 模式**（`apps/desktop/launcher-network.mjs`），依赖 `@qpjoy/electron-launcher` 2.3.19：
  - 打开桌面端后先连接自己的产品网络：经 bootstrap 申请匿名 lease，WireGuard 只路由 Rig 自己的 lease 段和 VIP，不设系统 DNS / PAC / NRPT，然后确认 VIP 和 Rig 服务都能访问；
  - 登录页先显示「内网」状态：没有服务地址可填，网络通了才能登录；第一次连接前说明要装什么（系统授权）；连接过一次以后，启动时自动重连；
  - 统一账号登录：账号密码经隧道交给 Rig 服务，业务登录完成后在后台经 VIP 换桌面端自己的 token、切换用户 lease。token 只在内存里；网络凭据用系统钥匙串加密存放；
  - Rig 的本地账号仍可登录，网络保持匿名 lease；
  - 只有真正建立过隧道才会去停它。连接在建立隧道之前就失败了，退出时不碰系统，也就不会弹管理员授权。
  - 没有登记时给出明确提示，告诉管理员该做什么。
- **服务端**：`scripts/manage.sh deploy` 在集群里找到 Launcher Internal，自动设置统一账号登录；网络策略只多放行 Launcher Internal 的 18090 端口；deploy 结束时打印要登记的网关路由。
- **登记**：`deploy/launcher/mx-rig.json` 是登记清单。`scripts/manage.sh launcher plan` 只读，按 Launcher 的公式挑出空闲的 lease 段和 VIP（见下）；`launcher apply` 用 Launcher 的 Internal Ops Token 写入 ProductNetwork 和 AppCenter 条目，并列出只能在 Launcher Admin 里做的两步：在 Domestic 中继上对齐 VIP，以及网关反代路由。
- **打包**：`scripts/manage.sh desktop --launcher` 打出 Launcher 独立端，带上目标平台的 WireGuard 引擎，放在 `Resources/wireguard/<平台>`。其他平台或架构的引擎会自动取一次。
- **仓库自检**：`scripts/check.mjs` 原来禁止桌面端出现任何数据面代码，现在只允许 `launcher-network.mjs` 这一个文件，并且它不能出现别的产品的名字；驱动 MX-H2I runtime、手工改路由仍然在任何地方都禁止。

最初方案曾推算 product index 3；2026-10-17 现场实际登记为 **product index 4、VIP `10.88.100.6`、lease 段 `10.94.0.0/16`**。其他环境仍以 `launcher plan` 读到的数据为准，桌面端继续动态查询，不硬编码这些地址。

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

**真实环境验收**：2026-10-17 用户已确认产品登记、网关发布，以及 Rig 的 `Sync & Apply Service VIP` 成功；桌面端连接、账号登录和用户网络接管仍需按 §10.1 验收。以下保留完整顺序，已完成的服务器步骤不必重复执行：

1. 在 Internal 节点上 `scripts/manage.sh deploy`，确认打印了统一账号登录和网关路由；
2. `scripts/manage.sh launcher plan` 看计划，`MX_LAUNCHER_OPS_TOKEN=… scripts/manage.sh launcher apply` 写入；
3. 按 apply 的实际 VIP 登记网关路由，保存、预览后执行 `Apply Gateway` 并等待网关就绪，再到 Rig 详情执行一次 `Sync & Apply Service VIP`。2026-10-17 的上线约束允许短暂中断，但要求自动恢复：这些动作会更新共享网关、重启共享 Internal service peer，必须验收 MX-H2I 恢复联网及 Rig 的端到端访问；当前没有覆盖所有失败情况的自动回滚，应用报错时先定位失败步骤，不重复点击或把“已触发 rollout”当作就绪；
4. `scripts/manage.sh desktop --launcher` 打包，在测试机上安装；
5. 打开 →「连接内网」→ 系统授权 → 已连接 → 用统一账号登录 → 「内网 · 用户网络」；
6. 同时检查 MX-H2I：登录、已有连接、断开、退出都照常（Launcher 的并存检查 C1–C12）；
7. 退出 MX Rig，隧道随之停止；再打开时自动重连，不再要授权。

**Admin 排障（2026-10-17）**：点击 `Sync Domestic CIDRs` 后如只剩内置应用，先在工作台刷新应用目录。该同步接口只补 Domestic 配置网段，不删除应用；旧版界面的读取失败会清空本地目录，Launcher 的修复与回归见 `mx-launcher/docs/38-neon-void-admin-ui.md`。旧版 `Service VIP materialization` 只按 `mx-rig.mxinfo-inc.cn` 查找路由，新版检查优先识别 standalone 产品自身 VIP 的精确 Host 路由，并兼容原域名路由；embed 应用不会借用宿主 VIP 冒充自己的路由。未发布新版服务端时，`DNS route is missing` 仍可能出现，应到 DNS Routes 核对实际 VIP 的启用路由和 NodePort 上游，不为消除提示重复应用共享网络。

网关应用后，在 Internal 服务器先验证共享网关恢复和 Rig Host 转发（地址以实际登记为准）：

执行 VIP 应用前应先发布 2026-10-17 的 Launcher 安全修复：产品接入的 reconcile 强制保留已有 Domestic/Internal 密钥，材料缺失或生成配置未成功时停止，不继续应用共享运行时。旧版可能在缺失材料时自动生成新密钥，不符合既有连接短暂中断后恢复的要求。正常完整的已有密钥继续复用；这项检查不等于所有运行时错误都有自动回滚。

```bash
kubectl -n mx-internal-shadow rollout status daemonset/mx-internal-gateway --timeout=180s
curl --noproxy '*' --connect-timeout 3 --max-time 8 -i http://192.168.1.2:30891/readyz
curl --noproxy '*' --connect-timeout 3 --max-time 8 -i -H 'Host: 10.88.100.6' http://127.0.0.1/readyz
```

两个 HTTP 请求应返回 `200` 和 `{"status":"ready","store":"postgres"}`。如果 NodePort 正常而 80 端口失败，可用相同 Host 请求 `http://127.0.0.1:8008/readyz` 区分 Caddy 路由和端口 80 归属问题。Rig 客户端建立自身网络后还要验证 `http://10.88.100.6/readyz`；Launcher 的 `VIP:18090/healthz` 和网关 TCP 就绪探针都不能替代这项 Rig 检查。保留 MX-H2I 的既有连接观察其自动恢复，同时确认新登录和内网访问正常。

**Internal nginx 入口**：现场确认 NodePort 与带 Rig Host 的 Caddy 8008 均返回 ready，而同 Host 的 80 返回 nginx 默认 404。此部署有意保留 nginx 占用 80（Launcher docs/50），VIP reconcile 不会把 HTTP 80 重定向到 8008。需要增加单独的 `server_name 10.88.100.6`，转发到 `127.0.0.1:8008` 并保留 Host。样例为 `deploy/nginx-vip.conf.example`，包含 WebSocket 转发和 SSE 禁用缓冲；其它集群须先替换为实际分配的 VIP。不要停止 nginx 或切换全局 Gateway 后端来修复这一条路由。

安装到现有 nginx `http` include 的独立文件（本机惯例 `/etc/nginx/conf.d/mx-rig-vip.conf`）前，先运行 `nginx -t`，检查是否已有相同 `server_name`；已有文件先备份。安装后再次运行 `nginx -t`，出现同名 Host 冲突警告时也应恢复备份、停止发布。用 `nginx -T` 在服务器本地确认新文件被 include 后执行 `systemctl reload nginx`，再用上述 Host `/readyz` 检查 80 返回 ready；完整配置含身份网关凭据，不贴到聊天或日志。测试或 reload 失败时恢复原文件；首次新增则移走新文件，再验证原配置。2026-10-17 用户确认该步成功；本机没有安装 nginx，未代替现场执行验收。

若 reload 后 Launcher 管理页显示账号服务不可用，先点击「重试连接」或强制刷新；排查的是 `/auth/admin/session`，不是公网被有意拒绝的 `/internal/v1/user-center/roles`。现场该 session 返回 200、`enabled:true`、`accessMode:"sso-only"`，用户刷新后恢复。无需因此回滚 Rig 路由或更换 Token，详细判断见 `mx-launcher/docs/41-public-identity-and-certificates.md`。恢复管理入口不等于 Rig VIP 已应用；该次排障时用户尚未执行 Rig 的 `Sync & Apply Service VIP`。

## 8. P2 交付记录（2026-10-16）：Release Center 自动更新

**决定**

- **只发完整安装包**（macOS DMG、Windows NSIS），桌面端只检查 `app-installer`，不检查 `app-asar`。热更新（只换 app.asar）要求已安装的版本经 ASAR bootstrap 启动，还要能从新 asar 找到安装包里的 `node_modules`。Rig 的主进程是未打包的 ESM，Playwright 必须留在真实文件系统上，现有 bootstrap 做不到这一点。贸然接入的话，下载下来的 .asar 永远加载不了。所以先不检查，误发的 ASAR 计划也不会被下载。
- **更新和网络互不干扰**：检查、下载都不重连、不改路由；Release Center 的地址每次从 Rig 自己的产品网络读（`http://<Rig 的 VIP>:18090`），网络没有 ready 就不检查，也绝不用别的产品的 VIP。
- **只有 Launcher 模式的安装包能发布**：非 Launcher 模式的包要是经更新装到用户机器上，会把他们的产品网络拿掉。打包时只给 `--launcher` 的安装包写发布清单，发布命令没有清单就拒绝。
- **先定向，再全量**：新版本先发给指定的安装 ID 或用户；手动验证后，由另一个账号（Approver）批准；定向更新走通后再推给所有人。发布命令只提供这一种顺序。

**已在 mx-rig 里实现**

- **桌面端**（`apps/desktop/launcher-updates.mjs`）：用 `@qpjoy/electron-launcher` 的应用更新控制器（L3）。Rig 只提供自己的部分：
  - 按包名 `@qpjoy/mx-rig` 解析发布身份，渠道 `stable`；
  - 连上内网后自动检查一次，同一个网络、账号、版本不重复检查；
  - 下载经过大小和 SHA-256 校验，存在 userData 下；
  - 点「关闭并安装」才打开安装程序，然后停掉 Rig 自己的 Runtime、执行机、工位和隧道（和退出时一样），再退出。
  - 页面只收到状态投影：阶段、固定的中文文案、版本、更新说明、进度、可用的按钮，以及手动检查时显示的安装 ID。URL、本机路径、原始错误只留在主进程日志里。
  - 网络或账号在检查之后变了，必须重新检查。
  - 从源码运行是 development，`--dir` 包是 portable，这两种都不自动更新。`MX_RIG_UPDATE_DISTRIBUTION=installed` 是从源码测试更新用的入口，打包后无效。
- **界面**：
  - 登录页「内网」面板里显示版本和「检查更新」，旧到登录不了的客户端也能更新；
  - 工作台顶栏显示版本，有新版本时变成「新版本 x.y.z」；
  - 右下角的更新卡片会在有可做的事时自己出现：下载、进度（总大小未知时显示不定进度）、取消、关闭并安装、更新说明。
- **登记**（`launcher apply`）：
  - AppCenter 条目带上 `channels: ["stable"]`；
  - 第一次写入条目时 Launcher 签发的 Publisher 凭据，和单独创建的 Approver 账号（只能读和批准，只限 `mx-rig`），都直接写进一个 0600 的临时文件，再合并进 Secret `mx-rig/mx-rig-release`，然后删掉文件，任何地方都不打印；
  - 集群里已有的不再动。已经签发过、但集群里没有保存的，才轮换一次。不知道集群里存了什么时（不经 manage.sh 直接运行），一律不轮换；
  - `plan` 多两项：Release Center 能否按包名解析到 `mx-rig`，以及发版凭据是否已在集群里。
- **打包**：
  - 安装包改名为 `MX-Rig-<版本>-<mac|win>-<架构>.<dmg|exe>`（Release Center 要求 ASCII 文件名）；
  - `--launcher` 的安装包旁边生成 `<安装包>.json` 发布清单，含版本、平台、架构、大小和 SHA-256；
  - defaults 写入 `distribution`。
- **发布**（`scripts/manage.sh release`，在 Internal 节点上运行，凭据经环境变量从 Secret 交给命令，不经命令行参数）：

  ```text
  release publish <安装包> --install-id <ID> [--user-id <ID>] [--notes <文件>] [--from <旧版本>]
      上传（发布前核对清单与文件一致）并建定向计划；gate 处于 blocked，谁都还收不到
  release approve <plan> --smoke passed      在测试机上亲手装过、打开过之后，用 Approver 批准
  release promote <plan>                     定向更新走通后，同一个制品建全量计划（又是 blocked）
  release approve <全量 plan> --smoke passed  批准全量；证据里引用定向计划
  release reject <plan> | release status
  ```

  安装 ID 在桌面端点「检查更新」后显示。同样的请求重复执行，得到的是同一个计划；`releaseId` 和 `requestId` 由文件摘要、受众和更新说明决定。

**验证**

- `tests/launcher-updates.test.mjs`（7 项）：真实的 SDK 控制器，对着替身 Release Center：
  - 连上后按包名检查一次，只问 `app-installer`；同一网络不重复检查，换账号重新检查；
  - 下载、校验、安装：安装程序只打开一次，路径在 userData 下，然后清理、`exit(0)`；页面收到的所有状态里没有 URL、路径或替身地址；
  - 没联网时不访问 Release Center，development 发行形态直接 unsupported；
  - 检查后换账号，下载被拒绝，要求重新检查；重连中不安装，也不清理、不退出；
  - Release Center 返回别的包名的身份时拒绝，文案里不带对方的名字；
  - 投影：总大小未知时不显示 0%，原始错误不外泄；
  - 产品网络只在 ready 时、只在自己的 VIP 上给出 Release Center 地址。
- `tests/release-publish.test.mjs`（3 项）：
  - 发布清单：没有清单、不是 Launcher 模式、文件被改过、扩展名和平台不符、文件名有空格，都拒绝；
  - 完整流程：不指定受众不发布；凭据不能放在参数里；上传参数和字节正确；同样的请求得到同一个 requestId；未批准不能推全量；批准要 `--smoke passed`，由 Approver 账号执行；全量计划复用制品，证据里引用定向计划；输出里没有密钥。
- `tests/launcher-register.test.mjs` 新增：
  - Release Center 身份和凭据的计划状态；
  - `apply` 没有 `--secret-out` 就拒绝；两份凭据写进 0600 文件，且不打印；
  - 已签发、未保存时轮换；两份都已保存时不动；直接运行时不轮换。
- `tests/manage-release.test.mjs`：用假的 kubectl 跑 `manage.sh launcher apply` 和 `release status`：
  - 凭据进了 Secret `mx-rig-release`，临时文件已删除；
  - 输出和 kubectl 参数里没有密钥；
  - 再执行一次时不签发也不轮换；
  - `release` 从 Secret 取凭据，交给命令。
- `npm run test:desktop`：Launcher 模式的登录页显示版本；未连接时点「检查更新」，卡片显示「连上内网后才能检查更新」和安装 ID，没有下载或安装按钮，卡片可以收起。
- 顺带修了 `tests/build-proxy.test.mjs`：`npm test` 把临时文件放在本仓库里（`"type": "module"`），Node 22.21 会把没有扩展名的假工具当 ES 模块加载，导致 9 项失败。和本次改动无关；在假工具的目录里放一个 `{"type":"commonjs"}` 就好了。

**还没有验证的**：

- 真实 Release Center 上的完整一轮（检查 → 下载 → 打开安装程序 → 新版本首次启动时上报 `installer-completed`）。要先完成 P1 的登记，再：
  1. 把 `package.json` 的版本改高，`scripts/manage.sh desktop --launcher` 打出新包；
  2. 把安装包和 `.json` 一起拷到 Internal 节点，`scripts/manage.sh release publish … --install-id <测试机的安装 ID>`；
  3. 在测试机上手动装一遍新包确认能用，然后 `release approve`；
  4. 测试机装回旧版本，点「检查更新」→ 下载 → 关闭并安装。macOS 会打开安装盘，把 MX Rig 拖进「应用程序」替换；Windows 会运行安装程序；
  5. 新版本打开、连上内网后，`release status` 里能看到上报；然后 `release promote`、`release approve`；
  6. 同时确认 MX-H2I 不受影响。
- macOS 的 Developer ID 签名、公证，以及 Windows 的 Authenticode 签名：现在仍是 ad-hoc 签名（macOS 第一次打开要确认一次）。经更新下载的安装包是 Rig 主进程自己写的文件，按理不带隔离标记，替换后不用再确认一次；这一点还要在真机上确认。

## 9. P3 交付记录（2026-10-17）：外网通道

**做了什么**：在「出网与通道」页面开启后，用平台统一账号的海外订阅，在这台电脑的回环地址上跑一个海外代理；选择「让这台电脑上的测试浏览器走海外通道」后，Agent 的测试浏览器（以及这台电脑上的试验规程回放）经它出网。系统代理、DNS、路由都不动，MX-H2I 和其他应用感觉不到。

**决定**

- **和罗盘同一条链路，用平台已有的部件**：
  - 订阅由 `@qpjoy/electron-launcher` 的 `ensureElectronLauncherUserOverseaSubscription` 申请，请求只经 Rig 自己的 VIP 发给 Launcher Internal；
  - 配置由平台的 `@qpjoy/electron-core-mihomo` 编译；
  - 代理引擎用 Launcher 发布的 `@qpjoy/electron-plugin-tunnel-engine-<平台>` 里的 Mihomo。不引入 `electron-plugin-tunnel` 本体：它依赖原生模块 better-sqlite3，Rig 用不到那部分。
- **只留一个回环端口**：
  - 端口每次随机挑空闲的，不用订阅里写的 7788。7788 正是这类本地代理的常用端口，这台开发机上就有一个；
  - 编译后删掉 DNS 监听、外部控制器和 secret；不开局域网，不开虚拟网卡（TUN）；
  - 配置里一旦出现 TUN 或局域网就拒绝启动。用真实的 Mihomo 实测过：进程只在 `127.0.0.1:<端口>` 上监听。
- **不用 geo 规则**：订阅里的 `GEOSITE/GEOIP,CN` 会让 Mihomo 启动前先从 GitHub 下载 GeoIP / GeoSite 两个数据文件。在这台机器上实测花了 83 秒，测试机上可能直接失败；打包带上又要多约 21 MB。所以用平台编译器的 app-global 模式，关掉 geo 规则：内网地址、Internal 预留网段和常见国内站点（编译器自带的列表）直连，其余都经海外出去。
- **由人选择、跟着账号走**：
  - 开启和「测试浏览器走海外」都要人去点，这两个选择存在本机；
  - 海外权限属于统一账号：退出登录或断开内网时通道停止，再次以统一账号连上时自动重开；
  - Rig 本地账号、访客账号都用不了。登录时多申请了 `oversea.subscription.ensure` 这个 scope；Launcher 会和账号实际拥有的 scope 取交集，访客照样能登录。
- **和服务端通道用同一个入口**：桌面端把这个本机通道叠加到 Runtime 每一步都会重读的策略上，策略版本号随之改变。所以切换后测试浏览器在下一步重开，进行中的确认要重新发起，和 docs/09 的切换语义一致。服务端不知道这个本机通道，也不需要知道。
- **订阅里有每个用户自己的密码**：只在通道运行时以 0600 写在 userData 下，停止时删除；页面和日志里都不出现密码、token、端口或订阅内容。App 崩溃后遗留的代理进程，下次启动时只有确认进程名是 mihomo 才会结束它。

**实现**

- 桌面端：
  - [launcher-oversea.mjs](../apps/desktop/launcher-oversea.mjs)：申请订阅（遇到「同步中」最多试 4 次）、编译配置、启动、等端口、经代理访问 `https://www.gstatic.com/generate_204` 验证（这个地址国外能通、国内不通，和平台自己的健康检查一样）、停止、清理遗留进程；
  - [mihomo-engine.mjs](../apps/desktop/mihomo-engine.mjs)：找到引擎并按摘要解压一次。
- Runtime：[local-egress.mjs](../packages/runtime/local-egress.mjs) 只接受回环地址上的 HTTP 代理；worker 新增 `local-egress` 消息，初始化时也会带上。
- 网络：`overseaSession()` 只在内网 ready、登录的是统一账号时，交出 VIP、用户 ID 和 token，并且只给主进程。
- 界面：「出网与通道」页面多了一张「本机海外通道（Launcher 订阅）」卡片，只在 Launcher 模式的桌面端出现；测试浏览器走海外时，顶栏显示「内网 · 用户网络 · 海外」。
- 打包：`--launcher` 的安装包带上目标平台的 Mihomo 引擎，放在 `Resources/mihomo/<平台>-<架构>`；引擎包本身不打进 app.asar。
- 仓库自检：桌面端和 Runtime 里出现设置系统代理的命令（networksetup、scutil --proxy、netsh winhttp、注册表 Internet Settings 等）就报错。

**验证**

- `tests/launcher-oversea.test.mjs`（10 项）：
  - 用真实的平台编译器编译：只剩回环端口；没有 geo 规则、DNS 监听和控制器；预留网段直连；配置里不再有写着账号邮箱的注释；编译出 TUN 时拒绝；
  - 开启：经 VIP 申请；「同步中」会等待；配置文件是 0600；选择后测试浏览器才用它；页面收到的内容里没有密码、token、端口或 YAML；关闭时进程结束、配置删除、选择被记住；
  - 跟着账号：退出登录就停，换回统一账号连上后自动重开；从没开启过的不会启动；没有统一账号时只等待，不发申请；
  - 失败时的说明：没有权限、没有线路、一直在同步、试访问失败、进程意外退出（测试浏览器随之不再走它）；
  - 遗留进程只在确认是 mihomo 时才结束；
  - 经 CONNECT 代理的试访问：拒绝、502、完整的 TLS 204 都覆盖；
  - Runtime 只接受回环代理；策略版本号随之改变；浏览器会重开；只有 execution-config 被改写；
  - 引擎按摘要解压一次，旧版本删除；
  - **用真实的 Mihomo**：编译出的配置能启动；经代理访问本机页面成功；用 lsof 看只监听在 `127.0.0.1:<端口>`；停止后端口关闭。
- `tests/launcher-network.test.mjs`：登录申请的 scope 包含 `oversea.subscription.ensure`；登录后 `overseaSession()` 交出 VIP 地址，退出后返回 null。
- `npm run test:desktop`：Launcher 模式下，没有统一账号时开启海外通道，状态是「等待」并记住开启，关闭后恢复。这一路经过真实 Electron 主进程的 IPC。
- `npm run test:browser`：用页面自己的样式画出卡片的三种状态（等待、就绪并选中、没有权限），核对按钮和动作。截图在 `.runtime/qa/web-oversea-panel.png`。

**还没有验证的**：真实的海外订阅和 Hysteria2 线路。要在 P1 登记完成后，用一个开通了海外权限的统一账号：

1. 登录 → 「出网与通道」→「开启海外通道」，等到「已就绪（试访问 … ms）」。
2. 勾选「让这台电脑上的测试浏览器走海外通道」。
3. 在一个允许访问海外站点的任务里，让 Agent 打开这个站点，能打开。
4. 同时确认系统代理设置没变，MX-H2I 的连接照常。
5. 退出登录时通道停止，进程和配置文件都不在了。

Hysteria2 走 UDP 51288 端口。网络拦截 UDP 时，试访问会失败，卡片上会写明。

## 10. VIP 应用成功后的验收与登录选择（2026-10-17）

### 10.1 先验收现有桌面端，不等待域名 SSO

当前起点：用户已确认 Launcher Admin 的 `Sync & Apply Service VIP` 成功。这证明该管理动作成功，还不能代替客户端建立隧道、登录和实际执行的验收。

在开发 Mac 上运行当前源码，连接已部署的 Rig 服务：

```bash
cd /Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-rig
# 首次运行或依赖发生变化时先执行 npm install；需要 Node.js 22 或更高版本。
env -u ELECTRON_RUN_AS_NODE -u MX_RIG_SERVER_URL \
  MX_RIG_LAUNCHER=1 npm run desktop
```

这里用环境变量开启 Launcher 模式，服务地址由自己的 ProductNetwork 决定。不使用 `manage.sh local desktop`，因为它会启动本地服务并指向本机；`npm run desktop -- --launcher` 也不是源码运行的模式开关。源码验收不覆盖安装包更新。

按顺序记录结果；一步失败时先定位该步：

| 步骤 | 操作 | 通过标准 |
| --- | --- | --- |
| 1. 产品内网 | 点「连接内网」，首次完成系统授权 | 状态已连接，Rig 服务可达；不只是 Launcher healthz 成功 |
| 2. Rig 服务 | 在同一台已连接的 Mac 运行下方 readyz 检查 | HTTP 200，返回 PostgreSQL ready |
| 3. 统一账号 | 用 Launcher 的普通统一账号密码登录 | 进入工作台、显示正确成员；随后网络显示「内网 · 用户网络」。只进入工作台但仍是匿名网络，不能算网络接管通过 |
| 4. Rig 权限 | 检查当前角色及项目权限 | 首次统一账号默认 viewer。由 Rig 管理员在「管理 → 账号与成员」配置角色；执行还需项目执行权限。Launcher 管理员身份不会自动变成 Rig 管理员 |
| 5. 实际执行 | 使用 Rig 管理员走「新项目：从用例到测试代码」新手关卡，选择内置试验场、准备本机测试仓库和执行机，再亲手点击最后的执行按钮 | 看见真实执行从排队进入运行、形成最终结果，并能打开步骤和报告制品。计划建好或任务派发成功不等于测试通过；该关卡使用预置实现，不要求先配置模型，详见 [docs/24 §8](24-guided-tours.md#8-m8b-交付记录2026-10-08) |
| 6. 并存与恢复 | Rig 连接、登录、退出时观察原有 MX-H2I；再打开 Rig | MX-H2I 登录和网络正常；Rig 再打开可自动重连。当前不保存用户登录 token，自动重连不等于免登录 |
| 7. 可选海外能力 | 用有海外权限的账号按 §9 开启测试浏览器通道 | 测试浏览器可访问目标，系统代理及 MX-H2I 状态正常 |

步骤 2 在客户端隧道已连好后执行；当前现场 VIP 是 `10.88.100.6`：

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 8 -i http://10.88.100.6/readyz
```

预期正文 `{"status":"ready","store":"postgres"}`。客户端尚未连接时访问该私网 VIP 失败，不能据此认定服务端部署失败。

Mac 源码验证通过后，分别验收 macOS 的 DMG 和 Windows x64 的 NSIS 安装包，再做 §8 的旧版到新版定向更新。`scripts/manage.sh desktop --launcher --mac --arm64`、`--mac --x64`、`--win --x64` 对应各目标；安装、系统授权、重开和更新必须在对应平台实测，不能由源码冒烟代替。

### 10.2 `rig.minsight-ai.com` 的作用

**当前不需要先部署这个域名**：现有桌面端通过自己的 VIP 访问 Rig，支持统一账号密码登录。后续若接浏览器 SSO，建议用稳定 HTTPS 域名 `rig.minsight-ai.com` 作为 Rig 的入口和回调地址；统一身份提供方仍是 `auth.minsight-ai.com`，不是再建一套账号中心。

P4 需要一整条接入链路：

1. 配置域名、TLS 和反代，明确哪些入口需要公开可达；不因为接 SSO 就默认公开所有测试管理接口。
2. 在 Launcher Internal 的统一认证接入应用中登记独立的 `mx-rig` 客户端及准确回调 `https://rig.minsight-ai.com/auth/sso/callback`。
3. Rig 后端接入平台已有的 `@qpjoy/mx-common/identity/sso`，实现登录、回调、持久会话和退出，并接入 Rig 现有业务授权。以已验证的身份映射既有成员，保留项目权限；不能靠同名或同邮箱自动合并账号。
4. 桌面端通过系统默认浏览器登录，再用绑定本次请求的一次性交接凭据完成桌面会话；不能把长期 bearer token 放进 URL。还要衔接用户 lease 和海外订阅的授权，浏览器会话本身不能直接替代当前网络 token。

已有浏览器统一认证会话时，SSO 可以省掉重复输入密码；仍受身份平台的重新认证、授权等策略约束。只在 Launcher Admin 输入过 **Internal Ops Token**，不等于拥有个人账号的浏览器 SSO 会话。桌面端使用系统浏览器才能复用该浏览器的登录状态，Rig 的隔离测试浏览器不应借用个人登录 cookie。参见 [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)。

SSO 不会自动缩短匿名入网、用户 lease 切换、peer 同步或 WireGuard 应用的耗时。它主要改善跨应用认证体验，不能据此承诺首次启动更快。

### 10.3 现有登录可优化的部分（待实施）

当前顺序已按代码核对：匿名组网 → Rig `native-login`（服务端向 Launcher 换 token 并内省）→ 主进程 `/me` 与 Runtime 初始化 → 显示工作台；与此同时，主进程在后台再次用密码换网络 token、申请用户 lease 并重新应用 Rig 隧道。参考 [main.mjs](../apps/desktop/main.mjs)、[launcher-network.mjs](../apps/desktop/launcher-network.mjs)、[identity](../packages/test-platform/server/identity/index.mjs)。

优先处理以下几点，先采集阶段耗时，再对比改动前后结果：

1. **避免网络切换干扰首屏。** 当前 SDK 默认 `action: restart`，Rig 用户网络接管会与工作台首屏 API 请求重叠。需要协调接管和依赖网络的请求，并研究同一 Rig owner 下的安全配置更新；不能直接省掉用户 lease 或借用 MX-H2I 的隧道。
2. **缩短无响应的等待。** 为产品查询、enrollment、snapshot 等请求设置明确期限和取消能力；当前共用串行队列，一项悬挂会拖住后续连接或断开操作。避免把普通业务请求的 90 秒默认超时直接当作登录体验预算。
3. **减少首屏串行加载。** config / graph / tools 已并行，但 missions、tasks、系统信息仍依次等待后才 render。可并行互不依赖的请求，把非首屏必需信息延后；参考 [app.js](../apps/web/app.js)。
4. **减少重复密码校验。** Rig 业务登录与网络登录目前各验证一次。改为受控凭据交换或一次性桌面交接前，要明确 audience、scope、有效期和退出语义；不能直接混用业务 token、网络 token 或运维凭据。

用户网络切换已经在后台，服务端 token 内省也已有缓存和并发合并，不能把它们当作尚未实现的优化。上述性能工作应先在 Rig 范围内完成；新增 SSO 接入独立验收，保留 MX-H2I 当前的登录与联网行为。
