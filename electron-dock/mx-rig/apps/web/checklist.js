// 上手清单：一个项目从登记到第一次定时运行还差哪几步（docs/21 M6）。
//
// Each step is judged from the project's real state, never from a click, and
// says what to do next. Once every required step is done the list folds away.

import { h } from './views.js'
import { button, note } from './project-settings.js'
import { checklistSteps } from './project-model.js'

const go = (ctx, tab) => {
  ctx.state.projectTab = tab
  ctx.state.runDetail = null
  return ctx.render()
}

function action(ctx, step, { admin, native }) {
  if (step.done) return null
  switch (step.key) {
    case 'suite':
      return admin ? button('去新建执行方式', () => go(ctx, 'settings'), { 'data-checklist-go': 'suite' }) : note('请管理员在「设置」里建。')
    case 'cases':
      return button('去写用例', () => go(ctx, 'catalog'), { 'data-checklist-go': 'cases' })
    case 'plan':
      return button('去新建执行计划', () => go(ctx, 'plans'), { 'data-checklist-go': 'plan' })
    case 'machine':
      return native
        ? button(
            '在本机托管并启动执行机',
            () =>
              ctx.run(async () => {
                let runner = await ctx.api('runner-status')
                if (!runner.registered) runner = await ctx.api('runner-register', {})
                if (!runner.running) await ctx.api('runner-start')
                ctx.notice(`本机执行机「${runner.name ?? '本机'}」已启动；指定给它或「任意执行机」的计划会由它接手。`)
                await ctx.render()
              }),
            { 'data-checklist-go': 'machine' }
          )
        : button('去接入执行机', () => ctx.go('runners'), { 'data-checklist-go': 'machine' })
    case 'verify':
      return button('去立即执行', () => go(ctx, 'plans'), { 'data-checklist-go': 'verify' })
    case 'schedule':
      return button('去开启定时', () => go(ctx, 'plans'), { 'data-checklist-go': 'schedule' })
    default:
      return null
  }
}

export async function setupChecklist(ctx, app) {
  const [{ suites = [] }, { cases = [] }, { tasks = [] }, { runners = [] }, { runs = [] }] = await Promise.all([
    ctx.api('app-suites', { app: app.slug }).catch(() => ({ suites: [] })),
    ctx.api('app-cases', { app: app.slug }).catch(() => ({ cases: [] })),
    ctx.api('app-tasks', { app: app.slug }).catch(() => ({ tasks: [] })),
    ctx.api('runners').catch(() => ({ runners: [] })),
    ctx.api('app-runs', { app: app.slug }).catch(() => ({ runs: [] }))
  ])
  const steps = checklistSteps({ suites, cases, plans: tasks, runners, runs })
  const required = steps.filter((step) => step.required)
  const left = required.filter((step) => !step.done).length
  const options = { admin: ctx.state.principal?.role === 'admin', native: Boolean(ctx.state.native) }
  // The first required step not done is the one to do now.
  const next = steps.find((step) => step.required && !step.done)
  const details = h(
    'details',
    { class: 'qp-panel rig-section rig-checklist', id: 'setup-checklist', 'data-left': String(left) },
    h(
      'summary',
      { class: 'qp-body-1 qp-body-1--semibold' },
      left ? `上手清单 · 还差 ${left} 步` : '上手清单 · 已经可以定时运行'
    ),
    note('新项目的顺序：执行方式 → 用例 → 执行计划 → 执行机 → 立即执行并确认通过 → 再开启定时。每一项都按这个项目的真实状态判断。'),
    h(
      'ol',
      { class: 'rig-checklist__steps' },
      ...steps.map((step) =>
        h(
          'li',
          { 'data-step': step.key, 'data-done': step.done ? 'true' : 'false', 'data-next': step === next ? 'true' : 'false' },
          h('span', { class: 'rig-checklist__mark', text: step.done ? '✓' : step.required ? '○' : '·' }),
          h(
            'div',
            { class: 'rig-checklist__text' },
            h('strong', { class: 'qp-body-2', text: `${step.title}${step.required ? '' : '（建议）'}` }),
            h('span', { class: 'qp-caption qp-muted', text: step.detail })
          ),
          action(ctx, step, options)
        )
      )
    )
  )
  details.open = left > 0 && ctx.state.checklistOpen?.[app.slug] !== false
  details.ontoggle = () => {
    ctx.state.checklistOpen = { ...(ctx.state.checklistOpen ?? {}), [app.slug]: details.open }
  }
  return details
}
