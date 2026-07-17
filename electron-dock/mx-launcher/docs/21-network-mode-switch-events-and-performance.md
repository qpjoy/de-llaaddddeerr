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

这会显著缩短已安装、已授权机器上的切换；首次连接、系统授权、异常残留清理仍不是
零耗时。最终数值以 `connection.diagnostics.transitionTiming` 的真机 P50 / P95 为准。

## 2. V1 与 V2 边界

V1 HDO 由 `electron-demo/hdo`、`electron-server`、`electron-plugin-hdo` 和
`electron-core-wireguard` 形成以 Domestic 为中心的用户、DNS 和 VPN 模型。V2 的职责是：

- Internal：用户、匿名 install/device、权限、ProductNetwork、snapshot、signed lease。
- Domestic：bootstrap proxy、relay lease apply、peer materialization，不决定用户权限。
- MX-H2I standalone launcher：本机唯一的 V2 network owner，执行 WireGuard、系统 PAC、
  split DNS、ownership 和 network event。
- H2O / AppCenter / embed app：通过 broker capability 使用网络，不直接拥有系统数据面。
- Luopan：可测试 standalone 能力，也应能在 `reuse/attach` 模式观察并复用 MX-H2I；不能
  因自身启动就断开已经存在的 staff 网络。

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
| `staff/visit:disconnect` | WireGuard 已确认停止 | 才发布 `disconnected` 并提交 idle |

应用崩溃重启后可以照常发默认 `visit:connect`；launcher 若发现系统已有 staff，只返回
no-op，不会为了初始化而断开员工网络。

断开的状态真相以系统 WireGuard 状态为准，不能以 IPC 已返回或 channel release 已执行为准。
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

若 P95 仍高：`controlPlaneMs` 对应 bootstrap/OAuth/lease；`preflightMs` 对应 peer sync 或
PAC route catalog；`wireGuardMs` 对应 daemon cleanup、授权、route install 或 utun ready；
`postConnectMs` 对应 Internal health、PAC/resolver verification 和 ownership registry。
