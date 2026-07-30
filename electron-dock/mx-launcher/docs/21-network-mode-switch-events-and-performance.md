# MX-H2I 访客 / 员工网络切换、事件与性能基线

> 状态：V2 当前实现基线。本文描述 MX-H2I standalone launcher 如何拥有网络数据面，
> 以及 Luopan、H2O 等应用如何观察网络，而不是各自抢写 WireGuard、PAC 或 DNS。

## 1. 结论与实测根因

V2 的慢切换不是 Clash 模式本身在切换，也不是单纯等待 Internal 分配 IP。2026-07-16
本机样本如下：

| 时间 | 阶段 |
| --- | --- |
| `21:14:11.728` | anonymous lease 和 route plan 已 ready |
| `21:14:15` | 本地 WireGuard config 已生成 |
| `21:14:22` | root LaunchDaemon 资源复制完成 |
| `21:14:28` | 新 LaunchDaemon 进入 `launchdaemon-start` |
| `21:14:30.757` | WG route、Internal API、PAC / split DNS 验证完成 |

主要等待发生在 macOS LaunchDaemon 的数据面替换：旧 daemon 为避免 Clash/Mihomo TUN
抢路由，会清理一组细粒度 overlay 路由；新 daemon 启动后又无条件做一遍相同 cleanup。
两次全量清理串在一起，远大于 lease 请求本身。

当前修复：

1. 干净 bootout / uninstall 后写入一次性 `clean-start` marker；下一 daemon 消费 marker
   并跳过重复 cleanup。异常退出或没有 marker 时仍执行完整清理。
2. Domestic peer sync、Internal direct peer sync、PAC / split DNS prepare 并行执行。
3. 22 秒上限的 Domestic relay 深度诊断移到连接后的后台，不再挡住 ready。
4. `visit -> staff` 不再要求用户先断访客。访客 overlay 保持可用，先完成登录和 user
   lease，再由 launcher 原子替换数据面。
5. UI 分开显示 lease ready、preflight、data-plane switching，不再把所有阶段都显示成
   “正在申请 relay lease”。
6. macOS endpoint bypass 不再读取 Clash/Mihomo utun 的逻辑 default；LaunchDaemon、诊断和
   主动修复统一从完整路由表选择物理 IPv4 default。主动修复直接在一次管理员事务中把 relay
   endpoint `/32` 绑定到物理 gateway，后台检测不再产生预期内的 `must be root` 噪声。

这会显著缩短已安装、已授权机器上的切换；首次连接、系统授权、异常残留清理仍不是
零耗时。最终数值以 `connection.diagnostics.transitionTiming` 的真机 P50 / P95 为准。

## 2. V1 与 V2 边界

V1 HDO 由 `electron-demo/hdo`、`electron-server`、`electron-plugin-hdo` 和
`electron-core-wireguard` 形成以 Domestic 为中心的用户、DNS 和 VPN 模型。V2 的职责是：

- Internal：用户、匿名 install/device、权限、ProductNetwork、snapshot、signed lease 的
  desired-state 和审计真相；不直接修改客户端系统网络。
- Domestic：bootstrap proxy、relay lease apply、peer materialization，不决定用户权限。
- MX-H2I standalone launcher：当前本机 DNS/PAC network owner，执行自己的 WireGuard、
  系统 PAC、split DNS、route、UAC/LaunchDaemon、ownership 和 network event，并验证、
  恢复本机状态。互不重叠的 product-scoped WG routes 可与 Luopan 的独立 routes 并存；
  共享 PAC/resolver、`2053` 和 machine-global NRPT baseline 仍必须保持单写者。
- H2O / AppCenter / embed app：通过 broker capability 使用网络，不直接拥有系统数据面。
- Luopan：当前默认是拥有独立 ProductNetwork/WG 的 standalone 测试产品；`reuse/attach`
  只是可选 smoke。它不能因自身启动就断开已经存在的 staff 网络，也不能把当前 Luopan
  route/ownership smoke 当作 Windows NRPT/PAC 端到端证据。

## 3. 登录与数据面分层

登录与网络不是完全独立，也不应绑成一个不可观察的长事务。

### 3.1 控制面

1. 解析 bootstrap；已有可用 overlay 时优先使用 retained Internal overlay。
2. `staff` 登录通过 User Center 获取 JWT。
3. Internal 根据 user identity 返回 user lease 和 snapshot。

这部分需要至少一条可达 Internal 的路径。当 visit 已连接时，visit overlay 正是员工登录
最稳定的 bootstrap；所以不能先断 visit 再登录。

### 3.2 Preflight

Domestic peer sync、可选 Internal direct peer sync、PAC reverse routes 和 dynamic resolver
shell 可以并行准备。Domestic 深度诊断用于解释失败，不是 WG 启动前置条件；peer sync
通过后，深度诊断应在 ready 后补齐。

### 3.3 原子系统切换

macOS 上 WireGuard、PAC 和 dynamic split DNS 仍保持同一个提权事务：

- 先改 PAC / DNS 会产生 PAC 指向未 ready overlay 的窗口；
- 先改 WG 会产生域名仍走旧 resolver 的窗口；
- 分开恢复容易覆盖用户原系统代理或另一个 launcher 的 ownership claim。

macOS 的目标门禁是 local edge 与 SystemConfiguration supplemental resolver 都已准备好后，
suppressed interface DNS 才能算 ready；当前 suppression 布尔结果本身不能证明 prepared，
验收必须补 live local-edge/resolver evidence。supplemental resolver 只接管声明的
Internal/app domain，未命中域名仍走原系统 resolver。Windows 则由 UAC/WireGuard service
path 为 profile 声明的 namespace 安装 NRPT，并默认由用户态同时安装 MX local-edge
WinINet PAC。Internal exact/suffix 经 PAC 固定走 `PROXY 127.0.0.1:2053`；只有 live
NRPT/system DNS、PAC readback、Chromium `resolveProxy` 和实际 CONNECT 全部通过才 ready。
`MX_H2I_WINDOWS_SYSTEM_PAC=0` 只允许诊断/降级，不能发布 `connected`。NRPT 仍不接管
未命中的公网域名。

所以“分层”指控制面、preflight、诊断和数据面有独立状态及耗时，不代表把系统网络写入
拆成几个没有事务保障的命令。

## 4. 模式优先级与幂等

| 请求 | 当前状态 | 结果 |
| --- | --- | --- |
| `visit:connect` | staff connected | `skipped / staff-active`，不重启、不降级 |
| `visit:connect` | visit connected | `skipped / visit-active`，幂等返回 |
| `visit:connect` | idle | 申请 anonymous lease 并连接 |
| `staff:connect` | visit connected | 保留 visit 完成登录；staff ready 后替换 visit |
| `staff:connect` | idle | 登录、申请 user lease 并连接 |
| staff 登录失败 | visit connected | 恢复 visit runtime，原隧道保持连接 |
| staff 授权取消 | visit connected | 恢复 visit runtime，不把系统误报成 idle |
| `staff/visit:disconnect` 授权取消 | connected | 发布 `failed / authorization-canceled`；保留连接、ownership、PAC 和 DNS，不执行第二次提权恢复 |
| Windows `staff/visit:disconnect` | connected | 保持 `2053` 存活；仅当 MX 仍持有 `AutoConfigURL` 时恢复最近成功协商捕获的 external value，外部 owner 已接管则保留其值。再停 WG、清 owned NRPT 并核验，最后关闭 `2053`；全部成功才发布 `disconnected` |
| Windows disconnect/正常退出任一步失败 | connected / recovering | 阻止断开或退出，保留 WG/NRPT 或 `2053` 所需的可恢复路径并显示 repair |
| macOS `staff/visit:disconnect` | connected | 保持现有联合恢复事务；WireGuard 已确认停止后才发布 `disconnected` |

应用崩溃重启后可以照常发默认 `visit:connect`；launcher 若发现系统已有 staff，只返回
no-op，不会为了初始化而断开员工网络。

断开的状态真相以平台 teardown 全部 live 证据为准，不能以 IPC 已返回或 channel release
已执行为准。Windows 不能在 WinINet 仍引用 MX PAC 时先关闭 `2053`，也不能在 owned NRPT
清理未确认时提交 idle。
若旧版本在授权取消后误写了 idle，而 LaunchDaemon / utun 仍 active，MX-H2I 启动时会只读
对账并恢复成 `tunnel-only`，继续提供“断开连接”入口。用户再次断开时只发起一个合并的
WireGuard + PAC + split DNS 管理员事务；取消后立即停止后续清理，避免连续授权窗口。

## 5. 跨进程事件契约

`@qpjoy/electron-launcher/network-mode-events` 提供：

- `publishElectronLauncherNetworkModeEvent()`：仅 network owner 发布；
- `readElectronLauncherNetworkModeEventState()`：启动时读取 durable snapshot；
- `subscribeElectronLauncherNetworkModeEvents()`：运行时监听变化；
- `defaultElectronLauncherNetworkModeEventStatePath()`：返回平台共享状态文件路径。

事件名固定为 `visit:connect`、`visit:disconnect`、`staff:connect`、
`staff:disconnect`。每条事件含 `phase`：`connecting | connected | disconnected | skipped |
failed`，以及 `sequence`、`productId`、`instanceId`、`leaseIp`、`reason`、`transitionId`
和 `occurredAt`。状态文件保留最近 32 条事件，并维护 `activeMode`。

macOS 默认路径：

```text
~/Library/Application Support/QPJoy/Electron Launcher/network-mode-events.json
```

消费端示例：

```ts
import {
  readElectronLauncherNetworkModeEventState,
  subscribeElectronLauncherNetworkModeEvents
} from '@qpjoy/electron-launcher/network-mode-events';

const initial = readElectronLauncherNetworkModeEventState();
if (initial.activeMode === 'staff') {
  // attach / refresh UI；不要发 visit disconnect。
}

const unsubscribe = subscribeElectronLauncherNetworkModeEvents((state) => {
  const event = state.current;
  if (!event) return;
  if (event.name === 'staff:connect' && event.phase === 'connected') {
    // staff capability ready；刷新用户态功能。
  }
  if (event.name === 'visit:connect' && event.phase === 'skipped'
      && event.reason === 'staff-active') {
    // 默认 visit 初始化被安全忽略；继续复用 staff。
  }
});
```

事件是状态通知，不是让每个应用自行 `wg down`、写 PAC 或修改 resolver 的命令总线。
connect/disconnect 仍由 MX-H2I broker/network owner 串行化。

## 6. 可观测性与发布门槛

每次切换写入 `connection.diagnostics.transitionTiming`：`transitionId`、
`controlPlaneMs`、`preflightMs`、`wireGuardMs`、`postConnectMs`、`totalMs`。

建议发布门槛：

- 重复 visit 或 staff 下的 visit 请求：P95 < 300 ms，且 WG PID/utun 不变；
- visit -> staff、staff -> visit：已授权机器 P50 < 5 s，P95 < 10 s；
- `domesticRelayDiagnostics` 超时不影响 network-ready；
- transition 失败且原 visit 健康时，`activeMode` 保持 visit；
- PAC URL、dynamic resolver key、ownership claim 只有一个有效 owner；
- Clash/Mihomo TUN 开启时，Internal VIP 和 relay endpoint 仍分别走 WG 与物理网卡。
- Windows 上依次执行 Clash TUN → system proxy → TUN、Clash 重启/端口变化；每一步都要
  保持 live NRPT/system DNS、PAC readback、Chromium `resolveProxy -> 2053` 和 CONNECT。
  未命中流量按 owner 状态选择 `DIRECT`、live loopback static proxy 或包装后的 loopback
  PAC；AutoDetect/WPAD 仅在它是唯一适用 owner、且不存在可表达的 live static/PAC
  continuation 时 fail closed；短启动宽限期后仍无 listener 的 stale loopback PAC 被跳过且
  不恢复，live-invalid/非 loopback PAC 或 dead static listener 仍 fail closed。
- Windows 的 5 秒 watcher 常态只读验证；新外部 owner signature 可触发一次有界协商并按
  结果写回 `AutoConfigURL`，同一 signature 后续 tick 不重复写。owner 状态变化、重连或
  手动 repair 才开启下一次协商。
- 旧版本升级并保留 WireGuard service/tunnel 时，必须读取 live route、Internal health、
  `Get-DnsClientNrptGlobal`/rules、系统 DNS、PAC readback、Chromium `resolveProxy` 和
  CONNECT 后才能恢复 `connected`；历史 route audit 只能解释过程，不能代替当前状态。
- Windows disconnect/正常退出必须通过两阶段门禁：先恢复/保留 external WinINet owner 且
  保持 `2053` 存活，再做 WG/owned NRPT cleanup，最后关闭 `2053`；失败时操作被取消而不是
  留下失效 PAC。
- 微信、豆包、Steam 等公网应用异常默认进入 WinINet/PAC/Clash 排查，不因 MX 内部域名
  NRPT 告警直接归因为 DNS。

若 P95 仍高：`controlPlaneMs` 对应 bootstrap/OAuth/lease；`preflightMs` 对应 peer sync 或
PAC route catalog；`wireGuardMs` 对应 daemon cleanup、授权、route install 或 utun ready；
`postConnectMs` 对应 Internal health、PAC/resolver verification 和 ownership registry。
