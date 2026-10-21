# Internal Kubernetes 数据切换

2026-10-20，最新事务 `mx-k8s-20261020-053718-a8d8c128` 已完成迁移，服务器回传 **`phase=services-restored`、`may_write=true`、`automatic_checks_passed=true`**。五个数据根使用根逻辑卷上的新副本，独立服务为 `mx-k8s-containerd.service`，socket 为 `/run/mx-k8s-containerd/containerd.sock`。用户此前已在新副本上确认 MX-H2I 原用户登录、联网和 Pay 访问正常。Docker 数据未迁移，etcd 未再次迁移，NAS 未纳入操作，历史数据及备份保留；无需继续执行 `migrate` 或 `resume`。

历史事务 `mx-k8s-20261020-045344-8a34e06b` 已为 `aborted / may_write=false / recovery_status=restored`；随后 Docker 查询回传 `equivalent=true / ignored_differences=[mount_order]`。成功事务曾在 `committed` 阶段遇到 `workload set changed during migration`，位置 `Host.verify → Cluster.assert_workloads`；TTL 兼容修复后，用户已执行 `resume` 并完成最终验收。下文保留当时的执行及排障过程，不能据此重新发起已完成的迁移。

最终摘要中的 `user_login_and_network_validation=required` 是程序固定输出的人工验收提示，不表示失败，也不记录用户已完成的登录、联网实测。`capacity` 中的复制估算、根卷剩余空间及预留值来自迁移预检，不能作为切换后的实时磁盘容量。`historical_data_deleted=false` 表示原历史副本尚未清理，本次成功验收不包含旧数据删除。

## 2026-10-21 后续发布与公网身份故障

DataPort 旧发布脚本未选择独立 containerd，后续回执确认迁移 Pod `ErrImageNeverPull`，容器未启动；已用 `23fb2852` 补齐运行时选择和 CRI 镜像 ID 核验。旧失败镜像是否只存在于原 runtime，仍需新旧实例的实际对比，不能仅凭 Job 等待 Complete 超时推定。

当前另有公网身份 hostPort 故障：`mx-identity-public` 在 `mx-internal-server` 上 Running/Ready，Pod `192.168.224.83` 的 `/healthz` 返回 200；宿主机拥有 `10.88.88.88`，Pod 声明 `hostIP/hostPort: 10.88.88.88:18444`，但该地址拒绝连接，已查 nft `CNI-HOSTPORT-DNAT` 仅有 18220、没有 18444。当前证据指向 hostPort 转发缺失，规则消失原因未确定，不能归并为镜像导入故障或宣称已恢复。

自动验收的控制器 Ready 检查不覆盖 hostPort DNAT 和公网 SSO；详细边界及恢复验证见[运行时消费者记录](runtime-consumers.md#2026-10-21-公网身份-hostport-故障与验收范围)。**不能为缺失 hostPort 再运行这个已完成事务的 `migrate` 或 `resume`。** 保留已提交的新副本、原账号/凭据和 MX-H2I 登录联网配置，转发修复与端到端验收单独处理。

## 维护前同步

以下清单保留为运行时适配文件的同步合同，不表示本现场需要重新迁盘。在原服务器仓库同步时保留 `electron-dock/` 下各项目相对目录；不能只同步一个 `manage.sh` 或把 `mx-move` 单独放到另一目录。至少包括：

| 范围 | 必须同步的内容 |
| --- | --- |
| mx-move | 整个模块，包括 `k8s/`、`etcd/`、入口与依赖文件。 |
| Launcher | `scripts/k8s-production-recovery.sh`、`scripts/manage.sh`、`scripts/install-k8s-centos.sh`，以及原有恢复/身份模块。 |
| Hub、mx-common | 各自 `scripts/manage.sh`，保留 mx-common 的存储预检模块。 |
| DataPort | `scripts/k8s-runtime.mjs` 和 `scripts/operations.mjs`，保留部署所需模块；预检同时检查解析器、显式地址导入及 CRI 镜像核验，不能只同步 helper。 |
| Rig | `scripts/manage.sh`、`scripts/build-proxy.sh`。 |
| Pay | `scripts/runtime.mjs`、`scripts/build-proxy.sh`，保留原 `postgres.mjs` 及其模块依赖。 |
| mx-base 父入口 | `scripts/manage.sh` 已增加精确转发；下列命令使用模块入口，不依赖旧父入口。 |

服务器现有 Pay `.deploy/database.json`、Launcher 恢复文件、Secret、私钥和运行环境是本次核验依据，必须保留原件；不要用开发机配置替换，不要补造缺失身份文件。预检发现缺失、权限异常、模板变化或未同步的运行时入口会停止；不通过普通 deploy、重建数据库或重新注册 SSO 来修复迁移预检。

维护窗口期间暂停其他项目发布、自动备份和数据库维护任务，避免它们在停写、复制或身份更新时重新启动工作负载或改写数据。工具会取得相关操作锁并检查状态漂移，但锁不能覆盖所有外部任务；完成自动检查及现场验收后再恢复这些任务。

## 执行命令

以下命令均以 **root** 在服务器的 **`electron-dock/mx-base` 目录**执行。若已在 `mx-move` 目录，只将入口改为 `bash scripts/manage.sh`。

### 已完成的工作负载验收与 TTL 修复

现场 `workload-check` 已确认只有 `mx-harbor/mx-harbor-migrate-256cfbfe` 缺失，原 UID 为 `7d914a1b-a9cc-4a55-8f3d-88f25de7d4d4`；基线终态为 `Complete`、无活动实例、TTL 为 86400 秒、完成时间为 `2026-10-18T21:54:26Z`。按完成时间计算，到期时刻为北京时间 2026-10-20 05:54:26，落在迁移期间。没有新增或同名替换工作负载；这些证据符合 TTL 清理，但不能单凭摘要确认删除操作者。

用户同步更新后的 `mx-move/k8s/cluster_ops.py`，并已执行以下恢复命令完成验收（当前无需重跑）：

```bash
bash mx-move/scripts/manage.sh k8s resume
```

新版守卫仅允许缺失的基线 Job 同时满足：唯一 `Complete=True`、无 `Failed=True`、无活动或正在终止的实例、无删除标记、TTL 为有效非负整数、完成时间与完成条件转换时间均有效且 TTL 已到期。Kubernetes 使用完成条件的 `lastTransitionTime` 起算 TTL，工具保守取它与 `completionTime` 的较晚值，依据见 [TTL 控制器实现](https://github.com/kubernetes/kubernetes/blob/master/pkg/controller/ttlafterfinished/ttlafterfinished_controller.go)。基线和现场中通过 owner UID 或 controller UID 标签关联的 Pod 都必须已终止，且没有运行或等待中的容器。其余缺失、新增、同名 UID 替换，以及现存对象的配置变化仍拒绝；原基线不修改，也不重建 Job。

提交后的 `resume` 不重复冷复制，也不退回旧副本；已经运行的服务使用 `start` 保持运行，已恢复的副本数不重复修改。服务器已实际回传 `phase=services-restored`、`may_write=true`、`automatic_checks_passed=true`，确认本次自动验收完成。

需要继续只读定位集合差异时可运行：

```bash
bash mx-move/scripts/manage.sh k8s workload-check
```

命令只读六类控制器：Deployment、StatefulSet、DaemonSet、Job、CronJob、HPA，比较最近事务记录和当前对象集合、UID。输出只包含 namespace/name/UID 和固定的 Job 终态、活动标记、TTL、完成时间、删除标记；不输出模板、环境变量、Secret、日志、注解或完整 API 对象，不改基线、不创建或删除 Job。`differences` 列出缺失、新增、同名替换对象；`workload_set_equal` 只判断集合，`equivalent` 还核对 UID。退出码 0 表示集合和 UID 一致，2 表示有差异，1 表示检查无法完成。

该查询始终显示原始集合差异，因此已放行的 TTL 清理仍会报告 `equivalent=false` 和退出码 2；迁移是否完成以 `resume` 的完整验收摘要为准。它只定位集合和 UID 变化，不代表模板、凭据、数据库或整体迁移验收已经通过。

### 历史 Docker 比较阻断

旧程序直接比较整份 Docker 盘点记录，包含每个容器原序的 `.Mounts` 和成功重试后留下的 `diagnostics`。Moby 的旧实现从映射生成挂载列表，返回顺序可能变化，见[官方排序修复](https://github.com/moby/moby/commit/ff0b471f2091c7b7be351cee44c2a013fb6914d7)。这两项非业务差异会造成误报，但旧事务未保存失败当时的后快照，不能据此认定本次没有真实 Docker 状态变化。

同步新增 `k8s/docker_compare.py`、更新后的 `k8s/cutover.py` 和入口 `scripts/manage.sh`，执行：

```bash
bash mx-move/scripts/manage.sh k8s docker-check
```

查询只读当前 Docker 和最近事务的私有预检记录，不停止服务、不修改事务或挂载，也不读取 NAS 文件。先验证盘点完整性、数量与 ID 对应关系，再统一列表顺序并排除成功采集的诊断提示；Docker 根目录、容器集合、运行/暂停状态、重启策略、停止信号及每个挂载的全部字段仍严格比较。未知字段也保留比较，公开摘要只使用固定字段名与合法容器 ID，不显示挂载路径、容器名称或配置值。

`equivalent=true` 表示当前实质内容与预检基线一致；若同时 `raw_equal=false`，`ignored_differences` 会说明 `mount_order`、`container_order` 或 `probe_diagnostics` 差异。`equivalent=false` 时查看 `changes` 并回传摘要，不直接重跑迁移。退出码 0 表示一致，2 表示发现真实差异，1 表示无法完成核验。`historical_failure_reconstructed=false` 明确表示此刻查询没有重建过去的失败现场。后续正式迁移遇到真实差异，会在恢复前记录并输出脱敏差异，原始基线保持不变。

只读核对通过后仍需完整预检，并在维护窗口内执行正式迁移。

先运行不停止业务的检查：

```bash
bash mx-move/scripts/manage.sh k8s cutover-check
```

预期摘要为 `phase=preflight-passed`、`execution_started=false`。检查当前节点/集群、候选与旧运行时、产品入口、全部挂载、Docker 消费者、原数据库/卷/凭据身份及目标空间；不建立正式迁移事务或修改服务。检查可使用私有临时请求文件和操作锁，它们不是业务迁移。

若旧版工具在此时报 `systemctl returned an ambiguous kubelet configuration`，先同步 `k8s/endpoint_config.py` 的兼容修复，再重跑同一预检，无需重启服务、执行 `daemon-reload` 或重新导入镜像。[systemd v219](https://raw.githubusercontent.com/systemd/systemd/v219/src/systemctl/systemctl.c) 会将环境文件逐条输出为 `EnvironmentFile=…`，[v239](https://raw.githubusercontent.com/systemd/systemd/v239/src/systemctl/systemctl.c) 和 [v252](https://raw.githubusercontent.com/systemd/systemd/v252/src/systemctl/systemctl-show.c) 使用逐条 `EnvironmentFiles=…`；空数组可能完全省略该字段。解析器现按原顺序统一这些格式，仍拒绝重复路径、重复标量属性、多个启动命令和端点覆盖。

若旧版工具报 `产品运行时入口未同步完整适配：mx-rig/scripts/manage.sh`，可能是预检未识别 Rig 的共用解析器：`manage.sh` 加载 `build-proxy.sh` 并调用其中的 `rig_managed_runtime_value`，解析器路径只定义在后者。先同步 `k8s/cutover.py` 的修复，再重跑同一预检；新版会核对调用入口与共用脚本，仍拒绝缺失或未适配的文件。此修复不需要重新部署 Rig、重启服务或重新导入镜像。

若旧版工具报 `Kubernetes storage identity mismatch; raw values hidden`，已知一个发生在数据库核验之前的误判：systemd 将 Launcher 挂载单元中的连字符编码为文件名中的字面量 `\x2d`，旧检查使用数据目录规则而拒绝该文件名。同步 `k8s/storage_ops.py` 后重跑预检。修复仅允许固定 generator 目录下由五个已选挂载路径推导出的单元文件，仍检查父目录、普通文件类型、root 所有者、写权限和单元内容；数据路径与 PostgreSQL 身份规则保持原样。若仍报错，保留现场并回传输出，不根据这条通用错误修改数据库或目录权限。

若报 `迁移子命令失败：node，退出码 1（原始输出已隐藏）`，仅凭这一行无法判断实际原因。同步 `k8s/cutover.py` 和 `k8s/storage-identities.mjs` 后重跑 `cutover-check`，回传 `identity_diagnostics`。它只输出固定的阶段、文件用途、错误分类、校验规则编号和 Node 数字版本；`payCheckpoint` 指服务器原有 `mx-pay/.deploy/database.json`，`missing_path` 指缺失路径，`guard_rejected` 指既有安全或身份规则拒绝。规则编号来自工具内固定断言文本，不是凭据或文件内容摘要。若模块在导入/解析阶段退出，则显示依赖或语法错误分类；未知错误保持隐藏。此诊断不会创建缺失身份文件、修改权限或放宽身份比较，也不改变 NAS、挂载或业务运行状态。

现场随后回传 `stage=source-file, subject=common, rule=bd43410c4276`，并确认 `/var/lib/mx-common` 为 root 所有的 0755 目录，`storage-identity.json` 为 root 所有的 0600 普通文件、单硬链接。旧工具把通用数据父目录当作私有凭据目录而误拒绝；mx-common 的身份记录生成器不会修改已有父目录权限。同步 `k8s/storage-identities.mjs` 后重跑预检：仅此 common 父目录允许组/其他用户读取与遍历，仍禁止组/其他用户写入、错误所有者和符号链接；生产路径整个父链的保护检查及文件私有权限、单硬链接、inode 核验保持不变。Launcher、Pay、请求与事务目录仍按私有目录检查。无需修改服务器目录权限，数据库身份比较仍会继续执行。

若报 `stacked mounts are unsupported`，先查看 `duplicate_targets` 中的路径和层数。现场已确认 `/proc/sys/fs/binfmt_misc` 有两层挂载，旧版工具因全机任意重复而拒绝，范围过大。同步新版 `k8s/storage_ops.py` 后重跑预检：仅拒绝覆盖迁移逻辑目录、物理源目录、事务目标目录或其子树的重复挂载，以及覆盖 Docker、etcd、NAS 保护路径（含动态 Docker 挂载源）自身或祖先的重复挂载。复制、切换、恢复和卸载 kubelet 子挂载前也复查相应范围。无关重复项保留原状，不自动去重或卸载；`duplicate_targets` 只输出相关阻断路径和层数，不输出挂载源或选项。无需手工卸载 `/proc/sys/fs/binfmt_misc`。

也可在服务器执行下面的只读命令列出重复挂载点；`--raw` 已提供无树形前缀的输出，无需叠加 `--list`（部分版本会报参数互斥，见 [findmnt 文档](https://kernel.googlesource.com/pub/scm/utils/util-linux/util-linux/+/refs/tags/v2.28.1/misc-utils/findmnt.8)）。

```bash
findmnt --raw --noheadings --output TARGET | sort | uniq -cd
```

若报 `Docker 本机消费者盘点不完整`，同步 `k8s/cutover.py` 后重跑预检并回传 `docker_diagnostics`。它显示 Docker info 是否取得、容器总数/已核验数，以及失败阶段、原因分类、退出码和相关容器 ID；不输出完整 inspect、环境变量或命令原始错误。`timeout` 表示该条 Docker 命令触及 30 秒上限，`daemon_unavailable` 表示连接失败，`template_error` 或 `invalid_or_incomplete_response` 需要检查 CLI 返回兼容性。总体预检已运行 60 秒不等于 Docker 命令必定超时；在完整盘点前仍拒绝切换，不重启 Docker 或迁移其数据。

若报 `unsupported kubelet submount`，不要手工卸载，也不要把所有 XFS 子挂载加入卸载白名单。现场已确认两项来自原 `/data` 盘：Pay 的 `mx-pay-postgres-data` local PV，及 ES 的只读 `elasticsearch.yml` ConfigMap subPath。新版同时需要 `k8s/cutover.py`、`k8s/storage_ops.py`、`k8s/kubelet_bindings.py`：在线预检将它们与当前 Pod/PV/PVC/配置卷关系、文件系统 UUID、实际目录或文件身份核对，单独登记为由 kubelet 管理的绑定。维护时先正常停止对应 Pod，保持 kubelet 运行并等待它释放绑定，最多 120 秒；完成后才停止运行时并冷复制。若绑定残留或变化，拒绝继续并尝试恢复原业务，绝不以手工 `umount` 兜底。手工清理仍仅限已记录且身份未变的 projected/secret tmpfs。

NAS 明确排除：不迁移其数据，不更改或卸载 `/mnt/nas`，不更改 NAS 的 fstab 行。历史盘点记录过 Docker 容器绑定 `/mnt/nas/pgsql/data` 及验证码目录，因此按已使用的存储保护，不能按“看起来没数据”处理。任何未核验的 NFS/CIFS/CSI 或其他 kubelet 子挂载仍阻止迁移；检查不读取 NAS 文件内容。

若 `migrate` 只输出通用隐藏错误，先用 `status` 确认提交状态。现场事务 `mx-k8s-20261020-043136-47c1e44e` 已为 `aborted / may_write=false`，6 个配置文件已保存，但未保存 `snapshot_sha256`；etcdctl 和 `kubernetes.before` 存在，`snapshot.db` 不存在。这将失败范围缩小到配置备份或在线快照保存附近，尚不能确定具体原因。原版本没有记录错误细节，不从这些痕迹推断数据库故障。

同步 `k8s/cutover.py` 和模块入口 `scripts/manage.sh` 后，可先独立验证准备步骤：

```bash
bash mx-move/scripts/manage.sh k8s prepare-check
```

此命令重新预检，在独立的 root 私有目录备份身份、配置、etcdctl 和在线 etcd 快照，并校验原登录配置基线；会占用少量备份空间，但不暂停工作负载、不复制业务数据、不修改挂载、NAS 或当前事务指针。它要求当前没有未恢复的迁移事务，成功摘要为 `phase=preparation-checked / execution_started=false / service_changes=false`，失败则输出具体的 `preparation_diagnostics`，仅含步骤、固定分类、退出码或 errno、工具源码位置；凭据和原始错误仍隐藏。独立记录留在输出所指目录；`status` 仍指向之前的正式事务。失败不需要对这次准备检查运行 `resume`。成功后再在维护窗口运行 `migrate`，正式迁移会重新检查并生成自己的备份。

现场 `prepare-check` 随后明确失败于 `kubernetes-backup / copy_failed`，即 `/etc/kubernetes` 目录复制，尚未进入 etcd 快照。`shutil.Error` 是多项复制错误的聚合，顶层 `errno=null` 不代表子错误没有编号。新版 `k8s/cutover.py` 会额外输出 `copy_errors`（最多 20 项）、总数和截断标记；每项只含经过路径校验的相对路径、数字 errno 和固定原因，未知路径显示 `unknown`，不输出目标路径、原始错误、链接目标或文件内容。诊断仅投影已有异常，不为生成报告执行 stat/readlink 或访问 NAS。不要为了通过检查而启用忽略坏链接、跳过未知文件或忽略复制错误。

可先用以下只读命令盘点特殊文件；不读取文件内容，不跟随符号链接，不跨文件系统。若发现链接或挂载到外部存储，先核对其用途，再决定备份方式。

```bash
find -P /etc/kubernetes -xdev ! -type f ! -type d -printf 'type=%y path=%p\n'
```

现场仅发现两条链接，均位于已记录的早期认证修复备份：

- `mx-kubelet-auth-repair.CeHaeh/pki.before/kubelet-client-current.pem`
- `mx-kubelet-auth-repair.CeHaeh/old-clients/kubelet-client-current.pem`

默认 `copytree` 会展开这些历史链接；目前尚未取得其目标是否存在的证据。新版只将这两条已核验路径按符号链接原文备份（即使目标已不存在），不解析或读取目标、不改动原链接，也不跳过历史目录。其余普通配置、证书和历史文件仍完整复制；活动配置或其他未知链接、特殊文件、非本机根卷及已发现的嵌套挂载会拒绝。复制前后复核源目录身份和挂载，并比较源与备份的链接原文；禁止访问 NAS 链接目标。沿用维护期间暂停其他发布/修复操作的要求，避免目录或挂载并发变化。

现场随后回传 `mx-k8s-20261020-045146-bf03602a`：`phase=preparation-checked`、`preparation_step=flush`、`execution_started=false`、`service_changes=false`。配置及历史链接备份、在线 etcd 快照校验和原登录配置基线检查已完成；预计复制 139,914,613,190 bytes，根卷可用 931,007,381,504 bytes，要求保留 107,374,182,400 bytes。`automatic_checks_passed=false` 在此阶段是正常值，迁移后的自动验收尚未执行。

这次准备检查没有替换正式事务指针；之前正式事务仍为 `aborted`。下一次 `migrate` 将重新预检、生成新事务及备份，无需对成功的准备检查执行 `resume`，也无需传入它的事务目录。原认证文件、历史修复备份和当前业务保持原状；真实用户登录、联网及 Pay 验收仍须在切换恢复后完成。

### Rig 初始化失败时恢复原业务

后续现场确认 `mx-rig-postgres-0` 的主容器为 `PodInitializing`，`fix-permissions` 为 `CrashLoopBackOff`，报 `chown: /var/lib/postgresql/data/pgdata: Permission denied`。它执行已知递归 chown，但安全上下文只保留 `CHOWN`，缺少仓库清单已补充的 `DAC_OVERRIDE`。自动恢复先等所有数据库 Ready，再恢复应用；旧程序此处静默等待最长 1200 秒，磁盘上的 `phase=quiescing / quiesced=true` 不代表还在生成 ES 快照。

先让原 `migrate` 进程结束并保留其最后错误。同步 `k8s/cutover.py`、`k8s/cluster_ops.py`、新增 `k8s/rig_init_repair.py`（入口帮助同步 `scripts/manage.sh`），再以 root 在 `mx-base` 目录执行：

```bash
bash mx-move/scripts/manage.sh k8s resume --repair-rig-init
```

该入口取得既有迁移锁，只允许已停写、快照已校验、尚未复制或切换的 `quiescing / may_write=false` 事务。它重新核验原 Rig 卷、集群身份和工作负载规格，把修复意图保存在独立字段，不修改原 `cluster.objects` 基线；仅接受既有 StatefulSet 的 `fix-permissions` 能力列表由 `[CHOWN]` 变成 `[CHOWN,DAC_OVERRIDE]`，其他字段仍逐项核对。模板已修复时不重复打补丁。不会运行 Rig deploy、数据库迁移或修改 Secret/PVC。

现场另已确认更新策略为 `RollingUpdate / partition=0`，不能套用仓库当前的 `OnDelete` 假设。入口先核对故障 Pod 的归属、初始化失败及主 PostgreSQL 尚未启动，再持久化修复意图、正常缩容 Rig 到 0。确认控制器已观察到零副本、Pod 全部退出之后，才在零副本条件下补权限，然后交给原恢复流程还原副本数。整个过程保留现场 `RollingUpdate` 策略；若初始化期间意外恢复，缩容仍遵循正常终止流程，不强制杀库或删除 PVC。[StatefulSet 更新策略说明](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)说明了直接修改运行中模板会触发滚动更新，因此这里先排空再修改。

模板更新使用 UID、resourceVersion、原字段值和零副本的比较条件。对于原本为 `OnDelete` 的事务，则只对确认 PostgreSQL 从未启动的旧故障 Pod 发出带 UID/resourceVersion 前置条件的正常删除请求，由控制器重建，不强制删除或清理数据。中途失败保留明确修复记录，同一命令可重新核对结果后继续；未完成权限修复时，普通 `resume` 会提示继续使用 `resume --repair-rig-init`，不会直接启动旧模板。其他未知模板变化仍拒绝。

随后恢复原数据库和应用，成功为 `phase=aborted / may_write=false / recovery_status=restored`，表示本次迁移已退出且原业务已恢复，并不表示数据迁移成功。验证原 MX-H2I 登录和联网、SSO 与 Pay；回传恢复摘要和最初迁移错误后再处理迁移阻断。新版恢复增加心跳及脱敏的 `failure_diagnostics / recovery_diagnostics`，诊断记录失败不会阻止原有恢复，提交后的恢复方向保持原规则。

**仅在已安排的维护窗口执行：**

```bash
bash mx-move/scripts/manage.sh k8s migrate
```

`migrate` 会重新检查现场，不依赖之前的检查结果。它会暂停 Kubernetes 应用写入，等待 Elasticsearch 原生快照成功，停止 Launcher、mx-common、Rig、Pay 四组 PostgreSQL 与 ES 等有状态工作负载，核验数据库正常关闭后再复制。登录、SSO、应用 API 和 MX-H2I 联网在窗口内可能暂时不可用，不能承诺迁移全程无中断。

无需手工执行 rsync、卸载卷、修改 `fstab`、停止 Docker 或改 kubelet endpoint。原 Docker daemon、数据和共享 containerd 保留；仅清理旧实例里的 Kubernetes tasks/sandboxes。命令失败时保留数据和记录，按下文 `status` / `resume` 处理。

## 本次固定范围

每次事务使用独立 `mx-k8s-<时间>-<随机标识>`，数据目标均位于已核验的根逻辑卷：

| 原业务逻辑路径（保持不变） | 新物理目录 |
| --- | --- |
| `/var/lib/kubelet` | `/var/lib/mx-move/k8s-data/<事务>/kubelet` |
| `/var/lib/mx-launcher` | `/var/lib/mx-move/k8s-data/<事务>/launcher` |
| `/data/k8s/mx-runtime/mx-common/k8s` | `/var/lib/mx-move/k8s-data/<事务>/common` |
| `/data/mx-rig` | `/var/lib/mx-move/k8s-data/<事务>/rig` |
| `/data/mx-pay/mx-pay/postgres` | `/var/lib/mx-move/k8s-data/<事务>/pay-postgres` |

工具在原逻辑路径安装 bind mount，保留 PV/PVC 和宿主机路径。mx-common 的 PostgreSQL、ES 数据、快照及 HanLP 作为一个根目录迁移，不为每个子目录另建挂载。仅在停止全部 Kubernetes 写入者后处理已识别的 kubelet 临时子挂载；未知子挂载、外置 WAL/表空间或 Docker 路径重叠会拒绝。

现有 `/var/lib/etcd` 已在根卷，保持原活动副本和保护，不重迁；旧共享 `/var/lib/containerd`、`/data/docker`、Docker 卷与构建 namespace 不复制。NAS、NFS、已在根卷的旧服务目录和其他 `/data` 内容不属于本次迁移。所谓“1T”是 `cl-root` 逻辑卷，工具按 UUID 核验，不按 NVMe 编号猜测。

## 提交与恢复边界

事务记录位于 `/var/lib/mx-move/k8s-transactions/<事务>/journal.json`；最近指针为该父目录中的 `current.json`。原目录、目标副本、etcd 快照、原配置和身份文件备份全部保留，不提供删除操作。

冷复制保留 UID/GID、权限、ACL、扩展属性和硬链接，并校验内容、元数据及落盘结果。Launcher 的 CA/PG 身份、原用户和 SSO 密钥、Pay 的安装和数据库身份、PV/PVC UID、Secret 与网络配置保留。身份适配只允许本次选定的挂载字段改变；Pay 额外更新现有 PostgreSQL 模板中的 `MX_PAY_EXPECTED_MOUNT_ROOT`，不重建卷或生成凭据。

在新副本可能写入前，工具先保存 `may_write=true` 提交记录，再启用新运行时/挂载启动保护、发布受保护的 `active.json` 并启动 kubelet。之后正常产品发布通过统一解析器连接新 K8s runtime；Docker 构建继续使用旧实例。

kubelet 的原 unit、环境文件及有效启动参数会先记录并核验，显式 endpoint/root 覆盖会拒绝。切换同步更新 kubelet 配置、存在的 `instance-config.yaml` 和本机 `/etc/crictl.yaml`；若 Node 已有旧 kubeadm CRI 标注，使用 UID/版本/原值比较后更新，不主动创建已淘汰的标注。原配置字节保存在私有事务中。

中断或报错后：

```bash
bash mx-move/scripts/manage.sh k8s status
bash mx-move/scripts/manage.sh k8s resume
```

| 持久记录 | `resume` 行为 |
| --- | --- |
| `may_write=false` | 恢复原挂载、配置、身份和原副本服务，成功后标记 `aborted`；保留失败副本。 |
| `may_write=true` | 只继续恢复和核验新副本，保留它作为权威数据；不自动挂回历史目录。 |

**提交后不能直接挂回旧目录。** 新 PG/ES 已可能接收写入，旧目录成为历史副本。将最新数据再迁回原盘需要另一轮停写、复制和验收；当前没有 K8s `rollback` 命令，现有 `etcd rollback` 也不能替代业务数据回迁。挂载、配置、凭据或受管身份被其他操作修改时，恢复会拒绝覆盖。

## 验收

迁移自动恢复完成的摘要为 `phase=services-restored`、`automatic_checks_passed=true`。它核验数据库与挂载保护、原集群与 etcd 身份、PV/PVC 和凭据连续性、旧 K8s tasks 清空、Docker task 保持，以及新运行时的实际使用情况。MX-H2I Gateway、Flannel、kube-proxy 和 CoreDNS 必须恢复就绪。此摘要不是用户验收。

正常完成后用只读命令复核，不再重复 `migrate`：

```bash
bash mx-move/scripts/manage.sh k8s status
bash mx-move/scripts/manage.sh k8s verify
```

`status` 只读最近事务；`verify` 只核验已提交的新副本，不修改挂载、补丁或副本数，也不重启服务。需要恢复操作时显式使用 `resume`。

现场还需使用**原有账户与客户端配置**验收 MX-H2I 登录、联网与 DNS，确认 Hub/Launcher/DataPort/Pay 的 SSO 连通及 Pay 原数据库可用。不能以容器 Running、镜像列表或自动检查替代这些业务结果。整机重启与隔离恢复演练尚未完成。

只贴终端摘要或简短错误。事务中可能包含完整 Kubernetes Secret、PKI、数据库和登录配置，不要贴 journal、快照、环境文件、镜像归档或恢复目录。保留在同一根卷的事务备份不能抵御整盘损坏；本工具不配置异机备份或通用灾难恢复。
