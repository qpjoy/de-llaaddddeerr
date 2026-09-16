import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applyCapture,
  evaluateTest,
  readPath,
  renderTemplate,
  validateOrchestration
} from '../packages/graph/orchestration.mjs'
import { compileOrchestration } from '../packages/runtime/orchestration-graph.mjs'
import { BUILTIN_ORCHESTRATIONS } from '../apps/server/orchestration-presets.mjs'
import { TOOL_NAMES } from '../packages/contracts/index.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'

const PROBE = {
  prepareTool: async () => ({}),
  branch: async () => {},
  checkpoint: async () => {},
  analyze: async () => ({}),
  finish: async () => '',
  act: async () => ({}),
  rejected: async () => {},
  conclude: async () => {}
}

const minimal = (overrides = {}) => ({
  key: 'demo',
  displayName: '示例',
  summary: '一句话',
  inputs: [{ name: 'taskId', label: '计划', kind: 'task', required: true }],
  entry: 'run',
  nodes: [
    {
      id: 'run',
      title: '派发',
      type: 'tool',
      tool: 'tests_run',
      args: { taskId: '{{taskId}}' },
      capture: { runId: { from: 'run.id' } },
      next: 'done'
    },
    { id: 'done', title: '结束', type: 'finish', message: '已派发 {{runId}}' }
  ],
  ...overrides
})

test('the built-in orchestrations validate and compile', () => {
  for (const raw of BUILTIN_ORCHESTRATIONS) {
    const { spec, warnings } = validateOrchestration(raw, {
      toolNames: TOOL_NAMES,
      agentKeys: ['failure-triage', 'result-analyst']
    })
    assert.deepEqual(warnings, [], `${raw.key} should have no unreachable nodes`)
    const shape = compileOrchestration(spec, PROBE).describe()
    // Every authored node plus the four the runtime always supplies.
    assert.equal(shape.nodes.length, spec.nodes.length + 4)
    const names = new Set([...shape.nodes.map((node) => node.name), '__end__'])
    for (const edge of shape.edges) assert.ok(names.has(edge.to), `${raw.key}: edge to ${edge.to}`)
  }
})

test('structural mistakes are refused with the node that caused them', () => {
  const cases = [
    [minimal({ entry: 'nowhere' }), /入口节点 nowhere 不存在/],
    [
      minimal({
        nodes: [{ ...minimal().nodes[0], next: 'ghost' }, minimal().nodes[1]]
      }),
      /指向了不存在的节点 ghost/
    ],
    [
      minimal({
        nodes: [{ ...minimal().nodes[0], tool: 'rm_minus_rf' }, minimal().nodes[1]]
      }),
      /未知工具 rm_minus_rf/
    ],
    [
      minimal({
        nodes: [{ ...minimal().nodes[0], args: { taskId: '{{nope}}' } }, minimal().nodes[1]]
      }),
      /引用了未定义的变量 nope/
    ],
    [minimal({ nodes: [minimal().nodes[0], minimal().nodes[0]] }), /节点 ID run 重复/]
  ]
  for (const [spec, pattern] of cases)
    assert.throws(() => validateOrchestration(spec, { toolNames: TOOL_NAMES }), pattern)
})

test('an unreachable node is a warning, not a rejection', () => {
  const spec = minimal()
  spec.nodes.push({ id: 'orphan', title: '孤儿', type: 'finish', message: '没人到得了这里' })
  const { warnings } = validateOrchestration(spec, { toolNames: TOOL_NAMES })
  assert.match(warnings[0], /orphan/)
})

test('templates, captures and tests read only what they are given', () => {
  assert.equal(renderTemplate('task={{taskId}}/{{missing}}', { taskId: 'tsk_1' }), 'task=tsk_1/')
  assert.equal(applyCapture({ run: { id: 'r1' } }, { from: 'run.id', select: 'value' }), 'r1')
  assert.equal(
    applyCapture(
      { runners: [{ online: true }, { online: false }, { online: true }] },
      { from: 'runners', select: 'count', where: 'online' }
    ),
    '2'
  )
  assert.equal(applyCapture({ runners: [] }, { from: 'runners', select: 'count' }), '0')
  assert.equal(applyCapture({}, { from: 'run.id', select: 'value' }), '')
  // A path may not climb out of the object it was given.
  assert.equal(readPath({}, 'constructor.name'), undefined)
  assert.equal(readPath({}, '__proto__.polluted'), undefined)

  const vars = { n: '3', status: 'failed' }
  assert.equal(evaluateTest({ var: 'n', op: 'gt', value: '0' }, vars), true)
  assert.equal(evaluateTest({ var: 'n', op: 'lt', value: '3' }, vars), false)
  assert.equal(evaluateTest({ var: 'status', op: 'in', values: ['failed', 'flaky'] }, vars), true)
  assert.equal(evaluateTest({ var: 'missing', op: 'missing' }, vars), true)
  assert.equal(evaluateTest({ var: 'status', op: 'ne', value: 'passed' }, vars), true)
  // A non-numeric comparison is false, never a thrown error mid-run.
  assert.equal(evaluateTest({ var: 'status', op: 'gt', value: '1' }, vars), false)
})

// -- execution ---------------------------------------------------------------

async function fixture(t, { orchestrations, runners = [] }) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-orch-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 5,
    allowedTools: ['tests_runners', 'tests_run', 'tests_result'],
    browserOrigins: []
  }
  const calls = []
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      calls.push({ path, body })
      if (path === '/api/rig/v1/execution-config')
        return { policy: structuredClone(policy), orchestrations, agents: [] }
      if (path === '/api/rig/v1/model/turn') return { message: { content: '分析结论：证据不足。' } }
      if (path === '/api/v1/runners') return { runners }
      if (path.endsWith(':run')) return { run: { id: 'run-a', status: 'queued' } }
      return { run: { id: 'run-a', status: 'failed' } }
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client),
    owner: 'alice'
  })
  t.after(() => engine.close())
  return { store, engine, calls, policy }
}

const guarded = () => structuredClone(BUILTIN_ORCHESTRATIONS[0])

test('a guard branch refuses to dispatch when no runner is online', async (t) => {
  const f = await fixture(t, { orchestrations: [guarded()] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '派发',
    orchestrationKey: 'guarded-dispatch',
    inputs: { taskId: 'task-a' }
  })
  await f.engine.job
  const state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'completed')
  assert.deepEqual(
    state.trace.map((entry) => entry.node),
    ['n_read_runners', 'act', 'n_has_runner', 'n_no_runner', 'conclude']
  )
  assert.match(state.result, /没有在线执行机/)
  // The point of the guard: nothing was dispatched.
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)
})

test('with a runner online the same orchestration still stops for approval', async (t) => {
  const f = await fixture(t, {
    orchestrations: [guarded()],
    runners: [{ id: 'r1', online: true }]
  })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '派发',
    orchestrationKey: 'guarded-dispatch',
    inputs: { taskId: 'task-a' }
  })
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'awaiting_approval')
  // The template was rendered from the mission's inputs, not left literal.
  assert.deepEqual(state.pending.args, { taskId: 'task-a' })
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)
  await f.engine.approve(row.id, state.pending.approvalId, true)
  await f.engine.job
  state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'completed')
  assert.equal(state.testRunId, 'run-a')
  assert.match(state.result, /不代表测试通过/)
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 1)
})

test('an authored checkpoint pauses on its own question and rejecting stops the run', async (t) => {
  const spec = guarded()
  spec.nodes.find((node) => node.id === 'has_runner').then = 'confirm'
  spec.nodes.push({
    id: 'confirm',
    title: '派发前复核',
    type: 'approval',
    message: '这会真的派发一次测试。',
    next: 'dispatch'
  })
  const f = await fixture(t, { orchestrations: [spec], runners: [{ id: 'r1', online: true }] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '派发',
    orchestrationKey: 'guarded-dispatch',
    inputs: { taskId: 'task-a' }
  })
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'awaiting_approval')
  assert.equal(state.pending.name, 'checkpoint')
  assert.equal(state.pending.args.检查点, '派发前复核')
  await f.engine.approve(row.id, state.pending.approvalId, false)
  await f.engine.job
  state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'cancelled')
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)
  assert.ok(state.trace.map((entry) => entry.node).includes('rejected'))
})

test('an analysis node gets one model turn and no tools', async (t) => {
  const spec = {
    key: 'analyse-only',
    displayName: '只分析',
    summary: '读一次结果再交给 Agent',
    inputs: [{ name: 'runId', label: 'Run', kind: 'run', required: true }],
    entry: 'read',
    nodes: [
      {
        id: 'read',
        title: '读取结论',
        type: 'tool',
        tool: 'tests_result',
        args: { runId: '{{runId}}' },
        capture: { status: { from: 'run.status' } },
        next: 'think'
      },
      {
        id: 'think',
        title: '分析',
        type: 'analyze',
        agentKey: 'result-analyst',
        instruction: '解释这次失败。',
        next: null
      }
    ]
  }
  const f = await fixture(t, { orchestrations: [validateOrchestration(spec).spec] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '分析',
    orchestrationKey: 'analyse-only',
    inputs: { runId: 'run-a' }
  })
  await f.engine.job
  const state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'completed')
  assert.match(state.result, /证据不足/)
  const turn = f.calls.find((call) => call.path === '/api/rig/v1/model/turn')
  assert.equal(turn.body.agentKey, 'result-analyst')
  // No tools offered: an authored analysis step summarises, it does not roam.
  assert.deepEqual(turn.body.tools, [])
  assert.match(turn.body.messages[0].content, /status = failed/)
})

test('a mission holds the spec revision it started on', async (t) => {
  const f = await fixture(t, { orchestrations: [guarded()], runners: [{ id: 'r1', online: true }] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '派发',
    orchestrationKey: 'guarded-dispatch',
    inputs: { taskId: 'task-a' }
  })
  await f.engine.job
  const pending = f.store.get(row.id, 'alice').pending
  f.policy.revision = 'v2'
  await f.engine.approve(row.id, pending.approvalId, true)
  await f.engine.job
  // Same rule as the mission loop: an approval does not survive a policy change.
  assert.equal(f.store.get(row.id, 'alice').status, 'blocked')
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 0)
})

// -- fan-out and subflows -----------------------------------------------------

const twoTrack = () => ({
  key: 'two-track',
  displayName: '双轨冒烟',
  summary: 'web 与 electron 都跑，全部到齐后汇总',
  inputs: [
    { name: 'webTask', label: 'Web 计划', kind: 'task', required: true },
    { name: 'electronTask', label: 'Electron 计划', kind: 'task', required: true }
  ],
  entry: 'split',
  nodes: [
    {
      id: 'split',
      title: '分头跑',
      type: 'fanout',
      branches: ['web', 'electron'],
      join: 'summary'
    },
    {
      id: 'web',
      title: 'Web',
      type: 'tool',
      tool: 'tests_run',
      args: { taskId: '{{webTask}}' },
      capture: { webRun: { from: 'run.id' } },
      next: 'summary'
    },
    {
      id: 'electron',
      title: 'Electron',
      type: 'tool',
      tool: 'tests_run',
      args: { taskId: '{{electronTask}}' },
      capture: { electronRun: { from: 'run.id' } },
      next: 'summary'
    },
    {
      id: 'summary',
      title: '汇总',
      type: 'finish',
      message: 'web={{webRun}} electron={{electronRun}}'
    }
  ]
})

test('a fan-out runs every branch once and the join fires only on the last arrival', async (t) => {
  const { spec, expanded } = validateOrchestration(twoTrack(), { toolNames: TOOL_NAMES })
  const shape = compileOrchestration(expanded, PROBE).describe()
  assert.equal(shape.joins.n_summary, 2)
  assert.equal(shape.edges.filter((edge) => edge.kind === 'fanout').length, 2)

  const f = await fixture(t, { orchestrations: [spec] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '双轨',
    orchestrationKey: 'two-track',
    inputs: { webTask: 'task-web', electronTask: 'task-el' }
  })
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  // Both dispatches are write tools, so each stops for its own approval.
  for (let guard = 0; guard < 4 && state.status === 'awaiting_approval'; guard++) {
    await f.engine.approve(row.id, state.pending.approvalId, true)
    await f.engine.job
    state = f.store.get(row.id, 'alice')
  }
  assert.equal(state.status, 'completed')
  const visited = state.trace.map((entry) => entry.node)
  assert.deepEqual(
    visited.filter((node) => node === 'n_summary'),
    ['n_summary'],
    'the join must run exactly once'
  )
  assert.ok(visited.indexOf('n_web') < visited.indexOf('n_electron'), 'branches run in order')
  assert.equal(f.calls.filter((call) => call.path.endsWith(':run')).length, 2)
  assert.match(state.result, /web=run-a electron=run-a/)
})

test('a fan-out branch that cannot reach the join is refused', () => {
  const spec = twoTrack()
  spec.nodes.find((node) => node.id === 'electron').next = null
  assert.throws(() => validateOrchestration(spec, { toolNames: TOOL_NAMES }), /走不到汇合节点/)
  const outside = twoTrack()
  outside.nodes.push({
    id: 'stray',
    title: '外部',
    type: 'branch',
    test: { var: 'webRun', op: 'exists' },
    then: 'summary',
    otherwise: null
  })
  outside.nodes.find((node) => node.id === 'split').branches = ['web', 'electron']
  assert.throws(
    () => validateOrchestration(outside, { toolNames: TOOL_NAMES }),
    /从分叉之外指向了汇合节点/
  )
})

const child = () => ({
  key: 'dispatch-one',
  displayName: '派发一个计划',
  summary: '子编排：派发并记下 run',
  inputs: [{ name: 'taskId', label: '计划', kind: 'task', required: true }],
  entry: 'go',
  nodes: [
    {
      id: 'go',
      title: '派发',
      type: 'tool',
      tool: 'tests_run',
      args: { taskId: '{{taskId}}' },
      capture: { runId: { from: 'run.id' } },
      next: null
    }
  ]
})

test('the same subflow used twice keeps its two copies apart', async (t) => {
  const parent = {
    key: 'both',
    displayName: '两次调用同一子编排',
    summary: '同一条子编排用两次',
    inputs: [
      { name: 'webTask', label: 'Web', kind: 'task', required: true },
      { name: 'elTask', label: 'Electron', kind: 'task', required: true }
    ],
    entry: 'web',
    nodes: [
      {
        id: 'web',
        title: 'Web',
        type: 'subflow',
        orchestrationKey: 'dispatch-one',
        inputs: { taskId: '{{webTask}}' },
        next: 'el'
      },
      {
        id: 'el',
        title: 'Electron',
        type: 'subflow',
        orchestrationKey: 'dispatch-one',
        inputs: { taskId: '{{elTask}}' },
        next: 'done'
      },
      { id: 'done', title: '汇总', type: 'finish', message: 'web={{web__runId}} el={{el__runId}}' }
    ]
  }
  const resolve = (key) => (key === 'dispatch-one' ? child() : null)
  const { spec, expanded } = validateOrchestration(parent, { toolNames: TOOL_NAMES, resolve })
  // Two copies, namespaced, plus the two seed nodes and the finish.
  assert.deepEqual(
    expanded.nodes.map((node) => node.id).sort(),
    ['done', 'el', 'el__go', 'web', 'web__go'].sort()
  )
  assert.equal(expanded.nodes.find((node) => node.id === 'web__go').args.taskId, '{{web__taskId}}')

  const f = await fixture(t, { orchestrations: [spec, child()] })
  const row = await f.engine.start({
    mode: 'orchestration',
    goal: '两条',
    orchestrationKey: 'both',
    inputs: { webTask: 'task-web', elTask: 'task-el' }
  })
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  const approved = []
  for (let guard = 0; guard < 4 && state.status === 'awaiting_approval'; guard++) {
    approved.push(state.pending.args.taskId)
    await f.engine.approve(row.id, state.pending.approvalId, true)
    await f.engine.job
    state = f.store.get(row.id, 'alice')
  }
  assert.equal(
    state.status,
    'completed',
    state.events
      .filter((e) => e.kind === 'error')
      .map((e) => e.message)
      .join(' | ')
  )
  // Each copy got its own input, which is the whole point of namespacing.
  assert.deepEqual(approved, ['task-web', 'task-el'])
  assert.match(state.result, /web=run-a el=run-a/)
})

test('subflow cycles, missing children and depth are refused', () => {
  const selfRef = {
    ...child(),
    key: 'loop',
    entry: 'again',
    nodes: [
      {
        id: 'again',
        title: '自己',
        type: 'subflow',
        orchestrationKey: 'loop',
        inputs: {},
        next: null
      }
    ]
  }
  assert.throws(() => validateOrchestration(selfRef, { resolve: () => selfRef }), /子编排环/)
  const missing = {
    ...selfRef,
    key: 'missing',
    nodes: [{ ...selfRef.nodes[0], orchestrationKey: 'not-there' }]
  }
  assert.throws(() => validateOrchestration(missing, { resolve: () => null }), /不存在或已停用/)
})

test('a published spec can be handed straight back to the validator', () => {
  // The admin view and the runtime both read what the server published and
  // pass it back. Every field the server adds has to survive that round trip.
  const published = {
    ...BUILTIN_ORCHESTRATIONS[0],
    builtin: true,
    warnings: [],
    missingTools: ['tests_run'],
    nextFireAt: '2026-09-17T01:00:00.000Z'
  }
  const { spec } = validateOrchestration(published, { toolNames: TOOL_NAMES })
  assert.equal(spec.key, 'guarded-dispatch')
  for (const field of ['warnings', 'missingTools', 'nextFireAt'])
    assert.equal(spec[field], undefined, `${field} must not survive into the stored spec`)
})
