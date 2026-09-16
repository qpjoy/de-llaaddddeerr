import { renderGraph } from './graph-view.js'

// -- dom helpers --------------------------------------------------------------
// Everything is built as nodes with textContent. There is no HTML string
// interpolation anywhere in the workbench, so test output, page text and model
// replies cannot become markup.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue
    if (key === 'class') node.className = value
    else if (key === 'text') node.textContent = value
    else if (key === 'dataset') Object.assign(node.dataset, value)
    else if (key.startsWith('on') && typeof value === 'function') node[key.toLowerCase()] = value
    else node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue
    node.append(child.nodeType ? child : document.createTextNode(String(child)))
  }
  return node
}

const panel = (title, ...body) =>
  h(
    'section',
    { class: 'qp-panel rig-section' },
    title && h('h2', { class: 'qp-heading-2', text: title }),
    ...body
  )

const metric = (label, value, hint) =>
  h(
    'article',
    { class: 'qp-metric' },
    h('span', { class: 'qp-metric__label', text: label }),
    h('strong', { class: 'qp-metric__value', text: String(value) }),
    hint && h('small', { class: 'qp-metric__hint', text: hint })
  )

const empty = (text) => h('div', { class: 'rig-empty qp-body-2', text })

const STATUS_TONE = {
  passed: 'success',
  completed: 'success',
  running: 'info',
  queued: 'info',
  'pending-runner': 'warning',
  awaiting_approval: 'warning',
  flaky: 'warning',
  blocked: 'warning',
  failed: 'danger',
  expired: 'danger',
  cancelled: 'default'
}
const STATUS_TEXT = {
  queued: '排队',
  running: '执行中',
  awaiting_approval: '等待确认',
  completed: '任务完成',
  failed: '失败',
  blocked: '受阻',
  cancelled: '已取消',
  passed: '通过',
  flaky: '不稳定',
  expired: '已过期',
  'pending-runner': '等待执行机'
}
export const statusTag = (status, id) =>
  h('span', {
    class: 'qp-status',
    id,
    'data-status': STATUS_TONE[status] ?? 'default',
    text: STATUS_TEXT[status] ?? status
  })

// Column widths live in style.css keyed by `data-layout`. The page is served
// under `style-src 'self'`, which blocks inline style attributes outright —
// including the ones the CSSOM would write — so layout has to be a class or an
// attribute the stylesheet can respond to, never a string of CSS.
const table = (columns, rows, { layout = 'default' } = {}) => {
  const wrap = h('div', { class: 'qp-data-table rig-table', 'data-layout': layout })
  wrap.append(
    h(
      'div',
      { class: 'qp-data-row qp-data-row--header' },
      ...columns.map((column) => h('span', { text: column.title }))
    )
  )
  for (const row of rows)
    wrap.append(
      h('article', { class: 'qp-data-row' }, ...columns.map((column) => column.cell(row)))
    )
  return wrap
}

const ago = (iso) => {
  if (!iso) return '—'
  const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000)
  if (!Number.isFinite(seconds)) return '—'
  if (seconds < 60) return `${Math.max(seconds, 0)} 秒前`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} 小时前`
  return new Date(iso).toLocaleString()
}

const AGENT_GLYPH = {
  orchestration: '◈',
  triage: '⌕',
  coverage: '▤',
  operations: '⚙',
  inspection: '◉'
}

// -- overview -----------------------------------------------------------------

export async function overview(ctx, mount) {
  const [{ tasks = [] }, { runs = [] }, { apps = [] }, { insights }] = await Promise.all([
    ctx.api('tasks'),
    ctx.api('runs'),
    ctx.api('apps').catch(() => ({ apps: [] })),
    ctx.api('insights', { window: ctx.state.window }).catch(() => ({ insights: null }))
  ])
  ctx.state.tasks = tasks
  ctx.state.insights = insights
  const decided = runs.filter((run) =>
    ['passed', 'failed', 'flaky', 'blocked'].includes(run.status)
  )
  const online = insights?.fleet.online ?? 0
  const agents = ctx.state.config?.agents ?? []
  const ready = agents.filter((agent) => agent.effectiveTools.length > 0)
  const waiting = ctx.state.missions.filter((row) => row.status === 'awaiting_approval')

  const steps = [
    { done: apps.length > 0, title: '接入应用', text: '登记要测的 Compass Web / Electron' },
    { done: tasks.length > 0, title: '建测试计划', text: '选套件与轨道，手动或定时执行' },
    { done: online > 0, title: '连接执行机', text: '没有执行机时测试只会排队' },
    { done: decided.length > 0, title: '看报告与录像', text: '从失败步骤跳到录像那一刻' },
    {
      done: ctx.state.config?.model.configured === true,
      title: '接上模型（可选）',
      text: 'Agent 才能帮你读证据'
    }
  ]
  const next = steps.findIndex((step) => !step.done)
  const onboarding = panel(
    '从这里开始',
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '每一步都读的是平台真实状态；高亮的那一步就是现在该做的事。'
    }),
    // The banner is the five-step summary; the system layer is the same path
    // with the actual click-by-click steps, version by version.
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '按系统任务一步步做 ⬢',
        onclick: () => ctx.go('system')
      }),
      ctx.state.system?.claimable.length
        ? h('span', {
            class: 'qp-tag qp-tag--danger',
            text: `${ctx.state.system.claimable.length} 项可领取`
          })
        : null
    ),
    h(
      'div',
      { class: 'rig-steps' },
      ...steps.map((step, index) =>
        h(
          'article',
          { class: `rig-step ${step.done ? 'is-done' : index === next ? 'is-next' : ''}` },
          h('span', { class: 'rig-step__num', text: step.done ? '✓' : String(index + 1) }),
          h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: step.title }),
          h('span', { class: 'qp-body-2 qp-muted', text: step.text })
        )
      )
    )
  )

  const inbox = panel(
    waiting.length ? `等你确认（${waiting.length}）` : '没有等你确认的动作',
    waiting.length
      ? h(
          'div',
          { class: 'rig-section' },
          ...waiting.map((row) =>
            h(
              'article',
              { class: 'rig-approval' },
              h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: row.goal }),
              h('p', {
                class: 'qp-body-2 qp-soft',
                text: `${ctx.toolTitle(row.pending?.name ?? '')} · ${JSON.stringify(row.pending?.args ?? {})}`
              }),
              h('button', {
                class: 'qp-button qp-button--primary qp-button--sm',
                text: '去核对',
                onclick: () => {
                  ctx.state.selected = row.id
                  ctx.go('missions')
                }
              })
            )
          )
        )
      : h('div', {
          class: 'rig-empty qp-body-2',
          text: '写动作和检查点会出现在这里，等你逐条核对。'
        })
  )

  const recent = panel(
    '最近执行',
    runs.length
      ? table(
          [
            { title: '状态', cell: (run) => statusTag(run.status) },
            {
              title: '结果',
              cell: (run) =>
                h('span', {
                  class: 'qp-body-2',
                  text: run.totals?.tests
                    ? `通过 ${run.totals.passed ?? 0} / ${run.totals.tests}`
                    : '—'
                })
            },
            {
              title: '轨道',
              cell: (run) =>
                h('span', {
                  class: 'qp-body-2 qp-muted',
                  text: `${run.profile ?? '—'} / ${run.track ?? '—'}`
                })
            },
            {
              title: '时间',
              cell: (run) =>
                h('span', {
                  class: 'qp-body-2 qp-muted',
                  text: ago(run.finishedAt ?? run.queuedAt)
                })
            },
            {
              title: '',
              cell: (run) =>
                h('button', {
                  class: 'qp-button qp-button--ghost qp-button--sm',
                  text: '看报告 ↗',
                  onclick: () => ctx.openPath(`/api/v1/runs/${run.id}/report`)
                })
            }
          ],
          runs.slice(0, 8),
          { layout: 'runs' }
        )
      : empty('还没有执行记录。先在「测试中心」选一个计划跑一次。')
  )

  const health = insights
    ? panel(
        `最近 ${insights.window.days} 天`,
        h(
          'div',
          { class: 'rig-grid-2' },
          trendChart(insights.trend),
          riskList(insights.risks.slice(0, 4), { empty: '没有需要先处理的风险。' })
        ),
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm rig-inline-action',
          text: '打开完整质量报告 →',
          onclick: () => ctx.go('report')
        })
      )
    : null

  mount.append(
    h(
      'div',
      { class: 'qp-metric-grid' },
      metric(
        '通过率',
        asPercent(insights?.verdicts.passRate),
        insights?.verdicts.judged
          ? `${insights.verdicts.passed} / ${insights.verdicts.judged} 次有结论`
          : '窗口内没有可判定的执行'
      ),
      metric('受阻', String(insights?.verdicts.blocked ?? 0), '环境没跑起来，不算失败'),
      metric('在线执行机', String(online), online ? '可以派发' : '派发后会等待执行机'),
      metric(
        '可用 Agent',
        `${ready.length}/${agents.length}`,
        ctx.state.config?.model.configured ? `模型 ${ctx.state.config.model.name}` : '尚未配置模型'
      )
    )
  )

  // Same data, ordered for whoever is looking.
  const sections = {
    tester: [inbox, onboarding, recent, health],
    developer: [recent, health, inbox, onboarding],
    lead: [health, onboarding, recent, inbox]
  }[ctx.state.lens]
  for (const section of sections) if (section) mount.append(section)
}

// -- shared metric presentation -------------------------------------------------

/** A rate with no samples reads "—", never 0% and never 100%. */
export const asPercent = (value) =>
  value === null || value === undefined ? '—' : `${Math.round(value * 100)}%`

const asDuration = (ms) => {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`
  const minutes = Math.floor(ms / 60_000)
  return minutes < 60
    ? `${minutes} 分 ${Math.round((ms % 60_000) / 1000)} 秒`
    : `${(minutes / 60).toFixed(1)} 小时`
}

const RISK_TONE = { high: 'danger', medium: 'warning', low: 'info' }

function riskList(list, { empty = '当前没有需要处理的风险。' } = {}) {
  if (!list.length) return h('div', { class: 'rig-empty qp-body-2', text: empty })
  return h(
    'div',
    { class: 'rig-risks' },
    ...list.map((risk) =>
      h(
        'article',
        { class: 'rig-risk', 'data-level': risk.level },
        h(
          'div',
          { class: 'qp-row qp-row--between' },
          h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: risk.title }),
          h('span', {
            class: 'qp-status',
            'data-status': RISK_TONE[risk.level] ?? 'info',
            text: { high: '要先处理', medium: '需要关注', low: '留意' }[risk.level] ?? risk.level
          })
        ),
        h('p', { class: 'qp-body-2 qp-soft', text: risk.detail })
      )
    )
  )
}

/**
 * The pass-rate trend, drawn as bars rather than a line.
 *
 * A day with no runs is a gap, not a zero: a line chart would slope down
 * through it and invent a decline that never happened.
 *
 * It is an SVG because the page runs under `style-src 'self'` — a bar whose
 * height is an inline style would simply not render. SVG geometry lives in
 * attributes, which the CSP has no opinion about.
 */
const SVG_NS = 'http://www.w3.org/2000/svg'
const svgEl = (tag, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs))
    if (value != null) node.setAttribute(key, String(value))
  return node
}

function trendChart(buckets) {
  if (!buckets.some((bucket) => bucket.judged > 0))
    return h('div', { class: 'rig-empty qp-body-2', text: '这个窗口内还没有可以判定的执行。' })
  const width = Math.max(buckets.length * 34, 120)
  const plot = 96
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} ${plot + 26}`,
    width,
    height: plot + 26,
    class: 'rig-trend',
    role: 'img',
    'aria-label': '每日通过率趋势'
  })
  buckets.forEach((bucket, index) => {
    const x = index * 34 + 6
    const group = svgEl('g', {
      class: 'rig-trend__day',
      'data-empty': bucket.judged === 0 ? 'true' : null,
      'data-tone':
        bucket.judged === 0
          ? null
          : (bucket.passRate ?? 0) >= 0.9
            ? 'good'
            : (bucket.passRate ?? 0) >= 0.6
              ? 'fair'
              : 'poor'
    })
    const title = svgEl('title')
    title.textContent =
      bucket.judged === 0
        ? `${bucket.date}：没有执行`
        : `${bucket.date}：通过 ${bucket.passed} / 判定 ${bucket.judged}${bucket.blocked ? `，受阻 ${bucket.blocked}` : ''}`
    group.append(
      title,
      svgEl('rect', { class: 'rig-trend__track', x, y: 0, width: 22, height: plot, rx: 3 })
    )
    if (bucket.judged > 0) {
      const tall = Math.max(3, Math.round((bucket.passRate ?? 0) * plot))
      group.append(
        svgEl('rect', {
          class: 'rig-trend__fill',
          x,
          y: plot - tall,
          width: 22,
          height: tall,
          rx: 3
        })
      )
    }
    if (bucket.blocked > 0)
      group.append(
        svgEl('rect', {
          class: 'rig-trend__blocked',
          x,
          y: plot + 2,
          width: 22,
          height: 3,
          rx: 1.5
        })
      )
    const label = svgEl('text', {
      class: 'rig-trend__label',
      x: x + 11,
      y: plot + 20,
      'text-anchor': 'middle'
    })
    label.textContent = bucket.date.slice(5)
    group.append(label)
    svg.append(group)
  })
  return h('div', { class: 'rig-trend-wrap' }, svg)
}

// -- mission workspace ---------------------------------------------------------

export async function missions(ctx, mount) {
  const selected = ctx.state.missions.find((row) => row.id === ctx.state.selected) ?? null
  const left = h('div', { class: 'rig-section' })
  const right = h('div', { class: 'rig-section' })
  mount.append(h('div', { class: 'rig-workspace' }, left, right))

  if (!selected) {
    const agents = (ctx.state.config?.agents ?? []).filter(
      (agent) => agent.surface !== 'desktop' || ctx.state.native
    )
    left.append(
      panel(
        '选一个 Agent，或直接描述目标',
        h('p', {
          class: 'qp-body-2 qp-muted',
          text: 'Agent 决定角色和可用工具；工具集仍受 Internal 允许列表约束。选「不指定」则使用全部被允许的工具。'
        }),
        h(
          'div',
          { class: 'rig-cards' },
          ...agents.map((agent) =>
            h(
              'article',
              {
                class: `rig-agent ${ctx.state.agentKey === agent.key ? 'is-selected' : ''}`,
                onclick: () => {
                  ctx.state.agentKey = ctx.state.agentKey === agent.key ? null : agent.key
                  if (ctx.state.agentKey && agent.starter) ctx.state.draft = agent.starter
                  ctx.render()
                }
              },
              h(
                'div',
                { class: 'rig-agent__head' },
                h('span', { class: 'rig-agent__mark', text: AGENT_GLYPH[agent.category] ?? '◈' }),
                h(
                  'div',
                  {},
                  h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: agent.displayName }),
                  h('div', {
                    class: 'qp-caption qp-muted',
                    text: ctx.state.categories[agent.category] ?? agent.category
                  })
                )
              ),
              h('p', { class: 'qp-body-2 qp-soft', text: agent.summary }),
              h(
                'div',
                { class: 'rig-chips' },
                ...agent.tools.map((name) =>
                  h('span', {
                    class: 'rig-chip',
                    'data-off': agent.effectiveTools.includes(name) ? null : 'true',
                    text: name
                  })
                )
              ),
              agent.effectiveTools.length === 0 &&
                h('span', {
                  class: 'qp-status',
                  'data-status': 'warning',
                  text: '所需工具未被 Internal 允许'
                })
            )
          )
        )
      )
    )
  } else {
    left.append(missionDetail(ctx, selected))
  }
  left.append(composer(ctx, selected))

  // An orchestration mission runs its own compiled graph; drawing the generic
  // mission loop next to it would highlight nodes that never ran.
  const orchestrated = selected?.mode === 'orchestration'
  const railGraph = orchestrated
    ? ctx.state.orchestration.selected === selected.orchestrationKey
      ? ctx.state.orchestration.graph
      : null
    : ctx.state.graph
  const railBody = railGraph
    ? h(
        'div',
        { class: 'rig-graph rig-graph--compact' },
        renderGraph(railGraph, {
          trace: (selected?.trace ?? []).map((entry) => entry.node),
          current:
            selected?.status === 'awaiting_approval'
              ? 'approve'
              : ((selected?.trace ?? []).at(-1)?.node ?? null)
        })
      )
    : orchestrated
      ? h(
          'button',
          {
            class: 'qp-button qp-button--outline qp-button--sm',
            onclick: () => {
              ctx.selectOrchestration(selected.orchestrationKey)
              ctx.go('orchestration')
            }
          },
          `在编排中心查看「${selected.orchestrationKey}」`
        )
      : empty('编排图尚未加载')

  right.append(
    panel(
      '编排位置',
      railBody,
      h('p', {
        class: 'qp-caption qp-muted',
        text: '高亮的是这项任务真实走过的节点。虚线是条件分支，带「暂停点」的节点必须由人确认。'
      })
    ),
    panel(
      '本次执行边界',
      h(
        'dl',
        { class: 'rig-kv' },
        h('dt', { text: '模型' }),
        h('dd', {
          text: ctx.state.config?.model.configured ? ctx.state.config.model.name : '未配置'
        }),
        h('dt', { text: '步数上限' }),
        h('dd', { text: String(ctx.state.config?.policy.maxTurns ?? '—') }),
        h('dt', { text: '允许工具' }),
        h('dd', { text: String(ctx.state.config?.policy.allowedTools.length ?? 0) }),
        h('dt', { text: '浏览器 origin' }),
        h('dd', { text: String(ctx.state.config?.policy.browserOrigins.length ?? 0) })
      )
    )
  )
}

// Labels for the structured conclusion. Mirrored from
// `packages/runtime/finding.mjs` the same way status words are: the workbench
// is served as plain files from apps/web and cannot import from packages/.
const VERDICT_TEXT = {
  'product-defect': { label: '产品缺陷', tone: 'danger' },
  'environment-blocked': { label: '环境受阻', tone: 'warning' },
  'case-issue': { label: '用例问题', tone: 'warning' },
  flaky: { label: '不稳定（flaky）', tone: 'warning' },
  inconclusive: { label: '证据不足', tone: 'default' }
}
const FINDING_CONFIDENCE = { high: '高', medium: '中', low: '低' }

/**
 * The Agent's own judgement, with its citations checked.
 *
 * Everything here is labelled as a claim. `seen` means the id appears in a
 * tool result this mission really read — the one kind of invention the product
 * can catch, so it is shown per reference instead of summarised away.
 */
function findingCard(finding) {
  const verdict = VERDICT_TEXT[finding.verdict] ?? { label: finding.verdict, tone: 'default' }
  const rows = [h('dt', { text: '依据' }), h('dd', { class: 'rig-wrap', text: finding.evidence })]
  if (finding.nextStep) rows.push(h('dt', { text: '下一步' }), h('dd', { text: finding.nextStep }))
  return h(
    'section',
    { class: 'qp-panel rig-finding', 'data-verdict': finding.verdict },
    h(
      'div',
      { class: 'qp-row qp-row--between' },
      h(
        'div',
        {},
        h('p', { class: 'qp-caption qp-muted', text: 'AGENT 判断 · 不是测试结论' }),
        h('h3', { class: 'qp-heading-2', text: verdict.label })
      ),
      h('span', {
        class: 'qp-status',
        'data-status': verdict.tone,
        text: `置信度 ${FINDING_CONFIDENCE[finding.confidence] ?? finding.confidence}`
      })
    ),
    h('p', { class: 'qp-body-1', text: finding.summary }),
    h('dl', { class: 'rig-kv' }, ...rows),
    finding.checkable
      ? h(
          'div',
          { class: 'rig-chips' },
          ...finding.references.map((reference) =>
            h('span', {
              class: 'rig-ref',
              'data-seen': reference.seen ? 'true' : null,
              title: reference.seen
                ? '这个 ID 出现在本次任务读到的工具结果里'
                : '这个 ID 没有出现在本次任务的工具结果里',
              text: `${reference.id}${reference.seen ? ' ✓ 已读到' : ' ⚠ 未读到'}`
            })
          )
        )
      : h('p', { class: 'qp-caption qp-muted', text: '没有可核对的 run / 计划 ID 引用。' }),
    h('p', {
      class: 'qp-caption qp-muted',
      text: '结论由 Agent 提交，不改变任何测试 Run 的状态。标「未读到」的引用说明它没有出现在本次任务的工具结果里，需要人工复核。'
    })
  )
}

function missionDetail(ctx, row) {
  const box = h('div', { class: 'rig-section' })
  box.append(
    h(
      'div',
      { class: 'qp-row qp-row--between' },
      h(
        'div',
        {},
        h('p', {
          class: 'qp-caption qp-muted',
          text: `MISSION / ${row.id.slice(0, 8)} · ${row.mode === 'agent' ? 'AGENT' : 'WORKFLOW'}${row.agentKey ? ` · ${row.agentKey}` : ''}`
        }),
        h('h2', { class: 'qp-heading-2', text: row.goal })
      ),
      statusTag(row.status, 'mission-status')
    )
  )
  if (row.finding) box.append(findingCard(row.finding))
  const timeline = h('div', { class: 'rig-timeline', id: 'timeline' })
  for (const event of row.events) {
    const body = h(
      'div',
      { class: 'rig-event__body' },
      h('div', { class: 'qp-body-2', text: event.message })
    )
    if (event.data) {
      const details = h('details')
      details.append(
        h('summary', { text: '查看执行证据' }),
        h('pre', { class: 'qp-code-block', text: JSON.stringify(event.data, null, 2) })
      )
      body.append(details)
      const screenshot = event.data.result?.screenshot
      if (ctx.state.native && screenshot)
        body.append(
          h('button', {
            class: 'qp-button qp-button--outline qp-button--sm rig-inline-action',
            text: '打开截图',
            onclick: () => ctx.run(() => ctx.api('artifact', { path: screenshot }))
          })
        )
    }
    timeline.append(
      h(
        'article',
        { class: 'rig-event', 'data-kind': event.kind },
        h('time', { text: new Date(event.at).toLocaleTimeString() }),
        body
      )
    )
  }
  // Partial model text. It arrives on the mission row and is redrawn by the
  // same poll as everything else, so the desktop and the web behave the same;
  // what it is not is a token-by-token feed.
  if (row.stream?.text) {
    timeline.append(
      h(
        'article',
        { class: 'rig-event', 'data-kind': 'stream' },
        h('time', { text: '正在输出' }),
        h(
          'div',
          { class: 'rig-event__body' },
          h('p', {
            class: 'qp-caption qp-muted',
            text: `模型正在生成第 ${row.stream.turn || row.turns || 1} 步的回复`
          }),
          h('p', { class: 'rig-stream qp-body-2', text: row.stream.text })
        )
      )
    )
    ctx.signal?.('saw_stream')
  }
  box.append(panel(null, timeline))

  if (row.status === 'awaiting_approval' && row.pending) {
    const buttons = h('div', { class: 'qp-row' })
    for (const [approved, label, cls] of [
      [true, '确认执行', 'qp-button qp-button--primary'],
      [false, '拒绝并停止', 'qp-button qp-button--danger']
    ])
      buttons.append(
        h('button', {
          class: cls,
          text: label,
          onclick: (event) => {
            event.target.disabled = true
            ctx.run(async () => {
              await ctx.api('approve', {
                id: row.id,
                approvalId: row.pending.approvalId,
                approved
              })
              await ctx.refresh()
            })
          }
        })
      )
    box.append(
      h(
        'div',
        { class: 'rig-approval', id: 'approval' },
        h('h3', { class: 'qp-heading-2', text: '确认这一次操作' }),
        h('p', {
          class: 'qp-body-2',
          text: `${ctx.toolTitle(row.pending.name)} · 确认只对下面这组参数生效；策略变更后需要重新发起。`
        }),
        h('pre', { class: 'qp-code-block', text: JSON.stringify(row.pending.args, null, 2) }),
        buttons
      )
    )
  }
  if (!['completed', 'failed', 'blocked', 'cancelled'].includes(row.status))
    box.append(
      h('button', {
        class: 'qp-button qp-button--danger qp-button--sm',
        text: '停止此任务',
        onclick: () =>
          ctx.run(async () => {
            await ctx.api('cancel', { id: row.id })
            await ctx.refresh()
          })
      })
    )
  return box
}

const CONFIDENCE_TEXT = { high: '匹配明确', medium: '可能是这个', low: '只能猜到这一步' }
const CONFIDENCE_TONE = { high: 'success', medium: 'warning', low: 'default' }

/**
 * What the sentence was understood as — and what is still missing.
 *
 * The parse happens on the server without a model, so everything here is
 * checkable: which words matched which plan, which required input has no
 * value yet, and why a candidate is blocked. Nothing runs until one of these
 * cards is confirmed, and the request posted is the one printed on the card.
 */
function proposalPanel(ctx) {
  const plan = ctx.state.plan
  if (!plan) return null
  const cards = plan.proposals.map((proposal) => {
    // Filled in on the card, not on the server: a missing plan id is the
    // reader's decision, and it has to be visible before it is posted.
    const body = {
      ...proposal.body,
      ...(proposal.body.inputs ? { inputs: { ...proposal.body.inputs } } : {})
    }
    const confirm = h('button', {
      class: 'qp-button qp-button--primary qp-button--sm',
      text: '确认派发',
      disabled: !ctx.canRun() || Boolean(proposal.blocked)
    })
    const ready = () => {
      if (proposal.kind === 'workflow') return Boolean(body.taskId)
      if (proposal.kind === 'orchestration')
        return proposal.missing.every((name) => Boolean(body.inputs?.[name]))
      return true
    }
    const sync = () => {
      confirm.disabled = !ctx.canRun() || Boolean(proposal.blocked) || !ready()
    }
    const fill = h('div', { class: 'rig-composer__controls' })
    if (proposal.kind === 'workflow' && proposal.missing.includes('taskId')) {
      const select = h(
        'select',
        { class: 'qp-select', 'aria-label': '测试计划' },
        h('option', { value: '', text: '选择测试计划…' }),
        ...proposal.candidates.map((entry) => h('option', { value: entry.id, text: entry.label }))
      )
      select.onchange = () => {
        body.taskId = select.value || undefined
        sync()
      }
      fill.append(select)
    }
    if (proposal.kind === 'orchestration')
      for (const name of proposal.missing) {
        const label = proposal.candidates.find((entry) => entry.id === name)?.label ?? name
        const input = h('input', { class: 'qp-input', maxlength: '400', placeholder: label })
        input.oninput = () => {
          body.inputs = { ...(body.inputs ?? {}), [name]: input.value }
          sync()
        }
        fill.append(input)
      }
    confirm.onclick = (event) => {
      event.target.disabled = true
      ctx.run(async () => {
        const { mission } = await ctx.api('start', body)
        ctx.state.selected = mission.id
        ctx.state.plan = null
        ctx.state.draft = ''
        await ctx.refresh()
      })
    }
    sync()
    return h(
      'article',
      { class: 'rig-proposal', 'data-blocked': proposal.blocked ? 'true' : null },
      h(
        'div',
        { class: 'qp-row qp-row--between' },
        h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: proposal.title }),
        h('span', {
          class: 'qp-status',
          'data-status': CONFIDENCE_TONE[proposal.confidence],
          text: CONFIDENCE_TEXT[proposal.confidence]
        })
      ),
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        ...proposal.because.map((line) => h('li', { text: line }))
      ),
      proposal.blocked ? h('p', { class: 'qp-body-2 rig-error', text: proposal.blocked }) : null,
      ...(proposal.warnings ?? []).map((line) =>
        h('p', { class: 'qp-caption qp-muted', text: line })
      ),
      fill.childElementCount ? fill : null,
      h('pre', { class: 'qp-code-block', text: JSON.stringify(body, null, 2) }),
      h('p', { class: 'qp-caption qp-muted', text: proposal.note }),
      h('div', { class: 'qp-row' }, confirm)
    )
  })
  return panel(
    '这句话可以这样执行',
    h('p', { class: 'qp-body-2 qp-muted', text: plan.note }),
    ...(cards.length ? cards : [empty('没有候选。换个说法，或直接在下面选测试计划。')]),
    h('button', {
      class: 'qp-button qp-button--ghost qp-button--sm rig-inline-action',
      text: '收起解析结果',
      onclick: () => ctx.clearPlan()
    })
  )
}

function composer(ctx, selected) {
  const terminal =
    !selected || ['completed', 'failed', 'blocked', 'cancelled'].includes(selected.status)
  if (!terminal)
    return h('p', { class: 'qp-caption qp-muted', text: '任务进行中，完成或停止后可以继续对话。' })
  const textarea = h('textarea', {
    class: 'qp-textarea',
    id: 'goal',
    rows: '3',
    maxlength: '8000',
    placeholder: selected ? '继续这项任务……' : '描述任务目标，或选择一个测试计划直接派发……'
  })
  textarea.value = ctx.state.draft ?? ''
  textarea.oninput = () => {
    ctx.state.draft = textarea.value
  }
  const mode = h(
    'select',
    { class: 'qp-select', id: 'mode', 'aria-label': '执行方式' },
    h('option', { value: 'agent', text: 'Agent 对话' }),
    h('option', { value: 'workflow', text: '测试工作流 · 无需模型' })
  )
  mode.value = ctx.state.mode
  const task = h('select', { class: 'qp-select', id: 'task', 'aria-label': '测试计划' })
  for (const entry of ctx.state.tasks)
    task.append(h('option', { value: entry.id, text: entry.name || entry.id }))
  if (ctx.state.pendingTask) task.value = ctx.state.pendingTask
  task.hidden = ctx.state.mode !== 'workflow' || Boolean(selected)
  task.onchange = () => {
    ctx.state.pendingTask = task.value
  }
  mode.onchange = () => {
    ctx.state.mode = mode.value
    task.hidden = mode.value !== 'workflow'
  }
  mode.hidden = Boolean(selected)

  const controls = h(
    'div',
    { class: 'rig-composer__controls' },
    mode,
    task,
    !selected &&
      ctx.state.agentKey &&
      h('span', { class: 'qp-tag qp-tag--primary', text: `Agent · ${ctx.state.agentKey}` }),
    // 对话式下任务：解析先行，执行仍然要按下面那个按钮。
    !selected &&
      h('button', {
        class: 'qp-button qp-button--outline',
        id: 'plan',
        type: 'button',
        text: '解析成任务 ⌕',
        disabled: !ctx.canRun(),
        onclick: () =>
          textarea.value.trim()
            ? ctx.run(() => ctx.planDispatch(textarea.value.trim()))
            : ctx.notice('先写一句话，例如「跑一下 Compass Electron 的登录验收」。')
      }),
    h('button', {
      class: 'qp-button qp-button--primary',
      id: 'start',
      type: 'submit',
      text: selected ? '继续对话 ↑' : '开始任务 ↑',
      disabled: !['operator', 'admin'].includes(ctx.state.principal?.role)
    })
  )
  const form = h(
    'form',
    {
      class: 'rig-composer',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          const body = selected
            ? { id: selected.id, goal: textarea.value }
            : {
                goal: textarea.value,
                mode: mode.value,
                ...(mode.value === 'workflow' ? { taskId: task.value } : {}),
                ...(mode.value === 'agent' && ctx.state.agentKey
                  ? { agentKey: ctx.state.agentKey }
                  : {})
              }
          const { mission } = await ctx.api(selected ? 'followup' : 'start', body)
          ctx.state.selected = mission.id
          ctx.state.draft = ''
          ctx.state.pendingTask = null
          await ctx.refresh()
        })
      }
    },
    textarea,
    controls,
    h('p', {
      class: 'qp-caption qp-muted',
      text: '写动作会展示具体参数，确认后才执行。任务完成不等于测试通过。'
    })
  )
  const parsed = selected ? null : proposalPanel(ctx)
  return parsed ? h('div', { class: 'rig-section' }, parsed, form) : form
}

// -- tests ---------------------------------------------------------------------

export async function tests(ctx, mount) {
  const [{ tasks = [] }, { runs = [] }, { apps = [] }] = await Promise.all([
    ctx.api('tasks'),
    ctx.api('runs'),
    ctx.api('apps').catch(() => ({ apps: [] }))
  ])
  ctx.state.tasks = tasks
  mount.append(
    panel(
      '已接入的应用',
      apps.length
        ? h(
            'div',
            { class: 'rig-cards' },
            ...apps.map((app) =>
              h(
                'article',
                { class: 'qp-panel qp-card' },
                h('strong', {
                  class: 'qp-body-1 qp-body-1--semibold',
                  text: app.displayName || app.slug
                }),
                h('div', { class: 'qp-caption qp-muted', text: app.slug }),
                h(
                  'div',
                  { class: 'rig-chips' },
                  ...(app.surfaces ?? []).map((surface) =>
                    h('span', { class: 'rig-chip', text: surface })
                  )
                )
              )
            )
          )
        : empty(
            '还没有接入应用。到完整测试管理台用「接入 / 对齐 Compass」登记 Web 与 Electron 两个 surface。'
          )
    ),
    panel(
      '测试计划',
      tasks.length
        ? h(
            'div',
            { class: 'rig-cards' },
            ...tasks.map((task) =>
              h(
                'article',
                { class: 'qp-panel qp-card rig-section' },
                h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: task.name || task.id }),
                h('div', { class: 'qp-caption qp-muted', text: task.id }),
                h(
                  'div',
                  { class: 'rig-chips' },
                  h('span', { class: 'rig-chip', text: `profile ${task.profile ?? '—'}` }),
                  h('span', { class: 'rig-chip', text: `track ${task.track ?? '—'}` }),
                  h('span', { class: 'rig-chip', text: task.runsOn ?? 'any-runner' })
                ),
                h('button', {
                  class: 'qp-button qp-button--outline qp-button--sm',
                  text: '创建测试工作流',
                  disabled:
                    task.enabled === false ||
                    !['operator', 'admin'].includes(ctx.state.principal?.role),
                  onclick: () => {
                    ctx.state.mode = 'workflow'
                    ctx.state.selected = null
                    ctx.state.draft = `执行测试计划：${task.name || task.id}`
                    ctx.state.pendingTask = task.id
                    ctx.go('missions')
                  }
                })
              )
            )
          )
        : empty('还没有测试计划。先在完整测试管理台建立套件与任务。')
    ),
    panel(
      '最近执行',
      runs.length
        ? table(
            [
              { title: '状态', cell: (run) => statusTag(run.status) },
              { title: 'Run ID', cell: (run) => h('span', { class: 'qp-caption', text: run.id }) },
              {
                title: '轨道',
                cell: (run) =>
                  h('span', {
                    class: 'qp-body-2 qp-muted',
                    text: `${run.profile ?? '—'} / ${run.track ?? '—'}`
                  })
              },
              {
                title: '时间',
                cell: (run) =>
                  h('span', {
                    class: 'qp-body-2 qp-muted',
                    text: ago(run.finishedAt ?? run.queuedAt)
                  })
              },
              {
                title: '',
                cell: (run) =>
                  h('button', {
                    class: 'qp-button qp-button--ghost qp-button--sm',
                    text: '报告 ↗',
                    onclick: () => ctx.openPath(`/api/v1/runs/${run.id}/report`)
                  })
              }
            ],
            runs,
            { layout: 'test-runs' }
          )
        : empty('还没有执行记录。')
    )
  )
}

// -- agent market ---------------------------------------------------------------

export async function agents(ctx, mount) {
  const list = ctx.state.config?.agents ?? []
  const byCategory = new Map()
  for (const agent of list) {
    if (!byCategory.has(agent.category)) byCategory.set(agent.category, [])
    byCategory.get(agent.category).push(agent)
  }
  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: 'Agent 是配置，不是代码：角色说明、可用工具和调用序列都保存在 Internal，服务端按 key 解析，客户端不能自带人设。'
    })
  )
  for (const [category, entries] of byCategory) {
    mount.append(
      panel(
        ctx.state.categories[category] ?? category,
        h('div', { class: 'rig-cards' }, ...entries.map((agent) => agentCard(ctx, agent)))
      )
    )
  }
  if (!list.length) mount.append(empty('没有启用的 Agent。管理员可在 Internal 配置里启用。'))
}

function agentCard(ctx, agent) {
  const persona = h('details')
  persona.append(
    h('summary', { text: '查看角色说明（模型收到的原文）' }),
    h('pre', { class: 'qp-code-block', text: agent.persona })
  )
  return h(
    'article',
    { class: 'rig-agent' },
    h(
      'div',
      { class: 'rig-agent__head' },
      h('span', { class: 'rig-agent__mark', text: AGENT_GLYPH[agent.category] ?? '◈' }),
      h(
        'div',
        {},
        h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: agent.displayName }),
        h('div', {
          class: 'qp-caption qp-muted',
          text: `${agent.key}${agent.builtin ? ' · 内置' : ' · 自定义'}`
        })
      )
    ),
    h('p', { class: 'qp-body-2 qp-soft', text: agent.summary }),
    h(
      'div',
      { class: 'rig-chips' },
      ...agent.tools.map((name) =>
        h('span', {
          class: 'rig-chip',
          'data-off': agent.effectiveTools.includes(name) ? null : 'true',
          'data-effect': ctx.toolEffect(name),
          text: name
        })
      )
    ),
    agent.surface === 'desktop' &&
      h('span', {
        class: 'qp-status',
        'data-status': 'info',
        text: '仅桌面端可用（需要隔离浏览器）'
      }),
    persona,
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '用这个 Agent 开始',
        disabled:
          agent.effectiveTools.length === 0 || (agent.surface === 'desktop' && !ctx.state.native),
        onclick: () => {
          ctx.state.agentKey = agent.key
          ctx.state.mode = 'agent'
          ctx.state.selected = null
          ctx.state.draft = agent.starter || ''
          ctx.go('missions')
        }
      })
    )
  )
}

// -- providers -------------------------------------------------------------------

export async function providers(ctx, mount) {
  const admin = ctx.state.principal?.role === 'admin'
  const model = ctx.state.config?.model ?? { configured: false, providers: [] }
  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '模型凭据永远不出现在界面、任务或用例里：只配置一个服务端环境变量名，值由部署注入。'
    }),
    panel(
      '生效中的调用序列',
      model.providers.length
        ? table(
            [
              {
                title: '顺序',
                cell: (entry) =>
                  h('span', { class: 'qp-tag qp-tag--primary', text: `#${entry.index}` })
              },
              {
                title: 'Provider',
                cell: (entry) =>
                  h(
                    'span',
                    { class: 'qp-data-cell' },
                    h('strong', { text: entry.displayName }),
                    h('small', { text: entry.id })
                  )
              },
              {
                title: '模型',
                cell: (entry) => h('span', { class: 'qp-body-2', text: entry.model })
              },
              {
                title: '',
                cell: (entry) =>
                  admin
                    ? h('button', {
                        class: 'qp-button qp-button--ghost qp-button--sm',
                        text: '连通性检查',
                        onclick: (event) => {
                          event.target.disabled = true
                          ctx.run(async () => {
                            const { probe } = await ctx.api('probe', { providerId: entry.id })
                            ctx.notice(
                              `${entry.displayName}：HTTP ${probe.status} · ${probe.latencyMs}ms · ${probe.note}`
                            )
                            event.target.disabled = false
                          })
                        }
                      })
                    : h('span', { class: 'qp-caption qp-muted', text: '仅管理员' })
              }
            ],
            model.providers.map((entry, index) => ({ ...entry, index: index + 1 })),
            { layout: 'providers' }
          )
        : empty('还没有可用的 Provider。序列里只有填了地址和模型名、且已启用的 Provider 才会生效。')
    ),
    panel(
      '故障转移如何工作',
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        h('li', { text: '按序列顺序尝试；上一个返回错误或超时，才会尝试下一个。' }),
        h('li', { text: '用户取消不会继续向下尝试——那是用户的决定，不是 Provider 故障。' }),
        h('li', { text: '缺少凭据环境变量的 Provider 会被跳过，并在最后一个失败时报告。' }),
        h('li', { text: '连通性检查只调用 /models，不消耗补全额度，也不验证模型名一定可用。' })
      )
    ),
    admin
      ? h('p', {
          class: 'qp-caption qp-muted',
          text: 'Provider 的新增、排序与停用在「Internal 配置」中完成。'
        })
      : h('p', { class: 'qp-caption qp-muted', text: '仅管理员可以修改 Provider 与调用序列。' })
  )
}

// -- orchestration centre ---------------------------------------------------------

const NODE_GLYPH = {
  tool: '⌘',
  branch: '⑂',
  fanout: '⋔',
  subflow: '⧉',
  human: '✋',
  model: '◈',
  output: '◉',
  step: '·'
}

export async function orchestration(ctx, mount) {
  const store = ctx.state.orchestration
  const specs = ctx.state.config?.orchestrations ?? []
  const admin = ctx.state.principal?.role === 'admin'
  const selected = store.selected
  const current = specs.find((entry) => entry.key === selected) ?? null

  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '编排是配置，不是代码：节点类型由运行时提供，作者决定下一步走哪个已知步骤、带什么参数、结果存进哪个变量。这里画的图来自编译后的图定义，和真正执行的是同一个对象。'
    }),
    panel(
      '选择一条编排',
      h(
        'div',
        { class: 'rig-chips' },
        h('button', {
          class: `qp-button qp-button--sm ${selected === 'mission' ? 'qp-button--primary' : 'qp-button--outline'}`,
          text: '任务图（Agent 对话 / 测试工作流）',
          onclick: () => ctx.selectOrchestration('mission')
        }),
        ...specs.map((entry) =>
          h('button', {
            class: `qp-button qp-button--sm ${selected === entry.key ? 'qp-button--primary' : 'qp-button--outline'}`,
            text: entry.displayName,
            onclick: () => ctx.selectOrchestration(entry.key)
          })
        )
      ),
      current && h('p', { class: 'qp-body-2 qp-soft', text: current.summary }),
      current?.missingTools?.length
        ? h('span', {
            class: 'qp-status',
            'data-status': 'warning',
            text: `以下工具未被 Internal 允许，这条编排会在该步骤受阻：${current.missingTools.join('、')}`
          })
        : null,
      current?.nextFireAt
        ? h('span', {
            class: 'qp-status',
            'data-status': 'info',
            text: `定时执行 ${current.schedule.cronExpr}（${current.schedule.timezone}），下次 ${new Date(current.nextFireAt).toLocaleString()}`
          })
        : null
    )
  )

  const shape = store.preview?.graph ?? store.graph
  const detail = h('div', { class: 'rig-section' })
  const showNode = (node) => {
    detail.replaceChildren(
      ...[
        h('h3', { class: 'qp-heading-2', text: `${NODE_GLYPH[node.kind] ?? '·'} ${node.title}` }),
        h('div', { class: 'qp-caption qp-muted', text: `${node.name} · ${node.kind}` }),
        h('p', { class: 'qp-body-2 qp-soft', text: node.description || '（无说明）' }),
        node.interrupts
          ? h('span', {
              class: 'qp-status',
              'data-status': 'warning',
              text: '这是一个暂停点：会等待人工确认'
            })
          : null
      ].filter(Boolean)
    )
  }
  if (shape?.nodes?.length) showNode(shape.nodes[0])

  const mission = ctx.state.missions.find((row) => row.id === ctx.state.selected) ?? null
  const traceSource =
    selected !== 'mission' && mission?.orchestrationKey === selected
      ? mission
      : selected === 'mission'
        ? mission
        : null

  mount.append(
    panel(
      store.error
        ? '草稿有问题，下面仍显示已保存的版本'
        : store.preview
          ? '草稿预览（尚未保存）'
          : '编排图',
      store.error
        ? h(
            'div',
            { class: 'rig-approval qp-body-2' },
            h('strong', { text: '无法编译：' }),
            store.error
          )
        : null,
      shape
        ? h(
            'div',
            { class: 'rig-graph' },
            renderGraph(shape, {
              trace: (traceSource?.trace ?? []).map((entry) => entry.node),
              current:
                traceSource?.status === 'awaiting_approval'
                  ? 'approve'
                  : ((traceSource?.trace ?? []).at(-1)?.node ?? null),
              onSelect: showNode,
              // Only an admin editing this spec can move nodes, and only the
              // draft moves — the saved layout changes when they save.
              onMove: admin && current ? (name, at) => ctx.moveNode(name, at) : undefined
            })
          )
        : empty(store.error ?? '编排图加载中'),
      store.preview?.warnings?.length
        ? h(
            'div',
            { class: 'qp-stack qp-stack--tight' },
            ...store.preview.warnings.map((line) =>
              h('span', { class: 'qp-status', 'data-status': 'warning', text: line })
            )
          )
        : null,
      h(
        'div',
        { class: 'rig-legend' },
        h('span', { text: '实线 = 固定边' }),
        h('span', { text: '虚线 = 条件边' }),
        h('span', { text: '点线 = 分叉' }),
        h('span', { text: '黄色虚框 = 暂停点' }),
        h('span', { text: '高亮 = 当前任务真实走过' }),
        admin && current ? h('span', { text: '可以拖动节点摆位置' }) : null
      )
    ),
    h(
      'div',
      { class: 'rig-grid-2' },
      panel('节点说明', detail),
      selected === 'mission' ? panel('状态通道', channelsPanel()) : runPanel(ctx, current)
    )
  )

  if (admin && current) mount.append(await editorPanel(ctx, current))
}

function runPanel(ctx, spec) {
  if (!spec) return panel('运行', empty('先选择一条编排'))
  const values = {}
  const fields = spec.inputs.map((input) => {
    const control =
      input.kind === 'task'
        ? h(
            'select',
            { class: 'qp-select' },
            ...ctx.state.tasks.map((task) =>
              h('option', { value: task.id, text: task.name || task.id })
            )
          )
        : h('input', { class: 'qp-input', placeholder: input.kind === 'run' ? 'trun_…' : '' })
    values[input.name] = () => control.value
    return h(
      'label',
      { class: 'qp-field' },
      h('span', { class: 'qp-field__label', text: `${input.label}（${input.name}）` }),
      control
    )
  })
  const blocked = (spec.missingTools ?? []).length > 0
  return panel(
    '运行这条编排',
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '编排会在写动作和检查点处停下来等你确认。跑完不等于测试通过。'
    }),
    ...fields,
    h('button', {
      class: 'qp-button qp-button--primary',
      text: '开始运行 ↑',
      disabled: blocked || !['operator', 'admin'].includes(ctx.state.principal?.role),
      onclick: (event) => {
        event.target.disabled = true
        ctx
          .run(async () => {
            const inputs = Object.fromEntries(
              Object.entries(values).map(([name, read]) => [name, read()])
            )
            const missing = spec.inputs.filter((input) => input.required && !inputs[input.name])
            if (missing.length) throw new Error(`请填写：${missing.map((i) => i.label).join('、')}`)
            const { mission } = await ctx.api('start', {
              mode: 'orchestration',
              goal: `运行编排：${spec.displayName}`,
              orchestrationKey: spec.key,
              inputs
            })
            ctx.state.selected = mission.id
            await ctx.refresh()
            ctx.go('missions')
          })
          .finally(() => {
            event.target.disabled = false
          })
      }
    }),
    blocked &&
      h('span', {
        class: 'qp-status',
        'data-status': 'warning',
        text: '所需工具未被允许，无法运行'
      })
  )
}

// -- the editor ---------------------------------------------------------------------

const TOOL_NODE = () => ({
  id: '',
  title: '新步骤',
  type: 'tool',
  tool: 'tests_runners',
  args: {},
  capture: {},
  next: null
})
const NEW_NODE = {
  tool: TOOL_NODE,
  fanout: () => ({ id: '', title: '新分叉', type: 'fanout', branches: [], join: '' }),
  subflow: () => ({
    id: '',
    title: '新子编排',
    type: 'subflow',
    orchestrationKey: '',
    inputs: {},
    next: null
  }),
  branch: () => ({
    id: '',
    title: '新分支',
    type: 'branch',
    test: { var: '', op: 'exists' },
    then: null,
    otherwise: null
  }),
  approval: () => ({
    id: '',
    title: '新检查点',
    type: 'approval',
    message: '继续之前请人工核对。',
    next: null
  }),
  analyze: () => ({
    id: '',
    title: '新分析',
    type: 'analyze',
    agentKey: 'result-analyst',
    instruction: '基于已收集的证据给出结论。',
    next: null
  }),
  finish: () => ({ id: '', title: '结束', type: 'finish', message: '编排结束。' })
}
const OPS = [
  ['exists', '有值'],
  ['missing', '为空'],
  ['eq', '等于'],
  ['ne', '不等于'],
  ['gt', '大于'],
  ['lt', '小于'],
  ['in', '属于']
]

async function editorPanel(ctx, spec) {
  const store = ctx.state.orchestration
  const draft = store.draft ?? structuredClone(spec)
  store.draft = draft
  const box = h('div', { class: 'rig-section' })
  const targets = () => [
    { value: '', label: '→ 结束' },
    ...draft.nodes.map((node) => ({ value: node.id, label: `→ ${node.title}（${node.id}）` }))
  ]

  const select = (value, options, onChange) => {
    const node = h(
      'select',
      { class: 'qp-select' },
      ...options.map((o) => h('option', { value: o.value, text: o.label }))
    )
    node.value = value ?? ''
    node.onchange = () => onChange(node.value === '' ? null : node.value)
    return node
  }
  const textField = (
    label,
    value,
    onInput,
    { area = false, placeholder = '', commit = false } = {}
  ) => {
    const control = area
      ? h('textarea', { class: 'qp-textarea', rows: '3', placeholder })
      : h('input', { class: 'qp-input', placeholder })
    control.value = value ?? ''
    control.oninput = () => onInput(control.value)
    // A node's id and title are how every other card refers to it. Redraw once
    // the author leaves the field, or the "下一步" menus keep offering the old
    // name and wiring to a node you just renamed silently selects nothing.
    if (commit) control.onchange = () => rerender()
    return h(
      'label',
      { class: 'qp-field' },
      h('span', { class: 'qp-field__label', text: label }),
      control
    )
  }
  const pairsField = (label, example, value, onChange) => {
    const control = h('textarea', { class: 'qp-textarea', rows: '3', placeholder: example })
    control.value = Object.entries(value)
      .map(([k, v]) => `${k} = ${typeof v === 'string' ? v : JSON.stringify(v)}`)
      .join('\n')
    control.oninput = () => onChange(control.value)
    return h(
      'label',
      { class: 'qp-field' },
      h('span', { class: 'qp-field__label', text: label }),
      control,
      h('span', { class: 'qp-field__hint', text: `例如：${example}` })
    )
  }

  const rerender = () => {
    box.replaceChildren()
    build()
  }

  function nodeCard(node, index) {
    const head = h(
      'div',
      { class: 'qp-row qp-row--between' },
      h(
        'div',
        {},
        h('strong', {
          class: 'qp-body-1 qp-body-1--semibold',
          text: `${NODE_GLYPH[ctx.state.nodeTypes[node.type]?.kind] ?? '·'} ${node.title || '(未命名)'}`
        }),
        h('div', {
          class: 'qp-caption qp-muted',
          text: `${node.id || '(缺少 ID)'} · ${ctx.state.nodeTypes[node.type]?.title ?? node.type}${draft.entry === node.id ? ' · 入口' : ''}`
        })
      ),
      h(
        'div',
        { class: 'qp-row' },
        draft.entry !== node.id &&
          h('button', {
            class: 'qp-button qp-button--ghost qp-button--sm',
            text: '设为入口',
            onclick: () => {
              draft.entry = node.id
              rerender()
            }
          }),
        h('button', {
          class: 'qp-button qp-button--ghost qp-button--sm',
          text: '删除',
          onclick: () => {
            draft.nodes.splice(index, 1)
            for (const other of draft.nodes) {
              if (other.next === node.id) other.next = null
              if (other.then === node.id) other.then = null
              if (other.otherwise === node.id) other.otherwise = null
            }
            if (draft.entry === node.id) draft.entry = draft.nodes[0]?.id ?? ''
            rerender()
          }
        })
      )
    )
    const fields = [
      h(
        'div',
        { class: 'rig-grid-2' },
        textField(
          '节点 ID',
          node.id,
          (value) => {
            const previous = node.id
            node.id = value
            // Keep every edge pointing at this node rather than quietly
            // dropping them when its id changes.
            for (const other of draft.nodes) {
              if (other.next === previous) other.next = value
              if (other.then === previous) other.then = value
              if (other.otherwise === previous) other.otherwise = value
            }
            if (draft.entry === previous) draft.entry = value
          },
          { commit: true }
        ),
        textField(
          '标题',
          node.title,
          (value) => {
            node.title = value
          },
          { commit: true }
        )
      )
    ]
    if (node.type === 'tool') {
      fields.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '工具' }),
            select(
              node.tool,
              ctx.state.tools.map((tool) => ({
                value: tool.name,
                label: `${tool.title}（${tool.name}${tool.effect === 'write' ? ' · 需确认' : ''}）`
              })),
              (value) => {
                node.tool = value
              }
            )
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '下一步' }),
            select(node.next, targets(), (value) => {
              node.next = value
            })
          )
        ),
        pairsField(
          '参数（每行 名称 = 值，值里可以用 {{变量名}}）',
          'taskId = {{taskId}}',
          node.args,
          (raw) => {
            node.args = parsePairs(raw)
          }
        ),
        pairsField(
          '取出变量（每行 变量名 = 路径，或 变量名 = count:路径:字段）',
          'runId = run.id',
          Object.fromEntries(
            Object.entries(node.capture).map(([name, rule]) => [
              name,
              rule.select === 'count'
                ? `count:${rule.from}${rule.where ? `:${rule.where}` : ''}`
                : rule.from
            ])
          ),
          (raw) => {
            node.capture = Object.fromEntries(
              Object.entries(parsePairs(raw)).map(([name, value]) => {
                const parts = String(value).split(':')
                return parts[0] === 'count'
                  ? [
                      name,
                      {
                        from: parts[1] ?? '',
                        select: 'count',
                        ...(parts[2] ? { where: parts[2] } : {})
                      }
                    ]
                  : [name, { from: String(value), select: 'value' }]
              })
            )
          }
        )
      )
    }
    if (node.type === 'branch') {
      fields.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          textField('判断变量', node.test.var, (value) => {
            node.test.var = value
          }),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '比较方式' }),
            select(
              node.test.op,
              OPS.map(([value, label]) => ({ value, label })),
              (value) => {
                node.test.op = value
              }
            )
          )
        ),
        textField(
          node.test.op === 'in' ? '候选值（逗号分隔）' : '比较值',
          node.test.op === 'in' ? (node.test.values ?? []).join(',') : (node.test.value ?? ''),
          (value) => {
            if (node.test.op === 'in')
              node.test.values = value
                .split(',')
                .map((entry) => entry.trim())
                .filter(Boolean)
            else node.test.value = value
          }
        ),
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '成立时' }),
            select(node.then, targets(), (value) => {
              node.then = value
            })
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '不成立时' }),
            select(node.otherwise, targets(), (value) => {
              node.otherwise = value
            })
          )
        )
      )
    }
    if (node.type === 'fanout') {
      const picks = h('div', { class: 'rig-chips' })
      for (const other of draft.nodes) {
        if (other.id === node.id) continue
        const input = h('input', { type: 'checkbox' })
        input.checked = node.branches.includes(other.id)
        input.onchange = () => {
          node.branches = input.checked
            ? [...new Set([...node.branches, other.id])]
            : node.branches.filter((id) => id !== other.id)
        }
        picks.append(
          h(
            'label',
            { class: 'qp-choice qp-choice--checkbox' },
            input,
            h('span', { class: 'qp-choice__control' }),
            h('span', { class: 'qp-caption', text: `${other.title}（${other.id}）` })
          )
        )
      }
      fields.push(
        h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: '分支入口（至少两个，按勾选顺序依次执行）' }),
          picks
        ),
        h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: '汇合节点（全部分支到齐后继续）' }),
          select(
            node.join,
            targets().filter((option) => option.value !== ''),
            (value) => {
              node.join = value ?? ''
            }
          )
        )
      )
    }
    if (node.type === 'subflow') {
      const others = (ctx.state.config?.orchestrations ?? []).filter(
        (entry) => entry.key !== draft.key
      )
      fields.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '要嵌入的编排' }),
            select(
              node.orchestrationKey,
              others.map((entry) => ({
                value: entry.key,
                label: `${entry.displayName}（${entry.key}）`
              })),
              (value) => {
                node.orchestrationKey = value ?? ''
              }
            )
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '下一步' }),
            select(node.next, targets(), (value) => {
              node.next = value
            })
          )
        ),
        pairsField(
          '传给子编排的输入（每行 子编排输入名 = 值）',
          'taskId = {{webTask}}',
          node.inputs,
          (raw) => {
            node.inputs = parsePairs(raw)
          }
        ),
        h('span', {
          class: 'qp-field__hint',
          text: `子编排里的变量在这里要写成 ${node.id || '<本节点ID>'}__变量名，同一条子编排用两次也不会串。`
        })
      )
    }
    if (node.type === 'approval')
      fields.push(
        textField(
          '给确认人的说明',
          node.message,
          (value) => {
            node.message = value
          },
          { area: true }
        ),
        h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: '通过后' }),
          select(node.next, targets(), (value) => {
            node.next = value
          })
        )
      )
    if (node.type === 'analyze')
      fields.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: 'Agent' }),
            select(
              node.agentKey,
              (ctx.state.config?.agents ?? []).map((agent) => ({
                value: agent.key,
                label: `${agent.displayName}（${agent.key}）`
              })),
              (value) => {
                node.agentKey = value
              }
            )
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '下一步' }),
            select(node.next, targets(), (value) => {
              node.next = value
            })
          )
        ),
        textField(
          '交给它做什么',
          node.instruction,
          (value) => {
            node.instruction = value
          },
          { area: true }
        )
      )
    if (node.type === 'finish')
      fields.push(
        textField(
          '结论文本（可以用 {{变量名}}）',
          node.message,
          (value) => {
            node.message = value
          },
          { area: true }
        )
      )
    return h('article', { class: 'qp-panel qp-stack' }, head, ...fields)
  }

  function scheduleCard() {
    const on = h('input', { type: 'checkbox' })
    on.checked = Boolean(draft.schedule)
    on.onchange = () => {
      draft.schedule = on.checked
        ? { cronExpr: '0 9 * * 1-5', timezone: 'Asia/Shanghai', enabled: true }
        : null
      rerender()
    }
    const rows = [
      h(
        'label',
        { class: 'qp-choice qp-choice--checkbox' },
        on,
        h('span', { class: 'qp-choice__control' }),
        h('span', { text: '定时自动执行' })
      )
    ]
    if (draft.schedule) {
      const cron = h('input', { class: 'qp-input', placeholder: '0 9 * * 1-5' })
      cron.value = draft.schedule.cronExpr
      cron.oninput = () => {
        draft.schedule.cronExpr = cron.value
      }
      const zone = h('input', { class: 'qp-input', placeholder: 'Asia/Shanghai' })
      zone.value = draft.schedule.timezone ?? 'Asia/Shanghai'
      zone.oninput = () => {
        draft.schedule.timezone = zone.value
      }
      const enabled = h('input', { type: 'checkbox' })
      enabled.checked = draft.schedule.enabled !== false
      enabled.onchange = () => {
        draft.schedule.enabled = enabled.checked
      }
      rows.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: 'cron（分 时 日 月 周）' }),
            cron
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '时区' }),
            zone
          )
        ),
        h(
          'label',
          { class: 'qp-choice qp-choice--checkbox' },
          enabled,
          h('span', { class: 'qp-choice__control' }),
          h('span', { text: '启用这条定时规则' })
        )
      )
    }
    rows.push(
      h('p', {
        class: 'qp-caption qp-muted',
        text: '定时执行时没有人在场，所以只有能自己跑完的编排可以排期：不能有人工检查点、写工具或子编排，也不能有必填输入。保存时会检查。'
      })
    )
    return h('article', { class: 'qp-panel qp-stack' }, ...rows)
  }

  function build() {
    box.append(
      scheduleCard(),
      ...draft.nodes.map((node, index) => nodeCard(node, index)),
      h(
        'div',
        { class: 'rig-chips' },
        ...Object.entries(ctx.state.nodeTypes).map(([type, meta]) =>
          h('button', {
            class: 'qp-button qp-button--outline qp-button--sm',
            text: `＋ ${meta.title}`,
            title: meta.hint,
            onclick: () => {
              const node = NEW_NODE[type]()
              node.id = `${type}_${draft.nodes.length + 1}`
              draft.nodes.push(node)
              if (!draft.entry) draft.entry = node.id
              rerender()
            }
          })
        )
      ),
      h(
        'div',
        { class: 'qp-row' },
        h('button', {
          class: 'qp-button qp-button--outline',
          text: '校验并预览',
          onclick: () => ctx.previewOrchestration(draft)
        }),
        h('button', {
          class: 'qp-button qp-button--ghost',
          text: '自动排布',
          disabled: Object.keys(draft.layout ?? {}).length === 0,
          onclick: () => {
            draft.layout = {}
            ctx.previewOrchestration(draft)
          }
        }),
        h('button', {
          class: 'qp-button qp-button--primary',
          text: '保存到 Internal',
          onclick: (event) => {
            event.target.disabled = true
            ctx
              .run(() => ctx.saveOrchestration(draft))
              .finally(() => {
                event.target.disabled = false
              })
          }
        }),
        h('button', {
          class: 'qp-button qp-button--ghost',
          text: '放弃修改',
          onclick: () => {
            store.draft = null
            store.preview = null
            ctx.render()
          }
        })
      ),
      store.error && h('span', { class: 'qp-status', 'data-status': 'danger', text: store.error })
    )
  }
  build()
  return panel(
    `编辑：${spec.displayName}`,
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '改完先「校验并预览」，上面的图会换成草稿编译后的结果；保存前不会影响正在运行的任务。内置编排可以改写、可以停用，但不能删除。'
    }),
    box
  )
}

/** What the mission loop routes on. Shown beside the generic task graph. */
function channelsPanel() {
  const rows = [
    ['mode', 'agent 或 workflow，决定入口分支', '覆盖'],
    ['turns', '已完成的模型规划轮数，用于步数预算', '覆盖'],
    ['call', '待执行的工具调用（名称与参数）', '覆盖'],
    ['write', '这次调用是否需要人工确认', '覆盖'],
    ['approved', '人工确认的结果，仅对当前参数有效', '覆盖'],
    ['answer', '模型给出的结论文本', '覆盖'],
    ['trace', '真实经过的节点序列', '追加']
  ]
  return h(
    'div',
    {},
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '每个节点只返回增量，由通道的合并规则并入全局状态；写错形状会在产生它的节点当场失败，而不是几步之后在路由里才暴露。'
    }),
    table(
      [
        { title: '通道', cell: (row) => h('span', { class: 'qp-caption', text: row[0] }) },
        { title: '含义', cell: (row) => h('span', { class: 'qp-body-2', text: row[1] }) },
        { title: '合并', cell: (row) => h('span', { class: 'rig-chip', text: row[2] }) }
      ],
      rows,
      { layout: 'channels' }
    )
  )
}

function parsePairs(raw) {
  const out = {}
  for (const line of String(raw).split('\n')) {
    const at = line.indexOf('=')
    if (at < 0) continue
    const name = line.slice(0, at).trim()
    const value = line.slice(at + 1).trim()
    if (name) out[name] = value
  }
  return out
}

// -- tools -------------------------------------------------------------------------

export async function tools(ctx, mount) {
  const { tools: catalogue = [], groups = {} } = await ctx.api('tools')
  ctx.state.tools = catalogue
  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '工具由 Internal 允许列表控制，执行前还会重新校验一次策略版本；策略变了，等待中的确认就作废。'
    })
  )
  for (const [group, meta] of Object.entries(groups)) {
    const entries = catalogue.filter((tool) => tool.group === group)
    if (!entries.length) continue
    mount.append(
      panel(
        `${meta.title} · ${meta.where}`,
        table(
          [
            {
              title: '工具',
              cell: (tool) =>
                h(
                  'span',
                  { class: 'qp-data-cell' },
                  h('strong', { text: tool.title }),
                  h('small', { text: tool.name })
                )
            },
            {
              title: '说明',
              cell: (tool) => h('span', { class: 'qp-body-2 qp-soft', text: tool.description })
            },
            {
              title: '动作',
              cell: (tool) =>
                h('span', {
                  class: `qp-tag ${tool.effect === 'write' ? 'qp-tag--danger' : ''}`,
                  text: tool.effect === 'write' ? '写 · 需确认' : '只读'
                })
            },
            {
              title: 'Internal',
              cell: (tool) =>
                h('span', {
                  class: 'qp-status',
                  'data-status': tool.allowed ? 'success' : 'default',
                  text: tool.allowed ? '已允许' : '未允许'
                })
            }
          ],
          entries,
          { layout: 'tools' }
        )
      )
    )
  }
}

// -- egress ---------------------------------------------------------------------------

const ROUTE_TEXT = { 'rig-channel': 'Rig 通道', 'proxy-env': '代理环境变量', direct: '直连' }

export async function egress(ctx, mount) {
  const { egress: observed, note } = await ctx.api('egress')
  mount.append(
    h('div', { class: 'qp-panel qp-panel--active' }, h('p', { class: 'qp-body-2', text: note })),
    h(
      'div',
      { class: 'qp-metric-grid' },
      metric(
        '模型调用',
        ROUTE_TEXT[observed.route.model] ?? observed.route.model,
        '服务端发出的请求'
      ),
      metric(
        '隔离浏览器',
        ROUTE_TEXT[observed.route.browser] ?? observed.route.browser,
        '桌面 Runtime 打开的页面'
      ),
      metric(
        '环境变量观测',
        observed.configured ? (observed.honored ? '已配置且生效' : '已配置但未生效') : '未配置',
        observed.honored ? 'NODE_USE_ENV_PROXY=1' : 'Node fetch 不读代理变量'
      ),
      metric('其他一切', '由部署环境决定', 'Rig 不设置系统代理或路由')
    ),
    h(
      'div',
      { class: 'rig-grid-2' },
      panel(
        observed.effective === 'proxy-env' ? '环境观测：按代理环境变量' : '环境观测：直连',
        h('p', { class: 'qp-body-2 qp-soft', text: observed.reason }),
        h(
          'dl',
          { class: 'rig-kv' },
          h('dt', { text: '观测来源' }),
          h('dd', { text: observed.sourceKind }),
          h('dt', { text: '运行位置' }),
          h('dd', { text: `${observed.runtime.platform} · ${observed.runtime.hostname || '—'}` }),
          h('dt', { text: 'Node' }),
          h('dd', { text: observed.runtime.node }),
          h('dt', { text: '观测时间' }),
          h('dd', { text: new Date(observed.observedAt).toLocaleString() })
        )
      ),
      panel(
        '进程可见的代理变量',
        table(
          [
            {
              title: '变量',
              cell: (entry) => h('span', { class: 'qp-caption', text: entry.source ?? entry.name })
            },
            {
              title: '值',
              cell: (entry) =>
                h('span', {
                  class: 'qp-body-2 rig-wrap',
                  text: entry.set ? entry.value : '未设置'
                })
            },
            {
              title: '凭据',
              cell: (entry) =>
                h('span', {
                  class: 'qp-status',
                  'data-status': entry.credentials ? 'warning' : 'default',
                  text: entry.credentials ? '含凭据（已隐藏）' : '无'
                })
            }
          ],
          observed.variables,
          { layout: 'egress' }
        )
      )
    ),
    channelsEgressPanel(ctx, observed),
    panel(
      '这一页管什么、不管什么',
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        h('li', {
          text: '管：Rig 自己的两种出网请求——服务端的模型调用，和桌面 Runtime 打开的隔离浏览器。'
        }),
        h('li', {
          text: '不管：系统代理、路由表、DNS、PAC、NRPT，以及其他任何应用的网络归属。Rig 不拥有网络。'
        }),
        h('li', {
          text: '上半页始终是真实环境观测，不会因为启用了通道而改写——「模型连不上」和「模型配错了」要能分开。'
        }),
        h('li', {
          text: '切换通道会产生新的策略版本：已经发出的待确认动作随之失效，需要重新发起。'
        }),
        h('li', {
          text: '需要私网连通时，仍由管理员在部署层提供，或通过 standalone launcher 的既有能力接入。'
        })
      )
    )
  )
}

/**
 * Rig's own channels: the switchable half.
 *
 * Credentials follow the Provider rule — an environment variable name is
 * stored, the value is read in the server process, and a channel that needs
 * one may not be used by the desktop browser at all.
 */
function channelsEgressPanel(ctx, observed) {
  const admin = ctx.state.principal?.role === 'admin'
  const managed = observed.managed
  const profiles = managed.profiles ?? []
  const rows = profiles.length
    ? table(
        [
          {
            title: '通道',
            cell: (profile) =>
              h(
                'div',
                {},
                h('strong', { class: 'qp-body-2', text: profile.displayName }),
                h('div', { class: 'qp-caption qp-muted', text: profile.proxyUrl })
              )
          },
          {
            title: '作用面',
            cell: (profile) =>
              h(
                'div',
                { class: 'rig-chips' },
                ...profile.appliesTo.map((surface) =>
                  h('span', {
                    class: 'rig-chip',
                    text: surface === 'model' ? '模型调用' : '浏览器'
                  })
                )
              )
          },
          {
            title: '凭据',
            cell: (profile) =>
              h('span', {
                class: 'qp-status',
                'data-status': profile.authEnv
                  ? profile.authConfigured
                    ? 'success'
                    : 'warning'
                  : 'default',
                text: profile.authEnv
                  ? `${profile.authEnv}${profile.authConfigured ? '' : '（未设置）'}`
                  : '无'
              })
          },
          {
            title: '',
            cell: (profile) =>
              h(
                'div',
                { class: 'qp-row' },
                h('button', {
                  class: `qp-button qp-button--sm ${
                    managed.activeId === profile.id ? 'qp-button--outline' : 'qp-button--primary'
                  }`,
                  text: managed.activeId === profile.id ? '当前启用' : '切到这条',
                  disabled: !admin || managed.activeId === profile.id,
                  onclick: () => ctx.run(() => ctx.activateEgress(profile.id))
                }),
                h('button', {
                  class: 'qp-button qp-button--ghost qp-button--sm',
                  text: '删除',
                  disabled: !admin,
                  onclick: () =>
                    ctx.run(() =>
                      ctx.saveEgress(
                        profiles.filter((entry) => entry.id !== profile.id),
                        managed.activeId === profile.id ? null : managed.activeId
                      )
                    )
                })
              )
          }
        ],
        profiles,
        { layout: 'egress-channels' }
      )
    : empty('还没有配置通道：Rig 的模型调用按环境观测走，隔离浏览器直连。')

  const body = [
    h('p', { class: 'qp-body-2 qp-muted', text: managed.route?.note ?? observed.route.note }),
    rows,
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '改为直连',
        disabled: !admin || !managed.activeId,
        onclick: () => ctx.run(() => ctx.activateEgress(null))
      })
    )
  ]
  if (admin) body.push(channelForm(ctx, profiles, managed.activeId))
  else
    body.push(
      h('p', { class: 'qp-caption qp-muted', text: '只有管理员可以新增、删除或切换通道。' })
    )
  return panel('Rig 自己的通道（可实时切换）', ...body)
}

function channelForm(ctx, profiles, activeId) {
  const field = (label, placeholder, attrs = {}) => {
    const input = h('input', { class: 'qp-input', placeholder, maxlength: '300', ...attrs })
    return {
      input,
      node: h(
        'label',
        { class: 'qp-field' },
        h('span', { class: 'qp-field__label', text: label }),
        input
      )
    }
  }
  const id = field('通道 ID', 'office-proxy')
  const name = field('名称', '办公网代理')
  const url = field('通道地址', 'http://127.0.0.1:7890')
  const bypass = field('直连列表（逗号分隔）', '.internal.example.com, 10.0.0.5')
  const auth = field('凭据环境变量名（可留空）', 'MX_RIG_EGRESS_AUTH', { maxlength: '101' })
  const model = h('input', { type: 'checkbox', checked: true })
  const browser = h('input', { type: 'checkbox' })
  return h(
    'form',
    {
      class: 'rig-section',
      onsubmit: (event) => {
        event.preventDefault()
        const next = {
          id: id.input.value.trim(),
          displayName: name.input.value.trim() || id.input.value.trim(),
          proxyUrl: url.input.value.trim(),
          bypass: bypass.input.value
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean),
          ...(auth.input.value.trim() ? { authEnv: auth.input.value.trim() } : {}),
          appliesTo: [...(model.checked ? ['model'] : []), ...(browser.checked ? ['browser'] : [])]
        }
        ctx.run(() => ctx.saveEgress([...profiles, next], activeId))
      }
    },
    h('h3', { class: 'qp-heading-2', text: '新增通道' }),
    h('div', { class: 'rig-grid-2' }, id.node, name.node, url.node, bypass.node, auth.node),
    h(
      'div',
      { class: 'qp-row' },
      h('label', { class: 'qp-row' }, model, h('span', { class: 'qp-body-2', text: '模型调用' })),
      h(
        'label',
        { class: 'qp-row' },
        browser,
        h('span', { class: 'qp-body-2', text: '隔离浏览器' })
      )
    ),
    h('p', {
      class: 'qp-caption qp-muted',
      text: '地址只写 scheme://host:port，不要带凭据。socks 通道只能作用于浏览器；需要凭据的通道不能作用于浏览器。'
    }),
    h('button', {
      class: 'qp-button qp-button--primary qp-button--sm rig-inline-action',
      type: 'submit',
      text: '保存通道'
    })
  )
}

// -- guide ------------------------------------------------------------------------------

export async function guide(ctx, mount) {
  const steps = [
    {
      title: '1 · 先看懂三个词',
      body: [
        '应用 = 要测的系统（Compass 有 Web 和 Electron 两个 surface）。',
        '套件 = 一组用例怎么跑（cypress / playwright-electron、在哪台机器上）。',
        '计划 = 一次可重复的执行（选套件 + profile + 轨道 functional/demo）。'
      ]
    },
    {
      title: '2 · 跑第一次',
      body: [
        '到「测试中心」挑一个计划，点「创建测试工作流」。',
        '回到任务工作台，核对 tests_run 的参数，点确认。',
        '拿到 run ID，不代表通过——要去看它最后是什么状态。'
      ]
    },
    {
      title: '3 · 读结果，而不是猜',
      body: [
        'passed / failed / flaky / blocked / expired / cancelled 都是不同的事。',
        'blocked 常常是环境或执行机问题，不是产品缺陷。',
        'demo 轨道会录像，functional 轨道追求快和稳定。'
      ]
    },
    {
      title: '4 · 让 Agent 帮你读',
      body: [
        '「结果分析师」把一次执行拆到用例与步骤级。',
        '「失败定级员」给出产品缺陷 / 环境受阻 / 用例问题 / flaky 四选一，并要求给证据。',
        'Agent 不会替你放行发布，也不能改测试结论。'
      ]
    },
    {
      title: '5 · 卡住了怎么办',
      body: [
        '一直排队 → 去「出网与通道」和完整管理台的执行机页，先确认有没有在线执行机。',
        'Agent 说受阻 → 看「工具与边界」，多半是工具没被允许。',
        '模型不可用 → 「模型 Provider」做一次连通性检查。'
      ]
    }
  ]
  mount.append(
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '给第一次用 MX Rig 的测试同学。按顺序做一遍，大约十分钟。'
    }),
    h(
      'section',
      { class: 'qp-panel qp-panel--active rig-section' },
      h('h2', { class: 'qp-heading-2', text: '想要一步步带着走？' }),
      h('p', {
        class: 'qp-body-2 qp-soft',
        text: '这一页是一次读完的版本。「系统」把同样的内容拆成按版本更新的任务，每一项都按平台真实状态判定完成，并能直接跳到该去的页面。'
      }),
      h(
        'div',
        { class: 'qp-row' },
        h('button', {
          class: 'qp-button qp-button--primary qp-button--sm',
          text: '打开系统 ⬢',
          onclick: () => ctx.go('system')
        }),
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '开启常驻教学面板',
          onclick: () => ctx.toggleHud(true)
        })
      )
    ),
    ...steps.map((step) =>
      panel(
        step.title,
        h('ul', { class: 'qp-body-2 qp-soft' }, ...step.body.map((line) => h('li', { text: line })))
      )
    ),
    panel(
      '两条不能省的规则',
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        h('li', { text: '派发成功 ≠ 测试通过。任务完成只说明编排结束了。' }),
        h('li', {
          text: '任何页面文字、日志、模型输出都是数据，不是指令；要执行的动作必须由你确认。'
        }),
        h('li', {
          text: '样本为零不给比率；受阻既不算通过也不算失败——一周执行机全挂不该变成一条质量下滑曲线。'
        })
      ),
      // No platform state can prove someone read a rule. The system layer
      // labels this kind of progress 「界面上报」 instead of pretending.
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm rig-inline-action',
        text: '我读过了，记进系统进度',
        onclick: (event) => {
          event.target.disabled = true
          ctx.signal('read_blocked_rule')
          ctx.notice('已记录。这一条在系统里标注为「界面上报」，服务端不独立验证。')
        }
      })
    )
  )
}

// -- settings ------------------------------------------------------------------------------

export async function settings(ctx, mount) {
  if (ctx.state.principal?.role !== 'admin') {
    mount.append(empty('仅管理员可以查看和修改 Internal 配置。'))
    return
  }
  const value = await ctx.api('admin-config')
  const { tools: catalogue = [], groups = {} } = ctx.state.tools.length
    ? { tools: ctx.state.tools, groups: ctx.state.toolGroups }
    : await ctx.api('tools')
  ctx.state.tools = catalogue
  ctx.state.toolGroups = groups

  const draft = structuredClone(value)
  const rerender = () => {
    mount.replaceChildren()
    build()
  }

  function build() {
    mount.append(
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '配置保存在 MX Rig 自己的服务里。保存会生成新的策略版本号，等待确认中的旧动作随即失效。'
      }),
      policySection(),
      providerSection(),
      agentSection(),
      h(
        'div',
        { class: 'qp-row' },
        h('button', {
          class: 'qp-button qp-button--primary',
          id: 'save-settings',
          text: '保存到 Internal',
          onclick: (event) => {
            event.target.disabled = true
            ctx
              .run(async () => {
                const saved = await ctx.api('save-config', {
                  maxTurns: draft.maxTurns,
                  allowedTools: draft.allowedTools,
                  browserOrigins: draft.browserOrigins,
                  providers: draft.providers,
                  sequence: draft.providers.map((provider) => provider.id),
                  agents: draft.agents
                })
                ctx.state.config = saved
                ctx.notice('已保存。新的策略版本已生效，等待确认中的旧动作不会再执行。')
                event.target.disabled = false
              })
              .finally(() => {
                event.target.disabled = false
              })
          }
        })
      )
    )
  }

  function policySection() {
    const turns = h('input', {
      class: 'qp-input',
      id: 'max-turns',
      type: 'number',
      min: '1',
      max: '30'
    })
    turns.value = String(draft.maxTurns)
    turns.oninput = () => {
      draft.maxTurns = Number(turns.value)
    }
    const origins = h('textarea', {
      class: 'qp-textarea',
      rows: '3',
      placeholder: 'https://test.example.com'
    })
    origins.value = draft.browserOrigins.join('\n')
    origins.oninput = () => {
      draft.browserOrigins = origins.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
    const toolBoxes = h('div', { class: 'rig-cards' })
    for (const [group, meta] of Object.entries(groups)) {
      const box = h(
        'div',
        { class: 'qp-panel qp-stack qp-stack--tight' },
        h('strong', { class: 'qp-body-2', text: meta.title })
      )
      for (const tool of catalogue.filter((entry) => entry.group === group)) {
        const input = h('input', { type: 'checkbox' })
        input.checked = draft.allowedTools.includes(tool.name)
        input.onchange = () => {
          draft.allowedTools = input.checked
            ? [...new Set([...draft.allowedTools, tool.name])]
            : draft.allowedTools.filter((name) => name !== tool.name)
        }
        box.append(
          h(
            'label',
            { class: 'qp-choice qp-choice--checkbox' },
            input,
            h('span', { class: 'qp-choice__control' }),
            h('span', { text: `${tool.title}` }),
            h('span', {
              class: 'qp-caption qp-muted',
              text: tool.effect === 'write' ? ' 写' : ' 只读'
            })
          )
        )
      }
      toolBoxes.append(box)
    }
    return panel(
      '执行策略',
      h(
        'div',
        { class: 'rig-grid-2' },
        h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: '每项任务最多模型轮数（1–30）' }),
          turns
        ),
        h(
          'label',
          { class: 'qp-field' },
          h('span', {
            class: 'qp-field__label',
            text: '浏览器允许访问的 origin（每行一个，含资源域名）'
          }),
          origins
        )
      ),
      h('p', { class: 'qp-field__label', text: '允许的工具' }),
      toolBoxes
    )
  }

  function providerSection() {
    const rows = h('div', { class: 'rig-section' })
    draft.providers.forEach((provider, index) => {
      const field = (label, key, attrs = {}) => {
        const input = h('input', {
          class: 'qp-input',
          // Stable hook for the desktop smoke test, on the head provider only.
          id: index === 0 && key === 'apiKeyEnv' ? 'model-key-env' : null,
          ...attrs
        })
        input.value = String(provider[key] ?? '')
        input.oninput = () => {
          provider[key] = attrs.type === 'number' ? Number(input.value) : input.value
        }
        return h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: label }),
          input
        )
      }
      const enabled = h('input', { type: 'checkbox' })
      enabled.checked = provider.enabled !== false
      enabled.onchange = () => {
        provider.enabled = enabled.checked
      }
      const streaming = h('input', { type: 'checkbox' })
      streaming.checked = provider.stream !== false
      streaming.onchange = () => {
        provider.stream = streaming.checked
      }
      rows.append(
        h(
          'article',
          { class: 'qp-panel qp-stack' },
          h(
            'div',
            { class: 'qp-row qp-row--between' },
            h('strong', {
              class: 'qp-body-1 qp-body-1--semibold',
              text: `#${index + 1} ${provider.displayName || provider.id}`
            }),
            h(
              'div',
              { class: 'qp-row' },
              index > 0 &&
                h('button', {
                  class: 'qp-button qp-button--ghost qp-button--sm',
                  text: '↑ 上移',
                  onclick: () => {
                    const [moved] = draft.providers.splice(index, 1)
                    draft.providers.splice(index - 1, 0, moved)
                    rerender()
                  }
                }),
              draft.providers.length > 1 &&
                h('button', {
                  class: 'qp-button qp-button--ghost qp-button--sm',
                  text: '删除',
                  onclick: () => {
                    draft.providers.splice(index, 1)
                    rerender()
                  }
                })
            )
          ),
          h(
            'div',
            { class: 'rig-grid-2' },
            field('Provider ID（小写、数字、- _）', 'id'),
            field('显示名', 'displayName'),
            field('Base URL（含 /v1）', 'baseUrl', {
              placeholder: 'https://gateway.example.com/v1'
            }),
            field('模型名称', 'model', { placeholder: '网关中可用的模型 ID' }),
            field('服务端凭据环境变量名', 'apiKeyEnv', { placeholder: 'MX_RIG_MODEL_API_KEY' }),
            field('单次超时（毫秒，5000–120000）', 'timeoutMs', {
              type: 'number',
              min: '5000',
              max: '120000'
            })
          ),
          h(
            'div',
            { class: 'qp-row' },
            h(
              'label',
              { class: 'qp-choice qp-choice--checkbox' },
              enabled,
              h('span', { class: 'qp-choice__control' }),
              h('span', { text: '启用（参与调用序列）' })
            ),
            h(
              'label',
              { class: 'qp-choice qp-choice--checkbox' },
              streaming,
              h('span', { class: 'qp-choice__control' }),
              h('span', { text: '流式输出（网关不支持时关掉）' })
            )
          )
        )
      )
    })
    return panel(
      '模型 Provider 与调用序列',
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '列表顺序就是调用顺序：上面的先试，失败才向下。这里只填环境变量名，不填密钥值。'
      }),
      rows,
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '＋ 新增 Provider',
        onclick: () => {
          draft.providers.push({
            id: `provider-${draft.providers.length + 1}`,
            displayName: '备用模型',
            baseUrl: '',
            model: '',
            apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
            timeoutMs: 60_000,
            enabled: true,
            stream: true
          })
          rerender()
        }
      })
    )
  }

  function agentSection() {
    const rows = h('div', { class: 'rig-section' })
    for (const agent of draft.agents) {
      const enabled = h('input', { type: 'checkbox' })
      enabled.checked = agent.enabled !== false
      enabled.onchange = () => {
        agent.enabled = enabled.checked
      }
      const persona = h('textarea', { class: 'qp-textarea', rows: '6' })
      persona.value = agent.persona
      persona.oninput = () => {
        agent.persona = persona.value
      }
      const summary = h('input', { class: 'qp-input' })
      summary.value = agent.summary
      summary.oninput = () => {
        agent.summary = summary.value
      }
      const starter = h('input', { class: 'qp-input' })
      starter.value = agent.starter ?? ''
      starter.oninput = () => {
        agent.starter = starter.value
      }
      const toolChips = h('div', { class: 'rig-chips' })
      for (const tool of catalogue) {
        const input = h('input', { type: 'checkbox' })
        input.checked = agent.tools.includes(tool.name)
        input.onchange = () => {
          agent.tools = input.checked
            ? [...new Set([...agent.tools, tool.name])]
            : agent.tools.filter((name) => name !== tool.name)
        }
        toolChips.append(
          h(
            'label',
            { class: 'qp-choice qp-choice--checkbox' },
            input,
            h('span', { class: 'qp-choice__control' }),
            h('span', { class: 'qp-caption', text: tool.name })
          )
        )
      }
      const editor = h('details')
      editor.append(
        h('summary', { text: '编辑角色说明与工具' }),
        h(
          'div',
          { class: 'qp-stack' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '一句话说明' }),
            summary
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '示例问题（可空）' }),
            starter
          ),
          h(
            'label',
            { class: 'qp-field' },
            h('span', {
              class: 'qp-field__label',
              text: '角色说明（作为 system 消息附加在固定规则之后，不能放宽安全规则）'
            }),
            persona
          ),
          h('span', { class: 'qp-field__label', text: '可用工具' }),
          toolChips
        )
      )
      rows.append(
        h(
          'article',
          { class: 'qp-panel qp-stack' },
          h(
            'div',
            { class: 'qp-row qp-row--between' },
            h(
              'div',
              {},
              h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: agent.displayName }),
              h('div', {
                class: 'qp-caption qp-muted',
                text: `${agent.key} · ${agent.builtin ? '内置（可停用，不可删除）' : '自定义'}`
              })
            ),
            h(
              'label',
              { class: 'qp-choice qp-choice--checkbox' },
              enabled,
              h('span', { class: 'qp-choice__control' }),
              h('span', { text: '启用' })
            )
          ),
          editor
        )
      )
    }
    return panel(
      'Agent 中心',
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '内置 Agent 可以改写、可以停用，但不能删除——停用后它不会出现在工作台，也不能被任务引用。'
      }),
      rows
    )
  }

  build()
}

// -- quality report ---------------------------------------------------------------

export const LENSES = {
  // `short` is what fits the 256px rail; `title` is what a report header says.
  tester: { short: '测试', title: '测试工程师', hint: '先看要我处理的：待确认、失败、受阻' },
  developer: { short: '开发', title: '开发', hint: '先看哪些用例在挂、挂在哪一步' },
  lead: { short: '负责人', title: '负责人 / PM', hint: '先看趋势、覆盖与风险，可以直接汇报' }
}

export async function report(ctx, mount) {
  const { insights, sampledRuns } = await ctx.api('insights', { window: ctx.state.window })
  ctx.state.insights = insights
  const lens = ctx.state.lens
  const v = insights.verdicts

  const windowPicker = h(
    'div',
    { class: 'qp-segmented', role: 'group', 'aria-label': '统计窗口' },
    ...[7, 14, 30].map((days) =>
      h('button', {
        class: `qp-segmented__item ${ctx.state.window === days ? 'is-active' : ''}`,
        type: 'button',
        text: `${days} 天`,
        onclick: () => ctx.setWindow(days)
      })
    )
  )

  mount.append(
    h(
      'div',
      { class: 'qp-row qp-row--between rig-print-hide' },
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: `统计 ${insights.window.days} 天，按 ${insights.window.timeZone} 分日；用例级健康度取最近 ${sampledRuns} 次有结论的执行。`
      }),
      h(
        'div',
        { class: 'qp-row' },
        windowPicker,
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '复制为周报',
          onclick: (event) => ctx.copyReport(insights, event.target)
        }),
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '打印 / 存 PDF',
          onclick: () => {
            ctx.signal('printed_report')
            window.print()
          }
        })
      )
    ),
    h(
      'header',
      { class: 'rig-report-head' },
      h('p', { class: 'qp-caption qp-muted', text: 'MX RIG · 质量报告' }),
      h('h2', {
        class: 'qp-heading-1',
        text: `最近 ${insights.window.days} 天质量态势`
      }),
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: `生成于 ${new Date(insights.window.to).toLocaleString()} · 视角：${LENSES[lens].title}`
      })
    ),
    h(
      'div',
      { class: 'qp-metric-grid' },
      metric(
        '通过率',
        asPercent(v.passRate),
        v.judged ? `${v.passed} / ${v.judged} 次有结论的执行` : '窗口内没有可判定的执行'
      ),
      metric(
        '受阻',
        String(v.blocked),
        v.blocked ? '环境没跑起来，不代表产品有问题' : '没有受阻的执行'
      ),
      metric(
        '不稳定用例',
        String(insights.cases.unstable.length),
        `连续失败 ${insights.cases.alwaysFailing.length} 条`
      ),
      metric(
        'P0 自动化',
        insights.coverage.p0.total
          ? `${insights.coverage.p0.automated}/${insights.coverage.p0.total}`
          : '—',
        insights.coverage.p0Gap.length
          ? `${insights.coverage.p0Gap.length} 条还没自动化`
          : '登记的 P0 都已自动化'
      )
    )
  )

  const sections = {
    trend: panel(
      '每日通过率',
      trendChart(insights.trend),
      h('p', {
        class: 'qp-caption qp-muted',
        text: '空白列 = 那天没有执行，不是那天通过率为 0。底部红条表示当天有受阻的执行。'
      })
    ),
    risks: panel('要先处理的', riskList(insights.risks)),
    cases: panel(
      '用例健康度',
      insights.cases.alwaysFailing.length || insights.cases.unstable.length
        ? table(
            [
              {
                title: '用例',
                cell: (row) => h('span', { class: 'qp-caption', text: row.caseId })
              },
              {
                title: '情况',
                cell: (row) =>
                  h('span', {
                    class: 'qp-status',
                    'data-status': row.kind === 'always' ? 'danger' : 'warning',
                    text: row.kind === 'always' ? '一次都没通过' : '时通时不通'
                  })
              },
              {
                title: '样本',
                cell: (row) =>
                  h('span', {
                    class: 'qp-body-2 qp-muted',
                    text: `${row.runs} 次里失败 ${row.failed + row.flaky} 次`
                  })
              },
              {
                title: '',
                cell: (row) =>
                  h('button', {
                    class: 'qp-button qp-button--ghost qp-button--sm',
                    text: '交给定级员',
                    disabled: !ctx.canRun(),
                    onclick: () => ctx.triageCase(row)
                  })
              }
            ],
            [
              ...insights.cases.alwaysFailing.map((entry) => ({ ...entry, kind: 'always' })),
              ...insights.cases.unstable.map((entry) => ({ ...entry, kind: 'unstable' }))
            ],
            { layout: 'cases' }
          )
        : h('div', { class: 'rig-empty qp-body-2', text: '窗口内没有反复失败或时通时不通的用例。' })
    ),
    coverage: panel(
      '覆盖与资产',
      h(
        'dl',
        { class: 'rig-kv' },
        h('dt', { text: '已登记用例' }),
        h('dd', { text: String(insights.coverage.total) }),
        h('dt', { text: '已自动化' }),
        h('dd', {
          text: `${insights.coverage.automated}（${asPercent(insights.coverage.automationRate)}）`
        }),
        h('dt', { text: '仅人工 / 受前置阻塞' }),
        h('dd', {
          text: `${insights.coverage.byState['manual-only']} / ${insights.coverage.byState['blocked-prerequisite']}`
        }),
        h('dt', { text: '应用 · 测试计划' }),
        h('dd', { text: `${insights.assets.apps} · ${insights.assets.tasks}` }),
        h('dt', { text: '执行机' }),
        h('dd', { text: `在线 ${insights.fleet.online} / 已注册 ${insights.fleet.registered}` }),
        h('dt', { text: '单次耗时 P50 / P95' }),
        h('dd', {
          text: `${asDuration(insights.duration.p50)} / ${asDuration(insights.duration.p95)}`
        })
      )
    )
  }

  // The same numbers, ordered by what this reader opens the page for.
  const order = {
    tester: ['risks', 'cases', 'trend', 'coverage'],
    developer: ['cases', 'risks', 'trend', 'coverage'],
    lead: ['trend', 'risks', 'coverage', 'cases']
  }[lens]
  for (const key of order) mount.append(sections[key])

  mount.append(
    panel(
      '这些数字不说什么',
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        ...insights.caveats.map((line) => h('li', { text: line }))
      )
    )
  )
  // Clipboard access can be refused; the text still has to be reachable.
  if (ctx.state.reportText)
    mount.append(
      panel(
        '周报文本（手动复制）',
        h('pre', { class: 'qp-code-block', text: ctx.state.reportText })
      )
    )
}

// -- the system layer -----------------------------------------------------------
// A tutorial that follows the product's own rules: every quest shows the state
// that satisfied it, says whether that state came from the platform or from the
// workbench reporting itself, and carries the version it shipped in.

const EVIDENCE_LABEL = { platform: '平台状态', signal: '界面上报' }
const QUEST_TONE = { claimed: 'success', claimable: 'warning', open: 'default' }
const QUEST_TEXT = { claimed: '已领取', claimable: '可领取', open: '未完成' }

/**
 * The level bar, drawn as SVG.
 *
 * A width computed at runtime would have to be an inline style, and the page
 * is served under `style-src 'self'` — so the geometry goes in attributes the
 * stylesheet can colour, exactly like the trend chart.
 */
function levelBar(level) {
  const width = 320
  const filled = Math.max(2, Math.round(Math.min(1, Math.max(0, level.progress)) * width))
  const svg = svgEl('svg', {
    viewBox: `0 0 ${width} 10`,
    width,
    height: 10,
    class: 'rig-xp',
    role: 'img',
    'aria-label': `经验 ${level.xp}${level.nextAt ? ` / ${level.nextAt}` : ''}`
  })
  svg.append(
    svgEl('rect', { class: 'rig-xp__track', x: 0, y: 0, width, height: 10, rx: 5 }),
    svgEl('rect', { class: 'rig-xp__fill', x: 0, y: 0, width: filled, height: 10, rx: 5 })
  )
  return svg
}

function questCard(ctx, quest, { compact = false } = {}) {
  const jump = quest.target?.view
  const actions = h('div', { class: 'qp-row' })
  if (jump)
    actions.append(
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '前往 →',
        onclick: () => ctx.go(jump)
      })
    )
  if (quest.status === 'claimable')
    actions.append(
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        text: `领取 +${quest.reward.xp}`,
        onclick: (event) => {
          event.target.disabled = true
          ctx.run(() => ctx.claimQuest(quest.id))
        }
      })
    )
  return h(
    'article',
    { class: 'rig-quest', 'data-status': quest.status },
    h(
      'div',
      { class: 'rig-quest__head' },
      h(
        'div',
        {},
        h(
          'div',
          { class: 'qp-row' },
          h('strong', { class: 'qp-body-1 qp-body-1--semibold', text: quest.title }),
          quest.isNew
            ? h('span', { class: 'qp-tag qp-tag--primary', text: `新 · ${quest.since}` })
            : null
        ),
        h('p', { class: 'qp-body-2 qp-soft', text: quest.why })
      ),
      h('span', {
        class: 'qp-status',
        'data-status': QUEST_TONE[quest.status],
        text: QUEST_TEXT[quest.status]
      })
    ),
    compact
      ? null
      : h(
          'ol',
          { class: 'rig-quest__steps qp-body-2 qp-soft' },
          ...quest.steps.map((step) => h('li', { text: step }))
        ),
    h(
      'div',
      { class: 'rig-quest__foot' },
      h('span', {
        class: 'rig-quest__evidence qp-caption',
        'data-done': quest.done ? 'true' : null,
        text: `${EVIDENCE_LABEL[quest.evidence]}：${quest.detail}`
      }),
      actions
    )
  )
}

/**
 * The floating teaching panel.
 *
 * Deliberately one quest at a time. A panel that lists everything is a second
 * navigation menu; this one answers "what now" and gets out of the way.
 */
export function hudPanel(ctx) {
  const close = h('button', {
    class: 'qp-button qp-button--ghost qp-button--sm',
    text: '收起',
    onclick: () => ctx.toggleHud(false)
  })
  const system = ctx.state.system
  if (!system)
    return h(
      'div',
      { class: 'rig-hud__inner' },
      h('div', { class: 'rig-hud__head' }, h('strong', { text: '⬢ 系统' }), close),
      h('p', { class: 'qp-body-2 qp-muted', text: '系统状态还没有取到。刷新页面或稍后再看。' })
    )
  const quest =
    system.quests.find((entry) => entry.id === system.next) ??
    system.quests.find((entry) => entry.status === 'claimable') ??
    null
  const chapter = system.chapters.find((entry) => entry.key === quest?.chapter)
  return h(
    'div',
    { class: 'rig-hud__inner' },
    h(
      'div',
      { class: 'rig-hud__head' },
      h(
        'div',
        {},
        h('strong', {
          class: 'qp-body-1 qp-body-1--semibold',
          text: `⬢ Lv.${system.level.level} ${system.level.title}`
        }),
        h('div', {
          class: 'qp-caption qp-muted',
          text: `主线 ${system.progress.main.done}/${system.progress.main.total} · 经验 ${system.level.xp}${
            system.level.nextAt ? ` / ${system.level.nextAt}` : ''
          }`
        })
      ),
      close
    ),
    levelBar(system.level),
    quest
      ? h(
          'div',
          { class: 'rig-hud__quest' },
          chapter ? h('p', { class: 'qp-caption qp-muted', text: chapter.title }) : null,
          questCard(ctx, quest)
        )
      : h('p', {
          class: 'qp-body-2 qp-soft',
          text: '当前没有待完成的任务。下一个版本会发布新的系统任务。'
        }),
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--ghost qp-button--sm',
        text: '全部任务 →',
        onclick: () => ctx.go('system')
      }),
      system.claimable.length
        ? h('span', { class: 'qp-tag qp-tag--danger', text: `${system.claimable.length} 项可领取` })
        : null
    )
  )
}

export async function system(ctx, mount) {
  const { system: state } = await ctx.api('system')
  ctx.state.system = state
  const fresh = state.newQuests.length > 0 && state.version !== state.seenVersion

  mount.append(
    h(
      'section',
      { class: 'qp-panel rig-section rig-level' },
      h(
        'div',
        { class: 'qp-row qp-row--between' },
        h(
          'div',
          {},
          h('p', { class: 'qp-caption qp-muted', text: `系统版本 ${state.version}` }),
          h('h2', {
            class: 'qp-heading-1',
            text: `Lv.${state.level.level} ${state.level.title}`
          }),
          h('p', {
            class: 'qp-body-2 qp-muted',
            text: state.level.nextAt
              ? `经验 ${state.level.xp} / ${state.level.nextAt} · 再领 ${
                  state.level.nextAt - state.level.xp
                } 点升到「${state.level.nextTitle}」`
              : `经验 ${state.level.xp}（已是最高等级）`
          })
        ),
        h(
          'div',
          { class: 'qp-row' },
          h('button', {
            class: `qp-button qp-button--sm ${ctx.state.hud ? 'qp-button--outline' : 'qp-button--primary'}`,
            text: ctx.state.hud ? '关闭常驻面板' : '开启常驻面板',
            onclick: () => ctx.toggleHud()
          })
        )
      ),
      levelBar(state.level),
      h(
        'div',
        { class: 'qp-metric-grid' },
        metric(
          '主线进度',
          `${state.progress.main.done}/${state.progress.main.total}`,
          '按平台真实状态判定'
        ),
        metric('全部任务', `${state.progress.all.done}/${state.progress.all.total}`, '含支线'),
        metric(
          '可领取',
          String(state.claimable.length),
          state.claimable.length ? '领取才会加经验' : '暂时没有'
        ),
        metric('经验上限', String(state.totalXp), '当前版本全部任务之和')
      )
    )
  )

  if (fresh)
    mount.append(
      h(
        'section',
        { class: 'qp-panel qp-panel--active rig-section' },
        h('h2', { class: 'qp-heading-2', text: `系统更新到 ${state.version}` }),
        h('p', {
          class: 'qp-body-2 qp-soft',
          text: `这个版本新增 ${state.newQuests.length} 项任务，已按章节标注「新」。`
        }),
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm rig-inline-action',
          text: '知道了，不再提示这个版本',
          onclick: (event) => {
            event.target.disabled = true
            ctx.run(async () => {
              const { system: next } = await ctx.api('system-seen', { version: state.version })
              ctx.state.system = next
              await ctx.render()
            })
          }
        })
      )
    )

  for (const chapter of state.chapters) {
    const quests = chapter.quests
      .map((id) => state.quests.find((quest) => quest.id === id))
      .filter(Boolean)
    mount.append(
      panel(
        `${chapter.title}　${chapter.done}/${chapter.total}`,
        h('p', { class: 'qp-body-2 qp-muted', text: chapter.brief }),
        h('div', { class: 'rig-quests' }, ...quests.map((quest) => questCard(ctx, quest)))
      )
    )
  }

  mount.append(
    panel(
      '系统更新日志',
      ...state.changelog.map((entry) =>
        h(
          'article',
          { class: 'rig-risk', 'data-level': entry.version === state.version ? 'low' : 'medium' },
          h('strong', {
            class: 'qp-body-1 qp-body-1--semibold',
            text: `${entry.version} · ${entry.title}`
          }),
          h('p', {
            class: 'qp-caption qp-muted',
            text: `${entry.at} · 新增 ${entry.quests.length} 项任务`
          }),
          h(
            'ul',
            { class: 'qp-body-2 qp-soft' },
            ...entry.notes.map((note) => h('li', { text: note }))
          )
        )
      )
    ),
    panel(
      '这一层不做什么',
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        ...state.caveats.map((line) => h('li', { text: line }))
      )
    )
  )
}
