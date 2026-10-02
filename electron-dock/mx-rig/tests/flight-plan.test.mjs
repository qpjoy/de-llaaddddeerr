import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import {
  OrchestrationError,
  orchestrationSpec,
  validateOrchestration
} from '../packages/graph/orchestration.mjs'
import { compileOrchestration } from '../packages/runtime/orchestration-graph.mjs'
import { blockingSteps } from '../apps/server/orchestration-schedule.mjs'
import {
  buildFlightReport,
  debriefMessage,
  evaluateCriterion,
  flightVerdict,
  summarizeCases
} from '../packages/runtime/flight.mjs'

// -- the deterministic half ---------------------------------------------------

test('criteria read recorded results and never pass on no evidence', () => {
  const stages = {
    pf: { type: 'preflight', go: true },
    smoke: {
      type: 'flight',
      status: 'failed',
      counts: { passed: 8, failed: 1, flaky: 1, blocked: 0, total: 10 }
    },
    empty: { type: 'flight', status: 'passed', counts: { total: 0 } },
    running: { type: 'flight', status: 'running', counts: {} },
    look: { type: 'explore', assertions: 3, failedAssertions: 0 },
    none: { type: 'explore', assertions: 0, failedAssertions: 0 }
  }
  const judge = (criterion) => evaluateCriterion(criterion, stages).ok
  assert.equal(judge({ metric: 'preflight_go', stage: 'pf' }), true)
  assert.equal(judge({ metric: 'run_passed', stage: 'smoke' }), false)
  assert.equal(judge({ metric: 'failed_max', stage: 'smoke', value: 2 }), true)
  assert.equal(judge({ metric: 'failed_max', stage: 'smoke', value: 1 }), false)
  assert.equal(judge({ metric: 'failed_max', stage: 'running', value: 5 }), false, 'unfinished runs never pass')
  assert.equal(judge({ metric: 'pass_rate_min', stage: 'smoke', value: 80 }), true)
  assert.equal(judge({ metric: 'pass_rate_min', stage: 'empty', value: 0 }), false, 'no judged cases is not 100%')
  assert.equal(judge({ metric: 'assertions_all_passed', stage: 'look' }), true)
  assert.equal(judge({ metric: 'assertions_all_passed', stage: 'none' }), false)
  assert.equal(judge({ metric: 'run_passed', stage: 'missing' }), false)

  assert.equal(flightVerdict({ stages: { pf: { type: 'preflight', go: false } }, gates: {} }), 'scrubbed')
  assert.equal(flightVerdict({ stages: {}, gates: { g: { passed: true } } }), 'go')
  assert.equal(flightVerdict({ stages: {}, gates: { g: { passed: true, approved: false } } }), 'no-go')
  assert.equal(flightVerdict({ stages: {}, gates: {} }), null, 'no criteria, no verdict')

  const { counts, failed } = summarizeCases([
    { caseId: 'A-1', title: 'login', status: 'passed' },
    { caseId: 'A-2', title: 'save', status: 'failed' },
    { caseId: 'A-3', title: 'export', status: 'flaky' }
  ])
  assert.deepEqual([counts.passed, counts.failed, counts.flaky, counts.total], [1, 1, 1, 3])
  assert.deepEqual(failed.map((entry) => entry.caseId), ['A-2', 'A-3'])
})

// -- the plan itself -------------------------------------------------------------

const plan = (overrides = {}) => ({
  key: 'nightly-flight',
  displayName: '夜间飞行',
  summary: '预检、冒烟、放行、讲评',
  entry: 'pf',
  nodes: [
    {
      id: 'pf',
      type: 'preflight',
      title: '预检',
      stage: 'tminus',
      taskIds: ['task-a'],
      checks: ['runners', 'production'],
      next: 'smoke'
    },
    { id: 'smoke', type: 'flight', title: '冒烟', stage: 'static-fire', taskId: 'task-a', waitMinutes: 1, next: 'go' },
    {
      id: 'go',
      type: 'gate',
      title: '冒烟放行',
      criteria: [
        { metric: 'run_passed', stage: 'smoke' },
        { metric: 'failed_max', stage: 'smoke', value: 0 }
      ],
      next: 'report'
    },
    { id: 'report', type: 'debrief', title: '讲评', notify: true, next: null }
  ],
  ...overrides
})

async function fixture(t, { spec = plan(), runStatus = 'passed', cases, runners, replies = [], browser } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-flight-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 12,
    allowedTools: ['tests_run', 'tests_result', 'tests_wait', 'browser_snapshot', 'browser_assert', 'finding_submit'],
    browserOrigins: ['https://staging.example'],
    productionHosts: ['.prod.example']
  }
  const calls = []
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      calls.push({ path, body })
      if (path === '/api/rig/v1/execution-config')
        return {
          policy: structuredClone(policy),
          model: { configured: true },
          orchestrations: [structuredClone(spec)],
          agents: []
        }
      if (path === '/api/rig/v1/model/turn') return { message: replies.shift() ?? { content: '完成' } }
      if (path === '/api/v1/tasks')
        return {
          tasks: [
            { id: 'task-a', name: '冒烟', appId: 'app-1', suiteId: 'suite-1', runsOn: null, targetUrl: 'https://staging.example/' },
            { id: 'task-prod', name: '生产', appId: 'app-1', suiteId: 'suite-1', runsOn: 'server', targetUrl: 'https://www.prod.example/' }
          ]
        }
      if (path === '/api/v1/apps') return { apps: [{ id: 'app-1', slug: 'compass', displayName: 'Compass' }] }
      if (path === '/api/v1/apps/compass/suites')
        return { suites: [{ id: 'suite-1', engine: 'playwright', surface: 'web', runnerKind: 'local' }] }
      if (path === '/api/v1/runners')
        return {
          runners: runners ?? [
            { id: 'r1', name: 'lab-1', online: true, capabilities: { engines: ['playwright'], surfaces: ['web'] } }
          ]
        }
      if (path.endsWith(':run')) return { run: { id: 'trun_1', status: 'pending-runner', appId: 'app-1' } }
      if (path === '/api/v1/runs/trun_1/cases')
        return {
          cases: cases ?? [
            { caseId: 'C-1', title: '登录', status: 'passed' },
            { caseId: 'C-2', title: '保存', status: 'passed' }
          ]
        }
      if (path === '/api/v1/runs/trun_1') return { run: { id: 'trun_1', status: runStatus, appId: 'app-1' } }
      if (path === '/api/v1/notifications:debrief') return { queued: 1 }
      throw new Error(`unexpected ${path}`)
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client, browser ?? null),
    owner: 'alice'
  })
  engine.pollMs = 5
  t.after(() => engine.close())
  const until = async (id, status) => {
    await engine.job
    const row = store.get(id, 'alice')
    assert.equal(row.status, status, JSON.stringify(row.events.at(-1)))
    return row
  }
  return { store, engine, calls, until }
}

test('a flight plan checks, flies, judges and reports — with the dispatch still approved', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  let state = await f.until(row.id, 'awaiting_approval')
  assert.equal(state.pending.name, 'tests_run')
  assert.equal(state.flight.stages.pf.go, true)
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)

  await f.engine.approve(row.id, state.pending.approvalId, true)
  state = await f.until(row.id, 'completed')
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 1)
  assert.equal(state.flight.stages.smoke.status, 'passed')
  assert.equal(state.flight.stages.smoke.counts.passed, 2)
  assert.equal(state.flight.gates.go.passed, true)
  assert.equal(state.flight.verdict, 'go')
  assert.match(state.report.markdown, /GO · 放行/)
  assert.match(state.report.markdown, /冒烟放行：达标/)
  const notified = f.calls.find((call) => call.path === '/api/v1/notifications:debrief')
  assert.equal(notified.body.app, 'compass')
  assert.equal(notified.body.message.totals.passed, 2)
  assert.ok(state.events.some((event) => /1 个通知通道/.test(event.message)))
})

test('a pre-flight that is not Go scrubs the launch and dispatches nothing', async (t) => {
  const f = await fixture(t, { runners: [] })
  const row = await f.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  const state = await f.until(row.id, 'blocked')
  assert.equal(state.flight.verdict, 'scrubbed')
  assert.match(state.result, /取消发射/)
  assert.match(state.result, /没有能跑 playwright × web 的在线执行机/)
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)
  assert.match(state.report.markdown, /SCRUB/)
})

test('production targets are scrubbed however the plan was written', async (t) => {
  const spec = plan()
  spec.nodes[0].taskIds = ['task-prod']
  const f = await fixture(t, { spec })
  const row = await f.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  const state = await f.until(row.id, 'blocked')
  assert.match(state.result, /生产环境禁区/)
})

test('a failed gate is a No-Go, recorded as a finished flight, not an error', async (t) => {
  const f = await fixture(t, {
    runStatus: 'failed',
    cases: [
      { caseId: 'C-1', title: '登录', status: 'passed' },
      { caseId: 'C-2', title: '保存', status: 'failed' }
    ]
  })
  const row = await f.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  let state = await f.until(row.id, 'awaiting_approval')
  await f.engine.approve(row.id, state.pending.approvalId, true)
  state = await f.until(row.id, 'completed')
  assert.equal(state.flight.verdict, 'no-go')
  assert.match(state.result, /No-Go/)
  assert.match(state.report.markdown, /C-2 保存/)
  assert.ok(!f.calls.some((call) => call.path === '/api/v1/notifications:debrief'), 'the report node was not reached')
})

test('a gate can require a person to say go, and a refusal is a No-Go', async (t) => {
  const spec = plan()
  spec.nodes[2].confirm = true
  const f = await fixture(t, { spec })
  const row = await f.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  let state = await f.until(row.id, 'awaiting_approval')
  await f.engine.approve(row.id, state.pending.approvalId, true)
  state = await f.until(row.id, 'awaiting_approval')
  assert.equal(state.pending.name, 'checkpoint')
  await f.engine.approve(row.id, state.pending.approvalId, false)
  state = await f.until(row.id, 'completed')
  assert.equal(state.flight.gates.go.approved, false)
  assert.equal(state.flight.verdict, 'no-go')
  assert.match(state.result, /人工否决/)
})

test('an admin-saved plan may be pre-authorised; the same plan as a draft may not', async (t) => {
  const spec = plan({ authorize: { dispatch: true } })
  const saved = await fixture(t, { spec })
  const row = await saved.engine.start({ mode: 'orchestration', goal: '夜间飞行', orchestrationKey: 'nightly-flight' })
  const state = await saved.until(row.id, 'completed')
  assert.ok(state.events.some((event) => event.data?.preauthorized === true))
  assert.equal(state.flight.verdict, 'go')

  const draft = await fixture(t, { spec })
  const inline = await draft.engine.start({ mode: 'orchestration', goal: '草稿飞行', spec })
  const paused = await draft.until(inline.id, 'awaiting_approval')
  assert.equal(paused.pending.name, 'tests_run', 'a draft never inherits standing authorisation')
  assert.equal(paused.inlineSpec.key, 'nightly-flight')
})

test('an exploration stage runs a bounded Agent loop and its assertions feed the gate', async (t) => {
  const browser = {
    async execute(name, args) {
      if (name === 'browser_snapshot') return { url: 'https://staging.example/', snapshot: '- button "保存" [ref=e1]' }
      if (name === 'browser_assert')
        return {
          assertion: { kind: args.kind, description: '页面上可见指定文本', expected: args.expected, passed: true },
          url: 'https://staging.example/'
        }
      throw new Error(`unexpected ${name}`)
    },
    async close() {}
  }
  const call = (id, name, args) => ({
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
  })
  const spec = {
    key: 'look-around',
    displayName: '巡检飞行',
    summary: '探索并放行',
    entry: 'look',
    nodes: [
      { id: 'look', type: 'explore', title: '巡检首页', goal: '确认首页可以保存', maxTurns: 4, next: 'gate' },
      {
        id: 'gate',
        type: 'gate',
        title: '断言放行',
        criteria: [{ metric: 'assertions_all_passed', stage: 'look' }],
        next: null
      }
    ]
  }
  const f = await fixture(t, {
    spec,
    browser,
    replies: [
      call('c1', 'browser_snapshot', {}),
      call('c2', 'tests_run', { taskId: 'task-a' }),
      call('c3', 'browser_assert', { kind: 'text_visible', expected: '保存' }),
      { content: '首页的保存按钮可见，断言通过。' }
    ]
  })
  const row = await f.engine.start({ mode: 'orchestration', goal: '巡检', orchestrationKey: 'look-around' })
  const state = await f.until(row.id, 'blocked')
  // Dispatching is not an exploration's job: the model asked, and the mission
  // stopped rather than letting it shop for a tool it was not offered.
  assert.match(state.events.at(-1).message, /未被 Internal 策略允许/)
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 0)

  const g = await fixture(t, {
    spec,
    browser,
    replies: [
      call('c1', 'browser_snapshot', {}),
      call('c3', 'browser_assert', { kind: 'text_visible', expected: '保存' }),
      { content: '首页的保存按钮可见，断言通过。' }
    ]
  })
  const again = await g.engine.start({ mode: 'orchestration', goal: '巡检', orchestrationKey: 'look-around' })
  const done = await g.until(again.id, 'completed')
  assert.equal(done.flight.stages.look.assertions, 1)
  assert.equal(done.flight.stages.look.failedAssertions, 0)
  assert.match(done.flight.stages.look.summary, /保存按钮可见/)
  assert.equal(done.flight.verdict, 'go')
  assert.ok(done.crew.look.messages.length > 1, 'the stage keeps its own conversation')
  assert.equal(
    g.store.public(done).crew,
    undefined,
    'the exploration transcript is not part of the public record'
  )
  assert.equal(done.assertions.length, 1)
})

test('plans are validated as a graph, and only safe ones can be scheduled', () => {
  const wrong = plan()
  wrong.nodes[2].criteria = [{ metric: 'run_passed', stage: 'pf' }]
  assert.throws(() => validateOrchestration(wrong), OrchestrationError)
  const unknownVar = plan()
  unknownVar.nodes[1].taskId = '{{nope}}'
  assert.throws(() => validateOrchestration(unknownVar), /未定义的变量/)
  // Stage results are variables later nodes can read.
  const reads = plan()
  reads.nodes.push({ id: 'end', type: 'finish', title: '结束', message: '通过 {{smoke_passed}} 条' })
  reads.nodes[3].next = 'end'
  assert.ok(validateOrchestration(reads))

  const writeTools = ['tests_run', 'tests_cancel']
  const parsed = (spec) => orchestrationSpec.parse(spec)
  assert.ok(blockingSteps(parsed(plan()), writeTools).some((reason) => /架次/.test(reason)))
  assert.deepEqual(blockingSteps(parsed(plan({ authorize: { dispatch: true } })), writeTools), [])
  const templated = plan({ authorize: { dispatch: true } })
  templated.inputs = [{ name: 'task', label: '计划', kind: 'task', required: false }]
  templated.nodes[1].taskId = '{{task}}'
  assert.ok(blockingSteps(parsed(templated), writeTools).length > 0, 'a template cannot be pre-authorised')

  // The compiled graph is what the editor draws: both terminals are there.
  const handlers = new Proxy({}, { get: () => async () => ({}) })
  const scrubbing = compileOrchestration(validateOrchestration(plan()).expanded, handlers).describe()
  assert.ok(scrubbing.nodes.some((node) => node.name === 'scrub'))
  assert.ok(scrubbing.nodes.some((node) => node.name === 'nogo'))
  assert.ok(scrubbing.nodes.some((node) => node.name === 'n_smoke__wait'))
})

test('the flight report and its notification say what was checked', () => {
  const mission = {
    id: 'm-1',
    goal: '夜间飞行',
    flight: {
      verdict: 'no-go',
      stages: {
        smoke: {
          type: 'flight',
          title: '冒烟',
          stage: 'static-fire',
          status: 'failed',
          runId: 'trun_1',
          counts: { passed: 3, failed: 1, total: 4 },
          failed: [{ caseId: 'C-9', title: '导出', status: 'failed' }]
        }
      },
      gates: {
        go: {
          title: '冒烟放行',
          passed: false,
          results: [{ ok: false, label: '失败用例数不超过', value: 0, stage: 'smoke', actual: '1' }]
        }
      }
    },
    assertions: [{ description: '页面上可见指定文本', expected: '已保存', actual: false, passed: false }]
  }
  const markdown = buildFlightReport({ mission, planName: '夜间飞行', now: new Date('2026-09-26T00:00:00Z') })
  assert.match(markdown, /NO-GO/)
  assert.match(markdown, /Static Fire/)
  assert.match(markdown, /C-9 导出/)
  assert.match(markdown, /期望 已保存/)
  assert.match(markdown, /不由模型判断/)
  const message = debriefMessage({ mission, planName: '夜间飞行' })
  assert.equal(message.event, 'debrief')
  assert.equal(message.totals.failed, 1)
  assert.equal(message.failedCases[0].caseId, 'C-9')
})
