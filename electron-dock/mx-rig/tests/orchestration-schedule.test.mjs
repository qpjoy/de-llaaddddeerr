import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ScheduleState,
  blockingSteps,
  dueOrchestrations,
  nextFireAt,
  readSchedule
} from '../apps/server/orchestration-schedule.mjs'
import { start } from '../apps/server/index.mjs'

const readOnly = (overrides = {}) => ({
  key: 'nightly',
  displayName: '每日巡检',
  summary: '读执行机并报告',
  enabled: true,
  inputs: [],
  entry: 'read',
  nodes: [
    {
      id: 'read',
      title: '读执行机',
      type: 'tool',
      tool: 'tests_runners',
      args: {},
      capture: { online: { from: 'runners', select: 'count', where: 'online' } },
      next: 'done'
    },
    { id: 'done', title: '报告', type: 'finish', message: '在线执行机 {{online}} 台。' }
  ],
  ...overrides
})

test('only an orchestration that can finish alone may be scheduled', () => {
  const writeTools = ['tests_run', 'tests_cancel']
  assert.deepEqual(blockingSteps(readOnly(), writeTools), [])
  const schedule = readSchedule({ cronExpr: '0 9 * * 1-5' }, readOnly(), { writeTools })
  assert.equal(schedule.timezone, 'Asia/Shanghai')
  assert.ok(nextFireAt(schedule))

  const dispatches = readOnly({
    nodes: [
      { id: 'd', title: '派发', type: 'tool', tool: 'tests_run', args: {}, capture: {}, next: null }
    ]
  })
  assert.throws(() => readSchedule({ cronExpr: '0 9 * * *' }, dispatches, { writeTools }), /写工具/)

  const asks = readOnly({
    nodes: [{ id: 'a', title: '复核', type: 'approval', message: '看一眼', next: null }]
  })
  assert.throws(() => readSchedule({ cronExpr: '0 9 * * *' }, asks, { writeTools }), /人工检查点/)

  // Nobody is there to type an input at 09:00.
  const needsInput = readOnly({
    inputs: [{ name: 'runId', label: 'Run', kind: 'run', required: true }]
  })
  assert.throws(
    () => readSchedule({ cronExpr: '0 9 * * *' }, needsInput, { writeTools }),
    /没有人填写输入/
  )

  assert.throws(() => readSchedule({ cronExpr: '不是 cron' }, readOnly(), { writeTools }), /cron/)
  assert.throws(
    () => readSchedule({ cronExpr: '0 9 * * *', oops: 1 }, readOnly(), { writeTools }),
    /多余字段/
  )
  assert.equal(readSchedule(null, readOnly(), { writeTools }), null)
})

test('a disabled schedule never comes due, and firing is recorded once', async () => {
  const now = new Date('2026-09-16T01:00:30.000Z')
  const on = readOnly({
    schedule: { cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: true }
  })
  const off = readOnly({
    key: 'paused',
    schedule: { cronExpr: '0 9 * * *', timezone: 'Asia/Shanghai', enabled: false }
  })
  const due = dueOrchestrations([on, off], {}, now)
  assert.deepEqual(
    due.map((entry) => entry.spec.key),
    ['nightly']
  )
  // Once recorded for that slot, the same tick does not fire it again.
  const state = { nightly: { lastFiredAt: due[0].firedFor } }
  assert.deepEqual(dueOrchestrations([on], state, now), [])
  // A disabled orchestration is skipped even with an enabled schedule.
  assert.deepEqual(dueOrchestrations([{ ...on, enabled: false }], {}, now), [])

  const file = join(await mkdtemp(join(tmpdir(), 'mx-rig-sched-')), 'schedule.json')
  const store = await new ScheduleState(file).init()
  await store.record('nightly', '2026-09-16T01:00:00.000Z')
  assert.equal(
    (await new ScheduleState(file).init()).value.nightly.lastFiredAt,
    '2026-09-16T01:00:00.000Z'
  )
})

test('a due orchestration starts a real mission owned by the service account', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'mx-rig-tick-'))
  const runtime = await start(
    {
      MX_RIG_ADMIN_TOKEN: 'test-only-rig-secret',
      MX_RIG_HOST: '127.0.0.1',
      MX_RIG_PORT: '0',
      MX_RIG_STORE: 'memory',
      MX_RIG_STATE_DIR: root,
      MX_RIG_ARTIFACTS_DIR: join(root, 'artifacts')
    },
    // No timer: the tick is driven by hand so the test cannot race it.
    { schedule: false }
  )
  t.after(() => runtime.close())
  const api = async (path, body) => {
    const response = await fetch(runtime.origin + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: 'Bearer test-only-rig-secret',
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const current = (await api('/api/rig/v1/admin/config')).body
  const saved = await api('/api/rig/v1/admin/config', {
    ...current,
    orchestrations: [
      ...current.orchestrations,
      readOnly({ schedule: { cronExpr: '* * * * *', timezone: 'UTC', enabled: true } })
    ]
  })
  assert.equal(saved.status, 200, JSON.stringify(saved.body))
  assert.ok(saved.body.orchestrations.find((entry) => entry.key === 'nightly').nextFireAt)

  const started = await runtime.tick(new Date())
  assert.equal(started.length, 1)
  assert.equal(started[0].mode, 'orchestration')
  assert.equal(started[0].orchestrationKey, 'nightly')
  // Firing is recorded, so an immediately repeated tick does nothing.
  assert.ok(runtime.scheduleState.value.nightly.lastFiredAt)
  assert.deepEqual(await runtime.tick(new Date()), [])

  const id = started[0].id
  for (let i = 0; i < 200; i++) {
    const row = runtime.missions.get(id, 'service-admin')
    if (row.status === 'completed') {
      assert.match(row.result, /在线执行机 0 台/)
      return
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  const row = runtime.missions.get(id, 'service-admin')
  throw new Error(`scheduled mission never completed: ${row.status}`)
})
