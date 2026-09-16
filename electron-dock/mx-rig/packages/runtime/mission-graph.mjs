import { z } from 'zod'
import { StateGraph, START, END } from '../graph/graph.mjs'
import { channel, appendChannel } from '../graph/state.mjs'

export const toolCallSchema = z.object({
  id: z.string().min(1).max(200),
  name: z.string().min(1).max(64),
  args: z.record(z.string(), z.string()).default({})
})

/**
 * Everything the mission loop routes on, and nothing else.
 *
 * The durable record of a mission stays in the MissionStore: this is the
 * working state of one execution, which is what gets checkpointed at an
 * interrupt and replayed on approval.
 */
export const MISSION_CHANNELS = {
  mode: channel(z.enum(['agent', 'workflow'])),
  turns: channel(z.number().int().min(0).max(100), { initial: () => 0 }),
  call: channel(toolCallSchema.nullable(), { initial: () => null }),
  write: channel(z.boolean(), { initial: () => false }),
  approved: channel(z.boolean(), { initial: () => false }),
  answer: channel(z.string().max(24_000).nullable(), { initial: () => null }),
  trace: appendChannel(z.object({ node: z.string(), at: z.string() }), { max: 400 })
}

const stamp = (node) => ({ trace: [{ node, at: new Date().toISOString() }] })

/**
 * The agent loop as a graph rather than a for-loop.
 *
 * Handlers do the work; this file owns only the shape. That split is what lets
 * the orchestration centre draw the graph that actually ran — `describe()`
 * reads the same object the runtime executes, so the picture cannot be a
 * flattering diagram of an older design.
 */
export function buildMissionGraph(handlers, { maxSteps = 200 } = {}) {
  const graph = new StateGraph(MISSION_CHANNELS)

  graph.addNode(
    'seed_workflow',
    async (state, ctx) => ({
      ...(await handlers.seedWorkflow(state, ctx)),
      ...stamp('seed_workflow')
    }),
    {
      title: '载入测试计划',
      kind: 'tool',
      description: '把选中的测试计划变成一次待确认的派发动作，不经过模型。'
    }
  )
  graph.addNode(
    'plan',
    async (state, ctx) => ({ ...(await handlers.plan(state, ctx)), ...stamp('plan') }),
    {
      title: '模型规划',
      kind: 'model',
      description: '读取会话与当前可用工具，决定下一步调用哪个工具，或给出结论。'
    }
  )
  graph.addNode(
    'approve',
    async (state, ctx) => {
      // The pause. Everything needed to resume is in the checkpoint, so a
      // restart can refuse to replay instead of guessing what was approved.
      const approved = ctx.interrupt({ call: state.call })
      return { approved: approved === true, ...stamp('approve') }
    },
    {
      title: '人工确认',
      kind: 'human',
      interrupts: true,
      description: '写动作执行前逐次确认；确认只对当前这组参数生效，策略变更即失效。'
    }
  )
  graph.addNode(
    'act',
    async (state, ctx) => ({
      ...(await handlers.act(state, ctx)),
      call: null,
      approved: false,
      ...stamp('act')
    }),
    {
      title: '执行工具',
      kind: 'tool',
      description: '在重新校验策略后调用工具，并把原始结果作为证据记录下来。'
    }
  )
  // Node names may not collide with channel names — the `answer` channel holds
  // the text, `conclude` is the node that records it.
  graph.addNode(
    'conclude',
    async (state, ctx) => ({ ...(await handlers.answer(state, ctx)), ...stamp('conclude') }),
    {
      title: '给出结论',
      kind: 'output',
      description: '把本轮结论写入任务记录。任务完成不等于测试通过。'
    }
  )
  graph.addNode(
    'dispatched',
    async (state, ctx) => ({ ...(await handlers.dispatched(state, ctx)), ...stamp('dispatched') }),
    {
      title: '派发完成',
      kind: 'output',
      description: '记录测试 Run ID；最终状态必须到测试中心查看。'
    }
  )
  graph.addNode(
    'rejected',
    async (state, ctx) => ({ ...(await handlers.rejected(state, ctx)), ...stamp('rejected') }),
    {
      title: '已拒绝',
      kind: 'output',
      description: '用户拒绝了这次动作，任务停止，不做任何替代操作。'
    }
  )

  graph.addConditionalEdges(
    START,
    (state) => (state.mode === 'workflow' && state.turns === 0 ? 'seed_workflow' : 'plan'),
    ['seed_workflow', 'plan'],
    { labels: { seed_workflow: '测试工作流', plan: 'Agent 对话' } }
  )
  graph.addConditionalEdges(
    'seed_workflow',
    (state) => (state.write ? 'approve' : 'act'),
    ['approve', 'act'],
    {
      labels: { approve: '需确认', act: '只读' }
    }
  )
  graph.addConditionalEdges(
    'plan',
    (state) => (state.call ? (state.write ? 'approve' : 'act') : 'conclude'),
    ['approve', 'act', 'conclude'],
    { labels: { approve: '写动作', act: '读动作', conclude: '无需工具' } }
  )
  graph.addConditionalEdges(
    'approve',
    (state) => (state.approved ? 'act' : 'rejected'),
    ['act', 'rejected'],
    {
      labels: { act: '已确认', rejected: '已拒绝' }
    }
  )
  graph.addConditionalEdges(
    'act',
    (state) => (state.mode === 'workflow' ? 'dispatched' : 'plan'),
    ['dispatched', 'plan'],
    {
      labels: { dispatched: '工作流结束', plan: '继续规划' }
    }
  )
  graph.addEdge('conclude', END)
  graph.addEdge('dispatched', END)
  graph.addEdge('rejected', END)

  return graph.compile({ maxSteps })
}
