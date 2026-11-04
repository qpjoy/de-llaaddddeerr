# Luopan 客户端优化建议：借鉴 MX-H2I 的连接状态机

状态：2026-10-23 源码走读与优化设计；本文件没有修改罗盘、MX-H2I、standalone SDK 或服务器运行代码。

本文承接 [54 · Luopan standalone Windows/macOS 执行流程](./54-luopan-standalone-execution-flow-windows-macos.md)，比较正式罗盘 `/Users/qpjoy/workspace/mingxi/luopan/po-frontend` 与 `demos/mx-h2i` 的连接实现，给出客户端优化顺序。

## 结论

MX-H2I 可以借鉴的核心是：

- 每个网络操作有明确的 epoch、取消标志和阶段状态，旧操作完成后不能覆盖新身份。
- 连接前先探测可保留的旧隧道；健康时复用，半失效时原位修复，避免直接卸载重装。
- Domestic peer、Internal direct peer 和本地准备动作可以并行预检；失败时按必需/可降级分类，并在切换失败时保留旧连接。
- 所有网络、DNS、原生命令都有上限；后台探测一次失败不立即破坏连接。
- `connecting`、`lease-only`、`data-plane`、`ready` 分阶段保存和广播，使页面能显示卡在哪一段。

不应直接复制 MX-H2I 的 PAC、split DNS/NRPT、员工/访客双模式、匿名策略或系统代理事务。docs/28 已约束 MX-H2I 与 Luopan 可以共享 Domestic relay fabric 和 Internal service peer，但必须继续隔离 ProductNetwork、lease CIDR、service VIP、AllowedIPs 和 ownership。

## 当前差距

| 位置 | 当前罗盘行为 | MX-H2I 已有做法 | 影响 |
| --- | --- | --- | --- |
| peer 同步 | Windows 只把本地路由预读与整段 peer 同步并行；Domestic 完成后才请求 Internal direct | 三个 preflight 用 `Promise.allSettled` 同时开始 | 首次连接把两个服务器等待时间相加 |
| 控制面请求 | `postLauncherNetwork` 使用无 `signal` 的 `fetch`；standalone core 的 `requestJson` 也没有 timeout | 关键 HTTP/DNS/原生命令有阶段上限 | 半开连接可能无限等待，直接破坏 5 秒目标 |
| HTTP 结果 | 主要只检查 HTTP 状态码；HTTP 200 内的 `blocked/failed` 可能被当作成功 | 解析 `status/execution` 并分类 | 可能进入不完整数据面后才暴露问题 |
| 用户切换 | 登录用户重新 `connectNetwork`；失败时没有完整的旧 anonymous lease 回滚 | guest→employee handover 有旧连接快照、abort 和 rollback | 登录卡住时可能让用户失去原本可用的网络 |
| 重复操作 | 有 `connecting` Promise 合并，但没有统一 epoch/cancel 检查 | 每个 await 后检查 foreground operation 是否仍有效 | 旧登录、旧 lease 或恢复任务可能晚到并写回新状态 |
| 应用重启 | runtime 读入后连接状态清空，通常重新走控制面 | 启动先 reconcile retained WireGuard，再决定是否恢复 | 已有可用服务也可能重新申请 lease、重建数据面 |
| 恢复 | 没有 Luopan 专用的网络变化/唤醒恢复 watcher | app-ready、resume、unlock、网络签名变化触发后台恢复 | 睡眠或切网后依赖用户重新登录/刷新 |
| 状态持久化 | `setConnection` 多次写完整 runtime 文件 | H2I 有阶段状态和广播，同时保留可恢复快照 | 小文件写入和黑盒 loading 影响感知耗时 |

另一个需要先修正的认知是：docs/52 记录的“网络 POST 约 15 秒超时”不是当前 Luopan/standalone core 的实现事实。当前源码中的 `requestJson` 与 `postLauncherNetwork` 没有 `AbortSignal` 或 deadline；只有 bootstrap resolver 明确有候选探测超时。

## 优先级和边界

| 优先级 | 建议 | 收益 | 主要风险与保护 |
| --- | --- | --- | --- |
| P0 | 发布门禁检查两个 pnpm patch 是否进入 ASAR/安装包；为 bootstrap、enrollment、snapshot、peer sync、WG ready、VIP health 加阶段耗时和 deadline | 先消除实际卡死和“本机代码与发布包不同”的盲区 | 超时必须返回带阶段/trace 的错误；不能因超时清理 MX-H2I ownership |
| P1 | Domestic peer 与 Internal direct peer 并行；Domestic 保持硬依赖，Internal direct 按 route plan 可降级 | 将两段远端等待改为约 `max(Domestic, Internal)` | 先确认两个接口对同一 lease 幂等、审计和 handover 记录可并发；服务器端已有类似 `Promise.allSettled` 的过期 handover 处理，可先加客户端/服务端测试 |
| P1 | 引入 Luopan 专用 operation epoch、AbortController 和旧结果检查 | 防止重复点击、用户切换、网络变化覆盖新状态 | generation 只作用于 `productId=luopan`；不得共享或清理 MX-H2I 状态 |
| P1 | 用户切换保留旧 anonymous 数据面，完成新 lease 的 peer、ownership、route 和 VIP health 后再提交切换 | 登录失败时用户仍可使用原网络 | 需要服务端 handover capability 和客户端 rollback；不能直接把 H2I PAC/DNS handover 搬来 |
| P1 | 已运行 Luopan 服务先做 route + VIP health probe；匹配 lease/capability/snapshot digest 时复用，否则原位修复或冷启动 | 重启和重复登录从秒级降到探测时间 | 缓存必须绑定 product、owner、lease、配置指纹和过期时间，不能仅凭 service Running |
| P2 | 删除或后置 macOS `applySession` 中只描述旧路由的同步诊断；复用路径把已验证的短时 health 结果传给外层 | 减少重复 native probe 和重复 VIP health | 仍需在最终 WG/route 状态后做一次新鲜 ready 检查 |
| P2 | 将 Windows 之外的复用缓存写入也放到 ready 后；把持久化的 transient 状态合并写入 | 减少入口文件写入等待 | lease/identity/失败状态仍需在关键边界落盘 |
| P2 | 增加只观测的唤醒、网络签名变化和周期恢复；连续 3 次确认失败后才降级/修复 | 断网、睡眠恢复更平滑 | 后台不能强制重装、抢占 H2I 资源或重新弹权限 |
| P3 | loading 页显示阶段和最近阶段耗时，增加 Electron event-loop delay | 能区分远端等待与同步 native 卡顿 | 仅记录 lease ID、阶段和摘要，不能记录 token、私钥或完整订阅 |

## P0：先解决无限等待和发布不一致

### 阶段 deadline

给 `launcher-core` 的 `FetchInitLike` 增加可选 `signal`，让 `requestJson` 将 `AbortSignal` 传给实际 fetch；Luopan 的 `postLauncherNetwork` 使用同一套 `AbortController`。每次连接再创建一个总 deadline，并为阶段派生子 deadline：

```text
总连接 deadline
 ├─ bootstrap resolve
 ├─ enrollment
 ├─ snapshot
 ├─ Domestic/Internal peer preflight
 └─ WG apply、route probe、VIP health
```

deadline 数值应由实测和目标 SLO 确定，不应把超时简单写成一个很大的常数。超时错误至少包含 `traceId`、阶段、目标、已耗时、是否可回退。首次匿名连接超时应停止当前未提交的数据面并显示阶段错误；已有 anonymous 或 user 连接时，应优先保留旧连接。

bootstrap 当前按候选和两个 health path 逐个等待，每个候选最多约 3 秒；在候选可信且同一控制面的情况下，可以改成有限并发竞速，首个成功后 abort 其余请求。公网请求数量和服务端日志会增加，因此应只对已配置的同域候选启用，并设总 deadline。

enrollment → snapshot 仍是强依赖，不能在客户端盲目并行。若要进一步压缩这段，应该新增兼容的原子 connect API，或让 enrollment 返回可验证 snapshot，而不是让客户端同时发送两个相互依赖的请求。

### 正确识别 HTTP 200 业务失败

`postLauncherNetwork` 应解析响应中的 `domesticPeerSync`/`internalDirectPeerSync`，把 `status=blocked/failed` 或 `execution=failed` 转成明确结果。HTTP 200 只能说明控制器返回了响应，不能说明 peer 已经写入 Domestic 或 Internal。这样可以避免假 ready，也能让 Internal direct 的可降级策略有依据。

### 发布包 patch gate

构建时保留现有 runtime inspector，并对最终 ASAR 解包后的文件做特征检查：Windows 服务复用、路由预读、并行 readiness；macOS daemon 复用和不带 `kickstart -k`。没有 patch_hash 或特征缺失时阻止正式发布，而不是只在开发机 node_modules 上通过检查。

## P1：把 peer 预检改成安全并行

当前罗盘 `syncLeasePeers` 在 [746–755 行](/Users/qpjoy/workspace/mingxi/luopan/po-frontend/src-electron/luopan-launcher-manager.ts:746) 先等待 Domestic，再请求 Internal direct。可以改成：

```text
Promise.allSettled([
  syncDomesticPeer(...),
  syncInternalDirectPeer(...)
])
 → Domestic 失败：整次连接失败或回退旧连接
 → Internal direct 失败：只有 route plan 明确有 Domestic fallback 时降级
 → 保存两个结构化结果
 → 继续 WG apply
```

这里要先验证服务器端的并发语义。两个 controller 都会读取同一 lease，并分别调用 peer host runner；普通新 lease 没有完整 handover 时风险较低，但同一 lease 的审计和 handover 状态可能并发写入。因此必须使用不同 requestId，增加 controller/store 测试，确认重复调用幂等，并在失败时保留 Domestic 成功结果。

不能因为 Internal direct 是可降级项就无条件把它丢到后台。只有当 route plan 已明确可经 Domestic relay 到达所有 required targets，且 WG AllowedIPs 不依赖 direct peer 时，才可把 direct sync 改成 ready 后诊断；否则先并行、再汇合。

## P1：借鉴 H2I 的保留连接和取消模型

罗盘当前用户登录的前置条件是 anonymous `network-ready`，之后再申请 user lease。优化目标应是：

```text
保留 anonymous 数据面
 → 获取 user token 和 user lease
 → 并行准备新 lease 的 peer
 → 新 ownership、route、WG、VIP health 全部通过
 → 原子切换到 user
 → 失败则恢复 anonymous
```

这需要服务端明确 handover capability、旧 lease 的保留窗口和 commit/abort 语义。不能直接用 standalone `connectUser` 或 snapshot API 代替 `connectNetwork`；当前 `connectUser` 的协议语义和 Luopan 用户租约分配并不等价。

所有可能继续运行的任务都应捕获当前 generation：

- 用户登录、退出、刷新网络各自创建 operation ID。
- `await` 返回后检查 operation 仍是当前 operation，身份、leaseId、productId 都未改变。
- 新登录开始时 abort 旧的海外请求、peer sync 和恢复 probe。
- 旧任务即使最终成功，也只能记录诊断，不能调用 `setConnection`、写 runtime 或释放新 ownership。

H2I 的 `beginForegroundNetworkOperation`、epoch 检查和旧连接 snapshot 是可借鉴的机制；它们保护的是 H2I 自己的连接，罗盘应实现 Luopan 专用版本。

## P2：减少本机重复探测和启动黑盒

罗盘 macOS 的 `applySession` 在真正安装数据面前做同步 route diagnosis。这个结果只能描述旧系统状态，不能证明新 lease 已 ready；建议改成轻量状态记录，或放到后台诊断。真正的 ready 仍由 SDK apply 后的 route/ownership/health 完成。

Windows 和 macOS 的复用验证都可能已经完成一次 route + VIP health，随后 `applyDataPlane` 又执行一次 VIP health。可以在同一 operation 内传递带时间戳的验证结果，在 route/ownership 未变化且未超过很短 freshness window 时复用；任何状态变化都必须重新探测。

罗盘已有 `lease-active`、`data-plane-pending` 和 `network-ready` 状态，但页面主要仍表现为等待。可以把阶段事件发送给 loading 页面：

```text
bootstrap → lease-active → peers-ready → platform-applying
 → route-ready → vip-health → network-ready
```

这不会改变网络门槛，只是让用户知道是 Domestic、Internal、系统授权、WG ready 还是 VIP health 在等待。同步 `execFileSync`、`spawnSync`、文件锁等待应另外记录 event-loop delay，避免把主线程阻塞误判成服务器慢。

## P2：后台恢复，但不破坏共存

可以参考 H2I 的 app-ready、resume、unlock、网络签名变化和 45 秒周期 watcher，但 Luopan 第一阶段应只做观测和安全的原位修复：

1. 先读 Luopan 自己的 ownership claim、lease、route plan 和服务指纹。
2. 只探测 Luopan 的 lease IP、service VIP 和自己的 route/endpoint。
3. 一次失败只记录 degraded；连续三次确认失败后才进入 Luopan 专用 repair。
4. repair 前再次确认 H2I ownership、route CIDR 和 profile 不重叠。
5. 无法证明归属时停止修复并提示用户，不清理现场。

普通退出是否停止 standalone 数据面也需要明确产品策略。若目标是快速再次打开，应保留服务但必须按上述 probe/reuse 规则恢复；若退出即断网，则应像 H2I 一样 await `stop`、释放 Luopan claim 并确认清理完成。当前 Luopan 普通 `before-quit` 没有调用 `luopanLauncherManager.stop()`，这更像未决行为，不能把它当成既定优化。

## 实施顺序和验收

建议按以下顺序落地，每一步都保持 MX-H2I 安装包和登录回归测试通过：

1. 发布包 patch gate、阶段日志、deadline、HTTP 业务状态解析。
2. Domestic/Internal peer 并行及服务器幂等测试。
3. operation epoch/cancel，重复点击、换用户、断网和旧请求晚到测试。
4. Luopan retained-session probe、复用缓存和失败回退；先做不带自动破坏性修复的观测版。
5. macOS 重复诊断后置、后台恢复 watcher、阶段 UI 和 event-loop delay。

每个版本应记录冷启动、热重启、重复登录、睡眠恢复四组 p50/p95：bootstrap、enrollment、snapshot、Domestic peer、Internal peer、WG platform apply、route probe、VIP health、总入口耗时。验收条件包括：

- warm reuse 不重新 enrollment，且只验证 Luopan 自己的 route/VIP；
- peer 并行后总耗时接近较慢分支，而不是两段相加；
- 所有半开请求都在 deadline 内结束；
- 旧身份结果不能覆盖新身份；
- 任意失败都不删除或修改 MX-H2I 的 route、NRPT、DNS、PAC 或 ownership；
- Windows/macOS 发布包确实包含声明的 standalone/core patch。

主要依据：[MX-H2I 启动恢复与后台 watcher](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/demos/mx-h2i/src/main-runtime.cjs:287)、[H2I 连接 epoch](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/demos/mx-h2i/src/main-runtime.cjs:4629)、[H2I 并行 preflight 与 rollback](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/demos/mx-h2i/src/main-runtime.cjs:14631)、[Luopan peer sync](/Users/qpjoy/workspace/mingxi/luopan/po-frontend/src-electron/luopan-launcher-manager.ts:730)、[standalone core 请求](/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr/electron-dock/mx-launcher/packages/launcher-core/src/index.ts:1167)、[Luopan/ MX-H2I 共存边界](./28-mx-h2i-connection-operations-and-anonymous-governance.md)。
