# Delta / part2 业务验收与旧 SSD 回收

这是显式迁移收尾操作，普通开机恢复、应用发布和容错不会调用它。

**最新现场：当前部署审核已通过，下一步是在当前业务确认正常后，显式选择这份审核续删。** 服务器任务 `mx-nas-part2-delta-reclaim-ab99146252.service` 已 Succeeded。本次只是只读审核，没有继续删除；原回收计划、归属和意图日志保留。

原计划仍为 `reclaim-plan-1fc15c5eb242408b85c4d1549a9f380e`，引用原 `reclaim-check-d28a86a2c0f341b18789fb7cd3e47bef`。新增审核目录为该计划下的 `runtime-review-265849b08eb549259eabbf147e48f949`；审核摘要 `eccbe6c2727b169670329433235c6f0038468ad8d73ae638943d7cff7bfb6945`，当前运行摘要 `e3b2d770695033f46a8a8774e079af63487200019c91626e1ef75a2571c87181`。

本次核对得到：

- SSD 尚存 55,036 个清单文件；264,777 个缺失路径全部有持久删除意图记录，合计原 319,813 个文件。不能用文件数推算已释放字节。
- NAS 对应项仅 1 个 ctime-only 候选：`video/f6b999d6eadf0016d8d0e9906bcc50cb581ffd76644219ff2796212692b4e4db.mp4`，2,706,046 字节；其他差异 `issues=0`。
- 候选在预检/删除前分别核对两侧完整哈希，预计共读取 10,824,184 字节、2 对。返回的 64 MiB / 64 对预算覆盖本快照；这不是传输限速，也不说明候选内容哈希已经通过。
- `content_verified=false`、`business_acceptance_pending=true`、`deletion_authorized=false` 为预期值：部署审核不是内容证明、业务验收或删除命令。

若**本次重新部署后**的账号登录/联网、旧媒体读取、新媒体写入和后台任务已经实测正常，在服务器 mx-static 目录执行返回的顶层 `resume_command`：

```bash
bash scripts/manage.sh nas delta cleanup \
  /var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-1fc15c5eb242408b85c4d1549a9f380e \
  --runtime-review /var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-1fc15c5eb242408b85c4d1549a9f380e/runtime-review-265849b08eb549259eabbf147e48f949 \
  --business-accepted \
  --ctime-proof-read-mib 64 \
  --ctime-proof-pairs 64
```

这是**实际续删 SSD 清单文件**的命令。它保留卷/目录、其他 media、NAS、数据库和队列。按新任务返回的 journalctl 命令查看进度，不复用只读审核的 unit。最终需取得 `nas_delta_reclaim_complete` 与 Succeeded，再核对 `/data` 空间与 delta 存储状态；目前尚未收到该完成回执。`statistics.resume_command=null` 是有意避免输出不带新审核的旧命令，使用顶层完整命令即可。

无需因本次成功回执再次安装、重复审核或新建 cleanup check/prepare。本地运行时仍为 `c5613bfa5cd301643400`；本次只更新操作记录。续删前会重新核对原日志、当前运行和文件，并为 ctime 候选做实际双侧哈希；若出现新部署或新文件变化，仍会停止，不能无视错误继续。

此前 `957702929d` 只读检查因十个媒体容器的 ID/PID/启动时间、实际镜像及部分 HostConfig.Mounts 改变而拒绝。本次独立审核已核对当前部署，原运行记录未改写。旧 `may_be_partially_reclaimed=false` 不代表历史未删除；新的错误输出在尚未核对归属时为 null 及 `prior_ownership_checked=false`。

审核重新检查当前 NAS 卷和内核子挂载、额外 SSD 访问路径、必需服务健康、恢复启用及当前代码；核对原始迁移/停写/清单证据，按原意图日志核对 SSD 缺失与剩余文件，扫描剩余 NAS 对应项的元数据，执行当前容器 NAS 身份和 1024 字节 HTTP 读取探测。业务新写到 NAS 的额外文件保留。NAS 内容变化不会因部署审核而被直接接受：此处只统计可进行 ctime-only 哈希的候选，真正续删仍必须做完整双侧内容证明。

成功事件 **`nas_delta_reclaim_runtime_review_complete`** 包含 `review_directory`、仅服务/字段名的 `changes`、`statistics` 和 `resume_command`。统计包含当前剩余/意图覆盖缺失数、ctime-only 候选数量/最大文件、预计读取字节/哈希对数。原计划/归属/目录身份和日志已有前缀与新审核绑定，日志后续只能追加。记录中的 `business_acceptance_pending=true` 和 `deletion_authorized=false` 是预期值；旧版本业务验收不代表新部署已实测正常。

确认**当前部署**账号登录/联网、旧媒体读取、新媒体写入、后台任务正常后，使用此次输出的完整 `resume_command`。它仍指定原 `1fc15c5e…` 计划，增加 `--runtime-review <本次审核目录>`、`--business-accepted` 及有限哈希读取预算。不要猜审核目录，工具不会自动选择最新记录。续删会重新核对原日志前缀、全部剩余文件、当前运行与恢复；审核后再次部署/重启、原记录变化或内容不符仍停止。若同一审核下因暂时故障再次中断，可保留日志用同一显式命令重试；新的合法意图追加不使原前缀失效。选择的审核摘要同时写入新的 ctime 证明和完成收据。

预算沿用之前的异常核验策略：默认单文件 16 MiB、累计读取 64 MiB、64 对；显式 `--ctime-proof-read-mib N` 设累计读取上限、单文件上限为四分之一，`--ctime-proof-pairs N` 限制成对哈希次数。预检和删除前各读双侧，估计是候选字节的 4 倍 / 候选数的 2 倍；这是核验范围，不是限速。只准 SHA256 命名、非 tmp、单链接普通文件且仅 NAS ctime 变化的候选；两侧稳定完整 SHA256 必须相同且等于文件名。其他属性/路径/内容变化拒绝。原清单和旧证明不被修改，不复用旧哈希跳过核验。之后新增 ctime 差异仍可能超出预算，保留日志分析。

`--inspect-ctime` 仍可用于运行未变时的同计划只读统计；当前现场已经完成 `--review-runtime`；若只需重新统计，可显式带 `--runtime-review <上述已完成审核目录>`。两种只读动作均不授权删除，也不会建立替代回收计划。

**清理期间避免并行部署/重启，不重置任何原始记录，不从 SSD 回写 NAS。** 普通业务可继续。只有最终 `nas_delta_reclaim_complete` 和任务 `Succeeded` 才表示该清单完成，再按第 4 节查看空间/服务状态。当前没有服务器删除完成回执。下文保留历史与通用流程，不能覆盖本段的部分删除处理。

此前（2026-09-29）：删除重试 `mx-nas-part2-delta-reclaim-e6f5367f18.service` 已通过源目录打开，随后在初始运行指纹核对处拒绝。十个媒体容器的 ID/PID/启动时间均变化，多数实际镜像改变，web 命令和三个 worker 的 HostConfig.Mounts 也变化；这是不同于下文绑定挂载格式问题的真实部署变化。原 `6f8ee490…` 清单不能继续用于当前部署。当次尚未进入删除归属/日志创建和文件删除。

当时在未开始删除的条件下，使用以下只读命令重新核验当前部署、原停写 SSD 和 NAS 对应项（现已完成）：

```bash
bash scripts/manage.sh nas delta cleanup check
```

若当前部署业务也已实际验收，可加 `--business-accepted`；否则先完成只读检查。检查器会先拒绝已有 `ssd-reclaim.json` 回收归属，SSD 有未经记录的缺失/变化也会拒绝，不能用新清单接管部分删除。成功后使用新输出的 `check_directory` 执行第 2 步 prepare，并使用新的 plan_directory 执行第 3 步，旧证据原样保留。不修改旧运行指纹，不重复迁移/覆盖 NAS，也无需为了此运行变化再改代码或安装工具。日志中的通用提示“只重试同一清单”不能用于反复重试已失效的预检清单；已开始删除的场景仍必须保留原清单/日志、先分析。

此前：业务验收已登记，检查 `reclaim-check-738fdb0f9ef94b2c981e2dc94cc8970b` 与就绪清单 `reclaim-plan-6f8ee4902178476eb91ba29514392017` 均成功。显式删除任务 `mx-nas-part2-delta-reclaim-854b886ada.service` 在源 SSD 身份检查处失败，尚未进入删除归属/日志创建和文件删除。此前头像核验失败已确认仅 NAS ctime 变化，两侧 504 字节稳定内容哈希相等且匹配文件名；新报告保存了新的 NAS 元数据，原报告未改写。

本次原因是任务的 `ReadOnlyPaths=/data /mnt/nas` 加精确 `ReadWritePaths` 形成子目录绑定挂载，`findmnt SOURCE` 显示为 `/dev/nvme0n1p1[/docker/volumes/delta_59202_media_data/_data/data_hub_raw_media]`，旧校验只接受裸设备名。这种方括号格式是 [util-linux 2.32.1 官方 findmnt 文档](https://github.com/util-linux/util-linux/blob/v2.32.1/misc-utils/findmnt.8) 说明的文件系统子目录信息。修复只额外接受该卷的精确 raw-media 子目录，同时检查块设备类型、目录类型和实际设备号；不去除任意方括号，不移除只读保护，不放宽文件/容器/日志校验。

格式修复后曾建议重试旧清单，后来运行变化使该建议失效。新检查和准备已经完成，当前已经部分删除，按本页顶部说明保留原计划诊断；以下仅保留完整流程供参考。

## 删除范围

只回收下面旧 SSD 目录中、已通过核验且列入清单的普通文件：

```text
/data/docker/volumes/delta_59202_media_data/_data/data_hub_raw_media
```

保留 `delta_59202_media_data` Docker 卷、`_data`、raw-media 根目录及子目录、其他 media 文件、NAS 文件、PostgreSQL、Redis 和其他应用卷。不使用 `docker volume rm`、`down -v`、prune 或 `rm -rf`。

最新只读核验对应 319,813 个文件、1,006,412,732,832 逻辑字节，约 937.29 GiB；全部 quick-check 匹配，未做全量内容哈希。实际释放空间受文件分配和同期业务写入影响，以删除后的 `df` 为准。

## 1. 同步并安装本次工具

在服务器 mx-static 目录，以 root 执行。只同步 mx-static，无需为了删除重新发布应用：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

本次预期运行时快照：`ccdc6496e84250c89611`。delta 和 infra 应仍已核对、已纳入，timer active/enabled。安装不停止业务，保留已有策略。原只读核验记录不用改写；新增能力不会把其中的 `deletion_supported=false` 原地改成 true。

## 2. 实际业务验收通过后，准备独立回收清单

确认 delta 现有账号登录/联网、旧媒体读取、新媒体写入和后台任务正常后执行：

```bash
bash scripts/manage.sh nas delta cleanup prepare \
  "本次新检查输出的完整check_directory" \
  --business-accepted
```

这是只读媒体的后台准备任务，不删除任何媒体文件。它重新核对原检查/停写清单、SSD 现存文件、NAS 对应文件、当前容器/挂载/健康、恢复设置以及媒体读取样本。使用任务输出给出的精确 `journalctl` 命令查看，必须等到 `nas_delta_reclaim_prepare_complete` 和 unit 的 `Succeeded`。

成功摘要应有 `business_acceptance_recorded=true`、`reclaim_ready=true`、`deletion_supported=true`、`deletion_authorized=false`、`source_deleted=false`。保存输出里的完整 `plan_directory`，形式为：

```text
/var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-<本次实际编号>
```

`reclaim-check-738f…` 是历史检查报告，不能直接作为删除参数，当前部署变化后也不能再据它生成新计划。prepare 会新建 `delta-retained-reclaim-v1` 清单，引用并校验检查证据，记录实际验收；不修改切换报告或 NAS marker，也不编辑 Git 中的 plan。上方占位路径必须替换为本次新检查输出。

## 3. 准备成功后，显式删除清单内 SSD 文件

将下方引号内的占位文字替换为上一步真实的完整 `plan_directory`。这一步才执行删除，可以等抽空再运行；等待期间有部署或对应文件变化时，旧清单会被拒绝。

```bash
bash scripts/manage.sh nas delta cleanup \
  "上一步输出的完整回收清单目录" \
  --business-accepted
```

同样根据返回的精确 unit 查看 `journalctl`。提交任务不等于已完成。执行期间不要并行发布、重启容器或直接写入旧 SSD 目录；应用正常 NAS 业务写入可以继续。

正式执行再次检查全部剩余 SSD 文件和 NAS 对应项，确认当前运行状态未变化；每批删除前先持久写入意图日志，再逐文件复核 NAS 元数据、SSD inode/属性和父目录身份，使用目录描述符删除清单文件。复用的是已测试的底层逐文件删除函数，不是 infra 的固定项目执行器。

任务进程将 `/data` 与 `/mnt/nas` 设置为只读，仅为精确 SSD raw-media 目录设置可写例外；私有证据和进度保存在 `/var/lib/mx-static`。systemd 支持在只读路径内设置可写子目录，见 [systemd v239 官方执行环境文档](https://github.com/systemd/systemd/blob/v239/man/systemd.exec.xml#L822-L858)。这是任务自身的路径约束，不拦截其他 root 进程。应用发布和迁移入口还共享现有操作锁；原始 Docker 命令不受这个锁保护。

## 4. 确认完成

须看到 `nas_delta_reclaim_complete` 和 unit 的 `Succeeded`。回执应有：

- `phase=ssd_files_reclaimed`、`source_deleted=true`（仅指清单内 SSD 文件）。
- `nas_deleted=false`、`source_root_retained=true`、`other_media_retained=true`。
- `manifest_files_total` 为清单总数；`removed_this_run` 为本次删除数，续删时可能小于总数。

然后执行：

```bash
df -hT /data
bash scripts/manage.sh nas delta status
bash scripts/manage.sh nas delta storage check
bash scripts/manage.sh nas recovery check
```

当前回收归属/完成记录保存在成功切换报告下的 `ssd-reclaim.json`；逐批意图与完成回执位于选中的清单目录。`locate` 会显示这份清单，`status` 会显示已开始/已完成。原切换 `execution.json` 和只读 `check.json` 仍是历史快照，保持原内容，不用手工修改其中的 `source_deleted=false`。

## 中断和拒绝

SSH 断开不停止后台任务；主机重启不会自动续跑删除。先查看精确任务日志，再决定后续：

- **尚未开始删除，运行状态已变化**：旧证据会拒绝。重新做 `nas delta cleanup check`，再从新检查报告准备新清单，原证据保留。
- **已开始删除**：只能保留并沿用同一 `reclaim-plan` 和 `unlink-intents.jsonl`；相同运行状态下修复暂时故障后重跑同一条 cleanup 命令，工具会根据已持久写入的意图核对缺失文件，只删除尚存的清单文件。发生部署变化时按本页顶部执行独立当前运行审核，显式选择后才能续删；另一份回收计划不能接管。
- **重启、重部署、报告/清单/挂载变化，或日志丢失/截断**：拒绝自动采用新状态续删；保留全部证据，先分析错误。不要重置日志、重新复制 SSD 到 NAS、绕过校验或手工把状态改成成功。

已删除部分不会回滚；NAS 始终是正式来源。普通业务运行、恢复和数据库/队列不因清理失败被本工具停止或重建。

本地 526 项 NAS 测试、41 个 Python 文件的 Python 3.6 语法检查、10 个 NAS/manage Bash 语法检查通过。本轮 18 个新增用例覆盖部分删除后的独立审核与显式选择、零原证据/媒体变更、审核前后部署变化、NAS 回落和 SSD 别名拒绝、依赖/恢复/探测失败、未登记缺失、新文件、NAS 非 ctime 差异、日志丢失/截断/前缀改变、合法追加后的同审核续跑、完成标记与存储约束核对，以及选用新运行审核后仍执行两轮双侧 ctime 内容核验、错误内容拒绝。Docker/NFS/systemd 边界采用模拟，未连接服务器、未做真实删除或断电演练。
