import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { start } from '../apps/server/index.mjs'
import { dispatchQueued } from '../packages/test-platform/server/runner/dispatcher.mjs'

const CASES = ['user.login_1', 'LOGOUT-002'].map((caseId) => ({
  caseId,
  title: caseId,
  steps: '操作页面',
  expected: '预期状态',
  platforms: ['web', 'electron'],
  specPath: 'tests/auth.spec.ts'
}))

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'rig-execution-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'execution-admin',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: dir,
      MX_RIG_ARTIFACTS_DIR: join(dir, 'artifacts')
    },
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body, token = 'execution-admin') => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: response.status === 204 ? null : await response.json() }
  }
  const app = (
    await api('/api/v1/apps', {
      slug: 'fixture',
      displayName: 'Fixture',
      surfaces: ['web', 'electron']
    })
  ).body.app
  const suite = (
    await api('/api/v1/apps/fixture/suites', {
      slug: 'web',
      displayName: 'Web suite',
      engine: 'playwright',
      surface: 'web',
      runnerKind: 'local',
      targetMode: 'self',
      command: ['node', 'run-tests.mjs']
    })
  ).body.suite
  assert.ok(suite)
  const task = (
    await api('/api/v1/tasks', { app: 'fixture', suite: 'web', name: 'Web mock', profile: 'mock' })
  ).body.task
  assert.ok(task)
  const mission = (await api('/api/rig/v1/test-tasks', { app: 'fixture', goal: '双端验收' })).body
    .mission
  const base = `/api/rig/v1/missions/${mission.id}`
  await api(base + '/cases', { expectedRevision: 0, cases: CASES })
  await api(base + '/cases:confirm', { expectedRevision: 1 })
  const selection = { taskId: task.id, expectedRevision: 1 }
  const dispatch = async () => {
    const plan = await api(base + '/executions:plan', selection)
    assert.equal(plan.status, 200, JSON.stringify(plan.body))
    const input = { ...selection, planHash: plan.body.planHash, requestId: randomUUID() }
    const result = await api(base + '/executions:dispatch', input)
    assert.equal(result.status, 202, JSON.stringify(result.body))
    return { run: result.body.run, input, plan: plan.body }
  }
  const runner = (
    await api('/runner/v1/runners:register', {
      name: 'fixture-runner',
      kind: 'local',
      os: 'macos',
      engines: ['playwright'],
      surfaces: ['web']
    })
  ).body
  const claim = () => api('/runner/v1/runs:claim', {}, runner.token)
  const complete = (run, cases) =>
    api(
      `/runner/v1/runs/${run.id}:complete`,
      {
        exitCode: 0,
        summary: {
          schemaVersion: 2,
          status: 'passed',
          totals: { tests: cases.length, passed: cases.length },
          cases
        }
      },
      runner.token
    )
  return {
    api,
    runtime,
    store: runtime.kernel.store,
    app,
    suite,
    task,
    mission,
    base,
    selection,
    dispatch,
    claim,
    complete
  }
}

test('reviewed execution is idempotent, immutable and associated with the owner task', async (t) => {
  const f = await fixture(t)
  const plan = (await f.api(f.base + '/executions:plan', f.selection)).body
  const input = { ...f.selection, planHash: plan.planHash, requestId: randomUUID() }
  const first = await Promise.all([
    f.api(f.base + '/executions:dispatch', input),
    f.api(f.base + '/executions:dispatch', input)
  ])
  assert.ok(
    first.every((r) => r.status === 202),
    JSON.stringify(first)
  )
  const run = first[0].body.run
  assert.equal(first[1].body.run.id, run.id)
  const retries = await Promise.all(
    Array.from({ length: 4 }, () => f.api(f.base + '/executions:dispatch', input))
  )
  assert.ok(retries.every((response) => response.body.run.id === run.id))
  assert.equal((await f.store.listRuns()).length, 1)
  assert.equal(
    (await f.api(f.base + '/executions:dispatch', { ...input, planHash: '0'.repeat(64) })).status,
    409
  )
  await f.api(f.base + '/cases', {
    expectedRevision: 1,
    cases: [{ ...CASES[0], expected: '新的预期' }]
  })
  assert.equal(
    (await f.api(f.base + '/executions:dispatch', input)).body.run.id,
    run.id,
    'uncertain-response retry survives later case edits'
  )
  assert.equal(
    (await f.api(f.base + '/executions:dispatch', { ...input, requestId: randomUUID() })).status,
    409
  )
  const list = await f.api(f.base + '/executions')
  assert.equal(list.body.runs[0].revision, 1)
  assert.equal(list.body.runs[0].coverage.length, 2)
  assert.equal(list.body.runs[0].runTokenSha256, undefined)
  assert.equal((await f.api(`/api/v1/runs/${run.id}`)).body.run.workbench.cases, undefined)
  assert.equal((await f.api('/api/v1/runs')).body.runs[0].workbench.cases, undefined)
  assert.equal((await f.store.getRun(run.id)).workbench.cases[0].expected, '预期状态')
})

test('dispatch rejects changed settings and claim uses the accepted suite after further edits', async (t) => {
  const f = await fixture(t)
  const plan = (await f.api(f.base + '/executions:plan', f.selection)).body
  await f.store.updateSuite(f.suite.id, { command: ['node', 'new-tests.mjs'] })
  const stale = await f.api(f.base + '/executions:dispatch', {
    ...f.selection,
    planHash: plan.planHash,
    requestId: randomUUID()
  })
  assert.equal(stale.status, 409)
  assert.equal((await f.store.listRuns()).length, 0)
  const { run } = await f.dispatch()
  await f.store.updateSuite(f.suite.id, {
    command: ['node', 'different.mjs'],
    engine: 'cypress',
    surface: 'electron',
    requirements: { os: ['windows'] }
  })
  const claimed = await f.claim()
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body))
  assert.equal(claimed.body.runId, run.id)
  assert.deepEqual(claimed.body.command, ['node', 'new-tests.mjs'])
  assert.equal(claimed.body.suite.surface, 'web')
  assert.equal(
    claimed.body.env.E2E_SPEC,
    undefined,
    'whole suite is explicit, no imaginary per-case filter'
  )
})

test('missing, skipped and wrong-script evidence cannot satisfy the reviewed cases', async (t) => {
  const f = await fixture(t)
  for (const variant of ['missing', 'skipped', 'wrong', 'empty']) {
    const { run } = await f.dispatch()
    await f.claim()
    const cases = [{ caseId: CASES[0].caseId, status: 'passed', spec: CASES[0].specPath }]
    if (variant === 'skipped')
      cases.push({ caseId: CASES[1].caseId, status: 'skipped', spec: CASES[1].specPath })
    if (variant === 'wrong')
      cases.push({ caseId: CASES[1].caseId, status: 'passed', spec: 'other.spec.ts' })
    if (variant === 'empty') cases.length = 0
    const result = await f.complete(run, cases)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    assert.equal(result.body.run.status, 'blocked', variant)
    const rows = (await f.api(`/api/v1/runs/${run.id}/cases`)).body.cases
    assert.equal(rows.length, 2)
    assert.equal(
      rows.find((c) => c.caseId === CASES[1].caseId).status,
      variant === 'skipped' ? 'skipped' : 'notRun'
    )
  }
})

test('passing evidence retains extra suite results without claiming desktop or newer-version coverage', async (t) => {
  const f = await fixture(t)
  const { run } = await f.dispatch()
  await f.claim()
  const result = await f.complete(run, [
    ...CASES.map((entry) => ({ caseId: entry.caseId, spec: entry.specPath, status: 'passed' })),
    { caseId: 'EXTRA-001', status: 'passed', spec: 'extra.spec.ts' }
  ])
  assert.equal(result.body.run.status, 'passed')
  assert.equal(result.body.run.catalog.catalogTotal, 2)
  const list = (await f.api(f.base + '/executions')).body
  assert.equal(list.runs.length, 1)
  assert.equal(list.runs[0].platform, 'web')
  assert.equal(list.runs[0].profile, 'mock')
  assert.equal(list.runs[0].extraCases, 1)
  assert.ok(list.runs[0].coverage.every((entry) => entry.result.status === 'passed'))
})

test('bindings must cover this platform and cannot widen into globs or foreign cases', async (t) => {
  const f = await fixture(t)
  for (const bindings of [
    [{ caseId: CASES[0].caseId, specPath: '../escape.ts' }],
    [{ caseId: CASES[0].caseId, specPath: '**/*.ts' }],
    [{ caseId: 'FOREIGN-001', specPath: 'test.ts' }],
    [
      { caseId: CASES[0].caseId, specPath: 'one.ts' },
      { caseId: CASES[0].caseId, specPath: 'two.ts' }
    ]
  ])
    assert.ok(
      (await f.api(f.base + '/executions:plan', { ...f.selection, bindings })).status >= 400
    )
  await f.store.updateTask(f.task.id, { caseFilter: 'tests/one.ts' })
  assert.equal(
    (await f.api(f.base + '/executions:plan', f.selection)).body.error.code,
    'filtered_task'
  )
})

test('execution endpoints enforce owner and operator; clients cannot submit arbitrary commands', async (t) => {
  const f = await fixture(t)
  const resolve = f.runtime.kernel.identity.resolve
  f.runtime.kernel.identity.resolve = async (token, source) =>
    token === 'foreign'
      ? { id: 'other', role: 'operator' }
      : token === 'viewer'
        ? { id: 'service-admin', role: 'viewer' }
        : resolve(token, source)
  assert.equal((await f.api(f.base + '/executions', undefined, 'foreign')).status, 404)
  assert.equal((await f.api(f.base + '/executions:plan', f.selection, 'viewer')).status, 403)
  assert.equal(
    (await f.api(f.base + '/executions:plan', { ...f.selection, command: ['node', 'evil.mjs'] }))
      .status,
    400
  )
  const { input } = await f.dispatch()
  assert.equal((await f.api(f.base + '/executions:dispatch', input, 'viewer')).status, 403)
  assert.equal((await f.api(f.base + '/executions:dispatch', input, 'foreign')).status, 404)
})

test('server dispatcher receives the same immutable suite as a local runner', async (t) => {
  const f = await fixture(t)
  await f.store.updateTask(f.task.id, { runsOn: 'server' })
  const { run } = await f.dispatch()
  await f.store.updateSuite(f.suite.id, { command: ['node', 'changed.mjs'] })
  const calls = []
  const dispatched = await dispatchQueued({
    store: f.store,
    config: { maxConcurrentServerRuns: 1, runLeaseMs: 60000 },
    dispatcher: {
      available: true,
      dispatch: async (entry) => {
        calls.push(entry)
      }
    },
    issueRunToken: async () => 'fixture-token',
    buildEnv: async () => ({})
  })
  assert.deepEqual(dispatched, [run.id])
  assert.deepEqual(calls[0].suite.command, ['node', 'run-tests.mjs'])
})

test('older execution details load on demand and cannot cross task boundaries', async (t) => {
  const f = await fixture(t)
  const { run } = await f.dispatch()
  await f.claim()
  await f.complete(
    run,
    CASES.map((entry) => ({
      caseId: entry.caseId,
      spec: entry.specPath,
      status: 'passed',
      steps: [{ seq: 1, label: 'evidence', status: 'passed' }]
    }))
  )
  const next = await f.dispatch()
  const list = (await f.api(f.base + '/executions')).body
  assert.equal(list.runs[0].id, next.run.id)
  assert.equal(list.runs[1].coverage, undefined)
  const detail = (await f.api(f.base + `/executions?run=${run.id}`)).body.runs[0]
  assert.equal(detail.coverage[0].result.status, 'passed')
  assert.equal(
    detail.coverage[0].result.steps,
    undefined,
    'the overview never downloads every step history'
  )
  const other = (await f.api('/api/rig/v1/test-tasks', { app: 'fixture', goal: 'Other task' })).body
    .mission
  assert.equal(
    (await f.api(`/api/rig/v1/missions/${other.id}/executions?run=${run.id}`)).status,
    404
  )
})

test('task result tools read only the bound mission on Web and desktop clients', async (t) => {
  const { InProcessClient } = await import('../apps/server/in-process-client.mjs')
  const { WorkbenchExecutions } = await import('../apps/server/workbench-executions.mjs')
  const { RigClient } = await import('../packages/runtime/client.mjs')
  const { ToolExecutor } = await import('../packages/runtime/tools.mjs')
  const f = await fixture(t)
  const { run } = await f.dispatch()
  await f.claim()
  await f.complete(run, [{ caseId: CASES[0].caseId, status: 'passed', spec: 'tests/auth.spec.ts' }])
  const foreign = (await f.api('/api/rig/v1/test-tasks', { app: 'fixture', goal: '另一个任务' })).body.mission
  const service = new WorkbenchExecutions({ store: f.store })
  const localClient = (id) => new InProcessClient({
    principal: { kind: 'service', id, role: 'admin' },
    kernel: f.runtime.kernel, settings: f.runtime.settings,
    missions: f.runtime.missions, executions: service
  })
  const clients = [localClient('service-admin'), new RigClient({ url: f.runtime.origin, token: 'execution-admin' })]
  for (const client of clients) {
    const executor = new ToolExecutor(client)
    const { policy } = await client.request('/api/rig/v1/execution-config')
    const context = { policy, missionId: f.mission.id, workbench: true }
    const result = await executor.execute('task_results', {}, context)
    assert.equal(result.runs[0].id, run.id)
    assert.equal(result.runs[0].revision, 1)
    assert.equal(result.runs[0].platform, 'web')
    assert.equal(result.runs[0].profile, 'mock')
    assert.equal(result.runs[0].status, 'blocked', 'missing case remains blocked in model context')
    assert.equal(result.runs[0].coverage.length, 2)
    assert.equal(result.tasks, undefined, 'agent does not receive runnable plan commands')
    await assert.rejects(executor.execute('task_results', { runId: run.id }, { ...context, missionId: foreign.id }), { code: 'not_found' })
    await assert.rejects(executor.execute('task_results', {}, { ...context, workbench: false }), { code: 'not_test_task' })
    await assert.rejects(executor.execute('task_results', { missionId: foreign.id }, context))
    assert.deepEqual((await executor.execute('task_results', {}, { ...context, missionId: foreign.id })).runs, [])
  }
  await assert.rejects(localClient('another-owner').request(f.base + '/executions'), { code: 'not_found' })
  const after = (await f.api('/api/v1/runs')).body.runs
  assert.equal(after.length, 1, 'reading results never dispatches')
})
