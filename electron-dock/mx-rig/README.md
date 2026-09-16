# MX Rig

自动化测试工作台，外加一个能读证据、串流程的 Agent 中心。测试是第一个领域能力，不是 Runtime 的顶层模型。

**版本：0.7 Preview。** 在 0.1 的独立 Electron 工作台、本地子进程 Runtime、Internal 服务与逐动作确认之上加入：LangGraph 形状的自建编排运行时（状态通道、条件边、分叉汇合、暂停点、checkpoint）、Agent 中心（Provider 调用序列、六个可编辑可观测的内置 Agent、工具边界、出网观测）、**可视化编排中心**（七种节点的声明式编排、子编排内联、拖拽摆位、只读编排定时执行；存进去之前一定能编译）、15 个工具（测试领域、浏览器、结论）与 zod 严格校验的接口层，统一到 Neon Void 的工作台界面，**质量报告**（通过率趋势、不稳定用例、覆盖缺口、风险清单，可复制成周报或打印）与按角色排版的视角，**系统**（随版本更新的教学任务层：26 项任务、五章主线加一条支线、常驻面板，完成判定读平台真实状态）、**对话式下任务**（一句话解析成候选派发，不调用模型，确认后才执行）、**出网通道**（为 Rig 自己的模型调用与隔离浏览器指定代理，可实时切换），以及本轮的两件事：**流式输出**（上游 SSE → 服务端 NDJSON → 任务记录 → 工作台渲染，草稿在回答到达时清空）与**结构化结论**（`finding_submit`：结论类型、置信度、依据受 schema 约束，引用的 run/用例 ID 与本次任务真的读到过的证据比对）。不是完整的 Codex 替代品，也不声称支持任意操作系统自动化。

## 一个产品目录

```text
electron-dock/mx-rig/
  apps/desktop/             Electron 主进程、受限 preload、打包配置
  apps/web/                 桌面与 Internal 共用工作台 UI（Neon Void 设计系统）
  apps/server/              Internal 身份适配、配置、Agent 预设、模型网关、出网通道与系统教学层
  packages/graph/           自建的 StateGraph 运行时：通道、reducer、条件边、interrupt、编排规格
  packages/runtime/         任务图、工具注册表、状态存储与本地 worker
  packages/contracts/       标识、URL 与工具输入校验
  packages/test-platform/   从旧框架迁入的完整测试领域内核
  test-packs/               QA 用例包，当前为 Compass Electron
  deploy/                   独立服务镜像与 Compose
  docs/                     架构、Agent 中心、编排、指标、系统层、出网通道、运行与验收记录
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

## 工作台

左侧顶部是**视角**：测试 / 开发 / 负责人。它只改变页面的排版顺序，不改变任何人的权限——同一份数据，按这个人打开时最想先看到的东西排列。

下面分四组：

- **工作台** — 总览（等你确认的动作、真实状态驱动的五步引导、通过率趋势、最近执行）、任务工作台（Agent 对话、测试工作流、一句话解析）、**系统**（教学任务、等级与版本更新）。
- **测试** — 质量报告（趋势、风险、覆盖，可复制成周报或打印）、测试中心（应用、计划、执行与报告入口）、新手引导。
- **Agent 中心** — Agent 市场、模型 Provider、编排中心（可视化编辑）、工具与边界、出网与通道。
- **管理** — Internal 配置（策略、Provider、Agent，仅管理员）。

完整的测试资产管理（用例目录、执行机、成员、实时执行流）仍在同 origin 的 `/test-center/`，右上角一键打开。

## 第一条任务

最省事的走法是打开左侧的**「系统」**：它把下面这几步拆成带步骤的任务，每一项的完成判定读的是平台真实状态（有没有应用、有没有在线执行机、你自己有没有确认过一次写动作），点「前往」直接跳到该去的页面。右上角「⬢ 系统」可以把它变成常驻面板跟着你翻页。版本更新时新增的任务会标「新」，不用重读文档。

手动走一遍也是这些：

1. 在完整测试管理台接入项目、用例、Suite 和 Task。继承的“接入 / 对齐 Compass”入口可复用，一次就能建好 Compass Web（cypress，functional + demo 双轨）与 Compass Electron（playwright-electron）两条线；登记不会自动运行测试。
2. 回到 Rig 的测试中心，在某个计划上点“创建测试工作流”。
3. 核对 `tests_run` 参数并确认。Rig 返回真实测试 Run ID；派发完成不等于测试通过。右侧编排图会高亮这项任务真实走过的节点。
4. 在测试管理台检查 Runner、结果、JUnit、录像和报告。未连接 Runner 时显示等待执行机，不能算通过。
5. 有模型连接后，在 Agent 市场选一个 Agent（例如“结果分析师”“失败定级员”），让它读证据、调用工具、给出带依据的判断。回复会边生成边显示；定级类 Agent 还会提交一张结构化结论卡（结论类型、置信度、依据），卡上每个被引用的 ID 都标明本次任务是否真的读到过它——标「未读到」的要人工复核。

模型由管理员在 Internal 配置：一到八个 OpenAI-compatible Provider（Chat Completions base URL 含 `/v1`、明确的模型名、服务端凭据环境变量名），列表顺序即调用顺序，上一个失败才试下一个。设置对应环境变量后重启服务。**不把密钥填入 UI、任务、用例或浏览器字段。** 没有模型时测试工作流仍可用；Agent 明确显示受阻。

出网只影响 Rig 自己的两种请求：服务端的模型调用，和桌面 Runtime 打开的隔离浏览器。管理员可以在「出网与通道」里登记通道（`scheme://host:port`，凭据用环境变量名登记）并**实时切换**——下一次模型调用立即生效，隔离浏览器在下一次打开页面时重开。切换会产生新的策略版本，因此已经发出的待确认动作失效，需要重新发起。这一页的上半部分始终是真实环境观测，启用通道也不会被改写；MX Rig 不设置系统代理、路由、DNS、PAC 或 NRPT，也不接管其他应用的网络归属。

浏览器工具默认关闭。管理员逐项允许 `browser_open / browser_snapshot / browser_click / browser_fill` 并填写允许访问的 origin（包括所需资源域）。只在桌面 Runtime 可用；UI 点击、填写和导航逐动作确认，密码/验证码/支付字段不通过 Agent 填写。浏览器截图可能含业务数据，保存在该用户的本地工作目录；在证据项点击打开。

也可以直接跑一条编排：在「编排中心」选「有人接才派发」，填测试计划，它会先确认有在线执行机再进入派发确认——没有执行机就直接说清楚，不制造一条永远排队的 Run。编排支持分叉汇合（Web 与 Electron 各跑一条、都到齐再汇总）、把另一条编排整条嵌进来复用，以及给只读编排排一个 cron。

或者在任务工作台直接写一句话，例如「跑一下 Compass Electron 的登录验收」，点「解析成任务 ⌕」。解析**不调用模型**：它把句子对上你本来就能看到的计划、编排和 Agent，列出匹配到什么、还缺什么、会不会受阻，以及将要发出的请求体原文。确认之前什么都不会发生。缺计划就给下拉让你选，一条都对不上就直说，不硬凑。

Agent 中心的模型、边界与编排运行时语义见 [Agent 中心](docs/05-agent-center.md)（含"还差哪些环"的逐项对账：流式输出、结构化结论、重试告警、MCP、多 Agent 交接等）；编排怎么写、怎么校验见 [编排中心](docs/06-orchestration.md)；每个指标怎么算、不算什么见 [指标与汇报](docs/07-metrics-and-reporting.md)；系统教学层与一句话解析见 [系统层](docs/08-system-layer.md)；出网通道见 [出网通道](docs/09-egress-channels.md)。

指标有两条不肯让步的口径：**样本为零时不给比率**（显示 `—`，不显示 100%），**受阻既不算通过也不算失败**（环境没跑起来，它没告诉你产品好坏）。一周执行机全挂不会在报告上变成一条质量下滑的曲线。

## 测试与打包

```powershell
npm run check
npm test
npm run package -- --dir
```

界面依赖 `@qpjoy/ui-design-neon-void`。`npm run design`（以及 `dev` / `desktop` / `package` 的 pre 脚本）把安装好的那份 CSS 同步到 `apps/web/vendor/`，桌面的 `file://` 与 Internal 的 HTTP 因此用同一个相对路径、同一个版本。该目录是生成物，不入库。工作台在 `style-src 'self'` 下运行，界面里没有任何内联样式或 HTML 字符串拼接。

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
- 编排可在界面里增删节点、改连线与参数、拖拽摆位，但节点**类型**由运行时提供：作者组合已知步骤，不能定义新的步骤实现。这是边界不是欠账——能在浏览器里改、对所有人生效的配置一旦变成任意执行逻辑，工具允许列表就没有意义了。
- 分叉汇合按顺序依次执行，不是并发；真正的并行来自测试平台那一侧的多台执行机。
- 只有能无人值守跑完的只读编排可以定时执行，且没有失败重试与告警。
- Agent 对话每步只允许一个工具调用；没有跨任务共享 checkpoint、MCP 服务端、任意原生 OS 工具或 Hub 数据工具。
- 流式输出到工作台这一段是轮询（0.7 秒一次）而不是推送，所以是分块而不是逐字；上游网关必须支持 SSE，不支持就在 Provider 上关掉，行为回到整段返回。
- 结构化结论是可选的工具输出，不是强制的回答格式：Agent 可以只给文本，编排的 `analyze` 节点不提供工具因此没有结论卡。结论只存在任务记录里，**还没有进入质量报告**，不能按结论类型统计。从 0.6 升级的部署需要管理员把 `finding_submit` 勾进允许列表。
- 系统层的任务目录是服务端内置数据，不能在界面里增删；标「界面上报」的任务由工作台报告，服务端无法独立验证，只记名称和时间。等级与经验不解锁任何权限。
- 出网通道只作用于 Rig 自己的模型调用与隔离浏览器：socks 通道不能用于模型（那一侧走 HTTP CONNECT），带凭据的通道不能用于浏览器（桌面是另一个进程，不接收服务端凭据）。
- 一句话解析只做一次匹配：不做多步计划、不改写参数、不记忆历史。
- 本地测试 Runner 仍通过迁入的 CLI 注册/运行，尚未在桌面里一键托管；浏览器操作 worker 已由桌面托管。
- 该版本采用单实例文件状态存储（Mission/策略）与可选 PostgreSQL（测试领域）。不能启用多副本共享同一状态目录。
- Launcher 测试中心的发布门禁接口保持原样；集成方案见 [Launcher 边界](docs/02-launcher-integration.md)，本次不自动改写在线注册记录。

历史项目保留以便比较；新产品不再运行时 import 它们。新测试领域代码的维护入口是 `packages/test-platform`。

本轮实际验证范围见 [验证记录](docs/04-verification.md)。
