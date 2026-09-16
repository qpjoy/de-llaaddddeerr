/**
 * 系统：一层跟着版本走的操作教程。
 *
 * The workbench already has a five-step banner on the overview and a static
 * 新手引导 page. Neither survives contact with a growing product: the banner
 * only knows five things, and the page is prose nobody re-reads after a
 * release. This module is the third form — a quest catalogue with three
 * properties the other two lack.
 *
 * 1. Every quest is *verified against real state*, or it says who reported it.
 *    `evidence: 'platform'` means the answer came from the test kernel, the
 *    stored config or this member's own mission history. `evidence: 'signal'`
 *    means the workbench told us the member did something the server cannot
 *    see (opened a report, printed a page). The distinction is shown in the UI
 *    and it is the whole reason this is not a checkbox list.
 * 2. Every quest carries the version it shipped in, so an upgrade produces a
 *    visible list of new quests instead of a silently longer tutorial.
 * 3. Rewards are progress, not permission. XP and levels unlock nothing: roles
 *    stay viewer / operator / admin, decided by Internal. A tutorial that
 *    hands out capabilities would be a second, worse policy engine.
 *
 * Pure module on purpose, like `insights.mjs`: facts in, quest states out. It
 * performs no IO and holds no per-member state, so the whole catalogue is
 * testable without a server.
 */

export const SYSTEM_VERSION = '0.7'

/**
 * What the workbench is allowed to report about itself.
 *
 * A closed list. A signal is the weakest kind of evidence in the product — the
 * client saying "I did this" — so it may never name a tool, a mission or a
 * path, and the server records nothing but the name and a timestamp.
 */
export const SIGNALS = [
  'opened_run_report',
  'copied_report',
  'printed_report',
  'triaged_case',
  'read_blocked_rule',
  'opened_tools',
  'opened_egress',
  'dispatch_planned',
  'lens_switched',
  'hud_opened',
  'desktop_login',
  'saw_stream'
]

export const LEVELS = [
  { level: 1, at: 0, title: '见习操作员' },
  { level: 2, at: 140, title: '执行员' },
  { level: 3, at: 360, title: '测试工程师' },
  { level: 4, at: 640, title: '证据分析员' },
  { level: 5, at: 980, title: '编排师' },
  { level: 6, at: 1380, title: '首席操作员' }
]

export const CHAPTERS = [
  {
    key: 'ignition',
    line: 'main',
    title: '第一章 · 点火：让第一条测试真的跑起来',
    brief: '主线是自动化测试。这一章结束时，平台上会有一条你自己派发、拿到真实结论的执行。'
  },
  {
    key: 'evidence',
    line: 'main',
    title: '第二章 · 回收：把证据读明白',
    brief: '一次执行的价值在证据里。这一章练的是分清 failed 与 blocked，以及从可疑用例跳到定级。'
  },
  {
    key: 'copilot',
    line: 'main',
    title: '第三章 · 副驾：Agent 与它的边界',
    brief: 'Agent 读证据、串流程、调用工具，但工具集由 Internal 允许列表决定，写动作由你确认。'
  },
  {
    key: 'orchestration',
    line: 'main',
    title: '第四章 · 编排：把流程固定下来',
    brief: '把一次能跑通的流程变成一张图：分支、分叉汇合、暂停点，只读的那种还能定时跑。'
  },
  {
    key: 'control',
    line: 'main',
    title: '第五章 · 控制面：出网、开关与一句话下任务',
    brief: '系统设置里能实时切换 Rig 自己的出网通道；任务也可以用一句话说，由系统解析成结构化派发。'
  },
  {
    key: 'side',
    line: 'side',
    title: '支线 · 手感与自救',
    brief: '不影响主线，但都是真出问题时用得上的动作。做完主线再回来捡也行。'
  }
]

const CHAPTER_KEYS = new Set(CHAPTERS.map((chapter) => chapter.key))

/** "2 个应用" reads better than "true"; a quest shows the state that satisfied it. */
const count = (value, unit, none) => (value > 0 ? `已有 ${value} ${unit}` : none)

export const QUESTS = [
  // -- 第一章 ------------------------------------------------------------------
  {
    id: 'onboard-app',
    chapter: 'ignition',
    title: '接入一个被测应用',
    why: '测试资产挂在应用上。没有应用，套件、用例和计划都没有地方落。',
    steps: [
      '右上角「完整测试管理台 ↗」打开同 origin 的测试中心。',
      '用继承下来的「接入 / 对齐 Compass」入口，一次建好 Compass Web 与 Compass Electron 两条线。',
      '回到 Rig 的「测试中心」，确认应用列表里能看到它们。'
    ],
    target: { view: 'tests' },
    reward: { xp: 60 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.apps > 0,
      detail: count(facts.apps, '个应用', '测试中心还没有应用')
    })
  },
  {
    id: 'build-plan',
    chapter: 'ignition',
    title: '建一个可重复执行的测试计划',
    why: '计划 = 套件 + profile + 轨道。它是唯一可以被派发、被定时、被编排引用的东西。',
    steps: [
      '在测试管理台给某个套件建计划，选 functional（快）或 demo（录像）。',
      '回到 Rig 的「测试中心」，计划会出现在可派发列表里。',
      '登记不会自动跑测试——这一步只是把"怎么跑"写下来。'
    ],
    target: { view: 'tests' },
    reward: { xp: 60 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.tasks > 0,
      detail: count(facts.tasks, '个测试计划', '还没有测试计划')
    })
  },
  {
    id: 'runner-online',
    chapter: 'ignition',
    title: '让至少一台执行机在线',
    why: '没有在线执行机时，派发只会产生一条永远排队的 Run。这不是测试失败，是环境没起来。',
    steps: [
      '用迁入的 CLI 在目标机器上注册执行机（`mxt-runner`），或部署 K8s Job 执行机。',
      '在测试管理台的执行机页确认它在线。',
      '回到总览，「在线执行机」应该不再是 0。'
    ],
    target: { view: 'overview' },
    reward: { xp: 80 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.runnersOnline > 0,
      detail:
        facts.runnersOnline > 0
          ? `在线 ${facts.runnersOnline}/${facts.runnersRegistered} 台`
          : facts.runnersRegistered > 0
            ? `已注册 ${facts.runnersRegistered} 台，但都不在线`
            : '还没有注册执行机'
    })
  },
  {
    id: 'first-dispatch',
    chapter: 'ignition',
    title: '亲手派发一次测试，并确认参数',
    why: '派发是写动作。系统会把工具名和完整参数摊开等你确认——这一步就是感受那个暂停点。',
    steps: [
      '「测试中心」里选一个计划，点「创建测试工作流」。',
      '到「任务工作台」核对 tests_run 的参数，点「确认执行」。',
      '拿到真实 Run ID。派发成功 ≠ 测试通过。'
    ],
    target: { view: 'tests' },
    reward: { xp: 100 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.dispatchedMissions > 0,
      detail: count(facts.dispatchedMissions, '次派发（带真实 Run ID）', '你还没有派发过测试')
    })
  },
  {
    id: 'first-verdict',
    chapter: 'ignition',
    title: '拿到第一个真实结论',
    why: 'passed / failed / flaky 才进通过率；blocked 不进分子也不进分母。第一次看见这套口径最好是在自己的数据上。',
    steps: [
      '等执行结束，在总览的「最近执行」里看它最后是什么状态。',
      '点「看报告 ↗」打开这次执行的报告。',
      '如果是 blocked，先看执行机和环境，不要当成产品缺陷。'
    ],
    target: { view: 'overview' },
    reward: { xp: 80 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.judgedRuns > 0,
      detail:
        facts.judgedRuns > 0
          ? `窗口内有 ${facts.judgedRuns} 次有结论的执行`
          : facts.blockedRuns > 0
            ? `只有 ${facts.blockedRuns} 次受阻，还没有 passed/failed/flaky`
            : '还没有执行记录'
    })
  },

  // -- 第二章 ------------------------------------------------------------------
  {
    id: 'open-run-report',
    chapter: 'evidence',
    title: '打开一次执行的完整报告',
    why: '报告里有用例级结果、失败步骤和录像时刻。它是唯一能回答"到底哪一步坏了"的地方。',
    steps: [
      '总览「最近执行」任一行点「看报告 ↗」。',
      '找到失败用例，看它停在哪一步。',
      'demo 轨道有录像；functional 轨道追求快和稳定。'
    ],
    target: { view: 'overview' },
    reward: { xp: 50 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.opened_run_report),
      detail: facts.signals.opened_run_report ? '已打开过执行报告' : '还没有打开过报告'
    })
  },
  {
    id: 'weekly-report',
    chapter: 'evidence',
    title: '把质量报告复制成一份周报',
    why: '报告里的每个比率都带分母，样本为零写「—」。直接复制出去，比自己重算一遍更不容易失真。',
    steps: [
      '打开「质量报告」，先看趋势和风险清单。',
      '点「复制为周报」，粘到团队真正在用的地方。',
      '注意口径那几行会跟着一起复制——它们是数字的一部分。'
    ],
    target: { view: 'report' },
    reward: { xp: 70 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.copied_report),
      detail: facts.signals.copied_report ? '已复制过周报' : '还没有复制过周报'
    })
  },
  {
    id: 'triage-case',
    chapter: 'evidence',
    title: '把一条可疑用例交给定级',
    why: '不稳定用例列表只告诉你"这条不对"。定级要回答的是：产品缺陷、环境受阻、用例问题，还是真 flaky。',
    steps: [
      '「质量报告」里找到不稳定或连续失败的用例。',
      '点这一行的「让 Agent 定级」，草稿会自动写好上下文。',
      '没有模型时也能看到它被阻断的原因，不会假装给结论。'
    ],
    target: { view: 'report' },
    reward: { xp: 70 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.triaged_case),
      detail: facts.signals.triaged_case ? '已发起过一次定级' : '还没有发起过定级'
    })
  },
  {
    id: 'read-blocked-rule',
    chapter: 'evidence',
    title: '读懂两条不让步的口径',
    why: '样本为零不给比率，受阻既不算通过也不算失败。一周执行机全挂，不该在报告上变成质量下滑。',
    steps: [
      '打开「新手引导」最后两条规则，或「质量报告」底部的口径说明。',
      '确认你能说清 blocked 与 failed 的区别。',
      '这一条没有平台状态可以证明，靠你自己点"读过了"。'
    ],
    target: { view: 'guide' },
    reward: { xp: 40 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.read_blocked_rule),
      detail: facts.signals.read_blocked_rule ? '你已确认读过' : '尚未确认'
    })
  },

  // -- 第三章 ------------------------------------------------------------------
  {
    id: 'model-online',
    chapter: 'copilot',
    title: '接上一个模型 Provider',
    why: 'Agent 需要模型。密钥只用环境变量名登记，服务端读取——UI、任务、用例里都不该出现密钥本身。',
    steps: [
      '管理员在「Internal 配置」填 Provider：含 /v1 的 base URL、明确的模型名、凭据环境变量名。',
      '设置对应环境变量并重启服务。',
      '在「模型 Provider」页做一次连通性检查。'
    ],
    target: { view: 'providers' },
    reward: { xp: 90 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.modelConfigured,
      detail: facts.modelConfigured
        ? `调用序列里有 ${facts.providers} 个可用 Provider`
        : '还没有可用的 Provider'
    })
  },
  {
    id: 'agent-answer',
    chapter: 'copilot',
    title: '让一个 Agent 读证据给出结论',
    why: 'Agent 是副驾：它读 run、用例、产物，给带依据的判断。它不会替你宣布测试通过。',
    steps: [
      '「Agent 市场」里选「结果分析师」或「失败定级员」。',
      '在任务工作台描述目标，或直接用它的示例问题。',
      '每一步只允许一个工具调用；工具集是它的意图 ∩ Internal 允许列表。'
    ],
    target: { view: 'agents' },
    reward: { xp: 100 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.agentAnswers > 0,
      detail: count(facts.agentAnswers, '次 Agent 给出结论', '还没有完成过 Agent 对话')
    })
  },
  {
    id: 'watch-a-stream',
    chapter: 'copilot',
    title: '看一次模型边写边出',
    why: '一段回答要生成十几秒。看着它长出来和干等一个转圈，是两种产品；也顺便说明为什么它是"草稿"而不是结论。',
    steps: [
      '让任一 Agent 跑一步（例如「结果分析师」读一次执行）。',
      '任务时间线最下面会出现「正在输出」，文字分块出现。',
      '结束时那段草稿被正式回答替换——半句话不会留在记录里。'
    ],
    target: { view: 'missions' },
    reward: { xp: 50 },
    since: '0.7',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.saw_stream),
      detail: facts.signals.saw_stream ? '已看过流式输出' : '还没有看到过'
    })
  },
  {
    id: 'structured-finding',
    chapter: 'copilot',
    title: '拿到一次结构化结论',
    why: '"大概是环境问题"和"environment-blocked / 置信度高 / 依据 trun_x"对产品是两种东西：后者能统计、能筛、能核对引用。',
    steps: [
      '给 Agent 放开 finding_submit 工具（Internal 配置 → 工具允许列表）。',
      '让「失败定级员」读一次失败执行并定级。',
      '任务详情顶部会出现结论卡：结论类型、置信度、依据，以及每个引用 ID 是否真的在本次任务里读到过。'
    ],
    target: { view: 'missions' },
    reward: { xp: 90 },
    since: '0.7',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.findings > 0,
      detail: count(facts.findings, '次结构化结论', '还没有 Agent 提交过结构化结论')
    })
  },
  {
    id: 'tool-boundary',
    chapter: 'copilot',
    title: '看清工具与边界这一页',
    why: 'Agent 说"受阻"时，多半不是模型不行，是工具没被允许。这一页是判断的地方。',
    steps: [
      '打开「工具与边界」，看每个工具的 read / write 标记。',
      '注意浏览器工具默认关闭，且只在桌面 Runtime 可用。',
      '允许列表由 Internal 管理；实际动作前会重新取一次当前策略。'
    ],
    target: { view: 'tools' },
    reward: { xp: 50 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.opened_tools),
      detail: facts.signals.opened_tools ? '已看过工具与边界' : '还没有看过这一页'
    })
  },
  {
    id: 'approve-write',
    chapter: 'copilot',
    title: '亲手批准一次写动作',
    why: '确认只对那一组参数生效，不可重用；策略在执行前变了就直接拒绝。这条规则值得亲手体验一次。',
    steps: [
      '让 Agent 或工作流走到一个写动作（例如派发测试）。',
      '在「确认这一次操作」里读完整参数再点确认。',
      '拒绝也是一个合法结局：任务会停在"已拒绝"。'
    ],
    target: { view: 'missions' },
    reward: { xp: 80 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.approvals > 0,
      detail: count(facts.approvals, '次确认记录', '还没有确认过写动作')
    })
  },

  // -- 第四章 ------------------------------------------------------------------
  {
    id: 'run-orchestration',
    chapter: 'orchestration',
    title: '跑一条内置编排',
    why: '编排把"先查执行机，有人接才派发"这类判断固定下来，不再依赖某个人记得先看一眼。',
    steps: [
      '「编排中心」选「有人接才派发」，填测试计划。',
      '它会先确认有在线执行机，再进入派发确认。',
      '没有执行机就直接说清楚，不制造一条永远排队的 Run。'
    ],
    target: { view: 'orchestration' },
    reward: { xp: 90 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.orchestrationRuns > 0,
      detail: count(facts.orchestrationRuns, '次编排执行', '还没有跑过编排')
    })
  },
  {
    id: 'author-orchestration',
    chapter: 'orchestration',
    title: '自己存下一条编排',
    why: '节点类型由运行时提供，你组合顺序、参数与变量走向。存进去之前一定能编译——作者的笔误不该变成操作者的失败执行。',
    steps: [
      '「编排中心」里新增节点、改连线、拖拽摆位。',
      '点校验预览：上方的图会换成草稿的真实编译结果。',
      '保存。正在运行的任务仍按它启动时那一版执行。'
    ],
    target: { view: 'orchestration' },
    reward: { xp: 110 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.authoredOrchestrations > 0,
      detail: count(facts.authoredOrchestrations, '条自建编排', '编排都还是内置的')
    })
  },
  {
    id: 'schedule-orchestration',
    chapter: 'orchestration',
    title: '给一条只读编排排一个 cron',
    why: '只有能无人值守跑完的只读编排可以定时。带写工具或人工检查点的会被直接拒绝，这是有意的。',
    steps: [
      '选一条只读编排（例如执行机巡检），在运行面板里设 cron。',
      '保存后能看到"下次触发"的具体时间。',
      '定时执行没有失败重试与告警，别用它守关键发布。'
    ],
    target: { view: 'orchestration' },
    reward: { xp: 90 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.scheduledOrchestrations > 0,
      detail: count(facts.scheduledOrchestrations, '条已启用的定时编排', '还没有定时编排')
    })
  },

  // -- 第五章 ------------------------------------------------------------------
  {
    id: 'read-egress',
    chapter: 'control',
    title: '看清自己的出网状态',
    why: '"模型连不上"和"模型配错了"是两件事。这一页把它们分开，让排查不靠猜。',
    steps: [
      '打开「出网观测」，看进程可见的代理变量与是否真的生效。',
      'Node 22 的 fetch 不读代理环境变量——页面会直接说这件事。',
      '含凭据的代理值只显示形状，不回显原文。'
    ],
    target: { view: 'egress' },
    reward: { xp: 50 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.opened_egress),
      detail: facts.signals.opened_egress ? '已看过出网观测' : '还没有看过这一页'
    })
  },
  {
    id: 'switch-egress',
    chapter: 'control',
    title: '配一个出网通道并实时切换',
    why: 'Rig 只给自己的出网请求设代理：模型调用和隔离浏览器。它不改系统代理、路由、DNS 或 PAC——那是 Launcher 那一侧的事。',
    steps: [
      '管理员在「出网观测」新增通道：http/https/socks5 的 host:port，凭据用环境变量名登记。',
      '点「切到这条」，下一次模型调用立即走新通道，不用重启。',
      '浏览器会在下一次 browser_open 时用新通道重开隔离上下文。'
    ],
    target: { view: 'egress' },
    reward: { xp: 90 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: Boolean(facts.egressActive),
      detail: facts.egressActive
        ? `当前通道：${facts.egressActive}`
        : facts.egressProfiles > 0
          ? `已配置 ${facts.egressProfiles} 条通道，但都没有启用`
          : '还没有配置出网通道'
    })
  },
  {
    id: 'talk-to-dispatch',
    chapter: 'control',
    title: '用一句话下一个任务',
    why: '对话式下任务不是让模型替你决定。系统把一句话解析成候选派发，写清匹配到什么、还缺什么，你确认后才执行。',
    steps: [
      '在任务工作台的输入框写一句话，例如「跑一下 Compass Electron 的登录验收」。',
      '点「解析成任务」，看它给出的候选、依据与缺失项。',
      '解析不调用模型；确认前什么都不会发生。'
    ],
    target: { view: 'missions' },
    reward: { xp: 80 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.dispatch_planned),
      detail: facts.signals.dispatch_planned ? '已解析过一句话任务' : '还没有用过'
    })
  },

  // -- 支线 --------------------------------------------------------------------
  {
    id: 'try-lenses',
    chapter: 'side',
    title: '换一次视角',
    why: '视角只改变排版顺序，不改变任何人的权限。负责人先看趋势，测试先看要处理的。',
    steps: ['侧栏顶部切换 测试 / 开发 / 负责人。', '看总览和质量报告的区块顺序确实变了。'],
    target: { view: 'overview' },
    reward: { xp: 30 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.lens_switched),
      detail: facts.signals.lens_switched ? '已切换过视角' : '还没有换过视角'
    })
  },
  {
    id: 'open-hud',
    chapter: 'side',
    title: '开一次系统面板',
    why: '面板是这层教程的常驻入口：当前任务、要点的位置、下一步跳哪里，跟着你翻页。',
    steps: ['右上角「⬢ 系统」打开悬浮面板。', '不需要时收起；它记住你的选择。'],
    target: { view: 'system' },
    reward: { xp: 20 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.hud_opened),
      detail: facts.signals.hud_opened ? '已开过面板' : '还没有开过'
    })
  },
  {
    id: 'stop-a-mission',
    chapter: 'side',
    title: '停掉一个跑飞的任务',
    why: '停止只取消 Agent 的后续步骤，不会撤销已经提交的测试或其他外部副作用。知道这条边界比敢按那个按钮更重要。',
    steps: [
      '在任务工作台对一个进行中的任务点「停止此任务」。',
      '看它变成"已取消"，以及事件里那条说明。',
      '已派发的测试要在测试平台那一侧单独取消。'
    ],
    target: { view: 'missions' },
    reward: { xp: 50 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.cancellations > 0,
      detail: count(facts.cancellations, '次取消记录', '还没有取消过任务')
    })
  },
  {
    id: 'browser-tool',
    chapter: 'side',
    title: '在允许列表里跑一次浏览器工具',
    why: '浏览器工具是唯一会碰真实页面的能力：逐动作确认、临时独立 context、不读你浏览器的登录态、不填密码和验证码。',
    steps: [
      '管理员在「Internal 配置」逐项允许 browser_* 并填 origin（含所需资源域）。',
      '在桌面端让 Agent 打开那个 origin。',
      '截图留在你自己的本地工作目录，在证据项点击打开。'
    ],
    target: { view: 'tools' },
    reward: { xp: 70 },
    since: '0.6',
    evidence: 'platform',
    verify: (facts) => ({
      done: facts.browserActions > 0,
      detail:
        facts.browserActions > 0
          ? count(facts.browserActions, '次浏览器工具调用', '')
          : facts.browserOrigins > 0
            ? `已允许 ${facts.browserOrigins} 个 origin，但还没有真的跑过`
            : '还没有允许任何 origin'
    })
  },
  {
    id: 'desktop-surface',
    chapter: 'side',
    title: '在桌面端登录一次',
    why: '桌面端有本地 Runtime 和隔离浏览器，Web 端没有。两个执行面的历史目前不自动同步——知道这件事能省掉一次"我的任务去哪了"。',
    steps: [
      '`npm run browser:install` 后 `npm run desktop`。',
      '用同一个账号登录同一个 Internal 服务。',
      'renderer 不接收 bearer token；凭据只在主进程与 worker 内存。'
    ],
    target: { view: 'system' },
    reward: { xp: 40 },
    since: '0.6',
    evidence: 'signal',
    verify: (facts) => ({
      done: Boolean(facts.signals.desktop_login),
      detail: facts.signals.desktop_login ? '已在桌面端登录过' : '还没有在桌面端登录'
    })
  }
]

/**
 * 系统更新日志。
 *
 * The point of a versioned tutorial is that an upgrade is visible. Each entry
 * names the quests it introduced, so a member who returns after a release can
 * read what changed instead of re-scanning the whole catalogue.
 */
export const CHANGELOG = [
  {
    version: '0.7',
    at: '2026-09-16',
    title: '流式输出与结构化结论',
    notes: [
      '模型回复边生成边显示：服务端按 SSE 读上游，再以 NDJSON 把增量交给 Runtime，草稿落在任务记录上由工作台轮询渲染。',
      '新增 finding_submit 工具：结论类型、置信度、依据与下一步受 schema 约束，引用的 run / 计划 ID 会与本次任务真的读到过的工具结果比对。',
      'Provider 可以逐个关掉流式（网关不支持时）；关掉后行为与 0.6 完全一致。'
    ],
    quests: []
  },
  {
    version: '0.6',
    at: '2026-09-16',
    title: '系统上线：教学任务、一句话下任务、出网通道切换',
    notes: [
      '新增「系统」页与常驻面板：24 个任务分五章主线加一条支线，进度按平台真实状态判定。',
      '任务工作台支持一句话解析成候选派发：不调用模型，确认后才执行。',
      '出网观测从只读观测扩展为可切换通道，只作用于 Rig 自己的模型调用与隔离浏览器。'
    ],
    quests: QUESTS.filter((quest) => quest.since === '0.6').map((quest) => quest.id)
  }
]

// Filled after QUESTS so each entry lists what it introduced without repeating
// the ids by hand.
for (const entry of CHANGELOG)
  entry.quests = QUESTS.filter((quest) => quest.since === entry.version).map((quest) => quest.id)

/** Compare two dotted versions numerically: '0.10' is newer than '0.6'. */
export function isNewer(a, b) {
  const left = String(a).split('.').map(Number)
  const right = String(b).split('.').map(Number)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const one = left[index] ?? 0
    const two = right[index] ?? 0
    if (!Number.isFinite(one) || !Number.isFinite(two)) return false
    if (one !== two) return one > two
  }
  return false
}

export function levelFor(xp) {
  let current = LEVELS[0]
  for (const entry of LEVELS) if (xp >= entry.at) current = entry
  const next = LEVELS.find((entry) => entry.at > xp) ?? null
  return {
    level: current.level,
    title: current.title,
    xp,
    at: current.at,
    nextAt: next?.at ?? null,
    nextTitle: next?.title ?? null,
    // Progress inside the current band, so a bar has something honest to show
    // at the top level too (full, not empty).
    progress: next ? (xp - current.at) / (next.at - current.at) : 1
  }
}

/**
 * Normalise everything the quests are allowed to read.
 *
 * Platform facts (apps, plans, runners, runs, stored config) are shared: the
 * tutorial teaches one deployment, and the first person to register an app
 * really has registered it for everyone. Personal facts come from this
 * member's own missions and their own signals. The UI says which is which.
 */
export function systemFacts({
  apps = [],
  tasks = [],
  runs = [],
  runners = [],
  missions = [],
  config = {},
  signals = {}
} = {}) {
  const events = (row) => (Array.isArray(row.events) ? row.events : [])
  const orchestrations = Array.isArray(config.orchestrations) ? config.orchestrations : []
  const egress = config.egress ?? {}
  return {
    apps: apps.length,
    tasks: tasks.length,
    runnersRegistered: runners.length,
    runnersOnline: runners.filter((runner) => runner.online).length,
    judgedRuns: runs.filter((run) => ['passed', 'failed', 'flaky'].includes(run.status)).length,
    blockedRuns: runs.filter((run) => run.status === 'blocked').length,
    dispatchedMissions: missions.filter((row) => Boolean(row.testRunId)).length,
    agentAnswers: missions.filter(
      (row) => row.mode === 'agent' && events(row).some((event) => event.kind === 'answer')
    ).length,
    orchestrationRuns: missions.filter((row) => row.mode === 'orchestration').length,
    approvals: missions.filter((row) => events(row).some((event) => event.kind === 'approved'))
      .length,
    cancellations: missions.filter((row) => row.status === 'cancelled').length,
    findings: missions.filter((row) => Boolean(row.finding)).length,
    browserActions: missions.filter((row) =>
      events(row).some((event) => String(event.data?.tool ?? '').startsWith('browser_'))
    ).length,
    modelConfigured: Boolean(config.model?.configured),
    providers: config.model?.providers?.length ?? 0,
    allowedTools: config.policy?.allowedTools?.length ?? 0,
    browserOrigins: config.policy?.browserOrigins?.length ?? 0,
    authoredOrchestrations: orchestrations.filter((entry) => !entry.builtin).length,
    scheduledOrchestrations: orchestrations.filter((entry) => entry.schedule?.enabled).length,
    egressProfiles: (egress.profiles ?? []).length,
    egressActive: egress.activeId ?? null,
    signals: signals ?? {}
  }
}

/**
 * The whole system state for one member.
 *
 * `claimed` is the only thing that moves XP. Verification is real, but the
 * reward still needs a deliberate click: a tutorial that silently awards
 * points for state someone else produced teaches nothing.
 */
export function evaluateSystem({
  facts,
  progress = {},
  catalogue = QUESTS,
  version = SYSTEM_VERSION,
  changelog = CHANGELOG
} = {}) {
  const claimed = new Set(Array.isArray(progress.claimed) ? progress.claimed : [])
  const quests = catalogue.map((quest) => {
    const { done, detail } = quest.verify(facts)
    const isClaimed = claimed.has(quest.id)
    return {
      id: quest.id,
      chapter: quest.chapter,
      line: CHAPTERS.find((chapter) => chapter.key === quest.chapter)?.line ?? 'side',
      title: quest.title,
      why: quest.why,
      steps: quest.steps,
      target: quest.target,
      reward: quest.reward,
      since: quest.since,
      evidence: quest.evidence,
      done,
      detail,
      // Claimed stays claimed. Platform state can regress (a runner goes
      // offline, an app is archived) and taking a reward back for something
      // the member really did would be a lie in the other direction.
      status: isClaimed ? 'claimed' : done ? 'claimable' : 'open',
      isNew: isNewer(quest.since, progress.seenVersion ?? '0')
    }
  })
  const xp = quests
    .filter((quest) => quest.status === 'claimed')
    .reduce((sum, quest) => sum + quest.reward.xp, 0)
  const total = quests.reduce((sum, quest) => sum + quest.reward.xp, 0)
  const main = quests.filter((quest) => quest.line === 'main')
  return {
    version,
    level: levelFor(xp),
    totalXp: total,
    quests,
    chapters: CHAPTERS.map((chapter) => {
      const own = quests.filter((quest) => quest.chapter === chapter.key)
      return {
        ...chapter,
        quests: own.map((quest) => quest.id),
        done: own.filter((quest) => quest.done).length,
        total: own.length
      }
    }),
    claimable: quests.filter((quest) => quest.status === 'claimable').map((quest) => quest.id),
    // The next thing to do: first unfinished main-line quest in catalogue
    // order, and only then a side quest. Order is the teaching.
    next:
      main.find((quest) => !quest.done)?.id ??
      quests.find((quest) => !quest.done)?.id ??
      quests.find((quest) => quest.status === 'claimable')?.id ??
      null,
    progress: {
      main: { done: main.filter((quest) => quest.done).length, total: main.length },
      all: { done: quests.filter((quest) => quest.done).length, total: quests.length }
    },
    changelog,
    newQuests: quests.filter((quest) => quest.isNew).map((quest) => quest.id),
    seenVersion: progress.seenVersion ?? null,
    caveats: [
      '平台状态（应用、计划、执行机、执行结果、配置）是整个部署共享的；任务历史、上报与领取记录按人保存。',
      '标注「界面上报」的任务由工作台报告，服务端无法独立验证，只记录名称与时间。',
      '等级与经验只是进度，不解锁任何权限；权限仍然只有 viewer / operator / admin，由 Internal 判定。'
    ]
  }
}

/** Guard for the claim route: only a verified, unclaimed quest may be taken. */
export function questById(id, catalogue = QUESTS) {
  return catalogue.find((quest) => quest.id === id) ?? null
}

export const QUEST_IDS = QUESTS.map((quest) => quest.id)

// A catalogue typo would be invisible until someone opened the page, and the
// page is the one place this product cannot afford to be vague.
for (const quest of QUESTS) {
  if (!CHAPTER_KEYS.has(quest.chapter)) throw new Error(`未知章节 ${quest.chapter}`)
  if (!['platform', 'signal'].includes(quest.evidence))
    throw new Error(`任务 ${quest.id} 的证据来源无效`)
}
if (new Set(QUEST_IDS).size !== QUEST_IDS.length) throw new Error('任务 ID 重复')
