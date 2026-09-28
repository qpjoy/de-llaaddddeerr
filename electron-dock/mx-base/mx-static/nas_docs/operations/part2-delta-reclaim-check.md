# Delta 切换后的 SSD 只读核验

2026-09-28，服务器正式切换报告为 `delta-2084964733fa4abfb8d0409ac076c699`。随后用户回传十个媒体服务全部匹配内核 NFS，`locate` 指向该报告，delta / infra 恢复均已核对、已纳入，安装快照当前、timer active/enabled。SSD 仍保留，实际业务验收尚未收到确认。

## 最新核验：服务器已通过，业务验收待完成

`mx-nas-part2-delta-reclaim-check-c93f38cb82.service` 已返回 `nas_delta_reclaim_check_complete` 并 `Succeeded`。本次报告：

```text
/var/lib/mx-static/nas-delta-cutover/delta-2084964733fa4abfb8d0409ac076c699/reclaim-check-93f7115885534b64a254a5e7e0ae01a6
```

- SSD 文件 319,813 个，逻辑大小 1,006,412,732,832 字节，约 937.29 GiB；4 个目录包含保留的根目录。
- SSD 清单与停写清单 SHA256 均为 `0f7742a8730369e7d22de3a9b7cd2f0a539944e018da9b72d720e98968603f18`。
- 全部 319,813 个 NAS 对应文件通过 quick-check；`hashed_equal=0`、`hashed_bytes=0`，本次没有执行内容哈希，不应描述成全量内容校验。
- `files_verified=true`，恢复已核对、安装当前、策略已选择，timer loaded/active/enabled。
- 用户随后明确回复“尚未全部检查”；`business_acceptance_recorded=false`、`verification_ready=false` 保持有效。
- `reclaim_ready=false`、`deletion_supported=false`、`deletion_authorized=false`、`source_deleted=false`：SSD 保留；该只读报告没有删除能力，也未选定删除清单。

当前无需为上述 false 标志重新复制、切换或重复这轮检查。先实际确认 delta 现有账号登录/联网、旧媒体读取、新媒体写入及后台任务；后续登记验收和准备删除时，再按当时的运行/文件状态核验。此回执只证明本次快照，不保证之后没有部署或文件变化。新增的显式回收步骤见 [delta 业务验收与 SSD 回收](part2-delta-cleanup.md)：无需手工更改这份检查报告的 false 标志，实际验收后准备独立计划。

## 核验命令（本次已执行成功）

以下是已完成的只读核验命令。它最初对应快照 `e6b505be05ffb0f04888`；新增回收命令的当前安装步骤见 [回收流程](part2-delta-cleanup.md)，不要为了重复本轮核验而重新安装旧版本：

```bash
bash scripts/manage.sh nas recovery install &&
bash scripts/manage.sh nas recovery check &&
bash scripts/manage.sh nas delta cleanup check
```

检查由后台 systemd 单元执行。使用输出给出的精确 `journalctl` 命令跟随日志，完成须有 `nas_delta_reclaim_check_complete` 和该 unit 的 `Succeeded`。检查期间避免同时进行应用发布、容器重启或更改存储登记。hard NFS 暂时无响应时访问可能等待，不强卸载或并发提交重试。

本命令不停止业务、不创建容器/卷、不复制、不更改媒体权限、不删除；`ReadOnlyPaths=/data /mnt/nas` 限定任务进程对两侧媒体的访问。它也不执行数据库查询、迁移、账号初始化或队列清理。Docker exec 仅在当前 web 默认身份读取 NAS 目录身份/挂载信息，HTTP 仅读取原有媒体样本前 1 KiB。

若已经实际确认 delta 账号登录/联网、新旧媒体读写及后台任务正常，可以在这次检查时附带 `--business-accepted`。不要因为存储状态匹配就填写该标记。

## 核验内容和结果

- 从独立 `delta-media.json` 读取成功报告，不修改原切换、复制记录、NAS marker 或 Git 清理清单。
- 核对当前十个媒体服务的 NAS/内核挂载、数据库/队列健康和数据挂载、其他容器或驱动的媒体访问别名、恢复安装及启用状态。正常发布前后的 Env、镜像、容器 ID 可以变化；一份核验开始后会固定当前状态，中途重部署/重启则拒绝通过。
- 重新扫描旧 SSD 元数据，与正式切换时的停写清单严格一致才继续；核对每个文件在 NAS 上的对应项。大小和修改时间一致走 quick-check，修改时间不同的同大小文件在已有预算内比对内容哈希。**不是 900 GiB 全量哈希验证**。
- NAS 同名文件缺失、内容冲突、符号链接、硬链接、SSD 新写入、报告或目录身份变化均阻止通过。NAS 独有业务新增不扫描、不删除；NAS 属性保留。

独立证据位于成功报告下的 `reclaim-check-<UUID>/`，包括 `check.json`、两侧元数据清单、有限哈希证据和不含 Env 明文的运行指纹。新的回执不会自动成为已选中的删除清单，因此 `nas delta locate` 显示“清理清单：未登记”仍属预期。

关键字段：

| 字段 | 含义 |
| --- | --- |
| `files_verified=true` | 本次停写清单、SSD 和 NAS 对应文件核验通过 |
| `business_acceptance_recorded` | 是否显式提供本次实际业务验收 |
| `recovery.verified=true` | 本次恢复登记、当前安装和启用状态已核对 |
| `verification_ready` | 文件核验通过且验收/恢复条件齐备，仅表示只读核验条件 |
| `reclaim_ready=false`、`deletion_supported=false` | 这份只读报告不直接支持删除；需独立 prepare 生成回收计划 |
| `deletion_authorized=false`、`source_deleted=false` | 未授权也未执行删除 |

该 `delta-retained-review-v1` 回执不是 infra 的回收计划，不能传给 infra / legacy `reclaim`。已新增 [显式 delta 回收流程](part2-delta-cleanup.md)：实际验收后 prepare 新清单，再准确指定清单执行实时复核和逐文件删除；不得删除整个 Docker 卷、media 的其他目录、NAS、数据库或队列。

本地 469 项 NAS 测试（含 20 个新增 delta 核验用例）、38 个 Python 文件的 Python 3.6 语法检查、11 个 Bash 语法检查通过。验证使用真实临时文件与模拟 Docker/NFS/systemd 边界，不替代服务器的当前文件检查或真实重启/断电演练。
