// End-to-end smoke against a running deployment.
//
// This is the P0 exit criterion made executable: register an app, sync a
// catalog, create a task, run it, claim it as a runner, submit a summary, and
// read the result back. Called by `manage.sh verify`.
//
// Identities are *fixed*, not suffixed with a timestamp.
//
// A unique suffix per run avoided collisions, and left one fake application and
// one fake runner behind every single time. Six deploys in, the runner list a
// person actually opens had six `verify-runner-1788…` rows in it and no way to
// remove them. Litter that only grows is a defect, even when each individual
// piece is harmless.
//
// Reusing one identity is also better as a record: `verify-selfcheck` becomes
// the history of every self-check this deployment has ever run. The one thing
// created per run — the task — is deleted at the end, because tasks have no
// uniqueness constraint and would otherwise stack up and all fire.

const base = (process.env.MXT_BASE_URL || 'http://127.0.0.1:8790').replace(/\/$/, '')
const adminToken = process.env.MXT_ADMIN_TOKEN || ''
const appSlug = process.env.MXT_VERIFY_APP || 'verify-selfcheck'

let failures = 0

const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function call(method, path, { body, token = adminToken, stream = false } = {}) {
  if (stream) return readStream(path, token)
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

/**
 * Read a Server-Sent Events response into frames.
 *
 * Bounded by a timeout because the stream of a run that is still running is
 * open-ended on purpose: it stays connected until the run ends. Whatever
 * arrived before the deadline is the answer.
 */
async function readStream(path, token) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 1500)
  let text = ''
  try {
    const response = await fetch(`${base}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
    for await (const chunk of response.body) text += Buffer.from(chunk).toString('utf8')
    return { status: response.status, frames: parseFrames(text) }
  } catch {
    return { status: 200, frames: parseFrames(text) }
  } finally {
    clearTimeout(timer)
  }
}

function parseFrames(text) {
  const frames = []
  for (const block of text.split('\n\n')) {
    const lines = block.split('\n')
    const kind = lines.find((line) => line.startsWith('event: '))?.slice(7)
    const data = lines.find((line) => line.startsWith('data: '))?.slice(6)
    if (kind && data) {
      try {
        frames.push({ kind, data: JSON.parse(data) })
      } catch {
        // A frame this script cannot parse is not worth failing a self-check.
      }
    }
  }
  return frames
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
// 409 means a previous self-check already registered it, which is the point.
check('application registered', app.status === 201 || app.status === 409, JSON.stringify(app.body))

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
check('suite registered', suite.status === 201 || suite.status === 409, JSON.stringify(suite.body))

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
// On the first run both cases are added; on later runs they are already there.
// What must hold either way is that the catalog now contains exactly these two
// — that is what the notRun assertion below depends on.
const catalogCases = await call('GET', `/api/v1/apps/${appSlug}/cases`)
check(
  'catalog synced',
  catalog.status === 200 &&
    (catalogCases.body?.cases ?? []).filter((entry) => entry.caseId.startsWith('VER-FE-SMOKE-')).length === 2,
  JSON.stringify(catalog.body),
)

const task = await call('POST', '/api/v1/tasks', {
  body: {
    app: appSlug,
    suite: 'smoke',
    name: 'verify smoke',
    targetUrl: 'https://verify.example.internal',
    runsOn: 'server',
  },
})
check('task created', task.status === 201, JSON.stringify(task.body))
// The 「在哪跑」 choice has to survive a round trip through the real database,
// which is the one thing the in-memory tests cannot prove (docs/25 §13).
check('task records where it runs', task.body?.task?.runsOn === 'server', JSON.stringify(task.body?.task?.runsOn))

const triggered = await call('POST', `/api/v1/tasks/${task.body?.task?.id}:run`)
check('task ran on demand', triggered.status === 202, JSON.stringify(triggered.body))
const runId = triggered.body?.run?.id

const runner = await call('POST', '/runner/v1/runners:register', {
  body: {
    // Registering the same name again updates the existing machine rather than
    // adding another, so this stays at one row however often it runs.
    name: 'verify-selfcheck',
    kind: 'server',
    os: 'linux',
    engines: ['cypress'],
    surfaces: ['web'],
  },
})
check('runner registered', runner.status === 201 || runner.status === 200, JSON.stringify(runner.body))
const runnerToken = runner.body?.token

const claimed = await call('POST', '/runner/v1/runs:claim', { token: runnerToken, body: {} })
check('runner claimed the run', claimed.status === 200 && claimed.body.runId === runId, JSON.stringify(claimed.body))
check(
  'the server track does not record video',
  claimed.body?.env?.MXT_RECORD_VIDEO === '0',
  JSON.stringify(claimed.body?.env?.MXT_RECORD_VIDEO),
)
check(
  'compass-compatible E2E_* variables are injected',
  claimed.body?.env?.E2E_BASE_URL === 'https://verify.example.internal' &&
    claimed.body?.env?.E2E_RUN_ID === runId,
  JSON.stringify(claimed.body?.env),
)

// Live progress: the run page's answer to "跑到哪一步了" (docs/25).
const claimEvents = await call('GET', `/api/v1/runs/${runId}/events?lastEventId=0`, { stream: true })
check(
  'claiming a run writes the first events by itself',
  claimEvents.frames?.[0]?.kind === 'run.claimed',
  JSON.stringify(claimEvents.frames?.slice(0, 2)),
)

const progress = await call('POST', `/runner/v1/runs/${runId}/events`, {
  token: claimed.body?.runToken,
  body: {
    events: [
      { kind: 'stage', stage: 'execute', status: 'started' },
      { kind: 'case.started', caseId: 'VER-FE-SMOKE-001', title: '打开首页' },
      { kind: 'step', caseId: 'VER-FE-SMOKE-001', seq: 1, label: '打开首页' },
    ],
  },
})
check('runner progress accepted', progress.status === 202 && progress.body?.accepted === 3, JSON.stringify(progress.body))

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

// The stream of a finished run replays its timeline and closes itself. If it
// did not close, every run page ever opened would hold a connection open
// against the browser's six-per-origin limit.
const timeline = await call('GET', `/api/v1/runs/${runId}/events`, { stream: true })
check(
  'the live timeline replays and terminates',
  timeline.frames?.at(-1)?.kind === 'end' &&
    timeline.frames.some((frame) => frame.kind === 'run.finished'),
  JSON.stringify(timeline.frames?.map((frame) => frame.kind)),
)

// Clean up the one thing that would otherwise accumulate.
//
// Applications, suites and runners are reused by fixed name, but a task has no
// uniqueness constraint — the same suite can legitimately have a nightly task
// and an on-merge one — so a new one is created every run and has to be removed
// again. Eight of them had piled up before anyone looked.
//
// Deliberately after the assertions and deliberately not fatal: a failed
// cleanup must not turn a passing self-check red, but it must be visible.
const taskId = task.body?.task?.id
if (taskId) {
  const removed = await call('DELETE', `/api/v1/tasks/${taskId}`)
  if (removed.status !== 204) {
    console.error(`  warn 没能删掉自检任务 ${taskId}（HTTP ${removed.status}），下次会多出一条`)
  }
}

if (failures > 0) {
  console.error(`\nverify FAILED: ${failures} check(s)`)
  process.exit(1)
}
console.log('\nverify passed')
