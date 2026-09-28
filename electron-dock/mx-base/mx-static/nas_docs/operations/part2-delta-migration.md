# 第二卷 delta：从已有预复制推进到 NAS 写入

2026-09-28：用户确认约 500 GiB 的 infra 已完成迁移和 SSD 清理，现在推进约 900 GiB 的 delta。15:53 服务器（`b4d90f7`）回执确认 `/data` 可用约 519.82 GiB、使用率 73%，delta 当前没有 raw-media NAS 子挂载，源检查仍通过本地 SSD 核对。历史预复制确实成功，但当前恢复旧复制被身份/阶段复合校验拒绝；不能把预复制当成切换成功。

infra 已安装 `aa1049b7eaba9364b176`，恢复检查通过，统一策略与 timer 已启用。该安装回执只证明工具/恢复登记就绪，不代表新增会话卷已发布或 delta 已迁移。本轮不重复 infra 的复制、切换、删除或业务验收。

## 最新回执与当前下一步

**最新状态覆盖下方首次准备指令：** 服务器已安装 `18ededb3d26883ec29c6`，infra 恢复正常。准备报告 `/var/lib/mx-static/nas-precopy-continuation/delta-8cb4f04483264339ba4cdc63df13a788` 成功：312,505 个共享文件 / 932.13 GiB quick-check 一致，6,781 个 SSD 独有文件 / 4.77 GiB 待添加（不含 tmp），共享哈希候选为 0。复制前全部 6,781 个源文件复核通过。

续传任务 `mx-nas-part2-delta-copy-resume-c8552f3f5c.service`、尝试 `copy-ef8f3e5aea0d4857aeaaa1a86f5699b0` 已开始不限速添加，最后一条进度为 copied=200、logical_bytes=6,097,882，随后状态复核报 `Media HTTP service not healthy: gateway` 并停止。日志只能确认至少 200 个完成文件，实际数量看私有 copy.jsonl；本次没有完成收据。已完成的 NAS 添加保留，源和旧 marker 保留，不做回滚或删除。

错误来自 `delta_copy.current → reclaim_plan.health_guard` 的 HTTP 健康门槛；具体健康状态可能是 unhealthy、starting 或未提供状态，不能仅凭报错断言超时、NAS 故障或复制引起业务异常。先在服务器以 root 读取 delta gateway 的状态/近期探测结果，不重启、不打印 Env：

```bash
date -Is
docker ps -aq --filter label=com.docker.compose.project=delta_59202 --filter label=com.docker.compose.service=gateway |
  xargs -r docker inspect --format 'name={{.Name}} id={{.Id}} restart_count={{.RestartCount}} state={{json .State}}'
```

如果恢复 healthy，沿用原报告显式重试（无需重复 install/prepare）；执行器仍重新检查当前容器/PID、挂载、源文件及 marker，已存在文件通过内容核对后跳过。若发生身份变化则按错误另建计划，不能改报告指纹：

```bash
bash scripts/manage.sh nas delta copy resume \
  /var/lib/mx-static/nas-precopy-continuation/delta-8cb4f04483264339ba4cdc63df13a788 \
  --unlimited
```

持续不健康时先查近期 Health.Log 的探测退出码/响应原因；本次没有删除或放宽健康检查，也不建议在未知原因下反复提交复制。下文保留实现说明及首次准备过程。

服务器日志确认 `mx-nas-part2-copy-d076b1bf96.service` 成功，job_id 为 `cdc8d85a2475440b86b21c624f365512`。2026-09-24 05:20:33–08:42:43（北京时间）复制了 312,505 个普通文件，逻辑大小 1,000,864,960,734 字节（932.13 GiB）；rsync 退出 0、没有删除文件、当次不限速，phase 为 `precopy_pass_complete`，cutover_ready/reclaim_ready 均为 false。

历史源身份为 device `66309` / inode `7135180`，目标 inode `384893057`，消费者指纹 `918f25a42057ff3334d4458596925cc79dc4a8561a59ec2735db15ac96db05a8`。最新服务器安装 `ef5b6675f3b12c142d28` 后确认：**只有 consumer_fingerprint 不一致**，当前值为 `1cb035cc33634e4675ddb4f1fd1a24c12c406398c3f0745c481b8eced6b6f9b4`；源目录、目标路径/inode、schema、job_id 和未封存阶段都匹配。旧 marker 只保存摘要，不能反推具体是 ID、镜像或哪个挂载发生变化；不能改旧指纹续传。

当前 delta web 的部署标签已确认：工作目录 `/home/lcy/test/Delta/mx_data`，依次使用 `docker-compose.ghcr.yml`、`docker-compose.local-build.yml`、`docker-compose.db-port.yml`，环境文件为 `deploy/.env.delta-59202.ghcr`。这是定位证据，不代表全部服务的当前模型/启动脚本已审核。宿主机挂载表可见 infra 的 NFS 卷；delta 仍未登记 NAS 切换/恢复/清理。

`nas delta copy status` 的逐项诊断已完成，不必重复。旧 `nas delta copy --unlimited` 仍保留严格指纹检查，**不要继续重试该入口或删除旧 marker**。

本次增加独立的 `delta copy prepare / resume`，用于已成功预复制后正常部署发生变化的场景：只重用项目无关的文件核验/添加函数，不调用 infra 的迁移执行器，不改变 infra 常量、登记、恢复或清理状态。

同步本次 mx-static 代码后，在服务器 mx-static 目录以 root 执行：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check &&
bash scripts/manage.sh nas delta copy prepare
```

prepare 只读取媒体和 Docker/内核挂载，扫描目录元数据，将结果写入新的 root 私有目录 `/var/lib/mx-static/nas-precopy-continuation/delta-<32位ID>`。成功摘要为 `nas_delta_copy_prepared`。必须证明当前十个媒体容器健康运行、raw-media 由预期 SSD 父挂载提供，没有已挂载目标或额外 Docker 路径/卷别名访问该媒体。当前消费者、PID、启动时间和内核来源记录到这份新计划；准备或执行期间再部署/重启则拒绝，要求新建计划，旧证据不改写。

比较策略是保留并集：只把 SSD 独有文件列为候选；NAS 独有和已有属性保留；同名大小冲突拒绝，同大小但 mtime 不同最多核验 1,000 对、双侧合计 512 MiB 的内容哈希。它不是全量哈希校验。已有 NAS 父目录缺失、链接、跨设备、文件变化或真实内容冲突均失败，保留报告，不自动覆盖或扩大冲突读取范围。

成功后，把实际准备报告路径代入（不是旧 job_id、infra 报告或 copy 尝试路径）：

```bash
bash scripts/manage.sh nas delta copy resume /var/lib/mx-static/nas-precopy-continuation/delta-实际32位ID --unlimited
```

resume 以后台任务执行，只添加该清单内 NAS 缺失文件。带宽始终不限速，`--unlimited` 可显式保留；一次计划的范围上限为 400,000 个候选、2 TiB、512 MiB 清单，和限速无关，不放宽 infra 原有的小批修复上限。按候选字节检查 NAS 余量加 1 GiB 预留。每个新增文件在本次独占暂存目录写入、哈希读回，再以不替换已有名称的链接发布；只清理本次自己的暂存文件/空目录，不删 SSD 或任何原 NAS 文件。中断后保留完成文件与私有日志；同份计划重试时已存在文件须内容完全一致才跳过，否则停止。新报告不会替换旧 `.mx-static-precopy.json`，因此旧 status 仍可报告原指纹差异，续传结果以新 attempt/result.json 为准。

使用提交输出中的精确 `journalctl` 命令跟随日志，确认 `nas_delta_copy_complete`、phase=`manifest_copy_complete` 和 unit Succeeded。这只完成在线差量清单，仍为 `stopped_writer_recheck_required=true`、`reclaim_ready=false`；当前业务继续写 SSD，不代表已经切换。失败不做回滚、不删已复制文件、不自动继续。不要并行运行其他迁移或部署；同一迁移锁防止本工具任务竞争，不能拦截任意 root/原始 Docker 命令。

本地 399 项 NAS 回归通过（含新增 25 项 delta 续传测试），34 个运行时 Python 文件通过 Python 3.6 语法检查，11 个 Bash 脚本语法检查通过；本次运行时快照预期为 `18ededb3d26883ec29c6`。测试验证真实临时文件的追加、冲突拒绝、部分完成重试、marker 字节不变及源保留；Docker/内核/NFS 边界使用隔离模拟，未连接服务器，也没有执行真实复制或重启。正式切换、发布约束、独立恢复和回收能力仍按下文第三至六步实现。

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

以下为已回传的初始检查命令，保留供复查，不必重复执行整组。当前下一步使用上方 `copy prepare`。不输出 .env 内容，不读取数据库表，不停止容器。

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

**当前服务器已确认消费者指纹变化，应使用上文 `copy prepare / resume`。** 以下原 rsync 入口仅保留给原消费者指纹仍匹配的预复制，不适用于本次回执。

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
