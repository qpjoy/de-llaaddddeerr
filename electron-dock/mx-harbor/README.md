# MX Harbor 数港

Harbor（Data Harbor / DataPort）是独立部署的客户入口。视觉组件来自 `/tmp/dataport`，账号由 Launcher/Auth 管理，业务权限与数据由 Hub 管理。

**当前完成第一批实现：独立 UI、邀请准入、统一 SSO、受限客户读取接口和 K8s 部署工具。尚未完成购买、¥1 管理员验收、付款返回及 IP 查询闭环，不具备商业上线条件。没有部署到生产。**

## 本地运行

Node.js 22.18+。在本目录执行：

```bash
npm ci
npm run build
MX_HARBOR_PREVIEW=1 npm start
```

另一个终端执行 `npm run dev`，打开 `http://127.0.0.1:4278/`；设计对照入口为 `http://127.0.0.1:4278/demos/ui-design-harbor/`。也可使用 `npm run dev:gallery` 在 4279 单独启动设计对照。

预览模式不连接真实账号、数据库或支付；gallery 表单不会创建账号。生产模式必须提供 SSO 和后端配置，缺失时启动失败，不会回退到演示用户。生产服务不开放 `/demos/`。

## 当前目录

- `ui-design/`：原 DataPort CSS、基础组件和来源 SHA256 清单。独立命名为 `@qpjoy/ui-design-harbor`，未修改 Hub/Neon Void 样式。
- `apps/web/`：React 19 + TypeScript + Vite 页面，保留原登录弹窗布局，加入邀请码注册。
- `apps/server/`：独立 BFF、mx-common SSO、加密会话；每次客户接口调用重新校验 Auth。
- `migrations/`：Harbor 自有会话库迁移，无 Hub 业务表、密码或支付账本。
- `deploy/`、`scripts/`：单节点 K8s 构建/迁移/发布、网关模板和一次性 Hub 接入补丁。

## 管理命令

首次配置和适用范围见 [部署说明](docs/implementation-and-operations.md)。在已经固定的 Internal 节点执行：

```bash
MX_HARBOR_BUILD_PROXY=http://127.0.0.1:7789 bash scripts/manage.sh ops internal-production deploy
```

`deploy` 一次完成配置保留与校验、镜像构建/导入、幂等迁移、应用更新与自动重启、rollout 和健康检查。每次部署使用新镜像触发一次 Pod 替换，无需另行运行 `migrate` 或 `restart`。

重复执行保留数据库、SSO 密钥和网关凭据；已应用迁移校验通过后跳过。迁移失败不更新应用，发布或健康检查失败返回非零。旧 `migrate`、`restart` 命令兼容为完整 `deploy` 的别名，不再提供分步部署。

只查看状态可运行 `bash scripts/manage.sh ops internal-production status`。

兼容 `MX_INSIGHT_BUILD_PROXY` 作为构建代理的备用变量。命令只管理 Harbor，不自动发布 Launcher、不运行 Hub 迁移、不重启 Hub/Pay、不 `ensure` 全部 mx-common。

- [实施状态、配置与验证](docs/implementation-and-operations.md)
- [全局架构与后续实施](docs/architecture-and-rollout.md)
- [完整商业闭环验收要求](docs/acceptance.md)

## 验证

```bash
npm run build
npm test
```

数据库用例需要显式的本机临时库 `MX_SSO_TEST_DATABASE_URL`，名称必须含 `sso_test`；未设置会跳过。该变量不能指向业务数据库。部署命令替身测试不等于实际 K8s 发布验收。
