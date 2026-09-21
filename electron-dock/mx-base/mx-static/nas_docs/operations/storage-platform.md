# 多项目存储策略、复制速度和数据库扩展

2026-09-22 更新决策：统一采用容器平台的存储声明与成熟组件，**不把每个业务一套 systemd 启动程序作为通用默认方案**。此前 [host bind 方案](boot-and-recovery.md) 降为兼容备选，尚未部署；所有生产容器配置不变。Delta 的数据复制和保留原卷仍按既定流程推进，不在同一次迁移中更换数据库版本或运行平台。

## 复制时间与“快速复制”

10 MiB/s 仅是小批验证的保守限速。以下为单遍传输数学估算，不包含文件遍历、校验、业务竞争、停写与最终增量：

| 持续速度 | 900 GiB | 930 GiB | 两卷约 1,426 GiB |
| --- | ---: | ---: | ---: |
| 10 MiB/s | 25.6 小时 | 26.5 小时 | 40.6 小时 |
| 30 MiB/s | 8.5 小时 | 8.8 小时 | 13.5 小时 |
| 50 MiB/s | 5.1 小时 | 5.3 小时 | 8.1 小时 |
| 100 MiB/s | 2.6 小时 | 2.6 小时 | 4.1 小时 |

900 GB / 10 MB/s 是 25 小时；表中使用 GiB/MiB。1 Gb/s 链路理论约 119 MiB/s，实际有效吞吐更低；尚未取得本机到 NAS 的链路与磁盘吞吐数据，不能承诺达到某一档。

小批成功后先结合链路/业务余量采用 30–50 MiB/s 的单路预复制，再根据 NAS 延迟、RPC 重传和业务响应决定是否提升。SHA256/rsync checksum 的读取也消耗 NAS 吞吐；10 MiB/s 小批结果不能作为最大吞吐测试。当前以容量压力为主，复制期间需控制下载增长。

- 同一文件系统内 mv 通常改目录项，所以很快；跨 SSD 与 NAS 时需要实际复制，随后 mv 会移除源，不符合保留原数据要求。
- `cp --reflink` 是文件系统支持的写时复制，共享底层块；不能把本地 XFS 的块直接变成独立 NAS 上的数据。源和副本还共享底层介质风险。[GNU cp](https://www.gnu.org/s/coreutils/manual/html_node/cp-invocation.html)、[Linux reflink 范围限制](https://man7.org/linux/man-pages/man2/ioctl_ficlonerange.2.html)
- 硬链接既不能跨此处的文件系统，也不是独立副本。NAS 内部快照/克隆可能很快，但前提是数据已在对应存储系统中。
- 本次第一次把约 1.4 TiB 数据放到 NAS，仍要传输实际内容。rsync 的价值是保留源、重复运行时做增量、记录和核对结果；它不让首次全量传输变成目录项操作。正式复制仍不使用 delete/remove-source-files，不先打压缩包。多数视频已经压缩，不默认加 -z 或用大量并发冲击机械盘。

## 分清平台能保障什么

| 层次 | 原生配置/组件负责 | 仍要验收 |
| --- | --- | --- |
| 文件系统可挂载 | Docker NFS volume；K8s NFS PV/CSI | 指定导出是否正确、断线表现、NAS 容量/健康 |
| 进程能启动/恢复 | Docker restart policy；K8s controllers/kubelet | 初始挂载失败后的重试、维护暂停、版本兼容 |
| 服务可接受请求 | Compose healthcheck + depends_on；K8s readiness/startup probes | 数据库恢复完成、Schema/任务状态、应用重连 |
| 数据一致且可恢复 | 引擎备份/复制、存储持久化、快照/独立备份 | 断电、误删、双主/重复消费、实际恢复演练 |

统一管理存储规格和部署模板，**每个项目仍保留自己的数据库、队列、凭据和独立数据卷/PVC**。不扫描所有容器后统一停止，不恢复整个 Docker 对 NAS 的强依赖。

## 当前 Docker/Compose：优先验证原生 NFS volume

新的 [Compose 候选模板](../templates/compose.delta-raw-media-nfs-volume.yml.example) 保留原 `/app/media` 父卷，在 `/app/media/data_hub_raw_media` 挂一个新的外部 NFS named volume。它覆盖同样 10 个媒体消费者，gateway 只读，使用 `nocopy: true`，不修改 DB/Redis 或重启策略。此模板与旧 host-bind 模板二选一，**不能叠加**。

Docker local volume driver 支持 NFS 的 type/device/options。把挂载责任交给 Docker 后，容器启动前需要成功取得该远端卷，不再把 `/mnt/nas` 的本地空目录当作媒体库。[Docker volumes](https://docs.docker.com/engine/storage/volumes/)

拟用新卷名分别为 `delta_59202_raw_media_nfs_v1`、`mx_data_raw_media_nfs_v1`，不是旧 media_data 卷名。目标仍是已规划的 NAS 目录，因此现有复制工具和旧卷保留方案不用重做。新卷必须在迁移完成、路径核验后单独建立，审查 `docker volume inspect` 的 type/device/options，再作为 external 引用；不把旧 volume 删除重建来改变 driver options。

NFS 卷选项的拟定值（仅说明，不是创建命令）：

```yaml
driver: local
driver_opts:
  type: nfs
  o: addr=192.168.1.3,vers=3,proto=tcp,rw,hard,rsize=524288,wsize=524288,timeo=600,retrans=2,sec=sys
  device: :/volume1/data1/mx-internal-server/data/docker/media-volumes/po_infra_media_data/data_hub_raw_media
```

另一实例使用它自己的目录。必须先验证 NAS 是否允许直接挂载这个导出子目录；目前只证明了导出根的宿主机挂载。不能把 `x-systemd.*` 参数塞进 Docker driver options。`/mnt/nas` 可继续供迁移工具和宿主机访问，但新容器卷不依赖其 fstab 开机状态。

### 普通 Compose 的限制，不隐藏在 restart 参数后面

- 原生 NFS volume 解决挂载失败时不能正常使用本地空目录的问题，**不等于 NAS 晚到后保证自动启动**。容器在卷挂载阶段就失败时，不能依靠普通 restart policy 保证持续重试。[Docker restart policy](https://docs.docker.com/engine/containers/start-containers-automatically/)
- 已核对现场 Engine 对应的 Moby v26.1.3：`setupMounts` 错误直接返回；daemon 启动恢复路径中启动错误被记录，且等待恢复任务完成。因此除重试外，还应实测挂载等待对 daemon 就绪时间的影响，不能声称原生 NFS 会绝对隔离所有启动延迟。[start.go](https://github.com/moby/moby/blob/v26.1.3/daemon/start.go)、[daemon.go](https://github.com/moby/moby/blob/v26.1.3/daemon/daemon.go)
- `depends_on: condition: service_healthy` 在 Compose 执行 up 时帮助安排启动；Docker daemon 重启不会重新运行整套 Compose 编排，运行期数据库断开也需要现成应用客户端的重连能力。配置模板可统一使用这些功能，但不能宣称业务代码从此永远不需要处理断线。[Compose startup order](https://docs.docker.com/compose/how-tos/startup-order/)

短期保留 Compose 时，先在隔离栈验证 NAS 先开、NAS 晚开、挂载失败、Docker 重启和运行中断线。若现场不能可靠自动重试，明确采用维护人员在 NAS 恢复后的平台启动操作，或单个按标签/声明配置管理 NAS 依赖容器的平台级补偿入口；**不再按数据库种类/每实例编写一套脚本**。这两个补偿选项都不是本轮已实现功能。

若要求长期完全由平台调度持续重试，优先规划进入现有 Kubernetes 的 PV/CSI 模型；Swarm 也有服务调度，但当前没有必要为了这一卷同时引入第三套平台。此次 Delta 先复制数据和做故障试验，不顺带把完整业务迁到 K8s。

## Kubernetes：按存储等级配置，卷就绪由平台处理

使用 NFS PV 或经过版本匹配的 NFS CSI，为每个业务声明独立 PVC。kubelet 在启动容器前处理必需卷，挂载失败会形成 FailedMount 等事件并重试，NAS 晚到通常不需要为每个数据库编写宿主机启动脚本。不要用 `hostPath: /mnt/nas/...` 假装实现了这个机制，也不能用一个虚假的 local PV 掩盖远端 NFS。[Persistent Volumes](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)、[Pod lifecycle](https://kubernetes.io/docs/concepts/workloads/pods/pod-lifecycle/)、[NFS CSI](https://github.com/kubernetes-csi/csi-driver-nfs)

建立两类共享模板/StorageClass：

| 用途 | 建议后端 | 使用方式 |
| --- | --- | --- |
| nas-media | 机械 NAS 的 NFS | 大媒体、归档；按业务独立 PVC，必要时 RWX，多读写方需应用支持 |
| ssd-db | 本机扩容后的 SSD，或受支持 CSI 的 SSD 块存储 | 数据库、持久队列、随机 I/O；独立 PVC，禁止多个独立 DB 实例共写同一数据目录 |
| 独立备份 | NAS 备份目录/其他备份介质 | 引擎一致备份、恢复演练；不能与唯一生产数据共用同一故障域就当作独立备份 |

已有数据导入优先 Retain 回收策略、明确 volumeName/claimRef 映射；动态新卷统一容量、配额、权限和备份策略。PVC 扩容要存储驱动与后端共同支持；`allowVolumeExpansion` 不会凭空增加物理容量。普通 NFS 子目录 PVC 的标称容量也不应被当作已经生效的 NAS 硬配额。[StorageClass](https://kubernetes.io/docs/concepts/storage/storage-classes/)

数据库使用成熟 chart/operator 模板中的 StatefulSet、启动/就绪检查、优雅停机和备份配置。readiness 控制 Service 流量，不会自动停止所有独立 worker/cron；不要把“依赖数据库离线”简单做成持续重启所有容器的 liveness 检查。[Kubernetes probes](https://kubernetes.io/docs/tasks/configure-pod-container/configure-liveness-readiness-startup-probes/)

RWO 是单节点可读写，并非必然单 Pod；受版本/CSI 支持时可考虑 RWOP。存储访问模式和 StatefulSet 不代替数据库复制、选主与防止双写的机制。控制平面 etcd、容器 runtime 根目录和 CSI 控制组件自身不能反过来依赖尚未挂载的 NAS 卷。

## 将来数据库变大：扩容量、性能与迁移分别处理

目前先迁 Delta 原始媒体，DB/队列卷保持 SSD；统一模板不意味着把所有数据库一同搬到机械 NAS。

数据库继续增长时按需求选择：

1. **本机扩 SSD/NVMe**：保留服务器上的数据库计算和低延迟存储，使用独立文件系统/LVM 等受控扩容；对接 Docker named volume/bind 或 K8s local/CSI 时明确宿主机约束。
2. **独立 SSD 存储池/存储节点**：由受支持的 CSI/块存储或专用数据库服务提供容量。NAS 的 iSCSI 可作为候选，但底层仍是机械盘时不会自动获得 SSD IOPS，单个 NAS 也不会变成多故障域高可用。普通 XFS/ext4 LUN 不允许多主机无协调地同时读写挂载。
3. **按引擎归档/分区或复制扩展**：热表、索引、WAL/持久队列优先性能存储，冷媒体与备份归 NAS。具体迁移遵循实际引擎和版本，不用媒体 rsync 工具复制正在运行的数据库目录。

PostgreSQL 并非绝对不能用 NFS。官方支持在满足语义的 NFS 上存放 PGDATA，要求 hard；同时强调服务器稳定落盘/适当 export sync 和 fsync 语义。是否适合当前 NAS 还取决于随机延迟、断电保护、网络和恢复验收；本次 4 KiB 权限测试远不足以证明数据库适用。[PostgreSQL 16 NFS](https://www.postgresql.org/docs/16/creating-cluster.html#CREATING-CLUSTER-NFS)

以当前 Delta PostgreSQL 为例，大库可采用 pg_basebackup + WAL/流复制建立新存储上的副本，在受控停写/追平后切换；小库可用逻辑备份恢复。需要保留旧实例、核对复制一致性与恢复路径，禁止两个实例同时写同一 PGDATA。[pg_basebackup](https://www.postgresql.org/docs/16/app-pgbasebackup.html)、[备份方式](https://www.postgresql.org/docs/16/backup.html)

MySQL、Redis 持久化、RabbitMQ 等各按自己的复制/备份和确认语义选成熟组件，统一封装到引擎模板/Operator 中。可以统一存储供应和部署接口，但不能用一个“移动 volume”的通用命令保证所有数据库/队列的数据一致性。开始迁某类数据库时，才针对该引擎版本选型和验证具体步骤。

## 本次继续执行什么

1. 现有 [小批复制](sample-copy.md) 原样继续：10 MiB/s、最多选择 256 MiB，先验证内容/权限，不测峰值。
2. 两卷样本通过后，记录链路速率与 NAS 业务余量，再确定全量预复制限速。首次仍复制所有 tmp，保留源卷。
3. 同时用隔离目录/栈验证原生 NFS volume 的子目录挂载及启动故障，不给现有服务换卷。
4. 切换前确定自动恢复责任，完成完整校验、启动/断线测试和回滚方案。Kubernetes 作为后续统一存储管理方向，本轮不新装 CSI、Operator 或迁移其他数据库。

新增 NFS Compose 文件只是审核候选，不能替代迁移就绪记录或现场故障测试。版本、镜像和原 env-file 的要求不变；不删除原 named volumes。

本地验证：使用本机 po-infra 的真实 Compose 基础文件，在 Compose v2.34.0 中分别合并 mx_data / delta_59202 的原文件组合和新 NFS 覆盖模板。两套均确认十个媒体消费者新增正确子卷、gateway 只读、nocopy 启用，原父卷/DB/Redis/服务字段和 restart policy 不变；未设置新卷名时配置解析拒绝。此验证不连接 Docker daemon，不证明线上 Compose v2.27.0 或实际 NFS 故障恢复已经通过。
