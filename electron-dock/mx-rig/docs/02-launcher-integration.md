# Launcher 测试中心集成

本次选择“独立产品 + 平台入口”，不把模型循环和浏览器放进 Launcher server。

## 现有系统保持原样

- 不修改 MX-H2I 密码/飞书登录、游客/员工切换或退出顺序。
- 不添加 ProductNetwork，不复用 MX-H2I/Luopan 网络 owner 或凭据。
- 不改 Launcher readiness、测试门禁判定、数据库迁移、Secret 或部署脚本。
- Rig 故障只使自己的入口不可用；不能加入 Launcher 的登录前置条件。

## 可交付的入口

Rig 管理入口：`https://<rig-internal-origin>/rig/`；完整测试管理台：同 origin `/test-center/`。管理员在 Internal 现有应用/导航注册流程中将其作为独立业务入口登记。桌面应用标识为 `dev.qpjoy.mx-rig`，不需要在 `demos` 放源码副本。

两个入口共用 `@qpjoy/ui-design-neon-void`，与 Insight Hub、AppCenter 看起来是同一套产品；共用的只是设计系统包，没有共享运行时、身份或网络。

本版本不提供伪造的 ProductNetwork 注册 manifest。需要独立 VPN 能力时，后续通过明确的 Launcher 注册合同申请自己的地址段，不能复制旧 Autotest 身份，也不能只为“应用展示”申请网络权限。

身份：Rig 使用公开 OAuth/introspection 合同，audience mx-sdk，用户首次进入默认 viewer。Rig 的操作员/管理员角色由其独立数据库维护，模型不能提升权限。服务间密码/校验请求延续旧独立服务的公平预算、负缓存和并发限制。

平台测试中心将来可以调用 Rig 测试 API并保存 evidence 引用；只接入有限摘要、状态与原始证据 URL。MX Rig 的 Agent 答复不能直接调用 Launcher gate evaluate，更不能给生产发布自动放行——内置 Agent 的角色说明里写明了这一点，工具集里也没有任何门禁接口。

## 上线验证

在独立预发布环境验证 MX-H2I 登录、已有连接、断开与退出；Rig 缺席、停止、超时、部署、模型不可用、Provider 序列全部失败、浏览器崩溃均不得改变其结果。Rig 的出网观测页是只读的，不会写入任何代理、路由或 DNS 设置。比较 Launcher Deployment/Pod generation、端口、route/WG/PAC/NRPT 状态和登录 API 错误率。现网未执行这些检查前，不宣称现网集成已验收。
