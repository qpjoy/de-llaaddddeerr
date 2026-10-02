import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { matches } from '../apps/server/hooks.mjs'
import { composeDebrief } from '../packages/test-platform/server/notify/events.mjs'

const ADMIN = 'hooks-admin-token'

/**
 * A model that triages like a competent crew would: read the run named in the
 * goal, then file a conclusion citing it. Served through the real gateway.
 */
function triageModel() {
  const requests = []
  return {
    requests,
    options: {
      environment: { MX_RIG_MODEL_API_KEY: 'k' },
      fetchImpl: async (_url, init) => {
        const body = JSON.parse(init.body)
        requests.push(body)
        const runId = /trun_[a-z0-9]+/.exec(
          body.messages.find((m) => m.role === 'user').content
        )?.[0]
        const tools = body.messages.filter((m) => m.role === 'tool').length
        const call = (name, args) => ({
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: `c${tools}`,
              type: 'function',
              function: { name, arguments: JSON.stringify(args) }
            }
          ]
        })
        const message =
          tools === 0
            ? call('tests_result', { runId })
            : tools === 1
              ? call('finding_submit', {
                  verdict: 'product-defect',
                  confidence: 'high',
                  summary: '下单接口返回 500',
                  evidence: `${runId} 的用例 SHP-WEB-ORD-001 失败`
                })
              : { role: 'assistant', content: `${runId} 是产品缺陷。` }
        return Response.json({ choices: [{ index: 0, message, finish_reason: 'stop' }] })
      }
    }
  }
}

async function service(t, modelOptions) {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-hooks-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false, modelOptions }
  )
  t.after(() => server.close())
  await server.settings.update({
    ...server.settings.value,
    providers: [
      {
        id: 'primary',
        displayName: '主模型',
        baseUrl: 'https://models.example/v1',
        model: 'triage',
        apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
        timeoutMs: 60_000,
        enabled: true,
        stream: false
      }
    ],
    sequence: ['primary']
  })
  const api = async (path, body, token = ADMIN) => {
    const response = await fetch(server.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  return { server, api }
}

const record = (api, status) =>
  api('/api/v1/apps/shop/results:record', {
    summary: {
      schemaVersion: 2,
      status,
      totals: {
        tests: 1,
        passed: status === 'passed' ? 1 : 0,
        failed: status === 'failed' ? 1 : 0
      },
      cases: [
        {
          caseId: 'SHP-WEB-ORD-001',
          title: '下单',
          status,
          ...(status === 'failed' ? { error: '500' } : {})
        }
      ]
    }
  }).then((response) => response.body.run)

test('a failed run is triaged once, by a read-only crew, and the conclusion is kept', async (t) => {
  const model = triageModel()
  const { server, api } = await service(t, model.options)
  await api('/api/v1/apps', { slug: 'shop', displayName: '商城', surfaces: ['web'] })
  const history = await record(api, 'failed')

  // Only read-only crews may be hooked; only admins may hook them.
  const writer = await api('/api/rig/v1/hooks', {
    version: 0,
    rules: [{ name: '派发', event: 'run.finished', agentKey: 'smoke-pilot' }]
  })
  assert.equal(writer.status, 400)
  assert.match(writer.body.error.message, /只能用只读的 Agent/)
  await api('/api/v1/members', { account: 'op1', role: 'operator', password: 'op-password-1' })
  const op = (
    await (
      await fetch(server.origin + '/api/rig/v1/native-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'op1', password: 'op-password-1' })
      })
    ).json()
  ).token
  assert.equal((await api('/api/rig/v1/hooks', { version: 0, rules: [] }, op)).status, 403)
  assert.equal((await api('/api/rig/v1/hooks', undefined, op)).status, 200, 'members can read')

  await api('/api/v1/notification-channels', {
    kind: 'webhook',
    name: '值班群',
    config: { url: 'https://hooks.example/notify' },
    events: ['debrief']
  })
  // Give the rule a creation time strictly after the earlier failure.
  await new Promise((resolve) => setTimeout(resolve, 5))
  const saved = await api('/api/rig/v1/hooks', {
    version: 0,
    rules: [
      {
        name: '失败自动定级',
        event: 'run.finished',
        statuses: ['failed'],
        includeProcedureRuns: true,
        maxPerHour: 1,
        notify: true
      }
    ]
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  const stale = await api('/api/rig/v1/hooks', { version: 0, rules: [] })
  assert.equal(stale.status, 409, 'saves are against a version')

  const first = await record(api, 'failed')
  const second = await record(api, 'failed')
  await record(api, 'passed')

  const tick = await server.hooks.tick()
  assert.deepEqual([tick.claimed, tick.skipped], [1, 1], 'the hourly cap holds')
  assert.ok(tick.started, 'a triage mission started')
  // Started means launched; its first model call follows on its own time.
  for (let waited = 0; waited < 15_000 && !model.requests.length; waited += 20)
    await new Promise((resolve) => setTimeout(resolve, 20))
  const goal = model.requests[0].messages.find((m) => m.role === 'user').content
  assert.match(goal, /只读取，不派发、不取消/)
  const offered = model.requests[0].tools.map((tool) => tool.function.name)
  assert.ok(!offered.includes('tests_run') && !offered.includes('tests_cancel'))

  // Bounded by time, not by a count of short sleeps: under a loaded test run
  // two seconds was not always enough for the mission to finish.
  const deadline = Date.now() + 15_000
  while (
    Date.now() < deadline &&
    server.missions.get(tick.started.id, 'rig-hooks').status !== 'completed'
  )
    await new Promise((resolve) => setTimeout(resolve, 20))
  const settled = await server.hooks.tick()
  assert.equal(settled.settled, 1)
  assert.equal(settled.claimed, 0, 'the same run is never claimed twice')

  const { fires } = (await api('/api/rig/v1/hooks')).body
  const done = fires.find((fire) => fire.status === 'done')
  const skipped = fires.find((fire) => fire.status === 'skipped')
  assert.ok([first.id, second.id].includes(done.run.id))
  assert.equal(done.finding.verdict, 'product-defect')
  assert.equal(done.finding.unverified, 0, 'it cited the run it read')
  assert.match(skipped.reason, /上限/)
  assert.ok(!fires.some((fire) => fire.run?.id === history.id), 'history is not re-triaged')
  assert.equal(fires.length, 2)

  // The conclusion reaches the report and the channel, labelled as a judgement.
  const insights = (await api('/api/rig/v1/insights?window=7')).body.insights
  assert.equal(insights.missions.findings.byVerdict['product-defect'], 1)
  const queued = await server.kernel.store.listNotifications({ runId: done.run.id })
  assert.equal(queued.length, 1)
  assert.match(queued[0].payload.note, /Agent 判断（不是测试结论）：产品缺陷/)
})

test('matching is narrow, and the note reads as text on every channel', () => {
  const rule = {
    enabled: true,
    event: 'run.finished',
    statuses: ['failed'],
    apps: ['shop'],
    includeProcedureRuns: false
  }
  assert.equal(matches(rule, { status: 'failed', trigger: 'schedule' }, 'shop'), true)
  assert.equal(matches(rule, { status: 'blocked', trigger: 'schedule' }, 'shop'), false)
  assert.equal(matches(rule, { status: 'failed', trigger: 'schedule' }, 'crm'), false)
  assert.equal(matches(rule, { status: 'failed', trigger: 'rig-procedure' }, 'shop'), false)
  assert.equal(matches({ ...rule, enabled: false }, { status: 'failed' }, 'shop'), false)
  const message = composeDebrief({ title: 't', note: '判断：产品缺陷' })
  assert.equal(message.note, '判断：产品缺陷')
})
