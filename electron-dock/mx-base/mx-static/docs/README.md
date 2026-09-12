# mx-static：部署、缓存与故障恢复

版本 0.3.0，2026-09-12。用户确认尚未线上部署。本服务负责多媒体字节与读取，不负责 Hub 租户授权、付费数据采集或 MX-H2I 登录/联网。当前是单主机持久服务；NAS 是可选归档层，不是 HTTP 主存储。Hub 接入已暂停。

## 部署和操作

在 Internal 的 `electron-dock/mx-base` 目录执行：

```sh
cp mx-static/.env.example mx-static/.env
# 编辑 .env：DATA_PATH 对象目录，STATE_PATH 本机队列目录，UID/GID 等。
bash scripts/manage.sh deploy mx-static
bash scripts/manage.sh status
bash scripts/manage.sh jobs mx-static
bash scripts/manage.sh logs mx-static
```

不带参数运行 `manage.sh` 可选择应用和操作；`deploy` 只选择一个应用。`stop mx-static` 保留容器、挂载数据和凭据；`start` 恢复；`restart` 重启；`doctor` 查看上下文、状态和 Compose 配置有效性。Jenkins 是独立应用，不会随 mx-static 启动。

默认部署使用 `/srv/mx-static/data` 和 `/srv/mx-static/state` 两个物理目录，首次自动生成 `mx-static/secrets/projects.json`、`signing-key`，重复执行不覆盖凭据。root 运维只创建目录并分配 UID/GID，容器默认 1000:1000、只读根文件系统、无 capabilities。非 root 运维必须提前准备具有相应读写权限的目录。不要 chmod 777。凭据不会在 deploy/status/jobs 输出，且不可提交 Git。

Compose writer/reader 共享对象目录；reader 的对象与状态挂载均为只读。默认 writer `127.0.0.1:18200`，reader `127.0.0.1:18201`，独立容器重启策略、日志轮转、每容器 2 GiB 内存/2 CPU 上限。控制目录不能与对象目录相同。控制库拒绝 NFS/CIFS 及 Docker Desktop 的 virtiofs/9p 共享目录；Linux 用本机 SSD bind，macOS 测试用 Docker VM 内本地 volume。应用控制数据库使用镜像内固定 Node 24.21.0 / SQLite，升级需运行恢复回归。

Dockerfile 的构建上下文为 `electron-dock`，仅复制 Hub 已测试的无状态 SSRF/DNS 固定媒体模块和错误类，无 Hub 进程或数据库依赖。因此部署源码保留这两个文件即可，后续可提取为共享代码包。运行依赖只有自身文件系统和可访问的上游 CDN。

## 请求与存储流程

1. 上游 JSON 的保存、租户授权与计费仍在 Hub。mx-static 不改变原样 JSON。
2. Hub 或外部项目提交媒体 URL，任务先写入本机 SQLite WAL，`synchronous=FULL` 提交后才确认接收。相同 project + scope + URL 的进行中任务合并。
3. 后台默认 4 个下载 worker，最多接收 10000 个 queued/running 任务。HTTP 并发与下载并发分开；不会因为页面有 10 张图片就只接收 4 张。容量满返回 429，调用者保留任务并重试。
4. 下载完成校验大小与媒体签名，写临时文件、fsync、原子 rename、同步目录，再发布元数据并提交 ready 状态。只在完成后提供文件 key/预览链接。
5. 下载期间返回 202 和任务查询地址，不发布半成品文件 URL。默认等待最多 1 秒可直接返回已完成结果；`Prefer: respond-async` 立即确认持久任务。客户端断开不取消任务。
6. 进程强制终止后，过期租约最多约 60 秒后恢复。普通故障指数退避，最多 5 次；非法媒体/被拒 URL 等不重试。失败项保留，可显式 retry；常规重复读取不会无限新建失败任务。租约 owner 防止旧 worker 覆盖新结果。

磁盘布局（日期 UTC）：

| 挂载 | 内容 | 生命周期 |
| --- | --- | --- |
| `/data/objects/<project>/YYYY/MM/DD/<uuid>` | 不可变原始媒体字节 | 默认永久保留 |
| `/data/metadata/<project>/YYYY/MM/DD/<uuid>.json` | SHA-256、类型、大小、scope、采集时间 | 与对象一同保留 |
| `/state/archive.sqlite` 及 WAL/SHM | 归档/恢复 outbox、NAS 状态、卷身份 | 永远留本地 |
| `/state/jobs.sqlite` 及 WAL/SHM | 持久队列、租约、来源索引、完成记录 | 本机磁盘；不可迁到 NAS |
| `/data/sources/...` | 兼容 0.1 版旧来源索引 | 新写入使用控制库索引 |

每文件上限 64 MiB，写前至少保留 512 MiB 空间；用独立分区和容量告警避免占满主机。当前不自动删历史对象、任务历史或未引用文件，以免误删证据；运维需要监测增长。文件上传在完整接收并持久化后才返回 201，最多 2 个并发上传。上传中断、未收到成功响应不能视为存储成功；当前不提供分片续传，也不保证来源 URL 在重启重试前仍有效。

## 多级缓存：刷新为什么不回源

| 层 | 默认策略 | 淘汰后 |
| --- | --- | --- |
| Hub 媒体内存 | 按租户 + URL 隔离，64 MiB、最多 2048 条、TTL 60 秒 | 请求 mx-static；不会因此重新调用付费数据接口 |
| mx-static writer/reader 内存 | 各自 64 MiB、最多 2048 条、单文件 ≤1 MiB、TTL 60 秒、LRU | 从本机对象盘读取；冷对象异步恢复后再缓存 |
| OS page cache | 操作系统按内存压力管理 | 访问本机磁盘 |
| 本机对象盘 | 默认保留完整文件 | 只有显式、校验后的 evict 才释放 |
| NFS 归档盘 | 独立后台同步与校验 | 离线不阻塞 HTTP 本地读写 |

Hub 每次读取检查有效期，并每 10 秒清理；mx-static 每次读取检查有效期，并每 0.5 秒清理。大文件使用流式文件读取与 Range，避免所有视频都装入 JS 内存。小文件同 key 的缓存填充合并，最多 16 个同时填充，其余流式读取。

mx-static `cache_first` 命中已完成来源索引就返回存档；`cache_only` 绝不抓来源，缺失且无在途任务返回 404，在途返回 202；`refresh` 明确创建新采集任务，有旧文件时在后台更新期间立即可用旧文件，返回 `refreshing_cache`，最终失败返回 `stored_fallback`。旧 key 永远保持对应版本原始字节。

刷新网页重新展示已提交结果与点击“重新采集最新数据”是不同操作：后者仍遵守 Hub 的付费数据刷新策略，但同 URL 媒体默认 cache_first。已存 URL 后续内容发生变化时，需显式 media refresh 归档新版本。

## 接口

请求路径均保留 `/static`。项目 write token 用于写入、retry；read token 可读该项目文件和任务。Hub 令牌只留在服务器；下游租户经 Hub 原鉴权入口访问。外部独立调用者分配独立 project，不能分发 Hub 项目的令牌。新增 project 后更新 secrets 并重启两个容器。

```sh
# 输入 URL：持久接收，返回 202 + id/state/statusUrl，或命中缓存直接 200
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/ingest" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -H 'Prefer: respond-async' \
  -d '{"url":"https://example.com/image.jpg","scope":"tenant-scope","mode":"cache_first"}'

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

`GET/HEAD /static/files/<key>` 支持 Bearer 或短期签名，ETag/304 和单区间 Range/206；`x-mx-static-cache` 表示 memory/disk/stream。没有无鉴权目录或文件列表。签名过期由授权端重新申请，轮换 signing-key 撤销既有预览链接。

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

在 mx-base 目录操作：

```sh
bash scripts/manage.sh deploy mx-static   # 不要求 NAS 配置或就绪
bash scripts/manage.sh attach mx-static   # 核实 NFS 类型，只重建 archive 容器
bash scripts/manage.sh storage mx-static  # online/backoff/stalled/offline/detached 与任务字节数
bash scripts/manage.sh detach mx-static   # 先逻辑脱离，再限时停止 archive
```

attach 启动容器不等于远端身份验证完成，要看 storage 状态。普通网络恢复由仍运行的归档组件自动探测和重试；NFS 被卸载、重新挂载后使用 attach 重建归档容器，使它获得新挂载。writer/reader 无需重启。archive 默认不随 Docker 自动启动，主机重启后待 NFS 就绪再 attach；可以单独为 archive 配置依赖 NFS mount unit 的宿主启动单元，不能让主服务等待该 mount。NAS 未挂载时 attach 拒绝；卷标记不匹配时不写入任何文件。更换另一块 NAS 需先完成完整迁移和验证，不能只改 volume ID 绕过保护。

默认单个归档子进程，流式传输，archive 容器限制 256 MiB / 0.5 CPU。15 秒无进度超时，正常慢传输有进度可继续，任务最长 15 分钟（可配置 MX_STATIC_NAS_IDLE_TIMEOUT_MS/MX_STATIC_NAS_MAX_JOB_MS）。超时熔断并退避，不堆积新的 NFS 子进程；若内核 D 状态使 SIGKILL 也无法结束，storage 显示 stalled，需恢复 NFS/宿主诊断，不反复强制新建容器。

本机内存命中直接返回；本地文件读取有并发上限与首响应超时，慢 I/O 返回可重试 503。主进程不做 NFS stat/read/write/目录扫描，因此 NAS 慢盘不会占满它的文件线程池。若本机主磁盘自身严重卡死，SQLite/操作系统也受影响，不能承诺无限可用。

## 冷文件、空间管理与接口

默认不自动清理本机副本，优先保证 NAS 离线期间可读取。需要利用 36 TB 远端容量时，可以按明确业务保留策略逐个释放已归档的本机对象：

```sh
# 查询本项目归档计数、字节数及 NAS 状态
curl "$STATIC_URL/static/v1/projects/mx-insight-hub/storage" -H "Authorization: Bearer $READ_TOKEN"

# 请求校验 NAS 副本后释放本机文件；元数据永远留本地
curl -X POST "$STATIC_URL/static/v1/projects/mx-insight-hub/storage/evict" \
  -H "Authorization: Bearer $WRITE_TOKEN" -H 'Content-Type: application/json' \
  -d '{"key":"<完整文件 key>"}'
```

相同格式的 `/storage/restore` 请求恢复；`/storage/sync` 可用本机完整副本重建损坏的 NAS 副本。操作返回 202，只表示请求入队。未归档、不具备有效 NAS 副本或状态不允许时返回 409。释放前完整 SHA 核验失败不会删本机文件。

冷文件 GET 自动请求恢复并返回 `503 media_restore_pending` / `Retry-After: 2`，文件恢复后原地址正常读取，不返回误导性的 404、不自动回源。reader 通过内部 writer 地址入队，网络超时 1 秒；API 客户端应退避轮询。NAS 离线且文件仅存在 NAS 时，无法凭空返回字节，必须等待恢复。需要离线可用的文件应保留本机副本。

本机至少预留 512 MiB；恢复也受空间保护。NAS 长期离线时新增文件会占用本机容量，盘满后拒绝新写入，已有本地文件继续读。建议本地盘按“写入速率 × 预期最长 NAS 离线时间 + 热数据集 + 预留空间”规划。当前没有自动 LRU 删盘、自动扩容或多 NAS 切换。异常中断可能留下未引用临时文件，清理须审计，不能直接批量删除对象目录。

## Hub 与 Nginx 状态

按用户最新要求，**Hub 运行时没有接入 mx-static**：已撤下 index、ingest worker、环境和部署配置接线；适配模块仍保留作后续实验，不会自动调用。本文项目名 `mx-insight-hub` 仅用于凭据/API 示例。原有 Hub 页面/API 文档/媒体 URL 修复继续保留。

`deploy/edge-locations.conf` 与 `deploy/internal-locations.conf` 仍是独立静态服务的路由模板：`/static/files` 转 reader，`/static/v1` 转 writer。发布路由不等于 Hub 媒体调用已接入。当前没有线上部署或 Nginx reload。正式接入 Hub 前，须验证 pending 重试、租户隔离、NAS 长期离线、冷文件恢复、本机盘满及原登录/联网路径。

## 备份与边界

一致性备份：先 detach NAS，再 stop mx-static，备份完整 data、state、secrets，随后启动。两个 SQLite 库及 WAL 都属于备份范围，不要在线只复制主 DB 文件。NAS 保存对象和元数据副本，不能取代本机控制库及凭据备份。

本实现提供服务层逻辑热插拔，不承诺运行中任意替换 Docker volume。NFS hard 挂载的内核等待不能靠 JS 超时取消；soft 挂载又存在数据完整性风险，所以采用隔离进程和持久本地缓冲。原先 0.2 版直接迁移 DATA_PATH 到 NAS 的方案已废止。[ADR-0003](../../docs/adr/0003-detachable-nfs-archive.md) 记录依据、Docker/NFS 官方资料及取舍。

## 验证

见 [验证记录](validation.md)。上线验收还需在目标主机完成真实闲鱼来源、磁盘性能、两跳 Nginx 和 NAS 故障测试；截图的 422 不能仅凭状态码认定 CORS，需读取 error.code。旧 HTTP Alibaba 媒体 URL 已补 HTTPS 兼容。
