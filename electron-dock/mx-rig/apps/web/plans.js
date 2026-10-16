// 执行计划 (docs/21 M3): what runs, where and when — the kernel's `mxt_tasks`,
// called 测试任务 by the old console. A plan can be run now, run on a cron, or
// chosen by a test task when it dispatches. Procedure regression is a plan
// too (执行方式 = 规程回放), so it is listed here beside the others.

import { h, empty } from './views.js'
import { bound, button, field, note, section } from './project-settings.js'
import { openRun } from './run-detail.js'
import { workspacePanel } from './packs.js'
import { repositoryPanel } from './repository.js'
import { filterLabel } from './run-model.js'
import { planVerification, VERIFICATION_TEXT } from './project-model.js'

const RUNS_ON_LABEL = { server: '服务器', 'any-runner': '任意执行机', 'pinned-runner': '指定执行机' }

/** A plan's draft from a stored plan, or a fresh one for the first suite. */
function draftOf(task, suites) {
  if (task)
    return {
      name: task.name ?? '',
      suite: suites.find((entry) => entry.id === task.suiteId)?.slug ?? '',
      targetUrl: task.targetUrl ?? '',
      profile: task.profile ?? 'mock',
      track: task.track ?? 'functional',
      runsOn: task.runsOn ?? 'any-runner',
      runnerId: task.runnerId ?? '',
      caseFilter: task.caseFilter ?? '',
      scheduleKind: task.scheduleKind === 'cron' ? 'cron' : 'manual',
      cronExpr: task.cronExpr ?? '0 2 * * *',
      wasScheduled: task.scheduleKind === 'cron',
      enabled: task.enabled !== false
    }
  const first = suites.find((entry) => entry.engine !== 'rig-procedure') ?? suites[0]
  return {
    name: '',
    suite: first?.slug ?? '',
    targetUrl: '',
    profile: 'mock',
    track: 'functional',
    runsOn: first?.runnerKind === 'server' ? 'server' : 'any-runner',
    runnerId: '',
    caseFilter: '',
    scheduleKind: 'manual',
    cronExpr: '0 2 * * *',
    enabled: true
  }
}

/**
 * The plan form. `onSaved(task)` runs after the service accepted it; the
 * service also checks that the chosen place can run the chosen suite.
 * Scheduling is offered only for a `verified` plan (its latest finished run
 * passed): a new plan is manual, is run once, and is scheduled after that.
 */
export function planForm(ctx, app, { suites, runners, editing, onSaved, onCancel, verified = false }) {
  const { draft } = editing
  const isNew = editing.mode === 'new'
  const canSchedule = !isNew && (verified || draft.wasScheduled)
  const suite = () => suites.find((entry) => entry.slug === draft.suite)
  const online = runners.filter((runner) => runner.online)
  const hint = h('p', { class: 'qp-caption qp-muted', id: 'plan-hint' })
  const targetInput = bound('input', draft, 'targetUrl', { id: 'plan-target', placeholder: 'https://test.example.internal（不要带账号密码或问号参数）' })
  const placeRunner = h('div', { class: 'qp-row' })
  const cronRow = h('div', { class: 'qp-row' })
  // What the chosen suite allows: a self-hosted target takes no address, a
  // desktop suite cannot run on the server, a pinned plan names a machine.
  const sync = () => {
    const chosen = suite()
    const self = chosen?.targetMode === 'self'
    targetInput.disabled = self
    if (self) draft.targetUrl = ''
    targetInput.value = draft.targetUrl
    const desktop = chosen?.surface === 'electron'
    if (desktop && draft.runsOn === 'server') draft.runsOn = 'any-runner'
    place.value = draft.runsOn
    for (const option of place.options) option.disabled = option.value === 'server' && desktop
    hint.textContent = !chosen
      ? '这个项目还没有执行方式；先在项目「设置」里建一个。'
      : `${chosen.displayName}：${chosen.engine} · ${chosen.surface === 'electron' ? '桌面端' : '网页'} · ${
          self ? '测试自己起被测目标，不需要地址' : '对地址运行'
        }${desktop ? '；桌面端只能在执行机上跑' : ''}`
    placeRunner.replaceChildren(
      ...(draft.runsOn === 'pinned-runner'
        ? [
            field(
              '哪一台',
              bound('select', draft, 'runnerId', {
                id: 'plan-runner',
                options: online.length ? online.map((runner) => [runner.id, `${runner.name} · ${runner.os}${runner.mine ? '（我的）' : ''}`]) : [['', '（当前没有在线执行机）']]
              })
            )
          ]
        : [])
    )
    if (draft.runsOn === 'pinned-runner' && !draft.runnerId && online[0]) draft.runnerId = online[0].id
    cronRow.replaceChildren(
      ...(draft.scheduleKind === 'cron'
        ? [field('重复规则', bound('input', draft, 'cronExpr', { id: 'plan-cron' }), '五段 cron：分 时 日 月 周。0 2 * * * 是每天凌晨两点（服务端时区）')]
        : [])
    )
  }
  const suitePicker = bound('select', draft, 'suite', {
    id: 'plan-suite',
    disabled: !isNew,
    options: suites.map((entry) => [entry.slug, `${entry.displayName}（${entry.engine}）`])
  })
  suitePicker.addEventListener('change', sync)
  const place = bound('select', draft, 'runsOn', {
    id: 'plan-runs-on',
    options: [
      ['server', '服务器静默跑 —— 快，出报告，不录像'],
      ['any-runner', '任意执行机 —— 谁先空出来谁跑'],
      ['pinned-runner', '指定一台执行机']
    ]
  })
  place.addEventListener('change', sync)
  const when = bound('select', draft, 'scheduleKind', {
    id: 'plan-schedule',
    options: [['manual', '手动 —— 点了才跑'], ['cron', canSchedule ? '定时重复' : '定时重复（先立即执行一次并通过）']]
  })
  when.querySelector('option[value="cron"]').disabled = !canSchedule
  when.addEventListener('change', sync)
  const scheduleNote = !canSchedule
    ? note(isNew ? '定时要先验证：新计划先手动立即执行一次，结果通过后再回来开启定时。' : '这个计划最近一次执行还没有通过；先立即执行并确认通过，再开启定时。')
    : !verified && draft.wasScheduled
      ? h('p', { class: 'qp-caption rig-warning-line', text: '这个计划还没有通过的执行；定时触发的结果可能一直是失败或受阻。' })
      : null
  const form = h(
    'form',
    {
      class: 'rig-plan-form',
      id: 'plan-form',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          const schedule = draft.scheduleKind === 'cron' ? { kind: 'cron', cronExpr: draft.cronExpr.trim() } : { kind: 'manual' }
          const common = {
            name: draft.name.trim(),
            profile: draft.profile,
            track: draft.track,
            targetUrl: draft.targetUrl.trim() || undefined,
            caseFilter: draft.caseFilter.trim() || undefined,
            runsOn: draft.runsOn,
            ...(draft.runsOn === 'pinned-runner' ? { runnerId: draft.runnerId } : {}),
            schedule
          }
          const saved = isNew
            ? await ctx.api('plan-create', { app: app.slug, suite: draft.suite, ...common })
            : await ctx.api('plan-update', { id: editing.id, ...common, enabled: Boolean(draft.enabled), caseFilter: draft.caseFilter.trim() })
          ctx.notice(isNew ? `已新建执行计划「${common.name}」` : `已更新执行计划「${common.name}」`)
          await onSaved?.(saved.task)
        })
      }
    },
    h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: isNew ? '新建执行计划' : `编辑执行计划 · ${draft.name}` }),
    note('执行计划 = 执行方式 + 环境 + 跑哪些 + 在哪跑 + 什么时候跑。登记计划不会自动开始测试。'),
    h(
      'div',
      { class: 'qp-row' },
      field('名称', bound('input', draft, 'name', { id: 'plan-name', required: true, placeholder: '例如：Luopan 每晚冒烟' })),
      field('执行方式', suitePicker, isNew ? null : '执行方式建好后不能改；要换就新建一个计划')
    ),
    hint,
    field('被测地址', targetInput),
    h(
      'div',
      { class: 'qp-row' },
      field('数据模式', bound('select', draft, 'profile', { id: 'plan-profile', options: [['mock', 'mock —— 假数据，安全可重复'], ['real', 'real —— 打真实环境']] })),
      field('轨道', bound('select', draft, 'track', { id: 'plan-track', options: [['functional', 'functional —— 快，判断对错'], ['demo', 'demo —— 放慢并录像，给人看']] }))
    ),
    field('在哪跑', place),
    placeRunner,
    field('只跑其中几条（可选）', bound('input', draft, 'caseFilter', { id: 'plan-filter', placeholder: 'LP-FE-AUTH-001, smoke/*.cy.ts' }), '逗号分隔：用例编号或 spec 路径。留空跑整套；填了之后覆盖率只按这几条算'),
    field('什么时候跑', when),
    scheduleNote,
    cronRow,
    isNew
      ? null
      : h('label', { class: 'qp-choice qp-choice--checkbox' }, bound('input', draft, 'enabled', { type: 'checkbox', id: 'plan-enabled' }), h('span', { class: 'qp-choice__control' }), h('span', { text: '启用（停用后不定时触发，也不能派发）' })),
    h(
      'div',
      { class: 'qp-row' },
      h('button', { type: 'submit', class: 'qp-button qp-button--primary qp-button--sm', text: isNew ? '新建计划' : '保存', disabled: !suites.length }),
      button('取消', () => onCancel?.(), { class: 'qp-button qp-button--ghost qp-button--sm' })
    )
  )
  sync()
  return form
}

/** 执行计划 tab of a project: list, run now, edit, enable or stop, delete, and new. */
export async function planTab(ctx, mount, app, access) {
  const { state } = ctx
  const canWrite = access.canWrite && ['operator', 'admin'].includes(state.principal?.role)
  const [{ tasks: plans = [] }, { suites = [] }, { runners = [] }, { runs = [] }] = await Promise.all([
    ctx.api('app-tasks', { app: app.slug }),
    ctx.api('app-suites', { app: app.slug }),
    ctx.api('runners').catch(() => ({ runners: [] })),
    ctx.api('app-runs', { app: app.slug }).catch(() => ({ runs: [] }))
  ])
  const verdicts = new Map(plans.map((plan) => [plan.id, planVerification(plan, runs)]))
  const suiteById = new Map(suites.map((entry) => [entry.id, entry]))
  const editing = state.planEdit?.app === app.slug ? state.planEdit : null
  const workspace = await workspacePanel(ctx, app, { suites, plans, admin: state.principal?.role === 'admin' })
  if (workspace) mount.append(workspace)
  const repository = await repositoryPanel(ctx, app, { suites, runs, plans }).catch((error) => section('测试仓库', note(error.message)))
  if (repository) mount.append(repository)
  const close = async () => {
    state.planEdit = null
    await ctx.render()
  }
  mount.append(
    section(
      '执行计划',
      note('执行计划回答“怎么跑、在哪跑、跑哪些、什么时候跑”，可以立即执行、定时执行，也可以在测试任务的「执行与结果」里选用。规程回归也是一种执行计划（执行方式为规程回放）。'),
      canWrite
        ? h(
            'div',
            { class: 'qp-row' },
            button(
              '新建执行计划',
              () => {
                state.planEdit = { app: app.slug, mode: 'new', draft: draftOf(null, suites) }
                ctx.render()
              },
              { class: 'qp-button qp-button--primary qp-button--sm', id: 'plan-new', disabled: !suites.length }
            ),
            suites.length ? null : note('这个项目还没有执行方式；管理员先在「设置」里建一个。')
          )
        : null,
      editing
        ? planForm(ctx, app, { suites, runners, editing, onSaved: close, onCancel: close, verified: verdicts.get(editing.id)?.state === 'verified' })
        : null,
      plans.length
        ? h(
            'div',
            { class: 'rig-cards' },
            ...plans.map((plan) => {
              const suite = suiteById.get(plan.suiteId)
              const procedure = suite?.engine === 'rig-procedure'
              const justRun = state.planRun?.planId === plan.id ? state.planRun : null
              const verdict = verdicts.get(plan.id)
              return h(
                'article',
                { class: 'qp-panel qp-card rig-section', 'data-plan': plan.id },
                h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: plan.name || plan.id }),
                h('div', { class: 'qp-caption qp-muted', text: `${procedure ? '规程回归' : suite?.displayName ?? '执行方式已删除'} · ${plan.id}` }),
                h(
                  'div',
                  { class: 'rig-chips' },
                  h('span', { class: 'rig-chip', text: `${plan.profile ?? '—'} / ${plan.track ?? '—'}` }),
                  h('span', { class: 'rig-chip', text: RUNS_ON_LABEL[plan.runsOn] ?? plan.runsOn ?? '按执行方式默认' }),
                  h('span', { class: 'rig-chip', text: plan.scheduleKind === 'cron' ? `定时 ${plan.cronExpr ?? ''}` : plan.scheduleKind === 'once' ? '定时一次' : '手动' }),
                  plan.scheduleKind === 'cron' && plan.enabled !== false && plan.nextRunAt
                    ? h('span', { class: 'rig-chip', text: `下次 ${new Date(plan.nextRunAt).toLocaleString()}` })
                    : null,
                  plan.caseFilter ? h('span', { class: 'rig-chip', text: filterLabel(plan.caseFilter), title: plan.caseFilter }) : null,
                  plan.enabled === false ? h('span', { class: 'rig-chip', text: '已停用' }) : null,
                  h('span', {
                    class: 'rig-chip',
                    'data-verification': verdict.state,
                    text: verdict.active
                      ? '正在执行'
                      : `${VERIFICATION_TEXT[verdict.state]}${verdict.run?.finishedAt ? ` · ${new Date(verdict.run.finishedAt).toLocaleString()}` : ''}`,
                    title: '已验证 = 最近一次执行通过；验证过的计划才能开启定时'
                  })
                ),
                verdict.state !== 'verified' && plan.scheduleKind !== 'cron' && !procedure
                  ? note('先立即执行一次，确认通过后再开启定时。')
                  : null,
                justRun
                  ? h('p', { class: 'qp-caption', 'data-plan-run': justRun.runId, text: `刚刚派发 ${justRun.runId}：${justRun.note}` })
                  : null,
                h(
                  'div',
                  { class: 'qp-row' },
                  canWrite
                    ? button(
                        '立即执行',
                        () =>
                          ctx.run(async () => {
                            const result = await ctx.api('plan-run', { id: plan.id })
                            state.planRun = { planId: plan.id, runId: result.run.id, note: result.note ?? '已排队' }
                            ctx.notice(`已派发「${plan.name}」：${result.note ?? '已排队'}`)
                            await ctx.render()
                          }),
                        { class: 'qp-button qp-button--primary qp-button--sm', 'data-plan-run-now': plan.id, 'data-plan-name': plan.name, disabled: plan.enabled === false }
                      )
                    : null,
                  plan.lastRunId || justRun
                    ? button('最近一次执行', () => openRun(ctx, justRun?.runId ?? plan.lastRunId), { class: 'qp-button qp-button--ghost qp-button--sm', 'data-plan-last-run': plan.id })
                    : null,
                  canWrite
                    ? button(
                        '编辑',
                        () => {
                          state.planEdit = { app: app.slug, mode: 'edit', id: plan.id, draft: draftOf(plan, suites) }
                          ctx.render()
                        },
                        { class: 'qp-button qp-button--ghost qp-button--sm', 'data-plan-edit': plan.id }
                      )
                    : null,
                  canWrite
                    ? button(
                        plan.enabled === false ? '启用' : '停用',
                        () =>
                          ctx.run(async () => {
                            await ctx.api('plan-update', { id: plan.id, enabled: plan.enabled === false })
                            ctx.notice(plan.enabled === false ? `已启用「${plan.name}」` : `已停用「${plan.name}」，不再定时触发`)
                            await ctx.render()
                          }),
                        { class: 'qp-button qp-button--ghost qp-button--sm', 'data-plan-toggle': plan.id }
                      )
                    : null,
                  canWrite
                    ? button(
                        '删除',
                        () =>
                          ctx.run(async () => {
                            if (!window.confirm(`删除执行计划「${plan.name}」？已有的执行记录保留。`)) return
                            await ctx.api('plan-delete', { id: plan.id })
                            ctx.notice(`已删除执行计划「${plan.name}」`)
                            await ctx.render()
                          }),
                        { class: 'qp-button qp-button--ghost qp-button--sm', 'data-plan-delete': plan.id }
                      )
                    : null,
                  procedure
                    ? null
                    : button(
                        '在 Agent 会话中派发',
                        () => {
                          state.mode = 'workflow'
                          state.selected = null
                          state.draft = `派发执行计划：${plan.name || plan.id}`
                          state.pendingTask = plan.id
                          ctx.go('missions')
                        },
                        { class: 'qp-button qp-button--ghost qp-button--sm', disabled: plan.enabled === false || !canWrite }
                      )
                ),
                procedure ? note('规程回归跑这个项目已启用、关联了用例的网页规程；规程本身在「试验规程」页维护。') : null,
                plan.lastRunId && !justRun ? note(`上次派发 ${plan.lastRunId}`) : null
              )
            })
          )
        : empty(suites.length ? '这个项目还没有执行计划。新建一个，就可以立即执行或定时执行。' : '这个项目还没有执行方式和执行计划。')
    )
  )
}

/**
 * Inside a test task's 「执行与结果」: no fitting plan, make one here and
 * pick it. `onCreated(task)` selects it.
 */
export async function inlinePlanCreator(ctx, app, { onCreated, open = false }) {
  const { state } = ctx
  const [{ suites = [] }, { runners = [] }] = await Promise.all([
    ctx.api('app-suites', { app: app.slug }),
    ctx.api('runners').catch(() => ({ runners: [] }))
  ])
  const usable = suites.filter((entry) => ['cypress', 'playwright', 'playwright-electron'].includes(entry.engine) && entry.kind !== 'build')
  const details = h('details', { class: 'qp-panel rig-section', id: 'inline-plan' }, h('summary', { text: '没有合适的执行计划？在这里新建一个' }))
  details.open = open || state.planEdit?.inline === true
  if (!usable.length) {
    details.append(note('这个项目还没有 Cypress / Playwright 的执行方式。管理员在项目「设置 → 执行方式」里从模板建一个之后，这里就能新建计划。'))
    return details
  }
  if (!(state.planEdit?.inline && state.planEdit.app === app.slug))
    state.planEdit = { app: app.slug, mode: 'new', inline: true, draft: draftOf(null, usable) }
  details.ontoggle = () => {
    if (details.open && state.planEdit) state.planEdit.inline = true
  }
  details.append(
    planForm(ctx, app, {
      suites: usable,
      runners,
      editing: state.planEdit,
      onSaved: async (task) => {
        state.planEdit = null
        await onCreated?.(task)
      },
      onCancel: () => {
        details.open = false
      }
    })
  )
  return details
}

/** Scheduled orchestrations, read-only beside the plans: edited in the orchestration centre. */
export function scheduledOrchestrations(ctx) {
  const scheduled = (ctx.state.config?.orchestrations ?? []).filter((entry) => entry.schedule)
  if (!scheduled.length) return null
  return section(
    '定时编排',
    note('这些编排按 cron 自动运行，在「编排中心」里修改；这里只汇总，方便和执行计划放在一起看。'),
    h(
      'ul',
      { class: 'rig-step-results' },
      ...scheduled.map((entry) =>
        h('li', {
          'data-status': 'passed',
          text: `${entry.title ?? entry.key} · ${entry.schedule.cronExpr}（${entry.schedule.timezone ?? '服务端时区'}）${entry.nextFireAt ? ` · 下次 ${new Date(entry.nextFireAt).toLocaleString()}` : ''}`
        })
      )
    )
  )
}

