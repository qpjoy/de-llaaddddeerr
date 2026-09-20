import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { start } from '../apps/server/index.mjs'
import { waitForRun } from '../packages/runtime/tools.mjs'

async function connect(t, origin, { writes = false, token = 'test-mcp-admin' } = {}) {
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL('../bin/mx-rig-mcp.mjs', import.meta.url))],
    {
      env: {
        PATH: process.env.PATH,
        MX_RIG_URL: origin,
        MX_RIG_TOKEN: token,
        MX_RIG_MCP_ALLOW_WRITES: writes ? '1' : '0'
      },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )
  let errors = ''
  child.stderr.on('data', (chunk) => {
    errors += chunk
  })
  const pending = new Map()
  let sequence = 0
  const lines = createInterface({ input: child.stdout })
  lines.on('line', (line) => {
    const reply = JSON.parse(line) // Any stdout logging corrupts the protocol.
    pending.get(reply.id)?.(reply)
    pending.delete(reply.id)
  })
  t.after(async () => {
    lines.close()
    if (child.exitCode === null) {
      const done = once(child, 'exit')
      child.kill('SIGTERM')
      await done
    }
    assert.equal(errors.includes(token), false)
  })
  const request = (method, params = {}) =>
    new Promise((resolvePromise) => {
      const id = ++sequence
      pending.set(id, resolvePromise)
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  const init = await request('initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'rig-regression', version: '1' }
  })
  assert.equal(init.result.serverInfo.name, 'mx-rig')
  child.stdin.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n')
  return {
    request,
    call: async (name, args = {}) => (await request('tools/call', { name, arguments: args })).result
  }
}

test(
  'stdio MCP executes the real Rig API with host opt-in, policy, role and closed schemas',
  { timeout: 15000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'mx-rig-mcp-'))
    const runtime = await start(
      {
        MX_RIG_ADMIN_TOKEN: 'test-mcp-admin',
        MX_RIG_HOST: '127.0.0.1',
        MX_RIG_PORT: '0',
        MX_RIG_STORE: 'memory',
        MX_RIG_STATE_DIR: root,
        MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
      },
      { schedule: false }
    )
    t.after(async () => {
      await runtime.close()
      await rm(root, { recursive: true, force: true })
    })
    const store = runtime.kernel.store
    const app = await store.createApp({
      slug: 'tool-fixture',
      displayName: 'Tool fixture',
      surfaces: ['web']
    })
    const suite = await store.createSuite({
      appId: app.id,
      slug: 'smoke',
      engine: 'playwright',
      surface: 'web',
      runnerKind: 'local',
      command: ['node', 'fixture.mjs']
    })
    const task = await store.createTask({
      appId: app.id,
      suiteId: suite.id,
      name: 'fixture',
      profile: 'mock',
      track: 'functional',
      scheduleKind: 'manual',
      claimWindowMinutes: 60
    })
    const readonly = await connect(t, runtime.origin)
    const { result: catalog } = await readonly.request('tools/list')
    assert.ok(catalog.tools.some((tool) => tool.name === 'tests_wait'))
    assert.equal(
      catalog.tools.some((tool) => tool.name === 'tests_run' || tool.name.startsWith('browser_')),
      false
    )
    assert.ok(
      (await readonly.request('tools/call', { name: 'tests_run', arguments: { taskId: task.id } }))
        .error
    )
    assert.equal((await readonly.call('tests_apps')).structuredContent.apps[0].slug, app.slug)

    await runtime.settings.update({
      ...runtime.settings.value,
      allowedTools: [...runtime.settings.value.allowedTools, 'tests_cancel']
    })
    const writer = await connect(t, runtime.origin, { writes: true })
    const invalid = await writer.call('tests_run', {
      taskId: task.id,
      command: ['sh', '-c', 'anything']
    })
    assert.equal(invalid.isError, true)
    assert.equal((await store.listRuns({})).length, 0)
    const dispatched = await writer.call('tests_run', { taskId: task.id })
    assert.equal(dispatched.isError, undefined, JSON.stringify(dispatched))
    const run = dispatched.structuredContent.run
    assert.ok(['queued', 'pending-runner'].includes(run.status))
    const cancelled = await writer.call('tests_cancel', { runId: run.id })
    assert.equal(cancelled.isError, undefined, JSON.stringify(cancelled))
    assert.equal(cancelled.structuredContent.run.cancellation.stopState, 'not-started')
    const waited = await writer.call('tests_wait', { runId: run.id, timeoutMs: 1000 })
    assert.equal(waited.structuredContent.run.status, 'cancelled')
    assert.deepEqual(waited.structuredContent.wait, { terminal: true, timedOut: false })
    const original = runtime.kernel.identity.resolve
    runtime.kernel.identity.resolve = async (token, source) =>
      token === 'test-viewer' ? { id: 'viewer', role: 'viewer' } : original(token, source)
    const viewer = await connect(t, runtime.origin, { writes: true, token: 'test-viewer' })
    assert.equal((await viewer.call('tests_run', { taskId: task.id })).isError, true)
    await runtime.settings.update({ ...runtime.settings.value, allowedTools: ['tests_apps'] })
    const denied = await writer.call('tests_run', { taskId: task.id })
    assert.equal(denied.structuredContent.error.code, 'tool_denied')
    assert.equal((await store.listRuns({})).length, 1)
  }
)

test('bounded waits preserve status, distinguish timeout, propagate cancellation and API errors', async () => {
  let polls = 0
  const completed = await waitForRun(
    {
      request: async () => ({
        run: { id: 'trun_fixture', status: ++polls > 1 ? 'failed' : 'running' }
      })
    },
    { runId: 'trun_fixture', timeoutMs: 1000 },
    undefined,
    1
  )
  assert.equal(completed.run.status, 'failed')
  const timeout = await waitForRun(
    { request: async () => ({ run: { status: 'running' } }) },
    { runId: 'trun_fixture', timeoutMs: 15 },
    undefined,
    2
  )
  assert.equal(timeout.run.status, 'running')
  assert.equal(timeout.wait.timedOut, true)
  const controller = new AbortController()
  controller.abort(new Error('caller stopped waiting'))
  await assert.rejects(
    waitForRun(
      {
        request() {
          assert.fail('must not poll')
        }
      },
      { runId: 'x' },
      controller.signal
    ),
    /caller stopped waiting/
  )
  await assert.rejects(
    waitForRun(
      {
        request: async () => {
          throw new Error('forbidden')
        }
      },
      { runId: 'x' }
    ),
    /forbidden/
  )
})
