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

- ConfigMap 放 `MX_ENVIRONMENT`、`MX_SITE_ROLE`、`INTERNAL_STORE_DRIVER` 这类非敏感值。
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

`down` 会删除 Internal API、migration Job、Postgres workload、ConfigMap 和 Secret，但
默认保留 namespace 和 PVC。删除数据盘应该做成单独的 `purge` 动作，并要求二次确认。

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
