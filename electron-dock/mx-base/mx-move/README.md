# mx-move：Kubernetes 存储迁移

`mx-move` 集中放置 Kubernetes 存储迁移工具。目前只实现 `etcd/`：将现有单节点 kubeadm 集群的 etcd 从业务数据盘迁移到独立根盘，并支持把最新数据迁回原盘。它保留原目录、快照和每次复制的数据，不提供删除命令。

这次实现针对 Internal 当前的布局：`/var/lib/etcd` 通过 bind mount 使用数据盘上的目录，目标是另一块系统盘上的根文件系统。2026-10-19 的 `lsblk` 确认两块物理盘均约 2TB；此前所称的“1T 盘”实际是系统盘上的 `cl-root` 逻辑卷，同一系统盘另有 `cl-home`。工具读取实际挂载、文件系统 UUID 和物理父盘验证布局，不根据 `nvme0` / `nvme1` 名字或标称容量猜盘。默认目标是根文件系统上的 `/var/lib/mx-move/etcd-data/`；源、目标若位于同一物理盘，检查会拒绝迁移。下文的“1T”均指这个根逻辑卷。

本模块未在生产服务器执行迁移，也未完成真实块设备上的切换集成验证。

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

2026-10-19 的现场配置为 fstab 生成、无 drop-in，`[Mount]` 中 `What=/data/mx-runtime/etcd`、`Where=/var/lib/etcd`、`Options=bind`。活动挂载的 `systemctl show What` 返回 `/dev/nvme0n1p1`，不能据此判断下次开机使用哪个目录。工具读取经过来源核验的生成文件；[systemd 说明](https://www.freedesktop.org/software/systemd/man/latest/systemd.mount.html#fstab)中 `/etc` 下原生 mount unit 可以覆盖 fstab，不能只验证 fstab 文本。

### 共享 `/data` 的所有权

Internal 的实测布局为：`/data` 是 `1003:1003 755`，`/data/mx-runtime`、`/data/mx-runtime/etcd` 和 `/var/lib/etcd` 均为 `root:root 755`；活动挂载是 `/dev/nvme0n1p1[/mx-runtime/etcd]`。旧版对整条路径统一要求 root 所有，因此在 `/data` 停止；这条报错本身不表示 etcd 数据损坏。

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

空间检查使用固定 **50 GiB 安全预留**，复制与备份预算额外叠加。迁移到根盘时，按当前 etcd 目录大小的 3 倍加 1 GiB 估算本轮副本与备份需要。回滚分别检查原盘和存放快照的根盘；复制前还会复查可用空间，均使用相同的 50 GiB 预留。以实际 `plan` 检查为准。

空间不足时，报错会显示检查路径、总容量、当前可用、复制/备份预算、安全预留、合计需要的可用空间，以及向上取整的释放缺口。2026-10-19 的本次实测根分区为 1023.50 GiB、可用 96.13 GiB，etcd 约 382 MiB：本轮预算约 2.12 GiB，加上固定 50 GiB 安全预留，至少需约 52.12 GiB 可用，因此此项空间检查可通过。执行前仍须重新运行 `plan`，以当时实际值和其他检查结果为准；工具不会自动清理空间。`/home` 是独立文件系统，清理 `/home` 不会增加 `/` 的可用空间。

同日补充的现场采样：`/` 使用率 91%、可用 97G，`/data` 使用率 30%，`/var/lib/etcd` 约 383M。etcd 在 3 秒进程 I/O 采样中约写入 15 KB/s，多组 PostgreSQL 和 Celery 写入更明显；该短采样不能将进程直接归属到具体业务或物理盘。

两块 NVMe 的 SMART 均报告 `critical_warning=0`、`media_errors=0`、`num_err_log_entries=0`。数据盘 nvme0 温度 60°C、寿命消耗估计 2%、历史警告温度时间 5 分钟；系统盘 nvme1 温度 44°C、寿命消耗估计 30%、历史警告温度时间为 0。[NVMe SMART 字段定义](https://github.com/linux-nvme/libnvme/blob/master/doc/rst/types.rst)中的 `percentage_used` 是厂商估算的耐久度消耗，不是文件系统使用率或精确的剩余寿命。此次 SMART 输出未报告介质错误，不能据此否定此前内核记录的 nvme0 I/O timeout，也不能仅凭 60°C 判定降速原因。迁移前仍须通过最新 `plan` 与根盘空间预检。

etcd 不存放 Docker 镜像、PostgreSQL 表或 ES 索引，其增长主要来自 Kubernetes 对象和相关历史数据；这些业务数据不会随本次迁移进入 1T 盘。etcd 数据、事务快照和保留目录仍会增长，反复迁移也会累积副本。工具没有自动清理、压缩或碎片整理行为；后续稳定后再单独规划清理，当前活动目录必须保留。

## 本地验证

迁移逻辑和 Launcher 身份更新的隔离测试可在开发机运行：

```bash
python3 -m unittest discover -s etcd/tests -p 'test_*.py'
node --test etcd/tests/launcher-identity.test.mjs
```

单元测试不会证明真实主机上的挂载、SELinux、kubelet 停止时序或生产登录/联网已经验收。真实迁移结果以目标主机上的检查、切换验收及业务验证为准。

设计依据：[etcd 备份与恢复](https://etcd.io/docs/v3.6/op-guide/recovery/)说明快照的完整性校验、WAL 的作用以及 restore 会重建 member 身份；[kubeadm 静态 Pod 管理](https://kubernetes.io/docs/tasks/administer-cluster/kubeadm/kubeadm-certs/#renew-certificates-with-kubeadm)说明通过暂时移出 manifest 停止对应静态 Pod。本工具沿用完整冷副本的原集群身份。
