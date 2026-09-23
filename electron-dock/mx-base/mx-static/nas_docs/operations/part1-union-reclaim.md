# Part 1 新恢复登记与清理前核验

2026-09-24，服务器已完成当前版本 NAS 修复切换：

- 成功单元：`mx-nas-part1-repair-switch-194cd1338d.service`。
- 新报告：`/var/lib/mx-static/nas-cutover/po_infra_media_data-33e5abb193d04e7595251a5e6a6046ae`。
- 最终停写证据：上述目录下的 `repair-final-11cccd4afb1243a79a84ff98015babe9`。
- 十个媒体服务已核对 NFS 子挂载、HTTP 媒体读取和应用写入探测；Postgres/Redis 保持原 ID，SSD 未删除。
- 用户回答“尚未全部检查”现有账号登录、联网、旧媒体读取、新媒体写入及后台任务；**业务验收仍待完成**。

Git 的 Part 1 `report` 已改选新报告，`plan` 置空。历史报告与旧清单仍留在服务器，不删除、不改写，也不继续选用旧清单。不能只凭更新 Git 就认为服务器安装完成。

## 现在执行

同步本次代码后，在服务器 mx-static 目录依次执行；前一步失败则停止，不跳过检查：

```bash
bash scripts/manage.sh nas infra storage check &&
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery enable --migrated &&
bash scripts/manage.sh nas recovery check &&
bash scripts/manage.sh nas infra cleanup check
```

安装操作更新本机恢复代码/声明快照，保留原恢复策略；enable 检查当前容器后启用持久 timer。安装不重建业务；timer 如触发，只允许补启动已经登记的 NAS 容器，健康容器不重启。恢复检查应显示 infra 配置/挂载核对通过、已纳入，且安装快照与当前代码/声明一致；delta 等待迁移是预期结果。

最后一条提交只读后台核验任务，打印唯一单元和 journalctl 命令。systemd 将 `/data` 与 `/mnt/nas` 设为只读；工具只向新私有本地报告写证据，不停止业务、不复制媒体、不修改 NAS 权限、不删除 SSD。没有带宽节流，不读取整卷内容做全量 SHA256。

回传统一恢复检查摘要和 `nas_reclaim_check_complete` 整条记录。当前不要添加 `--business-accepted`。文件检查成功、恢复覆盖通过但业务验收未记录时，`reclaim_ready=false` 是正确结果，不代表文件核验失败。

## 新清单如何证明可以保留到日后回收

1. 核对新切换执行记录、当前部署配置、十个消费者 ID、镜像、NAS 声明和实际内核挂载，保留数据库/Redis 身份；拒绝其他 Docker SSD 消费者。
2. 读取停写最终报告的完整 SSD 清单并核对摘要；重新扫描 SSD，要求目录/文件元数据与停写时完全一致。新增、缺失、替换、ctime/权限变化、链接或子挂载均阻止通过，不将在线变化直接采纳为新基准。
3. 仅访问上述 SSD 清单在 NAS 的对应路径。NAS 独有文件和目录不扫描、不归入删除对象；它们的在线新增不会被当作“多余文件”。NAS 对应文件必须是同文件系统上的单链接普通文件，父目录不得是符号链接。
4. 相同大小和整秒 mtime 按已接受的 quick-check 策略核验；NAS 原有 uid/gid/mode 保留。大小不同立即失败；mtime 不同只对有限候选进行双侧 SHA256，内容相同才接受，适用时验证哈希文件名。上限仍为 1,000 对、双侧 512 MiB，不扩大为全卷读取。quick-check 本身不是全量内容哈希证明。
5. 保存新的 SSD `files.jsonl`、NAS 对应路径 `nas-files.jsonl`、有限哈希证据 `hashes.jsonl` 及各自摘要。再次检查 SSD 未变化、每个 NAS 对应文件仍匹配刚验证的完整元数据；再次检查部署/挂载、NFS 身份及现有媒体 HTTP 读取。
6. 核对安装代码/登记是否最新、infra 是否被恢复策略选中、timer 是否持久启用且 active。新 `plan.json` 同时记录技术核验结果和业务验收事实，不以技术成功代替业务验收。

文件清单位于新切换报告下独立的 `reclaim-plan-<ID>`。`files_verified=true` 表示此时文件核验通过；只有实际业务验收明确记录且恢复覆盖通过，才标记 `reclaim_ready=true`。工具不会把清单自动写入 Git `profiles.json`，也不会执行删除。切换收据中的 pending 字段保留其历史阶段含义；当前事实看最新核验结果。

用户完成并确认业务验收后，可以再次运行 `infra cleanup check --business-accepted` 生成新的核验和验收记录；该参数在 **check** 上仅登记验收，仍不会删除。通过后再显式登记该清单、更新安装快照。到此 SSD 继续保留，按用户安排以后再删除；本轮不提供或执行删除命令。

## 日后删除仍有独立校验

UNION 清单不是永久删除许可。实际删除入口要求显式业务验收参数、准确登记的当前计划、恢复覆盖仍有效、当前执行记录摘要相同；未验收或未登记的清单被拒绝。修复后的报告不能再交给未核验 NAS 对应清单的旧计划流程绕过这些条件。

删前重新检查全部剩余 SSD 文件及 NAS 对应文件。NAS 核验基于保存的 **NAS 自身**元数据，所以不会把已接受的 NAS 0600 误当作必须改成 SSD 0644；NAS 文件 inode、nlink、size、mtime、ctime 或权限后来变化则停止，保留 SSD 供重新核验。每批前核对部署/目录，每个文件删除前再次核对精确 SSD 状态与 NAS 对应状态，持久记录删除意图；中断只按已记录意图恢复。始终保留 SSD 目录、named volume、media 其他目录以及全部 NAS 文件。

当前没有实际 SSD 清理回执，磁盘可用空间不会因只读核验而增加。重启、NAS 迟启动、双方断电或 Docker 重装未演练；外部发布入口强制携带 NAS 覆盖的约束仍待完成，不能把恢复 timer 当作该约束。Part 1 业务验收及清理前核验完成后，才按约定推进 Part 2 的独立迁移。
