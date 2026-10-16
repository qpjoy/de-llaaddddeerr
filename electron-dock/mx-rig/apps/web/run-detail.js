// 执行详情：一次执行的全部内容，项目、计划、测试任务和总览都打开这一页
// (docs/21 M4). It replaces the old console's run page: the pipeline, the
// cases as they run, then each case's result, recording and steps — a step
// seeks the recording — with 只重跑这条, cancel, and both reports.
//
// The page polls the run's timeline as JSON every two seconds while the run is
// active, rather than holding an event stream: the desktop's requests go
// through its main process, which answers JSON. Once the run ends the page
// reads everything once more and stops.

import { h, statusTag, ago } from './views.js'
import {
  ACTIVE_RUN,
  CASE_TEXT,
  RUN_TEXT,
  STAGES,
  applyEvent,
  artifactSrc,
  brokenStage,
  clock,
  duration,
  liveModel,
  recordingFor,
  screenshotsFor
} from './run-model.js'

const POLL_MS = 2000
const note = (text) => h('p', { class: 'qp-caption qp-muted', text })
const button = (text, onclick, props = {}) =>
  h('button', { type: 'button', class: 'qp-button qp-button--outline qp-button--sm', text, onclick, ...props })

/** Show one run's detail on `view` (default: the page the reader is on). */
export function openRun(ctx, runId, view = ctx.state.view) {
  ctx.state.view = view
  ctx.state.runDetail = runId
  return ctx.render()
}

export function closeRun(ctx) {
  ctx.state.runDetail = null
  return ctx.render()
}

/** Draw the detail of `runId` into `mount`, and keep it current while the run is active. */
export async function runDetail(ctx, mount, runId) {
  const root = h('div', { class: 'rig-run', id: 'run-detail', 'data-run': runId })
  mount.append(root)
  let data = await load(ctx, runId)
  draw(ctx, root, data)
  if (!ACTIVE_RUN.includes(data.run.status)) return

  // The view is drawn into a detached fragment first and swapped in after;
  // the loop ends once the page it was drawn into has been replaced.
  let attached = false
  let waits = 0
  const tick = async () => {
    if (root.isConnected) attached = true
    else if (attached || ++waits > 30) return
    if (attached && !document.hidden) {
      try {
        const status = await readProgress(ctx, runId, data.model).catch(
          async () => (await ctx.api('run', { id: runId })).run.status
        )
        if (!ACTIVE_RUN.includes(status)) {
          data = await load(ctx, runId)
          if (root.isConnected) draw(ctx, root, data)
          return
        }
        if (status !== data.run.status) data.run = (await ctx.api('run', { id: runId })).run
        if (root.isConnected) drawLive(ctx, data)
      } catch {
        // A missed poll is retried on the next one.
      }
    }
    setTimeout(tick, POLL_MS)
  }
  setTimeout(tick, POLL_MS)
}

async function load(ctx, runId) {
  const [detail, { cases = [] }, { artifacts = [] }] = await Promise.all([
    ctx.api('run', { id: runId }),
    ctx.api('run-cases', { id: runId }),
    ctx.api('run-artifacts', { id: runId }).catch(() => ({ artifacts: [] }))
  ])
  const model = liveModel()
  // A service from before the JSON timeline still shows results, only without the pipeline.
  const timeline = await readProgress(ctx, runId, model).then(() => true, () => false)
  return { ...detail, cases, artifacts, model, timeline, slots: {} }
}

/** Read the timeline from where the model left off; answers the run's status. */
async function readProgress(ctx, runId, model) {
  let status = null
  for (let page = 0; page < 12; page += 1) {
    const answer = await ctx.api('run-progress', { id: runId, afterSeq: model.lastSeq })
    for (const event of answer.events ?? []) applyEvent(model, event)
    status = answer.status
    if (!answer.more) break
  }
  return status
}

// -- drawing -------------------------------------------------------------------

function draw(ctx, root, data) {
  const { run } = data
  const active = ACTIVE_RUN.includes(run.status)
  data.slots = {
    banner: h('div', { class: 'rig-run__banners' }),
    flow: h('div', { class: 'rig-run-flow-wrap', id: 'run-flow' }),
    tiles: h('div', { class: 'qp-metric-grid rig-run__tiles', id: 'run-tiles' }),
    live: h('div', { id: 'run-live' }),
    log: h('div', { id: 'run-log' })
  }
  root.dataset.status = run.status
  root.replaceChildren(
    head(ctx, data),
    data.slots.banner,
    data.timeline ? section('流水', data.slots.flow) : null,
    data.slots.tiles,
    active ? section('正在执行', data.slots.live) : caseSection(ctx, data),
    data.slots.log
  )
  drawLive(ctx, data)
}

/** The parts that move while the run is active. */
function drawLive(ctx, data) {
  const { run, model, slots } = data
  slots.banner.replaceChildren(...banners(data))
  slots.flow.replaceChildren(...flow(model, run).filter(Boolean))
  slots.tiles.replaceChildren(...tiles(data))
  if (ACTIVE_RUN.includes(run.status)) slots.live.replaceChildren(liveCases(model))
  slots.log.replaceChildren(
    model.logs.length
      ? h(
          'details',
          { class: 'qp-panel rig-section rig-run-log' },
          h('summary', { class: 'qp-body-2', text: `详细输出（最近 ${model.logs.length} 行）` }),
          h('pre', { class: 'qp-code-block', text: model.logs.join('\n') })
        )
      : ''
  )
}

const section = (title, ...children) =>
  h('section', { class: 'qp-panel rig-section' }, h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: title }), ...children)

function head(ctx, { run, app, suite, task }) {
  const active = ACTIVE_RUN.includes(run.status)
  const report = `/api/v1/runs/${run.id}/report`
  return h(
    'header',
    { class: 'rig-run__head' },
    h(
      'div',
      { class: 'rig-run__title' },
      button('← 返回', () => closeRun(ctx), { id: 'run-back', class: 'qp-button qp-button--ghost qp-button--sm' }),
      h('h2', { class: 'qp-heading-2', text: `${app?.displayName ?? '执行'} · 执行详情` }),
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: [
          suite?.displayName,
          `${run.profile ?? '—'} / ${run.track ?? '—'}`,
          task?.name ? `执行计划：${task.name}` : null,
          ago(run.finishedAt ?? run.queuedAt),
          run.id
        ]
          .filter(Boolean)
          .join(' · ')
      }),
      run.caseFilter
        ? h(
            'div',
            { class: 'rig-chips' },
            h('span', { class: 'rig-chip', text: `只跑了 ${run.caseFilter}` }),
            h('span', { class: 'qp-caption qp-muted', text: '覆盖率按这个范围算，不能和全量执行直接比' })
          )
        : null
    ),
    h(
      'div',
      { class: 'qp-row rig-run__actions' },
      button(ctx.state.native ? '完整报告' : '完整报告 ↗', () => ctx.openPath(report), { id: 'run-report' }),
      button(ctx.state.native ? '对外版（脱敏）' : '对外版（脱敏）↗', () => ctx.openPath(`${report}?redacted=true`), {
        id: 'run-report-redacted',
        class: 'qp-button qp-button--ghost qp-button--sm',
        title: '去掉地址、账号和内部信息，可以发给项目外的人'
      }),
      ctx.state.native && !active
        ? button(
            '保存为 PDF',
            (event) => {
              event.target.disabled = true
              ctx.run(async () => {
                try {
                  // The 对外版 is the one meant to leave the project.
                  const { saved } = await ctx.api('report-save', { path: `${report}?redacted=true` })
                  if (saved) ctx.notice('已保存对外版执行报告（PDF）')
                } finally {
                  event.target.disabled = false
                }
              })
            },
            { id: 'run-report-save', class: 'qp-button qp-button--ghost qp-button--sm', title: '把对外版报告存成 PDF，可以直接发给项目外的人' }
          )
        : null,
      !active && ctx.canRun() && ctx.analyzeRun
        ? button('让 Agent 分析这次执行', () => ctx.analyzeRun(run, { app, task }), {
            id: 'run-analyze',
            title: '带着这次执行的编号去「测试任务」，由 Agent 读结果、归类失败并给出能否上线的建议；确认后才开始'
          })
        : null,
      active && ctx.canRun()
        ? button(
            '取消执行',
            (event) => {
              if (!window.confirm('取消这次执行？已经跑完的用例结果保留。')) return
              event.target.disabled = true
              ctx.run(async () => {
                try {
                  const { note: said } = await ctx.api('run-cancel', { id: run.id })
                  ctx.notice(said ?? '已取消')
                  await ctx.render()
                } finally {
                  event.target.disabled = false
                }
              })
            },
            { id: 'run-cancel', class: 'qp-button qp-button--ghost qp-button--sm' }
          )
        : null
    )
  )
}

function banner(tone, title, ...lines) {
  return h(
    'div',
    { class: 'rig-run__banner', 'data-tone': tone },
    h('strong', { class: 'qp-body-2', text: title }),
    ...lines.filter(Boolean).map((line) => h('p', { class: 'qp-body-2', text: line }))
  )
}

function banners({ run, model, pending, cases }) {
  const out = []
  if (run.blockedReason)
    out.push(
      banner(
        'danger',
        '本次执行受阻，不算通过。',
        run.blockedReason,
        '受阻表示环境或配置的问题（目标打不开、浏览器起不来、一条用例都没跑），不是产品缺陷。'
      )
    )
  if (run.status === 'pending-runner' || (run.status === 'queued' && pending))
    out.push(
      banner(
        'warning',
        '正在等一台执行机认领。',
        '这次执行要在真实电脑上跑。到「执行机与工位」接入一台电脑，或在本机托管执行机。',
        pending?.message
      )
    )
  else if (ACTIVE_RUN.includes(run.status))
    out.push(
      banner(
        'info',
        model.runner ? `${model.runner} 已经接手。` : `${RUN_TEXT[run.status] ?? run.status}。`,
        '下面是实时进度，跑完会自动刷新，不用手动刷新页面。'
      )
    )
  if (run.status === 'cancelled' && run.cancellation?.stopState === 'requested' && !run.cancellation?.acknowledgedAt)
    out.push(banner('warning', '已请求停止。', '执行机确认之前，正在跑的进程可能还没停下。'))
  const notRun = run.catalog?.counts?.notRun ?? cases.filter((entry) => entry.status === 'notRun').length
  if (!ACTIVE_RUN.includes(run.status) && notRun > 0)
    out.push(
      banner(
        'info',
        `有 ${notRun} 条用例登记了但没有跑到。`,
        '可能还没写实现代码，也可能被误删或跳过。下面状态为「未执行」的就是。'
      )
    )
  return out
}

function flow(model, run) {
  const waiting = model.stages.size === 0
  const broke = brokenStage(model)
  return [
    h(
      'ol',
      { class: 'rig-run-flow' },
      ...STAGES.map(([key, label], index) => {
        const entry = model.stages.get(key) ?? { status: 'pending', detail: '' }
        return h(
          'li',
          { class: 'rig-run-flow__node', 'data-state': entry.status, title: entry.detail || label },
          h('span', { class: 'rig-run-flow__dot', text: String(index + 1) }),
          h('span', { class: 'rig-run-flow__label', text: label }),
          h('span', { class: 'qp-caption qp-muted rig-run-flow__detail', text: entry.detail || '' })
        )
      })
    ),
    broke
      ? banner('danger', `卡在「${broke[0]}」`, broke[1] || '没有更多信息，展开下面的「详细输出」看日志。')
      : null,
    note(
      waiting
        ? run.status === 'pending-runner'
          ? '还没有执行机接手。接一台电脑进来，这条流水就会开始走。'
          : ACTIVE_RUN.includes(run.status)
            ? '等待第一条进度……'
            : '这次执行没有上报流水。'
        : model.runner
          ? `执行机：${model.runner}`
          : '服务端执行'
    )
  ]
}

const tile = (label, value, tone) =>
  h(
    'article',
    { class: 'qp-metric', 'data-tone': tone },
    h('span', { class: 'qp-metric__label', text: label }),
    h('strong', { class: 'qp-metric__value', text: String(value) })
  )

function tiles({ run, model }) {
  const active = ACTIVE_RUN.includes(run.status)
  const counts = run.catalog?.counts ?? {}
  const passed = active ? model.counts.passed : (counts.passed ?? run.totals?.passed ?? 0)
  const failed = active ? model.counts.failed : (counts.failed ?? run.totals?.failed ?? 0)
  return [
    tile('结果', RUN_TEXT[run.status] ?? run.status),
    tile('通过', passed, 'success'),
    tile('失败', failed, 'danger'),
    tile('未执行', active ? '—' : (counts.notRun ?? 0), 'warning'),
    tile('耗时', active ? '进行中' : duration(run.durationMs))
  ]
}

function steps(list, video) {
  if (!list?.length)
    return h(
      'p',
      { class: 'qp-caption qp-muted' },
      '没有上报步骤。在用例代码里用 step() 包住每个用户可见的动作，这里就有可点击的时间轴。'
    )
  return h(
    'ol',
    { class: 'rig-run-steps' },
    ...list.map((step) =>
      h(
        'li',
        { 'data-status': step.status ?? 'passed' },
        h('span', { class: 'rig-run-steps__seq', text: String(step.seq ?? '') }),
        h('span', { class: 'rig-run-steps__label', text: step.label ?? '', title: step.label ?? '' }),
        step.offsetMs != null && video
          ? h('button', {
              type: 'button',
              class: 'rig-run-steps__time',
              text: clock(step.offsetMs),
              title: '跳到录像的这一刻',
              'data-seek': (step.offsetMs / 1000).toFixed(2),
              onclick: () => {
                video.currentTime = step.offsetMs / 1000
                video.play().catch(() => {})
              }
            })
          : h('span', { class: 'rig-run-steps__time is-plain', text: step.offsetMs != null ? clock(step.offsetMs) : '—' })
      )
    )
  )
}

function liveCases(model) {
  if (model.order.length === 0)
    return h(
      'div',
      { class: 'rig-empty qp-body-2' },
      '还没有用例开始。看不到用例级进度，通常是这个执行方式还没接进度上报——流水仍然会走完。'
    )
  return h(
    'div',
    { class: 'rig-run-cases' },
    note(`已跑 ${model.order.length} 条 · 通过 ${model.counts.passed} · 失败 ${model.counts.failed}`),
    ...model.order.map((caseId) => {
      const entry = model.cases.get(caseId)
      return h(
        'article',
        { class: 'rig-run-case', 'data-status': entry.status, 'data-case': entry.caseId },
        h(
          'div',
          { class: 'rig-run-case__summary' },
          statusTag(entry.status, undefined, CASE_TEXT[entry.status] ?? entry.status),
          h('code', { text: entry.caseId }),
          h('span', { class: 'rig-run-case__title', text: entry.title ?? '' }),
          h('span', { class: 'qp-caption qp-muted', text: entry.durationMs != null ? duration(entry.durationMs) : '' })
        ),
        entry.steps.length ? steps(entry.steps.slice(-6), null) : null
      )
    })
  )
}

const FILTERS = [
  ['all', '全部', () => true],
  ['failed', '失败', (entry) => entry.status === 'failed' || entry.status === 'flaky'],
  ['passed', '通过', (entry) => entry.status === 'passed'],
  ['notRun', '未执行', (entry) => entry.status === 'notRun' || entry.status === 'skipped']
]

function caseSection(ctx, data) {
  const { run, cases } = data
  const coverage = run.catalog?.coverage
  const list = h('div', { class: 'rig-run-cases', id: 'run-cases' })
  const show = (key) => {
    const [, , keep] = FILTERS.find(([name]) => name === key)
    const chosen = cases.filter(keep)
    list.replaceChildren(
      ...(chosen.length ? chosen.map((entry) => caseRow(ctx, data, entry)) : [h('div', { class: 'rig-empty qp-body-2', text: '没有这类用例。' })])
    )
    for (const tab of filters.children) tab.setAttribute('aria-selected', tab.dataset.filter === key ? 'true' : 'false')
  }
  const filters = h(
    'div',
    { class: 'qp-row rig-run__filters', role: 'tablist', 'aria-label': '按结果筛选' },
    ...FILTERS.map(([key, label, keep]) =>
      h('button', {
        type: 'button',
        role: 'tab',
        class: 'qp-button qp-button--ghost qp-button--sm',
        'data-filter': key,
        text: `${label} ${cases.filter(keep).length}`,
        onclick: () => show(key)
      })
    )
  )
  show('all')
  const box = section(
    '用例明细',
    coverage
      ? note(`目录执行率 ${coverage.catalogCompletionPercent ?? 0}% · 执行通过率 ${coverage.executedPassPercent ?? 0}%`)
      : null,
    cases.length ? filters : null,
    cases.length ? list : h('div', { class: 'rig-empty qp-body-2', text: '这次执行没有用例结果。' })
  )
  box.id = 'run-case-section'
  return box
}

function caseRow(ctx, { run, artifacts }, entry) {
  const recording = recordingFor(entry, artifacts)
  const native = Boolean(ctx.state.native)
  const video = recording
    ? h('video', {
        class: 'rig-run-video',
        controls: true,
        preload: 'metadata',
        src: artifactSrc(run.id, recording.path, native)
      })
    : null
  const shots = screenshotsFor(entry, artifacts)
  const row = h(
    'details',
    { class: 'rig-run-case', 'data-status': entry.status, 'data-case': entry.caseId },
    h(
      'summary',
      { class: 'rig-run-case__summary' },
      statusTag(entry.status, undefined, CASE_TEXT[entry.status] ?? entry.status),
      h('code', { text: entry.caseId }),
      h('span', { class: 'rig-run-case__title', text: entry.title ?? '' }),
      recording ? h('span', { class: 'rig-chip', text: '有录像' }) : null,
      h('span', { class: 'qp-caption qp-muted', text: duration(entry.durationMs) })
    ),
    h(
      'div',
      { class: 'rig-run-case__body' },
      run.taskId && entry.status !== 'notRun' && ctx.canRun()
        ? h(
            'div',
            { class: 'qp-row' },
            button(
              '只重跑这条',
              (event) => {
                event.target.disabled = true
                ctx.run(async () => {
                  try {
                    const result = await ctx.api('plan-run', { id: run.taskId, caseFilter: entry.caseId })
                    ctx.notice(result.note ?? '已排队，正在打开新的执行')
                    await openRun(ctx, result.run.id)
                  } finally {
                    event.target.disabled = false
                  }
                })
              },
              { 'data-rerun': entry.caseId }
            ),
            note('按同一个执行计划，只跑这一条用例')
          )
        : null,
      entry.errorText ? h('pre', { class: 'qp-code-block rig-run-case__error', text: entry.errorText }) : null,
      entry.status === 'notRun' ? note('这条用例登记在用例库里，但还没有实现代码，所以本次没有执行。') : null,
      h(
        'div',
        { class: 'rig-run-playback', 'data-video': recording ? 'true' : 'false' },
        video ?? note('这条用例没有录像。'),
        steps(entry.steps, video)
      ),
      shots.length
        ? h(
            'div',
            { class: 'rig-run-shots' },
            ...shots.map((shot) =>
              h('img', { src: artifactSrc(run.id, shot.path, native), alt: `${entry.caseId} 截图`, loading: 'lazy' })
            )
          )
        : null
    )
  )
  row.open = entry.status === 'failed'
  return row
}
