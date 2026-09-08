# 03 · Luopan / Compass 初步验收

> 状态：待执行。本文件是首轮验收协议，不表示 Luopan / Compass 已通过 MX Autotest 自动化。

## 验收目的

首轮不是证明平台“支持所有框架”，而是用一个真实的 Quasar Web + Electron 项目证明五件事：

1. MX Autotest 能作为 standalone launcher 应用独立安装、启动和登录；
2. 同一 Project 能管理 Web 与 Electron 两种表面；
3. Cypress Web 能形成快速机器证据和人工可看的慢速完整视频；
4. Playwright Electron 能对固定打包制品形成可复现证据，并诚实暴露原生 UI 边界；
5. 整个部署与执行过程不改变 MX-H2I 现有登录和联网行为。

任何一项缺少可检查证据，都只能记为 partial 或 blocked，不能宣布首轮验收完成。

## 已知输入与必须先核实的事实

目前已知：

- 本地参考仓库：/Users/qpjoy/workspace/mingxi/luopan/po-frontend；
- 历史 Cypress 用例位于较旧的 public 分支；
- 当前开发参考分支为 feat/yjj/hdo_v2；
- 项目可构建 Web 和 Electron。

这些是规划输入，不是运行合同。验收前必须记录：

- 实际远程 repo URL；
- public 与 feat/yjj/hdo_v2 的准确 commit SHA；
- 当前可构建分支与 lockfile 状态；
- Cypress 用例数、目录、fixture 和自定义 command 清单；
- Web 启动方式、目标 URL 和健康检查；
- Electron 打包命令、产物路径、平台、签名状态和 sha256；
- mx-launcher 测试账号、Luopan 测试账号和允许访问的数据范围。

平台配置不得持久化上述绝对本地路径。Run 必须使用 Git commit、artifact digest 和 runner 工作目录记录来源。

## 验收环境矩阵

| 表面 | 工具 | 执行位置 | 首轮范围 |
| --- | --- | --- | --- |
| MX Autotest 登录 | launcher 身份合同 | standalone desktop | 独立启动、登录、登出、会话恢复与共存 |
| Compass Web | Cypress，固定版本 | K8s server runner 优先；本地 runner 可作对照 | Chromium、mock 或隔离测试环境 |
| Compass Electron | Playwright Node Electron，固定版本 | desktop runner | 一个明确 OS / arch 的打包制品 |
| MX-H2I 非回归 | 现有可靠 smoke 或人工见证步骤 | 原有客户端 | 登录和基础联网前后均正常 |

首轮 Electron 只承诺一个选定平台，例如 macOS arm64 或 Windows x64。其他平台必须单独列为未验证，不能从一次执行外推。

## Gate A：Standalone 与登录隔离

### 场景 A1：MX-H2I 未运行

步骤：

1. 确认 MX-H2I 业务窗口和进程没有运行；
2. 从 standalone launcher 入口启动 MX Autotest；
3. 使用专用测试账号完成 mx-launcher 登录；
4. 进入 Project 列表并读取 Internal 下发的应用配置；
5. 登出并再次登录。

验收：

- 不要求先启动 MX-H2I；
- 不使用 MX Autotest 自建用户；
- mx-auto-server 能识别 principal，但本地权限仍由 mx-auto-server 项目角色决定；
- 失败时能区分身份服务不可达、账号拒绝和本地授权不足；
- token 不出现在日志、URL、截图或报告中。

### 场景 A2：与 MX-H2I 同时运行

步骤：

1. 先验证 MX-H2I 基线登录和基础联网；
2. 同时启动 MX Autotest 并登录；
3. 在 MX Autotest 触发一个无破坏性的 smoke Run；
4. 再次验证 MX-H2I 登录、登出、重新登录和基础联网；
5. 分别退出两个应用，确认彼此不被带停。

验收：

- 无端口、协议、窗口单例、缓存目录或本地服务冲突；
- mx-auto-server 部署前后，launcher Deployment UID、revision 和 ready replicas 没有因本次部署变化；
- mx-launcher / Domestic / DNS / WireGuard 相关 Secret、ConfigMap、Deployment、DaemonSet 未被 mx-auto-server 脚本写入；
- MX-H2I 基线和事后 smoke 均有时间戳与操作者记录。

## Gate B：Project、Catalog 与源码冻结

在平台创建一个 Luopan / Compass Project，至少包含 web 和 electron 两个 surface。
首次接入由管理员登录 AutoTest Web，在「应用与用例」点击「接入 / 对齐 Compass」完成；
不得把登录 Internal 节点运行登记脚本作为产品流程。Launcher 用户首次登录后，管理员也在
同一 Web 的「成员」页面把其角色从只读改为测试工程师，无需复制 `principalId`。

验收：

- Web 与 Electron 使用同一 Project，但各自有独立 Suite、能力、证据策略和测试源码 ref；
- public 分支上的存量 Cypress 用例先做 inventory，不直接视为当前开发分支的有效真相；
- 每个 Run 记录被测源码 commit、测试源码 commit、Catalog digest、toolchain digest 和 runner fingerprint；
- 创建 Run 后，即使 Task 的 branch selector 变化，历史 Run 仍指向原 commit；
- Catalog 能显示 notRun、unmapped 和 duplicate；
- 目录内零用例或选择器匹配零用例时 Run 为 blocked。

建议先建立以下 Suite：

| Suite | 目的 | Track |
| --- | --- | --- |
| compass-web-smoke | P0 Web 快速反馈 | evidence-fast |
| compass-web-review | 人工评审完整流程 | review-video |
| compass-electron-smoke | 打包应用桌面冒烟 | evidence-fast |

Electron Catalog、Suite、JUnit 与 sidecar 必须共同使用 `compass-electron-smoke`，不得再混用 `electron-smoke` 或 `electron-playwright`。同一 Suite 内用机器值 `bootstrap` 与 `auth` 区分 lane；产品界面把 `auth` 显示为 formal-auth。formal-auth 是独立 Run，不能用 bootstrap 的绿色结论替代。

## Gate C：Cypress Web 快速证据轨

### 目标

快速轨为机器和开发人员提供及时反馈。它没有人为停顿或演示横幅，不为了“好看”减慢整个回归。

最低场景：

- Web 服务 readiness；
- 未登录或测试身份下的入口行为；
- 一个核心导航流程；
- 一个关键数据或策略流程；
- 一个可控的断言失败场景，用于验证诊断链。

验收：

1. 使用固定 Cypress 与浏览器版本，Run 中记录 digest；
2. 从冻结的应用 / 测试 commit 执行，而不是在运行时跟随 branch HEAD；
3. 产出有效 JUnit XML，至少一个 testcase；
4. 产出 Cypress 原生或成熟 HTML 报告；
5. 首轮验收配置必须留下一份可播放的视频证据；长期默认可按策略缩短 passed 视频保留期；
6. 失败时至少保留截图、相关视频、命令日志和错误上下文；
7. 无人工等待、无固定 900ms 步骤停顿；
8. 平台能从报告进入具体 Case、源码 ref 和 artifact；
9. 一次人为可控失败被归类为 failed，而不是 blocked；
10. 停止目标服务后的一次对照运行被归类为 blocked，而不是产品失败。

通过 Run 与对照失败 Run 都要进入验收包。只展示一条绿色 Run 不足以证明平台能诊断问题。

## Gate D：Cypress 人工慢速完整视频

### 目标

review-video 面向产品经理、负责人、客户演示准备和人工走查。它由人工触发，不进入高频 cron，也不与快速轨同时默认执行。

规则：

- 尽量复用快速轨的同一份 spec 和 step 定义，不维护第二套业务断言；
- Catalog 选择适合展示的稳定子集；
- 可以添加步骤标题、焦点高亮和 700–1200ms 的阅读停留；
- 从用户意图开始，形成一段完整流程，而不是只保留失败片段；
- 视频与 JUnit / Case 关联，能看到对应应用和测试版本；
- 默认内部可见；对外分享前生成脱敏副本。

验收：

1. 在平台上明确选择“人工评审视频”后才启动；
2. 一次完整流程形成连续可播放视频；
3. 报告展示步骤、总时长和视频入口；
4. 快速轨与慢速轨的 JUnit 结论分别保留，不用慢速视频覆盖快速轨历史；
5. 对外副本移除内网 URL、主机、源码路径、账号、token 和原始堆栈；
6. 原始视频和脱敏副本有独立 retention 与撤销记录。

首轮允许快速轨和 review-video 分别执行；不要求构建视频后处理系统。长期可评估从同一次执行的 trace / screenshots 生成演示，但不能牺牲可复现性。

## Gate E：Playwright Electron 技术验证

### 为什么标记为实验性

Playwright 的 Electron 能力只在 Node.js 绑定中提供，且 Electron 自动化接口具有实验性质。它擅长：

- 启动指定 Electron executable 或应用入口；
- 访问 renderer 中的 Page；
- 观察多窗口；
- 在支持范围内执行 main process 侧检查；
- 产出 screenshot、video、trace、console 和 network 证据。

它不天然覆盖所有 OS 原生界面。以下内容不得在 spike 前承诺：

- macOS / Windows 原生 Open、Save 对话框；
- 系统权限弹窗、Keychain、UAC；
- 安装器、自动更新器和系统托盘的所有交互；
- 浏览器内 FileChooser 之外的原生文件选择；
- 需要真实 VPN、系统代理或管理员权限的操作。

这些场景应选择：可测试的应用内替身、平台特定 driver、Computer Use、人工见证，或单独的系统测试轨。不得为了可测性在生产构建中关闭安全边界。

### 首轮 Electron 场景

建议选择稳定而可诊断的最小闭环：

1. 下载或定位固定 digest 的打包产物；
2. 校验 sha256 后冷启动；
3. 识别主窗口并验证标题、基本壳和一个关键入口；
4. 验证一个核心 renderer 流程；
5. 捕获 console error、主进程异常、screenshot 和 trace；
6. 正常退出，确认无残留测试进程；
7. 运行一个可控失败，验证报告能回到失败步骤。

如登录涉及 launcher 或系统窗口，应先做技术 spike 并记录实际可控制边界。不能通过跳过真实登录而声称登录流程已验证；也不能把用于隔离的测试 hook 带入生产模式。

### Bootstrap 与 formal auth 分轨

当前 Compass Electron test-pack 提供两个明确入口：

| Lane | 本地显式命令 | Case | 结论边界 |
| --- | --- | --- | --- |
| bootstrap | `pnpm test` / `pnpm test:bootstrap` | CPS-EL-BOOT-001、CPS-EL-BOOT-002 | 只证明打包应用进入真实 login/home renderer，并采集启动诊断 |
| formal-auth（机器值 `auth`） | `pnpm test:auth` | CPS-EL-AUTH-001 | 使用专用账号提交登录并进入 authenticated home；不得 skip |

两条轨都必须先声明 `COMPASS_E2E_NETWORK_MODE=dedicated-runner` 或经评审的 `reviewed-isolated-build`，否则在启动 Compass 前 blocked。formal-auth 还要求：

- Suite secretRefs 注入专用 `COMPASS_E2E_ACCOUNT` 与 `COMPASS_E2E_PASSWORD`；
- 使用另行安全评审的非生产 acceptance build，并声明 `COMPASS_AUTH_CAPTCHA_MODE=reviewed-test-hook`；
- 页面若仍出现 production captcha，生成 blocked preflight，不能记为 failed，更不能自动绕过；
- V0 尚不执行 sidecar 的 restricted ACL；因此 auth Run 不生成 HTML report、页面 snapshot、截图、trace、视频或 renderer/main-process 原文诊断，只保留 JUnit、runtime metadata 与 Case sidecar；
- Playwright 1.63 的自动失败页面 snapshot 必须显式关闭，Run 结束后删除其 per-test context 目录并扫描 JUnit 中的精确凭据变体；命中时删除污染结果并 blocked。依赖升级时重新验证，保护开关缺失或扫描/清理失败也 blocked。

表内是本地诊断入口；平台侧 Suite 的唯一 command 始终是 `pnpm test`。V0 让两个 Task 指向同一 `compass-electron-smoke` Suite：`profile=mock` 选择 bootstrap，V0 合法值 `profile=real` 选择 formal-auth。两个 Task 还应分别把 `caseFilter` 固定为 `CPS-EL-BOOT-001,CPS-EL-BOOT-002` 与 `CPS-EL-AUTH-001`，并形成独立 Run；Task 本身没有 command，不得为切轨临时 PATCH Suite command。formal-auth Task 必须保持 manual，直到账号、验证码 acceptance build 与专用 runner 的评审证据齐全。

只有 auth Playwright controller 可以读取凭据用于输入；V0 的 secretRefs 暂时属于 Suite 级，因此 bootstrap wrapper 必须在启动 Playwright worker 前再次剔除账号、密码与 token/secret。被测 Electron child 只继承严格系统 allowlist，且 HOME / APPDATA / TEMP / XDG 目录都指向 Run 临时 profile。账号、密码、Git token、平台 token、代理凭据和 Node 注入参数不得进入目标应用环境。后续应把 secretRefs 下沉到 Task/lane，消除 bootstrap 获取凭据的机会。

bootstrap 不能把取得第一个窗口当成功。它必须拒绝 startup-loading `.panel.failed`，等待登录页 `#account + #password + .login-button` 或主页 `.ai-home-page / .arco-main-layout`，并记录 renderer pageerror、console error 与 main-process stderr。加载页超时、窗口提前关闭和应用无法启动写根目录 `preflight.json`，wrapper 返回 exit 2。

验收：

- 执行的是打包制品，不只是 dev server；
- Run 记录 artifact digest、OS、arch、Playwright，以及被测 Electron 自带的 Electron/Chromium 版本；本轨不下载独立 Playwright browser，因此不伪造 browser revision；
- JUnit 是最低结果，Playwright HTML / trace 是增强证据；
- 没有 testcase、应用无法启动或找不到窗口均为 blocked；
- renderer 断言失败为 failed；
- 原生对话框范围在报告中明确标为 covered、manual 或 unsupported；
- 结果可由同能力 runner 使用相同 digest 重跑；
- 清理被测进程和临时 profile，不污染用户真实配置。
- bootstrap 与 formal-auth 分别形成 Run；formal-auth 未执行或 blocked 时，P0 登录 Gate 不得因为 bootstrap 通过而变绿；
- 目标 Electron 进程的实际环境经过 allowlist 检查，不含账号、密码、Git / 平台 token；
- runtime metadata 不含绝对 appPath，至少记录应用版本、OS、arch、Electron、Chromium、Electron Node 与 Playwright 版本。

## Gate F：运维、流量与恢复

验收：

- mx-auto-server 可由一条入口命令完成 deploy，migration 在 API rollout 前成功；
- migrate 可单独运行且具 checksum 漂移保护；
- deploy 重跑幂等，实际 workload 使用预期 image digest；
- down 不删除数据库、Secret 和 artifact；
- 只在打开进行中 Run 页面时建立 SSE，关闭页面后连接释放；
- server runner 不在每个 Run 重复下载同一 Cypress / Playwright 浏览器；
- Desktop Runner 首次获取工具后命中内容寻址缓存；
- 视频在 Run 完成后上传，不做持续直播；
- 大文件中断后能续传，或在不支持续传的首版明确限制大小并给出恢复步骤；
- 存储超阈值时拒绝新录像并标 blocked / warning，不挤满 launcher 所在节点；
- mx-auto-server 故障时已运行的 MX-H2I 登录和联网不受影响。

## 验收证据包

每个 Gate 的验收记录至少包含：

| 证据 | 要求 |
| --- | --- |
| acceptance.json | 环境、日期、操作者、Gate 结论和关联 Run ID |
| source-manifest.json 或 sidecar.sources | 应用 / 测试 commit、制品与 Catalog digest；V0 可先嵌入 sidecar |
| toolchain-manifest.json 或 sidecar.engine/runtime | 工具、浏览器、OS、arch、镜像或缓存 digest；V0 可先嵌入 sidecar |
| junit/*.xml | 原始最低结果 |
| mx-autotest.sidecar.json | 若 adapter 支持则提供 |
| preflight.json | 仅 blocked 时提供；记录脱敏 stage/reason，不伪造 testcase |
| report/ | 可离线打开或通过受权链接访问 |
| videos/ | Web 快速证据/人工慢速完整视频，以及按 Case ID 绑定的 Electron 证据视频 |
| traces/ | Electron Playwright trace |
| screenshots/ | Electron bootstrap 的失败与关键检查点；formal-auth 为保护凭据不截图 |
| operations/ | 部署、迁移、资源水位和登录非回归摘要 |

所有证据先做密钥扫描与文本脱敏。视频和截图无法保证自动脱敏，必须只使用隔离测试账号和非真实客户数据。

## 最终判定

首轮“通过”必须同时满足：

- Gate A 至 Gate F 均通过；
- Web 快速轨、人工慢速视频轨、Electron smoke 各有独立 Run；
- 至少一个故意失败和一个基础设施受阻场景被正确分类；
- MX-H2I 登录非回归前后均通过；
- 所有证据可打开、可关联且未发现凭据；
- 未覆盖的 OS 原生场景有明确清单。

若 Electron 的技术 spike 证明 Playwright 无法稳定驱动目标打包应用，应把 Gate E 记为 blocked，并基于证据评估 WebdriverIO、平台 driver 或人工轨。更换工具是合格的工程结论，伪造“已支持”不是。
