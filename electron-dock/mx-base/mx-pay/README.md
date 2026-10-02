# mx-pay：统一支付能力与独立交易服务

2026-10-02：已实现独立 PostgreSQL 交易服务、应用凭据、付款事件、服务端 SDK 和一键部署脚本。默认真实收款关闭。仓库实现与本机测试不代表已经部署到 Internal。

**现有 Hub 人工充值继续使用原内嵌路径。** `@qpjoy/mx-pay` 原规则导出保持兼容；本次未切换 Hub 支付后端，也不导入存量订单、重放历史付款或更改钱包。独立服务可单独部署并验证，正式切换须按[单写入方迁移规划](../../mx-insight-hub/docs/architecture/payment-center-service-boundaries-and-reliability.md)完成交接。同一正式收款账户不能未经交接同时在旧 Hub 和新服务中核实收款。

## 一个命令部署或更新

在目标部署主机完成一次性配置后，在本目录运行：

```sh
bash scripts/manage.sh deploy
```

也可以在 `electron-dock/mx-base` 使用统一入口：

```sh
bash scripts/manage.sh deploy mx-pay
```

Kubernetes 为默认方式：配置验证 → 检查至少两个就绪工作节点 → 取得部署锁 → 构建并推送镜像、固定 digest → 创建本版本不可变配置 → 执行数据库迁移 Job → 迁移完成后更新 API → 等待 rollout 与 readiness。重复执行检查原迁移校验和，不重复执行已完成 SQL。部署失败返回非零退出码，阶段结果在 `.deploy/last-result.json`，方便后续 Internal Admin 执行器接入。

API 为两个或以上副本，RollingUpdate 的 `maxUnavailable=0`、`maxSurge=1`，按主机分布，配置资源限额、探针、退出排空与 PDB。无 hostNetwork、hostPort、Ingress、NodePort 或自动公网域名。镜像需可被每台 worker 拉取；数据库使用独立 PostgreSQL，不调用 mx-common 的共享集群部署，也不等待 Hub、Launcher、ES、Redis 或 AI 服务。

部署脚本目前不会创建 PostgreSQL 集群、数据库角色或镜像仓库。两台 worker 和此部署配置也不等于数据库/控制面已高可用；这些环境前提与滚更中的请求连续性仍需在目标集群验收。

## 一次性配置

准备 Node.js 22.18+、Docker Buildx、kubectl，以及目标 Kubernetes context、专用 PostgreSQL 数据库和所有 worker 可访问的镜像仓库。构建主机的镜像架构应与目标 worker 匹配；异构集群需使用已构建的多架构镜像 digest。

```sh
cp .env.example .env
node scripts/init-credentials.mjs mx-insight-hub
```

编辑 `.env` 中 context、镜像仓库、namespace 等值。`init-credentials` 只在目标文件不存在时生成应用的 test/live 调用凭据、各环境独立的核实凭据和渠道管理凭据；已有文件保留，输出不打印密钥，不启用真实收款。应用 API 凭据仅放在业务服务端，不分发给浏览器，不复用 Hub Admin Token 或 Launcher 登录令牌。

自行创建权限为 `0600` 的 `secrets/runtime.env`：

```dotenv
MX_PAY_DATABASE_URL=postgresql://mx_pay_runtime:URL_ENCODED_PASSWORD@PAYMENT_DB_HOST:5432/mx_pay
MX_PAY_DB_POOL_SIZE=10
```

使用普通 `KEY=value`，不加 shell 引号；数据库 URL 中的密码应编码。数据库应有持久磁盘、备份和已验证的恢复方式。新服务会拒绝包含 Hub tenants/原支付表或 Launcher 平台记录的数据库。

正式环境建议另建迁移 owner 与运行角色，在 `.env` 设置 `MX_PAY_MIGRATION_ENV_FILE=secrets/migration.env`：

```dotenv
MX_PAY_DATABASE_URL=postgresql://mx_pay_owner:URL_ENCODED_PASSWORD@PAYMENT_DB_HOST:5432/mx_pay
MX_PAY_RUNTIME_ROLE=mx_pay_runtime
```

两个角色和数据库先由数据库管理员建立；运行角色须能连接该库。迁移结束后自动对运行角色授予当前支付表需要的查询/写入权限，不授予 DDL、DELETE 或审计修改权限。API Pod 只挂载运行凭据，迁移 owner 仅进入 Job。未单独配置迁移文件时沿用运行连接，适用于本机/过渡环境。

`secrets/credentials.json` 可登记多个应用；每条记录有独立 `id`、`appId`、`environment`、`secret` 和 `scopes`。身份与环境从凭据确定，请求体不能指定其他应用或环境。凭据更新通过新版本 Secret 和 Pod 发布生效；旧 Pod 完全退出前旧凭据可能仍有效，不能把修改文件当成即时撤销。

预构建镜像部署：设置 `MX_PAY_BUILD=0` 和 `MX_PAY_IMAGE=registry/path@sha256:<64位摘要>`。一般重复 deploy 自动构建新镜像，不使用 `latest` 或单节点的 `imagePullPolicy: Never`。

## 管理与恢复

```sh
bash scripts/manage.sh status
bash scripts/manage.sh doctor
bash scripts/manage.sh logs
bash scripts/manage.sh migrate   # 只迁移，不更新 API
bash scripts/manage.sh restart   # Kubernetes 滚动重启当前版本
bash scripts/manage.sh stop      # 显式停止 API，保留数据库与凭据
bash scripts/manage.sh start
```

- 迁移采用 mx-common 的锁、逐文件事务和不可变校验和；失败立即停止，旧 API 配置未更新。已成功的兼容迁移保留，下次 deploy 接着执行。
- 同一 namespace 的修改操作共用 `mx-pay-deploy-lock`，包含迁移和 rollout。并发操作直接失败，不交叉发版；不同主机也受同一锁约束。
- 中断或超时会先等待迁移 Job 删除，再以 UID 前置条件释放自己的锁。不能确认迁移停止时保留锁。主机崩溃/SIGKILL 后，需人工确认原执行进程已停止、对应 Job/Pod 已终止，再恢复锁；脚本不会根据年龄盲目抢占。
- rollout 失败可能已有部分新副本就绪；脚本报告失败并保留证据，不声称已经自动回滚。检查 Job、Pod 和原镜像/Secret 后，可使用上一个兼容镜像 digest 重新 deploy。回退程序不回退付款事实或数据库。
- 首次部署即记录数据库目标指纹；之后普通 deploy 不允许悄悄换库。密码更新不改变目标指纹。数据库迁移或主机名称切换是独立运维变更。
- 每代 Secret 保留，便于兼容回退；后续清理必须先核对 Deployment/ReplicaSet/Job 引用。当前不自动删旧凭据、数据库、PVC 或备份。

脚本 `stop` 是停进程，会中断该服务；正式支付维护应先安排停止新单并处理在途订单。尚未实现业务层维护开关、自动渠道回调、退款或自动开票，不能把 restart/stop 当成退款或取消付款。

本机/过渡可设置 `MX_PAY_DEPLOY_DRIVER=compose`，仍使用专用 PG，`deploy` 先迁移再更新 API 并等待健康。默认仅绑定 `127.0.0.1:18230`，保留旧镜像记录，按调用者 UID/GID 读取本机凭据。Compose 模式不提供滚动可用性或跨主机部署锁，不作为正式双节点方案。

## 独立 API 与可靠交付

除健康检查外均需服务端 Bearer 凭据，写订单和状态操作还需原 `Idempotency-Key`。

| 接口 | 职责 / scope |
| --- | --- |
| `GET /health/live`、`GET /health/ready` | 存活；支付库迁移兼容性与排空状态 |
| `GET /v1/channels` | 当前凭据环境的可用渠道；`orders.read` |
| `POST /v1/orders` | 下单；`orders.write`；body 为 businessOrderId/customerRef/amountMinor |
| `GET /v1/orders`、`GET /v1/orders/:id` | 当前应用/环境订单；`orders.read`；分页 1–100 |
| `POST /v1/orders/:id/submit`、`cancel` | 提交流水、取消未提交订单；`orders.write` |
| `POST /v1/orders/:id/confirm`、`reject` | 人工核实或退回；独立 `receipts.confirm` |
| `GET/PUT /v1/settings` | 收款码配置；`settings.write`；写入仅 live 凭据 |
| `GET /v1/events` | 未确认付款事件，最多 100 条；支持 after 分页；`events.read` |
| `POST /v1/events/:id/ack` | 业务已提交凭据 businessReceipt；`events.ack` |

金额使用整数分；当前 CNY 500–10,000,000 分。重复下单需保持相同业务单、金额和幂等键。确认时严格校验订单版本、实收金额、真实流水与到账时间，同一收款账户的流水不能被多个应用重复使用。用户提交付款流水不会使订单变成已支付。

服务端 SDK 导出 `@qpjoy/mx-pay/client` 的 `PaymentClient`：create/order/act/events/acknowledge/consumeBatch。超时的写请求返回 `payment_outcome_unknown`，不会自动换编号或重发新订单；应查原订单或以原编号重试。

确认收款与 `payment.paid` 事件同事务提交。首期采用 **应用主动拉取 + 提交后确认**：无需支付服务访问业务内网，也不需要空转的支付 worker。事件在业务系统停机期间保留，允许重复投递；没有依赖递增游标的漏单窗口。后台拉取循环属于接入应用，SDK 本身不偷偷启动定时任务。推送通知、渠道查单 worker 后续接入同一事件契约。

消费方必须验证 appId/environment/paymentId/businessOrderId/customerRef/金额和币种，将 inbox 去重记录与本地钱包或权益更新在自己的同一事务中提交，然后返回稳定的业务流水号再 ack。ack 丢失后重试不得重复入账。`consumeBatch` 只在回调成功返回业务凭据后确认；它不替业务实现事务。分页返回 `nextAfter`；每轮扫描用它继续后续页，扫描结束或进程重启后从首页重试仍未确认的事件。游标不能当作永久消费水位；这样早期失败事件不会挡住后续页面，并发晚提交也可在下一轮取回。尚无独立死信后台或自动重试调度。

独立服务不持有 Hub 钱包，不处理公司发票资料。原 Hub 充值/开票界面仍按既有路径使用，接入新 API 和存量交接属于下一实施段；不能把部署新服务当作已经切换 Hub。

## 验证与后续

```sh
npm ci --omit=optional --ignore-scripts
npm test
# 使用已创建的可丢弃测试库；包含 HTTP、本地事务、权限和迁移验证
MX_PAY_TEST_DATABASE_URL=postgresql://.../mx_pay_test npm test
```

部署测试使用替身命令验证执行顺序、失败停止、锁与配置代际；数据库测试使用真实 PostgreSQL。2026-10-02 本机 13 项支付测试、43 项 Hub 登录/钱包/充值回归及 1 项 mx-base 管理回归通过。当前机器 Docker daemon 未启动，未完成容器构建、真实双节点 rollout 或生产部署验收。

后续先接 Hub 业务 inbox、充值交付与存量单写交接，再完善独立人类管理台和 Launcher 身份接入。官方支付宝、Creem、微信、退款执行、分账和供应商付款尚未实现。业务架构见[统一管理规划](../../mx-launcher/docs/32-platform-business-centers-and-management-integration.md)与[支付规划](../../mx-insight-hub/docs/product/payments-and-cost-control.md)。

部署机制参考 [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)与[PostgreSQL 锁](https://www.postgresql.org/docs/16/explicit-locking.html)。实际可用性须按目标环境进行故障和恢复验收。
