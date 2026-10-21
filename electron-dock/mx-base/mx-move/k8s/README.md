# Kubernetes 数据迁移：盘点、预备与正式切换

这组命令将已盘点 Internal 的 Kubernetes 数据从 `/data` 迁到根逻辑卷，提供盘点、独立 containerd 预备，以及**维护窗口内的停写、冷复制、挂载/运行时切换和中断恢复**。2026-10-20 现场回传已恢复业务并通过全部自动验收，本次迁移完成。执行过程及历史排障见[正式切换说明](cutover.md)。

| 命令 | 当前执行范围 |
| --- | --- |
| `inventory` / `plan` / `runtime-check` | 只读盘点与报告。 |
| `prepare-runtime` | 写入根卷私有隔离配置和 K8s 镜像归档，不启动服务。 |
| `install-runtime --prepared <目录>` | 复用成功归档，安装并启动独立候选服务，导入 `k8s.io` 镜像并核对 CRI；不切换 kubelet、复制数据库、改挂载、发布 active 描述或设置开机启用。 |
| `cutover-check` | 正式迁移前核验当前主机、运行时、所有数据与身份，不停止业务。 |
| `prepare-check` | 独立验证配置备份、在线 etcd 快照和原登录配置基线；不停止业务、不替换正式事务指针。 |
| `migrate` | 维护窗口内停写、备份、冷复制五个数据根、切换挂载和 kubelet，再恢复原工作负载并验收。 |
| `status` / `verify` | 分别只读最近事务、只读核验已提交的新副本。 |
| `docker-check` | 只读比较当前 Docker 与最近事务预检基线，输出字段级脱敏差异，不停止服务。 |
| `workload-check` | 只读列出工作负载集合增删、同名 UID 替换及 Job 生命周期摘要，不修改对象或基线。 |
| `resume` | 提交前恢复原副本；提交后只继续恢复新副本。当前不提供 K8s `rollback`。 |
| `resume --repair-rig-init` | 仅在已确认的停写后恢复故障中，受控补充 Rig 初始化容器权限，再恢复原业务。 |

维护窗口已允许，但现有用户、密码、SSO 密钥和注册、网络配置必须保留。搬迁 Launcher 数据库和运行时会涉及服务中断，不能承诺窗口内登录、DNS 或联网持续可用。具体停启范围和执行命令须依据服务器报告确定，不能只从 `df` 和 `fstab` 推断全部数据位置。

**当前范围：只迁移 Kubernetes 数据。** 用户允许同一窗口短暂停 Docker，但明确不迁移 Docker 数据。2026-10-20 的[现场报告分析](server-2026-10-20.md)确认 Docker 使用现有 containerd，因而 `/data/docker`、Docker 卷以及现有共享 `/var/lib/containerd` 整树都不属于直接复制范围。`docker_overlap=[]` 仅指没有发现数据路径重叠，不代表运行时不共用。

Kubernetes 独占的业务目录和 kubelet 目录可保持逻辑路径，通过根卷新副本切换。若将 Kubernetes 镜像和容器运行时数据一并迁入根卷，方案是创建独立 containerd 实例，通过镜像 API 导出/导入所需镜像，再切换 kubelet 的实际 CRI endpoint；保留 Docker 的服务、socket、原共享运行时及构建 namespace。不能直接 rsync 某个 `k8s.io` 子目录，namespace 不是完整独立的数据目录。

Launcher、Hub、mx-common、Pay、Rig 的镜像导入和相关修复入口已增加中性运行时解析适配；只有正式生效描述存在时才选择受验证的新实例。候选安装不创建该描述，所以普通发布继续使用原运行时。正式切换执行器在提交后发布该描述；不能重置集群或停用存储保护来绕过检查。

当前事务 `mx-k8s-20261020-053718-a8d8c128` 的服务器最终回传为 `phase=services-restored`、`may_write=true`、`automatic_checks_passed=true`。五个数据根已切换至根逻辑卷，Kubernetes 使用独立 containerd；Docker 数据未迁移、etcd 未再次迁移，NAS 未纳入操作，历史数据及备份保留。用户此前已在新副本上确认 MX-H2I 原账号登录、联网及 Pay 访问均正常。**本次迁移完成，无需继续执行 `migrate` 或 `resume`。** 日后需要查看记录时，以 root 在 **`electron-dock/mx-base` 目录**执行只读命令：

```bash
bash mx-move/scripts/manage.sh k8s status
```

若已进入 **`electron-dock/mx-base/mx-move` 目录**，只把入口改成 `bash scripts/manage.sh`。摘要中的 `user_login_and_network_validation=required` 是固定的人工验收提示，工具不会自动记录用户的实测结果；它不表示自动验收失败。`capacity` 是事务预检时保存的容量数据，不是迁移后的实时剩余空间。此前 TTL 清理造成的 Job 集合差异已通过受限兼容检查；`workload-check` 仍按原始集合报告差异，不改写基线。具体边界见[正式切换说明](cutover.md)。

## 执行只读检查

在 Internal 控制平面 Linux 主机以 root 执行，需要 Python 3.6+；保留仓库模块目录结构。先同步整个 `mx-move` 模块，然后在仓库根目录运行：

```bash
cd electron-dock/mx-base/mx-move
bash scripts/manage.sh k8s inventory
bash scripts/manage.sh k8s plan --measure
```

若当前目录是 **`electron-dock/mx-base`**，可直接使用带模块名的路径（无需更新父级入口）：

```bash
bash mx-move/scripts/manage.sh k8s plan --measure
```

新版 `mx-base/scripts/manage.sh` 也支持转发 `k8s inventory` / `k8s plan`。旧版父级入口会把 `plan` 当应用名并报 `[mx-base] ERROR: 未知应用：plan`，此时尚未调用盘点程序；使用上述模块路径即可。

全量报告已取得后，补充运行时专用短报告；从 **mx-base 目录**执行：

```bash
bash mx-move/scripts/manage.sh k8s runtime-check
```

该命令只读读取实际进程参数、合并后的 containerd 配置的允许字段、socket 身份、namespace 任务数量以及本地 Docker 的停止/恢复集合；不重新扫描数据库、不查询整套 Kubernetes 工作负载、不输出原始配置。采集缺项明确返回未知，不能据此停止服务或创建新运行时。`imports = []` 不属于外部覆盖；旧版报告仅凭出现 `imports` 键就标为 true，已修正，仍以合并后的配置为准。

`inventory` 用于快速获取清单；`plan --measure` 额外测量目录大小，可能耗时并产生磁盘读取负载。它使用低优先级 `du`，每个目录默认最多 30 秒，存在嵌套挂载的目录不扫描；大小未知会保留为 `null`。省略 `--measure` 可先检查路径和阻塞项，但不能据此确认容量足够。JSON 写入 stdout，阶段提示写入 stderr。

需要 `kubectl`、`findmnt`、`lsblk`、`systemctl`，测量还需 GNU `du`；有 Docker 时只读列出容器挂载消费者。报告包含实际 kubelet/containerd 参数中的路径字段、Pay 存储 ConfigMap 的允许字段、PG 控制文件标识及外置 WAL/表空间链接；不会打印完整配置或命令。`--node` 仍须通过本机 hostname/systemUUID 核对，不能用于强行查询其他节点的本地数据。

可显式选择节点或目标父目录，例如：

```bash
bash scripts/manage.sh k8s plan --node mx-internal-server \
  --target-root /var/lib/mx-move/k8s-data --measure
```

默认目标为 `/var/lib/mx-move/k8s-data`。所谓“1T 盘”在本现场指 `/dev/mapper/cl-root` 根逻辑卷；它与 `/home` 共用的物理盘身份应以现场 `lsblk`、UUID 和挂载信息核实，不能按 `nvme0` / `nvme1` 名字猜测。`/home` 的可用空间不能计入根卷迁移预算。

2026-10-20 提供的 `df -TH` 为根卷容量 1.1T、可用 968G，`/data` 已用 598G，`/home` 可用 18G。这比先前 etcd 迁移记录中的根卷余量充足，但不是 Kubernetes 实际数据量：`/data` 还可能包含 Docker、旧副本和非 Kubernetes 文件，备份、增长及运行时挂载也需另核算。上述为十进制展示值，报告以字节计算。

建议把待贴回报告保存在仓库外的私有文件中，避免混入 Git：

```bash
umask 077
report="$(mktemp /root/mx-k8s-storage-XXXXXX.json)"
bash scripts/manage.sh k8s plan --measure > "$report"
printf '报告文件：%s\n' "$report"
cat "$report"
```

贴回该 JSON 和检查失败时的简短提示即可；不要附上 Secret、环境文件、恢复快照、证书私钥或完整容器 `inspect` 输出。采集失败、权限不足或未测量都属于待核实项，不代表相关服务或数据不存在。

上述只读命令退出码 `0` 仅表示采集未报告错误；`2` 表示报告已输出但有采集缺项；`1` 表示未能完成报告。报告中的 `execution_supported` 固定为 `false`。容量按 UUID + 文件系统内路径合并 bind 别名和父子目录，默认留出 **100 GiB + 已测数据量的 25% 增长空间**，数据库备份另算；`required_bytes_lower_bound` 与 `lower_bound_fits` 只是已测量部分的下限，不是“可以迁移”的结论。完整性、实际物理盘、未来增长、未发现的外置路径和停写后容量仍需复查。

新版保留 `capacity` 作为与首份报告对照的全路径统计；`migration_scope` 明确排除共享运行时，`kubernetes_data_capacity` 才是此次业务数据及 kubelet 的复制预算草案，尚不含专用运行时、镜像转换或备份预算。包含共享运行时的父目录，以及与 Docker 数据根重叠的路径和 bind 别名，也会排除并标为待核实，不能通过复制上层目录带走 Docker 数据。位于根卷的符号链接也必须核实目标，不能仅因链接自身在根卷就当作数据已经迁移。

## 迁移范围与保留边界

应以实际 PV/PVC、Pod 和工作负载的卷声明、运行时路径及宿主机挂载交叉核对，涵盖 Launcher、mx-common、Pay、Rig 以及仍有保留卷的旧服务。仓库整合或退役记录不能证明服务器上已没有旧实例。

| 范围 | 处理原则 |
| --- | --- |
| 已迁移的 `/var/lib/etcd` | 保持当前根卷活动副本、fstab 与启动保护，不重复迁移。已有 etcd 工具见[上级说明](../README.md)。 |
| 现有 `/var/lib/containerd` | 与 Docker 共用，整树保留原位；Kubernetes 运行时迁入根卷须另建隔离实例并验证镜像与部署入口。 |
| `/var/lib/kubelet` | 核实嵌套挂载及写入者，停写后复制；仅停止 daemon 不等于所有容器和 shim 已退出。 |
| `/var/lib/mx-launcher` | 包含登录数据库及其他持久数据；保留原 PV/PVC、数据库身份、Secret 和业务路径。 |
| mx-common、Pay、Rig 及其他本地卷 | 从现场发现真实路径及使用者，逐一确认停写、备份、身份保护和恢复顺序。 |
| 已在根卷的数据 | 核实后保留，不为统一目录重复搬迁。 |
| NAS `/mnt/nas`、其他 NFS/CSI/远端卷 | 单独列出依赖；不把远端内容误当成本地数据复制，也不修改 NAS 挂载。 |
| Docker 及非 Kubernetes 服务 | 默认不迁移、不重启；核实与 Kubernetes 是否共用路径或运行时。发现共用时必须调整方案。 |

保留旧数据目录，不对整个 `/data` 做迁移或清理。容器镜像、运行时快照、临时卷、业务数据库和备份应区分核算，避免嵌套 bind mount 重复统计或漏掉跨文件系统的数据。PostgreSQL 外置 WAL、表空间和其他符号链接目标须单独核实。

不要运行 Launcher 的旧 [`k8s.migrate.sh`](../../../mx-launcher/scripts/k8s.migrate.sh)：它会停止 Docker/containerd/kubelet，并使用旧 `/data/mx-runtime/etcd` 路径。也不要用各项目的普通 deploy 代替迁移，部署可能触发数据库或业务工作负载更新。

## 必须同步的存储身份

保留相同的业务路径并新增 bind mount，仍会改变底层文件系统身份。`storage-identities.mjs` 在核实副本后，仅更新本事务明确允许的挂载字段，保留数据库、集群、用户和凭据身份；先备份原字节，再逐文件 CAS 写入并校验。不能删除身份文件或关闭保护来绕过检查。

| 项目 | 现有保护与迁移要求 |
| --- | --- |
| Launcher | [`localIdentity`](../../../mx-launcher/scripts/k8s-recovery-state.mjs)记录节点、CA、PG system ID，以及 Launcher、PG 子路径、etcd、containerd、Docker 和相关 fstab 父挂载。`/var/lib/mx-launcher-recovery/host.json` 与 `latest.json` 必须一致，后者还包含 checksum。 |
| etcd 迁移辅助程序 | [`launcher-identity.mjs`](../etcd/launcher-identity.mjs)只允许 etcd 挂载变化，不能直接用于整体迁移。应保留其私有备份、并发变化检查和可恢复的身份更新规则。 |
| mx-common | [`storage-preflight.mjs`](../../../mx-common/scripts/storage-preflight.mjs)核对 `/var/lib/mx-common/storage-identity.json` 的根目录、节点、PG system ID、挂载点和 UUID；PG 与 ES 数据/快照目录须处于同一个根挂载，不能随意给每个子目录分别加 bind。 |
| Pay | [`postgres.mjs`](../../mx-pay/scripts/postgres.mjs)核对 `mx-pay-database` ConfigMap、项目 `.deploy/database.json`、`/var/lib/mx-pay/<namespace>/storage-identity.json`；StatefulSet 的 `MX_PAY_EXPECTED_MOUNT_ROOT` 还限制容器内挂载根。迁移必须协调这些记录和启动模板，保留安装 ID、PG system ID、PV/PVC UID、凭据及 SSO 注册。 |

mx-common 旧 `migrate-storage` 会删除并重建 PV/PVC，不是本次整体迁移的替代入口。Pay 普通 deploy 不会更新已有 PostgreSQL StatefulSet，不能指望它自动修复变更后的挂载身份。

## 切换与恢复约束

盘点、预备与候选成功报告均已收到；`migrate` 执行以下事务，不应以手工改挂载替代：

1. 记录节点/集群、PV/PVC、数据库及挂载身份；保存 etcd/ES 快照和必要私有配置，保留数据库原目录。冷副本校验不等于完成隔离恢复演练。
2. 保留原副本，使用新的目标目录；停止已识别的全部写入者，确认数据库退出以及原 `k8s.io` tasks/sandboxes 全部退出，处理 kubelet 的活动子挂载、相关容器和 shim；不能对仍在写入的数据库做普通文件复制。
3. 保留 UID/GID、权限、ACL、扩展属性及硬链接，校验副本和落盘结果，再更新受管挂载、存储身份及启动保护。不得改变网络接口、路由、DNS、VPN 或账户配置。
4. 在允许目标接收写入前持久记录切换状态；恢复服务后核对原数据库身份、数据连续性、凭据、SSO、MX-H2I 现有用户登录及联网，并单独验收 Pay。

**新副本一旦可能写入，就不能直接挂回旧目录。**恢复应继续使用已提交的新副本；如需迁回原盘，应再次停写并把最新数据复制到原盘的新目录后切换。多个数据库可能形成不同时间点的业务状态，不能只因文件复制成功就宣布整体回滚安全。

`install-runtime` 只启动无工作负载的候选运行时；本现场当前先解除 Rig 初始化故障并恢复原业务，再核对迁移最初异常。`resume` 按 `may_write` 决定恢复原副本或向前恢复；`verify` 只读核验新副本。开发机测试和准备检查通过不能替代生产迁移、整机重启或真实用户登录/联网验收；现有 etcd 的启动保护一直保留，不提供通用灾难恢复。

只读与脱敏回归测试：`python3 -B -m unittest discover -s k8s/tests -p 'test_*.py'`。技术依据：[Kubernetes 卷](https://kubernetes.io/docs/concepts/storage/volumes/)、[节点维护](https://kubernetes.io/docs/tasks/administer-cluster/safely-drain-node/)、[containerd 容器生命周期](https://github.com/containerd/containerd/blob/main/docs/historical/design/lifecycle.md)。
