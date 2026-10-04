# Luopan Java 后端核对与 mx-pay 修正

2026-10-03。只读核对 `/Users/qpjoy/workspace/mingxi/po-backend-java` 的 `feat/yjj/hdo_v2`，提交 `e86be9c008277e1045b7421332c9d03b7f4edde1`；前端为 `/Users/qpjoy/workspace/mingxi/luopan` 同名分支、提交 `a4cc5de`。未切换分支、修改参考仓库或读取商户密钥。

## 对应关系

这是此前前端调用的对应后端实现。`AgentToolboxController` 的类路径是 `api/agent-toolbox`，下列接口、参数和返回字段逐项一致：

| 前端行为 | Java 后端 |
| --- | --- |
| POST `/api/agent-toolbox/payments/alipay/page-pay`，参数 `agent_code`、`plan_code` | `src/main/java/org/example/controller/AgentToolboxController.java:121` |
| 返回 `order_no`、`pay_url`，前端打开收银台 | `src/main/java/org/example/service/impl/AgentToolboxPaymentServiceImpl.java:65`，SDK `pageExecute(..., "GET")` |
| GET `/api/agent-toolbox/payments/{orderNo}`，读取 `status` 和钱包 | Controller 第 146 行、Service 第 98 行 |
| 支付宝通知接收 | POST `/api/agent-toolbox/payments/alipay/notify`，Controller 第 164 行 |
| 官方 SDK | `pom.xml`：`com.alipay.sdk:alipay-sdk-java:4.40.865.ALL` |

服务器已知容器是 `compass-backend-pub`，镜像 `compass-backend:pub`，启动 `/app/app.jar`。源码接口匹配不能证明这个运行中 JAR 恰好由上述提交构建；这仍需服务器构建记录、制品版本或校验和确认。

当前 Java 下单接口额外检查登录账号名是否为 `admin`，其他用户返回 403；不是所有已登录用户都可直接使用支付宝充值。这是该应用的开放策略，不移入公共支付中心。

## 可借鉴的设计与保留边界

Java 服务按业务套餐从数据库取价格和 Token 数量，保存订单快照；验签并核对应用、卖家、金额和交易号；条件更新订单后充值，外层 `@Transactional` 把订单与 Token 入账放在同一数据库事务。SQL 还对支付宝交易号设置唯一索引。这些是有价值的业务侧参考。

但它的用户、套餐、订阅钱包属于该业务应用。mx-pay 继续使用独立数据库、应用/环境凭据和不可变支付订单，只将付款确认、审计、outbox、报表及观察证据原子提交。Hub/其他应用消费事件时，再把自身 inbox 与钱包/权益账同事务提交，不能把 Java 的 Token 表搬入支付中心。

参考实现有几处不能直接照搬：

- 本地下单 15 分钟后标记 `timeout`；回调仍可把它更新为 paid，但主动查单只在 `created` 状态执行。回调丢失且本地已超时的订单因此缺少该查询补偿入口。mx-pay 到期仅停止生成收银台链接，原单仍可查证、收回调，不直接判失败。
- Java 用 `HALF_UP` 统一到两位小数再比较。mx-pay 保持严格十进制字符串校验，拒绝多余小数位、科学计数法等输入，不把错误金额四舍五入为正确金额。
- Java 重复表单参数取首值；mx-pay 拒绝重复字段，单次 URL 解码后交给官方 SDK 验签。
- Java 主动查询处于数据库事务中；mx-pay 只用短事务取得查询租约，外部网络请求不占住数据库事务。
- Java 下单没有调用方请求键，接口重试会生成新订单；mx-pay 保留应用/环境/业务单/请求键约束，模糊结果沿用原单查询。

## 本次实际修正

依据[官方 Java SDK 的电脑网站支付模型](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/domain/AlipayTradePagePayModel.java)，并通过已锁定的[官方 Node.js SDK](https://github.com/alipay/alipay-sdk-nodejs-all)验证请求和响应：

1. **订单号分层**：内部 UUID 不变；新支付宝单保存 `checkout.outTradeNo = MXP + UUID 去掉连字符`，用于签名、查单和回调核对。解析后走已有 UUID 主键查询，再核对完整渠道编号，不能把 UUID 和新格式互认成别名。
2. **历史订单不改号**：缺少新字段的既有订单仍用原 UUID 查单、收通知；不再给它生成不符合当前字段规则的新链接。不能因这条限制直接要求用户重付，必须先查清原交易。
3. **请求字段校正**：创建前拒绝标题中的 `/`、`=`、`&`、控制/格式字符；移除电脑网站支付模型中未定义的 `seller_id` 请求字段。卖家身份仍通过不可变配置和通知校验保护，不能靠额外请求字段假定账户正确。
4. **付款窗口不续期**：使用东八区绝对到期时间，按秒固定为创建后 30 分钟；剩余不足一分钟不生成链接，同一订单不会因重新打开而延长。拒绝生成链接不等于确认未付款。
5. **特殊资金状态留待核实**：如果成功报文还带有“卖家未收款”等附加状态或信用支付模式，保存 review，不产生交付事件。这些字段的语义见[官方查单响应模型](https://github.com/alipay/alipay-sdk-java-all/blob/master/v2/src/main/java/com/alipay/api/response/AlipayTradeQueryResponse.java)。普通回调/后续查证可继续处理；已 paid 不倒退。
6. **响应身份不遮盖**：查单响应若实际带回冲突的应用或卖家字段，保留冲突交统一核验，不能用本地配置覆盖。直连商户查询通常不返回这些字段，缺省身份来自发起请求的应用及绑定配置；它们不是支付宝响应中额外提供的证明。本期不支持服务商代商户模式。

`pay_004_alipay_order_identity.sql` 只新增约束，不改历史迁移校验和、不回填旧订单、不移动数据库；订单既有保护触发器使新渠道编号同样不可变。

## 部署和验证

仍只需 `bash scripts/manage.sh deploy`。脚本先执行全部迁移；Kubernetes 已有 Deployment 且目标配置启用了官方渠道时，先把全部副本替换为“新代码、暂停官方新单/收银台”的版本，等待 rollout 完成，再恢复目标渠道配置并滚动发布。期间已存在付款仍可通知/查单，mock 和人工渠道不受这个开关影响。首次部署或所有官方渠道都停用时无需两阶段发布。

这是有意的短暂新收款暂停，不能宣称新收银台全程无中断。过渡阶段失败会非零退出，不执行恢复启用；重试 deploy 会重新完成兼容屏障，不根据 Deployment 模板已变更就猜测旧副本退出。源私密配置保持原值，使用不同的不可变 Secret 承载两阶段状态。直接用旧镜像回滚不具备新订单读取能力，不能绕过该升级契约。

测试使用合成 RSA 密钥和订单、官方 SDK 实际 HTTP 传输、独立临时 PostgreSQL，覆盖旧 schema 升级、旧编号接收、新旧编号混用拦截、数据库身份约束、签名篡改/缺失、上游异常、付款窗口、特殊资金状态、事务回滚和重放。部署使用替代命令验证顺序、失败停止、重试屏障及配置保留；这不能替代真实 Kubernetes 和支付宝沙箱验收。没有启用真实资金、迁移 Hub 余额或修改 Launcher/MX-H2I 登录。

本次结果：支付宝专项 17/17，支付全套 51/51（`TZ=UTC`），Hub 原身份/充值/报表兼容 31/31，均无跳过；脚本语法和变更空白检查通过。Java 项目仅做静态核对，未声称已运行其测试或验证服务器 JAR。
