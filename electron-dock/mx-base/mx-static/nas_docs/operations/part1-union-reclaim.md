# Part 1 验收完成，保留 SSD 待日后回收

2026-09-24，服务器已完成当前版本 NAS 修复切换：

- 成功单元：`mx-nas-part1-repair-switch-194cd1338d.service`。
- 新报告：`/var/lib/mx-static/nas-cutover/po_infra_media_data-33e5abb193d04e7595251a5e6a6046ae`。
- 最终停写证据：上述目录下的 `repair-final-11cccd4afb1243a79a84ff98015babe9`。
- 十个媒体服务已核对 NFS 子挂载、HTTP 媒体读取和应用写入探测；Postgres/Redis 保持原 ID，SSD 未删除。
- 用户起初回答业务“尚未全部检查”；最新验收核验回执已记录业务验收和文件核验通过，见下文。

## 最新服务器回执与登记

- 独立媒体登记已写入 `/etc/mx-static/nas/infra-media.json`，恢复快照 `a25a1eae157b9e99636f` 安装成功；infra 已核对并纳入 `migrated` 策略，timer active/enabled。delta 等待迁移。
- 未验收的首次核验清单尾号为 `df68511205fd47c9af3be3d643455300`，不选用。
- 后续单元 `mx-nas-part1-reclaim-check-53504b393b.service` 成功，最终清单位于新报告下的 `reclaim-plan-a1dc4bb0dfea4d5d83ce143daaf052e9`。
- 200,543 个普通文件，538,031,658,699 逻辑字节（约 501.08 GiB）；200,464 个 quick-check 匹配，79 个差异文件双侧哈希一致；保留 1,681 个文件的 NAS 原属性。
- `files_verified=true`、`business_acceptance_recorded=true`、`recovery.verified=true`、`reclaim_ready=true`；`deletion_authorized=false`、`source_deleted=false`。
- SSD 清单和停写清单摘要相同：`049f14e174ae53e42400d775605e03310ede473ac61cdd1f77fa031d3b5c099d`。这仍是清单/有限差异哈希证明，不是所有文件的全量内容哈希。

Git 的 Part 1 `report` 保持新报告，`plan` 现显式选择上述已验收清单。历史报告、未验收清单及原 SSD 文件继续保留，不改写、不删除。Part 1 已满足“验收通过，SSD 保留到日后另行回收”的约定终点；更新 Git 本身不会更新服务器安装快照或启动任何删除。

此前 `Deployment files changed since preparation.` 的原因是服务器仍选择旧报告 `830225384207402a8ba23a2364d252d1`；当时当前部署与新报告一致。现已采用 [独立媒体恢复](media-runtime.md) 并取得服务器登记和安装回执，不再按旧错误重复修复。迁移/清理的严格校验保持原样，不修改历史报告摘要、重复切换或清除 NAS 标记。

## 现在执行

先将本次清单登记更新同步到服务器 mx-static 目录，然后执行。前一步失败则停止，不跳过检查：

```bash
bash scripts/manage.sh nas infra locate &&
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check
```

`locate` 中的计划应为 `reclaim-plan-a1dc4bb0dfea4d5d83ce143daaf052e9`。安装只更新恢复代码/声明快照，保留启用策略；不重启或重建业务，不执行清理。检查应显示 infra 已核对、已纳入、安装快照一致且 timer active/enabled。无需因清单登记再次复制 Part 1、重新切换或重复业务验收。

通过后可以按约定启动 Part 2 的独立不限速在线预复制：

```bash
bash scripts/manage.sh nas delta copy --unlimited
```

使用命令返回的唯一单元/journalctl 跟踪此次任务。`precopy_start` 应显示 `bandwidth_unlimited=true`、`bandwidth_limit_mib_per_second=0`；最终成功阶段为 `precopy_pass_complete`、`last_exit_code=0`。任务只复制 delta 的 raw-media（含 tmp），不停止业务、不切换挂载、不删除源文件。Part 2 目前仅支持预复制；正式切换、恢复登记和可回收清单仍需该实例自己的部署审查及适配，不能复用 Part 1 的报告或宣称预复制后可删 SSD。

Part 1 旧 SSD 尚未删除，预复制也不会释放 `/data` 空间。沿用单卷顺序，不并发两卷；复制期间观察 `df -hT /data` 和业务状态，按需暂停新的大批采集，不为释放空间自动清理文件。

## 新清单如何证明可以保留到日后回收

1. 核对新切换执行记录、当前部署配置、十个消费者 ID、镜像、NAS 声明和实际内核挂载，保留数据库/Redis 身份；拒绝其他 Docker SSD 消费者。
2. 读取停写最终报告的完整 SSD 清单并核对摘要；重新扫描 SSD，要求目录/文件元数据与停写时完全一致。新增、缺失、替换、ctime/权限变化、链接或子挂载均阻止通过，不将在线变化直接采纳为新基准。
3. 仅访问上述 SSD 清单在 NAS 的对应路径。NAS 独有文件和目录不扫描、不归入删除对象；它们的在线新增不会被当作“多余文件”。NAS 对应文件必须是同文件系统上的单链接普通文件，父目录不得是符号链接。
4. 相同大小和整秒 mtime 按已接受的 quick-check 策略核验；NAS 原有 uid/gid/mode 保留。大小不同立即失败；mtime 不同只对有限候选进行双侧 SHA256，内容相同才接受，适用时验证哈希文件名。上限仍为 1,000 对、双侧 512 MiB，不扩大为全卷读取。quick-check 本身不是全量内容哈希证明。
5. 保存新的 SSD `files.jsonl`、NAS 对应路径 `nas-files.jsonl`、有限哈希证据 `hashes.jsonl` 及各自摘要。再次检查 SSD 未变化、每个 NAS 对应文件仍匹配刚验证的完整元数据；再次检查部署/挂载、NFS 身份及现有媒体 HTTP 读取。
6. 核对安装代码/登记是否最新、infra 是否被恢复策略选中、timer 是否持久启用且 active。新 `plan.json` 同时记录技术核验结果和业务验收事实，不以技术成功代替业务验收。

文件清单位于新切换报告下独立的 `reclaim-plan-<ID>`。`files_verified=true` 表示此时文件核验通过；只有实际业务验收明确记录且恢复覆盖通过，才标记 `reclaim_ready=true`。工具不会把清单自动写入 Git `profiles.json`，也不会执行删除。切换收据中的 pending 字段保留其历史阶段含义；当前事实看最新核验结果。

本次 `infra cleanup check --business-accepted` 已完成，并依据回执显式登记清单；该参数在 **check** 上仅登记验收，仍不会删除。以后若实际回收前状态变化而核验拒绝，先审查变化，再按流程生成并登记新清单，不能改写旧证据来绕过。

## 用户现在请求的 SSD 删除命令

用户已在上述验收后询问执行 Part 1 SSD 回收的命令。同步本次登记后，按前文 `locate` / `recovery install` / `recovery check` 确认当前选中的是 `reclaim-plan-a1dc4bb0dfea4d5d83ce143daaf052e9` 且恢复覆盖通过，然后执行：

```bash
bash scripts/manage.sh nas infra cleanup --business-accepted
```

此命令**真正删除**已登记清单内、逐项重新核验通过的旧 SSD 文件；范围固定为 `/data/docker/volumes/po_infra_media_data/_data/data_hub_raw_media`，不删除根目录、其他 media、NAS 文件、数据库或队列。不要加 `check`（加上仅核验）。项目名已选择任务，无需 `task part1`。执行中不要发布、重建容器或修改旧 SSD 文件。

跟随提交结果所列单元日志，也可执行 `bash scripts/manage.sh nas infra logs`。最终应有 `reclaim_result`、`phase=ssd_files_reclaimed` 和单元 `Succeeded`，再用 `df -hT /data` 核对释放空间。文件逻辑大小约 501.08 GiB，实际释放量以 df 为准。若失败，保留清单及删除意图日志、回传错误；不能直接 rm、改清单或绕过检查。尚未收到本次删除完成回执。

## 日后删除仍有独立校验

UNION 清单不是永久删除许可。实际删除入口要求显式业务验收参数、准确登记的当前计划、恢复覆盖仍有效、当前执行记录摘要相同；未验收或未登记的清单被拒绝。修复后的报告不能再交给未核验 NAS 对应清单的旧计划流程绕过这些条件。

删前重新检查全部剩余 SSD 文件及 NAS 对应文件。NAS 核验基于保存的 **NAS 自身**元数据，所以不会把已接受的 NAS 0600 误当作必须改成 SSD 0644；NAS 文件 inode、nlink、size、mtime、ctime 或权限后来变化则停止，保留 SSD 供重新核验。每批前核对部署/目录，每个文件删除前再次核对精确 SSD 状态与 NAS 对应状态，持久记录删除意图；中断只按已记录意图恢复。始终保留 SSD 目录、named volume、media 其他目录以及全部 NAS 文件。

当前没有实际 SSD 清理回执，磁盘可用空间不会因只读核验而增加。重启、NAS 迟启动、双方断电或 Docker 重装未演练；外部发布入口强制携带 NAS 覆盖的约束仍待完成，不能把恢复 timer 当作该约束。Part 1 业务验收及清理前核验完成后，才按约定推进 Part 2 的独立迁移。
