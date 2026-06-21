# MX Launcher K8s Deployment Runbook

本文档说明 `scripts/manage.sh k8s` 的部署顺序，以及如何用 Docker Compose 的经验理解
K8s。第一版目标是 Internal shadow：`mx-launcher/server` + PostgreSQL + TypeORM
migration + smoke。

## 一句话

Docker Compose 适合把本地服务跑起来；K8s 适合把服务声明成“期望状态”，由集群持续
对齐。`manage.sh` 做的事情，是把这些期望状态按安全顺序提交给 K8s。

## Compose 到 K8s 的映射

| Docker Compose | K8s | 在 MX Launcher 中 |
| --- | --- | --- |
| `services.internal` | Deployment | `mx-launcher-internal`，无状态 NestJS API |
| `services.postgres` | StatefulSet | `mx-internal-postgres`，有状态数据库 |
| `ports` | Service + port-forward / Ingress | `mx-launcher-internal` ClusterIP，smoke 用 port-forward |
| 宿主机入口 | DaemonSet + hostNetwork | `mx-internal-gateway`，正式 Internal 主机长驻入口 |
| `environment` | ConfigMap + Secret | 非敏感配置进 ConfigMap，密码和 `DATABASE_URL` 进 Secret |
| `volumes` | PersistentVolumeClaim | Postgres 数据盘，`down` 默认不删除 |
| `healthcheck` | livenessProbe / readinessProbe | `/healthz` 判断进程，`/readyz` 判断可接流量 |
| 一次性命令 | Job | `mx-launcher-migrate` 跑 TypeORM migrations |

## 为什么这样设计

### Namespace

Namespace 类似一个逻辑隔离空间。`internal-shadow` 使用 `mx-internal-shadow`，后续
`beta`、`stable`、客户 demo 可以分 namespace，避免配置、Secret、Service 名称互相
污染。

### ConfigMap 和 Secret

Compose 里环境变量都写在一个 service 下。K8s 中要拆开：

- ConfigMap 放 `MX_ENVIRONMENT`、`MX_SITE_ROLE`、`INTERNAL_STORE_DRIVER`、
  `SITE_SLOT_RUNNER_REMOTE_EXECUTION_ENABLED` 这类非敏感值。远程执行开关默认关闭。
- Secret 放 `PG_PASSWORD`、`DATABASE_URL` 这类敏感值。

`manage.sh k8s apply internal-shadow` 会从本地环境变量生成 Secret，不把密码写进 git：

```bash
PG_USER=mx_internal PG_PASSWORD=... PG_DB=mx_internal_shadow \
  bash scripts/manage.sh k8s apply internal-shadow
```

### StatefulSet 和 PVC

Postgres 不能像普通 API 那样随便换身份、换盘，所以使用 StatefulSet。PVC 类似 Compose
的 named volume，但由 K8s 的存储系统提供。`k8s down` 默认保留 PVC，是为了模拟
“服务重启但数据仍在”的真实部署场景。

裸 kubeadm 单节点通常没有默认 StorageClass。`18-local-pv.yaml` 会为 Internal CentOS
测试/正式主机创建两个 hostPath PV：

- `mx-internal-postgres-local-pv` -> `/var/lib/mx-launcher/k8s/postgres`
- `mx-launcher-internal-ssh-local-pv` -> `/var/lib/mx-launcher/k8s/internal-ssh`

它们使用 `Retain` 回收策略，`down` 不删除 PV/PVC，也不删除宿主机目录。

### Migration Job

虽然 API 启动时也会兜底执行 TypeORM migration，但 K8s 部署流程里更推荐先跑 Job：

1. 等 Postgres ready。
2. 跑 `mx-launcher-migrate` Job。
3. Job completed 后再滚动更新 API Deployment。

这样 Admin 后台可以清楚展示“数据库迁移是否成功”，而不是把迁移隐含在 API Pod 启动
日志里。

### Deployment 和 Probes

Internal API 是无状态 HTTP 服务，用 Deployment。K8s 通过 probes 判断 Pod 状态：

- `startupProbe`: 给应用启动和迁移兜底时间。
- `livenessProbe`: 失败多次后重启容器。
- `readinessProbe`: 只有通过后才让 Service 把流量打进来。

### Service 和 Smoke

Service 是集群内稳定访问名。当前没有接 Ingress，smoke 使用临时 port-forward：

```bash
bash scripts/manage.sh k8s smoke internal-shadow
```

它会把本地 `127.0.0.1:18090` 临时转发到集群内 `mx-launcher-internal:18090`，然后跑
同一套 HTTP smoke。

正式 Internal 主机不需要长期手动 port-forward。`45-internal-gateway.yaml` 会部署
`mx-internal-gateway` DaemonSet，使用 `hostNetwork` 绑定宿主机 `0.0.0.0:18090`，
反代到 `mx-launcher-internal.mx-internal-shadow.svc.cluster.local:18090`。在单台
CentOS/Ubuntu Internal K8s 上，DaemonSet 实际只运行一个 Pod；如果以后变成多节点，
应给真正拥有 `mx-internal-svc` / `10.88.88.88` 的节点打 label，再把 gateway 约束到
那台节点。

## 部署顺序

### CentOS 单节点 K8s Bootstrap

如果 Internal 服务器现在只安装了 Docker，建议先用 kubeadm 初始化一套单节点 K8s。
当前 Kubernetes 官方 RPM 文档使用 `v1.36` 仓库；如果现场要锁定别的 minor，把仓库 URL
里的 `v1.36` 一并替换。

优先使用 CentOS Stream 9 / Rocky 9 / Alma 9 这类仍在维护的系统。如果是 CentOS 7，
建议先升级系统或改用企业发行版 K8s；CentOS 7 已经过维护期，kubeadm、containerd、
CNI 和内核网络组合更容易出现场地问题。

推荐直接使用一键脚本。脚本会关闭 swap、配置 containerd、安装 kubeadm / kubelet /
kubectl、初始化单节点集群、安装 Flannel、放开单节点 control-plane 调度，并按需打开
firewalld 的 `18090/tcp`、`6443/tcp`、`8472/udp`。

```bash
cd ~/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher

bash scripts/install-k8s-centos.sh --advertise-address <这台 Internal CentOS 的内网 IP>
```

CentOS/RHEL 8 系列常见组合是 4.18 内核 + cgroups v1。Kubernetes v1.35+ 会把
cgroups v1 作为 deprecated 路径，v1.36 可能在 kubeadm preflight 阶段报
`FailCgroupV1` / `SystemVerification`。脚本会自动识别并启用测试机兼容路径；也可以
显式传入：

```bash
bash scripts/install-k8s-centos.sh \
  --advertise-address <这台 Internal CentOS 的内网 IP> \
  --allow-cgroup-v1
```

如果卡在 `registry.k8s.io/kube-apiserver` / `europe-west3-docker.pkg.dev` 镜像下载，
说明当前网络访问 Kubernetes 官方镜像仓库超时。改用可访问的镜像仓库：

```bash
bash scripts/install-k8s-centos.sh \
  --advertise-address <这台 Internal CentOS 的内网 IP> \
  --allow-cgroup-v1 \
  --image-repository registry.aliyuncs.com/google_containers
```

脚本会先执行 `kubeadm config images pull` 预拉控制面镜像，并把同一个
`imageRepository` 写入 kubeadm init 配置。若现场使用 Harbor / 内网 registry，把
`registry.aliyuncs.com/google_containers` 换成对应地址即可。

如果 Flannel 卡在 `Init:0/2`，并且 DaemonSet 镜像是
`ghcr.io/flannel-io/flannel*`，通常是 GHCR 镜像源访问问题。可以让脚本把 Flannel
镜像改成 Docker Hub 的 `flannel/*`，或改成现场 Harbor 镜像仓库：

```bash
bash scripts/install-k8s-centos.sh \
  --advertise-address <这台 Internal CentOS 的内网 IP> \
  --allow-cgroup-v1 \
  --image-repository registry.aliyuncs.com/google_containers \
  --flannel-image-repository docker.io/flannel
```

长期生产建议升级到 CentOS Stream 9 / Rocky 9 / Alma 9 或启用 cgroups v2；cgroups v1
只是为了当前 Internal 测试机先跑通。

如果希望 K8s 安装完成后顺手部署 MX-H2I Internal 服务：

```bash
cd ~/mx/workspace/de-llaaddddeerr/electron-dock/mx-launcher

PG_PASSWORD='<换成 Internal 测试库密码>' \
  bash scripts/install-k8s-centos.sh \
    --advertise-address <这台 Internal CentOS 的内网 IP> \
    --deploy-mx
```

可以先预览脚本动作：

```bash
bash scripts/install-k8s-centos.sh --advertise-address <IP> --dry-run
```

脚本默认参数可以通过环境变量覆盖：

```bash
K8S_VERSION=v1.36 \
K8S_ALLOW_CGROUP_V1=auto \
K8S_IMAGE_REPOSITORY=registry.aliyuncs.com/google_containers \
K8S_FLANNEL_IMAGE_REPOSITORY=docker.io/flannel \
POD_CIDR=10.244.0.0/16 \
SERVICE_CIDR=10.96.0.0/12 \
bash scripts/install-k8s-centos.sh --advertise-address <IP>
```

下面是脚本展开后的手动步骤，保留给现场排障或审计。以下命令在 Internal CentOS
服务器上以 root 执行：

```bash
cat /etc/os-release
ip -4 addr
```

准备 containerd、内核网络和 swap：

```bash
swapoff -a
sed -i.bak '/[[:space:]]swap[[:space:]]/ s/^/#/' /etc/fstab

cat >/etc/modules-load.d/k8s.conf <<'EOF'
overlay
br_netfilter
EOF
modprobe overlay
modprobe br_netfilter

cat >/etc/sysctl.d/99-kubernetes-cri.conf <<'EOF'
net.bridge.bridge-nf-call-iptables = 1
net.bridge.bridge-nf-call-ip6tables = 1
net.ipv4.ip_forward = 1
EOF
sysctl --system

mkdir -p /etc/containerd
containerd config default >/etc/containerd/config.toml
sed -i 's/SystemdCgroup = false/SystemdCgroup = true/' /etc/containerd/config.toml
systemctl enable --now containerd
systemctl restart containerd
```

安装 kubeadm / kubelet / kubectl：

```bash
setenforce 0 || true
sed -i 's/^SELINUX=enforcing$/SELINUX=permissive/' /etc/selinux/config

cat >/etc/yum.repos.d/kubernetes.repo <<'EOF'
[kubernetes]
name=Kubernetes
baseurl=https://pkgs.k8s.io/core:/stable:/v1.36/rpm/
enabled=1
gpgcheck=1
gpgkey=https://pkgs.k8s.io/core:/stable:/v1.36/rpm/repodata/repomd.xml.key
exclude=kubelet kubeadm kubectl cri-tools kubernetes-cni
EOF

yum install -y kubelet kubeadm kubectl --disableexcludes=kubernetes
systemctl enable --now kubelet
```

初始化单节点集群。`10.244.0.0/16` 给 Flannel Pod 网段，`10.96.0.0/12` 给 K8s
Service 网段；它们不占用 HDO V1 的 `100.*`，也不占用 MX-H2I service peer 的
`10.88.*` / `10.89.*`。

```bash
CENTOS_LAN_IP=<这台 Internal CentOS 的内网 IP>
kubeadm init \
  --apiserver-advertise-address="$CENTOS_LAN_IP" \
  --pod-network-cidr=10.244.0.0/16 \
  --service-cidr=10.96.0.0/12 \
  --cri-socket=unix:///run/containerd/containerd.sock

mkdir -p "$HOME/.kube"
cp -i /etc/kubernetes/admin.conf "$HOME/.kube/config"
chown "$(id -u):$(id -g)" "$HOME/.kube/config"

kubectl apply -f https://github.com/flannel-io/flannel/releases/latest/download/kube-flannel.yml
kubectl taint nodes --all node-role.kubernetes.io/control-plane-
kubectl get nodes -o wide
kubectl -n kube-system get pods -o wide
```

如果开启了 `firewalld` 或云安全组，至少要让可信 Internal 管理机能访问 TCP `18090`。
K8s API `6443` 只开放给管理员机器；PostgreSQL、Docker daemon 和 containerd socket 不
对外开放。

```bash
firewall-cmd --permanent --add-port=18090/tcp
firewall-cmd --permanent --add-port=6443/tcp
firewall-cmd --reload
```

### 安装当前 MX-H2I 服务

把当前仓库放到 Internal CentOS 后，在 `electron-dock/mx-launcher` 目录执行：

```bash
corepack enable
pnpm install

PG_PASSWORD='<换成 Internal 测试库密码>' \
  bash scripts/manage.sh ops internal-production deploy

bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production gateway-smoke
curl -fsS http://127.0.0.1:18090/healthz
```

`internal-production deploy` 会构建 `qpjoy/mx-launcher-server:shadow`。在 CentOS
kubeadm/containerd 环境里，脚本会自动把 Docker 本地镜像导入 containerd 的 `k8s.io`
namespace，让 migration Job 和 Internal API Pod 能直接使用这份镜像。如果现场改成推送
到 Harbor / 私有 registry，也可以设置 `MX_SHADOW_CONTAINERD_IMPORT=0` 跳过本地导入，
并把 manifest 中的 image 改成 registry 地址。

```bash
bash scripts/manage.sh k8s plan internal-shadow
bash scripts/manage.sh k8s explain internal-shadow
bash scripts/manage.sh k8s render internal-shadow
bash scripts/manage.sh k8s apply internal-shadow
bash scripts/manage.sh k8s status internal-shadow
bash scripts/manage.sh k8s smoke internal-shadow
bash scripts/manage.sh k8s gateway-smoke internal-shadow
bash scripts/manage.sh k8s db-summary internal-shadow
bash scripts/manage.sh k8s logs internal-shadow
```

面向 Internal CentOS/Ubuntu 的一键正式部署：

```bash
bash scripts/manage.sh ops internal-production deploy
bash scripts/manage.sh ops internal-production status
bash scripts/manage.sh ops internal-production gateway-smoke
```

`internal-production deploy` 会构建 `qpjoy/mx-launcher-server:shadow`、部署
PostgreSQL / migration Job / Internal API / `mx-internal-gateway`，然后直接通过
`http://127.0.0.1:18090` 跑 gateway smoke。若该机器有防火墙或云安全组，只允许可信
Internal 管理网、Domestic relay 或 `mx-internal-svc` overlay 访问 TCP `18090`。
构建镜像前，脚本会检查 `site-slots/domestic/qp-tunnel-cli` fallback 是否包含
`dist/index.js`、`dist/hdo.js` 和声明文件。CentOS/Internal runtime 主机默认不安装或编译
`electron-plugin` workspace，避免触发 `better-sqlite3`、Electron native module、
node-gyp 等桌面/原生依赖；如果 fallback dist 缺失，materializer 会生成一个
server-safe degraded fallback，足够完成 Internal API 镜像构建和 K8s 部署。需要给
Domestic 做完整离线 `qp-tunnel-cli` 推送前，应在开发/发布机刷新完整 fallback，或显式在
构建机设置 `MX_SHADOW_BUILD_ELECTRON_PLUGIN_FALLBACK=1`。

### 与 HDO V1 共存

`internal-shadow` 可以先部署到 Internal CentOS 的 K8s 上，默认不会替换或停止已经在线上
运行的 HDO V1。当前边界如下：

| 维度 | MX-H2I / Launcher 2.0 | HDO V1 | 共存判断 |
| --- | --- | --- | --- |
| K8s namespace | `mx-internal-shadow`，另建 `mx-dns` | 不使用这套 K8s manifest | 不重名 |
| API 端口 | Pod / Service 内部 `18090`；正式 gateway 绑定宿主机 `18090` | `electron-server` 默认 `8080` | 不抢 V1 `8080`，但正式 gateway 会占用宿主机 `18090` |
| Postgres | Service `mx-internal-postgres:5432`，PVC 独立 | Compose `qpjoy-postgres`，宿主机默认 `5433:5432` | 不共库、不共 volume |
| 服务名 | `mx-launcher-internal`、`mx-internal-postgres`、`mx-internal-coredns` | `qpjoy-market`、`qpjoy-postgres`、`hdo-home` | 不重名 |
| 网段 | `10.88.0.0/16`、`10.89.0.0/16`、`10.90.0.0/16+` | legacy `100.88/100.89` | 不重叠 |
| WireGuard interface | 2.0 使用 `mx-domestic`、`mx-internal-svc` | V1 使用 `hdo-home`、`hdo-internal` | 不重名；V1 清理是显式命令 |

默认 `k8s apply internal-shadow` 只创建/更新 K8s 对象、Secret、migration Job、
ClusterIP Service 和 Internal gateway；它不会执行 `wg-quick`、不会改宿主机 route/iptables、不会停止
`hdo-home`。会触碰宿主机网络的动作是后续单独阶段：

- Domestic 2.0 relay 激活：创建/重启 `wg-quick@mx-domestic`，写入 `10.88.*` 路由和
  `mx-domestic` 转发规则。
- Internal service peer handoff：在真正的 Internal runtime host 上启动
  `mx-internal-svc`，把 Internal 固定到 `10.88.88.88`。
- `ops site-slot cleanup-v1-wireguard --apply`：显式停止并归档 `hdo-home` /
  `hdo-internal`，只有确认 V1 不再需要时才执行。

在同一台机器同时保留 HDO V1 和 MX-H2I 2.0 时，推荐先只执行：

```bash
bash scripts/manage.sh k8s apply internal-shadow
bash scripts/manage.sh k8s status internal-shadow
bash scripts/manage.sh k8s smoke internal-shadow
```

如果需要让局域网内的 Mac 临时访问 Internal API，可以用 `18190` 等非冲突端口
port-forward；正式路径用 `mx-internal-gateway` 提供宿主机 `18090`，再通过
`mx-domestic` + `mx-internal-svc` 让客户端访问 `10.88.88.88:18090`。不要把
Postgres 或 Docker daemon 暴露到公网。

面向本机运维的封装命令：

```bash
bash scripts/manage.sh ops k8s-shadow cycle
bash scripts/manage.sh ops k8s-shadow db-summary
```

停止工作负载：

```bash
bash scripts/manage.sh k8s down internal-shadow
```

`down` 会删除 Internal API、migration Job、Postgres workload、CoreDNS writer RBAC、
shadow DNS target、ConfigMap、ServiceAccount 和 Secret，但默认保留 Internal namespace
和 PostgreSQL PVC。删除数据盘应该做成单独的 `purge` 动作，并要求二次确认。

### CoreDNS apply 权限

`internal-shadow` 会额外创建 `mx-dns` namespace 和一个 baseline `coredns` ConfigMap。
Internal API 使用 `mx-launcher-internal` ServiceAccount，通过 `mx-dns` namespace 内的
RoleBinding 更新这个固定 ConfigMap。RBAC 只允许 get/update/patch `coredns`，不授予
创建任意 ConfigMap 的权限。

HTTP smoke 在 K8s 模式下会设置 `MX_SMOKE_EXPECT_K8S_APPLY=1`，并调用
`POST /internal/v1/dns/coredns/configmap/apply` 验证真实写入。Compose 本地模式不打开
`COREDNS_K8S_APPLY_ENABLED`，因此只验证 apply gate 会被阻断。

## Admin 化方向

`manage.sh` 中每个 K8s action 都可以变成 Admin 的一个后端动作：

| CLI action | Admin 后台能力 |
| --- | --- |
| `plan` | 展示部署计划和影响范围 |
| `render` | 展示待提交 manifest / diff |
| `apply` | 创建 deploy run，按步骤执行 |
| `status` | 展示 pods/services/jobs/pvc 当前状态 |
| `logs` | 聚合最近日志 |
| `smoke` | 触发 Test Center smoke run |
| `down` | 停止 shadow/demo 环境 |

后续应该把每一步写入 `audit.events` 和 `test.runs`，并把 Job/rollout/smoke 输出作为
evidence。

## 从 K8s shadow 到平台运维底座

当前 K8s runbook 只要求 Internal shadow 能稳定部署、迁移、smoke 和观察。下一阶段不
做 AI 训练平台，而是借鉴 K8s 和成熟运维系统能力，把 MX Launcher 的 Internal 控制面
强化成平台运维底座。

### etcd 边界

etcd 是 Kubernetes 控制面的状态存储，不直接作为 MX Config Center 的业务数据库。
MX 的用户、RBAC、配置、release、site-slot、runner、evidence 和 audit truth 仍保存在
Internal PostgreSQL。

可以使用 K8s API 间接消费 etcd 能力：

- ConfigMap / Secret：运行时配置和 Secret 投影。
- Lease：leader election、短租约、协调锁。
- CRD：把 `SiteSlotPlan`、`ReleasePlan`、`RunnerJob`、`EvidenceBundle` 投影成
  K8s 原生对象。
- watch：监听 K8s 状态变化并写回 Internal audit/evidence。

### 第一批平台组件

| 组件 | 在 MX Launcher 中的角色 |
| --- | --- |
| AWX | Ansible 执行平面，承接 Domestic/Oversea inventory、credential、job template 和 task event |
| Argo CD / Flux | GitOps 发布 Internal K8s、CoreDNS、AWX、Observability、Admin 后端 |
| Prometheus / Alertmanager / Grafana | 指标、告警、Release Gate 和 Admin topology health |
| OpenTelemetry / Loki / Tempo | trace、log、runner/worker evidence 关联 |
| cert-manager | Internal API、Admin、Ingress、mTLS、site-agent 证书生命周期 |
| External Secrets / Vault / SOPS | SSH key、数据库密码、API key、Hysteria2 secret |
| Cilium / Calico | NetworkPolicy、pod 隔离、网络观测和排障入口 |
| Harbor / MinIO | 镜像、artifact、snapshot、evidence、截图和 release bundle |
| Velero / Postgres Operator | K8s 资源和 Internal 数据备份恢复 |

这些组件进入平台后仍由 Internal/Admin 统一建模：组件自身可以执行、观测或存储制品，
但不替代 Internal 的审批、配置、证据和发布状态机。

### AWX 接入位置

AWX 应作为 Worker Contract V1 的一个 provider：

```text
Admin action -> Internal worker job -> awx-provider -> AWX job template
  -> Ansible playbook / role -> slot host -> AWX event -> worker report
```

现有 `remote-ssh` runner 可以保留为 fallback。AWX job event 要映射为 worker report
steps，使 Evidence Drawer 能展示 task、host、changed、failed、stdout/stderr、
duration、job template 和 rollback hint。

当前 shadow 实现先提供 `awx-shadow` runner/provider mode：Admin 或 CLI 可以创建
AWX shadow runner，再记录包含 inventory、credential、job template、extra vars 和
task event 的 worker report。这个阶段不调用 AWX API，也不登录或修改
Domestic / Oversea。真实 provider 已通过 `site-slot.worker-run.awx-launch`
接入同一份 Worker Contract：Internal 调用 AWX job template launch，按需等待 job
完成，拉取 job events，再把 AWX summary/events 写回 worker report 和 Evidence Drawer。
AWX provider endpoint、organization、project、inventory/credential/job-template
命名前缀和启停状态由 Config Center `awx-provider` registry 保存；K8s 内的 AWX
只作为执行面，不成为 MX 配置真相源。
真实 launch 前先走 Config Center provider check：只读调用 AWX `/api/v2/ping/`、
organization、project、inventory 和 job template list endpoint，把 HTTP status、
count、matched name 和失败原因回写为 Admin 可见的 readiness evidence。检查请求可
携带一次性 bearer token，但 token 不写入 Config Center。
真实 launch 还必须满足四个 gate：Internal 环境变量 `AWX_API_LAUNCH_ENABLED=true`、
Admin action body `confirmAwxLaunch=true`、active AWX provider、以及一次性 action
token 或 Internal secret `AWX_API_TOKEN`。这些 gate 失败时 action 返回 blocked
evidence，不创建 worker report；AWX API 调用后失败则创建 failed worker report，
保证 Release Gate / Rollback 能看到失败原因。

### Oversea shadow setup 入口

当前 Admin 的推荐路径是先使用
`POST /internal/v1/admin/oversea/:siteId/shadow-setup` 把一个 Oversea slot 的必要
shadow 对象一次性做完：

1. Upsert SSH Profile。
2. Issue Internal mihomo / access accounts。
3. Create site-slot plan。
4. Create preflight execution。
5. Create confirmed apply execution。
6. Create `awx-shadow` runner session。
7. Create AWX worker job。
8. Record AWX shadow worker report。

这个接口仍然是 shadow 边界：不登录 Oversea、不调用 AWX launch、不修改远端，只把
Internal 编排对象、AWX readonly check 和 worker report evidence 补齐。真实执行时，
在 ready AWX worker job 上执行 Admin action `site-slot.worker-run.awx-launch`；
`remote-ssh` 继续保留为 fallback 和排障通道。

完整路线见
`docs/13-platform-ops-and-admin-design-system-roadmap.md`。
