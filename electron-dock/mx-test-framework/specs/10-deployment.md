# 10 · 部署与运维

目标：**`bash scripts/manage.sh deploy` 一条命令搞定**——部署 k8s 服务、跑数据库迁移、
清理旧文件。不过度部署。

沿用 `mx-insight-hub/scripts/manage.sh` 的形态，不发明新的运维方式。

## 命令面

```
MX Test Framework lifecycle

本地 Docker:
  bash scripts/manage.sh local up|status|logs|down

Internal Kubernetes:
  bash scripts/manage.sh deploy      # 全量幂等部署：镜像 → 迁移 Job → 服务
  bash scripts/manage.sh migrate     # 只跑数据库迁移
  bash scripts/manage.sh verify      # 冒烟：健康检查 + 建一个 run 并查回来
  bash scripts/manage.sh status
  bash scripts/manage.sh logs [server|runner]
  bash scripts/manage.sh clean       # 清理过期产物目录与已完成的 runner Job
  bash scripts/manage.sh down        # 服务缩到 0，保留 PVC 与 Secret
```

`deploy` 是幂等的：重复执行等于 reconcile。它内部依次做：

1. 构建/加载镜像
2. `kubectl apply -k deploy/k8s/internal`
3. 等迁移 Job 完成（迁移由 `@qpjoy/mx-common` 的 advisory lock 保证并发安全）
4. 等 Deployment ready
5. 跑一次健康检查

`down` **不删 PVC、不删 Secret、不删数据库**。删数据是单独的显式命令,不藏在 down 里。

## k8s 清单

```
deploy/k8s/internal/
  00-namespace.yaml
  05-serviceaccount.yaml
  10-artifacts-pvc.yaml      独立产物存储
  20-migration-job.yaml      node server/migrate.mjs
  30-server.yaml             控制面 Deployment + Service
  40-runner-rbac.yaml        允许 server 创建 runner Job
  50-network-policy.yaml
  kustomization.yaml
```

比 insight-hub 少一层：没有 projector / ingest / 双 API 拆分。**一个 server 进程**
就是全部控制面,调度器跑在同进程里。规模到不了需要拆的程度。

### Service 暴露

普通 `ClusterIP` + Ingress，不需要 service VIP,不登记 AppCenter。
它是通用测试框架,不是分发给终端用户的产品。

访问路径就是 Internal 内网的一个域名,和其他内部管理页面一样。

## 存储

两块，互不影响：

| 存储 | 用途 | 说明 |
| --- | --- | --- |
| PostgreSQL `mx_test` 库 | 任务、执行、用例结果 | 复用 mx-common 共享实例的**独立库**（[ADR-0004](adr/0004-independent-database.md)） |
| PVC `mx-test-framework-artifacts` | 报告、录像、截图 | **独立 PVC**，不与程序数据或任何线上数据共用 |

产物 PVC 用独立的 StorageClass 或 hostPath 路径（如 `/var/lib/mx-test-framework/artifacts`），
它被填满时不会影响数据库或其他服务。

## 清理

`manage.sh clean` 做三件事，也可以由平台内的定时任务每天自动做：

1. 删除 `retain_until` 已过的产物目录（默认 30 天前）
2. 删除已完成的 runner Job（k8s 的 `ttlSecondsAfterFinished` 也会兜底）
3. 删除孤儿目录——PVC 上有目录但库里没有对应 run 的（部署失败或手工操作留下的）

删产物**不删 run 记录**。历史列表、趋势、用例通过率都还在，只是点开产物时显示
"已过期"。这样清理是安全的,不会让历史断档。

保留天数由环境变量控制：

```
MXT_ARTIFACT_RETAIN_DAYS=30
```

## 配置

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `MXT_PORT` | `8790` | 服务端口 |
| `MXT_DATABASE_URL` | — | `mx_test` 库连接串 |
| `MXT_ARTIFACTS_DIR` | `/data/artifacts` | PVC 挂载点 |
| `MXT_ARTIFACT_RETAIN_DAYS` | `30` | 产物保留天数 |
| `MXT_LAUNCHER_URL` | — | mx-launcher 地址，用于用户登录校验 |
| `MXT_LAUNCHER_AUDIENCE` | `mx-test-framework` | token audience |
| `MXT_ADMIN_TOKEN` | — | 服务级管理 token，用于运维脚本 |
| `MXT_RUNNER_IMAGE_CYPRESS` | `cypress/included:15.0.0` | 服务端 runner 镜像 |
| `MXT_RUNNER_IMAGE_PLAYWRIGHT` | `mcr.microsoft.com/playwright:v1.56.0-noble` | 同上 |

生产配置放 `.env.internal`（模式 0600），`deploy` 时自动加载,与 insight-hub 一致。

## 降级行为

| 情况 | 行为 |
| --- | --- |
| mx-launcher 不可达 | 人**登录不了**；已登录会话在缓存 TTL 内仍可用；已排队的任务继续跑 |
| PVC 满 | 新 run 置 `blocked` 并明确报"产物存储已满"，不静默丢产物 |
| 没有可用 runner | run 停在 `pending-runner`，不算失败（[11](11-runner-environments.md)） |
| MXT 整体不可用 | 被测应用仓库里的 `pnpm e2e:local` 照常能跑。**平台是增益，不是前置依赖** |
