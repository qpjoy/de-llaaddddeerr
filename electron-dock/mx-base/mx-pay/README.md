# mx-pay：统一支付能力与独立交易服务

2026-10-02：已实现独立 PostgreSQL 交易服务、应用凭据、付款事件、服务端 SDK 和一键部署脚本。默认真实收款关闭。仓库实现与本机测试不代表已经部署到 Internal。

2026-10-04：已接入 Launcher 共享 SSO 的独立支付查询台，按原用户身份、业务应用和 test/live 单独授权；交易 API 与人的登录分进程、分入口。Hub 复用新增的 `@qpjoy/mx-pay/integration` 一致性校验，Internal「运行与维护」新增 MX Pay。部署、配置及待定设计见 [SSO 与应用接入](docs/sso-and-application-onboarding.md)。尚未上线服务器或切换正式充值。

2026-10-03：新增多渠道配置与支付宝电脑网站支付，包括官方 SDK 签名、通知验签、主动查单、异常留档和跨库报表兼容。mock/人工渠道保持兼容；部署自动保留渠道 Secret 并执行全部新增迁移。对照 Luopan Java 后端及官方模型，进一步修正渠道订单号、标题、到期窗口和特殊资金状态；已启用官方渠道的 Kubernetes 升级会先完成兼容副本替换，再恢复新收款。详见[Java 后端核对记录](docs/alipay-java-reference-review.md)和[支付宝与多渠道接入](docs/alipay-channels.md)。没有商户配置时官方收款关闭，未接真实资金或自动切换 Hub 钱包。

事务与异常处理以[支付事务、异常矩阵与恢复协议](docs/transactions-and-failure-model.md)为验收依据：区分付款事实、调用结果未知和业务交付，逐项标明已实现保护、待补处置与真实环境演练。静态码的取消后到账、多付少付、额外来款以及存量支付交接仍是优先缺口。

**现有 Hub 默认继续使用原内嵌充值路径。** `@qpjoy/mx-pay` 原规则导出保持兼容；已提供 Hub 独立支付适配、账务员权限和钱包事件交付，但部署不自动切换。可先审核启用测试；已有正式历史订单仍需专项交接，不导入或重放历史付款。见 [Hub 接入、事务与切换说明](../../mx-insight-hub/docs/operations/payment-delivery.md)。独立服务可单独部署并验证，正式切换须按[单写入方迁移规划](../../mx-insight-hub/docs/architecture/payment-center-service-boundaries-and-reliability.md)完成交接。同一正式收款账户不能未经交接同时在旧 Hub 和新服务中核实收款。

## 一个命令部署或更新

在有 Node.js 22.18+、kubectl 和 Docker Buildx 的目标部署主机，在本目录运行；无需先复制 `.env` 或手填 context、密码：

```sh
bash scripts/manage.sh deploy
```

如果服务器使用 `/data/tmp`，直接运行 `TMPDIR=/data/tmp bash scripts/manage.sh deploy` 即可。尚未生成 SSO 档案时正常启动内网支付 API；同机 Launcher 已登记 mx-pay 时，deploy 会自动导入唯一的公网/内网接入档案，并首次创建空的查询权限文件。无需手工复制 `profile.json`、创建 `access.json` 或指定端口。之后登记 SSO，再运行同一命令即可追加查询台；空权限表示登录后暂时不能查看订单。

使用本机 `7789` HTTP 代理下载和构建镜像：

```sh
TMPDIR=/data/tmp MX_PAY_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh deploy
```

`MX_PAY_BUILD_PROXY` 也可存入支付 `.env`；命令行环境变量优先，显式空值沿用原构建方式。代理覆盖构建客户端、镜像仓库访问和 Dockerfile 内 npm 下载，不写入支付 API/查询台的运行环境。脚本在当前 Linux 主机的本地 Docker 中创建并复用 Pay 专用 BuildKit，经 host 网络访问回环代理，不修改 Docker/containerd 的全局配置，不切换全局 builder。首次缺少 BuildKit 镜像时经 `ctr` 客户端代理下载后加载；当前单节点首次托管 PG 也会预加载 PostgreSQL 镜像，先校验本机就是已固定节点。多节点的运行时拉取仍使用各节点已有网络配置。可用 `MX_PAY_BUILD_NO_PROXY` 指定内部地址绕过列表。实现依据：[Docker 远程构建器](https://docs.docker.com/build/builders/drivers/remote/)、[预定义代理参数](https://docs.docker.com/build/building/variables/#proxy-arguments)。

也可以在 `electron-dock/mx-base` 使用统一入口：

```sh
bash scripts/manage.sh deploy mx-pay
```

Kubernetes 为默认方式：发现并固定集群 → 检查节点并确定单节点/多节点模式 → 取得部署锁 → 发现/保留配置与凭据 → 构建和分发镜像 → 准备专用 PostgreSQL、固定存储身份 → 创建本版本不可变配置 → 执行迁移 Job → 迁移成功后更新 API → 等待 rollout 与 readiness。重复执行检查原迁移校验和，不重复执行已完成 SQL。失败返回非零退出码，阶段结果在 `.deploy/last-result.json`。

首次安装时，若整个集群只有一个节点，自动采用单节点模式，兼容当前 Internal 的 kubeadm 控制平面。API、查询台、迁移任务和首次托管 PG 都固定在该节点；仅为 Pay Pod 添加标准控制平面 NoSchedule 容忍，不删除集群 taint，不改变 Launcher/H2I 调度。仍检查 Ready、未 cordon 和其他阻止调度的 taint。单节点模式保留两个应用副本，但**没有跨主机容灾能力**。模式和节点保存在 `.deploy/topology.json` 与安装 ConfigMap，普通 deploy 不自动切换或替换主机。其他首次集群及历史多节点安装仍要求至少两个可调度 worker；部分节点故障不会被误判为新的单机安装。单节点扩容到多节点属于单独运维变更。

API 为两个或以上副本，RollingUpdate 的 `maxUnavailable=0`、`maxSurge=1`，按主机分布，配置资源限额、探针、退出排空与 PDB。无 hostNetwork、hostPort、Ingress、NodePort 或自动公网域名。数据库使用专用 PostgreSQL 实例，不调用 mx-common 的共享集群部署，也不等待 Hub、Launcher、ES、Redis 或 AI 服务。

未配置外部支付数据库时，自动创建专用 PG16、`mx_pay` 数据库、迁移 owner 与运行角色、持久卷、数据库 Secret 和应用凭据。API 发布不重启/升级已有 PostgreSQL。当前托管 PG 为一个 StatefulSet 副本，采用 `OnDelete` 更新策略和 PDB；**双节点 API 不等于 PostgreSQL 或控制面高可用**。生产主备、WAL/PITR、异地备份与断电恢复仍需单独建设和验收。脚本不能凭空创建第二台机器。

## 自动发现与可选配置

- 集群：显式覆盖值 → 已记录的部署目标 → 当前 context → 唯一 context。保留 context、`kube-system` namespace UID 和目标 namespace，不修改全局 `kubectl use-context`。重复部署拒绝变更集群身份。
- 凭据：优先现有 `secrets/` 文件；文件丢失则从当前 Deployment/安装记录引用的 Secret 恢复。首次生成应用 test/live、核实人员和渠道管理员独立凭据。只恢复配置，不恢复业务数据；已有服务凭据不能因查询失败而被当成“不存在”。
- 查询台：已有支付档案/权限 → 已部署查询台原 Secret → 首次从 `/var/lib/mx-launcher/identity/applications/{public|private}/mx-pay.json` 导入。保留原 clientSecret/sessionKey，不修改 Launcher。两个入口都存在时须用 `MX_PAY_SSO_SOURCE` 选择；显式路径尚未生成且查询台从未配置时继续仅发布 API。`MX_PAY_SSO_AUTO_DISCOVER=0` 可关闭首次自动发现，`MX_PAY_LAUNCHER_IDENTITY_DIR` 可指定主机身份目录。`.deploy/console-enrolled.json` 记录本机已准备过查询台；其配置后续丢失时必须恢复，不能重新生成身份或把权限清空。配置校验在构建/迁移前完成，`status/discover` 不导入或生成这些文件。
- 镜像仓库：显式 `.env` → 安装记录 → 当前 namespace 的 `ConfigMap/mx-platform-runtime` 中 `data.imageRepository`。这是一份可选运行时能力声明，为后续总 `manage.sh` 预留，无需额外中心在线。
- 无仓库：检查所选节点的 containerd（单节点模式为固定节点，多节点模式为可调度 worker），通过本机 `ctr` 或已有可信 SSH 导入同一镜像。远端默认使用节点 InternalIP 与当前 SSH 用户，可用 Node annotation `mx-pay.io/ssh-target=user@host` 明确已有入口。使用 `BatchMode`、严格 known_hosts 和无交互 sudo；不自动信任新主机、不改 containerd 配置。任一所选节点无法访问则在迁移前失败，提示所缺节点或可选镜像仓库。
- 节点镜像采用 Docker 内容 ID 命名、逐节点验证、`imagePullPolicy: Never`，API/迁移仅调度到已导入的节点。多节点模式新增 worker 后再次 deploy 才纳入；单节点模式保持原固定节点。节点镜像被运行时 GC 清除时也需重新 deploy；长期生产优先使用可靠仓库。节点导入目前要求同构 amd64/arm64，自动选择对应构建平台；异构集群可提供多架构镜像 digest。
- 存储：唯一默认 StorageClass → 本机 Linux 专用 local PV。无动态存储时，仅在通过 InternalIP 确认的本机上创建目录；优先挂载后的 `/data/mx-pay/<namespace>/postgres`，否则 `/var/lib/mx-pay/<namespace>/postgres`。存在 `/data` 却未挂载立即失败。已有路径、卷和数据身份优先，不扫描备份寻找“可用数据”。首次本地目录创建需要该主机文件权限，截图中的 root 运行方式可满足。

```sh
# 可选：自定义，而不是 deploy 的前置要求
cp .env.example .env
```

`.env.example` 所有配置均为注释形式的可选覆盖。自动生成和恢复的本地文件为 `0600`，日志不打印密码；不启用真实收款。应用 API 凭据仅放在业务服务端，不分发给浏览器，不复用 Hub Admin Token 或 Launcher 登录令牌。

如需接入**已经由外部管理的专用 PostgreSQL**，可自行提供 `0600` 的 `secrets/runtime.env`：

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

外部数据库的两个角色和数据库由其管理员建立；托管模式由脚本自动建立。迁移结束后自动对运行角色授予当前支付表需要的查询/写入权限，不授予 DDL、DELETE 或审计修改权限。API Pod 只挂载运行凭据，迁移 owner 仅进入 Job。已有单连接配置保持兼容，首次托管部署始终使用独立的 `runtime.env`、`migration.env`。

`secrets/credentials.json` 可登记多个应用；每条记录有独立 `id`、`appId`、`environment`、`secret` 和 `scopes`。身份与环境从凭据确定，请求体不能指定其他应用或环境。凭据更新通过新版本 Secret 和 Pod 发布生效；旧 Pod 完全退出前旧凭据可能仍有效，不能把修改文件当成即时撤销。

预构建镜像部署：设置 `MX_PAY_BUILD=0` 和 `MX_PAY_IMAGE=registry/path@sha256:<64位摘要>`。一般重复 deploy 自动构建新镜像。

## 管理与恢复

```sh
bash scripts/manage.sh status
bash scripts/manage.sh doctor
bash scripts/manage.sh discover  # 只读 JSON：版本、动作、实际节点、服务地址和依赖
bash scripts/manage.sh backup    # 独立托管 PG 的一致性逻辑归档与恢复配置
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
- 首次 PostgreSQL 初始化使用独立 Job。完成后固定 PV/PVC UID、PG system identifier 与安装标记；普通数据库启动命令没有 `initdb`，数据缺失或身份不一致则拒绝启动。local PV 使用 `local.path` 与硬节点亲和性，保留策略为 `Retain`，不会因调度到另一台节点而创建空目录。独立宿主机收据位于 `/var/lib/mx-pay/<namespace>/storage-identity.json`，绑定文件系统 UUID、挂载点与路径；不要删除它来“修复”部署。
- 动态 PV 也固定 UID，并将本服务专有 PV 的回收策略改为 `Retain`。既有 PG 镜像、路径、PVC、密码不因默认值变化而重建。初始化失败/超时保留 Job；完成/终止未确认时保留部署锁，需排查，不能自动删除锁或换库重试。
- `backup` 使用 `pg_dump -Fc` 的一致性快照；经 `pg_restore --list` 验证并生成 SHA-256 后才把 `.partial` 目录发布为完成目录。同时保留安装信息、专用 PG 凭据、当前及在运行副本引用的支付凭据，目录 `0700`、文件 `0600`。默认 Linux 路径 `/var/backups/mx-pay/<namespace>`，可用 `MX_PAY_BACKUP_DIR` 指定；需安全复制到异机。归档可读不代表已完成恢复演练，manifest 明确记录 `restoreDrillCompleted=false`。外部 PG 由其备份/PITR体系管理；普通 deploy 从不恢复任何备份。

### 重启、持久化与存量系统

Launcher 当前已有 local PV/磁盘身份与恢复凭据保护，mx-common 已有 PG system identifier、文件系统 UUID 与保留卷检查，Hub 遇到 mx-common 存储身份错误会停止部署。这些已有机制与 mx-pay 相互独立；本次不修改 H2I 登录、Launcher 身份或 Hub 租户数据。

曾出现“重启后像切到了另一份备份”的情况，应先核对实际挂载、PV/PVC、数据库连接、PG 身份、关键记录最新时间和业务流水，保留所有候选数据，不能用部署命令自动择库。身份检查能阻止误指向与空库初始化，**不能证明同一实例的一份物理历史备份足够新**；正式恢复仍需确定恢复点、核对在途交易/总账/上游流水后才开放写入。当前仅完成代码检查和测试，未连接服务器确认上次事故原因，也未替现有数据做新旧裁决。

后续总 `manage.sh` 应消费各中心的 `discover`/`last-result` 合约，编排部署、只读数据身份检查和独立备份任务；不能把“某个服务不可用”解释为允许为它选择备用数据、轮换凭据或创建新数据库。

脚本 `stop` 是停进程，会中断该服务；正式支付维护应先安排停止新单并处理在途订单。支付宝通知和渠道停用开关已实现；统一业务维护开关、退款和自动开票仍未实现，不能把 restart/stop 当成退款或取消付款。

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
| `GET /v1/reporting/snapshot` | 存量分页与初始增量水位；独立 `reports.read` |
| `GET /v1/reporting/changes` | 可重放的已提交订单变更，独立于业务 ACK；`reports.read` |

金额使用整数分；当前 CNY 500–10,000,000 分。重复下单需保持相同业务单、金额和幂等键。确认时严格校验订单版本、实收金额、真实流水与到账时间，同一收款账户的流水不能被多个应用重复使用。用户提交付款流水不会使订单变成已支付。

服务端 SDK 导出 `@qpjoy/mx-pay/client` 的 `PaymentClient`：create/order/act/events/acknowledge/consumeBatch。超时的写请求返回 `payment_outcome_unknown`，不会自动换编号或重发新订单；应查原订单或以原编号重试。

确认收款与 `payment.paid` 事件同事务提交。首期采用 **应用主动拉取 + 提交后确认**：无需支付服务访问业务内网，也不需要空转的支付 worker。事件在业务系统停机期间保留，允许重复投递；没有依赖递增游标的漏单窗口。后台拉取循环属于接入应用，SDK 本身不偷偷启动定时任务。推送通知、渠道查单 worker 后续接入同一事件契约。

消费方必须验证 appId/environment/paymentId/businessOrderId/customerRef/金额和币种，将 inbox 去重记录与本地钱包或权益更新在自己的同一事务中提交，然后返回稳定的业务流水号再 ack。ack 丢失后重试不得重复入账。`consumeBatch` 只在回调成功返回业务凭据后确认；它不替业务实现事务。分页返回 `nextAfter`；每轮扫描用它继续后续页，扫描结束或进程重启后从首页重试仍未确认的事件。游标不能当作永久消费水位；这样早期失败事件不会挡住后续页面，并发晚提交也可在下一轮取回。尚无独立死信后台或自动重试调度。

独立服务不持有 Hub 钱包，不处理公司发票资料。Hub 已有独立支付适配，默认仍走原充值路径，须按环境审核启用；存量正式订单交接另行实施，不能把部署新服务当作已经切换 Hub。

## 验证与后续

跨 Kubernetes／数据库集成使用业务 API 与只读报表数据契约。现已补齐存量分页、增量游标、独立报表凭据、SDK，以及可复用的 PostgreSQL 消费组件 `@qpjoy/mx-pay/reporting`。Hub 已接可选同步任务与管理员明细/状态/日汇总 API，可使用独立报表数据库；尚未新增浏览器报表页面或切换充值。详见[跨中心同步与财务报表](docs/cross-center-reporting.md)与 [Hub 接入部署](../../mx-insight-hub/docs/operations/payment-reporting.md)。

```sh
npm ci --omit=optional --ignore-scripts
npm test
# 使用已创建的可丢弃测试库；包含 HTTP、本地事务、权限和迁移验证
MX_PAY_TEST_DATABASE_URL=postgresql://.../mx_pay_test npm test
# PG16 初始化脚本、权限、备份恢复和拒绝空库启动；仅创建可丢弃临时实例
MX_PAY_TEST_PG_BIN=/path/to/postgresql-16/bin node --test tests/bootstrap-postgres.test.mjs
```

部署测试使用替身命令验证执行顺序、自动发现、重复部署/丢失配置恢复、错误集群/卷/数据库拦截、每节点镜像导入、迁移失败停止、锁与归档失败不发布；数据库测试使用真实 PostgreSQL。2026-10-02 全部 25 项支付测试通过（无跳过），含真实 PG16 初始化、运行权限、逻辑备份恢复到新库、数据身份错误/目录缺失时拒绝启动，以及报表存量/增量、并发提交/回滚、权限隔离、时钟偏差和独立消费者。Launcher/mx-common 现有 48 项存储与恢复保护测试、mx-base 管理回归也已通过。测试不代表目标机器状态；当前未完成 Docker 容器构建、真实双节点 rollout 或生产部署验收。

消费者接入后追加通过 Hub 的 31 项报表/部署配置/原充值/身份回归（无跳过），其中端到端测试使用临时 PG16 的独立支付库和报表库，经真实 HTTP 拉取、投影和管理接口查询；Hub manage 脚本回归也通过。此测试不替代目标环境的部署验收。

2026-10-03 事务异常验证增量：新增 7 个真实 PG 语句边界/HTTP 应答故障场景，该阶段支付测试 33 项通过、无跳过。覆盖 COMMIT 已成功但响应丢失、outbox 插入后失败、并发确认与退回，以及跨应用认领同一流水；这属于本地故障注入，未模拟真实节点/主库故障。

同日支付宝扩展后，全套支付测试 **47 项通过、0 失败、0 跳过**，在 `TZ=UTC` 下验证；Hub 身份/原充值/报表回归仍为 **31 项通过、无跳过**。新增签名与通知事务、跨人工/官方渠道流水去重、独立报表库、停用后收通知和渠道 Secret 丢失恢复测试。没有连接真实支付宝商户或进行生产收款。

随后对照 Java 后端与官方模型修正后，最新全套 **51 项通过、0 失败、0 跳过**（`TZ=UTC`），Hub 兼容回归 **31/31**。增加旧订单迁移与编号不可互换、SDK 实际 HTTP 查单验签、标题/付款窗口/特殊资金状态，以及两阶段升级失败停止与重试验证。

Hub 业务 inbox、充值交付和支付查询台 SSO 已实现，后续重点是上线验收、存量单写交接与人员资金操作权限。支付宝已支持电脑网站支付、验签通知和主动查单；定时对账/关单、Creem、微信、退款执行、分账和供应商付款尚未实现。业务架构见[统一管理规划](../../mx-launcher/docs/32-platform-business-centers-and-management-integration.md)与[支付规划](../../mx-insight-hub/docs/product/payments-and-cost-control.md)。

部署机制参考 [Kubernetes Jobs](https://kubernetes.io/docs/concepts/workloads/controllers/job/)、[Deployments](https://kubernetes.io/docs/concepts/workloads/controllers/deployment/)、[持久卷保留](https://kubernetes.io/docs/concepts/storage/persistent-volumes/)、[PG16 初始化](https://www.postgresql.org/docs/16/app-initdb.html)与[归档恢复](https://www.postgresql.org/docs/16/app-pgrestore.html)。实际可用性须按目标环境进行故障和恢复验收。
