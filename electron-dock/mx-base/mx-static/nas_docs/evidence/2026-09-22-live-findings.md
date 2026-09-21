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

用户决定**不恢复 Docker 全局 NAS 依赖**。fstab 取消注释是否已执行未收到回执；重启行为另按 [启动与恢复设计](../operations/boot-and-recovery.md) 验收。

下一步运行 [小批复制工具](../operations/sample-copy.md)，先 po_infra_media_data，成功后再 delta_59202_media_data。每次最多 8 个文件/选择时 256 MiB、rsync 限速 10 MiB/s，包含可选到的正式文件与旧 tmp；独立 NAS 测试副本及校验报告保留，不切换服务、不删除源数据。通过后继续准备正式全量预复制，仍需 NAS 健康、配额和备份信息。
