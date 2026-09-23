# mx-static：部署、缓存与故障恢复

版本 0.7.0，2026-09-13。用户确认尚未线上部署。本服务负责多媒体字节与读取，不负责 Hub 租户授权、付费数据采集或 MX-H2I 登录/联网。当前是单主机持久服务；NAS 是可选归档层，不是 HTTP 主存储。Hub 接入已暂停。本文描述当前实现的行为与边界；目标负载下的吞吐代价、瓶颈与优化清单见 [容量与吞吐](capacity.md)，控制面数据库的作用/上限/是否换 PostgreSQL 见 [控制面](control-plane.md)。

现有 Docker 存储盘扩容和媒体迁往 NAS，先看 [NAS 迁移入口与现场记录](../nas_docs/README.md)。迁移文档和工具统一在本项目维护，通过 Git 分发；当前 Delta 排查使用 `scripts/nas-audit.sh`。fstab/systemd 背景与通用原则见 [SSD/NAS 通用方案](storage-migration.md)。媒体目录迁移与本项目静态文件服务可以并行部署。

2026-09-21：由 `knock-nas/fdc2f16` 归并到 mx-base，原来的 25 个文件与 knock-nas 初始 0.3.0 完全相同。此次补齐旧库升级及统一管理入口兼容，生产默认保留 Docker；可选宿主 Nginx 直接发文件。详见 [代码来源与部署决策](deployment-decision.md)。

## 部署和操作

优先在 `electron-dock/mx-base` 使用统一入口，保留应用选择与部署确认；这个入口不要求宿主安装 Node：

```sh
cp mx-static/.env.example mx-static/.env
bash scripts/manage.sh deploy mx-static
bash scripts/manage.sh status mx-static
bash scripts/manage.sh jobs mx-static
bash scripts/manage.sh attach mx-static
bash scripts/manage.sh detach mx-static
bash scripts/manage.sh storage mx-static
```

统一 deploy 准备目录、幂等生成凭据（含 admin-token，已有值不覆盖）、构建镜像并启动 writer/reader、等待健康。旧库在写端初始化时补列和索引。对已有实例升级前，应停止写入者/归档并备份 data/state/secrets；此次只移植源码，没有操作线上实例。

也保留了从 knock-nas 移入的独立管理入口，**以下命令在 mx-static 自身目录执行**；它使用宿主 Node 读取版本与生成配置，独立 deploy 会先构建，再停止核心容器、迁移、启动。不要混淆两个目录下 manage.sh 的参数：

```sh
bash scripts/manage.sh status     # 容器状态 + 实时容量与占用
bash scripts/manage.sh logs       # 跟随日志
bash scripts/manage.sh console    # 打印设置控制台地址与 token 位置
bash scripts/manage.sh doctor     # 检查路径、凭据、compose 有效性
bash scripts/manage.sh migrate    # 只跑控制面迁移
bash scripts/manage.sh attach     # 接入 NAS 归档（需已挂载并写好卷标记）
bash scripts/manage.sh detach     # 脱离 NAS 归档
bash scripts/manage.sh storage    # 归档后端状态与各项目计数
bash scripts/manage.sh stop       # 也支持 start、restart、build、prune
```

应用配置 schema 中的可调数值有类型和范围；畸形值会降级为默认值并记 warning。这个机制不涵盖 shell `.env` 语法、Compose 插值、端口、路径/权限、核心盘类型和凭据，这些错误仍可能阻止启动。没有配置 NAS 不影响核心部署；`attach` 才检查 NFS 挂载，远端卷身份由隔离的归档进程验证。

## 设置控制台

`http://<bind>:<writer 端口>/static/admin`，用 `secrets/admin-token` 登录。**没有配置 admin token 时整个入口返回 404**，不存在任何设置面。

按 服务 / 容量 / 采集 / 缓存 / NAS 归档 分组，不常动的收进「Advanced」折叠区。每项显示对应的环境变量名、取值范围和默认值。标记为可热改的设置**保存后立即生效，不需要重启**——改动存在 `settings.sqlite`，另一个容器（比如 reader）在几秒内跟上；不可热改的显示为「restart required」，需要改 `.env` 后重新 deploy。页面顶部是实时仪表：各池占用、两个下载池的在途数、事件循环延迟、带宽预算与链路占用。

层次是 **schema 默认值 < `.env` < 控制台改动**。把某项改回空即可退回下一层。

默认部署使用 `/srv/mx-static/data` 和 `/srv/mx-static/state` 两个物理目录，首次自动生成 `mx-static/secrets/projects.json`、`signing-key`，重复执行不覆盖凭据。root 运维只创建目录并分配 UID/GID，容器默认 1000:1000、只读根文件系统、无 capabilities。非 root 运维必须提前准备具有相应读写权限的目录。不要 chmod 777。凭据不会在 deploy/status/jobs 输出，且不可提交 Git。

Compose writer/reader 共享对象目录；reader 的对象与状态挂载均为只读。默认 writer `127.0.0.1:18200`，reader `127.0.0.1:18201`，独立容器重启策略、日志轮转、每容器 2 GiB 内存/2 CPU 上限。控制目录不能与对象目录相同。控制库拒绝 NFS/CIFS 及 Docker Desktop 的 virtiofs/9p 共享目录；Linux 用本机 SSD bind，macOS 测试用 Docker VM 内本地 volume。应用控制数据库使用镜像内固定 Node 24.21.0 / SQLite，升级需运行恢复回归。

0.4.0 起本仓库自足：构建上下文就是仓库本身，镜像只复制 `src/`，**没有任何运行时依赖**。SSRF/DNS 固定、媒体签名校验和流式下载都是本地模块（[net-guard.mjs](../src/net-guard.mjs)、[media-types.mjs](../src/media-types.mjs)、[fetch-media.mjs](../src/fetch-media.mjs)），不再从 mx-insight-hub 引入。**这三个模块是新写的，上线前应与 Hub 原模块对照评审。** 消费侧的客户端在 [client.mjs](../src/client.mjs)。运行依赖只有自身文件系统和可访问的上游 CDN。

## 请求与存储流程

1. 上游 JSON 的保存、租户授权与计费仍在 Hub。mx-static 不改变原样 JSON。
2. Hub 或外部项目提交媒体 URL，任务先写入本机 SQLite WAL，`synchronous=FULL` 提交后才确认接收。相同 project + scope + URL 的进行中任务合并。
3. 下载有**两个独立的池**：图片默认 24、视频默认 6，按 URL 扩展名分类（ingest 也可显式传 `kind`），音频与视频同池。**队列里全是视频也拿不走图片的 worker。** 最多接收 100000 个 queued/running 任务。HTTP 并发与下载并发分开；不会因为页面有 10 张图片就只接收 4 张。容量满返回 429，调用者保留任务并重试。**上游一页多条媒体应走批量接口**：`POST .../ingest/batch` 一次事务、一次 fsync 收下整页，批内重复与已在途任务自动合并，单条失败不影响整批。
4. 下载是流式的：边收边写 `<DATA_PATH>/.staging` 下的临时文件、边增量算 SHA-256，**前 12 字节就判定媒体签名**，坏源不会先写满再拒绝，视频字节不进 JS 内存。完成后 fsync、原子 rename 进对象目录、同步目录，再发布元数据并提交 ready 状态。只在完成后提供文件 key/预览链接。崩溃残留的 `.part` 在启动时清理。
5. 下载期间返回 202 和任务查询地址，不发布半成品文件 URL。同步等待由任务完成事件唤醒，不再每 50 ms 轮询一次控制库。默认等待最多 1 秒可直接返回已完成结果；`Prefer: respond-async` 立即确认持久任务。客户端断开不取消任务。**同步等待期间请求槽被占住，写路径并发上限 128，因此单条 ingest 在默认模式下的实际天花板约 128 QPS；高 QPS 调用方应使用批量接口，或固定带 `Prefer: respond-async` 并轮询。** 批量接口永远异步返回。
6. 进程强制终止后，过期租约最多约 60 秒后恢复。普通故障指数退避，最多 5 次；非法媒体/被拒 URL 等不重试。失败项保留，可显式 retry；常规重复读取不会无限新建失败任务。租约 owner 防止旧 worker 覆盖新结果。

磁盘布局（日期 UTC）：

| 挂载 | 内容 | 生命周期 |
| --- | --- | --- |
| `/data/objects/<project>/YYYY/MM/DD/HH/<xx>/<uuid>` | 不可变原始媒体字节 | 默认永久保留 |
| `/data/metadata/<project>/YYYY/MM/DD/HH/<xx>/<uuid>.json` | SHA-256、类型、大小、scope、采集时间 | 与对象一同保留 |
| `/data/.staging/*.part` | 下载中的临时文件 | 发布时 rename 进对象树；崩溃残留在启动/migrate 时清理 |
| `/state/settings.sqlite` 及 WAL/SHM | 控制台改过的运行时设置 | 本机磁盘 |
| `/state/archive.sqlite` 及 WAL/SHM | 归档/恢复 outbox、NAS 状态、卷身份 | 永远留本地 |
| `/state/jobs.sqlite` 及 WAL/SHM | 持久队列、租约、来源索引、完成记录 | 本机磁盘；不可迁到 NAS |
| `/data/sources/...` | 兼容 0.1 版旧来源索引 | 新写入使用控制库索引 |

当前配置 schema 的单文件默认上限是 **256 MiB**（`MX_STATIC_MAX_BYTES`，当前 Compose 尚未转发此变量），写前至少保留 512 MiB 空间；用独立分区和容量告警避免占满主机。当前不自动删历史对象、任务历史或未引用文件，以免误删证据；运维需要监测增长。文件上传在完整接收并持久化后才返回 201，最多 2 个并发上传。下载已流式化；**上传仍整文件缓冲**，拼接和解析还会带来额外内存开销，不能根据下载流式化就安全地放大上传上限。当前图片/视频下载默认分别为 24/6 个 worker；URL 下载固定 30 秒超时。上传中断、未收到成功响应不能视为存储成功；当前不提供分片续传，也不保证来源 URL 在重启重试前仍有效。

## 内容去重与引用计数

**相同的字节只存一份。** 落盘前按 SHA-256 查是否已持有该内容；命中就对同一个 inode 再建一个硬链接，不写第二份。去重跨 project、跨 scope 生效，但对调用方完全不可见：每个引用仍是自己的 key、自己的 metadata、自己的鉴权边界。

物理引用计数由文件系统承担：`DELETE` 只解除该 key 自己的链接，**字节要到最后一个引用被删除时才真正释放**。删除响应会告诉你还剩多少引用：

```sh
curl -X DELETE "$STATIC_URL/static/v1/projects/mx-insight-hub/objects/<key>" \
  -H "Authorization: Bearer $WRITE_TOKEN"
# {"key":"...","references":2,"contentRemoved":false,"archivedCopyQueuedForRemoval":false}
```

`references` 是删除后仍指向同一内容的引用数，`contentRemoved` 为 true 表示这份内容已经没有任何引用。删除需要 write token，且只能删本 project 的 key；重复删除返回 404 而不是错误状态。**没有批量删除接口**。

NAS 侧同样去重：同内容的第二个 key 在 NAS 上是一次 LINK，不重新传输字节。同一批任务里的相同内容也只传一次。**删除本地 key 保留 NAS 文件**，不会排队清除远端；旧 purge 记录保留但不再执行。`contentRemoved` 仅说明本地引用，不表示 NAS 副本删除。归档发布保留暂存硬链接，失败残留也不自动清理；现有远端内容冲突会报错，不自动覆盖。迁移清理需另走明确的迁移维护流程。

`GET /static/v1/projects/<p>/storage` 的 `content` 字段给出 `references` / `distinctObjects` / `logicalBytes` / `storedBytes` / `savedBytes`。

**已知边界**：两个内容相同的下载**同时**完成时，谁都还没登记，于是各写一份——结果正确但没省下空间。当前没有后台合并任务。

## 冷热与释放本机副本

归档表记录每个对象的最后读取时间。读路径只写内存，由定时器批量合并成一次事务（只读副本通过 `POST .../storage/touch` 汇报给 writer），**不会让访问统计出现在每次读取的关键路径上**。

`GET .../storage?coldFor=<毫秒>` 的 `coldest` 列出已归档、仍在本机、且超过该时长没被读过的对象，按最后读取时间排序——这是 `evict` 应该瞄准的对象。默认 24 小时。当前仍不自动 evict，需要按业务保留策略显式调用。

## 多级缓存：刷新为什么不回源

| 层 | 默认策略 | 淘汰后 |
| --- | --- | --- |
| Hub 媒体内存 | 按租户 + URL 隔离，64 MiB、最多 2048 条、TTL 60 秒 | 请求 mx-static；不会因此重新调用付费数据接口 |
| mx-static writer/reader 内存 | 各自 64 MiB、最多 2048 条、单文件 ≤1 MiB、TTL 60 秒、LRU | 从本机对象盘读取；冷对象异步恢复后再缓存 |
| OS page cache | 操作系统按内存压力管理 | 访问本机磁盘 |
| 本机对象盘 | 默认保留完整文件 | 只有显式、校验后的 evict 才释放 |
| NFS 归档盘 | 独立后台同步与校验 | 离线不阻塞 HTTP 本地读写 |

Hub 每次读取检查有效期，并每 10 秒清理；mx-static 每次读取检查有效期，并每 0.5 秒清理。大文件使用流式文件读取与 Range，避免所有视频都装入 JS 内存。小文件同 key 的缓存填充合并，最多 16 个同时填充，其余流式读取。读许可分三种：两类共用的磁盘短读（超出 503 `storage_read_busy`），以及**图片/静态资源与视频/音频各自独立的传输许可**（超出 503 `storage_stream_busy`）。一路 Range 视频流只占视频池，**视频再多也拿不走图片的名额**；事件循环延迟超过 `MX_STATIC_MAX_LAG_MS`（默认 250 ms）时视频类先降级返回 503 `storage_overloaded`，图片类永不因此被拒。这些许可数由声明的服务水平推导，见下节。>1 MiB 的对象仍不进 body 缓存，但其 manifest 有独立 LRU 缓存（默认 8 MiB / 2 万条 / TTL 5 分钟），Range 请求不再重读 JSON。

mx-static `cache_first` 命中已完成来源索引就返回存档；`cache_only` 绝不抓来源，缺失且无在途任务返回 404，在途返回 202；`refresh` 明确创建新采集任务，有旧文件时在后台更新期间立即可用旧文件，返回 `refreshing_cache`，最终失败返回 `stored_fallback`。旧 key 永远保持对应版本原始字节。

刷新网页重新展示已提交结果与点击“重新采集最新数据”是不同操作：后者仍遵守 Hub 的付费数据刷新策略，但同 URL 媒体默认 cache_first。已存 URL 后续内容发生变化时，需显式 media refresh 归档新版本。

## 容量按服务水平声明

不要直接猜许可数。在 `.env` 里声明这套部署必须扛住什么，许可数由 Little 定律推导（`并发 = 速率 × 延迟`，再乘突发系数）：

```dotenv
MX_STATIC_SLO_ASSET_QPS=10            # 图片/静态资源，持续每秒读取数
MX_STATIC_SLO_ASSET_P95_MS=200        # 该类的延迟预算
MX_STATIC_SLO_VIDEO_VIEWERS=30        # 同时在看的视频路数
MX_STATIC_SLO_VIDEO_BITRATE_KBPS=3000
MX_STATIC_LINK_MBPS=1000              # 用 iperf3 量，不要照抄默认值
MX_STATIC_DISK_READ_MBPS=500          # 用 fio 量
```

启动日志打印推导结果与带宽预算。**声明的目标装不进声明的硬件时会给出 `capacity warning`**，`MX_STATIC_CAPACITY_STRICT=true` 则直接拒绝启动。`GET /static/v1/projects/<p>/capacity`（read token）返回声明、许可、带宽预算，以及当前各池占用、事件循环延迟、缓存命中率和下载队列深度——用它看余量，不要靠猜。推导值可用 `MX_STATIC_MAX_READS` / `MX_STATIC_MAX_ASSET_STREAMS` / `MX_STATIC_MAX_VIDEO_STREAMS` 显式覆盖。详见 [容量与吞吐](capacity.md) §2.5。

## 接口

请求路径均保留 `/static`。项目 write token 用于写入、retry；read token 可读该项目文件和任务。Hub 令牌只留在服务器；下游租户经 Hub 原鉴权入口访问。外部独立调用者分配独立 project，不能分发 Hub 项目的令牌。新增 project 后更新 secrets 并重启两个容器。

```sh
# 输入 URL：持久接收，返回 202 + id/state/statusUrl，或命中缓存直接 200
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/ingest" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -H 'Prefer: respond-async' \
  -d '{"url":"https://example.com/image.jpg","scope":"tenant-scope","mode":"cache_first"}'

# 整页批量：一次事务、一次 fsync、一个请求槽；逐条返回状态
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/ingest/batch" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"scope":"tenant-scope","mode":"cache_first","items":[
        "https://example.com/a.jpg","https://example.com/b.mp4"]}'

# 查询任务（queued/running 为 202 + Retry-After，ready/failed 为 200）
curl "$STATIC_URL/static/v1/projects/mx-insight-hub/jobs/$JOB_ID" \
  -H "Authorization: Bearer $READ_TOKEN"

# 显式重试失败任务（保留原失败记录）
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/jobs/$JOB_ID/retry" \
  -H "Authorization: Bearer $WRITE_TOKEN"

# 项目计数与最近 100 个任务；无来源 URL 明文
curl "$STATIC_URL/static/v1/projects/mx-insight-hub/jobs" \
  -H "Authorization: Bearer $READ_TOKEN"

# 单文件 multipart，也支持原始二进制 POST + Content-Type
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/upload" \
  -H "Authorization: Bearer $WRITE_TOKEN" -F 'file=@photo.jpg;type=image/jpeg'
```

ready/上传成功响应包含 key、sha256、size、contentType、capturedAt、sourceMode 和 15 分钟有效 previewUrl。浏览器直接打开 previewUrl 可预览图片/音视频，受浏览器编解码能力限制。支持 JPEG/PNG/WebP、MP4/WebM、MP3/Ogg/WAV、PDF；校验文件签名，PDF 强制下载，拒绝 HTML/SVG/脚本。

批量返回 `{"results":[...]}`，顺序与输入一致；每项是命中缓存的存档结果、任务视图，或 `{"error":{"code":...},"status":...}`。单批上限 `MX_STATIC_MAX_BATCH`（默认 200），请求体上限 1 MiB。整批鉴权失败才返回非 200。

`GET/HEAD /static/files/<key>` 支持 Bearer 或短期签名，ETag/304 和单区间 Range/206；`x-mx-static-cache` 表示 memory/disk/stream/accel。

配置 `MX_STATIC_ACCEL_REDIRECT` 后，可由宿主 Nginx 发送文件字节；Compose 默认空值保持关闭。`deploy/internal-upstreams.conf` 放在 `http` 上下文，`deploy/internal-locations.conf` 放在 `server` 上下文；权限、Range/条件请求与限流边界按 [部署决策](deployment-decision.md) 验收。容器继续鉴权、判断冷文件和处理本地元数据。内存命中仍由本服务直接返回。Node 路径响应 `cache-control: private, max-age=<N>, immutable`，`N` 取 `MX_STATIC_FILE_MAX_AGE`（默认 900）与签名剩余有效期的较小值；启用 Nginx 后也需端到端核对缓存头。没有无鉴权目录或文件列表。签名过期由授权端重新申请。

CORS 默认关闭，跨域 JS 读取需精确配置 MX_STATIC_CORS_ORIGINS。同域 `/static` 不需新证书，但路径不是安全隔离边界，强制 nosniff/CSP sandbox，不托管主动内容。URL 下载只接受 HTTPS（已知 Alibaba HTTP CDN 升级 HTTPS），逐跳检查公网地址并固定连接 IP，拒绝私网/回环/元数据地址；不转发 Cookie/Authorization，不关闭 TLS 校验。

## NAS 接入、脱离与恢复

**不要将 DATA_PATH、STATE_PATH 或整个 Docker 数据目录迁往 NAS。** 主服务只用本机盘。NAS 挂载仅进入 `compose.nas.yml` 的 archive 容器，基础服务可在 NAS 完全未配置、未就绪时启动。

先在 Linux 宿主完成 NFS 挂载与 UID/GID 权限准备，确认它是目标 NFS 后，在用于 mx-static 的目录中创建 `.mx-static-volume-id`（例如内容 `mx-static-nas-01`）。不要自动在未确认的空目录中生成标记。`.env` 配置：

```dotenv
MX_STATIC_DATA_PATH=/srv/mx-static/data
MX_STATIC_STATE_PATH=/srv/mx-static/state
MX_STATIC_NAS_PATH=/mnt/nas/mx-static
MX_STATIC_NAS_VOLUME_ID=mx-static-nas-01
```

在本仓库目录操作：

```sh
bash scripts/manage.sh deploy   # 不要求 NAS 配置或就绪
bash scripts/manage.sh attach   # 核实 NFS 类型，只重建 archive 容器
bash scripts/manage.sh storage  # online/backoff/stalled/offline/detached 与任务字节数
bash scripts/manage.sh detach   # 先逻辑脱离，再请求停止 archive
```

attach 启动容器不等于远端身份验证完成，要看 storage 状态。普通网络恢复由仍运行的归档组件自动探测和重试；NFS 被卸载、重新挂载后使用 attach 重建归档容器，使它获得新挂载。writer/reader 无需重启。archive 默认不随 Docker 自动启动，主机重启后待 NFS 就绪再 attach；可以单独为 archive 配置依赖 NFS mount unit 的宿主启动单元，不能让主服务等待该 mount。NAS 未挂载时 attach 拒绝；卷标记不匹配时不写入任何文件。更换另一块 NAS 需先完成完整迁移和验证，不能只改 volume ID 绕过保护。

**始终最多一个归档子进程**（这是防 NFS D 状态僵尸堆积的不变量），但该子进程内部按 `MX_STATIC_NAS_CONCURRENCY`（默认 4）并发处理一批任务——小文件写 NFS 是延迟受限的，串行会让链路基本空转。逐任务回报结果：**一个坏对象按自己的退避重排队，不拖住也不重跑整批**，后端健康保持 online；子进程没有回报过的任务一律重排队，干净退出不等于某个对象写成功。长批次靠进度消息续租，恢复时间仍是约 60 秒。用 `scripts/nas-bench.mjs` 在真实 NAS 上测出该设多少。

`MX_STATIC_NAS_VERIFY=always|sample|never`（默认 `always`）控制写入 NAS 后的整文件回读校验，它会让 NFS 流量翻倍。`sample` 按对象 SHA 前缀确定性抽 1/16。**`evict` 永远完整校验，不受此配置影响**——那是唯一删除另一份副本的操作。流式传输，archive 容器限制 512 MiB / 0.5 CPU。15 秒无进度超时，正常慢传输有进度可继续，任务最长 15 分钟（可配置 MX_STATIC_NAS_IDLE_TIMEOUT_MS/MX_STATIC_NAS_MAX_JOB_MS）。超时熔断并退避，不堆积新的 NFS 子进程；若内核 D 状态使 SIGKILL 也无法结束，storage 显示 stalled，需恢复 NFS/宿主诊断，不反复强制新建容器。

本机内存命中直接返回；本地文件读取有并发上限与首响应超时，慢 I/O 返回可重试 503。主进程不做 NFS stat/read/write/目录扫描，因此 NAS 慢盘不会占满它的文件线程池。若本机主磁盘自身严重卡死，SQLite/操作系统也受影响，不能承诺无限可用。

## 冷文件、空间管理与接口

默认不自动清理本机副本，优先保证 NAS 离线期间可读取。需要利用 NAS 远端容量时，可以按明确业务保留策略逐个释放已归档的本机对象；实际容量、内存和阵列状态需在部署前重新确认：

```sh
# 查询本项目归档计数、字节数及 NAS 状态
curl "$STATIC_URL/static/v1/projects/mx-insight-hub/storage" -H "Authorization: Bearer $READ_TOKEN"

# 请求校验 NAS 副本后释放本机文件；元数据永远留本地
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/storage/evict" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"<完整文件 key>"}'
```

相同格式的 `/storage/restore` 请求恢复；`/storage/sync` 可用本机完整副本重建损坏的 NAS 副本。操作返回 202，只表示请求入队。被拒时返回 409 **并说明是哪个前置条件不成立**：`archive_key_unknown`、`not_yet_archived`、`already_evicted`、`local_copy_missing`、`archive_busy`（该 key 已有在途转换）、`archive_backend_<detached|offline|backoff|stalled>`。释放前完整 SHA 核验失败不会删本机文件。

冷文件 GET 自动请求恢复并返回 `503 media_restore_pending` / `Retry-After: 2`，文件恢复后原地址正常读取，不返回误导性的 404、不自动回源。reader 通过内部 writer 地址入队，网络超时 1 秒；API 客户端应退避轮询。NAS 离线且文件仅存在 NAS 时，无法凭空返回字节，必须等待恢复。需要离线可用的文件应保留本机副本。

本机至少预留 512 MiB；恢复也受空间保护。NAS 长期离线时新增文件会占用本机容量，盘满后拒绝新写入，已有本地文件继续读。建议本地盘按“写入速率 × 预期最长 NAS 离线时间 + 热数据集 + 并发暂存/恢复 + 预留空间”规划。当前没有自动 LRU 删盘、自动扩容或多 NAS 切换；本地归档表已记录访问时间并提供 coldest 查询，但仍需按业务规则显式 evict。误把热对象释放到 NAS 会让该对象的读延迟从毫秒级变成一次整文件恢复。异常中断可能留下未引用临时文件，清理须审计，不能直接批量删除对象目录。

## Hub 与 Nginx 状态

按用户最新要求，**Hub 运行时没有接入 mx-static**：已撤下 index、ingest worker、环境和部署配置接线；适配模块仍保留作后续实验，不会自动调用。本文项目名 `mx-insight-hub` 仅用于凭据/API 示例。原有 Hub 页面/API 文档/媒体 URL 修复继续保留。

`deploy/edge-locations.conf` 与 `deploy/internal-locations.conf` 仍是独立静态服务的路由模板：`/static/files` 转 reader，`/static/v1` 转 writer。发布路由不等于 Hub 媒体调用已接入。当前没有线上部署或 Nginx reload。正式接入 Hub 前，须验证 pending 重试、租户隔离、NAS 长期离线、冷文件恢复、本机盘满及原登录/联网路径。

## 备份与边界

一致性备份：先 detach NAS，再 stop mx-static，确认所有写入者已停止，备份完整 data、state、secrets，随后启动。jobs/archive/settings 三个 SQLite 库及其 WAL 都属于备份范围，不要在线只复制主 DB 文件。NAS 保存对象和元数据副本，不能取代本机控制库及凭据备份。

本实现提供服务层逻辑热插拔，不承诺运行中任意替换 Docker volume。NFS hard 挂载的内核等待不能靠 JS 超时取消；soft 挂载又存在数据完整性风险，所以采用隔离进程和持久本地缓冲。原先 0.2 版直接迁移 DATA_PATH 到 NAS 的方案已废止；本仓库内的部署依据与官方资料见 [存储迁移方案](storage-migration.md)。

## 验证

见 [验证记录](validation.md)，容量与吞吐评估见 [容量与吞吐](capacity.md)（含上线前必须实测的 fio/iperf3 清单）。上线验收还需在目标主机完成真实闲鱼来源、磁盘性能、两跳 Nginx 和 NAS 故障测试；截图的 422 不能仅凭状态码认定 CORS，需读取 error.code。旧 HTTP Alibaba 媒体 URL 已补 HTTPS 兼容。
