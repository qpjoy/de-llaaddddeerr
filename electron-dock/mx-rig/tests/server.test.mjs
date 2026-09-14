import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start, configuration } from '../apps/server/index.mjs'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-api-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, headers = { authorization: 'Bearer test-only-rig-secret' }) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, headers: response.headers, body: await response.json() }
  }
  return { runtime, api }
}
test('Rig config ignores legacy environment and requires own admin credential', () => {
  assert.throws(() => configuration({ MXT_ADMIN_TOKEN: 'legacy' }), { code: 'admin_required' })
  const config = configuration({
    MX_RIG_ADMIN_TOKEN: 'new',
    MXT_NAMESPACE: 'mx-internal-shadow',
    MX_AUTO_DATABASE_URL: 'postgres://legacy'
  })
  assert.equal(config.namespace, 'mx-rig')
  assert.equal(config.databaseUrl, null)
  assert.equal(config.port, 8791)
})
test('login keeps credential out of browser JSON; config and model require authorization', async (t) => {
  const { api } = await fixture(t)
  assert.equal((await api('/api/rig/v1/config', undefined, {})).status, 401)
  const login = await api(
    '/api/rig/v1/login',
    { account: 'admin', password: 'test-only-rig-secret' },
    {}
  )
  assert.equal(login.status, 200)
  assert.equal(login.body.token, undefined)
  assert.match(login.headers.get('set-cookie'), /mx_rig_session=/)
  assert.match(login.headers.get('set-cookie'), /HttpOnly/)
  const config = await api('/api/rig/v1/config')
  assert.equal(config.status, 200)
  assert.equal(config.body.model.configured, false)
  const model = await api('/api/rig/v1/model/turn', {
    messages: [{ role: 'user', content: 'hello' }],
    tools: []
  })
  assert.equal(model.status, 409)
  assert.equal(model.body.error.code, 'model_unconfigured')
  const foreign = await api(
    '/api/rig/v1/login',
    { account: 'admin', password: 'test-only-rig-secret' },
    { origin: 'https://evil.example' }
  )
  assert.equal(foreign.status, 403)
})
test('real HTTP workflow integrates inherited task API without fake test success', async (t) => {
  const { api, runtime } = await fixture(t)
  assert.equal(
    (
      await api('/api/v1/apps', {
        slug: 'rig-smoke',
        displayName: 'Rig acceptance',
        surfaces: ['web']
      })
    ).status,
    201
  )
  assert.equal(
    (
      await api('/api/v1/apps/rig-smoke/suites', {
        slug: 'smoke',
        displayName: 'Smoke',
        engine: 'playwright',
        surface: 'web',
        runnerKind: 'local',
        command: ['node', 'test.mjs'],
        targetMode: 'self'
      })
    ).status,
    201
  )
  const task = await api('/api/v1/tasks', {
    app: 'rig-smoke',
    suite: 'smoke',
    name: 'Regression',
    profile: 'mock',
    track: 'functional'
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  const created = await api('/api/rig/v1/missions', {
    mode: 'workflow',
    goal: 'Run regression',
    taskId: task.body.task.id
  })
  assert.equal(created.status, 201)
  const id = created.body.mission.id
  async function until(status) {
    for (let i = 0; i < 100; i++) {
      const row = runtime.missions.get(id, 'service-admin')
      if (row.status === status) return row
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error(`Expected ${status}`)
  }
  const waiting = await until('awaiting_approval')
  assert.equal((await api('/api/v1/runs')).body.runs.length, 0)
  const approval = await api(`/api/rig/v1/missions/${id}/approve`, {
    approvalId: waiting.pending.approvalId,
    approved: true
  })
  assert.equal(approval.status, 200, JSON.stringify(approval.body))
  const done = await until('completed')
  assert.ok(done.testRunId)
  const run = await api(`/api/v1/runs/${done.testRunId}`)
  assert.equal(run.body.run.status, 'pending-runner')
  assert.match(done.result, /不代表测试通过/)
})
test('viewer cannot edit policies, call model or authorize local execution', async (t) => {
  const { api, runtime } = await fixture(t)
  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'viewer-token' ? { id: 'viewer', role: 'viewer' } : original(token, source)
  const headers = { authorization: 'Bearer viewer-token' }
  assert.equal((await api('/api/rig/v1/config', undefined, headers)).status, 200)
  for (const path of ['/api/rig/v1/execution-config', '/api/rig/v1/admin/config'])
    assert.equal((await api(path, undefined, headers)).status, 403)
  assert.equal(
    (await api('/api/rig/v1/missions', { mode: 'agent', goal: 'test' }, headers)).status,
    403
  )
})
