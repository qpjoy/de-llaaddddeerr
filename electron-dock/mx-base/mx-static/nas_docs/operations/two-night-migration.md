# 两晚分卷执行：先 po_infra，再 delta_59202

**最新执行策略：用户要求取消额外全量 SHA256 复读并开始切换，执行 [rsync 常规切换流程](rsync-cutover.md)。成功预复制 + 停写增量同步 + 逐路径快速检查 + 业务验收，不再要求全卷 SHA256 完成；下文关于 SHA256 清单的设计保留为可选方案。**

用户最新要求：今晚优先完成较小的一卷，验收后回收其旧 SSD 媒体空间，明晚处理另一卷；po_infra/mx_data 可安排 **10–30 分钟停写窗口**。最新补充：四小时只是耗时期望，取消复制的固定运行时限，优先安全完成单卷；维护停写窗口仍为 10–30 分钟。用户已条件授权验收后的旧媒体清理，不再把“永远不删除”当成目标；只清理原卷里的 raw_media，不能删除整个 volume、数据库、队列或其他项目目录。

NAS 目前没有独立备份，底层文件系统/阵列健康/快照尚未知，NFS 只是共享协议。回收 SSD 后将只剩 NAS 副本，不能保证 NAS 整机故障时恢复；用户最新确认是四盘位群晖，但管理凭据遗忘、SSH 22 超时；本轮暂缓 OSS 和管理端登录，先开始已通过 NFS 探测的在线预复制。[后端检查](nas-health-and-oss.md) 保留为未确认，NAS SSH 和云端备份均不是预复制前置条件。本轮没有上传 OSS、创建收费资源、切换生产或删除数据。

## 今晚与明晚的顺序

| 批次 | 实例 / 原卷 | 旧统计 raw_media | 本轮证据支持的安排 |
| --- | --- | ---: | --- |
| Part 1 今晚 | mx_data / po_infra_media_data | 497.47 GiB | 已完成预复制，实际本轮 497.71 GiB / 3 小时 10 分 35 秒；下一步完整校验 |
| Part 2 明晚 | delta_59202 / delta_59202_media_data | 928.57 GiB | Part 1 验收后复用流程，等效单遍 4.77 小时，不承诺四小时完成 |

不同时启动两卷。128 核不等于两份独立 NAS 带宽；并行能否提高总吞吐尚未验证。先回收较小卷约 499G 的历史 du 占用即可明显增加 SSD 余量，实际回收量必须以 df 和打开的旧文件句柄为准。

## 当前检查点：第一卷预复制完成，改为准备 rsync 常规切换

用户已回传第一卷 `precopy_pass_complete`、`last_exit_code=0` 和 `mx-nas-part1-po.service: Succeeded.`；03:04:04 至 06:14:39 完成，总大小 534,415,703,995 bytes，整轮等效约 44.57 MiB/s。**不要再为取消限速重跑这轮已完成的复制**。在线 SHA256 已运行到约 51.38 GiB，用户明确选择取消后续全量复读。下一步按 [切换准备](rsync-cutover.md) 检查真实 Docker NFS 子目录挂载和候选配置，再停写完成增量；并非只看总大小直接切换或清理。

以下保留已执行的预复制流程和历史启动检查点，供故障恢复及第二卷参考。

用户已明确不再等待 NAS 管理凭据，开始迁移。服务器链路、NFS 权限和样本内容已验证，先按下一节启动 po_infra_media_data；不重复小样本或继续 SSH/端口探测。脚本启动时仍核对本机 Docker、源卷、消费者、NAS 导出与目标身份，任何不符都会停止并保留数据。

启动后先回传 journal 中的初始日志和是否出现 `precopy_start`，无需等数小时结束才报告。若提示单元已存在或 guard 拒绝，保留错误原文，不删除锁或 NAS 目标来绕过检查。用户已回传 systemd 接受 mx-nas-part1-po.service 和展开后的进度：约 7.39 GiB、1%、显示速率 35.95 MB/s，已传输 92,649 个文件；这证明截图时正在传输，不是最终成功或已校验完成。

## 已交付：在线预复制入口

先通过 Git 更新服务器上的 mx-static，保持在该目录。以下启动的是**完整预复制，不是小样本测试**；服务继续使用 SSD。

```bash
sudo systemd-run --unit=mx-nas-part1-po \
  --property=RuntimeMaxSec=infinity \
  --property=TimeoutStopSec=90s \
  --property=ReadOnlyPaths=/data \
  /bin/bash "$PWD/scripts/nas-precopy.sh" po_infra_media_data --copy
```

`ReadOnlyPaths=/data` 只约束这个复制单元的私有挂载命名空间，其他 Docker/K8s 进程不受该只读视图影响。脚本固定使用本机 `/var/run/docker.sock` 读取 Docker 元数据（只改变本进程环境，不修改 Docker context 配置），不创建/停止容器。`RuntimeMaxSec=infinity` 明确取消运行时限，正常情况下持续到单卷本轮预复制完成；真实读写错误仍按失败处理并保留两边数据。`TimeoutStopSec=90s` 仅是收到停止请求后的退出宽限，不会在 90 秒或四小时主动停止复制；hard NFS D 状态仍可能延迟退出。systemd-run 启动返回成功也不代表复制完成。已核对 systemd v239 原始文档支持这两个属性：[私有只读路径](https://github.com/systemd/systemd/blob/v239/man/systemd.exec.xml)、[运行时限](https://github.com/systemd/systemd/blob/v239/man/systemd.service.xml)。实际 EL8 执行仍以现场回传为准。

若已经用旧的四小时参数启动，更新 Git 或修改这里的命令不会改变正在运行的单元。不要重复启动或先停止正在复制的任务，先贴回实际状态：

```bash
sudo systemctl show mx-nas-part1-po.service \
  -p ActiveState -p SubState -p RuntimeMaxUSec -p MainPID -p ExecMainStartTimestamp
```

`RuntimeMaxUSec=4h` 表示旧时限仍有效；`infinity` 才是无运行时限。这里不提供未经现场确认的热修改命令：systemd v239 原始实现把此属性的 D-Bus 设置限制在创建临时单元阶段，不能假定 `systemctl set-property` 能为已运行任务取消时限。[v239 实现](https://github.com/systemd/systemd/blob/v239/src/core/dbus-service.c)

观察与取回结果：

```bash
sudo journalctl -fu mx-nas-part1-po
```

按 Ctrl+C 只退出日志查看，不停止该复制服务。完成后：

```bash
sudo systemctl show mx-nas-part1-po -p ActiveState -p SubState -p Result -p ExecMainStatus
sudo journalctl -u mx-nas-part1-po -n 100 --no-pager
sudo bash scripts/nas-precopy.sh po_infra_media_data --status
df -hT /data
```

复制期间不要部署/重建相关消费者、改动目标或启动其他目标写入工具；当前 guard 在启动时核对身份，无法给所有外部管理员操作加锁。每 15–30 分钟查看最新 df 和业务错误/延迟，剩余空间快速下降时先限制新的批量采集，不靠复制自动腾空。

成功退出的临时 unit 可能被 systemd 自动回收，此时 show 显示 not-found；结合保留的 journal 和 marker 判断，不能只看 unit 是否存在。

不要重复启动同名 unit；已有 unit、全局锁冲突或中断状态都先看日志。若需暂停该后台预复制，可 `sudo systemctl stop mx-nas-part1-po`；只停止此复制单元，不停止 Docker、数据库、队列或业务容器。保留目标和 marker；恢复前评估退出原因，不删锁文件或目标目录。

### 限速与当前 blob 日志

默认 60 MiB/s 是在线业务资源余量的保守设置，不是文件完整性的要求。当前服务器到 NAS 是千兆链路；取消限速能否提速取决于持续吞吐、机械盘与业务竞争，不能承诺翻倍。新增 `--copy --unlimited` 只把 rsync 的 bwlimit 设为 0，保留单卷互斥、低调度优先级、源/目标保护和全部错误处理；不修改已运行的 rsync。[rsync 3.1.3 参数说明](https://github.com/RsyncProject/rsync/blob/v3.1.3/rsync.yo)

`[48.0K blob data]` 是日志条目的大小，不是 48 KB/s 传输速度或数据损坏结论。旧版把 rsync 的回车进度直接写入 journal，可能被折叠；先不停止任务，展开最近日志：

```bash
sudo journalctl -u mx-nas-part1-po -n 3 -a -o cat --no-pager | tr '\r' '\n' | tail -n 15
```

新版将 CR 进度转换为单行 JSON，约每 5 秒输出 `rsync_progress`，保留最后进度；错误与最终统计输出为 `rsync_output`，不会因进度节流被丢弃。`--outbuf=N` 在 rsync 3.1.3 中可用，日志只转换输出，不改变数据流。原始 rsync 退出码仍用于判断成功，24 等非零不忽略。[journalctl v239 的 -a](https://github.com/systemd/systemd/blob/v239/man/journalctl.xml)

最新展开截图为 `7,932,663,327  1%  35.95MB/s  0:03:30 (xfr#92649, to-chk=101256/193909)`，末尾还有一条未完整显示的 `7,932,702,365`。当前显示速率低于 60 MiB/s，尚不能认定限速是主要瓶颈；文件数量进度不能代替字节进度，已传输文件多而总字节占比低，说明当前阶段小文件较多。建议先继续当前作业，再比较相隔数分钟的累计字节与速率；单张截图不保证后续大文件速度，也不能把时间列当成整卷只剩 3 分 30 秒。

如果当前速度明显低于上限，取消限速未必改善；若接近完成，重新启动的扫描成本也可能不值得。要立刻改成不限速，先通过 Git 同步新版，运行 `bash scripts/nas-precopy.sh --help` 确认有 `--unlimited`，然后在服务器 mx-static 目录执行以下**只停止复制单元**的续跑流程：

```bash
sudo bash <<'BASH'
set -euo pipefail
systemctl stop mx-nas-part1-po.service
old_state="$(systemctl show mx-nas-part1-po.service -p ActiveState --value)"
old_pid="$(systemctl show mx-nas-part1-po.service -p MainPID --value)"
case "$old_state" in inactive|failed) ;; *) echo "Old copy has not stopped: $old_state" >&2; exit 1 ;; esac
if [[ "$old_pid" != 0 ]]; then echo "Old main process remains: $old_pid" >&2; exit 1; fi
systemd-run --unit=mx-nas-part1-po-unlimited \
  --property=RuntimeMaxSec=infinity \
  --property=TimeoutStopSec=90s \
  --property=ReadOnlyPaths=/data \
  /bin/bash "$PWD/scripts/nas-precopy.sh" po_infra_media_data --copy --unlimited
BASH
```

如果旧单元已经被回收而查询失败，或 stop 卡住/返回失败，保留输出，先确认旧作业结果及残留进程；不绕过检查。新单元仍使用同一个目标、marker 和全局锁，旧复制/子进程仍持锁时拒绝运行；不要删除锁或 marker。未完成的文件可能重新传输，已完成且未变化的文件按 quick-check 跳过；最终仍需要完整一致性校验，续跑不是自动切换。

不限速续跑启动后改看新单元：

```bash
sudo journalctl -u mx-nas-part1-po-unlimited -n 40 --no-pager
sudo journalctl -fu mx-nas-part1-po-unlimited
```

本节未在服务器执行停止/续跑，正在运行的旧任务不会因本机代码改动自动取消限速。`precopy_start` 的 `bandwidth_unlimited=true`、`bandwidth_limit_mib_per_second=0` 表示新版此次没有 rsync 速率上限；不代表文件系统/网络没有其他瓶颈。

### 工具实际做什么

- 仅允许 mx-internal-server 的本机 Docker /data/docker 及两个已登记卷，核实 local Driver/Options/源目录和 SSD 设备，核对该实例全部 10 个媒体消费者。消费者已有 raw_media 子挂载，或发现已登记的新 NFS 卷名/直接 NAS 目标路径已被容器挂载时拒绝再次预复制，避免旧 SSD 覆盖 NAS 的新写入。它不是对其他客户端、宿主机进程或任意 Kubernetes 写入者的完整审计。
- NAS 仍须是已验证导出，通过保持打开的 fd 创建/访问 `data/docker/media-volumes/<原卷名>/data_hub_raw_media`。只给新目录设置权限，不修改已有 shared_*。遇到未登记的已有目标、链接、非预期设备、公开可写的管理目录、被替换的目标 inode，停止并保留现场。
- 管理标记 `.mx-static-precopy.json` 位于该卷的 NAS 管理父目录，业务只挂 raw_media 子目录，标记不进入媒体 URL。记录 job、源身份、目标 inode、消费者指纹与退出码，只有同一作业才能续跑。
- 原生 rsync 一次处理整树，`-a --numeric-ids --one-file-system`，默认限速 60 MiB/s，可显式 `--unlimited` 取消；保留低调度优先级和私有 partial-dir，不以并发两卷或省略校验赶工。复制全部 raw_media（含 tmp）；不使用 delete、remove-source-files、inplace、append 或对业务树的 `-L`。不打压缩包，不修改数据库。
- 使用与小批工具相同的本机锁，并传给 rsync 子进程；一个作业未退出时不启动第二卷或样本。整个 Docker/系统不增加 NAS 强依赖，systemd 单元仅用于本次离线于 SSH 会话的复制工作。
- rsync 退出非零（包括源文件消失的 24）记录失败，不忽略。再次正常执行会按 rsync quick-check 补齐/更新；本地到 NFS 的 whole-file 默认行为可能重传未完成文件，**不承诺每个文件从中断字节续传**。
- 退出码 0 的状态名是 `precopy_pass_complete`，同时 `cutover_ready=false`、`reclaim_ready=false`。在线源仍可能变化；源/目标内容和完整文件集合未经过最终一致性验收，绝不能据此删 SSD。

脚本没有自动停止服务、切换 Compose 或删除原数据的入口。尚未实现的切换/回收步骤不能用手写 rm、volume rm 或 down -v 代替。

## 10–30 分钟窗口如何保持可控

先在业务在线时完成大部分复制。第一卷复制已完成，用户选择取消额外全量 SHA256；维护窗口前先完成 Docker NFS 子卷和原部署核对。停写后使用普通增量 rsync，不加 `--checksum`，完成逐路径 dry-run、元数据与文件集合检查；只有待传输的变化文件需要重新传输和传输校验。具体流程以 [最新切换方案](rsync-cutover.md) 为准。

后续切换仍要求核对源/目标身份、消费者停写、rsync 成功和无未解释的逐路径差异；删除项显式列出，不能把真实 `--delete` 当默认操作。SHA256 清单工具保留为加严方案，用户当前策略不依赖它的完整结果。源副本保留至挂载和业务验收；不能只凭一次成功或总大小相等立即删除源。

窗口前还需通过隔离栈确认 Docker NFS 子目录挂载、真实 UID/GID 与 gateway 读取，并冻结当前应用镜像和 Compose 原参数。Web 启动会 migrate/bootstrap/collectstatic，部分 Worker 会 recover_stale_agent_runs --requeue；先核对未应用迁移、容器可写层和任务状态，不 pull/build，不用新 checkout 替换线上镜像。

窗口内顺序：关闭该实例入口和生产者 → 暂停 beat → 等待在途 Worker 任务完成并记录队列/任务状态 → 受控停止全部媒体消费者 → 数据库一致备份及最终增量核验 → 重建带 NAS 子卷的消费者 → 验证旧媒体读取、写入、任务继续处理、鉴权和 Range → 恢复入口/调度。

数据库、Redis 和其他项目继续运行；不 purge 队列，不强杀长任务来赶时间。若任务未排空、最终变化量过大或校验未通过，不进入 NAS 新写入阶段，恢复原 SSD 配置并另约窗口。NAS 已产生新写入以后，回滚要先停写并合并新增/修改/删除，不能直接指回旧 SSD；NAS 不可读时也不能承诺无损回滚。

## SSD 回收的边界

用户已授权验收后释放空间，但当前尚未达到回收状态。后续回收命令必须逐项核对：完整校验记录与源身份、所有媒体消费者实际挂载、业务/队列恢复结果、备份风险记录、旧目录没有继续写入或打开的遗留句柄。范围只限对应旧卷的 data_hub_raw_media 内容，保留父卷及其他目录；先生成清单与预计字节，再执行。

NAS 快照可改善误删恢复，但同池快照不是独立副本。SSD 清理后不能再靠原 SSD 目录快速回滚；恢复能力来自 NAS/独立备份，需明确保留位置与恢复方法。当前 NAS 无独立备份的事实必须保留在验收记录中，不能把 RAID 或历史稳定性写成备份已完成。

Part 2 不设置未经验收的“明晚自动删除”任务。完成 Part 1 的实际切换、回收及业务验证后，再以 delta_59202 的独立目标/标记和另一个复制单元重复流程。

## 本地验证范围

57 个 NAS 测试通过，其中 12 个预复制测试覆盖目标冲突/软链接/替换、作业续跑与封存、消费者变化、本机 Docker 固定连接，以及真实 rsync 复制后源文件保留和再次补齐。不限速覆盖只改变速率参数、旧作业续跑、拒绝无效选项，以及真实子进程 CR 输出节流/末条保留/非 UTF-8 错误/退出 24 透传；新增 13 项在线校验测试详见 [校验说明](online-verification.md)。测试在 macOS/Python 3.11.7 运行；真实 rsync 用本机 2.6.9 并去掉其不支持的 progress2/outbuf 日志参数，实际验证不限速补齐。Python 3.6 仅做语法/API 兼容检查，不能冒充 EL8/systemd 239/rsync 3.1.3/NFS 整卷现场验证。Bash 入口通过语法检查，正式迁移状态仍以前述现场结果为准。
