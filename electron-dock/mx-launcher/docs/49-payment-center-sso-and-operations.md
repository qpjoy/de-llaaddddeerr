# 49 · 支付中心 SSO、Hub 首个应用与运行维护

2026-10-04。代码接入与本地验收完成，未部署生产。

mx-pay 位于 `mx-base/mx-pay`，使用 Launcher 的账号权威与 mx-common 共享 SSO。人的支付查询台和机器交易 API 分进程、监听端口、Deployment 与 Secret；支付配置、加密会话和交易事实留在专用支付数据库，不使用 Launcher / Hub 数据库。

Internal「运行与维护」增加 MX Pay 的状态、有限日志、诊断与部署入口。命令调用支付项目自身 `bash scripts/manage.sh deploy`，不联动发布 Launcher/Auth 或 Hub、不启用正式收款、不迁移原订单。已有执行器升级只追加缺失的支付实例，保留原令牌和主机档案，等待任务排空后载入新服务。

统一认证客户端可在 Internal → 平台设置 → 统一认证 → 接入应用中登记，使用 `appId=mx-pay`。登记仍沿用原 Auth 发布流程，原账号、Hub 客户端、MX-H2I 用户登录及联网逻辑不变。应用登记不是支付业务授权；首阶段支付查询台仅支持按 issuer/subject/clientId + appId + test/live 单独授予的 viewer。

实际导航：左侧栏向下滚动到「平台管理」，展开「平台设置 → 统一认证」，填写「新增接入应用」。Pay 使用公网认证、名称 `MX Pay`、标识 `mx-pay`、地址 `https://pay.minsight-ai.com`，首次 Audience 设为 `mx-pay`；校验、保存后点击「前往 Launcher 发布」，完成发布再刷新确认「Auth 已加载」。密钥和回调由主机生成，接入详情显示私有档案路径。

Pay 的 `deploy` 现已自动处理本机接入档案与首次空权限，无需手动复制 `profile.json` 或创建 `access.json`。未生成 SSO 档案时可先部署内网 API，后续登记后重跑同一命令补上查询台；已有身份和权限保持。Internal 运维计划将自动发现来源、已登记状态及目标配置一起纳入摘要校验，预检后档案变化须重新预检，浏览器不接收凭据内容。

2026-10-05 修复：旧版生产恢复检查会把新增的公网应用也当成凭据变化，在镜像构建及业务发布前以 `public identity credentials differ; recovery stopped` 退出。恢复检查现在与身份发布的规则一致：允许主机档案新增应用，但已发布客户端的完整登记、issuer、签名密钥、Cookie 密钥、入口凭据及 CA 必须保留；公网和内网已有应用被修改或遗漏时仍然停止。

服务器同步修复后，在 `mx-launcher` 目录重跑原 `bash scripts/manage.sh ops internal-production deploy` 及原有环境参数即可，`MX_INSIGHT_HUB_DEPLOY=0` 可继续保留。无需重新登记 mx-pay、删除身份档案或恢复检查点。检查点同时保留已发布 Secret 与含待发布应用的主机档案；恢复本身不会提前发布新增客户端，随后正常 Auth 发布才生效。若更新后仍报告凭据不一致，应核对已有配置差异，不能跳过保护。

Hub 作为首个业务接入方，继续保留自己的充值意图、租户钱包和提交后 ACK；支付源与权威订单校验已抽取为 `@qpjoy/mx-pay/integration` 并由 Hub 消费。现有 `client`、`reporting` SDK 继续复用。Hub 用户充值无需登录支付查询台，机器凭据不能由人的 SSO Token 替代。

完整配置、Kubernetes/Compose 入口、公共模块边界、验收和待定设计集中记录于 [mx-pay 接入说明](../../mx-base/mx-pay/docs/sso-and-application-onboarding.md)。2026-10-05 已确定 Pay 公网域名和原公共 Auth 入口，用户已确认无存量订单。`de-mingxi` 的 `internal-pay-install --pay-root <项目目录>` 自动按固定集群目标查询 Service IP/端口。上线仍需首批查看授权、服务器部署/证书及 Hub 正式渠道联调。支付人员授权的 Internal 编辑页面、人工确认和退款审批属于后续设计。

## 2026-10-05 支付管理授权边界

Pay 已升级为独立管理中心，root 需先经 Launcher 创建/邀请注册，再以实际 userId 在 Pay 引导首个管理员。Launcher 仍管统一账号和应用准入；Pay 管模块、角色和应用/环境范围。支付访问邀请不替代 Launcher 注册邀请码，不给同名账号隐式授权。此批不改 Launcher/H2I 运行代码，无需为 Pay 管理页面再次发布 Launcher。

未来全局权限中心使用 Pay 的 `GET /v1/permissions/catalog` 和分页 `GET /v1/permissions/members`，凭据 scope 为 `permissions.read`、绑定 mx-launcher/live。当前仅汇总契约，代写授权需后续单独受审计 API，不直连各中心权限数据库。详细操作、权限矩阵与范围见 [支付管理中心](../../mx-base/mx-pay/docs/management-center.md)。


## 2026-10-05：界面分配 Hub / Pay 管理员

更新并部署 Launcher、Hub、Pay 各一次后，在「成员与访问 → 用户与账号 → 用户详情 → 角色与应用授权」勾选 Hub 管理员、Pay 管理员并保存。需要管理 Launcher 本身时另选 MX Admin；用户名 root 没有特殊含义。已有角色支持多选并保留，注册邀请码仅创建普通用户，注册后可在该界面授权。不再需要先在服务器执行 Pay bootstrap-admin。

新增角色映射：mx-hub-admin → mx:hub:admin；mx-pay-admin → mx:pay:admin；mx-pay-channel-manager → mx:pay:channels；mx-pay-auditor → mx:pay:audit；mx-pay-finance-viewer → mx:pay:finance。原有 mx-admin、mx-user 权限不扩张，禁止应用仍优先阻止登录。

应用只接受当前已验证、issuer/client/audience/subject 匹配的 SSO 身份。Hub 映射为 platformAdmin，Pay 映射为本地定义的中心角色；Pay 不把中央角色持久化成本地授权。只读缓存最多 30 秒，写操作重新验证；账号停用继续复用原 SSO 撤销机制。机器支付凭据不能登录管理台或授予人员角色。

部署继续使用「运行与维护」各服务现有 deploy 动作。每次角色变更不需要重发服务。迁移保留原 Launcher 用户角色库、Hub/Pay 数据库与 SSO/Secret，不读取子应用权限数据库，也不生成基于机器主机名的新授权。详细边界见 [Pay 管理中心说明](../../mx-base/mx-pay/docs/management-center.md)。
