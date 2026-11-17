# MinCave Windows 安装时授权与网络服务

## 行为与部署范围

Windows 完整 NSIS 安装包使用所有用户安装，默认安装到 Program Files，保留目录选择页，允许选择其他本地固定磁盘上的 NTFS/ReFS 目录（例如 `D:\Apps\MinCave`）。安装、完整升级、修复和卸载由安装器请求 UAC，安装 `MinCaveNetworkService`。Electron 主程序仍为 `asInvoker`；正常连接、断开、重连、修复网络和内置 Mihomo TUN 通过已安装的服务执行，不再在使用时启动 `RunAs` PowerShell。

飞书企业登录、MinCave 成员与角色准入保持在原有流程中，Windows 服务可用性检查位于准入之后、申请连接 lease 之前。macOS、Linux 和未注入此执行器的其他 Launcher 客户端沿用原有实现。Windows 当前仅支持 x64。

本次需要发布 **Windows 完整安装包**，不需要部署 Launcher 后端。旧 Windows 客户端必须先安装新完整包，不能仅发布这次 ASAR 给旧客户端；ASAR 无法注册服务、部署受保护资源或更新原生服务。后续使用相同服务协议的 UI 更新仍可走 ASAR。

ZIP 解压运行不负责安装服务；没有已安装的服务身份时客户端会提示安装／修复完整包，不会尝试运行旁边的服务程序或自动拉起 UAC。Windows 本地开发执行真实连接也需要先安装匹配版本的完整包。

内部 `appId`、`mx-h2i.exe`、WireGuard 配置名和用户数据目录保留，避免断开原有账号、设备身份、更新链和隧道归属。

## 安装内容与权限边界

- `<所选安装目录>/resources/network-service/MinCaveNetworkService.exe`：Go 编写的 LocalSystem SCM 服务，自动启动，异常退出由 SCM 重启。
- 同目录 `worker.cjs`：完整安装时构建的固定网络工作程序，使用已安装的 Electron `ELECTRON_RUN_AS_NODE` 执行。它从不加载 ASAR、下载的代码或用户指定的脚本。
- 同目录 `mihomo.exe`：从工作区 Windows 引擎构建资源复制，不接受调用方指定引擎路径。
- 同目录 `identity.json`：安装器写入的服务公钥，客户端用于认证服务。
- `ProgramData/MinCave/network-service`：服务身份私钥、资源哈希、网络归属、WireGuard 配置及 Mihomo 状态。保护 ACL 只允许 SYSTEM／管理员访问；拒绝重解析点及普通用户预置的状态目录或文件。

现有 endpoint 路由归属继续与其他 Launcher 共用 `ProgramData/QPJoy/WireGuard`；安装前验证文件所有者和 ACL，锁定此网络状态目录，执行前再次拒绝普通用户可写的共享状态，避免读取伪造的路由清理记录。不会清理其他应用登记的路由归属。

服务工作进程的受限环境必须包含 `ProgramData`：从 Windows 已知文件夹得到的受保护状态目录推导，不能继承客户端提供的值。缺少此变量会导致 NRPT 脚本的 `Join-Path $env:ProgramData` 在创建 WireGuard 隧道前失败。2026-11-17 修复此遗漏；需要重新构建并安装 Windows 完整包来更新原生服务，ASAR 更新无法修复。

安装器记录最终落盘的 Electron、worker、WireGuard 和 Mihomo 文件哈希。服务启动校验，执行前检查文件身份、大小和修改时间，变更时重新计算哈希。ASAR 不在 SYSTEM 代码加载路径上。现有 electron-builder 的 EXE 签名流程也覆盖 `extraResources` 中的服务和引擎；发布签名仍取决于构建机已有的代码签名配置，哈希校验不能代替发行者证书。

### 自定义目录与升级

安装器在清理旧安装和写入新文件之前运行内嵌的固定目录校验程序。所选路径通过环境变量传递，不拼接成 PowerShell 代码；仅加载系统 PowerShell 模块。允许新建空应用目录，或使用现有 MinCave 目录，不接管无关的非空目录。

安装目录及所有祖先不能是链接、junction 或重解析点。现有路径所有者必须为 SYSTEM、Administrators 或 TrustedInstaller；祖先不能允许普通用户修改权限、属性或删除子目录。允许普通用户在祖先中新建文件夹，但安装目录本身只授予普通用户读取与执行，SYSTEM/管理员可修改。安装器只保护新建路径和 MinCave 目录，不更改磁盘根目录或其他现有父目录的权限。不满足条件时停止并提示更换目录。因此，普通用户可随意修改的下载/桌面目录、网络盘、FAT/exFAT 和权限过宽的磁盘或父目录不支持直接安装此系统服务。

服务启动时再次检查磁盘能力、路径链及整个安装树的 ACL，覆盖 Electron DLL 和支持文件，替代旧的 Program Files 字符串限制。升级沿用 electron-builder 已有安装目录记录；更新时沿用原有文件迁移/失败恢复逻辑，并保留安装根目录及其 ACL。完整卸载仍删除安装目录。首次迁入其他盘符、覆盖升级和卸载需要 Windows 实机验收。

## IPC 与操作限制

本地命名管道为 `\\.\pipe\MinCave.Network.v1`。拒绝远程管道连接。服务从实际管道客户端 PID 确认其映像为安装目录中的 `mx-h2i.exe`，并从进程令牌读取 Windows SID 和交互会话；请求体不能指定 SID。

客户端使用安装器写入的公钥验证 Ed25519 签名，签名绑定随机 nonce、双方临时 X25519 密钥、Windows SID 与服务版本。业务请求和响应通过 AES-256-GCM 加密、认证，每个连接只处理一个请求；防止其他本机进程冒充同名管道获取网络私钥或订阅。请求与响应使用不同 AAD；帧上限 2 MiB，配置另有更小限制。

只开放以下操作，不接受任意命令、PowerShell 文本、可执行文件位置、配置文件位置或任意 PID：

| 操作 | 允许范围 |
| --- | --- |
| capabilities | 只读服务版本和能力 |
| wireguard | 固定 `mx-h2i` 接口的 up/down/restart/repair |
| mihomo.start/reload | 校验后写入服务自己的固定配置 |
| mihomo.stop/status | 仅服务登记且路径、PID、启动时间均匹配的引擎 |
| mihomo.api | 版本、节点、连接查询及选定节点；不转发任意 API |

WireGuard 配置被重新解析、重建：只允许客户端既有企业网段 `10.88.0.0/16`、`10.89.0.0/16`、`10.90.0.0/16`、历史 `100.88.0.0/16` 至 `100.91.0.0/16` 及其更具体路由，企业 DNS 限于这些网段。NRPT 限于客户端默认的 `mx.cn`、`mxinfo-inc.cn`、`internal.mx`、`corp.mx`、`h2i.mx` 及各自子域。不接受默认路由、其他私网或公网网段、公共 DNS 后缀、配置钩子或任意系统操作。拓展网段或 DNS 域需要更新受信任服务资源，不能通过 ASAR 放宽。

2026-11-17 现场诊断显示员工 lease 已分配，但服务返回“网络配置字段超出允许范围”，WireGuard 状态为 `NOT_FOUND`。原因是新增服务错误地只接受 `10.88.*`，与产品现有飞书地址池 `10.89.0.0/16` 不一致；同时漏掉客户端其他默认 split-DNS 域。修正固定白名单以匹配这些现有配置，保留其余校验。回归使用核心库实际渲染的合成员工配置（无真实密钥），覆盖各既有网段、实际默认域名以及邻接网段、过宽路由、公网 DNS 和脚本指令拒绝。修复前两个兼容用例均失败，修复后专项检查 16 项通过、1 项 Windows PowerShell ACL 用例在 macOS 跳过；Windows x64 服务构建通过，生成的受保护 worker 也已单独验证接受员工配置并拒绝默认路由。尚未验证 Windows 实际隧道连接。该修改位于完整安装部署的受保护 worker，需要重新构建并安装 Windows 完整 EXE；不需要后端部署，ASAR 不会替换此 worker。

Mihomo 重建监听、控制密钥、TUN 选项和 provider 缓存路径；仅回环监听，控制密钥不交给 UI。不接受文件 provider、外部证书／密钥路径、脚本、任意监听器或 SSH 文件凭据。HTTP provider 的文件位置由服务生成。每次控制请求校验端口所属 PID，不跟随 HTTP 重定向，限制响应大小。

一个 Windows SID 同时拥有服务网络状态；其他 Windows 账号必须等原账号断开。旧 WireGuard 移交需 SCM 登记配置文件的所有者 SID 和私钥同时匹配。只读取旧配置证明身份，将校验后的配置放入受保护目录，用固定引擎和受保护脚本清理旧隧道及其路由归属；绝不执行用户目录中的配置钩子或脚本，不按进程名清理其他 VPN。旧版独立提升的 Mihomo 必须先在旧客户端停止，新客户端不会通过临时提权接管它。

服务串行处理网络操作。工作程序在运行前被加入 Windows Job；失败、超时或服务异常退出时终止该 Job 内的进程树，防止 PowerShell 在已返回失败后继续修改系统。成功记录的 TUN 才允许持续运行。无法确认进程树已退出时拒绝后续变更，要求重启电脑。调用超时不自动重试；先确认当前状态。

## 升级、卸载与回退

完整升级先停止服务接收请求、等待正在执行的操作完成，清理自身 WireGuard／NRPT／路由及 TUN，释放被占用的旧引擎文件，再替换资源、更新哈希并启动服务。升级会短暂断开网络，保留服务身份和客户端账号数据。

完整卸载先清理自有网络，再删除 SCM 注册和服务状态。清理或停止失败时中止卸载，避免先删可执行文件而留下系统网络状态。用户数据是否保留沿用已有安装器策略。

首次从旧版升级前退出旧客户端，并停止其内置 TUN。若已有旧 WireGuard 仍运行，仅在归属证明匹配时移交；无法匹配时先在旧客户端断开。回退使用完整安装包：先正常卸载新版本（完成服务清理），再安装已确认的旧完整包，不用 ASAR 替换原生服务。回退会断网，需重新登录／连接。

## 构建与验证

构建机需要已有 Node/pnpm 依赖及 **Go 1.26+**；最终用户不需要 Node 或 Go。`beforePack` 自动运行 Go 协议测试、交叉编译服务、打包独立 worker 并复制 Windows Mihomo 引擎。

```powershell
cd electron-dock/mx-launcher/demos/mx-h2i
pnpm make:win
```

产物仍在 `out/electron-builder`，使用 `MinCave-<版本>-win-x64.exe` 完整安装包安装。正常向导显示目录选择；静默升级也会校验目录。自定义目录功能需要重新构建完整包，ASAR 无法修改安装器或原生服务。

专项检查：

```sh
pnpm check
pnpm check:windows-network
pnpm build:windows-service
cd native/windows-network-service
go test ./...
```

2026-11-16 本机验证：原有客户端检查通过（UI 62 项及原有安全回归），新增服务专项检查通过，涉及修改的 TypeScript 包构建通过；Go 协议测试、Windows x64 交叉编译与 Windows `go vet` 通过。使用临时预打包样本和 NSIS 工具集 1.2.1 成功编译安装／卸载钩子；它仅用于编译验证，不是可安装验收产物。macOS ARM 上默认旧 x64 NSIS 工具无法运行，因此这次编译验证临时指定了 ARM 兼容工具集，未改正式工具集配置。

2026-11-17 自定义目录验证：`pnpm check` 通过；`pnpm check:windows-service` 13 项通过、1 项 Windows PowerShell ACL 策略用例在 macOS 跳过；Go 通用测试通过，Windows 专用 ACL 测试已交叉编译但未执行，Windows x64 `go vet` 和服务构建通过。相同临时预打包样本的安装／卸载 NSIS 编译通过。仍需 Windows 验证默认目录、D/E 盘安全目录、带中文/空格的路径、宽权限父目录拒绝、升级路径保留、文件占用时恢复及完整卸载；以上编译结果不能替代这些实机结果。

Windows 首次执行专项用例发现 `AceFlags -band AceFlags` 会抛出 `InvalidCastException`；这同时影响打包检查和安装器中的同一段目录校验。兼容修复对 ACE 标志、文件属性及访问掩码显式转换为整数后再进行位运算，保留原有权限拒绝规则。回归场景使用实际的 `FileAttributes` 枚举，并覆盖 `InheritOnly` ACE 和重解析点；本机 macOS 不能代替 Windows PowerShell 5.1 的实际执行，合入后需要在 Windows 重跑 `pnpm check:windows-service`。

覆盖安装／修复时，原实现复用新建服务的配置但遗漏 `ServiceType`。`mgr.CreateService` 会将零值补为 `SERVICE_WIN32_OWN_PROCESS`，`mgr.Service.UpdateConfig` 则直接传给 `ChangeServiceConfig`，零值会导致 Windows 返回“参数错误”。修复显式设置独立进程类型，供首次注册与更新共同使用；保留 LocalSystem、自动启动、依赖及现有身份。增加不修改系统的 Windows 配置回归检查，防止再次依赖仅新建接口提供的默认值。[Windows API 契约](https://learn.microsoft.com/en-us/windows/win32/api/winsvc/nf-winsvc-changeserviceconfigw)。

安装器捕获服务程序的错误输出，并在失败弹窗与安装详情中显示原因，不再只有返回码。原生服务错误包含安装阶段（例如 `prepare-shared-endpoint-registry`、`register-service`、`start-service`），路径校验失败包含实际路径；不会输出身份私钥或网络配置内容。这是诊断能力改进，不代表所有安装失败都已修复。2026-11-17 本机验证：服务专项检查 13 项通过、1 项 Windows PowerShell 用例跳过；Go 通用测试、Windows x64 构建与 `go vet`、NSIS 样本编译通过；Windows 配置回归检查仅交叉编译，尚未在 Windows 执行，也未验证实际失败弹窗。

排查时必须在安装失败的电脑上检查。已有服务程序不带参数运行时只校验安装路径，然后提示通过 Windows Service Control Manager 启动；该提示属于预期行为，不能作为安装失败原因。需要重试安装并读取实际错误时，由管理员显式运行已安装的固定服务程序 `install` 命令并重定向标准错误；不要删除共享状态或放宽目录权限来绕过校验。

尚未进行 Windows 实机测试，发布前必须完成：标准用户安装 UAC／取消 UAC、安装后主程序普通权限运行、真实飞书登录到连接、断开／重连／修复无额外 UAC、TUN 启停及模式切换、多 Windows 账号冲突、服务重启／丢失／超时、旧版升级、带活动连接升级与卸载清理。尤其需要检查实际 WireGuard 与 Mihomo 引擎在 Windows 上的服务权限及适配器行为。

实现依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[electron-builder NSIS](https://www.electron.build/nsis/)。
