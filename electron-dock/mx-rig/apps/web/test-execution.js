import { h } from './views.js'
import { inlinePlanCreator } from './plans.js'
import { openRun } from './run-detail.js'
import { taskRepositoryPanel } from './repository.js'

const note = (text) => h('p', { class: 'qp-caption qp-muted', text })
const button = (text, onclick, props = {}) =>
  h('button', { type: 'button', class: 'qp-button qp-button--outline', text, onclick, ...props })
const section = (title, ...children) =>
  h(
    'section',
    { class: 'qp-panel rig-section' },
    h('h2', { class: 'qp-heading-2', text: title }),
    ...children
  )
const platformName = (value) => (value === 'electron' ? '桌面端' : 'Web')
// getRandomValues also works on explicitly enabled private-HTTP deployments.
const requestId = () => {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64
  bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map((value) => value.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
const statusName = (value) =>
  ({
    passed: '通过',
    failed: '失败',
    flaky: '不稳定',
    blocked: '阻塞',
    skipped: '跳过',
    notRun: '未覆盖',
    queued: '排队中',
    'pending-runner': '等待执行机',
    running: '执行中',
    cancelled: '已取消',
    expired: '等待超时',
    timeout: '执行超时'
  })[value] ?? value

export async function testExecution(ctx, mount, mission, book) {
  const data = await ctx.api('task-executions', { id: mission.id })
  const key = `${mission.id}:${book.revision}`
  if (ctx.state.testExecution?.key !== key) ctx.state.testExecution = { key, bindings: {} }
  const session = ctx.state.testExecution
  const tasks = data.tasks.filter(
    (task) =>
      task.suite &&
      ['cypress', 'playwright', 'playwright-electron'].includes(task.suite.engine) &&
      task.suite.kind !== 'build'
  )
  const task = tasks.find((entry) => entry.id === session.taskId) ?? tasks[0]
  session.taskId = task?.id
  const picker = h(
    'select',
    { class: 'qp-select', id: 'execution-task', 'aria-label': '执行计划' },
    ...tasks.map((entry) =>
      h('option', {
        value: entry.id,
        text: `${entry.name} · ${platformName(entry.suite.surface)} · ${entry.profile} · ${entry.suite.engine}`
      })
    )
  )
  if (task) picker.value = task.id
  picker.onchange = () => {
    session.taskId = picker.value
    invalidate()
    for (const control of form.querySelectorAll('input, button, select')) control.disabled = true
    ctx.render()
  }
  const planMount = h('div', { id: 'execution-preview' })
  const invalidate = () => {
    session.plan = null
    planMount.replaceChildren()
  }
  // The project's own test repository (docs/23): write the approved
  // implementation, then run exactly that commit on this computer.
  const repository = await taskRepositoryPanel(ctx, mission, {
    tasks: data.tasks,
    runs: data.runs,
    onRun: ({ plan, qaRef, bindings }) =>
      ctx.run(async () => {
        session.taskId = plan.id
        session.bindings[plan.id] = { ...bindings }
        session.qaRef = { ...qaRef, planId: plan.id }
        const input = {
          expectedRevision: book.revision,
          taskId: plan.id,
          bindings: Object.entries(bindings).map(([caseId, specPath]) => ({ caseId, specPath })),
          qaRef
        }
        const preview = await ctx.api('task-execution-plan', { id: mission.id, ...input })
        session.plan = { ...preview, selection: input, requestId: requestId() }
        await ctx.render()
      })
  })
  if (repository) mount.append(repository)
  const cases = book.cases.filter((entry) => entry.platforms.includes(task?.suite.surface))
  const bindings = task ? (session.bindings[task.id] ??= {}) : {}
  const form = section(
    '选择执行计划',
    note(book.confirmed ? `将使用已确认用例 v${book.revision}。` : '请先回到“用例”确认本次版本。'),
    note('每次执行一个平台的整套 Suite；逐条核对该平台的全部已确认用例。其他平台仍需分别执行。'),
    tasks.length ? picker : note('本项目还没有可用的 Cypress / Playwright 执行计划。在下面新建一个。')
  )
  // No fitting plan: make one here, and it is the one picked (docs/21 M3).
  const app = { slug: mission.workbench?.appSlug }
  if (app.slug && ['operator', 'admin'].includes(ctx.state.principal?.role))
    form.append(
      await inlinePlanCreator(ctx, app, {
        open: !tasks.length,
        onCreated: async (created) => {
          session.taskId = created?.id
          invalidate()
          await ctx.render()
        }
      })
    )
  if (task) {
    form.append(
      note(
        '下列路径用于核对报告，必须相对 Suite 工作目录。留空时使用项目用例库的关联；不会据此生成或修改脚本。'
      )
    )
    for (const entry of cases) {
      const input = h('input', {
        class: 'qp-input',
        'aria-label': `${entry.caseId} 脚本路径`,
        placeholder: '例如 tests/login.spec.ts',
        maxlength: 240
      })
      input.value =
        bindings[entry.caseId] ??
        (!entry.suiteSlug || entry.suiteSlug === task.suite.slug ? entry.specPath : '')
      input.oninput = () => {
        bindings[entry.caseId] = input.value
        invalidate()
      }
      form.append(
        h(
          'label',
          { class: 'rig-case-field' },
          h('span', { text: `${entry.caseId} · ${entry.title}` }),
          input
        )
      )
    }
    const selection = () => ({
      expectedRevision: book.revision,
      taskId: task.id,
      bindings: cases
        .map((entry) => ({
          caseId: entry.caseId,
          specPath: (
            bindings[entry.caseId] ??
            (!entry.suiteSlug || entry.suiteSlug === task.suite.slug ? entry.specPath : '')
          ).trim()
        }))
        .filter((entry) => entry.specPath),
      ...(session.qaRef?.planId === task.id ? { qaRef: { branch: session.qaRef.branch, commit: session.qaRef.commit } } : {})
    })
    form.append(
      button(
        '预览本次执行',
        (event) =>
          ctx.run(async () => {
            const control = event.currentTarget
            control.disabled = true
            const input = selection()
            try {
              const plan = await ctx.api('task-execution-plan', { id: mission.id, ...input })
              if (
                session.taskId !== task.id ||
                JSON.stringify(selection()) !== JSON.stringify(input)
              )
                return
              session.plan = { ...plan, selection: input, requestId: requestId() }
              await ctx.render()
            } finally {
              control.disabled = false
            }
          }),
        { disabled: !ctx.canRun() || !book.confirmed || !cases.length }
      )
    )
  }
  mount.append(form, planMount)
  if (session.plan) {
    const plan = session.plan
    const m = plan.manifest
    const preview = section(
      '确认执行范围',
      note(`v${m.revision} · ${platformName(m.platform)} · ${m.cases.length} 条 · ${m.suite.slug}`),
      note(
        `环境：${m.task.profile === 'mock' ? 'mock（模拟环境，不能作为真实环境验收）' : 'real'} · 轨道：${m.task.track} · 目标：${m.task.targetUrl || '由套件自行启动'} · 执行位置：${m.task.runsOn || m.suite.runnerKind}`
      ),
      note(
        `仓库：${m.suite.repoUrl || m.app.repoUrl || '执行机工作目录'} · 引用：${m.suite.defaultBranch || m.app.defaultBranch || '执行机当前源码'} · 工作目录：${m.suite.workingDir || '.'}`
      ),
      m.qaRef ? note(`测试仓库：${m.qaRef.branch} @ ${m.qaRef.commit.slice(0, 7)}（执行机检出这个提交）`) : null,
      note(
        m.appPackage
          ? `桌面包：${m.appPackage.version || m.appPackage.filename || '已绑定发行物'}`
          : '尚未固定发行物；分支可能继续变化，实际提交由 Runner 回报。'
      ),
      h('pre', { class: 'qp-code-block', text: JSON.stringify(m.suite.command) }),
      note(
        '执行以上整套命令；同套件的其他测试也可能运行。范围外结果单独记录，不代替本任务用例。' +
          (m.suite.writesData ? '该套件声明会写入测试数据，请核对目标环境。' : '')
      ),
      ...m.bindings.map((entry) => note(`${entry.caseId} → ${entry.specPath}`)),
      button(
        '按此范围开始执行',
        (event) =>
          ctx.run(async () => {
            const control = event.currentTarget
            control.disabled = true
            try {
              await ctx.api('task-execution-dispatch', {
                id: mission.id,
                ...plan.selection,
                planHash: plan.planHash,
                requestId: plan.requestId
              })
              session.plan = null
              await ctx.render()
            } finally {
              control.disabled = false
            }
          }),
        {
          id: 'dispatch-reviewed-cases',
          class: 'qp-button qp-button--primary',
          disabled: !ctx.canRun()
        }
      )
    )
    planMount.append(preview)
  }
  const results = section(
    '本任务执行与证据',
    button('刷新执行结果', () => ctx.render())
  )
  if (!data.runs.length) results.append(note('尚未发起执行。用例确认不会自动产生通过结果。'))
  if (data.hasMore) results.append(note('这里显示最近 50 次；项目的全部执行在项目的「执行记录」里。'))
  for (const run of data.runs) {
    const coverage = h('div')
    const showCoverage = (detail) => {
      const active = ['queued', 'pending-runner', 'running'].includes(detail.status)
      coverage.replaceChildren(
        ...detail.coverage.map((entry) =>
          h('p', {
            class: 'rig-case-text',
            text: `${entry.caseId} · ${entry.title}：${entry.result ? statusName(entry.result.status) : active ? '等待结果' : '未覆盖'}\n${entry.expectedSpec}${entry.result?.errorText ? '\n' + entry.result.errorText : ''}`
          })
        ),
        note(`另有 ${detail.extraCases} 条范围外结果。`)
      )
    }
    if (run.coverage) showCoverage(run)
    else
      coverage.append(
        button(`查看 ${run.caseCount} 条用例结果`, () =>
          ctx.run(async () => {
            const detail = await ctx.api('task-executions', { id: mission.id, runId: run.id })
            showCoverage(detail.runs[0])
          })
        )
      )
    results.append(
      h(
        'article',
        { class: 'rig-test-case', 'data-execution-id': run.id },
        h('strong', {
          text: `v${run.revision} · ${platformName(run.platform)} · ${run.profile} · ${statusName(run.status)}`
        }),
        note(
          `${run.suiteName} · ${new Date(run.queuedAt).toLocaleString()}${run.revision !== book.revision ? ' · 历史版本，不能证明当前版本通过' : ''}`
        ),
        run.blockedReason && note(run.blockedReason),
        coverage,
        note(
          `${run.profile === 'mock' ? '本次仅验证模拟环境。' : ''}${run.sourceRef?.gitSha ? ` 实际提交：${run.sourceRef.gitSha}` : ''}`
        ),
        button('执行详情：步骤、录像与报告', () => openRun(ctx, run.id), { 'data-run-open': run.id })
      )
    )
  }
  mount.append(results)
}
