# Delta / part2 业务验收与旧 SSD 回收

这是显式迁移收尾操作，普通开机恢复、应用发布和容错不会调用它。

最新现场（2026-09-29）：业务验收已登记，新检查 `reclaim-check-738fdb0f9ef94b2c981e2dc94cc8970b` 与就绪清单 `reclaim-plan-6f8ee4902178476eb91ba29514392017` 均成功。显式删除任务 `mx-nas-part2-delta-reclaim-854b886ada.service` 在源 SSD 身份检查处失败，尚未进入删除归属/日志创建和文件删除。此前头像核验失败已确认仅 NAS ctime 变化，两侧 504 字节稳定内容哈希相等且匹配文件名；新报告保存了新的 NAS 元数据，原报告未改写。

本次原因是任务的 `ReadOnlyPaths=/data /mnt/nas` 加精确 `ReadWritePaths` 形成子目录绑定挂载，`findmnt SOURCE` 显示为 `/dev/nvme0n1p1[/docker/volumes/delta_59202_media_data/_data/data_hub_raw_media]`，旧校验只接受裸设备名。这种方括号格式是 [util-linux 2.32.1 官方 findmnt 文档](https://github.com/util-linux/util-linux/blob/v2.32.1/misc-utils/findmnt.8) 说明的文件系统子目录信息。修复只额外接受该卷的精确 raw-media 子目录，同时检查块设备类型、目录类型和实际设备号；不去除任意方括号，不移除只读保护，不放宽文件/容器/日志校验。

当前只需同步代码后执行第 1 步安装/恢复检查，再沿用已成功准备的清单重试：

```bash
bash scripts/manage.sh nas delta cleanup \
  /var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-6f8ee4902178476eb91ba29514392017 \
  --business-accepted
```

执行器仍重新核对当前状态。若后来重部署、重启或对应文件变化，不绕过报错或自动采用新基准。此次格式问题本身无需重跑复制、切换、检查或清单准备。以下保留完整流程供参考，当前应继续第 3 步。

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

本次预期运行时快照：`519f63842c724ba186e1`。delta 和 infra 应仍已核对、已纳入，timer active/enabled。安装不停止业务，保留已有策略。原只读核验记录不用改写；新增能力不会把其中的 `deletion_supported=false` 原地改成 true。

## 2. 实际业务验收通过后，准备独立回收清单

确认 delta 现有账号登录/联网、旧媒体读取、新媒体写入和后台任务正常后执行：

```bash
bash scripts/manage.sh nas delta cleanup prepare \
  /var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-check-738fdb0f9ef94b2c981e2dc94cc8970b \
  --business-accepted
```

这是只读媒体的后台准备任务，不删除任何媒体文件。它重新核对原检查/停写清单、SSD 现存文件、NAS 对应文件、当前容器/挂载/健康、恢复设置以及媒体读取样本。使用任务输出给出的精确 `journalctl` 命令查看，必须等到 `nas_delta_reclaim_prepare_complete` 和 unit 的 `Succeeded`。

成功摘要应有 `business_acceptance_recorded=true`、`reclaim_ready=true`、`deletion_supported=true`、`deletion_authorized=false`、`source_deleted=false`。保存输出里的完整 `plan_directory`，形式为：

```text
/var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-plan-<本次实际编号>
```

`reclaim-check-738f…` 是检查报告，不能直接作为删除参数。prepare 会新建 `delta-retained-reclaim-v1` 清单，引用并校验原检查证据，记录实际验收；不修改切换报告或 NAS marker，也不编辑 Git 中的 plan。当前已经有成功的 `6f8ee490…` 计划，不必重复准备。

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

本地 489 项 NAS 测试、39 个 Python 文件的 Python 3.6 语法检查、10 个 NAS/manage Bash 语法检查通过。原 16 个回收回归覆盖真实临时文件删除、两次显式验收参数、精确范围、元数据/运行变化、日志先落盘、部分删除续跑、拒绝更换计划及完成回执写入中断；本次 4 个新增用例覆盖现场绑定来源格式、其他目录/项目绑定拒绝、显示设备与实际设备不一致、文件类型/NFS/错误磁盘/符号链接拒绝。Docker/NFS/systemd 边界采用模拟，尚未取得服务器删除完成回执，也未做断电演练。
