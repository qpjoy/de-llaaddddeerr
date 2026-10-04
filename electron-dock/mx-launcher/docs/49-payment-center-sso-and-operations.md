# 49 · 支付中心 SSO、Hub 首个应用与运行维护

2026-10-04。代码接入与本地验收完成，未部署生产。

mx-pay 位于 `mx-base/mx-pay`，使用 Launcher 的账号权威与 mx-common 共享 SSO。人的支付查询台和机器交易 API 分进程、监听端口、Deployment 与 Secret；支付配置、加密会话和交易事实留在专用支付数据库，不使用 Launcher / Hub 数据库。

Internal「运行与维护」增加 MX Pay 的状态、有限日志、诊断与部署入口。命令调用支付项目自身 `bash scripts/manage.sh deploy`，不联动发布 Launcher/Auth 或 Hub、不启用正式收款、不迁移原订单。已有执行器升级只追加缺失的支付实例，保留原令牌和主机档案，等待任务排空后载入新服务。

统一认证客户端可在 Internal → 平台设置 → 统一认证 → 接入应用中登记，使用 `appId=mx-pay`。登记仍沿用原 Auth 发布流程，原账号、Hub 客户端、MX-H2I 用户登录及联网逻辑不变。应用登记不是支付业务授权；首阶段支付查询台仅支持按 issuer/subject/clientId + appId + test/live 单独授予的 viewer。

实际导航：左侧栏向下滚动到「平台管理」，展开「平台设置 → 统一认证」，填写「新增接入应用」。Pay 使用公网认证、名称 `MX Pay`、标识 `mx-pay`、地址 `https://pay.minsight-ai.com`，首次 Audience 设为 `mx-pay`；校验、保存后点击「前往 Launcher 发布」，完成发布再刷新确认「Auth 已加载」。密钥和回调由主机生成，接入详情显示私有档案路径。

Hub 作为首个业务接入方，继续保留自己的充值意图、租户钱包和提交后 ACK；支付源与权威订单校验已抽取为 `@qpjoy/mx-pay/integration` 并由 Hub 消费。现有 `client`、`reporting` SDK 继续复用。Hub 用户充值无需登录支付查询台，机器凭据不能由人的 SSO Token 替代。

完整配置、Kubernetes/Compose 入口、公共模块边界、验收和待定设计集中记录于 [mx-pay 接入说明](../../mx-base/mx-pay/docs/sso-and-application-onboarding.md)。2026-10-05 已确定 Pay 公网域名和原公共 Auth 入口，用户已确认无存量订单。`de-mingxi` 的 `internal-pay-install --pay-root <项目目录>` 自动按固定集群目标查询 Service IP/端口。上线仍需首批查看授权、服务器部署/证书及 Hub 正式渠道联调。支付人员授权的 Internal 编辑页面、人工确认和退款审批属于后续设计。
