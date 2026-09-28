# 第二卷 delta：从已有预复制推进到 NAS 写入

2026-09-28：用户确认约 500 GiB 的 infra 已完成迁移和 SSD 清理，现在推进约 900 GiB 的 delta。15:53 服务器（`b4d90f7`）回执确认 `/data` 可用约 519.82 GiB、使用率 73%，delta 当前没有 raw-media NAS 子挂载，源检查仍通过本地 SSD 核对。历史预复制确实成功，但当前恢复旧复制被身份/阶段复合校验拒绝；不能把预复制当成切换成功。

infra 已安装 `aa1049b7eaba9364b176`，恢复检查通过，统一策略与 timer 已启用。该安装回执只证明工具/恢复登记就绪，不代表新增会话卷已发布或 delta 已迁移。本轮不重复 infra 的复制、切换、删除或业务验收。

## 最新回执与当前下一步

服务器日志确认 `mx-nas-part2-copy-d076b1bf96.service` 成功，job_id 为 `cdc8d85a2475440b86b21c624f365512`。2026-09-24 05:20:33–08:42:43（北京时间）复制了 312,505 个普通文件，逻辑大小 1,000,864,960,734 字节（932.13 GiB）；rsync 退出 0、没有删除文件、当次不限速，phase 为 `precopy_pass_complete`，cutover_ready/reclaim_ready 均为 false。

历史源身份为 device `66309` / inode `7135180`，目标 inode `384893057`，消费者指纹 `918f25a42057ff3334d4458596925cc79dc4a8561a59ec2735db15ac96db05a8`。当前旧工具只报告 `Migration marker/deployment changed or copy is sealed`；不能仅凭此断言是容器 ID 变化，更不能改旧指纹续传。

当前 delta web 的部署标签已确认：工作目录 `/home/lcy/test/Delta/mx_data`，依次使用 `docker-compose.ghcr.yml`、`docker-compose.local-build.yml`、`docker-compose.db-port.yml`，环境文件为 `deploy/.env.delta-59202.ghcr`。这是定位证据，不代表全部服务的当前模型/启动脚本已审核。宿主机挂载表可见 infra 的 NFS 卷；delta 仍未登记 NAS 切换/恢复/清理。

本次新增 `nas delta copy status` 只读入口，并把旧复合校验逐项输出为 `precopy_resume_check`：包括旧/当前源目录身份、目标路径/inode、消费者指纹、阶段及任务标识。沿用原主机/锁/目录检查，检查不扫描媒体树、不改 marker、不采用新指纹，不提供绕过参数；失败仍退出 1。旧 `nas-precopy.sh --status` 同样得到详细事件。

同步本次 mx-static 代码后，在服务器 mx-static 目录以 root 执行：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
bash scripts/manage.sh nas delta copy status --json
```

本次运行时快照预期为 `ef5b6675f3b12c142d28`（后续代码/声明改变会改变摘要）。回传 `precopy_resume_check` 及紧随其后的失败/状态事件。若只有 consumer_fingerprint 不匹配，下一步仍须核对当前部署并形成单独的续传依据；本次没有放宽旧记录的身份保护。若源/目标 inode 或阶段也变了，则先处理对应差异。当前不要重复提交 `copy` 或开始切换。

本地 374 项 NAS 回归、33 个运行时 Python 3.6 语法及 11 个 Bash 语法检查通过；测试验证每种身份/封存差异均拒绝、记录字节保持不变、输出只含指定元数据，以及统一入口只运行 `--status` 并保留失败退出码。未连接服务器、未复制或重启业务。

## 两个实例的对应关系

| 项目 | infra / part1 | delta / part2 |
| --- | --- | --- |
| 应用脚本 | `scripts/deploy_public_ghcr.sh` | 同一脚本 |
| 发布参数 | 不传 `--instance`，端口 `59201` | `--instance delta-59202`，端口 `59202`，`--db-port 55432` |
| Compose project | `mx_data` | `delta_59202` |
| 原媒体父卷 | `po_infra_media_data` | `delta_59202_media_data` |
| NAS 子卷登记名 | `mx_data_raw_media_nfs_v1` | `delta_59202_raw_media_nfs_v1`（拟用，不代表已创建/挂载） |
| 运维入口 | `bash scripts/manage.sh nas infra ...` | `bash scripts/manage.sh nas delta ...` |

`nas delta` 已定位 part2，无需再写 part2。应用 `--instance` 保留连字符，Compose project 使用下划线，两者不要混用。

当前应用脚本默认派生 delta 环境文件为 `deploy/.env.delta-59202.ghcr`；`--db-port` 还会加入 `docker-compose.db-port.yml`，与 ghcr/local-build 文件一起使用。最终以服务器现有容器标签及实际入口为准，不能复制 infra 的 `.env.ghcr`、数据库卷名、端口或镜像到 delta。

迁移范围仅是 raw-media 子目录，包括其中的 tmp：

```text
SSD 源：/data/docker/volumes/delta_59202_media_data/_data/data_hub_raw_media
NAS 目标：/mnt/nas/mx-internal-server/data/docker/media-volumes/delta_59202_media_data/data_hub_raw_media
容器目标：/app/media/data_hub_raw_media
```

不是整个 `/data`、整个父媒体卷或整个 Docker 数据目录。父卷其他目录、数据库、Redis、static、会话卷保留；不能按 tmp 文件名或年龄直接删除。

## 当前实现边界

`deploy/nas/projects/delta.json` 仍为 `adapter: precopy-only`，支持 `status / locate / logs / copy`。`profiles.json` 中 part2 的 `report / plan / storage_file` 均为空；切换准备/执行器和 media-v1 恢复适配目前绑定 infra。应用发布检查把尚未登记 NAS 的 delta 保持在 local 模式。

因此现在可检查和补齐预复制，**不能把 infra 命令中的名称换成 delta 就完成切换**。`nas delta storage check`、`repair switch`、`cleanup` 等还没有可执行适配；此文不把拟实现命令伪装成可直接运行的命令。也不能用原应用部署命令代替迁移：当前 delta 的正常部署仍会使用本地媒体声明。

## 第一步：读取现场，暂不改变运行服务

以下为已回传的初始检查命令，保留供复查，不必重复执行整组。当前下一步使用上方新逐项诊断入口。不输出 .env 内容，不读取数据库表，不停止容器。

```bash
date -Is
git rev-parse --short HEAD
df -hT /data
bash scripts/manage.sh nas host status
bash scripts/manage.sh nas delta status
bash scripts/manage.sh nas delta locate
bash scripts/nas-precopy.sh delta_59202_media_data --status
journalctl -n 40 --no-pager -o cat -u 'mx-nas-part2-*'
docker ps -aq --filter label=com.docker.compose.project=delta_59202 --filter label=com.docker.compose.service=web | xargs -r docker inspect --format 'container={{.Name}} working_dir={{index .Config.Labels "com.docker.compose.project.working_dir"}} config_files={{index .Config.Labels "com.docker.compose.project.config_files"}} env_file={{index .Config.Labels "com.docker.compose.project.environment_file"}}'
```

`nas delta status` 查看容器状态和 raw-media 挂载声明，不读取预复制 marker，所以另外调用现有 `nas-precopy.sh --status`。后者检查源目录、当前消费者和 NAS 中的既有记录，不扫描全部文件；hard NFS 访问仍可能等待。正在复制时锁占用会拒绝这项检查，不应启动第二份复制。

预期旧记录包含 `phase: precopy_pass_complete`、`last_exit_code: 0`。这只说明当时在线复制成功，仍会有 `cutover_ready: false`、`reclaim_ready: false`。若出现 `Migration marker/deployment changed or copy is sealed`，可能是期间重新部署改变了容器 ID/镜像/挂载；此时先分析现场，不能删 marker、改指纹或把 NAS 目录清空。若 NAS 已被消费者挂载，也不能用旧 SSD 预复制覆盖正在使用的 NAS。

## 第二步：条件满足后不限速补齐在线增量

仅在第一步证明旧目标仍是未切换的预复制目录、SSD 仍是本实例的写入来源、源/目标及消费者身份通过检查时执行：

```bash
bash scripts/manage.sh nas delta copy --unlimited
```

统一入口提交后台任务，不停止业务、不重建容器、不删除源文件。复用原目标，按大小/修改时间跳过相同文件，复制新增/变化文件及 tmp；不需要另建一份 900 GiB 副本，但仍需扫描目录元数据。`--unlimited` 不设 rsync 带宽上限；耗时仍取决于差异量和实际 I/O。实际同步不带 `--delete`；预复制会更新目标中的同名变化文件，因此不能对已成为正式来源的 NAS 使用。

查看：

```bash
bash scripts/manage.sh nas delta logs
```

日志跟随可以用 Ctrl-C 退出，不会停止后台复制。结束时确认 `precopy_result` 的 `last_exit_code: 0` 和 `phase: precopy_pass_complete`，不能只看“后台任务已提交”。若出现保护检查或 rsync 错误，保留两侧和原日志，先诊断；不要手工跳过校验。

## 第三步：接入 delta 的正式切换能力（当前待实现）

依据第一步现场补齐独立 delta 适配，继续使用统一 manage.sh 和已有应用发布 hook，不另造一套人工部署命令。必须覆盖：

1. 记录本次源/目标、NAS marker、现有服务、镜像、启动行为和配置定位，证明没有混用 infra 的卷或报告；为旧预复制后正常重部署提供可审计的重新核对流程，不能直接改旧指纹。
2. 为 delta 生成其自己的 NFS 卷及存储/运行时/发布声明；保留原 `/app/media` 父卷，只在 raw-media 子目录挂原生 NFS，所有写服务使用 nocopy，gateway 只读。
3. 保留当前应用版本与登录相关配置，不把存储迁移变成应用升级，不运行 migrate、bootstrap_admin、任务清空或递归修改 NAS 权限。
4. 在正式切换前就准备好 delta 的发布约束。成功切换后，同一个应用 hook 必须选用 delta 的 NAS 声明，不能再次以 local 模式部署；缺声明/缺卷时停止，不回退 SSD。新增普通应用卷仍按正常发布规则处理。
5. 增加 delta 的独立媒体恢复、实际挂载核验及清单回收支持。用隔离测试验证每一步都不操作 infra 的容器、卷、数据库或清理记录；不把 infra 全局常量改成 delta 来复用执行器。

这些能力完成并测试后才给出正式切换命令；现有 `.example` 模板不能直接作为生产切换工具使用。

## 第四步：维护窗口停写、最终同步、切换

这是待实现适配的执行顺序，不是让操作者现在手工运行 Docker stop/up：

1. 暂停 delta 的发布和新增任务，按依赖关系让其媒体写入者正常退出；确认所有写入者停止后才开始最终同步。仅操作 delta，infra 保持运行。
2. 从 SSD 向已登记 NAS 目标做最后一次不限速增量同步；逐路径确认目标覆盖源数据，冲突另行核验，保留 NAS 独有文件，不删除 NAS 内容。保留 tmp，不靠文件名授权清理。
3. 同步/核验成功后封存 SSD 基准与迁移证据，只重建 delta 的媒体消费者并挂载 NFS。使用本次已核对的镜像、env 和受控启动方式，数据库/Redis 数据卷保持本地，不重建或初始化它们。
4. 检查 Docker 挂载声明与每个运行消费者的内核来源，必须是 delta NAS 路径上的 nfs；仅有 named volume 名称、宿主机 NAS 挂载或历史成功报告都不够。
5. NAS 开始接收新写入后，失败不能自动切回旧 SSD。保留现场和已写入数据，按报告恢复；不提供自动删除/清空的“回滚”。

原先同意的 10–30 分钟是 infra 历史窗口，不视为本次 delta 的停写安排或时长保证；delta 停写时段按现场任务与最终增量量安排。

## 第五步：验证、恢复登记及正常发布验证

首先通过旧图片/视频读取、新媒体写入及后台任务验证，使用现有账号确认本实例登录/联网正常。记录新文件的相对路径，证明它落在 NAS，而旧 SSD 不再出现对应新增文件；检查权限使用应用身份，不能只用 root 读取推断。

将成功切换的 delta 纳入现有统一恢复策略；检查两个项目均正确登记、工具快照一致和 timer 状态。既有服务只补启动，正在运行的跳过；缺失容器/存储交给显式部署与修复，不自动初始化数据库。然后通过已接入的原 `--instance delta-59202` 发布入口验证重建后仍使用 NAS，保留普通新增应用卷能力。

真实重启、Docker 重装或断电演练是另行安排的现场验证；不能把注册成功写成这些演练已通过，也不应为迁移无故重启整个 Docker。

## 第六步：达到可回收状态，再显式清理 SSD

业务验收后，生成 delta 专属的最新 SSD/NAS 文件清单，复核 NAS 对应文件、源目录身份、当前存储与恢复覆盖，得到可回收收据。清单就绪后可以先保留 SSD，等待用户安排删除。

实际清理必须通过 delta 的受控清单入口再次核验，仅逐项删除已验证的旧 `data_hub_raw_media` 内容，保留根目录、父媒体卷、其他媒体、数据库、队列、会话数据和整个 infra。不能使用整个卷删除、`down -v`、NAS 删除或全局 prune。完成后以删除收据及 `/data` 的 `df` 确认，逻辑大小不等于实际释放空间。

当前 delta 清单/删除入口尚未实现，不在此提前给出可执行的删除命令。预复制、切换成功与可删除 SSD 是三个独立检查点。
