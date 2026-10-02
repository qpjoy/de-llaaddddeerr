import { randomUUID } from 'node:crypto'
import {
  GATE_METRICS,
  NODE_TYPES,
  OrchestrationError,
  PREFLIGHT_CHECKS,
  STAGES,
  orchestrationSpec,
  validateOrchestration
} from '../../packages/graph/orchestration.mjs'
import { overlap, pieces } from './dispatch-intent.mjs'

/**
 * Flight Director: a sentence in, a flight plan out — as a draft a person
 * reviews, never as something that runs on its own.
 *
 * Two ways to get there, with the same checks at the end:
 *
 * - A template, with no model at all: match the sentence against the test
 *   plans the member can see, and lay them out as pre-flight → static fire →
 *   gate → (regression → gate) → debrief. Works on day one.
 * - A model, when one is configured: it is shown the node palette and the
 *   real catalogue, and asked for JSON. Whatever comes back is validated as a
 *   graph and every plan id it names must exist; a draft that fails twice is
 *   replaced by the template, with a warning saying so.
 *
 * Either way the result is an orchestration spec — data in a closed palette,
 * the same thing an admin draws by hand.
 */

const REGRESSION_WORDS = ['回归', '全量', 'regression']
const EXPLORE_WORDS = ['探索', '巡检', '页面', '点一点', '看看', '走一遍', '检查页面']
const NOTIFY_WORDS = ['通知', '飞书', '推送', '发群', '群里', '企业微信']
const PROCEDURE_WORDS = ['规程', '试车', 'procedure']
const PROCEDURES_PER_STAGE = 5
const MAX_CATALOGUE = 40

const mentions = (text, words) => words.some((word) => text.toLowerCase().includes(word))

/** Test plans ranked by how much of their name (and app) the sentence contains. */
export function rankTasks(text, tasks, apps) {
  const sentence = pieces(text)
  return tasks
    .filter((task) => task.enabled !== false)
    .map((task) => {
      const app = apps.find((entry) => entry.id === task.appId)
      const byName = overlap(task.name, sentence)
      const byApp = app
        ? overlap(`${app.displayName ?? ''} ${app.slug ?? ''}`, sentence)
        : { ratio: 0 }
      return { task, app, score: byName.ratio * 2 + byApp.ratio }
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
}

/** Active procedures ranked by how much of their title, app and case the sentence names. */
export function rankProcedures(text, procedures = []) {
  const sentence = pieces(text)
  return procedures
    .filter((entry) => entry.status === 'active')
    .map((entry) => ({
      entry,
      score: overlap(`${entry.title} ${entry.app ?? ''} ${entry.caseId ?? ''}`, sentence).ratio
    }))
    .filter((ranked) => ranked.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((ranked) => ranked.entry)
}

function draftKey() {
  return `flight-${randomUUID().slice(0, 8)}`
}

function title(text, max = 60) {
  const clean = String(text).replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean || '飞行计划'
}

/** The plan a person would sketch from the sentence, with no model involved. */
export function templatePlan({
  text,
  tasks,
  apps,
  suites = [],
  desktop = false,
  browserReady = false,
  procedures = []
}) {
  const ranked = rankTasks(text, tasks, apps)
  // A plan's own name says which stage it belongs to: a smoke plan fires
  // first, a regression plan comes after. Relevance only breaks ties.
  const smokeNamed = (entry) => /冒烟|smoke|静态点火/i.test(entry.task.name)
  const regressionNamed = (entry) => /回归|全量|regression/i.test(entry.task.name)
  const smoke =
    ranked.find(smokeNamed) ?? ranked.find((entry) => !regressionNamed(entry)) ?? ranked[0] ?? null
  const regression = mentions(text, REGRESSION_WORDS)
    ? (ranked.find((entry) => entry !== smoke && regressionNamed(entry)) ??
      ranked.find((entry) => entry !== smoke) ??
      null)
    : null
  const explore = desktop && browserReady && mentions(text, EXPLORE_WORDS)
  // Reviewed procedures that match the sentence replay in the static-fire
  // stage — on the desktop, where the browser station is.
  const replays = desktop ? rankProcedures(text, procedures).slice(0, PROCEDURES_PER_STAGE) : []
  const notify = mentions(text, NOTIFY_WORDS)
  const electron = [smoke, regression]
    .filter(Boolean)
    .some(
      (entry) => suites.find((suite) => suite.id === entry.task.suiteId)?.surface === 'electron'
    )

  const nodes = []
  const chain = []
  const taskIds = [smoke, regression].filter(Boolean).map((entry) => entry.task.id)
  nodes.push({
    id: 'tminus',
    type: 'preflight',
    title: 'T-minus 预检',
    stage: 'tminus',
    taskIds,
    checks: [
      ...(taskIds.length ? ['runners', 'production'] : []),
      ...(electron ? ['package'] : []),
      ...(explore ? ['browser', 'model'] : [])
    ].filter((value, index, list) => list.indexOf(value) === index),
    onNoGo: null,
    next: null
  })
  if (!nodes[0].checks.length) nodes[0].checks = ['model']
  chain.push(nodes[0])
  if (smoke) {
    nodes.push({
      id: 'static_fire',
      type: 'flight',
      title: `Static Fire · ${smoke.task.name}`.slice(0, 60),
      stage: 'static-fire',
      taskId: smoke.task.id,
      waitMinutes: 30,
      next: null
    })
    nodes.push({
      id: 'static_fire_gate',
      type: 'gate',
      title: '冒烟放行',
      stage: 'static-fire',
      criteria: [
        { metric: 'run_passed', stage: 'static_fire' },
        { metric: 'blocked_none', stage: 'static_fire' }
      ],
      confirm: false,
      onFail: null,
      next: null
    })
    chain.push(nodes.at(-2), nodes.at(-1))
  }
  if (replays.length) {
    nodes.push({
      id: 'procedures',
      type: 'procedure',
      title: `规程试车 · ${replays.length} 条`,
      stage: 'static-fire',
      procedureIds: replays.map((entry) => entry.id),
      next: null
    })
    nodes.push({
      id: 'procedures_gate',
      type: 'gate',
      title: '规程放行',
      stage: 'static-fire',
      criteria: [{ metric: 'procedures_passed', stage: 'procedures' }],
      confirm: false,
      onFail: null,
      next: null
    })
    chain.push(nodes.at(-2), nodes.at(-1))
  }
  if (explore) {
    nodes.push({
      id: 'explore',
      type: 'explore',
      title: '探索巡检',
      stage: 'flight',
      goal: title(text, 2000),
      maxTurns: 8,
      next: null
    })
    nodes.push({
      id: 'explore_gate',
      type: 'gate',
      title: '探索放行',
      stage: 'flight',
      criteria: [{ metric: 'assertions_all_passed', stage: 'explore' }],
      confirm: false,
      onFail: null,
      next: null
    })
    chain.push(nodes.at(-2), nodes.at(-1))
  }
  if (regression) {
    nodes.push({
      id: 'regression',
      type: 'flight',
      title: `Regression · ${regression.task.name}`.slice(0, 60),
      stage: 'regression',
      taskId: regression.task.id,
      waitMinutes: 120,
      next: null
    })
    nodes.push({
      id: 'regression_gate',
      type: 'gate',
      title: '回归放行',
      stage: 'regression',
      criteria: [{ metric: 'failed_max', stage: 'regression', value: 0 }],
      confirm: true,
      onFail: null,
      next: null
    })
    chain.push(nodes.at(-2), nodes.at(-1))
  }
  nodes.push({
    id: 'debrief',
    type: 'debrief',
    title: 'Debrief 讲评',
    stage: 'debrief',
    notify,
    next: null
  })
  chain.push(nodes.at(-1))
  // Wire the chain; a failed gate or pre-flight still ends in the debrief, so
  // the report exists whichever way the flight went.
  for (let index = 0; index < chain.length - 1; index += 1) chain[index].next = chain[index + 1].id
  for (const node of nodes) {
    if (node.type === 'gate') node.onFail = 'debrief'
    if (node.type === 'preflight') node.onNoGo = 'debrief'
  }
  const spec = orchestrationSpec.parse({
    key: draftKey(),
    displayName: title(text),
    summary: title(
      `由一句话生成：${[smoke && '冒烟', replays.length && '规程试车', explore && '探索', regression && '回归'].filter(Boolean).join('、') || '仅预检'}，最后讲评`,
      240
    ),
    entry: 'tminus',
    nodes
  })
  return {
    spec,
    matched: [smoke, regression]
      .filter(Boolean)
      .map((entry) => ({
        taskId: entry.task.id,
        name: entry.task.name,
        app: entry.app?.displayName ?? null
      })),
    procedures: replays.map((entry) => ({ id: entry.id, title: entry.title })),
    warnings: [
      ...(smoke || replays.length
        ? []
        : ['没有找到和这句话匹配的测试计划，草稿只包含预检与讲评，请手动加上架次。']),
      ...(mentions(text, PROCEDURE_WORDS) && !replays.length
        ? [
            desktop
              ? '想要规程试车，但没有找到和这句话匹配的已启用规程。'
              : '规程试车只能在桌面端执行，已跳过；在桌面端生成可以包含规程阶段。'
          ]
        : []),
      ...(mentions(text, EXPLORE_WORDS) && !explore
        ? [
            desktop
              ? '想要页面探索，但浏览器工具或 origin 尚未被允许，已跳过探索阶段。'
              : '页面探索只能在桌面端执行，已跳过；在桌面端生成可以包含探索阶段。'
          ]
        : [])
    ]
  }
}

/** What the model is told: the palette, the rules, and only real ids. */
export function directorPrompt({
  text,
  tasks,
  apps,
  suites,
  desktop,
  browserOrigins,
  browserSites = 'ask',
  procedures = []
}) {
  const catalogue = tasks
    .filter((task) => task.enabled !== false)
    .slice(0, MAX_CATALOGUE)
    .map((task) => {
      const app = apps.find((entry) => entry.id === task.appId)
      const suite = suites.find((entry) => entry.id === task.suiteId)
      return `- ${task.id}｜${task.name}｜应用 ${app?.displayName ?? app?.slug ?? '?'}｜${suite?.engine ?? '?'} × ${suite?.surface ?? '?'}`
    })
    .join('\n')
  const reviewed = desktop
    ? procedures
        .filter((entry) => entry.status === 'active')
        .slice(0, MAX_CATALOGUE)
        .map(
          (entry) =>
            `- ${entry.id}｜${entry.title}${entry.app ? `｜应用 ${entry.app}` : ''}${entry.caseId ? `｜用例 ${entry.caseId}` : ''}`
        )
        .join('\n')
    : ''
  const palette = ['preflight', 'flight', 'procedure', 'explore', 'gate', 'debrief', 'finish']
    .map((type) => `- ${type}：${NODE_TYPES[type].title}。${NODE_TYPES[type].hint}`)
    .join('\n')
  // One user message: the gateway keeps system messages for its own fixed
  // rules and for server-resolved personas, and refuses them from callers.
  return [
    {
      role: 'user',
      content: `你是 MX Rig 的 Flight Director，把测试需求写成一份飞行计划（JSON）。只输出一个 \`\`\`json 代码块，不要解释。

可用节点类型（闭合集合，不能发明新类型）：
${palette}

字段约定：
- 顶层：key（小写字母数字与 -）、displayName、summary、entry（入口节点 id）、nodes（最多 24 个）。
- 每个节点：id（小写字母开头，字母数字下划线）、type、title、stage（${Object.keys(STAGES).join(' / ')}）。
- preflight：taskIds（数组）、checks（${Object.keys(PREFLIGHT_CHECKS).join(' / ')}）、onNoGo（节点 id 或 null）、next。
- flight：taskId（必须来自下方清单）、waitMinutes（1–180）、next。
- procedure：procedureIds（数组，必须来自下方规程清单）、next。${desktop ? '' : '当前不是桌面端，不要使用 procedure。'}
- explore：goal、maxTurns（1–20）、next。${desktop ? '' : '当前不是桌面端，不要使用 explore。'}
- gate：criteria（metric：${Object.keys(GATE_METRICS).join(' / ')}；stage：被评审的节点 id；failed_max 与 pass_rate_min 需要 value）、confirm、onFail、next。
- debrief：notify（布尔）、next。
- next 为 null 表示结束。

规则：第一个节点是 preflight；每个 flight 或 procedure 后面跟一个 gate；最后是 debrief；gate 的 onFail 与 preflight 的 onNoGo 指向 debrief，让报告总能生成。只使用清单里的测试计划 id。

需求：${text}

可用测试计划：
${catalogue || '（没有）'}

已启用的试验规程（无模型重放，每条记为一次执行）：
${reviewed || '（没有）'}

预先允许的站点：${browserOrigins.length ? browserOrigins.join('、') : '（没有）'}${
        browserSites === 'list' ? '（只允许这些站点）' : '；其他站点在任务里第一次打开时由发起人确认'
      }`
    }
  ]
}

/** Pull the plan out of a reply and hold it to the same rules as a drawn one. */
export function checkDraft(content, { tasks, desktop, procedures = [] }) {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(String(content ?? ''))
  let raw
  try {
    raw = JSON.parse((fenced ? fenced[1] : String(content ?? '')).trim())
  } catch {
    throw new OrchestrationError('回复不是 JSON')
  }
  if (raw && typeof raw === 'object') {
    raw.key = /^[a-z0-9][a-z0-9_-]*$/.test(raw.key ?? '') ? raw.key : draftKey()
    delete raw.schedule
    delete raw.authorize
  }
  // A reply of the wrong shape is a draft to correct, not a crash: report it
  // the same way a structural mistake is reported.
  const shaped = orchestrationSpec.safeParse(raw)
  if (!shaped.success) {
    const issue = shaped.error.issues[0]
    throw new OrchestrationError(
      `格式不符（${issue?.path?.join('.') || '根'}：${issue?.message ?? '无效'}）`
    )
  }
  const { spec } = validateOrchestration(shaped.data, {})
  const known = new Set(tasks.map((task) => task.id))
  const reviewed = new Set(
    procedures.filter((entry) => entry.status === 'active').map((entry) => entry.id)
  )
  for (const node of spec.nodes) {
    if (node.type === 'subflow' || node.type === 'tool' || node.type === 'fanout')
      throw new OrchestrationError(`草稿不能使用 ${node.type} 节点`, node.id)
    if (node.type === 'explore' && !desktop)
      throw new OrchestrationError('当前不是桌面端，草稿不能包含 explore', node.id)
    if (node.type === 'procedure') {
      if (!desktop) throw new OrchestrationError('当前不是桌面端，草稿不能包含 procedure', node.id)
      for (const id of node.procedureIds)
        if (!reviewed.has(id))
          throw new OrchestrationError(
            `规程试车 ${node.id} 引用了不存在或未启用的规程 ${id}`,
            node.id
          )
    }
    if (node.type === 'flight' && !known.has(node.taskId))
      throw new OrchestrationError(`架次 ${node.id} 引用了不存在的测试计划 ${node.taskId}`, node.id)
    if (node.type === 'preflight')
      for (const id of node.taskIds)
        if (!known.has(id))
          throw new OrchestrationError(`预检 ${node.id} 引用了不存在的测试计划 ${id}`, node.id)
  }
  return spec
}

/**
 * Draft a plan. `turn` is the model gateway (null when none is configured);
 * the catalogue is what the caller is allowed to see.
 */
export async function draftFlightPlan({
  text,
  tasks,
  apps,
  suites,
  desktop = false,
  browserReady = false,
  browserOrigins = [],
  browserSites = 'ask',
  procedures = [],
  turn = null,
  signal
}) {
  const template = () =>
    templatePlan({ text, tasks, apps, suites, desktop, browserReady, procedures })
  if (!turn) return { ...template(), source: 'template' }
  const messages = directorPrompt({
    text,
    tasks,
    apps,
    suites,
    desktop,
    browserOrigins,
    browserSites,
    procedures
  })
  let lastError = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const { message } = await turn({ messages, tools: [] }, signal)
    try {
      const spec = checkDraft(message.content, { tasks, desktop, procedures })
      return { spec, source: 'model', matched: [], warnings: [] }
    } catch (error) {
      if (!(error instanceof OrchestrationError)) throw error
      lastError = error.message
      messages.push(
        { role: 'assistant', content: message.content ?? '' },
        { role: 'user', content: `这份计划没有通过校验：${error.message}。请修正后只输出 JSON。` }
      )
    }
  }
  const fallback = template()
  return {
    ...fallback,
    source: 'template',
    warnings: [`模型草稿两次都没有通过校验（${lastError}），已改用模板草稿。`, ...fallback.warnings]
  }
}
