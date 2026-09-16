import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { start } from '../apps/server/index.mjs'
import { BUILTIN_AGENTS } from '../apps/server/agent-presets.mjs'

async function fixture(t, env = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-agent-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts'),
      ...env
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (
    path,
    body,
    headers = { authorization: 'Bearer test-only-rig-secret' },
    method
  ) => {
    const response = await fetch(runtime.origin + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  return { runtime, api }
}

test('the tool catalogue reports effect, surface and whether Internal allows it', async (t) => {
  const { api } = await fixture(t)
  const { status, body } = await api('/api/rig/v1/tools')
  assert.equal(status, 200)
  assert.equal(body.tools.length, 14)
  const run = body.tools.find((tool) => tool.name === 'tests_run')
  assert.equal(run.effect, 'write')
  assert.equal(run.surface, 'internal')
  assert.equal(run.allowed, true)
  const click = body.tools.find((tool) => tool.name === 'browser_click')
  assert.equal(click.surface, 'desktop')
  // Browser tools ship switched off; an allow-list that starts open is not one.
  assert.equal(click.allowed, false)
  assert.ok(body.groups.test && body.groups.browser)
})

test('the orchestration view is served the compiled mission graph', async (t) => {
  const { api } = await fixture(t)
  const { body } = await api('/api/rig/v1/graph')
  const names = body.graph.nodes.map((node) => node.name)
  assert.ok(names.includes('approve'))
  assert.ok(names.includes('plan'))
  assert.equal(body.graph.nodes.find((node) => node.name === 'approve').interrupts, true)
  assert.ok(body.graph.edges.length >= names.length)
})

test('egress is observed, credential-free, and closed to viewers', async (t) => {
  const { api, runtime } = await fixture(t, {
    HTTP_PROXY: 'http://tunnel:s3cr3t@127.0.0.1:7788',
    NO_PROXY: 'localhost,.mxinfo-inc.cn'
  })
  const { status, body } = await api('/api/rig/v1/egress')
  assert.equal(status, 200)
  assert.equal(body.egress.configured, true)
  assert.equal(body.egress.sourceKind, 'process-env')
  assert.ok(!JSON.stringify(body).includes('s3cr3t'))
  assert.equal(body.egress.variables.find((entry) => entry.name === 'HTTP_PROXY').credentials, true)
  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'viewer-token' ? { id: 'viewer', role: 'viewer' } : original(token, source)
  assert.equal(
    (await api('/api/rig/v1/egress', undefined, { authorization: 'Bearer viewer-token' })).status,
    403
  )
})

test('built-in Agents are published and a mission can pick one', async (t) => {
  const { api } = await fixture(t)
  const config = await api('/api/rig/v1/config')
  assert.equal(config.body.agents.length, BUILTIN_AGENTS.length)
  const analyst = config.body.agents.find((agent) => agent.key === 'result-analyst')
  assert.ok(analyst.persona.length > 0)
  assert.ok(analyst.effectiveTools.every((name) => analyst.tools.includes(name)))
  // page-inspector wants browser tools, which Internal has not allowed yet.
  const inspector = config.body.agents.find((agent) => agent.key === 'page-inspector')
  assert.deepEqual(inspector.effectiveTools, [])
  const created = await api('/api/rig/v1/missions', {
    mode: 'agent',
    goal: '分析最近一次执行',
    agentKey: 'result-analyst'
  })
  assert.equal(created.status, 201)
  assert.equal(created.body.mission.agentKey, 'result-analyst')
  // No model is configured, so the mission must stop rather than invent a reply.
  const unknown = await api('/api/rig/v1/missions', {
    mode: 'agent',
    goal: 'x',
    agentKey: 'nope'
  })
  assert.equal(unknown.status, 409)
})

test('admin config is strict about unknown fields and keeps built-in Agents', async (t) => {
  const { api } = await fixture(t)
  const current = (await api('/api/rig/v1/admin/config')).body
  const rejected = await api('/api/rig/v1/admin/config', { ...current, surprise: true })
  assert.equal(rejected.status, 400)
  assert.match(rejected.body.error.message, /请求参数无效/)
  const saved = await api('/api/rig/v1/admin/config', {
    ...current,
    maxTurns: 6,
    allowedTools: ['tests_runs', 'tests_result'],
    browserOrigins: ['https://test.example']
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(saved.body.policy.maxTurns, 6)
  assert.equal(saved.body.agents.length, BUILTIN_AGENTS.length)
  const analyst = saved.body.agents.find((agent) => agent.key === 'result-analyst')
  assert.deepEqual(analyst.effectiveTools, ['tests_runs', 'tests_result'])
})

test('probing a provider needs admin and never leaks the endpoint error text', async (t) => {
  const { api, runtime } = await fixture(t)
  const unconfigured = await api('/api/rig/v1/admin/providers:probe', { providerId: 'primary' })
  assert.equal(unconfigured.status, 409)
  assert.equal(unconfigured.body.error.code, 'model_unconfigured')
  const missing = await api('/api/rig/v1/admin/providers:probe', { providerId: 'ghost' })
  assert.equal(missing.status, 404)
  const original = runtime.kernel.identity.resolve
  runtime.kernel.identity.resolve = async (token, source) =>
    token === 'operator-token' ? { id: 'op', role: 'operator' } : original(token, source)
  assert.equal(
    (
      await api(
        '/api/rig/v1/admin/providers:probe',
        { providerId: 'primary' },
        { authorization: 'Bearer operator-token' }
      )
    ).status,
    403
  )
})

test('the workbench is served with its own design system copy under a strict CSP', async (t) => {
  const { runtime } = await fixture(t)
  const page = await fetch(runtime.origin + '/rig/')
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-security-policy'), /script-src 'self'/)
  const html = await page.text()
  assert.match(html, /vendor\/styles\.css/)
  for (const asset of ['/rig/vendor/styles.css', '/rig/vendor/tokens.css', '/rig/app.js']) {
    const response = await fetch(runtime.origin + asset)
    assert.equal(response.status, 200, asset)
    await response.body.cancel()
  }
  const vendored = await (await fetch(runtime.origin + '/rig/vendor/tokens.css')).text()
  assert.match(vendored, /--qp-primary/)
})

test('an orchestration draft is compiled for preview without being stored', async (t) => {
  const { api } = await fixture(t)
  const before = (await api('/api/rig/v1/admin/config')).body.orchestrations.length
  const draft = {
    key: 'draft-only',
    displayName: '草稿',
    summary: '只预览，不保存',
    inputs: [{ name: 'runId', label: 'Run', kind: 'run', required: true }],
    entry: 'read',
    nodes: [
      {
        id: 'read',
        title: '读取',
        type: 'tool',
        tool: 'tests_result',
        args: { runId: '{{runId}}' },
        capture: {},
        next: null
      }
    ]
  }
  const ok = await api('/api/rig/v1/admin/orchestrations:preview', { orchestration: draft })
  assert.equal(ok.status, 200, JSON.stringify(ok.body))
  assert.ok(ok.body.graph.nodes.some((node) => node.name === 'n_read'))
  assert.deepEqual(ok.body.warnings, [])
  // Previewing must not create anything.
  assert.equal((await api('/api/rig/v1/admin/config')).body.orchestrations.length, before)

  const broken = await api('/api/rig/v1/admin/orchestrations:preview', {
    orchestration: { ...draft, nodes: [{ ...draft.nodes[0], next: 'ghost' }] }
  })
  assert.equal(broken.status, 400)
  assert.equal(broken.body.error.code, 'invalid_orchestration')
  assert.match(broken.body.error.message, /ghost/)
})

test('a stored orchestration must compile, and built-ins cannot be deleted', async (t) => {
  const { api } = await fixture(t)
  const current = (await api('/api/rig/v1/admin/config')).body
  assert.ok(current.orchestrations.length >= 2)

  const dropped = await api('/api/rig/v1/admin/config', { ...current, orchestrations: [] })
  assert.equal(dropped.status, 400)
  assert.match(dropped.body.error.message, /不能删除/)

  const broken = current.orchestrations.map((entry) =>
    entry.key === 'guarded-dispatch'
      ? { ...entry, nodes: entry.nodes.map((node) => ({ ...node, next: 'ghost' })) }
      : entry
  )
  const refused = await api('/api/rig/v1/admin/config', { ...current, orchestrations: broken })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'invalid_orchestration')

  // Disabling is the supported way to retire a built-in.
  const disabled = current.orchestrations.map((entry) =>
    entry.key === 'guarded-dispatch' ? { ...entry, enabled: false } : entry
  )
  const saved = await api('/api/rig/v1/admin/config', { ...current, orchestrations: disabled })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.equal(
    saved.body.orchestrations.some((entry) => entry.key === 'guarded-dispatch'),
    false
  )
  const graph = await api('/api/rig/v1/graph?orchestration=guarded-dispatch')
  assert.equal(graph.status, 404)
})

test('an orchestration reports the tools Internal has not allowed', async (t) => {
  const { api } = await fixture(t)
  const current = (await api('/api/rig/v1/admin/config')).body
  await api('/api/rig/v1/admin/config', { ...current, allowedTools: ['tests_result'] })
  const config = await api('/api/rig/v1/config')
  const guarded = config.body.orchestrations.find((entry) => entry.key === 'guarded-dispatch')
  assert.deepEqual(guarded.missingTools.sort(), ['tests_run', 'tests_runners'])
  const triage = config.body.orchestrations.find((entry) => entry.key === 'failure-triage')
  assert.ok(triage.missingTools.includes('tests_artifacts'))
})

test('insights are computed from real runs and refuse to flatter an empty platform', async (t) => {
  const { api, runtime } = await fixture(t)
  const empty = await api('/api/rig/v1/insights')
  assert.equal(empty.status, 200)
  assert.equal(empty.body.insights.verdicts.passRate, null)
  assert.equal(empty.body.insights.coverage.automationRate, null)
  assert.ok(empty.body.insights.risks.some((risk) => risk.kind === 'fleet'))

  await api('/api/v1/apps', { slug: 'luopan', displayName: 'Compass', surfaces: ['web'] })
  await api('/api/v1/apps/luopan/suites', {
    slug: 'smoke',
    displayName: 'Smoke',
    engine: 'playwright',
    surface: 'web',
    runnerKind: 'local',
    targetMode: 'self',
    command: ['node', 't.mjs']
  })
  const madeCase = await api('/api/v1/apps/luopan/cases', {
    // The platform's own id convention: <应用>-<端>-<业务域>-<三位序号>.
    caseId: 'CPS-EL-AUTH-001',
    title: '登录',
    priority: 'P0',
    automationState: 'planned'
  })
  assert.equal(madeCase.status, 201, JSON.stringify(madeCase.body))
  const app = (await api('/api/v1/apps')).body.apps[0]
  const now = new Date()
  // Three decided runs: one pass, one failure, one blocked.
  for (const [status, offsetDays] of [
    ['passed', 0],
    ['failed', 1],
    ['blocked', 2]
  ]) {
    const at = new Date(now.getTime() - offsetDays * 86_400_000).toISOString()
    const created = await runtime.kernel.store.createRun({
      appId: app.id,
      profile: 'mock',
      track: 'functional'
    })
    await runtime.kernel.store.updateRun(created.id, {
      status,
      finishedAt: at,
      queuedAt: at,
      durationMs: 30_000
    })
  }
  const { body } = await api('/api/rig/v1/insights?window=7&timezone=UTC')
  const insights = body.insights
  assert.equal(insights.verdicts.decided, 3)
  // blocked is neither a pass nor a failure, so the denominator is 2.
  assert.equal(insights.verdicts.judged, 2)
  assert.equal(insights.verdicts.passRate, 0.5)
  assert.equal(insights.verdicts.blocked, 1)
  assert.equal(insights.trend.length, 8)
  assert.equal(insights.coverage.p0.total, 1)
  assert.equal(insights.coverage.automationRate, 0)
  assert.deepEqual(
    insights.coverage.p0Gap.map((entry) => entry.caseId),
    ['CPS-EL-AUTH-001']
  )
  assert.ok(insights.risks.some((risk) => risk.kind === 'coverage'))
  assert.ok(insights.risks.some((risk) => risk.kind === 'environment'))
  assert.equal(insights.window.days, 7)
})
