import { randomUUID } from 'node:crypto'
import { RigError, TERMINAL, text, safeMessage } from '../contracts/index.mjs'
import { DEFINITIONS } from './tools.mjs'

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
    try {
      await this.event(row, 'user', goal)
    } catch (error) {
      this.active = null
      throw error
    }
    this.launch(row, () => this.advance(row))
    return this.store.public(row)
  }
  async start(input) {
    if (this.closed || this.active)
      throw new RigError('busy', '已有任务运行或等待确认，请先完成或取消', 409)
    const goal = text(input.goal, '任务目标', 8000)
    if (!['agent', 'workflow'].includes(input.mode))
      throw new RigError('invalid_mode', '请选择 Agent 或测试工作流')
    const taskId = input.mode === 'workflow' ? text(input.taskId, '测试计划', 200) : null
    // Reserve synchronously before the first await, including durable create.
    this.active = 'creating'
    let row
    try {
      row = await this.store.create(this.owner, { goal, mode: input.mode })
      this.active = row.id
    } catch (error) {
      this.active = null
      throw error
    }
    row.messages = [{ role: 'user', content: goal }]
    row.workflowTaskId = taskId
    this.launch(row, () => this.advance(row))
    return this.store.public(row)
  }
  launch(row, work) {
    this.controller = new AbortController()
    this.job = (async () => {
      try {
        if (row.status !== 'cancelled' && !this.closed) await work()
      } catch (error) {
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
  async policy(row) {
    const { policy } = await this.client.request(
      '/api/rig/v1/execution-config',
      undefined,
      this.controller.signal
    )
    row.policyRevision = policy.revision
    return policy
  }
  async advance(row) {
    const signal = this.controller.signal
    const policy = await this.policy(row)
    if (row.mode === 'workflow') {
      return this.call(
        row,
        { id: randomUUID(), name: 'tests_run', args: { taskId: row.workflowTaskId } },
        policy
      )
    }
    for (let step = row.turns || 0; step < policy.maxTurns; step++) {
      signal.throwIfAborted()
      row.status = 'running'
      row.turns = step + 1
      await this.event(row, 'thinking', `正在规划第 ${row.turns} 步`)
      const { message } = await this.client.request(
        '/api/rig/v1/model/turn',
        {
          messages: row.messages,
          tools: DEFINITIONS.filter(
            (d) => policy.allowedTools.includes(d.name) && (!d.local || this.executor.browser)
          ).map(({ name, description, parameters }) => ({
            type: 'function',
            function: { name, description, parameters }
          }))
        },
        signal
      )
      signal.throwIfAborted()
      if (!message.tool_calls?.length) {
        row.result = message.content || '任务结束，未返回文本。'
        row.status = 'completed'
        row.messages.push({ role: 'assistant', content: row.result })
        await this.event(row, 'answer', row.result)
        return
      }
      if (message.tool_calls.length !== 1)
        throw new RigError('parallel_not_allowed', '当前版本每步只允许一个工具调用')
      const call = message.tool_calls[0]
      let args
      try {
        args = JSON.parse(call.function.arguments)
      } catch {
        throw new RigError('invalid_arguments', '模型工具参数不是 JSON')
      }
      row.messages.push({ role: 'assistant', content: message.content || null, tool_calls: [call] })
      const waiting = await this.call(row, { id: call.id, name: call.function.name, args }, policy)
      if (waiting) return
    }
    throw new RigError('turn_budget', '已达到任务步数预算，请检查证据后继续新任务')
  }
  async call(row, call, policy, approved = false) {
    const def = this.executor.definition(call.name, call.args, policy)
    if (def.effect === 'write' && !approved) {
      row.status = 'awaiting_approval'
      row.pending = { ...call, approvalId: randomUUID(), policyRevision: policy.revision }
      await this.event(row, 'approval', `请核对并确认 ${call.name}`, {
        tool: call.name,
        args: call.args
      })
      return true
    }
    row.status = 'running'
    row.pending = null
    await this.event(row, 'tool_start', `执行 ${call.name}`, { tool: call.name })
    const result = await this.executor.execute(call.name, call.args, {
      policy,
      approved,
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
    if (row.mode === 'workflow') {
      row.result = '测试任务已派发。请到测试中心检查测试 Run 的最终状态；派发成功不代表测试通过。'
      row.testRunId = result.run?.id || null
      row.status = 'completed'
      await this.event(row, 'answer', row.result)
    } else row.messages.push({ role: 'tool', tool_call_id: call.id, content: summary })
    return false
  }
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
        row.status = 'cancelled'
        await this.event(row, 'cancelled', '用户拒绝了动作')
        return
      }
      const policy = await this.policy(row)
      if (policy.revision !== call.policyRevision)
        throw new RigError('policy_changed', 'Internal 策略已改变，请重新发起任务')
      await this.event(row, 'approved', '用户批准了这一次具体动作', { tool: call.name })
      await this.call(row, call, policy, true)
      if (row.mode === 'agent') await this.advance(row)
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
