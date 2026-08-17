import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { loadConfig } from '../server/config.mjs'
import { start } from '../server/index.mjs'

// End-to-end over real HTTP against the memory store. This is the P0 exit
// criterion in executable form: register an app, sync a catalog, create a task,
// run it, claim it as a runner, submit a summary, and read the result back.

const ADMIN_TOKEN = 'test-admin-token'
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
    MXT_ARTIFACTS_DIR: '/data/artifacts',
  })
  runtime = await start(config, { schedule: false })
  base = `http://127.0.0.1:${runtime.port}`
})

after(async () => {
  await runtime.close()
})

test('health and readiness need no credentials', async () => {
  assert.equal((await api('GET', '/healthz', { token: null })).status, 200)
  assert.equal((await api('GET', '/readyz', { token: null })).status, 200)
})

test('the control plane rejects a missing or wrong token', async () => {
  assert.equal((await api('GET', '/api/v1/apps', { token: null })).status, 401)
  assert.equal((await api('GET', '/api/v1/apps', { token: 'wrong' })).status, 401)
})

let appSlug = 'compass'
let suiteSlug = 'compass-web-functional'
let taskId

test('registers an application and a suite', async () => {
  const app = await api('POST', '/api/v1/apps', {
    body: {
      slug: appSlug,
      displayName: '罗盘 Compass',
      surfaces: ['web', 'electron'],
      catalogGlob: 'cypress/case-catalog.*.json',
    },
  })
  assert.equal(app.status, 201)
  assert.equal(app.body.app.slug, appSlug)

  const duplicate = await api('POST', '/api/v1/apps', {
    body: { slug: appSlug, displayName: 'again' },
  })
  assert.equal(duplicate.status, 409)

  const suite = await api('POST', `/api/v1/apps/${appSlug}/suites`, {
    body: {
      slug: suiteSlug,
      displayName: 'Web 功能主轨',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'server',
      command: ['pnpm', 'e2e:run:mock'],
    },
  })
  assert.equal(suite.status, 201)
})

test('imports a schemaVersion 1 catalog unchanged', async () => {
  // Exactly the shape compass already writes, so onboarding it edits nothing.
  const sync = await api('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
    body: {
      schemaVersion: 1,
      application: 'luopan-po-frontend',
      catalogFile: 'cypress/case-catalog.frontend.json',
      cases: [
        {
          id: 'LP-FE-AUTH-001',
          priority: 'P0',
          spec: 'cypress/e2e/smoke/auth.cy.ts',
          title: '未登录用户访问受保护页面时跳转登录并保留目标地址',
          tags: ['auth', 'route-guard'],
        },
        {
          id: 'LP-FE-AUTH-002',
          priority: 'P0',
          spec: 'cypress/e2e/smoke/auth.cy.ts',
          title: '登录表单阻止空账号、空密码和未完成验证码的提交',
        },
        {
          id: 'LP-FE-NAV-003',
          priority: 'P1',
          spec: 'cypress/e2e/smoke/navigation.cy.ts',
          title: '未知路由展示 404 页面并可返回首页',
        },
      ],
    },
  })
  assert.equal(sync.status, 200)
  assert.deepEqual(sync.body.added.sort(), ['LP-FE-AUTH-001', 'LP-FE-AUTH-002', 'LP-FE-NAV-003'])

  const cases = await api('GET', `/api/v1/apps/${appSlug}/cases`)
  assert.equal(cases.body.cases.length, 3)
  // Defaults filled in for a v1 catalog.
  assert.deepEqual(cases.body.cases[0].tracks, ['functional'])
})

test('rejects a case id that does not match the naming rule', async () => {
  const response = await api('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
    body: {
      schemaVersion: 2,
      application: appSlug,
      catalogFile: 'bad.json',
      cases: [{ id: 'not-a-case-id', title: 'x' }],
    },
  })
  assert.equal(response.status, 400)
  assert.equal(response.body.error.code, 'invalid_case_id')
  // The message must show the shape it wants, not just say "invalid".
  assert.match(response.body.error.hint, /LP-FE-AUTH-001|序号/)
})

test('removing a case from its catalog retires it instead of deleting it', async () => {
  await api('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
    body: {
      schemaVersion: 1,
      application: appSlug,
      catalogFile: 'cypress/case-catalog.frontend.json',
      cases: [
        { id: 'LP-FE-AUTH-001', priority: 'P0', title: '保留' },
        { id: 'LP-FE-AUTH-002', priority: 'P0', title: '保留' },
        { id: 'LP-FE-NAV-003', priority: 'P1', title: '保留' },
      ],
    },
  })
  const dropped = await api('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
    body: {
      schemaVersion: 1,
      application: appSlug,
      catalogFile: 'cypress/case-catalog.frontend.json',
      cases: [{ id: 'LP-FE-AUTH-001', priority: 'P0', title: '保留' }],
    },
  })
  assert.deepEqual(dropped.body.retired.sort(), ['LP-FE-AUTH-002', 'LP-FE-NAV-003'])

  const active = await api('GET', `/api/v1/apps/${appSlug}/cases`)
  assert.equal(active.body.cases.length, 1)
  const all = await api('GET', `/api/v1/apps/${appSlug}/cases?retired=true`)
  assert.equal(all.body.cases.length, 3)

  // Restore the full catalog for the run tests below.
  await api('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
    body: {
      schemaVersion: 1,
      application: appSlug,
      catalogFile: 'cypress/case-catalog.frontend.json',
      cases: [
        { id: 'LP-FE-AUTH-001', priority: 'P0', title: '未登录跳转登录' },
        { id: 'LP-FE-AUTH-002', priority: 'P0', title: '登录表单校验' },
        { id: 'LP-FE-NAV-003', priority: 'P1', title: '404 页面' },
      ],
    },
  })
})

test('creates a task and validates its schedule', async () => {
  const bad = await api('POST', '/api/v1/tasks', {
    body: {
      app: appSlug,
      suite: suiteSlug,
      name: '坏调度',
      targetUrl: 'https://compass.example.internal',
      schedule: { kind: 'cron', cronExpr: 'not a cron' },
    },
  })
  assert.equal(bad.status, 400)
  assert.equal(bad.body.error.code, 'task_schedule_invalid')

  const credentialUrl = await api('POST', '/api/v1/tasks', {
    body: {
      app: appSlug,
      suite: suiteSlug,
      name: '带凭据的地址',
      targetUrl: 'https://user:pass@compass.example.internal',
    },
  })
  assert.equal(credentialUrl.status, 400)

  const created = await api('POST', '/api/v1/tasks', {
    body: {
      app: appSlug,
      suite: suiteSlug,
      name: 'compass 每晚回归',
      profile: 'mock',
      track: 'functional',
      targetUrl: 'https://compass.example.internal',
      schedule: { kind: 'cron', cronExpr: '0 2 * * *', timezone: 'Asia/Shanghai' },
    },
  })
  assert.equal(created.status, 201)
  assert.ok(created.body.task.nextRunAt, 'a cron task must carry its next fire time')
  taskId = created.body.task.id
})

let runId
let runnerToken

test('runs a task on demand and hands it to a matching runner', async () => {
  const triggered = await api('POST', `/api/v1/tasks/${taskId}:run`)
  assert.equal(triggered.status, 202)
  assert.equal(triggered.body.run.status, 'queued')
  runId = triggered.body.run.id

  const registered = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'ci-linux-01',
      kind: 'server',
      os: 'linux',
      engines: ['cypress', 'playwright'],
      surfaces: ['web'],
    },
  })
  assert.equal(registered.status, 201)
  runnerToken = registered.body.token
  assert.ok(runnerToken)
  assert.equal(registered.body.runner.tokenSha256, undefined, 'never echo the stored hash')

  const claimed = await api('POST', '/runner/v1/runs:claim', {
    token: runnerToken,
    body: {},
  })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.runId, runId)
  // compass reads E2E_*; the platform speaks both so that repo needs no edits.
  assert.equal(claimed.body.env.E2E_BASE_URL, 'https://compass.example.internal')
  assert.equal(claimed.body.env.MXT_BASE_URL, 'https://compass.example.internal')
  assert.equal(claimed.body.env.E2E_RUN_ID, runId)
  assert.ok(claimed.body.env.MXT_ARTIFACTS_DIR.endsWith(`/runs/${runId}`))
  assert.deepEqual(claimed.body.command, ['pnpm', 'e2e:run:mock'])

  const second = await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  assert.equal(second.status, 204, 'a claimed run must not be handed out twice')
})

test('a runner cannot act on a run it does not hold', async () => {
  const intruder = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'other-box', kind: 'local', os: 'windows', engines: ['playwright'], surfaces: ['electron'] },
  })
  const response = await api('POST', `/runner/v1/runs/${runId}:complete`, {
    token: intruder.body.token,
    body: { exitCode: 0, summary: { schemaVersion: 2, runId, app: appSlug, status: 'passed', totals: { tests: 1 } } },
  })
  assert.equal(response.status, 403)
})

test('ingests a compass-shaped summary and reconciles it with the catalog', async () => {
  const completed = await api('POST', `/runner/v1/runs/${runId}:complete`, {
    token: runnerToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 1,
        runId,
        profile: 'mock',
        status: 'passed',
        totals: { tests: 2, passed: 2, failed: 0, skipped: 0, durationMs: 4200 },
        specs: [
          {
            name: 'cypress/e2e/smoke/auth.cy.ts',
            tests: [
              { title: '未登录跳转登录', state: 'passed', durationMs: 3120, attempts: 1 },
              { title: '登录表单校验', state: 'passed', durationMs: 1080, attempts: 1 },
            ],
          },
        ],
        functional: {
          catalogTotal: 3,
          cases: [
            { id: 'LP-FE-AUTH-001', status: 'passed', actualTitle: '未登录跳转登录', actualSpec: 'cypress/e2e/smoke/auth.cy.ts' },
            { id: 'LP-FE-AUTH-002', status: 'passed', actualTitle: '登录表单校验', actualSpec: 'cypress/e2e/smoke/auth.cy.ts' },
          ],
          unmapped: [],
        },
      },
    },
  })
  assert.equal(completed.status, 200)
  const run = completed.body.run
  assert.equal(run.status, 'passed')

  // LP-FE-NAV-003 is in the catalog but was never executed. Silently dropping
  // it would let a deleted test look like a clean run.
  assert.equal(run.catalog.counts.notRun, 1)
  assert.equal(run.catalog.counts.passed, 2)
  assert.equal(run.catalog.catalogTotal, 3)
  assert.equal(run.catalog.coverage.catalogPassPercent, 66.67)
  assert.equal(run.catalog.coverage.executedPassPercent, 100)

  const cases = await api('GET', `/api/v1/runs/${runId}/cases`)
  const byId = Object.fromEntries(cases.body.cases.map((entry) => [entry.caseId, entry]))
  assert.equal(byId['LP-FE-AUTH-001'].status, 'passed')
  assert.equal(byId['LP-FE-AUTH-001'].durationMs, 3120)
  assert.equal(byId['LP-FE-NAV-003'].status, 'notRun')
})

test('a run with no executed tests is blocked, never passed', async () => {
  const triggered = await api('POST', `/api/v1/tasks/${taskId}:run`)
  const emptyRunId = triggered.body.run.id
  await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })

  const completed = await api('POST', `/runner/v1/runs/${emptyRunId}:complete`, {
    token: runnerToken,
    body: {
      exitCode: 2,
      summary: {
        schemaVersion: 2,
        runId: emptyRunId,
        app: appSlug,
        status: 'passed',
        totals: { tests: 0 },
        blockedReason: 'Target unreachable',
      },
    },
  })
  assert.equal(completed.body.run.status, 'blocked')
  assert.equal(completed.body.run.blockedReason, 'Target unreachable')
  // The catalog still reports what did not run.
  assert.equal(completed.body.run.catalog.counts.notRun, 3)
})

test('a non-zero exit code overrides an optimistic summary', async () => {
  const triggered = await api('POST', `/api/v1/tasks/${taskId}:run`)
  const failingRunId = triggered.body.run.id
  await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })

  const completed = await api('POST', `/runner/v1/runs/${failingRunId}:complete`, {
    token: runnerToken,
    body: {
      exitCode: 1,
      summary: {
        schemaVersion: 2,
        runId: failingRunId,
        app: appSlug,
        status: 'passed',
        totals: { tests: 1, passed: 1 },
        cases: [{ caseId: 'LP-FE-AUTH-001', status: 'passed' }],
      },
    },
  })
  assert.equal(completed.body.run.status, 'failed')
})

test('records step offsets so a report can jump into the recording', async () => {
  const triggered = await api('POST', `/api/v1/tasks/${taskId}:run`)
  const stepRunId = triggered.body.run.id
  await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  await api('POST', `/runner/v1/runs/${stepRunId}:complete`, {
    token: runnerToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        runId: stepRunId,
        app: appSlug,
        status: 'passed',
        totals: { tests: 1, passed: 1 },
        cases: [
          {
            caseId: 'LP-FE-AUTH-001',
            status: 'passed',
            steps: [
              { seq: 1, label: '打开受保护页面', status: 'passed', offsetMs: 120 },
              { seq: 2, label: '确认跳转到登录页', status: 'passed', offsetMs: 2400 },
            ],
            artifacts: [{ kind: 'video', path: 'videos/smoke/auth.cy.ts.mp4' }],
          },
        ],
      },
    },
  })
  const steps = await api('GET', `/api/v1/runs/${stepRunId}/cases/LP-FE-AUTH-001/steps`)
  assert.equal(steps.body.steps.length, 2)
  assert.equal(steps.body.steps[1].offsetMs, 2400)
})

test('an Electron suite is never handed to a Linux container', async () => {
  await api('POST', `/api/v1/apps/${appSlug}/suites`, {
    body: {
      slug: 'compass-electron',
      displayName: '桌面端',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
      requirements: { os: ['windows', 'macos'] },
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: appSlug, suite: 'compass-electron', name: '桌面冒烟', claimWindowMinutes: 60 },
  })
  const triggered = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`)
  // Local-runner work waits for a machine rather than queueing for the cluster.
  assert.equal(triggered.body.run.status, 'pending-runner')

  const wrongRunner = await api('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
  assert.equal(wrongRunner.status, 204)

  const desktop = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'wang-windows',
      kind: 'local',
      os: 'windows',
      engines: ['playwright-electron'],
      surfaces: ['electron'],
    },
  })
  const claimed = await api('POST', '/runner/v1/runs:claim', {
    token: desktop.body.token,
    body: {},
  })
  assert.equal(claimed.status, 200)
  assert.equal(claimed.body.runId, triggered.body.run.id)
})

test('an unknown runner token is rejected', async () => {
  const response = await api('POST', '/runner/v1/runs:claim', { token: 'mxt-rnr-bogus', body: {} })
  assert.equal(response.status, 401)
})
