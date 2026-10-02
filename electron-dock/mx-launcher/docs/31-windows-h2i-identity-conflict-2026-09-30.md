# Windows MX-H2I 身份与隧道不一致诊断（2026-09-30）

## 范围与结论

依据 `MX-H2I-diagnostics-2026-09-30_05-05-32-427-9c39ff`，客户端为 Windows 10 19045 x64、MX-H2I 2.1.19。时间戳为 UTC，换算北京时间加八小时。

本次不是单纯的 DNS 故障：两个 MX-H2I 安装身份争用同一组网络资源，同时 pending 身份切换、保存的租约和实际隧道地址不一致。导出时底层隧道仍可到达 Internal，但应用没有完成 ownership 与浏览器路径恢复。

本文件前半部分记录初次诊断，后半部分记录验证结果与客户端修复。用户随后确认：退出应用、检查隧道已停止并定向删除 `.14` 对应的旧 claim 后，连接恢复正常。

## 已确认的证据

| 项目 | 证据 |
| --- | --- |
| 当前安装身份 | `inst_mx_h2i_ecb97327c7224ff395eb315b1c4d7330` |
| 冲突的另一 MX-H2I 身份 | `inst_mx_h2i_b9bd17824a224251aef77e30d989af88` |
| ownership 冲突 | 9 月 29 日 09:26 和 9 月 30 日 05:04 等多次 `wireguard.not-ready`：同优先级 DNS zones 和相同 route CIDRs 被以上两个 owner 同时声明，connect-preflight 拒绝安装 WG |
| Luopan | 注册表列出 `luopan:compass`，但本次记录的 conflicts 全部发生在以上两个 MX-H2I owner 之间；不能据此归咎于 Luopan |
| pending 切换 | `feishu-staff-connect-1790673939175-b5a00796`，phase=`prepared`，旧 IP `10.89.0.18`，新 IP `10.89.50.15` |
| 实际 Windows 地址 | `windows-ipconfig-all.txt` 的 `mx-h2i` 是 `10.89.50.14`；`windows-route-print.txt` 中 Internal 路由也经此地址 |
| 应用保存的地址 | `summary.json` 的 connection.localIp 是 `10.89.50.15` |
| DNS / Internal | 导出时三层 DNS 探测均返回 `10.88.88.88`；10 条 owned NRPT 均 ready；WG 服务 RUNNING；应用记录 Internal API ready |
| 浏览器路径 | systemDomainProxy.applied=false，browserReady=false，错误为 Windows Internal 浏览器 PAC 尚未应用 |

实际地址既不是 pending 旧地址，也不是新地址，所以保留 pending、不自动 commit/abort 是正确的保护行为。连接状态中的所有 health 项 ready 也不能证明身份一致或浏览器路径 ready。

两个安装 ID 的来源尚未证实：可能涉及历史安装、数据目录或安装身份变化。诊断包缺少完整的 ownership claims、进程与数据目录映射、Internal lease/public-key 关联，不能将旧 owner 直接认定为可删除的孤儿。

## 为什么点击系统修复仍卡住

`main-runtime.cjs` 中网络修复可恢复 WG/NRPT，但 PAC/local edge 仍受 standalone ownership gate 保护。日志反复记录 `system domain proxy restored while inactive: route-refresh`，连接保留在 `tunnel-only`。DNS 正常不能解除安装身份冲突。

错误提示将 DNS 成功消息放在“WireGuard 尚未 ready”之后，掩盖真正的 ownership 阻塞。Windows 页面出现 macOS 权限框说明也是跨平台提示问题，不是 Windows 故障原因。

初次诊断时仓库 2.1.20 中，同产品 ownership 接管与 retained ownership 修复仅对 darwin 开启。下面的 Windows 修复尚未发布，不能仅凭已有版本号认为安装包已包含此修复。

另一个代码风险：`electron-core-wireguard/src/index.ts` 的 Windows status.addresses 来自配置文件；pending reconciliation 却把它标记为实际接口地址。本案有 ipconfig/route 的独立证据确认 `.14`，但后续实现必须区分配置地址与实时地址，不能只根据配置内容提交身份切换。

## 保留登录与当前网络的修复顺序

1. 停止连续重试连接、身份切换和系统修复；界面“停止后续恢复”仅暂停后续步骤。不要清除应用数据、安全存储、installation ID、lease capability 或整个 ownership 注册表。
2. 在故障机器本地备份 `%APPDATA%\MX-H2I` 和 `%APPDATA%\QPJoy\Electron Launcher\standalone-ownership.json`。这些文件可能含凭据，不要上传原始 runtime、WG 配置或私钥。
3. 只读核对两个 owner 的完整 claim、运行中的 MX-H2I 进程路径/数据目录，以及 Internal 中 `.14`、`.15`、`10.89.0.18` 对应的 lease、安装身份、公钥和 pending transition。保留 Luopan 的 claim。
4. 若 `.14` 属于当前应保留的有效身份：先将应用恢复到与该隧道匹配的身份/租约，再由 Internal 根据真实 peer 状态协调旧 pending；若应迁移到 `.15`，必须经完整 prepare → 应用新隧道 → 实际地址/路由/Internal 验证 → commit，之后才退役旧 lease。不能直接把本地 IP 改成 `.15` 或直接删 pending。
5. 只有确认另一 owner 已不再被活跃实例/租约使用，且已确定隧道归属后，才能通过带锁、核对旧 claim 快照的原子操作释放或接管该特定 claim。若旧实例仍运行，应先协调该实例正常释放，不能抢占。
6. ownership 一致后恢复 PAC/local edge，复核 NRPT、系统 DNS、浏览器代理路径及员工身份。完成后重新导出诊断确认 pending 已正确结算。

步骤 3 所需的完整关联证据不在当前诊断包中，因此目前没有依据提供可安全直接执行的删除 owner/pending 命令。当前健康隧道若需要替换，也不能承诺零瞬断；应先完成身份核对再决定迁移。

## 后续代码修复的边界与验收

- Windows 同产品旧 claim 恢复必须有进程、安装与实时隧道身份归属证明；保留跨产品冲突拦截，不能直接移除 darwin 平台限制复用接管逻辑。
- handover 使用实时网卡地址，读取失败、服务停止、双地址或第三地址时保留 pending；不能回退用配置地址提交。
- readiness 同时检查租约/实际地址一致、ownership、Internal、split DNS 与浏览器路径。诊断输出实际阻塞项，平台提示按系统显示。
- 回归覆盖：既有员工/飞书登录、guest→employee 切换、Luopan 共存、活跃旧 owner 拒绝接管、孤儿 owner 恢复、第三地址 pending 保留、DNS ready 但 PAC 未应用。
- 真机验收：实际 IP 与目标有效 lease 一致，ownership 无冲突，Internal 与 DNS/PAC 探测通过，现有员工登录保持有效，后台刷新不再反复撤销 PAC。

## 已实现：将验证有效的本地恢复纳入下次发版

本次只内置已验证的“停止后的旧 claim 清理”，不扩大为清除凭据、强停服务或手动提交 pending。以上实时地址用于 handover 的底层风险仍属于后续独立工作；本次不会绕过 pending 的保护检查。

入口：

1. **员工/匿名连接前**：Windows 原子登记 ownership 发生冲突时，自动检查残留 MX-H2I claim；满足下面条件才清理，然后重试登记一次。其他产品的冲突仍会拒绝连接。
2. **高级 → 网络恢复 · 保留登录 → 清理残留网络声明**：无需 PowerShell。保留当前 owner、auth、installation、密钥、lease capabilities、pending 和 Luopan 等其他产品声明。已连接时按钮禁用，主进程仍独立验证安全条件。
3. **修复网络**：复用同一恢复逻辑。若清理成功，暂停后续自动恢复并提示用原员工身份连接，避免直接重启属于旧身份的 `.conf`。若检测到残留声明但安全条件不满足，显示阻塞原因，不继续尝试修复该隧道。
4. **刷新/导出诊断**：新加入的 ownership 检查只读，记录候选 owner、进程/服务/网卡探测、阻塞原因和最近清理记录，不自动删除 claim。

安全条件：

- 仅 Windows，当前未连接，且没有竞争中的连接/恢复/断开操作；连接前检查仅允许自身的连接操作。
- 只选择其他 `mx-h2i` owner，`ownerId` 与 `instanceId` 一致，且声明了 `dataPlaneOwner=true` 和有效 IPv4 租约。
- 使用系统 Windows PowerShell 查询实时状态，不能以配置文件地址作为停止证明。
- 当前主进程必须存在；MX-H2I 当前进程树以外不能有另一个同名客户端实例。Electron 子进程不算另一实例。
- `WireGuardTunnel$mx-h2i` 不存在或已停止；不能存在 `mx-h2i` 网卡或匹配旧租约的实际 IPv4 地址。查询异常、超时、权限不足或格式不完整均拒绝清理。
- 在共享 ownership 锁内再次执行实时检查，并逐条比较候选 claim 快照。变化则拒绝；先写 `.before-repair-<uuid>.bak` 备份，再原子写回保留的 claims。备份失败不执行删除。

同时修正身份轮换：`rotateLocalLauncherIdentity` 保留既有 `ownershipInstanceId`，本地资源 owner 不随远端 installation/device/key 的轮换改变；已有用户不进行统一身份迁移或重置。

发布要求：本次新增底层 `pruneElectronLauncherStandaloneOwnershipClaims` API，需 Windows 全量包。旧基座如果只装了新 ASAR，手动清理会明确提示需要全量包，不能退化为直接改写文件。请递增正式发布版本后，在 Windows 执行 `pnpm make:win`；该命令已包含新增的只读 PowerShell 真机探测检查。

本地验证：新增测试覆盖只读诊断、活跃隧道/其他实例拒绝、超时拒绝、锁内状态变化、并发 claim 更新、备份、幂等性、当前 owner/Luopan 保留、真实连接前登记重试，以及 auth/key/capability/pending 不变。另跑既有 ownership 并发测试、飞书登录与 MX-H2I check。浏览器 mock 验证高级入口及已连接禁用状态；真实 Windows UAC、服务与升级后登录仍须在发版机验证。
