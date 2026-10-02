# MX Rig

自动化测试工作台，外加一个能读证据、串流程的 Agent 中心。测试是第一个领域能力，不是 Runtime 的顶层模型。

**版本：0.8.0 Preview。** 提供独立 Electron 工作台、Internal 测试控制面、Agent 中心、声明式编排、质量报告、出网通道、流式输出与结构化结论，以及可选的 MCP 测试工具服务。

2026-09 这一轮新增：
- Rig 自有账号；
- 带引用与断言的浏览器航电、Electron 工位、人工接管、任务级预授权、视觉帧；
- 飞行计划（一句话起草 → 预检 → 架次 → 放行评审 → 讲评与通知）与探索路径导出 Playwright 脚本；
- 桌面一键托管本机执行机；
- 用量计量与上下文压缩；
- 乘组评测集；
- 原生桌面工位（macOS 预览）；
- compose 与 Kubernetes 两套部署。

standalone launcher 宿主适配不在当前范围（只改 mx-rig，见 [docs/12](docs/12-self-contained-rig-and-flight-model.md) §0）。

**试验规程**是 mx-rig 独有的测试工具：
- Agent 写：从对话起草用例，把走通的路径固化为规程；
- 机器跑：按原样重放，不经模型；
- 失败时修正：在失败的那一步由 Agent 提出修正，修正经重放证明后由人批准；
- 每次试车都记为所属应用的一次执行，进入质量报告。

**钩子**让 Rig 在事件发生时自己动手：
- 执行失败后，由只读的定级 Agent 自动给出结论，可以推送到通知渠道；
- 规程在全部试车中失败时，自动交给规程维护员提出修正，修正仍需人批准。

**定时回归**由服务端排程、由工位执行：
- 服务端只负责排队和记录，不开浏览器；
- 工位有三种：桌面端值守、测试机上的 `mx-rig station watch`、`scripts/manage.sh up --station` 起的容器；
- 工位领到一批规程后用自己的浏览器重放，按用例记为一次执行。

**终端 Agent `mx-rig`**：在项目目录里运行，用法和 Codex、Claude Code 一样。
- 内置「测试工程师」读代码、用项目自己的命令跑测试、解释失败、修测试或补测试；
- 每条命令、每次改文件都先给你看确切的命令或差异，确认后才执行；
- 同一个会话里还可以查平台上的计划和执行、打开允许的测试页面、起草用例、导出 Playwright 草稿、固化规程；
- 文件、命令和浏览器都在你的机器上，服务端只做模型网关、策略和记录；
- 确认过的命令在沙箱里跑：只能写项目、临时目录和工具缓存（macOS 与装了 bubblewrap 的 Linux）；
- 独立安装：`npm run pack:cli` 打出 tgz，成员 `npm install -g` 就能用，不需要这个仓库。

```bash
mx-rig login --server https://rig.internal && mx-rig init && mx-rig
```

**看得见的过程**：
- 任务页用对话展示 Agent 的工作过程，工具步骤折叠成一句话，截图有灯箱；
- 被自动化的页面上有 Agent 的光标：动手之前先移到目标、框出来、写上要做什么；
- 桌面端右侧实时显示被操作的页面，去了别的页面就在右下角以画中画显示；确认时实时页面会标出要操作的元素；
- 每一步都可以回放：光标在步骤之间移动，可以导出成一个自己会播放的 HTML 文件。

定位分析与使用方法见 [docs/13](docs/13-agent-client-and-test-procedures.md)；终端 Agent 见 [docs/14](docs/14-terminal-agent.md)；工作台、光标与回放见 [docs/15](docs/15-agent-workbench-and-replay.md)；在实时画面里接管见 [docs/16](docs/16-live-takeover.md)。

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
  evals/                    乘组评测集：固定场景（含规程修正）、评分与运行入口
  deploy/                   服务镜像、执行机镜像、Compose、Kubernetes 清单（deploy/k8s/internal）
  scripts/manage.sh         部署与运维入口：compose（up/down）与 Kubernetes（deploy/verify/…）
  docs/                     架构、Agent 中心、编排、指标、系统层、出网通道、运行与验收记录
```

不在 `mx-launcher/demos` 新建第二个 mx-rig，不新建 mx-rig-server 平级仓库。
Launcher 是平台基础设施，Rig 是独立产品。Internal 是部署/管理面，不是“全部业务都必须写入 Launcher 进程”。

## 本地启动

Node.js 22+。macOS、Linux 和 Windows 的 Git Bash 上，一条命令完成：装依赖、生成或询问配置、准备测试浏览器、后台启动。

```bash
bash scripts/manage.sh local init
```

打开打印出来的地址，账号 `admin`，密码用 `bash scripts/manage.sh local token` 查看。之后的常用命令：
- `local desktop`：打开桌面端，服务地址已经填好；
- `local status`：看服务、模型、测试浏览器的状态；
- `local down`：停止服务。

详见 [docs/18](docs/18-out-of-the-box-delivery.md)。

只想跑开发服务也可以用 `npm install && npm run dev`，密码在 `.runtime/dev-token`。两种方式默认都是内存模式：测试中心的数据在重启后清空，Mission 和策略会保留。

**账号不依赖任何其他系统的登录。** 管理员在完整测试管理台（`/test-center/`）的「成员」页新建 Rig 账号，一次性密码只显示一次；成员首次登录后在左下角「修改密码」。会话由 Rig 签发、服务端可吊销，默认 12 小时（`MX_RIG_SESSION_TTL_HOURS`）。配置 `MX_RIG_LAUNCHER_URL` 时 Launcher 账号也可以登录，这是可选的联邦来源。PostgreSQL 部署需先执行迁移 `019_local_accounts.sql`；内存模式下账号随进程重启清空。

桌面端另开终端：

```powershell
npm run desktop
```

测试浏览器不用另外安装：依次找安装包自带的、Playwright 缓存里的、下载过的、本机的 Chrome / Edge；都没有时自动下载，官方 CDN 不通就改用 npmmirror（`npm run browser:install` 也走这条路）。

桌面不要求 MX-H2I 运行；只要求能访问配置的 Rig 服务。非本机服务默认必须通过 HTTPS；内网测试服务器没有 TLS 时，在登录页勾选「内网测试服务器」，只放行私有网段的 IP，并提示连接未加密。桌面不会申请网络 lease，也不接管 VPN、DNS、PAC、NRPT 或已有网络 owner。需要私网连通性时，由管理员提供已有网络或后续明确注册的 Launcher 能力，而不是隐式依赖 MX-H2I 进程。

登录凭据只在主进程/worker 内存；renderer 不接收 bearer token。退出销毁当前 Runtime，本机历史按服务地址和用户分目录保存。浏览器使用临时独立 context，不读取用户浏览器登录态。

## 工作台

左侧顶部是**视角**：测试 / 开发 / 负责人。它只改变页面的排版顺序，不改变任何人的权限——同一份数据，按这个人打开时最想先看到的东西排列。

下面分四组：

- **工作台** — 总览（等你确认的动作、真实状态驱动的五步引导、通过率趋势、最近执行）、任务工作台（Agent 对话、测试工作流、一句话解析）、**系统**（教学任务、等级与版本更新）。
- **测试** — 质量报告（趋势、风险、覆盖，可复制成周报或打印）、测试中心（应用、用例目录、计划、执行与报告入口）、新手引导。
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

浏览器测试开箱即用（2026-10-01 起，见 [docs/17](docs/17-sites-and-page-behaviour.md)）：
- **工具**：新部署默认允许 `browser_open / browser_snapshot / browser_click / browser_fill / browser_select / browser_check / browser_press / browser_wait / browser_assert / browser_handoff` 和 `electron_launch`。已有部署在「Internal 配置」里点一下「开启浏览器测试」。
- **站点**：不用先填允许列表。Agent 第一次去某个站点时，确认框会说明这是新站点，确认后这项任务可以使用它。管理员列出的站点不用再问；也可以设置为「一律不打开」没有列出的站点。生产环境禁区始终拒绝。
- **页面自己的请求**：脚本、接口、内嵌的登录框和验证码框、WebSocket 都不受站点范围约束；只有标签页本身的跳转受约束。
- **页面自己做的事**：新标签页跟过去；confirm 按这一步的 `dialog` 回答，默认取消，并告诉 Agent；下载的文件存进证据；跳到范围外不跳转，并说明原因。

浏览器工具只在桌面 Runtime 和 `mx-rig` 终端可用。Agent 看到的是页面的可访问性快照，可操作元素带 `[ref=eN]` 引用；执行前核对引用仍指向同一个元素，页面变了就要求重新观察。点击、填写、选择、勾选、按键逐动作确认，密码/验证码/支付字段不通过 Agent 填写（在确认之前就拒绝），它们的值也会从发给模型的快照和证据截图里遮掉。`browser_assert` 做确定性检查，结果记录在任务上，未通过是测试事实而不是工具错误。每步截图与会话 trace（`trace.zip`）保存在该用户的本地工作目录，可能含业务数据；在证据项点击打开。

桌面端还有这些能力：
- **Electron 应用**：在「工具与边界」页登记本机的 Electron 应用，Agent 用 `electron_launch` 按 ID 启动，再用同一套浏览器工具操作。
- **人工接管**：执行中直接在「浏览器」页签的实时画面里操作页面（鼠标、键盘、输入法、粘贴、文件选择），操作完「交还给 Agent」，可以附一句话。Agent 碰到密码、验证码、扫码、支付时，会用 `browser_handoff` 请你来做。你输入的内容不记录，也不给模型。见 [docs/16](docs/16-live-takeover.md)。
- **任务级预授权**：管理员打开后，发起人可以为单个任务预授权浏览器写动作；只在这项任务已经可以使用的站点内，新站点总要问人，策略一变就失效，从不覆盖派发测试。
- **原生应用（macOS 预览）**：登记 `.app` 后，Agent 用 `native_*` 工具读控件树、点击、填写、断言；每次写动作都要确认。需要在系统设置里给 MX Rig 辅助功能权限；Windows 暂不支持。
- **视觉**：Provider 标记支持视觉时，最新一张截图会随下一轮送给模型。

**飞行计划**是分阶段的编排：预检（T-minus）→ 架次（派发并等待测试计划）→ 探索（Agent 走页面并断言）→ 放行评审（按失败数、通过率、断言等确定性标准判 Go/No-Go）→ 讲评（生成飞行报告，可推送飞书/企业微信/Webhook）。在编排中心写一句需求即可「起草飞行计划」：模型起草、服务端校验，人审阅后保存。任务里走过的浏览器路径可以导出为 Playwright 脚本草稿。

也可以直接跑一条编排：在「编排中心」选「有人接才派发」，填测试计划，它会先确认有在线执行机再进入派发确认——没有执行机就直接说清楚，不制造一条永远排队的 Run。编排支持分叉汇合（Web 与 Electron 各跑一条、都到齐再汇总）、把另一条编排整条嵌进来复用，以及给只读编排排一个 cron。

或者在任务工作台直接写一句话，例如「跑一下 Compass Electron 的登录验收」，点「解析成任务 ⌕」。解析**不调用模型**：它把句子对上你本来就能看到的计划、编排和 Agent，列出匹配到什么、还缺什么、会不会受阻，以及将要发出的请求体原文。确认之前什么都不会发生。缺计划就给下拉让你选，一条都对不上就直说，不硬凑。

Agent 中心的模型、边界与编排运行时语义见 [Agent 中心](docs/05-agent-center.md)（含"还差哪些环"的逐项对账：流式输出、结构化结论、重试告警、MCP、多 Agent 交接等）；编排怎么写、怎么校验见 [编排中心](docs/06-orchestration.md)；每个指标怎么算、不算什么见 [指标与汇报](docs/07-metrics-and-reporting.md)；系统教学层与一句话解析见 [系统层](docs/08-system-layer.md)；出网通道见 [出网通道](docs/09-egress-channels.md)。

指标有两条不肯让步的口径：**样本为零时不给比率**（显示 `—`，不显示 100%），**受阻既不算通过也不算失败**（环境没跑起来，它没告诉你产品好坏）。一周执行机全挂不会在报告上变成一条质量下滑的曲线。

## 测试与打包

```powershell
npm run check
npm test
npm run eval            # 乘组评测集（脚本模式）；--live 用真实模型，见 evals/README.md
npm run package -- --dir
```

给同事的安装包用 `bash scripts/manage.sh desktop --server <服务器地址> [--private-http]`：自带 Chromium，登录页已经填好地址；Mac 上没有证书时做 ad-hoc 签名，DMG 里附首次打开说明。见 [docs/18](docs/18-out-of-the-box-delivery.md)。

界面依赖 `@qpjoy/ui-design-neon-void`。`npm run design`（以及 `dev` / `desktop` / `package` 的 pre 脚本）把安装好的那份 CSS 同步到 `apps/web/vendor/`，桌面的 `file://` 与 Internal 的 HTTP 因此用同一个相对路径、同一个版本。该目录是生成物，不入库。工作台在 `style-src 'self'` 下运行，界面里没有任何内联样式或 HTML 字符串拼接。

测试包含新 Runtime/API 和迁入的内核回归。临时产物位于 `.runtime/test-tmp`，避免把大文件放到系统盘。安装包签名、macOS notarization、真实模型网关和现网登录回归须在对应交付环境验证；本地单元测试不能代替这些证据。

## 独立部署

同一个镜像，两套配方，都由 `scripts/manage.sh` 管理（详见 [运行与验收](docs/03-operations.md)）：

```bash
scripts/manage.sh up --lan --runner --station   # 任何一台机器：docker compose，首次运行自动生成密钥
scripts/manage.sh deploy              # Internal 的 Kubernetes 节点上：构建、导入、迁移、上线、验证
scripts/manage.sh desktop             # 在开发机上打包桌面端
```

- compose 适合本机和没有集群的测试服务器；Internal 已经跑着 Kubernetes，用 `deploy`，服务端执行的 Run 会派成 K8s Job。
- 两者都自带独立 PostgreSQL，先迁移再上线；不操作 Launcher，也不碰其他产品的命名空间或数据。

## 当前边界

- 桌面端的任务在桌面本地执行，每次保存后会同步一份去掉模型对话记录的副本到服务端。同步失败会自动重试，服务端太旧时自动停用同步。Web 工作台和质量报告能看到这些任务，但它们在 Web 上是只读的：确认、停止、继续都要回到执行它的桌面端完成。截图和 trace 只保存在那台电脑上。
- 一份 Runtime 一次执行一项 Mission；停止只取消 Agent 后续步骤，不自动撤销已提交测试或外部副作用。
- 执行中的任务如果所在进程停止，会变为 blocked（多副本部署时，由其他副本在心跳超时后标记），不会自动重放已经开始的动作。PostgreSQL 部署里，等待确认的服务端任务不占用进程，重启后依然可以确认；桌面端和 memory 模式下，重启后仍然变为 blocked。退出登录不会取消服务端任务。
- 编排可在界面里增删节点、改连线与参数、拖拽摆位，但节点**类型**由运行时提供：作者组合已知步骤，不能定义新的步骤实现。这是边界不是欠账——能在浏览器里改、对所有人生效的配置一旦变成任意执行逻辑，工具允许列表就没有意义了。
- 分叉汇合按顺序依次执行，不是并发；真正的并行来自测试平台那一侧的多台执行机。
- 只有能无人值守跑完的只读编排可以定时执行，且没有失败重试与告警。
- Agent 对话每步只执行一个工具调用（多余的调用不执行并告知模型）；参数错误、引用过期、元素不可操作这类可恢复错误回给模型重新决定，未知或未被允许的工具仍使任务停止。没有跨任务共享 checkpoint、任意原生 OS 工具或 Hub 数据工具。Agent 由 Rig 自己的 Runtime 执行，不依赖其他系统的 Agent；独立 MCP 服务端是可选的对外接口。
- 流式输出到工作台这一段是轮询（0.7 秒一次）而不是推送，所以是分块而不是逐字；上游网关必须支持 SSE，不支持就在 Provider 上关掉，行为回到整段返回。
- 结构化结论是可选的工具输出，不是强制的回答格式：Agent 可以只给文本，编排的 `analyze` 节点不提供工具因此没有结论卡。质量报告里有单独的「Agent 结论与页面断言」一栏，按结论类型和断言通过率统计，与测试通过率分开，不计入通过率；只读成员只看到计数。从 0.6 升级的部署需要管理员把 `finding_submit` 勾进允许列表。
- 系统层的任务目录是服务端内置数据，不能在界面里增删；标「界面上报」的任务由工作台报告，服务端无法独立验证，只记名称和时间。等级与经验不解锁任何权限。
- 出网通道只作用于 Rig 自己的模型调用与隔离浏览器：socks 通道不能用于模型（那一侧走 HTTP CONNECT），带凭据的通道不能用于浏览器（桌面是另一个进程，不接收服务端凭据）。
- 一句话解析只做一次匹配：不做多步计划、不改写参数、不记忆历史。
- 桌面端的「测试中心」可以一键把这台电脑注册为执行机并启动、停止、移除；执行机仍是平台自己的 `mxt-runner`。桌面上的 Agent 任务与测试 Run 使用各自的协议（任务本机优先、按版本同步；Run 走内核的认领与租约）。
- 原生桌面工位是 macOS 预览：只用模拟的系统调用和编译检查验证过，还没有对真实应用跑过；Windows UI Automation 未实现。
- 乘组评测集还没有用真实模型跑出基线；脚本模式只说明运行时和评分本身正常。
- 两套部署配方都在本机实测过：compose，以及 Docker Desktop 自带的 Kubernetes；Internal 服务器（containerd 镜像导入路径）尚未部署。
- `MX_RIG_STORE=postgres` 时，任务、策略、定时触发记录和教学进度都在数据库里，服务可以多副本运行：确认只执行一次，停止请求会传到执行任务的副本，失联副本名下的任务会被回收，测试计划的每次定时触发只产生一个 Run（见[运行与验收](docs/03-operations.md)）。memory 模式仍是单实例文件存储。服务端 Runtime 在进程内调用测试领域接口，不再经过 HTTP 回环，也不在内存里保存用户 token。
- Launcher 测试中心的发布门禁接口保持原样；集成方案见 [Launcher 边界](docs/02-launcher-integration.md)，本次不自动改写在线注册记录。

历史项目保留以便比较；新产品不再运行时 import 它们。新测试领域代码的维护入口是 `packages/test-platform`。

本轮实际验证范围见 [验证记录](docs/04-verification.md)。

2026-09-20 的代码走读、standalone 接入差距、Codex harness 对比与分阶段建议见 [实现评估](docs/10-implementation-review-and-codex-harness.md)；该文档是分析建议，不代表新增能力已交付。

2026-09-21 已增加独立 stdio MCP 工具入口、有界等待与可靠性修复。Codex 接入配置、权限、取消回执、数据库升级与验证范围见 [工具接口与可靠性改进](docs/11-tool-interface-and-reliability.md)。测试平台继续管理执行与证据，MCP 可供外部 Agent 调用；无需在 Rig 配置模型。

2026-09-25 起的目标设计与实现记录见 [自成一体的试车台与飞行任务模型](docs/12-self-contained-rig-and-flight-model.md)：只改 mx-rig、不依赖 MX-H2I 登录、不依赖其他系统的 Agent。§6 逐项记录已实现的内容与验证范围（账号、航电、PostgreSQL 控制面、桌面同步、飞行计划、Pad、用量与压缩、原生工位、评测集、部署），§7 是路线状态。
