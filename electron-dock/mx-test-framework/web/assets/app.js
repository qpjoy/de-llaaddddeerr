// MX 测试平台 — 前端。
//
// 无框架、无构建步骤：设计系统本身就是纯 CSS + tokens，它自己的 demo 也是这么写的。
// 一个内部工具不该为了「看起来现代」而背上一套打包链路。
//
// 页面对新同学的假设是：不看文档。所以每一页都自带「下一步做什么」。

const $ = (html) => {
  const template = document.createElement('template')
  template.innerHTML = html.trim()
  return template.content.firstElementChild
}

const esc = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const STATUS = {
  passed: ['通过', 'success'],
  failed: ['失败', 'danger'],
  flaky: ['不稳定', 'warning'],
  blocked: ['受阻', 'danger'],
  timeout: ['超时', 'danger'],
  running: ['执行中', 'info'],
  queued: ['排队中', 'info'],
  'pending-runner': ['等待执行机', 'warning'],
  expired: ['已过期', 'muted'],
  cancelled: ['已取消', 'muted'],
  skipped: ['跳过', 'muted'],
  notRun: ['未执行', 'muted'],
}

const statusTag = (status) => {
  const [label, tone] = STATUS[status] ?? [status, 'muted']
  return `<span class="mxt-status mxt-status--${tone}">${esc(label)}</span>`
}

const ago = (iso) => {
  if (!iso) return '—'
  const diff = Date.now() - new Date(iso).getTime()
  if (diff < 60_000) return '刚刚'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`
  if (diff < 2_592_000_000) return `${Math.floor(diff / 86_400_000)} 天前`
  return new Date(iso).toLocaleDateString('zh-CN')
}

const dur = (ms) => {
  if (!Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
}

const clock = (ms) =>
  Number.isFinite(ms)
    ? `${String(Math.floor(ms / 60000)).padStart(2, '0')}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, '0')}`
    : '--:--'

// -- state & api -------------------------------------------------------------

const state = { me: null, apps: [], route: { name: 'overview', params: {} }, loginEnabled: true }

function toast(message, tone = 'info') {
  const node = $(
    `<div class="qp-toast" data-tone="${tone}" role="status">${esc(message)}</div>`,
  )
  document.getElementById('toasts').append(node)
  setTimeout(() => node.remove(), tone === 'danger' ? 8000 : 4000)
}

async function api(method, path, body) {
  const response = await fetch(path, {
    method,
    // The session lives in an httpOnly cookie, so a recording in a <video> tag
    // and a fetch here authenticate the same way.
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  })
  if (response.status === 401) {
    state.me = null
    render()
    throw new Error('登录已失效')
  }
  const text = await response.text()
  const payload = text ? JSON.parse(text) : null
  if (!response.ok) {
    const error = payload?.error ?? {}
    const message = error.hint ? `${error.message}\n${error.hint}` : error.message || '请求失败'
    throw new Error(message)
  }
  return payload
}

const guard = (fn) => (...args) =>
  Promise.resolve(fn(...args)).catch((error) => toast(error.message, 'danger'))

// -- routing -----------------------------------------------------------------

const ROUTES = [
  [/^\/$/, () => ({ name: 'overview', params: {} })],
  [/^\/apps$/, () => ({ name: 'apps', params: {} })],
  [/^\/apps\/([^/]+)\/cases$/, (m) => ({ name: 'cases', params: { app: m[1] } })],
  [/^\/tasks$/, () => ({ name: 'tasks', params: {} })],
  [/^\/runs$/, () => ({ name: 'runs', params: {} })],
  [/^\/runs\/([^/]+)$/, (m) => ({ name: 'run', params: { runId: m[1] } })],
  [/^\/runners$/, () => ({ name: 'runners', params: {} })],
  [/^\/members$/, () => ({ name: 'members', params: {} })],
  [/^\/help$/, () => ({ name: 'help', params: {} })],
]

function resolveRoute() {
  const path = location.pathname
  for (const [pattern, build] of ROUTES) {
    const match = pattern.exec(path)
    if (match) return build(match)
  }
  return { name: 'overview', params: {} }
}

function go(path) {
  history.pushState({}, '', path)
  state.route = resolveRoute()
  render()
}

document.addEventListener('click', (event) => {
  const link = event.target.closest('[data-nav]')
  if (!link) return
  event.preventDefault()
  go(link.getAttribute('href'))
})
window.addEventListener('popstate', () => {
  state.route = resolveRoute()
  render()
})

// -- modal -------------------------------------------------------------------

function modal({ title, body, confirmLabel = '保存', onConfirm, wide = false }) {
  const backdrop = $(`
    <div class="mxt-backdrop">
      <div class="mxt-modal" style="${wide ? 'width:min(880px,100%)' : ''}" role="dialog" aria-modal="true">
        <div class="mxt-modal__head">
          <h2>${esc(title)}</h2>
          <button class="qp-icon-button" data-close aria-label="关闭">✕</button>
        </div>
        <div class="mxt-modal__body"></div>
        <div class="mxt-modal__foot">
          <button class="qp-button qp-button--ghost" data-close>取消</button>
          <button class="qp-button qp-button--primary" data-confirm>${esc(confirmLabel)}</button>
        </div>
      </div>
    </div>`)
  backdrop.querySelector('.mxt-modal__body').append(body)
  const close = () => backdrop.remove()
  backdrop.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', close))
  backdrop.addEventListener('click', (event) => {
    if (event.target === backdrop) close()
  })
  backdrop.querySelector('[data-confirm]').addEventListener(
    'click',
    guard(async (event) => {
      const button = event.currentTarget
      button.disabled = true
      try {
        await onConfirm(close)
      } finally {
        button.disabled = false
      }
    }),
  )
  document.body.append(backdrop)
  backdrop.querySelector('input,select,textarea')?.focus()
  return { close }
}

const field = (label, control, hint) => `
  <label class="qp-field">
    <span class="qp-field__label">${esc(label)}</span>
    ${control}
    ${hint ? `<span class="mxt-hint">${hint}</span>` : ''}
  </label>`

// -- shell -------------------------------------------------------------------

const NAV = [
  ['/', '概览'],
  ['/tasks', '测试任务'],
  ['/runs', '执行记录'],
  ['/apps', '应用与用例'],
  ['/runners', '执行机'],
  ['/help', '新手指引'],
]

function shell(content) {
  const admin = state.me?.role === 'admin'
  return $(`
    <div class="mxt-shell">
      <aside class="mxt-side">
        <div class="mxt-brand">
          <div class="mxt-brand__mark">MX</div>
          <div>
            <div class="qp-body-1 qp-body-1--semibold">测试平台</div>
            <div class="qp-caption qp-muted">自动化 e2e</div>
          </div>
        </div>
        <nav class="mxt-nav">
          ${NAV.map(
            ([href, label]) =>
              `<a href="${href}" data-nav class="${location.pathname === href ? 'is-active' : ''}">${label}</a>`,
          ).join('')}
          ${admin ? `<a href="/members" data-nav class="${location.pathname === '/members' ? 'is-active' : ''}">成员</a>` : ''}
        </nav>
        <div class="mxt-side__foot">
          <div class="qp-user-card">
            <div class="qp-user-card__name">${esc(state.me?.displayName ?? '')}</div>
            <div class="qp-user-card__role">${esc(
              { admin: '管理员', operator: '测试工程师', viewer: '只读' }[state.me?.role] ?? state.me?.role ?? '',
            )}</div>
          </div>
          <button class="qp-button qp-button--ghost qp-button--sm" data-logout>退出登录</button>
        </div>
      </aside>
      <main class="mxt-main"></main>
    </div>`)
}

// -- pages -------------------------------------------------------------------

async function pageOverview(main) {
  const [{ runs }, { tasks }, { runners }] = await Promise.all([
    api('GET', '/api/v1/runs?limit=8'),
    api('GET', '/api/v1/tasks'),
    api('GET', '/api/v1/runners'),
  ])
  const recent = runs.filter((run) => ['passed', 'failed', 'flaky', 'blocked'].includes(run.status))
  const passed = recent.filter((run) => run.status === 'passed').length

  // The onboarding path is the page itself: whichever step is unfinished is the
  // one highlighted, so "what do I do now" never needs asking.
  const steps = [
    { done: state.apps.length > 0, title: '注册应用', text: '告诉平台要测哪个系统' },
    { done: state.apps.length > 0, title: '登记用例', text: '写清楚要验证什么' },
    { done: tasks.length > 0, title: '建测试任务', text: '选应用与套件，立即或定时跑' },
    { done: recent.length > 0, title: '看报告与录像', text: '点失败的步骤跳到录像那一刻' },
  ]
  const nextIndex = steps.findIndex((step) => !step.done)

  main.innerHTML = `
    <div class="mxt-head">
      <div>
        <h1 class="qp-heading-1">概览</h1>
        <p class="qp-body-2 qp-muted">你好，${esc(state.me?.displayName ?? '')}。这里是最近的测试情况。</p>
      </div>
      <div class="mxt-actions">
        <a class="qp-button qp-button--primary" href="/tasks" data-nav>去跑一次测试</a>
      </div>
    </div>

    <div class="mxt-steps-guide">
      ${steps
        .map(
          (step, index) => `
        <div class="mxt-steps-guide__item ${step.done ? 'is-done' : index === nextIndex ? 'is-next' : ''}">
          <span class="mxt-steps-guide__num">${step.done ? '✓' : index + 1}</span>
          <h4>${esc(step.title)}</h4>
          <p>${esc(step.text)}</p>
        </div>`,
        )
        .join('')}
    </div>

    <div class="mxt-tiles">
      <div class="mxt-tile"><p class="qp-caption qp-muted">测试任务</p><p class="mxt-tile__value">${tasks.length}</p></div>
      <div class="mxt-tile mxt-tile--success"><p class="qp-caption qp-muted">最近通过</p><p class="mxt-tile__value">${passed}/${recent.length || 0}</p></div>
      <div class="mxt-tile"><p class="qp-caption qp-muted">应用</p><p class="mxt-tile__value">${state.apps.length}</p></div>
      <div class="mxt-tile"><p class="qp-caption qp-muted">在线执行机</p><p class="mxt-tile__value">${
        runners.filter((entry) => entry.status !== 'offline').length
      }</p></div>
    </div>

    <div class="mxt-panel">
      <div class="mxt-panel__head">
        <h2>最近执行</h2>
        <a class="mxt-link" href="/runs" data-nav>全部记录 →</a>
      </div>
      ${runsTable(runs)}
    </div>`
}

function runsTable(runs) {
  if (runs.length === 0) {
    return `<div class="mxt-empty">还没有执行记录。<br>先到「测试任务」建一个任务，然后点「立即执行」。</div>`
  }
  return `
    <div class="mxt-table__wrap">
      <table class="mxt-table">
        <thead><tr><th>状态</th><th>结果</th><th>轨道</th><th>耗时</th><th>时间</th><th></th></tr></thead>
        <tbody>
          ${runs
            .map(
              (run) => `
            <tr>
              <td>${statusTag(run.status)}</td>
              <td>
                ${
                  run.totals?.tests
                    ? `<span class="qp-body-2">通过 ${run.totals.passed ?? 0} / ${run.totals.tests}</span>${
                        run.totals.notRun ? ` <span class="qp-caption" style="color:var(--qp-warning)">未执行 ${run.totals.notRun}</span>` : ''
                      }`
                    : '<span class="qp-muted qp-body-2">—</span>'
                }
              </td>
              <td class="qp-body-2 qp-muted">${esc(run.profile)} / ${esc(run.track)}</td>
              <td class="qp-body-2 qp-muted">${dur(run.durationMs)}</td>
              <td class="qp-body-2 qp-muted">${ago(run.finishedAt ?? run.queuedAt)}</td>
              <td><a class="mxt-link" href="/runs/${esc(run.id)}" data-nav>查看</a></td>
            </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>`
}

async function pageRuns(main) {
  const { runs } = await api('GET', '/api/v1/runs?limit=100')
  main.innerHTML = `
    <div class="mxt-head"><div><h1 class="qp-heading-1">执行记录</h1>
      <p class="qp-body-2 qp-muted">每次执行都留有报告和录像，产物默认保留 30 天。</p></div></div>
    <div class="mxt-panel">${runsTable(runs)}</div>`
}

async function pageTasks(main) {
  const [{ tasks }] = await Promise.all([api('GET', '/api/v1/tasks')])
  const appById = new Map(state.apps.map((app) => [app.id, app]))
  const canEdit = state.me?.role !== 'viewer'

  main.innerHTML = `
    <div class="mxt-head">
      <div>
        <h1 class="qp-heading-1">测试任务</h1>
        <p class="qp-body-2 qp-muted">一个任务 = 测什么 + 什么时候测。可以立即执行，也可以定时重复。</p>
      </div>
      ${canEdit ? '<div class="mxt-actions"><button class="qp-button qp-button--primary" data-new-task>新建任务</button></div>' : ''}
    </div>
    ${
      tasks.length === 0
        ? `<div class="mxt-guide">
             <div class="mxt-guide__body">
               <h3>还没有测试任务</h3>
               <p>任务是这个平台的核心：选一个应用和它的测试套件，决定跑一次还是每天跑。</p>
               <ol>
                 <li>点右上角「新建任务」</li>
                 <li>选应用、套件，填被测地址</li>
                 <li>调度方式先选「手动」，建好后点「立即执行」试一次</li>
                 <li>跑顺了再改成「定时重复」，例如每晚两点</li>
               </ol>
             </div>
           </div>`
        : ''
    }
    <div class="mxt-panel">
      ${
        tasks.length === 0
          ? '<div class="mxt-empty">暂无任务</div>'
          : `<div class="mxt-table__wrap"><table class="mxt-table">
        <thead><tr><th>名称</th><th>应用</th><th>调度</th><th>下次执行</th><th>上次结果</th><th></th></tr></thead>
        <tbody>${tasks
          .map(
            (task) => `
          <tr>
            <td><b>${esc(task.name)}</b><div class="qp-caption qp-muted">${esc(task.profile)} / ${esc(task.track)}</div></td>
            <td class="qp-body-2">${esc(appById.get(task.appId)?.displayName ?? '—')}</td>
            <td class="qp-body-2 qp-muted">${
              task.scheduleKind === 'cron'
                ? `定时 <code>${esc(task.cronExpr)}</code>`
                : task.scheduleKind === 'once'
                  ? '定时一次'
                  : '手动'
            }${task.enabled ? '' : ' <span class="qp-tag">已停用</span>'}</td>
            <td class="qp-body-2 qp-muted">${task.nextRunAt ? ago(task.nextRunAt).replace('前', '后') : '—'}</td>
            <td>${
              task.lastRunId
                ? `<a class="mxt-link" href="/runs/${esc(task.lastRunId)}" data-nav>查看上次</a>`
                : '<span class="qp-muted qp-body-2">未跑过</span>'
            }</td>
            <td>${
              canEdit
                ? `<button class="qp-button qp-button--sm qp-button--outline" data-run="${esc(task.id)}">立即执行</button>`
                : ''
            }</td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
      }
    </div>`

  main.querySelector('[data-new-task]')?.addEventListener('click', () => newTaskDialog())
  main.querySelectorAll('[data-run]').forEach((button) =>
    button.addEventListener(
      'click',
      guard(async () => {
        button.disabled = true
        const result = await api('POST', `/api/v1/tasks/${button.dataset.run}:run`)
        toast(result.note ?? '已排队')
        go(`/runs/${result.run.id}`)
      }),
    ),
  )
}

async function newTaskDialog() {
  if (state.apps.length === 0) {
    toast('还没有注册应用。先到「应用与用例」页面新建一个。', 'danger')
    return
  }
  const suitesByApp = {}
  for (const app of state.apps) {
    suitesByApp[app.slug] = (await api('GET', `/api/v1/apps/${app.slug}/suites`)).suites
  }
  const firstApp = state.apps[0].slug
  const body = $(`
    <form class="mxt-form">
      ${field('任务名称', '<input class="qp-input" name="name" placeholder="例如：compass 每晚回归" required>')}
      <div class="mxt-form__row">
        ${field(
          '应用',
          `<select class="qp-select" name="app">${state.apps
            .map((app) => `<option value="${esc(app.slug)}">${esc(app.displayName)}</option>`)
            .join('')}</select>`,
        )}
        ${field('测试套件', '<select class="qp-select" name="suite"></select>')}
      </div>
      ${field(
        '被测地址',
        '<input class="qp-input" name="targetUrl" placeholder="https://compass.example.internal">',
        '不要带账号密码或问号参数。桌面端套件可以留空。',
      )}
      <div class="mxt-form__row">
        ${field(
          '数据模式',
          `<select class="qp-select" name="profile">
             <option value="mock">mock —— 用假数据，安全可重复</option>
             <option value="real">real —— 打真实环境</option>
           </select>`,
        )}
        ${field(
          '轨道',
          `<select class="qp-select" name="track">
             <option value="functional">functional —— 快，用来判断对错</option>
             <option value="demo">demo —— 放慢并录像，给人看</option>
           </select>`,
        )}
      </div>
      ${field(
        '什么时候跑',
        `<select class="qp-select" name="kind">
           <option value="manual">手动 —— 我点了才跑</option>
           <option value="cron">定时重复</option>
         </select>`,
      )}
      <div data-cron hidden>
        ${field(
          '重复规则',
          '<input class="qp-input" name="cronExpr" value="0 2 * * *">',
          '五段 cron：分 时 日 月 周。<code>0 2 * * *</code> 是每天凌晨两点（北京时间）。',
        )}
      </div>
    </form>`)

  const appSelect = body.querySelector('[name=app]')
  const suiteSelect = body.querySelector('[name=suite]')
  const syncSuites = () => {
    const suites = suitesByApp[appSelect.value] ?? []
    suiteSelect.innerHTML = suites.length
      ? suites.map((suite) => `<option value="${esc(suite.slug)}">${esc(suite.displayName)}</option>`).join('')
      : '<option value="">（该应用还没有配置套件，需要管理员先建）</option>'
  }
  appSelect.value = firstApp
  syncSuites()
  appSelect.addEventListener('change', syncSuites)
  body.querySelector('[name=kind]').addEventListener('change', (event) => {
    body.querySelector('[data-cron]').hidden = event.target.value !== 'cron'
  })

  modal({
    title: '新建测试任务',
    body,
    confirmLabel: '创建',
    onConfirm: async (close) => {
      const data = Object.fromEntries(new FormData(body))
      if (!data.suite) throw new Error('该应用还没有测试套件，请先让管理员配置。')
      await api('POST', '/api/v1/tasks', {
        app: data.app,
        suite: data.suite,
        name: data.name,
        profile: data.profile,
        track: data.track,
        targetUrl: data.targetUrl || undefined,
        schedule: data.kind === 'cron' ? { kind: 'cron', cronExpr: data.cronExpr } : { kind: 'manual' },
      })
      toast('任务已创建')
      close()
      render()
    },
  })
}

async function pageRun(main, { runId }) {
  const [{ run, app, suite }, { cases }, { artifacts }] = await Promise.all([
    api('GET', `/api/v1/runs/${runId}`),
    api('GET', `/api/v1/runs/${runId}/cases`),
    api('GET', `/api/v1/runs/${runId}/artifacts`).catch(() => ({ artifacts: [] })),
  ])
  const counts = run.catalog?.counts ?? {}
  const coverage = run.catalog?.coverage ?? {}
  const base = `/api/v1/runs/${runId}/artifacts`
  const videos = artifacts.filter((entry) => /\.(mp4|webm)$/i.test(entry.path))

  const pickVideo = (testCase) => {
    if (videos.length === 0) return null
    if (testCase.specPath) {
      const name = testCase.specPath.split('/').pop()
      const hit = videos.find((entry) => entry.path.includes(name))
      if (hit) return hit
    }
    return videos.find((entry) => entry.path.includes(testCase.caseId)) ?? (videos.length === 1 ? videos[0] : null)
  }

  main.innerHTML = `
    <div class="mxt-head">
      <div>
        <h1 class="qp-heading-1">${esc(app?.displayName ?? '')} · 执行详情</h1>
        <p class="qp-body-2 qp-muted">
          ${esc(suite?.displayName ?? '')} · ${esc(run.profile)}/${esc(run.track)} ·
          ${ago(run.finishedAt ?? run.queuedAt)} · <span class="mxt-mono">${esc(run.id)}</span>
        </p>
      </div>
      <div class="mxt-actions">
        <a class="qp-button qp-button--outline" href="${base.replace('/artifacts', '/report')}" target="_blank" rel="noreferrer">完整报告</a>
        <a class="qp-button qp-button--ghost" href="${base.replace('/artifacts', '/report')}?redacted=true" target="_blank" rel="noreferrer">对外版（脱敏）</a>
      </div>
    </div>

    ${
      run.blockedReason
        ? `<div class="mxt-banner mxt-banner--danger">
             <b>本次执行受阻，不算通过。</b> ${esc(run.blockedReason)}
             <p class="qp-body-2">受阻表示环境或配置问题（目标打不开、浏览器起不来、一条用例都没跑），不是产品缺陷。</p>
           </div>`
        : ''
    }
    ${
      ['queued', 'pending-runner', 'running'].includes(run.status)
        ? `<div class="mxt-banner mxt-banner--info">
             <b>${STATUS[run.status][0]}。</b>
             ${
               run.status === 'pending-runner'
                 ? '这条套件要在真实电脑上跑，正在等一台执行机认领。到「执行机」页面看怎么把自己的电脑接进来。'
                 : '正在执行，稍后刷新即可看到结果。'
             }
           </div>`
        : ''
    }

    <div class="mxt-tiles">
      <div class="mxt-tile"><p class="qp-caption qp-muted">结果</p><p class="mxt-tile__value" style="font-size:20px">${
        STATUS[run.status]?.[0] ?? run.status
      }</p></div>
      <div class="mxt-tile mxt-tile--success"><p class="qp-caption qp-muted">通过</p><p class="mxt-tile__value">${counts.passed ?? 0}</p></div>
      <div class="mxt-tile mxt-tile--danger"><p class="qp-caption qp-muted">失败</p><p class="mxt-tile__value">${counts.failed ?? 0}</p></div>
      <div class="mxt-tile mxt-tile--warning"><p class="qp-caption qp-muted">未执行</p><p class="mxt-tile__value">${counts.notRun ?? 0}</p></div>
      <div class="mxt-tile"><p class="qp-caption qp-muted">耗时</p><p class="mxt-tile__value" style="font-size:20px">${dur(run.durationMs)}</p></div>
    </div>

    ${
      (counts.notRun ?? 0) > 0
        ? `<div class="mxt-banner mxt-banner--info">
             <b>有 ${counts.notRun} 条用例登记了但没有跑到。</b>
             <p class="qp-body-2">可能是还没写实现代码，也可能是被误删或跳过了。下面列表里状态为「未执行」的就是。</p>
           </div>`
        : ''
    }

    <div class="mxt-panel">
      <div class="mxt-panel__head">
        <h2>用例明细</h2>
        <span class="qp-body-2 qp-muted">
          目录执行率 ${coverage.catalogCompletionPercent ?? 0}% ·
          执行通过率 ${coverage.executedPassPercent ?? 0}%
        </span>
      </div>
      ${
        cases.length === 0
          ? '<div class="mxt-empty">这次执行没有用例结果。</div>'
          : cases
              .map((testCase) => {
                const video = pickVideo(testCase)
                return `
        <details class="mxt-case-row" ${testCase.status === 'failed' ? 'open' : ''}>
          <summary>
            ${statusTag(testCase.status)}
            <code>${esc(testCase.caseId)}</code>
            <span class="mxt-case-row__title">${esc(testCase.title ?? '')}</span>
            <span class="qp-caption qp-muted">${dur(testCase.durationMs)}</span>
          </summary>
          <div class="mxt-case-row__body">
            ${testCase.errorText ? `<pre class="mxt-error">${esc(testCase.errorText)}</pre>` : ''}
            ${
              testCase.status === 'notRun'
                ? '<p class="qp-body-2 qp-muted">这条用例已登记在目录里，但还没有实现代码，所以本次没有执行。</p>'
                : ''
            }
            <div class="mxt-playback">
              <div>${
                video
                  ? `<video class="mxt-video" controls preload="metadata" src="${base}/${encodeURI(video.path)}"></video>`
                  : '<p class="qp-body-2 qp-muted">这条用例没有录像。</p>'
              }</div>
              <ol class="mxt-steps">${
                testCase.steps?.length
                  ? testCase.steps
                      .map(
                        (step) => `
                  <li class="mxt-step ${step.status === 'failed' ? 'mxt-step--danger' : ''}">
                    <span class="mxt-step__seq">${step.seq}</span>
                    <span class="mxt-step__label" title="${esc(step.label)}">${esc(step.label)}</span>
                    ${
                      step.offsetMs != null && video
                        ? `<button class="mxt-step__time" data-seek="${(step.offsetMs / 1000).toFixed(2)}" title="跳到录像这一刻">${clock(step.offsetMs)}</button>`
                        : `<span class="mxt-step__time is-plain">${step.offsetMs != null ? clock(step.offsetMs) : '—'}</span>`
                    }
                  </li>`,
                      )
                      .join('')
                  : '<li class="mxt-step"><span class="qp-caption qp-muted">没有上报步骤。在用例代码里用 step() 包住每个动作，这里就会出现可点击的时间轴。</span></li>'
              }</ol>
            </div>
          </div>
        </details>`
              })
              .join('')
      }
    </div>`

  main.addEventListener('click', (event) => {
    const button = event.target.closest('[data-seek]')
    if (!button) return
    const video = button.closest('.mxt-case-row__body')?.querySelector('video')
    if (!video) return
    video.currentTime = Number(button.dataset.seek)
    video.play().catch(() => {})
  })
}

async function pageApps(main) {
  const admin = state.me?.role === 'admin'
  main.innerHTML = `
    <div class="mxt-head">
      <div><h1 class="qp-heading-1">应用与用例</h1>
        <p class="qp-body-2 qp-muted">先有应用，再有用例。用例可以在这里直接写，不需要会写代码。</p></div>
      ${admin ? '<div class="mxt-actions"><button class="qp-button qp-button--primary" data-new-app>注册应用</button></div>' : ''}
    </div>
    ${
      state.apps.length === 0
        ? `<div class="mxt-guide"><div class="mxt-guide__body">
             <h3>还没有应用</h3>
             <p>「应用」就是要测的那个系统，比如罗盘。注册后就能在它下面登记用例、建测试任务。</p>
             ${admin ? '<p>点右上角「注册应用」开始。</p>' : '<p>这一步需要管理员权限，找管理员开一个即可。</p>'}
           </div></div>`
        : `<div class="mxt-panel"><div class="mxt-table__wrap"><table class="mxt-table">
        <thead><tr><th>应用</th><th>标识</th><th>形态</th><th></th></tr></thead>
        <tbody>${state.apps
          .map(
            (app) => `
          <tr>
            <td><b>${esc(app.displayName)}</b></td>
            <td><code>${esc(app.slug)}</code></td>
            <td class="qp-body-2 qp-muted">${(app.surfaces ?? []).join('、') || '—'}</td>
            <td><a class="mxt-link" href="/apps/${esc(app.slug)}/cases" data-nav>管理用例 →</a></td>
          </tr>`,
          )
          .join('')}</tbody></table></div></div>`
    }`

  main.querySelector('[data-new-app]')?.addEventListener('click', () => {
    const body = $(`
      <form class="mxt-form">
        ${field('应用名称', '<input class="qp-input" name="displayName" placeholder="罗盘 Compass" required>')}
        ${field('标识', '<input class="qp-input" name="slug" placeholder="compass" required>', '小写字母、数字、连字符。建任务时用它。')}
        ${field('代码仓库', '<input class="qp-input" name="repoUrl" placeholder="https://git.internal/luopan/po-frontend.git">', '服务端执行时从这里拉代码。可以先留空。')}
      </form>`)
    modal({
      title: '注册应用',
      body,
      confirmLabel: '创建',
      onConfirm: async (close) => {
        const data = Object.fromEntries(new FormData(body))
        await api('POST', '/api/v1/apps', {
          slug: data.slug,
          displayName: data.displayName,
          repoUrl: data.repoUrl || undefined,
          surfaces: ['web', 'electron'],
        })
        toast('应用已注册')
        close()
        state.apps = (await api('GET', '/api/v1/apps')).apps
        render()
      },
    })
  })
}

async function pageCases(main, { app: appSlug }) {
  const { cases } = await api('GET', `/api/v1/apps/${appSlug}/cases`)
  const app = state.apps.find((entry) => entry.slug === appSlug)
  const canEdit = state.me?.role !== 'viewer'
  const pending = cases.filter((entry) => !entry.implemented)

  main.innerHTML = `
    <div class="mxt-head">
      <div>
        <h1 class="qp-heading-1">${esc(app?.displayName ?? appSlug)} · 用例</h1>
        <p class="qp-body-2 qp-muted">共 ${cases.length} 条，其中 ${pending.length} 条还没有实现代码。</p>
      </div>
      <div class="mxt-actions">
        ${canEdit ? '<button class="qp-button qp-button--primary" data-new-case>写一条用例</button>' : ''}
        <a class="qp-button qp-button--ghost" href="/api/v1/apps/${esc(appSlug)}/cases:export" target="_blank" rel="noreferrer">导出给开发</a>
      </div>
    </div>

    <div class="mxt-guide"><div class="mxt-guide__body">
      <h3>用例是怎么走完一生的</h3>
      <p>你在这里写清楚<b>要验证什么</b>；工程师照着写实现代码。没有实现之前，它在每份报告里都显示「未执行」，不会被忘掉。</p>
      <ol>
        <li>你写用例 —— 编号、标题、前置条件、每一步做什么、期望看到什么</li>
        <li>点「导出给开发」拿到目录文件，工程师提交进代码仓库并实现</li>
        <li>实现后跑一次，这条用例就会有真实结果和录像</li>
      </ol>
    </div></div>

    <div class="mxt-panel">
      ${
        cases.length === 0
          ? '<div class="mxt-empty">还没有用例。点右上角「写一条用例」开始，不需要写代码。</div>'
          : `<div class="mxt-table__wrap"><table class="mxt-table">
        <thead><tr><th>编号</th><th>标题</th><th>优先级</th><th>实现</th><th>最近结果</th><th>来源</th><th></th></tr></thead>
        <tbody>${cases
          .map(
            (entry) => `
          <tr>
            <td><code>${esc(entry.caseId)}</code></td>
            <td>${esc(entry.title)}</td>
            <td class="qp-body-2">${esc(entry.priority)}</td>
            <td>${
              entry.implemented
                ? '<span class="mxt-status mxt-status--success">已实现</span>'
                : '<span class="mxt-status mxt-status--warning">待实现</span>'
            }</td>
            <td>${
              entry.lastRunId
                ? `<a class="mxt-link" href="/runs/${esc(entry.lastRunId)}" data-nav>${STATUS[entry.lastStatus]?.[0] ?? entry.lastStatus}</a>`
                : '<span class="qp-muted qp-body-2">—</span>'
            }</td>
            <td class="qp-body-2 qp-muted">${entry.origin === 'platform' ? '界面登记' : '代码仓库'}</td>
            <td>${
              canEdit && entry.origin === 'platform'
                ? `<button class="qp-button qp-button--sm qp-button--ghost" data-edit="${esc(entry.caseId)}">编辑</button>`
                : ''
            }</td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
      }
    </div>`

  const openEditor = (existing) => caseDialog(appSlug, existing, () => render())
  main.querySelector('[data-new-case]')?.addEventListener('click', () => openEditor(null))
  main.querySelectorAll('[data-edit]').forEach((button) =>
    button.addEventListener('click', () =>
      openEditor(cases.find((entry) => entry.caseId === button.dataset.edit)),
    ),
  )
}

function caseDialog(appSlug, existing, onDone) {
  const steps = existing?.steps?.length ? existing.steps : [{ action: '', expect: '' }]
  const body = $(`
    <form class="mxt-form">
      <div class="mxt-form__row">
        ${field(
          '用例编号',
          `<input class="qp-input" name="caseId" value="${esc(existing?.caseId ?? '')}" placeholder="CPS-FE-LOGIN-001" ${existing ? 'readonly' : ''} required>`,
          '格式：应用-端-业务域-序号。端用 FE（网页）或 EL（桌面）。',
        )}
        ${field(
          '优先级',
          `<select class="qp-select" name="priority">
             ${['P0', 'P1', 'P2']
               .map(
                 (level) =>
                   `<option value="${level}" ${existing?.priority === level ? 'selected' : ''}>${level}${
                     level === 'P0' ? ' —— 核心，坏了不能发版' : level === 'P1' ? ' —— 重要' : ' —— 一般'
                   }</option>`,
               )
               .join('')}
           </select>`,
        )}
      </div>
      ${field(
        '这条用例验证什么',
        `<input class="qp-input" name="title" value="${esc(existing?.title ?? '')}" placeholder="未登录用户访问受保护页面时跳转登录并保留目标地址" required>`,
        '写成一句话，说明「在什么情况下，应该发生什么」。',
      )}
      ${field(
        '前置条件',
        `<textarea class="qp-textarea" name="preconditions" rows="2" placeholder="例如：已有一个未登录的浏览器会话">${esc(existing?.preconditions ?? '')}</textarea>`,
      )}
      <div class="qp-field">
        <span class="qp-field__label">测试步骤</span>
        <div class="mxt-steps-editor" data-steps></div>
        <button type="button" class="qp-button qp-button--sm qp-button--ghost" data-add-step style="align-self:flex-start;margin-top:8px">+ 加一步</button>
        <span class="mxt-hint">左边写「做什么」，右边写「应该看到什么」。这两列就是工程师写代码的依据。</span>
      </div>
      ${field(
        '需求编号',
        `<input class="qp-input" name="requirementRef" value="${esc(existing?.requirementRef ?? '')}" placeholder="COMPASS-142">`,
        '填了才能算需求覆盖率，可以留空。',
      )}
    </form>`)

  const container = body.querySelector('[data-steps]')
  const paint = () => {
    container.innerHTML = steps
      .map(
        (step, index) => `
      <div class="mxt-step-row">
        <span class="mxt-step-row__num">${index + 1}</span>
        <input class="qp-input" data-action="${index}" value="${esc(step.action)}" placeholder="打开 /strategy">
        <input class="qp-input" data-expect="${index}" value="${esc(step.expect)}" placeholder="跳转到登录页，地址带 redirect=/strategy">
        <button type="button" class="qp-icon-button" data-drop="${index}" title="删除这一步">✕</button>
      </div>`,
      )
      .join('')
  }
  paint()
  container.addEventListener('input', (event) => {
    const target = event.target
    if (target.dataset.action !== undefined) steps[Number(target.dataset.action)].action = target.value
    if (target.dataset.expect !== undefined) steps[Number(target.dataset.expect)].expect = target.value
  })
  container.addEventListener('click', (event) => {
    const button = event.target.closest('[data-drop]')
    if (!button) return
    steps.splice(Number(button.dataset.drop), 1)
    if (steps.length === 0) steps.push({ action: '', expect: '' })
    paint()
  })
  body.querySelector('[data-add-step]').addEventListener('click', () => {
    steps.push({ action: '', expect: '' })
    paint()
  })

  modal({
    title: existing ? `编辑 ${existing.caseId}` : '写一条用例',
    body,
    wide: true,
    confirmLabel: existing ? '保存' : '创建',
    onConfirm: async (close) => {
      const data = Object.fromEntries(new FormData(body))
      const payload = {
        caseId: data.caseId,
        title: data.title,
        priority: data.priority,
        preconditions: data.preconditions || undefined,
        requirementRef: data.requirementRef || undefined,
        steps: steps.filter((step) => step.action || step.expect),
      }
      if (existing) {
        await api('PUT', `/api/v1/apps/${appSlug}/cases/${existing.caseId}`, payload)
      } else {
        await api('POST', `/api/v1/apps/${appSlug}/cases`, payload)
      }
      toast(existing ? '用例已更新' : '用例已登记，它会出现在报告里，状态是「待实现」')
      close()
      onDone()
    },
  })
}

async function pageRunners(main) {
  const { runners } = await api('GET', '/api/v1/runners')
  const origin = location.origin
  main.innerHTML = `
    <div class="mxt-head"><div>
      <h1 class="qp-heading-1">执行机</h1>
      <p class="qp-body-2 qp-muted">网页测试由服务器自动跑；桌面应用测试需要一台真实的 Windows 或 Mac。</p>
    </div></div>

    <div class="mxt-guide"><div class="mxt-guide__body">
      <h3>把自己的电脑变成执行机</h3>
      <p>桌面端（Electron）测试没法在服务器上跑——服务器上没有 Windows 和 macOS。用下面三条命令把你的电脑接进来，任务就会派给它。</p>
      <pre class="mxt-error" style="background:var(--qp-bg-3);border-color:var(--qp-line);color:var(--qp-text-2)">npx mxt-runner login --server ${esc(origin)}
npx mxt-runner register --name "我的电脑"
npx mxt-runner watch</pre>
      <p class="qp-body-2">用你自己的 mx-launcher 账号登录即可，不需要额外开通。跑完关掉窗口就行。</p>
    </div></div>

    <div class="mxt-panel">
      ${
        runners.length === 0
          ? '<div class="mxt-empty">还没有执行机。<br>网页测试仍然可以跑（服务器自动执行），桌面测试需要先接一台电脑进来。</div>'
          : `<div class="mxt-table__wrap"><table class="mxt-table">
        <thead><tr><th>名称</th><th>状态</th><th>系统</th><th>能跑什么</th><th>归属</th><th>最近活跃</th></tr></thead>
        <tbody>${runners
          .map(
            (runner) => `
          <tr>
            <td><b>${esc(runner.name)}</b></td>
            <td>${statusTag(runner.status === 'offline' ? 'expired' : runner.status === 'busy' ? 'running' : 'passed')}</td>
            <td class="qp-body-2">${esc(runner.os)}${runner.arch ? ` / ${esc(runner.arch)}` : ''}</td>
            <td class="qp-body-2 qp-muted">${(runner.capabilities?.surfaces ?? []).join('、')}</td>
            <td class="qp-body-2 qp-muted">${esc(runner.ownerPrincipal ?? '—')}</td>
            <td class="qp-body-2 qp-muted">${ago(runner.lastSeenAt)}</td>
          </tr>`,
          )
          .join('')}</tbody></table></div>`
      }
    </div>`
}

async function pageMembers(main) {
  const { members } = await api('GET', '/api/v1/members')
  main.innerHTML = `
    <div class="mxt-head"><div>
      <h1 class="qp-heading-1">成员</h1>
      <p class="qp-body-2 qp-muted">账号来自 mx-launcher，这里只管在测试平台里能做什么。新人首次登录默认是「只读」。</p>
    </div></div>
    <div class="mxt-panel"><div class="mxt-table__wrap"><table class="mxt-table">
      <thead><tr><th>成员</th><th>权限</th><th>最近登录</th></tr></thead>
      <tbody>${members
        .map(
          (member) => `
        <tr>
          <td><b>${esc(member.displayName)}</b><div class="qp-caption qp-muted mxt-mono">${esc(member.principalId)}</div></td>
          <td>
            <select class="qp-select" data-role="${esc(member.principalId)}" style="max-width:220px">
              <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>只读 —— 只能看</option>
              <option value="operator" ${member.role === 'operator' ? 'selected' : ''}>测试工程师 —— 写用例、建任务、跑测试</option>
              <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>管理员 —— 还能注册应用和套件</option>
            </select>
          </td>
          <td class="qp-body-2 qp-muted">${ago(member.lastSeenAt)}</td>
        </tr>`,
        )
        .join('')}</tbody></table></div></div>`

  main.querySelectorAll('[data-role]').forEach((select) =>
    select.addEventListener(
      'change',
      guard(async () => {
        await api('PATCH', `/api/v1/members/${select.dataset.role}`, { role: select.value })
        toast('权限已更新')
      }),
    ),
  )
}

function pageHelp(main) {
  main.innerHTML = `
    <div class="mxt-head"><div><h1 class="qp-heading-1">新手指引</h1>
      <p class="qp-body-2 qp-muted">五分钟看完，够你独立跑通一次测试。</p></div></div>

    <div class="mxt-panel"><div style="padding:var(--qp-space-5);line-height:1.9" class="qp-body-1">
      <h2 class="qp-heading-2">这个平台在做什么</h2>
      <p class="qp-muted">它替你反复执行测试，把结果、报告和录像留下来。你不需要每次手动点一遍页面。</p>

      <h2 class="qp-heading-2" style="margin-top:24px">四个概念</h2>
      <ul class="qp-muted">
        <li><b>应用</b> —— 要测的系统，比如罗盘。</li>
        <li><b>用例</b> —— 一条要验证的事，比如「未登录访问受保护页面应该跳登录」。你可以在界面上直接写。</li>
        <li><b>任务</b> —— 什么时候、用什么方式跑哪些用例。可以手动点，也可以每天定时。</li>
        <li><b>执行</b> —— 任务跑的一次，产生结果、报告和录像。</li>
      </ul>

      <h2 class="qp-heading-2" style="margin-top:24px">你最常做的三件事</h2>
      <ol class="qp-muted">
        <li><b>写用例</b>：应用与用例 → 选应用 → 写一条用例。写清楚每步做什么、期望看到什么。不需要写代码。</li>
        <li><b>跑测试</b>：测试任务 → 立即执行。跑完点进去看结果。</li>
        <li><b>看失败</b>：执行详情里失败的用例会自动展开，点步骤右边的时间就跳到录像的那一刻。</li>
      </ol>

      <h2 class="qp-heading-2" style="margin-top:24px">三个容易误解的地方</h2>
      <ul class="qp-muted">
        <li><b>「受阻」不等于「失败」</b>。受阻是环境问题——地址打不开、浏览器起不来、一条用例都没跑。它永远不算通过，但也不说明产品有 bug。</li>
        <li><b>「未执行」很重要</b>。用例登记了却没跑到，报告会单独标出来。否则删掉一条失败用例就能让结果变绿。</li>
        <li><b>覆盖率有三个不同的分母</b>。报告里分开列，不能互相替代，也都不等于「产品需求覆盖率」。</li>
      </ul>

      <h2 class="qp-heading-2" style="margin-top:24px">权限</h2>
      <p class="qp-muted">用 mx-launcher 账号登录。首次登录是「只读」，找管理员在「成员」页面升成「测试工程师」就能写用例和跑测试。</p>
    </div></div>`
}

// -- login -------------------------------------------------------------------

function renderLogin(root) {
  const card = $(`
    <div class="mxt-login">
      <div class="mxt-login__card">
        <div class="mxt-brand" style="margin-bottom:20px">
          <div class="mxt-brand__mark">MX</div>
          <div><div class="qp-heading-2">测试平台</div><div class="qp-caption qp-muted">用 mx-launcher 账号登录</div></div>
        </div>
        <form class="mxt-form">
          ${field('账号', '<input class="qp-input" name="username" autocomplete="username" required>')}
          ${field('密码', '<input class="qp-input" type="password" name="password" autocomplete="current-password" required>')}
          <button class="qp-button qp-button--primary qp-button--block" type="submit">登录</button>
        </form>
        <p class="mxt-hint" style="margin-top:16px">没有账号？用你平时登录 MX 的那一个即可。首次登录会自动开通只读权限。</p>
      </div>
    </div>`)
  const form = card.querySelector('form')
  form.addEventListener(
    'submit',
    guard(async (event) => {
      event.preventDefault()
      const data = Object.fromEntries(new FormData(form))
      const result = await api('POST', '/api/v1/auth/login', data)
      state.me = { ...result.member, id: result.member.principalId }
      await boot()
    }),
  )
  root.replaceChildren(card)
}

// -- render ------------------------------------------------------------------

const PAGES = {
  overview: pageOverview,
  apps: pageApps,
  cases: pageCases,
  tasks: pageTasks,
  runs: pageRuns,
  run: pageRun,
  runners: pageRunners,
  members: pageMembers,
  help: pageHelp,
}

async function render() {
  const root = document.getElementById('root')
  root.className = ''
  if (!state.me) {
    renderLogin(root)
    return
  }
  const frame = shell()
  root.replaceChildren(frame)
  frame.querySelector('[data-logout]').addEventListener(
    'click',
    guard(async () => {
      await api('POST', '/api/v1/auth/logout')
      state.me = null
      render()
    }),
  )
  const main = frame.querySelector('.mxt-main')
  main.innerHTML = '<div class="qp-spinner"></div>'
  try {
    await PAGES[state.route.name](main, state.route.params)
  } catch (error) {
    main.innerHTML = `<div class="mxt-banner mxt-banner--danger"><b>加载失败</b><p>${esc(error.message)}</p></div>`
  }
}

async function boot() {
  state.route = resolveRoute()
  try {
    const { member } = await api('GET', '/api/v1/auth/me')
    state.me = member
    state.apps = (await api('GET', '/api/v1/apps')).apps
  } catch {
    state.me = null
  }
  render()
}

boot()
