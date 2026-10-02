# 服务与部署：使用与接入

日期：2026-10-03。状态：界面、命令目录、受保护 API、独立执行器与安装程序已在本地实现并验证；开发验收未操作生产。用户提供的生产日志已显示独立执行器就绪和镜像构建继续，但尚不能据此确认整次生产 deploy 成功。用户确认 Launcher、Hub、Embedding、OCR 位于同一主机，项目根为 `/root/mx/workspace/de-llaaddddeerr/electron-dock`；OCR 已由用户验证可用。

## 1. 页面与操作

入口：**运行与维护 → 服务与部署**，或工作台的“服务与部署”快捷入口。

| 服务 | 已实现动作 |
| --- | --- |
| Launcher | 状态、最近 API 日志、发布前检查、部署当前检出版本 |
| Hub | 生产状态、API 日志、部署当前检出版本、显式 smoke 验收 |
| Embedding | 状态、资源用量、最近日志、GPU 诊断、部署、启动、重启、停止、模型验收 |
| OCR | 状态、资源用量、最近日志、GPU 诊断、部署、启动、重启、停止、OCR 验收 |

页面按照动作显示适用字段：项目目录、代理模式（沿用脚本配置/指定代理/本次直连）、代理协议/主机/端口，以及 Launcher 的临时目录、节点名称、API Server 地址、构建缓存上限与保留时间、更新原 Runner 开关；Embedding 部署提供沿用共享 GPU 开关。所有动作使用固定程序与参数目录，没有任意 shell 输入接口。

修改后实时生成命令，可直接复制到目标主机。浏览器草稿以当前 MX Server 地址隔离，切换地址清空当前计划、任务视图和连接状态，沿用原 Ops Token origin 保护。普通内部 HTTP 页面不具备 Clipboard API 时使用复制降级路径。草稿不保存 Ops Token、执行器 Token 或业务秘密。

“保存到主机”只持久保存部署参数，不修改业务 `.env`、启动或部署服务。在线执行的项目目录必须与安装时登记的真实路径一致；可修改目录用于命令预览，但不能借此在主机执行其他目录的脚本。运行中调整项目登记由主机管理员处理。

操作流程：选择实例与动作 → 修改参数 → 预检并生成计划 → 核对版本和影响 → 执行计划 → 查看任务与脱敏输出。读取状态不因 `exit 0` 就显示服务健康，尤其 GPU 脚本可能返回 `UNKNOWN`。日志为有限的最近 200 行快照，资源统计不会持续占用一个交互终端。

## 2. 随 Launcher deploy 自动安装、接入与更新

### 在 Launcher 界面重新部署自身

首次完整 deploy 成功、页面显示独立执行器已连接后，日常重新部署无需再到终端拼接命令：

1. 打开“运行与维护 → 服务与部署”，选择“MX Launcher → 部署当前检出版本”。
2. 首次核对主机目录、`127.0.0.1:7789` 代理、`/data/tmp`、节点/IP 和缓存参数，点击“保存到主机”；以后可复用已保存参数。
3. 点击“预检并生成计划”，核对 commit、命令与影响，确认后“执行计划”。代码/配置变更或计划过期时重新预检。
4. 在“执行任务”查看日志。Launcher API 更新可能使页面短暂断连，独立执行器继续运行；恢复后点击“查询原任务”，不重复提交部署。
5. 任务成功后再用“查看状态”核验，并按发布基线检查原登录与现有 H2I/Luopan 连接。

这是“重新部署主机已准备的版本”，不是“自动拉取最新分支”。当前没有 Git 拉取、网页选择发布版本或自动回滚功能；部署写操作要求干净工作区，commit 与配置在执行前复核。机器/集群/代理本身不可用或 Launcher 页面无法打开时，仍需原 CLI 作为恢复入口。

代理引导修复随本批脚本交付：BuildKit 镜像通过指定代理准备后只从本地启动，不触发 Docker 守护进程的第二次引导拉取；详见[构建代理说明](11-k8s-deployment-runbook.md)。该修复需先同步到服务器的检出目录才会用于下一次部署，不改变已经运行中的命令。

### 首次安装与后续更新机制

同步本批完整代码后，继续使用原来的 Launcher 命令，无需先手动安装执行器：

```bash
cd /root/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7789 \
bash scripts/manage.sh ops internal-production deploy
```

以上是使用说明，本轮没有执行生产命令。需要目标 Linux 主机有 Node.js 22+、systemd、flock、root/sudo 安装权限，以及原部署所需 Git、Bash、pnpm/Docker/kubectl/Python/GPU 工具。安装器不安装系统包，Node 路径需长期存在。

`deploy/cycle` 在原生产预检、节点与磁盘检查后，镜像构建和 API rollout 前调用安装器：

1. 首次将执行器及共享命令目录安装到 `/opt/mx-service-operations/releases/<SHA256>`，`current` 原子链接选择待启动版本。用独立 systemd 服务运行，与 Launcher API、native host runner 分离。
2. 首次生成权限为 600 的 `/etc/mx-service-operations/token` 和 `config.json`。从当前 Launcher 目录推导同级项目根，登记主机已有 Launcher/Hub/Embedding/OCR 项目；缺失的兄弟项目不阻止 Launcher 部署，也不自动部署它们。
3. 之后保留令牌、实例登记、保存的参数、计划、日志和任务。已有令牌丢失时要求恢复，不能静默换一套。已有主机地址和端口不随 LAN 检测结果覆盖。
4. 同版本重复部署只核对文件、开机启用与连接，不重启执行器。有新版本时先完整暂存，再由旧执行器停止接收新执行请求，等待所有已接收命令和结果落盘，然后自行退出，由 systemd 启动新版本。安装器不从部署子进程调用 `systemctl restart`。
5. 执行器承接 Launcher 的自部署时，安装器立即返回“待切换”，使这次部署继续完成；结果保存后才切换。待人工核对的写任务会保留锁并阻止切换，需先核对主机实际状态并记录结果。等待切换期间可以读取已有任务与日志；新命令暂不受理。
6. 空闲更新和首次安装会等待带令牌的就绪响应。随后幂等登记 `mx-internal-shadow/mx-service-operations` Secret；Namespace 首次不存在时创建。凭据经 stdin 传给 kubectl，不进入命令参数或输出。
7. 后续正常 Launcher rollout 读取新的可选 Secret 引用。执行器准备或 Secret 登记失败会让本次 deploy 停在镜像构建/API rollout 之前，不报告部署成功。此前原流程已执行的主机、网络预检/恢复不会自动回滚。

安装并发使用 Linux `flock`，进程结束或主机重启自动释放。执行器更新自身不重放业务任务；旧版本发布目录暂保留用于排查，不自动回退代码或回滚数据库。异常崩溃/断电仍走任务核对流程，不能把它当作正常排空更新。

| 配置 | 默认与重复部署行为 |
| --- | --- |
| `MX_SERVICE_OPERATIONS_INSTALL` | `1`。设为 `0` 跳过本次安装/更新和 Secret 登记，保留现有服务与 Secret；不停止执行器 |
| `MX_SERVICE_OPERATIONS_BIND` | 首次默认使用生产部署检测的主机 LAN IPv4（上述命令为 `192.168.1.2`）；后续沿用已有值 |
| `MX_SERVICE_OPERATIONS_PORT` | 首次默认 `19290`；后续沿用已有值 |

对已有安装显式传入不同 bind/port 会报错，请由主机管理员安排连接配置迁移后再部署，不静默覆盖。端口须对 Launcher Pod 可达，并限定可信管理网络；安装器不改防火墙或证书。在页面应用原 Internal Ops Token 后点击“刷新执行器与任务”。短暂切换断线时查询原任务，不另建部署；新版本会拒绝旧执行器生成但尚未执行的计划，需重新预检。

独立安装命令仍可用于准备主机或排查，本身不滚动四个业务服务：

```bash
sudo node server/scripts/service-operations-install.mjs \
  --workspace /root/mx/workspace/de-llaaddddeerr/electron-dock \
  --bind 192.168.1.2 --port 19290 --connect-k8s
```

若旧执行器不支持安全更新接口或暂不可达，安装器保留旧进程并报错，不强制杀掉任务。非 Kubernetes 环境可在 Launcher 服务端配置 `MX_SERVICE_OPERATIONS_URL` 和 `MX_SERVICE_OPERATIONS_TOKEN`；它们不进入浏览器。当前 Kubernetes 接入对应固定生产命名空间 `mx-internal-shadow`。Secret 未配置时原登录/业务 API 仍可运行，新执行入口显示未接入。

## 3. 计划、版本和任务持久化

计划有效期为 5 分钟，固定服务实例、动作、参数、代码 commit、工作区变化摘要、关键运行配置/凭据的摘要和已保存配置版本。执行前再次核验，变化后拒绝旧计划。部署/启停等写操作要求干净的 Git 工作区。指定 commit 字段是校验条件，不是自动 checkout；当前实现部署已经准备在主机目录中的版本，不自动拉取远端分支、切换代码、回滚数据库或重建账号。

`planId` 同时是幂等键；重复请求返回同一个任务。操作、主机配置、日志分别写入 `/var/lib/mx-service-operations/{operations,profiles,plans}`，目录权限 700。每个任务最多保留最近 128 KiB 脱敏输出，界面列出最近 30 个任务；任务元数据保留在主机。暂未实现长期日志归档/保留策略，需按现有磁盘监控管理该目录。

部署、启停、构建预检和模型验收使用单主机互斥锁；状态、日志等只读操作仍可查询。Launcher API 或原 native host runner 重启不终止这个独立 systemd 服务。API/网页断线后查询原任务，不能把网络错误当执行失败并创建新的部署。

状态为 `queued/running/succeeded/failed/needs_reconciliation/reconciled`。执行器自身中断、命令超时或结果不确定时，写任务锁保留，重启后不会自动重放。操作者可先执行只读状态/日志查询，核对实际主机后填写记录解除阻塞；`reconciled` 不篡改原命令为成功。命令失败不会触发自动回滚。机器重启、断电和跨机恢复仍属于后续恢复编排，不由这个执行器冒充完成。

现有主机 CLI 与管理员手动 Git/配置修改不受本执行器任务锁控制。运维执行期间不要并行改同一工作区或使用终端部署同一实例；部署中的执行器更新已使用上述排空机制。版本与配置检查在启动前进行，不是文件系统快照隔离。

## 4. 四个服务的实际边界

- Launcher：保留用户提供的节点、地址、`TMPDIR=/data/tmp`、2GB/24h 构建缓存、7789 代理预填。明确 `MX_INSIGHT_HUB_DEPLOY=0`，不联动部署 Hub。状态动作不继承部署的 endpoint 修复参数。完整 deploy 仍会执行原迁移、API rollout、网关收敛，不能承诺全部会话/VPN 零中断。
- Hub：使用 `ops internal-production` 命令族，明确 `MX_INSIGHT_SYNC_LAUNCHER=0`。显式 `MX_INSIGHT_BUILD_PROXY`（包括空值表示本次直连）优先于 `.env.internal`。没有新增通用 Hub 重启按钮，不把完整部署标成无影响重启。
- Embedding：保持现用共享 GPU 的显式 `--keep-gpu` 部署；普通 start/restart 仍执行严格 GPU 检查，可能拒绝共享实例。代理必须容器可达；不能复用宿主机回环地址。维护影响 Hub 向量化/RAG，不联动重启其他服务、修改预算或启动历史向量化。
- OCR：保留 GPU UUID/归属保护；部署、停止、重启可能丢失内存异步队列与结果，需先停提交并收集结果。显式 PROXY 优先于既有 `.env`。统一 `stats` 入口修复了旧上游缺失 `cmd_stats` 的问题，使用已有 OCR 标签限定容器、`docker stats --no-stream` 和 `nvidia-smi` 读取用量。

GPU 部署的旧人工 `yes` 提示继续适用于普通 CLI。执行器在有效计划获确认后注入限定应用与 UUID 的 `MX_BASE_DEPLOY_APPROVAL`，只替代这个提示；不跳过 GPU、存储、健康或所有权检查。复制出的普通命令仍走原交互确认。

## 5. 验收与未覆盖范围

本地已验证：

- Desktop build、原 UI 兼容测试、新命令目录测试；四服务命令、代理/路径/switch、非法值与 shell 转义。
- Server 类型检查、Ops Token 入口和固定目标代理；执行器本机临时 Git 仓库测试覆盖版本与配置变化、过期计划、幂等、写互斥/读并发、持久记录与人工核对。
- 临时真实 Bash 子进程验证环境隔离和分块日志脱敏；GPU 替身验证机器计划授权不跳过 GPU 检查；OCR 代理优先级与有限资源统计。
- 安装器隔离测试覆盖首次/重复安装、缺失兄弟项目、令牌/配置/任务保留、空闲升级、忙时延迟切换、就绪/Secret 失败；Bash 替身验证接入顺序、开关和失败停止。真实本机 Node 子进程验证版本软链接启动、已有任务完成后以状态 75 退出、新版本读回原结果且不重放；systemd/kubectl 均为替身。
- Hub 原部署脚本行为测试，追加自定义代理、显式直连和沿用配置三种模式。
- 浏览器使用本机 Playwright（Browser plugin not available），1440×1000 / 390×844：真实 DOM 表单、复制及 HTTP 降级、草稿、保存、旧计划失效、影响确认、过期禁用、模拟任务日志、断线查询原任务、切换服务器隔离。无页面异常；只访问本地隔离服务，503 和断线为主动注入的故障。

没有连接生产，没有真实部署、停止或重启 Launcher/Hub/Embedding/OCR，没有修改 Luopan 实际产品、SDK、用户、租户、凭据或 VPN 配置。Linux systemd 实际托管、Pod 到执行器端口连通、真实 GPU/集群与原 H2I/Luopan 连接保持仍需目标环境验收。本次不包含邀请注册、SSO、证书自动续期、备份恢复、制品仓库版本选择或总 deploy；这些继续按 [分阶段验收](35-platform-implementation-and-acceptance.md) 推进。
