# Hub Admin 缩容停在控制器协调阶段

2026-10-19 的部署失败现场：Admin Deployment `generation=418`、`observedGeneration=417`、目标副本数 0、当前及 Ready 副本数 1；Pod 仍为 Running，没有 `deletionTimestamp`，停止宽限期为 30 秒。120 秒等待失败后，部署清理恢复 Admin 目标副本数 1。

这证明 API 已接受缩容意图，但当时 Deployment 控制器尚未报告处理这一代配置。没有进入 Pod 删除的证据，不能把此现场归因为 Node 进程不退出或 30 秒 grace 不足。

后续只读回执显示节点 `v1.36.2`、Ready=True，但 `kube-controller-manager` 及 `kube-scheduler` 均为 0/1、CrashLoopBackOff，分别累计重启 132、135 次。控制器故障与缩容无法推进直接相关；调度器故障还会影响新 Pod 调度。已有 leader Lease 或 Ready 节点本身不证明控制器仍正常续租、工作。

## 控制平面日志证据

随后收到的 API Server 日志显示，它访问本机 `127.0.0.1:2379` 时，连续出现 etcd `KV/Range`、`Txn` 请求超时。etcd 在 UTC `17:15:33` 明确记录 `slow fdatasync`，耗时 **1.518977 秒**；同一时刻的 `ReadIndex` 约 1.518 秒、健康检查约 1.229 秒、控制器 Lease 请求约 1.238 秒。

这组证据把本次部署阻塞从“Pod 没有退出”进一步定位到控制平面存储响应慢：已经确认 etcd 一次同步落盘调用耗时约 1.5 秒，并有同时段的读索引、健康和租约请求延迟，以及 API Server 对 etcd 的连续请求超时。它支持 etcd 延迟拖累控制平面协调的判断；不能仅凭这些耗时确定磁盘硬件故障、磁盘满、CPU 调度、宿主机 I/O 竞争或某个业务进程是原因。具体资源瓶颈仍需结合实际 data-dir 所在设备、`iostat`、`vmstat` 及同时间段日志确认；也不能把单个 `slow fdatasync` 条目解释成全部历史重启的唯一原因。

随后约 5 秒采样中的 1 秒间隔主机样本显示：etcd data-dir 为 `/var/lib/etcd`；`nvme0n1` 的写等待依次约 1213/2116/786/362 毫秒、平均队列约 16/523/392/109、设备利用率约 70–102%，同时吞吐量只有约 4–7 MB/s。另一个设备 `nvme1n1` 写等待约 0.4–1 毫秒、队列很低；CPU 约 89% 空闲，没有 swap 活动，但有约 9–11 个 blocked 任务。这证明当时 `nvme0n1` 存在明显排队和写延迟，CPU 整体忙满并不符合该组样本。

进一步的 `findmnt /var/lib/etcd` 已确认挂载为 `/dev/nvme0n1p1[/mx-runtime/etcd]`、XFS：**etcd 确实位于出现异常写等待的 NVMe 上**。内核日志在 10 月 18 日主机本地时间约 19:53、23:20 多次记录 `nvme0` 的 I/O QID 7/9 timeout、aborting、Abort status 0，并有 hung-task 提示。日志证实设备 I/O 路径发生超时；Abort status 0 不能解释为原始 I/O 未受影响。这仍不足以区分硬件介质、控制器/固件、驱动、PCIe 链路或其他底层原因。需进一步核对设备健康、文件系统容量及独立备份状态，不能直接以业务重启或放大部署超时代替处理。

同批 `pidstat` 可见若干 PostgreSQL 进程写入，其中一个单秒样本约 560056 kB/s，其他样本约 5 MB/s 和 6–12 MB/s；尚未建立各进程的数据目录、挂载设备与 I/O 时间对应关系，不能据此认定某个 PostgreSQL 进程导致了 etcd 设备超时。

后续进程归属回执把突发写入 PID 64327 与 PID 64982、720960 关联到同一个 Kubernetes Pod UID `7022a2b6-7c56-4f8d-9fe2-b1d9c6e60c60`、同一容器，工作目录均为 `/var/lib/postgresql/data/pgdata`；另一个 PID 716800 已退出。这确认了几项写入样本的共同容器归属，随后 Pod UID 已确认为 `mx-common/mx-common-postgres-0`，即 Hub 使用的共享数据库。当时其数据目录的宿主机设备映射尚待核对，后续同盘证据见下文“共享 PostgreSQL 观测”。

后续 SMART 回执为 PASS，Critical Warning、Media/Data Integrity Errors、Error Information Log Entries 均为 0，Available Spare 100%，Percentage Used 2%；当前温度为 71°C，Warning Composite Temperature Time 累计 5 分钟。该报告没有给出可据以判断本次事件的温度阈值及降频时间对应关系，不能直接认定 71°C 导致了超时。SMART 未报告上述介质/关键健康错误，也不能推翻内核已经记录的 I/O 超时；smartmontools 的 NVMe PASS 判定来自 Critical Warning 字段，不能解释为整个 I/O 路径正常的保证。[smartmontools NVMe 状态输出实现](https://www.smartmontools.org/static/doxygen/nvmeprint_8cpp_source.html)

设备身份随后确认为 Lexar SSD NQ790 2TB、固件 `22788`。这些信息用于后续核对制造商资料，当前没有证据可把事件归为此型号或固件的已知缺陷。

容量回执显示 `nvme0` 约 1.9 TB、已用 623 GB（34%）；根卷 `cl-root` 约 1 TB、已用 927 GB（91%）、剩余约 98 GB。这不是 etcd 所在 NVMe 文件系统已满的证据；根卷空间偏紧应独立管理，不能据此随意清理容器或数据库文件。

同一 `nvme0` 还承载 `/data`、`/var/lib/mx-launcher`、containerd、kubelet、etcd 与 `mx-pay-postgres-data`。因此任何整盘迁移、服务批量重启或重装容器运行时都会涉及现有 MX-H2I 登录/联网及支付服务，不能当作 Hub 单服务修复执行。用户说明 NAS 当前用于 Delta 的大文件，Hub 尚未使用 NAS；两周前约 1 TB 的文件转移也不是已确认的 PostgreSQL/etcd 备份。用户对当前备份状态不确定；本次请求是为腾出的业务盘排查延迟，不包含从 NAS 还原旧数据的任务。NAS 已挂载在 `/mnt/nas`，另有两个 Delta media NFS 卷。

上述控制平面日志的时间窗口与约 UTC 14 时 Luopan/Delta 调 Hub 的 504 请求窗口不同。14 时的 Hub 后段数据库等待与 17 时的 etcd 延迟尚未证明有共同宿主机资源原因；二者应保留各自证据链，不能用此次 etcd 日志回填先前 Hub 账务 `unknown` 的原因或改写其结果。

## 共享 PostgreSQL 观测

UTC 17:32:15 的只读统计显示共享 PG 于 16:09:09 启动；Hub 17 个会话均为 idle/ClientRead，另有 Harbor 1 个 idle。后台 checkpointer 当时为 CheckpointWriteDelay。Hub 累计临时文件 8 个、124MB，不是该时刻正在产生 124MB 临时写入的证据。bgwriter 自 16:08:43 起累计 timed/requested checkpoints 6/19，checkpoint_write_time 4074765ms、sync_time 57962ms；写入时间包含主动分摊等待，不能全部解释为 I/O 阻塞。max_wal_size=1024MB、checkpoint_timeout=300s、completion_target=0.9、work_mem=32MB、track_io_timing=off。随后已确认该 PV 为 hostPath、位于 `/data` 的同一 nvme0n1p1 XFS；日志多次 `checkpoint starting: wal`，并在 17:15:59 报告 checkpoints 过于频繁（25 秒）。因此确认同盘 WAL 触发的 checkpoint 过频，存在可降低的 checkpoint 写入压力；这不等于 PostgreSQL 引发了 NVMe 底层超时。已提供操作者热加载命令：仅原值仍为 1024MB/300s 且非命令行强制配置时设置 max_wal_size=4GB、checkpoint_timeout=10min，保留 completion_target=0.9 和全部持久性设置；改动持久化在 PGDATA 的 postgresql.auto.conf，不需要数据库重启。代价为更多 WAL 保留及可能更长的异常恢复时间，max_wal_size 是软限制。回退为 1GB/5min 后 reload。操作者已执行并返回成功：两项 ALTER SYSTEM 完成、pg_reload_conf=true；新连接确认 max_wal_size=4096MB、checkpoint_timeout=600s、source=configuration file、pending_restart=false，completion_target仍为0.9。热调整已生效且无需重启；后续 I/O/控制器稳定性仍待回执，不能称 NVMe 已修好。[PG16 WAL 配置](https://www.postgresql.org/docs/16/wal-configuration.html)

## 热调整后的首轮观测

调整后约 2–3 分钟的四个 1 秒间隔样本：nvme0n1 w_await=4.32/2.84/6.07/3.19ms，aqu-sz=5.54/2.95/5.84/3.58；相较调整前数百至两千毫秒的等待明显降低。该变化是短时前后采样，不是硬件故障已消除或长期 p95 的证明，利用率仍约 76–83%。

此时 scheduler Ready=true、restart139、Lease 17:37:33Z；controller-manager Ready=false、restart136、上次退出17:35:07Z、Lease仍17:34:57Z。API Server/etcd为Ready。控制器尚未恢复，不能重试Hub部署；已请求只读等待其自动恢复并确认新Lease，不删除Pod、不手工重启控制平面。

## 后续回执：短时改善未持续

只读等待 controller-manager Ready 的 180 秒命令超时，但紧接的状态读取为 Ready=true、restart137、started17:41:21Z；当时它的 Lease 仍为17:34:57Z，scheduler Lease为17:39:17Z。等待截止后才启动并不矛盾，也不能仅凭 Ready 判断已接任。

UTC17:42:54 新回执确认 controller-manager 已续租至17:42:52.768944Z，缓存同步完成；scheduler Lease仍为17:39:17.977184Z，其日志明确17:39:18因失去租约退出。etcd同窗口仍记录6.827秒读请求和17:42:53的1.021秒 WAL fdatasync。因此热调虽已生效且有短时改善，控制面存储延迟尚未稳定，不能恢复Hub部署。

约17:46的Hub只读状态显示 telegram-monitor-messages active/running、processed_count=1864169，chats active/idle、20484；14个Night-All已存记录源及province-opinion-results当次均为idle。PG当次ingest、retrieval和api出现WALWrite等待，retrieval另有WALInitSync。这支持优先减少正在发生的Hub后台写入、观察共享WAL等待是否缓解；不能据此把NVMe底层超时单独归罪于TG或向量处理。准备使用现有源暂停机制在批次边界停止后续TG同步，并窄范围暂停后台向量化；尚未收到暂停执行回执。

已提供操作者两步限定减载：在Admin容器内以已有Admin凭据调用本机 `POST /internal/v1/admin/pipelines/telegram-monitor/status {status:paused}`，随后只读GET核对；以及有1秒锁等待、5秒语句上限的事务，仅将 `retrieval.settings` 单行的 `paused=false` 改成true并返回其他设置。凭据不输出，不改enabled、并发、预算、checkpoint、任务结果或账务。向量管理接口当前configure还会准备ES索引和唤醒预算等待队列，故暂停仅使用这个已有worker实时识别的开关。

验收要点：TG两源paused、游标退出running；retrieval后台非retire任务的running归零。已开始的批次/embedding允许完成，删除投影、心跳和轮询仍继续；暂停不等于零I/O。Public/canonical/已有向量查询不读取此暂停开关，新TG数据和新向量的可见性会延后。恢复走Internal正常管理入口：TG保留源合同/映射校验，retrieval保留无预算持续处理的worker健康门槛及必要的等待队列唤醒；不提供无条件SQL反向切换，也不把原已paused的设置当成恢复授权。没有缩容ingest：其旧Night-All backfill在abort时可能跳过续接，与已有external-pull的持久化续接机制不同，不能承诺整体停止后全部自动恢复。

操作者已执行上述暂停。TG POST和随后的独立GET均返回HTTP200、pipeline paused；chats/messages都为paused、cursor idle。retrieval原值为enabled=true、paused=false、max_concurrency=2、daily_token_budget=0（此处0表示不设日预算上限）；事务UPDATE1并COMMIT，updated_at=2026-10-18T17:51:14.930618Z，只把paused变为true。源批次已排空，向量在途任务数量和减载后的I/O/控制面状态仍待只读验收。不要因为这两步成功就声称线上故障已修复或自行恢复后台高负载。

UTC17:53:58的减载验收：非retire的running embedding=0；该时刻Hub的pg_stat_activity无其他active行。nvme0写等待三次为0.98/70.98/0.16ms，队列0.76/52.41/0.09；仍有间歇写入波动。controller-manager/scheduler均Ready=false，累计重启138/143，Lease停在17:52:20；etcd17:53:45仍有1.247秒health、1.875秒peerserverlease等慢读。TG与向量暂停达到了排空目标，但未足以恢复控制面；瞬时无active会话不代表没有PG后台checkpoint或其他业务I/O，也不能证明硬件健康或排除所有Hub写入。

随后主机最近10分钟的内核过滤命令未输出匹配的新NVMe timeout/reset/abort、I/O error、blocked或XFS错误；SMART当前温度67°C（此前71°C），传感器2为54°C，Critical Warning/介质错误/错误日志计数仍为0，历史warning温度时间仍5分钟。这只说明该采样窗口与过滤范围未看到新设备报错，不能替代etcd延迟和控制器持续续租验收。已请求间隔30秒的两轮Pod/Lease对照与etcd近期日志，应用部署仍暂缓。

## 本轮控制面恢复回执

UTC17:56:43与17:57:14两次采样中，scheduler均Ready=true、restart143不变，Lease由17:56:42推进至17:57:12；controller当时仍Ready=false/restart138，Lease17:52:20未动。同期最近一分钟的有限etcd日志过滤仅返回一条约117.98ms慢读，未返回此前秒级项。

随后只读等待成功：controller-manager Ready=true、restart139、started17:57:48Z。主机UTC17:58:45时，controller/scheduler Lease分别为17:58:44.332374Z和17:58:44.997869Z。这确认了本轮controller已重新启动并工作、scheduler持续续租；不是NVMe硬件已经修复或长期负载稳定的保证。减载后的先前采样已确认TG游标idle、embedding running0。

发布安排：保持TG与后台向量暂停，先同步已推送的Hub修复并走既有标准部署，继续设置 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`。遇到控制面再次失租或存储超时就停止发布，不强行删除Pod或绕过冻结。应用部署及部署后的canonical/Luopan验收仍未执行；通过之后再逐项恢复后台任务，观察一次只增加一种负载，不同时恢复所有积压。历史设备I/O超时仍保留为后续主机维护线索。

## 当前恢复边界

两项组件的本轮自动恢复已确认，后续持续负载稳定性仍需观察。已保留型号/固件和温度回执；若限定后台减载后仍持续超时，应进一步核对散热、驱动/固件与设备链路，不能继续仅靠放大数据库或部署超时。本次没有实施恢复旧数据、迁移业务盘、设备压测、固件更新或手工控制平面重启，不以备份核对作为这次热调与只读验收的前置流程。

## 本地部署脚本调整

`scripts/manage.sh` 保持原有 120 秒冻结等待总预算，改为逐阶段验证：

1. 在同一次显式读取中获取 Admin Deployment UID 和 resourceVersion；API 读取失败立即停止，只有确认对象不存在才按首次安装继续。
2. 带该 resourceVersion 前置条件提交目标副本数 0，防止读取后对象被替换仍缩容新对象；仅收到成功回执后记录本次冻结身份。冲突或响应未知时输出状态待核查，不迁移、不自动恢复、不重试 scale。成功后等待同一个 UID 的 Deployment `observedGeneration >= generation`，目标副本数仍为 0。
3. 等待当前及 Ready 副本数归零，并读取确认选择器下已经没有 Admin Pod。空列表是已停止的证据，无需再对不存在的 Pod 执行删除等待。
4. 仅全部成立才启动迁移。对象更换、目标副本数被改回、无法确认停止等情况均拒绝继续。

轮询读取每次最多 5 秒，并受剩余等待预算限制。输出 `controller_observation`、`replica_scale_down`、`pod_termination` 或读取失败阶段；失败仍先输出原有有限元数据，再尝试恢复本次冻结的 Admin。恢复前有限读取 UID、目标副本数及 resourceVersion；只对同一个 UID、仍为 0 的目标执行带 `--current-replicas=0` 和 `--resource-version` 前置条件的 scale。对象替换、外部扩容、读取失败或读写间发生版本冲突时停止恢复，不覆盖他人的修改，不无条件重试；原部署退出码保留。恢复 scale 请求成功不等于 Admin 已 Ready。

没有延长冻结等待的 120 秒预算（前置读写、诊断及恢复另有请求时限）、强制删除 Pod、绕过 Admin 冻结、重启控制平面、修改应用关闭逻辑或修改 Launcher/MX-H2I。脚本也不把特定发行版的静态 Pod 名称当成所有 Kubernetes 集群的部署门禁。

此调整改善部署确认和失败定位，不能治愈控制平面 CrashLoop。应先修复控制平面，确认控制器和调度器稳定运行、Lease 持续续租，再执行既有标准 Hub 部署；保留 `MX_INSIGHT_SYNC_LAUNCHER=0`、`MX_SMOKE_DATA=0`。本次失败发生在新迁移及应用滚动发布之前，不能据此宣称待发布修复已上线。

## 验证

完整 shell 回归 166/166 通过，含 23 项冻结与 EXIT 恢复场景；语法及差异检查通过。

离线 `tests/admin-freeze.test.sh` 覆盖控制器不观察、逐阶段收敛、Pod 已消失、Pod 仍终止中、缺省零副本状态、对象替换、外部重新扩容、无效状态、对象消失、API 持续失败及暂时失败；另以真实 `apply_k8s → die → EXIT` 路径验证同 UID 恢复、替换/扩容/读取失败拒绝写入、恢复 resourceVersion 冲突不重试、初次 scale 冲突/对象替换/响应未知不取得恢复权，以及保留失败退出码。既有 `tests/manage-script.test.sh` 同时验证失败前未执行迁移、原有诊断隐私边界及 Admin 恢复行为；新测试已接入该入口。

Kubernetes 的 desired/current 分别描述目标和观察状态，scale 写入成功并不是停止完成：[Scale API](https://kubernetes.io/docs/reference/kubernetes-api/definitions/scale-v1-autoscaling/)。强制删除不等待实际进程停止，不能作为迁移写入冻结的证明：[kubectl delete](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_delete/)。

## 发布续检：部署锁与镜像缓存

恢复后的首次重试在取得部署进程锁前退出。随后操作者读取到锁文件设备号 `fd00`、inode `1614009922`，同次提供的内核锁表没有 `fd:00:1614009922`；只确认该次采样未见目标锁，不推断最初持锁者。未删除锁文件或终止部署进程。再次标准部署已通过锁与凭据连续性检查，进入 mx-common 预加载；最后输出 `using cached Docker image: docker.elastic.co/elasticsearch/elasticsearch:9.4.2`。该行之后是 `docker image save | ctr -n k8s.io images import -`，原脚本没有阶段进度，不能仅凭无输出判断进程卡死。

本地确认缓存检测存在独立缺陷：`pipefail` 下的 `ctr images ls -q | grep -Fqx` 在长列表前部命中后提前关闭管道，生产者返回 SIGPIPE，导致已缓存镜像被误判为缺失。root/sudo 两分支均可复现。修复仅移除 grep 的 `-q` 并丢弃标准输出，让它消费完整列表；保留精确镜像引用匹配和实际 ctr 失败的非零退出码。真正需要导入时增加导出/解包阶段提示。新增回归在旧代码失败，修复后 storage-preflight 25/25 通过，语法与差异检查通过。此缺陷可导致重复导入，现场这一次是否由它触发尚待进程与缓存回执，不能归因于新的 ES 数据索引或供应商搜索。

当前部署窗口继续保留，另一个终端只读查看 docker/ctr 状态及完整消费镜像列表。不要并发开始第二次部署或删除缓存。若后续考虑 `MX_COMMON_AUTO_PRELOAD=0`，先确认本机 containerd `k8s.io` 已有配置所需的目标镜像；它只影响下一次运行，ES API healthy 本身不是镜像引用齐备的证据。TG/向量后台暂停仍保持，应用发布成功尚未确认。
