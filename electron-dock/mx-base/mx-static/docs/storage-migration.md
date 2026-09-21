# SSD 计算与 NAS 媒体存储：排查和迁移方案

2026-09-21 编写的通用方案。2026-09-22 已取得部分现场输出，具体证据、待确认事项和最新执行入口移至 [nas_docs](../nas_docs/README.md)，当前 Delta 迁移以该目录中的记录为准。本地工作站不能证明服务器当前挂载、负载或启动依赖正常。先采集现状，再按项目迁移；不要先恢复 fstab、执行 mount -a、重启 Docker 或压测机械盘。

## 推荐部署结构

将“大媒体持久文件”与“应用的所有持久数据”分开。现有应用优先迁移专门的媒体目录，而不是整个 Docker root 或所有 named volumes。

| 数据或工作 | 建议位置 | 原因 |
| --- | --- | --- |
| Docker 镜像、可写层、构建缓存 | 服务器 SSD | 不让所有容器依赖 NAS |
| 数据库、SQLite/WAL、队列、配置、检索索引、缩略图缓存 | 服务器 SSD | 小文件/随机 I/O、锁和延迟敏感 |
| 转码、解码、抽帧、下载暂存、未完成文件 | 服务器 CPU/GPU + SSD 工作目录 | 处理完成、校验后再写入 NAS |
| 原始照片、视频、音频、已完成媒体、独立备份 | NAS | 主要提供大容量持久存储和顺序 I/O |
| 热门媒体副本 | 有上限的 SSD 缓存，内存由 OS page cache 使用 | 为恢复/下载预留空间；大内存不等于持久缓存 |

NFS、HTTP 是访问方式；文件在哪块盘才决定容量占用。服务器上的 Nginx 即使读 `/mnt/nas`，缓存未命中时仍需等待 NFS；仅添加静态 HTTP 服务不会自动迁移旧文件、自动变成 SSD 缓存，或消除 NAS 故障。通过服务器播放/转码可把计算留在服务器，但源数据吞吐仍受 NAS 和网络限制。

你提到的“128 核”属于 CPU 规格，内存容量需要 `free -h` 确认。带宽可用“并发人数 × 每路码率”估算，再为下载/归档/校验留余量。例如 20 路 × 25 Mbit/s = 500 Mbit/s，接近一半的 1 Gbit/s 标称链路；随机拖动、多文件并发和机械盘寻道还会影响表现。先测实际瓶颈，不根据 CPU 核数调大 NAS 并发。

## 成熟方案与本项目如何共存

| 方案 | 适合的应用 | 接入成本和边界 |
| --- | --- | --- |
| 宿主 NFS + Compose bind mount | 原本读取本地路径的现有媒体应用；优先选择 | 只切换媒体挂载的 source，保留容器内路径；需要挂载就绪检查 |
| Docker local driver 的 NFS volume | 希望由 Docker 管理某个媒体卷 | 官方支持；挂载失败时该容器创建/启动失败，运行期仍有 hard NFS 等待；不是独立于 NFS 的高可用方案 |
| Jellyfin 等媒体服务器运行在 SSD 主机 | 媒体库浏览、播放、转码 | 配置/缓存/转码目录在 SSD，媒体目录只读挂 NAS；不替代已有业务数据库 |
| Nginx HTTP 静态服务 | 应用能够存储和使用外部媒体 URL | 需要接入 URL、鉴权、Range 和缓存策略；不透明兼容要求文件路径的应用 |
| 当前 mx-static | 自有项目的媒体采集 API、鉴权、归档、按需恢复 | 有本地控制面与 NAS 隔离，但不是任意 Docker 媒体卷的透明替代品 |

Docker 支持 bind mount 和 NFS volume，Jellyfin 官方容器示例也把配置、缓存、媒体作为独立挂载。[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[Docker volumes](https://docs.docker.com/engine/storage/volumes/)、[Jellyfin 容器部署](https://jellyfin.org/docs/general/installation/container/)。SQLite WAL 不适合放到网络文件系统上。[SQLite WAL](https://sqlite.org/wal.html)

**两条路径可以同时存在**：已有应用使用 `/mnt/nas/media/<app>`；mx-static 只管理 `/mnt/nas/mx-static`。不要让另一应用直接改写 mx-static 的 objects/metadata，也不要将任意目录复制进去就当作完成导入；它还需要本地目录索引、元数据、队列与鉴权状态。

当前实现核对结果：

- `compose.yml` 的 writer/reader 仅挂本地 data/state；`src/mounts.mjs` 拒绝将 NFS/CIFS 作为核心数据盘。NAS 只挂进 `compose.nas.yml` 的 archive。
- 归档、远端卷标识验证、校验后 evict、冷文件 restore、Range、内容去重已经有代码与本地测试。归档本身保留 SSD 副本，**仅归档不会释放本机空间**；evict 必须显式触发。
- 冷文件 GET 返回 `503 media_restore_pending`，后台恢复**整个文件**到 SSD 后才能播放。播放器通常不会按 API 约定自动轮询，所以不能把这个行为当作透明冷视频直放。
- `src/config.mjs` 的单文件默认上限是 **256 MiB**，配置范围最高 16 GiB；当前 Compose 没有传入 `MX_STATIC_MAX_BYTES`。只在宿主 `.env` 写它不会传进容器，需显式增加 environment 并重建容器。
- URL 下载是流式，但 HTTP 上传仍整文件缓冲，默认最多两个并发上传。提高文件上限会显著增加上传内存风险；大文件下载还有固定 30 秒 deadline，NAS 任务默认最长 15 分钟。
- 有访问时间与 coldest 查询，**没有自动按磁盘高/低水位淘汰**。恢复/暂存仍要本地空间；现有 512 MiB 空闲底线不是多 GiB 并发任务的容量保证。
- 配置 schema、Compose 和旧文档的默认值存在差异；每个容器目前默认只分到 2 CPU/2 GiB。容量参数的推导不能替代目标主机实测，实际生效配置以容器 environment 和服务设置为准。

因此，先用普通 NFS 媒体目录迁移解除现有磁盘压力。mx-static 可作为独立项目继续部署和验证；若要负责大视频冷热分层，再单独补流式上传/续传、可配置下载期限、并发空间预留、有上下水位的自动淘汰、播放前预热及客户端恢复协议。

## 第一轮：确认“配置”与“当前状态”

在服务器的 `electron-dock/mx-base/mx-static` 目录运行，输出可直接贴回。脚本只读取元信息，不遍历 NAS，不输出容器环境变量或凭据，不改任何服务：

```bash
sudo bash scripts/storage-audit.sh host
sudo bash scripts/storage-audit.sh docker
```

如果使用 rootless Docker，第二条用日常运行 Docker 的用户执行。核对脚本输出的 Docker context，确认查询的是目标 Linux 主机。可遮住 IP/主机名，保留 mount source、路径、文件后缀和依赖关系；报告如需留存可写进已忽略的 `reports/`。

判断原则：

1. `findmnt` 显示 nfs/nfs4 挂在 `/mnt/nas`：内核中仍然挂载；不表示远端一定响应。
2. 只显示 autofs：有按需挂载入口，不证明 NFS 已挂载。没有 NFS 条目也不保证旧容器 mount namespace 没有保留旧挂载；第二轮可按容器 PID 只读 `/proc/<PID>/mountinfo`。
3. 注释 fstab 只改配置，不卸载现存 NFS。`mount -a` 也不会卸载被删除/注释的项目。
4. 将 drop-in 的 `xxx.conf` 改为 `xxx.conf.bak` 后，后者不是正常加载的 `.conf`；但内存中的依赖可能还未刷新。对照 `systemctl show` 的 `DropInPaths/Requires/After/RequiresMountsFor/NeedDaemonReload` 与磁盘搜索结果，不能仅凭后缀断言已经解除依赖。
5. `daemon-reload` 重读单元并重新运行 fstab generator；它本身不是重启 Docker、卸载 NFS 或恢复挂载。先留取当前证据，确定正确配置后再操作。[systemd mount 文档源](https://github.com/systemd/systemd/blob/main/man/systemd.mount.xml)、[systemd unit 文档源](https://github.com/systemd/systemd/blob/main/man/systemd.unit.xml)

“现在不卡了”还可能是应用停止扫描、归档暂停、负载下降或 NAS 磁盘唤醒，不能据此确定原因。若有 D 状态进程或 `server not responding`，先处理连接与存储问题，避免堆积新的访问进程。`timeout` 不能保证杀掉内核不可中断 I/O；不要不断重跑卡住的命令。

## 第二轮：找到真正占空间的数据

第一轮确认没有失联的 NFS volume 后，再运行以下可能有额外 I/O 的命令。它们不删除数据，但 `docker system df -v` 会统计 volume，可能触及 NFS，不能作为失联场景的第一条命令：

```bash
sudo docker system df -v
sudo docker ps -a --size --format 'table {{.Names}}\t{{.Size}}'
sudo journalctl --disk-usage
```

`docker ps --size` 主要显示容器可写层，不包括挂载卷；Docker 汇总也不是任意 bind mount 的空间清单。结合第一轮的 source → target → Compose 项目映射再扫描。下面只选**已确认为本地 SSD**的目录，一次一个，低优先级运行；不是让你扫描 NAS：

```bash
# 例子：先核实 /srv 是本地目录，改成现场实际路径再执行。
sudo ionice -c 3 nice -n 19 du -xhd1 /srv | sort -h
# DockerRootDir 若确认为 /var/lib/docker，可分别看它的一级占用。
sudo ionice -c 3 nice -n 19 du -xhd1 /var/lib/docker | sort -h
```

`-x` 不跨不同文件系统，但**不会阻止扫描起点本身位于 NFS，也不会排除同设备 bind mount**。不要对未知目录递归扫描。大 named volume 需按容器挂载映射判断是 media、数据库还是缓存，不能凭 volume 名称删除。需要深入时再对确认的本地媒体子目录运行 `du`；先不做全盘 `find`、`lsof +D` 或 fio 写压测。不要执行 `docker system prune --volumes` 作为迁移步骤。

同时补充 NAS 型号、文件系统/阵列、可用容量、网络链路速度，以及 NAS 上低负载时的 `uptime`、`free -h`、`iostat -xz 1 3`（命令存在时）。先从状态判断 CPU、磁盘还是网络瓶颈，再决定是否做限速文件传输测试；不要在未知盘路径上运行写入型 fio。

## 开机顺序与 NFS 故障

设计应允许 Linux 比 NAS 先启动，也允许 NAS 运行中短暂掉线。

- SSH、Docker daemon、数据库和只依赖 SSD 的容器照常启动。不要给整个 `docker.service` 增加 `RequiresMountsFor=/mnt/nas`。
- 只有真正需要 NAS 的媒体容器/归档单元等待挂载；校验 NFS 类型、准确的 export/source 和专用卷标记后启动。目录存在、ping 通、`network-online.target` 到达都不等于 NFS 已可用。
- `create_host_path: false` 只能避免自动创建缺失目录。卸载后留在 SSD 的空目录仍可能存在，不能靠它判断 NAS 就绪。
- Docker 默认 private mount propagation；容器先绑定空目录后再挂 NFS，不保证容器能看到新挂载。需要在 NFS 就绪后重建受影响容器。不要用全局 restart Docker 代替。
- 普通媒体栈可以用专属 systemd 单元控制启动：`RequiresMountsFor=` 配合前置 source/type/卷标记检查；给该栈独立的延迟重试机制。仅有 `After=` 不会主动挂载，仅有 `RequiresMountsFor=` 也不是远端健康检查。
- **明确一个启动管理者。** 若由 systemd 负责整个栈的启动/重试，就让该栈的容器 `restart: "no"`，并正确监督 Compose 生命周期，避免 Docker 先自动拉起容器绕过挂载检查。不要仅包装 `compose up -d` 就假设 systemd 能监督容器崩溃；也不要假设失败的 mount 依赖会触发服务自身的 `Restart=`。需要显式的定时重试/运维重试策略。
- 本项目 archive 已是 `restart: "no"`；主机重启后需挂载确认再 `bash scripts/manage.sh attach`。基础 writer/reader 可独立启动；NAS 不在时本地文件仍可读，仅 NAS 副本的冷文件无法读取。

Docker 官方说明 bind propagation 与重启策略，并提醒不要同时混用 Docker restart policy 和宿主进程管理器来管理同一容器。[bind propagation](https://docs.docker.com/engine/storage/bind-mounts/#configure-bind-propagation)、[restart policies](https://docs.docker.com/engine/containers/start-containers-automatically/)

拿到现场输出后，可评估下列 fstab 方案。**这是候选配置，不应在排查前直接覆盖。** 暂保留已知的 NFSv3 与传输参数，不同时变更多个变量：

```fstab
nas-storage:/volume1/data1 /mnt/nas nfs rw,_netdev,nofail,x-systemd.automount,hard,vers=3,proto=tcp,rsize=524288,wsize=524288,timeo=600,retrans=2,sec=sys,x-systemd.mount-timeout=30s 0 0
```

`nofail` 减少对系统启动的硬依赖；automount 把实际连接推迟到首次访问。**首次访问仍会等待**，因此必须隔离使用 NAS 的服务；不建议给持续使用的媒体目录设置很短的 idle 自动卸载。NAS 支持的 NFSv4.1、rsize/wsize 自动协商可后续独立验证，不承诺更换版本就更快。[systemd mount 选项](https://github.com/systemd/systemd/blob/main/man/systemd.mount.xml)

原配置 `hard,timeo=600,retrans=2` 中，`600` 为 60 秒，`retrans=2` 不是“只试两次就返回”；hard 请求会持续恢复/重试。`x-systemd.mount-timeout` 只控制挂载命令等待，不能限制挂载后文件 I/O。不要为了不卡简单切换 `soft`：NFS 文档说明它在某些情况下存在静默数据损坏风险。[NFS mount options](https://man7.org/linux/man-pages/man5/nfs.5.html)

## 分应用迁移流程与回滚

1. 根据占用报告选出一个媒体量大、路径可独立挂载的应用。记录 Compose、容器 UID/GID、原 source/target、数据库与媒体的关系及备份位置。媒体和数据库混在一个卷时，先确认应用支持拆路径。
2. 核实目标 NAS export、真实挂载、容量、配额及权限；在**已确认的 NFS**里为应用准备专用目录与卷标记。测试容器实际 UID/GID 的读写/rename 权限。NFS root squash 下 root 并不等于有权写，不用 chmod 777 或关闭保护来掩盖权限错误。
3. 业务可接受时先做限速预复制，旧盘仍为权威源；活跃修改的文件暂不视为一致副本。数据库使用应用原生备份。源目录尾部的 `/` 表示复制内容而非多套一层目录。
4. 停止该应用的写入者、下载器、索引任务，保留原数据；再做最终增量复制和核验。目标用专用目录，发现目标多余文件时先人工核对，默认不加 `--delete`。
5. 只修改媒体 source，保持容器内 target 一致。数据库/配置/缓存继续在 SSD；读取方可挂只读。修改前先备份 Compose，再按挂载就绪流程重建此应用。
6. 验证数量、字节、校验和、权限、播放、Range 拖动、转码输出路径。安排维护窗口验收“NAS 未就绪时主机能启动、媒体栈不误写 SSD 空目录、恢复后重试、运行期掉线、正常重启”四类故障。
7. 观察一个约定周期后才删除旧媒体副本。**复制和切换都不会释放源盘空间**；删除前仍需确认业务全部读取新位置且有独立备份。NAS/RAID/归档不等于备份。

最终源/目标路径必须来自现场报告。下面只是常见复制参数；不要把占位路径直接执行：

```bash
# 先评估 NAS 的 ACL/xattr/硬链接支持；不支持时按应用需求调整 A/X/H。
# 51200 的单位为 KiB/s，约 50 MiB/s，可按业务负载降低。
sudo rsync -aHAX --numeric-ids --info=progress2 --bwlimit=51200 /CONFIRMED-SSD-MEDIA/ /CONFIRMED-NAS-MEDIA/
# 停写并做最终同步后，完整读双方文件进行 checksum 比较，开销较大。
sudo rsync -aHAXnci --numeric-ids /CONFIRMED-SSD-MEDIA/ /CONFIRMED-NAS-MEDIA/
```

校验有差异或 rsync 非零退出，不能删除源副本。跨 SSD/NFS 无法使用原子 rename 和跨盘硬链接；“移动到已完成目录”实际上可能变成完整复制。下载器/媒体整理工具依赖硬链接时，需要单独设计其最终目录布局。

回滚先停止新位置的写入。只读库可恢复旧 source 后重建；若切换后 NAS 已有新增/修改，先核对增量再回迁，否则直接切回旧路径会丢掉这段业务数据。迁移和删除分开，避免全栈停机与不可回退切换。
