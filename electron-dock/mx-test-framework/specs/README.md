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
| [14-ci-runners-and-stack.md](14-ci-runners-and-stack.md) | **选型定稿**：Jenkins 与 mx-base、独立数据库、保留 clone 的条件、临时执行机、语言分轴、LLM 评测的位置 |
| [15-server-side-first-run.md](15-server-side-first-run.md) | **上机手册**：部署、浏览器访问、接入罗盘、跑第一次、改定时、Jenkins 的边界 |
| [16-multi-stack-platform.md](16-multi-stack-platform.md) | **平台化**：JUnit XML 通用契约、引擎与镜像、接入新项目零平台代码、pytest/Playwright/Jenkins 的价值分析 |
| [17-one-console.md](17-one-console.md) | **一个后台**：为什么执行机接 MXT 而不是接 Jenkins、构建→测试的交接、罗盘两条 suite |
| [18-notifications.md](18-notifications.md) | **通知**：只在状态跃迁时通知、适配器接口（飞书/企业微信/通用 webhook）、outbox、使用步骤与斟酌点 |
| [19-audit-trail.md](19-audit-trail.md) | **审计轨迹**：放开命令白名单之后的那道保障、记什么不记什么、审计表不能变成第二个密钥库 |
| [20-secret-store.md](20-secret-store.md) | **密钥库与注入**：env 还是文件之争的结论、加密落库的具体理由、只有 run token 能取值、按精确值脱敏 |
| [21-build-jobs.md](21-build-jobs.md) | **构建作业**：没有产物不是构建成功、artifactPath 让被测仓库零改动、校验和由平台算、罗盘三条 suite |
| [22-webhook-triggers.md](22-webhook-triggers.md) | **Webhook 触发**：唯一无鉴权路由的写法、原始字节验签、payload 永远不是指令、run 钉在推送的 commit 上 |
| [23-local-verification.md](23-local-verification.md) | **本机验证记录**：第一次真部署 + 罗盘 web/electron 两条流程跑通；`_electron` spike 的答案；实跑抓到的三个 bug |
| [24-windows-local-service.md](24-windows-local-service.md) | **Windows 本地服务版**：一台 Windows 跑完整平台做测试与 demo，与内网 Linux 服务端 + Windows/Mac runner 的正式形态并列，含 Windows 特有的坑 |

## 架构决策记录

| ADR | 决策 |
| --- | --- |
| [0001](adr/0001-standalone-platform.md) | 独立平台，与 mx-launcher 只共享账号；不做门禁、不进 AppCenter |
| [0002](adr/0002-playwright-primary-cypress-adapter.md) | Playwright 为主引擎，Cypress 作为一等 runner adapter |
| [0003](adr/0003-git-owned-case-source-of-truth.md) | 用例代码以 git 为真相源，平台做注册与调度 |
| [0004](adr/0004-independent-database.md) | 独立 `mx_test` 库，复用 mx-common 迁移器 |
| [0005](adr/0005-federated-identity-and-runner-tokens.md) | 复用 Launcher 账号登录；Runner 用 run 作用域短期 token |
| [0006](adr/0006-mxt-absorbs-builds-jenkins-deferred.md) | **MXT 吸收「构建」动作，Jenkins 暂不启用**；写死启用的触发条件 |
| [0007](adr/0007-test-code-ownership.md) | **框架与命令在 MXT 后台指定；用例代码归测试团队自己的 git 仓库**，业务仓库零改动 |

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
