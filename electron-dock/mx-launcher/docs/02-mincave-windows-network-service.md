# MinCave Windows 安装时授权与网络服务

## 行为与部署范围

Windows 完整 NSIS 安装包改为所有用户安装到 Program Files。安装、完整升级、修复和卸载由安装器请求 UAC，安装 `MinCaveNetworkService`。Electron 主程序仍为 `asInvoker`；正常连接、断开、重连、修复网络和内置 Mihomo TUN 通过已安装的服务执行，不再在使用时启动 `RunAs` PowerShell。

飞书企业登录、MinCave 成员与角色准入保持在原有流程中，Windows 服务可用性检查位于准入之后、申请连接 lease 之前。macOS、Linux 和未注入此执行器的其他 Launcher 客户端沿用原有实现。Windows 当前仅支持 x64。

本次需要发布 **Windows 完整安装包**，不需要部署 Launcher 后端。旧 Windows 客户端必须先安装新完整包，不能仅发布这次 ASAR 给旧客户端；ASAR 无法注册服务、部署受保护资源或更新原生服务。后续使用相同服务协议的 UI 更新仍可走 ASAR。

ZIP 解压运行不负责安装服务；没有已安装的服务身份时客户端会提示安装／修复完整包，不会尝试运行旁边的服务程序或自动拉起 UAC。Windows 本地开发执行真实连接也需要先安装匹配版本的完整包。

内部 `appId`、`mx-h2i.exe`、WireGuard 配置名和用户数据目录保留，避免断开原有账号、设备身份、更新链和隧道归属。

## 安装内容与权限边界

- `Program Files/.../resources/network-service/MinCaveNetworkService.exe`：Go 编写的 LocalSystem SCM 服务，自动启动，异常退出由 SCM 重启。
- 同目录 `worker.cjs`：完整安装时构建的固定网络工作程序，使用已安装的 Electron `ELECTRON_RUN_AS_NODE` 执行。它从不加载 ASAR、下载的代码或用户指定的脚本。
- 同目录 `mihomo.exe`：从工作区 Windows 引擎构建资源复制，不接受调用方指定引擎路径。
- 同目录 `identity.json`：安装器写入的服务公钥，客户端用于认证服务。
- `ProgramData/MinCave/network-service`：服务身份私钥、资源哈希、网络归属、WireGuard 配置及 Mihomo 状态。保护 ACL 只允许 SYSTEM／管理员访问；拒绝重解析点及普通用户预置的状态目录或文件。

现有 endpoint 路由归属继续与其他 Launcher 共用 `ProgramData/QPJoy/WireGuard`；安装前验证文件所有者和 ACL，锁定此网络状态目录，执行前再次拒绝普通用户可写的共享状态，避免读取伪造的路由清理记录。不会清理其他应用登记的路由归属。

安装器记录最终落盘的 Electron、worker、WireGuard 和 Mihomo 文件哈希。服务启动校验，执行前检查文件身份、大小和修改时间，变更时重新计算哈希。ASAR 不在 SYSTEM 代码加载路径上。现有 electron-builder 的 EXE 签名流程也覆盖 `extraResources` 中的服务和引擎；发布签名仍取决于构建机已有的代码签名配置，哈希校验不能代替发行者证书。

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

WireGuard 配置被重新解析、重建：只允许既有企业网段 `10.88.0.0/16`、历史 `100.88.0.0/16` 至 `100.91.0.0/16` 及其更具体路由，企业 DNS 限于这些网段，NRPT 限于 `mxinfo-inc.cn` 和子域。不接受默认路由、配置钩子或任意系统操作。拓展网段或 DNS 域需要更新受信任服务资源，不能通过 ASAR 放宽。

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

产物仍在 `out/electron-builder`，使用 `MinCave-<版本>-win-x64.exe` 完整安装包安装。NSIS 安装位置固定，禁止改到用户可写目录。

专项检查：

```sh
pnpm check
pnpm check:windows-network
pnpm build:windows-service
cd native/windows-network-service
go test ./...
```

2026-11-16 本机验证：原有客户端检查通过（UI 62 项及原有安全回归），新增服务专项检查通过，涉及修改的 TypeScript 包构建通过；Go 协议测试、Windows x64 交叉编译与 Windows `go vet` 通过。使用临时预打包样本和 NSIS 工具集 1.2.1 成功编译安装／卸载钩子；它仅用于编译验证，不是可安装验收产物。macOS ARM 上默认旧 x64 NSIS 工具无法运行，因此这次编译验证临时指定了 ARM 兼容工具集，未改正式工具集配置。

尚未进行 Windows 实机测试，发布前必须完成：标准用户安装 UAC／取消 UAC、安装后主程序普通权限运行、真实飞书登录到连接、断开／重连／修复无额外 UAC、TUN 启停及模式切换、多 Windows 账号冲突、服务重启／丢失／超时、旧版升级、带活动连接升级与卸载清理。尤其需要检查实际 WireGuard 与 Mihomo 引擎在 Windows 上的服务权限及适配器行为。

实现依据：[Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[electron-builder NSIS](https://www.electron.build/nsis/)。
