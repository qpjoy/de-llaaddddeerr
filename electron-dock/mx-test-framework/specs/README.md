# MX Test Framework · Specs

MX Test Framework（简称 **MXT**）是一个独立的 e2e 测试平台，位于
`electron-dock/mx-test-framework`，与 `mx-launcher`、`mx-insight-hub` 同级。

本目录是设计真相。实现如果和这里不一致，先改这里再改代码。

## 阅读顺序

| 文档 | 内容 |
| --- | --- |
| [00-overview-and-scope.md](00-overview-and-scope.md) | 定义、任务模型、范围与非目标 |
| [01-architecture.md](01-architecture.md) | 单进程 server + 两种 runner |
| [02-domain-model.md](02-domain-model.md) | 七张表的领域模型与 schema |
| [03-case-catalog.md](03-case-catalog.md) | Case ID 规范、目录 schema、drift 检测 |
| [04-runner-contract.md](04-runner-contract.md) | Runner 接入契约（环境变量、产物、退出码） |
| [05-tracks-and-artifacts.md](05-tracks-and-artifacts.md) | 双轨的提炼与优化、产物、脱敏与对外分享 |
| [06-api-contract.md](06-api-contract.md) | 控制面 / Runner 面 HTTP API |
| [07-agent-case-authoring.md](07-agent-case-authoring.md) | Agent 生成用例的工作流与护栏 |
| [08-compass-onboarding.md](08-compass-onboarding.md) | 首批落地：compass web → compass electron |
| [09-roadmap.md](09-roadmap.md) | 阶段、验收标准、开放项 |
| [10-deployment.md](10-deployment.md) | `manage.sh deploy` 一键部署、存储、清理 |
| [11-runner-environments.md](11-runner-environments.md) | RHEL 无头 e2e 可行性、本地 runner、定时任务排队 |
| [12-ui-and-onboarding.md](12-ui-and-onboarding.md) | 界面、新人引导、测试同学如何提供用例 |
| [13-platform-review-and-redesign.md](13-platform-review-and-redesign.md) | **复盘与重构方案**：现有实现的问题清单、目标分层架构、Web/Electron 引擎选型、定时与运维、落地路线 |

## 架构决策记录

| ADR | 决策 |
| --- | --- |
| [0001](adr/0001-standalone-platform.md) | 独立平台，与 mx-launcher 只共享账号；不做门禁、不进 AppCenter |
| [0002](adr/0002-playwright-primary-cypress-adapter.md) | Playwright 为主引擎，Cypress 作为一等 runner adapter |
| [0003](adr/0003-git-owned-case-source-of-truth.md) | 用例代码以 git 为真相源，平台做注册与调度 |
| [0004](adr/0004-independent-database.md) | 独立 `mx_test` 库，复用 mx-common 迁移器 |
| [0005](adr/0005-federated-identity-and-runner-tokens.md) | 复用 Launcher 账号登录；Runner 用 run 作用域短期 token |

## 三条硬约束

1. **平台是增益，不是前置依赖。** MXT 不可用时，被测应用仓库里的 `pnpm e2e:local`
   必须仍能独立跑通。
2. **零用例不是通过。** 配置错、浏览器起不来、目标不可达，一律 `blocked`（退出码 2）。
3. **不改 mx-launcher 任何代码，不介入 MX-H2I 的联网与登录路径。**

## 上游参考

- 存量实现：compass（`luopan/po-frontend`，`public` 分支）的 `cypress/`、
  `scripts/e2e-*.mjs`、`docs/E2E.md`
- 同级应用范式：`mx-insight-hub`（ESM server + migrations + `scripts/manage.sh` + docs/adr）
- 术语来源：[`mx-launcher/docs/09-observable-automation-test-platform.md`](../../mx-launcher/docs/09-observable-automation-test-platform.md)
  —— 那是 launcher 自己的 HDOI 质量控制面，MXT 只借用了它的 run/case/step 记录结构

## 与 MX Agent Studio 的边界

权威边界见
[`ADR-0012: Hub-native Agent Studio`](../../mx-insight-hub/docs/adr/0012-hub-native-agent-studio.md)：
Hub 负责创建业务 Data Agent，并原生拥有 Agent 内部 Trace、Eval、Gate 与 Release；MXT 只提供
部署后黑盒质量证据。Promptfoo、Langfuse 与 LangSmith 不进入当前 MXT 或 Hub 运行依赖。
即使未来共享底层 CI/Job 执行基础设施，也必须另立 ADR 抽取无领域状态的 runner substrate，
继续隔离数据库、身份与 payload；Agent Eval 永远不是 MXT 领域对象，Release 决策也不移出 Hub。
