# Part 1 当前版本维护切换

2026-09-24：原修复清单的 5,289 个候选已全部在线补齐。此页入口已实现并通过本地测试，尚无服务器切换回执。目标是将当前十个媒体消费者恢复到 NAS，保留两侧数据；不是删除步骤，也不表示整个 Part 1 已验收完成。

## 本次执行

先将包含本页和 `infra_repair_switch.py` 的代码同步到服务器，在 mx-static 目录执行。**此命令会停止并重建 web/gateway 等十个媒体服务，访问会中断，需在维护窗口运行。** 保持当前已审核镜像、认证环境、账号和数据库；不重启 Postgres/Redis，不执行数据库迁移、管理员初始化或任务恢复。优雅等待现有工作退出，hard NFS 也可能等待，不承诺固定完成时间。

```bash
bash scripts/manage.sh nas infra repair switch \
  /var/lib/mx-static/nas-repair/infra-a0131341096e4ba9b9e3e61c3e2581dd/copy-220e052707a64e0aa53f2208b54448e2 \
  --maintenance --write-test
```

参数必须指向**成功 copy 尝试目录**，不是原修复目录、旧 cutover 目录或清理目录。后台任务会打印唯一单元和精确 journalctl 命令；提交不代表完成。systemd 使用 `ReadOnlyPaths=/data`，仅保护本工具直接文件访问；Docker daemon 不受该文件命名空间限制，因此容器操作另有严格的十服务清单、配置、镜像及数据库身份核对。复制无带宽限制。

## 执行边界与证据

1. 核对成功 copy 回执确实覆盖原清单，当前部署仍与修复准备基准一致，旧报告/NAS 标记及卷选项未变；拒绝其他 Docker 媒体消费者。
2. 新建 `/var/lib/mx-static/nas-cutover/po_infra_media_data-<ID>` 私有报告。重新审核当前版本、钉住当前镜像，生成独立覆盖。`web` 直接启动已审核的 gunicorn；worker 使用 `MX_RECOVER_STALE_AGENT_RUNS=0`，其余配置、凭据、端口及媒体父卷保持原值。
3. 在隔离容器内执行 NFS 目录身份及自身 4 KiB 探测；重新扫描两侧目录元数据，拒绝内容冲突、大量未审核增量或缺少 NAS 父目录。共享大小/整秒 mtime 相符仍采用已接受的 quick-check；仅哈希共享 mtime 差异，最多 1,000 对/双侧 512 MiB，不重读全量约 500 GiB。
4. 记录新执行状态，把 NAS 标记明确关联到新报告；旧标记与旧执行收据完整保存在 `repair-lineage.json`，旧报告文件不修改。此后旧操作会因身份不符而被阻止，不应手工恢复旧标记或删除执行记录。
5. 优雅停止已审核十个消费者，数据库/Redis 保持原 ID。保存全量停止写入后的 SSD 元数据；重新取两侧差异，按无覆盖方式补齐本次 SSD 独有文件。上限 10,000 文件/16 GiB，NAS 留 1 GiB 余量；不自动放宽。NAS 独有文件与所有既有 NAS 权限保留，不调用旧 rsync 镜像、隔离多余文件或属性覆盖逻辑。
6. 再次扫描确认没有 SSD 独有文件、没有共享冲突，SSD 全量元数据在整个停写补齐期间一致。只留下本次私有清单及日志，清除本次工具自己创建且身份相符的空暂存目录；既有失败暂存证据保留。只读再次确认原生 NFS 卷身份。
7. Compose 仅重建这十个服务，使用 `--no-deps --no-build --pull never --no-start --force-recreate --remove-orphans=false`。先验证 NAS 子卷、nocopy、只读网关及其他配置，再按组启动。缺少外部 NFS 卷/元数据时失败，不创建 SSD 替代品。
8. 检查健康、实际内核 NFS 子挂载、现有媒体 HTTP Range 读回；用九个写服务的默认容器用户分别写入、改名和读回自身小探测并删除自身 inode。网关只读。复核部署、目录及数据库/服务身份后记录 `nas_repair_switch_complete`。

新报告中的 `repair-final-<ID>/files.jsonl` 是停写时 SSD 元数据证据；`union-manifest.jsonl` 和 `verify-<ID>/` 记录补齐及核验。它们**不能直接传给旧 reclaim**，也不是永久有效的删除授权。

## 完成后仍需继续

回传 `nas_repair_switch_complete` 整条记录及新报告目录，不贴私有 Compose、环境或容器配置。随后确认现有 MX-H2I 用户登录、联网、旧媒体读取、新媒体写入及后台任务；不能以容器 healthy 代替业务验收。

此命令保留 `business_acceptance_pending=true`、`recovery_registration_pending=true`、`reclaim_ready=false`。需要依据新成功报告更新 Git 登记（旧 plan 不再沿用）、核验/更新已安装的恢复快照，完成适配 NAS 现有属性的新清理前核验。当前 `recovery check` 仍指向旧报告，会继续阻止恢复；不要仅安装旧登记便宣称已覆盖新容器。

受控重建强制使用外部 NFS 卷。外部旧发布入口仍可能省略该覆盖，防绕过约束尚未完成；重启、双方断电及 Docker 重装尚未实际演练。新切换成功不等于这些场景全部验收。Part 1 达到约定“可回收但保留 SSD”的终点后，才开始 Part 2。

## 失败或中断

任务不会在重启后自动续跑，也不会自动恢复 SSD 服务。查看本任务日志中的 `nas_repair_switch_preparing`、`cutover_phase`、`nas_repair_switch_failed` 和新报告。错误可能发生在停写前、业务已停止、部分容器重建或部分服务已启动；不要再次执行旧 copy/cutover/redeploy，不删除暂存证据。

在确认失败原因已处理后，同一新报告可显式运行：

```bash
bash scripts/manage.sh nas infra repair resume <本次新切换报告目录> --maintenance --write-test
```

仅支持记录明确的阶段：原 SSD 消费者仍完整时重新停写复核；已经完整登记新 NAS 容器 ID 时只核验并补启动这些容器、重做探测，不再复制或重建。若处于可能部分创建、尚未登记完整新 ID 的阶段，工具拒绝自动接管，须先检查现场；不要手工伪造 `new_ids`。任何阶段均不允许自动退回 SSD。

本地验证使用真实临时文件检查无覆盖合并、属性保留、源变化/冲突拒绝，并模拟 Docker、systemd 与 NFS 的流程边界；不能替代 EL8、真实 NFS 和现有用户登录的现场验收。
