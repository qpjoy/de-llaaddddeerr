# 验证记录

## 2026-09-21：归并至 mx-base/mx-static

- 对比 Git blob：mx-base 原来的 25 个受版本控制文件与 knock-nas `6063eb4` 全部一致。本次来源为 knock-nas `fdc2f16`，并适配父级统一入口；详见 [来源与部署决策](deployment-decision.md)。
- Node **24.21.0**：`node --test mx-static/tests/*.test.mjs tests/*.test.mjs`，**73 passed，0 failed**（72 项应用测试 + 1 项父级管理入口测试）。新增旧版 jobs/archive schema 升级测试，验证任务、租约、媒体大小/哈希、NAS 卷身份及冷文件标记保留，重复运行不丢记录。
- `python3 -m unittest discover -s tests -p 'test_*.py'`：**21 passed**，覆盖原有 mx-base 管理/GPU 生命周期回归，使用模拟环境，没有触碰真实 GPU 或容器。
- Bash 语法、基础/NAS Compose 配置检查通过；显式设置 `MX_STATIC_ACCEL_REDIRECT=/internal-objects` 后，渲染配置确认 writer/reader 均收到该值。默认仍关闭。
- Nginx upstream 与 location 已拆为正确的配置上下文，对象路径关闭打开文件描述符缓存以免延迟回收 evict 后的 SSD 占用。但工作站没有 Nginx，Docker daemon 未运行，**未运行 nginx -t、镜像/Compose smoke 或真实数据路径压测**。
- 只移植源码；未部署、未替换在线容器、未迁移生产数据库或媒体、未更改服务器 NFS/systemd。

## 2026-09-21：NAS 迁移规划与管理脚本

- 使用官方校验和验证过的 Node **24.21.0**，`node --test tests/*.test.mjs`：**70 passed，0 failed**。包括原有 66 项和新增 4 项管理脚本回归；测试仅使用临时文件/本机 HTTP，不是目标 Linux/NAS 验收。
- 新增回归确认：配置了不可用 NAS 时 status/doctor 不探测远端目录；清除 NAS 配置后 storage/detach 仍可运行；核心部署不删除 archive 或全局构建缓存；未挂载 NAS 时 attach 在变更控制队列/容器前失败。Docker 命令使用记录型替身，不能代替真实 Docker 的挂载测试。
- `bash -n scripts/manage.sh scripts/storage-audit.sh`、基础 Compose 与 NAS profile 的 `docker compose config --quiet`、`git diff --check`：通过。`.gitignore` 验证凭据/状态/报告被排除，`.env.example` 与源码仍保留。
- 本次工作站 Docker daemon 未运行，**未复跑镜像构建和两个 Compose smoke**；下方 2026-09-13 的历史结果不是本次运行结果。
- **尚未收到目标服务器/NAS 的现场输出**，未变更 fstab、systemd、生产容器或数据，未实际迁移/删除任何媒体。真实 NFS 挂载、权限、重挂载、开机顺序和吞吐仍需现场验证。步骤见 [存储迁移方案](storage-migration.md)。

# 0.7.0 历史验证记录（2026-09-13）

## 结果

- `node --test tests/*.test.mjs`：**66 passed，0 failed**（连跑 8 次无偶发）。新增 7 条去重/引用计数/删除/冷热，1 条 X-Accel-Redirect 契约，1 条延迟分位数。
- `docker build -t mx-static:0.7.0 .`：通过。
- `node scripts/smoke-compose.mjs`、`node scripts/smoke-nas-compose.mjs`：均 PASS。

## 这轮回答的问题

用户问：系统是否校验相同文件不存第二次、是否都是副本、删除是否只删副本、删到最后一个才真正删除（云盘模型）。

**0.6.0 之前不是。** 去重按 `(scope, URL)`，不是按内容：同样的字节来自两个不同 URL 就是两份；`sha256` 只用于 ETag 和归档校验，没有索引也没参与去重；**完全没有删除接口**。

0.7.0 实现了该模型：

- 落盘前按 SHA-256 查已持有的内容，命中就对同一 inode 再建硬链接。**实测**：同一份字节上传三次（其中一次在另一个 project），三个 key、同一个 inode、`nlink=3`，`storage.content.savedBytes` 等于重复的字节数。
- `DELETE .../objects/<key>` 解除一个引用。**实测**：删掉第一个后第二个仍能读出原字节且 `nlink` 降为 1，响应 `references:1, contentRemoved:false`；删掉最后一个后文件从磁盘消失，响应 `references:0, contentRemoved:true`。
- NAS 侧同样去重。**实测**：两个同内容的 key 在 NAS 上是同一个 inode（`nlink=2`），第二个没有重新传输。删除其中一个只清除它自己的远端路径，孪生路径的字节完好。
- 去重跨 project 生效但对调用方不可见：每个引用仍是独立的 key、metadata 和鉴权边界。read token 不能删除，跨 project 删除返回 404。

**已知边界**：两个内容相同的下载同时完成时，谁都还没登记，于是各写一份——结果正确但没省空间，当前没有后台合并任务。省下多少完全取决于真实重复率，上线后看 `storage.content.savedBytes`。

## 其余落地项

- **X-Accel-Redirect**：本服务只鉴权并返回重定向头，字节由 Nginx `sendfile` 直发，Range 和条件请求归 Nginx。冷文件不会被丢给 Nginx 去 404——重定向之前就走完了恢复判断。内存命中仍由本服务直接返回。
- **Nginx 配置**：补上 `upstream ... keepalive`（原先 `proxy_pass` 直连地址，keepalive 根本不生效，每请求新建 TCP）、`open_file_cache`、`aio threads`、`internal` 的对象 location。
- **冷热判定**：`objects` 表加 `last_read` 列与索引。读路径只写内存，定时器批量折叠成一次事务；只读副本通过 `POST .../storage/touch` 汇报。`GET .../storage?coldFor=<毫秒>` 返回按最后读取时间排序的 `coldest`。**实测**：读过的对象访问时间前移，未读的排在 `coldest` 首位。
- **延迟分位数**：`/capacity` 的 `live.latencyMs` 按 图片 / 视频 / 采集 三类给出 p50/p95/p99/max，各保留最近 1024 个样本。

## 一个批内去重的真限制

同一批归档任务里的两个同内容对象，在领取时都还没镜像，互相都找不到 twin，于是各传一次。测试直接暴露了这一点（两个 NAS inode 不同）。已改为：子进程按内容哈希分组，同哈希的第一个先落地，其余再链接到它。

## 三处旧测试假设失效

都是**新行为正确、旧断言过期**，不是回归：

1. 同一个 PNG 上传 6 次现在是同一个 inode，"改坏其中一个对象"会改坏全部——测试改为每次上传唯一字节。
2. "磁盘满返回 507"因为去重跳过了空间检查而变成 201。判断是：**空闲底线对每一次写入都成立**，只有真正新增的对象才额外按自身大小检查。已按此实现，测试恢复。
3. 若干断言把 NAS 上的字节和裸 `png` 比较，而上传已带唯一后缀——改为与实际上传的字节比较。

## 仍未验证

**Nginx 的 X-Accel-Redirect 没有端到端跑过**：开发机没装 Nginx，`deploy/internal-locations.conf` 连 `nginx -t` 都没做。只验证了本服务发出的头契约和冷文件回落。**目标主机上必须先 `nginx -t`，再实测一次重定向读取和一次 Range 请求。**

**没有接触真实 48 TB NAS，没有真实 NFS 断网/重挂载/宿主重启演练，没有真实上游 CDN 负载，没有在目标 Linux 主机上跑过，没有做过任何真实并发压测。** 去重的实际收益取决于真实重复率，本机测试只证明机制正确。

硬链接要求对象树在**同一个文件系统**上。跨设备时 `link()` 返回 EXDEV，代码会退回写第二份副本——正确但不省空间。目标主机上应确认 `DATA_PATH` 是单一挂载点。

[容量与吞吐 §5](capacity.md#5-优化清单) 仍标 ⬜ 的：NFS 挂载参数（需在目标主机执行）、自动 evict、Prometheus 导出、边缘层少一跳、多 reader 实例、`archive.sqlite` 降 `synchronous`。

## 复跑

```sh
node --test tests/*.test.mjs
bash scripts/manage.sh deploy
node scripts/smoke-compose.mjs
node scripts/smoke-nas-compose.mjs
nginx -t -c <你的配置>        # 目标主机，套用 deploy/internal-locations.conf 之后
```

---

## 0.6.0 验证记录（2026-09-13）

## 结果

- `node --test tests/*.test.mjs`：**57 passed，0 failed**（连跑 8 次无偶发）。新增 7 条配置/设置/分池、2 条 key 分片、1 条事件唤醒、1 条内存突发不被误拒、2 条设置存储降级。
- `docker build -t mx-static:0.6.0 .`：通过。
- `node scripts/smoke-compose.mjs`：连跑 5 次全 PASS。
- `node scripts/smoke-nas-compose.mjs`：PASS。
- `bash scripts/manage.sh deploy`：在隔离沙箱中完整跑通两次，**第二次不重新生成任何凭据**，凭据权限 `0440`。
- 设置控制台：用浏览器实测登录、改值、保存。改「并发观看数」30 → 80 后，视频许可 `0/60` → `0/160`、带宽预算 106.4 → 256.4 Mbps、链路占用 11% → 26%，提示 "Applied without a restart"。**改动传播到了只读的 reader 容器，并在 writer 重启后仍然生效。**

## 坏配置不影响启动（实测）

部署时故意注入 `MX_STATIC_SLO_ASSET_QPS=abc`、`MX_STATIC_SLO_VIDEO_VIEWERS=nonsense`、`MX_STATIC_NAS_VERIFY=bogus`、`MX_STATIC_CACHE_BYTES=-1`：容器正常启动并健康，每一项都降级为默认值并在 `status` 输出里列出原因。`compose.nas.yml` 里原先的 `${...:?}` 强制变量已移除，没有 NAS 配置时 `docker compose config` 也能通过。

## 三个被测试和演练逼出来的真缺陷

1. **reader 启动即崩溃**（`Error: unable to open database file`）。只读副本可能在 writer 建好 WAL 文件之前就去读设置库，而只读挂载上 SQLite 无法自己创建这些文件；我只把构造函数包进了 try，没包住第一次 `read()`。已改为：`Settings.read()` / `revision()` 永不抛错，失败时降级为"只用 .env"并在后续轮询中自愈；writer 建库时额外取一次写锁，确保 WAL/shm 文件先存在。**这正是本轮要消除的那类问题，是容器演练而非单元测试发现的。**
2. **纯内存命中被磁盘许可误拒**。读许可本意是限制磁盘并发，却在查内存缓存**之前**就被占用：完全命中内存、根本不碰盘的请求也占着盘的名额，并发一高就互相 503。冒烟里 100 并发缓存读的 p50 从 45 ms 跳到 101 ms 就是这个。已改为只在真要访问磁盘时才取许可。
3. **admin token 成了必需的 compose secret**，文件不存在容器就起不来——我自己引入的、与"配置不应阻止启动"直接冲突的回归。冒烟脚本没建这个文件因而失败。已在所有部署路径中生成该文件。

## 性能改动

| 改动 | 之前 | 现在 |
| --- | --- | --- |
| 下载池 | 单池，默认 4，硬上限 32 | 图片/视频两个独立池，默认 24 + 6，无硬上限 |
| 同步等待 | 每等待者每 50 ms 一次**同步阻塞** SQLite 查询 | 任务完成事件唤醒，250 ms 兜底轮询 |
| 对象目录 | `YYYY/MM/DD/<uuid>`，100 个/s 时单目录一天 864 万文件 | `YYYY/MM/DD/HH/<xx>/<uuid>`，叶目录约 1400 个；读取兼容旧形状 |
| 磁盘读许可 | 内存命中也占用 | 只在真要访问磁盘时取 |
| 队列容量默认 | 10000 | 100000 |
| 对象缓存默认 | 64 MiB / 单文件 1 MiB | 256 MiB / 单文件 2 MiB |

**这些数字是配置默认值和结构改动，不是实测吞吐。** 冒烟脚本的 p50 在本机 41–68 ms 之间波动（Docker Desktop、68 字节 PNG），噪声大于任何可归因的差异，不能当作性能证据。

## 仍未验证

**没有接触真实 48 TB NAS，没有真实 NFS 断网/重挂载/宿主重启演练，没有真实上游 CDN 负载，没有在目标 Linux 主机上跑过，没有做过任何真实并发压测。** 归档并发的收益、SLO 推导出的许可是否合适、分片后的目录行为，全都需要在目标主机上用 `scripts/nas-bench.mjs`、`fio`、`iperf3` 和真实负载复核。

设置控制台只在 Chromium 内核下验证过。`manage.sh` 的 `chown` 分支在 macOS 上会警告并跳过（非 root），Linux 上以 root 运行才会真正生效——目标主机上需要复核目录属主。

[容量与吞吐 §5](capacity.md#5-优化清单) 中仍标 ⬜ 的主要是：Nginx `X-Accel-Redirect`、NFS 挂载参数、延迟分位数指标与 Prometheus 导出、冷热判定（归档表仍没有 `last_read`，系统无法区分冷热）。

## 复跑

```sh
node --test tests/*.test.mjs
bash scripts/manage.sh deploy      # 幂等
bash scripts/manage.sh doctor
node scripts/smoke-compose.mjs
node scripts/smoke-nas-compose.mjs
```

---

## 0.5.0 验证记录（2026-09-12）

## 结果

- `node --test tests/*.test.mjs`：**44 passed，0 failed**（连跑 12 次无偶发）。新增 5 条归档批量/并发、1 条 409 拒绝原因、6 条容量推导、4 条分类分池与降级。
- `docker build -t mx-static:0.5.0 .`：通过。
- `node scripts/smoke-compose.mjs`：PASS。`{"node":"v24.21.0","sqlite":"3.53.4","uid":1000}`。
- `node scripts/smoke-nas-compose.mjs`：PASS（含新的归档并发与 verify 模式代码路径）。
- `scripts/nas-bench.mjs`：在本地临时目录上端到端跑通，卷标记守卫正确拒绝未确认目录，结束后只剩标记文件。

## 两个被测试逼出来的真缺陷

都不是测试问题，是这轮改动引入或放大的：

1. **`stop()` 关库后子进程回调还要写库**（`database is not open`）。`stop()` 杀掉子进程就立刻关闭 catalog，而子进程的 `exit` 回调随后还要回写任务结果。原代码在两处关库且无保护，逐任务回写把它放大成必现。已改为：`stop()` 在关库前有上限地等待子进程退出（250 ms，绝不无限等一个 D 状态子进程），关库只发生一次，`finish()` 在库已关闭时直接返回。
2. **后端健康卡在 `starting`**。逐任务回报让对象在子进程**退出前**就完成，而 health 只在退出时才翻成 `online`，于是刚归档成功的后端仍报 `starting`，导致 `evict` 被 409 拒绝。表现为约 3/10 的偶发测试失败。已改为：**一个成功归档的对象就是后端可达的证据**，health 在首次成功回报时即翻为 online。

第二个缺陷是通过给 409 加上具体原因才定位到的——原先只返回 `storage_transition_unavailable`，看不出是哪个前置条件不成立。现在每种拒绝有独立代码，这既是可运维性改进，也是这次能查清的原因。

## 归档并发的验证边界

**没有真实 NAS，因此这轮改动最核心的收益——NFS 小文件并发写的加速——没有被实测。** 本地临时目录没有网络延迟，并发只看到约 1.45×，而延迟受限场景的预期是 4-8×。文档里 2 TB 迁移的时间表全部标 `[估算]`。

**上线前必须先跑 `scripts/nas-bench.mjs`**，它会按对象尺寸和 verify 模式给出实测吞吐表和 `MX_STATIC_NAS_CONCURRENCY` 建议值。该脚本只在校验过 `.mx-static-volume-id` 的 NAS 上写自己的临时子目录，不触碰 `objects/` 或 `metadata/`。

已在本地覆盖的行为：一批对象经单个子进程全部镜像完成；一个坏对象按自己的退避重排队而不拖累同批其余对象、后端保持 online；子进程未回报的任务全部重排队且绝不标记为已镜像；`verify=never` 跳过远端回读但 `evict` 仍完整校验（NAS 副本被破坏时本机副本必须存活）；长批次靠进度消息续租不被他人抢走。

## 容量声明

容量推导是纯函数，已覆盖：SLO 到许可数的换算、许可随承诺而非固定默认值伸缩、链路与磁盘两类不可行情形被报出而非静默接受、带宽预算可被独立核算、非法输入被拒。

服务侧已覆盖：视频池占满时图片类不受影响；事件循环被压住 500 ms 后视频返回 `503 storage_overloaded` 而图片仍 200；`/capacity` 返回声明、许可、预算与实时占用且需要 read token。

**`MX_STATIC_LINK_MBPS` 和 `MX_STATIC_DISK_READ_MBPS` 的默认值是占位数字**，不填实测值的话可行性校验没有意义。用 §复跑 里的 `iperf3` / `fio` 量出来再填。

## 仍未验证

**没有接触真实 48 TB NAS，没有真实 NFS 断网/重挂载/宿主重启演练，没有真实上游 CDN 负载，没有在目标 Linux 主机上跑过。** 生产吞吐、实际 NFS fsync/root_squash、D 状态恢复仍需目标主机验收。

[容量与吞吐 §5](capacity.md#5-优化清单) 中仍标 ⬜ 的主要是：Nginx `X-Accel-Redirect`、图片/视频下载分池、下载并发上限 32→256、同步等待改事件通知、NFS 挂载参数、目录分片、冷热判定。

## 复跑

```sh
node --test tests/*.test.mjs
docker build -t mx-static:0.5.0 .
node scripts/smoke-compose.mjs
node scripts/smoke-nas-compose.mjs
# 在目标主机上，NAS 已挂载并写好卷标记之后：
node scripts/nas-bench.mjs --nas=/mnt/nas/mx-static --volume-id=mx-static-nas-01 \
  --sizes=200k,5m --concurrency=1,2,4,8,16 --count=128 --verify=always,never
```

---

## 0.4.0 验证记录（2026-09-12）

## 结果

- `node --test tests/*.test.mjs`：**28 passed，0 failed**（连跑 10 次无偶发）。其中新增 7 条流式下载/SSRF、7 条批量与读许可。
- `docker build -t mx-static:0.4.0 .`：通过。镜像只含 `src/`，**无运行时依赖**，构建上下文就是本仓库。
- `node scripts/smoke-compose.mjs`：PASS（双容器、独立 data/state bind、非 root writer + 只读 reader、重启后字节与任务记录一致）。容器内 `{"node":"v24.21.0","sqlite":"3.53.4","uid":1000}`。
- `node scripts/smoke-nas-compose.mjs`：PASS（可选接入 archive、缺卷标记拒绝归档、离线期间本地读写、重连补传、reader 触发冷文件恢复；writer/reader 容器 ID 不变）。

**0.3.0 的仓库在这里一条测试都跑不起来**：`src/service.mjs` 从 `../../../mx-insight-hub/...` 引入两个模块，而本仓库是从 monorepo 抽出的子集，那两个文件不存在。0.4.0 把 SSRF/DNS 固定、媒体签名、流式下载和消费侧客户端都变成本地模块后，仓库才第一次可以自测。

## 实测数字

开发机（macOS，Node v24.21.0），只说明数量级与拐点，**不能代表目标 Linux 主机**：

| 项 | 改造前 | 改造后 |
| --- | --- | --- |
| `GET /storage` 汇总，200 万行 `objects` | **6.0 s**（全表扫 + 每行 `json_extract`，同步阻塞事件循环） | **178 ms**（覆盖索引 + `size` 实列），33× |
| 同上，100 万行 / 20 万行 | 2.3 s / 416 ms | — |
| 控制面点查（30 万行） | 14.7 µs（每次重新编译 SQL） | **7.2 µs**（缓存 prepared statement），2× |
| SHA-256 吞吐 | 约 2 GiB/s → 64 MiB 文件同步阻塞 33 ms；`Buffer.concat` 再 18 ms | 下载改为流式增量哈希，不再整文件入内存 |
| `objects` 表体积 | 每百万行约 0.48 GiB | — |
| smoke-compose 的 100 次缓存读 | 0.2.0 记录 p50 155 ms / p95 197 ms | p50 **40 ms** / p95 **46 ms** |

最后一行不是受控对比：同一个脚本、同样的 68 字节 PNG，但 0.2.0 那次跑在 macOS Docker 文件共享上，0.3.0 起改用 Docker VM 本地 volume。**不能据此声称性能提升了 4 倍**，只能说当前这套在这个合成负载上是这个数。

macOS 的 `fsync()` 不下刷盘缓存，所以**开发机的 SQLite 提交耗时没有参考价值**，本轮不引用。控制面真实写入预算取决于目标盘的 fsync 延迟，见 [容量与吞吐 §7](capacity.md#7-上线前必须先量的数) 的 `fio` 命令。

## 新增模块的验证边界

`net-guard.mjs` / `media-types.mjs` / `fetch-media.mjs` **是新写的代码，不是 Hub 那份已在生产跑过的模块。** 已覆盖：

- 地址守卫：18 个私网/回环/链路本地/ULA/多播/文档段（含 `::ffff:192.168.1.3` 这类 IPv4-mapped 形式）全部拒绝，公网地址放行。
- 实测发现并规避了一个陷阱：`net.BlockList.check(address)` **不显式传地址类型时，对任何 IPv6 输入静默返回 `false`**。代码现在一律从 `isIP()` 推出类型再传入。
- URL 守卫：非 https、URL 内嵌凭据、`localhost`/`.local`/`.internal`、IP 字面量私网全部 422。
- 流式下载：完整路径、坏签名在前 12 字节即拒且不留暂存文件、声明长度与实际长度双重限流、不允许的 content-type、非 2xx 源、**逐跳重新校验重定向**（跳到 `169.254.169.254` 仍 422）、重定向链上限、不转发 Cookie/Authorization。

未覆盖：真实 CDN、真实 TLS 链、对抗性 DNS rebinding（测试用的是本地 DNS 解析）、HTTP/2 源站。**上线前应把这三个模块与 mx-insight-hub 的原实现逐条对照评审。**

`createMediaFetcher` 的 `allowHosts` 和 `tls` 是**测试专用钩子，故意不接任何环境变量**，部署无法通过配置关闭 SSRF 防护；`allowHosts` 只按主机名逐个豁免，重定向到其他私网地址照样拒绝。

## 一处测试改动

"response deadline is bounded while accepted background work survives" 原先用同一个 `ioTimeoutMs: 25` 的服务去验证后台任务存活，末尾那句 `cache_only` 断言在并行测试负载下约 1/5 概率因 25 ms 截止时间超时而拿到 503。该路径的 I/O 与改动前一致，属于测试把"响应截止时间"和"任务存活"压在同一个秒表上。现在用一个普通截止时间、不参与 pump 的第二实例做存活验证，断言含义不变，连跑 10 次稳定。

## 仍未验证

**没有接触真实 48 TB NAS，没有做真实 NFS 断网/重挂载/宿主重启演练，没有真实上游 CDN 负载，没有在目标 Linux 主机上跑过。** NAS 相关测试用临时目录模拟可见性与故障，`NAS_REQUIRE_NFS=false` 仅用于本地演练，生产保持默认 `true`。生产吞吐、实际 NFS fsync/root_squash、D 状态恢复仍需目标主机验收。

[容量与吞吐 §5](capacity.md#5-优化清单) 中标 ⬜ 的各项均未实现，其中**归档并发化（§5.3-12）是剩余项里收益最大的一条**，也是存量迁移能否在可接受时间内完成的前提。

## 复跑

```sh
node --test tests/*.test.mjs
docker build -t mx-static:0.4.0 .
node scripts/smoke-compose.mjs
node scripts/smoke-nas-compose.mjs
```

脚本使用独立项目名、临时目录和临时控制卷，结束后清理，不会影响默认部署项目。

---

## 0.3.0 历史验证（2026-09-12）

- 静态服务、NAS 故障模拟和管理脚本：15 passed，0 failed。
- Hub 运行时接线已撤下；服务端回归：1661 passed，9 skipped，0 failed（总计 1670）。
- 最终 `mx-static:0.3.0` 镜像构建通过。
- 三容器隔离 Compose 验证通过：独立接入 archive、挂载标记缺失拒绝归档、离线期间本地读写、重新接入补传、校验后释放本机副本、reader 自动请求冷文件恢复。writer/reader 容器 ID 始终不变。
- 模拟无法退出的 NFS 子进程：触发 stalled 后只保留一个槽，不启动替代进程；主服务健康与本地上传仍可响应。
- 慢传输进度延长空闲超时，总任务时长仍受限；HTTP 首响应超时不会取消已持久接收的任务。
- NAS 副本损坏时不释放本机文件；卷 ID 缺失/不同不写入空挂载目录；离线冷文件返回 503 恢复中，不误报 404。

**边界：使用临时目录模拟 NFS 可见性和故障，并模拟内核不可终止子进程；没有访问真实 36 TB NAS，没有执行真实 NFS 断网、挂载或宿主重启演练。** 生产吞吐、实际 NFS fsync/root_squash、重连/D 状态恢复需要在目标 Linux 主机验收。

macOS Docker 共享目录出现过跨进程控制状态不可见；换为 Docker VM 本地 volume 后验证通过。现在控制库启动拒绝 virtiofs/9p。Linux 部署使用本机原生文件系统；这是控制盘校验，不能迁到 NAS。

复跑（仓库根目录）：

```sh
node --test electron-dock/mx-base/mx-static/tests/*.test.mjs electron-dock/mx-base/tests/manage.test.mjs
```

复跑容器故障演练（electron-dock 目录）：

```sh
docker build -f mx-base/mx-static/Dockerfile -t mx-static:0.3.0 .
node mx-base/mx-static/scripts/smoke-nas-compose.mjs
```

脚本使用独立项目名、临时目录和临时控制卷，结束后清理。模拟脚本设置 NAS_REQUIRE_NFS=false，仅用于本地演练；生产保持默认 true。

## 0.2.0 历史验证

下述记录保留此前验证语境；NAS 和 Hub 接入行为以 0.3.0 文档为准。

### 0.2.0 本地验证记录

2026-09-12，0.2.0。未部署生产；未修改 MX-H2I 用户登录、联网、DNS 或 WireGuard 路径。

| 验证 | 结果 |
| --- | --- |
| Hub 全部服务端回归（含既有认证/租户隔离测试） | 1670 passed，0 failed |
| mx-static 持久队列/服务测试 | 8 passed，0 failed |
| mx-base 管理脚本行为测试 | 1 passed，0 failed |
| Hub 运维脚本 / Sites 运行时测试 | 116 / 4 passed |
| Hub 前端生产构建 | 通过，保留既有大 chunk 提示 |
| Docker 镜像 | mx-static:0.2.0，Node v24.21.0 / SQLite 3.53.4，UID 1000 |
| 实际双容器 Compose | 对象盘/控制盘分别 bind，reader 只读，上传后重启，字节与任务记录一致 |
| 并发采集 | 16 个 URL 同时接收，无 429；限定 3 个测试 worker；重复请求合并；cache_only 在途返回 202 |
| 强制崩溃恢复 | 子进程 SIGKILL，重开控制库，过期租约恢复；旧 owner 不可完成新租约 |
| 内存缓存 | TTL/LRU/字节上限、淘汰后读磁盘、不重新回源、租户隔离通过 |
| 浏览器等待 | queued 转为可重试 pending，不重复直连上游；任务独立于浏览器存活 |

100 个同时缓存读取的本地冒烟样本全部成功，p50 约 155 ms、p95 约 197 ms。样本是 68 字节 PNG，包含 macOS Docker 文件共享/客户端开销，只证明并发路径正确，不代表真实图片、生产网络或 NAS 吞吐能力。

上轮已验证：浏览器签名 WebP 直接预览、Hub 默认开放 API/refresh 与原生文档导航；两层实际 Nginx 配置的本地 `nginx -t` 通过（测试副本剥离生产证书引用）。线上完整 TLS、真实闲鱼 error.code/回源、真实图片负载与 NAS 断链仍需上线环境验收。

## 复跑

在仓库根目录：

```sh
node --test electron-dock/mx-base/tests/manage.test.mjs
node --test electron-dock/mx-base/mx-static/tests/*.test.mjs
```

在 `electron-dock`：

```sh
docker build -f mx-base/mx-static/Dockerfile -t mx-static:0.2.0 .
node mx-base/mx-static/scripts/smoke-compose.mjs
```

Compose 验证脚本创建独立、带进程 ID 的临时项目和临时目录，使用随机端口，结束后清理。不会对默认部署项目运行 stop/down。macOS 测试凭据是固定无效样本并允许容器读取；生产凭据由 manage.sh 随机生成、0440 权限。

在 `electron-dock/mx-insight-hub`：`npm run test:server`、`npm run test:ops`、`npm run test:sites`、`npm run build`。
