import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'

async function fixture(t, replies = []) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-test-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 3,
    allowedTools: ['tests_list', 'tests_run', 'tests_result'],
    browserOrigins: []
  }
  const calls = []
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      calls.push({ path, body })
      if (path === '/api/rig/v1/execution-config') return { policy: structuredClone(policy) }
      if (path === '/api/rig/v1/model/turn')
        return { message: replies.shift() || { content: '完成' } }
      if (path === '/api/v1/tasks') return { tasks: [{ id: 'task-a' }] }
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
  return { root, store, engine, policy, calls, client }
}
test('workflow waits for exact approval and never declares test passed', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'workflow', goal: 'run smoke', taskId: 'task-a' })
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'awaiting_approval')
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 0)
  await assert.rejects(f.engine.approve(row.id, 'wrong', true), { code: 'stale_approval' })
  await f.engine.approve(row.id, state.pending.approvalId, true)
  await f.engine.job
  assert.equal(state.status, 'completed')
  assert.equal(state.testRunId, 'run-a')
  assert.match(state.result, /不代表测试通过/)
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 1)
})
test('concurrent approvals execute once', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'workflow', goal: 'run', taskId: 'task-a' })
  await f.engine.job
  const approval = f.store.get(row.id, 'alice').pending.approvalId
  const results = await Promise.allSettled([
    f.engine.approve(row.id, approval, true),
    f.engine.approve(row.id, approval, true)
  ])
  await f.engine.job
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 1)
})
test('policy change invalidates a previously approved action', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'workflow', goal: 'run', taskId: 'task-a' })
  await f.engine.job
  f.policy.revision = 'v2'
  await f.engine.approve(row.id, f.store.get(row.id, 'alice').pending.approvalId, true)
  await f.engine.job
  assert.equal(f.store.get(row.id, 'alice').status, 'blocked')
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 0)
})
test('reject, cancel and restart do not replay a mutating action', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'workflow', goal: 'run', taskId: 'task-a' })
  await f.engine.job
  const pending = f.store.get(row.id, 'alice').pending.approvalId
  const recovered = await new MissionStore(f.root).init()
  assert.equal(recovered.get(row.id, 'alice').status, 'blocked')
  assert.equal(recovered.get(row.id, 'alice').pending, null)
  await f.engine.approve(row.id, pending, false)
  await f.engine.job
  assert.equal(f.store.get(row.id, 'alice').status, 'cancelled')
  const next = await f.engine.start({ mode: 'workflow', goal: 'run again', taskId: 'task-a' })
  await f.engine.job
  await f.engine.cancel(next.id)
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 0)
})
test('agent uses read tool, records evidence and bounds loop', async (t) => {
  const call = {
    content: null,
    tool_calls: [
      { id: 'call-1', type: 'function', function: { name: 'tests_list', arguments: '{}' } }
    ]
  }
  const f = await fixture(t, [call, { content: '只有 task-a。' }])
  const row = await f.engine.start({ mode: 'agent', goal: 'list tests' })
  await f.engine.job
  const state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'completed')
  assert.equal(state.turns, 2)
  assert.equal(state.events.find((e) => e.kind === 'tool_result').data.result.tasks[0].id, 'task-a')
  assert.equal(f.store.public(state).messages, undefined)
})
test('unknown tools, extra arguments, cross-user access and concurrent start fail closed', async (t) => {
  const f = await fixture(t, [
    { tool_calls: [{ id: '1', type: 'function', function: { name: 'shell', arguments: '{}' } }] }
  ])
  assert.throws(
    () => f.engine.executor.definition('tests_run', { taskId: 'a', command: 'rm' }, f.policy),
    { code: 'invalid_arguments' }
  )
  const first = f.engine.start({ mode: 'agent', goal: 'attempt shell' })
  await assert.rejects(f.engine.start({ mode: 'agent', goal: 'second' }), { code: 'busy' })
  const row = await first
  await f.engine.job
  assert.equal(f.store.get(row.id, 'alice').status, 'blocked')
  assert.throws(() => f.store.get(row.id, 'bob'), { code: 'not_found' })
})
test('browser origin policy does not accept prefix matches, credentials or file URLs', () => {
  const browser = new BrowserTools('/unused')
  const policy = { browserOrigins: ['https://test.example'] }
  for (const url of [
    'https://test.example.evil',
    'https://test.example@evil',
    'file:///etc/passwd',
    'https://user:pass@test.example'
  ])
    assert.equal(browser.allowed(url, policy), false)
  assert.equal(browser.allowed('https://test.example/path', policy), true)
})
test('follow-up keeps the assistant answer and stays in the same owned mission', async (t) => {
  const f = await fixture(t, [{ content: 'first answer' }, { content: 'second answer' }])
  const row = await f.engine.start({ mode: 'agent', goal: 'first question' })
  await f.engine.job
  await f.engine.followup(row.id, { goal: 'second question' })
  await f.engine.job
  const state = f.store.get(row.id, 'alice')
  assert.equal(state.result, 'second answer')
  assert.equal(f.engine.list().length, 1)
  assert.deepEqual(
    state.messages.map((m) => m.content),
    ['first question', 'first answer', 'second question', 'second answer']
  )
  assert.equal(state.events.filter((e) => e.kind === 'answer').length, 2)
})
test('cancelling while approval is being persisted prevents execution', async (t) => {
  const f = await fixture(t)
  const row = await f.engine.start({ mode: 'workflow', goal: 'run', taskId: 'task-a' })
  await f.engine.job
  const approval = f.store.get(row.id, 'alice').pending.approvalId
  const save = f.store.save.bind(f.store)
  let release, entered
  const ready = new Promise((r) => {
    entered = r
  })
  let hold = true
  f.store.save = async (state) => {
    if (hold && state.status === 'running') {
      hold = false
      entered()
      await new Promise((r) => {
        release = r
      })
    }
    return save(state)
  }
  const approved = f.engine.approve(row.id, approval, true)
  await ready
  await f.engine.cancel(row.id)
  release()
  await approved
  await f.engine.job
  assert.equal(f.store.get(row.id, 'alice').status, 'cancelled')
  assert.equal(f.calls.filter((c) => c.path.endsWith(':run')).length, 0)
})
