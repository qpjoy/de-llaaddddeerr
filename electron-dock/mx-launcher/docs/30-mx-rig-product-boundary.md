# MX Rig 产品与 Launcher 边界

2026-09-14：自动化产品演进为 MX Rig 桌面 Agent 工作台。主目录为 sibling `electron-dock/mx-rig`，内部包含 apps/desktop、apps/server、共用 UI、packages/runtime 和测试领域内核；不在 demos 新建同名项目。

MX Rig 的当前实现与运行说明以 [README](../../mx-rig/README.md) 和 [架构](../../mx-rig/docs/01-architecture.md) 为准。旧 mx-test-framework、mx-auto-server 和 demos/mx-autotest 保留作历史，既有代码不被新产品动态加载。

Internal 管理组织配置、模型连接和工具策略。身份通过 Launcher 公开合同验证，Rig 角色与任务数据独立。桌面 Runtime 托管自己的浏览器子进程，当前不申请 network lease，不接管 MX-H2I/Luopan 的 profile、DNS、PAC、NRPT 或网络所有权。

Launcher 的现有 test-center 继续承担平台质量与发布门禁。Rig 可作为统一测试入口下的独立工作台；详细入口方案见 [集成说明](../../mx-rig/docs/02-launcher-integration.md)。本次只增加文档，不修改 Launcher Controller、登录限流、readiness 或部署资源；没有执行现网注册。

产品配置统一不等于进程、数据库和故障域合并。Rig 的模型服务、工具或 Runner 不可用时，不得使 MX-H2I 用户登录与联网依赖失败。测试门禁不得把 Agent 任务完成当作测试通过。
