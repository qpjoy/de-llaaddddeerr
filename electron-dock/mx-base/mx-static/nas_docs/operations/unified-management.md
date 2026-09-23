# NAS 统一管理、部署配置和重启恢复

**2026-09-24 现场更新：** infra 后续重建遗漏 NAS 覆盖，当前实际在 SSD，恢复被配置漂移阻止。本页“同版本重建/清理”不能用于绕过该阻止；旧 override 含旧镜像，不可直接用于新版本恢复。先读 [当前差异与重启/重装防回退要求](no-ssd-fallback.md)。

**更新：** 默认中文易读显示；推荐 `nas recovery check` 和 `nas recovery enable --migrated` 管理全部已成功迁移且审核登记的项目，保留单项目暂停例外，参见 [统一恢复模式](readable-recovery.md)。本页逐项目命令继续兼容，但不必逐个 enable。

后续已加入 host / project / task 二级入口及 infra 权限、发布审查、私有审计；见 [NAS 管理结构](nas-platform.md) 与 [安全约定](../SAFETY.md)。本页旧命令仍兼容。

本轮按用户选择：**配置和运维集中在 mx-static；po-infra 不修改。** 入口为：

```bash
bash scripts/manage.sh nas
```

NAS 子命令在静态服务器的 Node、`.env`、容器逻辑之前分发，服务器只需现有 Bash、Python 3.6+、Docker/Compose、systemd 等工具。无需启动 mx-static 静态服务，也不执行业务数据库 migration。

## 当前覆盖文件在哪里

9 月 22 日成功切换使用的完整覆盖文件是（当前容器已遗漏它）：

```text
/var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1/compose.nas.override.json
```

这是切换准备时在服务器生成的持久文件，原来既不在 po-infra Git 中，也不在 mx-static checkout 中。它包含当时固定的镜像 ID、安全 Web 启动命令、Worker 恢复开关，以及 NAS 子挂载。报告内其他私有文件可能有环境凭据，不提交整个报告到 Git。

现在由 mx-static Git 中的声明统一登记：

- `deploy/nas/profiles.json`：part1 / part2 的 Compose 项目、卷名、成功报告和已核对的回收清单路径。
- `deploy/nas/mx-static-nas-boot.service` / `.timer`：持久开机恢复单元，安装脚本从 Git 模板生成服务器文件。
- `deploy/nas/part1.storage.json`：十个媒体消费者的 NAS 子卷声明，gateway 只读、所有消费者 nocopy；不包含凭据或固定镜像。管理器会核对它与已成功应用的完整覆盖文件一致。

运行时完整覆盖仍保留在原报告目录，统一入口自动携带，不再要求操作者记住路径。Git 保存声明和工具，服务器保存实际执行证据，两者通过登记和校验关联；不要手动移动/删掉报告。`locate` 一次列出它们：

```bash
sudo bash scripts/manage.sh nas locate part1
sudo bash scripts/manage.sh nas status part1
sudo bash scripts/manage.sh nas compose part1 config-check
```

`status` 只读取 Docker 元数据、本机内核挂载表和 SSD 空间，不遍历 NAS，不能据此声称 NAS 硬盘/RAID 健康。历史迁移记录与当前挂载分别显示。`nas infra storage check` 独立检查当前容器，不依赖旧 `.env` 哈希；不匹配或无法确认返回 1，但不拦截外部发布。`locate` 和日志、暂停自动恢复在 Docker 暂不可用时也可使用。

## 日常命令

| 操作 | 命令尾部（前面统一为 `sudo bash scripts/manage.sh nas`） | 边界 |
| --- | --- | --- |
| 第一/二卷状态 | `status part1` / `status part2` | 包含迁移/业务验收/回收记录；不修改业务 |
| 找到文件与服务 | `locate part1` / `locate part2` | 输出受登记管理的路径与卷名 |
| 追踪日志 | `logs part1` / `logs part2` | 第一卷同时包含旧迁移单元和开机恢复日志 |
| 开机准备检查 | `boot-check part1` | 不模拟断线、不重启主机；核对配置、登记容器和数据库健康 |
| 完整 Compose 检查 | `compose part1 config-check` | 自动带 NAS override；不输出完整环境变量 |
| Compose 状态 | `compose part1 ps` | 自动带 NAS override |
| 补启动 | `recover part1` | 新建临时单元，只启动已登记且停止的 NAS 媒体容器；不重建/同步/删除 |
| 同版本重建 | `redeploy part1 --maintenance` | 维护窗口：优雅停十个媒体消费者，使用相同固定镜像和 NAS override 重建，登记新 ID，恢复并检查；DB/Redis 不重建 |
| 再次生成清单 | `plan part1` | 只读；不会自动选择新清单用于删除，仍使用 Git 明确登记且已审核的清单 |
| 回收旧 SSD | `reclaim part1 --business-accepted` | 须业务验收通过；复用已测试的限定清单清理工具 |
| 第二卷复制 | `copy part2 --unlimited` | 在线预复制、不停业务，不自动切换或删除；无该选项沿用复制脚本默认限速 |

本次不提供 `reboot` 系统重启命令。重启演练需要独立维护窗口；`boot-check` 的成功不能替代真实演练。第一卷已经切换，重复 `copy/prepare/cutover part1` 会在创建新任务前拒绝。第二卷目前只有审计、定位、预复制能力；切换/回收入口拒绝将第一卷参数套用到 delta_59202。

耗时操作自动使用唯一名字的 `systemd-run` 临时单元，避免 SSH 断开和同名失败任务冲突，输出实际 unit 名。复制/切换/清单单元对 `/data` 只读；回收单元需要写 SSD，对 `/mnt/nas` 只读。全局迁移锁防止本工具的迁移、清理和恢复同时操作；它不约束任意管理员命令。

## 业务程序需要做什么

本次存储切换不需要应用改路径、改 Dockerfile、执行 migration 或启动 mx-static 静态服务器：容器内仍使用 `/app/media/data_hub_raw_media`。业务负责验收旧媒体、新上传/采集、任务结果；网络、存储挂载和容器编排由平台与运维管理。应用连接数据库/队列的重试、任务幂等性仍是应用职责，systemd 无法替代。

**以后不能直接用缺少 NAS override 的原 `docker compose up` 或 po-infra 原发布脚本。** 本地审查发现原发布脚本有数据库迁移、后台任务恢复、递归修改整个 `/app/media` 权限等动作，且不会自动加载本次 NAS 覆盖。按用户要求不修改 po-infra，因此统一管理入口是约定的操作方式，无法阻止 root 绕过入口直接运行其他命令。

`redeploy` 只处理当前登记版本，不拉镜像、不构建、不进行应用版本升级；固定镜像与安全启动覆盖不会悄悄恢复成原 Web 初始化。它会优雅等任务退出，不因超过 10–30 分钟就强杀；长任务可能延长维护。失败后保留现场，不自动 SSD 回滚；未能完整登记的新容器集合需根据日志处理。

正式升级业务版本、修改 Compose/env 或更换数据库容器时，需要在 mx-static 明确审查新部署，更新登记和恢复基准。当前身份/配置发生漂移时管理器会停止，而不是静默接受；本轮没有实现通用多版本发布系统。

## 重启和短暂断线：分别由谁处理

| 场景 | 当前责任与行为 |
| --- | --- |
| SSH 连接断开 | 之前的 `systemd-run` 任务由 systemd 继续管理，不依赖 SSH 会话 |
| 主机重启 | 临时迁移任务不会变成开机服务，不自动重新复制或删除；容器原来的 Docker restart policy 负责常规恢复 |
| 容器启动前 NAS 未就绪 | Docker 原生 NFS volume 无法挂载时拒绝正常启动，不能退回 SSD 空目录；原生 restart policy 不保证首次挂载失败之后一直重试 |
| 运行中 NAS 短时断线 | Linux `hard` NFS 客户端重试未完成的请求；NAS 回来后通常继续。恢复可能需要重传等待，并非网络恢复瞬间所有请求立刻完成 |
| 容器仍 running 但 I/O/健康异常 | 不自动 kill/restart，不 soft 挂载、不强卸载；观察内核/NFS 与应用日志，必要时人工处理 |
| 容器已退出 | Docker 原 restart policy 处理正常退出恢复；已登记的 `recover` 可补启动，保持相同容器和挂载 |
| 数据库/Redis 尚未健康 | 新的恢复入口等待它们由原平台启动且健康，不把这些 SSD 数据库绑到 NAS 上 |

依据：[systemd 239 transient units](https://raw.githubusercontent.com/systemd/systemd/v239/man/systemd-run.xml)、[Docker restart policy 的生效条件与限制](https://docs.docker.com/engine/containers/start-containers-automatically/)、[hard NFS 的重试语义](https://man7.org/linux/man-pages/man5/nfs.5.html)、[Compose 启动依赖](https://docs.docker.com/compose/how-tos/startup-order/)。

Docker 官方不建议将常驻宿主机进程管理器与 Docker restart policy 叠加。本方案只补开机阶段的启动失败，成功后退出、不持续监管/重启容器。启用意味着“这一套登记容器希望开机运行”：有意停业务之前应先 `auto-disable part1`，不能指望自动恢复识别任意手工 docker stop 的维护意图。

Docker daemon 本身启动时尝试挂载失败的容器仍可能有等待；本工具不增加全局 NAS 依赖，但不承诺所有宿主机服务完全不受底层等待影响。保留全局 `20-requires-nas.conf.bak` 禁用，不重启 Docker、不自动修改 fstab。容器使用 Docker 原生 NFS 子卷，恢复入口不依赖宿主机 `/mnt/nas` 的 fstab 挂载；迁移/复制/清理工具仍需要它。

## 安装持久开机恢复

兼容修复：EL8/systemd 239 不允许 oneshot + Restart，当前模板采用 `Type=simple`。install 在替换单元前调用服务器的 `systemd-analyze verify`；simple 的 active/running 代表恢复检查正在执行，成功后才为 active/exited。见 [故障与修复记录](systemd-239-recovery-fix.md)。

先同步本轮 mx-static 修改到服务器，查看登记并执行只读检查：

```bash
sudo bash scripts/manage.sh nas status part1
sudo bash scripts/manage.sh nas boot-check part1
```

安装和启用是明确独立动作：

```bash
sudo bash scripts/manage.sh nas auto-install
sudo bash scripts/manage.sh nas auto-enable part1
```

- `auto-install` 从当前 Git checkout 打包 Python 工具和无密钥 JSON 声明，按内容哈希安装到 `/usr/local/lib/mx-static-nas/<hash>/`，更新 `current` 指针；生成 `/etc/systemd/system/mx-static-nas-boot.service` 和 `.timer`，执行 daemon-reload。它不启动容器、不自动启用 timer。更新 Git 工具后再次执行此命令即可更新安装副本；不要手工编辑生成的 unit。
- 启用状态统一存在 `/etc/mx-static/nas/auto.json`。安装不覆盖已有启用选择。`auto-enable` 要求当前十个容器及数据库健康、登记匹配，再 `enable --now` timer。开机计时已超过 60 秒时，首次启用可能立即触发一次检查；健康容器不重启。
- Timer 在每次开机约 60 秒后触发一次恢复服务。服务按 `After=docker.service network-online.target` 排序；读取本地登记与 Docker 元数据，检查 NAS TCP 2049 可达后，只补启动缺失的既有媒体容器，Web/聊天→Workers→gateway→beat，并等待健康/运行状态。端口可达不等于 NFS 服务健康，真正挂载仍由 Docker 完成。
- 恢复失败由 systemd 每隔 60 秒重试；同一 unit 不并发启动。NAS mount/API 卡住时保持一次等待，不持续制造新 mount/start。成功后 `RemainAfterExit=yes` 保持 `active (exited)`，不循环巡检，也不因 NAS 后续短暂断线反复重启应用。
- 不补建被删的容器，不接受变更后的容器 ID/镜像/挂载，不重建数据库，不复制/删除，不改变业务验收或 SSD 回收记录。不读取原 SSD 媒体，因此清理旧文件后仍可使用。

查看、暂停或手动补启动：

```bash
sudo bash scripts/manage.sh nas status part1
sudo bash scripts/manage.sh nas logs part1
sudo bash scripts/manage.sh nas auto-disable part1
sudo bash scripts/manage.sh nas recover part1
```

`auto-disable` 在逐项目模式且无其他启用项时关闭 timer、停止恢复 helper；在统一模式下只记录该项目暂停，不影响其他项目（均不停止业务容器）。已提交给 Docker daemon 的单次 start 请求可能仍在完成，不能将关闭 helper 当成撤销已提交请求。重新启用使用 `auto-enable part1`。运行期已经 running 但 unhealthy 的服务需要调查，`recover` 不强制重启它们。

## 验证范围

本页初版验证时 121 项 NAS 本地测试通过，其中新增 18 项涉及无 Node 分发、Git 子挂载一致性、Part 2 范围和显式维护/验收参数、健康服务不重复启动、启动顺序、暂停/OOM/正在重启/网络失败拒绝、持久单元只在开机补启动、日志/状态不泄露 Env、临时任务 SSD 只读隔离、禁止重复第一卷预复制、回收隔离、安装快照不包含凭据且不自动启用、同版本重建在启动前登记新容器、停写失败不重建、第二卷自动恢复拒绝。

还用本机真实 Compose v2.34 对 po-infra 的 ghcr/local-build 文件合并 Git storage 声明，确认只新增十个 NAS 子挂载和 external 卷，原数据库、端口、父卷、镜像等其他字段不变。通过 Bash 与 Python 3.6 语法检查。本地没有操作线上 Docker/NFS/systemd，也未执行服务器重启或拔网演练；持久单元仍需服务器安装回执和后续维护窗口实测。
