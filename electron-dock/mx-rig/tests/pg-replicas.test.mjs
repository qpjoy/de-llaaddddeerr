import test, { after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { migrate } from '../packages/test-platform/server/migrate.mjs'
import { start } from '../apps/server/index.mjs'
import { Settings } from '../apps/server/settings.mjs'
import { SystemProgress } from '../apps/server/system-progress.mjs'
import { SharedScheduleState } from '../apps/server/orchestration-schedule.mjs'
import { DocumentConflict, PgDocument } from '../apps/server/state-documents.mjs'
import { PgMissionStore } from '../apps/server/pg-missions.mjs'
import { ProcedureStation, enrollStation } from '../packages/runtime/station.mjs'

// The control plane on a real PostgreSQL, with two service processes on one
// database — which is what "more than one replica" means. Needs a server this
// test may create databases on:
//
//   MX_RIG_TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:55432/postgres npm test
//
// Without it the whole file is skipped; the memory-mode suites still run.

const ADMIN = 'pg-replica-admin-token'
const base = process.env.MX_RIG_TEST_DATABASE_URL
const skip = base ? false : 'MX_RIG_TEST_DATABASE_URL 未设置，跳过 PostgreSQL 多副本测试'
let databaseUrl
let pool
let dropDatabase = async () => {}

before(async () => {
  if (!base) return
  const name = `mx_rig_test_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(base)
  url.pathname = `/${name}`
  databaseUrl = url.toString()
  await migrate({ connectionString: databaseUrl })
  pool = new pg.Pool({ connectionString: databaseUrl, max: 4 })
  dropDatabase = async () => {
    await pool.end()
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  }
})
after(async () => dropDatabase())

// A model gateway that never answers until the request is aborted: a mission
// stuck in a model call, which is exactly when a stop has to reach it.
const hangingModel = {
  environment: { MX_RIG_MODEL_API_KEY: 'k' },
  fetchImpl: (_url, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })
}

async function replica(t, extraEnv = {}) {
  const state = await mkdtemp(join(tmpdir(), 'mx-rig-replica-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'postgres',
      MX_RIG_DATABASE_URL: databaseUrl,
      MX_RIG_STATE_DIR: join(state, 'control'),
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts'),
      MX_RIG_INSECURE_COOKIES: 'true',
      ...extraEnv
    },
    { schedule: false, modelOptions: hangingModel }
  )
  t.after(() => runtime.close())
  const api = async (path, body, token = ADMIN) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  return { runtime, api }
}

async function until(api, id, token, predicate, label, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const { body } = await api('/api/rig/v1/missions', undefined, token)
    const row = body.missions?.find((entry) => entry.id === id)
    if (row && predicate(row)) return row
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`等待超时：${label}`)
}

test('documents refuse a save made against a stale version', { skip }, async () => {
  const a = new PgDocument(pool, 'doc-cas')
  const b = new PgDocument(pool, 'doc-cas')
  assert.equal(await a.save({ n: 1 }, 0), 1)
  await assert.rejects(b.save({ n: 'other' }, 0), DocumentConflict)
  assert.equal(await b.save({ n: 2 }, 1), 2)
  await assert.rejects(a.save({ n: 3 }, 1), DocumentConflict)
  assert.deepEqual((await a.load()).value, { n: 2 })
})

test('two replicas agree on settings and see each other’s saves', { skip }, async () => {
  const a = await new Settings(new PgDocument(pool, 'settings-a')).init()
  const b = await new Settings(new PgDocument(pool, 'settings-a')).init()
  // Unsaved defaults would each carry a random revision; the first replica's
  // defaults are stored and the second adopts them.
  assert.equal(a.value.revision, b.value.revision)
  await a.update({ ...a.value, maxTurns: 7 })
  await b.refresh({ force: true })
  assert.equal(b.value.maxTurns, 7)
  assert.equal(b.value.revision, a.value.revision)
  // An editor that started from the old revision cannot overwrite the new one.
  const stale = { ...b.value, revision: 'not-the-current-one', maxTurns: 9 }
  await assert.rejects(b.update(stale), { code: 'settings_conflict' })
})

test('tutorial progress written by two replicas keeps both changes', { skip }, async () => {
  const a = await new SystemProgress(new PgDocument(pool, 'progress-a')).init()
  const b = await new SystemProgress(new PgDocument(pool, 'progress-a')).init()
  await Promise.all([a.seen('alice', '0.9'), b.seen('bob', '0.9')])
  const fresh = await new SystemProgress(new PgDocument(pool, 'progress-a')).init()
  assert.equal(fresh.get('alice').seenVersion, '0.9')
  assert.equal(fresh.get('bob').seenVersion, '0.9')
})

test('a scheduled slot is fired by exactly one replica', { skip }, async () => {
  const a = await new SharedScheduleState(pool, { claimant: 'a' }).init()
  const b = await new SharedScheduleState(pool, { claimant: 'b' }).init()
  const slot = '2026-09-26T01:00:00.000Z'
  const results = await Promise.all([a.claim('nightly', slot), b.claim('nightly', slot)])
  assert.deepEqual(results.sort(), [false, true])
  await b.refresh()
  assert.equal(b.value.nightly.lastFiredAt, slot)
})

test('a test plan’s cron fire becomes one run when both replicas tick', { skip }, async () => {
  const { PostgresStore } = await import('../packages/test-platform/server/store/postgres.mjs')
  const { tick } = await import('../packages/test-platform/server/scheduler.mjs')
  const a = new PostgresStore(pool)
  const b = new PostgresStore(pool)
  const app = await a.createApp({ slug: 'cron-app', displayName: 'Cron', surfaces: ['web'] })
  const suite = await a.createSuite({
    appId: app.id,
    slug: 'cron-web',
    displayName: 'Web',
    engine: 'playwright',
    surface: 'web',
    runnerKind: 'server'
  })
  const task = await a.createTask({
    appId: app.id,
    suiteId: suite.id,
    name: 'nightly',
    profile: 'mock',
    track: 'functional',
    targetUrl: 'https://cron.example.internal',
    scheduleKind: 'cron',
    cronExpr: '0 2 * * *',
    runAt: null,
    timezone: 'Asia/Shanghai',
    claimWindowMinutes: 720,
    enabled: true,
    nextRunAt: '2026-08-12T18:00:00.000Z'
  })
  const at = new Date('2026-08-12T18:00:05Z')
  const results = await Promise.all([tick(a, at), tick(b, at), tick(a, at), tick(b, at)])
  const created = results.flatMap((result) => result.created)
  assert.equal(created.length, 1)
  const after = await b.getTask(task.id)
  assert.equal(after.nextRunAt, '2026-08-13T18:00:00.000Z')
  assert.equal(after.lastRunId, created[0])
})

test('a mission started on one replica is approved once, from the other', { skip }, async (t) => {
  const A = await replica(t)
  const B = await replica(t)

  // Accounts and sessions are shared: sign in on B, act on A.
  assert.equal(
    (await A.api('/api/v1/members', { account: 'op', role: 'operator', password: 'op-password-1' }))
      .status,
    201
  )
  const signIn = await B.api(
    '/api/rig/v1/native-login',
    { account: 'op', password: 'op-password-1' },
    ''
  )
  const op = signIn.body.token
  assert.match(op, /^rig_s1_/)

  assert.equal(
    (await A.api('/api/v1/apps', { slug: 'rig-pg', displayName: 'PG', surfaces: ['web'] })).status,
    201
  )
  assert.equal(
    (
      await A.api('/api/v1/apps/rig-pg/suites', {
        slug: 'smoke',
        displayName: 'Smoke',
        engine: 'playwright',
        surface: 'web',
        runnerKind: 'local',
        command: ['node', 'test.mjs'],
        targetMode: 'self'
      })
    ).status,
    201
  )
  const task = await A.api('/api/v1/tasks', {
    app: 'rig-pg',
    suite: 'smoke',
    name: 'Regression',
    profile: 'mock',
    track: 'functional'
  })
  assert.equal(task.status, 201, JSON.stringify(task.body))
  const workflow = { mode: 'workflow', goal: 'run', taskId: task.body.task.id }

  const created = await A.api('/api/rig/v1/missions', workflow, op)
  assert.equal(created.status, 201, JSON.stringify(created.body))
  const id = created.body.mission.id
  const waiting = await until(
    B.api,
    id,
    op,
    (row) => row.status === 'awaiting_approval',
    '等待确认'
  )

  // One member, one open mission — across replicas, not just within one.
  const second = await B.api('/api/rig/v1/missions', workflow, op)
  assert.equal(second.status, 409)
  assert.equal(second.body.error.code, 'busy')

  // The same approval clicked on both replicas at once executes once.
  const body = { approvalId: waiting.pending.approvalId, approved: true }
  const answers = await Promise.all([
    A.api(`/api/rig/v1/missions/${id}/approve`, body, op),
    B.api(`/api/rig/v1/missions/${id}/approve`, body, op)
  ])
  assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409])
  const done = await until(A.api, id, op, (row) => row.status === 'completed', '完成')
  assert.ok(done.testRunId)
  // Other tests share this database; count only this task's runs.
  const runs = (await A.api('/api/v1/runs')).body.runs.filter(
    (run) => run.taskId === task.body.task.id
  )
  assert.equal(runs.length, 1, '派发只发生一次')
  assert.equal(runs[0].id, done.testRunId)

  // Paused on A, cancelled from B: nothing is in flight, so B closes it.
  const paused = (await A.api('/api/rig/v1/missions', workflow, op)).body.mission.id
  await until(A.api, paused, op, (row) => row.status === 'awaiting_approval', '第二项等待确认')
  const cancelled = await B.api(`/api/rig/v1/missions/${paused}/cancel`, {}, op)
  assert.equal(cancelled.status, 200)
  assert.equal(cancelled.body.mission.status, 'cancelled')

  // Deterministically the other way round: paused on A, approved only on B.
  // A must not keep treating it as its own open mission afterwards.
  const third = await A.api('/api/rig/v1/missions', workflow, op)
  assert.equal(third.status, 201, JSON.stringify(third.body))
  const thirdId = third.body.mission.id
  const pending = await until(
    A.api,
    thirdId,
    op,
    (row) => row.status === 'awaiting_approval',
    '第三项等待确认'
  )
  const approvedOnB = await B.api(
    `/api/rig/v1/missions/${thirdId}/approve`,
    { approvalId: pending.pending.approvalId, approved: true },
    op
  )
  assert.equal(approvedOnB.status, 200, JSON.stringify(approvedOnB.body))
  await until(A.api, thirdId, op, (row) => row.status === 'completed', '第三项完成')
  const fourth = await A.api('/api/rig/v1/missions', workflow, op)
  assert.equal(fourth.status, 201, JSON.stringify(fourth.body))
})

test(
  'a stop requested on one replica reaches a mission running on the other',
  { skip },
  async (t) => {
    const A = await replica(t)
    const B = await replica(t)
    await A.runtime.settings.update({
      ...A.runtime.settings.value,
      providers: [
        {
          id: 'primary',
          displayName: '主模型',
          baseUrl: 'https://models.example/v1',
          model: 'hangs',
          apiKeyEnv: 'MX_RIG_MODEL_API_KEY',
          timeoutMs: 120_000,
          enabled: true,
          stream: false
        }
      ]
    })
    const started = await A.api('/api/rig/v1/missions', { mode: 'agent', goal: '一直等模型' })
    assert.equal(started.status, 201, JSON.stringify(started.body))
    const id = started.body.mission.id
    await until(A.api, id, ADMIN, (row) => row.status === 'running', '运行中')
    await new Promise((resolve) => setTimeout(resolve, 200))

    const asked = await B.api(`/api/rig/v1/missions/${id}/cancel`, {})
    assert.equal(asked.status, 200)
    assert.equal(asked.body.mission.cancelRequested, true)
    // A notices on its next heartbeat, aborts the model call and closes the
    // mission itself; B never rewrites the record.
    const stopped = await until(B.api, id, ADMIN, (row) => row.status === 'cancelled', '取消生效')
    assert.ok(stopped.events.some((event) => /另一个工作台取消/.test(event.message)))
  }
)

test('missions left running by a vanished replica are closed as blocked', { skip }, async () => {
  const store = new PgMissionStore(pool, { instance: 'gone', staleAfterMs: 1 })
  const row = await store.create('someone', { goal: 'orphan', mode: 'agent' })
  row.status = 'running'
  await store.save(row)
  const paused = await store.create('someone-else', { goal: 'paused', mode: 'workflow' })
  paused.status = 'awaiting_approval'
  paused.pending = { approvalId: 'x' }
  await store.save(paused)
  await new Promise((resolve) => setTimeout(resolve, 20))

  const sweeper = new PgMissionStore(pool, { instance: 'alive', staleAfterMs: 1 })
  const closed = await sweeper.sweep()
  assert.ok(closed.includes(row.id))
  const after = await sweeper.get(row.id, 'someone')
  assert.equal(after.status, 'blocked')
  assert.equal(after.events.at(-1).kind, 'interrupted')
  // A paused mission holds nothing in memory; it stays approvable.
  assert.equal((await sweeper.get(paused.id, 'someone-else')).status, 'awaiting_approval')
})

test('a deployment switching to PostgreSQL keeps its file-based state', { skip }, async (t) => {
  // A separate database: the import runs once per database, on first start.
  const name = `mx_rig_import_${randomUUID().replaceAll('-', '').slice(0, 12)}`
  const admin = new pg.Client({ connectionString: base })
  await admin.connect()
  await admin.query(`CREATE DATABASE ${name}`)
  await admin.end()
  const url = new URL(base)
  url.pathname = `/${name}`
  let runtime = null
  // One hook, in order: the service releases its pool before the database goes.
  t.after(async () => {
    await runtime?.close()
    const cleanup = new pg.Client({ connectionString: base })
    await cleanup.connect()
    await cleanup.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`)
    await cleanup.end()
  })
  await migrate({ connectionString: url.toString() })

  const state = await mkdtemp(join(tmpdir(), 'mx-rig-legacy-'))
  const control = join(state, 'control')
  await mkdir(join(control, 'missions'), { recursive: true })
  const legacy = await new Settings(join(control, 'settings.json')).init()
  await legacy.update({ ...legacy.value, maxTurns: 5 })
  const missionId = randomUUID()
  await writeFile(
    join(control, 'missions', `${missionId}.json`),
    JSON.stringify({
      id: missionId,
      owner: 'service-admin',
      goal: '旧任务',
      mode: 'agent',
      status: 'completed',
      createdAt: new Date().toISOString(),
      events: [],
      messages: []
    })
  )

  runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: ADMIN,
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'postgres',
      MX_RIG_DATABASE_URL: url.toString(),
      MX_RIG_STATE_DIR: control,
      MX_RIG_ARTIFACTS_DIR: join(state, 'artifacts')
    },
    { schedule: false }
  )
  assert.equal(runtime.settings.value.maxTurns, 5)
  assert.equal(runtime.settings.value.revision, legacy.value.revision)
  const listed = await runtime.missions.list('service-admin')
  assert.ok(listed.some((row) => row.id === missionId && row.goal === '旧任务'))
})

test('a desktop record synced to one replica is read from the other', { skip }, async (t) => {
  const A = await replica(t)
  const B = await replica(t)
  const id = randomUUID()
  const row = {
    id,
    goal: '桌面巡检',
    mode: 'agent',
    status: 'running',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    events: []
  }
  const synced = await A.api('/api/rig/v1/missions:sync', { missions: [row] })
  assert.equal(synced.body.synced, 1)
  const seen = (await B.api('/api/rig/v1/missions')).body.missions.find((m) => m.id === id)
  assert.equal(seen.surface, 'desktop')
  assert.equal(seen.status, 'running')

  // Running on a desktop is not an orphan of either replica.
  const sweeper = new PgMissionStore(pool, { instance: 'sweeper', staleAfterMs: 1 })
  await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(!(await sweeper.sweep()).includes(id))

  // Newer wins, older is ignored, whichever replica receives it.
  const later = new Date(Date.now() + 5_000).toISOString()
  await B.api('/api/rig/v1/missions:sync', {
    missions: [{ ...row, status: 'completed', updatedAt: later }]
  })
  await A.api('/api/rig/v1/missions:sync', { missions: [{ ...row, status: 'running' }] })
  const final = (await A.api('/api/rig/v1/missions')).body.missions.find((m) => m.id === id)
  assert.equal(final.status, 'completed')
  const refused = await B.api(`/api/rig/v1/missions/${id}/cancel`, {})
  assert.equal(refused.body.error.code, 'desktop_mission')
})

test(
  'procedures are shared by replicas, and one proposal is approved once',
  { skip },
  async (t) => {
    const A = await replica(t)
    const B = await replica(t)
    const steps = [
      { do: 'open', url: 'https://t.example/settings' },
      { do: 'click', target: { role: 'button', name: '保存' } },
      { do: 'assert', kind: 'text_visible', expected: '已保存' }
    ]
    const created = await A.api('/api/rig/v1/procedures', { procedure: { title: '保存', steps } })
    assert.equal(created.status, 201, JSON.stringify(created.body))
    const id = created.body.procedure.id
    assert.equal((await B.api(`/api/rig/v1/procedures/${id}`)).body.procedure.title, '保存')

    const passed = {
      revision: 1,
      verdict: 'passed',
      failedStep: null,
      failure: null,
      steps: [],
      startedAt: '2026-09-29T00:00:00.000Z',
      finishedAt: '2026-09-29T00:00:01.000Z',
      durationMs: 1
    }
    const revised = steps.map((step, index) =>
      index === 1 ? { ...step, target: { role: 'button', name: '提交' } } : step
    )
    const { proposal } = (
      await B.api(`/api/rig/v1/procedures/${id}/proposals`, {
        proposal: {
          baseRevision: 1,
          verdict: 'case-issue',
          rationale: '改名',
          steps: revised,
          validation: passed
        }
      })
    ).body
    const decide = (side) =>
      side.api(`/api/rig/v1/procedures/${id}/proposals/${proposal.id}:decide`, { approved: true })
    const answers = await Promise.all([decide(A), decide(B)])
    assert.deepEqual(answers.map((answer) => answer.status).sort(), [200, 409])
    const final = (await A.api(`/api/rig/v1/procedures/${id}`)).body.procedure
    assert.equal(final.revision, 2, 'applied once, not twice')
    assert.equal(final.history.length, 1)
    assert.equal((await B.api('/api/rig/v1/procedures')).body.procedures[0].revision, 2)
  }
)

test('a failed run is claimed by one replica’s hook, once', { skip }, async (t) => {
  const A = await replica(t)
  const B = await replica(t)
  await A.api('/api/v1/apps', { slug: 'hooked', displayName: 'Hooked', surfaces: ['web'] })
  const saved = await B.api('/api/rig/v1/hooks', {
    version: 0,
    rules: [{ name: '失败定级', event: 'run.finished', includeProcedureRuns: true }]
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  await new Promise((resolve) => setTimeout(resolve, 5))
  const recorded = await A.api('/api/v1/apps/hooked/results:record', {
    summary: {
      schemaVersion: 2,
      status: 'failed',
      totals: { tests: 1, failed: 1 },
      cases: [{ caseId: 'HKD-WEB-X-001', title: 'x', status: 'failed' }]
    }
  })
  const runId = recorded.body.run.id
  const ticks = await Promise.all([
    A.runtime.hooks.tick(),
    B.runtime.hooks.tick(),
    A.runtime.hooks.tick()
  ])
  assert.equal(
    ticks.reduce((sum, tick) => sum + tick.claimed, 0),
    1,
    'three ticks on two replicas, one claim'
  )
  const fires = await pool.query(
    'SELECT count(*)::int AS n FROM rig_hook_fires WHERE subject_id = $1',
    [runId]
  )
  assert.equal(fires.rows[0].n, 1)
  const started = await pool.query(
    `SELECT count(*)::int AS n FROM rig_missions WHERE owner = 'rig-hooks'`
  )
  assert.equal(started.rows[0].n, 1, 'one triage mission')
  await Promise.all([A.runtime.hooks.tick(), B.runtime.hooks.tick()])
  const after = await pool.query(
    `SELECT count(*)::int AS n FROM rig_missions WHERE owner = 'rig-hooks'`
  )
  assert.equal(after.rows[0].n, 1, 'and never a second one')
})

test('a recorded replay with an unreadable clock never leaves a run running', { skip }, async (t) => {
  const A = await replica(t)
  await A.api('/api/v1/apps', { slug: 'clock', displayName: 'Clock', surfaces: ['web'] })
  const recorded = await A.api('/api/v1/apps/clock/results:record', {
    summary: {
      schemaVersion: 2,
      status: 'passed',
      startedAt: 'a',
      finishedAt: 'b',
      totals: { tests: 1, passed: 1 },
      cases: [{ caseId: 'CLK-WEB-X-001', title: 'x', status: 'passed' }]
    }
  })
  assert.equal(recorded.status, 201, JSON.stringify(recorded.body))
  assert.ok(Number.isFinite(Date.parse(recorded.body.run.startedAt)), 'the service’s clock instead')
  const running = await pool.query(
    `SELECT count(*)::int AS n FROM mxt_runs WHERE status = 'running' AND trigger = 'rig-procedure'`
  )
  assert.equal(running.rows[0].n, 0)
})

test('a procedure batch queued on one replica is taken and reported through the other', { skip }, async (t) => {
  const A = await replica(t)
  const B = await replica(t)
  const origin = 'http://127.0.0.1:9'
  const policy = (await A.api('/api/rig/v1/admin/config')).body
  assert.equal((await A.api('/api/rig/v1/admin/config', { ...policy, browserOrigins: [origin] })).status, 200)
  await A.api('/api/v1/apps', { slug: 'batch', displayName: 'Batch', surfaces: ['web'] })
  await A.api('/api/v1/apps/batch/cases', { caseId: 'BAT-WEB-X-001', title: '打开', priority: 'P1', steps: [] })
  const { id } = (
    await A.api('/api/rig/v1/procedures', {
      procedure: { title: '打开', app: 'batch', caseId: 'BAT-WEB-X-001', baseUrl: origin, steps: [{ do: 'open', url: '/' }] }
    })
  ).body.procedure
  await A.api(`/api/rig/v1/procedures/${id}/runs`, {
    run: {
      revision: 1,
      verdict: 'passed',
      failedStep: null,
      failure: null,
      steps: [],
      startedAt: '2026-09-29T00:00:00.000Z',
      finishedAt: '2026-09-29T00:00:01.000Z',
      durationMs: 1,
      station: 'test'
    }
  })
  assert.equal((await B.api(`/api/rig/v1/procedures/${id}:status`, { status: 'active' })).status, 200)
  const task = (await A.api('/api/rig/v1/procedure-tasks', { app: 'batch', name: '回归', runsOn: 'server' })).body.task
  const code = (await B.api('/api/v1/runners:enroll', {})).body.code
  const enrolled = await enrollStation({ server: B.runtime.origin, code, name: 'pg-station', kind: 'server', os: 'linux', arch: 'x64' })
  const runId = (await A.api(`/api/rig/v1/procedure-tasks/${task.id}:run`, {})).body.run.id

  // Two stations, one on each replica, race for the one batch.
  const browser = { root: null, async perform() { return {} }, async close() {} }
  const other = await enrollStation({
    server: A.runtime.origin,
    code: (await A.api('/api/v1/runners:enroll', {})).body.code,
    name: 'pg-station-2',
    kind: 'server',
    os: 'linux',
    arch: 'x64'
  })
  const outcomes = await Promise.all([
    new ProcedureStation({ server: B.runtime.origin, runnerToken: enrolled.runnerToken, browser }).once(),
    new ProcedureStation({ server: A.runtime.origin, runnerToken: other.runnerToken, browser }).once()
  ])
  const taken = outcomes.filter(Boolean)
  assert.equal(taken.length, 1, 'one station takes it')
  assert.deepEqual([taken[0].runId, taken[0].status], [runId, 'passed'])
  const run = (await A.api(`/api/v1/runs/${runId}`)).body.run
  assert.equal(run.status, 'passed')
  const record = (await A.api(`/api/rig/v1/procedures/${id}`)).body.procedure.runs[0]
  assert.deepEqual([record.station, record.kernelRunId], ['station', runId])
  const overview = (await B.api('/api/rig/v1/procedure-tasks')).body
  assert.deepEqual(overview.tasks.map((entry) => entry.lastRun?.status), ['passed'])
})
