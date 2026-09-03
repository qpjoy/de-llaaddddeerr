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

带“目标架构”或“后续”状态的文档不代表代码已经实现。运行时能力必须以实现、测试和
部署证据为准。
