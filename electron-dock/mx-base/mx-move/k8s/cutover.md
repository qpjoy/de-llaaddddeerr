# Internal Kubernetes 数据切换

当前现场已回传 `candidate-ready`：172 个镜像引用、71 个 CRI 镜像、候选工作负载 0，当时根卷剩余 930,353,958,912 bytes。独立服务为 `mx-k8s-containerd.service`，socket 为 `/run/mx-k8s-containerd/containerd.sock`。**保留现有预备目录和归档，不重新导出或导入。预检已通过，迁移尝试在配置备份阶段退出；当前下一步是同步修复并重跑 `prepare-check`。**

本轮代码提供正式停写、复制、挂载与运行时切换事务；现场正式事务为 `aborted / may_write=false`，尚未进入业务停写或完成迁移，也未完成真实用户验收。候选成功只证明镜像和 CRI 准备完成，不表示业务数据已经迁移。

## 维护前同步

在原服务器仓库内同步本次变更，保留 `electron-dock/` 下各项目相对目录。不能只同步一个 `manage.sh` 或把 `mx-move` 单独放到另一目录。至少包括：

| 范围 | 必须同步的内容 |
| --- | --- |
| mx-move | 整个模块，包括 `k8s/`、`etcd/`、入口与依赖文件。 |
| Launcher | `scripts/k8s-production-recovery.sh`、`scripts/manage.sh`、`scripts/install-k8s-centos.sh`，以及原有恢复/身份模块。 |
| Hub、mx-common | 各自 `scripts/manage.sh`，保留 mx-common 的存储预检模块。 |
| Rig | `scripts/manage.sh`、`scripts/build-proxy.sh`。 |
| Pay | `scripts/runtime.mjs`、`scripts/build-proxy.sh`，保留原 `postgres.mjs` 及其模块依赖。 |
| mx-base 父入口 | `scripts/manage.sh` 已增加精确转发；下列命令使用模块入口，不依赖旧父入口。 |

服务器现有 Pay `.deploy/database.json`、Launcher 恢复文件、Secret、私钥和运行环境是本次核验依据，必须保留原件；不要用开发机配置替换，不要补造缺失身份文件。预检发现缺失、权限异常、模板变化或未同步的运行时入口会停止；不通过普通 deploy、重建数据库或重新注册 SSO 来修复迁移预检。

维护窗口期间暂停其他项目发布、自动备份和数据库维护任务，避免它们在停写、复制或身份更新时重新启动工作负载或改写数据。工具会取得相关操作锁并检查状态漂移，但锁不能覆盖所有外部任务；完成自动检查及现场验收后再恢复这些任务。

## 执行命令

以下命令均以 **root** 在服务器的 **`electron-dock/mx-base` 目录**执行。若已在 `mx-move` 目录，只将入口改为 `bash scripts/manage.sh`。

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

同步 `k8s/cutover.py` 后先重跑上面的 `prepare-check`，贴回摘要；不要修改证书权限、删除旧修复备份或运行认证恢复脚本来绕过复制失败。此项修复及本地回归不代表服务器准备检查已经通过。

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
