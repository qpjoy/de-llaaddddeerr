import { z } from 'zod'
import { StateGraph, START, END } from '../graph/graph.mjs'
import { channel, appendChannel } from '../graph/state.mjs'
import { NODE_TYPES, describeTest, evaluateTest } from '../graph/orchestration.mjs'
import { toolCallSchema } from './mission-graph.mjs'

// Author-visible node ids are namespaced so they cannot collide with the
// runtime's own `approve` / `act` / `conclude` nodes, or with a channel name.
const graphId = (id) => `n_${id}`

export const ORCHESTRATION_CHANNELS = {
  vars: channel(z.record(z.string(), z.string().max(400)), {
    // Nodes contribute the variables they captured; nobody rewrites the bag.
    reducer: (previous = {}, next = {}) => ({ ...previous, ...next }),
    initial: () => ({})
  }),
  call: channel(toolCallSchema.nullable(), { initial: () => null }),
  write: channel(z.boolean(), { initial: () => false }),
  approved: channel(z.boolean(), { initial: () => false }),
  // Where `act` returns to once the tool has run. A shared execution node plus
  // an explicit return pointer keeps approval in exactly one place.
  resumeTo: channel(z.string().max(60).nullable(), { initial: () => null }),
  // Which authored node asked for the current call, so `act` knows whose
  // `capture` rules to apply to the result.
  sourceNode: channel(z.string().max(60).nullable(), { initial: () => null }),
  answer: channel(z.string().max(24_000).nullable(), { initial: () => null }),
  trace: appendChannel(z.object({ node: z.string(), at: z.string() }), { max: 400 })
}

const stamp = (node) => ({ trace: [{ node, at: new Date().toISOString() }] })

/**
 * Compile a stored orchestration into the same StateGraph the mission loop
 * uses, so it inherits approval, cancellation, the step budget and the
 * checkpoint/resume behaviour rather than reimplementing any of them.
 *
 * `handlers` does the work; this function owns only the wiring. `describe()`
 * on the result is what the editor draws, which is why an author's picture
 * cannot disagree with what will run.
 */
export function compileOrchestration(spec, handlers, { maxSteps = 120, layout } = {}) {
  const graph = new StateGraph(ORCHESTRATION_CHANNELS)
  const target = (id) => (id === null ? 'conclude' : graphId(id))
  const allTargets = [...spec.nodes.map((node) => graphId(node.id)), 'conclude']

  // Every node is declared before any edge is added: `addEdge` refuses an
  // unknown target, which is the guard that makes a compiled spec trustworthy,
  // and it cannot tell "not yet declared" from "does not exist".
  graph.addNode(
    'approve',
    async (state, ctx) => {
      const approved = ctx.interrupt({ call: state.call })
      return { approved: approved === true, ...stamp('approve') }
    },
    {
      title: '人工确认',
      kind: 'human',
      interrupts: true,
      description: '写动作执行前逐次确认；确认只对当前这组参数生效。'
    }
  )
  graph.addNode(
    'act',
    async (state, ctx) => ({
      ...(await handlers.act(state, ctx)),
      call: null,
      approved: false,
      sourceNode: null,
      ...stamp('act')
    }),
    {
      title: '执行工具',
      kind: 'tool',
      description: '重新校验策略后调用工具，并把原始结果记录为证据。'
    }
  )
  graph.addNode(
    'rejected',
    async (_state, ctx) => {
      await handlers.rejected(ctx)
      return stamp('rejected')
    },
    {
      title: '已拒绝',
      kind: 'output',
      description: '有人拒绝了这一步，编排停止，不做任何替代操作。'
    }
  )
  graph.addNode(
    'conclude',
    async (state, ctx) => {
      await handlers.conclude(state, ctx)
      return stamp('conclude')
    },
    { title: '编排结束', kind: 'output', description: '写入结论。编排跑完不等于测试通过。' }
  )

  for (const node of spec.nodes) {
    const meta = {
      title: node.title,
      kind: NODE_TYPES[node.type].kind,
      description: describeNode(node),
      interrupts: node.type === 'approval'
    }
    const id = graphId(node.id)
    if (node.type === 'tool')
      graph.addNode(
        id,
        async (state, ctx) => ({
          ...(await handlers.prepareTool(node, state, ctx)),
          resumeTo: target(node.next),
          sourceNode: node.id,
          ...stamp(id)
        }),
        meta
      )
    else if (node.type === 'branch')
      graph.addNode(
        id,
        async (state, ctx) => {
          await handlers.branch(node, state, ctx)
          return stamp(id)
        },
        meta
      )
    else if (node.type === 'approval')
      graph.addNode(
        id,
        async (state, ctx) => {
          // Same mechanism as a write tool: pause, checkpoint, wait for a
          // person. Rejecting stops the run instead of taking the other branch.
          const approved = ctx.interrupt({ checkpoint: node, message: node.message })
          await handlers.checkpoint(node, approved === true, ctx)
          return { approved: approved === true, ...stamp(id) }
        },
        meta
      )
    else if (node.type === 'fanout')
      graph.addNode(
        id,
        async (_state, ctx) => {
          await handlers.fanout(node, ctx)
          return stamp(id)
        },
        meta
      )
    else if (node.type === 'subflow')
      graph.addNode(
        id,
        async (state, ctx) => ({
          ...(await handlers.subflow(node, state, ctx)),
          ...stamp(id)
        }),
        meta
      )
    else if (node.type === 'analyze')
      graph.addNode(
        id,
        async (state, ctx) => ({ ...(await handlers.analyze(node, state, ctx)), ...stamp(id) }),
        meta
      )
    else
      graph.addNode(
        id,
        async (state, ctx) => ({ answer: await handlers.finish(node, state, ctx), ...stamp(id) }),
        meta
      )
  }

  for (const node of spec.nodes) {
    const id = graphId(node.id)
    if (node.type === 'tool')
      graph.addConditionalEdges(
        id,
        (state) => (state.write ? 'approve' : 'act'),
        ['approve', 'act'],
        {
          labels: { approve: '需确认', act: '只读' }
        }
      )
    else if (node.type === 'branch')
      graph.addConditionalEdges(
        id,
        (state) => target(evaluateTest(node.test, state.vars) ? node.then : node.otherwise),
        [...new Set([target(node.then), target(node.otherwise)])],
        {
          labels: {
            [target(node.then)]: `是 · ${describeTest(node.test)}`,
            [target(node.otherwise)]: '否'
          }
        }
      )
    else if (node.type === 'approval')
      graph.addConditionalEdges(
        id,
        (state) => (state.approved ? target(node.next) : 'rejected'),
        [...new Set([target(node.next), 'rejected'])],
        { labels: { [target(node.next)]: '已确认', rejected: '已拒绝' } }
      )
    else if (node.type === 'fanout')
      graph.addFanoutEdges(
        id,
        node.branches.map((branch) => graphId(branch)),
        graphId(node.join),
        {
          labels: Object.fromEntries(
            node.branches.map((branch, index) => [graphId(branch), `分支 ${index + 1}`])
          )
        }
      )
    else if (node.type === 'analyze' || node.type === 'subflow')
      graph.addEdge(id, target(node.next))
    else graph.addEdge(id, 'conclude')
  }

  graph.addConditionalEdges(
    'approve',
    (state) => (state.approved ? 'act' : 'rejected'),
    ['act', 'rejected'],
    {
      labels: { act: '已确认', rejected: '已拒绝' }
    }
  )
  graph.addConditionalEdges('act', (state) => state.resumeTo ?? 'conclude', allTargets, {})
  graph.addEdge('rejected', END)
  graph.addEdge('conclude', END)
  graph.addEdge(START, graphId(spec.entry))
  return graph.compile({ maxSteps, layout: layout ?? spec.layout ?? {} })
}

function describeNode(node) {
  if (node.type === 'tool') {
    const args = Object.entries(node.args)
      .map(([key, value]) => `${key}=${value}`)
      .join('，')
    const captured = Object.keys(node.capture)
    return [
      `调用 ${node.tool}${args ? `（${args}）` : ''}`,
      captured.length ? `取出变量：${captured.join('、')}` : null
    ]
      .filter(Boolean)
      .join('；')
  }
  if (node.type === 'branch') return `判断 ${describeTest(node.test)}`
  if (node.type === 'fanout')
    return `${node.branches.length} 条分支依次执行，全部到达 ${node.join} 后继续`
  if (node.type === 'approval') return node.message
  if (node.type === 'analyze') return `交给 ${node.agentKey}：${node.instruction}`
  if (node.type === 'subflow') {
    const seeded = Object.keys(node.seed ?? {})
    return `嵌入子编排 ${node.orchestrationKey}${seeded.length ? `，传入 ${seeded.join('、')}` : ''}`
  }
  return node.message
}

export { graphId }
