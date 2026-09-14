import assert from 'node:assert/strict'
import test from 'node:test'
import { computeNextRunAt, tick } from '../server/scheduler.mjs'
import { MemoryStore } from '../server/store/memory.mjs'

async function fixture({ runnerKind = 'server' } = {}) {
  const store = new MemoryStore()
  const app = await store.createApp({ slug: 'compass', displayName: 'Compass', surfaces: ['web'] })
  const suite = await store.createSuite({
    appId: app.id,
    slug: 'web-functional',
    displayName: 'Web',
    engine: 'cypress',
    surface: 'web',
    runnerKind,
  })
  return { store, app, suite }
}

const baseTask = (app, suite, overrides) => ({
  appId: app.id,
  suiteId: suite.id,
  name: 't',
  profile: 'mock',
  track: 'functional',
  targetUrl: 'https://compass.example.internal',
  scheduleKind: 'manual',
  cronExpr: null,
  runAt: null,
  timezone: 'Asia/Shanghai',
  claimWindowMinutes: 720,
  enabled: true,
  nextRunAt: null,
  ...overrides,
})

test('a manual task never becomes due on its own', async () => {
  const { store, app, suite } = await fixture()
  await store.createTask(baseTask(app, suite))
  const result = await tick(store, new Date('2026-08-12T10:00:00Z'))
  assert.equal(result.created.length, 0)
})

test('a cron task fires and immediately schedules its next fire', async () => {
  const { store, app, suite } = await fixture()
  const task = await store.createTask(
    baseTask(app, suite, {
      scheduleKind: 'cron',
      cronExpr: '0 2 * * *',
      nextRunAt: '2026-08-12T18:00:00.000Z',
    }),
  )
  const result = await tick(store, new Date('2026-08-12T18:00:05Z'))
  assert.equal(result.created.length, 1)

  const after = await store.getTask(task.id)
  // Advancing in the same pass is what stops a slow tick from double-firing.
  assert.equal(after.nextRunAt, '2026-08-13T18:00:00.000Z')
  assert.equal(after.lastRunId, result.created[0])

  const again = await tick(store, new Date('2026-08-12T18:00:30Z'))
  assert.equal(again.created.length, 0, 'the same due time must not fire twice')
})

test('a once task fires exactly once and then disables itself', async () => {
  const { store, app, suite } = await fixture()
  const task = await store.createTask(
    baseTask(app, suite, {
      scheduleKind: 'once',
      runAt: '2026-08-12T18:00:00.000Z',
      nextRunAt: '2026-08-12T18:00:00.000Z',
    }),
  )
  assert.equal((await tick(store, new Date('2026-08-12T18:01:00Z'))).created.length, 1)
  const after = await store.getTask(task.id)
  assert.equal(after.enabled, false)
  assert.equal(after.nextRunAt, null)
  assert.equal((await tick(store, new Date('2026-08-13T18:01:00Z'))).created.length, 0)
})

test('a task pointing at a disabled suite is parked, not retried forever', async () => {
  const { store, app, suite } = await fixture()
  const task = await store.createTask(
    baseTask(app, suite, {
      scheduleKind: 'cron',
      cronExpr: '* * * * *',
      nextRunAt: '2026-08-12T18:00:00.000Z',
    }),
  )
  // Simulate the suite being turned off after the task was created.
  const disabled = { ...(await store.getSuite(suite.id)), enabled: false }
  store.getSuite = async (id) => (id === suite.id ? disabled : null)

  const result = await tick(store, new Date('2026-08-12T18:00:05Z'))
  assert.equal(result.created.length, 0)
  assert.equal((await store.getTask(task.id)).enabled, false)
})

test('local-runner work waits for a machine and expires without failing', async () => {
  const { store, app, suite } = await fixture({ runnerKind: 'local' })
  await store.createTask(
    baseTask(app, suite, {
      scheduleKind: 'cron',
      cronExpr: '0 2 * * *',
      claimWindowMinutes: 60,
      nextRunAt: '2026-08-12T18:00:00.000Z',
    }),
  )
  const fired = await tick(store, new Date('2026-08-12T18:00:00Z'))
  const run = await store.getRun(fired.created[0])
  assert.equal(run.status, 'pending-runner')
  assert.equal(run.claimDeadline, '2026-08-12T19:00:00.000Z')

  const swept = await tick(store, new Date('2026-08-12T19:00:01Z'))
  assert.deepEqual(swept.expired, [run.id])
  // Expired is not a failure: nobody was at their desk, not a broken product.
  assert.equal((await store.getRun(run.id)).status, 'expired')
})

test('a claimed run whose runner goes silent is reclaimed as timeout', async () => {
  const { store, app, suite } = await fixture()
  const run = await store.createRun({
    appId: app.id,
    suiteId: suite.id,
    profile: 'mock',
    track: 'functional',
    engine: 'cypress',
    trigger: 'manual',
  })
  const runner = await store.registerRunner({
    name: 'r1',
    kind: 'server',
    os: 'linux',
    capabilities: { engines: ['cypress'], surfaces: ['web'] },
    tokenSha256: 'hash',
  })
  await store.claimRun({ runner, leaseMs: 60_000, now: new Date('2026-08-12T10:00:00Z') })

  const swept = await tick(store, new Date('2026-08-12T10:02:00Z'))
  assert.deepEqual(swept.timedOut, [run.id])
  assert.equal((await store.getRun(run.id)).status, 'timeout')
})

test('a disabled task computes no next fire time', () => {
  assert.equal(
    computeNextRunAt({ enabled: false, scheduleKind: 'cron', cronExpr: '* * * * *', timezone: 'UTC' }),
    null,
  )
})

test('a once task whose time has passed does not resurrect', () => {
  assert.equal(
    computeNextRunAt(
      { enabled: true, scheduleKind: 'once', runAt: '2020-01-01T00:00:00Z' },
      new Date('2026-08-12T00:00:00Z'),
    ),
    null,
  )
})
