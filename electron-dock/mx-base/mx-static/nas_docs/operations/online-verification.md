# po_infra 第一卷预复制后的在线完整校验

## 已收到的结果

2026-09-22 用户回传 `mx-nas-part1-po.service: Succeeded.`，作业 `1e9cdad9efd741338d3fdcb82f327ba5`，`last_exit_code=0`、`phase=precopy_pass_complete`。总文件大小 534,415,703,995 bytes，约 497.71 GiB；北京时间 03:04:04.524 至 06:14:39.778，共 3 小时 10 分 35 秒。总大小除以时长约 44.57 MiB/s，是整轮等效吞吐，不是瞬时网卡速率。

源卷 `po_infra_media_data`，源 device=66309 / inode=1083500031；NAS raw_media inode=384598076。消费者指纹 `f3f3605e8e80453b3b86e50b465b3fab0b4e0d1b3fdb05731576b749f7e3c7e4`。工具读取现场 marker 核对这些身份，不提供手工改 marker 的步骤。

`cutover_ready=false`、`reclaim_ready=false` 是正常状态。业务仍使用 SSD，NAS 尚未接收正式业务写入，不能因为 service 成功而删除 SSD。先完整校验第一卷，不启动第二卷与其争用 NAS。

## 更新项目后运行

通过既定 Git 流程把 mx-static 更新到包含 `scripts/nas-verify.sh` 的版本。在服务器的 mx-static 目录执行，保持数据库、队列和媒体消费者运行：

```bash
bash scripts/nas-verify.sh --help
df -hT /data /var/lib
sudo systemd-run --unit=mx-nas-verify-po-1 \
  --property=RuntimeMaxSec=infinity \
  --property=TimeoutStopSec=90s \
  --property="ReadOnlyPaths=/data /mnt/nas" \
  /bin/bash "$PWD/scripts/nas-verify.sh" po_infra_media_data --verify
sudo journalctl -u mx-nas-verify-po-1 -n 20 --no-pager
```

这个阶段读取两边的全部媒体字节，包括 tmp；没有限速参数和四小时退出，单进程、低 CPU/I/O 调度优先级，与复制/样本共享互斥锁。并非再次复制 500 GiB，也不上传压缩包。读取 NAS 仍消耗网络和磁盘，不能承诺几分钟完成；hard NFS 断连可能等待，不能保证 90 秒退出。

`ReadOnlyPaths` 只给该单元建立只读视图，不会把在线业务改成只读；脚本自身没有媒体写入、rsync、删除或停容器调用。它会在 `/var/lib/mx-static/nas-verification/po_infra_media_data-<随机ID>/` 创建本地报告，启动前要求该本地文件系统至少有 1 GiB 可用。约 20 万个文件的记录通常为百 MiB 量级，具体取决于路径长度和差异数；写入失败会令校验失败。不要把报告目录改到业务媒体里面。[systemd 239 私有路径说明](https://github.com/systemd/systemd/blob/v239/man/systemd.exec.xml)

观察进度：

```bash
sudo journalctl -fu mx-nas-verify-po-1
```

Ctrl+C 只退出日志查看。进度约每 10 秒输出一次，等待硬 NFS 或读取单个大文件时可能更久；缺少新日志本身不是任务已经完成。不要因等待重复启动或删除锁。

结束后贴回以下输出，**不需要贴整份 files.jsonl**：

```bash
sudo journalctl -u mx-nas-verify-po-1 -n 30 --no-pager
sudo systemctl show mx-nas-verify-po-1 -p ActiveState -p SubState -p Result -p ExecMainStatus
df -hT /data /var/lib
```

成功的 transient unit 可能已被 systemd 回收；以持久化的 `result.json` 和 journal 中的 `verify_result` 综合判断，不能把 not-found 当成功。启动日志和结果都含准确 `report_directory`。不要仅凭 matched_files、末条进度或 files.jsonl 存在判定完成。

同时可回传一次新的只读部署报告，核对维护窗口前消费者、镜像和启动配置是否漂移；这个命令不打印完整环境变量或凭据：

```bash
sudo env -u DOCKER_CONTEXT -u DOCKER_TLS_VERIFY -u DOCKER_CERT_PATH \
  DOCKER_HOST=unix:///var/run/docker.sock bash scripts/nas-audit.sh deployment
```

## 验证内容与退出码

1. 校验本机 Docker、SSD 源卷、10 个媒体消费者、NAS 导出、precopy marker 和源/目标身份。只接受上轮预复制成功，拒绝未知目录、已切换的子挂载、作业并发或消费者变化。
2. 枚举两边完整路径集合，不跟随符号链接，不跨文件系统。目录、空目录、异常硬链接/特殊文件和多余的 partial 目录也进入检查；不静默忽略 NAS 多余文件。
3. 对两边普通文件分别完整读取并计算 SHA256，包含全部 tmp；比较长度、UID/GID、mode、秒级 mtime。哈希命名的正式媒体还核对源内容与名称中的 SHA256。保存两边各自的 device/inode/纳秒 mtime/ctime/nlink 等稳定性记录，读取前后再检查。
4. 全部哈希后重新枚举两边目录，检查已校验文件是否又变化、增加或消失，并重验注册路径、部署指纹和 marker。
5. 本地写 `files.jsonl` 和 `result.json`，fsync 后输出最终结果。result 中保存清单 SHA256，用来发现后续清单损坏；这不是独立备份或数字签名。

| 退出码 | 含义 | 下一步 |
| --- | --- | --- |
| 0 | 本轮观察到文件集合、内容、属性和前后稳定性均通过，`observed_match=true` | 保留报告，继续挂载/部署与维护窗口准备 |
| 2 | 发现差异或在线变化，`observed_match=false` | 看分类和具体路径；先分析，再决定补复制或最终停写同步 |
| 1 / 信号终止 | 身份检查、I/O、报告写入等失败，或任务中断 | 保留两边数据和日志；缺少完整结果不算通过 |

活跃下载可能导致 missing_on_nas、changed_since_inventory；content_differs 也可能是源在预复制后改变，不能直接认定 NAS 损坏。任何差异都必须解释；脚本不会覆盖、修复或删除文件。报告中的前 20 条问题只是摘要，完整问题记录在清单里；同一路径可能有多个问题，因此 issues 不是差异文件数。

同大小、同秒级 mtime 的损坏也会被 SHA256 比较发现。这里不以 rsync quick-check、文件名或 du 代替内容检查，也不采用丢弃系统缓存来“加严测试”。NFS 回读可能命中缓存，不能据此证明 NAS 磁盘健康或断电持久性。

## 与后续停写、切换和清理的关系

这是在线证据，**不是原子快照**。无论退出码是什么，`consistent_snapshot=false`、`cutover_ready=false`、`reclaim_ready=false`，precopy marker 不变。没有自动续跑/自动切换/自动回收功能。

清单为最终窗口的增量核验留下依据，但还不能手工挑几项检查后宣布可删。后续工具必须绑定该卷、原作业和完整结果哈希，重验全部路径与两边身份/稳定性，处理报告中的所有差异，对新建/变化项补复制并重新哈希；NAS 上所有外部写入者必须受控。目录和文件集合在在线扫描期间不构成一致快照；可疑变化、重挂载、inode 复用或缺失报告时不得跳过完整核验。再次预复制改变 marker 后，不能沿用旧报告宣称最终一致。

仍需补齐：Docker 原生 NFS 子卷隔离试挂及真实 UID/GID 访问、原 Compose 文件/镜像冻结、队列排空与任务恢复、Web 启动的迁移副作用检查、10–30 分钟停写下的最终同步/验收，以及仅清理旧 raw_media 的受控入口。本次没有实现或执行这些生产变更。NAS 无独立备份的事实继续保留；回收 SSD 后无法靠原 SSD 副本恢复 NAS 故障。

## 本地测试边界

57 个 NAS 测试通过，新增 13 项覆盖真实文件 SHA256、同大小同 mtime 内容损坏、缺失/多余/partial 文件、属性差异、读中修改、读后变化和新文件、链接/FIFO/硬链接与跨设备拒绝、父目录替换、哈希命名、Python 3.6 scandir 回退、未完成预复制拒绝、无效参数、报告写入失败，以及完整控制流程的成功/差异退出与清单哈希。控制流程测试模拟主机与 Docker 身份，实际本地读写报告并 fsync；不冒充 NFS/EL8 的现场验证。

测试运行环境为 macOS/Python 3.11.7；Python 3.6.8 的 API 与语法另行核对，未在本机运行 Python 3.6。[Python 3.6.8 os 文档](https://github.com/python/cpython/blob/v3.6.8/Doc/library/os.rst) 服务器结果回传后再更新现场记录。
