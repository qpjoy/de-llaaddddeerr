# 验证记录

## 2026-10-16：Internal 集群部署时服务端反复崩溃（镜像里缺 test-packs）

- **现象**：`scripts/manage.sh deploy` 报 `deployment "mx-rig-server" exceeded its progress deadline`，Pod 处于 `CrashLoopBackOff`。日志显示启动时找不到 `/app/mx-rig/test-packs/compass/rig-specs/electron/case-catalog.electron.json`。
- **原因**：M5 起，内核在加载时读取验收包里的罗盘用例目录（`onboarding/compass.mjs`），从验收包创建项目也要读 `test-packs/`；但服务端镜像从来没有复制这个目录。本机和测试都直接在仓库里运行，所以一直没暴露。
- **修复**：`deploy/Dockerfile` 加上 `COPY mx-rig/test-packs ./test-packs`，约 240 KB，`node_modules` 已被构建上下文排除。
- **防回归**：新增 `tests/server-image.test.mjs`。它从 `apps/server/index.mjs` 出发，沿相对路径的 import 和 `new URL(…, import.meta.url)` 读取的文件走一遍，检查每一个都在 Dockerfile 复制的目录里。去掉这行 COPY 时，测试失败并指出缺的就是这个文件。
- 在本机用和容器相同的方式启动服务端（生产模式、设置 Launcher 地址），`/readyz` 和新接口返回 200。镜像要在 Internal 节点上重新构建部署才能验证。

## 2026-10-16：桌面端 Launcher 独立端 P1（自己的产品网络、统一账号、登记命令）

- `npm run check` 通过：仓库自检只允许 `apps/desktop/launcher-network.mjs` 一个文件带数据面代码。
- `npm test`：698 项，674 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/l1-tests.log`。新增：
  - `tests/launcher-network.test.mjs`（7 项）；
  - `tests/launcher-register.test.mjs`（3 项）。
- `npm run test:desktop`：新增 Launcher 模式启动（本地替身入口，走到「未登记」为止，不装 WireGuard）。截图在 `.runtime/qa/desktop-launcher-login.png`。
- `npm run test:browser` 通过。
- 修了一处冒烟和测试里的定位：登录页多了网络面板的按钮，改为只点提交按钮（四个地方）。
- `npm run package -- --dir --launcher`：WireGuard 引擎、SDK、Launcher 默认配置都在应用里。
- 真实 Launcher 上的连接还没有验证：要先登记，在装着 MX-H2I 的测试机上做，步骤见 [docs/25 §7](25-launcher-product-and-sso.md)。

## 2026-10-08：M8c 演示录像（发版时录制、发布、新手引导里播放）

- `npm run check` 通过。
- `npm test`：688 项，664 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m8c-tests.log`。新增 `tests/tour-videos.test.mjs`。
- `npm run test:browser`、`npm run test:desktop` 通过，新增内容：
  - 发布一段录像后，网页端和桌面端的新手引导都能播放：网页端从服务地址取，桌面端通过 `rig-media:` 取。
  - 日志在 `.runtime/m8c-browser.log` 和 `m8c-desktop.log`。
- `npm run record:tours`：三段录像分别是 20 秒、44 秒和 20 秒，合计 9 MB；中间那次真实执行通过。日志在 `.runtime/m8c-record.log`。
- 逐帧检查录像，发现并修了两处：面板里出现文字「null」（M8a 起就有），以及画面灰边。
- 详见 [docs/24 §9](24-guided-tours.md)。

## 2026-10-08：M8b 新项目关卡、内置试验场、关卡接入系统任务

- `npm run check` 通过。
- `npm test`：684 项，660 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m8b-tests.log`。
- `npm run test:desktop`：
  - 跟着「新项目」关卡走完 23 步：试验场在本机启动，计划指向它，停在执行之前；
  - 跟做走完罗盘关卡后，「跟着演示亲手走一遍」可以领取。
  - 日志在 `.runtime/m8b-desktop.log`。
- `npm run test:browser`：
  - 任务卡片上的「演示一遍」打开网页端能走的关卡；
  - 用「快速准备」走完不算完成任务。
  - 日志在 `.runtime/m8b-browser.log`。
- 关卡之后的正式流程：同一条用例和实现，在带缺陷的试验场上真跑一次，通过（8 秒，带录像）。
- 修了 M8a 留下的问题：冒烟脚本最后一行的英文撇号造成语法错误。是在最后一次冒烟之后改的那一行，没有重新检查。
- 详见 [docs/24 §8](24-guided-tours.md)。

## 2026-10-08：M8a 演示一遍（可自动化的教学关卡）

- `npm run check` 通过。
- `npm test`：681 项，657 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m8a-tests.log`。新增 `tests/tours.test.mjs`。
- `npm run test:desktop`：
  - 罗盘项目改为跟着关卡建立，冒烟脚本扮演用户；
  - 「读懂一次执行」用演示速度走：接手、继续，停在最后一步。
  - 日志在 `.runtime/m8a-desktop.log`，截图在 `.runtime/qa/desktop-tour-compass.png` 和 `desktop-tour-read.png`。
- `npm run test:browser`：
  - 网页端说明罗盘关卡要在桌面端进行；
  - 「读懂一次执行」用快速准备走完。
  - 日志在 `.runtime/m8a-browser.log`。
- 截图里发现两个问题并修掉：系统面板挡住目标；页面重画后目标滚出屏幕。冒烟脚本现在检查目标在屏幕内。
- 修了两处原有的冒烟竞态：密钥表单和「已合入本机主线」。
- 详见 [docs/24 §7](24-guided-tours.md)。

## 2026-10-06：M7b 团队执行机跑已发布版本、M7c 上线检查与 Agent 分析、测试版本存储

- `npm run check` 通过。
- `npm test`：678 项，654 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m7c-tests.log`。新增：
  - 测试版本存成文件；完整版本到达后，之前的增量删除；单个项目的上限；不挤占磁盘保留区；
  - 执行机只能凭自己正在进行的执行读取版本；
  - 发布检查逐个看两次发布之间的每个提交：提交后又删掉的录像和大文件照样拦下；
  - 内核的已发布版本执行方式。
- 端到端：一台没有任何测试仓库的“团队工位”执行机跑已发布的 `rig/v1`，两条用例通过，执行记录里是 `rig/v1` 和提交号。
- `npm run test:desktop` 新增：原分支前进后「上线检查」把基准更新到最新提交，并打开「全部用例」计划的这次执行。执行在被领取前取消，没有真正运行罗盘用例。日志在 `.runtime/m7c-desktop.log`。
  - 修了冒烟脚本里的一处竞态：提示先出现、页面后重画，脚本拿到的是旧节点。
- `npm run test:browser` 新增：执行详情「让 Agent 分析这次执行」跳到测试任务，草稿里有执行编号和“能不能上线”，选的是失败定级员，没有自动开始。日志在 `.runtime/m7c-browser.log`。
- 存储实测：`node scripts/measure-test-versions.mjs`。200 个版本、50 个测试文件、300 条用例，服务器上占 298 KB（不清理是 3.3 MB）。详见 [docs/23 §7](23-test-repository.md)。

## 2026-10-06：M7 测试仓库（本机版本、验证、发布与同步）

- `npm run check` 通过。
- `npm test`：672 项，648 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m7-tests.log`。
  - 有一次全量运行时，传感器评测（`proving-ground.test`）在高负载下超时失败，单独运行和再次全量运行都通过。它本来就对时间敏感。
- 端到端（试验场 + 本机执行机 + `npx playwright test`）：
  - 缺陷版：002 失败，即缺陷 PG-003；
  - 修复版：通过；
  - 用失败的执行发布被拒绝，用通过的执行发布成 v1；
  - 另一台电脑同步后主线跟上。
- `npm run test:desktop`：界面上完成写入、执行、验证、合入和发布 v1。截图在 `.runtime/qa/desktop-repository-task.png`、`desktop-repository.png`。
- `npm run test:browser`：网页端只读显示服务器版本。
- 详见 [docs/23 §5](23-test-repository.md)。

## 2026-10-06：整合旧管理台 M6（旧管理台只读、新手引导、审计、安装包）与流程修复

- `npm run check` 通过。
- `npm test`：662 项，638 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m6-tests.log`。
- 新增 `tests/project-model.test.mjs`；内核计划审计用现有测试覆盖，`api.test`、`audit.test`、`packs.test` 都通过。
- `npm run test:browser`：
  - 定时前先验证：新计划不能定时，验证通过后可以；
  - 上手清单；
  - 审计里的定时改动；
  - 登记安装包；
  - 旧管理台只读。
  - 截图在 `.runtime/qa/web-plans.png`、`web-audit.png`、`web-legacy-readonly.png`。
- `npm run test:desktop` 通过。
- 走查结论见 [docs/22](22-flow-review.md)，记录详见 [docs/21 §6.7](21-test-center-consolidation.md)。

## 2026-10-06：整合旧管理台 M5（罗盘验收包、源码快照与 QA 仓库）

- `npm run check` 通过。
- `npm test`：658 项，634 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m5-tests.log`。
- 新增测试：
  - `tests/project-workspace.test.mjs`；
  - `tests/compass-pack.test.mjs`；
  - 内核 `packs.test.mjs`。
- 对真实 hdo_v2（`feat/yjj/hdo_v2@a4cc5de`）的端到端运行：
  - 主路径冒烟 10/10 通过；
  - 全部用例 10 通过、1 失败。失败的 `CPS-WEB-STRAT-003` 是产品问题：平台列表接口失败时，策略列表不加载；
  - 原仓库的 HEAD、引用和 status 前后一致。
- `npm run test:browser`：网页端从验收包登记项目，用例库显示 23 条参考用例。截图在 `.runtime/qa/web-pack.png`。
- `npm run test:desktop`：桌面端选目录建立工作区，计划指定在本机执行机上；更新基准后保留旧快照。截图在 `.runtime/qa/desktop-pack-workspace.png`。
- 桌面端罗盘启动冒烟**没有运行**：它会初始化 Launcher 和网络，不能在有 MX-H2I 的本机上跑。只核对了它依赖的选择器。
- 详见 [docs/21 §6.6](21-test-center-consolidation.md)。

## 2026-10-05：整合旧管理台 M4（统一的执行详情）

- `npm run check` 通过。
- `npm test`：640 项，616 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m4-tests.log`。
- 新增测试：
  - `tests/run-detail.test.mjs`；
  - 内核 `events.test.mjs` 里的 `/progress` 用例。
- `npm run test:browser`：扮演执行机跑完一次执行（真实录制的 webm）。页面依次显示：等待认领 → 实时流水与用例 → 结果、录像按步骤跳转、筛选 → 只重跑这条 → 取消 → 返回。截图在 `.runtime/qa/web-run-live.png`、`web-run-detail.png`。
- `npm run test:desktop`：时间线经主进程轮询；录像经 `rig-media:` 播放并跳转，非录像文件被拒绝；对外版报告在应用内打开并保存为 PDF。截图在 `.runtime/qa/desktop-run-detail.png`。
- **实测中发现并修复**：
  - 流水下面多出 “null”；
  - 跑完的执行仍显示“进行中”的段；
  - 步骤时间只精确到秒；
  - 全局执行记录表的列宽。
- 详见 [docs/21 §6.5](21-test-center-consolidation.md)。

## 2026-10-05：整合旧管理台 M3（执行计划；桌面端去掉旧管理台）

- `npm run check` 通过。
- `npm test`：632 项，608 通过，0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m3-tests.log`。
- `npm run test:browser`：执行计划的完整生命周期，以及任务内当场新建计划，都通过。截图在 `.runtime/qa/web-plans.png`、`web-inline-plan.png`。
- `npm run test:desktop`：经主进程管理计划通过；桌面端没有旧管理台入口，打开 `/test-center/` 被拒绝。
- **实测中发现并修复**：
  - 卡片里的操作按钮被挤成一个字一行，长说明溢出卡片；
  - 服务端提示仍指向旧的“执行机”页面；
  - smoke 脚本里的变量名冲突。
- 详见 [docs/21 §6.4](21-test-center-consolidation.md)。

## 2026-10-05：整合旧管理台 M2（项目设置、用例库、提升到用例库、通知渠道）

- `npm run check` 通过。
- `npm test`：全量 0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m2-tests.log`。
- 新增测试 `tests/case-promotion.test.mjs`。
- `npm run test:browser`：网页端执行方式、密钥、用例库、提升、通知渠道、删除项目的完整流程通过。截图在 `.runtime/qa/web-project-settings.png`、`web-promote.png`。
- `npm run test:desktop`：经主进程完成同样的操作（含 PUT），越界路径被拒绝。
- **实测中发现并修复**：
  - smoke 服务没有配置加密密钥，暴露出提示里写的还是旧项目的变量名和 `.env.internal`，已改成 Rig 的说法；
  - 用 API 建的任务需要先刷新页面才会出现在列表里（smoke 脚本已补上刷新）；
  - 已确认的用例按钮仍写着“确认本次用例”；
  - 一行表单末尾的按钮会折成两行。
- 详见 [docs/21 §6.3](21-test-center-consolidation.md)。

## 2026-10-05：整合旧管理台 M1（账号与成员、执行机与工位）

- `npm run check` 通过。
- `npm test`：全量 0 失败；24 项 PostgreSQL 测试跳过。日志在 `.runtime/m1-tests.log`。
- 新增测试 `tests/client.test.mjs`：桌面客户端的 PATCH、DELETE、204 处理，以及 4xx 原因透传。
- `npm run test:browser`：网页端账号与执行机的完整流程通过。截图在 `.runtime/qa/web-members-created.png`、`web-runners-enroll.png`。
- `npm run test:desktop`：经主进程管理账号、接入码、移除执行机通过。截图在 `.runtime/qa/desktop-runners.png`。
- **实测中发现并修复**：
  - id 冲突；
  - 导航分组展开状态与轮询重绘的竞争；
  - smoke 脚本登录后立即判断导航的竞争；
  - 规程页测试写死旧分组。
- 详见 [docs/21 §6.2](21-test-center-consolidation.md)。

## 2026-10-05：整合旧管理台 M0（导航、用语、项目页签、桌面端内看报告）

- `npm run check`：217 个模块通过。
- `npm test`：627 项，603 通过，0 失败；24 项 PostgreSQL 测试跳过（没有设置 `MX_RIG_TEST_DATABASE_URL`）。日志在 `.runtime/m0-tests.log`。
- `npm run test:browser`：通过。
- `npm run test:desktop`：通过。新增一步：真实派发后在桌面端打开执行报告。核对了：报告带登录态渲染、颜色变量已加载、报告窗口里请求其他接口被拦截。截图在 `.runtime/qa/desktop-report-window.png`。
- 新增测试 `tests/report-window.test.mjs`：报告窗口只给本次执行的报告和产物加凭据；其他执行、其他接口、其他站点、写请求和路径技巧都被拒绝；样式文件和它导入的 tokens 放行。
- 本机服务 UI 核对（无头浏览器，管理员密码只经环境变量传入）：项目页签、执行计划卡片、全局执行记录页。截图在 `.runtime/m0-ui/`。
- **实测中发现并修复**：
  - 报告样式 `neon-void.css` 会 `@import ./tokens.css`，报告窗口没有放行，页面颜色全失；
  - “项目与任务”的副标题含“执行记录”四个字，和新页面名冲突，界面和 smoke 脚本都会认错；
  - `views.js` 里有两个同名常量 `RUNS_ON`；
  - 规程试车记录的“执行记录”按钮原本指向无效地址。
- 详见 [docs/21 §6.1](21-test-center-consolidation.md)。

## 2026-10-05：试验场 v1 与传感器（自动检查项）

环境：macOS 14.4.1（Apple 芯片）、Node 22.21.1、Playwright 1.58.2 / Chromium 145.0.7632.6，无头模式。

- `npm run check`：215 个模块通过。
- `npm test`：624 项，600 通过，0 失败；24 项跳过，原因都是没有设置 `MX_RIG_TEST_DATABASE_URL`，跳过的是 PostgreSQL 多副本测试。日志在 `.runtime/sensors-full-tests.log`。
- 新增测试：
  - `tests/sensors.test.mjs`（8 项）：
    - 脱敏，URL 只留路径，令牌只报参数名；
    - 按签名去重计数；
    - 站点范围外被拦下的请求、导航取消、关闭之后的事件都不算页面失败；
    - 不应答的页面跳过，不等待；
    - 服务端 schema 接收新字段，老版本服务端拒收后去掉新字段重报；
    - 回放帧带上信号。
  - `tests/proving-ground.test.mjs`（4 项）：
    - 缺陷开关；
    - 服务的页面与鉴权；
    - 两个版本的完整评测；
    - Agent 步骤携带信号，包括对“无效点击”的回归测试。
- **评测**：`evals/sensors.mjs`，卡死阈值取 2 秒。夹具结果，不是产品质量：

| 项目 | 结果 |
| --- | --- |
| 传感器负责的缺陷（10 个） | 全部检出 |
| 断言负责的缺陷（2 个） | 有缺陷版本判失败、修复版判通过 |
| 修复版误报 | 0 条 |
| 修复版未通过的规程 | 0 条 |
| 无法对应到已知缺陷的线索 | 0 条 |
| 断言全部通过、但传感器报警的规程 | 5 条：login、list-filter、item-detail、reports、settings-english |

  一次完整评测约 35 秒。
- **Agent 路径实测**：用 `BrowserTools.execute` 按 Agent 的方式在有缺陷版本上走 11 步，读到 6 类信号：URL 中的令牌、内容泄漏、无效点击、控制台报错、慢接口、加载卡死（这条路线没有走到会白屏和接口 500 的页面）。然后导出回放 HTML，在内置浏览器里核对：
  - “自动检查项”轨道按严重度着色，当前步骤带外框；
  - 当前步骤的线索列表正确；
  - 步骤列表上有计数徽标。
- **实测中发现并修复**：Agent 点击前会截一张带遮罩的意图图，Playwright 截图时临时插入的 `x-pw-glass` 节点被算成“页面有反应”，导致“无效点击”在 Agent 路径上漏报；规程路径没有这个问题。已排除工具自身的节点，并补了回归测试。
- **没有做**：
  - 没有在桌面端界面和 `mx-rig` 终端这两个正式入口对试验场实测；
  - 没有在 Electron 应用上实测传感器；
  - 没有在 Windows 和 Linux 上运行；
  - 没有用真实被测系统做误报评估；
  - 信号还没有进入内核 Run 与质量报告。
- 详见 [docs/20](20-blueprint.md) §12 与 [试验场说明](../test-packs/proving-ground/README.md)。

## 2026-10-02：本机一键体验、自带测试浏览器、写好服务器地址的安装包

- `npm run check`：189 个模块通过。
- `npm test`：566 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。整套连跑两次都通过，每次约 55 秒。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`：11 个场景全部通过。
- `npm run test:browser`：通过。
- `npm run test:desktop -- --browser`：
  - 登录页一打开就是安装包写好的地址；
  - 测试浏览器无需安装；
  - 退出后记住了地址和账号，没有记住密码。
- 新增测试：
  - `tests/browser-provision.test.mjs`：查找顺序、镜像回退、只下载一次、失败原因；
  - `tests/first-run.test.mjs`：隔离标记和临时副本的判断、命令转义；
  - `tests/local-script.test.mjs`：按行输入的答案、0600、生成的密码不打印、`up` / `status` / `token` / `down` 全流程。
- **安装包实测（Apple 芯片）**：
  - `--dir` 和 DMG 都打出来了；签名校验通过；DMG 262 MB，里面有「首次打开说明.txt」；
  - 用 Playwright 启动打包后的应用：登录页是写好的地址；登录后使用的是安装包自带的 Chromium 145，页面零报错。
- **实际下载**：只走 npmmirror，下载、解压、启动 Chromium 全部成功，用了 29 分钟。
- **本机一键体验实测**：在这台 Mac 上分别用按行输入和 `--yes` 跑了 `local init`、`up`、`status`、`logs`、`down`、`reset`。
- 实测中发现并修复：
  - **Mac 安装包以前从没运行过**：签名在打包后失效，Apple 芯片直接杀掉子进程；启动时往 app.asar 里写设计资源，弹出「MX Rig 启动失败：ENOTDIR」。
  - 这一轮新引入的问题：安装包里的 `playwright-core` 在嵌套目录下，导致登录失败。
  - 每个问题一个 readline 的写法，会丢掉按行预先输入的答案（数据库和模型的问题被跳过了）。
  - 打包时写下的服务器地址留在了源码目录里，会影响之后从源码运行的桌面端。
- 没有做：Linux 和 Windows 的 Git Bash 实测；从浏览器下载 DMG 后第一次打开的真实流程。
- 详见 [docs/18](18-out-of-the-box-delivery.md)。

## 2026-10-01：开箱即用的站点范围、页面自己的行为、接管放宽

- `npm run check`：183 个模块通过。
- `npm test`：557 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。整套连跑两次都通过，每次约 55 秒。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`：11 个场景全部通过。
- `npm run test:browser`：通过。
- 新增测试：
  - `tests/sites.test.mjs`，6 项，真实 Chromium，四个主机名扮演四个站点：
    - 站点判定；
    - 页面的跨站脚本、接口、WebSocket；
    - 生产禁区连图片都不放行；
    - 跳到范围外、新标签页、确认框、下载；
    - 「一律不打开」模式；
    - 接管时去别的站点、在面板上回答对话框、复制；
    - 一项完整任务里的两次站点确认，以及一次接管时由人打开的站点；
    - 规程带着 `dialog` 和自己的站点重放。
  - `tests/takeover.test.mjs`：拖动滑块；原生应用的交接。
  - `tests/browser-avionics.test.mjs`：真实 Electron 应用的窗口被接管，包括 confirm。
  - `tests/procedure.test.mjs`：规程带着自己的站点、生产禁区、「一律不打开」。
- 改了的断言：
  - 工具目录里 `browser_click` 现在默认允许；
  - 页面检查员开箱即可用；
  - 接管计数多了对话框、复制、下载三项。
- `npm run test:desktop -- --browser`（Electron + 真实 Chromium）新增：
  - 一键开启浏览器测试并保存；
  - 确认框里的新站点提示；
  - 接管时在面板上回答 confirm；
  - 交还计数「点击 2 次、输入 1 段文字、按键 1 次、回答了 1 个对话框」。
  - 截图：`.runtime/qa/desktop-site.png`、`desktop-dialog.png`。
- 实测中发现并修复：
  - **设置页的「重新绘制」一直是坏的**：它画进了一个已经被搬空的 DocumentFragment。Provider 的「上移」「删除」「＋ 新增 Provider」点了之后页面不变。
  - 冒烟测试里接管面板和确认框各有一套交还按钮。现在有实时画面时，附言只在面板上问。
  - 被 Chromium 拦下的跳转会留下一个错误页；现在退回到原来的页面。
  - 新标签页还没加载完时，结果里的截图拍的是空白页；现在等它加载完。
- 一次未复现的失败：第一次整套运行时，`procedure-loop` 测试里 Chromium 启动卡满了 180 秒的超时。单独运行和之后连续三次整套运行都通过，每次整套约 55 秒。
- 详见 [docs/17](17-sites-and-page-behaviour.md)。

## 2026-09-30（第四轮）：在实时画面里接管、Agent 请人来操作、快照里的密码

- `npm run check`：181 个模块通过。
- `npm test`：548 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。整套连跑两次都通过。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`：11 个场景全部通过。
- 新增测试 `tests/takeover.test.mjs`：
  - 接管之外的输入被拒绝，输入只记计数；
  - 文件选择；
  - 敏感字段的填写和取值断言被拒绝；
  - 一项完整的「填写被拒 → 请人 → 人输入 → 交还 → 断言」任务，密码不在任何模型请求和任务记录里；
  - 快照遮盖。
- `npm run test:desktop -- --browser`：Playwright 在 Electron 的实时画面里点密码框、打字、回车，然后交还，任务完成。截图在 `.runtime/qa/desktop-takeover*.png`。
- `npm run test:browser`：通过。
- 实测中发现并修复：
  - **已有的泄露**：可访问性快照会带上密码框的值，发给了模型；
  - 输入层 `line-height` 为 0，打不进字；
  - 按事件计数「输入 N 段文字」，等于记下了密码长度；
  - 被拒绝的填写被算成「未通过」；
  - 实时画面在负载下偶尔会发出一个空帧：迟到的节流定时器在帧已经发出后又发了一次。整套测试连跑时 `pilot.test.mjs` 失败一次，查出了这个问题。
- 详见 [docs/16](16-live-takeover.md)。

## 2026-09-30（第三轮）：看得见的工作过程、领航光标、实时画面与回放

- `npm run check`：180 个模块通过。
- `npm test`：545 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。整套连跑两次都通过。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`：11 个场景全部通过。
- 新增测试：
  - `tests/pilot.test.mjs`：严格 CSP 页面、按像素判定证据干净、不进可访问性结构；
  - `tests/replay.test.mjs`：回放文件在真实浏览器里自动播放；
  - 终端 `/replay`。
- `npm run test:desktop -- --browser`（Electron + 真实 Chromium）：实时画面、确认前在页面上标出元素、画中画、折叠的步骤与缩略图、灯箱、回放。截图在 `.runtime/qa/desktop-*.png`。
- `npm run test:browser`：通过（修正了质量报告页一条过期的指标数量断言）。
- 实测中发现并修复：
  - 截图 `style` 选项在严格 CSP 页面上被拦截，光标框线会留在证据截图里；
  - 实时画面节流会丢掉最后一帧，画面停在 `about:blank`；
  - `details` 与已有样式类重名，导致步骤组布局错乱；
  - 钩子测试在负载下的竞态。
- 详见 [docs/15](15-agent-workbench-and-replay.md)。

## 2026-09-30（第二轮）：命令沙箱、终端规程修正、会话续接、独立安装包

- `npm run check`：174 个模块通过。
- `npm test`：541 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`（脚本模式）：11 个场景全部通过。
- 新增的测试：
  - 沙箱：macOS 实测，写家目录被拒、工作区和临时目录可写；
  - 终端里的规程修正：真实 Chromium，从 `/fire`、`/repair`、批准到再次 `/fire` 通过；
  - `-c` 续接：只接这个项目的任务；
  - 安装包：内容正好是 CLI 的 import 图，解开后能运行。
- 手工验证：
  - 从 tgz 真实安装到临时前缀，安装出来的 `mx-rig exec` 和 `status` 正常；
  - 伪终端里粘贴多行只算一条消息，历史能跨会话找回。
- 没有做：Linux 上的 bubblewrap 实测、真实模型基线、PostgreSQL 重跑（这一轮没有改数据层）。
- 详见 [docs/14](14-terminal-agent.md)。

## 2026-09-30：终端 Agent `mx-rig`（P5）

- `npm run check`：172 个模块通过。
- `npm test`：537 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过（这次没有连临时数据库重跑）。新增的测试：
  - `tests/workspace.test.mjs` 7 项：工作区边界、命令、编辑、项目识别；
  - `tests/terminal.test.mjs` 3 项：会话端到端、命令行子进程、真实 Chromium；
  - `tests/eval-harness.test.mjs` 1 项：终端作弊脚本判失败。
- `npm run test:kernel`：322 项全部通过。
- `npm run eval`（脚本模式）：11 个场景全部通过，其中 3 个是新增的终端场景；真实模型基线尚未运行。
- 伪终端走查：隐藏密码输入、确认、Ctrl-C 取消后没有残留进程、空闲时连按两次 Ctrl-C 退出。
- 修复了 2 个问题：
  - 拒绝写操作后接着聊，对话里会留下没有回应的工具调用；
  - 钩子测试按次数计的等待在负载下偶尔不够。
- 详见 [docs/14](14-terminal-agent.md) §6。

## 2026-09-29：服务端回归（服务端排程，工位执行）

- `npm run check`：161 个模块通过。
- `npm test`：526 项，0 失败；不设数据库时 14 项 PostgreSQL 测试跳过。连临时 PostgreSQL 16 容器（测完删除）时，这 14 项全部通过，其中 2 项是新增的：
  - 两个副本、两个工位争同一批，只有一个领到；
  - 读不懂的时间不会留下孤儿执行。
- `npm run test:kernel`：322 项全部通过，新增规程批次的放置规则。
- 新增 `tests/station.test.mjs` 共 6 项，覆盖以下场景：
  - 批次汇总；
  - 真实 Chromium 一过一败；
  - 取消；
  - 桌面值守起真实子进程；
  - 网页端定时回归；
  - SIGTERM 发生在一批中间。
- `npm run test:desktop`：通过真实的桌面端完成工位登记、开始值守（Electron 以 Node 身份运行 `mx-rig station watch`）、停止值守（进程以 0 退出）和注销。
- Docker 实测：compose + 工位容器 + cron，测完删除全部容器、卷和镜像，并退出 Docker Desktop。
- 实测中发现并修复了 3 个问题：停止值守会关掉浏览器；团队工位的批次会永远排队；读不懂的时间会留下孤儿执行。
- 详见 [docs/13](13-agent-client-and-test-procedures.md) §3.10。

## 2026-09-29：飞行计划里的规程阶段

- `npm run check` 通过。
- `npm test`：517 项，0 失败，12 项 PostgreSQL 测试未设置数据库时跳过。
- 新增 3 项测试：节点规则与定时限制；起草时的规程选择与校验；真实 Chromium 上一过一败的计划被评审判为 NO-GO、报告写明原因，以及同一计划在服务端运行时记为受阻。
- 网页端走查了编排图、编辑器和阶段展示。详见 [docs/13](13-agent-client-and-test-procedures.md) §3.9。

## 2026-09-28：钩子，以及 PostgreSQL 实测

- `npm run check`：156 个模块通过。
- `npm test`：514 项，0 失败。不设数据库时 502 通过、12 项跳过；连临时 PostgreSQL 16 容器（测完删除）时 514 项全部通过，其中 12 项 PostgreSQL 多副本测试全部通过：
  - 迁移 021、022 实际执行；
  - 规程的多副本共享与同一修正只批准一次；
  - 钩子跨副本只认领一次。
- 钩子的服务测试、端到端自动修正、网页端走查见 [docs/13](13-agent-client-and-test-procedures.md) §3.8。

## 2026-09-28：试验规程

`npm run check`：154 个模块通过。`npm test`：511 项，500 通过、0 失败，11 项 PostgreSQL 测试因未设置数据库跳过。

新增测试：
- 规程重放：真实 Chromium，覆盖通过、改名后失败、断言失败、受阻、只重放到指定步骤；
- 端到端闭环：真实服务 + 真实 Chromium，模型为脚本；
- 规则：未经证明的修正不能批准、权限、用例导入逐条；
- 评测集两个修正场景及反例；
- 丢失断言的统计。

网页端界面用无头浏览器走查过。详见 [docs/13](13-agent-client-and-test-procedures.md) §3.6。

未运行（PostgreSQL 上的规程多副本测试已在同日补跑通过，见上一条）：
- 真实模型下的修正评测；
- 桌面端界面（Electron）里的试车与修正按钮：它们调用的试验台逻辑已由端到端测试覆盖；
- Electron 规程。

## 2026-09-27：飞行计划、航电、Pad、用量、评测集、原生工位、部署

`npm run check`：148 个模块通过。`npm test`：502 项，0 失败。其中 PostgreSQL 测试连临时 PostgreSQL 16 容器全部通过，不设数据库时这 10 项跳过。`npm run eval`（脚本模式）6 个场景全部通过。

部署实测（本机 Docker Desktop，测完删除容器、卷、命名空间、PV、虚拟机内的数据目录和这次构建与拉取的镜像，并退出 Docker Desktop）：
- **compose**：
  - 构建 → 迁移 20/20 → 上线 → 执行机注册；
  - 本地账号、Web 界面、设置存 PostgreSQL；
  - Rig 工作流任务 → 确认 → 派发 → compose 执行机认领执行 → Run passed；
  - `down --purge` 不加 `--yes` 会拒绝执行。
- **Kubernetes（docker-desktop）**：
  - `deploy` 首次成功，再次部署沿用已有密钥与数据目录；
  - 滚动更新期间主机与集群内的探测全部 200；
  - 服务端 Run 派成 K8s Job 并返回 passed。
- 实测发现并修复了 4 个问题：`mxt-runner watch` 空闲即退出（本轮引入）、滚动后 `verify` 误报失败、滚动更新掉请求、Docker Desktop 集群地址打印错误。

- 新增测试覆盖：
  - 用量计量与估算标注、上下文压缩（保留 ID，压缩后仍是合法对话，结论审计仍能核对）、token 上限在下一次调用前停下；
  - Provider 上报用量的两种返回方式；
  - 评测集的正反例：服从日志注入、引用没读过的 ID，都会被扣分；
  - 内网 HTTP 放行规则；
  - 原生工位：控件树、ref、过期引用、密码框、权限错误、不在预授权范围内、断言入账；
  - 测试内核定时调度在两个调度并发时只建一个 Run（去掉认领后能复现出两个 Run）。
- 无头 Chromium 走查了三处界面：任务详情的用量行、配置页的 token 上限（保存后读回一致）、质量报告的用量指标。
- 原生工位生成的 JXA 用 `osacompile` 编译通过（编译不发 Apple 事件）。
- `deploy/compose.yaml` 通过 `docker compose config` 校验。`scripts/manage.sh` 通过 `bash -n`。全部 Kubernetes 清单经脚本渲染后，占位符都已替换，YAML 可解析。

没有做的：
- 真实模型下的评测；
- 原生工位对真实应用的操作（需要系统授权）；
- Internal 服务器上的部署（kubeadm + containerd 镜像导入路径）；
- Windows、桌面安装包。

另外：一次对 System Events 的探测在本机等待 macOS 授权对话框超时，已终止，没有代为操作对话框。原生工位因此改为只在人点按钮时探测，每次调用都有超时。

## 2026-09-21：MCP 工具入口与可靠性

`npm run check`：122 个模块通过语法与网络所有权耦合检查。`npm test`：430 项通过，0 failed / skipped。新增 MCP stdio 到真实临时 Rig API 的读/写/权限/策略回归、有界等待、实际 Runner 取消回执、父/孙进程组清理、K8s 删除确认与调度竞争、SSE 截断、finding 自证、窗口外用例与生产只读资源测试。

未运行真实账号/模型、Windows 终止、K8s 集群、PostgreSQL 迁移和 Docker 镜像验收；没有操作 MX-H2I 登录/联网、生产数据库或在线注册信息。代码检查与接入方式见 [工具接口与可靠性改进](11-tool-interface-and-reliability.md)。

## 0.7（流式输出与结构化结论）

日期：2026-09-16。环境同 0.6。

### 已运行

1. `npm run check`：116 个模块通过语法检查，Runtime 无网络 owner 实现。
2. `npm test`：416 项通过，0 failed / skipped（0.6 是 403）。新增 13 项：
   - 流式 8 项：SSE 增量按顺序回调且拼出与非流式相同的消息、跨帧的 `tool_calls.arguments` 片段拼回完整 JSON 且注册表外的工具名在流式路径同样被拒、网关忽略 `stream` 时按普通 JSON 读完且 `streamed` 为 false、Provider 关掉流式后请求体里没有 `stream` 字段、**吐出第一个增量之后的失败不再向下一个 Provider 降级**（而第一个 token 之前的失败仍然降级）、NDJSON 在分块与多字节字符中间被切开仍能解析且中途 `{error}` 与缺失最终行都报错、Runtime 在轮询可见的位置留下草稿并在回答到达时清空、没有流式路由的服务只试一次 404 之后记住。
   - 结论 5 项：`validateArgs` 认 `enum`（`verdict: '还行'` 当场被拒）且 `nextStep` 可选、引用只在"本次任务真的读到过"时算已读（作者编排查 `evidence`、Agent 任务查 tool 消息，assistant 自述不算）、提交不调用任何外部接口也不需要确认且公开任务带上结论卡而对话仍不外泄、非法 verdict 在变成"看起来可审的结论"之前就被拒、Internal 没允许这个工具时按普通工具一样拒绝。
3. 浏览器实测（`node scripts/browser-smoke.mjs`）：替身网关按 450ms 一帧真的流式返回。工作台先渲染出「正在输出」的草稿（断言 `.rig-stream` 可见且有内容），任务完成后草稿消失（断言计数为 0），结论卡出现并显示「环境受阻 / 置信度 高 / 不是测试结论」，引用 chip 标「未读到」——这次任务确实没读过那个 ID。截图 `web-streaming.png`、`web-finding.png`。
4. `node scripts/desktop-smoke.mjs --browser`：通过。桌面那条链路上的替身网关**故意**只回普通 JSON，于是整条桌面栈（renderer → IPC → worker → `client.stream` → 服务端 → 网关）验证的是"网关忽略流式"的退路，并断言结束后没有草稿残留。真实 SSE 由浏览器 smoke 覆盖，两条路径各验一种。

### 修复与决定

- **结论差点给自己的引用作证。** `finding_submit` 的工具结果就是那份结论本身，而 Agent 路径会把工具结果写进模型对话——于是核对引用时在"本次任务读过的东西"里找到了它自己刚写的 ID，`未读到` 永远是 0。测试先发现（`unverified` 期望 1 实得 0）。改为**先核对再写进对话**；作者编排那侧同时不再把结论计入 `evidence`——一个结论不是证据，混进去连下一个 `analyze` 节点的提示词都会变成循环论证。
- **Runtime 不假设注入进来的 client 会流式。** 引擎把传输当依赖，`typeof client.stream === 'function'` 才走流式路由；否则仍用非流式接口。少了这一条，所有现有 fixture 与嵌入方都会因为调用一个不存在的方法而把任务变成 blocked。
- **响应头延迟到第一次写入。** 这样"第一个 token 之前就失败"仍然是 409/502 加 JSON 错误；已经开始流之后的失败才作为 `{error}` 行写在流里。
- **第一个增量之后不再降级。** 把备用 Provider 的回答接在半句话后面会产出一段没人写过的文本。测试写这一条时才发现：在 `ReadableStream.start()` 里 `controller.error()` 会把已入队的帧一起丢掉，那其实是"第一个 token 之前就断"，所以 fixture 改成先交付帧、再在 `pull()` 里报错。
- `validateArgs` 现在认 schema 上的 `enum`。工具的枚举以前只写在描述里给模型看，进门时并不检查；这类"文档型约束"迟早会变成一条看起来可审的脏数据。
- 重启时丢弃未完成任务的 `stream` 草稿：半句话不该在重启后看起来像结论。
- 工作台轮询改为 700ms 的基准节拍，按状态取 1 / 4 / 16 倍（流式 0.7 秒、运行中 2.8 秒、空闲 11.2 秒），且快节奏只在任务工作台生效——总览每次重绘要取四个集合，不该每秒两次。

### 尚未验证

与 0.6 相同的清单，另加：

- 真实模型网关的 SSE 没有实测（本轮全部是受控替身），因此没有真实网络抖动、重连、超长回答下的表现数据。
- NDJSON 那一跳没有做背压与限速测试；增量很小，但没有量过高并发下服务端的写入开销。
- 结构化结论只落在任务记录上，**还没有进入质量报告**：不能按 verdict 统计、筛选或汇总，引用核对也没有跨任务的聚合视图。
- 流式的呈现颗粒度取决于轮询，没有在高延迟网络下量过实际观感。

## 0.6（系统教学层、对话式下任务、出网通道）

日期：2026-09-16。环境：macOS 14.4 arm64、Node 22.21.1、Electron 34.5.8、Playwright 1.58.2 / Chromium 145.0.7632.6、zod 4.6.5。

### 已运行

1. `npm run check`：113 个模块通过语法检查，Runtime 无网络 owner 实现。
2. `npm test`：403 项通过，0 failed / skipped（0.5 是 375 项）。新增 28 项：
   - 系统层 8 项：空部署下全部未完成且 `next` 指向主线第一项、平台状态与「界面上报」两类证据分开判定、只有"领取"加经验且平台状态回退后不收回奖励、等级阈值与满级进度条、版本比较（`0.10` 新于 `0.6`）与升级后只有新任务被标新、进度存储拒绝未知名称且重复上报不写盘、HTTP 领取由服务端重新验证（未完成 409、未知任务 404、重复领取不翻倍）、viewer 能读教程但不因此获得任何权限。
   - 对话式下任务 10 项：中文二字切片匹配（单字重合不算）、一句话得到带真实计划 ID 的高置信候选、句子里的 `tsk_*` 压过名字相似度、只有动词时给下拉而不猜、没有在线执行机是提示而没有计划才是阻断、分析动词命中定级/分析 Agent 且无模型时明确受阻、桌面专属 Agent 不提供给 Web、编排候选按句子实际提供的输入填充、对不上时不硬凑候选、被阻断的候选排在可跑的后面；以及 HTTP 路由：读真实目录、解析不创建任何 Run 或 Mission、候选的 `body` 原样就是可用的 Mission 请求体。
   - 出网通道 10 项：通道地址必须写端口且不许带凭据/路径、socks 不能作用于模型面、带凭据的通道不能作用于浏览器、回环永远直连与 `.suffix` 匹配边界（`evil-internal.example.com.attacker.net` 不匹配）、按作用面解析启用通道、公开视图报告"变量有没有设"且不泄露值、`/config` 不给端点而 `/execution-config` 给、切换发新策略版本、模型网关按通道指纹缓存并在改地址后重建隧道、切回直连立即走直连。
3. 隧道实测（假代理 + 记录型上游）：CONNECT 的目标写成 `gateway.example:443`，`Proxy-Authorization` 为环境变量值的 Basic 编码；代理回 407 时报「通道要求代理凭据」而不是"连不上"；代理接受后，上游收到的第一个字节是 `0x16`——TLS ClientHello 确实穿过了隧道。直连列表命中与本机 `http:` 目标不进隧道，非本机 `http:` 目标被拒绝。
4. 浏览器实测（`node scripts/browser-smoke.mjs`，在原有覆盖之外新增）：
   - 系统页六个章节；只访问过「工具与边界」「出网与通道」时，这两项"界面上报"任务可领取，而「接入一个被测应用」仍是未完成——两类证据的区别是真的。
   - 领取一次奖励后卡片变「已领取」且等级行的经验跟着变。
   - 常驻面板在切页后仍在（`#view` 之外），按「收起」真的关闭。
   - 一句话解析：候选里是真实计划 ID、理由里写明"计划名匹配"，解析后 `GET /api/v1/runs` 仍然是 0 条。
   - 在界面里新建出网通道并「切到这条」：顶部读数变成"模型调用 Rig 通道"，而上半页仍然是「环境观测」——启用通道没有改写环境事实。随后「改为直连」恢复。
   - 新增截图：`.runtime/qa/web-system.png`、`web-system-hud.png`、`web-dispatch-plan.png`、`web-egress-channel.png`。
5. `node scripts/desktop-smoke.mjs --browser`：通过。新增断言走桌面的白名单 IPC——系统页与常驻面板可用、「在桌面端登录一次」这条支线因为桌面上报而可领取、`plan-dispatch` 通过主进程拿到真实计划 ID（renderer 永远不能自己写路径，缺一个动作只会在这里暴露）。截图 `desktop-system.png`。

### 修复与决定

- **出网配置的"缺省"语义。** 第一版把"请求体里有 `egress: undefined`"当成"清空通道"，于是管理页整份回传时会把通道清掉。改成与 agents / orchestrations 一致：缺省保留已存，清空必须显式写 `profiles: []`，并补了两条回归。
- **切换通道会作废待确认动作。** 这不是顺手的副作用，是有意的：一次确认是针对"这组参数 + 这条策略 + 这条出网路径"给的。实现上让切换走普通配置更新路径，因此拿到新的 `revision`，已发出的 `approvalId` 自然失效。文档写明了这条代价。
- **浏览器必须重开而不是复用。** Chromium 在启动时解析代理，留着旧进程说自己走新通道是对页面说谎。`BrowserTools` 记住启动时的通道指纹，指纹变了就先关掉。
- **证据行不能长得像"被拒绝"。** 第一版用 `.rig-chip[data-off]` 渲染"平台状态：还没有可用的 Provider"，那个样式带删除线，在工具页表示"未被允许"，放在这里读起来像禁用。改成独立的 `.rig-quest__evidence`，并去掉 detail 里重复的"界面上报："前缀（标签已经在前面）。
- **解析理由里报最长的那个动词。** `跑一下` 与 `跑一` 都命中时，第一版显示的是词干「跑一」——理由是给人读的，改成按长度取最长命中。
- 窄面板里状态标签会被挤成两行（「未完 成」），给它 `flex: 0 0 auto` 与 `nowrap`。
- 「解析成任务」只在新任务的输入框上出现：对着一条已结束任务的追问框解析没有可选目标。smoke 因此先点「＋ 新建任务」。

### 尚未验证

与 0.5 相同的清单（真实模型网关与费用、真实 Compass 制品与账号、PostgreSQL / Docker 实跑、K8s Job、Windows/Linux 桌面包与签名、Launcher AppCenter 现网登记、MX-H2I 现网登录/联网回归），另加：

- 真实企业代理没有实测，包括需要凭据的那种；socks5 下的隔离浏览器没有实测；经隧道到真实网关的完整 HTTPS 往返没有实测（本轮只证明了 ClientHello 穿过隧道）。
- 「界面上报」类任务在设计上就无法独立验证，页面与文档都写明了这一点；它们不是安全边界。
- 系统进度只在内存/文件存储下验证过；`system-progress.json` 没有做过多成员并发领取的压力测试。
- 本轮未修改 MX-H2I、Luopan、Insight Hub 的运行代码，也没有调用部署、数据库迁移或网络修复命令。

## 0.5（指标、汇报、视角与流畅度）

日期：2026-09-16。环境同 0.2。

### 已运行

1. `npm run check`：105 个模块通过语法检查。
2. `npm test`：375 项通过，0 failed / skipped。新增指标引擎的八项测试，覆盖：零样本给 `null` 而不是 100%、受阻既不进分子也不进分母（全受阻的窗口通过率为 `null`）、窗口过滤与倒序、趋势按日分桶且空日的 `passRate` 为 `null`、"从不通过"与"时通时不通"分开且只跑过一次的用例不算证据、覆盖率排除已退休用例并列出 P0 缺口、风险文案明确区分执行机问题与质量问题。另加一项 API 测试：用真实 run 记录验证 `passRate` 的分母不含 blocked。
3. 真实数据闭环：先用**真实 runner 契约**（注册执行机 → claim → 提交 summary）跑完 14 次执行，确认 ingest 链路可用；因平台自己给记录盖时间戳，再用一次性 harness 直接写入回溯了 16 次执行，得到跨 15 天的趋势、一条不稳定用例、一次受阻和两条 P0 覆盖缺口。报告读数：通过率 73%（11/15）、受阻 1、不稳定用例 1、P0 自动化 3/5，与手工核对一致。
4. 浏览器实测：三种视角切换后区块顺序确实改变（负责人先看趋势，测试先看要处理的）；趋势图里没有执行的日子是虚线空列而非 0；打印样式去掉侧栏与控件。`browser-smoke` 新增这段断言，并在空数据下断言通过率显示 `—`。
5. `node scripts/desktop-smoke.mjs --browser`：通过。

截图：`.runtime/qa/report-lead.png`、`overview-lead.png`、`overview-tester.png`、`web-report.png`。

### 修复

- **视角切换器塌成 2px。** `.qp-segmented` 带 `overflow: hidden`，而 `overflow` 不为 `visible` 会把 flex 容器的自动最小尺寸置为 0；作为 `display: grid` 侧栏的直接子项，它那一行于是只剩两像素边框，三个按钮溢出盖在下方导航上，看得见但点不到。外面包一层普通 div 即可。这个 bug 能通过可见性检查，所以 smoke 里改成断言实际高度。
- **轮询把侧栏整个重建。** 每 2.5 秒替换一次读者正要点的按钮，点击会落在刚被替换掉的节点上（Playwright 报 "intercepts pointer events"，人手点则是偶发失灵）。改为只在内容签名变化时重建。
- **刷新会清空正在看的页面。** 每次轮询都插入 spinner 再重绘，表现为规律性闪烁。改为保留旧内容、只在首次进入某页显示加载态，并在重绘后恢复滚动位置与光标；慢请求返回时若读者已切走则丢弃结果。
- 空闲时轮询从 2.5 秒退到 10 秒。

### 尚未验证

与 0.4 相同，另加：指标只在内存存储上验证过，PostgreSQL 下的 `listRuns/listCases/listRunCases` 聚合性能没有实测；耗时分位数把不同套件混在一起统计，跨套件比较没有意义（文档已写明）。

## 0.4（分叉、子编排、拖拽与定时）

日期：2026-09-16。环境同 0.2。

### 已运行

1. `npm run check`：103 个模块通过语法检查，Runtime 无网络 owner 耦合。
2. `npm test`：366 项通过，0 failed / skipped。新增：分叉两条分支各跑一次且汇合只触发一次、分支走不到汇合与外部指向汇合两种坏形状被拒、同一条子编排用两次各自带前缀互不串、子编排环/缺失/深度被拒、已发布 spec 原样回传仍可校验，以及定时规则的四类拒绝（写工具、人工检查点、必填输入、坏 cron）、禁用的定时不触发、触发只记一次、真实 tick 起出一条归服务账号的任务并跑到 completed。
3. 运行器层直接探针：分叉后轨迹为 `split → web → web2 → electron → summary`，汇合只跑一次；在一条分支内部 interrupt 后，队列与到达计数被 checkpoint，恢复后汇合仍只跑一次。
4. 引擎层真实执行：`n_split → n_web → approve → act → n_electron → approve → act → n_summary → conclude`，两次确认各自带着自己那条分支渲染后的 taskId。
5. 浏览器实测：在编排中心新建「双轨冒烟」（分叉→两条 tests_run→汇合）与「每日执行机巡检」（只读 + cron `0 9 * * 1-5`）。前者的图按分叉渲染（点线、紫色），运行面板给出两个计划输入；后者显示「定时执行 0 9 * * 1-5（Asia/Shanghai），下次 2026/9/16 09:00:00」。拖动节点后按 8px 吸附、草稿自动重新编译预览，保存后服务端回读到 `layout: { n_read: { x: 152, y: 136 } }`。
6. `node scripts/browser-smoke.mjs` 与 `node scripts/desktop-smoke.mjs --browser`：全部通过。

### 修复

- 引擎写 checkpoint 时只保存了游标，丢掉了运行器新增的路径队列与汇合到达计数：分叉的第一条分支停在确认上之后，第二条分支再也不会执行。改为整份 checkpoint，并把 per-step 的半份写入去掉——那份记录本来就缺少与游标配套的队列。
- `readOrchestration` 把派生的 `missingTools` / `nextFireAt` 存进了规格，运行时再读回来交给 strict schema 就被拒。与 0.3 的 `warnings` 同一类问题，这次在源头修：`withoutDerived()` 在解析前统一剥掉派生字段，并补了「已发布 spec 原样回传」的回归测试。
- 工作台的「↻ 刷新」只重绘不重新取数，而任务列表来自内存状态，所以在任务工作台上点它没有任何效果。改为先取数再重绘。
- 三处 `NODE_TYPES` / schema / 节点表的补丁因为 prettier 已经把目标行折行而静默没生效（`str.replace` 找不到就什么都不做）。补齐后加了一段一次性核对，确认七种节点在调色板、schema、编译器三处都在。

### 尚未验证

与 0.2 相同的清单，另加：定时触发只在手动 tick 与单元测试中验证过，没有让服务在真实 cron 时刻自己醒来跑一次；分叉与子编排没有在桌面端 Electron 里跑过（桌面走的是同一套运行时与同一份 smoke）。

## 0.3（可视化编排中心）

日期：2026-09-16。环境同 0.2。

### 已运行

1. `npm run check`：101 个模块通过语法检查，Runtime 无网络 owner 耦合。
2. `npm test`：358 项通过，0 failed / skipped。新增编排规格校验（悬空边、未知工具、未定义变量、重复 ID、缺失入口、不可达警告）、模板渲染与取值（含 `__proto__` / `constructor` 读不到的断言）、七种判断算子、编译产物形状，以及五项执行测试：守卫分支拒绝派发、同一条编排在有执行机时仍停在确认、作者写的检查点按自己的问题暂停且拒绝即停止、分析节点只做一次模型调用且不带工具、策略版本变化使已发出的确认失效。另加一项配置往返回归。
3. 真实 HTTP 闭环（脚本探针）：`guarded-dispatch` 两条分支都跑通——无在线执行机时轨迹为 `n_read_runners → act → n_has_runner → n_no_runner → conclude` 且**创建了 0 条 Run**；注册并上线一台执行机后轨迹为 `n_read_runners → act → n_has_runner → n_dispatch → approve → act → n_report → conclude`，在确认处停下时参数已渲染成真实 taskId，确认后创建 1 条 Run 并回填真实 testRunId。
4. 浏览器里的编辑器往返：打开内置编排 → 新增一个「人工检查点」节点 → 改 ID → 把分支接到它、再接回派发 → 校验并预览（图换成草稿编译结果，新节点标注「暂停点」）→ 保存 → 读 admin API 确认落盘的连线与界面所作完全一致。
5. `node scripts/browser-smoke.mjs`：在原有覆盖之外，新增编排中心（打开已存编排并确认拿到的是它自己的编译结果、草稿预览通过、被拒绝的草稿按节点名报错）。
6. `node scripts/desktop-smoke.mjs --browser`：桌面端全链路仍通过。
7. `docker compose config --quiet` 通过；并对 `apps/server/index.mjs` 的相对 import 做了闭包核对，确认 Dockerfile 覆盖全部依赖目录。

截图新增 `.runtime/qa/web-orchestration-editor.png`、`web-orchestration-invalid.png`。

### 修复

- `readOrchestration` 把派生的 `warnings` 一起存进了配置，于是管理页「读出来再存回去」的第二次保存会因 strict schema 报「Unrecognized key: warnings」。只存规格本身，并补了一项配置往返回归测试——管理页每次保存都是整份回传，这条往返就是契约。
- 编辑器里改完节点 ID 后，其他节点的「下一步」下拉仍是旧名字，选新名字会静默落空。改为离开输入框时重绘，并同步把指向该节点的边一起改名。
- 预览失败时只在编辑器底部提示，而页面顶部的图会悄悄退回已保存版本，看起来像什么都没发生。改为同时在通知条和图的位置显示具体原因。
- `/rig/` 静态资源没有 `cache-control`，浏览器按启发式缓存，部署更新后操作者可能停在旧工作台上却对着新 API。改为 `no-cache` 每次重新校验。
- 两个 smoke 脚本里 `document.querySelector('#mission-status').textContent` 在视图重绘的空窗期会抛错而不是继续轮询，改为可选链。

### 尚未验证

与 0.2 相同：真实模型网关与费用、真实 Compass 制品与账号、PostgreSQL / Docker 实跑、K8s Job、Windows/Linux 桌面包与签名、Launcher AppCenter 现网登记、MX-H2I 现网登录/联网回归。`analyze` 节点只用模型替身验证过协议与边界，不构成模型效果评测。

本轮未修改 MX-H2I、Luopan、Insight Hub 的运行代码。

## 0.2（Agent 中心与编排运行时）

日期：2026-09-15。环境：macOS 14.4 arm64、Node 22.21.1、Electron 34.5.8、Playwright 1.58.2 / Chromium 145.0.7632.6、zod 4.6.5。

### 已运行

1. `npm run check`：97 个模块通过语法检查，Runtime 无网络 owner 耦合。
2. `npm test`：345 项通过，0 failed / skipped。包含迁入内核回归，以及本轮新增的编排运行时（通道 reducer、schema 拒绝、条件路由、interrupt/resume、步数预算、构图期错误）、图布局、Agent 中心 API、出网观测、0.1 配置迁移与 Provider 序列降级测试。网络与模型全部由受控替身验证。
3. 真实 HTTP + 浏览器闭环：用继承的「对齐 Compass」接口建出 Compass Web（cypress，functional + demo 双轨）与 Compass Electron（playwright-electron，启动冒烟 + 正式登录验收）四个计划；在工作台创建测试工作流 → 停在 `tests_run` 确认 → 确认后派发 → 任务完成并给出真实 run ID，结论文案保持「不代表测试通过」。编排图上高亮的节点序列为 `seed_workflow → approve → act → dispatched`，与运行时 trace 一致。
4. `node scripts/desktop-smoke.mjs --browser`（源码桌面）：登录、renderer 无 `require`、凭据未返回 UI、独立 worker、逐动作确认、真实测试 API 派发、Internal 配置、退出；以及「模型替身 → 用户确认 → 打包内 Runtime → 真实 Chromium → 截图证据」完整链路。该项使用模型替身，不是外部模型效果评测。
5. `node scripts/browser-smoke.mjs`：浏览器工具的 origin 策略、真实页面填写/点击、密码字段拒绝、截图产物；Web 侧 HttpOnly 登录、未配置模型明确 blocked、Internal 配置保存、工具与边界、Agent 市场、编排视图（7 个节点）、出网观测。
6. CSP 核对：`style-src 'self'` 下页面内联样式元素数为 0；界面不使用 HTML 字符串拼接，全部以 `textContent` 落地。
7. Provider 与 Agent 往返：在界面里填写 Provider 地址与模型名并保存，「模型 Provider」页读到新的调用序列；`allowedTools` 收窄后，Agent 的 `effectiveTools` 同步收窄。
8. `docker compose config --quiet`：通过结构校验。未构建镜像、未启动服务。

截图位于 `.runtime/qa/`：`desktop-workspace.png`、`desktop-approval.png`、`desktop-completed.png`、`desktop-browser-agent.png`、`web-tools.png`、`web-agents.png`、`web-orchestration.png`、`web-egress.png`。均为本地模拟业务，不是生产证明。

### 修复

- 出网观测的凭据脱敏：`user:pass@host:7788` 会被 `new URL()` 解析成 scheme 为 `user:` 的合法 URL，用户名字段为空，原值（含密码）会被原样回显。改为只对已知代理 scheme 走结构化路径，其余只报形状。回归测试已覆盖。
- 迁入内核的审计事件排序：同一毫秒内写入的两条事件顺序不稳定，`audit.test.mjs` 因此偶发失败。内存实现增加单调序号做次级排序，PostgreSQL 查询加上 `id DESC` 次级排序。连续 5 次运行稳定通过。
- 编排图的回边选择：按 DFS 分类会因入口分支的列举顺序把 `plan → approve` 当成回边，画出与操作者认知相反的图。改为按「入口可达距离 + 声明顺序」排名，指向同级或更早节点的边才是回边，`act → plan` 因此稳定被画成返回路径。
- 部署镜像缺少 `packages/graph` 与 `scripts/design-assets.mjs`，服务端已经 import 它们；容器会在启动时失败。Dockerfile 已补齐，并对 `apps/server/index.mjs` 的相对 import 做了一次全量闭包核对。

### 尚未验证

真实模型网关与费用、真实 Compass 制品与账号、PostgreSQL / Docker 部署、K8s Job 真实执行、Windows/Linux 桌面包、安装包签名与公证、Launcher AppCenter 现网登记，以及 MX-H2I 现网登录/联网回归。Provider 连通性检查未对真实网关执行过。

本轮未修改 MX-H2I、Luopan、Insight Hub 的运行代码，也没有调用部署、数据库迁移或网络修复命令。

## 0.1 本地验证记录

日期：2026-09-14。环境：Windows 10 x64、Node 22.15.0、Electron 34.5.8、Playwright 1.58.2 / Chromium 145.0.7632.6。

1. `npm test`：321 项通过。包含迁入内核的 304 项测试，以及 Runtime、配置、API、跨平台产物判断测试。
2. 真实 HTTP 闭环：创建测试应用/Suite/Task → 创建 Mission → 等待具体参数确认 → 派发真实测试 Run → 原状态 pending-runner。
3. 源码桌面与 Windows unpacked 桌面：登录、renderer 无 require、独立 worker、确认后派发、配置页、退出。打包目录是 `dist/win-unpacked`。
4. 真实浏览器工具：localhost 测试页面导航、按标签填写、按名称点击、截图、拒绝密码输入和未允许 origin。
5. Web UI：HttpOnly 会话登录、未配置模型明确 blocked、Internal 配置保存、工具页面。
6. Docker Compose `config --quiet` 通过结构校验。未构建或启动 Docker 服务。

修复：Windows statfs 返回 files=0、ffree=0 表示没有 Unix inode 计数，不能据此拒绝所有上传；系统盘剩余空间不足测试要求的 5 GiB reserve，因此将测试临时数据移至项目盘，没有降低生产预算。重复确认、策略变更、跨用户读取、未知工具、非法参数、重启后未完成动作、取消与批准落盘竞争均有回归测试。
