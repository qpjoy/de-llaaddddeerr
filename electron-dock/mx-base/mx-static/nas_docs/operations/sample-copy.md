# 小批复制验证：权限探测通过之后

用户回传的 4 KiB 探测全部通过：io_passed、metadata_passed、root_owner_preservation、cleanup_passed 均为 true。创建文件 uid=0/gid=10，与父目录 setgid 相符；随后能改为 0:0。无需为此修改 NAS 旧目录权限或导出配置；这只证明本次身份和操作，不证明所有 ACL/xattr 或大文件吞吐。

最新 `/data` 为 XFS，1.9T、已用 1.8T、剩余 58G、97%；inode 使用 3%。这是容量紧张，不是 inode 耗尽。一次采样不能推算准确增长速度；保留原卷期间空间不会因复制腾出，要控制新的批量下载。

## 执行

在服务器 Git 更新后的 mx-static 项目目录运行，先做较小的 po_infra 卷：

```bash
sudo bash scripts/nas-sample-copy.sh po_infra_media_data --copy-test
```

第一条以退出码 0 结束，且最后 `sample_result.passed=true` 后，再运行另一卷：

```bash
sudo bash scripts/nas-sample-copy.sh delta_59202_media_data --copy-test
```

把完整输出贴回。**这是显式复制测试，不是只读命令，也不是全量迁移。** 无需重跑前面的全量文件统计或 4 KiB 探测。脚本不安装依赖：要求 Linux、root、Python 3.6+、Docker CLI、findmnt、rsync；现场已报告 rsync 3.1.3。

## 读取、写入与边界

- 只接受两个已知卷名；复核 local 驱动、无额外卷选项、精确源路径及 `/dev/nvme0n1p1`。只读打开源文件；不改写其内容/权限、不停服务。读取可能更新 atime，不把 atime 当作一致性依据。
- 仅查看 video/image/audio/document/other 的一级条目，总计最多 10,000 个；选择最多 8 个 24 小时前的普通文件，正式 SHA256 文件名与 tmp 交替选择。跳过链接、多个硬链接、空文件和超过 128 MiB 的文件；拒绝类别目录为链接或其他设备。不递归扫描整个卷/NAS。
- 按选择时大小合计不超过 256 MiB；源文件有变化时本次失败，不能把“旧文件”视为确定不变。通常能覆盖正式文件和 tmp，具体以报告为准；两者可能未被同时选中，样本也不代表所有目录/权限。
- 写入新的私有 `/mnt/nas/mx-internal-server/.mx-static-copy-check-<卷名>-<随机值>/`。不创建正式 data/docker/media-volumes 目标，不碰 shared_*，不复用已有目录。
- 使用原生 rsync archive/numeric-ids，每次只复制一个已打开的普通文件，限制 **10 MiB/s**；读取/校验也使用低优先级，但 SHA256 读取本身不受 rsync 带宽参数限速。目标目录按已验证 NFS 的描述符固定，NAS 卸载时不能退到本地路径继续写。
- rsync 的 `-L` 只为解引用 `/proc/<本进程>/fd/<已验证文件描述符>`，不是允许跟随业务目录链接。此小批工具通过宿主机只读访问 named volume 文件；不会重排 `_data` 或在其上挂载。全量复制仍单独设计只读源保护、续传和一致性流程。
- 内容验证：源文件 SHA256 → rsync → NAS 文件 fsync/读取 SHA256；正式文件还核对 SHA256 文件名。验证 size、UID/GID、mode、秒级 mtime，并确认源文件在选择、读取和复制期间未改变。这里不承诺纳秒 mtime、ACL/xattr/sparse/hardlink 保留，不证明断电恢复。
- 全局本地锁防止两卷并发运行此工具；hard NFS 可能等待，卡住时回传最后阶段，不强制卸载或反复开新脚本。不把常规 timeout 当作 D 状态清理保证。
- 成功和失败的 NAS 测试副本都保留，结果写在该新目录的 `result.json` 中。脚本没有删除、移走源文件、排除全量 tmp、容器重启或修改挂载的功能。即使样本 tmp 与正式文件内容相同，也不是历史 tmp 清理授权。

新目录仅用于校验，平铺测试文件并通过清单记录源相对路径，**不能作为业务新媒体根目录**。小批通过的 `passed=true` 不代表全量一致副本、生产启动就绪或迁移完成。

## 结果判读及后续

- 全部样本通过：确认这些文件的内容与基础元数据能经现场 rsync/NFS 保存。两卷都验证后，记录 NAS 健康、配额与备份条件，建立各自独立正式目标，准备限速、可恢复的全量预复制。
- `Source changed`/消失：在线文件变化，不自动放宽校验。保留这次清单，评估在途任务后重新取样；不因此删除 tmp。
- 正式 SHA256 文件名不匹配：先调查源内容/命名，不把源问题复制后称为完整性通过。
- rsync 非零、属性不一致、内容不同：停止此轮，不进入正式复制，回传阶段与错误。不能用忽略权限错误或取消校验“通过”。
- 全量首次预复制仍包含 tmp，原卷继续作为权威源；之后停写、最终同步、完整校验，再按最终选定的 [平台存储方案](storage-platform.md) 切换。保留原卷与旧数据。

本地验证覆盖真实 rsync 小文件往返、大小/年龄/链接边界、源文件被替换或并发修改、正式文件内容不符、rsync 失败、保留错误清单和命令参数。当前本机为 macOS，真实 rsync 测试版本是 2.6.9；生产 Linux 的 `/proc`、rsync 3.1.3 与 NFS 组合以本次现场执行为准。本地测试不连接生产服务器或 NAS。

10 MiB/s 仅用于此次小批验证，不是全量复制的固定限制。930 GiB 在 10/50/100 MiB/s 下单遍约需 26.5/5.3/2.6 小时，未计校验与业务争用；具体调速和多项目存储扩展见 [统一存储方案](storage-platform.md)。
