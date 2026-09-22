# 2026-09-22 现场回传结论

依据用户回传的 layout、deployment、media 输出整理。采集为在线快照，以下数字不是当前实时值；没有连接或修改服务器。原始报告不提交 Git，内部环境文件只记录路径，不保存内容。本文替代此前同类项目中的“待确认”项，不替代后续停写校验。

## 空间构成：先复制全部，再另行评估临时文件

下表是 `data_hub_raw_media` 内按路径累加的逻辑大小，GiB=2³⁰ bytes，不是 du 分配块数：

| 卷 | 文件总数 | 总 GiB | raw-media-*.tmp 数量 | tmp GiB | 其他 GiB |
| --- | ---: | ---: | ---: | ---: | ---: |
| delta_59202_media_data | 308,778 | 928.57 | 116,763 | 647.48 | 281.09 |
| po_infra_media_data | 193,282 | 497.47 | 58,986 | 312.98 | 184.49 |
| 合计 | 502,060 | 1,426.04 | 175,749 | 960.46 | 465.58 |

- 总逻辑字节 1,531,203,403,874；tmp 1,031,285,820,135（**67.35%**）。
- 超过 24 小时的 tmp 共 174,276 个、1,029,655,796,876 bytes（958.94 GiB）。
- 两次扫描均 error_count=0，未跳过软链接/其他设备，未发现多硬链接文件路径。
- 最大文件中有多个 tmp 与一个正式文件长度相同。**相同长度不是内容相同的证明，文件名/年龄也不是删除依据。**“其他文件”也不等于全部被数据库引用的有效媒体。

原卷仍为权威源。第一份预复制包括 tmp，不启用 exclude/delete/remove-source-files，不移动原文件。复制并保留旧数据不能释放 SSD 空间；此前 /data 剩余约 59 GiB 是旧快照，应重新读取 df 并控制新增采集量。

## 泄漏路径已与线上采样代码对应

两套实例的 web、worker-agent-data-hub 共四个运行容器的 `data_hub/media_storage.py` SHA256 均为：

```text
0c4047f2be731c5e29ed9f42e1f13468511e0f36eaced07cb25b89a8aa61c891
```

它与 [本地审查基准](po-infra-cdf3e649-sha256.json) 一致。已用这个原函数隔离复现：重复下载同一内容，已有 SHA256 命名正式文件时跳过 `os.replace`，却没有清理本次创建的 tmp；两次成功下载产生一个正式文件和一个遗留 tmp。

因此已确认采样线上代码存在泄漏路径，**不能进一步断言 960 GiB 全部由该路径造成或全部可删**。正常在途下载、被强制终止任务等也可能产生 tmp。

修复建议独立发布：正式目标已存在时清理本次调用创建的 tmp，并保持异常处理；测试首次下载、重复下载、网络/超限异常及数据库保存失败。它只阻止这一类后续泄漏，不处理历史 tmp，也无法保证 SIGKILL 时完成清理。本轮未修改 po-infra，也没有在运行容器内热补丁。服务器工作区存在未提交业务修改，先保存和确认实际发布源码；代码修复与存储切换分开验收。

如以后要回收历史 tmp，先另行完成“停止相关写入 → 对候选与正式文件实际计算哈希 → 数据库引用/任务核对 → 可恢复副本 → 明确清理范围”。此轮没有生成清理命令。

## 真实部署身份

依据原始 deployment 回传逐个核对 20 个媒体消费者，两卷均属于 po-infra 完整平台的部署，分别对应两个 Compose 项目：

| 媒体卷 | Compose 项目 | 媒体消费者 | 应用镜像引用 |
| --- | --- | ---: | --- |
| po_infra_media_data | mx_data | 10 | ghcr.io/mingxiinfo/po-infra:feat-new_delta |
| delta_59202_media_data | delta_59202 | 10 | po-infra-local:delta-59202-feat-new_delta |

每套包含 9 个应用写入服务与 1 个只读 Nginx gateway；gateway 使用自己的 Nginx 镜像。两套环境文件和媒体卷分别独立，不能因为同属 po-infra 就认为数据重复、合并 NAS 目标或删除其中一卷。它们不是本机 Delta_Pub 精简发行版的媒体卷。以下为同一次现场快照，后续变更仍需重新核对。

| 项目 | env-file（服务器本地） | Compose 文件，按顺序 |
| --- | --- | --- |
| mx_data | /home/lcy/test/Delta/mx_data/deploy/.env.ghcr | docker-compose.ghcr.yml、docker-compose.local-build.yml |
| delta_59202 | /home/lcy/test/Delta/mx_data/deploy/.env.delta-59202.ghcr | 上述两项，再加 docker-compose.db-port.yml |

两套 working_dir 都是 `/home/lcy/test/Delta/mx_data`。各有 10 个媒体消费者（9 rw、gateway ro），服务名与候选模板一致；目前都用 `unless-stopped`。采样 web/worker-agent-data-hub 的实际进程 UID/GID 为 0:0；不能据此认定 Nginx worker 也为 root。

当前应用 image ID：

```text
mx_data       sha256:111bce4a81e6a1d2fc7139f59e82bd54140ea5aa29c606d33756b1afb0748fa6
delta_59202   sha256:2493a0800c1707ff8cf129777875063953c513b9c2bf869ecdeefb572e0c6391
gateway       sha256:6769dc3a703c719c1d2756bda113659be28ae16cf0da58dd5fd823d6b9a050ea
```

应用镜像没有 RepoDigests/OCI revision；构建变量都声称 GIT_COMMIT=`d29a0bc2528d8f76bc79ddc0b3966a931b166e3e`，构建日期分别为 2026-09-21T03:09:15Z、2026-09-18T03:31:03Z。这些变量不是干净构建证明。

服务器 checkout HEAD 也是 d29a0bc2，分支 feat/new_delta，但有大量未提交修改及未跟踪 migration 0063/0064。本机 checkout 为 cdf3e649。**不要 reset、覆盖、盲目 pull/build 或以本机版本取代线上运行镜像。** 后续切换使用冻结的原 image ID，并核对容器可写层差异和启动脚本的数据库副作用。

四个采样容器的 services.py、settings.py、run_web.sh、run_worker.sh 与本地审查基准匹配；tasks.py 均为 `e1b9bbcd350e615ce5bc5b111f2d7956f588799183a3fdf1ca225c359113a141`，**不同于本地基准**。本地 tasks 队列和 120/150 秒限制仅作代码线索，停写前应核对运行版本的路由、限制和外部生产者，不能当作已验证线上值。

本次没有发现 Docker 的额外父/子路径 bind 消费者；所报告 Kubernetes Pod/PV 没有直接指向这两个卷。不能排除宿主机 cron/脚本、路径别名或以后新增消费者，也不能据此认定全部 K8s 数据已经位于 /data。

## NAS 路径与权限

- 已验证挂载 `/mnt/nas nas-storage:/volume1/data1 nfs`，不是仅有本地空目录。
- 可用字节 30,956,811,976,704，约 28.16 TiB；足以容纳 1.39 TiB 量级的第一份副本。存储池健康、子目录配额、独立备份仍需 NAS 管理端确认。
- `/mnt/nas/mx-internal-server` 为 **uid=1003、gid=10、mode=2750**；shared_archives/shared_dir/shared_media 为 1003:10 / 2770。
- `/mnt/nas/mx-internal-server/data` 不存在；其下 docker/media-volumes、两个拟用目标、k8s、mx-static 均不存在。当前无已知目标重名，但创建前仍需再次检查。

不要从导出根目录的 777 推导主机目录可写；也不要改旧 shared_* 权限。NFS 可以映射客户端 UID，读取目录成功不代表 chown 保留原 owner 成功。[NFS exports 手册](https://man7.org/linux/man-pages/man5/exports.5.html)

本次新增显式写测试 `scripts/nas-probe.sh permissions --write-test`：只在现有主机目录下创建独立 `.mx-static-probe-<随机值>`，写 4 KiB，fsync、rename、读取核对，测试 chmod/mtime/chown 0:0，然后仅清理自己的文件和空目录。它不创建 data/，不读写源卷，不改旧目录权限；失败保留具体阶段和未能清理的路径。目录通过文件描述符固定到核实过的 NFS 设备，拒绝软链接/设备不匹配，避免未挂载时写到本机。

判读方式：

- `io_passed=true`：本次写入/重命名/读取通过；不是断电持久性、吞吐或并发压测结论。
- `metadata_passed=true`：测试文件的 mode/mtime 能按要求设置。
- `root_owner_preservation=true`：该测试文件能保持 0:0；不是任意源 UID/GID、ACL/xattr 都能保留的证明。
- chown 被拒绝或返回 owner 不符：尚不能直接采用 `rsync -a --numeric-ids`。保留原策略，先确认 NAS 账号映射/专用目录授权，不忽略 rsync 错误，不全局关闭 root squash，不 chmod 777。
- `cleanup_passed=false`：只留下几 KiB 的独立测试对象，回传路径和错误，不用递归强删。
- 全部为 true 仍输出 `copy_readiness=not-established`：还需目标目录授权、小批原属性复制、真实容器读写、源增长与 NAS 备份确认。

`rsync -a` 包含 owner/group/permissions/times，并不包含全部 ACL/xattr/hardlink 保留选项；选项要与实际源数据要求和 NAS 支持一致。[rsync 手册](https://download.samba.org/pub/rsync/rsync.1)

## 版本、启动和下一步

现场 Docker 26.1.3，`docker compose` v2.27.0，独立 `docker-compose` 输出 2.34.0（采集器旧字段名 compose_v1 不代表版本 1）；systemd 239；rsync 3.1.3。采用服务器实际 `docker compose` 校验最终配置。SELinux 为 Permissive，container_use_nfs 不可用、virt_use_nfs=on；本轮不修改 SELinux。

此次报告没有重新验证开机挂载配置。此前 fstab 已注释、Docker 的 NAS drop-in 为 .bak、无 automount 的风险仍未闭环：当前可访问不等于重启后可用。完整复制可先做，正式切换仍等待每套媒体服务独立的 NAS 挂载检查与启动/故障恢复演练。保留 hard NFS；NAS 离线时 I/O 可持续等待，重复启动探测或普通 timeout 不能解决 D 状态。[NFS 客户端手册](https://man7.org/linux/man-pages/man5/nfs.5.html)

## 权限探测回传：已通过，进入小批复制

用户随后回传 `/data` 剩余 **58G、97% 已用**，inode **3% 已用**。`permissions --write-test` 的 io_passed、metadata_passed、root_owner_preservation、cleanup_passed 均为 true，测试目录已清理。新文件为 uid=0/gid=10（父目录 setgid 继承），chmod/mtime 通过，chown 后确认为 0:0。

这说明此次 root 写入、rename/read、fsync 和基础属性设置均可用，不需要再改旧目录权限，也不必重复该探测。它不证明所有 ACL/xattr、真实容器访问或机械盘持续吞吐。

用户决定**不恢复 Docker 全局 NAS 依赖**。fstab 取消注释是否已执行未收到回执；后续按 [原生存储与启动边界](../operations/storage-platform.md) 验收，原 host-bind 启动方案为兼容备选。

该阶段随后已执行两卷 [小批复制工具](../operations/sample-copy.md)，结果如下。仍需 NAS 健康、配额和备份信息。

## 小批复制回传：两卷均通过，尚未测持续吞吐

| 卷 | 检查一级条目 | 复制文件 | 选择/验证字节 | 复制校验阶段秒数 | passed |
| --- | ---: | ---: | ---: | ---: | --- |
| po_infra_media_data | 4,395 | 8（正式 4、tmp 4） | 30,288,366（28.89 MiB） | 42.358 | true |
| delta_59202_media_data | 2,607 | 8（正式 4、tmp 4） | 156,421,768（149.18 MiB） | 16.804 | true |

两次挂载均为 `/mnt/nas nas-storage:/volume1/data1 nfs 0:656`。16 个文件的 SHA256、正式文件哈希命名、size、uid/gid=0:0、mode=0644、秒级 mtime 和源文件稳定性检查全部通过。首次旧版 Python scandir 错误已在本次现场运行中越过。

NAS 保留的测试目录（各自有 result.json）：

```text
/mnt/nas/mx-internal-server/.mx-static-copy-check-po_infra_media_data-42d7ab59e1de45f299572acac5216ea6
/mnt/nas/mx-internal-server/.mx-static-copy-check-delta_59202_media_data-434482b6b66f462f9acbabb2a0391aa9
```

没有正式目标创建、容器切换或源文件删除。这些目录是平铺样本，不能作为新媒体根。权限证明仅限所选文件，不延伸到其他身份/ACL 或容器。

elapsed 不含选样与 NAS 父目录打开，包含逐文件 rsync、fsync、元数据和哈希。第一卷均摊约 0.68 MiB/s，第二卷约 8.88 MiB/s；由于 10 MiB/s 限速、样本小且没有分阶段时钟，不能把这些数字当作 NAS 最大吞吐，也不能确定第一卷较慢是机械盘唤醒、网络还是其他原因。

当时用户要求先测试，并希望后续耗时尽量不超过四小时；下述测试现已完成，最新结果和安排见下一节。当时安排运行单卷、最多 2 GiB / 32 个较大文件的 `--throughput-test`，限速 100 MiB/s，复制阶段 600 秒软预算，输出复制/落盘/哈希阶段耗时；hard NFS 阻塞不受该软预算强制终止。实际全量迁移和故障恢复仍未开始。

## 短时吞吐回传：已通过，四小时全量目标尚无依据

用户随后回传 delta_59202 的 throughput-test 以及新的 df 截图：`/data` 仍为 1.9T / 已用 1.8T / 可用 58G / 97%。df 的取整结果相同不能证明期间没有增长；测试副本写在 NAS，也不会释放 SSD。

- 检查 2,902 个一级条目，复制 32 个文件（正式 16、tmp 16），1,624,442,186 bytes = 1,549.19 MiB = 1.513 GiB。
- passed=true，verified_bytes 与 selected_bytes 相等，time_budget_exceeded=false。内容、基础属性和复制期间源文件稳定性检查通过。
- 复制校验阶段 31.708 秒；rsync 累计 27.963444 秒（约 88.2%），源 SHA256 1.843079 秒，目标 SHA256 1.871502 秒，单独 fsync 0.000118 秒，其他 0.026298 秒。
- rsync 阶段平均 55.401 MiB/s；含校验平均 48.858 MiB/s。逐文件总耗时 0.653–2.094 秒，本轮未重现此前 po_infra 小样本的较长耗时，但不能据此解释或排除那次延迟。
- 独立测试副本保留于 `/mnt/nas/mx-internal-server/.mx-static-copy-check-delta_59202_media_data-cb38a0c0b29d459c82e7b0adbb1ed19c/`，内有 result.json；不作为正式媒体根，不自动清理。

rsync 耗时包含文件传输和其内部操作；单独 fsync 几乎无耗时不证明机械盘瞬时写入完成或断电安全。目标校验紧跟写入，可能命中缓存。每文件单独启动 rsync、样本较大且全在 video 类别，不能代表约 50 万文件的整卷分布，也不能将 55.4 MiB/s 当作 NAS 的最大/长期吞吐。

使用此前文件统计和此次两个平均速率进行**纯算术外推**：

| 范围 | 此前逻辑 GiB | 55.401 MiB/s 单遍小时 | 48.858 MiB/s 小样本流程等效小时 |
| --- | ---: | ---: | ---: |
| delta_59202 | 928.57 | 4.77 | 5.41 |
| po_infra | 497.47 | 2.55 | 2.90 |
| 两卷合计 | 1,426.04 | 7.32 | 8.30 |

这不是实测全量工期，未计最终增量、停写完整校验和新增数据；不能因此承诺停机时间。大卷四小时单遍至少需要约 66.0 MiB/s，两卷约 101.4 MiB/s，校验还需余量。

目前不再重复小样本或直接增加并发。可同时用 `bash scripts/nas-audit.sh network` 只读获取本机到 192.168.1.3 的路由、相关网卡/下层设备的协商速率和内核 NFS 状态；它不读取 NAS 文件、不重挂、不改网卡、不跑网络压测。计数器是累计值，不归因于刚才 31.7 秒的测试。

用户已明确：今晚先完成较小/较快一卷，验证切换与业务恢复后释放该卷 SSD 旧媒体；另一个卷明晚 Part 2。po_infra/mx_data 可安排 10–30 分钟维护窗口。确定先 po_infra、再 delta，不并发争抢未经证实的 NAS 带宽。全部 tmp 仍保留到迁移验收，不按年龄清理。

用户确认没有独立备份，只知道通过 NFS 使用 NAS；实际后端文件系统、阵列与快照未确认。已加入 [NAS 健康检查和 OSS 预算](../operations/nas-health-and-oss.md)。约定先 [在线预复制](../operations/two-night-migration.md)，此步骤不等于最终一致副本，也不释放 SSD 空间。逐文件验证清单、停写最终增量、切换/恢复与回收入口尚未实现或现场验收；不能凭 rsync 退出 0 清理旧数据。用户已条件授权最终验收后的旧 raw_media 清理，原卷及其他目录仍保留。

## 最新执行约束：取消四小时自动停止

用户明确要求尽量快且保障一个卷复制完，不再设置严格四小时退出。新建复制单元使用 `RuntimeMaxSec=infinity`；复制程序原本没有全量截止计时，因此无需修改 Python 复制逻辑。保持单卷、60 MiB/s 限速、保留源数据和错误检查。此变化不放宽 10–30 分钟维护窗口，也不等于自动切换或清理；若已用旧参数启动，先读取实际单元状态，不能把文档修改视为服务器配置已经更新。

## 最新范围：先验证 NAS，暂缓 OSS

用户明确本轮不去阿里云备份，先验证 NAS。当前使用 NAS 管理端只读检查和服务器 network 模式补充后端/链路信息；已通过的基础写入、小样本与短时吞吐不重复。OSS 费用保留为历史参考，不作为本轮前置条件。继续按原计划先 po_infra、再 delta，逐卷预复制、核验和切换，当前无独立备份的事实不因健康探测通过而改变。

## 服务器链路回传：千兆全双工，待 NAS 后端信息

- Python 3.6.8 下 network 模式成功。到 192.168.1.3 的路由为 `dev eno2 src 192.168.1.2`；服务器 eno2 为 up、1000 Mb/s、full duplex、MTU 1500。未报告 lower 接口，缺少 bonding/slaves 文件本身不是故障。
- 1 Gb/s 原始线速换算约 119.2 MiB/s，实际文件吞吐还受协议、NAS 和文件分布影响。此前 rsync 55.4 MiB/s 未达到这个理论值，但不能仅凭一轮短测确定瓶颈，也不能保证调参会达到线速。
- 本机网卡累计 rx_errors=0、tx_errors=0、rx_dropped=592950、tx_dropped=0。缺少同一时间窗的增量，无法将 dropped 归因于本次复制；rx_dropped 包含收到但未交付处理的包，也不等同于线缆错误。[Linux 计数定义](https://docs.kernel.org/networking/statistics.html)
- /mnt/nas 为预期导出 `nas-storage:/volume1/data1`，NFSv3、hard、TCP、rsize/wsize=524288、timeo=600、retrans=2。mountstats 的 age=117453 秒（约 32.6 小时），这些是该挂载的累计统计，不是单次吞吐测试窗口；本轮不据此调整挂载、网卡或清计数。
- 最新 df：/data XFS，1.9T、已用 1.8T、可用 **57G、97%**；此前为取整 58G，不能由两份取整快照计算增长速率。尚未回传正式预复制结果，不能把 NAS 的可用性等同于迁移完成或 SSD 已回收。

用户目前远程登录 192.168.1.2；NAS 为 192.168.1.3。下一步从服务器使用 NAS 自己的账号 SSH 登录并回传只读后端信息；SSH 是否开启、账号和管理网页端口尚未知。操作见 [NAS 访问与验证](../operations/nas-health-and-oss.md)。OSS 仍暂缓。

## 最新决定：群晖管理访问暂缓，启动 po_infra 预复制

用户截图：在服务器执行 `ssh -o ConnectTimeout=10 minsight@192.168.1.3`，返回 `connect to host 192.168.1.3 port 22: Connection timed out`；未进入认证阶段，不能据此判断账号密码是否正确。随后用户确认 NAS 是新购四盘位群晖，具体型号未知，管理账号/密码已遗忘，要求在没有实质阻碍时开始迁移。

依据已通过的 NFS 挂载身份、root 写入/属性、样本内容校验及短时吞吐，开始第一卷 po_infra_media_data 的受控在线预复制，全部原数据保留，不等待 NAS SSH 或云端备份。本轮不再扩展端口探测/尝试账号，不重置 NAS 或停生产服务。底层健康、快照状态继续标记未确认，不能因设备新购或品牌而推断健康。

执行入口为 [两晚分卷安排](../operations/two-night-migration.md)，无限时单卷预复制。尚未收到该正式作业的启动/完成回传，因此不记录为已执行或已成功。预复制后仍需完整校验、最终同步、挂载与任务恢复验收，才能按已授权范围回收旧 SSD 媒体。

## 正式预复制启动与进度显示回传

用户已运行无截止时限的 systemd-run，得到 `Running as unit: mx-nas-part1-po.service`。随后 03:04:23–03:05:01 的 journal 截图持续出现 `[48.0K blob data]`/`[47.9K blob data]`，当时尚未提供展开后的 rsync 字节、速率、进度或最后退出结果。不能从 blob 大小推断速度、数据损坏或整卷完成。

用户询问能否不限速。已增加显式 `--unlimited`（rsync bwlimit=0），保留原默认值与所有存储检查；旧进程不能靠改脚本热调速。新增日志转为单行 JSON，进度约每 5 秒输出，保留错误/统计与 rsync 退出码。具体旧日志展开、受控停止复制单元并沿同一目标续跑的命令见 [执行文档](../operations/two-night-migration.md)。此修改未确认在服务器应用，不会将源码修改记录成现场已经不限速。

随后展开日志截图显示 `7,932,663,327  1%  35.95MB/s  0:03:30 (xfr#92649, to-chk=101256/193909)`，下一行仅显示 `7,932,702,365`。已累计传输约 7.39 GiB，截图时持续传输，尚未收到最终退出码或 `precopy_result`。文件数量多而字节占比低，当前阶段小文件较多；显示速率低于默认上限，不能据此断言取消限速能明显提速，后续大文件阶段仍需观察。该输出不是完整内容校验、切换或 SSD 清理凭据。

## 第一卷正式预复制成功回传

用户随后回传 `total size is 534,415,703,995 speedup is 1.00`、完整 `precopy_result` 和 `mx-nas-part1-po.service: Succeeded.`：

- volume=`po_infra_media_data`，job_id=`1e9cdad9efd741338d3fdcb82f327ba5`。
- phase=`precopy_pass_complete`，last_exit_code=0，cutover_ready=false，reclaim_ready=false。
- source_identity：device=66309、inode=1083500031；target_inode=384598076。
- consumer_fingerprint=`f3f3605e8e80453b3b86e50b465b3fab0b4e0d1b3fdb05731576b749f7e3c7e4`。
- target=`/mnt/nas/mx-internal-server/data/docker/media-volumes/po_infra_media_data/data_hub_raw_media`。
- started_at_unix=1790017444.5244474，finished_at_unix=1790028879.777642；北京时间 2026-09-22 03:04:04.524 至 06:14:39.778。
- 历时 11,435.253 秒（3 小时 10 分 35 秒）；总文件大小约 497.71 GiB，按总大小/总时间计算等效 44.57 MiB/s，不等同于网卡瞬时吞吐或已做 SHA256 验收。

第一卷在线复制已实际完成，原 SSD 数据仍保留，不能记录为业务已切换或空间已回收。未收到新的 df，不能假定仍有 57G 可用。下一步为 [在线完整内容校验](../operations/online-verification.md)，工具已经本地实现并测试，尚未取得现场校验结果；不为了取消限速重新跑本轮复制，不并发启动第二卷。

## 在线校验局部回传与用户选择的新验证策略

在线校验 07:03:15 开始，源目录条目 194,493，目标 193,909；07:18:02 时 matched_files=145,862、matched_bytes=55,173,252,995（约 51.38 GiB），issues=562。展示的前 20 条问题为 19 条 missing_on_nas 和 1 条 directory_attributes_differ；不能将剩余问题全部归类，也不能称 562 个文件损坏。最近几分钟配对哈希进度约 87–90 MiB/s，按原总量剩余约 85–90 分钟；这是当时估算，不是已经完成。

同次 df 回传：/data 可用 67G、97%，根文件系统可用 107G、90%。这些是新的容量快照，不推断具体空间回收来源。

用户确认首次限速 60 MiB/s 的完整 rsync 未中断且成功，明确要求取消全量内容比对并开始切换准备。已接受该决定：独立 SHA256 不再是切换硬性门槛，使用 rsync 自带传输校验、停写最终增量和逐路径 quick-check，再做挂载/业务验收；原 SSD 副本暂留。已提供停止校验单元的命令，但尚未收到停止回执或任何生产切换结果。

新增 [切换准备入口](../operations/rsync-cutover.md)：检查/创建新的 Docker 原生 NFS 卷、隔离 4 KiB 读写试挂、核对实际部署，生成固定镜像和 NAS 子挂载候选覆盖文件。原 Web 启动会 migrate/bootstrap_admin/collectstatic，bootstrap_admin 会 set_password；候选用相同 gunicorn 参数跳过初始化。Worker 候选设置 MX_RECOVER_STALE_AGENT_RUNS=0，避免本次重建额外扫描并重新入队旧任务。尚未应用覆盖配置；停写最终同步、挂载切换、任务恢复和空间回收仍待现场执行，不能记为已完成。


## 第一卷切换准备通过（用户回传）

报告目录 `/var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1`；`time_unix=1790034838.6539922`。Docker NFS 实际挂载、目标 inode 384598076、root 4 KiB 写读全部通过；`review_items=[]`，九个应用消费者的可写代码差异均为空。旧指纹经纯 Mounts 顺序兼容精确匹配，新规范化指纹为 `a5ed37346ebec398c8295dc2ed58b44394fba76a06a23e5079ecf4ef917f570c`。

预复制 job 仍为 `1e9cdad9efd741338d3fdcb82f327ba5`，SSD 源身份为 device 66309 / inode 1083500031，源卷 `po_infra_media_data`。没有停止业务、切换数据源或释放 SSD，`cutover_ready=false`、`reclaim_ready=false`。此结果支持进入已经约定的维护流程，不代表 NAS RAID/快照/独立备份健康已确认。

下一步执行 `nas-cutover.sh`，详见 [Part 1 操作文档](../operations/part1-cutover.md)。新增工具已本地测试，尚无生产执行回传。


## 第一卷正式切换成功（用户回传）

最初 `mx-nas-cutover-po-1` 因服务器缺少新脚本退出 127，没有进入迁移逻辑。用户同步脚本后启动 `mx-nas-cutover-po-2`，本次日志最终为 `Succeeded` 和 `cutover_result.phase=running_on_nas`。

- 沿用报告 `/var/lib/mx-static/nas-cutover/po_infra_media_data-830225384207402a8ba23a2364d252d1`。
- 在线增量：781 个新文件，422,488,713 字节（402.92 MiB）；最终停写同步传输 0 个文件、0 字节。
- 最终树包含 194,686 个普通文件、4 个目录，总逻辑字节 534,838,192,708（498.11 GiB）。元数据检查 issues=0，`final_sync_passed=true`，NFS 身份检查通过，`quarantined_roots=0`。
- 十个媒体消费者已创建并按序启动，HTTP 服务健康检查通过，一个已有视频 1024 字节 Range 读回返回 206 并匹配。PostgreSQL、Redis 保持原容器身份。
- `started_at_unix=1790036533.3219838`，`updated_at_unix=1790036693.634978`，差值 160.313 秒。该段包含在线补增量，不等于精确停机时长。
- `nas_may_have_writes=true`、`business_acceptance_pending=true`、`reclaim_ready=false`。SSD 未删除，也未收到最新 df；不能宣称空间已经释放。NAS RAID/快照/独立备份健康未因此得到确认。

后续业务抽查和原 SSD 回收范围见 [只读清单](../operations/part1-reclaim-plan.md)。已经发出业务验收信息请求，尚未收到答案；新增脚本只生成私有元数据清单，不改验收状态或删除数据。
