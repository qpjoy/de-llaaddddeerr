# MX DataPort 数港

DataPort（数港）是独立部署的客户入口。视觉组件来自用户提供的外部数港设计原型，账号由 Launcher/Auth 管理，业务权限与数据由 Hub 管理。

当前已完成 DataPort 品牌/目录/域名迁移支持、退出回登录修复，以及 Hub 统一管理的商品日限额、消费切换和全价升级。代码和本机验收已完成，生产尚未发布。操作见 [发布清单](dataport.setup.md)，业务规则见 [Hub 订阅设计](../mx-insight-hub/docs/product/dataport-subscriptions.md)。

## 本地运行

Node.js 22.18+。在本目录执行：

```bash
npm ci
npm run build
MX_HARBOR_PREVIEW=1 npm start
```

另一个终端执行 `npm run dev`，打开 `http://127.0.0.1:4278/`；设计对照入口为 `http://127.0.0.1:4278/demos/ui-design-dataport/`。也可使用 `npm run dev:gallery` 在 4279 单独启动设计对照。

预览模式不连接真实账号、数据库或支付；gallery 表单不会创建账号。生产模式需要 DataPort 自有数据库及已完成的迁移；SSO、Hub 尚未接入时仍可启动并展示首页，相关接口返回 503，不会回退到演示用户。生产服务不开放 `/demos/`。

正式域名：`https://dataport.minsight-ai.com`。保留 `mx-harbor` 身份、数据库、K8s 和 `MX_HARBOR_*` 配置标识以兼容现有数据；已有域名迁移使用 `enroll --migrate-domain`。首次全新应用发布后可运行 `bash scripts/manage.sh ops internal-production enroll` 自动登记独立 Auth client 并同步 Hub Portal 凭据；Auth/Hub 首次启用仍分别走原发布流程。两端网关和证书使用 de-mingxi 的 `internal-dataport-install` / `dataport-install`，详细顺序见 [操作清单](dataport.setup.md)。

## 当前目录

- `ui-design/`：DataPort CSS、基础组件和原始设计来源 SHA256 清单。独立命名为 `@qpjoy/ui-design-dataport`，未修改 Hub/Neon Void 样式。
- `apps/web/`：React 19 + TypeScript + Vite 页面，保留原登录弹窗布局，加入邀请码注册。
- `apps/server/`：独立 BFF、mx-common SSO、加密会话；每次客户接口调用重新校验 Auth。
- `migrations/`：DataPort 自有会话库迁移，无 Hub 业务表、密码或支付账本。
- `deploy/`、`scripts/`：单节点 K8s 构建/迁移/发布、网关模板、幂等接入工具和兼容接入补丁。

## 管理命令

首次配置和适用范围见 [部署说明](docs/implementation-and-operations.md)。在 Internal 节点执行：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

`deploy` 一次完成配置保留与校验、镜像构建/导入、幂等迁移、应用更新与自动重启、rollout、DataPort 就绪检查及已接入 SSO 的检查。每次部署使用新镜像触发一次 DataPort Pod 替换，无需另行运行 `migrate` 或 `restart`。

首次缺少 `secrets/operations.json` 时，自动发现当前 Kubernetes context、集群 UID 和本机节点，将配置以 0600 权限保存。Hub 默认使用固定的集群 Service DNS，部署时不要求 Hub 在线。已有配置始终保留；后续不会因当前 context 变化而切换部署目标。SSO profile、网关凭据缺失不阻止建库、迁移或发布。以后补齐本地接入文件再运行同一 deploy，会只补充 Secret 中缺失的配置，保留数据库和既有密钥。运行中的 DataPort 按请求读取挂载的接入文件，Secret 投影更新后即可发现，无需为接入配置单独重启。

部署宿主机无需先运行 `npm ci`。管理脚本仅使用 Node 标准库与相邻 `mx-common` 的配置校验源码；应用依赖由 Docker 构建阶段按 lockfile 安装。拉取项目时需保留相邻的 `electron-dock/mx-common` 目录。

重复执行保留数据库、SSO 密钥和网关凭据；已应用迁移校验通过后跳过。迁移失败不更新应用，发布或健康检查失败返回非零。SSO 检查发生在 DataPort 更新并就绪之后，失败会明确提示应用已更新，返回非零、不报告部署成功，不回滚或重新发布。旧 `migrate`、`restart` 命令兼容为完整 `deploy` 的别名，不再提供分步部署。

2026-10-21 起，DataPort 就绪后从运行 Pod 执行只读 discovery/capabilities 诊断。最终运行配置确实缺少 SSO profile 时跳过，保留首次未接入部署；已有 profile 且检查健康时不操作 Auth。仅固定 Internal 生产集群、生产 issuer/origin 和仅含 502/503/504 的上游失败具备恢复资格，调用原完整 `recover-public-auth-hostport.mjs --apply` CLI 最多一次，仍须通过它的全部现场校验和运维锁。它可以拒绝恢复，或确认入口已健康而不重建；200 配置不匹配、401/403/404、DNS/TLS/超时等不会触发恢复。

恢复后最多执行三次只读复查；仍失败或恢复结果不确定即退出非零，不重试恢复写入。该步骤不运行 `mx-move resume`、不重启私网身份或 MX-H2I；这是部署时检查与受限恢复，不是持续监控，也不保证 CNI 规则永不丢失。完整边界见[部署后 SSO 检查](docs/implementation-and-operations.md#2026-10-21-部署后-sso-检查与受限恢复)。新 deploy 接入按本地测试验证，生产仍待下一次正常 deploy 验收，不为验证重复发布。

只查看 K8s 状态可运行 `bash scripts/manage.sh ops internal-production status`。`/ready` 检查 DataPort 数据库和会话表，`/status` 返回外部接入配置状态（`pending` / `configured` / `invalid`），不返回地址或凭据；`configured` 不代表远端服务当前可用。

登录返回 410/503 时，可运行 `bash scripts/manage.sh ops internal-production diagnose-auth`，从现有数港 Pod 内检查 Auth discovery 和 capabilities，输出脱敏状态及匹配结果。无需发布镜像，不创建登录事务或修改配置。现场分层检查见 [SSO 故障排查](docs/sso-outage-20261021.md)。

2026-10-21 公网身份 18444 hostPort 缺失已通过定向恢复处理，用户已确认真实 DataPort 登录与 MX-H2I 登录、联网正常；规则最初消失的原因仍未确定。独立工具 `node scripts/recover-public-auth-hostport.mjs` 保留只读预检入口，`--apply` 仅重建经核验的公网身份 Pod；保护条件和验收见上述排查文档。当前健康时无需重跑恢复，迁盘事务已完成，不为此重跑 `mx-move resume`。

兼容 `MX_INSIGHT_BUILD_PROXY` 作为构建代理的备用变量。业务发布仍只更新 DataPort；仅上述守卫全部通过时可定向重建共享公网 Auth，期间依赖它的新登录可能短暂不可用。不执行 Launcher 全量发布、Hub 迁移或重启、Pay 重启，不 `ensure` 全部 mx-common，不改变 MX-H2I 的私网身份与联网服务。

- [实施状态、配置与验证](docs/implementation-and-operations.md)
- [全局架构与后续实施](docs/architecture-and-rollout.md)
- [完整商业闭环验收要求](docs/acceptance.md)

订阅按成交时的商品配置立即生效或顺延；旧商品默认保持顺延。默认消费最早到期的可用订阅，也可手动指定优先。升级按全价新购高档套餐，付款后立即生效并设为优先，旧订阅保留。

## 验证

```bash
npm run build
npm test
```

数据库用例需要显式的本机临时库 `MX_SSO_TEST_DATABASE_URL`，名称必须含 `sso_test`；未设置会跳过。该变量不能指向业务数据库。部署命令替身测试不等于实际 K8s 发布验收。
