# 验证记录

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
