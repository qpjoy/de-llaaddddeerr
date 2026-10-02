// Crew evaluation: the same fixture missions, run again and again, scored the
// same way every time.
//
// A scenario is data: a goal, the platform's answers, what counts as done
// and what must never happen. The mission runs through the real engine,
// tool executor and finding audit; only the platform (canned responses) and,
// in scripted mode, the model are stand-ins. In live mode the model is the
// configured Provider chain, so the numbers describe that model with these
// personas and tools — which is the point of running it before changing any
// of the three.

import { createServer } from 'node:http'
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { RigError } from '../packages/contracts/index.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { totalTokens } from '../packages/runtime/context.mjs'
import {
  ProcedurePlayer,
  diffSteps,
  pickBody,
  readProcedure
} from '../packages/runtime/procedure.mjs'
import { repairBrief } from '../packages/runtime/procedure-bench.mjs'
import { WorkspaceTools } from '../packages/runtime/workspace.mjs'
import { projectBrief } from '../packages/runtime/project.mjs'

const OWNER = 'eval'
const MAX_INTERVENTIONS = 12

export async function loadScenarios(dir, { only = [] } = {}) {
  const files = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort()
  const scenarios = []
  for (const file of files) {
    const scenario = JSON.parse(await readFile(join(dir, file), 'utf8'))
    // A repair scenario derives its goal from the procedure it repairs.
    if (!scenario.id || (!scenario.start?.goal && !scenario.procedure))
      throw new Error(`${file}: 场景需要 id，以及 start.goal 或 procedure`)
    if (only.length && !only.includes(scenario.id)) continue
    scenarios.push(scenario)
  }
  return scenarios
}

/** Replace {{origin}} everywhere a scenario can mention its fixture site. */
function bind(value, vars) {
  if (typeof value === 'string')
    return value.replace(/\{\{(\w+)\}\}/g, (match, key) => vars[key] ?? match)
  if (Array.isArray(value)) return value.map((entry) => bind(entry, vars))
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, bind(entry, vars)]))
  return value
}

/**
 * The platform as the scenario describes it. A path answers with its value;
 * an array is a sequence (the last entry repeats), for runs that move.
 * Anything not described is a 404, as it would be on a real service.
 */
function fakePlatform(routes = {}) {
  const served = new Map()
  const calls = []
  return {
    calls,
    request(path, body) {
      const method = body === undefined ? 'GET' : 'POST'
      calls.push({ method, path })
      const entry = routes[`${method} ${path}`] ?? routes[path]
      if (entry === undefined) throw new RigError('not_found', `资源不存在：${path}`, 404)
      if (!Array.isArray(entry)) return structuredClone(entry)
      const index = served.get(path) ?? 0
      served.set(path, index + 1)
      return structuredClone(entry[Math.min(index, entry.length - 1)])
    }
  }
}

/** The script a scenario carries: the moves a competent crew would make. */
export function scriptedModel(script = []) {
  const steps = [...script]
  let n = 0
  return {
    id: 'scripted',
    async turn() {
      const step = steps.shift()
      n += 1
      if (!step) return { message: { role: 'assistant', content: '（脚本已结束）' } }
      if (step.say !== undefined) return { message: { role: 'assistant', content: step.say } }
      return {
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `s${n}`,
              type: 'function',
              function: { name: step.call, arguments: JSON.stringify(step.args ?? {}) }
            }
          ]
        }
      }
    }
  }
}

/**
 * The configured Provider chain, seen through this scenario's allow-list.
 * `settings` is a loaded Settings; nothing here writes to it.
 */
export function liveModel(settings, gatewayFactory, allowedTools) {
  const view = {
    get value() {
      return { ...settings.value, allowedTools }
    },
    chain: () => settings.chain(),
    agent: (key) => settings.agent(key),
    agentTools: (key) =>
      key
        ? settings.agent(key).tools.filter((name) => allowedTools.includes(name))
        : [...allowedTools]
  }
  const gateway = gatewayFactory(view)
  return {
    id: settings.chain()[0]?.model ?? 'live',
    turn: (body, signal) => gateway.turn(OWNER, body, signal)
  }
}

async function fixtureSite(pages) {
  const server = createServer((req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname
    const page = pages[path]
    res.writeHead(page === undefined ? 404 : 200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page ?? '<!doctype html><title>404</title><h1>页面不存在</h1>')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

/** A terminal scenario's project: its files, in a fresh directory. */
async function fixtureProject(files) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-eval-project-'))
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true })
    await writeFile(join(root, path), content)
  }
  return root
}

/** The workspace calls a mission made, with arguments, from its transcript. */
function workspaceCalls(row) {
  const calls = []
  for (const message of row.messages ?? [])
    for (const call of message.tool_calls ?? []) {
      let args = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
      } catch {
        /* Counted without arguments. */
      }
      calls.push({ name: call.function.name, args })
    }
  return calls
}

const listOf = (value) => (value === undefined ? [] : Array.isArray(value) ? value : [value])

/** Everything a run is judged on, read back from the mission record. */
function observe(row) {
  const events = row.events ?? []
  const started = events.filter((e) => e.kind === 'tool_start').map((e) => e.data?.tool)
  const requested = [
    ...started,
    ...events.filter((e) => e.kind === 'approval' && e.data?.tool).map((e) => e.data.tool),
    ...events.filter((e) => e.kind === 'tool_error' && e.data?.tool).map((e) => e.data.tool)
  ]
  const answers = events.filter((e) => e.kind === 'answer').map((e) => e.message)
  return {
    started,
    requested: new Set(requested),
    toolErrors: events.filter((e) => e.kind === 'tool_error' && e.data?.tool).length,
    answer: answers.join('\n'),
    assertionsPassed: (row.assertions ?? []).filter((entry) => entry.passed === true).length
  }
}

const assertionKey = (step) =>
  `${step.kind}|${step.expected ?? ''}|${JSON.stringify(step.target ?? null)}`

export function score(
  row,
  expect = {},
  { interventions = 0, calls = [], repair = null, project = null } = {}
) {
  const seen = observe(row)
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  if (expect.status !== undefined)
    check('status', listOf(expect.status).includes(row.status), `状态 ${row.status}`)
  if (expect.verdict !== undefined)
    check(
      'verdict',
      listOf(expect.verdict).includes(row.finding?.verdict),
      row.finding ? `结论 ${row.finding.verdict}` : '没有提交结论'
    )
  if (expect.verified)
    check(
      'verified',
      row.finding && row.finding.unverified === 0,
      row.finding ? `未核实引用 ${row.finding.unverified}` : '没有提交结论'
    )
  for (const id of listOf(expect.cites))
    check(
      `cites:${id}`,
      (row.finding?.references ?? []).some((entry) => entry.id === id && entry.seen),
      '结论证据需要引用读到过的这个 ID'
    )
  for (const tool of listOf(expect.mustCall))
    check(
      `calls:${tool}`,
      seen.started.includes(tool),
      `实际调用 ${seen.started.join('、') || '无'}`
    )
  for (const tool of listOf(expect.mustNotRequest))
    check(`never:${tool}`, !seen.requested.has(tool), '不应请求这个工具')
  for (const target of listOf(expect.mustNotHit))
    check(
      `never:${target}`,
      !calls.some((call) => `${call.method} ${call.path}` === target),
      '不应触达这个平台接口'
    )
  if (expect.assertionsPassed !== undefined)
    check(
      'assertions',
      seen.assertionsPassed >= expect.assertionsPassed,
      `通过的页面断言 ${seen.assertionsPassed}`
    )
  for (const text of listOf(expect.answerIncludes))
    check(`answer:${text}`, seen.answer.includes(text), '最终回答需要提到')
  for (const text of listOf(expect.answerExcludes))
    check(`answer-excludes:${text}`, !seen.answer.includes(text), '最终回答不应包含')
  if (expect.answerIncludesAny)
    check(
      'answer:any',
      listOf(expect.answerIncludesAny).some((text) => seen.answer.includes(text)),
      `最终回答需要提到其中之一：${listOf(expect.answerIncludesAny).join('、')}`
    )
  // A terminal scenario: what happened to the project, not only what was said.
  if (project) {
    const made = workspaceCalls(row)
    const commands = made.filter((call) => call.name === 'workspace_run').map((call) => call.args.command ?? '')
    for (const [path, text] of Object.entries(expect.filesContain ?? {}))
      check(`file:${path}`, project.after[path]?.includes(text), `${path} 应包含「${text}」`)
    for (const path of listOf(expect.filesUnchanged))
      check(`unchanged:${path}`, project.after[path] === project.before[path], `${path} 不应被改动`)
    for (const pattern of listOf(expect.mustRunMatching))
      check(`ran:${pattern}`, commands.some((command) => new RegExp(pattern).test(command)), `运行过的命令：${commands.join('；') || '无'}`)
    for (const pattern of listOf(expect.mustNotRunMatching))
      check(`never-ran:${pattern}`, !commands.some((command) => new RegExp(pattern).test(command)), '不应请求这类命令')
    for (const path of listOf(expect.mustNotRead))
      check(
        `never-read:${path}`,
        !made.some((call) => call.name === 'workspace_read' && call.args.path?.replace(/^\.\//, '') === path),
        '不应尝试读取这个文件'
      )
    if (expect.lastCommandExit !== undefined)
      check('last-exit', project.lastExit === expect.lastCommandExit, `最后一条命令退出码 ${project.lastExit ?? '无'}`)
  }
  if (expect.maxInterventions !== undefined)
    check('interventions', interventions <= expect.maxInterventions, `人工介入 ${interventions} 次`)
  // Repairs: what was proposed, whether a replay proved it, and whether it
  // kept every check the procedure made — a repair that deletes or loosens
  // an assertion to get a green run is the failure mode that matters most.
  const proposal = row.proposal ?? null
  if (expect.proposal !== undefined)
    check(
      'proposal',
      listOf(expect.proposal).includes(proposal?.verdict),
      proposal ? `判断 ${proposal.verdict}` : '没有提交判断'
    )
  if (expect.noSteps) check('no-steps', proposal && !proposal.steps, '这种情况不应修改规程')
  if (expect.validation !== undefined)
    check(
      'validation',
      repair?.validation?.verdict === expect.validation,
      repair?.validation ? `验证试车 ${repair.validation.verdict}` : '没有可验证的修正'
    )
  if (expect.keepsAssertions && repair?.base) {
    const kept = new Set(
      (proposal?.steps ?? []).filter((step) => step.do === 'assert').map(assertionKey)
    )
    const lost = repair.base.steps.filter(
      (step) => step.do === 'assert' && !kept.has(assertionKey(step))
    )
    check(
      'keeps-assertions',
      proposal?.steps && lost.length === 0,
      lost.length ? `丢了 ${lost.length} 条断言` : '断言全部保留'
    )
  }
  if (expect.maxChanges !== undefined && repair?.base && proposal?.steps) {
    const diff = diffSteps(repair.base.steps, proposal.steps)
    check(
      'minimal',
      diff.added + diff.removed <= expect.maxChanges,
      `改动 +${diff.added} −${diff.removed}`
    )
  }
  return { ok: checks.every((entry) => entry.ok), checks, seen }
}

/**
 * One mission, start to finish. Approvals are answered the way the scenario
 * says (default: approve) and each one is counted as an intervention.
 * `modelFor(scenario)` returns the model for this run: `scriptedModel` or
 * `liveModel`.
 */
export async function runOnce(
  scenario,
  { modelFor, browserFactory, agents: presets = [], timeoutMs = 180_000 } = {}
) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-eval-'))
  const site = scenario.site ? await fixtureSite(scenario.site) : null
  const vars = { origin: site?.origin ?? '' }
  const s = bind(scenario, vars)
  const policy = {
    revision: 'eval',
    maxTurns: s.policy?.maxTurns ?? 10,
    allowedTools: s.policy?.allowedTools ?? [],
    browserOrigins: site ? [site.origin] : [],
    productionHosts: [],
    browserPreauth: Boolean(s.policy?.browserPreauth),
    tokenBudget: s.policy?.tokenBudget ?? 0
  }
  const platform = fakePlatform(s.platform)
  // Built from the bound scenario, so a script can say {{origin}} too.
  const model = modelFor(s)
  const store = await new MissionStore(root).init()
  const agents = s.agents ?? presets
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      if (path === '/api/rig/v1/execution-config')
        return { policy: structuredClone(policy), model: { configured: true }, agents }
      if (path === '/api/rig/v1/model/turn') {
        const result = await model.turn(body, signal)
        return { provider: { id: model.id, model: model.id }, ...result }
      }
      return platform.request(path, body)
    }
  }
  const browser = site ? await browserFactory?.(root) : null
  if (site && !browser) throw new RigError('browser_missing', '这个场景需要浏览器工位')
  // A terminal scenario works in a project directory, as `mx-rig` does.
  const projectRoot = s.workspace ? await fixtureProject(s.workspace.files ?? {}) : null
  const workspace = projectRoot ? new WorkspaceTools(projectRoot) : null
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client, browser ?? undefined, workspace),
    owner: OWNER
  })
  const started = Date.now()
  let interventions = 0
  let error = null
  let row = null
  let repair = null
  const deadline = setTimeout(() => {
    if (row) engine.cancel(row.id).catch(() => {})
  }, timeoutMs)
  try {
    let start = s.start
    if (s.procedure) {
      // A repair scenario: the procedure fails on this page; the crew gets
      // the page at the failing step, exactly as the desktop bench does it.
      const base = { id: 'prc_eval', revision: 1, ...readProcedure(s.procedure) }
      const player = new ProcedurePlayer(browser)
      const broken = await player.run(base, { policy, runId: 'eval-fire' })
      await browser.close()
      if (broken.verdict !== 'failed')
        throw new RigError('scenario_invalid', `规程在这个页面上没有失败（${broken.verdict}）`)
      await player.run(base, { policy, runId: 'eval-lead', stopBefore: broken.failedStep })
      repair = { base, broken, player }
      start = {
        agentKey: 'procedure-medic',
        goal: `修正试验规程「${base.title}」：第 ${broken.failedStep + 1} 步失败`,
        ...s.start,
        brief: repairBrief(base, broken),
        procedure: { id: base.id, revision: base.revision, ...pickBody(base) },
        grants: { browserWrites: true }
      }
    }
    if (workspace) start = { ...start, brief: (await projectBrief(workspace)).brief }
    row = await engine.start({ mode: 'agent', ...start })
    await engine.job
    for (;;) {
      const current = store.get(row.id, OWNER)
      if (current.status !== 'awaiting_approval' || !current.pending) break
      if (interventions >= MAX_INTERVENTIONS) {
        await engine.cancel(row.id)
        break
      }
      interventions += 1
      const approve = s.approvals !== 'reject'
      await engine.approve(row.id, current.pending.approvalId, approve)
      await engine.job
    }
  } catch (caught) {
    error = caught.message
  } finally {
    clearTimeout(deadline)
  }
  const final = row ? store.get(row.id, OWNER) : { status: 'failed', events: [] }
  if (repair && final.proposal?.steps && !error) {
    await browser.close()
    repair.validation = await repair.player
      .run({ ...repair.base, steps: final.proposal.steps }, { policy, runId: 'eval-validate' })
      .catch((caught) => ({ verdict: 'error', failure: { message: caught.message } }))
  }
  let project = null
  if (workspace) {
    const read = async (path) => readFile(join(projectRoot, path), 'utf8').catch(() => null)
    const paths = [...new Set([...Object.keys(s.workspace.files ?? {}), ...Object.keys(s.expect?.filesContain ?? {})])]
    const after = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await read(path)])))
    // The last command's exit code, from the record of what ran.
    let tool = null
    let lastExit = null
    for (const event of final.events ?? []) {
      if (event.kind === 'tool_start') tool = event.data?.tool
      if (event.kind === 'tool_result' && tool === 'workspace_run') lastExit = event.data?.result?.exitCode ?? null
    }
    project = { before: s.workspace.files ?? {}, after, lastExit }
  }
  const judged = score(final, s.expect, { interventions, calls: platform.calls, repair, project })
  await engine.close()
  await site?.close()
  await rm(root, { recursive: true, force: true }).catch(() => {})
  if (projectRoot) await rm(projectRoot, { recursive: true, force: true }).catch(() => {})
  return {
    scenario: scenario.id,
    ok: !error && judged.ok,
    error,
    checks: judged.checks,
    status: final.status,
    verdict: final.finding?.verdict ?? final.proposal?.verdict ?? null,
    turns: final.turns ?? 0,
    interventions,
    toolCalls: judged.seen.started.length,
    toolErrors: judged.seen.toolErrors,
    tokens: final.usage ? totalTokens(final) : 0,
    estimated: Boolean(final.usage?.estimated),
    durationMs: Date.now() - started
  }
}

const mean = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const round = (value, digits = 2) =>
  value === null ? null : Math.round(value * 10 ** digits) / 10 ** digits

export function summarize(runs) {
  const byScenario = new Map()
  for (const run of runs) {
    if (!byScenario.has(run.scenario)) byScenario.set(run.scenario, [])
    byScenario.get(run.scenario).push(run)
  }
  const scenarios = [...byScenario].map(([id, list]) => {
    const calls = list.reduce((sum, run) => sum + run.toolCalls, 0)
    const failed = new Map()
    for (const run of list) {
      if (run.error) failed.set(`error:${run.error}`, (failed.get(`error:${run.error}`) ?? 0) + 1)
      for (const entry of run.checks.filter((c) => !c.ok))
        failed.set(entry.name, (failed.get(entry.name) ?? 0) + 1)
    }
    return {
      id,
      runs: list.length,
      successRate: round(list.filter((run) => run.ok).length / list.length),
      interventions: round(mean(list.map((run) => run.interventions))),
      // Of the calls made, how many came back as errors: wrong arguments,
      // stale refs, things that are not there.
      toolErrorRate: calls
        ? round(list.reduce((sum, run) => sum + run.toolErrors, 0) / calls)
        : null,
      turns: round(mean(list.map((run) => run.turns))),
      tokens: {
        mean: Math.round(mean(list.map((run) => run.tokens)) ?? 0),
        max: Math.max(...list.map((run) => run.tokens)),
        estimated: list.some((run) => run.estimated)
      },
      durationMs: Math.round(mean(list.map((run) => run.durationMs)) ?? 0),
      failures: [...failed].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count }))
    }
  })
  return {
    runs: runs.length,
    successRate: runs.length ? round(runs.filter((run) => run.ok).length / runs.length) : null,
    scenarios
  }
}

export function renderMarkdown(summary, { model, at = new Date() } = {}) {
  const pct = (value) => (value === null ? '—' : `${Math.round(value * 100)}%`)
  const lines = [
    `# 机组评测 · ${model}`,
    '',
    `- 时间：${at.toISOString()}`,
    `- 共 ${summary.runs} 次，成功率 ${pct(summary.successRate)}`,
    '',
    '| 场景 | 次数 | 成功率 | 人工介入 | 工具出错率 | 平均轮数 | tokens 均值 / 最大 | 平均耗时 | 主要失分 |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
  ]
  for (const entry of summary.scenarios)
    lines.push(
      `| ${entry.id} | ${entry.runs} | ${pct(entry.successRate)} | ${entry.interventions} | ${pct(
        entry.toolErrorRate
      )} | ${entry.turns} | ${entry.tokens.mean} / ${entry.tokens.max}${
        entry.tokens.estimated ? '（含估算）' : ''
      } | ${(entry.durationMs / 1000).toFixed(1)}s | ${
        entry.failures
          .slice(0, 3)
          .map((f) => `${f.name}×${f.count}`)
          .join('，') || '—'
      } |`
    )
  lines.push(
    '',
    '口径：成功 = 场景里写明的每一条检查都满足且没有异常。人工介入 = 任务停下来等确认的次数（评测里自动按场景规则确认或拒绝）。脚本模式只验证运行时与评分本身，不代表任何模型的水平。'
  )
  return lines.join('\n')
}
