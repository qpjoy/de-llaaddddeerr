import {
  createConversation, confirmContext, recordSmoke, saveFlow,
  recordReplay, createTask, setTaskEnabled
} from './conversation-preview-model.js'

// A deliberately isolated design preview. All data lives in this mount only.
// No service calls, model calls, native bridge, storage, or test execution.
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'text') node.textContent = value
    else if (key === 'class') node.className = value
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value)
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child != null && child !== false) node.append(child.nodeType ? child : String(child))
  }
  return node
}
const tag = (text, tone = '') => el('span', { class: `cp-tag ${tone}`, text })
const button = (text, onclick, className = '', disabled = false) =>
  el('button', { type: 'button', class: className, text, onclick, disabled })
const note = (text, tone = '') => el('p', { class: `cp-note ${tone}`, text })

const COMPARISONS = [
  ['项目导航', '项目选择器 + 全局最近 12 个任务', '左侧按项目组织对话，项目内保留历史', '交互预览'],
  ['开始对话', '只要求项目与目标；源码稍后接入', '先确认目录、分支、环境与地址，才开放输入', '固定表单已演示；真实预检待接'],
  ['本机目录 / 分支', '已有源码快照、commit 与漂移校验', '复用校验，绑定项目 × 本机；分支解析到 commit', '已有底座；会话前置待接'],
  ['环境', 'mock/real 数据模式 + targetUrl', 'dev/prod 独立配置，保留 mock/real 数据模式', '环境实体与策略待实现'],
  ['对话测试', '测试助手、浏览器探索、派发分属不同入口', '对话中呈现明确动作卡，逐步探索和验证', '本页为固定脚本回复'],
  ['冒烟', '已有工位、执行机、运行记录和证据', '先验证核心路径；失败留在诊断阶段', '示例门禁；未执行测试'],
  ['固化流程', '已有规程捕获、无模型重放和版本管理', '审阅步骤、断言与清理动作，再确定性复跑', '已有能力；入口待整合'],
  ['自动任务', '计划、规程任务、编排等入口并存', '一个任务入口，复用现有执行和调度能力', '本页仅本次打开的示例'],
  ['定时门禁', '部分路径仅前端限制；flaky 也算已验证', '服务端校验环境、测试版本、执行配置和 passed 证据', '必须补齐，尚未改动'],
  ['prod', '浏览器对 productionHosts 直接拒绝', '预设可见；先做规划和证据分析，执行继续服从现有策略', '本页禁止模拟执行'],
  ['账号与网络', '现有 Rig / Launcher 认证与产品网络', '沿用原有链路，MX-H2I 登录、联网保持原样', '此次无改动']
]

export function mountConversationPreview(host, { onExit, onLegacy } = {}) {
  const projects = [
    { id: 'luopan', name: '罗盘 Luopan', directory: '/Users/qpjoy/workspace/mingxi/luopan/po-frontend' },
    { id: 'hub', name: 'MX Insight Hub', directory: '' },
    { id: 'dataport', name: 'MX Dataport', directory: '' }
  ]
  let seq = 1
  const first = createConversation('luopan', `preview-${seq++}`)
  const example = createConversation('luopan', `preview-${seq++}`)
  example.title = '登录与核心页面冒烟'
  const conversations = [first, example]
  let selected = first, projectId = 'luopan', view = 'chat', editing = false, error = ''
  let filter = 'all', mobileOpen = false
  const drafts = new Map()
  const messages = new Map()
  const taskDrafts = new Map()
  const root = el('section', { class: `conversation-preview${onExit ? ' is-overlay' : ''}`, 'aria-label': 'MX Rig 对话工作台设计预览' })
  host.append(root)

  const project = () => projects.find((p) => p.id === projectId)
  const draft = () => {
    if (!drafts.has(selected.id)) drafts.set(selected.id, { directory: project().directory, branch: '', environment: 'dev', targetUrl: '' })
    return drafts.get(selected.id)
  }
  function act(work) {
    try { error = ''; work() } catch (e) { error = e.message }
    render()
  }
  function changeView(next) { view = next; error = ''; mobileOpen = false; render() }
  function chooseConversation(c) {
    selected = c; projectId = c.projectId; editing = false; changeView('chat')
  }
  function newChat() {
    const c = createConversation(projectId, `preview-${seq++}`)
    conversations.push(c); chooseConversation(c)
  }
  function leave(destination = 'projects') {
    if (onLegacy) return onLegacy(destination)
    if (onExit) return onExit()
    location.href = location.protocol === 'file:' ? './index.html' : './'
  }
  function sidebar() {
    return el('aside', { class: 'cp-sidebar', 'aria-label': '项目和对话' },
      el('div', { class: 'cp-brand' }, el('span', { class: 'cp-logo', text: 'R', 'aria-hidden': 'true' }),
        el('div', {}, el('strong', { text: 'MX Rig' }), el('p', { class: 'cp-muted', text: '对话工作台' }))),
      el('div', { class: 'cp-global' }, button('+ 新对话', newChat, 'cp-new'), button('自动任务', () => changeView('tasks'), view === 'tasks' ? 'is-selected' : ''),
        button('收起项目列表', () => { mobileOpen = false; render() }, 'cp-mobile-menu')),
      el('nav', { class: 'cp-nav', 'aria-label': '示例项目' }, el('p', { class: 'cp-nav-label', text: '项目' }),
        projects.map((p) => [button(`${p.name}　${projectId === p.id ? '⌄' : '›'}`, () => {
          projectId = p.id
          const c = conversations.find((item) => item.projectId === p.id)
          if (c) chooseConversation(c); else newChat()
        }, 'cp-project'), projectId === p.id && el('div', { class: 'cp-conversations' },
          conversations.filter((c) => c.projectId === p.id).map((c) => el('button', {
            class: `cp-chat-item${selected === c && ['chat', 'flow', 'runs'].includes(view) ? ' is-selected' : ''}`,
            type: 'button', text: c.title, title: c.title,
            'aria-current': selected === c ? 'page' : null, onclick: () => chooseConversation(c)
          })))])),
      el('div', { class: 'cp-side-bottom' }, button('项目设置', () => { editing = true; changeView('chat') }),
        el('p', { class: 'cp-disclaimer', text: '交互预览 · 使用示例数据\n仅本次打开有效，不执行测试' })))
  }
  function header() {
    return el('header', { class: 'cp-header' },
      el('div', { class: 'cp-header-top' },
        el('div', { class: 'cp-breadcrumb' }, el('button', { type: 'button', class: 'cp-mobile-menu', text: '☰', 'aria-label': '打开项目列表', 'aria-expanded': String(mobileOpen), onclick: () => { mobileOpen = !mobileOpen; render() } }),
          el('span', { class: 'cp-muted', text: project().name }), el('span', { class: 'cp-muted', text: '/' }),
          el('strong', { text: view === 'compare' ? '功能对比' : view === 'tasks' ? '自动任务' : selected.title })),
        el('div', { class: 'cp-header-actions' }, button('功能对比', () => changeView('compare'), view === 'compare' ? 'is-selected' : ''),
          button('← 返回现有工作台', () => leave()))),
      el('nav', { class: 'cp-tabs', 'aria-label': '对话内容' }, [['chat', '对话'], ['flow', '流程'], ['runs', '执行记录']].map(([id, label]) =>
        el('button', { type: 'button', text: label, 'aria-current': view === id ? 'page' : null, onclick: () => changeView(id) }))))
  }
  function contextForm() {
    const values = draft()
    const field = (label, key, placeholder) => el('label', {}, label, el('input', {
      name: key, value: values[key], placeholder, required: true, autocomplete: 'off',
      oninput: (e) => { values[key] = e.target.value }
    }))
    const form = el('form', { class: 'cp-context', onsubmit: (e) => {
      e.preventDefault()
      act(() => {
        confirmContext(selected, values); editing = false; view = 'chat'
        selected.messages.push({ role: 'system', text: `上下文草稿 v${selected.context.revision} 已确认。尚未访问本机目录、解析分支或连接测试地址。` })
      })
    } },
    el('div', { class: 'cp-context-title' }, el('h2', { text: '会话上下文' }), tag(selected.context ? '重新确认草稿' : '尚未确认')),
    el('div', { class: 'cp-fields' }, field('项目本机目录', 'directory', '填写本机项目的绝对路径'),
      el('div', { class: 'cp-two' }, field('分支', 'branch', '选择或填写分支'),
        el('div', {}, el('p', { text: '环境' }), el('div', { class: 'cp-environments', 'aria-label': '环境预设' }, ['dev', 'prod'].map((env) =>
          el('button', { type: 'button', text: env, 'aria-pressed': String(values.environment === env), onclick: () => { values.environment = env; render() } }))))),
      field('测试地址', 'targetUrl', 'http://localhost:9000')),
    values.environment === 'prod' && note('prod 预设仅用于规划与证据分析。本预览不允许冒烟、复跑或启用任务。', 'prod'),
    selected.context && note('重新确认会清空此对话的示例冒烟、流程、复跑与任务；历史消息保留。'),
    error && el('p', { class: 'cp-error', role: 'alert', text: error }),
    el('div', { class: 'cp-form-footer' }, el('p', { text: '目录和分支由你确认，Agent 不自行推测。\n此处仅保存草稿，真实本机校验待接入。' }),
      el('button', { type: 'submit', class: 'cp-primary', text: '确认上下文' })))
    return form
  }
  function steps() {
    const current = !selected.context ? 0 : !selected.flow ? 1 : !selected.task ? 2 : 3
    return el('div', { class: 'cp-steps', 'aria-label': '测试流程' }, ['确认上下文', '对话与冒烟', '固化流程', '自动任务'].map((label, i) => [
      i > 0 && el('span', { class: 'cp-step-line', 'aria-hidden': 'true' }),
      el('span', { class: `cp-step${i === current ? ' active' : ''}` }, el('b', { text: i + 1 }), label)
    ]))
  }
  function composer(disabled) {
    const composerDraft = messages.get(selected.id) ?? ''
    return el('form', { class: 'cp-composer', onsubmit: (e) => {
      e.preventDefault()
      const text = (messages.get(selected.id) ?? '').trim()
      if (disabled || !text) return
      selected.messages.push({ role: 'user', text })
      if (selected.title === '新对话') selected.title = text.slice(0, 24)
      selected.messages.push({ role: 'assistant', text: selected.context.environment === 'prod'
        ? '预览回复：当前是 prod。可以讨论验收点和分析已有证据；本页不会访问生产地址，也不会执行测试。要体验冒烟流程，请新建 dev 对话。'
        : '预览回复：先把需求拆成可观察的验收点，再验证入口可用、关键路径和异常反馈。下方可以选择一个示例冒烟结果，体验失败诊断或通过后固化流程。这里没有调用模型，也没有实际执行。' })
      messages.delete(selected.id); render()
    } }, el('label', { class: 'cp-visually-hidden', for: 'cp-message', text: '测试需求' }),
    el('textarea', { id: 'cp-message', disabled, value: composerDraft, placeholder: disabled ? '确认上下文后，描述你想验证的功能…' : '描述你想验证的功能（预览不会调用模型）…',
      oninput: (e) => { messages.set(selected.id, e.target.value) } }, composerDraft),
    el('div', { class: 'cp-composer-footer' }, el('span', { text: '本机执行 · 当前为交互预览' }),
      el('button', { type: 'submit', class: 'cp-send', text: '↑', 'aria-label': '发送预览消息', disabled })))
  }
  function contextBar() {
    const c = selected.context
    return el('div', { class: 'cp-context-bar' }, tag(`${c.environment} · 草稿 v${c.revision}`, c.environment === 'prod' ? 'warn' : 'good'),
      el('span', { text: `分支 ${c.branch}` }), el('span', { text: c.targetUrl }),
      button('修改上下文', () => { editing = true; render() }),
      el('code', { text: `${c.directory} · 未校验本机目录 / commit` }))
  }
  function smokeCard() {
    const smoke = selected.smoke
    return el('section', { class: 'cp-evidence' },
      el('div', { class: 'cp-evidence-head' }, el('h3', { text: '核心路径冒烟' }), tag(smoke ? `${smoke.outcome === 'passed' ? '通过' : '失败'} · 模拟` : '尚无执行证据', smoke?.outcome === 'passed' ? 'good' : '')),
      el('p', { class: 'cp-muted', text: '用示例结果体验晋升规则；不会打开浏览器或运行命令。' }),
      smoke && el('div', { class: 'cp-row' }, el('span', { text: '证据归属' }), el('span', { text: `当前上下文 v${smoke.contextRevision} · 无真实 runId` })),
      smoke?.outcome === 'failed' && note('失败时先定位产品、环境或测试脚本问题。修复后重新冒烟，不能直接固化为可启用任务。'),
      el('div', { class: 'cp-actions' }, button('模拟冒烟通过', () => act(() => recordSmoke(selected, 'passed')), 'cp-outline'),
        button('模拟冒烟失败', () => act(() => recordSmoke(selected, 'failed')), 'cp-outline'),
        button('固化流程', () => act(() => { saveFlow(selected); view = 'flow' }), 'cp-primary', smoke?.outcome !== 'passed')))
  }
  function chat() {
    if (!selected.context || editing) return [
      el('div', { class: 'cp-intro' }, el('h1', { text: '先把测试现场准备好' }), el('p', { text: '明确项目、分支和环境，再开始对话。' })),
      contextForm(), steps(), composer(true)
    ]
    return el('div', { class: 'cp-chat-area' }, contextBar(),
      selected.messages.map((m) => el('article', { class: `cp-message ${m.role}` },
        el('div', { class: 'cp-message-label', text: m.role === 'user' ? '你' : m.role === 'assistant' ? 'Rig · 脚本化预览' : '上下文' }), el('p', { text: m.text }))),
      !selected.messages.some((m) => m.role === 'user') && note('可以从“验证登录和核心页面是否可用”开始。真实版本会先给出步骤与断言，再由执行器产生证据。'),
      selected.context.environment === 'prod' ? note('prod：只规划和分析，不开放执行动作。', 'prod') : selected.messages.some((m) => m.role === 'user') && smokeCard(),
      error && el('p', { class: 'cp-error', role: 'alert', text: error }), steps(), composer(false))
  }
  function empty(title, text, action, label) {
    return el('div', { class: 'cp-empty' }, el('h2', { text: title }), el('p', { text }), button(label, action, 'cp-primary'))
  }
  function flow() {
    if (!selected.flow) return empty('先让核心路径走通', '对话可以先整理草稿。冒烟通过后，再把步骤与断言固化为可复跑流程；此页目前没有真实测试证据。', () => changeView('chat'), '回到对话')
    const f = selected.flow
    return [el('div', { class: 'cp-section-head' }, el('h1', { text: '把走通的路径，变成可复跑流程' }),
      el('p', { text: `流程 v${f.revision} · 上下文 v${f.contextRevision} · 示例流程` })),
      note('人工或 Agent 探索成功之后，还需要不依赖模型的确定性重放。冒烟仅证明核心路径可用，完整回归还要覆盖权限、异常和数据边界。'),
      el('ol', { class: 'cp-flow-list' }, f.steps.map((step, index) => el('li', {}, el('span', { class: 'cp-number', text: `0${index + 1}` }),
        el('div', {}, el('h3', { text: step.title }), el('p', { text: step.expected }))))),
      el('div', { class: 'cp-evidence' }, el('div', { class: 'cp-evidence-head' }, el('h3', { text: '确定性复跑' }),
        tag(selected.replay ? `${selected.replay.outcome === 'passed' ? '通过' : '失败'} · 模拟` : '待复跑', selected.replay?.outcome === 'passed' ? 'good' : '')),
        el('p', { class: 'cp-muted', text: '同一上下文、同一流程版本。这里只演示门禁，不产生真实报告。' }),
        el('div', { class: 'cp-actions' }, button('模拟复跑通过', () => act(() => recordReplay(selected, 'passed')), 'cp-outline'),
          button('模拟复跑失败', () => act(() => recordReplay(selected, 'failed')), 'cp-outline'))),
      taskForm()]
  }
  function taskForm() {
    if (selected.task) return [note('已经保存一个示例任务。可到自动任务查看或停用；刷新预览后将清空。'), button('查看自动任务', () => changeView('tasks'), 'cp-primary')]
    const ready = selected.replay?.outcome === 'passed'
    if (!taskDrafts.has(selected.id)) taskDrafts.set(selected.id, { name: `${selected.title} · 回归`, schedule: 'manual' })
    const values = taskDrafts.get(selected.id)
    return el('form', { class: 'cp-task-form', onsubmit: (e) => {
      e.preventDefault(); const data = new FormData(e.currentTarget)
      act(() => { createTask(selected, { name: String(data.get('name')), schedule: String(data.get('schedule')) }); view = 'tasks' })
    } }, el('h2', { text: '保存为自动任务' }),
    !ready && el('p', { class: 'cp-muted', text: '需要此流程的示例复跑通过，才会开放保存。' }),
    el('label', {}, '任务名称', el('input', { name: 'name', value: values.name, required: true, maxlength: '100', oninput: (e) => { values.name = e.target.value } })),
    el('label', {}, '触发方式', el('select', { name: 'schedule', onchange: (e) => { values.schedule = e.target.value } },
      el('option', { value: 'manual', selected: values.schedule === 'manual', text: '手动触发' }),
      el('option', { value: 'daily', selected: values.schedule === 'daily', text: '每天 09:00 · Asia/Shanghai（模拟）' }))),
    error && el('p', { class: 'cp-error', role: 'alert', text: error }),
    el('div', {}, el('button', { type: 'submit', class: 'cp-primary', text: '保存示例任务', disabled: !ready })))
  }
  function tasks() {
    const items = conversations.filter((c) => c.projectId === projectId && c.task)
    return [el('div', { class: 'cp-section-head' }, el('h1', { text: '验证过，再交给自动化' }), el('p', { text: `${project().name} · 示例任务仅保留在当前预览内` })),
      items.length ? items.map((c) => el('article', { class: 'cp-task-card' },
        el('div', { class: 'cp-evidence-head' }, el('h2', { text: c.task.name }), tag(c.task.enabled ? '已启用 · 模拟' : '未启用 · 模拟', c.task.enabled ? 'good' : '')),
        el('div', { class: 'cp-task-meta' }, `${c.context.environment} · ${c.context.branch}`, `流程 v${c.task.flowRevision}`, c.task.schedule === 'daily' ? '每天 09:00 · Asia/Shanghai' : '手动触发'),
        note('这是状态演示，不会注册调度器、运行测试或发送通知。正式任务需固定执行机、版本与证据后才可启用。'),
        el('div', { class: 'cp-actions' }, button(c.task.enabled ? '停用示例任务' : '启用示例任务', () => act(() => setTaskEnabled(c, !c.task.enabled)), 'cp-primary'),
          button('查看来源对话', () => chooseConversation(c), 'cp-outline')))) :
        empty('还没有自动任务', '先完成对话冒烟，固化流程并确定性复跑，再保存为任务。', () => changeView('chat'), '开始一次对话'),
      error && el('p', { class: 'cp-error', role: 'alert', text: error })]
  }
  function runs() {
    return [el('div', { class: 'cp-section-head' }, el('h1', { text: '每个结论，都能回到证据' }), el('p', { text: '当前对话的模拟结果，不属于测试中心的真实执行记录。' })),
      !selected.smoke && !selected.replay ? empty('尚无示例执行记录', '不会凭聊天文本推断通过，也不会用其他项目或环境的结果放行。', () => changeView('chat'), '回到对话') :
        el('div', { class: 'cp-table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['阶段', '结果', '上下文', '证据'].map((s) => el('th', { text: s })))),
          el('tbody', {}, [['冒烟', selected.smoke], ['确定性复跑', selected.replay]].filter(([, r]) => r).map(([name, r]) =>
            el('tr', {}, el('td', { text: name }), el('td', {}, tag(r.outcome === 'passed' ? '通过 · 模拟' : '失败 · 模拟', r.outcome === 'passed' ? 'good' : 'warn')),
              el('td', { text: `${selected.context.environment} / v${r.contextRevision}` }), el('td', { text: '无真实 runId、截图或 trace' }))))))]
  }
  function compare() {
    const rows = COMPARISONS.filter((row) => filter === 'all' || (filter === 'existing' ? /已有|现有/.test(row[3]) : /待|尚未|必须/.test(row[3])))
    return [el('div', { class: 'cp-section-head' }, el('h1', { text: '能力保留，操作路径变简单' }),
      el('p', { text: '以对话组织工作，以确定性执行给出结论。新入口逐步接管现有能力。' })),
      note('本轮交付：导航与流程交互预览。所有项目、对话、结果和任务都是示例；没有接入真实模型、项目数据或调度。'),
      el('div', { class: 'cp-compare-nav', 'aria-label': '能力筛选' }, [['all', '全部能力'], ['existing', '复用现有'], ['pending', '需要补齐']].map(([id, label]) =>
        el('button', { type: 'button', text: label, class: filter === id ? 'is-selected' : 'cp-outline', 'aria-pressed': String(filter === id), onclick: () => { filter = id; render() } }))),
      el('div', { class: 'cp-table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, ['能力', '现在怎么做', '新入口怎么做', '实际状态'].map((s) => el('th', { text: s })))),
        el('tbody', {}, rows.map((row) => el('tr', {}, row.map((text) => el('td', { text }))))))),
      el('section', { class: 'cp-roadmap' }, el('h2', { text: '分阶段接入，不重做测试内核' }),
        [['01 · 当前预览', '确认信息架构、上下文流程、失败与晋升状态。'], ['02 · 真实上下文', '接本机目录验证、分支解析、dev/prod 配置和会话快照。'],
          ['03 · 证据门禁', '在服务端统一检查版本、环境、配置和 passed 证据，覆盖所有启用与定时 API。'], ['04 · 收敛入口', '接入真实对话、规程、执行和任务，再逐步减少旧入口。']].map(([title, text]) =>
          el('div', { class: 'cp-row' }, el('strong', { text: title }), el('span', { class: 'cp-muted', text })))),
      el('div', { class: 'cp-actions' }, button('体验新对话流程', () => changeView('chat'), 'cp-primary'), button('返回现有工作台', () => leave(), 'cp-outline'))]
  }
  function render() {
    root.classList.toggle('show-sidebar', mobileOpen)
    const body = view === 'chat' ? chat() : view === 'flow' ? flow() : view === 'runs' ? runs() : view === 'tasks' ? tasks() : compare()
    root.replaceChildren(sidebar(), el('main', { class: 'cp-main' }, header(), el('div', { class: 'cp-content' }, body)))
  }
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (mobileOpen) { mobileOpen = false; render() }
      else if (onExit) onExit()
    }
  })
  render()
  return () => root.remove()
}

const standalone = document.getElementById('conversation-preview-root')
if (standalone) mountConversationPreview(standalone)
