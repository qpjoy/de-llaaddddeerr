import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { catalogSubsetFor, parseCaseFilter } from '../server/ingest/case-filter.mjs'

// Running part of a suite — docs/25 §15d. `MXT_CASE_FILTER` was in the contract
// from the beginning and implemented nowhere; what these protect is that it now
// means something, that it refuses rather than silently running everything, and
// that a filtered run's coverage is measured against what it was asked to run.

const ADMIN = 'test-admin-token'
let base
let runtime

const api = async (method, path, { body, token = ADMIN } = {}) => {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await response.text()
  return { status: response.status, body: text ? JSON.parse(text) : null }
}

before(async () => {
  runtime = await start(
    loadConfig({
      MXT_STORE: 'memory',
      MXT_ADMIN_TOKEN: ADMIN,
      MXT_PORT: '0',
      MXT_ARTIFACTS_DIR: '.runtime/test-artifacts',
    }),
    { schedule: false },
  )
  base = `http://127.0.0.1:${runtime.port}`

  await api('POST', '/api/v1/apps', { body: { slug: 'filt', displayName: '筛选演示' } })
  await api('POST', '/api/v1/apps/filt/suites', {
    body: {
      slug: 'web',
      displayName: 'Web',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'local',
      command: ['pnpm', 'e2e:local'],
    },
  })
  await api('POST', '/api/v1/apps/filt/catalog:sync', {
    body: {
      schemaVersion: 2,
      application: 'filt',
      catalogFile: 'cases.json',
      suite: 'web',
      cases: [
        { id: 'FT-FE-AUTH-001', title: '登录', priority: 'P0', spec: 'cypress/e2e/smoke/auth.cy.ts' },
        { id: 'FT-FE-AUTH-002', title: '登出', priority: 'P1', spec: 'cypress/e2e/smoke/auth.cy.ts' },
        { id: 'FT-FE-HOME-001', title: '首页', priority: 'P0', spec: 'cypress/e2e/core/home.cy.ts' },
        { id: 'FT-FE-TODO-001', title: '还没写', priority: 'P2' },
      ],
    },
  })
})

after(async () => {
  await runtime.close()
})

test('a filter is a list, deduplicated and bounded', () => {
  assert.deepEqual(parseCaseFilter(' A, B ,A, '), ['A', 'B'])
  assert.deepEqual(parseCaseFilter(''), [])
  assert.deepEqual(parseCaseFilter(null), [])
  assert.equal(parseCaseFilter(Array.from({ length: 80 }, (_, i) => `C-${i}`).join(',')).length, 50)
})

test('a filtered run is measured against the subset, not the whole catalog', () => {
  const catalog = [
    { caseId: 'A-1', specPath: 'a.cy.ts' },
    { caseId: 'A-2', specPath: 'b.cy.ts' },
  ]
  assert.equal(catalogSubsetFor(catalog, null).length, 2, 'no filter means the whole catalog')
  assert.deepEqual(
    catalogSubsetFor(catalog, { caseIds: ['A-1'], specs: [] }).map((entry) => entry.caseId),
    ['A-1'],
  )
  // A glob selects every case that lives in the spec it names.
  assert.deepEqual(
    catalogSubsetFor(catalog, { caseIds: [], specs: ['b.cy.ts'] }).map((entry) => entry.caseId),
    ['A-2'],
  )
})

test('a filter naming something the catalog never heard of is refused', async () => {
  const unknown = await api('POST', '/api/v1/tasks', {
    body: { app: 'filt', suite: 'web', name: '不存在的用例', targetUrl: 'https://f.example.internal', caseFilter: 'FT-FE-NOPE-999' },
  })
  assert.equal(unknown.status, 400)
  assert.equal(unknown.body.error.code, 'case_filter_unknown')

  // "Registered, not yet implemented" has no spec to run. Saying so beats
  // running the whole suite and calling it a rerun.
  const unimplemented = await api('POST', '/api/v1/tasks', {
    body: { app: 'filt', suite: 'web', name: '还没实现', targetUrl: 'https://f.example.internal', caseFilter: 'FT-FE-TODO-001' },
  })
  assert.equal(unimplemented.status, 400)
  assert.equal(unimplemented.body.error.code, 'case_filter_unmapped')
})

let taskId

test('case ids reach the runner as spec paths, because that is what engines read', async () => {
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'filt',
      suite: 'web',
      name: '只跑登录',
      targetUrl: 'https://f.example.internal',
      caseFilter: 'FT-FE-AUTH-001',
    },
  })
  assert.equal(task.status, 201)
  assert.equal(task.body.task.caseFilter, 'FT-FE-AUTH-001')
  taskId = task.body.task.id

  const run = await api('POST', `/api/v1/tasks/${taskId}:run`)
  assert.equal(run.body.run.caseFilter, 'FT-FE-AUTH-001')

  const runner = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'filt-machine', kind: 'local', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: runner.body.token, body: {} })
  assert.equal(claimed.status, 200)
  // The contract's own variable carries what the person wrote…
  assert.equal(claimed.body.env.MXT_CASE_FILTER, 'FT-FE-AUTH-001')
  // …and the compass alias carries the resolved spec, which is the form
  // `cypress --spec` can act on. Resolving is something only the platform can
  // do: the mapping from case id to file lives in the catalog.
  assert.equal(claimed.body.env.E2E_SPEC, 'cypress/e2e/smoke/auth.cy.ts')

  const completed = await api('POST', `/runner/v1/runs/${claimed.body.runId}:complete`, {
    token: claimed.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId: claimed.body.runId,
        app: 'filt',
        status: 'passed',
        totals: { tests: 1, passed: 1 },
        cases: [{ caseId: 'FT-FE-AUTH-001', status: 'passed', durationMs: 900 }],
      },
    },
  })
  assert.equal(completed.status, 200)

  // The subset is "everything this filter causes to run", not "the ids that
  // were typed". Cypress runs whole spec files — there is no way to run one
  // test out of auth.cy.ts — so FT-FE-AUTH-002 is inside the scope of this run
  // whether or not anybody asked for it, and a run that did not report it did
  // genuinely skip it.
  //
  // The other two cases, which live in other files, are not counted at all.
  const counts = completed.body.run.catalog.counts
  assert.equal(counts.passed, 1)
  assert.equal(counts.notRun, 1, 'the sibling case in the same spec file is in scope')
  assert.equal(completed.body.run.catalog.catalogTotal, 2)
  assert.equal(completed.body.run.catalog.caseFilter, 'FT-FE-AUTH-001')
})

const taskById = async (id) =>
  (await api('GET', '/api/v1/tasks')).body.tasks.find((entry) => entry.id === id)

test('one execution can be restricted without changing what the task means', async () => {
  assert.equal((await taskById(taskId)).caseFilter, 'FT-FE-AUTH-001')

  // The rerun button: same task, one case, and the task is left alone.
  const rerun = await api('POST', `/api/v1/tasks/${taskId}:run`, {
    body: { caseFilter: 'FT-FE-HOME-001' },
  })
  assert.equal(rerun.body.run.caseFilter, 'FT-FE-HOME-001')
  assert.equal((await taskById(taskId)).caseFilter, 'FT-FE-AUTH-001')

  // And it can be widened back to the whole suite for one run.
  const full = await api('POST', `/api/v1/tasks/${taskId}:run`, { body: { caseFilter: '' } })
  assert.equal(full.body.run.caseFilter, null)
})

test('a suite that reports its own full catalog does not turn the rest into "unmapped"', async () => {
  // 罗盘 writes a schemaVersion 1 summary that reconciles against its own whole
  // catalog: a filtered run still reports all 23 cases, 19 of them notRun.
  // Those are registered cases outside this run's scope — calling them "not in
  // the catalog" would be exactly backwards, and that is what happened the
  // first time this ran for real.
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'filt',
      suite: 'web',
      name: '自带对账的套件',
      targetUrl: 'https://f.example.internal',
      caseFilter: 'FT-FE-HOME-001',
    },
  })
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  const runner = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'filt-machine-2', kind: 'local', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  // Earlier tests left runs queued, and a runner takes the oldest first. Drain
  // until this one comes up rather than assuming the queue is empty.
  let claimed = null
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const next = await api('POST', '/runner/v1/runs:claim', { token: runner.body.token, body: {} })
    if (next.status !== 200) break
    if (next.body.runId === run.body.run.id) {
      claimed = next
      break
    }
  }
  assert.ok(claimed, 'the run created by this test should be claimable')

  const completed = await api('POST', `/runner/v1/runs/${claimed.body.runId}:complete`, {
    token: claimed.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId: claimed.body.runId,
        app: 'filt',
        status: 'passed',
        totals: { tests: 4, passed: 1 },
        cases: [
          { caseId: 'FT-FE-HOME-001', status: 'passed', durationMs: 400 },
          { caseId: 'FT-FE-AUTH-001', status: 'notRun' },
          { caseId: 'FT-FE-AUTH-002', status: 'notRun' },
          { caseId: 'FT-FE-NOT-REGISTERED-001', status: 'passed', durationMs: 10 },
        ],
      },
    },
  })
  const catalog = completed.body.run.catalog
  assert.equal(catalog.catalogTotal, 1, 'home.cy.ts holds exactly one registered case')
  assert.equal(catalog.counts.passed, 1)
  assert.equal(catalog.counts.notRun, 0)
  assert.equal(catalog.outOfScope, 2, 'the two AUTH cases are registered, just not in scope')
  // A case nothing has ever registered is still unmapped — that signal has to
  // keep working, filter or no filter.
  assert.equal(catalog.unmapped.length, 1)
  assert.equal(catalog.unmapped[0].caseId, 'FT-FE-NOT-REGISTERED-001')

  const cases = await api('GET', `/api/v1/runs/${claimed.body.runId}/cases`)
  assert.ok(!cases.body.cases.some((entry) => entry.caseId === 'FT-FE-AUTH-001'), '范围外的用例不出现在明细里')
})
