# MX Autotest 设计文档

> 状态：产品与架构提案。本文档描述目标、边界和验收门槛，不表示对应功能已经实现或实跑通过。

MX Autotest 是一个注册到 standalone launcher 的桌面测试工作台，也是一个与技术栈无关的测试控制面。它面向测试人员组织项目、目录、套件、任务和执行记录，通过独立部署的 mx-auto-server 调度 Cypress、Playwright、pytest、k6 等工具，并把结果归一成可检索、可复现、可分享的质量证据。

它的产品主语始终是 **MX Autotest**。Cypress、Playwright 和未来的 tshark 只是补充能力的执行工具，不是产品的信息架构。

## 不可突破的边界

1. MX Autotest 作为 standalone launcher 应用注册，可独立安装和运行；MX-H2I 没有打开时仍可工作，也允许两者同时运行。
2. Internal 是应用注册、身份、策略和平台配置的唯一真相源。桌面缓存不是配置权威，Domestic 也不是 MX Autotest 的配置面。
3. 复用 mx-launcher 的账号认证，但不修改、不代理、不接管 MX-H2I 的登录与联网路径。
4. mx-auto-server 独立部署在 electron-dock 下的 K8s namespace、数据库和存储中。它的部署、迁移、扩缩容或故障不得滚动 mx-launcher，也不得影响现有用户登录。
5. 结果接入以 JUnit XML 为最低契约，以可选 rich sidecar 提供步骤、证据、目录映射和引擎原生能力。
6. 初期不依赖 Jenkins，也不在产品内复制一个通用 CI 流水线引擎。
7. 工具链使用官方固定版本、校验摘要和内容寻址缓存；不把所有浏览器和测试工具永久塞进 Electron 安装包。
8. 所有“完成”都必须有实跑记录和证据包。只有设计、代码或界面不能被表述为验收通过。

## 文档导航

| 文档 | 回答的问题 |
| --- | --- |
| [00 · 产品愿景](00-product-vision.md) | 为什么做、为谁做、什么不是本产品 |
| [01 · 架构与边界](01-architecture-and-boundaries.md) | standalone、Internal、身份、K8s 与故障边界如何落位 |
| [02 · 领域与契约](02-domain-contracts.md) | Project、Suite、Task、Run、Catalog 和结果契约如何定义 |
| [03 · Luopan / Compass 初步验收](03-luopan-compass-acceptance.md) | 首个 Web 与 Electron 闭环怎样才算可验证 |
| [04 · 测试源码交付](04-test-source-delivery.md) | 测试代码放哪、如何版本化、为什么不长期按工具分支 |
| [05 · 工具链与产物](05-toolchain-and-artifacts.md) | 工具如何获取、缓存、执行和产出可分享证据 |
| [06 · 低流量与运维](06-low-traffic-and-operations.md) | 如何避免长连接、大下载和对现有平台的资源干扰 |
| [07 · 路线图与商业价值](07-roadmap-and-business-value.md) | 如何分阶段交付，以及不同角色如何衡量价值 |

核心决策记录：

- [ADR-0001：standalone、Internal 真相源与登录隔离](adr/0001-standalone-internal-and-login-isolation.md)
- [ADR-0002：JUnit 最低契约与 rich sidecar](adr/0002-junit-baseline-and-rich-sidecar.md)
- [ADR-0003：QA 外部仓库优先](adr/0003-qa-owned-test-source.md)
- [ADR-0004：固定工具链、独立服务与暂不使用 Jenkins](adr/0004-pinned-toolchains-independent-server-no-jenkins.md)

## 建议阅读路径

- 测试新手：00 → 03 → 05。
- 测试专家或 SDET：02 → 04 → 05 → 06。
- 开发与排障人员：03 → 02 → 05。
- 架构、运维与安全人员：01 → 06 → ADR。
- 产品经理、负责人和投资决策者：00 → 07 → 03。

## 状态标记

文档使用以下词义，避免把愿景误写成事实：

| 标记 | 含义 |
| --- | --- |
| 已存在 | 仓库中已有可检查的实现；仍不等于在目标环境实跑通过 |
| 提议 | 已形成设计选择，尚待实现 |
| 实验性 | 需要技术 spike，能力边界可能导致方案调整 |
| 已验证 | 必须附 run ID、源码提交、环境指纹和可打开的证据包 |

当前这组文档整体状态为 **提议**。首轮真实验证以 [03 · Luopan / Compass 初步验收](03-luopan-compass-acceptance.md) 为准。

## 文档治理

这些文档允许随构建持续更新，但更新必须和实现同步：

- 新增或改变跨系统边界时先更新 ADR；
- 改动领域字段、runner 输入或结果格式时同步 schema、示例与 contract test；
- 完成一个 Gate 时附 evidence 和验证日期，不直接删除原来的未决风险；
- 发现文档与运行事实不一致时，以事实为依据修正文档并记录原因；
- README 保持可导航，废弃文档标 superseded，不静默改写历史决策。
