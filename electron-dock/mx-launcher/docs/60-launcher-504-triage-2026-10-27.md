# Launcher 间歇慢与 504：分层诊断和恢复

状态：2026-10-27 **故障阶段已确认：Domestic 公网 Nginx 到 Internal `10.88.88.88:80` 的 TCP 回源建连超时**；23:34 容器内探针已恢复，底层原因未结案。新增只读采集工具与一个本地验证的后台异常修复，未部署生产。

## 1. 本次证据

开发机对用户截图中的 `https://launcher.minsight-ai.com` 执行两次独立、无 Cookie 的 GET，绕过本机代理，不发送登录、订阅或业务写入：

| 路径 | HTTP | 公网 IP | TCP 建连累计 | TLS 完成累计 | 首字节 | 总耗时 |
| --- | --- | --- | --- | --- | --- | --- |
| `/admin/` | 504 | `116.62.51.154` | 0.200 s | 0.231 s | 5.256 s | 5.256 s |
| `/auth/admin/session` | 504 | 同上 | 0.025 s | 0.052 s | 5.080 s | 5.080 s |

第二次响应为 `server: nginx/1.30.4`，响应时间 `2026-10-27 22:37:37 +08:00`。表中时间均为 curl 从请求开始累计的字段，不能相加。两次采样不足以计算 P95 或证明所有客户端受影响。

两次均在 TLS 成功后约 5 秒返回，与仓库中公网和 Internal 两层 Nginx 的 `proxy_connect_timeout 5s` 接近。**优先怀疑回源建连失败，但还不能判定哪一跳**；需要实际 Nginx 的 `while connecting to upstream`、upstream 地址和同窗直连结果确认。不是根据截图就认定数据库或 WG 故障。

以上为初次采样的推断；本节后续 23:34 回执已确认具体失败跳点及阶段，底层网络/主机原因仍未确定。

用户随后回传手工探针：Internal `:80/admin/` 为 **403 / 1.502 ms**，`18444/healthz` 为 **200 / 1.573 ms**，TCP 建连分别 0.165 / 0.169 ms。执行主机及出站源地址尚待确认；这证明该采样点到两个端口当时可达，不能直接证明 Domestic 或其 Nginx 容器路径健康。403 也可能是来源 ACL 或后续网关校验拒绝，不是 504 的等价复现。下一步核对 `hostname`、`ip -4 route get 10.88.88.88` 与公网容器中的相同请求，不修改 allow/deny。

后续回执已确认执行机器是 `mx-internal-server`，路由为 `local 10.88.88.88 dev lo src 10.88.88.88`。该来源不属于 Nginx 允许的固定 Domestic `10.88.0.1`，403 符合来源限制；不应放宽 ACL。18444 健康检查通过只代表 Internal 本机采样，尚未覆盖 Domestic→Internal、Docker→WG、完整身份回源及 API 路径。下一项待回执：在 Domestic 公网主机上分别从宿主与 `compass-gateway-nginx-1` 请求同一 Internal upstream。

再后续用户确认 `hostname=HDO-Domestic`，路由为 `10.88.88.88 dev mx-domestic src 10.88.0.1`。接着回传 `:80/admin/` 为 **403 / 0.372 ms**，`18444/healthz` 为 **200 / 1.582 ms**，且 `compass-gateway-nginx-1` 不存在。此时不能继续用“Internal 本机来源不符”解释全部 403，也不能把默认容器不存在当作公网 Nginx 未运行。需同窗核对 hostname、实际 443 监听者、Docker 容器清单，以及显式绑定 `10.88.0.1` 的 HTTP 响应头。Nginx 来源拒绝、real_ip 规则及身份网关校验都尚待区分；不放宽 ACL、不重建默认容器。

**23:11:34 +08:00 公网复测**：`/admin/` 返回 200、`nginx/1.30.4`，TCP 0.131 s、TLS 累计 0.159 s、首字节 0.207 s、总计 **0.248 s**，公网 IP 未变。开发侧没有执行线上变更；不能据此认定根因已修复，需继续采集间歇失败和实际入口配置。前述 403 与此公网 200 也不是已证实的同一路径/同时刻对照。

**23:27:40 +08:00 Domestic 明确来源复测**：用户回传 Docker 列表含 `compass-gateway-nginx-1`（`nginx:stable-alpine`、Up 5 weeks、healthy、宿主 443 映射）及 `mx-domestic-edge`（Caddy、Up 2 months、healthy）。`ss` 确认本机 443 为 docker-proxy、80 为宿主 Nginx。显式 `--interface 10.88.0.1` 请求 Internal `/admin/` 返回 **200 / 49.976 ms**，curl 报告 `local=10.88.0.1 remote=10.88.88.88`，响应 `nginx/1.14.1`、Express、49487 字节。这确认当时 Domestic 宿主→Internal 完整 Admin 回源可用，还缺公网 Nginx 容器内同路径证据与故障时段日志。

此前“不存在默认容器”与本轮持续运行五周的容器清单不一致，不据此认定发生了容器重建或部署变更。以本轮实际来源/监听/清单为后续定位基线。另 `hdo-coredns` 仅运行 6 分钟，但公网 23:11 已有成功样本，且 Launcher 示例 upstream 为字面 IP；仅凭该 uptime 不能归因 DNS 或认定 DNS 重启修复了 504。

**23:34:21 +08:00 容器探针及故障日志**：用户在 `compass-gateway-nginx-1` 内请求 `http://10.88.88.88/admin/`，保留 Host/客户端 IP 头，返回 200、49487 字节，耗时约 **40 ms**、wget 退出码 0。故障日志在最近两小时/最多 10000 行范围内匹配到 **6 次**：

```text
error:    upstream timed out
stage:    while connecting to upstream
upstream: http://10.88.88.88:80
first:    2026-10-27T14:18:43.378262964Z  (北京时间 22:18:43)
last:     2026-10-27T14:37:37.151379865Z  (北京时间 22:37:37)
```

这确认 6 次请求在公网代理到 Internal :80 的建连阶段失败；其中末条与开发机 22:37:37 会话接口 504 同秒相符。无需再从用户中心 SQL 或订阅生成开始解释这 6 次超时，也不据此扩大 Nginx 超时或重启数据库。公网与容器当前成功只能说明当前路径恢复，不能证明底层问题消除。

尚需区分 Docker 转发/NAT、WG/底层网络丢包、conntrack 压力，以及 Internal 主机停顿/监听队列等。`while connecting` 本身不能把这些原因进一步区分，数据库/存储异常也只能通过主机受影响的同期证据间接关联。下一步优先读取两端北京时间 22:10–22:45（UTC 14:10–14:45）的内核/服务历史；累计 TCP 计数和当前 WG 握手只作基线，不归因到历史窗口。若历史证据不足，下次故障时需同步对照宿主与容器，而非凭健康期状态指定某条 NAT 规则。

### 后续历史回执：Internal memcg OOM 与 Domestic 容器停止

用户按上述带 `--utc` 的历史命令回传附件及文本。Internal 内核在 UTC `14:12:08`、`14:14:18`、`14:23:37`、`14:24:36`、`14:25:48`、`14:28:07`、`14:40:24`（北京时间分别加 8 小时）记录 **7 次** `CONSTRAINT_MEMCG` / `Memory cgroup out of memory`，受害进程均为 `python`、UID 1000：

- Pod UID：`b7528c3d-02bb-4f44-9a11-bd1dea104a43`。
- 容器 ID：`b2bc769a0592ebd85031c67051610705ff969dac086179fca622795f5583d6b5`。
- `oom_memcg` 指向该 Pod 的父 slice，`task_memcg` 指向上述容器 scope；需核对 Pod 父层及容器层限制，不能只看容器自身 limit。
- 7 个不同 PID 的 anon RSS 约 **3.14–5.57 GiB**；这不是 cgroup 总用量，也不能据此推出具体内存限额。

这些日志确认一个 Pod 内存控制组中的 OOM，**不单独证明整机 RAM 耗尽**。同一个容器 ID 中不同 Python 进程多次被杀，也不能写成“Pod 重启了 7 次”；可能是内部 worker/子进程失败，需结合容器主进程及状态核对。它与 504 时间重叠，但尚无同窗主机压力、WG/包路径证据建立因果关系。服务归属仍须用 UID/CID 映射，不依据 Python 名称猜测 Embedding/OCR/Rig。

Domestic dockerd 同窗记录 4 个容器退出码 137、`hasBeenManuallyStopped=true`、`daemonShuttingDown=false`、`restart canceled`：

| UTC 时间 | 容器 ID 前缀 | execDuration |
| --- | --- | --- |
| 14:20:58 | `65a284cd993a` | 12h22m23s |
| 14:21:10 | `fd9f045fded5` | 11.85s |
| 14:31:10 | `e2a4f8115d8a` | 10m0.31s |
| 14:41:16 | `36f05584c87f` | 10m5.08s |

137 与停止状态不足以证明 OOM：Docker stop 宽限期结束也会 SIGKILL，停止请求也可能来自部署/自动脚本而非人工点击。须只读映射容器名称、镜像、Compose service 与 `State.OOMKilled/ExitCode/FinishedAt`；容器已删除时保留“无法映射”，不能指定为网关或 DNS 服务。这批过滤日志没有提供 WG/Nginx 停止的正证据，不能把无匹配当成它们始终正常。

解释依据：[Linux memory cgroup 文档](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v1/memory.html)、[cgroup v2 内存边界](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html)、[Docker stop 信号语义](https://docs.docker.com/reference/cli/docker/container/stop/)。本轮继续只读归属与压力核对，不停止未知 Python 任务、不移除内存上限、不重启 WG/数据库。

### 2026-10-28 归属回执：HanLP 的 8Gi 限额与 worker 预算

用户用 Pod UID 映射确认上述 OOM 属于 `mx-common/mx-common-hanlp-55c7666bf8-t8vps`，容器 `hanlp` 的 memory limit 为 **8Gi**，Pod 显式内存 limit 为 `<none>`，重启计数为 **1**。`<none>` 不能解释为 Pod 父 cgroup 没有限制，仍须区分 Kubernetes 声明字段和内核实际限制。当前主机总内存 251Gi、available 112Gi、无 swap；这说明采样时有主机余量，不能回推故障时内存压力。Domestic 的 4 个旧容器 ID 均返回 `No such object`，本轮无法确定其名称或服务归属。

仓库 HanLP 实现提供了与回执相符的机制，线上版本及实际池大小还需 `/health` 确认：

- `mx-common/deploy/hanlp/server.py` 按前端 512Mi、每个 worker **1536Mi** 预算规划模型进程。当前 manifest 的 16 CPU / 8Gi 且无 `MAX_CONCURRENT_INFERENCES` 上限时，会启动 **5 个独立模型 worker**，每个 3 个计算线程，其中 1 个槽保留给 interactive 请求。
- OOM 日志中单个受害 Python 的 anon RSS 已达 **3.14–5.57Gi**，明显高于每 worker 1.5Gi 的静态预算。这使模型并发的内存预算成为 HanLP OOM 的首要排查点，但不能由单进程 RSS 推算安全的容器总限额。
- worker 管道断开后，HTTP 前端会补建 worker；因此同一个容器中 7 个不同 Python PID 被杀与 Pod 重启计数 1 并不矛盾。`/health` 的 `workers/liveWorkers/queued/replacedWorkers` 可补充当前证据。
- 只把 Deployment 内存从 8Gi 增至 16Gi，在无 worker cap 且重启后，会使上述规划从 5 个 worker 增至 10 个；增加的容量可能再次被模型副本占用。恢复应先固定 worker 并发，再依据真实批量负载和 cgroup 峰值评估容量。
- `MAX_CONCURRENT_INFERENCES=1` 是现有实现的保守降并发入口，但会降低吞吐且没有专用 interactive 槽。当前 Deployment **单副本、Recreate**，修改 env/resources 模板会替换 Pod、重新加载模型，存在 HanLP 不可用窗口；不能当成热更新直接执行。

当时的下一步是只读取得容器 `/health`、worker cap 和 cgroup 当前/峰值/限额/OOM 计数。必要时再补批次条数、总字符数与单条最大长度等数值，不采集业务正文，不用真实推理请求压测；当时尚未修改 HanLP 配置或部署。

**后续容器回执已确认上述生产池配置：** `worker_cap=<unset>`、`status=ready`、`workers=5`、`liveWorkers=5`、`threadsPerWorker=3`、`reservedForInteractive=1`；interactive/bulk 等待队列均为 0，`skippedDisconnected=1`、`replacedWorkers=57`。队列为 0 不代表没有正在执行的推理；ready 也不代表历史请求没有失败。

现场使用 cgroup v1，`memory.usage_in_bytes=3470815232`（约 **3.232Gi**）、`memory.max_usage_in_bytes=8594051072`（约 **8.004Gi**）、`memory.limit_in_bytes=8589934592`（**8Gi**）、`memory.failcnt=32`。历史峰值已到限额附近。`failcnt` 是内存限额命中计数，不能解释成 32 次 OOM；`replacedWorkers` 是进程替换累计，不能解释成 57 次 OOM。与已确认的 7 条内核 OOM 一起，这些证据支持先降低模型并发，不能单独推出单个批次所需的安全内存。

<a id="hanlp-concurrency-mitigation"></a>

#### HanLP 启动与容量修复（本地准备，未在线上执行）

最初准备过 cap=1 的应急降并发配置与单 worker 部署验收。**用户确认从未在线上执行，并明确要求保留多 worker 并发，随后同意增加最大内存。该单 worker 默认已撤回，不应照此前回复把它当成长期部署方案。** cap 是整个进程生命周期的并发上限，不是仅启动期生效；流量上升也不会自动扩容。

现方案：

| 项目 | 原线上 | 当前待部署 |
| --- | --- | --- |
| 内存 request / limit | 1Gi / 8Gi | 1Gi / **32Gi** |
| CPU limit | 16 | 16 |
| worker cap | 未设置，自动算出 5 | **5**，避免扩内存后自动增至 16 |
| 运行并发 | 5 workers × 3 threads，批量最多 4，保留 1 个交互槽 | 保持相同 |
| 模型加载 | 初始一次启动所有进程，替换也可同时加载 | 初始和替换逐个加载/预热，存活 worker 推理不受加载锁限制 |

内存 limit 是允许使用的峰值边界，不是预占或常驻内存；request 用于调度，也不等于实测 RSS。保留 1Gi request 不会为 32Gi 高峰预留调度容量，节点高峰时仍须有实际余量。业务空闲时模型及分配器缓存可能保留，不承诺自动回落到固定内存值。[Kubernetes 资源说明](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)

32Gi 以已观察的单进程 5.57Gi 用量和五个 worker 作为初始预算参考，**不是已测得的最坏上界**。原 OOM 跨约 28 分钟发生在同一容器，`replacedWorkers=57` 表示启动后有替换活动，不能认定只是开机瞬间。用户无法确认当时是否有重启或批量流量；串行加载只减少加载峰值重叠，扩容后的运行高峰仍需实测。不要把五个 worker 等同于无限吞吐或将 3 个计算线程理解为 3 路请求。

普通 Hub ensure/开机恢复不修改 HanLP 模板；新配置和服务代码通过显式 HanLP deploy 发布。在 `mx-internal-server` 的 `electron-dock` 目录同步代码后执行：

```bash
KUBECONFIG=/etc/kubernetes/admin.conf bash scripts/manage.sh deploy hanlp
```

部署保留构建缓存/导入流程，在一次 manifest apply 中设置 32Gi/cap=5；相同 image ID 与模板不额外滚动。rollout 后验收 ready、`workers=liveWorkers=5`，再执行分词冒烟；失败不报告成功。该 Deployment 为单副本 Recreate，首次发布会中断 HanLP 在途请求并重新加载模型，搜索/索引可能失败或等待；初始 Ready 仍等待全部模型预热。串行总启动预算同步设为 3000 秒（5 × 原单模型 600 秒），进度期限/默认部署等待为 3300 秒；预热完成后立即继续，不固定等到上限。既有开机只读验收仍可能在 900 秒先报告未就绪，但不会因此重启 HanLP。未修改 Launcher 登录、WG、订阅或数据库。

发布后只读查看实际池：

```bash
timeout 15s kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=8s -n mx-common exec deployment/mx-common-hanlp -c hanlp -- python -c 'import json,urllib.request; h=json.load(urllib.request.urlopen("http://127.0.0.1:8000/health",timeout=3)); print(json.dumps({k:h.get(k) for k in ("status","pool")}))'
```

预期 `ready / workers=5 / liveWorkers=5 / threadsPerWorker=3 / reservedForInteractive=1`。新 Pod 的内存峰值和替换计数归零不等于问题解决；继续在正常业务高峰检查 cgroup 峰值、failcnt 增量、新 OOM、worker 替换、队列和查询延迟。不创建额外生产重建任务压测。

本地 Python 完整回归 60 项通过，使用 stub 模型验证串行加载、关闭/失败清理、替换时其他 worker 继续服务，以及 32Gi/cap=5 保持五路容量和交互预留；部署验收回归 16 项及相关既有部署测试通过。探针、控制器与部署等待预算有一致性回归。未在生产部署，未验证真实 HanLP 冷启动耗时、32Gi 峰值上界或高峰吞吐。

**这项 HanLP 故障仍与 Launcher TCP 建连超时分开处理。** 已确认的 504 阶段是公网 Nginx→Internal :80 建连；HanLP OOM 时间重叠不足以建立因果关系。若复发，需在同一短时间窗并发对照 Domestic 宿主和 Nginx 容器到 Internal 的请求，并采两端 WG 流量增量、宿主 conntrack、容器网络命名空间 TCP 重传，以及 Internal :80 监听队列。健康期单次快照不能替代故障期证据。

另有此前的公网对照采样：`https://h2i.minsight-ai.com/bootstrap-healthz` 和 `/internal-healthz` 同样解析到 `116.62.51.154`，TLS 完成分别约 0.061 / 0.237 秒，但 10 秒内均未收到响应，curl 退出码 28、HTTP `000`（不是服务器返回了 HTTP 000）。这增加了共享公网入口/回源路径异常的可能性；仍需实际 upstream 证据。不能用这两个控制面健康请求的超时断言已建立的 WG 隧道或海外出口全部中断。

当前代码中 `/admin/` 是静态文件路径；个人 SSO 中间件对它直接放行到静态处理。静态首页整页 504 与“页面打开后某个用户/海外列表 API 慢”必须分开排查。整个 API 进程退出、阻塞、不可达或代理回源故障都可能影响静态首页。

### 用户补充：开机自动恢复与 NAS 相关构建负载

用户补充此前已实现 Launcher、HanLP、Hub、DataPort、Pay 的重启恢复，并报告曾观察到 NAS 相关 Docker 镜像持续构建。尚未取得本次故障窗口的具体构建进程、容器、起止时间和资源占用；“一直构建”在此作为待核实线索，不作为确认根因。

对当前仓库只读核对后的边界如下；安装快照、线上版本和额外 cron/CI/systemd 任务仍需现场核验：

- `electron-dock/scripts/boot.py` 的开机验收只轮询原服务、工作负载、镜像与健康状态，不调用 deploy/build，不自动恢复 replicas=0，不改 HanLP Pod 模板。验收服务是有总期限的 oneshot；缺镜像时报告问题，不以重建镜像补救。
- mx-static NAS 的 `_auto-recover` 使用全局锁，媒体服务恢复只 `docker start` 已有容器；已运行则跳过，不执行 Compose build/up。systemd 开机延迟 60 秒，失败后 60 秒重试，成功后保持 exited；不是每分钟重新构建。显式 NAS 发布的 `recreate --build` 属于另一条变更入口。
- 显式 Hub deploy 会先 `mx-common ensure`，再构建/导入 Hub 镜像。ensure 不 apply HanLP 模板，保留已设置的 cap；必要时只导入与已部署身份一致的缓存镜像。不过它可能删除 CrashLoopBackOff Pod，让控制器按原模板重建，不能称为全程只读。
- 统一 `deploy all` 串行并遇错停止；锁只覆盖同用户、同 state 目录、经该入口启动的部署，不能约束其他项目、用户或直接调用。不能用它证明全机没有并行构建。
- HanLP 专用 builder 默认限制 **4Gi / 2 CPU**，构建结束会停止；Launcher、Pay 的代理 BuildKit 容器使用 `unless-stopped`，当前创建代码未指定 CPU/内存上限。后者属于资源治理风险，尚未证明事故时在构建或占用过高。BuildKit 容器一直 `Up` 只说明构建服务常驻，不代表构建作业一直运行。
- NAS 显式维护发布的构建阶段调用 `docker compose build`，后台 transient unit 没有构建时长或 CPU/内存/I/O 预算；NAS 维护锁不与其他项目构建锁共享。po-infra 的本地发布也有独立 Compose build 入口，不能用运行容器的 `mem_limit/cpus` 代表 builder 限制。登记的 NFS 设备为独立 `192.168.1.3`，这两套媒体应用及 Docker root `/data/docker` 位于 Internal 主机；仍须核对用户此次所见的具体构建任务是否属于它们。

若实际构建发生在 `mx-internal-server`，它可能竞争 CPU、RAM 和 Docker/containerd 所在磁盘；镜像导入/解压也会产生 I/O，即使没有编译进程。若构建在独立 NAS 设备上，则不直接消耗 Internal 的物理内存，需另查共享 NFS 和网络的影响。CPU/内存/I/O 争用能造成延迟，但要用故障同窗的 `/proc/pressure/{cpu,memory,io}`、区间 vmstat/iostat 和容器资源数据验证，不能仅凭 builder uptime、主机总内存占用或负载平均值归因。[Linux PSI 说明](https://docs.kernel.org/accounting/psi.html)

这仍是两层不同证据：HanLP 的日志是其 Pod `CONSTRAINT_MEMCG` OOM，自身 8Gi 限额与模型并发已经构成容量问题；独立 Docker 构建的内存不会直接算作 HanLP Pod 的用量。主机压力可以并存，但停止构建不保证消除 HanLP 的负载峰值。Launcher 的证据则是公网回源 TCP **建连**超时；只有应用计算或 SQL 变慢，还不足以解释这个阶段，需继续关联两端 WG/转发、TCP 重传/监听队列及主机压力。

10 月 19 日已有 NVMe I/O timeout 历史，只作本轮 I/O 排查优先级依据，不移用为 10 月 27 日故障事实。优先取得同窗只读证据，再对已确认的构建作业做限额/串行或安排暂停；不关闭整个重启恢复机制、不停止 Docker/containerd/WG、不清理卷或模型。此前 HanLP cap=1 仅完成本地配置；后续用户明确保留并发，该默认已撤回。

### 00:32 资源回执：builder 低占用、恢复已结束，NVMe 有短时写延迟

新附件采样主机为 `mx-internal-server`，UTC `2026-10-27T16:32:31Z`，即北京时间 **10 月 28 日 00:32:31**，比最后一条已确认 504 晚约 1 小时 55 分钟。不能把它当成 22:18–22:37 故障窗口的同步资源证据。

| 采样项 | 结果 | 可支持的结论 |
| --- | --- | --- |
| 主机内存 | 251Gi 总量，120Gi used，83Gi free，115Gi available，无 swap | 采样时未显示整机内存耗尽；不回推故障时状态 |
| 13 个已识别构建服务容器 | 8 个 `buildx_buildkit_*`，以及 2 个 Launcher、2 个 Pay、1 个 Rig 代理 builder；CPU 均显示 0.00%，Docker CLI 内存合计约 404.71MiB | 当时没有高 CPU/RAM 构建负载证据；常驻容器不能等同活动构建任务，也不能排除处于等待中的作业 |
| vmstat 后续区间 | CPU idle 94–97%，wa 为 0，blocked 多为 0、末项 1，无 swap 活动 | 当时整体 CPU 有余量；不代表每个核/磁盘/网络路径均无延迟 |
| iostat 两个实时区间：nvme0n1 | 写约 4096KiB/s；w_await 5.32 → **86.13ms**；aqu-sz 0.69 → **9.99**；末段 116 writes/s、util 14.9% | 短时写延迟值得继续采样；一秒异常不等于设备损坏，也不能单独解释此前 5 秒建连失败 |
| iostat 两个实时区间：nvme1n1 | w_await 0.53 / 0.09ms，aqu-sz 0.30 / 0.06 | 同窗另一设备写等待低，不将其与 nvme0n1 混淆 |
| `/proc/pressure/*` | 三项均不存在，内核显示 4.18.0-348.7.1.el8_5 | 该环境未暴露 PSI 接口，不是压力为零；本轮改用区间 vmstat/iostat/pidstat，不为诊断升级/重启内核 |

`iostat` 第一组与 `vmstat` 第一行是自开机以来统计，不能当成本轮即时值；低的全机 iowait 或 NVMe util 不足以排除单个设备的等待。Docker CLI 内存是其自身显示口径（Linux 会扣除部分缓存），上述 405MiB 不等于完整构建 cgroup 原始内存；BLOCK I/O 是累计读写量，不能把 PostgreSQL 的 30.1GB 当成当前写入速率。容器上限显示为主机 251.3GiB 是后续核对资源边界的线索，不能理解为每个容器已经预占 251GiB。[iostat 说明](https://man7.org/linux/man-pages/man1/iostat.1.html)、[Docker stats 说明](https://docs.docker.com/reference/cli/docker/container/stats/)

同批 systemd 状态：

- `mx-boot-verify.service`：Result=success、NRestarts=0，21:27:21 开始、21:28:53 结束，inactive/dead；符合成功完成的一次性验收状态，不是服务崩溃。
- `mx-static-nas-boot.service`：Result=success、NRestarts=0，21:27:56 开始、21:28:58 结束，active/exited；恢复程序已退出，active 不表示仍在执行构建。

二者在本次已知 504 窗口开始前约 50 分钟完成，回执不支持“这两项恢复一直失败重试或一直构建”。它们启动过的业务负载后续仍会运行，其他手工发布或外部任务也未因此被排除。

随后请求磁盘路径映射与 20 秒 iostat/pidstat 采样；不按累计 BLOCK I/O、历史 PID 或进程名直接停止数据库。若同时复现 Launcher 504，仍须结合 Domestic 宿主/容器直连、TCP/WG 数据建立同窗联系。

### 00:44 资源回执：Docker 在本地盘，未复现持续 I/O 拥堵

`lsblk/findmnt` 确认 `/data/docker` 位于 `/data`、`/dev/nvme0n1p1`、XFS，是 Internal 本地 NVMe，不是 NAS 的 NFS 挂载。系统 `/`、`/home` 在另一块 `nvme1n1` 的 LVM 上。不能据 Docker root 的位置推断所有数据库 bind mount 的实际设备。

本次 `iostat` 区间为 UTC 16:44:21–39，`pidstat` 基线为 16:44:25、区间结束为 16:44:27–45，即北京时间 10 月 28 日 00:44。两者部分重叠，不能把各自窗口外的峰值配对。用户明确表示当时没有同时访问 Launcher；这一轮不能确认 504 是否仍在发生或已经消失。

- nvme0n1 最大写入段为 16:44:23，17,993KiB/s、w_await=2.87ms、aqu=5.85；它在 pidstat 开始前。另一段 22.25ms 仅有 2 writes/s、8KiB/s、aqu=0.04，其余多数区间写入很少。本轮未复现此前 86ms 的写等待，不证明设备持续拥堵或历史故障已经消除。
- iostat 第一组 CPU 各项合计仅 0.02%，不作为有效利用率报告使用；后续 CPU idle 92.22–97.13%。
- pidstat 中 13 个 `buildkitd` **进程**合计平均读 6.36KiB/s、写 0；不支持这段窗口有明显构建磁盘负载。所有 postgres 进程平均写入合计约 4091.74KiB/s，可能跨多个实例和设备；最大进程写入段在 16:44:45，已晚于 iostat 结束。
- PostgreSQL **PID 89225** 平均读取 875.15KiB/s，每个两秒区间 iodelay=194–209，十段合计 2004 **clock ticks**。iodelay 不是毫秒，也不是 ticks/s；若主机 `CLK_TCK=100`，对应累计约 20.04 秒等待。须先读 `getconf CLK_TCK`、PID 的 lstart/comm/wchan 和 cgroup 定位实例，再核对其挂载；不能凭 UID70 或 postgres 名称认定是 Launcher DB/NAS。[pidstat 说明](https://man7.org/linux/man-pages/man1/pidstat.1.html)

后续只针对 PID 89225 做最小归属核对，不再收集包含数万零活动行的全量 `pidstat -p ALL`。Launcher 主线仍是公网 Nginx→Internal:80 建连失败的故障同窗证据；HanLP 用户确认未上线 cap=1，后续改用上文 32Gi/cap=5 方案。

## 2. 应核对的链路

```text
浏览器 → Domestic Nginx :443
       → WireGuard → Internal Nginx 10.88.88.88:80
       → mx-identity-public 10.88.88.88:18444
       → mx-launcher-internal Service :18090 → API Pod
                                            → Launcher 自有 PostgreSQL

Internal 控制面：宿主机 Caddy :18090 → API Service/Pod
```

公网路径依据 de-mingxi 的 `compass/deploy/nginx/examples/71-launcher.conf.example`、
`nginx/snippets/proxy-common.conf`，以及 Launcher `scripts/identity-ingress.mjs`、
`scripts/identity-deploy.mjs`、`server/src/identity/server.ts`。示例配置不证明现场已启用；仍须以实际容器、监听和错误日志为准。

`18444/healthz` 必须带 `Host: auth.minsight-ai.com`。直接请求该端口 `/admin/` 缺少私有网关凭据会被拒绝，不能误判为服务坏了。Internal Nginx 只允许固定 Domestic peer；从 Internal 本机直接访问它收到 403 也不能证明公网路径故障。

identity 到 API 的代码超时为 30 秒，连接错误返回 502；Internal Nginx 的读取超时为 60 秒，公网示例读取超时为 300 秒。因此本次约 5 秒的 504 要先查代理连接阶段。不要用增加读取超时掩盖尚未定位的问题。

## 3. 两台服务器只读采集

同步本次新增脚本即可，无需构建或 deploy。在 **Internal 服务器的仓库根目录**执行：

```bash
bash electron-dock/mx-launcher/scripts/diagnose-launcher-timeout.sh internal
```

在 **Domestic 服务器**放置同一个脚本，然后执行：

```bash
bash diagnose-launcher-timeout.sh domestic
```

需要 Linux、Bash、Python 3；Internal 需要原有 kubectl 与 `/etc/kubernetes/admin.conf`，Domestic 使用原有 Docker/WireGuard。读取主机日志及集群通常需要 root。缺少可选工具时记录失败，不安装软件。脚本为有限次数采样，每条外部命令有期限，不循环压测。

输出包括 HTTP 分段耗时、指定资源的 Ready/重启/镜像、Service/EndpointSlice、数据库等待聚合、磁盘采样和脱敏错误分类。不会读取 Secret、输出原始 SQL、用户信息、WG key、订阅 URL 或完整 Nginx 配置；不会登录、重启、部署、修改数据库/路由或创建 debug Pod。读请求仍会消耗少量资源并可能进入已有访问日志。

`internal|domestic` 是操作者声明，不是自动识别；开头会输出 hostname 和到固定 Internal 地址的路由，先确认运行位置。`failed_checks` 统计采集命令错误，HTTP 403/504 保留为独立结果；无重启 Pod 会跳过 previous 日志，不当作检查失败。脚本语法检查及 7 项离线 fake 命令测试通过，覆盖超时继续、只读约束、输出脱敏、失败 curl 耗时及无重启跳过日志；没有在生产执行此脚本。

先回传输出中的 HTTP、Nginx 错误分类和 Pod 状态。缺失/失败的检查表示证据不完整，不表示对应组件正常。若此时恢复正常，可在下一次卡顿时再手动运行一次，避免仅用健康期快照解释故障期。

暂时无法同步脚本时，在 Domestic 上先执行这两条：

```bash
curl --noproxy '*' --connect-timeout 3 --max-time 8 -sS -o /dev/null \
  -H 'Host: launcher.minsight-ai.com' -H 'X-Real-IP: 10.88.0.1' \
  -w 'internal-nginx HTTP=%{http_code} connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  http://10.88.88.88/admin/
curl --noproxy '*' --connect-timeout 3 --max-time 8 -sS -o /dev/null \
  -H 'Host: auth.minsight-ai.com' \
  -w 'identity-18444 HTTP=%{http_code} connect=%{time_connect}s ttfb=%{time_starttransfer}s total=%{time_total}s\n' \
  http://10.88.88.88:18444/healthz
```

## 4. 按证据选择恢复范围

以下是条件分支，不是依次执行的重启清单。现场回执到齐前不执行生产变更。

| 同窗证据 | 继续定位 | 恢复范围 |
| --- | --- | --- |
| Domestic 的 80 和 18444 都无法建连，Internal 本机正常 | WG 路由/握手及增量流量、ACL、Domestic 出口；握手新鲜不等于 HTTP 通 | 仅修复已证实的错误路由/ACL；不 down/up 整个 WG、不重建 peer |
| Domestic 宿主请求正常，公网 Nginx 容器请求失败 | 容器到 WG 的转发、路由、NAT 与实际 upstream | 修复这条回源路径；不清空防火墙或重启 Docker |
| 80 快速建连但约 5 秒 504，18444 建连失败 | Internal Nginx → identity hostPort、Pod 是否存在、进程监听、CNI | 仅处理故障身份实例/回源目标；保留 issuer、Secret、cookie key、原 profile |
| 80 不是 Nginx，或 Nginx 启动失败 | `ss` 的端口归属、Nginx 启动错误 | 按 [50](50-internal-gateway-port80-ownership.md) 分支处理；共享网关滚动会影响控制请求，不能视为无中断动作 |
| 18444 健康，API Pod 快，Service/18090 慢 | Service EndpointSlice、Caddy upstream、kube-proxy/CNI | 修正已验证的 Service/回源漂移，保留其余应用路由；不直接应用空网关基线 |
| API Pod 的 healthz 和 admin 都慢/进程重启 | CPU 节流、事件循环、OOM/退出原因、当前及 previous 日志 | 对照故障版本，针对 API 修复；不把整个 Launcher deploy 当作重启按钮 |
| healthz/admin 快，但 readyz、身份或业务 API 慢 | PG wait_event/锁、连接等待、CPU 节流、磁盘延迟 | 先限定负载来源；`db status launcher` 查看运行资源，确认余量和根因后才决定原地资源/热参数调整 |
| WALWrite/WALSync 与 NVMe timeout/高 await 同时出现 | PG 实际挂载、设备 I/O、上游后台写入 | 复用 [51](51-internal-server-storage-deploy-incident-2026-10-19.md) 的存储事故流程；不关 fsync、不停共享数据库、不盲目搬盘 |

历史 10 月 19 日的 NVMe/WAL 等待是已记录的风险，不能代替本次证据。etcd 已迁移也不意味着 Launcher PG、容器数据及原数据盘已恢复。

## 5. 本地已验证的 API 异常缺陷

`LauncherNetworkController.onModuleInit()` 启动及周期调用 `reconcileExpiredHandovers()` 时原来没有处理 Promise rejection。回收任务的数据库查询失败会向外抛错；使用真实 controller、模拟失败的 store，在隔离 Node 子进程复现退出码 1。这会影响同一 API 进程提供的静态页、用户中心和网络控制请求。

本次仅在后台启动/周期入口增加异常捕获和固定结构化告警 `launcher_network.handover.reconcile_failed`。回收算法、定时周期、single-flight、直接调用的错误传播、登录凭据及 WG 配置保持原语义；失败后下一轮仍可重试。不输出原始数据库错误或请求内容。

本地回归覆盖启动失败、下一次定时失败、再下一次成功，验证子进程存活和日志脱敏；直接调用仍抛原错误并能再次执行。**这是已验证的独立代码缺陷，尚未证明是本次线上 504 的根因。** 需对照生产 API restartCount、lastState 和 previous 日志中 `reconcileExpiredHandovers` / `runExpiredHandoverReconciliation` 调用栈。

本地验证：新增回归与既有 runtime traffic 测试 7 项通过；另一次包含新增回归、产品网络隔离、租约身份和 SDK 密码路径的测试共 14 项通过（两组有重复，不能相加当作独立用例数）。TypeScript typecheck 通过。上述均未连接生产，不能代替真实客户端验收。

上线应先确认镜像、当前 rollout 和 Caddy/identity 使用的 Service/upstream。API 镜像更新仍有启动和滚动风险，不能承诺未验证的零中断；在 MX-H2I 登录/联网保护条件未得到满足时，不进行单副本重启。既有局部 API 发布说明见 [11](11-k8s-deployment-runbook.md)，其中历史镜像标签/提交号不能当成本次版本使用。

用户中心 N+1 查询、海外权益聚合重复读、主池等待上限及同步密码哈希另有优化空间。这些尚未证明是此次连接超时原因，本次不一并改变登录、认证或订阅语义。

## 6. 恢复验收

分别确认公网 admin/session、Internal API/identity Ready、正常业务请求；对比故障窗口的 5 秒 504、重启增量和磁盘等待是否消失。一次 200 不代表间歇故障已解决。

使用现有测试账号和会话验收 MX-H2I 密码/飞书登录、当前用户既有 WG 内网访问、既有海外出口/订阅刷新；不让现有用户统一登出或断开重连。检查 SSO、用户/角色、租约、peer 和密钥未被重置。Hub/DataPort/Pay 仍使用原 SSO 和各自数据库边界。

本轮没有连接生产 SSH/Kubernetes，没有执行恢复、部署或网络配置变更。恢复状态等待操作者回传并逐项确认。
