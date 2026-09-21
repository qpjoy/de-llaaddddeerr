# 容量与吞吐：QPS 100 评估、瓶颈与优化清单

0.7.0，2026-09-13。只讨论性能与容量；安全语义、故障语义、部署步骤见 [README](README.md)，控制面数据库的作用/上限/是否换 PG 见 [控制面](control-plane.md)，验证边界见 [验证记录](validation.md)。

**0.4.0 – 0.7.0 已落地 §5 中标 ✅ 的各项**，本文的"现状"一列已按落地后的行为更新；标 ⬜ 的仍是提案。

数字分三类，请按标记取用：

- `[代码]` 直接来自当前实现的硬编码限制，可在源码核对。
- `[实测]` 在开发机上跑过的微基准，只说明数量级，**不是目标主机数据**。
- `[估算]` 按延迟模型推导，上线前必须在目标主机复测，见 [§7 上线前必须先量的数](#7-上线前必须先量的数)。

**尚未接触真实 NAS、真实生产负载和目标 Linux 主机。本文是设计期容量分析，不是验收报告。**

## 1. 输入参数

| 项 | 值 | 备注 |
| --- | --- | --- |
| 主服务器 | 128 核，约 50 GiB 可用内存 | 本机盘接近写满，需先腾空间 |
| 本机盘剩余 | **待确认** | `save()` 低于 512 MiB 直接 507 |
| 本机盘类型 | **待确认（NVMe / SATA SSD / HDD）** | 决定 SQLite commit 与随机读成本，见 §3 |
| NAS | 48 TB，NFS，4 GiB 内存，非 SSD | 4 GiB 对 48 TB 相当于零元数据缓存 |
| 网络 | 同局域网 192.168.1.2 ↔ 192.168.1.3 | **链路速率待确认**，1 GbE 实测上限约 118 MB/s |
| 容器限额 | writer/reader 各 2 GiB / 2 CPU，archive 256 MiB / 0.5 CPU | `compose.yml`、`compose.nas.yml` |
| 负载形态 | 上游一次返回 10 条记录，每条含图片与视频 | 本文按每条 5 张图 × 200 KB + 1 个视频 × 5 MB ≈ 6 MB 估算 |

## 2. 结论：QPS 100 能不能扛

"QPS 100" 在这套系统里其实是六个互不相干的问题，答案不一样：

| 场景 | 0.4.0 现状 | 卡住的地方 | 再改造后 `[估算]` |
| --- | --- | --- | --- |
| A 读本机盘上的图片 | **能，余量很大** | Node 单进程约 1-3k QPS | 走 §5.1-1 后由 Nginx/磁盘决定，万级 |
| B 读视频（Range 长流） | **能，512 路并发** ✅ | 长流不再占用磁盘读许可 | — |
| C 读只在 NAS 上的冷文件 | **不能，约 12/s** | 归档进程串行 + HDD 随机读 | 并发化后 50-100/s，仍应把命中率压到接近 0 |
| D ingest 已存 URL（去重命中） | **能** | 一次 SQLite 读 + 一次 `stat` | — |
| E ingest 新 URL（真下载落盘） | **约 30-60/s** ✅ | 已流式化、不再整文件缓冲；worker 数仍默认 4、上限 32 | 提并发后 100-200/s |
| E' 整页批量入队 | **能** ✅ | 60 个 URL = 1 次事务、1 次 fsync、1 个请求槽 | — |
| F 新对象同步到 NAS | **不能，约 5-12/s** | 单任务串行 + 写完整文件回读校验 | 40-100/s（图片），视频受链路封顶 |

**一句话**：把 100 QPS 理解为"读"，现在能扛且余量很大；理解为"每秒新增 100 个媒体对象"，仍然扛不住——但真正的墙已经从服务本身移到了 **NAS 归档速率**和**容量**上，而**即使扛住了，48 TB 也撑不到一个月**（§4）。

还有一个前置判断：**这套系统的 100 QPS 成立的唯一前提，是热数据几乎全部命中本机盘。** NAS 是冷归档层，不是读路径。一旦热数据被 evict 到 NAS，读 QPS 立刻掉到 §2-C 那一行。

## 2.5 用 SLO 声明容量，而不是猜许可数 ✅

填 `maxStreams=512` 这种数字，没人知道该填多少、也不知道填错了会怎样。0.5.0 改成**声明这套部署必须扛住什么**，许可数由它推导：

```dotenv
MX_STATIC_SLO_ASSET_QPS=10            # 图片/静态资源，持续每秒读取数
MX_STATIC_SLO_ASSET_P95_MS=200        # 该类的延迟预算
MX_STATIC_SLO_VIDEO_VIEWERS=30        # 同时在看的视频路数
MX_STATIC_SLO_VIDEO_BITRATE_KBPS=3000
MX_STATIC_LINK_MBPS=1000              # 用 iperf3 量
MX_STATIC_DISK_READ_MBPS=500          # 用 fio 量
```

推导用的是 Little 定律：`并发 = 速率 × 延迟`，再乘一个突发系数（默认 4），并设下限。上面这组给出：

| 项 | 值 | 怎么来的 |
| --- | --- | --- |
| `maxAssetStreams` | 16 | 10 QPS × 0.2 s = 2 并发，×4 突发 = 8，下限 16 |
| `maxVideoStreams` | 60 | 30 路观看 × 2（拖动/重连会短暂占两路） |
| `maxReads` | 32 | 两类共用的磁盘短读许可 |
| 带宽预算 | 106.4 Mbps | 视频 30×3 = 90，图片 10×200 KiB×8 = 16.4 |
| 链路占用 | 10.6% | 1 Gbps 的 10.6%，余量充足 |

**声明不可能的目标会被当场指出**，而不是在半夜表现为超时：200 路 × 8 Mbps = 1.6 Gbps 在 1 Gbps 链路上，启动日志给出 `capacity warning: link: the SLO needs 1640 Mbps...`；`MX_STATIC_CAPACITY_STRICT=true` 则直接拒绝启动。

三层保障机制：

1. **分类分池**：图片/静态资源和视频/音频各有独立的传输许可，**视频再多也拿不走图片的名额**。
2. **视频先降级**：平滑后的事件循环延迟超过 `MX_STATIC_MAX_LAG_MS`（默认 250 ms）时，视频类返回 `503 storage_overloaded` + `Retry-After`，**图片类永不因此被拒**。这是"空出跑图片性能"的具体实现。
3. **实时可见**：`GET /static/v1/projects/<p>/capacity`（read token）返回声明、推导出的许可、带宽预算，以及当前各池占用、事件循环延迟、缓存命中率、下载队列深度。

需要绕过推导时，`MX_STATIC_MAX_READS` / `MX_STATIC_MAX_ASSET_STREAMS` / `MX_STATIC_MAX_VIDEO_STREAMS` 仍可显式覆盖。

## 3. 逐层瓶颈

### 3.1 读路径 `GET /static/files/<key>`

单次请求在命中内存以外时会做三件 I/O：读 `metadata/<key>.json`、`stat` 对象文件、读或流式发送对象。

| 层 | 单次延迟 | 100 QPS 的需求 | 判断 |
| --- | --- | --- | --- |
| 进程内存缓存（≤1 MiB、64 MiB、TTL 60 s） | ~0.1 ms | — | 命中即近乎免费 |
| OS page cache | ~0.1 ms | — | 取决于本机剩余内存，目前盘快满、缓存效果未知 |
| 本机 NVMe | 0.1-0.5 ms | 约 300 IOPS | 余量以万倍计 |
| 本机 SATA SSD | 0.2-1 ms | 约 300 IOPS | 余量很大 |
| 本机 HDD | 5-15 ms | 约 300 IOPS | 单盘约 150 IOPS，**直接打穿** |
| NAS（NFS + HDD + 4 GiB 缓存） | 8-20 ms + 网络 | 约 300 IOPS | 打穿；且当前实现不直读 NAS，要先整文件 restore |

带宽侧：100 QPS × 200 KB = 20 MB/s，1 GbE 的 17%，不是问题。100 路 5 MB 视频**同时完整下载**是 500 MB/s，远超 1 GbE —— 但真实播放是 Range 流，按码率算（2 Mbps × 100 路 = 25 MB/s）才合理。

Node 侧的硬限制：

- ✅ **已修**：原先 `reading>=64` 的计数器不区分"200 KB 的一次读"和"3 分钟的视频流"，后者整场播放占一个槽，64 个视频观众就让所有图片请求 503。现在拆成两个许可：磁盘短读 `maxReads`（默认 64），字节传输 `maxStreams`（默认 512），流在响应头发出前领取、在开始传输时归还短读许可。
- `[代码]` `service.mjs:211` 同 key 的缓存填充最多 16 个并发，其余走流式。这个设计是对的。
- ✅ **已修**：原先 `cache-control: private, max-age=0, must-revalidate` 强制每次展示都回源，而对象是内容寻址、永不变更的。现在是 `private, max-age=<N>, immutable`，`N` 取 `MX_STATIC_FILE_MAX_AGE`（默认 900）与**签名剩余有效期**的较小值——浏览器缓存不会比签名活得久，密钥轮换的撤销语义不受影响。**同一页面反复展示同一批图片时，这一行直接决定了读 QPS 的数量级。**
- ✅ **已修**：原先只有 body 在内存缓存里时才复用 metadata，而 >1 MiB 的视频永远进不了 body 缓存，于是浏览器每发一个 Range 请求就重读一次 `metadata/<key>.json`，拖进度条会放大成几十次。现在 manifest 有独立 LRU（默认 8 MiB / 2 万条 / TTL 5 分钟）；manifest 写一次就不再改写，缓存不会失效，对象是否存在仍然每次实检。
- ✅ **已修**：`UV_THREADPOOL_SIZE` 默认 4，所有 `fs` 操作、`createReadStream` 的每个 64 KiB 分片读、以及 `dns.lookup` 共用这 4 个线程，几路视频流就能把线程池占满让 metadata 小读排队。`compose.yml` 现在默认设为 16（`MX_STATIC_THREADPOOL` 可调）。注意只有底层存储有队列深度时才有收益（NVMe 有，单块 HDD 没有）。
- `[代码]` `compose.yml` writer/reader 各 `cpus: 2`、单进程。128 核只用了不到 2 核。

### 3.2 采集路径 `POST /static/v1/projects/<p>/ingest`

按 Little 定律，`并发 = QPS × 单请求耗时`：

| 模式 | 单请求耗时 | 100 QPS 需要的并发 | 对照上限 |
| --- | --- | --- | --- |
| 命中去重 | 1-2 ms | 0.2 | `active` 上限 128，宽裕 |
| 默认同步等待（`waitMs=1000`） | 最多 1000 ms | **100** | `[代码]` `service.mjs:317` `active >= 128` → **ingest 的硬天花板就是约 128 QPS，且所有请求槽被占死** |
| `Prefer: respond-async` | 1-2 ms | 0.2 | 宽裕 |

所以第一条结论很直白：**高 QPS 的调用方必须一律带 `Prefer: respond-async`**，否则 128 这个数字就是上限，而且一旦上游变慢，128 个槽全在 `sleep` 里空耗。

下载侧：

- ⬜ `[代码]` `service.mjs` `maxConcurrency > 32` 仍然直接抛错，默认仍是 4。CDN 图片按 200-500 ms 算，4 个 worker ≈ **11 个/s**；要做到 100 个/s 需要 35-50 并发。流式化之后调大已经安全，但默认值和上限还没动——**这是采集路径剩下的主要限制**。
- ✅ **已修**：原先 `bounded()` 把整个响应 `Buffer.concat` 再同步 `hash(body)`。`[实测]` SHA-256 约 2 GiB/s，64 MiB 文件 ≈ **33 ms**，`Buffer.concat` 64 MiB ≈ **18 ms**，即每个大文件落盘同步阻塞事件循环约 50 ms。现在下载走 [fetch-media.mjs](../src/fetch-media.mjs)：边收边写临时文件、边增量算 SHA-256，**前 12 字节就判定媒体签名**，坏源不会先写满再拒绝；发布时只是一次 `rename`，视频字节从不进入 JS 内存。上传路径仍然缓冲（并发上限 2），但 SHA-256 改成 4 MiB 分块并在块间让出事件循环。
- 内存耦合因此解除：下载 worker 不再按 `workers × maxBytes` 吃内存。**上传**仍受 `uploading(2) × maxBytes` 约束。
- `[代码]` `service.mjs:112-126` 图片和视频共用同一个 worker 池。一个 60 MB 的视频在 2 MB/s 下要占 30 秒。**4 个视频就能让图片采集完全停摆**，而上游"每条记录都带视频"正好是这个形状。
- ⬜ `[代码]` 同步等待仍用 50 ms 轮询，每次轮询是一次**同步阻塞**的 SQLite 查询。100 个等待者 = 2000 次/s 阻塞查询。（单次查询成本已经减半，见 [控制面 §3](control-plane.md)。）
- `[代码]` 每个 ingest 至少 3 次 `synchronous=FULL` 提交（`jobs.enqueue`、`archive.register`、`jobs.complete`），`node:sqlite` 的 `DatabaseSync` 是同步 API，**每次 fsync 都直接阻塞事件循环**。批量入队把其中的 `enqueue` 从每 URL 一次压成每页一次。成本完全取决于本机盘：数据中心级 NVMe（带掉电保护）约 0.05 ms，消费级 NVMe 0.5-2 ms，HDD 5-15 ms。按 2 ms 算，100 个/s × 3 = **600 ms/s，事件循环 60% 被占住**。开发机 `[实测]` 的 0.13 ms/commit 不能引用 —— macOS 的 `fsync()` 不下刷盘缓存，数字没有可比性。
- 另外：落盘还有 4 次异步 fsync（对象文件 + 其目录、metadata 文件 + 其目录），走的是那 4 个线程池线程。

**针对用户实际负载的关键观察**：上游一次返回 10 条记录、每条 6 个媒体 = **60 个 URL**。原先只能一个 URL 一个 POST，于是一次上游调用产生 60 次 HTTP、60 个事务、60 次 fsync、占 60 个 `active` 槽。✅ `POST .../ingest/batch` 已落地：**一次 HTTP、一次事务、一次 fsync、一个请求槽**，批内重复 URL 与已在途任务都自动合并，单条失败不影响整批。

### 3.3 归档到 NAS

小文件写 NFS 是**延迟受限，不是带宽受限**。每个对象的落盘序列大致是：目录 lookup/mkdir → 创建 temp → 写数据 → COMMIT → **回读整个文件做校验** → rename → 目录 fsync；metadata 文件再来一遍。保守估每个对象 8-10 次需要服务端确认的往返。

HDD NAS 的 commit 延迟按 5-15 ms 估：

| 对象 | 每对象耗时 `[估算]` | 串行吞吐 | 实际占用链路 |
| --- | --- | --- | --- |
| 200 KB 图片 | 约 80 ms（几乎全是往返延迟） | **约 12 个/s** | 写 2.4 MB/s + 回读 2.4 MB/s，1 GbE 用了 4% |
| 5 MB 视频 | 约 180 ms（延迟 80 ms + 传输 100 ms） | **约 5.5 个/s** | 约 55 MB/s，开始贴近 1 GbE |

两个直接推论：

1. **图片归档纯粹被"一次只跑一个任务"卡死**，链路 96% 空着。把并发提到 4-8 就是 4-8 倍。
2. `[代码]` `archive-io.mjs:37` 写完再 `verifyFile(temp)` 整文件回读，**NFS 流量翻倍**。`copyVerified` 在写入过程中已经用 Transform 流算过一次 SHA-256 了，这次回读防的是 NAS 端的静默损坏。关掉或抽样，图片和视频的归档吞吐都直接翻倍。

`[代码]` `archive-worker.mjs` "最多一个子进程"的设计目的是防 NFS D 状态僵尸进程堆积，这个不变量必须保留。可行的折中是：**仍然只起一个子进程，但让这个子进程内部并发处理一批任务**；看门狗照旧按空闲超时 SIGKILL 整个子进程。安全性不变，吞吐 ×N。

### 3.4 NAS 自身（48 TB / 4 GiB / NFS）

- 4 GiB 内存对 48 TB 是 0.008%。**元数据缓存基本不存在**，每次 lookup 都落盘。
- 如果是 ZFS：**绝对不要开 dedup**（4 GiB 内存 + 48 TB 必崩）；ARC 小到可以忽略，建议单独给一块 SSD 做 special vdev 或 L2ARC 存元数据，收益远大于加内存。
- `[代码]` 目录布局 `<project>/YYYY/MM/DD/<uuid>`。按 100 个/s 算，**单个目录一天 864 万个文件**。在 4 GiB 内存的 NAS 上，这个目录的每次 lookup 都是磁盘随机读。建议改成 `<project>/YYYY/MM/DD/<HH>/<uuid 前两位>/<uuid>`，每个叶目录约 1400 个文件。
  **现在改零成本（尚未上线、尚无数据），有数据之后改极其痛苦。** 涉及 `service.mjs:152` 的 key 生成、`service.mjs:246` 与 `archive-io.mjs:50` 的 key 正则。
- NFS 挂载参数是廉价的高杠杆项，见 §5.3。
- NAS 端 `nfsd` 线程数默认常见为 8。归档并发提到 8 以上时需要同步调高。

## 4. 容量规划：48 TB 能用多久

按每条记录 ≈ 6 MB、每次上游调用 10 条 ≈ 60 MB 计：

| 上游调用频率 | 新增媒体 | 日增量 | 48 TB 用满 |
| --- | --- | --- | --- |
| 1 次/分钟 | 1 个/s | 86 GB | 约 1.5 年 |
| 1 次/10 秒 | 6 个/s | 518 GB | 约 93 天 |
| 1 次/秒 | 60 个/s | 5.2 TB | **约 9 天** |
| 10 次/秒（=100 条/s） | 600 个/s | 52 TB | **不到 1 天** |
| 纯图片 100 个/s（无视频） | 100 个/s | 1.7 TB | 约 28 天 |

**这是本文最重要的一张表。** "每秒新增 100 个媒体对象"在存储上根本不是一个可持续的目标 —— 48 TB 是 1 到 28 天的量。所以：

- 真正的容量约束是**上游调用频率**，不是服务的 QPS 能力。先把这个数确定下来。
- 按 1.5 年规划，上游调用应控制在约 1 次/分钟量级；要更高频，就必须有**明确的保留期策略**（比如视频只留 90 天、图片留全量），而当前实现**不做任何自动清理**，全靠人工。
- 视频占了这个负载 83% 的字节。如果业务允许"视频只存链接、按需回源"或"转码降码率后存档"，容量压力立刻小一个数量级。这是产品决策，但技术上收益最大。

## 5. 优化清单

按"对 100 QPS 的影响"排序。每项给出：问题 → 改法 → 预期收益 → 风险 → 代码位置。

### 5.1 P0 · 读路径

**✅ 1. Nginx `X-Accel-Redirect`：把字节搬出 Node**（0.7.0）
设 `MX_STATIC_ACCEL_REDIRECT=/internal-objects` 后，本服务只做鉴权、读 manifest、判断对象是否在本机，然后返回 `X-Accel-Redirect` 头；字节由 `deploy/internal-locations.conf` 里的 `internal` location 用 `sendfile` 直发，Range 与条件请求也归 Nginx。**Node 完全离开字节路径**：不占传输许可、不做内存拷贝、不占线程池。内存命中仍由本服务直接返回（比多一跳更快）。
冷文件不会被丢给 Nginx 去 404——本服务在下发重定向之前就走完了 `stat` 和恢复判断。
同一份配置还补上了 `upstream ... keepalive`（原先 `proxy_pass` 直连地址，keepalive 根本不生效，每请求新建 TCP）以及 `open_file_cache`、`aio threads`。
**未在本机用 Nginx 端到端验证过**（开发机没装 Nginx，配置也没做 `nginx -t`）：只验证了本服务发出的头契约和冷文件回落。

**✅ 2. 不可变对象用长缓存头**（0.4.0）
`private, max-age=<N>, immutable`，`N = min(MX_STATIC_FILE_MAX_AGE 默认 900, 签名剩余秒数)`。`private` 保留（令牌/签名是能力凭证，不能进共享缓存），浏览器缓存不会比签名活得久。
收益：**整份清单里最便宜、收益最高的一条** —— 同一页面重复展示不再回源，读 QPS 直接掉一个数量级。

**✅ 3. 读并发计数区分短读与长流**（0.4.0）
当前一个视频流从建立到传完都占着 64 个槽之一。拆成两个计数器：短读（metadata/小文件）限 64，长流限一个大得多的数（或做 5.1-1 后直接取消）。
位置：`service.mjs:250`、`service.mjs:345` 的 `finally`。

**✅ 4. metadata 独立缓存**（0.4.0）
独立 LRU，默认 8 MiB / 2 万条 / TTL 5 分钟。消灭"每个 Range 请求重读一次 JSON"。manifest 写一次就不再改写，所以缓存不会失效；对象是否仍在本机盘依然每次实检，冷文件恢复语义不变。

**✅ 5. `UV_THREADPOOL_SIZE`**（0.4.0）
`compose.yml` 默认 16，用 `MX_STATIC_THREADPOOL` 调整（128 核 + NVMe 可以到 64）。只有底层存储有队列深度时才有收益。

### 5.2 P0 · 采集路径

**✅ 6. 批量入队接口**（0.4.0）
`POST /static/v1/projects/<p>/ingest/batch`，单批上限 `MX_STATIC_MAX_BATCH`（默认 200），在**同一个事务**里入队，逐条返回状态，单条失败不影响整批。批内重复 URL 与已在途的单条任务都合并到同一个 job。
收益：**针对"上游一次返回 10 条、每条带图带视频"最对症的一条**。60 次 HTTP → 1 次，60 次 fsync → 1 次，60 个 `active` 槽 → 1 个。等价于把 600 QPS 的 ingest 压成 10 QPS。
批量接口永远异步返回——不占请求槽正是它的目的。客户端辅助见 [client.mjs](../src/client.mjs) 的 `archiveBatch`。

**✅ 7. 流式下载 + 增量哈希**（0.4.0）
下载落到对象文件系统上的 `<DATA_PATH>/.staging`，边写边增量算 SHA-256，**前 12 字节就判定媒体签名**，坏源不会先写满再拒绝；发布时只是一次 `rename`，视频字节从不进入 JS 内存。声明的和实际的长度都受 `maxBytes` 约束。崩溃残留的 `.part` 文件在启动时清理（发布前的临时文件不被任何东西引用）。
收益：消除每个大文件约 50 ms 的事件循环阻塞 `[实测]`；解除 `workers × 64 MiB` 的内存耦合，`MX_STATIC_WORKERS` 才可能安全调大；顺带让视频的 64 MiB 上限有条件放宽。
新增 [fetch-media.mjs](../src/fetch-media.mjs)、[net-guard.mjs](../src/net-guard.mjs)、[media-types.mjs](../src/media-types.mjs)。**这三个模块替代了原先从 mx-insight-hub 引入的 SSRF/图片校验代码，是新写的，上线前应与 Hub 原模块对照评审。**

**✅ 8. 图片 / 视频分池**（0.6.0）
两个独立的下载池，默认图片 24、视频 6（`MX_STATIC_IMAGE_WORKERS` / `MX_STATIC_VIDEO_WORKERS`），任务按 URL 扩展名分类，调用方也可以在 ingest 里显式传 `kind: "image" | "video"`。音频跟视频同池——同样是长传输。队列里全是视频也拿不走图片的 worker。

**✅ 9. 下载并发上限解除**（0.6.0）
硬编码的 32 上限已移除（流式化之后放开是安全的），默认从 4 提到 24 + 6。上限由 §5.4-17 的实时指标和事件循环延迟约束，而不是一个写死的数字。

**✅ 10. 同步等待改事件通知**（0.6.0）
writer 自己掌握任务生命周期，`complete`/`fail` 时直接唤醒等待者。原先每个等待者每 50 ms 做一次**同步阻塞**的 SQLite 查询（100 个等待者 = 2000 次/s）；现在每个任务一次唤醒，外加 250 ms 的兜底轮询（用于被恢复租约完成的任务）。

**⬜ 11. 调用方一律 `Prefer: respond-async`**
这是配置约定不是代码改动，但是**不做这条，单条 ingest 的天花板就是 128 QPS**。批量接口（第 6 条）本身就是异步的，不受此限；仍在用单条接口的调用方应写进接入说明并在压测里验证。

### 5.3 P1 · 归档与 NAS

**✅ 12. 归档并发化（保留单子进程不变量）**（0.5.0）
`claimMany()` 一次领一批（每行仍有各自的 owner，租约围栏不变），单个子进程内部按 `MX_STATIC_NAS_CONCURRENCY`（默认 4）并发跑，**看门狗照旧按空闲超时 SIGKILL 整个子进程——"最多一个子进程"这个防 D 状态僵尸的不变量没有改动**。
逐任务通过 IPC 回报结果：**一个坏对象不再拖住或重跑整批**，它按自己的指数退避重排队，后端健康保持 online。子进程没有回报过的任务一律重排队——干净退出不等于某个对象写成功了。长批次靠进度消息续租（默认每 20 秒），所以恢复时间仍是约 60 秒，不被拉长。
`archive` 容器 `mem_limit` 相应提到 512m。用 `scripts/nas-bench.mjs` 在真实 NAS 上量出该设多少。

**✅ 13. 回读校验可配置**（0.5.0）
`MX_STATIC_NAS_VERIFY=always|sample|never`（默认 `always`）。`sample` 按对象 SHA 前缀确定性地抽 1/16——**同一个对象每次判定一致，不是每次重试随机**。
收益：NFS 流量减半，带宽受限的场景吞吐翻倍。写出去的字节在流式复制时已经逐字节哈希过，回读校验防的是 NAS 端落盘后的损坏。
**`evict` 永远完整校验，不受此配置影响**——那是唯一会删掉另一份副本的操作，不能基于未经验证的状态执行。NAS 是 ZFS/Btrfs（自带校验和）时 `sample` 是合理默认。

**⬜ 14. NFS 挂载参数**（仍需在目标主机执行）
`vers=4.2,nconnect=8,rsize=1048576,wsize=1048576,hard,timeo=600,retrans=2,noatime,nodiratime`
`nconnect` 开多条 TCP 连接，在"小文件、延迟受限"这个场景收益最大（Linux 5.3+）。`hard` 必须保留 —— `soft` 有静默数据损坏风险，不要为了吞吐换它。另外确认链路速率，两端支持的话开 MTU 9000。

**✅ 15. 目录分片**（0.6.0）
新 key 是 `<project>/YYYY/MM/DD/<HH>/<id 前两位>/<uuid>`（[keys.mjs](../src/keys.mjs)）。按 100 个/s 算，原先单目录一天 864 万文件，现在每个叶目录约 1400 个。读取同时接受旧的仅按日期的形状，写入只产生分片形式。

**✅ 16. reader 侧 restore 去重**（0.4.0，默认 5 秒窗口，`restoreDebounceMs` 可调）
`[代码]` `service.mjs:163-172`：reader 每遇到一个冷文件就 POST 一次 writer 的 `/storage/restore`，而这是 writer 上的一次同步 SQLite 写。100 QPS 冷读 = 100 次/s 阻塞写打在 writer 上，而归档只能恢复约 12 个/s —— 队列无限增长、客户端每 2 秒重试，形成死循环。
已改：reader 侧按 key 记上次请求时间，窗口内不重复发；表超过 1 万条整体清空。

### 5.4 P1 · 可观测性与冷热判定

**✅ 17. 实时容量与占用可见**（0.6.0，部分）
`GET /static/v1/projects/<p>/capacity` 返回声明、推导出的许可、带宽预算，以及事件循环延迟、各池实时占用、两个下载池的在途数、缓存与 manifest 命中率。设置控制台把这些画成实时仪表。
**仍缺**：读写延迟分位数（p50/p95/p99）、归档积压字节数、本机剩余空间，以及 Prometheus 格式导出。

**✅ 18. 冷热判定**（0.7.0）
`objects` 表加了 `last_read` 列和索引。读路径只写内存，定时器批量折叠成一次事务；只读副本通过 `POST .../storage/touch` 汇报，**访问统计不出现在任何一次读取的关键路径上**。
`GET .../storage?coldFor=<毫秒>` 返回 `coldest`：已归档、仍在本机、且超过该时长未被读取的对象，按最后读取时间排序——这正是 evict 该瞄准的集合。
**仍未做**：自动 evict。释放本机副本依然要按业务保留策略显式调用，系统只负责告诉你哪些是冷的。

### 5.5 P2

- **多 reader 实例**：reader 无状态且只读，Nginx `upstream` 轮询 4-8 个实例即可线性扩展（做了 5.1-1 之后未必需要）。
- **Nginx upstream keepalive**：`deploy/internal-locations.conf` 直接 `proxy_pass http://127.0.0.1:18201`，**没有 `upstream` 块，keepalive 不生效**，每个请求新建一次 TCP。改成 `upstream mx_static_reader { server 127.0.0.1:18201; keepalive 64; }`。
- **Nginx 文件层调优**：`open_file_cache max=200000 inactive=5m;`、`sendfile on; tcp_nopush on;`、大文件 `aio threads;`。
- **边缘层少一跳**：edge 的 `location ^~ /static/` 把文件字节也转给 internal 再转 reader，两跳。`/static/files/` 可以在边缘直连 reader。
- **⬜ `archive.sqlite` 降到 `synchronous=NORMAL`**：它是可重建的镜像状态（`jobs.sqlite` 必须保持 `FULL`，那是"已持久接收"的承诺）。WAL + NORMAL 只在掉电时可能丢最近几条提交，不会损坏；代价是需要一份"重扫本机与 NAS 重建 catalog"的运维流程。**收益中等、风险要人工兜底，排在最后。**

### 5.55 内容去重与引用计数 ✅（0.7.0）

这条不在原清单里，是对"48 TB 撑不了多久"（§4）最直接的一条：

- **相同字节只存一份。** 落盘前按 SHA-256 查已有内容，命中就对同一 inode 再建一个硬链接。跨 project、跨 scope 生效，对调用方不可见（每个引用仍有自己的 key 和鉴权边界）。
- **物理引用计数交给文件系统。** `DELETE .../objects/<key>` 只解除该 key 自己的链接；**字节到最后一个引用被删除时才释放**，响应里报告还剩几个引用。
- **NAS 侧同样去重**：同内容的第二个 key 在 NAS 上是一次 LINK 而不是重新传输。归档是全系统吞吐瓶颈，**这一条对重复率高的负载收益最大**。同一批任务里的相同内容也只传一次。
- 删除已归档的 key 会排队清除它自己的远端路径，孪生 key 不受影响。

省下多少完全取决于真实重复率。`GET .../storage` 的 `content.savedBytes` 给出实际数字——**上线后先看这个数，再决定 §4 的容量规划要不要重算**。

**已知边界**：两个内容相同的下载同时完成时各写一份（谁都还没登记），结果正确但没省空间；当前没有后台合并任务。

### 5.56 延迟分位数 ✅（0.7.0）

`/capacity` 的 `live.latencyMs` 按 图片 / 视频 / 采集 三类给出 p50/p95/p99/max（各保留最近 1024 个样本）。这是把 `MX_STATIC_SLO_ASSET_P95_MS` 这个**声明**和**实测**放在一起看的唯一办法。仍未做 Prometheus 格式导出。

### 5.6 配置与运维 ✅（0.6.0）

- **坏配置不再影响启动**：每个可调项都有 schema（类型、范围、默认值）。畸形值降级到默认值并记为 warning，启动日志和 `/capacity` 都能看到。只有凭据缺失才是致命的。`compose.nas.yml` 里原先的 `${...:?}` 强制变量也去掉了——没配 NAS 不再让整个 compose 渲染失败。
- **一条命令部署**：`bash scripts/manage.sh deploy` 建目录、幂等生成凭据（已存在绝不覆盖）、构建、跑控制面迁移、启动、等健康、清理被取代的构建产物，最后打印实时容量。另有 `status` / `logs` / `migrate` / `attach` / `detach` / `storage` / `console` / `doctor` / `prune`。
- **设置控制台**：`/static/admin`（需要 admin token，未配置则整个入口 404）。按 服务 / 容量 / 采集 / 缓存 / NAS 归档 分组，其余收进「Advanced」折叠区。标记为可热改的设置**立即生效、无需重启**，存在 `settings.sqlite`，另一个容器通过轮询在几秒内跟上；不可热改的显示为「restart required」并说明要在 `.env` 里改。
- **设置存储不可用时降级**：只读副本可能在 writer 建好 WAL 文件之前就去读设置库，而只读挂载上 SQLite 无法自己创建这些文件。读取失败一律降级为"只用 .env"，并在后续轮询中自愈——不再让 reader 启动即崩溃。

### 5.7 控制面（SQLite）

0.4.0 顺带修掉两处会随数据量恶化的问题，详见 [控制面](control-plane.md)：

- ✅ **`GET /storage` 的汇总查询**原先是全表扫 + 每行一次 `json_extract`，`[实测]` 200 万行 **6.0 秒的同步事件循环停顿**。加覆盖索引 + `size` 实列后 **178 ms**（33×）。200 万对象只相当于约 600 GB 媒体，这个量级很快会到。
- ✅ **每次查询都重新编译 SQL**：29 处调用点改为缓存 prepared statement，`[实测]` 点查 14.7 µs → 7.2 µs。这些查询全是同步阻塞的，省下的都是事件循环时间。

"要不要换 PostgreSQL"的完整分析在 [控制面 §4](control-plane.md#4-要不要换-postgresql)：**现在不要**，三个触发条件都不成立。

### 5.8 明确不做

| 方案 | 不做的原因 |
| --- | --- |
| `DATA_PATH` / `STATE_PATH` 迁到 NAS | README 已述；0.2 方案已废止 |
| NFS `soft` 挂载换吞吐 | 静默数据损坏风险 |
| ZFS dedup | 4 GiB 内存 + 48 TB，必崩 |
| 把小文件打包成 pack 文件减少 NFS 开销 | 收益确实大，但会破坏 key ↔ 文件一一对应，evict/restore/校验逻辑全部要重做。除非确认要处理千万级小文件并愿意重写恢复层，否则不值得 |
| 靠加 NAS 内存解决元数据缓存 | 4 GiB → 16 GiB 对 48 TB 仍是杯水车薪；同样的钱做 SSD 元数据 vdev 收益高得多 |

## 6. 存量 docker volume 数据的迁移

用户的现状是：本机盘快满，主要是 docker volume 里的历史多媒体；新文件先走 mx-static，存量慢慢迁。

推荐路径是**把存量当成一次离线导入，然后复用已有的 sync → 校验 → evict 机制**：

1. 离线导入工具扫描 volume，逐个文件算 SHA-256，写入 `objects/` 与 `metadata/`，向 archive catalog `register`（`local=1, mirrored=0`），产出一张 **旧路径 → 新 key 的映射表**供业务侧改引用。
2. 归档 worker 自然把它们同步到 NAS。
3. 校验通过后 `evict` 释放本机空间。

这条路不引入新机制，但有一个必须提前算的数 —— **存量迁移本身就被 §3.3 的串行归档卡住**：

按当前待归档的 **2 TB** 估算 `[估算]`（1 GbE、NFS 延迟按 §3.3 的模型，**必须用 `scripts/nas-bench.mjs` 在真实 NAS 上复核**）：

| 2 TB 的构成 | 文件数 | 串行（0.4.0 及以前） | 并发 8（0.5.0） | 并发 8 + `verify=never` |
| --- | --- | --- | --- | --- |
| 全是 200 KB 图片 | 约 1000 万 | 约 **10 天**（延迟受限） | 约 **1.7 天** | 约 1.7 天（仍是延迟受限，校验不是瓶颈） |
| 平均 2 MB 混合 | 约 100 万 | 约 **1.4 天** | 约 **10 小时**（链路受限） | 约 **5 小时** |

**2 TB 从"按天算"变成"按小时到一两天算"。** 注意两类工作负载的瓶颈不同：小文件是延迟受限，并发帮助最大而关校验没用；大文件是链路受限，关掉回读校验直接省一半流量。所以 `nas-bench.mjs` 同时按尺寸和 verify 模式出表。

另外两点：

- 导入期间本机盘会短暂同时存在"原 volume 副本 + mx-static 副本"。盘已经快满，**必须分批做：导入一批 → 归档 → evict → 删原文件 → 下一批**，不能一次性全导。
- 不要为了省事把整个存量目录 rsync 到 NAS 再用 Nginx 挂个只读 location 指过去 —— 那等于让主服务直读 NFS，违反整个架构的核心隔离原则，而且 HDD 随机读会让读延迟彻底失控。

## 7. 上线前必须先量的数

本文所有 `[估算]` 都建立在假设的盘和链路上。下面几条跑完，大部分数字就能换成实测：

```sh
# 1. 链路速率（决定视频归档与迁移的天花板）
iperf3 -c 192.168.1.3 -t 30
iperf3 -c 192.168.1.3 -t 30 -P 8   # 多流，对照 nconnect 的收益

# 2. 本机盘 fsync 成本 → 直接决定 SQLite commit 成本（§3.2）
fio --name=fsync --filename=/srv/mx-static/state/fio.tmp --rw=write \
    --bs=4k --size=256M --fdatasync=1 --runtime=30 --time_based --group_reporting

# 3. 本机盘随机读 → 决定读路径能不能真的到 100 QPS（§3.1）
fio --name=randread --directory=/srv/mx-static/data --rw=randread \
    --bs=256k --size=4G --iodepth=32 --numjobs=4 --runtime=30 --time_based --group_reporting

# 4. NAS 小文件写延迟，串行 vs 并发 → 验证 §5.3-12 的收益
fio --name=nfs1 --directory=/mnt/nas/mx-static --rw=write --bs=256k \
    --size=4M --numjobs=1 --fsync=1 --runtime=30 --time_based --group_reporting
fio --name=nfs8 --directory=/mnt/nas/mx-static --rw=write --bs=256k \
    --size=4M --numjobs=8 --fsync=1 --runtime=30 --time_based --group_reporting

# 5. 读 QPS 实测（用真实大小的图片，不要用 68 字节的 PNG）
oha -c 100 -z 60s "$STATIC_URL/static/files/$KEY?expires=...&signature=..."

# 6. NFS 侧计数器
nfsstat -c ; mountstats /mnt/nas/mx-static

# 7. 归档并发与校验模式的实测，直接给出 MX_STATIC_NAS_CONCURRENCY 建议值
#    只在确认过卷标记的 NAS 上写自己的临时子目录，结束后删除
node scripts/nas-bench.mjs --nas=/mnt/nas/mx-static --volume-id=mx-static-nas-01 \
  --sizes=200k,5m --concurrency=1,2,4,8,16 --count=128 --verify=always,never
```

量完之后把 `MX_STATIC_LINK_MBPS`、`MX_STATIC_DISK_READ_MBPS` 填进 `.env`，容量推导和可行性校验才是基于实测而不是默认值。

`[实测]` `validation.md` 里"100 并发、p50 155 ms / p95 197 ms"那组数据是 **68 字节 PNG + macOS Docker 文件共享**，只证明并发路径正确，不能用于容量判断。目标主机上必须用真实尺寸的图片和视频重做。

## 8. 与 README 的关系

README 描述的是**当前实现的行为与边界**；本文描述的是**这些行为在目标负载下的代价，以及改动清单**。两者不一致时以 README 为准 —— 本文列出的优化除非明确标注已落地，否则都还是提案。
