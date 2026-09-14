const $ = (id) => document.getElementById(id)
const native = Boolean(window.mxRig?.desktop)
let principal = null,
  missions = [],
  selected = null,
  config = null,
  tasks = [],
  view = 'missions',
  polling = false,
  lastRowRender = ''
const labels = {
  queued: '排队',
  running: '执行中',
  awaiting_approval: '等待确认',
  completed: '任务完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消'
}
const terminal = new Set(['completed', 'failed', 'blocked', 'cancelled'])
const toolLabels = {
  tests_list: '查看测试计划',
  tests_runs: '查看近期执行',
  tests_run: '执行测试计划',
  tests_result: '读取测试证据',
  browser_open: '打开浏览器',
  browser_snapshot: '观察页面',
  browser_click: '点击页面',
  browser_fill: '填写字段'
}
const routes = {
  login: '/api/rig/v1/login',
  me: '/api/rig/v1/me',
  logout: '/api/rig/v1/logout',
  missions: '/api/rig/v1/missions',
  start: '/api/rig/v1/missions',
  config: '/api/rig/v1/config',
  'admin-config': '/api/rig/v1/admin/config',
  tasks: '/api/v1/tasks',
  runs: '/api/v1/runs?limit=20'
}
async function api(action, body) {
  if (native) return window.mxRig.request(action, body)
  const path = ['approve', 'cancel', 'followup'].includes(action)
    ? `/api/rig/v1/missions/${encodeURIComponent(body.id)}/${action}`
    : routes[action]
  const response = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin'
  })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error?.message || `请求失败 (${response.status})`)
  return result
}
function element(tag, content, className) {
  const node = document.createElement(tag)
  if (content !== undefined) node.textContent = content
  if (className) node.className = className
  return node
}
function notice(message) {
  $('notice').textContent = message
  $('notice').hidden = !message
}
async function attempt(work) {
  try {
    notice('')
    await work()
  } catch (error) {
    notice(error.message)
  }
}
function chooseView(name) {
  view = name
  for (const n of ['missions', 'tests', 'tools', 'settings']) $(n + '-view').hidden = n !== name
  document
    .querySelectorAll('[data-view]')
    .forEach((b) => b.classList.toggle('active', b.dataset.view === name))
  $('view-title').textContent = {
    missions: '任务工作台',
    tests: '测试中心',
    tools: '工具与能力',
    settings: 'Internal 配置'
  }[name]
  if (name === 'tests') attempt(loadTests)
  if (name === 'settings') attempt(loadSettings)
}
function newMission() {
  selected = null
  chooseView('missions')
  renderMissions()
  $('goal').focus()
}
function renderMissions() {
  const list = $('mission-list')
  list.replaceChildren()
  for (const row of missions) {
    const b = element('button', row.goal, 'mission-item' + (row.id === selected ? ' selected' : ''))
    b.title = row.goal
    b.onclick = () => {
      selected = row.id
      chooseView('missions')
      renderMissions()
    }
    list.append(b)
  }
  const row = missions.find((m) => m.id === selected)
  $('welcome').hidden = Boolean(row)
  $('mission-detail').hidden = !row
  $('composer').hidden = Boolean(row && !terminal.has(row.status))
  $('mode').hidden = Boolean(row)
  $('task').hidden = Boolean(row) || $('mode').value !== 'workflow'
  $('start').textContent = row ? '继续对话 ↑' : '开始任务 ↑'
  if (!row) {
    lastRowRender = ''
    return
  }
  const version = JSON.stringify(row)
  if (version === lastRowRender) return
  lastRowRender = version
  $('mission-id').textContent =
    `MISSION / ${row.id.slice(0, 8)} · ${row.mode === 'agent' ? 'AGENT' : 'WORKFLOW'}`
  $('mission-goal').textContent = row.goal
  $('mission-status').textContent = labels[row.status] || row.status
  const timeline = $('timeline')
  timeline.replaceChildren()
  for (const event of row.events) {
    const block = element('article', undefined, 'event ' + event.kind)
    block.append(
      element('time', new Date(event.at).toLocaleTimeString()),
      element('div', event.message, 'event-message')
    )
    if (event.data) {
      const details = element('details')
      details.append(
        element('summary', '查看执行证据'),
        element('pre', JSON.stringify(event.data, null, 2))
      )
      block.append(details)
      const screenshot = event.data.result?.screenshot
      if (native && screenshot) {
        const b = element('button', '打开截图')
        b.onclick = () => attempt(() => api('artifact', { path: screenshot }))
        block.append(b)
      }
    }
    timeline.append(block)
  }
  $('approval').hidden = row.status !== 'awaiting_approval'
  $('approval').replaceChildren()
  if (row.pending) {
    $('approval').append(
      element('h3', '确认这一次操作'),
      element('p', `${toolLabels[row.pending.name] || row.pending.name} · 确认只适用于下方参数。`),
      element('pre', JSON.stringify(row.pending.args, null, 2))
    )
    for (const [ok, title] of [
      [true, '确认执行'],
      [false, '拒绝并停止']
    ]) {
      const b = element('button', title, ok ? 'primary' : '')
      b.onclick = () =>
        attempt(async () => {
          b.disabled = true
          await api('approve', { id: row.id, approvalId: row.pending.approvalId, approved: ok })
          await refresh()
        })
      $('approval').append(b)
    }
  }
  $('cancel').hidden = terminal.has(row.status)
}
async function refresh() {
  if (!principal || polling) return
  polling = true
  try {
    const result = await api('missions')
    missions = result.missions
    renderMissions()
  } finally {
    polling = false
  }
}
async function loadTasks() {
  const result = await api('tasks')
  tasks = result.tasks || []
  $('task').replaceChildren()
  for (const task of tasks) {
    const opt = element('option', task.name || task.id)
    opt.value = task.id
    $('task').append(opt)
  }
}
async function enter(member) {
  principal = member
  $('login').hidden = true
  $('workspace').hidden = false
  $('member').textContent = member.displayName || member.id || member.principalId
  $('surface').textContent = native ? 'DESKTOP · LOCAL RUNTIME' : 'INTERNAL · WEB WORKSPACE'
  config = await api('config')
  await loadTasks()
  await refresh()
  renderTools()
  $('start').disabled = !['operator', 'admin'].includes(member.role)
}
function renderTools() {
  const target = $('tools')
  target.replaceChildren()
  for (const [name, label] of Object.entries(toolLabels)) {
    const card = element('article', undefined, 'card')
    const allowed = config.policy.allowedTools.includes(name)
    card.append(
      element('h3', label),
      element('code', name),
      element('p', allowed ? 'Internal 已允许' : 'Internal 尚未允许'),
      element(
        'p',
        name.startsWith('browser_') ? '执行位置：桌面隔离浏览器' : '执行位置：Internal 测试服务'
      )
    )
    target.append(card)
  }
}
async function loadTests() {
  await loadTasks()
  const box = $('test-tasks')
  box.replaceChildren()
  if (!tasks.length)
    box.append(element('div', '尚无测试计划。请在完整测试管理台接入项目、用例和套件。', 'empty'))
  for (const task of tasks) {
    const card = element('article', undefined, 'card')
    card.append(
      element('h3', task.name || task.id),
      element('code', task.id),
      element('p', `套件 ${task.suiteId || '—'} · ${task.enabled === false ? '已停用' : '可执行'}`)
    )
    const b = element('button', '创建测试工作流')
    b.disabled = task.enabled === false || !['operator', 'admin'].includes(principal.role)
    b.onclick = () => {
      newMission()
      $('mode').value = 'workflow'
      $('task').hidden = false
      $('task').value = task.id
      $('goal').value = `执行测试计划：${task.name || task.id}`
    }
    card.append(b)
    box.append(card)
  }
  const { runs = [] } = await api('runs')
  const table = element('table')
  const head = element('tr')
  ;['执行 ID', '状态', '创建时间'].forEach((t) => head.append(element('th', t)))
  table.append(head)
  for (const run of runs) {
    const tr = element('tr')
    ;[run.id, run.status, new Date(run.createdAt).toLocaleString()].forEach((t) =>
      tr.append(element('td', t))
    )
    table.append(tr)
  }
  $('test-runs').replaceChildren(runs.length ? table : element('div', '尚无测试执行记录', 'empty'))
}
async function loadSettings() {
  const editable = principal.role === 'admin'
  $('settings-form')
    .querySelectorAll('input,textarea,button')
    .forEach((n) => (n.disabled = !editable))
  $('settings-note').textContent = editable
    ? '凭据值不在这里填写。请在服务端设置指定的环境变量，然后重启服务。'
    : '仅管理员可以查看和修改模型连接配置。'
  if (!editable) return
  const value = await api('admin-config')
  $('model-url').value = value.model.baseUrl
  $('model-name').value = value.model.name
  $('model-key-env').value = value.model.apiKeyEnv
  $('max-turns').value = value.maxTurns
  $('allowed-tools').value = value.allowedTools.join('\n')
  $('browser-origins').value = value.browserOrigins.join('\n')
}
$('server-field').hidden = !native
$('server').required = native
if (native)
  $('classic').onclick = (event) => {
    event.preventDefault()
    attempt(async () => {
      await api('test-center')
      notice('已在外部浏览器打开测试管理台；该浏览器会话需独立登录。')
    })
  }
$('login-form').onsubmit = async (event) => {
  event.preventDefault()
  const button = event.submitter
  button.disabled = true
  $('login-error').textContent = ''
  try {
    const result = await api('login', {
      url: $('server').value,
      account: $('account').value,
      password: $('password').value
    })
    $('password').value = ''
    await enter(result.member)
  } catch (e) {
    $('login-error').textContent = e.message
    $('login').hidden = false
    $('workspace').hidden = true
  } finally {
    button.disabled = false
  }
}
$('logout').onclick = () =>
  attempt(async () => {
    await api('logout', {})
    principal = null
    missions = []
    selected = null
    $('login').hidden = false
    $('workspace').hidden = true
  })
$('new-mission').onclick = newMission
document
  .querySelectorAll('[data-view]')
  .forEach((b) => (b.onclick = () => chooseView(b.dataset.view)))
document.querySelectorAll('[data-prompt]').forEach(
  (b) =>
    (b.onclick = () => {
      $('goal').value = b.dataset.prompt
      $('goal').focus()
    })
)
$('mode').onchange = () => {
  $('task').hidden = $('mode').value !== 'workflow'
}
$('composer').onsubmit = (event) => {
  event.preventDefault()
  attempt(async () => {
    const input = { goal: $('goal').value, mode: $('mode').value, taskId: $('task').value }
    const { mission } = await api(selected ? 'followup' : 'start', {
      ...input,
      ...(selected ? { id: selected } : {})
    })
    selected = mission.id
    $('goal').value = ''
    await refresh()
  })
}
$('cancel').onclick = () =>
  attempt(async () => {
    await api('cancel', { id: selected })
    await refresh()
  })
$('settings-form').onsubmit = (event) => {
  event.preventDefault()
  attempt(async () => {
    const lines = (id) =>
      $(id)
        .value.split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
    await api('admin-config', {
      maxTurns: Number($('max-turns').value),
      allowedTools: lines('allowed-tools'),
      browserOrigins: lines('browser-origins'),
      model: {
        baseUrl: $('model-url').value.trim(),
        name: $('model-name').value.trim(),
        apiKeyEnv: $('model-key-env').value.trim()
      }
    })
    config = await api('config')
    renderTools()
    notice('已保存到 Internal。等待确认中的旧策略动作将不再执行。')
  })
}
setInterval(() => {
  if (principal && !document.hidden && view === 'missions')
    refresh().catch((e) => notice(e.message))
}, 2500)
if (!native)
  api('me')
    .then(({ principal: p }) => enter(p))
    .catch(() => {})
