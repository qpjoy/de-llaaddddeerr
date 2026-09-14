# 0.1 本地验证记录

日期：2026-09-14。环境：Windows 10 x64、Node 22.15.0、Electron 34.5.8、Playwright 1.58.2 / Chromium 145.0.7632.6。

## 已运行

1. `npm test`：321 项通过，0 failed / skipped。包含迁入内核的 304 项测试，以及新增 Runtime、配置、API、跨平台产物判断测试。网络/模型由受控替身验证，不访问生产。
2. 真实 HTTP 闭环：创建测试应用/Suite/Task → 创建 Mission → 等待具体参数确认 → 派发真实测试 Run → 原状态 pending-runner；不冒充测试通过。
3. 源码桌面与 Windows unpacked 桌面：登录、renderer 无 require、凭据未返回 UI、独立 worker、确认后派发、配置页、退出。打包目录是 `dist/win-unpacked`。
   最终追加 `desktop-smoke.mjs --packaged --browser`：同一 Mission 继续对话、未配置模型受阻，以及模型替身 → 用户确认 → 打包内 Runtime → 真实 Chromium → 截图证据的完整链路通过。该项使用模型替身，不是外部模型效果评测。
4. 真实浏览器工具：localhost 测试页面导航、按标签填写、按名称点击、截图、拒绝密码输入和未允许 origin、结束关闭浏览器。
5. Web UI：HttpOnly 会话登录、未配置模型明确 blocked、Internal 配置保存、工具页面。
6. Docker Compose `config --quiet` 通过结构校验。未构建或启动 Docker 服务。

源代码语法检查由 `npm run check` 执行。截图位于 `.runtime/qa/desktop-workspace.png`、`desktop-approval.png`、`desktop-completed.png` 和 `web-tools.png`，均为本地模拟业务，不是生产证明。

## 修复与验证

- Windows statfs 返回 files=0、ffree=0 表示没有 Unix inode 计数，不能据此拒绝所有上传。只在新内核修复，Unix inode 和全平台字节/条目保护仍保留。
- 系统盘剩余空间不足测试要求的 5 GiB reserve，因此将测试临时数据移至项目盘；没有降低生产预算。
- 重复确认、策略变更、跨用户读取、未知工具、非法参数、重启后未完成动作、取消与批准落盘竞争均有回归测试。
- 同一 Mission 可以继续对话并保留上一轮用户/助手消息；长历史达到预算时要求建立新任务，避免无限累积。

## 尚未验证

真实模型网关/费用、真实 Compass 制品与账号、PostgreSQL/Docker 部署、K8s Job 真实执行、macOS/Linux 包、正式签名/公证、Launcher AppCenter 现网登记和 MX-H2I 现网登录/联网回归。

其他项目仅新增历史说明及 Launcher 架构文档；未修改 MX-H2I、Luopan、Insight Hub 的运行代码，也没有调用部署、数据库迁移或网络修复命令。
