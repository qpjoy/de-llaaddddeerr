# MX-H2I Electron Demo

## MinCave 客户端界面

默认启动 React/TypeScript 的 MinCave 浅色界面。未登录页只提供现有飞书 OAuth 登录；账号密码和匿名底层能力保留在旧界面兼容路径。保留网络修复与取消、AppCenter/H2O 和 Release Center 更新流程；不迁入演示员工选择、今日／月度流量、演示通知、城市网关切换或未实现应用卡片。工作台提供 Delta、Night-All、Hub、Compass、Compass管理后台、Argus 六个真实网页入口；连接就绪后通过既有 HTTP(S) 外部打开逻辑进入系统浏览器，地址维护于 `ui/src/workplaceApps.ts`。顶部提供员工工作台和客户端内管理控制台；管理端使用共享用户中心的 MinCave 专属角色及独立 Bearer 接口，本轮只开放成员与角色管理；员工侧栏仅保留工作台与设备。应用按中台应用（Delta、Hub、Night-All）、产品应用（Compass、Argus）、管理后台（Compass管理后台）、员工福利（海外代理）分类。海外代理为 H2O 工作台卡片显示名，工作台不显示 AppCenter。点击“安装”后在同一次操作中自动准备 AppCenter 依赖，再安装 H2O，界面统一显示“安装中”；已存在的依赖跳过，失败可从同一卡片重试，不自动启动代理。安装完成后卡片仅打开“海外订阅”弹窗，展示经核验的当前账号 Clash 链接及复制操作，不再展示 H2O 模式、规则、端口、节点、日志或流量管理页。新界面移除原型中没有的额外说明、登录通知、恢复步骤面板、技术提示和全局反馈条；真实状态与操作仍由原命令处理器驱动。

在本 demo 目录安装独立 UI 构建依赖（Node.js 22.18+）：

```sh
npm --prefix ui ci
pnpm build:ui
pnpm check:ui
```

随后按下文方式启动 Electron。`dev`、`check`、完整包与 ASAR 的构建链会先生成 `src/renderer-dist`；React 运行依赖包含在静态产物中，不要求旧安装基座额外提供 React。UI 使用独立的 `ui/package-lock.json`，工作区其余依赖仍按现有 pnpm 流程安装。

界面默认约 1120 × 760，可调整大小，单独保存宽版窗口尺寸。宽版不启用旧窄窗口的顶部吸附。需要使用旧界面排查时，在启动进程前设置 `MX_H2I_UI=legacy`；macOS 示例：

```sh
MX_H2I_UI=legacy pnpm dev
```

此开关保留旧渲染入口与窗口策略，不重置客户端身份、租约或配置。原型的独立退出功能不迁入，仍按现有“断开连接成功后结束本次客户端认证”的语义执行。

macOS 安装包使用 `build/icon.icns`，Windows 使用 `build/icon.ico`，分别复制自用户指定的 `MinCave-ui/MinCave-desktop-icons/MinCave.icns` 和 `MinCave.ico`。窗口／Dock 使用同套图标资源，macOS 菜单栏保留适配系统的 template 图标。

`pnpm check:ui` 包含状态、竞态、窗口策略和实际构建产物的 DOM 交互测试。可在允许自动启动浏览器的环境运行 `pnpm test:ui:browser`，使用隔离的测试数据验证布局并保存截图到 `out/ui-qa`；不会连接真实飞书或改变系统网络。

MX-H2I is the new H-side VPN product shell. It runs as a Launcher standalone
Electron app and owns one local network, auth, update, and permission channel.
The Launcher foundation itself is modeled as a reusable plugin/socket layer:
MX-H2I is the active standalone owner, while Luopan is reserved as a future
peer standalone owner that can consume the same foundation capabilities.
AppCenter and H2O are shown as Launcher embed apps with
`networkScope: broker-session`: they reuse the selected standalone broker
channel instead of receiving separate WireGuard peer lease IPs.

## Run

From `electron-dock/mx-launcher`:

```sh
pnpm --filter @qpjoy/mx-h2i-demo dev
```

本地连接验收时，先正常退出已安装的 MX-H2I，避免多个客户端同时占用默认本地代理端口 `127.0.0.1:2053`。独立验收配置不得放在桌面、文稿或下载等受 macOS 隐私保护的目录；否则系统提权脚本可能无法读取 WireGuard 配置。常规启动沿用 Electron 默认 userData；本次临时验收包使用独立私有临时目录，不修改产品网络实现。

## Test AppCenter And H2O

1. Start MX-H2I:

   ```sh
   pnpm --filter @qpjoy/mx-h2i-demo dev
   ```

2. Connect as guest or employee. The standalone channel must be connected
   before AppCenter can install embed apps.

3. Click `AppCenter -> Install/Enter`. AppCenter opens as a user-facing
   desktop app center: browse recommended apps, search by app name, select H2O,
   then install or open it. Operational details stay hidden by default.
   Installing AppCenter and running `Check Updates` both try to sync
   `/internal/v1/app-center/apps` from Internal; sync success or failure is
   written to the AppCenter debug log.

4. Click `Debug` in AppCenter only when developing or troubleshooting. The
   debug drawer shows `packageName`, `installedVersion`, `latestVersion`,
   `networkScope`, permissions, entrypoints, local install path, and recent
   install/runtime logs. Normal users only see install/open status and any
   visible error message.

5. Install H2O from AppCenter. H2O means **Home To Oversea**: it is the
   built-in AppCenter network plugin direction, similar to a Clash-style user
   surface, but it inherits network/user/permission state from MX-H2I instead
   of owning WireGuard itself. In development MX-H2I resolves
   `entrypoints.dev: workspace:demos/mx-app-h2o`, reads the local H2O package
   version, and records the install cache on `runtime.apps.h2o`. Built-in
   AppCenter records use `builtin://appcenter` and `builtin://h2o`; the packaged
   H2O runtime is activated directly and never requires Node.js/npm on the end
   user's machine. Future registry/tarball records are installed into the
   AppCenter cache directory under Electron `userData`.

6. Start the H2O embed app demo:

   ```sh
   pnpm --filter @qpjoy/electron-launcher-app-h2o dev
   ```

   The package is `@qpjoy/electron-launcher-app-h2o` and uses
   `launcherMode: embed`, `standaloneChannelProductId: mx-h2i`, and
   `networkScope: broker-session`. Its `runtimeContractVersion` is `0.1`, and
   it never creates an independent WireGuard peer.

7. H2O defaults to a user-facing Home To Oversea UI. Click `Debug` inside H2O
   to inspect broker session, socket path, package metadata, local IP,
   capability bridge, contract version, and inherited MX-H2I channel state.

8. To test the denied embed path, run H2O with the dev broker disabled:

   ```sh
   MX_H2O_BROKER_MODE=off pnpm --filter @qpjoy/electron-launcher-app-h2o dev
   ```

For production, Internal admin should register the same AppCenter app record
with `packageName: @qpjoy/electron-launcher-app-h2o`, the latest release
version, access policy, permissions, and entrypoints. The built-in H2O record
activates the runtime shipped with MX-H2I and opens it through the broker
session. A separately released registry/tarball app must be delivered by the
trusted Release Center artifact flow; the desktop client must not assume that
Node.js/npm exists on an end user's machine.

`pnpm dev` follows the V1 HDO local-development flow: it prepares the local
Launcher workspace packages before starting Electron. This keeps
`@qpjoy/electron-launcher` usable from the workspace without publishing it to
npm first.

## Package

```sh
pnpm --filter @qpjoy/mx-h2i-demo build
pnpm --filter @qpjoy/mx-h2i-demo package
pnpm --filter @qpjoy/mx-h2i-demo make
```

The package and make scripts run the same local Launcher preparation step
before invoking electron-builder, so clean Windows workspaces do not start with
an empty `@qpjoy/electron-launcher/dist`.

For a code-only ASAR update, run from this demo directory:

```sh
pnpm make:asar
# Windows shortcut: package.json version, win32 / x64:
pnpm make:asar:win
# Existing positional version/architecture override remains supported:
pnpm make:asar:win 2.1.20 arm64
# Optional explicit target (also supports --arch arm64 or x64):
pnpm make:asar --platform darwin --arch universal --version 2.1.20
```

The default target is the current OS (`darwin` or `win32`), with `universal`
for macOS and `x64` for Windows, matching the platform-specific shortcuts.
The version defaults to this demo's `package.json`; explicit flags override
these defaults. The command runs the checks and writes the `.asar` and its
`.asar.json` manifest to `out/release-asar/`. It does not publish a release.
Native dependencies are inherited from the compatible full installer.
The Windows shortcut delegates to the same preparation, check, and build
pipeline; its version argument is optional.

Windows packaging uses electron-builder's PowerShell-backed pnpm dependency
collector. `make:win` automatically prepends the inbox Windows PowerShell 5.1
directory to `PATH` and fails early with a focused message if
`powershell.exe` is actually unavailable. The expected executable is
`%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`.

Bootstrap resolution can be selected with `MX_H2I_BOOTSTRAP_RESOLVE_MODE`:
`env-first`, `dns-first`, `env-only`, or `dns-only`. Use the V2 bootstrap host
`https://h2i.minsight-ai.com`. The filed public suffix is intentionally not
added to MX-H2I split DNS; `mxinfo-inc.cn` remains there for existing Internal
names. The current Domestic public host is `116.62.51.154`; older
`121.43.253.179` / `121.43.254.179` runtime settings are treated as stale
defaults. The bootstrap phase may use
`MX_H2I_HOST_RESOLVE=h2i.minsight-ai.com=116.62.51.154`
to bypass public DNS and system-proxy selection; the client also auto-adds
`https://116.62.51.154` as a transport candidate when the Domestic relay host
is unchanged. For direct-IP HTTPS bootstrap, the connection still uses
`h2i.minsight-ai.com` as TLS SNI and HTTP `Host`; certificate verification is
never disabled. Packaged and production builds do not retain a bare public IP
as the canonical bootstrap URL: the IP is only a dial target for the named
HTTPS origin.
`X-MX-Original-Host` / `X-MX-Bootstrap-Host` also carry the original authority.
Use
`MX_H2I_BOOTSTRAP_DNS_SERVERS=223.5.5.5,119.29.29.29`
to resolve the bootstrap domain through an explicit resolver before dialing the
resolved IP with the original Host header. `MX_H2I_BOOTSTRAP_DNS_SERVERS` must
point at a DNS resolver, not merely at the A record returned for the bootstrap
host. If the Domestic public host is used as the direct bootstrap endpoint,
prefer Host Resolve/env mode and leave `MX_H2I_BOOTSTRAP_DNS_SERVERS` empty
unless that host also serves DNS on port 53. The connected WireGuard phase
still relies on the launcher route plan and split DNS.

`MX_H2I_DNS_DIAGNOSTIC_HOST` is only a candidate. Once an employee or guest
tunnel is retained, an out-of-namespace public host is ignored for split-DNS
readiness and MX-H2I selects a covered exact Internal child instead. On macOS
this lets the `127.0.0.1:2053` supplemental resolver outrank a V1 parent and
Clash TUN `any:53` hijack without changing unmatched public traffic.

Passwords, MX bearer tokens, and lease capabilities are accepted only over a
normally validated HTTPS endpoint, loopback HTTP, or the exact Internal HTTP
origin of an already live and re-probed WireGuard overlay. The legacy public
`http://*:18090` listener is diagnostic/migration-only. Existing persisted
`http://h2i.mxinfo-inc.cn:18090` and `http://api.mxinfo-inc.cn:18090` defaults
and the exact former `https://h2i.mxinfo-inc.cn` default are migrated to
`https://h2i.minsight-ai.com`. A custom path, non-default port, or custom
Host Resolve target on the old hostname is preserved. Deploy the new Domestic
TLS vhost before shipping this launcher build.
That vhost must enforce the generated method-and-path bootstrap allowlist:
health, Feishu safe config/token exchange, product lookup, enrollment/snapshot,
and capability-protected lease operations only. Never proxy all of
`/internal/*`, `/api/*`, or `/h2i/*`; doing so would expose Internal management
surfaces such as Config Center and Admin through the public login hostname.
The 443 owner must also overwrite untrusted inbound `X-Forwarded-For` with the
socket client IP; the one-hop Internal trust-proxy setting assumes that value
has already been cleaned at the public edge.

When `dns-first` is selected, MX-H2I retries the bootstrap DNS resolver three
times. If DNS still fails, the connection warns the user and temporarily falls
back to Host Resolve/env mode when configured, then to the system default
network path, so the launcher can continue toward the HDI/WireGuard phase.
On Windows, a user-initiated connect also attempts a privileged pre-bootstrap
recovery when a retained MX-H2I lease and WireGuard config are present. If that
local tunnel is restored, bootstrap is refreshed through the retained Internal
overlay first, which avoids depending on public DNS, ICP-sensitive domain
routing, or Clash/mihomo TUN during reboot recovery. Set
`MX_H2I_PREBOOTSTRAP_PRIVILEGED_RECOVERY=0` only when testing the public
bootstrap path in isolation.
The system path is intended to coexist with Clash/mihomo system proxy and TUN
mode. Fake-IP or proxy TUN routes are not treated as H2I proof; the connected
phase still requires the MX-H2I WireGuard route and Internal healthz.
In `env-first` mode the pinned endpoint avoids Clash DNS and proxy selection,
but a third-party TUN can still intercept or block the resulting IP route.
The current macOS endpoint-route repair owns only stale MX-H2I routes, and the
Windows/macOS physical endpoint bypass is owned by the installed WireGuard
service. There is no safe demo-local ownership lifecycle for installing a
privileged host route before the first WireGuard service exists, so MX-H2I
does not leave an unowned `/32` route behind. For a first-ever login under a
blocking TUN policy, configure Clash/mihomo `DIRECT` rules for
`h2i.minsight-ai.com` and `116.62.51.154`, or temporarily disable that TUN
policy. The Feishu callback listens only on `127.0.0.1`; before WireGuard is
ready MX-H2I does not replace an existing system proxy/PAC, so that proxy must
also keep loopback destinations direct.

After WireGuard is ready, MX-H2I installs a standalone-owned system PAC that
points Internal domains at the shared local edge `127.0.0.1:2053`. The same
port serves `/proxy.pac` and an HTTP/CONNECT proxy. Matched domains are resolved
through the route plan DNS server, then routed by WireGuard `AllowedIPs`; other
traffic falls back to the previous system proxy such as Clash/mihomo. Multiple
MX-H2I standalone instances can reuse the same local edge port. DNS resolution
prefers the Internal fixed IP `10.88.88.88`; Domestic `10.88.0.1` is kept only
as a relay/cache fallback. Override the port with `MX_H2I_LOCAL_EDGE_PORT` only
for diagnostics or collision tests.

Startup does not restore stale macOS PAC/split DNS state by default, because
that repair requires an administrator prompt before the user has chosen to
connect. Reconnect or disconnect performs the explicit repair path. Set
`MX_H2I_RESTORE_SYSTEM_PROXY_ON_STARTUP=1` only for break-glass cleanup runs.
While already connected, the periodic route refresh verifies the live macOS PAC
and dynamic split DNS state before trusting the saved state. Verification sends
both A and AAAA queries to the local relay instead of merely checking that the
resolver entry exists. Synthetic IPv4 ownership answers are returned only for A
or ANY; AAAA receives NOERROR/NODATA and never a mismatched A answer. If
sleep/wake, a physical network change, or a Clash/mihomo mode switch removes the
MX-H2I entries, the background refresh keeps WireGuard/Internal intact and
downgrades the UI to `tunnel-only`; it does not open an administrator prompt.
Reconnect, employee login, or the explicit network repair action reapplies PAC
and split DNS with one foreground authorization transaction. A confirmed but
failed transaction is latched until another explicit user retry, so the periodic
watcher cannot reopen the same dialog. A controlled test/operations environment that explicitly accepts
interactive authorization and repeated-repair risk can opt into the old behavior
with `MX_H2I_MAC_BACKGROUND_PROXY_REPAIR=1`; production packages should not
preconfigure it. PAC apply/readback
uses the current macOS network-service inventory; deleted test or VPN services
remain only in the restore snapshot and cannot poison a new privileged apply.
On restart, MX-H2I may restart only its process-local PAC/DNS listener after the
persisted policy and live PAC/resolver match exactly; it never rewrites macOS
network state or joins another process's local edge from that path. A renamed
service carrying the exact owned PAC is disabled during disconnect, while a
service taken over by Clash/HDO is left unchanged. No background path applies
system state. An authenticated employee retained in
`tunnel-only` sees repair/disconnect controls instead of a second login form.

While a foreground connect or repair is running, the launcher exposes a
`Stop this connection/recovery` action independently of the normal busy-action
lock. Stopping pauses later recovery stages and background retries while
preserving the current employee identity, lease, WireGuard process, and Internal
reachability; it is not a disconnect. If a macOS administrator dialog is already
open, the user still cancels that dialog in macOS. The launcher lets the current
privileged process settle, performs read-only reconciliation, and does not enter
another privileged stage. A new explicit Connect or Repair action clears the
pause and starts a fresh bounded transaction.

For a Mac that stayed powered on while moving between networks, run the
standalone repair script while the updated MX-H2I app is running:

```sh
electron-dock/mx-launcher/demos/mx-h2i/scripts/repair-macos-dns.sh
```

Packaged builds include the same script at
`MX-H2I.app/Contents/Resources/repair/repair-macos-dns.sh`. It validates the
local `127.0.0.1:2053` relay, adds the covered exact H2I host beside its parent
suffix, reapplies the dynamic resolver, flushes the macOS DNS caches, and then
requires both the local relay and the real macOS resolver to return only the
explicit MX-H2I target (`MX_H2I_DNS_EXPECTED_TARGETS`, default `10.88.88.88`),
not merely any V2 `10.*` address. It only reports V1 HDO resolver files
by default. After HDO is disconnected, use
`--remove-legacy-hdo-resolvers` to move confirmed legacy files into a recoverable
`/var/tmp/mx-h2i-dns-repair-*` backup. `--check-only` never changes system
state.

On macOS, the WireGuard runtime prefers a product-owned LaunchDaemon
(`com.qpjoy.mx-h2i.wireguard.*`) after the user approves connect. This mirrors
the V1 HDO keep-alive path: launchd keeps the tunnel alive across lock, unlock,
and sleep/resume, while the app process probes health and revalidates the
browser PAC plus CLI dynamic resolver path. Its endpoint-route watchdog compares
the physical IPv4 default gateway, interface, and local source/IFA address. It
selects that path from the complete macOS route table instead of trusting
`route get default`, which may point at a Clash/mihomo utun or its
`198.18.0.0/15` fake gateway. The source value is required when the Mac moves
between two Wi-Fi networks that both use `en0` and
the same gateway address but assign different DHCP addresses; otherwise the
public bootstrap host route can retain the old source and fail with
`EADDRNOTAVAIL`. A user-initiated reconnect detects and removes an older stale
route with one administrator authorization, then installs the current watchdog.
The same physical-network signature watcher now runs on Windows. Background
checks never request elevation; the user-facing Repair Network action performs
the privileged recovery. On macOS it rebinds routes to the current utun and
refreshes split DNS. On Windows it restores the WireGuard service when needed,
re-adds overlay routes and NRPT namespaces, and clears the Windows DNS client
cache. Retained `lease-only`, `tunnel-only`, and `network-unavailable` states no
longer suppress an explicit reconnect.

The Electron entry is intentionally light for the reservation phase:

- `src/main.cjs` owns the window, local runtime state, persisted endpoint
  settings, and IPC contracts.
- `src/preload.cjs` exposes a small safe API to the renderer.
- `src/renderer.js` renders guest connect, employee login, AppCenter install,
  H2O enablement, endpoint injection, and gray update states.
- `electron-builder.config.cjs` is ready for macOS, Windows, and Linux output.

## MinCave 企业准入与管理控制台

仅允许通过飞书登录且属于明悉科技的成员使用 MinCave。企业按服务端配置的精确 `tenant_key` 判断，不按名称、邮箱或客户端声明判断。角色保存在 Launcher 用户中心：`mx-mincave-admin`（MinCave 管理员）和 `mx-mincave-employee`（MinCave 员工），包含基本身份读取及 `mx:mincave:use`，管理员额外具有 `mx:mincave:admin`。`mx-admin` 不自动获得 MinCave 管理权限，MinCave 管理员也不获得 Launcher 或其他应用管理权限。

明悉科技成员首次使用时默认员工；配置指定的首位管理员仅在首次准入时初始化。成员在 Launcher 或 MinCave 被撤销角色后，后续登录不会自动恢复。员工只显示工作台、设备和通知，隐藏全部管理入口；管理员的管理台本轮只开放成员列表、两种角色的分配和 MinCave 启停。姓名、部门只读；不改动全局账号状态、其他角色或应用授权。两端共同执行最后一位有效管理员保护。

### 登录和接口

保持原飞书 OAuth、PKCE 和系统浏览器授权。服务端为新签发的飞书 Token 保存可信企业来源；旧 Token 缺少来源时需要正常飞书登录一次，进入管理台无需再次登录。客户端主进程以当前 Bearer 访问经过现有安全传输校验的员工网关／内网地址，渲染层不获得 Bearer。不调用 Launcher `/auth/admin/*`、`/admin-api/*`，不使用 Cookie、Ops Token 或独立管理登录。

| 接口 | 权限与用途 |
| --- | --- |
| `POST /internal/v1/mincave/session` | 校验飞书、企业与当前权限，首次登记成员；可附带本机 `device` 元数据登记账号设备，兼容旧客户端空请求体 |
| `GET /internal/v1/mincave/devices` | 有 MinCave 使用权限的当前成员读取自己的全部设备历史，不接受其他账号 ID |
| `GET /internal/v1/mincave/members` | 管理员读取同企业登录过 MinCave 的成员，仅返回必要展示字段 |
| `PATCH /internal/v1/mincave/members/:userId` | 管理员提交 `{role: admin或employee, enabled: boolean}`；拒绝额外字段 |

登录、启动恢复、新连接、后台恢复及手动修复前验证权限。登录后每 60 秒、窗口激活及管理请求时复核。已经核验并连接的当前会话遇到临时服务故障时保留连接、暂停管理，不允许新连接；明确拒绝时锁定使用并执行原有断开流程。清理被取消或失败后不由每次轮询重复触发系统授权，用户仍可主动重试断开。账号切换丢弃旧响应。

### 配置与发布顺序

服务端配置：`MX_MINCAVE_FEISHU_TENANT_KEY` 为已核实属于明悉科技的企业唯一标识，缺失时拒绝准入；`MX_MINCAVE_INITIAL_ADMIN_USER_ID` 为已核实的当前叶佳俊稳定用户 ID，不能按姓名匹配或采用“第一个登录者”。生产清单从可选 Secret `mx-mincave-access` 的 `tenant-key` 和 `initial-admin-user-id` 读取，不在源码填写实际标识。

先核实企业标识和当前用户在服务端的飞书绑定，再配置上述 Secret、发布共享用户中心服务中的 MinCave 模块和精确公网路由，最后更新客户端。现有通用记录表新增 `mincave-member` 类型，无新增 SQL 表／迁移；角色继续存放原用户记录。成员列表不导入完整通讯录，不提供自动离职同步。本次未部署或授予真实账号角色，缺少新接口的现网不能完成新客户端的准入验收。

Domestic Caddy 两种制品及管理端配置模板只放行上述精确方法与路径，不开放通用后台 namespace。若公网 TLS 由 Compass nginx 承担，发布时还需核对该入口的精确白名单。回退新客户端前先恢复旧客户端；回退服务不删除已保存的 MinCave 角色／成员记录，不扩大旧管理权限。

右上角通知继续使用现有真实更新状态，点击“查看更新”进入原下载、安装和重启流程；没有更新时保留浅紫胶囊样式的“检查更新”按钮。


### 账号设备历史

设备页沿用原型的横向卡片：设备名称、当前／历史标记、状态和虚拟地址。移除安装标识、站点标识及设备标识的技术字段展示。当前设备排在最前，其他设备按最近使用时间倒序；只有本机实时连接状态会显示“已连接”，历史设备显示“已绑定”，地址标记为“最近虚拟地址”。断开时本机显示“未连接”，不把旧地址或长效租约当作在线证明。

主进程在原有 `session` 校验中附带 `deviceId/deviceLabel/platform/deviceModel/osVersion`，账号始终由可信 Bearer 在服务端确定，拒绝客户端传入 `userId` 或额外授权字段。`GET devices` 对员工与管理员使用相同的本人权限，不调用管理后台租约列表，也不向客户端下发全员设备后再过滤。Bearer 仍留在主进程，账号切换或旧请求晚到时丢弃旧结果。读取失败提供重试，不用本地演示设备或本机信息填充成功列表。

共享记录表新增 `mincave-device` 类型，以账号 ID 和稳定设备 ID 的组合散列为键。重复登录和权限复核更新最近使用时间，保留首次记录；退出登录不清除历史。同一台设备可以出现在分别登录过的账号中，每个账号只能读取自己的关联。设备 ID 沿用既有安装身份，重装后身份改变可能产生新记录，不按名称合并不同设备。

首次附带设备信息的会话会合并并保存当前账号仍可查到的 MX-H2I 员工租约历史，包括已释放和过期记录。仅返回必要展示字段，不返回 WireGuard 公钥、Capability、来源 IP、安装标识或全员资料。旧记录的更新时间属于最近使用信息，不声称为精确登录时间；此前从未记录或已被覆盖／删除的历史无法追溯恢复。之后每台升级后的客户端在登录／恢复校验时登记，因此无需先完成系统网络连接才能记录本次设备。

本功能需先发布共享后端及 Domestic／公网入口的精确 `GET /internal/v1/mincave/devices` 路由，再更新客户端。旧客户端的空 `session` 请求仍兼容；不新增 SQL 表或配置项。服务端未部署时，新设备页会显示读取失败，本地 UI 验收不代表线上设备历史已可用。
