# MX Launcher 生产部署与搬迁恢复记录

更新：2026-09-21。适用于本次 `mx-internal-server` 单节点 Linux / kubeadm / containerd
部署；路径和恢复目录来自此次服务器实测，不是其它机器的通用默认值。

**当前已切回最新业务库，原 Ops Token、飞书配置及恢复检查点已恢复，可以恢复正常 deploy
流程。** 服务端检查已通过；员工原密码登录、飞书完整授权和 MX-H2I 原联网功能仍需要实际
验收，不能用 `deploy OK` 或页面 `Connected` 代替。建议先完成这三项验收，再进行下一次部署。

**当前决定保留旧目录和全部恢复备份，不清理。** 防止再次挂错库依靠正确的开机挂载和
deploy 的身份检查，不依靠删除所有旧副本。本文不提供自动删库或历史目录清理入口。

## 1. 当前服务与部署入口

| 项目 | 当前值 / 说明 |
| --- | --- |
| 分支 | `feat/mx_insight_hub`；本机提交后由维护者 push，服务器 pull |
| 服务器工作目录 | `/root/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher` |
| 节点 | `mx-internal-server` |
| 宿主机 LAN / API Server | `192.168.1.2` / `https://192.168.1.2:6443`；`.4` 是此次排查中发现的旧地址 |
| kubeconfig | `/etc/kubernetes/admin.conf`；生产 deploy 固定使用本机配置 |
| K8s 命名空间 | `mx-internal-shadow`；名称含 `shadow`，但本服务器实际生产服务仍使用此命名空间 |
| 业务环境 / 数据库名 | `shadow` / `mx_internal_shadow`；不要仅因名称含 shadow 就另建或切换数据库 |
| Internal API | Deployment / Service `mx-launcher-internal` |
| PostgreSQL | StatefulSet / Service `mx-internal-postgres`，Pod `mx-internal-postgres-0`，PostgreSQL 16 |
| Admin 入口 | `http://10.88.88.88:18090/admin/`；这是原 Internal 访问入口，不是 LAN API Server 地址 |
| Gateway | K8s 中的 Caddy `mx-internal-gateway`；宿主机还有 Nginx，具体域名入口以现有 Nginx 配置为准 |
| Native host runner | `mx-internal-host-runner.service`，端口 `19190`；本次已恢复 active 且健康检查通过 |

MX-H2I 的用户、认证、网络配置以 Internal 为中心；Luopan 用于独立 Launcher 功能验证。
MX Insight Hub 的数据平台部署另有入口。不要为修复 Launcher 顺带重置这些项目或其它 Docker 数据库。

## 2. 数据到底在哪：以这张表区分当前目录和旧副本

本次实测 `/data` 位于 `/dev/nvme0n1p1`，文件系统 XFS。设备名在其它机器或硬件调整后可能改变，
以后以 `findmnt` 的实际来源、UUID、挂载根和恢复检查点为准。

| 用途 | 服务读取的入口 | 当前物理目录 / 状态 |
| --- | --- | --- |
| **正在使用的 Launcher 数据树** | `/var/lib/mx-launcher` | **bind 到 `/data/k8s/mx-runtime/mx-launcher`** |
| **正在使用的 PostgreSQL PGDATA** | `/var/lib/mx-launcher/k8s/postgres/pgdata` | **`/data/k8s/mx-runtime/mx-launcher/k8s/postgres/pgdata`** |
| Internal SSH 文件 | `/var/lib/mx-launcher/k8s/internal-ssh` | `/data/k8s/mx-runtime/mx-launcher/k8s/internal-ssh` |
| 发布文件 | `/var/lib/mx-launcher/k8s/release-artifacts` | `/data/k8s/mx-runtime/mx-launcher/k8s/release-artifacts` |
| 站点配置与文件 | `/var/lib/mx-launcher/k8s/site-slots` | `/data/k8s/mx-runtime/mx-launcher/k8s/site-slots` |
| **当前控制面 etcd** | `/var/lib/etcd` | **`/data/mx-runtime/etcd`，仍在使用** |
| **当前 containerd** | `/var/lib/containerd` | **`/data/mx-runtime/containerd`，仍在使用** |
| **当前 kubelet** | `/var/lib/kubelet` | **`/data/mx-runtime/kubelet`，仍在使用** |
| Docker 镜像、容器、卷 | Docker data-root | `/data/docker`，仍在使用；不是此次 Launcher PGDATA 的存储入口 |
| **旧 Launcher 数据树** | 不应再绑定到 `/var/lib/mx-launcher` | **`/data/mx-runtime/mx-launcher`，保留的旧副本** |
| 最新迁移树中的原 etcd | 不接入当前控制面 | `/data/k8s/mx-runtime/etcd`，保留的原数据；本次从其备份提取认证 Secret |
| 一次性恢复备份 | 不作为业务服务挂载 | `/data/mx-recovery/confirmed-cutover.2VZC9C` |
| 日常重启恢复检查点 | deploy 读取 | `/var/lib/mx-launcher-recovery`；含身份及私有凭据，**不等于数据库备份，也不应假定它已经放在 `/data` 上** |

**两个目录前缀现在有意并存：Launcher 使用 `/data/k8s/mx-runtime/...`，当前集群的 etcd、
containerd、kubelet 仍使用 `/data/mx-runtime/...`。不能删除整个 `/data/mx-runtime`，也不能
把所有挂载批量替换成 `/data/k8s/mx-runtime`。**

当前 `/etc/fstab` 中相关 bind 关系应为下面这些来源和目标；这是核对表，不是让人重复追加条目：

| 来源 | 目标 |
| --- | --- |
| `/data/k8s/mx-runtime/mx-launcher` | `/var/lib/mx-launcher` |
| `/data/mx-runtime/etcd` | `/var/lib/etcd` |
| `/data/mx-runtime/containerd` | `/var/lib/containerd` |
| `/data/mx-runtime/kubelet` | `/var/lib/kubelet` |

PostgreSQL 的 PV 为 `mx-internal-postgres-local-pv`，PVC 为
`postgres-data-mx-internal-postgres-0`，hostPath 是 `/var/lib/mx-launcher/k8s/postgres`，
回收策略为 `Retain`。数据最终落在哪里由这个 hostPath 的实际挂载决定；PVC UID 不是密码或加密 key。
K8s 中的 Secret、PV/PVC 等资源记录保存在当前 etcd，PostgreSQL 业务数据保存在上面的 PGDATA。

## 3. 为什么曾恢复成旧数据库

1. 迁移后的最新数据在 `/data/k8s/mx-runtime/mx-launcher`，但当时 `/etc/fstab` 仍将
   `/data/mx-runtime/mx-launcher` 绑定到 `/var/lib/mx-launcher`。清单的 hostPath 没变，实际读到的树却是旧的。
2. 恢复初期从 7 月的 etcd 副本找回 `mx-launcher-db`，旧凭据可以连接旧数据目录；
   这证明凭据可用，没有证明业务库是最新的。恢复 Secret 本身没有执行数据库回滚。
3. 旧库有 18 个用户，业务记录时间停在 7 月 2 日；用户确认实际一直使用到 9 月，且应有 SMH、SQB。
   后续定位发现两份 PGDATA 设备/inode 不同，但 PG system identifier 相同，属于同一实例的不同副本。
4. 因此不能只看 `PG_VERSION`、system identifier、目录修改时间、用户名密码可连接或 `deploy OK`
   就认定数据正确。必须同时核对实际挂载、API 的数据库目标和已知业务记录。
5. 本次保留两份原目录，完整冷备后仅切换 Launcher 的 bind/fstab；没有覆盖在线 etcd，也没有删除 PV/PVC。

切回最新库时实测：`shadow` 环境 51 个用户、45 条用户凭据，SMH/SQB 及各自凭据存在，
最新用户行时间 `2026-09-18T06:35:13.135953+00:00`。这些是恢复时的核验基线，业务继续使用后会变化，
不能将固定数量当作以后部署必须满足的常量。

## 4. 凭据为什么丢失、现在怎样保留

本次原配置主要在 Kubernetes Secret 中；服务器 `server/.env` 没有对应原值。
部分业务配置确实在数据库，但不能把整个 `.env` 视为“已经存到数据库，启动 PG 就能自动找回”。

| 配置 | 保存位置 / 本次结果 |
| --- | --- |
| 数据库连接 | `mx-launcher-db`；原 PG 用户、密码、库名已核实，当前连接使用数据库 Service，避免固定历史 Pod IP |
| 员工密码 | PostgreSQL 中的用户凭据记录；本次缺用户源于旧库，未通过重置员工密码处理 |
| Internal Ops Token | `mx-internal-ops` 的 `token`；早期恢复曾生成临时值，**现在已恢复原值并通过管理接口验证** |
| 飞书配置 | `mx-feishu-oauth` 的 `app-id`、`app-secret`、`tenant-keys`；**原值已恢复，运行 API 报 enabled** |
| SDK 服务账号 | 最新 etcd 中未找到 `mx-sdk-service-account-secrets`，当前也缺失；恢复过程没有臆造新凭据 |
| OSS 等其它原有 Secret | 由对应 deploy 合约及检查点维护；不要因为 `.env` 中看不到就判断从未配置 |

`/var/lib/mx-launcher-recovery` 为 root 私有目录（0700），文件为 0600：

- `host.json`：节点、CA、文件系统/挂载身份及 PostgreSQL system identifier。
- `latest.json`：同集群、同数据身份下的最近有效 Secret 集合及校验摘要。
- `secrets-*.json`：发生凭据变化时保留的历史版本。

正常 deploy/重启复用当前原值；匹配身份下缺失的 Secret 从检查点补回，已有值不会被恢复步骤盲目覆盖。
显式在 shell 或私有 `.env` 设置不同 Token/飞书配置，仍可能触发配置更新；这不属于重启自动换 key。
`MX_K8S_APISERVER_ADVERTISE_ADDRESS` 改 IP 也不表示授权换库、换 CA 或换业务凭据。

不能删除 `host.json` 来消除挂载不匹配错误；也不要通过删除 Secret 撤销凭据，因为 deploy 可能按恢复约定补回。
确需轮换凭据时按原流程明确更新，并保存新的检查点。私有文件、`.env`、Secret JSON 和明文 Token 不提交 Git、不贴反馈。

## 5. 正常重启后的 deploy

在原 Linux 服务器以 root 执行，先同步已提交代码，再进入 `electron-dock/mx-launcher`。
本命令既会恢复已知基础设施问题，也会构建镜像、执行既有迁移和滚动更新服务；不是单纯的“启动进程”，
应安排维护窗口。新服务器初始化、磁盘迁移和历史数据切换不由此命令自动选择。

```bash
TMPDIR=/data/tmp \
MX_K8S_OS_HOSTNAME=mx-internal-server \
MX_K8S_APISERVER_ADVERTISE_ADDRESS=192.168.1.2 \
MX_SHADOW_BUILDKIT_KEEP_STORAGE=2GB \
MX_SHADOW_BUILDKIT_PRUNE_UNTIL=24h \
bash scripts/manage.sh ops internal-production deploy
```

需要下载代理时，在同一命令开头增加 `MX_LAUNCHER_BUILD_PROXY=http://127.0.0.1:7788`。
这里的 `127.0.0.1` 指执行部署的服务器，代理必须在该服务器可达。代理仅作用于构建/下载，
不写入 Internal 业务容器运行环境，不改变 MX-H2I 的 WireGuard、Hysteria、用户路由或飞书回调链路。
BuildKit 两个参数用于控制构建缓存，不是数据库保留期限。

deploy 会核对当前挂载与检查点、启动未运行的宿主服务、处理已识别的节点/API/CNI/镜像问题，
在应用前检查 PV/PVC 和凭据，给 PostgreSQL 保留已有数据启动保护，最后检查 API、网关和认证配置。
当前已有恢复检查点，无需重跑一次性切库或认证恢复脚本来建立它。

有身份不匹配、备份不完整、认证配置缺失或无法核实的故障时，脚本停止是保护行为。
不要改用 `k8s apply` 或 `ops internal-production apply` 来绕开 `deploy` 的恢复检查。

### 部署前后可用的只读核对

以下命令只查挂载、资源状态及文件元数据，不打印凭据、不修复挂载、不启动服务：

```bash
bash <<'BASH'
set -euo pipefail
export KUBECONFIG=/etc/kubernetes/admin.conf
unset HTTP_PROXY HTTPS_PROXY ALL_PROXY http_proxy https_proxy all_proxy

findmnt -T /data -o TARGET,SOURCE,FSTYPE,UUID,FSROOT
for mx_path in /var/lib/mx-launcher /var/lib/etcd /var/lib/containerd /var/lib/kubelet; do
  findmnt -T "$mx_path" -o TARGET,SOURCE,FSTYPE,FSROOT
done

# 两个当前路径应是同一物理目录；不使用历史固定 inode 数字判定未来重启。
mx_live=/var/lib/mx-launcher/k8s/postgres/pgdata
mx_expected=/data/k8s/mx-runtime/mx-launcher/k8s/postgres/pgdata
stat -Lc '%d:%i %n' "$mx_live" "$mx_expected"
test "$(stat -Lc '%d:%i' "$mx_live")" = "$(stat -Lc '%d:%i' "$mx_expected")" || {
  echo '停止：当前 PostgreSQL 入口没有指向已确认的最新目录。' >&2
  exit 1
}

# 只报告检查点文件存在及权限，不 cat 私有内容。
stat -c '%a %U %n' /var/lib/mx-launcher-recovery \
  /var/lib/mx-launcher-recovery/host.json /var/lib/mx-launcher-recovery/latest.json
kubectl --request-timeout=15s get nodes -o wide
kubectl --request-timeout=15s -n mx-internal-shadow get pods,pvc -o wide
kubectl --request-timeout=15s get pv mx-internal-postgres-local-pv
kubectl --request-timeout=15s -n mx-internal-shadow get secret \
  mx-launcher-db mx-internal-ops mx-feishu-oauth
BASH
```

需要核实用户/数据库目标时，在同一项目目录运行现有只读诊断：

```bash
KUBECONFIG=/etc/kubernetes/admin.conf node scripts/k8s-login-diagnose.mjs SMH
KUBECONFIG=/etc/kubernetes/admin.conf node scripts/k8s-login-diagnose.mjs SQB
```

它核对实际运行 API 的数据源和用户/凭据存在状态，不提交真实密码登录、不输出密码哈希。
如提示脚本 `MODULE_NOT_FOUND`，先确认服务器 pull 到对应提交、当前工作目录正确、文件存在；
这不表示数据库丢失。诊断未能完成时不能把结果当作“用户不存在”。

部署成功日志应包括 `current Ops Secret accepted`、`Feishu configuration enabled` 和
`internal-production deploy OK`。随后实际验收原员工密码、飞书完整授权、原 Admin Token 及原联网功能。
`enabled` 只说明 API 已加载飞书配置，不能证明飞书侧回调白名单、授权及公网入口全部正常。

## 6. 此次问题索引：以后先查什么

| 现象 | 此次证据 / 先查项 | 已有处理与边界 |
| --- | --- | --- |
| Node NotReady / 地址仍是 `.4` | kubelet 旧证书与当前 CA 不匹配，部分配置残留旧 IP | deploy 校验节点/CA/证书时间，按当前 API 地址修复已识别配置；不 reset 集群或更换 CA |
| `mx-launcher-db missing` | PGDATA 还在，当前 etcd 没有原 Secret | 匹配检查点时补缺失 Secret；没有原值时停止，不用随机密码初始化已有库 |
| 员工 `invalid credentials` / 用户少了 | 本次实际连接到旧目录，SMH/SQB 不在旧库 | 先核对数据源及业务记录；不能归因于 PVC key，也不能先重置密码 |
| 飞书 `OAuth is not configured` | 缺少原 `mx-feishu-oauth` | 本次从最新 etcd 副本提取原配置；生产 deploy 默认要求 local-password、feishu 两种登录 |
| Admin Connected 但鉴权失败 | 浏览器原 Token 与早期恢复生成的临时 Token 不同 | 现已找回原 Token；不把“Connected”视为认证通过 |
| PG 一直 Pending / sandbox 创建失败 | Flannel API 链路或 `/run/flannel/subnet.env` | 修复 API 地址，必要时限一次重启 Flannel；不手写租约或随意重建网络 |
| 镜像导入后仍 `ErrImageNeverPull` | 实际 CRI 不一致，或磁盘压力触发 kubelet 镜像 GC | 按 kubelet socket 验证 CRI image ID；缺缓存时补导一次，持续失败查磁盘/运行时 |
| PV immutable / `Directory` 与 `DirectoryOrCreate` | 现有 hostPath 类型与模板不同 | 保留原 PV 源与绑定；Released/Failed 也不自动删除重建 |
| 多文档 JSON 解析失败 | kubectl 对多份清单输出连续 JSON | 已按多文档/List 处理；解析失败不继续部分创建 |
| BuildKit `host-gateway is not supported` | docker-container driver 限制 | 构建代理 builder 使用 host network，不改全局 Docker 代理 |
| kube-proxy read/patch 失败 | API 访问、代理或并发修改需要区分 | 使用超时及直连配置检查真实 API 错误，不当作资源缺失 |
| Caddy upstream patch 失败 | 配置中有两段带 block 的 reverse_proxy | 两段一起更新并保留转发头策略；不为此重写宿主 Nginx 或抢占其端口 |
| 错误密码也能连 PG | 当时测的是本地连接，不能证明 Service 认证链路 | 后续用 Service 连接做负向验证；没有改 `pg_hba.conf` |
| 查询成功但 Pod IP 校验失败 | `inet_server_addr()::text` 带 `/32` 或 `/128` | 已改用 `host(inet_server_addr())` 比较裸 IP；不是重新切库的理由 |

此前提到的 GPU 驱动问题没有被此次日志证实为根因；若宿主驱动、磁盘或硬件异常，需要单独处理，
deploy 不承诺自动修复所有系统故障。详细实现和阶段日志见 [重启恢复手册](docs/31-internal-reboot-recovery.md)。

## 7. 保留的恢复资料与禁止误操作

本次已完成，不作为日常重启时再次执行的步骤：

| 记录 | 用途 |
| --- | --- |
| `/data/mx-recovery/confirmed-cutover.2VZC9C/latest-mx-launcher` | 最新树启用前的完整冷备 |
| `/data/mx-recovery/confirmed-cutover.2VZC9C/previous-mx-launcher` | 旧库停机后的完整冷备，保留事故期间可能产生的记录 |
| `/data/mx-recovery/confirmed-cutover.2VZC9C/latest-etcd` | 最新原 etcd 的完整副本，包括 WAL；用于隔离提取原 Secret |
| 同目录中的 `*.before.sha256`、`*.copy.sha256`、`*.after.sha256` | 原件前后与副本的逐文件校验记录 |
| `/data/mx-recovery/confirmed-cutover.2VZC9C/auth-inspect.jHEIk8` | 原认证凭据的私有提取记录 |
| `/data/mx-recovery/confirmed-cutover.2VZC9C/auth-restore.aY00gO` | 原认证 Secret 恢复前备份、验证及结果 |
| `/etc/kubernetes/mx-kubelet-auth-repair.CeHaeh` | 早期 kubelet 认证修复备份 |
| `/data/mx-recovery/secret-oM2oRM` | 早期从 7 月旧 etcd 提取 DB Secret 的资料；**不是最新业务数据或完整最新认证的依据** |

- 不重新执行 `restore-confirmed-mx-data.sh`、其 `--finish` 或认证恢复脚本来替代正常 deploy。
  这些是本次有阶段前提的一次性恢复工具，完整历史流程留在重启恢复手册中。
- 不删除旧树、完整冷备、检查点或其它 `/data/mx-runtime` 子目录；不把原 etcd 整树覆盖到在线 `/var/lib/etcd`。
- 不执行 `kubeadm reset`、删 PV/PVC、`docker volume prune` 或带卷清理的命令来修复 Launcher 登录。
- 不直接复制活动 PGDATA 当作一致性备份；需要数据库支持的备份方式或核实停机后的完整冷备。
- 本次冷备与原件在同一磁盘，能帮助回退误操作，不能防磁盘损坏。后续备份应同时覆盖最新业务数据、
  必要的站点/SSH/发布文件、私有凭据检查点、Kubernetes 配置及 etcd，并保留受控的异机副本。
- 再次迁移时带走 `/etc/fstab` 的已核实关系和 `/var/lib/mx-launcher-recovery`；不能只复制 `/data`
  然后沿用另一套旧挂载。迁移后的新 UUID、挂载根或 CA 变化需要单独核实，不能删除检查点强行 deploy。

本文记录的是恢复完成时的状态；以后主动迁移或调整存储后，应同步更新本文件和已核实的恢复记录。
