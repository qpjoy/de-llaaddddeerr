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
Runner Job 不直接挂载它，只能通过受限 API 写入。需要特别注意：hostPath 清单里的
`capacity` 只是 Kubernetes 声明，不是文件系统配额；同一磁盘被填满仍会影响同节点
服务。mx-auto V0 因此额外执行全局持久化上限与最低剩余空间限制，生产应使用有容量
隔离的 CSI volume 或独立分区。

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
| `MXT_ARTIFACT_MAX_FILE_BYTES` | `536870912` | 单文件持久化硬上限 |
| `MXT_ARTIFACT_MAX_RUN_BYTES` | `2147483648` | 单 Run 全部文件硬上限 |
| `MXT_ARTIFACT_MAX_FILES_PER_RUN` | `1000` | 单 Run 文件数硬上限 |
| `MXT_ARTIFACT_MAX_TOTAL_BYTES` | `21474836480` | 全部 Run 持久化字节硬上限 |
| `MXT_ARTIFACT_MAX_TOTAL_ENTRIES` | `100000` | 全部文件与目录条目硬上限（零字节文件也计数） |
| `MXT_ARTIFACT_MIN_FREE_BYTES` | `5368709120` | artifact 文件系统必须保留的空间 |
| `MXT_ARTIFACT_MIN_FREE_INODES` | `10000` | artifact 文件系统必须保留的 inode 数 |
| `MXT_MAX_CONCURRENT_SERVER_RUNS` | `1` | 同时存在的 K8s server Run 上限 |
| `MXT_LAUNCHER_URL` | — | mx-launcher 地址，用于用户登录校验 |
| `MXT_LAUNCHER_AUDIENCE` | `mx-test-framework` | token audience |
| `MXT_LAUNCHER_NEGATIVE_CACHE_TTL_MS` | `3000` | 明确无效 token 的短负缓存；网络/5xx 不缓存 |
| `MXT_LAUNCHER_INTROSPECTION_WINDOW_MS` | `10000` | opaque token 校验启动额度窗口 |
| `MXT_LAUNCHER_INTROSPECTION_MAX_STARTS` | `30` | 每窗口最多启动的 Launcher introspection 数 |
| `MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT` | `8` | 单实例同时进行的 Launcher introspection 上限 |
| `MXT_LAUNCHER_INTROSPECTION_MAX_STARTS_PER_SOURCE` | `6` | 单一 socket 来源每窗口的 introspection 启动上限 |
| `MXT_LAUNCHER_INTROSPECTION_MAX_IN_FLIGHT_PER_SOURCE` | `2` | 单一 socket 来源的 introspection 并发上限 |
| `MXT_LAUNCHER_PASSWORD_LOGIN_WINDOW_MS` | `10000` | 公开密码登录的独立启动额度窗口 |
| `MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS` | `10` | 每窗口最多启动的 Launcher OAuth 密码登录数 |
| `MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT` | `4` | 单实例同时进行的 Launcher OAuth 密码登录上限 |
| `MXT_LAUNCHER_PASSWORD_LOGIN_MAX_STARTS_PER_SOURCE` | `3` | 单一 socket 来源/用户名 digest 每窗口的密码登录上限 |
| `MXT_LAUNCHER_PASSWORD_LOGIN_MAX_IN_FLIGHT_PER_SOURCE` | `1` | 单一 socket 来源/用户名 digest 的密码登录并发上限 |
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

## 迁移是不可变的

已经跑过的迁移文件不能再改，一个字符都不行——包括注释和换行符。改了的后果是所有已部署
的库当场无法迁移。细节、踩过的两次坑、以及不同步之后怎么修，见
[`migrations/README.md`](../migrations/README.md)。

## 保留期是自动执行的

产物目录和进度事件都按 `MXT_ARTIFACT_RETAIN_DAYS`（默认 30 天）过期，由**调度器自己
每 6 小时扫一次**——不是 Kubernetes CronJob：平台已经有一个按时醒来的东西，
再加一个就是再加一个会悄悄停掉的东西。

`manage.sh clean` 仍然在，用来手动提前清理，或者顺带删掉已完成的 runner Job
和悬空镜像。**它不再是保留策略唯一的执行者**——在此之前，那句「默认保留 30 天」
是一句没有任何代码在执行的话。
