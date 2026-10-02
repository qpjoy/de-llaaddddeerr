import { renderGraph } from './graph-view.js'
import { activityView, browserPane, live, stepLabel } from './activity.js'

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
  const workspace = h('div', { class: 'rig-workspace' }, left, right)
  mount.append(workspace)

  if (!selected) {
    const agents = (ctx.state.config?.agents ?? []).filter(
      (agent) => agent.surface !== 'terminal' && (agent.surface !== 'desktop' || ctx.state.native)
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
    : orchestrated && selected.inlineSpec
      ? h('p', {
          class: 'qp-caption qp-muted',
          text: `一次性飞行计划「${selected.inlineSpec.displayName}」（未保存），共 ${selected.inlineSpec.nodes.length} 步。`
        })
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

  const railPanel = panel(
    '编排位置',
    railBody,
    h('p', {
      class: 'qp-caption qp-muted',
      text: '高亮的是这项任务真实走过的节点。虚线是条件分支，带「暂停点」的节点必须由人确认。'
    })
  )
  const boundsPanel = panel(
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
      h('dt', { text: '浏览器站点' }),
      h('dd', {
        text:
          ctx.state.config?.policy.browserSites === 'list'
            ? `只允许列表内 ${ctx.state.config?.policy.browserOrigins.length ?? 0} 个`
            : `预先允许 ${ctx.state.config?.policy.browserOrigins.length ?? 0} 个，其他由发起人确认`
      })
    )
  )
  if (!selected) {
    right.append(railPanel, boundsPanel)
    return
  }
  // A mission's side panel, as tabs: the browser it drove (live, then a
  // replay), where it is in the graph, and what it was allowed.
  const touched = (selected.events ?? []).some(
    (event) => event.kind === 'tool_start' && /^(browser_|electron_launch)/.test(event.data?.tool ?? '')
  )
  // The browser tab comes forward when the mission starts using the browser,
  // unless the member picked a tab themselves.
  if (ctx.state.missionTab?.id !== selected.id)
    ctx.state.missionTab = { id: selected.id, tab: touched ? 'browser' : 'graph', chosen: false }
  else if (!ctx.state.missionTab.chosen && touched) ctx.state.missionTab.tab = 'browser'
  const tab = ctx.state.missionTab.tab
  // The browser needs room to be read; the conversation gives some up.
  if (tab === 'browser') workspace.classList.add('rig-workspace--browser')
  const TABS = [
    ['browser', '浏览器'],
    ['graph', '编排'],
    ['bounds', '边界']
  ]
  right.append(
    h(
      'div',
      { class: 'rig-side-tabs' },
      h(
        'div',
        { class: 'qp-segmented', role: 'tablist', 'aria-label': '任务侧栏' },
        ...TABS.map(([key, label]) =>
          h('button', {
            class: `qp-segmented__item ${tab === key ? 'is-active' : ''}`,
            role: 'tab',
            type: 'button',
            'aria-selected': String(tab === key),
            id: `mission-tab-${key}`,
            text: label,
            onclick: () => {
              ctx.state.missionTab = { id: selected.id, tab: key, chosen: true }
              ctx.render()
            }
          })
        )
      )
    ),
    tab === 'browser' ? panel(null, browserPane(ctx, selected)) : tab === 'graph' ? railPanel : boundsPanel
  )
}

// Labels for the structured conclusion. Mirrored from
// `packages/runtime/finding.mjs` the same way status words are: the workbench
// is served as plain files from apps/web and cannot import from packages/.
export const VERDICT_TEXT = {
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

const kilo = (value) => (value >= 10_000 ? `${(value / 1000).toFixed(1)}k` : String(value))

/** What the mission spent on the model; an estimate says so. */
function usageLine(usage) {
  return `模型用量：${usage.calls} 次调用 · 输入 ${kilo(usage.promptTokens)} / 输出 ${kilo(
    usage.completionTokens
  )} tokens${usage.estimated ? '（部分为按字数估算）' : ''}`
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
          text: `MISSION / ${row.id.slice(0, 8)} · ${
            row.mode === 'agent'
              ? 'AGENT'
              : row.mode === 'workflow'
                ? 'WORKFLOW'
                : row.flight
                  ? 'FLIGHT PLAN'
                  : 'ORCHESTRATION'
          }${row.agentKey ? ` · ${row.agentKey}` : ''}${row.surface === 'desktop' ? (row.client === 'terminal' ? ' · 终端执行' : ' · 桌面执行') : ''}`
        }),
        h('h2', { class: 'qp-heading-2', text: row.goal }),
        row.usage?.calls
          ? h('p', {
              class: 'qp-caption qp-muted',
              id: 'mission-usage',
              text: usageLine(row.usage)
            })
          : null
      ),
      statusTag(row.status, 'mission-status')
    )
  )
  if (row.finding) box.append(findingCard(row.finding))
  if (row.flight) box.append(flightPanel(ctx, row))
  // What was said and done, folded into steps (activity.js).
  box.append(panel(null, activityView(ctx, row)))
  if (row.stream?.text) ctx.signal?.('saw_stream')
  const exporter = exportPanel(ctx, row)
  if (exporter) box.append(exporter)
  const authoring = authoringPanel(ctx, row)
  if (authoring) box.append(authoring)

  // A desktop's record, synced for reading. Its browser and its checkpoint
  // are on that machine; approving or stopping it from here would have
  // nothing to act on.
  if (row.surface === 'desktop' && !ctx.state.native) {
    box.append(
      h('p', {
        class: 'qp-caption qp-muted',
        text:
          row.client === 'terminal'
            ? `这项任务在成员的 mx-rig 终端里执行，这里是同步来的只读记录${row.truncated ? '（较早的工具输出已省略）' : ''}。命令输出、改动的文件和对话都留在那台电脑的项目里。`
            : `这项任务在桌面端执行，这里是同步来的只读记录${row.truncated ? '（较早的工具输出已省略）' : ''}。确认、停止或继续请回到执行它的桌面端；截图与 trace 保存在那台电脑上。`
      })
    )
    return box
  }

  if (row.status === 'awaiting_approval' && row.pending) {
    const takeover = row.pending.name === 'takeover'
    // Handing back can carry a word for the Agent — here too, for a native
    // app or a window with no live pane. With the pane, it is asked there.
    const inPane = ctx.state.native && live.frame?.missionId === row.id
    const note = takeover && !inPane
      ? h('input', {
          class: 'qp-input',
          id: 'approval-note',
          placeholder: '交还时给 Agent 的一句话（可选，别写密码）',
          value: ctx.state.handbackNote ?? ''
        })
      : null
    note?.addEventListener('input', () => (ctx.state.handbackNote = note.value))
    const buttons = h('div', { class: 'qp-row' }, note)
    for (const [approved, label, cls] of takeover
      ? [
          [true, '交还给 Agent', 'qp-button qp-button--primary'],
          [false, '结束这一段', 'qp-button qp-button--ghost']
        ]
      : [
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
                approved,
                ...(approved && note?.value.trim() ? { note: note.value.trim() } : {})
              })
              if (note) ctx.state.handbackNote = ''
              await ctx.refresh()
            })
          }
        })
      )
    box.append(
      h(
        'div',
        { class: 'rig-approval', id: 'approval' },
        h('h3', {
          class: 'qp-heading-2',
          text: takeover ? (row.pending.by === 'agent' ? 'Agent 请你来操作' : '人工接管中') : '确认这一次操作'
        }),
        h('p', {
          class: 'qp-body-2',
          text: takeover
            ? `${row.pending.args?.说明 ?? '浏览器现在归你操作。'}${
                ctx.state.native ? '右侧「浏览器」画面可以直接点击和输入。' : ''
              }交还后 Agent 会先重新观察页面再继续；你输入的内容不会记录，也不会给 Agent。`
            : `${ctx.toolTitle(row.pending.name)} · 确认只对下面这组参数生效；策略变更后需要重新发起。${
                ctx.state.native && /^browser_/.test(row.pending.name) ? '浏览器里已经标出这一步要操作的元素。' : ''
              }`
        }),
        !takeover &&
          h('p', {
            class: 'qp-body-1 qp-body-1--semibold rig-approval__what',
            text: String(row.pending.preview ?? stepLabel(row.pending.name, row.pending.args)).split('\n')[0]
          }),
        // A site nobody has said yes to yet: this yes covers it for the mission.
        !takeover &&
          row.pending.site &&
          h('p', {
            class: 'qp-body-2 rig-warning-line',
            id: 'approval-site',
            text: `${row.pending.site} 是这项任务第一次去的站点：确认后，本任务里 Agent 可以在这个站点上操作，每一步仍然要确认。`
          }),
        !takeover &&
          h(
            'details',
            {},
            h('summary', { class: 'qp-caption qp-muted', text: '完整参数' }),
            h('pre', { class: 'qp-code-block', text: JSON.stringify(row.pending.args, null, 2) })
          ),
        buttons
      )
    )
  }
  // Takeover is a desktop affair: the browser it hands over is on this machine.
  if (row.status === 'running' && ctx.state.native && ['agent', 'orchestration'].includes(row.mode))
    box.append(
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '暂停并接管浏览器',
        onclick: () =>
          ctx.run(async () => {
            await ctx.api('takeover', { id: row.id })
            ctx.notice('已请求接管：Agent 会在当前这一步结束后暂停。')
            await ctx.refresh()
          })
      })
    )
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
  if (selected?.surface === 'desktop' && !ctx.state.native)
    return h('p', { class: 'qp-caption qp-muted', text: '桌面端任务只能在桌面端继续对话。' })
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
    h('option', { value: 'workflow', text: '测试工作流 · 无需模型' }),
    h('option', { value: 'flight', text: '飞行计划 · 一句话生成' })
  )
  mode.value = ctx.state.mode
  const start = h('button', {
    class: 'qp-button qp-button--primary',
    id: 'start',
    type: 'submit',
    text: selected ? '继续对话 ↑' : ctx.state.mode === 'flight' ? '生成飞行计划 ✈' : '开始任务 ↑',
    disabled: !['operator', 'admin'].includes(ctx.state.principal?.role)
  })
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
    start.textContent = mode.value === 'flight' ? '生成飞行计划 ✈' : '开始任务 ↑'
  }
  mode.hidden = Boolean(selected)

  // A member's own grant for this mission: offered only on the desktop (where
  // the browser is) and only when the admin allows grants at all.
  const grant = h('input', { type: 'checkbox', id: 'grant-browser' })
  grant.checked = Boolean(ctx.state.grantBrowser)
  grant.onchange = () => {
    ctx.state.grantBrowser = grant.checked
  }
  const grantable = !selected && ctx.state.native && ctx.state.config?.policy.browserPreauth
  const controls = h(
    'div',
    { class: 'rig-composer__controls' },
    mode,
    task,
    grantable &&
      h(
        'label',
        {
          class: 'qp-choice qp-choice--checkbox',
          title: '只覆盖浏览器写动作，且只在允许的测试 origin 内；策略变更即失效；可随时停止任务'
        },
        grant,
        h('span', { class: 'qp-choice__control' }),
        h('span', { text: '本任务内自动确认浏览器操作' })
      ),
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
    start
  )
  const form = h(
    'form',
    {
      class: 'rig-composer',
      onsubmit: (event) => {
        event.preventDefault()
        ctx.run(async () => {
          // A flight plan is drafted, shown, and only run once somebody says so.
          if (!selected && mode.value === 'flight') {
            if (!textarea.value.trim())
              return ctx.notice(
                '先写一句话，例如「冒烟 Compass 登录，通过后跑全量回归，结果发飞书」。'
              )
            const { draft } = await ctx.api('draft-flight-plan', {
              text: textarea.value.trim(),
              surface: ctx.state.native ? 'desktop' : 'web'
            })
            ctx.state.flightDraft = draft
            return ctx.render()
          }
          const body = selected
            ? { id: selected.id, goal: textarea.value }
            : {
                goal: textarea.value,
                mode: mode.value,
                ...(mode.value === 'workflow' ? { taskId: task.value } : {}),
                ...(mode.value === 'agent' && ctx.state.agentKey
                  ? { agentKey: ctx.state.agentKey }
                  : {}),
                ...(grantable && grant.checked && mode.value === 'agent'
                  ? { grants: { browserWrites: true } }
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
  const parsed = selected ? null : (flightDraftPanel(ctx) ?? proposalPanel(ctx))
  return parsed ? h('div', { class: 'rig-section' }, parsed, form) : form
}

const FLIGHT_VERDICT = {
  go: { label: 'GO · 放行', tone: 'success' },
  'no-go': { label: 'NO-GO · 不放行', tone: 'danger' },
  scrubbed: { label: 'SCRUB · 取消发射', tone: 'warning' }
}

/** One line per plan step, in the order a flight takes them. */
function planSteps(ctx, spec) {
  const vocab = ctx.state.flightVocab ?? { stages: {}, gateMetrics: {} }
  const byId = new Map(spec.nodes.map((node) => [node.id, node]))
  const ordered = []
  const seen = new Set()
  for (let id = spec.entry; id && !seen.has(id) && byId.has(id); id = byId.get(id).next) {
    seen.add(id)
    ordered.push(byId.get(id))
  }
  for (const node of spec.nodes) if (!seen.has(node.id)) ordered.push(node)
  const planName = (taskId) => ctx.state.tasks.find((task) => task.id === taskId)?.name ?? taskId
  const describe = (node) => {
    if (node.type === 'preflight') return `核对：${node.checks.join('、')}`
    if (node.type === 'flight')
      return `派发「${planName(node.taskId)}」，最长等 ${node.waitMinutes} 分钟`
    if (node.type === 'explore') return node.goal
    if (node.type === 'procedure')
      return `按原样重放 ${node.procedureIds.length} 条规程：${node.procedureIds
        .map(
          (id) =>
            ctx.state.procedureList?.find((entry) => entry.id === id)?.title ??
            ctx.state.flightDraft?.procedures?.find((entry) => entry.id === id)?.title ??
            id
        )
        .join('、')}`
    if (node.type === 'gate')
      return `${node.criteria
        .map(
          (c) =>
            `${vocab.gateMetrics[c.metric]?.label ?? c.metric}${c.value !== undefined ? ` ${c.value}` : ''}（${c.stage}）`
        )
        .join('；')}${node.confirm ? '；需人工放行' : ''}`
    if (node.type === 'debrief') return node.notify ? '生成报告并推送通知' : '生成报告'
    return node.message ?? node.instruction ?? ''
  }
  return h(
    'ol',
    { class: 'rig-plan' },
    ...ordered.map((node) =>
      h(
        'li',
        { class: 'rig-plan__step', 'data-type': node.type },
        h(
          'div',
          { class: 'qp-row qp-row--between' },
          h('strong', {
            class: 'qp-body-2',
            text: `${NODE_GLYPH[ctx.state.nodeTypes[node.type]?.kind] ?? '·'} ${node.title}`
          }),
          node.stage && h('span', { class: 'qp-tag', text: vocab.stages[node.stage] ?? node.stage })
        ),
        h('p', { class: 'qp-caption qp-muted rig-wrap', text: describe(node) })
      )
    )
  )
}

/** A drafted flight plan, for review. Nothing here runs until a button says so. */
function flightDraftPanel(ctx) {
  const draft = ctx.state.flightDraft
  if (!draft) return null
  const spec = draft.spec
  const admin = ctx.state.principal?.role === 'admin'
  return panel(
    `飞行计划草稿：${spec.displayName}`,
    h(
      'div',
      { class: 'qp-row' },
      h('span', {
        class: 'qp-tag qp-tag--primary',
        text: draft.source === 'model' ? '模型草稿 · 已校验' : '模板草稿 · 未使用模型'
      }),
      h('span', { class: 'qp-caption qp-muted', text: spec.summary })
    ),
    draft.warnings?.length
      ? h(
          'ul',
          { class: 'qp-body-2 rig-warnings' },
          ...draft.warnings.map((line) => h('li', { text: line }))
        )
      : null,
    planSteps(ctx, spec),
    draft.graph &&
      h('div', { class: 'rig-graph rig-graph--compact' }, renderGraph(draft.graph, {})),
    h(
      'details',
      {},
      h('summary', { text: '查看计划原文（JSON）' }),
      h('pre', { class: 'qp-code-block', text: JSON.stringify(spec, null, 2) })
    ),
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--primary',
        text: '运行一次 ✈',
        disabled: !ctx.canRun(),
        onclick: () =>
          ctx.run(async () => {
            const { mission } = await ctx.api('start', {
              mode: 'orchestration',
              goal: spec.displayName,
              spec,
              ...(ctx.state.native &&
              ctx.state.grantBrowser &&
              ctx.state.config?.policy.browserPreauth
                ? { grants: { browserWrites: true } }
                : {})
            })
            ctx.state.flightDraft = null
            ctx.state.draft = ''
            ctx.state.selected = mission.id
            await ctx.refresh()
          })
      }),
      admin &&
        h('button', {
          class: 'qp-button qp-button--outline',
          text: '保存为编排',
          onclick: () =>
            ctx.run(async () => {
              const config = await ctx.api('admin-config')
              await ctx.api('save-config', {
                ...config,
                orchestrations: [...(config.orchestrations ?? []), spec]
              })
              ctx.state.flightDraft = null
              ctx.notice(
                `已保存为编排「${spec.displayName}」（${spec.key}）。可以在编排中心修改、预授权派发或设置定时。`
              )
              await ctx.render()
            })
        }),
      h('button', {
        class: 'qp-button qp-button--ghost',
        text: '丢弃',
        onclick: () => {
          ctx.state.flightDraft = null
          ctx.render()
        }
      })
    ),
    h('p', {
      class: 'qp-caption qp-muted',
      text: '一次性运行的草稿不带任何预授权：派发仍逐次确认。放行结论只由预检与放行标准判定。'
    })
  )
}

/** Save text as a file, from both the browser and the desktop renderer. */
function download(filename, text, type = 'text/plain') {
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }))
  const link = h('a', { href: url, download: filename })
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

async function copyText(ctx, text) {
  try {
    await navigator.clipboard.writeText(text)
    ctx.notice('已复制到剪贴板。')
  } catch {
    ctx.notice('剪贴板不可用，请从页面上的文本手动复制。')
  }
}

/** Verdict, stages, gates and the report of a flight-plan mission. */
function flightPanel(ctx, row) {
  const flight = row.flight
  const vocab = ctx.state.flightVocab ?? { stages: {} }
  const verdict = FLIGHT_VERDICT[flight.verdict] ?? { label: '未设放行标准', tone: 'default' }
  const stages = Object.entries(flight.stages ?? {})
  const describe = (stage) => {
    if (stage.type === 'preflight')
      return stage.go
        ? 'Go'
        : `No-Go：${(stage.checks ?? [])
            .filter((c) => !c.ok)
            .map((c) => c.detail)
            .join('；')}`
    if (stage.type === 'flight') {
      const c = stage.counts ?? {}
      return `${stage.status ?? '—'} · Run ${stage.runId ?? '—'} · 通过 ${c.passed ?? 0} / 失败 ${c.failed ?? 0} / 共 ${c.total ?? 0}${stage.note ? ` · ${stage.note}` : ''}`
    }
    if (stage.type === 'explore')
      return `断言 ${(stage.assertions ?? 0) - (stage.failedAssertions ?? 0)}/${stage.assertions ?? 0} 通过${stage.summary ? ` · ${stage.summary}` : ''}`
    if (stage.type === 'procedure') {
      const c = stage.counts ?? {}
      const misses = (stage.results ?? [])
        .filter((entry) => entry.verdict !== 'passed')
        .map(
          (entry) =>
            `「${entry.title}」${entry.verdict === 'blocked' ? '受阻' : `第 ${entry.failedStep + 1} 步失败`}`
        )
      return `规程 ${c.passed ?? 0}/${c.total ?? 0} 通过${misses.length ? ` · ${misses.join('；')}` : ''}`
    }
    return ''
  }
  const body = [
    h(
      'div',
      { class: 'qp-row qp-row--between' },
      h('p', { class: 'qp-caption qp-muted', text: 'FLIGHT · 结论只由预检与放行标准判定' }),
      h('span', { class: 'qp-status', 'data-status': verdict.tone, text: verdict.label })
    ),
    stages.length &&
      h(
        'dl',
        { class: 'rig-kv' },
        ...stages.flatMap(([id, stage]) => [
          h('dt', {
            text: `${stage.title ?? id}${
              stage.stage && (vocab.stages[stage.stage] ?? stage.stage) !== stage.title
                ? ` · ${vocab.stages[stage.stage] ?? stage.stage}`
                : ''
            }`
          }),
          h('dd', { class: 'rig-wrap', text: describe(stage) })
        ])
      ),
    ...Object.entries(flight.gates ?? {}).map(([id, gate]) =>
      h(
        'div',
        { class: 'rig-gate', 'data-passed': String(gate.passed && gate.approved !== false) },
        h('strong', {
          class: 'qp-body-2',
          text: `⛳ ${gate.title ?? id}：${gate.passed ? '达标' : '未达标'}${gate.approved === false ? '（人工 No-Go）' : gate.approved === true ? '（人工放行）' : ''}`
        }),
        h(
          'ul',
          { class: 'qp-caption' },
          ...(gate.results ?? []).map((result) =>
            h('li', {
              text: `${result.ok ? '✅' : '❌'} ${result.label}${result.value !== undefined ? ` ${result.value}` : ''}：实际 ${result.actual}`
            })
          )
        )
      )
    )
  ]
  if (row.report?.markdown)
    body.push(
      h(
        'details',
        {},
        h('summary', { text: '飞行报告（Markdown）' }),
        h('pre', { class: 'qp-code-block', text: row.report.markdown })
      ),
      h(
        'div',
        { class: 'qp-row' },
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '复制报告',
          onclick: () => copyText(ctx, row.report.markdown)
        }),
        h('button', {
          class: 'qp-button qp-button--ghost qp-button--sm',
          text: '下载 .md',
          onclick: () =>
            download(`flight-report-${row.id.slice(0, 8)}.md`, row.report.markdown, 'text/markdown')
        })
      )
    )
  return panel(null, ...body.filter(Boolean))
}

/** Offer the exploration → script export when the mission has browser steps. */
function exportPanel(ctx, row) {
  const hasSteps = (row.events ?? []).some(
    (event) => event.data?.action || event.data?.result?.action || event.kind === 'assertion'
  )
  if (!hasSteps) return null
  const output = h('div', { class: 'rig-section' })
  return h(
    'div',
    { class: 'rig-section' },
    h('button', {
      class: 'qp-button qp-button--outline qp-button--sm',
      text: '导出 Playwright 用例草稿',
      onclick: () =>
        ctx.run(async () => {
          const { export: spec } = await ctx.api('export', { id: row.id })
          output.replaceChildren(
            ...spec.warnings.map((line) =>
              h('p', { class: 'qp-caption rig-warning-line', text: line })
            ),
            h('pre', { class: 'qp-code-block', text: spec.content }),
            h(
              'div',
              { class: 'qp-row' },
              h('button', {
                class: 'qp-button qp-button--outline qp-button--sm',
                text: '复制',
                onclick: () => copyText(ctx, spec.content)
              }),
              h('button', {
                class: 'qp-button qp-button--ghost qp-button--sm',
                text: `下载 ${spec.filename}`,
                onclick: () => download(spec.filename, spec.content, 'text/typescript')
              })
            ),
            h('p', {
              class: 'qp-caption qp-muted',
              text: `共 ${spec.steps} 步。这是草稿：审阅定位方式、测试数据和断言后，再提交到测试包并登记用例目录。`
            })
          )
        })
    }),
    output
  )
}

// -- tests ---------------------------------------------------------------------

export async function tests(ctx, mount) {
  const [{ tasks = [] }, { runs = [] }, { apps = [] }] = await Promise.all([
    ctx.api('tasks'),
    ctx.api('runs'),
    ctx.api('apps').catch(() => ({ apps: [] }))
  ])
  ctx.state.tasks = tasks
  // Each app's case catalogue, as the full test-management console lists it:
  // what is to be verified, whether code implements it, how it last went.
  const catalogues = await Promise.all(
    apps.map((app) =>
      ctx
        .api('app-cases', { app: app.slug })
        .then(({ cases = [] }) => ({ app, cases }))
        .catch((error) => ({ app, cases: [], error: error.message }))
    )
  )
  const casesOf = new Map(catalogues.map((entry) => [entry.app.slug, entry.cases]))
  if (ctx.state.native && ['operator', 'admin'].includes(ctx.state.principal?.role))
    mount.append(await localRunnerPanel(ctx))
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
                  ),
                  h('span', { class: 'rig-chip', text: caseCount(casesOf.get(app.slug) ?? []) })
                )
              )
            )
          )
        : empty(
            '还没有接入应用。到完整测试管理台用「接入 / 对齐 Compass」登记 Web 与 Electron 两个 surface。'
          )
    ),
    casesPanel(ctx, catalogues),
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

const caseCount = (cases) => {
  const pending = cases.filter((entry) => !entry.implemented).length
  return `用例 ${cases.length} 条${pending ? `，${pending} 条待实现` : ''}`
}

/**
 * The case catalogue of every app. Read here; written in the full
 * test-management console (or drafted by an Agent and imported there).
 */
function casesPanel(ctx, catalogues) {
  const edit = h('button', {
    class: 'qp-button qp-button--ghost qp-button--sm',
    type: 'button',
    text: '在完整测试管理台写用例 ↗',
    onclick: () => ctx.openPath('/test-center/')
  })
  const withCases = catalogues.filter((entry) => entry.cases.length || entry.error)
  if (!withCases.length)
    return panel(
      '用例',
      empty(
        catalogues.length
          ? '还没有用例。到完整测试管理台的「应用与用例」写一条，或者让 Agent 用 case_draft 起草后导入。'
          : '还没有接入应用，所以也还没有用例。'
      ),
      edit
    )
  return panel(
    '用例',
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '每个应用要验证什么。「已实现」表示代码仓库里有对应的测试代码；没有实现的用例在报告里显示「未执行」。'
    }),
    ...withCases.map(({ app, cases, error }) =>
      h(
        'section',
        { class: 'rig-section', 'data-app': app.slug },
        h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: `${app.displayName || app.slug} · ${caseCount(cases)}` }),
        error
          ? h('p', { class: 'qp-body-2 rig-warning-line', text: `读不到用例：${error}` })
          : table(
              [
                { title: '编号', cell: (entry) => h('code', { class: 'qp-caption', text: entry.caseId }) },
                { title: '标题', cell: (entry) => h('span', { class: 'qp-body-2', text: entry.title }) },
                { title: '优先级', cell: (entry) => h('span', { class: 'qp-body-2', text: entry.priority ?? '—' }) },
                {
                  title: '实现',
                  cell: (entry) =>
                    h('span', {
                      class: `qp-tag ${entry.implemented ? 'qp-tag--success' : 'qp-tag--warning'}`,
                      text: entry.implemented ? '已实现' : '待实现'
                    })
                },
                {
                  title: '最近结果',
                  cell: (entry) =>
                    entry.lastRunId
                      ? h(
                          'button',
                          {
                            class: 'qp-button qp-button--ghost qp-button--sm',
                            type: 'button',
                            title: `执行 ${entry.lastRunId} 的报告`,
                            onclick: () => ctx.openPath(`/api/v1/runs/${entry.lastRunId}/report`)
                          },
                          statusTag(entry.lastStatus)
                        )
                      : h('span', { class: 'qp-body-2 qp-muted', text: '—' })
                },
                {
                  title: '来源',
                  cell: (entry) =>
                    h('span', { class: 'qp-body-2 qp-muted', text: entry.origin === 'platform' ? '界面登记' : '代码仓库' })
                }
              ],
              cases,
              { layout: 'case-catalog' }
            )
      )
    ),
    edit
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
    agent.surface === 'terminal' &&
      h('span', {
        class: 'qp-status',
        'data-status': 'info',
        text: '仅 mx-rig 终端可用：在项目目录里运行 mx-rig'
      }),
    persona,
    h(
      'div',
      { class: 'qp-row' },
      h('button', {
        class: 'qp-button qp-button--outline qp-button--sm',
        text: '用这个 Agent 开始',
        disabled:
          agent.effectiveTools.length === 0 ||
          agent.surface === 'terminal' ||
          (agent.surface === 'desktop' && !ctx.state.native),
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
  gate: '⛳',
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
  finish: () => ({ id: '', title: '结束', type: 'finish', message: '编排结束。' }),
  preflight: () => ({
    id: '',
    title: 'T-minus 预检',
    type: 'preflight',
    stage: 'tminus',
    taskIds: [],
    checks: ['runners', 'production'],
    onNoGo: null,
    next: null
  }),
  flight: () => ({
    id: '',
    title: '新架次',
    type: 'flight',
    stage: 'static-fire',
    taskId: '',
    waitMinutes: 30,
    next: null
  }),
  explore: () => ({
    id: '',
    title: '新探索',
    type: 'explore',
    stage: 'flight',
    goal: '按页面检查……，每个检查点用 browser_assert 记录。',
    maxTurns: 8,
    next: null
  }),
  procedure: () => ({
    id: '',
    title: '规程试车',
    type: 'procedure',
    stage: 'static-fire',
    procedureIds: [],
    next: null
  }),
  gate: () => ({
    id: '',
    title: '放行评审',
    type: 'gate',
    criteria: [],
    confirm: false,
    onFail: null,
    next: null
  }),
  debrief: () => ({
    id: '',
    title: 'Debrief 讲评',
    type: 'debrief',
    stage: 'debrief',
    notify: false,
    next: null
  })
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
  ctx.state.procedureList = (
    await ctx.api('procedures').catch(() => ({ procedures: [] }))
  ).procedures
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
              if (other.onNoGo === node.id) other.onNoGo = null
              if (other.onFail === node.id) other.onFail = null
              if (other.criteria)
                other.criteria = other.criteria.filter((criterion) => criterion.stage !== node.id)
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
              if (other.onNoGo === previous) other.onNoGo = value
              if (other.onFail === previous) other.onFail = value
              for (const criterion of other.criteria ?? [])
                if (criterion.stage === previous) criterion.stage = value
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
    const vocab = ctx.state.flightVocab ?? { stages: {}, gateMetrics: {}, preflightChecks: {} }
    const nextField = (label = '下一步') =>
      h(
        'label',
        { class: 'qp-field' },
        h('span', { class: 'qp-field__label', text: label }),
        select(node.next, targets(), (value) => {
          node.next = value
        })
      )
    const numberField = (label, value, min, max, onChange) => {
      const control = h('input', {
        class: 'qp-input',
        type: 'number',
        min: String(min),
        max: String(max)
      })
      control.value = String(value)
      control.oninput = () => {
        const parsed = Number(control.value)
        if (Number.isInteger(parsed)) onChange(parsed)
      }
      return h(
        'label',
        { class: 'qp-field' },
        h('span', { class: 'qp-field__label', text: label }),
        control
      )
    }
    const checkbox = (label, checked, onChange) => {
      const box = h('input', { type: 'checkbox' })
      box.checked = Boolean(checked)
      box.onchange = () => onChange(box.checked)
      return h(
        'label',
        { class: 'qp-choice qp-choice--checkbox' },
        box,
        h('span', { class: 'qp-choice__control' }),
        h('span', { text: label })
      )
    }
    const planOptions = () =>
      (ctx.state.tasks ?? []).map((task) => ({
        value: task.id,
        label: `${task.name}（${task.id}）`
      }))
    if (['preflight', 'flight', 'procedure', 'explore', 'gate', 'debrief'].includes(node.type))
      fields.push(
        h(
          'label',
          { class: 'qp-field' },
          h('span', { class: 'qp-field__label', text: '阶段（只用于分组与报告）' }),
          select(
            node.stage ?? '',
            [
              { value: '', label: '（不标注）' },
              ...Object.entries(vocab.stages).map(([value, label]) => ({ value, label }))
            ],
            (value) => {
              if (value) node.stage = value
              else delete node.stage
            }
          )
        )
      )
    if (node.type === 'preflight')
      fields.push(
        textField(
          '要核对的测试计划 ID（逗号分隔，可用 {{变量名}}）',
          node.taskIds.join(', '),
          (value) => {
            node.taskIds = value
              .split(/[,，\s]+/)
              .map((entry) => entry.trim())
              .filter(Boolean)
          }
        ),
        h(
          'div',
          { class: 'rig-chips' },
          ...Object.entries(vocab.preflightChecks).map(([check, label]) =>
            checkbox(label, node.checks.includes(check), (on) => {
              node.checks = on
                ? [...new Set([...node.checks, check])]
                : node.checks.filter((entry) => entry !== check)
            })
          )
        ),
        h(
          'div',
          { class: 'rig-grid-2' },
          nextField('Go 之后'),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: 'No-Go 时' }),
            select(
              node.onNoGo,
              [{ value: '', label: '→ 取消发射（Scrub）' }, ...targets().slice(1)],
              (value) => {
                node.onNoGo = value
              }
            )
          )
        )
      )
    if (node.type === 'flight')
      fields.push(
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '测试计划' }),
            select(
              planOptions().some((option) => option.value === node.taskId) ? node.taskId : '',
              [{ value: '', label: '（选择，或在右侧填模板）' }, ...planOptions()],
              (value) => {
                if (value) {
                  node.taskId = value
                  rerender()
                }
              }
            )
          ),
          textField('计划 ID 或 {{变量名}}', node.taskId, (value) => {
            node.taskId = value.trim()
          })
        ),
        h(
          'div',
          { class: 'rig-grid-2' },
          numberField('最长等待（分钟）', node.waitMinutes, 1, 180, (value) => {
            node.waitMinutes = value
          }),
          nextField()
        ),
        h('span', {
          class: 'qp-field__hint',
          text: `结果会存成变量：${node.id || '<ID>'}_run、_status、_passed、_failed、_flaky、_skipped、_total。`
        })
      )
    if (node.type === 'procedure') {
      const available = (ctx.state.procedureList ?? []).filter(
        (entry) => entry.status !== 'retired' || node.procedureIds.includes(entry.id)
      )
      fields.push(
        h('p', { class: 'qp-field__label', text: '要重放的规程（按勾选顺序执行）' }),
        available.length
          ? h(
              'div',
              { class: 'qp-stack qp-stack--tight' },
              ...available.map((entry) =>
                checkbox(
                  `${entry.title}${entry.caseId ? ` · ${entry.caseId}` : ''}${entry.status === 'active' ? '' : `（${entry.status === 'draft' ? '草稿' : '已停用'}）`}`,
                  node.procedureIds.includes(entry.id),
                  (checked) => {
                    node.procedureIds = checked
                      ? [...node.procedureIds, entry.id]
                      : node.procedureIds.filter((id) => id !== entry.id)
                  }
                )
              )
            )
          : h('span', {
              class: 'qp-caption qp-muted',
              text: '还没有规程；先在「试验规程」里固化一条。'
            }),
        nextField(),
        h('span', {
          class: 'qp-field__hint',
          text: `只在桌面端运行；每条规程记为所属应用的一次执行。结果存成变量：${node.id || '<ID>'}_passed、_failed、_blocked、_total；放行评审可以用「规程全部通过」或「规程通过率」。`
        })
      )
    }
    if (node.type === 'explore')
      fields.push(
        textField(
          '探索目标（可以用 {{变量名}}）',
          node.goal,
          (value) => {
            node.goal = value
          },
          { area: true }
        ),
        h(
          'div',
          { class: 'rig-grid-2' },
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: 'Agent（可选）' }),
            select(
              node.agentKey ?? '',
              [
                { value: '', label: '（不指定）' },
                ...(ctx.state.config?.agents ?? []).map((agent) => ({
                  value: agent.key,
                  label: `${agent.displayName}（${agent.key}）`
                }))
              ],
              (value) => {
                if (value) node.agentKey = value
                else delete node.agentKey
              }
            )
          ),
          numberField('本阶段最多步数', node.maxTurns, 1, 20, (value) => {
            node.maxTurns = value
          })
        ),
        nextField(),
        h('span', {
          class: 'qp-field__hint',
          text: '探索只能在桌面端运行浏览器工具；写动作仍逐次确认，不能派发测试。'
        })
      )
    if (node.type === 'gate') {
      const stageOptions = (metric) => {
        const wanted = vocab.gateMetrics[metric]?.stage
        return draft.nodes
          .filter((other) => other.type === wanted)
          .map((other) => ({ value: other.id, label: `${other.title}（${other.id}）` }))
      }
      const rows = node.criteria.map((criterion, position) =>
        h(
          'div',
          { class: 'rig-grid-2' },
          select(
            criterion.metric,
            Object.entries(vocab.gateMetrics).map(([value, meta]) => ({
              value,
              label: meta.label
            })),
            (value) => {
              criterion.metric = value
              criterion.stage = stageOptions(value)[0]?.value ?? ''
              if (!vocab.gateMetrics[value]?.needsValue) delete criterion.value
              else criterion.value ??= 0
              rerender()
            }
          ),
          h(
            'div',
            { class: 'qp-row' },
            select(
              criterion.stage,
              [{ value: '', label: '（选择阶段）' }, ...stageOptions(criterion.metric)],
              (value) => {
                criterion.stage = value ?? ''
              }
            ),
            vocab.gateMetrics[criterion.metric]?.needsValue &&
              numberField('数值', criterion.value ?? 0, 0, 100000, (value) => {
                criterion.value = value
              }),
            h('button', {
              class: 'qp-button qp-button--ghost qp-button--sm',
              text: '移除',
              onclick: () => {
                node.criteria.splice(position, 1)
                rerender()
              }
            })
          )
        )
      )
      fields.push(
        h('span', { class: 'qp-field__label', text: '放行标准（全部满足才达标）' }),
        ...rows,
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '＋ 标准',
          onclick: () => {
            const metric = Object.keys(vocab.gateMetrics)[1] ?? 'run_passed'
            node.criteria.push({ metric, stage: stageOptions(metric)[0]?.value ?? '' })
            rerender()
          }
        }),
        checkbox('标准满足后还要一个人确认放行（Go/No-Go）', node.confirm, (on) => {
          node.confirm = on
        }),
        h(
          'div',
          { class: 'rig-grid-2' },
          nextField('达标后'),
          h(
            'label',
            { class: 'qp-field' },
            h('span', { class: 'qp-field__label', text: '未达标时' }),
            select(
              node.onFail,
              [{ value: '', label: '→ No-Go 结束' }, ...targets().slice(1)],
              (value) => {
                node.onFail = value
              }
            )
          )
        )
      )
    }
    if (node.type === 'debrief')
      fields.push(
        checkbox('推送到订阅了「飞行报告」的通知通道', node.notify, (on) => {
          node.notify = on
        }),
        nextField()
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
    if (draft.nodes.some((node) => node.type === 'flight')) {
      const authorize = h('input', { type: 'checkbox' })
      authorize.checked = Boolean(draft.authorize?.dispatch)
      authorize.onchange = () => {
        draft.authorize = { dispatch: authorize.checked }
      }
      rows.push(
        h(
          'label',
          { class: 'qp-choice qp-choice--checkbox' },
          authorize,
          h('span', { class: 'qp-choice__control' }),
          h('span', { text: '预授权派发：运行这条计划时，固定 ID 的架次不再逐次确认' })
        ),
        h('p', {
          class: 'qp-caption qp-muted',
          text: '只有管理员保存的计划才带这项授权；用 {{变量}} 指定的计划、一次性运行的草稿、以及浏览器写动作都不受它覆盖。定时执行飞行计划需要勾选它。'
        })
      )
    }
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
      // DOM append turns null into the text "null"; only append a real node.
      ...(store.error
        ? [h('span', { class: 'qp-status', 'data-status': 'danger', text: store.error })]
        : [])
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
  if (ctx.state.native) mount.append(await electronAppsPanel(ctx))
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
  // The view is built into a fragment that the app then empties onto the
  // page; rebuilding has to happen in an element that stays there.
  const root = h('div', { class: 'rig-settings' })
  mount.append(root)
  const rerender = () => {
    root.replaceChildren()
    build()
  }

  function build() {
    root.append(
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
                  // The revision this page was loaded at: a save someone else
                  // made in the meantime is refused instead of overwritten.
                  revision: draft.revision,
                  maxTurns: draft.maxTurns,
                  allowedTools: draft.allowedTools,
                  browserOrigins: draft.browserOrigins,
                  browserSites: draft.browserSites === 'list' ? 'list' : 'ask',
                  productionHosts: draft.productionHosts ?? [],
                  browserPreauth: draft.browserPreauth === true,
                  tokenBudget: Number(draft.tokenBudget) || 0,
                  providers: draft.providers,
                  sequence: draft.providers.map((provider) => provider.id),
                  agents: draft.agents
                })
                ctx.state.config = saved
                // Later saves from this same page start from the new revision.
                draft.revision = saved.policy.revision
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
    // Where the browser may go: asked about per mission, or the list only.
    const siteChoice = (value, label) => {
      const input = h('input', { type: 'radio', name: 'browser-sites', value, id: `browser-sites-${value}` })
      input.checked = (draft.browserSites ?? 'ask') === value
      input.onchange = () => {
        if (input.checked) draft.browserSites = value
      }
      return h(
        'label',
        { class: 'qp-choice qp-choice--radio' },
        input,
        h('span', { class: 'qp-choice__control' }),
        h('span', { text: label })
      )
    }
    const sites = h(
      'div',
      { class: 'qp-field' },
      h('span', { class: 'qp-field__label', text: '没有列出的站点' }),
      siteChoice('ask', '任务里第一次打开时，由发起人确认（推荐，开箱即用）'),
      siteChoice('list', '一律不打开，只允许上面列出的站点'),
      h('span', {
        class: 'qp-field__hint',
        text: '确认只对那一项任务有效；人接管时自己去的站点也算确认过。页面自己加载的脚本、接口、登录或验证码框不受站点限制；生产环境禁区始终拒绝。'
      })
    )
    // Browser testing, off on a deployment that predates it being a default.
    const browserTools = catalogue.filter((tool) => tool.group === 'browser').map((tool) => tool.name)
    const enableBrowser = draft.allowedTools.includes('browser_open')
      ? null
      : h(
          'div',
          { class: 'qp-row rig-enable-browser' },
          h('span', { text: '浏览器测试还没有开启：Agent 现在不能打开和操作网页。' }),
          h('button', {
            class: 'qp-button qp-button--outline qp-button--sm',
            type: 'button',
            id: 'enable-browser',
            text: '开启浏览器测试',
            onclick: () => {
              draft.allowedTools = [...new Set([...draft.allowedTools, ...browserTools])]
              rerender()
              ctx.notice('已勾选浏览器工具。点「保存到 Internal」后生效；每一步操作仍然要确认。')
            }
          })
        )
    const preauth = h('input', { type: 'checkbox' })
    preauth.checked = draft.browserPreauth === true
    preauth.onchange = () => {
      draft.browserPreauth = preauth.checked
    }
    const production = h('textarea', {
      class: 'qp-textarea',
      rows: '2',
      placeholder: '.prod.example.com'
    })
    production.value = (draft.productionHosts ?? []).join('\n')
    production.oninput = () => {
      draft.productionHosts = production.value
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
    }
    const budget = h('input', {
      class: 'qp-input',
      id: 'token-budget',
      type: 'number',
      min: '0',
      step: '10000'
    })
    budget.value = String(draft.tokenBudget ?? 0)
    budget.oninput = () => {
      draft.tokenBudget = Number(budget.value)
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
      enableBrowser,
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
            text: '预先允许的站点（不用再确认；每行一个 origin，可以留空）'
          }),
          origins
        )
      ),
      sites,
      h(
        'label',
        { class: 'qp-field' },
        h('span', {
          class: 'qp-field__label',
          text: '生产环境禁区（每行一个主机名，或以 . 开头的后缀）'
        }),
        production,
        h('span', {
          class: 'qp-field__hint',
          text: '飞行计划的预检会拒绝指向这些主机的测试计划；浏览器工位即使 origin 被误加入也不会打开它们。'
        })
      ),
      h(
        'label',
        { class: 'qp-field' },
        h('span', {
          class: 'qp-field__label',
          text: '每项任务的模型用量上限（tokens，0 表示不限）'
        }),
        budget,
        h('span', {
          class: 'qp-field__hint',
          text: '每次调用模型前核对；Provider 未上报用量时按字数估算。超过上限的任务会停下并说明原因，已有结果保留。'
        })
      ),
      h(
        'label',
        { class: 'qp-choice qp-choice--checkbox' },
        preauth,
        h('span', { class: 'qp-choice__control' }),
        h('span', {
          text: '允许发起人对单个任务预授权浏览器写动作（只在允许的测试 origin 内，生产禁区始终拒绝）'
        })
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
      const vision = h('input', { type: 'checkbox' })
      vision.checked = provider.vision === true
      vision.onchange = () => {
        provider.vision = vision.checked
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
            ),
            h(
              'label',
              { class: 'qp-choice qp-choice--checkbox' },
              vision,
              h('span', { class: 'qp-choice__control' }),
              h('span', {
                text: '能读图：浏览器工位把最新截图交给它（调用序列里全部都能读图才生效）'
              })
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

/**
 * This computer as a runner: register, start, stop, remove — the three
 * terminal commands it used to take, as buttons. Desktop only.
 */
async function localRunnerPanel(ctx) {
  const status = await ctx.api('runner-status')
  const act = (action, body) =>
    ctx.run(async () => {
      await ctx.api(action, body)
      await ctx.render()
    })
  const name = h('input', { class: 'qp-input', placeholder: '这台电脑在平台上的名字（可留空）' })
  const rows = []
  if (!status.registered)
    rows.push(
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '把这台电脑接入为执行机后，派给「任意执行机」或指定给它的测试计划会在这里运行（Cypress / Playwright / Electron）。注册使用你当前的登录，执行机凭据只保存在这台电脑上。'
      }),
      h(
        'div',
        { class: 'qp-row' },
        name,
        h('button', {
          class: 'qp-button qp-button--primary',
          text: '注册这台电脑',
          onclick: () => act('runner-register', { name: name.value })
        })
      )
    )
  else
    rows.push(
      h(
        'dl',
        { class: 'rig-kv' },
        h('dt', { text: '名称' }),
        h('dd', { text: status.name ?? '—' }),
        h('dt', { text: '状态' }),
        h('dd', {
          text: status.running
            ? `运行中（进程 ${status.pid}）`
            : status.exited
              ? `已停止（${status.exited.signal ?? status.exited.code}）`
              : '未启动'
        }),
        h('dt', { text: '可执行' }),
        h('dd', { text: `${status.engines.join('、')} × ${status.surfaces.join('、')}` })
      ),
      h(
        'div',
        { class: 'qp-row' },
        status.running
          ? h('button', {
              class: 'qp-button qp-button--outline',
              text: '停止（当前任务结束后）',
              onclick: () => act('runner-stop')
            })
          : h('button', {
              class: 'qp-button qp-button--primary',
              text: '启动执行机',
              onclick: () => act('runner-start')
            }),
        h('button', {
          class: 'qp-button qp-button--ghost',
          text: '注销这台电脑',
          onclick: () => act('runner-remove')
        })
      ),
      status.log.length
        ? h(
            'details',
            {},
            h('summary', { text: '最近输出' }),
            h('pre', { class: 'qp-code-block', text: status.log.join('\n') })
          )
        : null
    )
  return panel(
    '本机执行机 · 桌面端',
    ...rows,
    h('p', {
      class: 'qp-caption qp-muted',
      text: '退出登录或关闭 MX Rig 时执行机会一并停止。需要 Node.js、git 与测试包自己的依赖；带网络副作用的被测客户端请放在专用测试机上跑。'
    })
  )
}

/**
 * The Electron apps this machine's user allowed an Agent to start. Kept on
 * this computer only; the Agent names an app by id and never sees a path.
 */
async function electronAppsPanel(ctx) {
  const { apps = [], platform } = await ctx.api('electron-apps')
  const mac = platform === 'darwin'
  const body = apps.length
    ? table(
        [
          {
            title: '应用',
            cell: (entry) =>
              h(
                'span',
                { class: 'qp-data-cell' },
                h('strong', { text: entry.name }),
                h('small', { text: `ID：${entry.id}` })
              )
          },
          {
            title: '可执行文件',
            cell: (entry) =>
              h(
                'span',
                { class: 'qp-data-cell' },
                h('span', {
                  class: 'qp-caption',
                  text:
                    entry.kind === 'native'
                      ? `原生 · native_launch · ${entry.bundleId}`
                      : 'Electron · electron_launch'
                }),
                h('small', { class: 'rig-wrap', text: entry.path })
              )
          },
          {
            title: '',
            cell: (entry) =>
              h('button', {
                class: 'qp-button qp-button--ghost qp-button--sm',
                text: '移除',
                onclick: () =>
                  ctx.run(async () => {
                    await ctx.api('electron-app-remove', { id: entry.id })
                    await ctx.render()
                  })
              })
          }
        ],
        apps,
        { layout: 'electron-apps' }
      )
    : empty('还没有登记应用。登记后，Agent 可以用 electron_launch 启动它（每次都要确认）。')
  const probeResult = h('p', { class: 'qp-caption qp-muted', id: 'native-probe-result' })
  const nativeTools = mac
    ? h(
        'div',
        { class: 'qp-stack qp-stack--tight' },
        h('p', {
          class: 'qp-caption qp-muted',
          text: '原生应用（macOS 预览）：通过系统辅助功能读取窗口控件树、点击和填写，Agent 使用 native_* 工具，每次写动作都要确认、不适用任务级预授权，也不会填写密码框。需要在 系统设置 → 隐私与安全性 → 辅助功能 与 自动化 中允许 MX Rig。Windows 暂不支持。'
        }),
        h(
          'div',
          { class: 'qp-row' },
          h('button', {
            class: 'qp-button qp-button--outline qp-button--sm',
            text: '登记原生应用…',
            onclick: () =>
              ctx.run(async () => {
                await ctx.api('electron-app-add', { kind: 'native' })
                await ctx.render()
              })
          }),
          h('button', {
            class: 'qp-button qp-button--ghost qp-button--sm',
            text: '检查辅助功能权限',
            onclick: (event) => {
              event.target.disabled = true
              probeResult.textContent = '正在检查；macOS 可能会弹出授权对话框，请在对话框里选择。'
              ctx
                .run(async () => {
                  const status = await ctx.api('native-probe')
                  probeResult.replaceChildren(
                    status.permitted
                      ? '可以使用：系统已允许 MX Rig 读取和操作原生窗口。'
                      : `暂不可用：${status.reason ?? '未获授权'}。在系统设置里打开 MX Rig 的开关，再点一次「检查辅助功能权限」。`
                  )
                  // The panes where the switch is: no hunting through System Settings.
                  if (!status.permitted && status.supported)
                    for (const [pane, label] of [
                      ['accessibility', '打开「辅助功能」设置'],
                      ['automation', '打开「自动化」设置']
                    ])
                      probeResult.append(
                        ' ',
                        h('button', {
                          class: 'qp-button qp-button--outline qp-button--sm',
                          type: 'button',
                          text: label,
                          onclick: () => ctx.run(() => ctx.api('open-privacy', { pane }))
                        })
                      )
                })
                .finally(() => {
                  event.target.disabled = false
                })
            }
          })
        ),
        probeResult
      )
    : null
  return panel(
    '本机 Electron 与原生应用 · 桌面端',
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '只保存在这台电脑上。Agent 只能按 ID 启动这里登记过的应用，并用浏览器工具操作它的窗口；管理员还需要在允许列表里打开 electron_launch。'
    }),
    body,
    h('button', {
      class: 'qp-button qp-button--outline qp-button--sm',
      text: '登记 Electron 应用…',
      onclick: () =>
        ctx.run(async () => {
          await ctx.api('electron-app-add')
          await ctx.render()
        })
    }),
    nativeTools
  )
}

// -- quality report ---------------------------------------------------------------

/**
 * What the Agents concluded and what the browser checked in this window.
 *
 * Deliberately its own panel, next to the test numbers and never inside them:
 * a finding is a judgement and an assertion covers only the pages an Agent
 * walked. Lists are present only for members who can run missions; a read-only
 * member sees the counts.
 */
function agentSection(ctx, stats) {
  if (!stats) return null
  const byVerdict = stats.findings.byVerdict
  const verdictLine = Object.entries(byVerdict)
    .filter(([, count]) => count > 0)
    .map(([verdict, count]) => `${VERDICT_TEXT[verdict]?.label ?? verdict} ${count}`)
    .join(' · ')
  const body = [
    h(
      'div',
      { class: 'qp-metric-grid' },
      metric(
        'Agent 任务',
        String(stats.total),
        `服务端 ${stats.bySurface.internal} · 桌面 ${stats.bySurface.desktop}`
      ),
      metric(
        '结构化结论',
        String(stats.findings.total),
        stats.findings.total ? verdictLine : '窗口内没有 Agent 提交结论'
      ),
      metric(
        '引用未核实',
        String(stats.findings.unverified),
        stats.findings.unverified ? '这些结论需要人工复核' : '没有未核实的引用'
      ),
      metric(
        '页面断言',
        stats.assertions.total ? asPercent(stats.assertions.passRate) : '—',
        stats.assertions.total
          ? `${stats.assertions.passed} / ${stats.assertions.total} 通过`
          : '窗口内没有断言'
      ),
      stats.usage?.calls
        ? metric(
            '模型用量',
            kilo(stats.usage.promptTokens + stats.usage.completionTokens),
            `${stats.usage.calls} 次调用 · 均 ${kilo(stats.usage.perMission)}/任务${
              stats.usage.estimated ? ' · 含估算' : ''
            }`
          )
        : null
    )
  ]
  const open = (missionId) =>
    ctx.state.missions.some((row) => row.id === missionId)
      ? h('button', {
          class: 'qp-button qp-button--ghost qp-button--sm',
          text: '打开任务',
          onclick: () => {
            ctx.state.selected = missionId
            ctx.go('missions')
          }
        })
      : h('span', { class: 'qp-caption qp-muted', text: '他人任务' })
  if (stats.findings.recent.length)
    body.push(
      h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: '最近的结论' }),
      table(
        [
          {
            title: '结论',
            cell: (row) =>
              h('span', {
                class: 'qp-status',
                'data-status': VERDICT_TEXT[row.verdict]?.tone ?? 'default',
                text: VERDICT_TEXT[row.verdict]?.label ?? row.verdict
              })
          },
          {
            title: '任务',
            cell: (row) =>
              h('span', {
                class: 'qp-body-2',
                text: `${row.surface === 'desktop' ? (row.client === 'terminal' ? '［终端］' : '［桌面］') : ''}${row.goal}`
              })
          },
          {
            title: '摘要',
            cell: (row) =>
              h('span', {
                class: 'qp-body-2 rig-wrap',
                text: `${row.summary}${row.unverified ? `（${row.unverified} 个引用未核实）` : ''}`
              })
          },
          { title: '', cell: (row) => open(row.missionId) }
        ],
        stats.findings.recent,
        { layout: 'findings' }
      )
    )
  if (stats.assertions.recentFailures.length)
    body.push(
      h('h3', { class: 'qp-body-1 qp-body-1--semibold', text: '未通过的断言' }),
      table(
        [
          {
            title: '检查',
            cell: (row) => h('span', { class: 'qp-body-2', text: row.description })
          },
          {
            title: '期望 / 实际',
            cell: (row) =>
              h('span', {
                class: 'qp-body-2 rig-wrap',
                text: `${row.expected ?? '—'} / ${row.actual ?? '—'}`
              })
          },
          { title: '任务', cell: (row) => h('span', { class: 'qp-body-2', text: row.goal }) },
          { title: '', cell: (row) => open(row.missionId) }
        ],
        stats.assertions.recentFailures,
        { layout: 'assertions' }
      )
    )
  body.push(
    h(
      'ul',
      { class: 'qp-caption qp-muted' },
      ...stats.caveats.map((line) => h('li', { text: line }))
    )
  )
  return panel('Agent 结论与页面断言', ...body)
}

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
    agents: agentSection(ctx, insights.missions),
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
    tester: ['risks', 'agents', 'cases', 'trend', 'coverage'],
    developer: ['cases', 'agents', 'risks', 'trend', 'coverage'],
    lead: ['trend', 'risks', 'agents', 'coverage', 'cases']
  }[lens]
  for (const key of order) if (sections[key]) mount.append(sections[key])

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

// -- 试验规程 ---------------------------------------------------------------------

const VERDICT_TONE = { passed: 'success', failed: 'danger', blocked: 'warning' }
const VERDICT_WORD = { passed: '通过', failed: '失败', blocked: '受阻' }
const PROCEDURE_STATE = {
  draft: ['草稿', 'default'],
  active: ['启用', 'success'],
  retired: ['停用', 'default']
}
const JUDGEMENT = {
  'case-issue': '用例问题（页面改了写法）',
  'product-defect': '产品缺陷',
  'environment-blocked': '环境问题',
  inconclusive: '证据不足'
}
const STATION = { desktop: '桌面试车', validation: '修正验证', test: '测试' }

const tone = (label, value) => h('span', { class: 'qp-status', 'data-status': value, text: label })
const verdictTag = (verdict) =>
  tone(VERDICT_WORD[verdict] ?? verdict, VERDICT_TONE[verdict] ?? 'default')
const stateTag = (status) => tone(...(PROCEDURE_STATE[status] ?? [status, 'default']))

export async function procedures(ctx, mount) {
  const { procedures: list = [] } = await ctx.api('procedures')
  if (ctx.state.procedureId && !list.some((entry) => entry.id === ctx.state.procedureId))
    ctx.state.procedureId = null
  const activeCount = list.filter((entry) => entry.status === 'active').length
  const fireAll =
    ctx.state.native && ctx.canRun() && activeCount
      ? h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          id: 'procedure-fire-all',
          text: `全部试车（${activeCount} 条启用的规程）`,
          onclick: (event) => {
            event.target.disabled = true
            ctx.notice(`回归试车中：${activeCount} 条规程依次执行，每条都记为一次执行……`)
            ctx
              .run(async () => {
                const { results, passed, total } = await ctx.api('procedure-fire-all', {})
                const failed = results.filter((entry) => entry.verdict !== 'passed')
                ctx.notice(
                  `回归试车完成：${passed}/${total} 通过。${failed
                    .map(
                      (entry) =>
                        `「${entry.title}」${VERDICT_WORD[entry.verdict] ?? entry.error ?? entry.verdict}`
                    )
                    .join('，')}`,
                  failed.length ? 'error' : 'info'
                )
                await ctx.render()
              })
              .finally(() => {
                event.target.disabled = false
              })
          }
        })
      : null
  const open = (id) => {
    ctx.state.procedureId = id
    ctx.render()
  }
  mount.append(
    panel(
      '试验规程',
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '规程是 Agent 写下、机器按原样重放的测试：重放时没有模型参与，同一版本每次都做同样的事，红了就是页面变了。探索过的任务在任务详情里「固化为规程」；试车失败时交给规程维护员，在失败的那一步提出修正，修正经重放验证后由你批准。每次试车都记为所属应用的一次执行，进入质量报告。'
      }),
      fireAll,
      list.length
        ? table(
            [
              {
                title: '规程',
                cell: (entry) =>
                  h(
                    'span',
                    { class: 'qp-data-cell' },
                    h('strong', { text: entry.title }),
                    h('small', {
                      text: `${entry.id} · 第 ${entry.revision} 版 · ${entry.steps} 步`
                    })
                  )
              },
              {
                title: '用例',
                cell: (entry) =>
                  h('span', {
                    class: 'qp-caption',
                    text: entry.caseId
                      ? `${entry.caseId}${entry.app ? ` · ${entry.app}` : ''}`
                      : '未关联'
                  })
              },
              { title: '状态', cell: (entry) => stateTag(entry.status) },
              {
                title: '最近试车',
                cell: (entry) =>
                  entry.lastRun
                    ? h(
                        'span',
                        { class: 'qp-data-cell' },
                        verdictTag(entry.lastRun.verdict),
                        h('small', {
                          text: `第 ${entry.lastRun.revision} 版 · ${ago(entry.lastRun.at)}${
                            entry.lastRun.failedStep !== null
                              ? ` · 停在第 ${entry.lastRun.failedStep + 1} 步`
                              : ''
                          }`
                        })
                      )
                    : h('span', { class: 'qp-caption qp-muted', text: '还没有试车' })
              },
              {
                title: '',
                cell: (entry) =>
                  h(
                    'span',
                    { class: 'qp-row' },
                    entry.openProposals
                      ? h('span', {
                          class: 'qp-tag qp-tag--warning',
                          text: `${entry.openProposals} 个待审修正`
                        })
                      : null,
                    h('button', {
                      class: 'qp-button qp-button--ghost qp-button--sm',
                      text: ctx.state.procedureId === entry.id ? '已打开' : '打开',
                      onclick: () => open(entry.id)
                    })
                  )
              }
            ],
            list,
            { layout: 'procedures' }
          )
        : empty(
            '还没有规程。让「页面巡检员」在桌面端走一遍页面并做断言，然后在任务详情里点「固化为规程」。'
          )
    )
  )
  if (ctx.state.procedureId) mount.append(await procedureDetail(ctx, ctx.state.procedureId))
  mount.append(await regressionPanel(ctx))
  if (ctx.state.native) mount.append(await localStationPanel(ctx))
}

const RUNS_ON = {
  'any-runner': '任意工位（含值守中的桌面）',
  server: '团队工位（服务器 / 容器）'
}

/**
 * 定时回归. The service keeps the schedule and the queue; a station — a
 * desktop on duty, `mx-rig station watch`, a station container — claims the
 * batch and replays it with its own browser. The service never opens one.
 */
async function regressionPanel(ctx) {
  let data
  try {
    data = await ctx.api('procedure-tasks')
  } catch (error) {
    return panel('定时回归', empty(`读取回归任务失败：${error.message}`))
  }
  const writable = ctx.canRun()
  const dispatch = (task, button) => {
    button.disabled = true
    ctx
      .run(async () => {
        const { run } = await ctx.api('procedure-task-run', { id: task.id })
        ctx.notice(
          run.status === 'pending-runner'
            ? `已排队：${run.id}，等工位来取。`
            : `已派发：${run.id}（${STATUS_TEXT[run.status] ?? run.status}）`
        )
        await ctx.render()
      })
      .finally(() => {
        button.disabled = false
      })
  }
  const tasks = data.tasks.length
    ? table(
        [
          {
            title: '回归任务',
            cell: (task) =>
              h(
                'span',
                { class: 'qp-data-cell' },
                h('strong', { text: task.name }),
                h('small', { text: `${task.app} · ${task.enabled === false ? '已停用' : task.id}` })
              )
          },
          {
            title: '时间',
            cell: (task) =>
              h('span', {
                class: 'qp-caption',
                text:
                  task.scheduleKind === 'cron'
                    ? `${task.cronExpr}（${task.timezone}）${task.nextRunAt ? ` · 下次 ${new Date(task.nextRunAt).toLocaleString()}` : ''}`
                    : '手动'
              })
          },
          {
            title: '在哪里',
            cell: (task) => h('span', { class: 'qp-caption', text: RUNS_ON[task.runsOn ?? 'any-runner'] })
          },
          {
            title: '最近一次',
            cell: (task) =>
              task.lastRun
                ? h(
                    'span',
                    { class: 'qp-data-cell' },
                    statusTag(task.lastRun.status),
                    h('small', { text: `${task.lastRun.id} · ${ago(task.lastRun.finishedAt)}` })
                  )
                : h('span', { class: 'qp-caption qp-muted', text: '还没有执行' })
          },
          {
            title: '',
            cell: (task) =>
              writable
                ? h('button', {
                    class: 'qp-button qp-button--ghost qp-button--sm',
                    text: '立即回归',
                    onclick: (event) => dispatch(task, event.target)
                  })
                : h('span')
          }
        ],
        data.tasks,
        { layout: 'procedure-tasks' }
      )
    : empty('还没有回归任务。')
  const stations = data.stations.length
    ? table(
        [
          {
            title: '工位',
            cell: (station) =>
              h(
                'span',
                { class: 'qp-data-cell' },
                h('strong', { text: station.name }),
                h('small', { text: `${station.id}${station.mine ? ' · 我的' : ''}` })
              )
          },
          {
            title: '类型',
            cell: (station) =>
              h('span', { class: 'qp-caption', text: station.kind === 'server' ? '团队工位' : '个人工位' })
          },
          {
            title: '状态',
            cell: (station) =>
              h('span', {
                class: 'qp-status',
                'data-status': station.online ? (station.status === 'busy' ? 'info' : 'success') : 'default',
                text: station.online ? (station.status === 'busy' ? '回归中' : '在线') : '离线'
              })
          },
          {
            title: '最近心跳',
            cell: (station) => h('span', { class: 'qp-caption', text: ago(station.lastSeenAt) })
          }
        ],
        data.stations,
        { layout: 'stations' }
      )
    : empty(
        '还没有工位。在桌面端打开「本机工位值守」，或在测试机上运行 mx-rig station enroll / watch，或用 scripts/manage.sh up --station 起一个工位容器。'
      )
  return panel(
    '定时回归',
    h('p', {
      class: 'qp-body-2 qp-muted',
      text: '服务端只负责排程和排队：到点把应用里「已启用、关联了用例」的规程排成一批，由工位领走、用工位自己的浏览器重放，结果按用例记为一次执行，每条规程的试车记录里也看得到。服务器不开浏览器。'
    }),
    tasks,
    writable ? regressionForm(ctx, data.apps) : null,
    h('h3', { class: 'qp-heading-3', text: '工位' }),
    stations
  )
}

function regressionForm(ctx, apps) {
  if (!apps.length)
    return h('p', {
      class: 'qp-caption qp-muted',
      text: '新建回归任务前，先把规程关联到用例并启用——没有用例的规程在一次执行里无处记录。'
    })
  const app = h(
    'select',
    { class: 'qp-input', id: 'regression-app' },
    ...apps.map((entry) =>
      h('option', { value: entry.slug, text: `${entry.slug}（${entry.procedures} 条规程）` })
    )
  )
  const name = h('input', { class: 'qp-input', id: 'regression-name', placeholder: '名称，例如「夜间回归」' })
  const cron = h('input', {
    class: 'qp-input rig-code-input',
    id: 'regression-cron',
    placeholder: 'cron，例如 0 2 * * *（留空为手动触发）'
  })
  const runsOn = h(
    'select',
    { class: 'qp-input', id: 'regression-runs-on' },
    ...Object.entries(RUNS_ON).map(([value, text]) => h('option', { value, text }))
  )
  return h(
    'details',
    { class: 'rig-section', id: 'regression-form' },
    h('summary', { text: '新建回归任务' }),
    h('div', { class: 'rig-grid-2' }, app, name),
    h('div', { class: 'rig-grid-2' }, cron, runsOn),
    h('button', {
      class: 'qp-button qp-button--primary qp-button--sm',
      id: 'regression-save',
      text: '保存回归任务',
      onclick: () =>
        ctx.run(async () => {
          await ctx.api('procedure-task-create', {
            app: app.value,
            name: name.value.trim() || `${app.value} 规程回归`,
            cronExpr: cron.value.trim() || null,
            runsOn: runsOn.value
          })
          ctx.notice('回归任务已保存。')
          await ctx.render()
        })
    })
  )
}

/**
 * This computer on duty (值守): procedure batches queued on the service are
 * replayed here in the background, headless, in a process of its own.
 * Desktop only.
 */
async function localStationPanel(ctx) {
  const status = await ctx.api('station-status')
  const act = (action, body) =>
    ctx.run(async () => {
      await ctx.api(action, body)
      await ctx.render()
    })
  const name = h('input', { class: 'qp-input', placeholder: '这个工位在平台上的名字（可留空）' })
  const rows = []
  if (!status.registered)
    rows.push(
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '值守时，派给「任意工位」的规程回归会在这台电脑上后台重放（无头浏览器，不打扰你的任务）。注册使用你当前的登录，工位凭据只保存在这台电脑上；它只能执行试验规程。'
      }),
      h(
        'div',
        { class: 'qp-row' },
        name,
        h('button', {
          class: 'qp-button qp-button--primary',
          id: 'station-register',
          text: '把这台电脑登记为工位',
          onclick: () => act('station-register', { name: name.value })
        })
      )
    )
  else
    rows.push(
      h(
        'dl',
        { class: 'rig-kv' },
        h('dt', { text: '名称' }),
        h('dd', { text: status.name ?? '—' }),
        h('dt', { text: '值守' }),
        h('dd', {
          text: status.running
            ? `值守中（进程 ${status.pid}）`
            : status.exited
              ? `已停止（${status.exited.signal ?? status.exited.code}）`
              : '未值守'
        })
      ),
      h(
        'div',
        { class: 'qp-row' },
        status.running
          ? h('button', {
              class: 'qp-button qp-button--outline',
              id: 'station-stop',
              text: '停止值守（当前批次结束后）',
              onclick: () => act('station-stop')
            })
          : h('button', {
              class: 'qp-button qp-button--primary',
              id: 'station-start',
              text: '开始值守',
              onclick: () => act('station-start')
            }),
        h('button', {
          class: 'qp-button qp-button--ghost',
          text: '注销工位',
          onclick: () => act('station-remove')
        })
      ),
      status.log.length
        ? h(
            'details',
            {},
            h('summary', { text: '最近输出' }),
            h('pre', { class: 'qp-code-block', text: status.log.join('\n') })
          )
        : null
    )
  return panel(
    '本机工位值守 · 桌面端',
    ...rows,
    h('p', {
      class: 'qp-caption qp-muted',
      text: '退出登录或关闭 MX Rig 时值守一并停止。靶场安全策略随批次下发，工位照样只访问允许的地址。'
    })
  )
}

async function procedureDetail(ctx, id) {
  const { procedure } = await ctx.api('procedure', { id })
  const writable = ctx.canRun()
  const native = ctx.state.native
  const box = h('section', { class: 'qp-panel rig-section', id: 'procedure-detail' })
  box.append(
    h(
      'div',
      { class: 'qp-row qp-row--between' },
      h(
        'div',
        {},
        h('p', {
          class: 'qp-caption qp-muted',
          text: `PROCEDURE / ${procedure.id} · 第 ${procedure.revision} 版 · ${
            procedure.surface === 'electron' ? 'Electron' : '网页'
          }${procedure.baseUrl ? ` · ${procedure.baseUrl}` : ''}`
        }),
        h('h2', { class: 'qp-heading-2', text: procedure.title }),
        h('p', {
          class: 'qp-caption qp-muted',
          text: procedure.caseId
            ? `实现用例 ${procedure.caseId}${procedure.app ? `（${procedure.app}）` : ''}；每次试车记为该应用的一次执行。`
            : '没有关联用例：试车只记在这里，不进入质量报告。'
        })
      ),
      stateTag(procedure.status)
    )
  )

  const actions = h('div', { class: 'qp-row rig-procedure-actions' })
  if (writable && native && procedure.status !== 'retired')
    actions.append(
      h('button', {
        class: 'qp-button qp-button--primary qp-button--sm',
        id: 'procedure-fire',
        text: '试车',
        onclick: (event) => {
          event.target.disabled = true
          ctx.notice('试车中：浏览器工位正在按规程逐步执行……')
          ctx
            .run(async () => {
              const { run, kernelRun, kernelError } = await ctx.api('procedure-fire', { id })
              ctx.notice(
                run.verdict === 'passed'
                  ? `试车通过（${run.steps.length} 步）。${kernelRun ? `已记为执行 ${kernelRun.id}。` : ''}`
                  : `试车${VERDICT_WORD[run.verdict]}：第 ${run.failedStep + 1} 步 ${run.failure?.message ?? ''}${
                      kernelError ? `（记入质量报告失败：${kernelError}）` : ''
                    }`,
                run.verdict === 'passed' ? 'info' : 'error'
              )
              await ctx.render()
            })
            .finally(() => {
              event.target.disabled = false
            })
        }
      })
    )
  if (!native)
    actions.append(
      h('span', {
        class: 'qp-caption qp-muted',
        text: '试车与修正需要 MX Rig 桌面端（浏览器工位在那里）。'
      })
    )
  const setStatus = (status, label) =>
    h('button', {
      class: 'qp-button qp-button--outline qp-button--sm',
      text: label,
      onclick: () =>
        ctx.run(async () => {
          const { caseUpdated } = await ctx.api('procedure-status', { id, status })
          ctx.notice(
            status === 'active'
              ? `已启用。${caseUpdated ? `用例 ${procedure.caseId} 已标记为「已自动化」。` : ''}`
              : status === 'retired'
                ? '已停用。历史试车记录保留。'
                : '已改回草稿。'
          )
          await ctx.render()
        })
    })
  if (writable && procedure.status === 'draft') actions.append(setStatus('active', '启用'))
  if (writable && procedure.status !== 'retired') actions.append(setStatus('retired', '停用'))
  if (writable && procedure.status === 'retired') actions.append(setStatus('draft', '恢复为草稿'))
  const editor = h('div', { class: 'rig-section' })
  if (writable && procedure.status !== 'retired')
    actions.append(
      h('button', {
        class: 'qp-button qp-button--ghost qp-button--sm',
        text: '编辑步骤',
        onclick: () => {
          if (editor.childElementCount) return editor.replaceChildren()
          const body = {
            title: procedure.title,
            app: procedure.app,
            caseId: procedure.caseId,
            surface: procedure.surface,
            baseUrl: procedure.baseUrl,
            variables: procedure.variables,
            steps: procedure.steps
          }
          const area = h('textarea', {
            class: 'qp-textarea rig-code-input',
            rows: '18',
            id: 'procedure-json'
          })
          area.value = JSON.stringify(body, null, 2)
          const reason = h('input', {
            class: 'qp-input',
            placeholder: '修改原因（会写进修订历史）'
          })
          editor.replaceChildren(
            h('p', {
              class: 'qp-caption qp-muted',
              text: '直接编辑规程 JSON。保存后生成新版本并回到草稿，下一次试车通过后才能启用。'
            }),
            area,
            reason,
            h('button', {
              class: 'qp-button qp-button--primary qp-button--sm',
              text: `保存为第 ${procedure.revision + 1} 版`,
              onclick: () =>
                ctx.run(async () => {
                  let parsed
                  try {
                    parsed = JSON.parse(area.value)
                  } catch {
                    throw new Error('不是合法的 JSON')
                  }
                  await ctx.api('procedure-revise', {
                    id,
                    expectedRevision: procedure.revision,
                    procedure: parsed,
                    reason: reason.value.trim() || '手工修改'
                  })
                  ctx.notice(`已保存为第 ${procedure.revision + 1} 版，请重新试车。`)
                  await ctx.render()
                })
            })
          )
        }
      })
    )
  box.append(actions, editor)

  box.append(
    h('h3', { class: 'qp-heading-3', text: '步骤' }),
    table(
      [
        {
          title: '#',
          cell: (entry) => h('span', { class: 'qp-caption', text: String(entry.index + 1) })
        },
        { title: '步骤', cell: (entry) => h('span', { class: 'qp-body-2', text: entry.text }) },
        {
          title: '说明',
          cell: (entry) => h('span', { class: 'qp-caption qp-muted', text: entry.note ?? '' })
        }
      ],
      procedure.steps.map((step, index) => ({
        index,
        text: procedure.stepText[index],
        note: step.note
      })),
      { layout: 'procedure-steps' }
    )
  )

  const pending = procedure.proposals.filter((entry) => entry.status === 'pending')
  for (const proposal of pending) box.append(proposalReview(ctx, procedure, proposal))

  box.append(h('h3', { class: 'qp-heading-3', text: '试车记录' }))
  const latestRepairable = procedure.runs.find(
    (run) => run.revision === procedure.revision && run.station !== 'validation'
  )
  box.append(
    procedure.runs.length
      ? table(
          [
            {
              title: '时间',
              cell: (run) =>
                h(
                  'span',
                  { class: 'qp-data-cell' },
                  h('span', { class: 'qp-caption', text: ago(run.finishedAt) }),
                  h('small', {
                    text: `${STATION[run.station] ?? run.station} · 第 ${run.revision} 版`
                  })
                )
            },
            { title: '结果', cell: (run) => verdictTag(run.verdict) },
            {
              title: '位置',
              cell: (run) => {
                const cell = h('div', { class: 'qp-caption' })
                cell.append(
                  h('span', {
                    text: run.failure
                      ? `第 ${run.failure.index + 1} 步：${run.failure.message}`
                      : `${run.steps.length} 步全部通过`
                  })
                )
                const details = h('details')
                details.append(
                  h('summary', { text: '逐步结果' }),
                  h(
                    'ol',
                    { class: 'rig-step-results' },
                    ...run.steps.map((step) =>
                      h('li', {
                        'data-status': step.status,
                        text: `${step.text}${step.error ? ` —— ${step.error.message}` : ''}`
                      })
                    )
                  ),
                  ...(run.failure?.snapshot
                    ? [h('pre', { class: 'qp-code-block', text: run.failure.snapshot })]
                    : [])
                )
                cell.append(details)
                return cell
              }
            },
            {
              title: '',
              cell: (run) =>
                h(
                  'span',
                  { class: 'qp-row' },
                  native && run.failure?.screenshot
                    ? h('button', {
                        class: 'qp-button qp-button--ghost qp-button--sm',
                        text: '截图',
                        onclick: () =>
                          ctx.run(() => ctx.api('artifact', { path: run.failure.screenshot }))
                      })
                    : null,
                  run.kernelRunId
                    ? h('button', {
                        class: 'qp-button qp-button--ghost qp-button--sm',
                        text: '执行记录',
                        onclick: () => ctx.openPath(`/test-center/#/runs/${run.kernelRunId}`)
                      })
                    : null,
                  writable &&
                    native &&
                    run === latestRepairable &&
                    run.verdict === 'failed' &&
                    run.repairable
                    ? h('button', {
                        class: 'qp-button qp-button--primary qp-button--sm',
                        id: 'procedure-repair',
                        text: '交给规程维护员修正',
                        onclick: (event) => {
                          event.target.disabled = true
                          ctx
                            .run(async () => {
                              const { mission } = await ctx.api('procedure-repair', {
                                id,
                                runId: run.id
                              })
                              ctx.notice(
                                '已重放到失败的那一步，并交给规程维护员。修正提出后会先自动验证，再回到这里等你批准。'
                              )
                              ctx.state.selected = mission.id
                              ctx.go('missions')
                            })
                            .finally(() => {
                              event.target.disabled = false
                            })
                        }
                      })
                    : null
                )
            }
          ],
          procedure.runs,
          { layout: 'procedure-runs' }
        )
      : empty(native ? '还没有试车。点上方「试车」按规程跑一遍。' : '还没有试车记录。')
  )

  const decided = procedure.proposals.filter((entry) => entry.status !== 'pending')
  if (procedure.history.length || decided.length) {
    const history = h('details', { class: 'rig-section' })
    history.append(
      h('summary', {
        text: `修订历史（${procedure.history.length} 个旧版本，${decided.length} 条已处理的修正）`
      }),
      h(
        'ul',
        { class: 'qp-body-2 qp-soft' },
        h('li', {
          text: `第 ${procedure.revision} 版（当前）· ${procedure.updatedBy} · ${ago(procedure.updatedAt)} · ${procedure.reason}`
        }),
        ...procedure.history.map((entry) =>
          h('li', {
            text: `第 ${entry.revision} 版 · ${entry.by} · ${ago(entry.at)} · ${entry.reason}`
          })
        ),
        ...decided.map((entry) =>
          h('li', {
            text: `修正 ${entry.id}（基于第 ${entry.baseRevision} 版）：${
              { approved: '已批准', rejected: '已驳回', dismissed: '已读', superseded: '已失效' }[
                entry.status
              ] ?? entry.status
            } · ${entry.rationale}`
          })
        )
      )
    )
    box.append(history)
  }
  return box
}

function proposalReview(ctx, procedure, proposal) {
  const proven = proposal.validation?.verdict === 'passed'
  const card = h('article', { class: 'qp-panel rig-proposal', 'data-proven': String(proven) })
  card.append(
    h(
      'div',
      { class: 'qp-row qp-row--between' },
      h('strong', {
        class: 'qp-body-1',
        text: `待审修正 · ${JUDGEMENT[proposal.verdict] ?? proposal.verdict}`
      }),
      proposal.steps
        ? proven
          ? tone('验证试车通过', 'success')
          : tone(proposal.validation ? '验证试车未通过' : '未验证', 'danger')
        : tone('不修改规程', 'default')
    ),
    h('p', { class: 'qp-body-2', text: proposal.rationale }),
    h('p', {
      class: 'qp-caption qp-muted',
      text: `由 ${proposal.by} 的修正任务提出，基于第 ${proposal.baseRevision} 版${
        proposal.validation?.failure
          ? `；验证停在第 ${proposal.validation.failure.index + 1} 步：${proposal.validation.failure.message}`
          : ''
      }`
    })
  )
  if (proposal.droppedAssertions)
    card.append(
      h('p', {
        class: 'qp-body-2 rig-warning-line',
        id: 'proposal-weakens',
        text: `这个修正删除或改动了 ${proposal.droppedAssertions} 条原有断言。验证试车看不出这一点：断言没了，就没有东西会失败。批准前确认这是需求本身变了，而不是为了让试车变绿。`
      })
    )
  if (proposal.diff)
    card.append(
      h(
        'ol',
        { class: 'rig-diff' },
        ...proposal.diff.entries.map((line) =>
          h('li', {
            class: 'rig-diff__line',
            'data-op': line.op,
            text: `${line.op === 'add' ? '+ ' : line.op === 'remove' ? '− ' : '  '}${line.text}`
          })
        )
      )
    )
  if (ctx.canRun()) {
    const decide = (approved) =>
      ctx.run(async () => {
        await ctx.api('procedure-decide', { id: procedure.id, proposalId: proposal.id, approved })
        ctx.notice(
          approved
            ? `已批准，规程更新为第 ${procedure.revision + 1} 版。`
            : proposal.steps
              ? '已驳回。规程保持原样。'
              : '已标记为已读。'
        )
        await ctx.render()
      })
    card.append(
      h(
        'div',
        { class: 'qp-row' },
        proposal.steps
          ? h('button', {
              class: 'qp-button qp-button--primary qp-button--sm',
              id: 'proposal-approve',
              text: proposal.droppedAssertions ? '仍然批准…' : '批准修正',
              disabled: !proven,
              onclick: (event) => {
                // Weakening a check takes a second, deliberate click.
                if (proposal.droppedAssertions && event.target.dataset.confirm !== 'yes') {
                  event.target.dataset.confirm = 'yes'
                  event.target.textContent = `确认批准（少了 ${proposal.droppedAssertions} 条断言）`
                  return
                }
                decide(true)
              }
            })
          : null,
        h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: proposal.steps ? '驳回' : '知道了',
          onclick: () => decide(false)
        })
      )
    )
  }
  return card
}

/** What a mission produced toward the test assets: drafts, a capture, a proposal. */
function authoringPanel(ctx, row) {
  const parts = []
  if (row.caseDrafts?.length) parts.push(caseDraftsCard(ctx, row))
  if (row.proposal) parts.push(repairCard(ctx, row))
  const capturable =
    row.status === 'completed' &&
    !row.procedureBase &&
    (row.events ?? []).some(
      (event) =>
        (event.kind === 'tool_result' && (event.data?.action || event.data?.result?.action)) ||
        event.kind === 'assertion'
    )
  // On the desktop the capture reads the full local record; on the web, the
  // synced copy (the service says so when early steps were trimmed).
  if (capturable && ctx.canRun()) parts.push(captureCard(ctx, row))
  return parts.length ? panel('测试资产', ...parts) : null
}

function caseDraftsCard(ctx, row) {
  const card = h('div', { class: 'rig-section', id: 'case-drafts' })
  const picks = row.caseDrafts.map(() => h('input', { type: 'checkbox' }))
  picks.forEach((box) => {
    box.checked = true
  })
  const results = h('div', { class: 'qp-caption' })
  card.append(
    h('h3', { class: 'qp-heading-3', text: `用例草稿（${row.caseDrafts.length} 条）` }),
    h('p', {
      class: 'qp-caption qp-muted',
      text: '这些是 Agent 起草的用例，还没有进入用例目录。勾选要保留的，加入后状态为「计划中」，之后可以固化为规程来实现它们。'
    }),
    ...row.caseDrafts.map((draft, index) => {
      const details = h('details', { class: 'rig-case-draft' })
      details.append(
        h(
          'summary',
          {},
          h(
            'label',
            { class: 'qp-choice qp-choice--checkbox' },
            picks[index],
            h('span', { class: 'qp-choice__control' }),
            h('span', { text: `${draft.caseId} · ${draft.priority} · ${draft.title}` })
          )
        ),
        h('p', {
          class: 'qp-caption qp-muted',
          text: `应用 ${draft.app}${draft.requirementRef ? ` · 需求 ${draft.requirementRef}` : ''}${draft.preconditions ? ` · 前置：${draft.preconditions}` : ''}`
        }),
        h(
          'ol',
          { class: 'qp-body-2' },
          ...draft.steps.map((step) =>
            h('li', { text: `${step.action}${step.expect ? ` ⇒ ${step.expect}` : ''}` })
          )
        )
      )
      return details
    }),
    ctx.canRun()
      ? h('button', {
          class: 'qp-button qp-button--primary qp-button--sm',
          id: 'import-cases',
          text: '把勾选的加入用例目录',
          onclick: () =>
            ctx.run(async () => {
              const cases = row.caseDrafts.filter((_draft, index) => picks[index].checked)
              if (!cases.length) throw new Error('没有勾选任何草稿')
              const { results: outcome } = await ctx.api('cases-import', { cases })
              results.replaceChildren(
                ...outcome.map((entry) =>
                  h('p', {
                    class: entry.ok ? '' : 'rig-warning-line',
                    text: entry.ok
                      ? `✓ ${entry.caseId} 已加入用例目录`
                      : `✗ ${entry.caseId}：${entry.error}`
                  })
                )
              )
            })
        })
      : null,
    results
  )
  return card
}

function captureCard(ctx, row) {
  const title = h('input', { class: 'qp-input', id: 'capture-title', placeholder: '规程名称' })
  title.value = String(row.goal ?? '').slice(0, 120)
  const app = h('input', { class: 'qp-input', placeholder: '应用 slug（可选，例如 compass）' })
  const caseId = h('input', {
    class: 'qp-input',
    placeholder: '实现的用例编号（可选，例如 CPS-WEB-AUTH-004）'
  })
  return h(
    'div',
    { class: 'rig-section', id: 'capture' },
    h('h3', { class: 'qp-heading-3', text: '固化为规程' }),
    h('p', {
      class: 'qp-caption qp-muted',
      text: '把这项任务里真实执行过的浏览器动作和断言保存为一条规程草稿，之后可以不经模型反复重放。关联用例编号后，每次试车都记为该应用的执行、进入质量报告。'
    }),
    h('div', { class: 'rig-grid-2' }, title, app),
    caseId,
    h('button', {
      class: 'qp-button qp-button--outline qp-button--sm',
      id: 'capture-procedure',
      text: '固化为规程',
      onclick: () =>
        ctx.run(async () => {
          const { procedure, warnings = [] } = await ctx.api('procedure-capture', {
            missionId: row.id,
            title: title.value.trim() || row.goal,
            app: app.value.trim() || null,
            caseId: caseId.value.trim().toUpperCase() || null
          })
          ctx.notice(
            `已保存为规程草稿（${procedure.steps.length} 步）。${warnings.join(' ')} 先试车，通过后再启用。`
          )
          ctx.state.procedureId = procedure.id
          ctx.go('procedures')
        })
    })
  )
}

function repairCard(ctx, row) {
  const proposal = row.proposal
  return h(
    'div',
    { class: 'rig-section', id: 'repair-proposal' },
    h('h3', {
      class: 'qp-heading-3',
      text: `规程修正 · ${JUDGEMENT[proposal.verdict] ?? proposal.verdict}`
    }),
    h('p', { class: 'qp-body-2', text: proposal.rationale }),
    h('p', {
      class: 'qp-caption qp-muted',
      text: proposal.steps
        ? row.proposalPosted
          ? '修正已经过验证试车并提交，等待规程负责人批准。'
          : '修正会在任务结束后自动验证试车，再提交审批。'
        : '判断不是用例问题，规程保持原样；这条判断已提交给规程负责人。'
    }),
    row.procedureBase
      ? h('button', {
          class: 'qp-button qp-button--outline qp-button--sm',
          text: '到规程页查看',
          onclick: () => {
            ctx.state.procedureId = row.procedureBase.id
            ctx.go('procedures')
          }
        })
      : null
  )
}

// -- 钩子 -------------------------------------------------------------------------

const HOOK_EVENTS = {
  'run.finished': { label: '执行结束 → 自动定级', where: '服务端' },
  'procedure.failed': { label: '规程在全部试车中失败 → 自动修正', where: '桌面端' }
}
const FIRE_STATE = {
  pending: ['排队', 'info'],
  running: ['进行中', 'info'],
  done: ['完成', 'success'],
  skipped: ['跳过', 'default'],
  failed: ['未完成', 'warning']
}
const RUN_WORD = {
  failed: '失败',
  blocked: '受阻',
  flaky: '不稳定',
  timeout: '超时',
  expired: '过期'
}

/** The fields a rule is saved with; the service adds the rest. */
const ruleInput = (rule) => ({
  id: rule.id,
  name: rule.name,
  enabled: rule.enabled,
  event: rule.event,
  statuses: rule.statuses,
  apps: rule.apps,
  includeProcedureRuns: rule.includeProcedureRuns,
  agentKey: rule.agentKey,
  maxPerHour: rule.maxPerHour,
  notify: rule.notify
})

export async function hooks(ctx, mount) {
  const data = await ctx.api('hooks')
  const admin = ctx.state.principal?.role === 'admin'
  const save = (rules, message) =>
    ctx.run(async () => {
      await ctx.api('hooks-save', { version: data.version, rules: rules.map(ruleInput) })
      ctx.notice(message)
      await ctx.render()
    })

  mount.append(
    panel(
      '钩子',
      h('p', {
        class: 'qp-body-2 qp-muted',
        text: '钩子让 Rig 在事件发生时自己动手。执行失败或受阻后，服务端由只读的定级 Agent 读证据、提交结构化结论，结论进入质量报告，也可以推送到通知渠道。规程在「全部试车」里失败时，由执行这次试车的桌面端交给规程维护员提出修正，修正仍要人批准。'
      }),
      h(
        'ul',
        { class: 'qp-caption qp-muted' },
        h('li', { text: '钩子任务只能用只读工具：不派发、不取消、不点击，所以不需要任何人确认。' }),
        h('li', {
          text: '同一次执行只会触发一次，几个服务副本同时发现也一样；每条钩子有每小时上限，超出的记为跳过。'
        }),
        h('li', { text: '只对钩子建立之后结束的执行生效，打开钩子不会回头处理历史失败。' })
      )
    )
  )

  const rules = data.rules
  mount.append(
    panel(
      '规则',
      rules.length
        ? table(
            [
              {
                title: '钩子',
                cell: (rule) =>
                  h(
                    'span',
                    { class: 'qp-data-cell' },
                    h('strong', { text: rule.name }),
                    h('small', {
                      text: `${HOOK_EVENTS[rule.event]?.label ?? rule.event} · ${HOOK_EVENTS[rule.event]?.where ?? ''}`
                    })
                  )
              },
              {
                title: '条件',
                cell: (rule) =>
                  h('span', {
                    class: 'qp-caption',
                    text: [
                      rule.event === 'run.finished'
                        ? `状态：${rule.statuses.map((status) => RUN_WORD[status] ?? status).join('、')}`
                        : null,
                      `应用：${rule.apps.length ? rule.apps.join('、') : '全部'}`,
                      rule.event === 'run.finished' && rule.includeProcedureRuns
                        ? '含规程试车'
                        : null,
                      rule.event === 'run.finished'
                        ? `Agent：${data.agents.find((agent) => agent.key === rule.agentKey)?.displayName ?? rule.agentKey}`
                        : null
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  })
              },
              {
                title: '上限 / 通知',
                cell: (rule) =>
                  h('span', {
                    class: 'qp-caption',
                    text: `每小时 ${rule.maxPerHour} 次${rule.notify ? ' · 推送结论' : ''}`
                  })
              },
              {
                title: '',
                cell: (rule) =>
                  admin
                    ? h(
                        'span',
                        { class: 'qp-row' },
                        h('button', {
                          class: 'qp-button qp-button--ghost qp-button--sm',
                          text: rule.enabled ? '停用' : '启用',
                          onclick: () =>
                            save(
                              rules.map((entry) =>
                                entry.id === rule.id ? { ...entry, enabled: !rule.enabled } : entry
                              ),
                              rule.enabled ? `已停用「${rule.name}」。` : `已启用「${rule.name}」。`
                            )
                        }),
                        h('button', {
                          class: 'qp-button qp-button--ghost qp-button--sm',
                          text: '删除',
                          onclick: () =>
                            save(
                              rules.filter((entry) => entry.id !== rule.id),
                              `已删除「${rule.name}」。`
                            )
                        })
                      )
                    : h('span', {
                        class: 'qp-caption qp-muted',
                        text: rule.enabled ? '启用中' : '已停用'
                      })
              }
            ],
            rules,
            { layout: 'hooks' }
          )
        : empty(
            admin
              ? '还没有钩子。在下面新建一条，例如「执行失败 → 自动定级」。'
              : '还没有钩子；由管理员建立。'
          ),
      admin ? hookForm(data, (rule) => save([...rules, rule], `已建立「${rule.name}」。`)) : null,
      admin
        ? h('button', {
            class: 'qp-button qp-button--outline qp-button--sm',
            id: 'hooks-tick',
            text: '立即检查一次',
            onclick: () =>
              ctx.run(async () => {
                const { tick } = await ctx.api('hooks-tick', {})
                ctx.notice(
                  `检查完成：新触发 ${tick.claimed} 次，跳过 ${tick.skipped} 次，收尾 ${tick.settled} 个任务${tick.started ? '，已启动一个定级任务' : ''}。`
                )
                await ctx.render()
              })
          })
        : null
    )
  )

  mount.append(
    panel(
      '钩子做了什么',
      data.fires.length
        ? table(
            [
              {
                title: '时间 / 钩子',
                cell: (fire) =>
                  h(
                    'span',
                    { class: 'qp-data-cell' },
                    h('span', { class: 'qp-caption', text: ago(fire.createdAt) }),
                    h('small', { text: fire.ruleName })
                  )
              },
              {
                title: '对象',
                cell: (fire) =>
                  h('span', {
                    class: 'qp-caption',
                    text:
                      fire.kind === 'repair'
                        ? `规程「${fire.procedure?.title ?? ''}」试车 ${fire.subjectId}`
                        : `执行 ${fire.run?.id ?? fire.subjectId}（${RUN_WORD[fire.run?.status] ?? fire.run?.status}${fire.run?.app ? ` · ${fire.run.app}` : ''}）`
                  })
              },
              {
                title: '状态',
                cell: (fire) => tone(...(FIRE_STATE[fire.status] ?? [fire.status, 'default']))
              },
              {
                title: '结果',
                cell: (fire) =>
                  h('span', {
                    class: fire.status === 'done' ? 'qp-caption' : 'qp-caption qp-muted',
                    text: fire.finding
                      ? `${VERDICT_TEXT[fire.finding.verdict]?.label ?? fire.finding.verdict}（${fire.finding.confidence}）：${fire.finding.summary}${fire.finding.unverified ? ` · ${fire.finding.unverified} 个引用未核实` : ''}`
                      : fire.kind === 'repair' && fire.proposalId
                        ? `已提出修正 ${fire.proposalId}，验证试车${fire.validation === 'passed' ? '通过' : fire.validation ? '未通过' : '未进行'}；到「试验规程」审批`
                        : (fire.reason ??
                          fire.answer ??
                          (fire.status === 'running' ? '定级中……' : '—'))
                  })
              }
            ],
            data.fires,
            { layout: 'hook-fires' }
          )
        : empty('还没有触发过。')
    )
  )
}

function hookForm(data, onSave) {
  const name = h('input', {
    class: 'qp-input',
    id: 'hook-name',
    placeholder: '名称，例如「回归失败自动定级」'
  })
  const event = h(
    'select',
    { class: 'qp-input', id: 'hook-event' },
    ...Object.entries(HOOK_EVENTS).map(([value, meta]) => h('option', { value, text: meta.label }))
  )
  const statusBoxes = Object.entries(RUN_WORD).map(([value, label]) => {
    const box = h('input', { type: 'checkbox', value })
    box.checked = value === 'failed'
    return { value, box, label }
  })
  const apps = h('input', {
    class: 'qp-input',
    placeholder: '只看这些应用（slug，逗号分隔；留空为全部）'
  })
  const agent = h(
    'select',
    { class: 'qp-input', id: 'hook-agent' },
    ...data.agents.map((entry) => h('option', { value: entry.key, text: entry.displayName }))
  )
  agent.value = data.agents.some((entry) => entry.key === 'failure-triage')
    ? 'failure-triage'
    : (data.agents[0]?.key ?? '')
  const includeProcedures = h('input', { type: 'checkbox' })
  const notify = h('input', { type: 'checkbox' })
  const perHour = h('input', { class: 'qp-input', type: 'number', min: '1', max: '60' })
  perHour.value = '6'
  const choice = (input, text) =>
    h(
      'label',
      { class: 'qp-choice qp-choice--checkbox' },
      input,
      h('span', { class: 'qp-choice__control' }),
      h('span', { text })
    )
  const triageOnly = h(
    'div',
    { class: 'qp-stack qp-stack--tight' },
    h(
      'div',
      { class: 'qp-row rig-procedure-actions' },
      h('span', { class: 'qp-caption', text: '执行状态：' }),
      ...statusBoxes.map((entry) => choice(entry.box, entry.label))
    ),
    h(
      'label',
      { class: 'qp-field' },
      h('span', { class: 'qp-field__label', text: '定级 Agent（只列出只读的）' }),
      agent
    ),
    choice(includeProcedures, '也处理规程试车记下的执行（规程失败默认由修正流程处理）'),
    choice(notify, '把结论推送到通知渠道（订阅了「讲评」事件的渠道）')
  )
  event.onchange = () => {
    triageOnly.hidden = event.value !== 'run.finished'
  }
  return h(
    'details',
    { class: 'rig-section', id: 'hook-form' },
    h('summary', { text: '新建钩子' }),
    h('div', { class: 'rig-grid-2' }, name, event),
    triageOnly,
    h(
      'div',
      { class: 'rig-grid-2' },
      apps,
      h(
        'label',
        { class: 'qp-field' },
        h('span', { class: 'qp-field__label', text: '每小时最多触发' }),
        perHour
      )
    ),
    h('button', {
      class: 'qp-button qp-button--primary qp-button--sm',
      id: 'hook-save',
      text: '保存钩子',
      onclick: () =>
        onSave({
          name: name.value.trim() || HOOK_EVENTS[event.value].label,
          enabled: true,
          event: event.value,
          statuses: statusBoxes.filter((entry) => entry.box.checked).map((entry) => entry.value),
          apps: apps.value
            .split(/[,，\s]+/)
            .map((value) => value.trim())
            .filter(Boolean),
          includeProcedureRuns: includeProcedures.checked,
          agentKey: agent.value || 'failure-triage',
          maxPerHour: Number(perHour.value) || 6,
          notify: notify.checked
        })
    })
  )
}
