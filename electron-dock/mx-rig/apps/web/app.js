import * as views from './views.js'
import { h } from './views.js'

const $ = (id) => document.getElementById(id)
const native = Boolean(window.mxRig?.desktop)

// One table for both surfaces: the browser turns an action into a same-origin
// request, the desktop hands the same action to the main process, which owns
// the bearer token. The renderer never sees a credential either way.
const GET_ROUTES = {
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
  runners: '/api/v1/runners'
}
const POST_ROUTES = {
  login: '/api/rig/v1/login',
  logout: '/api/rig/v1/logout',
  'save-config': '/api/rig/v1/admin/config',
  probe: '/api/rig/v1/admin/providers:probe',
  'preview-orchestration': '/api/rig/v1/admin/orchestrations:preview',
  'activate-egress': '/api/rig/v1/admin/egress:activate',
  'plan-dispatch': '/api/rig/v1/dispatch:plan',
  'system-signal': '/api/rig/v1/system/signal',
  'system-claim': '/api/rig/v1/system/claim',
  'system-seen': '/api/rig/v1/system/seen',
  start: '/api/rig/v1/missions'
}
const MISSION_ACTIONS = ['approve', 'cancel', 'followup']

const PAGES = [
  {
    label: '工作台',
    items: [
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
        title: '任务工作台',
        sub: 'Agent 对话与测试工作流',
        kicker: 'AGENT WORKSPACE'
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
        title: '测试中心',
        sub: '应用、计划与执行证据',
        kicker: 'QUALITY EVIDENCE'
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
        id: 'settings',
        glyph: '⚙',
        title: 'Internal 配置',
        sub: '策略、Provider 与 Agent',
        kicker: 'SOURCE OF TRUTH'
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
  graph: null,
  orchestration: { selected: 'mission', graph: null, preview: null, draft: null, error: null },
  missions: [],
  tasks: [],
  selected: null,
  agentKey: null,
  mode: 'agent',
  draft: '',
  pendingTask: null,
  view: 'overview',
  // Which reader this workspace is arranged for. A view preference only — it
  // changes the order things appear in, never what anyone is allowed to do.
  lens: 'tester',
  window: 14,
  insights: null,
  // The system layer: quest states, level, and the floating panel's visibility.
  system: null,
  hud: false,
  // A parsed one-liner waiting to be confirmed. Never executed on its own.
  plan: null,
  polling: false,
  scroll: {}
}

const LENS_KEY = 'mx-rig.lens'
const WINDOW_KEY = 'mx-rig.window'
const HUD_KEY = 'mx-rig.hud'
try {
  const savedLens = localStorage.getItem(LENS_KEY)
  if (savedLens && Object.hasOwn(views.LENSES, savedLens)) state.lens = savedLens
  const savedWindow = Number(localStorage.getItem(WINDOW_KEY))
  if ([7, 14, 30].includes(savedWindow)) state.window = savedWindow
  state.hud = localStorage.getItem(HUD_KEY) === 'on'
} catch {
  // Private windows and blocked site data are normal; the defaults are fine.
}

async function api(action, body) {
  if (native) return window.mxRig.request(action, body)
  if (action === 'orchestration-graph')
    return request('GET', `/api/rig/v1/graph?orchestration=${encodeURIComponent(body.key)}`)
  if (action === 'insights')
    return request(
      'GET',
      `/api/rig/v1/insights?window=${encodeURIComponent(body?.window ?? 14)}&timezone=${encodeURIComponent(
        Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
      )}`
    )
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
  setLens,
  setWindow,
  copyReport,
  triageCase,
  signal,
  claimQuest,
  toggleHud,
  planDispatch,
  clearPlan,
  activateEgress,
  saveEgress,
  canRun: () => ['operator', 'admin'].includes(state.principal?.role)
}

function remember(key, value) {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // A remembered preference is a convenience, never a requirement.
  }
}

function setLens(lens) {
  state.lens = lens
  remember(LENS_KEY, lens)
  signal('lens_switched')
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
    state.lens,
    state.principal?.role,
    state.selected,
    state.missions.map((row) => `${row.id}:${row.status}:${row.goal}`)
  ])
  if (signature === navSignature && nav.childElementCount) return
  navSignature = signature
  nav.replaceChildren()
  nav.append(
    h('p', { class: 'rig-nav__label', text: '视角' }),
    // The wrapper is load-bearing. `.qp-segmented` sets `overflow: hidden`,
    // which zeroes a flex container's automatic minimum size; as a direct grid
    // item its row then collapses to the two border pixels and the buttons
    // spill over the nav beneath, unclickable.
    h(
      'div',
      { class: 'rig-nav__lens' },
      h(
        'div',
        { class: 'qp-segmented', role: 'group', 'aria-label': '视角' },
        ...Object.entries(views.LENSES).map(([key, meta]) =>
          h('button', {
            class: `qp-segmented__item ${state.lens === key ? 'is-active' : ''}`,
            type: 'button',
            title: `${meta.title} · ${meta.hint}`,
            text: meta.short,
            onclick: () => setLens(key)
          })
        )
      )
    )
  )
  for (const group of PAGES) {
    nav.append(h('p', { class: 'rig-nav__label', text: group.label }))
    for (const item of group.items) {
      if (item.id === 'settings' && state.principal?.role !== 'admin') continue
      nav.append(
        h(
          'button',
          {
            class: `rig-nav__item ${state.view === item.id ? 'is-active' : ''}`,
            type: 'button',
            onclick: () => go(item.id)
          },
          h('span', { class: 'rig-nav__glyph', text: item.glyph }),
          h(
            'span',
            {},
            h('span', { text: item.title }),
            h('span', { class: 'rig-nav__sub', text: item.sub })
          ),
          item.id === 'missions' && state.missions.some((row) => row.status === 'awaiting_approval')
            ? h('span', { class: 'qp-tag qp-tag--danger', text: '待确认' })
            : null
        )
      )
    }
  }
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
            state.selected = row.id
            go('missions')
          }
        },
        h('span', { text: row.goal }),
        h('small', { text: `${row.mode === 'agent' ? 'AGENT' : 'WORKFLOW'} · ${row.status}` })
      )
    )
  nav.append(
    state.missions.length ? list : h('p', { class: 'qp-caption qp-muted', text: '还没有任务' })
  )
}

function go(view) {
  state.view = view
  render()
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
    if (changed) await render()
  } finally {
    state.polling = false
  }
}

async function enter(principal) {
  state.principal = principal
  $('login').hidden = true
  $('workspace').hidden = false
  $('member').textContent = principal.displayName || principal.id || principal.principalId || ''
  $('member-role').textContent =
    { admin: '管理员', operator: '测试工程师', viewer: '只读' }[principal.role] ??
    principal.role ??
    ''
  $('surface').textContent = native ? 'DESKTOP · 本地 Runtime' : 'INTERNAL · Web 工作台'
  const [config, graph, catalogue] = await Promise.all([
    api('config'),
    api('graph').catch(() => ({ graph: null, nodeTypes: {} })),
    api('tools').catch(() => ({ tools: [], groups: {}, categories: {} }))
  ])
  state.config = config
  state.graph = graph.graph
  state.nodeTypes = graph.nodeTypes ?? {}
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
}

$('server-field').hidden = !native
$('server').required = native
$('console-link').hidden = false
$('console-link').onclick = (event) => {
  if (!native) return
  event.preventDefault()
  openPath('/test-center/')
}
// Re-fetch, then redraw. Most pages load their own data during render, but
// the workbench reads the mission list from state, so a plain redraw there
// would show exactly what was already on screen.
$('refresh').onclick = () =>
  run(async () => {
    state.missions = (await api('missions')).missions
    await render()
  })
$('hud-toggle').onclick = () => toggleHud()
$('new-mission').onclick = () => {
  state.selected = null
  state.draft = ''
  go('missions')
}
$('logout').onclick = () =>
  run(async () => {
    await api('logout', {})
    state.principal = null
    state.missions = []
    state.selected = null
    $('login').hidden = false
    $('workspace').hidden = true
  })
$('login-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = event.submitter
  button.disabled = true
  $('login-error').textContent = ''
  try {
    const result = await api('login', {
      ...(native ? { url: $('server').value } : {}),
      account: $('account').value,
      password: $('password').value
    })
    $('password').value = ''
    await enter(result.member)
  } catch (error) {
    $('login-error').textContent = error.message
    $('login').hidden = false
    $('workspace').hidden = true
  } finally {
    button.disabled = false
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
  const busy = state.missions.some((row) => !TERMINAL.has(row.status))
  if (!busy && state.view !== 'missions' && state.view !== 'overview') return
  const streaming = state.view === 'missions' && state.missions.some((row) => row.stream?.text)
  const every = streaming ? 1 : busy ? 4 : 16
  if (ticks % every !== 0) return
  refresh().catch((error) => notice(error.message, 'error'))
}, TICK_MS)

if (!native)
  api('me')
    .then(({ principal }) => enter(principal))
    .catch(() => {})
