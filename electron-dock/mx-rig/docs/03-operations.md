# 运行、部署与验收

## 本地

`npm install` 安装依赖，`npm run dev` 启动 localhost:8791。随机开发口令保存在 `.runtime/dev-token`，仅用于本地。`npm run desktop` 打开 Electron，登录相同服务。工作台不自动为项目创建测试账号或运行目标测试。

`dev` / `desktop` / `package` 会先跑 `scripts/design-assets.mjs`，把已安装的 `@qpjoy/ui-design-neon-void` 同步到 `apps/web/vendor/`（生成物，不入库）。该包缺失时同步跳过并沿用已有副本，服务照常启动——打包后的桌面自带这份副本。

`npm run browser:install` 安装与锁定 Playwright 对应的 Chromium。若系统盘空间不足，安装和启动桌面时设置同一个 `PLAYWRIGHT_BROWSERS_PATH` 到工作盘目录。首次浏览器安装需要网络，浏览器不可用时任务应为 blocked。

## 服务配置

支持 Node `--env-file=.env`，或者直接注入 MX_RIG_*。服务凭据、数据库和状态目录必须独立。端口默认 8791，未占用 MX-H2I 端口。非本地客户端只接受 HTTPS 的 Rig 地址，生产通过受控 Internal 反向代理提供 TLS。

`MX_RIG_LAUNCHER_URL` 是现有 Launcher 身份公开接口的服务端基址，不是 Rig 自身地址。没有它时，只启用 Rig 自己的 admin 口令登录，不尝试修改 Launcher 来使服务启动。

模型连接配置在 Internal 页面保存：Provider 列表顺序即调用顺序，密钥只通过各 Provider 指定的服务端环境变量注入。改完环境变量需要重启服务。没有真实模型时，Agent 明确受阻而不是伪造回答；使用测试工作流可独立验证任务执行链。

「Agent 中心 → 出网观测」只读地报告本进程看到的代理变量，凭据隐藏但如实标注是否存在。注意 Node 22 的 `fetch` 不读代理环境变量：环境里配了代理不等于服务走代理，页面会分别标注"已配置"与"是否生效"。MX Rig 不设置代理、路由、DNS、PAC 或 NRPT。

## Compose

从本目录使用 `docker compose --env-file .env -f deploy/compose.yaml up --build -d`。额外设置 MX_RIG_DB_PASSWORD（建议随机 hex，避免 URL 保留字符）和 MX_RIG_SECRET_KEY（64 位 hex）；MX_RIG_ADMIN_TOKEN 使用独立随机值。

镜像构建上下文为 electron-dock；只复制 mx-rig、mx-common 和 Neon Void 依赖，不复制旧自动化项目。三个独立 volume 存放 PostgreSQL、Mission/策略和 artifact。数据库先就绪，再执行迁移，再启动服务。服务只将 8791 映射到宿主 loopback。

Compose 不提供 Kubernetes API，因此 K8s Job 派发不可用。使用注册的专用 Runner，或后续在独立 mx-rig namespace 部署并给予限范围 Job 权限。不能指向 Launcher 的 ServiceAccount。

本版本仅支持单实例服务。备份数据库与两个文件 volume；恢复前停服务，不能让两个进程同时写同一个 Mission/配置目录。`docker compose down` 保留 volume；不要使用 `-v`，除非有意删除 Rig 数据。

## 验证层级

- `npm run check`：源码语法和网络 owner 禁止耦合检查。
- `npm test`：迁入的测试领域回归，加上编排运行时、编排规格与编译、Agent 中心、出网观测、配置迁移与 API 边界测试。
- 浏览器 UI：本地登录、任务创建、确认与拒绝、Agent 中心各页、编排中心（打开已存编排、草稿预览、被拒绝的草稿）、配置保存、测试管理入口、刷新和证据展示。
- Electron：独立启动、IPC、子进程任务、取消、重登、浏览器隔离、关闭无残留。
- 发布：安装包签名与真实目标机器回归。
- 现网：隔离环境验证后再登记入口；必须另存 MX-H2I 登录和联网证据。

测试中模型替身验证协议和状态机，不代表已完成真实模型服务验收。模拟测试 Runner 验证调度/报告接口，不代表当前机器运行过真实 Compass 客户端。
