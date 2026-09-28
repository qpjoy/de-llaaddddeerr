# Delta 正式切换与恢复（2026-09-28）

## 当前状态：已切到 NAS，SSD 保留

服务器已返回 `nas_delta_switch_complete`，unit `mx-nas-part2-delta-migration-switch-823e84ae77.service` 为 `Succeeded`。成功执行报告为 `/var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699`，最终停写复核位于其 `repair-final-f08352c6561c45c5aa34012d3c0c1205`。`phase=running_on_nas`、`final_sync_passed=true`、十个新媒体容器 ID 已记录；`source_deleted=false`、`reclaim_ready=false`、`business_acceptance_pending=true`。

完成事件在内核 NFS/媒体 HTTP/应用默认身份 I/O 检查通过、独立 `/etc/mx-static/nas/delta-media.json` 完成登记之后输出。数据库、Redis 和 websearch 在执行器身份守卫下保留原状态。随后服务器只读回执确认十个媒体服务全部匹配 NFS，locate 指向本次报告，delta / infra 均已纳入恢复且 timer active/enabled。业务验收仍待确认；不据此认定真实重启/断电/应用重部署演练完成。下一步见 [SSD 只读核验](part2-delta-reclaim-check.md)，delta 删除适配尚未启用。

**不要重复 copy、prepare、switch 或 resume，不要重置旧 marker，不把 SSD 再补写到已经运行的 NAS。** 当前代码已自动登记本次报告，`nas delta locate` 已指向 `delta-20849647…`；无需为登记而改 Git 的旧报告路径或重建业务。本轮新增 cleanup check 运行时代码，需按只读核验文档同步并更新持久工具；下方旧快照仅属切换历史。

## 切换前记录（已由上面的成功回执取代）

最新服务器报告 `/var/lib/mx-static/nas-migration-prepare/delta-c2c06489a22e45c7add56c185f335940` 已通过：`review_items=[]`、`deployment_review_passed=true`、候选合并通过，10 个媒体服务的镜像/启动脚本通过，PostgreSQL/Redis 健康，websearch 的私有 `/tmp` tmpfs 保留。它是准备成功，不是 NAS 切换成功。

最新重试 `mx-nas-part2-delta-migration-switch-8366ae4205.service` 在 `preflight_only=true` 失败：`Original SSD writer changed: worker-agent-interactive`，报告 `/var/lib/mx-static/nas-delta-cutover/delta-d4023c293f4041c89ec4d402dfadd3c0`。没有尝试维护登记或停止服务，SSD/NAS 业务文件均保留。前面的部署快照比较已把 Docker 实际 `Mounts` 排序，随后的 writer guard 却比较原始列表，造成不一致。本地加入已观察到的会话卷，仅交换两项排列即复现同样错误。服务器旧日志未记差异字段，现场是否仅顺序变化仍待新日志确认。

修复统一 delta 准备、停写及创建后的实际挂载比较：仅规范化顶层 `Mounts` 顺序，保留所有条目/属性，拒绝重复或无效目标，不更改原准备报告。Config/HostConfig 中的列表顺序仍严格比较。预检仅顺序变化会输出 `nas_delta_mount_order_normalized`；writer guard 遇到真实变化会输出 `nas_delta_writer_changed` 的服务/字段名，不打印 Env 值。同步后仍用原准备报告执行下方 `migration switch`；`delta-d4023…` 同样不能 resume，不需重新复制或改应用部署。

服务器首次正式尝试 `mx-nas-part2-delta-migration-switch-1598f6dc88.service` 在 `phase=preflight` 失败：`Media graceful stop signal needs review.`。十个服务的镜像/启动检查、隔离 Docker NFS 挂载及 4 KiB root 读写已通过；失败点位于维护登记和停止业务之前，尚未切换写入、未补复制或删除业务文件。保留本次 `/var/lib/mx-static/nas-delta-cutover/delta-79b3192952c2460ead53458b9a4ee1a6` 报告，但它没有执行检查点，不能作为 `migration resume` 的目标。

旧检查要求所有媒体服务使用 TERM，误拒绝 nginx 官方镜像的 `STOPSIGNAL SIGQUIT`。[nginx 文档](https://nginx.org/en/docs/control.html)说明 QUIT 用于优雅退出；[官方镜像定义](https://github.com/nginx/docker-nginx/blob/master/stable/alpine-slim/Dockerfile)声明了该信号。本地已用该元数据复现相同失败；旧服务器日志没有服务名/实际信号，因此尚不能断言现场一定是 gateway。修复只允许已审核 nginx 命令/入口的 gateway 使用 QUIT/3，其他媒体服务仍限定 TERM/15 或未配置时的 Docker 默认 TERM；不改容器信号，不强制 kill。停止策略核对提前到创建/探测 NAS 前，并输出逐服务实际信号。修复同步后使用下面的原准备报告重试 `migration switch`，当前配置/身份仍须通过检查；无需改应用脚本或重做 900 GiB 复制。

源卷为 `delta_59202_media_data`，只切换其 `data_hub_raw_media`。目标 Docker NFS 卷为 `delta_59202_raw_media_nfs_v1`。infra 的已完成迁移、数据库及队列不参与本次操作。

## 历史执行步骤（本次已完成，不再重复）

在服务器 mx-static 目录，以 root 操作。先同步本次 mx-static 代码，然后安装持久工具；本次预期快照为 `a328613b893c026c9df3`：

```bash
bash scripts/manage.sh nas recovery install
```

安装本身不停止/启动业务，也不改变现有 timer 设置。新版 Git 声明要求 delta 使用 NAS，因此从安装到切换完成期间，**delta 应用重新部署和开机补启动会因缺少完成登记而被阻止**。原来正在运行的 SSD 容器不会被安装动作停止。不要在这段时间运行应用发布脚本；无需重跑约 932 GiB 预复制或已完成的 4.77 GiB 续传。

以下才是维护操作，会暂停 delta 的媒体 HTTP/后台消费者；耗时取决于正在执行任务的优雅退出、目录扫描及最后增量，不能保证几秒完成：

```bash
bash scripts/manage.sh nas delta migration switch \
  /var/lib/mx-static/nas-migration-prepare/delta-c2c06489a22e45c7add56c185f335940 \
  --maintenance --write-test
```

该命令提交后台 systemd 任务，随后使用输出中给出的 **精确 unit 名** 查看日志。SSH 断开不停止任务，主机重启不会自动续跑迁移。不要把“后台任务已提交”当成成功。

执行器会：

1. 重新核对原准备报告、成功 copy 证据、当前部署文件/容器/镜像/启动脚本、停止信号和重启策略、SSD/NAS 身份及额外媒体访问路径。部署变化则在停写前拒绝；保留旧报告，必要时重新做部署准备，不重置旧复制 marker。
2. 核对或显式创建严格指定的 native NFS 卷，以隔离的 Python 入口验证 NFS 目录身份和 4 KiB I/O。不启动应用入口、数据库迁移或账号初始化。先做在线并集预检，排除已知内容冲突后才进入维护。
3. 在 `/etc/mx-static/nas/delta-media.json` 持久记录维护所有权，之后按组优雅停止 **10 个 delta 媒体服务**，不强制 kill。PostgreSQL、Redis、websearch 保留原容器和运行状态，变化则停止后续操作。
4. 保存完整停写 SSD 元数据清单，不限速补 NAS 缺失文件；内容冲突拒绝覆盖，保留 NAS 独有文件/属性，重新检查 SSD 未变化。不镜像删除、不按 tmp 年龄删除、不递归改 NAS 权限。不做 900 GiB 全量内容哈希；共享文件按已审核 quick-check、差异文件做有上限的哈希。
5. 以当前固定镜像和原配置 `--no-deps --no-build --pull never --no-start --force-recreate` 重建这 10 个服务。只增加 NFS 子挂载与已有审核的维护启动调整：web 直接 Gunicorn，worker 禁止启动时重排旧任务。保留用户/环境、其他卷、端口等；不执行应用部署脚本。
6. 核对所有创建结果，先记录 NAS 可能写入的边界，再按现有 Compose 依赖顺序启动媒体服务，核对内核 NFS、已有媒体 HTTP Range/哈希、每个写入服务默认身份下的 4 KiB 写入/读取/改名探测。只清理本次探测/暂存自身对象，不删业务 NAS 文件。
7. 成功后自动完成独立恢复登记。记录不绑定业务 `.env`、镜像、容器 ID；执行报告保留这些私有证据，但日常恢复不靠它们。

## 成功判据与后续

须同时看到 `nas_delta_switch_complete`、`phase=running_on_nas`、`final_sync_passed=true` 和该 unit 的 `Succeeded`。然后执行：

```bash
bash scripts/manage.sh nas delta storage check
bash scripts/manage.sh nas delta locate
bash scripts/manage.sh nas recovery check
```

十个媒体服务都应匹配 `nfs /app/media/data_hub_raw_media`；delta 和 infra 都应“已核对 / 已纳入”，安装快照当前、timer active/enabled。原有 `migrated` 策略会自动纳入已完成的 delta；若策略未启用或项目曾被暂停，需按检查结果明确启用，不擅自清除暂停设置。

以上只读核对已经通过，不需重复切换。业务仍需实际验收账号登录/联网、旧媒体读取、新媒体写入和后台任务。`business_acceptance_pending=true` 与 `reclaim_ready=false` 是预期值；SSD 原文件保留。新版提供 `nas delta cleanup check` 做文件核验；**delta 的 SSD 删除适配尚未启用**，不要套用 infra 清理命令或删除整个 Docker 卷。见 [核验命令与结果说明](part2-delta-reclaim-check.md)。

## 重部署、重启与中断

日常继续使用应用原有 `deploy_public_ghcr.sh --instance delta-59202 ...`。已审核脚本中的强制发布入口会识别 delta 并追加 `part2.release.json`；NAS、media、static、PostgreSQL、Redis 五个基础卷须已有且 external，新增普通项目应用卷仍可由显式应用发布创建。普通应用配置/镜像可升级，改变受保护卷名、缺 NFS、缺登记、未完成维护则禁止发布。原始 Docker/Compose 命令可绕过该入口，不能声称守护了任意 root 操作。

```bash
bash scripts/manage.sh nas delta start
```

此命令及开机恢复只核对当前 NAS 挂载，并按现有依赖补启动已存在容器；已运行的跳过。停着的 PostgreSQL/Redis 先检查已有数据卷，缺容器/缺卷不创建空替代品。它不构建、不运行应用发布脚本、不扫描媒体、不删除 NAS/数据库/队列。Docker 重装丢失元数据须由明确的应用恢复流程处理；NAS 故障时不能以 SSD 继续写入。

迁移失败后，先保留日志及 `/var/lib/mx-static/nas-delta-cutover/delta-…` 报告。新日志的 `preflight_only=true` / `next_action=retry_switch_after_fix` 表示尚未尝试维护登记或停止服务：修复问题后，用原准备报告重试 `migration switch`（配置变更时需新准备），不对缺少检查点的预检目录执行 resume。

若已尝试写维护登记，失败日志为 `next_action=inspect_execution`，先核对持久登记/检查点；登记写入或 fsync 报错也不能擅自当成未写入。只有已进入维护且身份/阶段允许时，`migration resume` 才使用其 **执行报告**，不能用准备报告或 copy 目录：

```text
bash scripts/manage.sh nas delta migration resume <失败日志中的执行报告目录> --maintenance --write-test
```

停写/最终补复制阶段可以在身份仍匹配时继续。已登记全部新容器后可继续 NAS 启动/探测，不再用 SSD 补写正在运行的 NAS。若创建动作中断而新容器 ID 尚未完整登记，工具拒绝自动推断，应先检查具体容器身份；不会删除混合容器、回滚 SSD 或继续数据复制。业务配置、数据库/辅助容器发生变化时也需先检查，不强行续跑。

本地 449 项 NAS 测试、37 个 Python 文件的 Python 3.6 语法检查、11 个 Bash 语法检查通过。回归同时覆盖 nginx QUIT、媒体/会话卷排列变化下的完整切换、原准备报告不变、真实挂载属性/配置/容器身份变化及重复目标仍拒绝、错误日志不泄漏配置值。测试使用真实临时文件和模拟 Docker/systemd/NFS 边界；它不代替服务器 NFS I/O、真实 Compose 创建或断电重启演练。
