import { randomUUID } from 'node:crypto'
import { RigError, TERMINAL, text, safeMessage } from '../contracts/index.mjs'
import { DEFINITIONS, toolSchemas } from './tools.mjs'
import { START } from '../graph/graph.mjs'
import { applyCapture, renderTemplate, validateOrchestration } from '../graph/orchestration.mjs'
import { buildMissionGraph } from './mission-graph.mjs'
import { compileOrchestration } from './orchestration-graph.mjs'

export class RigRuntime {
  constructor({ store, client, executor, owner }) {
    this.store = store
    this.client = client
    this.executor = executor
    this.owner = owner
    this.active = null
    this.controller = null
    this.job = null
    this.closed = false
    this.graph = buildMissionGraph({
      seedWorkflow: (state, ctx) => this.#seedWorkflow(state, ctx),
      plan: (state, ctx) => this.#plan(state, ctx),
      act: (state, ctx) => this.#act(state, ctx),
      answer: (state, ctx) => this.#answer(state, ctx),
      dispatched: (state, ctx) => this.#dispatched(state, ctx),
      rejected: (state, ctx) => this.#rejected(state, ctx)
    })
    // Compiled orchestrations, keyed by spec key + policy revision: editing a
    // spec produces a new revision, so a stale graph can never be reused.
    this.compiled = new Map()
  }
  /** The compiled shape, for the orchestration centre. */
  describe() {
    return this.graph.describe()
  }
  list() {
    return this.store.list(this.owner)
  }
  async followup(id, input) {
    if (this.closed || this.active) throw new RigError('busy', '请先完成或取消当前任务', 409)
    const row = this.store.get(id, this.owner)
    if (!TERMINAL.has(row.status)) throw new RigError('busy', '这项任务尚未结束', 409)
    const goal = text(input.goal, '补充说明', 8000)
    if (row.events.length > 100 || row.messages.length > 60)
      throw new RigError('history_budget', '这项任务历史已较长，请创建新任务并引用执行 ID', 409)
    this.active = id
    if (row.testRunId)
      row.messages.push({
        role: 'assistant',
        content: `此前工作流派发的测试 Run ID 为 ${row.testRunId}。仍须读取原始状态。`
      })
    row.messages.push({ role: 'user', content: goal })
    row.mode = 'agent'
    row.turns = 0
    row.status = 'queued'
    row.result = null
    row.pending = null
    row.graph = null
    try {
      await this.event(row, 'user', goal)
    } catch (error) {
      this.active = null
      throw error
    }
    this.launch(row, () => this.run(row))
    return this.store.public(row)
  }
  async start(input) {
    if (this.closed || this.active)
      throw new RigError('busy', '已有任务运行或等待确认，请先完成或取消', 409)
    const goal = text(input.goal, '任务目标', 8000)
    if (!['agent', 'workflow', 'orchestration'].includes(input.mode))
      throw new RigError('invalid_mode', '请选择 Agent、测试工作流或编排')
    const taskId = input.mode === 'workflow' ? text(input.taskId, '测试计划', 200) : null
    const agentKey =
      input.mode === 'agent' && input.agentKey ? text(input.agentKey, 'Agent', 64) : null
    const orchestrationKey =
      input.mode === 'orchestration' ? text(input.orchestrationKey, '编排', 64) : null
    const inputs = input.mode === 'orchestration' ? readInputs(input.inputs) : null
    // Reserve synchronously before the first await, including durable create.
    this.active = 'creating'
    let row
    try {
      row = await this.store.create(this.owner, {
        goal,
        mode: input.mode,
        agentKey,
        orchestrationKey,
        inputs
      })
      this.active = row.id
    } catch (error) {
      this.active = null
      throw error
    }
    row.messages = [{ role: 'user', content: goal }]
    row.workflowTaskId = taskId
    this.launch(row, () => this.run(row))
    return this.store.public(row)
  }
  launch(row, work) {
    this.controller = new AbortController()
    this.job = (async () => {
      try {
        if (row.status !== 'cancelled' && !this.closed) await work()
      } catch (error) {
        if (process.env.MX_RIG_DEBUG_ERRORS === '1') console.error('[mx-rig]', error)
        if (row.status !== 'cancelled') {
          row.status = 'blocked'
          await this.event(row, 'error', safeMessage(error))
        }
      } finally {
        if (TERMINAL.has(row.status)) {
          try {
            await this.executor.close()
          } finally {
            if (this.active === row.id) this.active = null
          }
        }
        await this.store.save(row)
      }
    })()
    // Callers poll durable events; no detached rejection is left behind.
    this.job.catch(() => {
      this.active = null
    })
  }
  async event(row, kind, message, data) {
    row.events.push({ at: new Date().toISOString(), kind, message, ...(data ? { data } : {}) })
    if (row.events.length > 150) throw new RigError('event_limit', '任务事件超过预算')
    await this.store.save(row)
  }
  async config(row) {
    const config = await this.client.request(
      '/api/rig/v1/execution-config',
      undefined,
      this.controller.signal
    )
    row.policyRevision = config.policy.revision
    return config
  }
  /** Kept for callers and tests that only need the policy half. */
  async policy(row) {
    return (await this.config(row)).policy
  }

  // -- graph execution --------------------------------------------------------

  /**
   * Run the mission graph from the start, or resume it at the approval node.
   *
   * The checkpoint lives on the mission row, so an interrupt survives a
   * process restart as `blocked` rather than as a half-applied action.
   */
  async run(row, { resume, config } = {}) {
    const context = {
      row,
      config: config ?? null,
      ensureConfig: async () => (context.config ??= await this.config(row))
    }
    const graph = await this.graphFor(row, context)
    const checkpoint = row.graph
    const result = await graph.run({
      state:
        checkpoint?.state ??
        (row.mode === 'orchestration'
          ? graph.initialState({ vars: { ...(row.inputs ?? {}) } })
          : graph.initialState({ mode: row.mode, turns: row.turns || 0 })),
      next: resume === undefined ? START : (checkpoint?.next ?? START),
      // A fan-out leaves other paths waiting behind the one that paused, and a
      // join remembers how many branches have arrived. Both have to survive an
      // approval, or the branches that had not run yet are simply lost.
      queue: resume === undefined ? [] : (checkpoint?.queue ?? []),
      arrivals: resume === undefined ? {} : (checkpoint?.arrivals ?? {}),
      resume,
      context,
      signal: this.controller.signal,
      // The durable checkpoint is written once, below: writing it per step
      // would record a cursor without the queue that belongs with it.
      onStep: async ({ state }) => {
        row.trace = state.trace
      }
    })
    row.trace = result.state.trace
    const resting = { queue: result.queue, arrivals: result.arrivals, state: result.state }
    if (result.status === 'interrupted') {
      row.graph = { next: result.node, ...resting }
      const revision = (await context.ensureConfig()).policy.revision
      row.status = 'awaiting_approval'
      // A checkpoint node pauses on a written question rather than on a tool
      // call; both go through the same approval record so the runtime has one
      // notion of "waiting for a person".
      if (result.value.checkpoint) {
        const node = result.value.checkpoint
        row.pending = {
          id: node.id,
          name: 'checkpoint',
          args: { 检查点: node.title, 说明: result.value.message },
          approvalId: randomUUID(),
          policyRevision: revision
        }
        await this.event(row, 'approval', `请确认检查点：${node.title}`, {
          checkpoint: node.id,
          message: result.value.message
        })
        return
      }
      const call = result.value.call
      row.pending = { ...call, approvalId: randomUUID(), policyRevision: revision }
      await this.event(row, 'approval', `请核对并确认 ${call.name}`, {
        tool: call.name,
        args: call.args
      })
      return
    }
    row.graph = { next: null, ...resting }
  }

  /** The mission loop for agent/workflow, a compiled spec for orchestration. */
  async graphFor(row, context) {
    if (row.mode !== 'orchestration') return this.graph
    const config = await context.ensureConfig()
    const available = config.orchestrations || []
    const spec = available.find((entry) => entry.key === row.orchestrationKey)
    if (!spec) throw new RigError('orchestration_unknown', '编排不存在或已停用', 404)
    // Subflows are inlined here too, against the same published list, so the
    // runtime executes exactly the graph the orchestration centre drew.
    const { expanded } = validateOrchestration(spec, {
      resolve: (key) => available.find((entry) => entry.key === key) ?? null
    })
    const cacheKey = `${spec.key}@${config.policy.revision}`
    let compiled = this.compiled.get(cacheKey)
    if (!compiled) {
      compiled = compileOrchestration(expanded, {
        prepareTool: (node, state, ctx) => this.#prepareTool(node, state, ctx),
        branch: (node, _state, ctx) => this.#branch(node, ctx),
        fanout: (node, ctx) => this.#fanout(node, ctx),
        subflow: (node, state, ctx) => this.#subflow(node, state, ctx),
        checkpoint: (node, approved, ctx) => this.#checkpoint(node, approved, ctx),
        analyze: (node, state, ctx) => this.#analyze(node, state, ctx),
        act: (state, ctx) => this.#actAuthored(expanded, state, ctx),
        finish: (node, state, ctx) => this.#finishAuthored(node, state, ctx),
        rejected: (ctx) => this.#rejected(null, ctx),
        conclude: (state, ctx) => this.#concludeAuthored(state, ctx)
      })
      this.compiled.clear()
      this.compiled.set(cacheKey, compiled)
    }
    return compiled
  }

  async #prepareTool(node, state, ctx) {
    const { policy } = await ctx.ensureConfig()
    ctx.row.status = 'running'
    const args = Object.fromEntries(
      Object.entries(node.args).map(([name, template]) => [
        name,
        renderTemplate(template, state.vars)
      ])
    )
    const def = this.executor.definition(node.tool, args, policy)
    return { call: { id: randomUUID(), name: node.tool, args }, write: def.effect === 'write' }
  }

  async #branch(node, ctx) {
    await this.event(ctx.row, 'thinking', `判断分支：${node.title}`)
    return {}
  }

  async #subflow(node, state, ctx) {
    const vars = Object.fromEntries(
      Object.entries(node.seed ?? {}).map(([name, template]) => [
        name,
        renderTemplate(template, state.vars)
      ])
    )
    await this.event(ctx.row, 'thinking', `进入子编排 ${node.orchestrationKey}：${node.title}`, {
      vars
    })
    return { vars }
  }

  async #fanout(node, ctx) {
    await this.event(
      ctx.row,
      'thinking',
      `分叉：${node.branches.length} 条分支将依次执行，全部完成后汇合到 ${node.join}`
    )
    return {}
  }

  async #checkpoint(node, approved, ctx) {
    await this.event(
      ctx.row,
      approved ? 'approved' : 'cancelled',
      approved ? `检查点已通过：${node.title}` : `检查点被拒绝：${node.title}`
    )
    return {}
  }

  /**
   * One model turn over the evidence already gathered. No tools are offered:
   * an authored analysis step summarises what the orchestration collected, it
   * does not get to go looking for more on its own.
   */
  async #analyze(node, state, ctx) {
    const { row } = ctx
    const { policy } = await ctx.ensureConfig()
    if ((row.turns || 0) >= policy.maxTurns)
      throw new RigError('turn_budget', '编排中的分析步数已达上限，请精简编排后重试')
    row.status = 'running'
    row.turns = (row.turns || 0) + 1
    await this.event(row, 'thinking', `交给 ${node.agentKey} 分析：${node.title}`)
    const evidence = (row.evidence ?? [])
      .map((entry) => `【${entry.tool}】${entry.summary}`)
      .join('\n\n')
      .slice(0, 40_000)
    const variables = Object.entries(state.vars)
      .map(([name, value]) => `${name} = ${value}`)
      .join('\n')
    const { message } = await this.client.request(
      '/api/rig/v1/model/turn',
      {
        agentKey: node.agentKey,
        messages: [
          {
            role: 'user',
            content: `${node.instruction}\n\n当前变量：\n${variables || '（无）'}\n\n已收集的证据（工具原始返回）：\n${evidence || '（无）'}`
          }
        ],
        tools: []
      },
      ctx.signal
    )
    const answer = message.content || '模型没有返回文本。'
    await this.event(row, 'answer', answer)
    return { answer }
  }

  async #actAuthored(spec, state, ctx) {
    const { row } = ctx
    const { policy } = await ctx.ensureConfig()
    row.status = 'running'
    row.pending = null
    const call = state.call
    await this.event(row, 'tool_start', `执行 ${call.name}`, { tool: call.name })
    const result = await this.executor.execute(call.name, call.args, {
      policy,
      approved: state.approved,
      signal: this.controller.signal,
      missionId: row.id
    })
    const summary = JSON.stringify(result).slice(0, 24_000)
    await this.event(row, 'tool_result', `${call.name} 返回结果`, {
      result:
        JSON.stringify(result).length <= 24_000 ? result : { excerpt: summary, truncated: true }
    })
    this.controller.signal.throwIfAborted()
    row.evidence = [...(row.evidence ?? []), { tool: call.name, summary }].slice(-20)
    if (call.name === 'tests_run' && result.run?.id) row.testRunId = result.run.id
    const node = spec.nodes.find((entry) => entry.id === state.sourceNode)
    const vars = Object.fromEntries(
      Object.entries(node?.capture ?? {}).map(([name, rule]) => [name, applyCapture(result, rule)])
    )
    if (Object.keys(vars).length)
      await this.event(row, 'thinking', `取出变量：${Object.keys(vars).join('、')}`, { vars })
    return { vars }
  }

  async #finishAuthored(node, state, _ctx) {
    return renderTemplate(node.message, state.vars)
  }

  async #concludeAuthored(state, ctx) {
    const { row } = ctx
    row.result = state.answer || '编排已结束。'
    row.status = 'completed'
    await this.event(row, 'answer', row.result)
    return {}
  }

  async #seedWorkflow(_state, ctx) {
    const { policy } = await ctx.ensureConfig()
    const call = { id: randomUUID(), name: 'tests_run', args: { taskId: ctx.row.workflowTaskId } }
    const def = this.executor.definition(call.name, call.args, policy)
    return { call, write: def.effect === 'write' }
  }

  async #plan(state, ctx) {
    const { row } = ctx
    const config = await ctx.ensureConfig()
    const policy = config.policy
    if (state.turns >= policy.maxTurns)
      throw new RigError('turn_budget', '已达到任务步数预算，请检查证据后继续新任务')
    ctx.signal?.throwIfAborted()
    row.status = 'running'
    row.turns = state.turns + 1
    await this.event(row, 'thinking', `正在规划第 ${row.turns} 步`)
    const { message } = await this.client.request(
      '/api/rig/v1/model/turn',
      {
        ...(row.agentKey ? { agentKey: row.agentKey } : {}),
        messages: row.messages,
        tools: toolSchemas(this.#offeredTools(row, config))
      },
      ctx.signal
    )
    ctx.signal?.throwIfAborted()
    if (!message.tool_calls?.length)
      return { turns: row.turns, call: null, write: false, answer: message.content || '' }
    if (message.tool_calls.length !== 1)
      throw new RigError('parallel_not_allowed', '当前版本每步只允许一个工具调用')
    const call = message.tool_calls[0]
    let args
    try {
      args = JSON.parse(call.function.arguments)
    } catch {
      throw new RigError('invalid_arguments', '模型工具参数不是 JSON')
    }
    // Validate before asking for approval: an unknown or malformed call must
    // never reach a human as something that looks reviewable.
    const def = this.executor.definition(call.function.name, args, policy)
    row.messages.push({ role: 'assistant', content: message.content || null, tool_calls: [call] })
    return {
      turns: row.turns,
      call: { id: call.id, name: call.function.name, args },
      write: def.effect === 'write'
    }
  }

  /** Internal allow-list ∩ the Agent's own tools ∩ what this surface can run. */
  #offeredTools(row, config) {
    const agent = row.agentKey
      ? (config.agents || []).find((entry) => entry.key === row.agentKey)
      : null
    return DEFINITIONS.filter(
      (def) =>
        config.policy.allowedTools.includes(def.name) &&
        (!agent || agent.tools.includes(def.name)) &&
        (!def.local || Boolean(this.executor.browser))
    ).map((def) => def.name)
  }

  async #act(state, ctx) {
    const { row } = ctx
    const { policy } = await ctx.ensureConfig()
    row.status = 'running'
    row.pending = null
    const call = state.call
    await this.event(row, 'tool_start', `执行 ${call.name}`, { tool: call.name })
    const result = await this.executor.execute(call.name, call.args, {
      policy,
      approved: state.approved,
      signal: this.controller.signal,
      missionId: row.id
    })
    // Record actual results even if cancellation raced a non-idempotent action.
    const summary = JSON.stringify(result).slice(0, 24_000)
    await this.event(row, 'tool_result', `${call.name} 返回结果`, {
      result:
        JSON.stringify(result).length <= 24_000 ? result : { excerpt: summary, truncated: true }
    })
    this.controller.signal.throwIfAborted()
    if (row.mode === 'agent')
      row.messages.push({ role: 'tool', tool_call_id: call.id, content: summary })
    else row.testRunId = result.run?.id || null
    return {}
  }

  async #answer(state, ctx) {
    const { row } = ctx
    row.result = state.answer || '任务结束，未返回文本。'
    row.status = 'completed'
    row.messages.push({ role: 'assistant', content: row.result })
    await this.event(row, 'answer', row.result)
    return {}
  }

  async #dispatched(_state, ctx) {
    const { row } = ctx
    row.result = '测试任务已派发。请到测试中心检查测试 Run 的最终状态；派发成功不代表测试通过。'
    row.status = 'completed'
    await this.event(row, 'answer', row.result)
    return {}
  }

  async #rejected(_state, ctx) {
    const { row } = ctx
    row.status = 'cancelled'
    row.pending = null
    await this.event(row, 'cancelled', '用户拒绝了动作')
    return {}
  }

  // -- lifecycle --------------------------------------------------------------

  async approve(id, approvalId, approved) {
    if (typeof approved !== 'boolean')
      throw new RigError('invalid_approval', '确认结果必须是布尔值')
    await this.job
    const row = this.store.get(id, this.owner)
    if (this.closed || (this.active && this.active !== id))
      throw new RigError('busy', '另一个任务正在运行', 409)
    if (row.status !== 'awaiting_approval' || row.pending?.approvalId !== approvalId)
      throw new RigError('stale_approval', '确认已过期或已处理', 409)
    const call = structuredClone(row.pending)
    row.status = 'running'
    row.pending = null
    this.active = id
    await this.store.save(row)
    this.launch(row, async () => {
      if (!approved) {
        await this.run(row, { resume: false })
        return
      }
      const config = await this.config(row)
      if (config.policy.revision !== call.policyRevision)
        throw new RigError('policy_changed', 'Internal 策略已改变，请重新发起任务')
      await this.event(row, 'approved', '用户批准了这一次具体动作', { tool: call.name })
      await this.run(row, { resume: true, config })
    })
    return this.store.public(row)
  }
  async cancel(id) {
    const row = this.store.get(id, this.owner)
    if (TERMINAL.has(row.status)) return this.store.public(row)
    row.status = 'cancelled'
    row.pending = null
    this.controller?.abort()
    await this.event(
      row,
      'cancelled',
      '已取消 Agent 任务。已经提交到测试中心的 Run 需在那里单独取消；已发生的外部动作不会自动撤销。'
    )
    await this.executor.close()
    await this.job
    if (this.active === id) this.active = null
    return this.store.public(row)
  }
  async close() {
    this.closed = true
    if (this.active && this.active !== 'creating') await this.cancel(this.active)
    await this.job
    await this.executor.close()
  }
}

/** Orchestration inputs are a flat string bag; nothing else is accepted. */
function readInputs(value) {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value))
    throw new RigError('invalid_input', '编排输入必须是对象')
  const entries = Object.entries(value)
  if (entries.length > 6) throw new RigError('invalid_input', '编排输入最多 6 项')
  return Object.fromEntries(
    entries.map(([name, item]) => [
      text(name, '输入名称', 40),
      text(String(item ?? ''), `输入 ${name}`, 400)
    ])
  )
}
