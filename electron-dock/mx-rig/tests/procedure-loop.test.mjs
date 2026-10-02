import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BUILTIN_AGENTS } from '../apps/server/agent-presets.mjs'
import { RigClient } from '../packages/runtime/client.mjs'
import { MissionStore } from '../packages/runtime/store.mjs'
import { RigRuntime } from '../packages/runtime/engine.mjs'
import { ToolExecutor } from '../packages/runtime/tools.mjs'
import { BrowserTools } from '../packages/runtime/browser.mjs'
import { ProcedureBench } from '../packages/runtime/procedure-bench.mjs'

// The whole loop, on a real service and a real browser: a case, the
// procedure that implements it, a replay recorded as a run, a page that
// changes, a repair proposed by the crew (scripted here), proven by a replay
// and approved by a person, and the next replay passing again.

const ADMIN = 'procedure-loop-admin'
const page = (
  button
) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>个人设置</title></head>
<body><main><h1>个人设置</h1>
<form onsubmit="event.preventDefault();setTimeout(function(){document.getElementById('status').textContent='已保存：'+document.getElementById('nick').value},100)">
<label for="nick">昵称</label><input id="nick" value="旧昵称"><button type="submit">${button}</button>
</form><p id="status" role="status"></p></main></body></html>`

async function chromium() {
  const { chromium: engine } = await import('playwright')
  const launcher = {
    launch: (options) => engine.launch({ ...options, headless: true, channel: 'chromium' })
  }
  const probe = await launcher.launch({}).catch(() => null)
  if (!probe) return null
  await probe.close()
  return launcher
}

test('a procedure is fired, breaks, is repaired under review, and passes again', async (t) => {
  const launcher = await chromium()
  if (!launcher) return t.skip('Chromium 未安装；运行 npm run browser:install 后执行')

  const site = { button: '保存' }
  const web = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(page(site.button))
  })
  await new Promise((resolve) => web.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => web.close(resolve)))
  const origin = `http://127.0.0.1:${web.address().port}`

  const state = await mkdtemp(join(tmpdir(), 'mx-rig-procedure-loop-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const api = new RigClient({ url: server.origin, token: ADMIN })
  const call = async (method, path, body) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }

  // The catalog case this procedure implements, written in the platform.
  assert.equal(
    (
      await call('POST', '/api/v1/apps', {
        slug: 'profile',
        displayName: '个人中心',
        surfaces: ['web']
      })
    ).status,
    201
  )
  const caseCreated = await call('POST', '/api/v1/apps/profile/cases', {
    caseId: 'PRF-WEB-SET-001',
    title: '修改昵称后保存成功',
    priority: 'P1',
    steps: [{ action: '改昵称并保存', expect: '提示已保存' }]
  })
  assert.equal(caseCreated.status, 201, JSON.stringify(caseCreated.body))

  // The desktop: its own runtime and station, a scripted crew, the real service.
  const script = []
  const policy = {
    revision: 'loop',
    maxTurns: 8,
    allowedTools: ['browser_snapshot', 'browser_click', 'browser_assert', 'procedure_propose'],
    browserOrigins: [origin],
    productionHosts: [],
    browserPreauth: true
  }
  const client = {
    url: api.url,
    token: api.token,
    async request(path, body, signal) {
      if (path === '/api/rig/v1/execution-config')
        return {
          policy: structuredClone(policy),
          model: { configured: true },
          agents: BUILTIN_AGENTS
        }
      if (path === '/api/rig/v1/model/turn')
        return { message: script.shift() ?? { content: '完成' } }
      return api.request(path, body, signal)
    }
  }
  const browser = new BrowserTools(join(state, 'station'), launcher, { headless: true })
  const runtime = new RigRuntime({
    store: await new MissionStore(join(state, 'missions')).init(),
    client,
    executor: new ToolExecutor(client, browser),
    owner: 'service-admin'
  })
  t.after(() => runtime.close())
  const bench = new ProcedureBench({ client, runtime, browser, pollMs: 20 })

  const steps = [
    { do: 'open', url: '/settings' },
    { do: 'fill', target: { label: '昵称' }, value: 'Rig' },
    { do: 'click', target: { role: 'button', name: '保存' } },
    { do: 'assert', kind: 'text_visible', expected: '已保存：Rig' }
  ]
  const created = await api.request('/api/rig/v1/procedures', {
    procedure: {
      title: '修改昵称并保存',
      app: 'profile',
      caseId: 'PRF-WEB-SET-001',
      baseUrl: origin,
      steps
    }
  })
  const id = created.procedure.id
  assert.equal(created.procedure.status, 'draft')

  // Not proven yet: it cannot be activated.
  const early = await call('POST', `/api/rig/v1/procedures/${id}:status`, { status: 'active' })
  assert.equal(early.status, 409)
  assert.equal(early.body.error.code, 'procedure_unproven')

  // 试车 → recorded, and reported as a run of the app.
  const first = await bench.fire(id)
  assert.equal(first.run.verdict, 'passed')
  assert.equal(first.kernelRun.status, 'passed')
  const activated = await call('POST', `/api/rig/v1/procedures/${id}:status`, { status: 'active' })
  assert.equal(activated.status, 200)
  assert.equal(activated.body.caseUpdated, true, 'the catalog case now counts as implemented')
  const catalog = (await call('GET', '/api/v1/apps/profile/cases')).body.cases
  const entry = catalog.find((item) => item.caseId === 'PRF-WEB-SET-001')
  assert.equal(entry.automationState, 'implemented')

  // A release renames the button.
  site.button = '提交'
  const broken = await bench.fire(id)
  assert.equal(broken.run.verdict, 'failed')
  assert.equal(broken.run.failedStep, 2)
  assert.equal(broken.run.failure.code, 'target_missing')
  assert.equal(broken.kernelRun.status, 'failed')

  // 纠正措施: the crew is handed the page at step 3 and proposes a change.
  const revised = steps.map((step, index) =>
    index === 2 ? { ...step, target: { role: 'button', name: '提交' } } : step
  )
  script.push(
    {
      tool_calls: [
        { id: 'c1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }
      ]
    },
    {
      tool_calls: [
        {
          id: 'c2',
          type: 'function',
          function: {
            name: 'procedure_propose',
            arguments: JSON.stringify({
              verdict: 'case-issue',
              rationale: '保存按钮改名为「提交」，行为没有变化',
              steps: JSON.stringify(revised)
            })
          }
        }
      ]
    },
    { content: '把第 3 步的按钮名称改成了「提交」。' }
  )
  const { mission } = await bench.repair(id, broken.run.id)
  const proposal = await bench.settled(mission.id)
  assert.ok(proposal, 'the proposal was posted')
  assert.equal(proposal.validation.verdict, 'passed', 'proven by a full replay before review')
  assert.deepEqual([proposal.diff.removed, proposal.diff.added], [1, 1])
  const repaired = runtime.store.get(mission.id, 'service-admin')
  assert.equal(repaired.status, 'completed')
  assert.ok(
    repaired.messages[0].content.includes('"name": "保存"'),
    'the crew was given the procedure as written'
  )
  const snapshot = repaired.events.find((event) => event.kind === 'tool_result')
  assert.match(
    JSON.stringify(snapshot.data.result.snapshot),
    /提交/,
    'it looked at the page where the replay stopped'
  )

  // A stale revision cannot be written over; a person approves the proposal.
  const stale = await call('POST', `/api/rig/v1/procedures/${id}:revise`, {
    expectedRevision: 0 + 99,
    procedure: { ...created.procedure, steps: revised }
  })
  assert.equal(stale.status, 409)
  const approved = await call(
    'POST',
    `/api/rig/v1/procedures/${id}/proposals/${proposal.id}:decide`,
    {
      approved: true
    }
  )
  assert.equal(approved.status, 200, JSON.stringify(approved.body))
  assert.equal(approved.body.procedure.revision, 2)
  assert.equal(approved.body.procedure.status, 'active', 'the validation replay is its proof')
  assert.equal(approved.body.procedure.steps[2].target.name, '提交')
  assert.equal(approved.body.procedure.history[0].revision, 1)

  const again = await bench.fire(id)
  assert.equal(again.run.verdict, 'passed')
  assert.equal(again.run.revision, 2)

  // A regression pass over every active procedure.
  const pass = await bench.fireAll()
  assert.deepEqual([pass.passed, pass.total], [1, 1])
  assert.ok(pass.results[0].kernelRunId)

  // Every replay is a run of the app, measured only against its own case.
  const runs = (await call('GET', '/api/v1/runs')).body.runs.filter(
    (run) => run.trigger === 'rig-procedure'
  )
  assert.deepEqual(runs.map((run) => run.status).sort(), ['failed', 'passed', 'passed', 'passed'])
  const cases = (await call('GET', `/api/v1/runs/${again.kernelRun.id}/cases`)).body.cases
  assert.deepEqual(
    cases.map((item) => [item.caseId, item.status]),
    [['PRF-WEB-SET-001', 'passed']]
  )

  // 钩子: the next release renames the button again. A regression pass hands
  // the failure to the repair crew by itself; the proposal waits for review.
  const hook = await call('POST', '/api/rig/v1/hooks', {
    version: 0,
    rules: [{ name: '规程失败自动修正', event: 'procedure.failed', maxPerHour: 3 }]
  })
  assert.equal(hook.status, 200, JSON.stringify(hook.body))
  site.button = '确定'
  const third = steps.map((step, index) =>
    index === 2 ? { ...step, target: { role: 'button', name: '确定' } } : step
  )
  script.push(
    {
      tool_calls: [
        { id: 'd1', type: 'function', function: { name: 'browser_snapshot', arguments: '{}' } }
      ]
    },
    {
      tool_calls: [
        {
          id: 'd2',
          type: 'function',
          function: {
            name: 'procedure_propose',
            arguments: JSON.stringify({
              verdict: 'case-issue',
              rationale: '按钮又改名为「确定」',
              steps: JSON.stringify(third)
            })
          }
        }
      ]
    },
    { content: '第 3 步改为「确定」。' }
  )
  const nightly = await bench.fireAll({ repairTimeoutMs: 60_000 })
  assert.deepEqual([nightly.passed, nightly.total], [0, 1])
  assert.equal(nightly.repairs.length, 1)
  assert.equal(nightly.repairs[0].status, 'done', JSON.stringify(nightly.repairs[0]))
  assert.equal(nightly.repairs[0].validation, 'passed')
  const logged = (await call('GET', '/api/rig/v1/hooks')).body.fires
  assert.equal(logged[0].kind, 'repair')
  assert.equal(logged[0].proposalId, nightly.repairs[0].proposalId)
  const waiting = (await call('GET', `/api/rig/v1/procedures/${id}`)).body.procedure
  assert.equal(waiting.revision, 2, 'nothing changes without a person')
  assert.equal(
    waiting.proposals.find((entry) => entry.status === 'pending').id,
    nightly.repairs[0].proposalId
  )
})

test('proposals must be proven; drafts become catalog cases one by one', async (t) => {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-procedure-rules-'))
  const server = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => server.close())
  const call = async (method, path, body, token = ADMIN) => {
    const response = await fetch(server.origin + path, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const steps = [
    { do: 'open', url: 'https://t.example/a' },
    { do: 'click', target: { role: 'button', name: '保存' } }
  ]
  const { procedure } = (
    await call('POST', '/api/rig/v1/procedures', { procedure: { title: 'x', steps } })
  ).body
  const bad = await call('POST', '/api/rig/v1/procedures', {
    procedure: { title: 'x', steps: [{ do: 'click', target: { role: 'button', name: 'a' } }] }
  })
  assert.equal(bad.status, 400)
  assert.match(bad.body.error.message, /第一步必须是 open/)

  const failedReplay = {
    revision: 1,
    verdict: 'failed',
    failedStep: 1,
    failure: { index: 1, code: 'target_missing', message: '找不到' },
    steps: [],
    startedAt: '2026-09-29T00:00:00.000Z',
    finishedAt: '2026-09-29T00:00:01.000Z',
    durationMs: 1
  }
  const unproven = await call('POST', `/api/rig/v1/procedures/${procedure.id}/proposals`, {
    proposal: {
      baseRevision: 1,
      verdict: 'case-issue',
      rationale: '改名',
      steps: [steps[0], { do: 'click', target: { role: 'button', name: '提交' } }],
      validation: failedReplay
    }
  })
  assert.equal(unproven.status, 201)
  const refused = await call(
    'POST',
    `/api/rig/v1/procedures/${procedure.id}/proposals/${unproven.body.proposal.id}:decide`,
    { approved: true }
  )
  assert.equal(refused.status, 409)
  assert.equal(refused.body.error.code, 'proposal_unproven')
  const rejected = await call(
    'POST',
    `/api/rig/v1/procedures/${procedure.id}/proposals/${unproven.body.proposal.id}:decide`,
    { approved: false }
  )
  assert.equal(rejected.body.procedure.proposals[0].status, 'rejected')

  // A viewer reads procedures but cannot write them.
  await call('POST', '/api/v1/members', {
    account: 'viewer1',
    role: 'viewer',
    password: 'viewer-password-1'
  })
  const viewer = (
    await (
      await fetch(server.origin + '/api/rig/v1/native-login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account: 'viewer1', password: 'viewer-password-1' })
      })
    ).json()
  ).token
  assert.equal((await call('GET', '/api/rig/v1/procedures', undefined, viewer)).status, 200)
  assert.equal(
    (await call('POST', '/api/rig/v1/procedures', { procedure: { title: 'x', steps } }, viewer))
      .status,
    403
  )

  // Case drafts: each imported on its own; a taken id does not stop the rest.
  await call('POST', '/api/v1/apps', { slug: 'shop', displayName: '商城', surfaces: ['web'] })
  const draft = (caseId, title) => ({
    app: 'shop',
    caseId,
    title,
    priority: 'P1',
    steps: [{ action: '提交订单', expect: '看到订单号' }],
    tags: ['checkout']
  })
  const imported = await call('POST', '/api/rig/v1/cases:import', {
    cases: [
      draft('SHP-WEB-ORD-001', '下单成功'),
      draft('SHP-WEB-ORD-001', '重复编号'),
      draft('SHP-WEB-ORD-002', '库存不足')
    ]
  })
  assert.deepEqual(
    imported.body.results.map((entry) => entry.ok),
    [true, false, true]
  )
  const listed = (await call('GET', '/api/v1/apps/shop/cases')).body.cases
  assert.deepEqual(listed.map((item) => [item.caseId, item.automationState]).sort(), [
    ['SHP-WEB-ORD-001', 'planned'],
    ['SHP-WEB-ORD-002', 'planned']
  ])
})
