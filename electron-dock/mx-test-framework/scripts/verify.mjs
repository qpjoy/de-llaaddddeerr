// End-to-end smoke against a running deployment.
//
// This is the P0 exit criterion made executable: register an app, sync a
// catalog, create a task, run it, claim it as a runner, submit a summary, and
// read the result back. Called by `manage.sh verify`.
//
// It uses a unique suffix per run so it can be run repeatedly against the same
// deployment without colliding with its own earlier artifacts.

const base = (process.env.MXT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
const adminToken = process.env.MXT_ADMIN_TOKEN || ''
const suffix = process.env.MXT_VERIFY_SUFFIX || String(Date.now())
const appSlug = `verify-${suffix}`

let failures = 0

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, { body, token = adminToken } = {}) {
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

console.log(`verifying ${base}`)

const health = await call('GET', '/healthz', { token: null })
check('health endpoint responds', health.status === 200, `status ${health.status}`)

const ready = await call('GET', '/readyz', { token: null })
check('database is reachable', ready.status === 200, JSON.stringify(ready.body))

const unauthorized = await call('GET', '/api/v1/apps', { token: null })
check('control plane requires a token', unauthorized.status === 401, `status ${unauthorized.status}`)

const app = await call('POST', '/api/v1/apps', {
  body: { slug: appSlug, displayName: 'Verify', surfaces: ['web'] },
})
check('application registered', app.status === 201, JSON.stringify(app.body))

const suite = await call('POST', `/api/v1/apps/${appSlug}/suites`, {
  body: {
    slug: 'smoke',
    displayName: 'Smoke',
    engine: 'cypress',
    surface: 'web',
    runnerKind: 'server',
    command: ['pnpm', 'e2e:run:mock'],
  },
})
check('suite registered', suite.status === 201, JSON.stringify(suite.body))

const catalog = await call('POST', `/api/v1/apps/${appSlug}/catalog:sync`, {
  body: {
    schemaVersion: 2,
    application: appSlug,
    catalogFile: 'verify.json',
    cases: [
      { id: 'VER-FE-SMOKE-001', priority: 'P0', title: '冒烟用例一' },
      { id: 'VER-FE-SMOKE-002', priority: 'P0', title: '冒烟用例二' },
    ],
  },
})
check('catalog synced', catalog.status === 200 && catalog.body.added.length === 2, JSON.stringify(catalog.body))

const task = await call('POST', '/api/v1/tasks', {
  body: {
    app: appSlug,
    suite: 'smoke',
    name: 'verify smoke',
    targetUrl: 'https://verify.example.internal',
  },
})
check('task created', task.status === 201, JSON.stringify(task.body))

const triggered = await call('POST', `/api/v1/tasks/${task.body?.task?.id}:run`)
check('task ran on demand', triggered.status === 202, JSON.stringify(triggered.body))
const runId = triggered.body?.run?.id

const runner = await call('POST', '/runner/v1/runners:register', {
  body: {
    name: `verify-runner-${suffix}`,
    kind: 'server',
    os: 'linux',
    engines: ['cypress'],
    surfaces: ['web'],
  },
})
check('runner registered', runner.status === 201, JSON.stringify(runner.body))
const runnerToken = runner.body?.token

const claimed = await call('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
check('runner claimed the run', claimed.status === 200 && claimed.body.runId === runId, JSON.stringify(claimed.body))
check(
  'compass-compatible E2E_* variables are injected',
  claimed.body?.env?.E2E_BASE_URL === 'https://verify.example.internal' &&
    claimed.body?.env?.E2E_RUN_ID === runId,
  JSON.stringify(claimed.body?.env),
)

const completed = await call('POST', `/runner/v1/runs/${runId}:complete`, {
  token: runnerToken,
  body: {
    exitCode: 0,
    summary: {
      schemaVersion: 2,
      runId,
      app: appSlug,
      status: 'passed',
      totals: { tests: 1, passed: 1 },
      cases: [
        {
          caseId: 'VER-FE-SMOKE-001',
          status: 'passed',
          durationMs: 1200,
          steps: [{ seq: 1, label: '打开首页', status: 'passed', offsetMs: 100 }],
        },
      ],
    },
  },
})
check('summary ingested', completed.status === 200, JSON.stringify(completed.body))
check('run passed', completed.body?.run?.status === 'passed', completed.body?.run?.status)
check(
  'the case that never ran is reported as notRun',
  completed.body?.run?.catalog?.counts?.notRun === 1,
  JSON.stringify(completed.body?.run?.catalog?.counts),
)

const readBack = await call('GET', `/api/v1/runs/${runId}/cases`)
check('case results are queryable', readBack.status === 200 && readBack.body.cases.length === 2, JSON.stringify(readBack.body))

const steps = await call('GET', `/api/v1/runs/${runId}/cases/VER-FE-SMOKE-001/steps`)
check('step timeline is queryable', steps.body?.steps?.[0]?.offsetMs === 100, JSON.stringify(steps.body))

if (failures > 0) {
  console.error(`\nverify FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nverify passed')
