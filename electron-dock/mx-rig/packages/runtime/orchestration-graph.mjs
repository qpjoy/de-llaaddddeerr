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
  // How a pre-flight check or a gate came out, for the edge that follows it.
  outcome: channel(z.enum(['pass', 'fail']).nullable(), { initial: () => null }),
  trace: appendChannel(z.object({ node: z.string(), at: z.string() }), { max: 400 })
}

// Second graph node of a two-step flight-plan node: waiting on a dispatched
// run, or the human half of a gate.
const waitId = (id) => `${graphId(id)}__wait`
const pollId = (id) => `${graphId(id)}__poll`

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
  // Where a failed check goes when the author did not say: a pre-flight that
  // is not Go scrubs the launch, a gate that fails is a No-Go.
  const scrubTarget = (node) => (node.onNoGo === null ? 'scrub' : graphId(node.onNoGo))
  const failTarget = (node) => (node.onFail === null ? 'nogo' : graphId(node.onFail))
  const allTargets = [
    ...spec.nodes.map((node) => graphId(node.id)),
    ...spec.nodes.filter((node) => node.type === 'flight').map((node) => waitId(node.id)),
    'conclude'
  ]

  // Every node is declared before any edge is added: `addEdge` refuses an
  // unknown target, which is the guard that makes a compiled spec trustworthy,
  // and it cannot tell "not yet declared" from "does not exist".
  graph.addNode(
    'approve',
    async (state, ctx) => {
      if (await handlers.preapprove?.(state, ctx)) return { approved: true, ...stamp('approve') }
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
  if (spec.nodes.some((node) => node.type === 'preflight' && node.onNoGo === null))
    graph.addNode(
      'scrub',
      async (state, ctx) => {
        await handlers.scrub(state, ctx)
        return stamp('scrub')
      },
      {
        title: '取消发射（Scrub）',
        kind: 'output',
        description: '预检没有通过，这次不派发任何测试；记为受阻，不是失败。'
      }
    )
  if (spec.nodes.some((node) => node.type === 'gate' && node.onFail === null))
    graph.addNode(
      'nogo',
      async (state, ctx) => {
        await handlers.nogo(state, ctx)
        return stamp('nogo')
      },
      {
        title: 'No-Go',
        kind: 'output',
        description: '放行评审没有通过，计划到此为止；飞行结论记为 No-Go。'
      }
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
    else if (node.type === 'preflight')
      graph.addNode(
        id,
        async (state, ctx) => ({ ...(await handlers.preflight(node, state, ctx)), ...stamp(id) }),
        meta
      )
    else if (node.type === 'flight') {
      graph.addNode(
        id,
        async (state, ctx) => ({
          ...(await handlers.dispatchFlight(node, state, ctx)),
          resumeTo: waitId(node.id),
          sourceNode: node.id,
          ...stamp(id)
        }),
        meta
      )
      graph.addNode(
        waitId(node.id),
        async (state, ctx) => ({
          ...(await handlers.awaitFlight(node, state, ctx)),
          ...stamp(waitId(node.id))
        }),
        {
          title: `${node.title} · 等待结论`,
          kind: 'tool',
          description: `有界等待这次执行结束（最长 ${node.waitMinutes} 分钟），再读取用例级结果。`
        }
      )
    } else if (node.type === 'explore')
      graph.addNode(
        id,
        async (state, ctx) => {
          const step = await handlers.explore(node, state, ctx)
          return step.call
            ? { ...step, resumeTo: id, sourceNode: node.id, ...stamp(id) }
            : { ...step, call: null, write: false, ...stamp(id) }
        },
        meta
      )
    else if (node.type === 'gate') {
      graph.addNode(
        id,
        async (state, ctx) => ({ ...(await handlers.gate(node, state, ctx)), ...stamp(id) }),
        meta
      )
      if (node.confirm)
        graph.addNode(
          pollId(node.id),
          async (state, ctx) => {
            // Go/No-Go poll: the criteria passed; a person still says go.
            const approved = ctx.interrupt({
              checkpoint: node,
              message: `放行评审「${node.title}」的标准已满足，是否放行进入下一阶段？`
            })
            await handlers.checkpoint(node, approved === true, ctx)
            return { approved: approved === true, ...stamp(pollId(node.id)) }
          },
          {
            title: `${node.title} · Go/No-Go`,
            kind: 'human',
            interrupts: true,
            description: '标准已满足后由人确认放行；拒绝即 No-Go。'
          }
        )
    } else if (node.type === 'debrief')
      graph.addNode(
        id,
        async (state, ctx) => ({ ...(await handlers.debrief(node, state, ctx)), ...stamp(id) }),
        meta
      )
    else if (node.type === 'procedure')
      graph.addNode(
        id,
        async (state, ctx) => ({
          ...(await handlers.procedureStage(node, state, ctx)),
          ...stamp(id)
        }),
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
    else if (
      node.type === 'analyze' ||
      node.type === 'subflow' ||
      node.type === 'debrief' ||
      node.type === 'procedure'
    )
      graph.addEdge(id, target(node.next))
    else if (node.type === 'preflight')
      graph.addConditionalEdges(
        id,
        (state) => (state.outcome === 'pass' ? target(node.next) : scrubTarget(node)),
        [...new Set([target(node.next), scrubTarget(node)])],
        { labels: { [target(node.next)]: 'Go', [scrubTarget(node)]: 'No-Go' } }
      )
    else if (node.type === 'flight') {
      graph.addConditionalEdges(
        id,
        (state) => (state.write ? 'approve' : 'act'),
        ['approve', 'act'],
        { labels: { approve: '需确认', act: '已预授权' } }
      )
      graph.addEdge(waitId(node.id), target(node.next))
    } else if (node.type === 'explore')
      graph.addConditionalEdges(
        id,
        (state) => (state.call ? (state.write ? 'approve' : 'act') : target(node.next)),
        [...new Set(['approve', 'act', target(node.next)])],
        { labels: { approve: '写动作', act: '读动作', [target(node.next)]: '探索结束' } }
      )
    else if (node.type === 'gate') {
      const pass = node.confirm ? pollId(node.id) : target(node.next)
      graph.addConditionalEdges(
        id,
        (state) => (state.outcome === 'pass' ? pass : failTarget(node)),
        [...new Set([pass, failTarget(node)])],
        { labels: { [pass]: '达标', [failTarget(node)]: '未达标' } }
      )
      if (node.confirm)
        graph.addConditionalEdges(
          pollId(node.id),
          (state) => (state.approved ? target(node.next) : failTarget(node)),
          [...new Set([target(node.next), failTarget(node)])],
          { labels: { [target(node.next)]: 'Go', [failTarget(node)]: 'No-Go' } }
        )
    } else graph.addEdge(id, 'conclude')
  }
  if (spec.nodes.some((node) => node.type === 'preflight' && node.onNoGo === null))
    graph.addEdge('scrub', END)
  if (spec.nodes.some((node) => node.type === 'gate' && node.onFail === null))
    graph.addEdge('nogo', END)

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
  if (node.type === 'preflight')
    return `核对：${node.checks.join('、')}${node.taskIds.length ? `；计划 ${node.taskIds.join('、')}` : ''}`
  if (node.type === 'flight') return `派发 ${node.taskId}，最长等待 ${node.waitMinutes} 分钟`
  if (node.type === 'explore') return `探索（最多 ${node.maxTurns} 步）：${node.goal}`
  if (node.type === 'gate')
    return `${node.criteria.map((entry) => `${entry.metric}(${entry.stage}${entry.value !== undefined ? `, ${entry.value}` : ''})`).join('；')}${node.confirm ? '；需人工放行' : ''}`
  if (node.type === 'debrief') return `生成飞行报告${node.notify ? '并推送通知' : ''}`
  if (node.type === 'procedure')
    return `按原样重放 ${node.procedureIds.length} 条规程：${node.procedureIds.join('、')}`
  if (node.type === 'analyze') return `交给 ${node.agentKey}：${node.instruction}`
  if (node.type === 'subflow') {
    const seeded = Object.keys(node.seed ?? {})
    return `嵌入子编排 ${node.orchestrationKey}${seeded.length ? `，传入 ${seeded.join('、')}` : ''}`
  }
  return node.message
}

export { graphId }
