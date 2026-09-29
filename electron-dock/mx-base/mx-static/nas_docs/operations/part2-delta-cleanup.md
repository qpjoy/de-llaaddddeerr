# Delta / part2 业务验收与旧 SSD 回收

这是显式迁移收尾操作，普通开机恢复、应用发布和容错不会调用它。

**最新现场：部分删除后的只读诊断已确认，只能使用同一清单续删。** 原 `reclaim-plan-1fc15c5eb242408b85c4d1549a9f380e` 对应的 SSD 已缺失 41,875 个文件，均有持久删除意图；剩余 277,938 个。日志有 42,000 个唯一文件路径，包含报错头像，检查期间日志稳定。

报错 `avatar/e34a680ea26c1aeeb0163f836240d84892c4a889cd3fd92bd6b322eb575e3b45.png` 的 SSD 元数据未变；NAS 只有 ctime_ns 从 1790683256761350800 变为 1790688683942680403。两侧都是 504 字节普通单链接文件，稳定读取的完整 SHA256 一致且匹配文件名。尚未确定哪个进程改动了 ctime，不能由此推断其他文件均无变化。

本次修复只在显式 delta 删除器启用：NAS 与原清单仅 ctime 不同、文件名是 SHA256 的非 tmp 普通文件时，重新读取 SSD/NAS 完整内容，要求哈希均等于文件名，SSD 全部属性仍符合冻结清单。单文件最多 16 MiB，每次执行最多 64 对、累计双侧读取 64 MiB；这是异常核验的读取范围，不是限速。不满足条件或超出范围则保留 SSD 报错，不自动扩展到全量哈希。

每次核验另存并 fsync 原计划目录内的私有 `ctime-proof-UUID.json`，记录计划/检查/运行指纹、原新属性和双侧哈希，落盘后再次核对运行状态及文件描述符和路径。预检和逐文件删除前各自重新计算，不用旧复核文件作为许可。计划、清单、删除意图历史、NAS 文件和迁移报告保持原内容；缺失项仍必须在原意图日志中。默认 infra/旧回收路径继续严格匹配元数据。

同步本次 mx-static（包含新增 `scripts/nas/projects/delta_reclaim_files.py`）后，在服务器 mx-static 目录以 root 执行：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

预期快照 **`7d9bcc2847ec012da71e`**，两项目恢复仍已核对、已纳入。确认后显式续删：

```bash
bash scripts/manage.sh nas delta cleanup \
  /var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-1fc15c5eb242408b85c4d1549a9f380e \
  --business-accepted
```

根据新任务返回的精确 unit 查看日志。可见 `nas_delta_reclaim_ctime_revalidated`；最终仍须 `nas_delta_reclaim_complete` 和 `Succeeded`，然后按第 4 节核对状态/空间。当前没有服务端续删成功回执。

**不要运行新的 cleanup check/prepare，不改日志、不重新部署或重启容器、不从 SSD 回写 NAS。** 保留原报告下的 `ssd-reclaim.json`、1fc15c5e 目录的 `plan.json` / `unlink-intents.jsonl` 及它引用的 d28a86a2 检查。普通业务可继续；运行、挂载、源文件或其他 NAS 属性变化仍会拦截。下文保留历史事件与通用流程，不能覆盖上述部分删除状态。

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

本次预期运行时快照：`7d9bcc2847ec012da71e`。delta 和 infra 应仍已核对、已纳入，timer active/enabled。安装不停止业务，保留已有策略。原只读核验记录不用改写；新增能力不会把其中的 `deletion_supported=false` 原地改成 true。

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
- **已开始删除**：只能保留并沿用同一 `reclaim-plan` 和 `unlink-intents.jsonl`；相同运行状态下修复暂时故障后重跑同一条 cleanup 命令，工具会根据已持久写入的意图核对缺失文件，只删除尚存的清单文件。另一份计划不能接管。
- **重启、重部署、报告/清单/挂载变化，或日志丢失/截断**：拒绝自动采用新状态续删；保留全部证据，先分析错误。不要重置日志、重新复制 SSD 到 NAS、绕过校验或手工把状态改成成功。

已删除部分不会回滚；NAS 始终是正式来源。普通业务运行、恢复和数据库/队列不因清理失败被本工具停止或重建。

本地 500 项 NAS 测试、40 个 Python 文件的 Python 3.6 语法检查、10 个 NAS/manage Bash 语法检查通过。本次新增 11 个用例覆盖部分删除后同计划续删、双侧内容/文件名核验、预检到删除之间 ctime 变化、内容改写但大小/mtime 相同、源文件变化、临时文件拒绝、读取上限、读取/审计写入期间变化、父目录替换/链接、审计失败和运行状态拒绝。原有清单归属、日志落盘/丢失/截断、运行变化和删除范围测试继续通过。Docker/NFS/systemd 边界采用模拟，尚未取得服务器删除完成回执，也未做断电演练。
