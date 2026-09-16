/**
 * 对话式下任务：把一句话解析成候选派发。
 *
 * This is the deliberately unglamorous half of "conversational". It runs no
 * model, and it decides nothing: given free text and the catalogues the member
 * can already see, it returns candidate missions with the exact request body
 * the workbench would post, what it matched on, and what is still missing.
 * The member confirms one — or none.
 *
 * Three reasons it is not a model call:
 *
 * - A model that picks a test plan for you is a model that can pick the wrong
 *   one, and dispatch is a write action. The confirmation step has to show a
 *   plan id that came from somewhere auditable.
 * - It has to work before a Provider is configured, because "跑一下登录验收"
 *   is what a new member types on day one.
 * - The reasons must be listable. "matched 登录验收 against plan tsk_..." is
 *   something a person can check; a soft judgement is not.
 *
 * Pure module: catalogues in, proposals out.
 */

/**
 * Split text into comparable pieces.
 *
 * Latin runs become whole words. CJK has no spaces, so a run becomes its
 * 2-character shingles plus the run itself — that way 「登录验收」 in a plan
 * name matches 「的登录验收」 in a sentence without a segmenter, and a single
 * shared character is never enough on its own.
 */
export function pieces(value) {
  const text = String(value ?? '').toLowerCase()
  const out = new Set()
  for (const match of text.matchAll(/[a-z0-9]+/g)) if (match[0].length > 1) out.add(match[0])
  for (const match of text.matchAll(/[㐀-鿿぀-ヿ]+/g)) {
    const run = match[0]
    if (run.length <= 4) out.add(run)
    for (let index = 0; index + 2 <= run.length; index += 1) out.add(run.slice(index, index + 2))
  }
  return out
}

/** How much of a candidate's name the sentence actually contains. */
export function overlap(nameText, sentencePieces) {
  const own = pieces(nameText)
  if (!own.size) return { ratio: 0, hits: [] }
  const hits = [...own].filter((piece) => sentencePieces.has(piece))
  return { ratio: hits.length / own.size, hits }
}

// Verbs, not topics. A sentence names what to do ("跑", "分析") far more
// reliably than it names which surface it belongs to.
const VERBS = {
  workflow: [
    '跑一',
    '跑下',
    '跑个',
    '跑通',
    '跑一下',
    '执行',
    '派发',
    '发起',
    '运行',
    '冒烟',
    '回归',
    'run',
    'dispatch',
    'smoke'
  ],
  agent: [
    '分析',
    '定级',
    '排查',
    '诊断',
    '看看',
    '为什么',
    '为啥',
    '解释',
    '总结',
    '归因',
    '读一下',
    'why',
    'triage',
    'analyze',
    'analyse'
  ],
  orchestration: ['编排', '流程', '巡检', '双轨', '先查', '有人接', 'orchestration', 'pipeline']
}

const RUN_ID =
  /\b(trun_[a-z0-9_-]{2,60}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i
const TASK_ID = /\b(tsk_[a-z0-9_-]{2,60})\b/i

const CONFIDENCE = { high: 3, medium: 2, low: 1 }

function verbHits(text) {
  const lower = text.toLowerCase()
  const found = {}
  for (const [kind, words] of Object.entries(VERBS)) {
    // Longest first: 「跑一下」 is what the member wrote, 「跑一」 is only the
    // stem that happened to match, and the reason line is read by a person.
    const hits = words.filter((word) => lower.includes(word)).sort((a, b) => b.length - a.length)
    if (hits.length) found[kind] = hits
  }
  return found
}

/**
 * @param {object} input
 * @param {string} input.text                What the member typed.
 * @param {Array}  input.tasks               Test plans they can see.
 * @param {Array}  input.apps                Registered applications.
 * @param {Array}  input.orchestrations      Enabled orchestration specs.
 * @param {Array}  input.agents              Enabled agents (with effectiveTools).
 * @param {number} input.runnersOnline       Online runner count, for warnings.
 * @param {boolean} input.modelConfigured    Whether the Agent path can run at all.
 * @param {boolean} input.native             Desktop surface (desktop-only agents).
 */
export function planDispatch({
  text = '',
  tasks = [],
  apps = [],
  orchestrations = [],
  agents = [],
  runnersOnline = 0,
  modelConfigured = false,
  native = false
} = {}) {
  const sentence = String(text).trim()
  const said = pieces(sentence)
  const verbs = verbHits(sentence)
  const appById = new Map(apps.map((app) => [app.id, app]))
  const runId = sentence.match(RUN_ID)?.[1] ?? null
  const explicitTask = sentence.match(TASK_ID)?.[1] ?? null

  // -- which plan, if any ------------------------------------------------------
  const scoredTasks = tasks
    .map((task) => {
      const app = appById.get(task.appId)
      const name = overlap(task.name || task.id, said)
      const appName = app ? overlap(app.displayName || app.slug, said) : { ratio: 0, hits: [] }
      const track = [task.profile, task.track].filter(Boolean).map((v) => String(v).toLowerCase())
      const trackHit = track.filter((value) => said.has(value))
      const because = []
      if (explicitTask && task.id === explicitTask) because.push(`句子里写了计划 ID ${task.id}`)
      if (name.hits.length) because.push(`计划名匹配「${name.hits.join('、')}」`)
      if (appName.hits.length)
        because.push(`应用名匹配「${appName.hits.join('、')}」（${app.displayName || app.slug}）`)
      if (trackHit.length) because.push(`轨道匹配 ${trackHit.join(' / ')}`)
      return {
        task,
        because,
        score:
          (explicitTask && task.id === explicitTask ? 10 : 0) +
          name.ratio * 3 +
          appName.ratio +
          trackHit.length * 0.5
      }
    })
    .filter((entry) => entry.score > 0.4)
    .sort((a, b) => b.score - a.score)

  const proposals = []
  const warnings = []
  if (runnersOnline === 0)
    warnings.push('当前没有在线执行机：派发会创建一条等待执行机的 Run，不是测试失败。')

  const best = scoredTasks[0]
  const wantsRun = Boolean(verbs.workflow)
  if (best || wantsRun) {
    const confident = best && (best.score >= 3 || explicitTask)
    const because = [
      ...(verbs.workflow ? [`句子里有派发动作「${verbs.workflow[0]}」`] : []),
      ...(best ? best.because : [])
    ]
    proposals.push({
      kind: 'workflow',
      title: best ? `派发测试计划：${best.task.name || best.task.id}` : '派发一个测试计划',
      goal: sentence || `执行测试计划：${best?.task.name ?? ''}`.trim(),
      body: {
        mode: 'workflow',
        goal: sentence,
        ...(best ? { taskId: best.task.id } : {})
      },
      because: because.length ? because : ['没有匹配到具体计划，只识别出这是一次派发'],
      missing: best ? [] : ['taskId'],
      candidates: best
        ? scoredTasks.slice(1, 4).map((entry) => ({
            id: entry.task.id,
            label: entry.task.name || entry.task.id
          }))
        : tasks.slice(0, 8).map((task) => ({ id: task.id, label: task.name || task.id })),
      confidence: confident ? 'high' : best ? 'medium' : 'low',
      blocked: tasks.length ? null : '还没有测试计划可派发；先在测试管理台建计划。',
      warnings: [...warnings],
      note: '派发是写动作：确认页会显示 tests_run 的完整参数，派发成功不代表测试通过。'
    })
  }

  // -- which orchestration -----------------------------------------------------
  const scoredFlows = orchestrations
    .map((spec) => {
      const name = overlap(`${spec.displayName} ${spec.summary}`, said)
      const because = name.hits.length ? [`编排名匹配「${name.hits.slice(0, 4).join('、')}」`] : []
      return { spec, because, score: name.ratio * 3 + (verbs.orchestration ? 0.6 : 0) }
    })
    .filter((entry) => entry.score > 0.5)
    .sort((a, b) => b.score - a.score)
  const flow = scoredFlows[0]
  if (flow) {
    // Fill only what was actually matched. A task-kind input gets the plan the
    // sentence named; everything else stays missing on purpose.
    const inputs = {}
    const missing = []
    for (const declared of flow.spec.inputs ?? []) {
      if (declared.kind === 'task' && best) inputs[declared.name] = best.task.id
      else if (declared.kind === 'run' && runId) inputs[declared.name] = runId
      else if (declared.required) missing.push(declared.name)
    }
    proposals.push({
      kind: 'orchestration',
      title: `运行编排：${flow.spec.displayName}`,
      goal: sentence,
      body: {
        mode: 'orchestration',
        goal: sentence,
        orchestrationKey: flow.spec.key,
        ...(Object.keys(inputs).length ? { inputs } : {})
      },
      because: [
        ...(verbs.orchestration ? [`句子里提到编排/流程`] : []),
        ...flow.because,
        ...(Object.keys(inputs).length
          ? [`已按匹配结果填入 ${Object.keys(inputs).join('、')}`]
          : [])
      ],
      missing,
      candidates: (flow.spec.inputs ?? [])
        .filter((declared) => missing.includes(declared.name))
        .map((declared) => ({ id: declared.name, label: `${declared.label}（${declared.kind}）` })),
      confidence: flow.score >= 2.5 ? 'high' : 'medium',
      blocked: flow.spec.missingTools?.length
        ? `这条编排需要未被允许的工具：${flow.spec.missingTools.join('、')}`
        : null,
      warnings: [...warnings],
      note: '编排按它保存时的那一版执行；带写工具的节点仍会停在确认。'
    })
  }

  // -- which agent -------------------------------------------------------------
  const usable = agents.filter((agent) => agent.surface !== 'desktop' || native)
  const scoredAgents = usable
    .map((agent) => {
      const name = overlap(`${agent.displayName} ${agent.summary}`, said)
      return {
        agent,
        because: name.hits.length
          ? [`Agent 名称/说明匹配「${name.hits.slice(0, 4).join('、')}」`]
          : [],
        score: name.ratio * 3 + (verbs.agent ? 0.8 : 0)
      }
    })
    .filter((entry) => entry.score > 0.5)
    .sort((a, b) => b.score - a.score)
  const agent = scoredAgents[0]?.agent ?? (verbs.agent ? usable[0] : null)
  if (agent && (verbs.agent || scoredAgents.length)) {
    const because = [
      ...(verbs.agent ? [`句子里有分析动作「${verbs.agent[0]}」`] : []),
      ...(scoredAgents[0]?.because ?? []),
      ...(runId ? [`引用了 run ID ${runId}`] : [])
    ]
    proposals.push({
      kind: 'agent',
      title: `交给 Agent：${agent.displayName}`,
      goal: sentence,
      body: { mode: 'agent', goal: sentence, agentKey: agent.key },
      because: because.length ? because : ['按默认 Agent 处理'],
      missing: runId || !verbs.agent ? [] : ['run'],
      candidates: usable.slice(0, 6).map((entry) => ({ id: entry.key, label: entry.displayName })),
      confidence: scoredAgents[0]?.score >= 2.5 ? 'high' : verbs.agent ? 'medium' : 'low',
      blocked: !modelConfigured
        ? '还没有可用的模型 Provider；这条会明确受阻，不会假装给结论。'
        : agent.effectiveTools?.length === 0
          ? 'Internal 允许列表没有放开这个 Agent 需要的工具。'
          : null,
      warnings: [],
      note: 'Agent 每步只允许一个工具调用；写动作仍然逐次确认。'
    })
  }

  proposals.sort(
    (a, b) =>
      CONFIDENCE[b.confidence] - CONFIDENCE[a.confidence] ||
      (a.blocked ? 1 : 0) - (b.blocked ? 1 : 0) ||
      a.missing.length - b.missing.length
  )
  return {
    text: sentence,
    proposals: proposals.slice(0, 3),
    verbs: Object.keys(verbs),
    note: proposals.length
      ? '解析不调用模型，也不会执行任何动作：选一个候选并确认后才真正派发。'
      : '没能把这句话对上任何计划、编排或 Agent。可以直接选一个测试计划，或换成「跑 <计划名>」「分析 <run ID>」这样的说法。'
  }
}
