# Internal 服务器存储超时与部署故障交接记录（2026-10-19）

问题编号：`INTERNAL-STORAGE-DEPLOY-20261019`。状态：**未结案**。

本文件汇总截至 2026-10-19 本轮对话及仓库专题文档中的证据，作为下一次排查入口。服务器操作由用户执行并回传结果；本轮开发侧没有直接连接生产服务器。下面的“已通过”只代表对应采样或操作完成时的状态，不是当前实时健康保证。UTC 时间保留 `Z`；明确换算的北京时间为 UTC+8，未给出准确时间的回执不补造时间顺序。

## 下次直接引用

可以直接提出：

> 继续处理 `INTERNAL-STORAGE-DEPLOY-20261019`。先读 `electron-dock/mx-launcher/docs/51-internal-server-storage-deploy-incident-2026-10-19.md`，从“下一步排查顺序”继续。etcd 已迁到系统盘，重点核验 nvme0 I/O timeout、数据库实际挂载与上游写入、Launcher/Hub 最新部署结果；保持 MX-H2I 现有登录和联网，不默认重启、停库或重新迁移。

后续将新证据追加到本文末尾，并更新状态表；不要把历史快照覆盖成“始终正常”或“当前仍故障”。

## 1. 当前结论与未完成项

| 项目 | 已确认的事实 | 尚未确认 / 后续边界 |
| --- | --- | --- |
| 数据盘 | `/dev/nvme0n1p1` 的采样使用率约 34%；有秒级写等待和内核 NVMe I/O timeout | 不是容量已满；尚未确定介质、控制器、固件、驱动、PCIe、散热或负载各自贡献 |
| etcd | 已迁到另一物理盘的根逻辑卷；迁移事务 complete，挂载、启动保护、API/节点检查通过 | 未做整机重启或坏盘恢复演练；没有确认定期异机备份 |
| Launcher 发布 | 一次 deploy 在 528.68 秒后 exit=1；后查两个身份 Pod Ready、迁移 Completed，主 API 仍是此前实例 | 缺原部署窗口最终错误，不能断言具体失败命令；没有本次完整成功重部署回执 |
| Hub | 历史有 504、控制器失租/CrashLoop、Admin 冻结失败；也有阶段性恢复 | 后续又一次失败只确认 Admin desired 恢复为 1，未确认 Ready；504 是否消失及后台当前状态未验收 |
| DataPort | `AlreadyExists` 阻止取得部署锁；用户随后显式恢复，旧锁已释放 | 没有释放后部署成功回执；新自动解锁逻辑仅本地实现 |
| Pay | PG 启动权限修复已写入 StatefulSet 模板，旧 Pod 保持运行 | OnDelete 下旧 Pod 尚未采用新命令，不能称重建风险已验收 |
| MX-H2I | etcd 迁移后的配置/凭据连续性检查通过，未进行强制全栈重启 | 不代替真实用户登录、飞书授权、客户端联网验收 |
| 认证链路（晚间追加） | 慢请求卡在 Launcher `identity/introspect`（2.2–6.2 s），库内等 WALWrite/WALSync；Compass 每个请求都调 introspect；Launcher PG 限 1 CPU/1Gi；单副本 readiness 查库 | 代码已本地改（见第 12 节），未提交、未部署；`e367349d` 是否在线、PG 是否 CPU 节流待现场回执 |

当前最强证据是**数据盘 I/O 路径发生异常延迟**。etcd 搬离后控制面获得了存储隔离，但没有搬走其他数据库及容器数据，也没有修复原盘。DataPort 锁冲突是另一个明确的发布阻塞点；不能把所有失败都归为 etcd、代理或同一服务。

## 2. 必须保留的业务边界

- 不影响现有 MX-H2I 登录、SSO 身份及用户联网；不重建集群身份、用户、密钥、CA、issuer、网络租约或 VPN/路由。
- 不默认强制重启 Launcher 全体、删除 Pod、停止 PostgreSQL、重启 containerd/Docker/kubelet、运行旧迁移脚本或迁移整盘。此前这些动作没有作为本轮修复执行。
- 不把 `ops internal-production apply` 当作失败发布的安全续跑入口；它与完整 deploy 的身份、锁和恢复检查不同。后续发布仍按各项目原完整入口进行。
- Hub 独立部署保持 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`；Pay 保持独立支付数据库及凭据。
- 暂停后台任务也须先确定所属应用、在途任务和恢复条件；不凭 `postgres` 进程名、UID 或历史 PID 停库。不开生产压力测试，不通过重复付费请求验证 504。

## 3. 主机、集群与磁盘基线

### 3.1 主机与运行时

| 字段 | 本轮已知值 |
| --- | --- |
| 主机 / Kubernetes 节点 | `mx-internal-server` |
| Internal IP | `192.168.1.2` |
| kubeconfig / context | `/etc/kubernetes/admin.conf` / `kubernetes-admin@kubernetes` |
| Kubernetes 集群 UID | `399f2349-3a34-48f4-8105-d7bae56ca136` |
| containerd CRI endpoint | `unix:///run/containerd/containerd.sock` |
| etcd 版本 | `3.6.8`，单 member 迁移工具已通过拓扑检查 |
| 迁移前 etcd cluster/member ID | `6487051369918182888` / `2437189412692380418` |
| 迁移前 revision | `3600342`，这是历史值，不是现在应固定的 revision |
| 内核 / CPU 数 | `4.18.0-348.7.1.el8_5.x86_64` / `128 CPU`（iostat 回执） |

用户执行目录形如 `/root/mx/workspace/de-llaaddddeerr/electron-dock`；开发机仓库为 `/Users/qpjoy/workspace/qpjoy/de/de-llaaddddeerr`。服务器命令应在服务器执行，不能把开发机路径当成生产目录。

### 3.2 两块物理盘，而不是一块 1T 加一块 2T

| 物理盘 / 文件系统 | 布局与用途 | 当时容量快照 |
| --- | --- | --- |
| `nvme0n1` → `nvme0n1p1`，XFS | `/data`；原 etcd 位于 `/data/mx-runtime/etcd` | 总量 `1999421038592` B，已用 `679755472896` B，可用 `1319665565696` B，约 34% |
| `nvme1n1` → LVM `cl-root`，XFS | `/`；现在承载活动 etcd | 总量 `1098974756864` B，已用 `996199931904` B，可用 `102774824960` B，约 91% / 95.7 GiB 可用；稍后 plan 四舍五入显示 96.0 GiB |
| 同一 `nvme1n1` → LVM `cl-home` | `/home`，另有 16G swap、boot/EFI 分区 | `cl-home` 约 821.4G；不是另一块物理盘 |

两块物理盘的 `lsblk` 都约 1.8T。此前称“1T 盘”实际上是 `cl-root` 逻辑卷。清理 `/home` 不会直接增加 `/` 的文件系统可用空间，放到 `/home` 也不增加物理故障域。

- 数据盘 UUID：`45fa3b72-5a59-4d3c-9a57-4f61aee13e5e`。
- 根卷 UUID：`ea7e456d-19db-4f6e-b8b0-02c00f59d066`。
- 设备名可能随环境变化；后续以 UUID、挂载、物理父盘共同核对，不仅看 `nvme0`/`nvme1`。
- 根文件系统目录体积采样中 `/shared_media` 约 `790G`、`/var` 约 `69G`、`/usr` 约 `34G`、`/shared_dir` 约 `16G`。`/shared_media` 有正式媒体存储用途，未证明全部已迁移或可删，不能当缓存清理。
- 当前剩余空间不支持直接把整个 `/data` 或所有数据库/ES 搬入根卷。即使以后腾出空间，也须分别核算数据、WAL、镜像、备份、增长与临时副本，不能据此默认整盘迁移。

早期 Hub 现场记录还确认数据盘承载 Launcher、containerd、kubelet、Pay 等挂载。此后已确认的存储变更是 etcd；各数据库、Docker 卷和 ES 的**当前**具体来源仍须逐一复查，不能仅凭容器运行时目录推定数据库位置。

## 4. 已完成的 etcd 迁移与恢复边界

用户执行 `mx-base/mx-move` 的迁移，保留旧目录、在线 snapshot、完整冷副本和事务记录；没有执行清理旧副本。

```text
原目录：/data/mx-runtime/etcd
稳定访问路径：/var/lib/etcd
新活动目录：/var/lib/mx-move/etcd-data/mx-etcd-20261019-181949-157ad6a7
本次事务/备份：/var/lib/mx-move/runs/20261019-181949-157ad6a7
事务指针：/var/lib/mx-move/current.json
活动身份：/var/lib/mx-move/active-etcd.json
启动检查：/var/lib/mx-move/boot-guard.py
```

迁移前 etcd 约 `400855401` B（约 382 MiB）。plan 的副本/备份预算为 `2.12 GiB`，另保留 `50 GiB`。此前的 10% 空间门槛已改为固定 50 GiB；它是迁移工具的空间规则，不是 kubelet 的 DiskPressure 阈值。

用户随后回传：

- `direction=migrate`、`phase=complete`、`may_write=true`。
- `/var/lib/etcd` bind 到 `/dev/mapper/cl-root` 上的新活动目录，UUID 与根卷一致。
- `mx-move etcd 启动检查通过`；API `/readyz?verbose` 包含 etcd/etcd-readiness 全部通过。
- `Ready=True`；NetworkUnavailable/MemoryPressure/DiskPressure/PIDPressure 均为 False。
- 迁移日志提示一个容器 ID 变化；[mx-move 后续记录](../../mx-base/mx-move/README.md#迁移后验收与后续部署)确认旧 ID `32416fd845036…` 是 kube-apiserver，不能把该统计名称解读为某个 MX-H2I 业务容器必然被重启。真实业务验收仍未由这项统计替代。

`may_write=true` 表示新副本可能已接收新写入，不能直接挂回旧目录。需要正常回滚时，专用 `etcd rollback` 会把**当前最新活动数据**复制到原盘的新目录后切换；它要求当前集群健康、原盘身份及空间可验证。原盘仍有 I/O 超时时，不应把回滚当作解决超时的方法。

中断恢复由 `etcd resume` 根据事务记录决定：尚未允许新副本写入时可恢复原源；已可能写入时只恢复/验收新副本，不能自动使用历史目录。当前迁移已完成，不要为了“再验收”运行 migrate、resume 或迁移前的 plan；只读 status、挂载及实时健康检查即可。

本次 mx-move 工具留存的快照、PKI、身份备份与活动 etcd 都在同一系统物理盘，这些本地备份不抵御该盘损坏；其他既有备份的位置与可恢复性尚未全面核验。旧 `/data/mx-runtime/etcd` 不再更新。etcd 也不包含 PostgreSQL 表、ES 索引或 Docker 镜像。完整流程及已修复的 CRI 参数、`/data` 所有权核验、空间和启动保护问题以 [mx-move README](../../mx-base/mx-move/README.md) 为准。

## 5. Launcher 发布失败与磁盘证据

### 5.1 发布窗口与观察

用户运行：`PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy mx-launcher`。

统一入口记录：

```json
{
  "project": "mx-launcher",
  "action": "deploy",
  "phase": "child_failed",
  "startedAt": "2026-10-19T12:03:46.830225Z",
  "exitCode": 1,
  "elapsedSeconds": 528.68,
  "finishedAt": "2026-10-19T12:12:35.512624Z"
}
```

即北京时间约 `20:03:46–20:12:35`。截图显示构建完成、导入 containerd、PG ClusterIP 探测成功、迁移执行，约 345 秒进入身份发布并输出 Nginx 回源配置生成。后续回执中：

- `mx-identity`、`mx-identity-public` 均为 1/1 Ready，Pod 当时约 2–3 分钟。
- `mx-launcher-migrate-*` Completed。
- `mx-launcher-internal` 仍为此前约 3 小时的 Pod，不能说主 API 已成功更新。
- PG 的 `pg_isready` 3 秒 liveness/readiness 超时，主 API readiness 曾超时；新身份 Pod 曾有启动期 connection refused，后续 Ready。

身份发布先等公网 identity，再等内网 identity，各 180 秒。总耗时与进入身份阶段的差值接近一次 180 秒超时，**公网身份 rollout 超时是推测，不是已确认的最终错误**。仍缺原窗口末尾日志。Kubernetes 可以在脚本超时退出后继续协调，因此稍后 Pod Ready 不代表脚本恢复执行。

仓库已补上身份资源应用、rollout 阶段、耗时及等待进度；保留原顺序、180 秒期限和 Secret 输出保护。统一入口每 15 秒的计时是整次部署累计时间，不是当前阶段，也不是自动重试。进度补丁的现场使用版本及后续成功发布仍待确认，详见 [身份发布专题](37-managed-internal-identity.md#身份发布长时间等待2026-10-19)。

### 5.2 设备延迟和内核日志

后续两个 1 秒区间样本：

| 设备 | w_await | aqu-sz | 写吞吐 | 对照意义 |
| --- | --- | --- | --- | --- |
| nvme0n1，第 1 区间 | `1742.62 ms` | `399.06` | `5512 KiB/s` | 数据盘严重排队 |
| nvme0n1，第 2 区间 | `426.77 ms` | `251.80` | `6695.50 KiB/s` | 延迟仍高 |
| nvme1n1，同两区间 | `0.57 / 0.23 ms` | `0.01 / 0.01` | `1056 / 656.50 KiB/s` | 系统盘当时延迟低 |

`iostat` 第一份报告是开机以来平均值，不能与后续区间混为一谈；其中 `%util` 曾超过 100%，不将它作为 NVMe 性能上限的单独证据。`vmstat` 后两个样本 CPU idle 84–90%、无 swap 活动、blocked 任务 3–4；这不支持当时 CPU 整体忙满，也不构成完整内存健康证明。

同一次 Launcher 部署窗口内，内核在主机本地 `20:06:21–20:06:29` 多次记录：

```text
nvme nvme0: I/O ... QID 7 timeout, aborting
nvme nvme0: I/O ... QID 6 timeout, aborting
nvme nvme0: I/O ... QID 1 timeout, aborting
nvme nvme0: I/O ... QID 16 timeout, aborting
nvme nvme0: I/O ... QID 11 timeout, aborting
nvme nvme0: Abort status: 0x0
```

这确认设备 I/O 路径异常；`Abort status: 0x0` 不能解释为原 I/O 正常。最新 SMART 回执为 59°C、available_spare=100%、percentage_used=2%、critical_warning/media_errors/num_err_log_entries 均 0、历史 Warning Temperature Time=5 分钟、T1/T2 热管理计数及时间均 0。早期专题另记录型号 Lexar NQ790 2TB、固件 22788 和更高温度，属于历史识别信息，后续须按实际设备核对。

没有足够证据确认介质损坏、当前热降频或某个型号的固件缺陷；SMART 没报错也不能推翻内核 timeout。不能把 5–7 MiB/s 的短时吞吐直接解释成磁盘带宽上限。

### 5.3 写入进程已映射到哪里

`20:20` 的 3 秒 pidstat 与后续 cgroup/容器输出建立了以下关联。PID 和容器 ID 只作历史证据，下一次重新采样，不复用历史 PID 执行操作。

| 当时 PID | 平均写入约 KiB/s | 已确认归属 |
| --- | --- | --- |
| `1504395` | `6830.77` | Docker `mx_data-postgres-1`，CID 前缀 `adbbf32d07a0`，postgres:16-alpine |
| `3847049` / `3847066` | `2423.08` / `1435.90` | Docker `delta_59202-postgres-1`，CID 前缀 `01b133092f15`，postgres:16-alpine |
| `916024` | `1548.72` | 宿主机 `postgresql-16.service` |
| `3477454` | 一次 `26880`，采样平均 `8615.38` | 随后已退出，归属未知 |
| `2440738` | `33.33` | etcd |

上述两个 Docker PG 不属于本次查询中的 Kubernetes Launcher/mx-common/Pay/Rig PG 容器。已见 Kubernetes PG：`mx-common/mx-common-postgres-0`、`mx-internal-shadow/mx-internal-postgres-0`、`mx-pay/mx-pay-postgres-0`、`mx-rig/mx-rig-postgres-0`。

[历史 NAS 部署身份记录](../../mx-base/mx-static/nas_docs/evidence/2026-09-22-live-findings.md)将这两个 Docker 名称对应到两套 po-infra/Delta Compose 安装。媒体迁移不等于 PG 迁移；其**当前数据卷设备与产生写入的上游 worker/任务尚未核实**。宿主 PostgreSQL 的业务归属也待核验。不同时间的进程/设备样本不能相加推定某个进程造成全部 I/O，也未据此暂停任何数据库。

## 6. Hub 历史 504 与控制面故障应分开看

[504 专题](../../mx-insight-hub/docs/operations/hub-504-2026-10-18.md)记录 66 个 Delta 任务中的 56 个 504；部分供应方请求本身约 2.8–3.7 秒，后续 Hub 持久化/交付链路有长尾。另有连接获取、事务锁序等软件风险及修复记录。请求结果可能已提交或仍为 unknown，不能把 504 当成“没有执行”重复付费调用。

[Admin 冻结/控制面专题](../../mx-insight-hub/docs/operations/admin-freeze-controller-2026-10-19.md)记录了不同阶段：

1. Admin desired=0 但控制器未观察，controller-manager/scheduler CrashLoop/失租；当时 etcd 与 PG 同盘，etcd WAL fdatasync 曾达 1.519 秒，数据盘有 NVMe timeout。
2. 用户热调共享 PG：`max_wal_size=1GB → 4GB`、`checkpoint_timeout=5min → 10min`，reload 成功、pending_restart=false，保留持久性设置。短时 I/O 改善不能当作设备已修复。
3. 用户限定暂停 TG 和后台向量任务并排空；控制器/调度器后来恢复续租。该历史暂停状态不代表现在仍暂停，也不是长期停止采集的目标。
4. 有一次用户确认等待镜像导入后部署完成；之后又有一次 Admin 冻结/API 失联失败。最后那次仅确认带条件恢复 desired=1，未取得 Ready 回执。

这些窗口不能混为一次事故；更晚的 Pod/数据库重启和本次 Launcher 磁盘采样不能直接证明更早 56 个 504 的全部根因。Hub 当前 Admin/worker 状态和实际请求性能需新证据。持续采集和读写隔离的方向见 [后续架构建议](../../mx-insight-hub/docs/operations/continuous-ingest-read-isolation-2026-10-19.md)。

## 7. DataPort 部署锁：已释放的旧锁与尚未上线的新逻辑

DataPort 一次统一 deploy 在约 `0.42s` 内退出，API/etcd/node 预检通过，失败原因是 `mx-harbor/mx-harbor-deploy-lock` 已存在。它发生在取得项目锁之前，尚未开始本次构建、迁移或发布，不是代理构建错误，也不是 Launcher 锁。

旧锁回执为 `action=deploy`、created=`2026-10-19T05:43:48Z`、ownerHost=`mx-internal-server`、ownerPid=`3545685`。用户先运行默认只读 recover-lock，得到 processes=[]、12 个迁移 Job active=0/terminal=true、对应 Pod 全为 Succeeded；随后显式 `--confirm-idle` 成功，返回“遗留部署锁已释放”。本次旧锁是**手动核验后释放**，不是由新自动逻辑处理。

锁用于串行化 DataPort deploy/migrate/enroll，正常由脚本创建和删除；它不是 PG 表锁，不会因存在而主动停止在线服务。进程异常退出或 API 清理失败可能留锁，但缺上次任务退出与解锁日志，不能确定与磁盘卡顿的因果关系。

本地新脚本增加有限自动恢复：

- 新 deploy 锁记录 `recoveryVersion=1`、`recoveryState=active`；只有镜像、迁移、rollout、ready 全部成功后才标记 `releasable`。
- 下次明确收到本锁 AlreadyExists 后，还须确认同机原 PID 已退出、除自身外无相关操作进程、迁移 Job/Pod 已终止，才按 UID/resourceVersion 删除，确认旧锁消失并重新取锁一次。
- 旧格式、失败/中断、enroll、活动任务或无法验证的锁不自动删除；不按锁龄强删，不自动重跑失败部署。
- 临时目录先于取锁创建，避免临时目录创建失败直接留下锁。

54 项相关本地测试通过；完整前端构建因本地缺 `xlsx`、`exceljs` 及派生类型错误未通过。本轮没有修改前端或安装依赖。**新逻辑尚无生产执行回执**，同步宿主脚本后才可能在后续 deploy 中生效；原命令不变。详见 [DataPort 运维说明](../../mx-dataport/docs/implementation-and-operations.md#deploy-自动恢复部署锁2026-10-19)。

## 8. Pay、Rig 与各项目的部署边界

Pay 最初的模板与 Pod 字符串检查均为 `pgdata_mode_guard=False`。用户随后执行专用模板修复，回传：

```text
strategy=OnDelete
templateGuard=known-current
podGuard=known-legacy
podUID=2518112c-3f66-48f6-857d-1e7b58072aac
result=template-updated
patchResponseConfirmed=true
originalPodStillPresent=true
podRecreationNeededForGuard=true
restartsPod=false
changesDatabaseData=false
```

备份在当时 Pay 项目 `.deploy/postgres-permissions-Dl797N`，仅 StatefulSet 元数据，不是订单数据库备份。模板修复已完成；旧 Pod 的进程重启也不会自动加载新模板。后续应在 Pay 维护窗口先备份数据库、核对模板与身份，再按专用流程重建/验收，不能为验证此补丁现在直接重启支付库。参见 [Pay 重启持久化记录](../../mx-base/mx-pay/README.md#重启持久化与存量系统)。

Rig 在仓库检查中另发现 init 容器只有 CHOWN、可能无法遍历既有 0700 PGDATA，已局部补 DAC_OVERRIDE；这是不同于 Pay 的问题。未取得生产重建验收，普通 Rig deploy 的模板变化可能滚动重建数据库，应按 [Rig 运维文档](../../mx-rig/docs/03-operations.md)安排。

| 项目 | 部署与存储边界 |
| --- | --- |
| Launcher | K8s、自有 PG；常规 deploy 不改 etcd 挂载，但会更新登录/网络相关组件，不能承诺发布零中断 |
| Hub | K8s，使用 mx-common；正常 deploy 包含 mx-common ensure，模板差异可能更新共享 PG/ES |
| DataPort | K8s，保留旧 `mx-harbor` 标识，使用共享 PG 中的独立产品库；单副本 Recreate；deploy 不运行 enroll、不发布其他应用 |
| Pay | K8s、独立 PG；普通 deploy 保留已有 PG StatefulSet/Pod，应用流程含自身迁移与 checkout 暂停/恢复 |
| Device | 当前脚本是 Docker Compose，**不经过 Kubernetes/etcd**；排空自己的 worker，更新自己的 API/worker，保留既有 PG |
| Rig | K8s 测试中心，整合旧 mx-auto-server/mx-test-framework；模板变化可能更新自有 PG |

本轮 Kubernetes 回执证明所列 namespace 在同一被查询集群内，DataPort/Launcher 记录的 cluster UID 一致。不同项目或 namespace 不意味着独立 etcd；各项目最终目标仍要以保留配置核验。普通部署继续走 [统一入口](../../README.md)，不改现有集群 UID、hostname 或 IP 来绕过保护。

统一入口在服务器 `electron-dock` 目录使用 `PROXY=127.0.0.1:7788 bash scripts/manage.sh deploy <项目名>`。每次一个项目；`*` 只是主机占位，不能原样用作连接地址。构建代理不改变 MX-H2I 用户出网。统一入口本机锁与各项目锁是两层检查；入口通过 API/节点预检不等于磁盘延迟正常。

## 9. 下一步排查顺序

1. **更新时间和状态**：读取最近 Launcher/DataPort 部署结果，核验 etcd 当前挂载/guard、API/节点及 Hub/Launcher Pod。补原 Launcher 失败末尾日志或后续成功回执，不直接重跑 deploy。
2. **同窗采样**：同时段观察 iostat、pidstat、内核报错，判断 nvme0 timeout 是否继续、是否只在某类写入/发布时出现；不拿一次 SMART 正常作为结案依据。
3. **补齐存储与业务归属**：读取两个 Docker PG 的 Mounts 和实际 findmnt；确定宿主 PostgreSQL 数据目录、客户端/上游 worker 所属项目。为后续减载限定对象，不先停库。
4. **先确定可恢复性，再选择维修/隔离方案**：核实 Launcher、mx-common、Pay 等各自有效备份，增加异机副本与恢复演练。设备根因调查包括实际型号/固件、内核/NVMe 错误记录及 PCIe/散热线索；固件升级、参数修改和设备替换另做维护计划。
5. **需要减载时只调整已确认的后台生产者**：保留前台、登录、支付和网络；观察延迟/错误、迁移/请求结果及积压变化。Hub TG/向量是否仍暂停先读当前状态，恢复应分项低速进行。
6. **稳定后再逐项目发布及验收**：先有控制面持续健康、设备无新异常的观察，再运行相应完整部署，核验目标版本、业务状态和登录/联网。没有证据支持用 Launcher 全体强制重启解除 DataPort 锁。

长期方向仍是健康本地存储隔离、持续负载治理及异机备份。美国同配置 VPS 可作为异步灾备/备份和受限后台读取节点；它不能直接修复本地主库 WAL 落盘，也不能只复制 Hub 就恢复 Launcher/Pay/MX-H2I。备库不等于历史备份，同机多开 ES 节点也不增加物理磁盘能力。上述仍为规划，未执行海外迁移、自动主备切换或整盘迁移。

## 10. 下次可复制的只读检查

以下在原 Internal 服务器执行。每组按需运行，不循环刷屏；API 不可达时转主机本地采样，不以空输出当作没有资源。不要回传 Secret、完整 inspect/环境变量、数据库内容、证书或备份文件。

### 10.1 时间、活动挂载与控制面

```bash
date -Is
findmnt -T /var/lib/etcd -o TARGET,SOURCE,UUID,FSROOT,OPTIONS
df -B1 / /data /var/lib/etcd
lsblk -o NAME,SIZE,TYPE,FSTYPE,MOUNTPOINT
python3 -I /var/lib/mx-move/boot-guard.py --record /var/lib/mx-move/active-etcd.json
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get --raw='/readyz?verbose'
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get node mx-internal-server -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}'
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s -n kube-system get pods -o wide
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s -n kube-system get leases -o 'custom-columns=NAME:.metadata.name,HOLDER:.spec.holderIdentity,RENEW:.spec.renewTime'
```

对最后两条间隔约 30 秒再读一轮，比较 controller-manager/scheduler 的 Pod Ready、重启次数与 Lease 续租是否推进。一次 API readyz/Node Ready 不能代替这项持续工作检查；Lease 查询失败也不能当作 Lease 不存在。

在 `electron-dock` 目录查看迁移记录：`bash scripts/manage.sh etcd status`。它只读取事务，不能代替以上实时检查。

### 10.2 应用状态与最近部署结果

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s -n mx-internal-shadow get deployment mx-identity mx-identity-public mx-launcher-internal -o wide
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s -n mx-internal-shadow get pods -o wide
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s -n mx-internal-shadow get events --field-selector type=Warning --sort-by=.metadata.creationTimestamp
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get pods -A -o wide
```

统一入口结果文件是执行该命令的用户私有文件；本次为 root 的 `/root/.local/state/mx-electron-dock`。下面只显示已知结果字段，不读取业务配置：

```bash
python3 - <<'PY'
import json, os, pathlib
d = pathlib.Path(os.environ.get('MX_MANAGE_STATE_DIR', str(pathlib.Path.home() / '.local/state/mx-electron-dock')))
keys = ('project', 'action', 'phase', 'startedAt', 'preflightTarget', 'exitCode', 'elapsedSeconds', 'finishedAt')
for name in ('mx-launcher', 'mx-insight-hub', 'mx-dataport'):
    files = sorted(d.glob(name + '-*.json'), key=lambda p: p.stat().st_mtime)
    if not files:
        print(name + ': 未找到部署记录')
        continue
    value = json.loads(files[-1].read_text())
    print(json.dumps({k: value[k] for k in keys if k in value}, ensure_ascii=False, indent=2))
PY
```

### 10.3 同窗设备与进程采样

先开两个终端，在接近同一时间运行前两条。iostat 的 `-y` 跳过开机以来累计报告；10 秒短样本不能代替持续稳定性观察。

```bash
if command -v iostat >/dev/null 2>&1; then iostat -dx -y 1 10; else echo '未安装 iostat'; fi
if command -v pidstat >/dev/null 2>&1; then pidstat -d 1 10; else echo '未安装 pidstat'; fi
journalctl -k --since '-30 min' --no-pager | grep -Ei 'nvme|I/O error|reset|abort|timeout|blocked for|hung task|XFS.*error' | tail -n 80
```

按最新 lsblk 对应的设备读取 SMART，不根据历史设备序号猜盘；若映射仍相同：

```bash
if command -v nvme >/dev/null 2>&1; then nvme smart-log /dev/nvme0; elif command -v smartctl >/dev/null 2>&1; then smartctl -a /dev/nvme0n1; else echo '未安装 NVMe/SMART 查询工具'; fi
```

### 10.4 Docker 数据库挂载

```bash
docker ps --no-trunc --format '{{.ID}} {{.Names}} {{.Image}}' | grep -Ei 'postgres|pgvector|pgsql'
docker inspect --format '{{.Name}}{{range .Mounts}}{{printf "\n  type=%s source=%s destination=%s" .Type .Source .Destination}}{{end}}' mx_data-postgres-1 delta_59202-postgres-1
```

这只输出容器身份与 Mounts，不打印 Env。然后对实际数据挂载的宿主 `source` 单独执行 `findmnt -T <实际路径> -o TARGET,SOURCE,UUID,FSTYPE,FSROOT`；容器不存在时保留报错并按最新清单重新定位。宿主 PostgreSQL 的数据目录及上游业务另行只读核验，不复制包含连接密码的完整进程参数或 service 环境。

DataPort 若再次报锁冲突，在 `electron-dock` 目录先运行默认只读命令：

```bash
KUBECONFIG=/etc/kubernetes/admin.conf bash mx-dataport/scripts/manage.sh ops internal-production recover-lock
```

这里不默认追加 `--confirm-idle`，也不以旧回执代替新检查。

## 11. 证据入口与后续追加格式

| 来源 | 用途 |
| --- | --- |
| 本轮用户粘贴的 plan/status/findmnt/readyz/df/lsblk、部署 JSON、iostat/pidstat/cgroup/SMART/内核输出 | 本文数值和动作回执的直接来源；原截图仍在对话中，不依赖临时截图路径作为长期文档链接 |
| [mx-move](../../mx-base/mx-move/README.md) | etcd 迁移、备份、回滚、中断恢复、启动保护及跨项目部署审查 |
| [Launcher 身份发布](37-managed-internal-identity.md) | 528.68 秒发布失败、阶段进度及身份保护 |
| [统一管理入口](../../README.md) | PROXY、逐项目发布、预检、互斥与结果文件 |
| [Hub 504](../../mx-insight-hub/docs/operations/hub-504-2026-10-18.md) | 原请求及持久化/未知结果证据；原 `/tmp/hub_504_2026-10-18/README.md` 是现场材料，不保证在新环境仍存在 |
| [Hub 控制面/冻结故障](../../mx-insight-hub/docs/operations/admin-freeze-controller-2026-10-19.md) | 历史热调、减载、恢复及再次失败的分阶段记录 |
| [持续采集与读写隔离](../../mx-insight-hub/docs/operations/continuous-ingest-read-isolation-2026-10-19.md) | 后续架构方向，不能当作已上线能力 |
| [DataPort 运维](../../mx-dataport/docs/implementation-and-operations.md) | 旧锁显式恢复与新版有条件自动恢复 |
| [Pay](../../mx-base/mx-pay/README.md) / [Rig](../../mx-rig/docs/03-operations.md) | 数据库重建权限修复与上线边界 |

后续每次追加至少记录：时间与时区、目标主机/集群、执行命令或改动范围、有限脱敏输出、已确认结果、仍未确认事项、是否有写入/重启及恢复措施。生产回执与本地测试分开记录。结案须分别验收设备持续稳定、相关发布结果及实际业务；不以某一次 Ready、SMART 正常或部署退出码 0 统一结案。

## 12. 2026-10-19 晚：认证链路、6443 与减压（追加）

### 12.1 证据与结论

用户回传（时间以截图为准）：慢请求中大量调用卡在 MX Launcher `10.88.88.88:18090/.../identity/introspect`，读超时后返回 503；同机访问 Compass 入口与后端的无鉴权请求约 1 ms 返回。继续追到 Launcher 内部：每次认证都等待一条审计写库；现场数据库多条请求在等 `WALWrite/WALSync`；单独调用认证接口复现 2.2–6.2 秒，而 TCP 建连约 0.2 ms。

代码核对（开发机仓库，未连接生产）：

1. **调用量**：Compass 后端（`/Users/qpjoy/workspace/mingxi/po-backend-java`）的 `AuthInterceptor` 对**每个**业务请求调用 `MxLauncherAuthServiceImpl.validateToken` → `/internal/v1/sdk/identity/introspect`，没有缓存。业务 QPS 与 introspect QPS 是 1:1。Hub 的 Launcher 客户端已有 30 秒正向缓存，但同一 token 的并发未命中不合并。
2. **单次耗时**：Launcher `introspectToken` 是 2–3 次读加一条观测审计。`e367349d` 已把观测审计改成异步批量队列（每 250 ms 最多 100 条一次写，满了丢弃，不回压认证），并有 [11 号 runbook](11-k8s-deployment-runbook.md) 的局部 API 发布步骤。上面“每次认证都等待审计写库”与旧镜像吻合；**现场是否已运行该镜像需确认**。
3. **资源**：Launcher PG `mx-internal-postgres-0` 限 **1 CPU / 1Gi**、默认参数（`shared_buffers` 128MB、`max_wal_size` 1GB）；API `mx-launcher-internal` 1 CPU/1Gi 单副本；`mx-identity`/`mx-identity-public` 0.5 CPU/384Mi 单副本。MX-H2I 登录、SSO、introspect、审计全经过这一个被限 1 核的 PG，且几乎没有页缓存挡在出问题的数据盘前。
4. **探针放大**：API readiness `/readyz` 每次都查库（3 秒超时，连续 6 次失败下线）；identity 的 startup/readiness `/healthz` 查库，readiness 用 Kubernetes 默认 **1 秒**超时；Launcher PG 的 liveness 是 3 秒 `pg_isready`，连续 6 次失败会被 kubelet 重启（第 5.1 节已记录过这类超时）。单副本下 NotReady 不会把流量转给别人，只会把“慢”变成“拒绝连接”，同时产生 Endpoints/Pod 状态写入。

**关于 6443**：Launcher 的认证代码不调用 Kubernetes API（只有 admin/网络配置会写 CoreDNS/网关 ConfigMap），所以 introspect 本身不会压到 6443。可能的间接路径是：慢库导致探针翻转 Ready、liveness 重启、部署/脚本的 kubectl 轮询，以及 API Server 自身 APF 排队。etcd 已在系统盘，仍需用 12.4 的只读命令确认 6443 慢在哪个请求类别，不能凭感觉归因于 identity。

### 12.2 本轮代码改动（本地，未提交、未部署）

| 位置 | 行为 | 配置 |
| --- | --- | --- |
| Compass `po-backend-java`（当前分支 `feat/yjj/hdo_v2`）`MxLauncherAuthServiceImpl` | 成功的 introspect 按 token 的 SHA-256 缓存 30 秒；同一 token 的并发请求共享一次 Launcher 调用；**仅当** Launcher 不可用（超时/5xx）时，120 秒内确认过的 token 继续可用；Launcher 明确拒绝时立即清除；改密码后清除该 token；最多 10000 条 | `MX_LAUNCHER_INTROSPECTION_CACHE_TTL_MS=30000`（0 关闭）、`MX_LAUNCHER_INTROSPECTION_STALE_GRACE_MS=120000`（0 关闭）、`MX_LAUNCHER_INTROSPECTION_CACHE_MAX_ENTRIES=10000` |
| Hub `server/identity/launcher-client.mjs` | 原 30 秒缓存增加并发合并，以及同样的“仅 Launcher 不可用时 120 秒兜底”；明确拒绝清除；`invalidate()` 不会被进行中的调用回填 | `MX_INSIGHT_LAUNCHER_STALE_GRACE_MS=120000`（0 关闭，上限 600000）；`CACHE_TTL_MS=0` 时缓存与兜底都关闭 |
| Launcher `server/src/lib/readiness-gate.ts`，用于 API `/readyz` 与 identity `/healthz` | 同时最多一个库检查（探针不再给忙碌连接池加排队）；分别在 1 秒/0.5 秒内回答；首次成功前仍不就绪（启动门槛不变）；之后库慢或失败时 60 秒内保持在服务中（API 响应带 `degraded: true`），超过 60 秒仍下线 | liveness 不变：API `/healthz` 不查库，identity 是 TCP |

撤销语义：Compass 原来每次都问 Launcher，现在最晚 30 秒发现撤销（与 Hub 现有设计相同）；Launcher 不可用期间最晚 150 秒。Compass 的登出原本就不在 Launcher 侧撤销 token，不受影响。登录协议、token 格式、MX-H2I 联网、SSO 配置都没有改。

### 12.3 运维步骤（由操作者执行，均不重启）

1. **确认审计解耦已在线**：

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow get deployment mx-launcher-internal -o jsonpath='{range .spec.template.spec.containers[*]}{.name}={.image}{"\n"}{end}'
   ```

   不是 `auth-audit-e367349d-*` 或更新的镜像时，按 11 号 runbook 的局部 API 发布执行。

2. **先看 Launcher PG 是否被 CPU 节流**（间隔约 60 秒读两次，比较 `nr_throttled`、`throttled_usec` 增量）：

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow exec mx-internal-postgres-0 -- cat /sys/fs/cgroup/cpu.stat
   ```

3. **原地扩大 Launcher PG 的 CPU/内存上限**。集群为 v1.36，支持 Pod resize 子资源，容器不重启；QoS 仍为 Burstable。先 server dry-run，再执行，最后核对重启次数不变：

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow patch pod mx-internal-postgres-0 --subresource resize --dry-run=server -p '{"spec":{"containers":[{"name":"postgres","resources":{"limits":{"cpu":"4","memory":"4Gi"}}}]}}'
   ```

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow patch pod mx-internal-postgres-0 --subresource resize -p '{"spec":{"containers":[{"name":"postgres","resources":{"limits":{"cpu":"4","memory":"4Gi"}}}]}}'
   ```

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow get pod mx-internal-postgres-0 -o jsonpath='{.status.containerStatuses[0].restartCount} {.status.containerStatuses[0].resources}{"\n"}{.status.conditions}{"\n"}'
   ```

   这只改当前 Pod，StatefulSet 模板仍是 1 CPU/1Gi，Pod 重建后会回到旧值；而直接改模板会在下次部署滚动重启 PG。要固化应另排维护窗口（或像 Pay 一样先改为 OnDelete）。identity 两个 Pod（0.5 CPU）如有节流可用同样方式扩到 2 CPU。

4. **扩容后**对 Launcher PG 执行与 mx-common 相同的热加载参数（`max_wal_size`、`checkpoint_timeout`、`wal_compression`、`track_io_timing`、`log_lock_waits`；不改持久性设置，不重启）：

   ```bash
   kubectl --kubeconfig=/etc/kubernetes/admin.conf -n mx-internal-shadow exec -i mx-internal-postgres-0 -- sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1' < electron-dock/mx-common/scripts/postgres-burst-tuning.sql
   ```

   在 1 核上限下先开 `wal_compression` 会增加 CPU，所以放在扩容之后。

### 12.4 6443 只读诊断

API Server 的 APF 排队与拒绝（有非零值说明 6443 正在排队，标签里的 `flow_schema`/`priority_level` 指明是哪类客户端）：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get --raw /metrics | grep -E '^apiserver_flowcontrol_(current_inqueue_requests|current_executing_requests|rejected_requests_total)|^apiserver_current_inflight_requests' | awk '$NF>0'
```

按请求类别的平均耗时（API Server 启动以来累计值，前 15 项）：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get --raw /metrics | python3 -c '
import re, sys, collections
total, count = collections.Counter(), collections.Counter()
for line in sys.stdin:
    m = re.match(r"apiserver_request_duration_seconds_(sum|count)\{([^}]*)\} (\S+)", line)
    if not m: continue
    labels = dict(re.findall(r"(\w+)=\"([^\"]*)\"", m.group(2)))
    key = (labels.get("verb", "-"), labels.get("resource", "-"))
    (total if m.group(1) == "sum" else count)[key] += float(m.group(3))
rows = sorted(((total[k] / c, c, k) for k, c in count.items() if c), reverse=True)[:15]
for avg, c, (verb, resource) in rows:
    print("%-8s %-32s avg=%8.1f ms n=%d" % (verb, resource, avg * 1000, c))'
```

探针失败与重启（看是否正是慢库期间 Launcher/Hub/PG 在翻转）：

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get events -A --field-selector reason=Unhealthy --sort-by=.lastTimestamp | tail -n 30
```

```bash
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get pods -A -o custom-columns=NS:.metadata.namespace,POD:.metadata.name,RESTARTS:.status.containerStatuses[*].restartCount | awk 'NR==1 || $3!="0"'
```

### 12.5 发布顺序

1. **Compass 后端**：减少 introspect 量最直接，独立于 Launcher，按 Luopan 原发布流程。
2. **Hub**：标准部署，保留 `MX_INSIGHT_SYNC_LAUNCHER=0 MX_SMOKE_DATA=0`。
3. **Launcher readiness**：随下一次 `mx-launcher-internal` 局部 API 发布生效；identity 部分需随 Launcher 正常部署更新 identity。之前请先完成 12.3 的确认与扩容。
4. 每一步之后看 introspect 延迟、503 比例和 12.4 的指标，再进行下一步。

### 12.6 本地验证

- Compass：新增缓存测试 8 项，与原有 Launcher 认证/拦截器/登录/改密码测试共 27 项通过（离线 Maven，使用本机已缓存的 surefire 3.1.2）。全量 1230 项中 20 失败 + 1 错误，与干净 HEAD 导出的同一组失败完全一致（HEAD 1222 项）。
- Hub：新增 `tests/server/launcher-client-resilience.test.mjs` 6 项，identity 与代理配置测试共 53 项通过；全量 server 测试仍是已知的 38 项失败，无新增。
- Launcher：`readiness-gate.test.ts` 3 项与 platform controller 5 项通过；identity 13 项通过（6 项原本跳过）；sdk-auth 61 项通过；typecheck 与 build 通过。全部 `src/**/*.test.ts` 加 identity 脚本测试 267 项中唯一失败 `oversea-site-archive` 在干净 HEAD 同样失败。
- 均为离线测试，没有连接生产、没有压测，不代表现场延迟已下降。

### 12.7 统一入口自动应用（替代 12.3 的第 3、4 步）

同步代码后，12.3 第 3、4 步的手工 resize 与参数脚本由统一入口完成，且不重启数据库：

```bash
bash scripts/manage.sh db status launcher
bash scripts/manage.sh db apply launcher
```

Launcher PG 的模板已改为 4 CPU／4Gi 和 `updateStrategy: OnDelete`。下一次 `deploy mx-launcher` 写入这个模板时不会滚动数据库，部署成功后会自动执行一次 `db apply launcher`：原地调整 Pod 资源并热加载参数。mx-common（Hub／DataPort 共享库，16 CPU／48Gi）同理。`db status` 会列出仍需计划重启才生效的项（如 `shared_buffers` 或模板中的其他变化），这些项不会被自动执行。说明见 [electron-dock/README.md](../../README.md#数据库运行配置db-apply)。

