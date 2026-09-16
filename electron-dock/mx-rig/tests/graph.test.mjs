import test from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { StateGraph, START, END, GraphError } from '../packages/graph/graph.mjs'
import { channel, appendChannel } from '../packages/graph/state.mjs'
import { buildMissionGraph, MISSION_CHANNELS } from '../packages/runtime/mission-graph.mjs'

const channels = () => ({
  count: channel(z.number().int().min(0), { initial: () => 0 }),
  label: channel(z.string().max(20).nullable(), { initial: () => null }),
  log: appendChannel(z.string())
})

test('a node returns a delta and reducers decide how it merges', async () => {
  const graph = new StateGraph(channels())
    .addNode('a', async (state) => ({ count: state.count + 1, log: ['a'] }))
    .addNode('b', async (state) => ({ count: state.count + 1, log: ['b'] }))
    .addEdge(START, 'a')
    .addEdge('a', 'b')
    .addEdge('b', END)
    .compile()
  const result = await graph.run({ state: graph.initialState() })
  assert.equal(result.status, 'completed')
  assert.equal(result.state.count, 2)
  // Replace for `count`, append for `log` — same nodes, different merge rules.
  assert.deepEqual(result.state.log, ['a', 'b'])
})

test('an update that breaks the channel schema fails at the node that produced it', async () => {
  const graph = new StateGraph(channels())
    .addNode('bad', async () => ({ count: -5 }))
    .addEdge(START, 'bad')
    .addEdge('bad', END)
    .compile()
  await assert.rejects(graph.run({ state: graph.initialState() }), {
    code: 'graph_state_invalid',
    channel: 'count'
  })
  const unknown = new StateGraph(channels())
    .addNode('bad', async () => ({ nope: 1 }))
    .addEdge(START, 'bad')
    .addEdge('bad', END)
    .compile()
  await assert.rejects(unknown.run({ state: unknown.initialState() }), {
    code: 'graph_state_invalid'
  })
})

test('conditional edges route on state and refuse undeclared targets', async () => {
  const build = (router) =>
    new StateGraph(channels())
      .addNode('classify', async () => ({ label: 'refund' }))
      .addNode('refund', async () => ({ log: ['refund'] }))
      .addNode('tech', async () => ({ log: ['tech'] }))
      .addEdge(START, 'classify')
      .addConditionalEdges('classify', router, ['refund', 'tech'])
      .addEdge('refund', END)
      .addEdge('tech', END)
      .compile()
  const good = build((state) => state.label)
  assert.deepEqual((await good.run({ state: good.initialState() })).state.log, ['refund'])
  const bad = build(() => 'somewhere_else')
  await assert.rejects(bad.run({ state: bad.initialState() }), { code: 'graph_invalid_route' })
})

test('interrupt pauses the graph and resume re-enters the same node with the answer', async () => {
  const seen = []
  const graph = new StateGraph(channels())
    .addNode('draft', async (state) => ({ count: state.count + 1, log: ['draft'] }))
    .addNode('review', async (_state, ctx) => {
      seen.push('review')
      const answer = ctx.interrupt({ question: '可以发布吗' })
      return { label: answer }
    })
    .addNode('publish', async () => ({ log: ['publish'] }))
    .addEdge(START, 'draft')
    .addEdge('draft', 'review')
    .addConditionalEdges('review', (s) => (s.label === 'yes' ? 'publish' : 'draft'), [
      'publish',
      'draft'
    ])
    .addEdge('publish', END)
    .compile()

  const paused = await graph.run({ state: graph.initialState() })
  assert.equal(paused.status, 'interrupted')
  assert.equal(paused.node, 'review')
  assert.deepEqual(paused.value, { question: '可以发布吗' })
  assert.equal(seen.length, 1)

  // Rejecting loops back to draft and pauses again — the cycle is real.
  const again = await graph.run({ state: paused.state, next: 'review', resume: 'no' })
  assert.equal(again.status, 'interrupted')
  assert.equal(again.state.count, 2)

  const done = await graph.run({ state: again.state, next: 'review', resume: 'yes' })
  assert.equal(done.status, 'completed')
  assert.deepEqual(done.state.log, ['draft', 'draft', 'publish'])
})

test('a runaway cycle stops on the step budget instead of spinning', async () => {
  const graph = new StateGraph(channels())
    .addNode('loop', async (state) => ({ count: state.count + 1 }))
    .addEdge(START, 'loop')
    .addConditionalEdges('loop', () => 'loop', ['loop'])
    .compile({ maxSteps: 5 })
  await assert.rejects(graph.run({ state: graph.initialState() }), { code: 'graph_step_budget' })
})

test('graph construction refuses the mistakes that are silent at runtime', () => {
  const graph = new StateGraph(channels()).addNode('a', async () => ({}))
  assert.throws(() => graph.addNode('a', async () => ({})), { code: 'graph_duplicate_node' })
  assert.throws(() => graph.addNode('count', async () => ({})), { code: 'graph_name_clash' })
  assert.throws(() => graph.addEdge('a', 'ghost'), { code: 'graph_invalid_edge' })
  assert.throws(() => new StateGraph(channels()).compile(), { code: 'graph_no_entry' })
  const dangling = new StateGraph(channels()).addNode('a', async () => ({})).addEdge(START, 'a')
  assert.throws(() => dangling.compile(), { code: 'graph_dangling_node' })
  assert.ok(GraphError)
})

test('the mission graph describes exactly the nodes and branches that execute', () => {
  const noop = async () => ({})
  const compiled = buildMissionGraph({
    seedWorkflow: async () => ({ call: { id: '1', name: 'tests_run', args: {} }, write: true }),
    plan: noop,
    act: noop,
    answer: noop,
    dispatched: noop,
    rejected: noop
  })
  const shape = compiled.describe()
  assert.deepEqual(shape.nodes.map((node) => node.name).sort(), [
    'act',
    'approve',
    'conclude',
    'dispatched',
    'plan',
    'rejected',
    'seed_workflow'
  ])
  const approval = shape.nodes.find((node) => node.name === 'approve')
  assert.equal(approval.interrupts, true)
  assert.equal(approval.kind, 'human')
  // Every declared edge points at a node that exists, or at END.
  const names = new Set([...shape.nodes.map((node) => node.name), END])
  for (const edge of shape.edges) assert.ok(names.has(edge.to), `edge to ${edge.to}`)
  assert.ok(shape.edges.some((edge) => edge.kind === 'conditional' && edge.label))
  assert.ok(Object.keys(MISSION_CHANNELS).includes('trace'))
})
