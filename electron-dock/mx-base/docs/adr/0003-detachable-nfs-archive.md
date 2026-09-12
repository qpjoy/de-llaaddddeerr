# ADR-0003：本机接收、独立 NFS 归档与逻辑热插拔

2026-09-12，0.3.0。覆盖 ADR-0002 中“将对象主目录直接迁到 NAS”的方案。用户提供 NAS：NFS、36 TB、4 GB 内存。当前先完善 mx-static，Hub 运行时接入暂停。

## 决策

HTTP writer/reader 的 `/data`、`/state` 永远是本机磁盘。启动通过读取本地 mountinfo 拒绝 NFS/CIFS/FUSE 路径，不去 stat 失联挂载。NAS 只挂给可选 `archive` 容器，基础 Compose 无 NAS 配置依赖。归档容器单独重建不改变主服务容器或地址。

归档工作分两层：监督进程只访问本机 SQLite 控制库；一个子进程访问 NFS。子进程 15 秒没有进度则触发超时，文件传输有进度时延长等待，单任务最长 15 分钟。超时向子进程发 SIGKILL；若处于内核 D 状态无法退出，保留唯一工作槽，不不断启动替代进程。服务状态报告 stalled，主 HTTP 进程和它的文件 I/O 线程池不接触 NFS。

这提供的是**服务层逻辑热插拔**：detach 停止接收归档任务；attach 只重建归档容器并续传。不是对正在运行的主服务替换 Docker volume，更不是保证任意 NFS 内核故障都可热卸载。Docker bind/volume 默认 rprivate，不能把默认挂载当成可动态传播的热插拔设备。[Docker bind mounts](https://docs.docker.com/engine/storage/bind-mounts/)、[Docker volumes](https://docs.docker.com/engine/storage/volumes/)。

NFS hard 挂载断连可持续重试，soft 超时又有数据完整性风险。保留 hard 的完整性语义，通过进程隔离控制服务影响；不以切换 soft 作为可靠性修复。D 状态可能需要 NFS 恢复乃至宿主运维干预，不承诺强制卸载永远成功。[nfs(5)](https://man7.org/linux/man-pages/man5/nfs.5.html)。

## 数据状态

本机完整文件 + 元数据落盘 → 本机归档 outbox → NAS 临时文件 → 校验长度与 SHA-256 → fsync/rename → mirrored。归档确认前本机副本不可释放，API 201 表示本机持久保存，不表示 NAS 已完成。

默认永久保留本机文件，无自动淘汰。显式 evict 命令需要最近 online 状态，并在子进程再次完整校验 NAS 文件后才删除本机对象；元数据和控制记录始终本地。NAS 副本损坏/失联时拒绝释放。本地目录空间不足拒绝新写入/恢复，不删除唯一副本来腾空间。

冷文件读取在本地缺失时请求异步 restore；reader 通过短超时内网 HTTP 请求 writer 入队，二者均不读取 NFS。返回 503 + Retry-After，恢复完成后原 key 可读取。NAS 离线期间无法保证只存在于 NAS 上的文件仍能立即读取；这是容量与离线可用性之间的明确取舍。缺失本地副本不自动重新抓上游。

## 恢复与容量边界

归档 outbox、租约、backend identity 都在本机 `archive.sqlite`；重启后续传，恢复任务优先，失败退避至最多约 5 分钟。挂载必须是 NFS 且 `.mx-static-volume-id` 匹配，防止空挂载目录回落本机或误接其他盘。确认接入的 volume ID 不可随意更换。

NAS 只有 4 GB 内存，初版使用单个归档子进程、流式传输，归档容器限制 256 MiB / 0.5 CPU。36 TB 是远端容量，不是本机缓冲容量；应按 `写入字节速率 × 最大预期 NAS 离线时间 + 热数据 + 预留空间` 配置本地盘。本机盘完全损坏或卡住仍是主服务基础设施故障，进程隔离无法消除这一物理依赖。

## Hub 状态

先前添加的是默认关闭的可选适配。此轮撤下 `server/index.mjs`、ingest worker、环境模板和部署配置中的接线；适配模块保留为未接入实验代码。Hub 不派发 static-media 作业，不调用 mx-static。原有商品页面默认/API 文档/Alibaba URL 兼容改动保留，MX-H2I 登录和联网不变。
