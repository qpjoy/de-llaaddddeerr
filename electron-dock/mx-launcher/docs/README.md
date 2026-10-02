# MX Launcher 设计文档索引

本目录同时保存历史方案、当前实现基线和目标架构。涉及 MX-H2I 网络行为时，优先按以下
顺序阅读：

1. [14-mx-h2i-standalone-launcher-architecture.md](./14-mx-h2i-standalone-launcher-architecture.md)：
   V1/V2、standalone/embed、ProductNetwork、地址和网络 owner 的总边界。
2. [21-network-mode-switch-events-and-performance.md](./21-network-mode-switch-events-and-performance.md)：
   当前访客/员工切换、事件和性能不回归基线。
3. [28-mx-h2i-connection-operations-and-anonymous-governance.md](./28-mx-h2i-connection-operations-and-anonymous-governance.md)：
   当前 Launcher Network 多产品 Dashboard、MX-H2I/Luopan 归属与过滤、连接抽屉、
   Feishu 用户显示、产品级 ban/unban、匿名准入隔离，以及实时连接、3D 拓扑和
   未来 peer-safe 下线边界。

相关专题：

- [36-service-operations.md](./36-service-operations.md)：
  服务与部署已在本地实现：Launcher/Hub/Embedding/OCR 的参数表单、命令预览、独立执行器、
  版本与配置预检、持久任务及断线查询。包含随 Launcher deploy 幂等安装/安全更新及生产验收边界，未部署生产。

- [35-platform-implementation-and-acceptance.md](./35-platform-implementation-and-acceptance.md)：
  分阶段实施与验收进度。首期工作台、导航归纳和连接设置折叠已在本地实现与验证，未部署生产；
  后续依次接邀请注册、SSO、Hub 自助开通、飞书绑定及统一运维。

- [33-mx-platform-identity-and-sustainable-architecture.md](./33-mx-platform-identity-and-sustainable-architecture.md)：
  2026-10-02 完整平台设计：身份分域、SSO、复用原飞书、邀请码/开放注册、已有账号绑定与归并、
  按应用自动开通、产品权限和生效期限、Launcher 统一管理工作区、证书与服务风险、AWX 退出，
  以及保持 H2I/Luopan/Hub 老用户无感的分阶段方案。Luopan 线上产品为外部 po-frontend 的
  feat/yjj/hdo_v2 分支，demos/luopan 仅作演示，本轮不改实际产品。首期邀请码、后台可切开放。

- [34-platform-deploy-and-recovery-contract.md](./34-platform-deploy-and-recovery-contract.md)：
  总 deploy 的清单、子系统契约、依赖顺序、重启/换系统恢复、原凭据与数据库身份保护、
  失败续跑、运维按钮/动作目录、自更新和证书任务。总部署仍为设计；首批单服务执行见 36，阶段进度见 35。

- [32-platform-business-centers-and-management-integration.md](./32-platform-business-centers-and-management-integration.md)：
  平台入口、技术运维、业务管理的职责划分；从现有 Internal Admin 演进独立运维控制台，
  各中心独立数据/API/工作台，统一安装维护与财务、支付、Hub 的渐进接入。目标规划。

- [31-internal-reboot-recovery.md](./31-internal-reboot-recovery.md)：
  Internal 服务器搬迁/重启的 deploy 恢复、原数据与凭据保护、失败停止条件和现场验收。

- [30-mx-rig-product-boundary.md](./30-mx-rig-product-boundary.md)：
  MX Rig 独立产品工作区、测试领域内核迁入与 Launcher 测试中心入口边界；取代旧 AutoTest 的产品发展方向，不改 MX-H2I 登录和联网实现。

- [13-platform-ops-and-admin-design-system-roadmap.md](./13-platform-ops-and-admin-design-system-roadmap.md)：
  Admin/运维设计系统与 Three.js 工作区。
- [20-luopan-standalone-development-guide.md](./20-luopan-standalone-development-guide.md)：
  Luopan 及后续 standalone 产品隔离。
- [24-mx-h2i-feishu-login.md](./24-mx-h2i-feishu-login.md)：
  密码、飞书、访客 profile 与安全切换。
- [26-mx-insight-hub-integration-architecture.md](./26-mx-insight-hub-integration-architecture.md)：
  MX Insight Hub 与 Night-All 数据产品边界。
- [29-unified-launcher-updater-integration.md](./29-unified-launcher-updater-integration.md)：
  通用应用 updater、ProductNetwork 相对制品地址、Electron 产品接入与 Luopan 一次性 L3 切换边界。
- [MX AutoTest 历史产品文档](../demos/mx-autotest/docs/README.md)：
  独立安装、可与 MX-H2I 共存的测试领域产品；包括 Launcher 登录隔离、JUnit/证据契约、
  Compass Web/Electron 首期验收、低流量运行和商业路线。旧 `mx-test-framework` 仅作为
  `mx-auto-server` V0 的过渡执行内核。

带“目标架构”或“后续”状态的文档不代表代码已经实现。运行时能力必须以实现、测试和
部署证据为准。
