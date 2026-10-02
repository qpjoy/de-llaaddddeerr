import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'

const call = (id, name, args = {}) => ({
  tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }]
})

async function fixture(t, { replies, preauth = true }) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-crew-'))
  const store = await new MissionStore(root).init()
  const policy = {
    revision: 'v1',
    maxTurns: 10,
    allowedTools: ['browser_snapshot', 'browser_click', 'tests_run'],
    browserOrigins: ['https://staging.example'],
    browserPreauth: preauth
  }
  const clicks = []
  const browser = {
    async execute(name, args) {
      if (name === 'browser_click') clicks.push(args.ref)
      return { url: 'https://staging.example/', snapshot: '- button "保存" [ref=e1]' }
    },
    async close() {}
  }
  const gate = { wait: null }
  const client = {
    async request(path, body, signal) {
      signal?.throwIfAborted()
      if (path === '/api/rig/v1/execution-config')
        return { policy: structuredClone(policy), model: { configured: true }, agents: [] }
      if (path === '/api/rig/v1/model/turn') {
        if (gate.wait) await gate.wait
        return { message: replies.shift() ?? { content: '完成' } }
      }
      if (path.endsWith(':run')) return { run: { id: 'trun_x', status: 'queued' } }
      throw new Error(`unexpected ${path}`)
    }
  }
  const engine = new RigRuntime({
    store,
    client,
    executor: new ToolExecutor(client, browser),
    owner: 'alice'
  })
  t.after(() => engine.close())
  return { store, engine, policy, clicks, gate }
}

test('a mission grant stands in for browser clicks, only while policy allows', async (t) => {
  const f = await fixture(t, {
    replies: [
      call('c1', 'browser_click', { ref: 'e1' }),
      call('c2', 'browser_click', { ref: 'e1' }),
      { content: '点完了' }
    ]
  })
  const row = await f.engine.start({
    mode: 'agent',
    goal: '点保存',
    grants: { browserWrites: true }
  })
  await f.engine.job
  const done = f.store.get(row.id, 'alice')
  assert.equal(done.status, 'completed')
  assert.equal(f.clicks.length, 2)
  assert.equal(done.events.filter((event) => event.data?.preauthorized === 'mission').length, 2)
  assert.equal(
    done.grants.policyRevision,
    'v1',
    'the grant bound to the revision it was first used under'
  )

  const off = await fixture(t, {
    preauth: false,
    replies: [call('c1', 'browser_click', { ref: 'e1' })]
  })
  const again = await off.engine.start({
    mode: 'agent',
    goal: '点保存',
    grants: { browserWrites: true }
  })
  await off.engine.job
  assert.equal(
    off.store.get(again.id, 'alice').status,
    'awaiting_approval',
    'no admin permission, no grant'
  )
  assert.equal(off.clicks.length, 0)
})

test('a policy change takes the grant back, and it never covers a dispatch', async (t) => {
  const f = await fixture(t, {
    replies: [
      call('c1', 'browser_click', { ref: 'e1' }),
      call('c2', 'browser_click', { ref: 'e1' })
    ]
  })
  const row = await f.engine.start({
    mode: 'agent',
    goal: '点两次',
    grants: { browserWrites: true }
  })
  // Change the policy as soon as the first click has been auto-approved.
  const original = f.engine.executor.execute.bind(f.engine.executor)
  f.engine.executor.execute = async (...args) => {
    const result = await original(...args)
    f.policy.revision = 'v2'
    return result
  }
  await f.engine.job
  const paused = f.store.get(row.id, 'alice')
  // The executor re-reads policy before each action: the revision moved, so
  // the running mission stops rather than carrying the old grant forward.
  assert.ok(['awaiting_approval', 'blocked'].includes(paused.status))
  assert.equal(f.clicks.length, 1)

  const dispatch = await fixture(t, { replies: [call('c1', 'tests_run', { taskId: 'tsk_1' })] })
  const run = await dispatch.engine.start({
    mode: 'agent',
    goal: '派发',
    grants: { browserWrites: true }
  })
  await dispatch.engine.job
  const waiting = dispatch.store.get(run.id, 'alice')
  assert.equal(waiting.status, 'awaiting_approval')
  assert.equal(waiting.pending.name, 'tests_run')
})

test('a person can take the browser over and hand it back', async (t) => {
  let release
  const f = await fixture(t, {
    replies: [call('c1', 'browser_snapshot'), { content: '重新看过页面，已完成。' }]
  })
  f.gate.wait = new Promise((resolve) => {
    release = resolve
  })
  const row = await f.engine.start({ mode: 'agent', goal: '巡检' })
  for (let i = 0; i < 50 && f.store.get(row.id, 'alice').status !== 'running'; i += 1)
    await new Promise((resolve) => setTimeout(resolve, 5))
  await f.engine.takeover(row.id)
  f.gate.wait = null
  release()
  await f.engine.job
  let state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'awaiting_approval')
  assert.equal(state.pending.name, 'takeover')

  await f.engine.approve(row.id, state.pending.approvalId, true)
  await f.engine.job
  state = f.store.get(row.id, 'alice')
  assert.equal(state.status, 'completed')
  assert.ok(state.messages.some((message) => /手动操作过页面/.test(message.content ?? '')))
  assert.ok(state.events.some((event) => /交还了控制/.test(event.message)))
  await assert.rejects(f.engine.takeover(row.id), { code: 'not_running' })
})

test('a vision-capable model sees only the latest screenshot; others see none', async (t) => {
  const { modelTurnBody } = await import('../apps/server/schemas.mjs')
  const run = async (vision) => {
    const root = await mkdtemp(join(tmpdir(), 'mx-rig-vision-'))
    const store = await new MissionStore(root).init()
    const replies = [
      call('c1', 'browser_snapshot'),
      call('c2', 'browser_snapshot'),
      { content: '看完了' }
    ]
    const turns = []
    let frame = 0
    const browser = {
      vision: false,
      lastFrame: null,
      async execute() {
        this.lastFrame = this.vision ? Buffer.from(`frame-${++frame}`).toString('base64') : null
        return { url: 'https://staging.example/', snapshot: '- button "保存" [ref=e1]' }
      },
      async close() {}
    }
    const client = {
      async request(path, body) {
        if (path === '/api/rig/v1/execution-config')
          return {
            policy: {
              revision: 'v1',
              maxTurns: 6,
              allowedTools: ['browser_snapshot'],
              browserOrigins: ['https://staging.example']
            },
            model: { configured: true, vision },
            agents: []
          }
        if (path === '/api/rig/v1/model/turn') {
          turns.push(structuredClone(body))
          return { message: replies.shift() }
        }
        throw new Error(path)
      }
    }
    const engine = new RigRuntime({
      store,
      client,
      executor: new ToolExecutor(client, browser),
      owner: 'a'
    })
    t.after(() => engine.close())
    const row = await engine.start({ mode: 'agent', goal: '看看页面' })
    await engine.job
    assert.equal(store.get(row.id, 'a').status, 'completed')
    return turns.at(-1).messages
  }
  const images = (messages) =>
    messages.filter(
      (m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image_url')
    )

  const withVision = await run(true)
  assert.equal(images(withVision).length, 1, 'only the latest frame travels')
  assert.match(images(withVision)[0].content[1].image_url.url, /^data:image\/jpeg;base64,/)
  assert.equal(
    Buffer.from(images(withVision)[0].content[1].image_url.url.split(',')[1], 'base64').toString(),
    'frame-2'
  )
  assert.ok(
    withVision.some((m) => m.role === 'user' && /截图/.test(m.content ?? '')),
    'the older frame became text'
  )
  assert.equal(modelTurnBody.safeParse({ messages: withVision, tools: [] }).success, true)

  const without = await run(false)
  assert.equal(images(without).length, 0)

  const twoImages = [...withVision, images(withVision)[0]]
  assert.equal(modelTurnBody.safeParse({ messages: twoImages, tools: [] }).success, false)
})
