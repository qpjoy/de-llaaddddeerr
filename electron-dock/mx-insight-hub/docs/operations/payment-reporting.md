# 独立支付中心的报表同步

2026-10-02。已实现 mx-pay → 消费者 PostgreSQL → Hub 管理员查询的完整后端链路。它只读取付款事实，不写钱包、不确认付款、不 ACK 业务事件，也不切换现有 Hub 内嵌充值路径。现有 Hub 历史充值尚不属于独立 mx-pay 的数据源，不能把本报表当作两条路径的完整合并账。

## 已交付范围

- mx-pay 的 `@qpjoy/mx-pay/reporting` 提供 PostgreSQL 投影存储和后台消费循环；其他中心也能复用，数据库连接池由消费者传入。
- Hub Admin/combined 进程运行消费者；Public 进程不创建它、不接收它的凭据。可配置至多 16 个固定应用/环境数据源，使用独立 `reports.read` 密钥。
- 默认在 Hub PostgreSQL 内创建独立 `pay_reporting` schema，也可以指向另一套 PostgreSQL。两种方式都只通过支付 HTTP API 拉数据，不跨库查询支付生产表。
- 三个只读管理接口：同步状态、订单明细、按日实收/手续费。暂未新增浏览器报表页面、财务角色、关账凭证或会计总账。

## 接入与部署

先在 mx-pay 中登记报表消费者，不复用下单或核实凭据。例如先接测试环境：

```sh
# 在 electron-dock/mx-base/mx-pay
node scripts/add-reporting-credential.mjs mx-insight-hub test hub-bi-test
bash scripts/manage.sh deploy
bash scripts/manage.sh discover
```

从私有 `secrets/credentials.json` 取得 `hub-bi-test` 的 secret。入口使用 discover 返回的 serviceURL（同集群）或实际配置的 HTTPS 私网网关（跨集群）；跨集群不能直接复制另一个集群的 Service DNS。

在 Hub 新建 `secrets/payment-reporting.env`，目录权限 0700、文件权限 0600。文件使用普通 `KEY=value`，JSON 保持一行，不使用 shell 引号包住整段值。以下为占位示例，token 必须替换为实际只读凭据：

```dotenv
MX_INSIGHT_PAYMENT_REPORTING_SOURCES=[{"id":"hub-pay-test","appId":"mx-insight-hub","environment":"test","baseUrl":"http://mx-pay.mx-pay.svc.cluster.local:18230","token":"REPLACE_WITH_THE_READ_ONLY_SERVICE_SECRET"}]
# 可选；不配置时在现有 Hub 数据库内建独立报表 schema
# MX_INSIGHT_PAYMENT_REPORTING_DATABASE_URL=postgresql://reporting_role:URL_ENCODED_PASSWORD@REPORT_DB:5432/hub_reporting
```

数据源可带 `expectedSourceId`，用于预先固定已确认的支付源 UUID；未提供时，第一次成功提交存量页固定 UUID。`appId`/`environment` 必须与密钥授权一致。每个应用的 test/live 分别配置、分别汇总；不接受跨应用通配密钥。

```sh
# 在 electron-dock/mx-insight-hub
chmod 600 secrets/payment-reporting.env
bash scripts/manage.sh deploy
```

Hub 部署脚本读取该私有文件并创建专有 Secret；可通过 `.env` 的 `MX_INSIGHT_PAYMENT_REPORTING_ENV_FILE` 指定其他路径。仅 Admin 和 migration Job 引用这个 Secret。文件不存在时保留集群中已有 Secret，不能因为换部署主机而自动关闭同步或换库。显式设置 sources 为 `[]` 可停止新的同步，已有投影和进度仍保留。

标准 deploy 会自动执行消费者迁移，再发布 Hub。外部 reporting 数据库/角色需预先存在并拥有建 schema 的权限；脚本负责建表和增量迁移，不创建未知远端 PostgreSQL 实例。迁移不访问支付 API，因此支付中心临时离线不妨碍报表组件发布。运行期间支付入口、报表库或报表配置故障仅影响本集成，登录、现有充值与其他 Hub 服务继续按原配置工作。

Compose/本地运行使用同名两个环境变量；Compose 的 app 已透传，仍先执行标准迁移。公开监听器不会使用这些配置。不要把数据源密钥或报表库 URL 放进浏览器、普通 ConfigMap、源码或日志。

## 管理员查询

沿用现有 Hub 平台管理员会话/Admin Token。租户 owner/admin、普通 API Key 与 Public 监听器均不能访问跨租户报表。查询只读取本地投影，不触发同步或付款操作。

| GET 路径 | 返回 |
| --- | --- |
| `/internal/v1/admin/payment-reports/sources` | 配置源、固定的源 UUID、阶段、最近成功/失败、是否追平、是否过期；不返回密钥、服务 URL、DSN 或游标 |
| `/internal/v1/admin/payment-reports/hub-pay-test/orders?limit=50&after=UUID` | 1–100 条订单，按支付 ID 继续分页；仅该 source 的固定应用和环境 |
| `/internal/v1/admin/payment-reports/hub-pay-test/daily?from=2026-10-01&to=2026-10-02` | 包含起止日，最长 366 天，按 Asia/Shanghai 到账日与币种汇总 |

明细/汇总同时返回 `source`、`freshness` 和 `provisional`。首次存量未完成增量追赶、当前未追平、超过两分钟未完整追平或最近同步失败时，不能将数据当成最新完整结果。观察时间和源时间分别保留；这是运营查询，不能代替月结时冻结的多源截止水位与财务口径版本。

汇总字段：`paidCount`、`receivedMinor`、`knownFeeMinor`、`unknownFeeCount`。计数与合计使用十进制字符串，避免 JavaScript 大整数精度损失；单据金额仍为整数分。全为未知手续费时 `knownFeeMinor=null`，部分未知时只汇总已知部分并返回未知数量。这里的实收额不是会计收入，也没有自动外币换算、优惠折算或退款净额。

## 正确性与运行边界

1. 存量页和增量页使用源端版本契约。消费者按 revision 合并，旧版本不覆盖新版本；同版本内容冲突、固定业务身份变化、终态被改写会停止本页提交。
2. 同一页的订单批量投影与 checkpoint 在一个消费者事务中提交。HTTP 请求期间不占数据库锁；短事务内锁定 stream 并比较 version，多副本重复抓页时只有一个提交者，其余丢弃本次结果。
3. 单页最多 100 条，批量读写，不对每条记录跨网络查询一次。每轮每源最多 10 页，默认间隔 15 秒；失败持久化退避 5 秒至 5 分钟。重启读取原 checkpoint，不重新申请订单、不自动清空投影。
4. 配置源 ID 对应固定 app/environment；支付源 UUID 改变、源水位后退或数据冲突时保留原 checkpoint 和事实。错误状态只记录固定错误码，不存上游错误正文。恢复正确数据源后可从原进度续传。
5. 相同 `(source UUID, app, environment)` 在同一报表库只允许一个 stream，防止不同名称重复汇总同一份事实。多个独立报表库仍可各自消费。迁移/重建由运维明确处理，不能换名称绕过原源身份错误。
6. 报表连接池最多 3 个连接，管理端最多 2 个并发读请求，超限返回 429；查询超时 5 秒。它不借用 Hub 交易/登录连接池。默认与 Hub 共用 PostgreSQL 实例时仍共享 CPU/IO，独立 schema 不等于物理故障隔离。
7. 支付与报表迁移双向拒绝误用对方数据库。数据主键在 stream 内对应 payment_id，stream 固定源 UUID/应用/环境。customerRef 是业务引用，不根据它的文本猜测或重建 Hub 租户、影子账户或用户权限。

报表库与私有配置纳入所属中心备份；独立库由该 PostgreSQL 的备份/PITR 流程覆盖。报表投影可从支付事实重建，但原进度、源绑定和经确认的财务版本需保留；普通部署不选择或恢复备份，也不以“能连上”判断数据是否最新。

## 验证与后续

本地使用临时 PG16 的独立支付库和报表库，经过真实支付 HTTP 与 Hub 管理接口验证：重复消费、多副本竞争、分页追赶、事务回滚、重启续传、源绑定错误、未知手续费及权限隔离。命令：

```sh
MX_PAY_TEST_DATABASE_URL=postgresql://.../disposable_test_database \
  node --test tests/server/payment-reporting.test.mjs tests/server/payment-reporting-deploy.test.mjs
```

数据库测试会在该临时实例创建并删除独立测试数据库，需要 CREATEDB 权限；不要指向生产实例。真实跨集群网关、容器构建与线上部署仍需目标环境验收。

下一步可在现有管理界面展示上述查询，并加入支付事实与 Hub 业务账本的显式映射/差异核对。充值业务切换、存量收款交接、业务 inbox 与钱包幂等入账另行推进；不能通过报表消费者完成这些资金操作。
