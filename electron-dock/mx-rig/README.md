# MX Rig

连接本机与 Internal 能力的桌面 Agent 工作台。测试是第一个领域能力，不是 Runtime 的顶层模型。

**版本：0.1 Preview。** 已实现独立 Electron 工作台、本地子进程 Runtime、Internal 工作台与模型网关、逐动作确认、浏览器工具和继承的测试平台。不是完整的 Codex 替代品，也不声称支持任意操作系统自动化。

## 一个产品目录

```text
electron-dock/mx-rig/
  apps/desktop/             Electron 主进程、受限 preload、打包配置
  apps/web/                 桌面与 Internal 共用工作台 UI
  apps/server/              Internal 身份适配、配置与模型网关
  packages/runtime/         可独立运行的任务循环、工具、状态与本地 worker
  packages/contracts/       状态与工具输入校验
  packages/test-platform/   从旧框架迁入的完整测试领域内核
  test-packs/                QA 用例包，当前为 Compass Electron
  deploy/                   独立服务镜像与 Compose
  docs/                     架构、迁移和验收记录
```

不在 `mx-launcher/demos` 新建第二个 mx-rig，不新建 mx-rig-server 平级仓库。
Launcher 是平台基础设施，Rig 是独立产品。Internal 是部署/管理面，不是“全部业务都必须写入 Launcher 进程”。

## 本地启动

Node.js 22+，在本目录执行：

```powershell
npm install
npm run dev
```

打开 `http://127.0.0.1:8791/rig/`。账号 `admin`，密码从本目录 `.runtime/dev-token` 读取。程序不把密码打印到日志；首次启动生成随机值。开发测试目录使用内存，Mission 和策略保存于 `.runtime/control`。

桌面端另开终端：

```powershell
npm run browser:install
npm run desktop
```

桌面不要求 MX-H2I 运行；只要求能访问配置的 Rig 服务。非本机服务必须通过 HTTPS。桌面不会申请网络 lease，也不接管 VPN、DNS、PAC、NRPT 或已有网络 owner。需要私网连通性时，由管理员提供已有网络或后续明确注册的 Launcher 能力，而不是隐式依赖 MX-H2I 进程。

登录凭据只在主进程/worker 内存；renderer 不接收 bearer token。退出销毁当前 Runtime，本机历史按服务地址和用户分目录保存。浏览器使用临时独立 context，不读取用户浏览器登录态。

## 第一条任务

1. Web 工作台的“测试中心 → 打开完整测试管理台”，接入项目、用例、Suite 和 Task。继承的“接入 / 对齐 Compass”入口可复用；登记不会自动运行测试。
2. 回到 Rig，选择“测试工作流”，选择已有计划并开始。
3. 核对 `tests_run` 参数并确认。Rig 返回真实测试 Run ID；派发完成不等于测试通过。
4. 在测试管理台检查 Runner、结果、JUnit、录像和报告。未连接 Runner 时显示等待执行机，不能算通过。
5. 有模型连接后，改用“Agent 对话”读取计划、调用工具、分析结果。

模型由管理员在 Internal 配置：OpenAI-compatible Chat Completions base URL（含 `/v1`）、明确的模型名、服务端凭据环境变量名。设置该环境变量后重启服务。**不把密钥填入 UI、任务、用例或浏览器字段。** 没有模型时测试工作流仍可用；Agent 明确显示受阻。

浏览器工具默认关闭。管理员逐项允许 `browser_open / browser_snapshot / browser_click / browser_fill` 并填写允许访问的 origin（包括所需资源域）。只在桌面 Runtime 可用；UI 点击、填写和导航逐动作确认，密码/验证码/支付字段不通过 Agent 填写。浏览器截图可能含业务数据，保存在该用户的本地工作目录；在证据项点击打开。

## 测试与打包

```powershell
npm run check
npm test
npm run package -- --dir
```

测试包含新 Runtime/API 和迁入的内核回归。临时产物位于 `.runtime/test-tmp`，避免把大文件放到系统盘。安装包签名、macOS notarization、真实模型网关和现网登录回归须在对应交付环境验证；本地单元测试不能代替这些证据。

## 独立部署

见 [运行与验收](docs/03-operations.md)。`.env` 不自动加载：可用 Node `--env-file` 或部署平台注入环境变量。Compose 提供独立 PostgreSQL、迁移任务和服务，不操作 Launcher。

```powershell
node --env-file=.env apps/server/index.mjs
docker compose --env-file .env -f deploy/compose.yaml up --build -d
```

## 当前边界

- 桌面本地 Mission 和 Internal Web Mission 是两个独立执行面，当前不自动同步历史。
- 一份 Runtime 一次执行一项 Mission；停止只取消 Agent 后续步骤，不自动撤销已提交测试或外部副作用。
- 重启后未完成任务变为 blocked，不自动重放待确认/已开始的动作。
- 首版保存执行历史，但尚无可编辑 DAG、工作流模板版本库、多模型调度、MCP 服务端、任意原生 OS 工具或 Hub 数据工具。
- 本地测试 Runner 仍通过迁入的 CLI 注册/运行，尚未在桌面里一键托管；浏览器操作 worker 已由桌面托管。
- 该版本采用单实例文件状态存储（Mission/策略）与可选 PostgreSQL（测试领域）。不能启用多副本共享同一状态目录。
- Launcher 测试中心的发布门禁接口保持原样；集成方案见 [Launcher 边界](docs/02-launcher-integration.md)，本次不自动改写在线注册记录。

历史项目保留以便比较；新产品不再运行时 import 它们。新测试领域代码的维护入口是 `packages/test-platform`。

本轮实际验证范围见 [0.1 验证记录](docs/04-verification.md)。
