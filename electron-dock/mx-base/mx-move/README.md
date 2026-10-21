# mx-move：Kubernetes 存储迁移

`mx-move` 集中放置 Kubernetes 存储迁移工具。`etcd/` 已实现单节点 kubeadm etcd 的迁移、验收及最新数据回迁；`k8s/` 提供全量盘点、独立运行时预备，以及已盘点 Internal 的停写、冷复制、挂载/运行时切换和中断恢复。工具保留原目录、快照和每次复制的数据，不提供删除命令。

**2026-10-20 全量迁移已完成：** 事务 `mx-k8s-20261020-053718-a8d8c128` 已回传 `phase=services-restored`、`may_write=true`、`automatic_checks_passed=true`。五个 Kubernetes 数据根使用根逻辑卷的新副本，kubelet 使用独立 `mx-k8s-containerd.service`；用户已确认 MX-H2I 原用户登录、联网和 Pay 访问正常。Docker 数据、卷与原共享 containerd 保留原位，etcd 未再次迁移，NAS 未纳入操作，历史副本和备份保留。**本现场无需再执行 `cutover-check`、`migrate` 或 `resume` 来完成这次迁移。** 事务与历史排障见 [K8s 正式切换说明](k8s/cutover.md)。

准备阶段曾测得业务数据约 130.99 GiB，候选回执为 172 个镜像引用、71 个 CRI 镜像、工作负载 0；这些是历史准备记录，不是当前容量或运行状态。后续普通发布仍须同步[运行时消费者适配](k8s/runtime-consumers.md)，其中包括 DataPort 的运行时解析模块和部署调用者。

**2026-10-21 后续故障分开处理：** DataPort 旧发布脚本遗漏独立运行时适配，已补齐显式地址导入和 CRI 镜像核验；旧失败镜像在新旧实例中的实际分布仍缺现场对比证据。同日还发现公网身份 Pod 健康、宿主机 18444 hostPort DNAT 缺失；后续仅重建公网身份后，入口、discovery/capabilities 与数港 SSO start 均已恢复，用户随后确认真实 DataPort 登录和 MX-H2I 登录、联网均正常。规则最初消失原因未确定，不能认定与镜像导入同因，也不需要已完成事务的 `resume`。恢复证据与边界见[故障证据与验收范围](k8s/runtime-consumers.md#2026-10-21-公网身份-hostport-故障与验收范围)。

下文停启范围、50 GiB 预留和 `migrate/rollback` 均仅适用于 **etcd**，不要与 `k8s` 子命令混用。

这次实现针对 Internal 当前的布局：`/var/lib/etcd` 通过 bind mount 使用数据盘上的目录，目标是另一块系统盘上的根文件系统。2026-10-19 的 `lsblk` 确认两块物理盘均约 2TB；此前所称的“1T 盘”实际是系统盘上的 `cl-root` 逻辑卷，同一系统盘另有 `cl-home`。工具读取实际挂载、文件系统 UUID 和物理父盘验证布局，不根据 `nvme0` / `nvme1` 名字或标称容量猜盘。默认目标是根文件系统上的 `/var/lib/mx-move/etcd-data/`；源、目标若位于同一物理盘，检查会拒绝迁移。下文的“1T”均指这个根逻辑卷。

2026-10-19，用户在生产服务器执行迁移并回传 `phase=complete`；随后只读检查确认新挂载、启动保护、API 和节点状态正常，具体结果见“迁移后验收与后续部署”。开发侧未直接操作生产服务器，尚未验证整机重启和磁盘损坏后的恢复，也未代替用户完成真实登录/联网验收。

## 命令

在 **Internal 控制平面 Linux 主机**，以 root 身份进入仓库中的模块目录执行。`plan` 和 `status` 也要求 root，以便读取受保护的本机配置。

```bash
cd electron-dock/mx-base/mx-move

bash scripts/manage.sh etcd plan       # 只读检查和迁移计划
bash scripts/manage.sh etcd migrate    # 备份、暂停 etcd、复制、切换、验收
bash scripts/manage.sh etcd status     # 查看最近事务记录，不等同于实时健康检查
bash scripts/manage.sh etcd rollback  # 将最新活动数据复制回原盘的新目录，再切换
bash scripts/manage.sh etcd resume    # 按事务记录恢复中断操作
```

`migrate` 和 `rollback` 各自是一个命令，不需要手工停服务、复制文件或改 `fstab`。`migrate` 本身会重新执行检查，不依赖之前运行过 `plan`。

耗时步骤会显示阶段名称、开始/完成/未完成和已耗时；同一阶段每 15 秒输出一次“仍在执行”。复制、校验、落盘、挂载切换、等待 etcd/API 恢复、控制器续租和 Launcher 验收各自有提示；`rollback`、`resume` 与失败后的自动恢复也使用这些提示。示例（不代表本次现场耗时）：

```text
[18:20:00] 冷拷贝完整 member/WAL（382.3 MiB）：开始（已用 0.0 秒）
[18:20:15] 冷拷贝完整 member/WAL（382.3 MiB）：仍在执行（已用 15.0 秒）
[18:20:19] 冷拷贝完整 member/WAL（382.3 MiB）：完成（已用 19.0 秒）
[18:20:19] 校验冷副本内容与元数据：开始（已用 0.0 秒）
```

阶段提示写入 stderr，`plan` / `status` 的 stdout 保持 JSON。心跳只报告阶段及经过时间，不增加磁盘扫描或 API 探测，不输出凭据和子进程原文，也不提供未经测量的百分比或剩余时间。旧版在“复制完整 member/WAL”后还会继续校验、落盘和等待恢复，因此旧日志的一段静默不能用于判断具体耗时环节。

可为 `plan` / `migrate` 指定目标父目录，但仍必须位于已验证的独立根盘：

```bash
bash scripts/manage.sh etcd plan --target-root /var/lib/mx-move/etcd-data
bash scripts/manage.sh etcd migrate --target-root /var/lib/mx-move/etcd-data
```

每次复制使用新的 `mx-etcd-<时间>-<随机标识>` 目录，不覆盖已有副本。`rollback` 根据迁移记录定位原盘，不接受重新指定目标目录。已完成迁移时重复 `migrate` 会停止；成功回滚后可以重新发起一次迁移。

## 适用条件与依赖

当前只支持以下已经运行且健康的环境：

- 单节点 Kubernetes、单 member etcd，etcd 版本为 3.5 或 3.6，容器运行时为 containerd。
- kubeadm 静态 Pod 配置位于 `/etc/kubernetes/manifests/etcd.yaml`，管理员配置为 `/etc/kubernetes/admin.conf`。
- etcd 数据和 WAL 均在 `/var/lib/etcd` 内；使用 kubeadm 的本机 TLS endpoint 与 `/etc/kubernetes/pki/etcd/` 证书。外置 WAL、自定义配置文件、多 member 拓扑会被拒绝。
- `/etc/fstab` 恰有一条 `/var/lib/etcd` 的读写 bind mount，源目录与当前活动挂载一致；该条目不能包含 `nofail`、`noauto` 或 `ro`。
- `var-lib-etcd.mount` 必须来自 `/run/systemd/generator/`、`SourcePath=/etc/fstab`，无原生 mount unit 或 drop-in 覆盖，且配置已被 systemd 加载。工具只管理 fstab，不接管其他挂载配置。
- 源、目标是可验证 UUID 的本地 XFS / ext4 文件系统，物理父盘彼此独立。数据目录不能含符号链接、嵌套挂载或特殊文件；数据目录及其父目录须由 root 持有，不能被组或其他用户写入。唯一的所有权例外是经核实的共享文件系统挂载根，见下文 `/data` 说明；状态、备份和配置路径不使用此例外。

目标主机需要 Bash、Python 3.6+、Node.js，以及 `kubectl`、`crictl`、`rsync`、`findmnt`、`lsblk`、`mount`、`umount`、`mountpoint`、外部 `test` 命令、`sync` 和 `systemctl`。Node.js 需能运行仓库现有的 Launcher 恢复脚本；保留 `mx-base` 与 `mx-launcher` 的相对目录关系，不要只复制 `mx-move` 一个目录到服务器。

工具从**当前运行的 etcd 容器镜像**读取并保存匹配版本的 `etcdctl`，不自动下载二进制或安装依赖。检查失败时输出停止原因，不自动重建集群或改用另一套数据。

更新时同步整个 `mx-move` 模块，尤其是 `etcd/move.py`、`etcd/storage_paths.py` 和 `etcd/boot_guard.py`；只更新入口文件会缺少新依赖。

若旧版 `plan` 只报 `crictl 返回失败（输出已隐藏）`，先同步更新模块。旧版错误地调用了 `crictl version -o json`；[官方 version 命令](https://github.com/kubernetes-sigs/cri-tools/blob/v1.31.1/cmd/crictl/version.go)只输出文本，不支持该参数。修复版解析文本中的运行时名称，`ps` / `inspect` 仍使用它们支持的 JSON 输出，并将 runtime/image 两个 endpoint 都固定为 kubelet 实际使用的 socket。无需因此重启 containerd 或 etcd。

新版 CRI 调用失败时会显示调用阶段、退出码、socket、错误类别及一条只读复查命令，避免把容器环境变量和原始 `inspect` 内容显示到终端。`plan` 在此失败尚未进入备份、停机或挂载切换阶段；更新后重新执行 `bash scripts/manage.sh etcd plan`。

### 持久挂载核验

`plan` 会只读核验挂载配置；迁移还会在暂停 etcd 前、更新 fstab 并 `daemon-reload` 后，以及恢复 manifest 前再次核验。生成文件中的源目录必须与 fstab 和本事务选择一致。发现覆盖配置、尚未重新加载或生成结果仍指向旧目录时，工具停止，不会删除原生 unit/drop-in，也不会为通过检查自动重启服务。

只读复查命令：

```bash
systemctl show var-lib-etcd.mount -p LoadState -p FragmentPath -p SourcePath -p DropInPaths -p NeedDaemonReload
systemctl cat var-lib-etcd.mount
```

2026-10-19 迁移前的现场配置为 fstab 生成、无 drop-in，`[Mount]` 中 `What=/data/mx-runtime/etcd`、`Where=/var/lib/etcd`、`Options=bind`。迁移后 `What` 应为已完成事务的 `target`。迁移前活动挂载的 `systemctl show What` 返回 `/dev/nvme0n1p1`，不能据此判断下次开机使用哪个目录。工具读取经过来源核验的生成文件；[systemd 说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html#fstab)中 `/etc` 下原生 mount unit 可以覆盖 fstab，不能只验证 fstab 文本。

### 共享 `/data` 的所有权

Internal 迁移前的实测布局为：`/data` 是 `1003:1003 755`，`/data/mx-runtime`、`/data/mx-runtime/etcd` 和 `/var/lib/etcd` 均为 `root:root 755`；当时活动挂载是 `/dev/nvme0n1p1[/mx-runtime/etcd]`。旧版对整条路径统一要求 root 所有，因此在 `/data` 停止；这条报错本身不表示 etcd 数据损坏。

新版允许**经 findmnt 核实、FSROOT 为 `/` 的共享挂载根**由存储管理员持有，但仍拒绝组/其他用户可写、符号链接以及非 root 的 etcd 数据目录和中间目录。工具不修改 `/data` 或现有数据目录的所有者与权限。

由于共享挂载根的所有者能重命名其子目录，工具会记录数据目录和目标父目录的设备/inode，复制时从当前 `/var/lib/etcd` 挂载读取，以打开的目录描述符固定写入和 bind mount 对象，操作后再次核对路径。路径被替换时会停止；不会因为同名目录还存在就把它当作原数据。回滚也会验证最初记录的父目录身份。缺少该身份的旧迁移记录不能自动用于新版回滚。

迁移期间持有 `mx-move` 与 Launcher 发布锁；仓库存在 Hub 的运行目录时也获取其发布锁。独立于这些锁的手工运维或其他发布脚本不受此锁约束，迁移期间不要并行修改 etcd、挂载和恢复状态。

## 复制和切换过程

1. 校验当前节点、集群 UID、etcd cluster/member ID、活动数据目录、磁盘和可用空间；备份 manifest、`fstab`、Kubernetes PKI 及已有 Launcher 恢复身份文件。
2. 在线生成 etcd snapshot，校验快照的 SHA256 完整性尾部。此时 etcd 继续运行。
3. 把 etcd manifest 移出 kubelet 监视目录，等待容器和 etcd 进程确实退出。仅停止 kubelet 并不能证明 etcd 停止，因此工具保留 kubelet 运行。
4. 将完整 `member` 目录及 WAL 冷复制到新目录，保留所有者、权限、扩展属性等元数据，再通过校验和及元数据比较核验副本。
5. 只修改 etcd 对应的 `fstab` 条目，将 `/var/lib/etcd` bind mount 切到新目录，核验挂载身份。若存在 Launcher 恢复记录，仅更新其中的 etcd 挂载身份及校验和，保留其他字段和原始备份。
6. 先持久化“新副本可能开始写入”的事务状态，再恢复原 manifest。等待 etcd、API 和原节点健康，确认 cluster/member ID、集群 UID 不变且 revision 没有倒退，并确认 controller-manager 和 scheduler 的 lease 继续更新。

原 `/var/lib/etcd` 路径、etcd 配置和集群身份保持延续，不使用 snapshot restore 创建新 member。原有非 etcd 容器 ID 会在切换前后比较，统计包含 kube-apiserver、controller-manager、scheduler 等控制平面容器；发现 ID 已不在运行列表时会记录并提示核查，不自动重启业务。旧版将这项统计称为“业务容器”，出现变化不能直接确定是 MX-H2I 容器重启。用 `status` 的 `changed_business_containers` 与 `crictl ps -a` 的 ID 对照定位；已被运行时回收的旧容器可能无法再查询。

存在 Launcher Internal 部署时，迁移前后还会读取角色接口验证 Ops 鉴权、比较飞书登录配置与 `mx-*` Secret 内容摘要。凭据通过标准输入传递，不显示在日志中。这些检查不代替真实用户登录和客户端联网验收。

准备阶段会增加 `/etc/systemd/system/kubelet.service.d/90-mx-move-etcd.conf`，并把独立启动检查程序安装到 `/var/lib/mx-move/boot-guard.py`。未来启动 kubelet 时，检查实际 etcd 挂载的 UUID、目录 inode 与 `active-etcd.json` 中的当前选择一致，以及数据库文件存在、非空且权限符合要求，避免挂载失败后误用底层目录或旧副本。启动检查优先使用系统 Python，不依赖仓库目录或 Conda 激活；安装后会在暂停 etcd 前实际运行检查。

切换挂载时，manifest 已在监视目录外，身份记录暂时允许本事务的源和目标；恢复 manifest 前收窄到唯一权威目录并再次检查。仅执行 `systemctl daemon-reload`，不重启当前 kubelet。回滚后保留启动保护；可识别的旧版工具配置会备份升级，同名文件若是其他配置则停止核查。

## 对 MX-H2I、Docker 和 Hub 的影响

迁移只暂停 etcd。不会停止或重启 Docker、containerd、kubelet、PostgreSQL、Launcher、Pay，也不修改用户、SSO 凭据、VPN、DNS 或路由。业务数据和容器运行时数据仍留在原盘。

单节点 etcd 暂停期间，Kubernetes 控制平面会有短时不可用，发布、调度及依赖 Kubernetes API 的操作可能受影响。已经运行的业务容器通常继续工作，但不能承诺登录和联网绝对零影响。暂停时长取决于 kubelet 同步、冷复制和校验速度、etcd 启动及 API 恢复时间；完成后仍应核查 MX-H2I 现有用户登录和联网。

这项迁移可以隔离 etcd 与 2T 业务盘的 I/O 竞争。PostgreSQL 等服务仍使用原盘，原盘硬件超时或数据库查询压力导致的 Hub 504 仍可能发生；本工具不等同于全部性能问题的修复，也不是整机异地容灾。

## 迁移后验收与后续部署

2026-10-19 用户回传的事务与随后实时检查结果：

| 检查 | 结果 |
| --- | --- |
| 迁移事务 | `direction=migrate`、`phase=complete`、`may_write=true` |
| 当前活动目录 | `/var/lib/mx-move/etcd-data/mx-etcd-20261019-181949-157ad6a7` |
| `/var/lib/etcd` 实际来源 | `/dev/mapper/cl-root` 上的上述目录，UUID `ea7e456d-19db-4f6e-b8b0-02c00f59d066` |
| 独立启动检查 | `mx-move etcd 启动检查通过` |
| API `/readyz?verbose` | 所有检查通过，包括 `etcd`、`etcd-readiness`，最后为 `readyz check passed` |
| 节点 | `Ready=True`；`NetworkUnavailable`、`MemoryPressure`、`DiskPressure`、`PIDPressure` 均为 `False` |

据此，本次迁移的运行状态验收通过。`may_write=true` 表示新副本已允许接收写入，是完成迁移的正常状态。`complete` 表示完成时已通过 etcd cluster/member ID、集群 UID、revision 连续性、控制器续租及 Launcher 登录配置/凭据检查；后续实时健康仍需重新查询。

本次 `changed_business_containers` 中的 `32416fd845036…`，经用户提供的 `crictl ps -a` 确认为旧 `kube-apiserver`，已有新的 Running 实例。该份列表中 Launcher Internal API、身份服务和网关的运行容器均早于此次迁移；这不代替真实用户登录、飞书授权和 MX-H2I 客户端联网测试，也不能仅凭容器列表判定控制面重启的具体原因。

后续可在 `mx-move` 目录执行以下只读检查。`status` 用于定位事务；挂载、保护和健康分别从当前主机核实。已迁移成功后，不要为了验收再运行 `migrate`、`resume` 或迁移前的 `plan`。

```bash
bash scripts/manage.sh etcd status
findmnt -T /var/lib/etcd -o TARGET,SOURCE,UUID,FSROOT,OPTIONS
python3 -I /var/lib/mx-move/boot-guard.py --record /var/lib/mx-move/active-etcd.json
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get --raw='/readyz?verbose'
kubectl --kubeconfig=/etc/kubernetes/admin.conf --request-timeout=15s get node mx-internal-server \
  -o jsonpath='{range .status.conditions[*]}{.type}={.status}{"\n"}{end}'
```

检查实际挂载应与当前完成事务的 `target` 和启动保护记录一致；未来正常回滚会产生另一个新目录，不能一直拿本次历史路径作为判据。持久挂载还可用上文 `systemctl` 命令核对；不需要现在通过重启验证，整机重启验收留到维护窗口。

已核对仓库当前部署链路：

- **Launcher**：普通 `ops internal-production deploy` 不改 etcd bind/fstab，不调用旧 `scripts/k8s.migrate.sh`；迁移工具已同步 Launcher 恢复检查点中的 etcd 挂载身份。`TMPDIR=/data/tmp`、构建代理和 BuildKit 缓存参数不决定 etcd 数据位置。hostname/IP 应与现有集群一致，否则既有 endpoint 修复流程可能更新证书并重启 kubelet/控制面。发布仍会按原流程更新业务组件，不能据此承诺发布期间登录/联网零中断。参见 [Launcher 部署记录](../../mx-launcher/mx-launcher.deploy.md)。
- **Hub**：普通 deploy 使用 Kubernetes API，不改 etcd 挂载。其 `mx-common ensure` 会应用共享 PostgreSQL、ES、Redis 的清单，模板变化可能触发共享服务更新；Hub 自身也包含数据库迁移和服务发布。etcd 迁移不会解决这些发布影响。独立发布保持 `MX_INSIGHT_SYNC_LAUNCHER=0`、`MX_SMOKE_DATA=0`，避免启用额外联动或测试数据。
- **DataPort**：Kubernetes 部署保留原 context、集群 UID、节点及 `mx-harbor-runtime`，不操作 etcd 挂载或修复控制面。正常 deploy 不发布 Launcher、Hub、Pay，不调用 `mx-common ensure`；仅首次缺少自身运行 Secret 且无已安装 Deployment 时调用 `provision mx-harbor`。自身数据库迁移后，以单副本 `Recreate` 替换 DataPort Pod，会有短暂不可用。`restart`、`migrate` 都是完整 deploy 的兼容别名；独立的 `enroll` 才处理 Launcher/Hub 接入登记，此次 etcd 迁移不需要重新登记。
- **Pay**：默认 Kubernetes，绑定集群 UID、namespace、节点及独立 PG/PV/PVC 身份，不绑定 etcd 的物理目录；正常 deploy 不操作 etcd、控制面或其他项目部署。既有 PG 仅做身份核验，不升级/重启；自身 SQL 迁移后滚动更新 Pay API/console，保留原凭据和 SSO 注册。当前脚本对已有安装通常先暂停新 checkout 完成兼容发布，再恢复新单；第一阶段失败会保持新单暂停，需排查后重试，不能宣称支付全程无影响。
- **Device**：当前根 `manage.sh` 和 `scripts/manage.sh` 均走独立 Docker Compose，不经过 Kubernetes/etcd。保留自身 `.runtime` 与 `mx-device_data` 卷；deploy 不重建已有 PostgreSQL，排空自己的 Worker 后执行数据库迁移，再重建自己的 API/Worker。不会启动/重启 Docker 或 mobile-agent，也不调用 Launcher、Hub、Pay；本中心会有更新窗口。Worker 使用 host network，但无特权、网络管理 capability 或监听端口，脚本不调整 MX-H2I 的 VPN/路由。
- **旧迁移入口**：不要手工重跑 Launcher 的 `scripts/k8s.migrate.sh`；它包含停止运行时和绑定旧 `/data/mx-runtime/etcd` 的流程。迁移后的回滚只走本模块的 `rollback`。

在 Launcher 或 Hub 项目目录可以先运行 `KUBECONFIG=/etc/kubernetes/admin.conf bash scripts/manage.sh ops internal-production control-plane-preflight` 做只读 API 检查；其他三个项目不提供这个子命令。它不代替 Node 条件检查或各自完整发布前检查。迁移的固定 50 GiB 空间预留与 kubelet 的磁盘压力策略独立；本次实时 `DiskPressure=False`，后续部署仍以当时节点状态为准。

其他项目的现有诊断入口（在对应项目目录执行）：

| 项目 | 命令 | 检查边界 |
| --- | --- | --- |
| DataPort | `KUBECONFIG=/etc/kubernetes/admin.conf bash scripts/manage.sh ops internal-production status` | 只读核对保留的集群 UID 并列出自身资源；`plan` 仅离线展示，不是实时预检 |
| Pay | `KUBECONFIG=/etc/kubernetes/admin.conf bash scripts/manage.sh doctor` | 对集群只读，检查目标及资源状态；本地 `.deploy` 不存在时会创建空目录，不等同在线 PG 数据身份校验 |
| Device | `bash scripts/manage.sh status` | 只读列出自己的 Compose 服务；Kubernetes 健康不代表 Docker 和 Device 已就绪 |

Pay 另有一个既有重启风险：[2026-10-14 的记录](../mx-pay/README.md#重启持久化与存量系统)说明 PGDATA 权限曾变为 `2770`，仓库已在生成的 PG 启动命令中补充身份核验后的单目录 `chmod -- 00700`。2026-10-19 用户最初回传模板和当前 Pod 的该字符串检查均为 `False`；随后运行独立修复入口，回传 `result=template-updated`、`templateGuard=known-current`、`podGuard=known-legacy`、`patchResponseConfirmed=true`、`originalPodStillPresent=true`。据此，模板已更新，原数据库 Pod 保持运行，尚未采用新启动命令。

普通 Pay deploy 不更新既有 PG StatefulSet，且其策略是 `OnDelete`。`postgres-permissions-plan` / `postgres-permissions-apply` 用于核对身份后备份并只更新已知旧模板，不自动重启数据库；该备份仅为 StatefulSet 元数据，不是数据库备份。当前 Pod 仍需以后在 Pay 维护窗口备份数据库、核对待生效模板后重建并验收，不能因模板更新就认定该风险已经完全消除。本次 etcd 迁移不要求重建 PG 或修改权限。

### 其他项目是否需要相同的 PostgreSQL 权限修复

2026-10-19 对当前仓库启动链路的审查未发现其他已核对项目需要套用 Pay 的同类补丁，但发现 mx-rig Kubernetes 初始化容器有另一项重建权限风险。Pay 的旧启动命令在身份核验后直接执行 `postgres`，没有经过官方入口的目录权限处理；其他项目情况如下：

| 项目 | PostgreSQL 启动链路 | 本次结论 |
| --- | --- | --- |
| Launcher / MX-H2I Internal | [恢复保护脚本](../../mx-launcher/scripts/k8s-postgres-recovery.mjs)先检查既有 PG16 数据，再调用 `docker-entrypoint.sh postgres`；基础清单也保留官方镜像入口 | 未发现同类缺口，不为此修改或重启登录数据库 |
| mx-common（Hub、DataPort 使用） | [PG 清单](../../mx-common/deploy/k8s/common/10-postgres.yaml)先核验保留数据身份，再调用 `docker-entrypoint.sh postgres`；`pgvector/pgvector:pg16` 继承官方入口 | 未发现同类缺口；正常 Hub deploy 的 `mx-common ensure` 可能因模板差异滚动重启共享 PG，不用 deploy/ensure 代替只读检查 |
| mx-device | [Compose 清单](../mx-device/compose.yaml)使用 `postgres:17-alpine` 默认入口，没有覆盖 PG 启动命令；部署保留已有 PG 容器 | 未发现同类缺口；该项目不经过 Kubernetes/etcd |
| mx-rig | [Kubernetes 清单](../../mx-rig/deploy/k8s/internal/15-postgres.yaml)先由 init 容器处理所有者，PG 主容器保留默认入口；[Compose 清单](../../mx-rig/deploy/compose.yaml)也保留默认入口 | 无 Pay 同类缺口；Kubernetes init 对已有私有数据目录的遍历权限需要补足，见下文。Compose 不受该 init 问题影响 |

[官方 PostgreSQL 入口](https://github.com/docker-library/postgres/blob/master/docker-entrypoint.sh)会在启动时执行 PGDATA 目录权限处理，包括已有数据库。因此，不能把业务清单中不含字面字符串 `chmod -- 00700` 当成缺少保护；权限处理在镜像内部。目录所有者不匹配、只读挂载等异常仍可能使权限处理失败。

mx-rig 原 Kubernetes init 容器删除全部 capabilities 后仅保留 `CHOWN`，以 root 执行递归 `chown`。已有 PGDATA 通常为 `999:999`、`0700`，root 在缺少目录读取/搜索绕过能力时仍可能无法遍历它，导致 Pod 重建卡在 init 阶段；普通主容器重启不会重跑 init。[Linux capabilities 手册](https://man7.org/linux/man-pages/man7/capabilities.7.html)区分了修改所有者的 `CHOWN` 和绕过读取/搜索权限的能力。仓库已仅为该 init 增加 `DAC_OVERRIDE`，保留 PG 主容器限制和数据路径。Rig 未使用 Pay 的 `OnDelete` 策略，正常 deploy 会应用 PG 清单，模板变化可能自动滚动重建数据库 Pod；应用修复应在 Rig 数据库备份和维护窗口内进行，不把 deploy 当作只读检查。已退役的 mx-auto-server 清单也有相同 init 配置，若仍有遗留实例需单独核对，不能因已整合进 Rig 就认定实例已不存在。

以上结论来自仓库和镜像入口源码审查，未验证其他项目线上 StatefulSet/Pod 是否与仓库一致，也不覆盖仍在运行的旧 Hub 独立数据库或已被 mx-rig 替代的旧服务实例。若核对线上配置，应只读检查实际镜像、启动命令、securityContext、卷类型及 PGDATA 所有者/权限，不通过重启试验。此次 Launcher 的 73 项恢复相关测试、mx-common 的 25 项存储预检测试、Rig 的 2 项管理流程测试通过；Rig 离线清单构建及结构差异检查通过，工作负载唯一变化为该 init 增加一项 capability。本地 Docker 未运行，未做真实 Linux 容器验证；离线测试不等同线上重启验收。

这些项目仍共享宿主机资源。`TMPDIR=/data/tmp` 只控制各自使用的临时文件，不改变 Docker/containerd 的 data-root 或业务数据库位置；Launcher 的 BuildKit 缓存保留参数不能视为这些项目也会执行的缓存限制。此前部署兼容性审查的离线测试共 105 项通过（DataPort 25、Pay 58、Device 22），未执行生产发布；各自真实业务可用性仍需线上验收。

## 回滚使用最新数据

迁移成功后，1T 盘上的 etcd 会继续接收 Kubernetes 写入，原 2T 目录便成为历史副本。**不能直接把挂载改回旧目录**，否则可能丢失迁移后的集群变更。

```bash
bash scripts/manage.sh etcd rollback
```

回滚会重新做备份，暂停当前 etcd，将当前完整数据冷复制到原 2T 文件系统上的**另一个新目录**，核验后切换。它保留最初的 2T 目录、1T 目录和所有备份。回滚会核验原盘 UUID 与物理父盘身份，不会把更换过的盘当作原盘。

正常 `rollback` 要求上一轮 `migrate` 已完成、当前 etcd 和集群能够通过检查、原盘可读写且空间足够。原盘仍有 I/O 故障时，回滚复制或验收可能失败；命令不会强制绕过这些检查。

如果回滚在允许新副本写入前失败，并已安全恢复到 1T 活动目录、状态变为 `aborted`，可以再次执行同一个 `rollback` 命令。重试会复制此时的最新数据，使用另一个新目录，保留上次失败副本。

## 中断后恢复

先查看记录，再按记录恢复：

```bash
bash scripts/manage.sh etcd status
bash scripts/manage.sh etcd resume
```

`status` 显示方向、阶段、源/目标路径、原盘目录、事务目录及业务容器变化，不输出快照、证书或凭据内容。它读取的是持久化事务记录，不据此宣称服务当前健康。

`resume` 有两个明确边界：

- **新副本尚未获准写入**：恢复本事务开始前的源目录、挂载和 manifest，验收后将事务标为 `aborted`。这也适用于一次尚未切换的回滚事务；不会删除失败副本。
- **新副本可能已经写入**：只恢复或验收新副本，保留它作为权威数据，不自动启用历史目录。验收完成后，再用 `rollback` 将最新数据迁回原盘。

发现挂载、CRI、`fstab`、manifest 或 Launcher 恢复文件被其他操作修改，或无法证明当前数据身份时，会停止恢复。此时保留事务目录作人工排查依据；不要通过删除状态文件、直接挂回旧目录或重新初始化集群绕过检查。`resume` 不是从任意磁盘损坏中恢复服务的通用命令。

## 备份位置、空间与后续增长

状态和备份默认放在独立根盘：

```text
/var/lib/mx-move/
  current.json                    最近事务指针/记录
  active-etcd.json                启动保护使用的当前数据目录身份
  boot-guard.py                   独立于仓库的只读启动检查程序
  runs/<时间>-<随机标识>/          单次事务、快照及配置备份
    journal.json
    snapshot.db
    etcd.yaml
    fstab.before
    fstab.after
    pki/
    launcher-identity/
    etcdctl
  etcd-data/mx-etcd-.../           迁移后的活动数据或保留副本
```

事务目录由 root 持有、权限为 `0700`，状态与快照为 `0600`。snapshot 包含 Kubernetes 数据，PKI 与 Launcher 恢复文件也属于敏感备份，不应提交到 Git 或上传公开位置。

当前活动 etcd 与 `/var/lib/mx-move/runs` 均在同一系统盘，这些本地备份不能抵御该盘损坏。后续应增加定期 etcd 快照、必要配置/证书的加密异机备份，并在隔离环境演练恢复；PostgreSQL、ES 和业务文件需各自备份。当前工具只生成迁移事务备份，没有配置自动备份或异机容灾。原 `/data/mx-runtime/etcd` 自迁移后不再更新，不能作为最新灾难恢复副本。

空间检查使用固定 **50 GiB 安全预留**，复制与备份预算额外叠加。迁移到根盘时，按当前 etcd 目录大小的 3 倍加 1 GiB 估算本轮副本与备份需要。回滚分别检查原盘和存放快照的根盘；复制前还会复查可用空间，均使用相同的 50 GiB 预留。以实际 `plan` 检查为准。

空间不足时，报错会显示检查路径、总容量、当前可用、复制/备份预算、安全预留、合计需要的可用空间，以及向上取整的释放缺口。2026-10-19 的本次实测根分区为 1023.50 GiB、可用 96.13 GiB，etcd 约 382 MiB：本轮预算约 2.12 GiB，加上固定 50 GiB 安全预留，至少需约 52.12 GiB 可用，因此此项空间检查可通过。执行前仍须重新运行 `plan`，以当时实际值和其他检查结果为准；工具不会自动清理空间。`/home` 是独立文件系统，清理 `/home` 不会增加 `/` 的可用空间。

同日补充的现场采样：`/` 使用率 91%、可用 97G，`/data` 使用率 30%，`/var/lib/etcd` 约 383M。etcd 在 3 秒进程 I/O 采样中约写入 15 KB/s，多组 PostgreSQL 和 Celery 写入更明显；该短采样不能将进程直接归属到具体业务或物理盘。

两块 NVMe 的 SMART 均报告 `critical_warning=0`、`media_errors=0`、`num_err_log_entries=0`。数据盘 nvme0 温度 60°C、寿命消耗估计 2%、历史警告温度时间 5 分钟；系统盘 nvme1 温度 44°C、寿命消耗估计 30%、历史警告温度时间为 0。[NVMe SMART 字段定义](https://github.com/linux-nvme/libnvme/blob/master/doc/rst/types.rst)中的 `percentage_used` 是厂商估算的耐久度消耗，不是文件系统使用率或精确的剩余寿命。此次 SMART 输出未报告介质错误，不能据此否定此前内核记录的 nvme0 I/O timeout，也不能仅凭 60°C 判定降速原因。迁移前仍须通过最新 `plan` 与根盘空间预检。

etcd 不存放 Docker 镜像、PostgreSQL 表或 ES 索引，其增长主要来自 Kubernetes 对象和相关历史数据；这些业务数据不会随本次迁移进入 1T 盘。etcd 数据、事务快照和保留目录仍会增长，反复迁移也会累积副本。工具没有自动清理、压缩或碎片整理行为；后续稳定后再单独规划清理，当前活动目录必须保留。

## 本地验证

在 `electron-dock/mx-base/mx-move` 目录运行迁移逻辑、运行时消费者和 Launcher 身份更新的隔离测试：

```bash
python3 -m unittest discover -s etcd/tests -p 'test_*.py'
node --test etcd/tests/launcher-identity.test.mjs
python3 -B -m unittest discover -s k8s/tests -p 'test_*.py'
node --test ../../mx-dataport/tests/k8s-runtime.test.mjs ../../mx-dataport/tests/operations.test.mjs
```

Python `test_runtime_consumers.py` 覆盖 shell/Pay 调用者，`test_cutover_host.py` 检查 DataPort 模块和部署接线是否齐全；DataPort 实际命令行为由上列 Node 测试覆盖。仅通过 Python 套件不能替代 DataPort 的运行时与部署回归。

单元测试不会证明真实主机上的挂载、SELinux、kubelet 停止时序或生产登录/联网已经验收。真实迁移结果以目标主机上的检查、切换验收及业务验证为准。

设计依据：[etcd 备份与恢复](https://etcd.io/docs/v3.6/op-guide/recovery/)说明快照的完整性校验、WAL 的作用以及 restore 会重建 member 身份；[kubeadm 静态 Pod 管理](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/#renew-certificates-with-kubeadm)说明通过暂时移出 manifest 停止对应静态 Pod。本工具沿用完整冷副本的原集群身份。
