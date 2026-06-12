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

## 部署顺序

当前 manifest 使用镜像 `qpjoy/mx-launcher-server:shadow`。如果使用 Docker Desktop 本地
K8s，通常可以直接复用本机镜像；如果是远程 Internal 集群，需要先把镜像推到集群可访问
的 registry，并在 manifest 或后续部署模板中替换 image。

```bash
bash scripts/manage.sh k8s plan internal-shadow
bash scripts/manage.sh k8s explain internal-shadow
bash scripts/manage.sh k8s render internal-shadow
bash scripts/manage.sh k8s apply internal-shadow
bash scripts/manage.sh k8s status internal-shadow
bash scripts/manage.sh k8s smoke internal-shadow
bash scripts/manage.sh k8s db-summary internal-shadow
bash scripts/manage.sh k8s logs internal-shadow
```

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
