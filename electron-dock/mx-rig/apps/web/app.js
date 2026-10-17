import * as views from './views.js'
import { h } from './views.js'
import { live, pushFrame } from './activity.js'
import { routeAction } from './routes.js'

const $ = (id) => document.getElementById(id)
const native = Boolean(window.mxRig?.desktop)

// One table for both surfaces: the browser turns an action into a same-origin
// request, the desktop hands the same action to the main process, which owns
// the bearer token. The renderer never sees a credential either way.
const GET_ROUTES = {
  'auth-methods': '/api/rig/v1/auth-methods',
  me: '/api/rig/v1/me',
  config: '/api/rig/v1/config',
  tools: '/api/rig/v1/tools',
  graph: '/api/rig/v1/graph',
  egress: '/api/rig/v1/egress',
  missions: '/api/rig/v1/missions',
  insights: '/api/rig/v1/insights',
  system: '/api/rig/v1/system',
  'admin-config': '/api/rig/v1/admin/config',
  tasks: '/api/v1/tasks',
  runs: '/api/v1/runs?limit=20',
  apps: '/api/v1/apps',
  members: '/api/v1/members',
  runners: '/api/v1/runners',
  procedures: '/api/rig/v1/procedures',
  'procedure-tasks': '/api/rig/v1/procedure-tasks',
  hooks: '/api/rig/v1/hooks',
  'tour-videos': '/api/rig/v1/tour-videos'
}
const POST_ROUTES = {
  login: '/api/rig/v1/login',
  logout: '/api/rig/v1/logout',
  'change-password': '/api/v1/auth/password',
  'save-config': '/api/rig/v1/admin/config',
  probe: '/api/rig/v1/admin/providers:probe',
  'preview-orchestration': '/api/rig/v1/admin/orchestrations:preview',
  'activate-egress': '/api/rig/v1/admin/egress:activate',
  'plan-dispatch': '/api/rig/v1/dispatch:plan',
  'draft-flight-plan': '/api/rig/v1/flight-plans:draft',
  'system-signal': '/api/rig/v1/system/signal',
  'system-claim': '/api/rig/v1/system/claim',
  'system-seen': '/api/rig/v1/system/seen',
  start: '/api/rig/v1/missions',
  'project-create': '/api/v1/apps',
  'test-task-create': '/api/rig/v1/test-tasks',
  'procedure-create': '/api/rig/v1/procedures',
  'procedure-capture': '/api/rig/v1/procedures:capture',
  'procedure-task-create': '/api/rig/v1/procedure-tasks',
  'cases-import': '/api/rig/v1/cases:import',
  'hooks-save': '/api/rig/v1/hooks',
  'hooks-tick': '/api/rig/v1/hooks:tick'
}
const MISSION_ACTIONS = ['approve', 'cancel', 'followup']

const PAGES = [
  {
    label: '项目与任务',
    items: [
      {
        id: 'projects',
        glyph: '▣',
        title: '项目与任务',
        sub: '测试任务、用例库、计划与执行',
        kicker: 'TEST WORKSPACE'
      },
      {
        id: 'overview',
        glyph: '◉',
        title: '总览',
        sub: '状态、下一步与最近执行',
        kicker: 'MISSION CONTROL'
      },
      {
        id: 'missions',
        glyph: '◈',
        title: 'Agent 会话',
        sub: '独立的 Agent 对话、测试工作流与编排',
        kicker: 'AGENT SESSIONS'
      },
      {
        id: 'system',
        glyph: '⬢',
        title: '系统',
        sub: '教学任务、等级与版本更新',
        kicker: 'THE SYSTEM'
      }
    ]
  },
  {
    label: '测试',
    items: [
      {
        id: 'report',
        glyph: '◎',
        title: '质量报告',
        sub: '趋势、风险与覆盖，可直接汇报',
        kicker: 'QUALITY REPORT'
      },
      {
        id: 'tests',
        glyph: '▤',
        title: '执行记录',
        sub: '全部项目的执行计划与执行',
        kicker: 'EXECUTIONS'
      },
      {
        id: 'procedures',
        glyph: '⟲',
        title: '试验规程',
        sub: 'Agent 写、机器跑、失败时修正',
        kicker: 'TEST PROCEDURES'
      },
      {
        id: 'runners',
        glyph: '⌂',
        title: '执行机与工位',
        sub: '接入电脑、本机托管、在线状态',
        kicker: 'RUNNERS & STATIONS'
      },
      {
        id: 'guide',
        glyph: '✦',
        title: '新手引导',
        sub: '第一次跑测试看这里',
        kicker: 'GETTING STARTED'
      }
    ]
  },
  {
    label: 'AGENT 中心',
    items: [
      {
        id: 'agents',
        glyph: '◇',
        title: 'Agent 市场',
        sub: '可编辑、可观测的 Agent',
        kicker: 'AGENT MARKET'
      },
      {
        id: 'providers',
        glyph: '⌬',
        title: '模型 Provider',
        sub: '调用序列与连通性',
        kicker: 'MODEL ROUTING'
      },
      {
        id: 'orchestration',
        glyph: '⚿',
        title: '编排中心',
        sub: '可视化编排：节点、分支与暂停点',
        kicker: 'ORCHESTRATION'
      },
      {
        id: 'hooks',
        glyph: '⚓',
        title: '钩子',
        sub: '失败时自动定级、自动修正',
        kicker: 'HOOKS'
      },
      {
        id: 'channels',
        glyph: '✉',
        title: '通知渠道',
        sub: '飞书、企业微信与 Webhook',
        kicker: 'NOTIFICATIONS'
      },
      {
        id: 'tools',
        glyph: '⌘',
        title: '工具与边界',
        sub: '工具集与允许列表',
        kicker: 'CAPABILITIES'
      },
      {
        id: 'egress',
        glyph: '⇄',
        title: '出网与通道',
        sub: '真实出网情况与 Rig 自己的通道',
        kicker: 'SYSTEM EGRESS'
      }
    ]
  },
  {
    label: '管理',
    items: [
      {
        id: 'members',
        glyph: '☺',
        title: '账号与成员',
        sub: '新建账号、重置密码、停用与权限',
        kicker: 'ACCOUNTS'
      },
      {
        id: 'settings',
        glyph: '⚙',
        title: 'Internal 配置',
        sub: '策略、Provider 与 Agent',
        kicker: 'SOURCE OF TRUTH'
      },
      {
        id: 'audit',
        glyph: '⌕',
        title: '审计',
        sub: '谁在什么时候改了什么',
        kicker: 'AUDIT TRAIL'
      }
    ]
  }
]
const PAGE_BY_ID = new Map(PAGES.flatMap((group) => group.items).map((item) => [item.id, item]))
const TERMINAL = new Set(['completed', 'failed', 'blocked', 'cancelled'])

const state = {
  native,
  principal: null,
  config: null,
  categories: {},
  tools: [],
  toolGroups: {},
  nodeTypes: {},
  flightVocab: { stages: {}, gateMetrics: {}, preflightChecks: {} },
  // A drafted flight plan waiting to be reviewed; never run on its own.
  flightDraft: null,
  graph: null,
  orchestration: { selected: 'mission', graph: null, preview: null, draft: null, error: null },
  missions: [],
  tasks: [],
  selected: null,
  agentKey: null,
  mode: 'agent',
  draft: '',
  pendingTask: null,
  view: 'projects',
  // The run whose detail the current page shows (run-detail.js), or null.
  runDetail: null,
  reportView: 'summary',
  navExpanded: {},
  window: 14,
  insights: null,
  // The system layer: quest states, level, and the floating panel's visibility.
  system: null,
  hud: false,
  // A parsed one-liner waiting to be confirmed. Never executed on its own.
  plan: null,
  polling: false,
  scroll: {},
  // Launcher mode: the desktop's overseas channel (docs/25 P3), or null.
  oversea: null
}

const REPORT_VIEW_KEY = 'mx-rig.report-view'
const WINDOW_KEY = 'mx-rig.window'
const HUD_KEY = 'mx-rig.hud'
try {
  const savedView = localStorage.getItem(REPORT_VIEW_KEY)
  if (savedView && Object.hasOwn(views.REPORT_VIEWS, savedView)) state.reportView = savedView
  const savedWindow = Number(localStorage.getItem(WINDOW_KEY))
  if ([7, 14, 30].includes(savedWindow)) state.window = savedWindow
  state.hud = localStorage.getItem(HUD_KEY) === 'on'
} catch {
  // Private windows and blocked site data are normal; the defaults are fine.
}

async function api(action, body) {
  if (native) return window.mxRig.request(action, body)
  if (action === 'project-access' || action === 'project-access-save') {
    const { app, ...input } = body
    const path = `/api/v1/apps/${encodeURIComponent(app)}/access`
    return action === 'project-access' ? request('GET', path) : request('POST', path, input)
  }
  if (['task-implementation', 'task-implementation-save', 'task-implementation-approve'].includes(action)) {
    const { id, ...input } = body
    const base = `/api/rig/v1/missions/${encodeURIComponent(id)}/implementation`
    if (action === 'task-implementation') return request('GET', base + (input.revision ? `?revision=${encodeURIComponent(input.revision)}` : ''))
    return request('POST', base + (action === 'task-implementation-approve' ? ':approve' : ''), input)
  }
  if (['task-executions', 'task-execution-plan', 'task-execution-dispatch'].includes(action)) {
    const { id, ...input } = body
    const base = `/api/rig/v1/missions/${encodeURIComponent(id)}/executions`
    return action === 'task-executions' ? request('GET', base + (input.runId ? `?run=${encodeURIComponent(input.runId)}` : ''))
      : request('POST', base + (action === 'task-execution-plan' ? ':plan' : ':dispatch'), input)
  }
  if (['task-cases', 'task-cases-save', 'task-cases-confirm'].includes(action)) {
    const base = `/api/rig/v1/missions/${encodeURIComponent(body.id)}/cases`
    if (action === 'task-cases') return request('GET', base + (body.revision ? `?revision=${encodeURIComponent(body.revision)}` : ''))
    return request('POST', base + (action === 'task-cases-confirm' ? ':confirm' : ''), {
      expectedRevision: body.expectedRevision,
      ...(action === 'task-cases-save' ? { cases: body.cases } : {})
    })
  }
  if (action === 'orchestration-graph')
    return request('GET', `/api/rig/v1/graph?orchestration=${encodeURIComponent(body.key)}`)
  if (action === 'insights')
    return request(
      'GET',
      `/api/rig/v1/insights?window=${encodeURIComponent(body?.window ?? 14)}&timezone=${encodeURIComponent(
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      )}`
    )
  if (action === 'export')
    return request('GET', `/api/rig/v1/missions/${encodeURIComponent(body.id)}/export`)
  // Project and administration actions: one table with the desktop (routes.js).
  const routed = routeAction(action, body)
  if (routed) return request(routed.method, routed.path, routed.method === 'GET' || routed.method === 'DELETE' ? undefined : routed.body)
  // 试验规程. Replays and repairs drive a browser, which only the desktop has.
  if (
    action === 'procedure-fire' ||
    action === 'procedure-repair' ||
    action === 'procedure-fire-all'
  )
    throw new Error('试车与修正在 MX Rig 桌面端进行')
  if (action === 'procedure-task-run')
    return request('POST', `/api/rig/v1/procedure-tasks/${encodeURIComponent(body.id)}:run`, {})
  if (action.startsWith('station-')) throw new Error('本机工位值守在 MX Rig 桌面端进行')
  if (action.startsWith('procedure-') || action === 'procedure') {
    const id = encodeURIComponent(body?.id)
    if (action === 'procedure') return request('GET', `/api/rig/v1/procedures/${id}`)
    if (action === 'procedure-revise')
      return request('POST', `/api/rig/v1/procedures/${id}:revise`, {
        expectedRevision: body.expectedRevision,
        procedure: body.procedure,
        reason: body.reason
      })
    if (action === 'procedure-status')
      return request('POST', `/api/rig/v1/procedures/${id}:status`, { status: body.status })
    if (action === 'procedure-decide')
      return request(
        'POST',
        `/api/rig/v1/procedures/${id}/proposals/${encodeURIComponent(body.proposalId)}:decide`,
        { approved: body.approved }
      )
  }
  if (MISSION_ACTIONS.includes(action)) {
    const { id, ...rest } = body
    return request('POST', `/api/rig/v1/missions/${encodeURIComponent(id)}/${action}`, rest)
  }
  if (Object.hasOwn(POST_ROUTES, action)) return request('POST', POST_ROUTES[action], body ?? {})
  if (Object.hasOwn(GET_ROUTES, action)) return request('GET', GET_ROUTES[action])
  throw new Error(`未知动作 ${action}`)
}

async function request(method, path, body) {
  const response = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`)
  return result
}

function notice(message, tone = 'info') {
  const box = $('notice')
  box.textContent = message
  box.hidden = !message
  box.classList.toggle('rig-notice--error', Boolean(message) && tone === 'error')
}

async function run(work) {
  try {
    notice('')
    return await work()
  } catch (error) {
    notice(error.message, 'error')
  }
}

function openPath(path) {
  if (/^\/api\/v1\/runs\/[^/]+\/report$/.test(path)) signal('opened_run_report')
  if (native) return run(() => api('open-path', { path }))
  window.open(path, '_blank', 'noopener')
}

const ctx = {
  state,
  api,
  run,
  notice,
  openPath,
  go,
  refresh,
  render,
  toolTitle: (name) => state.tools.find((tool) => tool.name === name)?.title ?? name,
  toolEffect: (name) => state.tools.find((tool) => tool.name === name)?.effect ?? 'read',
  selectOrchestration,
  previewOrchestration,
  saveOrchestration,
  moveNode,
  setReportView,
  setWindow,
  copyReport,
  triageCase,
  analyzeRun,
  signal,
  claimQuest,
  toggleHud,
  planDispatch,
  clearPlan,
  activateEgress,
  saveEgress,
  oversea: async (action, body) => {
    state.oversea = await api(action, body)
    paintNetworkChip()
    if (state.view === 'egress') await render()
  },
  canRun: () => ['operator', 'admin'].includes(state.principal?.role)
}

function remember(key, value) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // A remembered preference is a convenience, never a requirement.
  }
}

function setReportView(view) {
  if (!Object.hasOwn(views.REPORT_VIEWS, view)) return
  state.reportView = view
  remember(REPORT_VIEW_KEY, view)
  signal('report_view_changed')
  render()
}

// -- the system layer ----------------------------------------------------------

// Page visits the workbench is allowed to report. Everything else about a
// quest is read from platform state on the server; these three are things the
// server genuinely cannot see.
const VIEW_SIGNALS = { tools: 'opened_tools', egress: 'opened_egress' }
const reported = new Set()

/**
 * Tell the server the member did something it cannot observe.
 *
 * Fire-and-forget, once per session per name, and never a reason for the page
 * to show an error: a tutorial that interrupts the work it is teaching has the
 * priorities backwards.
 */
async function signal(name) {
  if (!name || reported.has(name) || !state.principal) return
  reported.add(name)
  try {
    const { system } = await api('system-signal', { signal: name })
    state.system = system
    renderHud()
  } catch {
    reported.delete(name)
  }
}

async function claimQuest(id) {
  const { system } = await api('system-claim', { questId: id })
  state.system = system
  notice(`已领取「${system.quests.find((quest) => quest.id === id)?.title ?? id}」的奖励。`)
  await render()
}

function toggleHud(on = !state.hud) {
  state.hud = on
  remember(HUD_KEY, on ? 'on' : 'off')
  if (on) signal('hud_opened')
  renderHud()
}

async function refreshSystem() {
  const { system } = await api('system')
  state.system = system
  // Mark the catalogue version as seen only once its new quests have actually
  // been on screen; otherwise "有更新" would clear itself in the background.
  return system
}

/**
 * The floating teaching panel.
 *
 * Lives outside `#view`, so it survives every redraw and every page change —
 * the point of it is to follow the reader around while they do the steps.
 */
function renderHud() {
  const box = $('hud')
  if (!box) return
  const toggle = $('hud-toggle')
  if (toggle) {
    const pending = state.system?.claimable.length ?? 0
    toggle.textContent = pending ? `⬢ 系统 · ${pending}` : '⬢ 系统'
    toggle.classList.toggle('is-active', state.hud)
  }
  box.hidden = !state.hud || !state.principal
  if (box.hidden) return
  box.replaceChildren(views.hudPanel(ctx))
}

function setWindow(days) {
  state.window = days
  remember(WINDOW_KEY, days)
  render()
}

/**
 * The report as plain text, for pasting into whatever the team actually uses.
 *
 * Every figure carries its denominator, and "no samples" stays "—": a weekly
 * update that rounds an empty week up to 100% is worse than no update.
 */
function reportText(insights) {
  const percent = (value) =>
    value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`
  const v = insights.verdicts
  const lines = [
    `MX Rig 质量周报（最近 ${insights.window.days} 天，${insights.window.timeZone}）`,
    `生成于 ${new Date(insights.window.to).toLocaleString()}`,
    '',
    `通过率 ${percent(v.passRate)}（${v.passed}/${v.judged} 次有结论的执行）`,
    `受阻 ${v.blocked} 次——环境没跑起来，不代表产品有问题`,
    `不稳定用例 ${insights.cases.unstable.length} 条，连续失败 ${insights.cases.alwaysFailing.length} 条`,
    `P0 自动化 ${insights.coverage.p0.automated}/${insights.coverage.p0.total}，执行机在线 ${insights.fleet.online}/${insights.fleet.registered}`
  ]
  if (insights.risks.length) {
    lines.push('', '要先处理的：')
    for (const risk of insights.risks.slice(0, 5))
      lines.push(`- [${risk.level}] ${risk.title}：${risk.detail}`)
  }
  // Agent work gets its own lines, labelled for what it is.
  const agents = insights.missions
  if (agents?.total) {
    lines.push(
      '',
      `Agent 任务 ${agents.total} 项（服务端 ${agents.bySurface.internal}，桌面 ${agents.bySurface.desktop}）`
    )
    if (agents.findings.total) {
      const verdicts = Object.entries(agents.findings.byVerdict)
        .filter(([, count]) => count > 0)
        .map(([verdict, count]) => `${views.VERDICT_TEXT[verdict]?.label ?? verdict} ${count}`)
        .join('，')
      lines.push(
        `Agent 结论 ${agents.findings.total} 条：${verdicts}${
          agents.findings.unverified
            ? `；其中 ${agents.findings.unverified} 条引用未核实，需要复核`
            : ''
        }（Agent 的判断，不是测试结论）`
      )
    }
    if (agents.assertions.total)
      lines.push(
        `页面断言通过 ${percent(agents.assertions.passRate)}（${agents.assertions.passed}/${agents.assertions.total}）`
      )
    if (agents.usage?.calls)
      lines.push(
        `模型用量 ${agents.usage.promptTokens + agents.usage.completionTokens} tokens，${agents.usage.calls} 次调用${
          agents.usage.estimated ? `（${agents.usage.estimated} 项任务含估算）` : ''
        }`
      )
  }
  lines.push('', '口径：' + insights.caveats.join(' '))
  return lines.join('\n')
}

async function copyReport(insights, button) {
  const text = reportText(insights)
  signal('copied_report')
  try {
    await navigator.clipboard.writeText(text)
    notice('周报已复制到剪贴板。')
  } catch {
    // Clipboard access can be refused; showing the text still gets the job done.
    if (button) button.disabled = true
    state.reportText = text
    notice('剪贴板不可用，已把周报显示在页面底部，可以手动复制。')
  }
  await render()
}

// -- conversational dispatch ---------------------------------------------------

/**
 * Parse a sentence into candidate missions.
 *
 * The result is a proposal, not an action: `plan.proposals[n].body` is exactly
 * the request the composer would post, and it is only posted when the reader
 * presses confirm on that proposal.
 */
async function planDispatch(text) {
  state.plan = null
  const { plan } = await api('plan-dispatch', { text })
  state.plan = plan
  signal('dispatch_planned')
  await render()
}

function clearPlan() {
  state.plan = null
  render()
}

/**
 * Save the channel list.
 *
 * Posts the whole admin config back, the way the settings page does: one
 * writer, one validation path, one new policy revision.
 */
async function saveEgress(profiles, activeId = null) {
  const current = await api('admin-config')
  state.config = await api('save-config', {
    maxTurns: current.maxTurns,
    allowedTools: current.allowedTools,
    browserOrigins: current.browserOrigins,
    providers: current.providers,
    sequence: current.sequence,
    agents: current.agents,
    orchestrations: current.orchestrations.map(stripServerFields),
    egress: { activeId, profiles }
  })
  notice('出网通道已保存。通道只作用于 Rig 自己的模型调用与隔离浏览器。')
  await render()
}

async function activateEgress(activeId) {
  await api('activate-egress', { activeId: activeId ?? null })
  state.config = await api('config')
  notice(
    activeId
      ? '已切换出网通道。下一次模型调用立即生效；隔离浏览器会在下一次打开页面时重开。'
      : '已改为直连。已发出的待确认动作会因策略版本变化失效，需要重新发起。'
  )
  await render()
}

/** Jump straight from a suspicious case into the Agent that grades failures. */
function triageCase(row) {
  state.agentKey = 'failure-triage'
  state.mode = 'agent'
  state.selected = null
  state.draft = `用例 ${row.caseId} 在最近 ${row.runs} 次执行里失败 ${row.failed + row.flaky} 次${
    row.lastRunId ? `，最近一次是 ${row.lastRunId}` : ''
  }。读证据后给出定级和下一步。`
  go('missions')
}

/**
 * 让 Agent 分析这次执行 (docs/23 M7c): a finished run handed to the Agent
 * that grades failures, or to the result analyst when nothing failed, with
 * the release question asked outright. The draft waits for the person to start it.
 */
function analyzeRun(run, { app, task } = {}) {
  const failing = ['failed', 'blocked', 'flaky'].includes(run.status)
  state.agentKey = failing ? 'failure-triage' : 'result-analyst'
  state.mode = 'agent'
  state.selected = null
  const source = run.sourceRef?.version ?? run.sourceRef?.ref ?? null
  state.draft = [
    `分析执行 ${run.id}（${app?.displayName ?? run.appId ?? '项目'}${task?.name ? `，计划「${task.name}」` : ''}${source ? `，测试版本 ${source}` : ''}）。`,
    failing
      ? '逐条看失败和受阻的用例：步骤、截图、录像和执行机日志，判断是产品缺陷、环境受阻、用例问题还是不稳定，附证据。'
      : '确认每条用例的结论都有证据支撑，指出覆盖不到的地方。',
    '最后单独给出「能不能上线」的建议和理由；拿不准的写明缺什么证据。只读取，不派发、不取消任何执行。'
  ].join('\n')
  go('missions')
}

/**
 * Pin one node where the author dropped it.
 *
 * Positions live on the draft, so a move is an unsaved edit like any other —
 * it shows in the preview immediately and only reaches Internal on save.
 */
function moveNode(name, at) {
  const store = state.orchestration
  if (!store.draft) return
  store.draft.layout = { ...(store.draft.layout ?? {}), [name]: at }
  previewOrchestration(store.draft)
}

// -- orchestration centre actions ---------------------------------------------

async function selectOrchestration(key) {
  const store = state.orchestration
  // Switching away abandons an unsaved draft rather than silently carrying it
  // onto a different spec.
  Object.assign(store, { selected: key, preview: null, draft: null, error: null })
  await run(async () => {
    store.graph =
      key === 'mission' ? state.graph : (await api('orchestration-graph', { key })).graph
  })
  await render()
}

async function previewOrchestration(draft) {
  const store = state.orchestration
  store.error = null
  try {
    // The server compiles the draft and hands back the real shape, so the
    // picture an author checks is the one the runtime would execute.
    store.preview = await api('preview-orchestration', { orchestration: stripDraft(draft) })
    notice(
      store.preview.warnings?.length
        ? store.preview.warnings.join('；')
        : '草稿可以编译，上方已换成草稿预览。'
    )
  } catch (error) {
    store.preview = null
    store.error = error.message
    // The graph is at the top of the page and the editor at the bottom; a
    // failure that only prints next to the button looks like nothing happened.
    notice(error.message, 'error')
  }
  await render()
}

async function saveOrchestration(draft) {
  const current = await api('admin-config')
  const next = current.orchestrations.map((entry) =>
    entry.key === draft.key ? stripDraft(draft) : stripServerFields(entry)
  )
  state.config = await api('save-config', {
    maxTurns: current.maxTurns,
    allowedTools: current.allowedTools,
    browserOrigins: current.browserOrigins,
    providers: current.providers,
    sequence: current.sequence,
    agents: current.agents,
    orchestrations: next
  })
  Object.assign(state.orchestration, { draft: null, preview: null, error: null })
  state.orchestration.graph = (await api('orchestration-graph', { key: draft.key })).graph
  notice('编排已保存。正在运行的任务仍按它启动时的那一版执行。')
  await render()
}

/** Fields the server derives; posting them back would be noise, not intent. */
function stripServerFields(spec) {
  const { builtin, warnings, missingTools, nextFireAt, ...rest } = spec
  return rest
}
const stripDraft = stripServerFields

let navSignature = ''

/**
 * Rebuild the sidebar only when it would actually look different.
 *
 * The page polls, and rebuilding this subtree every couple of seconds replaces
 * the very buttons a reader is aiming at: a click that lands between the hit
 * test and the rebuild hits a node that no longer exists, and hover and focus
 * are lost each time. The signature covers everything the sidebar draws.
 */
function renderNav() {
  const nav = $('nav')
  const signature = JSON.stringify([
    state.view,
    state.principal?.role,
    state.selected,
    state.missions.map((row) => `${row.id}:${row.status}:${row.goal}`)
  ])
  if (signature === navSignature && nav.childElementCount) return
  navSignature = signature
  nav.replaceChildren()
  const pageButton = (id) => {
    const item = PAGE_BY_ID.get(id)
    return h('button', {
      class: `rig-nav__item ${state.view === id ? 'is-active' : ''}`,
      type: 'button',
      'data-nav': id,
      'aria-current': state.view === id ? 'page' : null,
      onclick: () => {
        state.runDetail = null
        go(id)
      }
    }, h('span', { class: 'rig-nav__glyph', text: item.glyph }),
    h('span', {}, h('span', { text: item.title }), h('span', { class: 'rig-nav__sub', text: item.sub })))
  }
  nav.append(pageButton('projects'))
  nav.append(h('p', { class: 'rig-nav__label', text: '最近任务' }))
  const list = h('div', { class: 'rig-missions' })
  for (const row of state.missions.slice(0, 12))
    list.append(
      h(
        'button',
        {
          class: `rig-mission-item ${row.id === state.selected ? 'is-active' : ''}`,
          type: 'button',
          title: row.goal,
          onclick: () => {
            if (state.selected === row.id && state.view === 'projects') return
            state.selected = row.id
            if (row.workbench) {
              state.projectSlug = row.workbench.appSlug
              state.projectTask = row.id
              state.projectTab = 'tasks'
              state.testTab = 'cases'
              go('projects')
            } else go('missions')
          }
        },
        h('span', { text: row.goal }),
        h('small', {
          text: `${row.workbench ? row.workbench.displayName + ' · ' : ''}${row.surface === 'desktop' ? (row.client === 'terminal' ? '终端 · ' : '桌面 · ') : ''}${
            row.mode === 'agent'
              ? 'AGENT'
              : row.mode === 'workflow'
                ? 'WORKFLOW'
                : row.flight
                  ? 'FLIGHT'
                  : 'ORCHESTRATION'
          } · ${views.missionStatusText(row)}`
        })
      )
    )
  nav.append(
    state.missions.length ? list : h('p', { class: 'qp-caption qp-muted', text: '还没有任务' })
  )
  // docs/21 §4: projects first; quality across projects; capabilities; the
  // deployment's own administration; help.
  for (const group of [
    { id: 'quality', title: '质量', pages: ['overview', 'report'] },
    { id: 'execution', title: '执行', pages: ['tests', 'procedures', 'runners'] },
    { id: 'capabilities', title: '能力与配置', pages: ['missions', 'agents', 'providers', 'orchestration', 'hooks', 'channels', 'tools', 'egress'] },
    { id: 'admin', title: '管理', pages: ['members', 'settings', 'audit'] },
    { id: 'help', title: '帮助', pages: ['guide', 'system'] }
  ]) {
    const adminOnly = new Set(['members', 'settings', 'audit'])
    const pages = group.pages.filter((id) => !adminOnly.has(id) || state.principal?.role === 'admin')
    if (!pages.length) continue
    // Remembered on the click itself: `toggle` fires a task later, and a poll
    // that redraws the nav in between would rebuild the group closed under
    // the reader's hand.
    const summary = h('summary', { text: group.title })
    summary.onclick = () => { state.navExpanded[group.id] = !details.open }
    const details = h('details', { class: 'rig-nav__group', 'data-nav-group': group.id }, summary, ...pages.map(pageButton))
    details.open = pages.includes(state.view) || Boolean(state.navExpanded[group.id])
    details.ontoggle = () => { state.navExpanded[group.id] = details.open }
    nav.append(details)
  }

}

function go(view) {
  // A run's detail belongs to the page it was opened on.
  if (view !== state.view) state.runDetail = null
  state.view = view
  return render()
}

let renderToken = 0

/**
 * Draw the current view.
 *
 * The page polls, so most renders replace content the reader is already
 * looking at. Three things follow from that: the old content stays on screen
 * while the new one loads (a spinner every 2.5 seconds is a flicker, not
 * feedback), the scroll position and caret are restored afterwards, and a
 * slow fetch that finishes after the reader has moved on is discarded.
 */
async function render() {
  const page = PAGE_BY_ID.get(state.view) ?? PAGE_BY_ID.get('overview')
  $('view-kicker').textContent = page.kicker
  $('view-title').textContent = page.title
  $('view-note').textContent = page.sub
  renderNav()
  const mount = $('view')
  const token = ++renderToken
  const first = mount.dataset.view !== page.id
  if (first) mount.replaceChildren(h('div', { class: 'qp-spinner', 'aria-label': '加载中' }))
  mount.setAttribute('aria-busy', 'true')

  const typing = document.activeElement
  const caret =
    typing?.id === 'goal' ? { start: typing.selectionStart, end: typing.selectionEnd } : null
  const scrollTop = first ? 0 : mount.scrollTop

  try {
    const fragment = document.createElement('div')
    await views[page.id](ctx, fragment)
    // A view the reader has already left must not paint over the new one.
    if (token !== renderToken) return
    mount.replaceChildren(...fragment.childNodes)
    mount.dataset.view = page.id
    mount.scrollTop = scrollTop
    if (caret) {
      const goal = $('goal')
      if (goal) {
        goal.focus()
        goal.setSelectionRange(caret.start, caret.end)
      }
    }
  } catch (error) {
    if (token !== renderToken) return
    mount.replaceChildren(h('div', { class: 'rig-empty qp-body-2', text: error.message }))
    mount.dataset.view = page.id
  } finally {
    if (token === renderToken) mount.removeAttribute('aria-busy')
  }
  renderHud()
  if (Object.hasOwn(VIEW_SIGNALS, page.id)) signal(VIEW_SIGNALS[page.id])
}

async function refresh() {
  if (!state.principal || state.polling) return
  state.polling = true
  try {
    const { missions } = await api('missions')
    const changed = JSON.stringify(missions) !== JSON.stringify(state.missions)
    state.missions = missions
    // Case forms retain the user's in-progress edits while the Agent updates its transcript.
    if (changed) {
      renderNav()
      if (!(state.view === 'projects' && state.testTab !== 'conversation')) await render()
    }
  } finally {
    state.polling = false
  }
}

async function enter(principal) {
  state.principal = principal
  $('login').hidden = true
  $('workspace').hidden = false
  // A download may already be under way (it starts with the Runtime).
  if (native) api('browser-status').then(showProvision).catch(() => {})
  $('member').textContent = principal.displayName || principal.id || principal.principalId || ''
  $('member-role').textContent =
    { admin: '管理员', operator: '操作员', viewer: '只读' }[principal.role] ??
    principal.role ??
    ''
  $('surface').textContent = native ? 'DESKTOP · 本地 Runtime' : 'INTERNAL · Web 工作台'
  // Only a Rig account has a password Rig can change; Launcher accounts and
  // the service admin token are managed where they come from.
  $('change-password').hidden = principal.kind !== 'local'
  const [config, graph, catalogue] = await Promise.all([
    api('config'),
    api('graph').catch(() => ({ graph: null, nodeTypes: {} })),
    api('tools').catch(() => ({ tools: [], groups: {}, categories: {} }))
  ])
  state.config = config
  state.graph = graph.graph
  state.nodeTypes = graph.nodeTypes ?? {}
  state.flightVocab = graph.flight ?? { stages: {}, gateMetrics: {}, preflightChecks: {} }
  state.orchestration.graph = graph.graph
  state.tools = catalogue.tools ?? []
  state.toolGroups = catalogue.groups ?? {}
  state.categories = catalogue.categories ?? {}
  const { missions } = await api('missions')
  state.missions = missions
  const { tasks = [] } = await api('tasks').catch(() => ({ tasks: [] }))
  state.tasks = tasks
  // The system layer must never keep someone out of the workbench: a failure
  // here leaves the panel empty and everything else working.
  await refreshSystem().catch(() => {})
  if (native) signal('desktop_login')
  await render()
  if (principal.mustChangePassword)
    notice('你正在使用管理员发放的一次性密码，请点左下角「修改密码」换成只有你知道的密码。')
}

$('server-field').hidden = !native
$('private-http-field').hidden = !native
$('server').required = native
// The address this build was made for, or the one that worked last time.
// An asynchronous preference read must not replace what the person has typed.
let serverEdited = false
let privateHttpEdited = false
$('server').addEventListener('input', () => { serverEdited = true })
$('private-http').addEventListener('change', () => { privateHttpEdited = true })
if (native)
  api('login-defaults')
    .then((defaults) => {
      if (!serverEdited) $('server').value = defaults.server
      if (!privateHttpEdited) $('private-http').checked = defaults.privateHttp === true
      if (defaults.account && !$('account').value) $('account').value = defaults.account
      if (defaults.launcher) showNetwork(defaults.launcher)
      // What this service's login page offers (browser SSO, docs/25 P4).
      refreshAuthMethods()
    })
    .catch(() => {})

/**
 * Launcher mode (docs/25 §3): the desktop's own product network. Signing in
 * waits for it; the address is the product's VIP, so there is none to type.
 */
const NETWORK_BUSY = new Set(['resolving', 'enrolling', 'applying', 'disconnecting'])
let loginPending = false
let networkActionPending = false
let lastNetwork = null
function loginBlocked() {
  return loginPending || networkActionPending || Boolean(lastNetwork && (lastNetwork.status !== 'ready' || lastNetwork.serverReachable === false))
}
function updateLoginControls() {
  $('login-form').querySelector('button[type=submit]').disabled = loginBlocked()
  $('sso-login').disabled = loginBlocked()
  const networkBusy = loginPending || networkActionPending || NETWORK_BUSY.has(lastNetwork?.status)
  $('network-connect').disabled = networkBusy
  $('network-disconnect').disabled = networkBusy
  $('network-recover').disabled = networkBusy || lastNetwork?.recoveryAvailable !== true
}
function showNetwork(snap) {
  if (!snap) return
  $('network-panel').hidden = false
  $('server-field').hidden = true
  $('private-http-field').hidden = true
  $('server').required = false
  if (snap.serverUrl) $('server').value = snap.serverUrl
  $('login-hint').textContent = '用平台统一账号登录（和 MX-H2I、Hub 是同一个）。账号密码只经 MX Rig 自己的隧道交给服务端，不经过公网。'
  const status = $('network-status')
  status.textContent = snap.statusText
  status.dataset.status = snap.status
  $('network-message').textContent = snap.message || (snap.status === 'idle' ? '连上内网后才能登录。' : '')
  $('network-first').hidden = snap.connectedOnce || snap.status !== 'idle'
  const busy = NETWORK_BUSY.has(snap.status)
  const connect = $('network-connect')
  connect.hidden = (snap.status === 'ready' && snap.serverReachable !== false) || busy
  connect.textContent = snap.status === 'idle' && !snap.connectedOnce ? '连接内网' : '重新连接'
  $('network-disconnect').hidden = snap.status !== 'ready'
  $('network-recover').hidden = snap.recoveryAvailable !== true
  $('network-recovery-hint').hidden = snap.recoveryAvailable !== true
  const becameReady = snap.status === 'ready' && lastNetwork?.status !== 'ready'
  lastNetwork = snap
  updateLoginControls()
  paintNetworkChip()
  // The service is reachable now: ask what its login page offers.
  if (becameReady) refreshAuthMethods()
}
function paintNetworkChip() {
  const snap = lastNetwork
  if (!snap) return
  const chip = $('network-chip')
  chip.hidden = false
  chip.dataset.status = snap.status
  const overseas = state.oversea?.usingBrowser ? ' · 海外' : ''
  chip.textContent = snap.status === 'ready' ? `内网 · ${snap.identity.kind === 'user' ? '用户网络' : '匿名'}${overseas}` : `内网 · ${snap.statusText}`
  chip.title = [snap.message, snap.leaseIp ? `本机地址 ${snap.leaseIp}` : null, snap.serviceVip ? `VIP ${snap.serviceVip}` : null, state.oversea ? state.oversea.text : null]
    .filter(Boolean)
    .join('\n')
}
// The overseas channel, as it changes: the chip, and the page that shows it.
function showOversea(snap) {
  if (!snap) return
  const changed = JSON.stringify(snap) !== JSON.stringify(state.oversea)
  state.oversea = snap
  paintNetworkChip()
  if (changed && state.principal && state.view === 'egress') render()
}
if (native) api('oversea-status').then(showOversea).catch(() => {})
if (native && window.mxRig.onOversea) window.mxRig.onOversea(showOversea)
if (native && window.mxRig.onNetwork) window.mxRig.onNetwork(showNetwork)
async function changeNetwork(action) {
  if (loginPending || networkActionPending || NETWORK_BUSY.has(lastNetwork?.status)) return
  if (action === 'network-recover' && lastNetwork?.recoveryAvailable !== true) return
  networkActionPending = true
  updateLoginControls()
  try {
    showNetwork(await api(action))
  } catch (error) {
    $('network-message').textContent = error.message
  } finally {
    networkActionPending = false
    updateLoginControls()
  }
}
$('network-connect').addEventListener('click', () => changeNetwork('network-connect'))
$('network-disconnect').addEventListener('click', () => changeNetwork('network-disconnect'))
$('network-recover').addEventListener('click', () => changeNetwork('network-recover'))

/**
 * Launcher mode (docs/25 P2): versions from Release Center. The card comes up
 * by itself only for what can be acted on; what a person asked for (检查更新)
 * is answered even when there is nothing to do. Closed, it stays closed until
 * the state changes.
 */
const UPDATE_ACTIONABLE = new Set(['available', 'downloading', 'verifying', 'staged', 'ready', 'installing'])
let updateState = null
let updateClosed = null
const updateKey = (state) => `${state.phase}:${state.targetVersion ?? ''}`
function showUpdate(state) {
  if (!state) return
  updateState = state
  const actionable = UPDATE_ACTIONABLE.has(state.phase)
  $('update-line').hidden = false
  $('update-version').textContent = state.currentVersion
  $('update-check').disabled = !state.actions.check
  const chip = $('update-chip')
  chip.hidden = false
  chip.dataset.phase = state.phase
  chip.textContent = actionable ? (state.phase === 'ready' ? '更新已就绪' : `新版本 ${state.targetVersion ?? ''}`) : `v${state.currentVersion}`
  chip.title = actionable ? '查看更新' : '检查更新'
  $('update-banner').hidden = !(actionable || state.origin === 'user') || updateClosed === updateKey(state)
  $('update-text').textContent = state.text
  const bar = $('update-progress')
  bar.hidden = !state.progress
  // An unknown total is an indeterminate bar, never 0%.
  if (state.progress?.percent != null) bar.value = state.progress.percent
  else bar.removeAttribute('value')
  $('update-notes-box').hidden = !state.notes
  $('update-notes').textContent = state.notes ?? ''
  // Asked for by hand: the install ID, for a targeted validation plan.
  const id = $('update-install-id')
  id.hidden = !(state.origin === 'user' && state.installId)
  id.textContent = state.installId ? `安装 ID：${state.installId}（定向验证新版本时发给管理员）` : ''
  $('update-download').hidden = !state.actions.download
  $('update-install').hidden = !state.actions.install
  $('update-cancel').hidden = !state.actions.cancel
  $('update-retry').hidden = !['error', 'cancelled'].includes(state.phase)
  $('update-actions').hidden = [...$('update-actions').children].every((button) => button.hidden)
}
function updateAction(action) {
  updateClosed = null
  return api(action)
    .then(showUpdate)
    .catch((error) => {
      $('update-text').textContent = error.message
      $('update-banner').hidden = false
    })
}
if (native) api('update-status').then(showUpdate).catch(() => {})
if (native && window.mxRig.onUpdate) window.mxRig.onUpdate(showUpdate)
$('update-check').addEventListener('click', () => updateAction('update-check'))
$('update-retry').addEventListener('click', () => updateAction('update-check'))
$('update-download').addEventListener('click', () => updateAction('update-download'))
$('update-cancel').addEventListener('click', () => updateAction('update-cancel'))
$('update-install').addEventListener('click', () => updateAction('update-install'))
$('update-close').addEventListener('click', () => {
  if (updateState) updateClosed = updateKey(updateState)
  $('update-banner').hidden = true
})
$('update-chip').addEventListener('click', () => {
  if (updateState && UPDATE_ACTIONABLE.has(updateState.phase)) {
    updateClosed = null
    $('update-banner').hidden = false
  } else updateAction('update-check')
})

/**
 * The test browser on first use: nothing to say once it is there; while it
 * downloads, how far along; when it failed, why, and a way to try again.
 */
function showProvision(info) {
  const box = $('browser-provision')
  if (!box || !info) return
  box.replaceChildren()
  box.dataset.tone = info.phase === 'failed' || (info.failure && !info.downloading) ? 'error' : 'info'
  if (info.phase === 'downloading' || (info.downloading && info.progress)) {
    const progress = info.phase === 'downloading' ? info : info.progress
    const percent = progress.total ? Math.floor((progress.done / progress.total) * 100) : 0
    const size = progress.total ? `约 ${Math.round(progress.total / 1048576)} MB，` : ''
    box.textContent = `正在准备测试浏览器（只在第一次使用时下载，${size}来源 ${progress.source}）… ${percent}%`
    box.hidden = false
    return
  }
  if (info.ready) {
    box.hidden = true
    return
  }
  if (info.failure || info.phase === 'failed') {
    box.append(
      `测试浏览器下载失败：${info.failure}。也可以安装 Google Chrome，MX Rig 会直接使用它。`,
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        type: 'button',
        text: '重试下载',
        onclick: () => api('browser-download').then(showProvision).catch((error) => notice(error.message, 'error'))
      })
    )
    box.hidden = false
  }
}
if (native) window.mxRig.onProvision?.(showProvision)
// The old test-management console: everything it did is in the workbench
// now (docs/21 M1–M3), so the desktop no longer offers it. The web keeps a
// link while the console is being made read-only.
$('console-link').hidden = native
// Re-fetch, then redraw. Most pages load their own data during render, but
// the workbench reads the mission list from state, so a plain redraw there
// would show exactly what was already on screen.
$('refresh').onclick = () =>
  run(async () => {
    state.missions = (await api('missions')).missions
    await render()
  })
$('hud-toggle').onclick = () => toggleHud()
$('new-mission').onclick = () => run(async () => {
  state.selected = null
  state.projectTask = null
  state.draft = ''
  await go('projects')
  $('test-task-goal')?.focus()
})
$('logout').onclick = () =>
  run(async () => {
    await api('logout', {})
    state.principal = null
    state.missions = []
    state.selected = null
    state.caseEdit = null
    state.caseImport = ''
    state.caseHistory = null
    state.projectTask = null
    state.testExecution = null
    state.implementation = null
    state.projectAccessEdits = {}
    $('login').hidden = false
    $('workspace').hidden = true
  })
$('change-password').onclick = () => {
  $('password-error').textContent = ''
  $('password-form').reset()
  $('password-dialog').showModal()
}
$('password-cancel').onclick = () => $('password-dialog').close()
$('password-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = event.submitter
  button.disabled = true
  $('password-error').textContent = ''
  try {
    await api('change-password', {
      current: $('password-current').value,
      next: $('password-next').value
    })
    $('password-form').reset()
    $('password-dialog').close()
    state.principal = { ...state.principal, mustChangePassword: false }
    notice('密码已修改；其他设备上的登录已失效。')
  } catch (error) {
    $('password-error').textContent = error.message
  } finally {
    button.disabled = false
  }
}
$('login-form').onsubmit = async (event) => {
  event.preventDefault()
  if (loginBlocked()) return
  loginPending = true
  updateLoginControls()
  $('login-error').textContent = ''
  try {
    const result = await api('login', {
      ...(native ? { url: $('server').value, privateHttp: $('private-http').checked } : {}),
      account: $('account').value,
      password: $('password').value
    })
    $('password').value = ''
    await enter(result.member)
    if (result.cleartext)
      notice('当前连接是内网 HTTP，未加密：只在可信的内网或 WireGuard 隧道里使用。')
  } catch (error) {
    $('login-error').textContent = error.message
    $('login').hidden = false
    $('workspace').hidden = true
  } finally {
    loginPending = false
    updateLoginControls()
  }
}

// Poll fast while text is arriving, at walking pace while something is
// running, and slowly when nothing is. The fast cadence is only used on the
// workbench page, which is the only place partial text is drawn — the overview
// re-fetches four collections per render and has no business doing that twice
// a second.
const TICK_MS = 700
let ticks = 0
setInterval(() => {
  if (!state.principal || document.hidden) return
  ticks += 1
  const busy = state.missions.some((row) => row.status !== 'draft' && !TERMINAL.has(row.status))
  if (!busy && state.view !== 'missions' && state.view !== 'overview') return
  const streaming = state.view === 'missions' && state.missions.some((row) => row.stream?.text)
  const every = streaming ? 1 : busy ? 4 : 16
  if (ticks % every !== 0) return
  refresh().catch((error) => notice(error.message, 'error'))
}, TICK_MS)

// The desktop streams the page the Agent is driving; the activity view shows
// it in the mission's browser tab, and anywhere else as a small window.
if (native && typeof window.mxRig.onFrame === 'function') {
  window.mxRig.onFrame((frame) => pushFrame(frame))
  // During takeover the page may ask for a file; the pane offers the dialog.
  window.mxRig.onChooser?.((info) => {
    live.chooser = info
    render()
  })
  window.mxRig.onDialog?.((info) => {
    live.dialog = info
    render()
  })
  live.open = (missionId) => {
    if (missionId) {
      state.selected = missionId
      state.missionTab = { id: missionId, tab: 'browser', chosen: true }
    }
    go('missions')
  }
}

if (!native)
  api('me')
    .then(({ principal }) => enter(principal))
    .catch(() => {})

/**
 * Browser SSO (docs/25 P4): the platform's unified authentication, Feishu
 * included. On the web it is a link to /auth/sso/login, and on the public
 * entrance the only way in. The desktop opens the system browser and waits for
 * it; its product network stays anonymous (no network token without a password).
 */
function showAuthMethods(methods) {
  const sso = methods?.sso?.enabled === true
  const passwords = methods?.password !== false
  $('sso-panel').hidden = !sso
  $('sso-or').hidden = !passwords
  $('account-field').hidden = !passwords
  $('password-field').hidden = !passwords
  $('account').required = passwords
  $('password').required = passwords
  $('login-form').querySelector('button[type=submit]').hidden = !passwords
  // Alone, it is the main action.
  $('sso-login').classList.toggle('qp-button--primary', !passwords)
  $('sso-login').classList.toggle('qp-button--outline', passwords)
  if (!passwords) $('login-hint').textContent = '用平台统一账号登录，也可以用飞书。这个入口不接受账号密码。'
  $('sso-hint').textContent = !sso
    ? ''
    : native && lastNetwork
      ? '在系统浏览器里完成登录。这样登录时内网保持匿名网络，海外通道需要用账号密码登录。'
      : '在统一认证页面登录，已经登录过的浏览器可以直接进入。'
}
function refreshAuthMethods() {
  api('auth-methods', native ? { url: $('server').value, privateHttp: $('private-http').checked } : undefined)
    .then(showAuthMethods)
    .catch(() => {})
}
if (!native) {
  // Back from Auth: the address need not keep saying so.
  if (new URLSearchParams(location.search).has('sso')) history.replaceState(null, '', `${location.pathname}${location.hash}`)
  refreshAuthMethods()
} else {
  let serverTimer = null
  $('server').addEventListener('input', () => {
    clearTimeout(serverTimer)
    serverTimer = setTimeout(refreshAuthMethods, 600)
  })
}
$('sso-login').addEventListener('click', async () => {
  if (!native) {
    location.assign('/auth/sso/login?ui=%2Frig%2F')
    return
  }
  if (loginBlocked()) return
  loginPending = true
  updateLoginControls()
  $('sso-cancel').hidden = false
  $('login-error').textContent = ''
  try {
    const result = await api('browser-login', { url: $('server').value, privateHttp: $('private-http').checked })
    await enter(result.member)
    if (result.networkNote) notice(result.networkNote)
    else if (result.cleartext) notice('当前连接是内网 HTTP，未加密：只在可信的内网或 WireGuard 隧道里使用。')
  } catch (error) {
    $('login-error').textContent = error.message
    $('login').hidden = false
    $('workspace').hidden = true
  } finally {
    loginPending = false
    $('sso-cancel').hidden = true
    updateLoginControls()
  }
})
$('sso-cancel').addEventListener('click', () => api('browser-login-cancel').catch(() => {}))
