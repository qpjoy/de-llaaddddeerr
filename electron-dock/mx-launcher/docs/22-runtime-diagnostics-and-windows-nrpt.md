# MX-H2I 运行日志、Windows NRPT 与 PAC/Clash 诊断

MX-H2I 在主进程中维护低开销的结构化运行日志，用于排查 WireGuard、PAC、split DNS、Windows NRPT 和模式切换错误。日志写入不进入连接关键路径：调用方只构造一条短事件，文件追加和轮转在异步队列中串行完成。

先区分两条互不替代的系统链路：Windows NRPT 只处理 WG profile 声明的 MX
Internal/app namespace；WinINet PAC/系统代理处理浏览器和部分公网应用流量。看到
`h2i.mxinfo-inc.cn` 仍解析到公网，只能说明这个内部 namespace 没有进入预期 split DNS，
不能据此断言微信、豆包、Steam 等未命中 namespace 的公网 DNS 被接管。
MX-H2I 默认同时启用两条链路；NRPT 正常但 PAC/browser proof 缺失仍只能是
`tunnel-only`。

## 日志保留

- 目录：Electron `userData/logs/`
- 当前文件：`mx-h2i-runtime.ndjson`
- 单文件上限：2 MB
- 轮转：当前文件加 2 份历史文件
- 内存只保留最近 40 条事件，高级页面最多显示最近 5 条 warning/error
- 常见 token、密码、私钥、Cookie 和 Authorization 字段会在写入前隐藏

## 导出诊断包

高级选项中的“导出诊断包”会让用户选择父目录，再创建独立的 `MX-H2I-diagnostics-*` 文件夹。较重的系统命令只在用户点击导出时执行。

通用文件：

- `summary.json`：版本、平台、连接状态、最近错误和活动
- `network-diagnostics.json`：域名解析、PAC readback、Chromium `resolveProxy`、
  local-edge CONNECT、WireGuard 和网络环境诊断
- `runtime-logs/`：滚动 NDJSON 日志
- `wireguard-route-audit.log`：WireGuard 服务审计日志（存在时）

Windows 额外文件：

- `windows-dns-nrpt.json`：live `Get-DnsClientNrptGlobal`/rules、WinINet proxy
  registry、关键本地 listener、网卡 DNS 和 IP 配置。只导出排障所需字段并限制记录数，
  不得使用 `Select-Object *` 序列化 CIM 元数据，以免超过子进程 stdout 上限
- `windows-ipconfig-all.txt`：`ipconfig /all`
- `windows-route-print.txt`：`route print`
- `windows-winhttp-proxy.txt`：WinHTTP proxy 快照；它与当前用户的 WinINet 设置不是同一状态

## 诊断证据级别

所有 UI、日志和排障结论必须标注来源：

| 标签 | 来源 | 能证明什么 |
| --- | --- | --- |
| `live` | 诊断包实时命令或现场同刻采集的 NRPT/system DNS、route、WinINet readback、Chromium `resolveProxy`、listener/CONNECT probe | 当前系统状态，可用于 ready/修复结论 |
| `audit-derived` | `wireguard-route-audit.log` 或其 tail 中的 add/remove/assert | 某个历史时刻执行过什么，只用于解释过程 |
| `runtime-derived` | NDJSON、持久化 runtime、UI 汇总 | 应用当时如何判断；不能覆盖相反的 live 证据 |

高级页的 NRPT 提示目前可能来自 route audit tail，必须显示 `audit-derived`。诊断包中的
`windows-dns-nrpt.json` 才是导出时的 `live` NRPT 证据。旧日志里的
`nrpt add complete` 不能证明升级、重启或网络切换后的规则仍存在。
用户文案应写“MX namespace 的 NRPT 未在当前网络生效”，不应写成 split DNS 将“接管所有网络”。

## Windows DNS / NRPT 排查顺序

NRPT rule 只应包含 Internal/AppCenter 下发的 exact domain/suffix，并指向产品 DNS。
“global policy” 表示这些 namespace rules 可在所有网络 profile 上被评估，不表示接管所有
DNS 查询。

1. 查看 `summary.json` 的连接状态和最近 `wireguard.not-ready` /
   `network.diagnostics-problem`，把它标为 `runtime-derived`。
2. 以 `windows-dns-nrpt.json` 为准检查 `live` 状态：QueryPolicy 应允许 NRPT；目标
   namespace 应存在且 NameServers 指向 MX-H2I DNS；未声明的公网 domain 不应出现。
3. 再用 `wireguard-route-audit.log` 解释安装过程：是否完整出现 `nrpt add start`、每个
   namespace 的 `nrpt assert ... count=1` 和 `nrpt add complete`。它是
   `audit-derived`，不能反向覆盖第 2 步。
4. live rule 正确后仍必须用系统 resolver 查询 namespace 内的内部 hostname。返回 Internal
   目标表示系统级 DNS ready；若仍解析到公网或 `198.18.*`，检查 Secure DNS/DoH、DNS
   cache、安全软件、Clash TUN 和企业组策略。同时继续启动 PAC/local edge：只有 Chromium
   `resolveProxy` 与真实 CONNECT 通过后，才可把浏览器路径恢复为 connected；非 PAC 程序仍
   标记 degraded。
5. 若日志出现 `rules missing after add`、`global policy failed` 或 PowerShell stderr，
   按错误原文检查管理员权限、安全软件和组策略拦截。

Windows 浏览器 gate 必须满足：

1. WinINet readback 的 `AutoConfigURL` 指向 MX-H2I PAC；`ProxyEnable`、
   `ProxyServer`、`ProxyOverride`、`AutoDetect` 只读，不作为 MX 写入值；
2. Electron Chromium system session 对 Internal URL 的 `resolveProxy()` 命中
   `PROXY 127.0.0.1:2053`；
3. 经 `2053` 向 Internal host 发出的真实 CONNECT 返回成功。

系统 DNS 同时返回 Internal 地址时，才是包含 `ping`、`curl` 等非 PAC 程序的完整系统级
ready。若系统 DNS 仍受 Clash TUN/DoH 影响，浏览器 proof 可以解除 `tunnel-only`，但
`windowsDnsResolution.ready=false` 必须保留，不能把非 PAC 程序误报为 ready。

`MX_H2I_WINDOWS_SYSTEM_PAC=0` 会刻意关闭这半条链路，只能用于诊断/降级，预期状态是
`tunnel-only`，不得视为修复或完整 ready。

从旧安装包升级且保留 tunnel/service 时，WG active 只是 tunnel 证据。启动恢复
`connected` 前必须重新读取 live NRPT/system DNS、route、Internal health、PAC readback、
Chromium `resolveProxy` 和 CONNECT。route、Internal health、NRPT 或浏览器 proof 缺失时
保持可恢复状态；只有 system DNS 失败而浏览器 proof 成功时允许 browser-connected，并明确
保留非 PAC DNS degraded，不能因为历史 audit 完整而跳过。

运行时调用 Windows PowerShell 不依赖 Electron 进程的 `PATH`，必须从
`%SystemRoot%\Sysnative|System32|SysWOW64\WindowsPowerShell\v1.0\powershell.exe`
解析绝对路径。`spawn powershell.exe ENOENT` 表示命令路径失败，不表示 NRPT cmdlet
失败；覆盖安装保留的 `AutoConfigURL` 会让这类通知/恢复错误在启动后立即暴露。

Windows split-DNS 诊断必须分别记录三层证据，不能把其中一层成功写成整条链路 ready：

1. `directDns`：`Resolve-DnsName -Server <routePlan.dnsServer>`，证明产品 DNS 自身有记录；
2. `nrpt`：默认 `Resolve-DnsName` 加 live NRPT metadata，证明 Windows namespace 路径；
3. `nodeGetaddrinfo`：Electron/Node 系统解析，作为最终应用层证明。

WinINet change notification 的 `Add-Type` 声明必须使用 PowerShell 5.1 可解析的普通字符串
或保留真实换行的 here-string。不能把 `@'`、声明正文和 `'@` 用空格拼成一行，否则覆盖
安装留下旧 PAC 时会持续出现 `UnexpectedCharactersAfterHereStringHeader`，PAC readback
永远无法进入 ready。

## V1/V2 Domestic DNS 共存

V1 与 V2 都由客户端直连 Domestic 的标准 DNS 端口，但使用不同的 WireGuard 地址：

- V1 HDO：`100.88.0.1:53`；
- V2 MX-H2I：`10.88.0.1:53`，只绑定该 V2 地址，再转发到当前 Internal authority
  `10.88.88.88:53`。

因此两个 `:53` 不冲突，也不得用“宿主机已有任意 53 listener”作为复用或跳过 V2 DNS
启动的依据。Internal 理论上可以使用任意双方一致且可达的端口，但当前线上只监听 53；
仅把 Domestic upstream 改成 50053 会直接导致查询失败。

CoreDNS 的 Corefile 采用单文件 bind mount 时，不能在宿主机用 `mv` 原子替换后只执行普通
`compose up -d`：运行中容器仍可能固定在旧 inode。配置 apply 必须精确
`--force-recreate --no-deps` DNS service 以重新挂载文件，并在报告成功前分别对配置的
bind/port 执行 UDP、TCP 查询，确认 `h2i.mxinfo-inc.cn -> 10.88.88.88`。
Internal K8s apply 同样不能只检查 Pod/Service：必须保留 Config Center 已发布的动态
ConfigMap，确认宿主机实际拥有 `10.88.88.88`，并直接向
`10.88.88.88:53` 做 UDP/TCP 查询。只有明确 NotFound 才能创建 baseline；RBAC、API 或
timeout 等不确定读取错误必须 fail closed，避免部署把动态 zone 覆盖成公网 fallback。

## Windows 公网应用、WinINet PAC 与 Clash

微信、豆包、Steam、浏览器图片等普通公网异常默认按 PAC/代理路径排查，而不是按 MX NRPT
排查。不同应用可能使用 WinINet、Chromium、自己的 resolver 或 socket，因此至少保留下列
同一时刻证据：

- Clash/mihomo 当前模式：TUN 或 system proxy，以及实际监听地址/端口；
- WinINet `AutoConfigURL`、`ProxyEnable`、`ProxyServer`、`ProxyOverride`；
- MX-H2I 当前 `/proxy.pac` 内容、`127.0.0.1:2053` local edge 和 PAC 中 fallback listener
  是否可达；
- 一个 MX internal hostname 和一个未命中 MX namespace 的公网 hostname 的 live
  DNS/HTTP 结果。

Windows 默认安装 MX-H2I PAC。Internal exact/suffix 固定先返回
`PROXY 127.0.0.1:2053`；unmatched 再按连接前的 live owner 处理：

- 无 owner 或 Clash TUN：`DIRECT`；
- 可读取、可编译的 loopback PAC：包装原 `FindProxyForURL`，但 Internal 规则优先；
- 没有可用 explicit PAC 时，live loopback 静态 proxy：
  `PROXY <listener>; DIRECT`；
- AutoDetect/WPAD 仅在它是唯一适用 owner、且不存在可表达的 live static/PAC
  continuation 时 fail closed；
- loopback PAC 初次连接失败时给旧客户端/Clash 一个短启动宽限期；仍无 listener 则按
  stale owner 跳过，不包装也不在断开时恢复，再继续选择 live static proxy 或 `DIRECT`；
- listener 存活但 PAC 返回错误、内容无效/不可编译，或 PAC 不是 loopback URL，以及无法
  表达的 static proxy：继续 fail closed，不修改 WinINet registry，也不报告 browser-ready。

MX-H2I 在 registry 中只拥有并回滚 `AutoConfigURL`，不会切换 `ProxyEnable` 或改写
`ProxyServer`/`ProxyOverride`。因此 Clash 静态 system proxy 仍可服务微信、Steam 等
不消费 PAC 的进程；浏览器则先执行 MX PAC，Internal 命中 `2053`，unmatched 再延续 Clash。
如果完全不写 `AutoConfigURL`，PAC 就无法约束浏览器，NRPT 也不能作为 Chromium Secure
DNS/DoH 的可靠替代；这种配置只能是 `tunnel-only` 诊断模式。

写入与恢复前会重读 `AutoConfigURL`、`ProxyEnable`、`ProxyServer`、`ProxyOverride`、
`AutoDetect` 并与协商快照比较，变化即 fail closed，写后还会 readback。这个 best-effort
CAS 能捕获普通模式切换，但 Windows registry 没有把跨进程“比较 + 写入”合成一个跨厂商
原子事务；不使用 Launcher lease 的 Clash 仍可能恰好在最后一次读取与写入之间变更。
watcher 会对检测到的新 signature 重新协商，但严格的双 owner 无竞态保证只能由单一
network broker（或双方共同采用同一 lease）提供。

显式 `MX_H2I_SYSTEM_PAC_FALLBACK_PROXY` / `MX_H2I_CLASH_PROXY` /
`MX_H2I_MIHOMO_PROXY` 仍可覆盖 fallback，但不是启用 Windows PAC 的前提，且 listener
同样必须 live。

当前诊断包自动采集 live NRPT、route、WinINet registry、关键 listener 和 WinHTTP proxy。
若实际 PAC 内容或 Clash 当前模式/动态端口未出现在包内，排障人员仍需现场同刻补采；
报告中不得把缺失字段写成“正常”。

Windows 验收必须覆盖连接前已开 TUN、静态 system proxy、loopback PAC、启动稍慢的 PAC、
stale loopback PAC、live-invalid/非 loopback PAC、WPAD、dead static listener，以及连接中
TUN ↔ system proxy、Clash 重启和端口变化。每 5 秒 tick
的常态路径只做 readback/`resolveProxy`/CONNECT 等只读验证；检测到新的外部 owner
signature 时允许触发一次有界重新协商，并可按结果写回 `AutoConfigURL`，同一 signature
继续存在时后续 tick 保持只读。每 30 秒可只读刷新 Clash listener/原 PAC 内容，并更新
内存中的 MX PAC 后发送 WinINet change notification，不改 registry。owner 状态变化、
重连或手动 repair 才可再次协商。

Windows 会监控非 loopback 网卡地址、掩码和 MAC 组成的网络签名。切换 Wi-Fi/有线网络后，后台只做无提权的 WireGuard、路由和 Internal API 探测，不会突然弹 UAC。用户点击“修复网络”后才执行提权修复：

1. WireGuard 服务未运行时先恢复服务；已运行时保留当前 peer。
2. 根据当前 WireGuard profile 重建 overlay routes。
3. 重建 split-DNS NRPT namespace，并校验目标 NameServers。
4. 执行 `Clear-DnsClientCache`，再探测系统 DNS、overlay route 和 Internal API。
5. 重新读取当前 WinINet owner，安全包装 live loopback proxy/PAC；不可安全包装则不写 registry。
6. 对 MX PAC 做 readback，再验证 Chromium `resolveProxy -> 2053` 和真实 CONNECT。

`network-unavailable`、`lease-only` 和 `tunnel-only` 是可恢复状态，不再被“已经连接”的重复请求保护拦截；用户点击“重新连接”会真正进入恢复流程。
该前台恢复只绕过当前这一个 connect operation 自身和后台失败 cooldown；并发 connect
仍被阻止。是否保留隧道以修复后的 live service probe 为准，不能继续使用点击前缓存的
`wireGuard.active`。
连接/恢复 busy 时，“停止本次连接/恢复”走独立 IPC，不受普通 action 锁阻挡。它会让当前
operation generation 失效、清除后续 recovery timer，并把自动恢复保持为 paused；不会清员工
token/identity、不会卸载 WireGuard、不会 restore PAC，也不会释放 lease。已启动的管理员进程
不能被应用强杀；若系统授权框已经出现，用户在系统窗口取消，子进程 settle 后 Launcher 只做
read-only reconcile，并记录 `networkOperation.cancelRequested/paused` 与本次 privileged stage。
下一次用户显式连接或修复才解除 paused。
若 live probe 仍确认 WireGuard service active，“重新连接”只允许原位修复
route/NRPT/PAC；修复未通过时保留现有隧道，不能继续进入 destructive restart。确需
restart 时先 Stop 并释放所有 `ServiceController` 句柄，再直接调用
`/installtunnelservice`，让 WireGuard 自己完成 delete/wait/create；只有显式断开才调用
`/uninstalltunnelservice`。这样避免 Windows 10/11 SCM 的
`ERROR_SERVICE_MARKED_FOR_DELETE` 竞态最终被误报为 `service=NOT_FOUND`。
`wireguard.exe` 是 Windows GUI subsystem 程序，PowerShell 5.1 直接调用后
`$LASTEXITCODE` 可能仍为空；提升权限脚本必须用
`Start-Process -Wait -PassThru` 并检查返回对象的 `ExitCode`，随后再以 live service
状态验证结果。空 `$LASTEXITCODE` 不能再被解释成 UAC 未授权。

## Windows 断开与正常退出

断开和正常退出共用严格 teardown：

1. 等待正在执行的 PAC 协商结束并保持 `2053` 存活；若 `AutoConfigURL` 仍是 MX PAC，
   恢复并 readback 核验最近一次成功协商捕获的 external value；若另一个 owner 已接管，
   保留其现值，只做 notification/readback；
2. 保持 `2053` 存活的同时停止 WireGuard，删除当前产品 owned NRPT 并 live 核验 cleanup；
3. 前两步成功后才关闭 `2053`、发布 `disconnected` 或退出进程。

PAC 恢复失败必须阻止断开/退出，并保持 `2053`；WG/NRPT 清理失败必须阻止正常退出并提供
repair。若 WireGuard 已被系统停止、但清理 readback 仍失败，PAC 不得重新指向不可用的
`2053`，界面必须明确显示清理未确认，不能把它当成成功 teardown。任何路径都不能留下仍
指向已关闭 `2053` 的 PAC。

## 启动状态对账与连接性能

磁盘里的 `connected` 只是上次运行快照，不是本次启动的 ready 证明。启动时必须与系统 WireGuard 状态对账：

- WireGuard 未运行时，所有 retained 状态都会刷新 `wireGuard.active=false`；旧 `connected/tunnel-only` 降为 `lease-only` 或 `idle`，并发布对应的 `staff/visit:disconnect / disconnected`。
- WireGuard 仍运行时，还要实时检查 route、Internal API 和平台 resolver。Windows 的
  platform resolver 证据是 live NRPT global/rules 加 namespace 内 hostname 的系统 DNS
  lookup，并且必须补齐 WinINet PAC readback、Chromium `resolveProxy` 和 CONNECT；
  macOS 是 live SystemConfiguration supplemental resolver + local DNS probe。全部通过才
  恢复 `connected`，否则保持 `tunnel-only/lease-only`。
- 真实员工 WireGuard 仍 active 时，`visit:connect` 只返回 `skipped / staff-active`，不抢占或重启员工数据面。
- 异常状态在访客页的主操作是“重新连接”，同时保留“清理旧连接”入口，不需要先进入员工页。

DNS/NRPT、PAC 和 endpoint-route 诊断不得阻塞 lease 申请。Windows 连接后的 live NRPT、
PAC readback、Chromium `resolveProxy` 与 CONNECT 是发布 browser-connected 前的有界
ready gate；system DNS proof 决定是否同时报告非 PAC 程序 ready。其它诊断在后台执行。
诊断返回时若连接已切换，结果会被丢弃，不覆盖新状态。

## 后台探测的证据分级

45 秒一次的后台 WireGuard 探测只能得出三种结论，必须区别对待：

1. **隧道确认在线，但 route / ownership / split-DNS 证据丢失**——真实的 split-brain，
   继续报 `connected` 会让流量泄漏，立即降级。
2. **隧道确认已断**——真实断线，按现有阈值降级。
3. **探测没能观察到隧道**——不是证据。

第 3 种在 Windows 上很常见：隧道状态查询要 spawn `wg` / `sc` / PowerShell，机器负载高或
杀软实时扫描时会超时，`getLauncherWireGuardPeerStatus()` 返回 `null`，probe 抛异常时
`wireGuardFailure()` 连 diagnostics 都是空的。历史实现把「没读到 ownership claim」当成
「ownership 丢失」，于是一次慢探测就绕过了连续失败阈值，直接把健康连接写成 `lease-only`。
`systemDomainProxyRuntimeEligible()` 随即返回 false，5 秒一次的 refresh watcher 把系统
PAC 撤掉，用户的 Internal 浏览直接断，要等下一次成功探测才恢复——现场日志里是
`system domain proxy restored while inactive: route-refresh` 连刷两分多钟，而同期
`wireguard-route-audit.log` 完全没有 route / NRPT 变更，隧道其实一直好的。

第二份现场诊断包（2.1.19）把「没能观察到」的具体形态钉死了：

```
"wireGuard": {
  "active": false,
  "serviceState": "RUNNING",
  "statusError": "spawnSync ...powershell.exe ETIMEDOUT"
}
```

`active:false` 与 `serviceState:"RUNNING"` 同时出现，是因为 `summarizeWireGuardStatus()`
在 `status.serviceState` 为 null 时回退到上一次的值。真正的原因是
`readWindowsTunnelMachineState()` 把 `Get-Service`、`Get-NetAdapter -IncludeHidden` 和
逐网卡的 `Get-NetRoute` 塞进同一个 spawnSync（5 秒超时）：只要网卡枚举慢，整个进程被杀，
决定性的 service answer 一起消失，返回值与「隧道确实停了」完全一样。

后果不只是标错状态。启动对账 `reconcileExistingWireGuardAfterStartup()` 用同一个
`status.active !== true` 去判断「孤儿隧道」，于是对一条完好的隧道跑了完整清理——
`wireguard-route-audit.log` 里是 `action=down`、`nrpt remove ownedMatches=10`、四条
route 被删掉，3.5 分钟后才 `action=up` 重新建立。这一段时间用户是真的断网。

规则：

- probe 结果带 `tunnelObserved`，由 `wireGuardStatusObserved()` 判定：status 为 null、
  或 `activeObserved === false`、或 `ok === false` 都算「没观察到」。
- `getWindowsWireGuardTunnelStatusByName()` 返回 `activeObserved`，取自 service 查询本身
  是否得到了答案。
- service 状态优先用 `sc.exe query`（不付 PowerShell 进程的代价），解析不出来才回退
  `Get-Service`；网卡/路由枚举拆成独立 probe，它慢或失败都不再吃掉 service answer。
- 启动对账在 status 未观察到时重试三次，仍然读不到就保留上次状态、既不清理也不降级，
  只记 `wireguard.startup-status-unobserved`。只有 pending cleanup 标记（上一次 teardown
  确实没做完的持久化证据）才允许在这种情况下继续清理。
- 证据丢失只有在 `tunnelObserved === true` 时才能绕过
  `WIREGUARD_BACKGROUND_PROBE_DOWNGRADE_THRESHOLD`；未观察到隧道的探测只累加失败计数。
- 缺失的 diagnostic 一律不等于丢失。`ownershipProofLost` 必须像 `routeProofLost` 一样先
  判断字段存在。
- 判定逻辑放在 `network-recovery-policy.cjs` 的 `preserveConnectedOnBackgroundProbe()`，
  由 `windows-reconnect-safety.test.mjs` 覆盖。

同一类问题的另一面是探测本身的开销：`captureWindowsState()` 每次后台 continuation
refresh 会并发 spawn 五个 `reg.exe`，2.5 秒的超时在负载机器上会被正常命中并被当作硬错误
上报（`system-domain-proxy.status-error`）。超时放宽到 6 秒；慢一次只是跳过下一个 tick，
`systemDomainProxyRefreshInFlight` 已经保证不会重入。

## 现场排查：Windows 探测耗时

怀疑某台机器是「探测太慢」而不是「网络真的断了」时，在该机器上直接跑：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\diagnose-windows-probe-latency.ps1 -Iterations 20
```

脚本以子进程方式重放 MX-H2I 真正会 spawn 的每一个查询（`Get-Service`、
`Get-NetAdapter -IncludeHidden`、`Get-NetRoute`、旧版的三合一脚本、`reg.exe query`、
WinINet `Add-Type`），输出 min/median/max 与各自的超时预算，并列出隐藏网卡数量、NRPT
规则归属和杀软信息。它只读不写，也不需要管理员。

判读：

- `Get-Service` 快而「combined」慢 → 网卡/路由枚举是瓶颈，正是本次拆分要解决的场景。
- 连空的 `powershell startup (baseline)` 都要几秒 → 问题在进程创建本身（杀软/EDR 扫描或
  磁盘争用），应为 MX-H2I 安装目录和它拉起的 powershell.exe 加排除项。
- 全部在预算内 → 加大 `-Iterations` 并在机器繁忙时复测，这个卡顿是间歇性的、跟负载走。

## macOS 长时间运行后切换网络

macOS 不使用 Windows NRPT。目标门禁要求 local edge 与只覆盖声明 Internal/app domain 的
SystemConfiguration supplemental resolver 都 live 后，suppressed interface DNS 才能算
ready；当前 suppression 布尔判定本身不是 prepared 证据，验收必须分别探测这两项。普通
公网域名继续走原系统 resolver。`/etc/resolver` 仅用于显式 fallback 或清理可识别的旧
状态，PAC 也不能替代 CLI/非代理应用需要的 supplemental DNS。

如果 Mac 未关机、未待机，直接从一个网络进入另一个网络，优先使用 MX-H2I 自带脚本：

```sh
electron-dock/mx-launcher/demos/mx-h2i/scripts/repair-macos-dns.sh
```

安装包中的位置是 `MX-H2I.app/Contents/Resources/repair/repair-macos-dns.sh`。脚本会先直接检查 `127.0.0.1:2053`：A 查询必须得到 IPv4，AAAA 查询不得错误得到 A；随后把被 parent suffix 覆盖的精确测试主机（默认 `h2i.mxinfo-inc.cn`）一并写入 `State:/Network/Service/com.qpjoy.electron-launcher.domain-proxy/DNS`，刷新 `dscacheutil` / `mDNSResponder` 缓存，再用 `dscacheutil` 的真实系统解析路径确认所有 IPv4 都命中 `MX_H2I_DNS_EXPECTED_TARGETS`（默认仅 `10.88.88.88`）。任意其它 `10.*`（包括 Luopan VIP 或客户端 lease）、V1 `100.*`、Clash `198.18.*` 都不算修复完成；routePlan 正式迁移后才应显式更新 expected target。

默认不会改动 V1 HDO 留下的 `/etc/resolver/*`。确认 HDO 已断开且 MX-H2I 应接管相同域名时，可显式运行：

```sh
electron-dock/mx-launcher/demos/mx-h2i/scripts/repair-macos-dns.sh --remove-legacy-hdo-resolvers
```

脚本只移动带 HDO 标记或 `100.88.0.1` 的旧 resolver 文件，备份保留在 `/var/tmp/mx-h2i-dns-repair-*`；不会删除无关 resolver。`--check-only` 只诊断。

应用内的自动检查也不再只看 resolver 配置是否存在，而是向本地 relay 发送真实 A/AAAA 查询。MX-H2I 对内部 IPv4 ownership 只在 A/ANY 查询中合成记录，AAAA 返回合法的 NOERROR/NODATA。这样可避免 macOS `getaddrinfo` 同时请求 A/AAAA 时被错误响应拖入超时。

若 `dig @127.0.0.1 -p 2053 <host> A` 已正常、`http://<host>` 通过固定 IP 也能返回 HTTP，但浏览器仍失败，应继续区分 HTTPS/HSTS 与 443 vhost：443 上的 nginx reset/证书/转发错误是 TLS 层问题，不是 split DNS 本身。

诊断包仍可能包含本机 IP、网卡、DNS 后缀和路由信息，只应发送给可信的排查人员。
