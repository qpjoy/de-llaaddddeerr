import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'
import { buildPackPlan, describePack, listPacks, loadPack } from '../server/onboarding/packs.mjs'

// Acceptance packs (docs/21 §5): a product's test project as data. What these
// tests protect: creating a project from a pack is idempotent, its workspace
// suites can only run on the machine holding the workspace, and the old cases
// it brings as references never count against a run.

const ADMIN_TOKEN = 'packs-admin-token'
let base
let runtime

const api = async (method, path, { body, token = ADMIN_TOKEN } = {}) => {
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
  const config = loadConfig({
    MXT_STORE: 'memory',
    MXT_ADMIN_TOKEN: ADMIN_TOKEN,
    MXT_PORT: '0',
    MXT_ARTIFACTS_DIR: '.runtime/test-artifacts',
  })
  runtime = await start(config, { schedule: false })
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
})

test('the Compass pack reads as data: suites, plans, cases and references', () => {
  const packs = listPacks()
  assert.ok(packs.some((pack) => pack.id === 'compass'))
  const compass = describePack(loadPack('compass'))
  assert.equal(compass.app.slug, 'luopan')
  assert.equal(compass.source.commit, 'a4cc5de02177cf67b8a498836151297068d24575')
  assert.deepEqual(compass.suites.map((suite) => suite.slug), ['compass-web-snapshot', 'compass-electron-smoke'])
  assert.equal(compass.cases, 14, '11 Web cases and 3 Electron cases')
  assert.equal(compass.references, 23, 'the old public@48af490 cases')
  assert.equal(loadPack('../etc'), null)
  assert.equal(loadPack('nope'), null)
})

test('without a runner a pack has no plans for its workspace suites, and says why', () => {
  const plan = buildPackPlan(loadPack('compass'))
  assert.equal(plan.tasks.length, 0)
  assert.equal(plan.warnings.length, 2)
  assert.match(plan.warnings[0], /桌面端建立快照/)
  for (const suite of plan.suites) {
    assert.equal(suite.repoUrl, 'rig-workspace://luopan/qa')
    assert.equal(suite.ownSource, true)
  }
  const pinned = buildPackPlan(loadPack('compass'), { runnerId: 'rnr_x' })
  assert.deepEqual(pinned.tasks.map((task) => [task.runsOn, task.runnerId]), [['pinned-runner', 'rnr_x'], ['pinned-runner', 'rnr_x']])
})

let runnerId
let runnerToken

test('creating the project from the pack, then pinning its plans to the workspace machine', async () => {
  const first = await api('POST', '/api/v1/onboarding/packs/compass:apply', { body: {} })
  assert.equal(first.status, 200, JSON.stringify(first.body))
  assert.equal(first.body.app.slug, 'luopan')
  assert.equal(first.body.tasks.length, 0)
  assert.match(first.body.summary.warnings.join(' '), /桌面端建立快照/)
  assert.match(first.body.boundary, /不等于线上通过/)
  const suites = (await api('GET', '/api/v1/apps/luopan/suites')).body.suites
  assert.deepEqual(
    suites.map((suite) => [suite.slug, suite.repoUrl, suite.workingDir]).sort(),
    [
      ['compass-electron-smoke', 'rig-workspace://luopan/qa', 'rig-specs/electron'],
      ['compass-web-snapshot', 'rig-workspace://luopan/qa', 'rig-specs'],
    ],
  )
  const cases = (await api('GET', '/api/v1/apps/luopan/cases')).body.cases
  assert.equal(cases.filter((entry) => entry.caseId.startsWith('CPS-WEB-')).length, 11)
  assert.equal(cases.filter((entry) => entry.automationState === 'reference').length, 23)

  const runner = await api('POST', '/runner/v1/runners:register', {
    body: { name: '持有工作区的电脑', kind: 'local', os: 'macos', engines: ['playwright', 'playwright-electron'], surfaces: ['web', 'electron'] },
  })
  runnerId = runner.body.runner.id
  runnerToken = runner.body.token
  const second = await api('POST', '/api/v1/onboarding/packs/compass:apply', { body: { runnerId } })
  assert.equal(second.status, 200)
  assert.deepEqual(second.body.tasks.map((task) => [task.name, task.runsOn, task.runnerId]), [
    ['罗盘 Web · 主路径冒烟', 'pinned-runner', runnerId],
    ['罗盘 Web · 全部用例（含韧性）', 'pinned-runner', runnerId],
  ])
  // Again: nothing new.
  const third = await api('POST', '/api/v1/onboarding/packs/compass:apply', { body: { runnerId } })
  assert.equal(third.body.summary.created.length, 0)
  assert.equal(third.body.summary.updated.length, 0)
  assert.match(third.body.message, /已经是最新/)
})

test('only an admin may apply a pack, with nothing but a runner to choose', async () => {
  assert.equal((await api('POST', '/api/v1/onboarding/packs/compass:apply', { body: { command: ['rm'] } })).status, 400)
  assert.equal((await api('POST', '/api/v1/onboarding/packs/nope:apply', { body: {} })).status, 404)
  assert.equal((await api('POST', '/api/v1/onboarding/packs/compass:apply', { body: { runnerId: 'rnr_missing' } })).status, 400)
  const member = await api('POST', '/api/v1/members', { body: { account: 'pack-operator', role: 'operator' } })
  const login = await api('POST', '/api/v1/auth/login', {
    token: null,
    body: { username: 'pack-operator', password: member.body.initialPassword },
  })
  assert.equal((await api('POST', '/api/v1/onboarding/packs/compass:apply', { token: login.body.token, body: {} })).status, 403)
  assert.equal((await api('GET', '/api/v1/onboarding/packs', { token: login.body.token })).status, 200)
})

test('a workspace suite runs only on a named machine', async () => {
  const refused = await api('POST', '/api/v1/tasks', {
    body: { app: 'luopan', suite: 'compass-web-snapshot', name: '随便哪台都行', runsOn: 'any-runner', schedule: { kind: 'manual' } },
  })
  assert.equal(refused.status, 400)
  assert.equal(refused.body.error.code, 'placement_impossible')
  assert.match(refused.body.error.message, /持有工作区/)
})

test('reference cases are not counted against a run', async () => {
  const plan = (await api('GET', '/api/v1/tasks?app=luopan')).body.tasks.find((task) => task.name === '罗盘 Web · 全部用例（含韧性）')
  const run = (await api('POST', `/api/v1/tasks/${plan.id}:run`, { body: {} })).body.run
  // A machine the run is not pinned to does not get it.
  const other = await api('POST', '/runner/v1/runners:register', {
    body: { name: '另一台', kind: 'local', os: 'linux', engines: ['playwright'], surfaces: ['web'] },
  })
  assert.equal((await api('POST', '/runner/v1/runs:claim', { token: other.body.token, body: {} })).status, 204)
  const claim = await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  assert.equal(claim.body.runId, run.id)
  assert.equal(claim.body.app.repoUrl, 'rig-workspace://luopan/qa')
  assert.equal(claim.body.suite.workingDir, 'rig-specs')
  // The pinned machine reports every Web case passed.
  const web = loadPack('compass').catalogs[0].catalog.cases
  const done = await api('POST', `/runner/v1/runs/${run.id}:complete`, {
    token: claim.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId: run.id,
        app: 'luopan',
        status: 'passed',
        totals: { tests: web.length, passed: web.length },
        cases: web.map((entry) => ({ caseId: entry.id, status: 'passed', durationMs: 100, spec: entry.spec })),
      },
    },
  })
  assert.equal(done.status, 200, JSON.stringify(done.body))
  assert.equal(done.body.run.catalog.catalogTotal, 11, "the Web suite's own cases: no references, no Electron cases")
  assert.equal(done.body.run.catalog.counts.notRun ?? 0, 0)
  assert.equal(done.body.run.catalog.coverage.catalogCompletionPercent, 100)
})

test('a plan filtered by case id is measured against exactly those ids', async () => {
  const plan = (await api('GET', '/api/v1/tasks?app=luopan')).body.tasks.find((task) => task.name === '罗盘 Web · 主路径冒烟')
  const run = (await api('POST', `/api/v1/tasks/${plan.id}:run`, { body: {} })).body.run
  const claim = await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  assert.equal(claim.body.runId, run.id)
  const ids = plan.caseFilter.split(',')
  assert.equal(claim.body.env.MXT_CASE_FILTER, plan.caseFilter)
  const done = await api('POST', `/runner/v1/runs/${run.id}:complete`, {
    token: claim.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId: run.id,
        app: 'luopan',
        status: 'passed',
        totals: { tests: ids.length, passed: ids.length },
        cases: ids.map((caseId) => ({ caseId, status: 'passed', durationMs: 100 })),
      },
    },
  })
  // CPS-WEB-STRAT-003 shares web/strategy.spec.mjs with two filtered cases,
  // but the suite selects by id: it was not asked for, so it is not "not run".
  assert.equal(done.body.run.catalog.catalogTotal, 10)
  assert.equal(done.body.run.catalog.counts.notRun ?? 0, 0)
})

test('a project without a pack gets a fixed suite for its own test repository', async () => {
  await api('POST', '/api/v1/apps', { body: { slug: 'repo-demo', displayName: '仓库演示', surfaces: ['web'], visibility: 'private' } })
  const member = await api('POST', '/api/v1/members', { body: { account: 'repo-operator', role: 'operator' } })
  const login = await api('POST', '/api/v1/auth/login', { token: null, body: { username: 'repo-operator', password: member.body.initialPassword } })
  // An operator who may not write to the project cannot create it…
  assert.equal((await api('POST', '/api/v1/apps/repo-demo/workspace-suite', { token: login.body.token, body: {} })).status, 404)
  // …the admin can, and so can an operator once the project is shared with them.
  const created = await api('POST', '/api/v1/apps/repo-demo/workspace-suite', { body: {} })
  assert.equal(created.status, 200)
  const suite = created.body.suite
  assert.deepEqual(
    [suite.slug, suite.engine, suite.surface, suite.repoUrl, suite.defaultBranch, suite.targetMode, suite.command.join(' '), suite.requirements.caseSelection],
    ['rig-tests-web', 'playwright', 'web', 'rig-workspace://repo-demo/qa', 'main', 'external', 'npx playwright test', 'case-id']
  )
  // Asking again gives the same suite; it is not duplicated.
  assert.equal((await api('POST', '/api/v1/apps/repo-demo/workspace-suite', { body: {} })).body.suite.id, suite.id)
  assert.equal((await api('GET', '/api/v1/apps/repo-demo/suites')).body.suites.length, 1)
  // It runs only on a named machine.
  const anywhere = await api('POST', '/api/v1/tasks', { body: { app: 'repo-demo', suite: 'rig-tests-web', name: '随便', targetUrl: 'http://127.0.0.1:4610', runsOn: 'any-runner' } })
  assert.equal(anywhere.body.error.code, 'placement_impossible')
  const audit = await api('GET', '/api/v1/audit?app=repo-demo&resource=suite')
  assert.equal(audit.body.events[0].action, 'suite.create')
})

test('published test versions get a fixed suite any runner may take, but not the server', async () => {
  const created = await api('POST', '/api/v1/apps/repo-demo/published-suite', { body: {} })
  assert.equal(created.status, 200)
  const suite = created.body.suite
  assert.deepEqual([suite.slug, suite.repoUrl, suite.defaultBranch, suite.command.join(' ')], ['rig-tests-web-published', 'rig-published://repo-demo', 'latest', 'npx playwright test'])
  const anyRunner = await api('POST', '/api/v1/tasks', { body: { app: 'repo-demo', suite: suite.slug, name: '团队', targetUrl: 'http://127.0.0.1:4610', runsOn: 'any-runner' } })
  assert.equal(anyRunner.status, 201)
  const onServer = await api('POST', '/api/v1/tasks', { body: { app: 'repo-demo', suite: suite.slug, name: '服务器', targetUrl: 'http://127.0.0.1:4610', runsOn: 'server' } })
  assert.equal(onServer.body.error.code, 'placement_impossible')
  assert.match(onServer.body.error.message, /执行机/)
})
