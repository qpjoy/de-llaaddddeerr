import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { Cron } from 'croner'
import { normalizeMonitorSchedule, scheduleEveryMinutes, scheduleControls, nextMonitorRun, previewMonitorRuns } from '../../shared/monitor-schedule.mjs'
import { MonitorCronTimer } from '../../server/monitor-cron-timer.mjs'
import { SupplierBalanceMonitor, balancePolicy } from '../../server/external-platforms/balance-monitor.mjs'
import { FeishuAlertNotifier } from '../../server/notifications-feishu.mjs'

const cron = expression => ({ mode: 'cron', expression })
const policy = { enabled: true, warningThreshold: '5', criticalThreshold: '3', expectedRevision: 0 }

test('five-field cron validation is bounded and rejects unexecutable dates and seconds', () => {
  assert.deepEqual(normalizeMonitorSchedule(cron('  0 9 * * mon-fri  ')), cron('0 9 * * MON-FRI'))
  for (const input of [null, [], {}, cron('* * * * * *'), cron('@hourly'), cron('60 * * * *'), cron('0 0 31 2 *'), cron('0 0 * * ?'),
    { ...cron('0 * * * *'), timeZone: 'UTC' }, { mode: 'interval', minutes: 0 }, { mode: 'interval', minutes: 1441 }]) {
    assert.throws(() => normalizeMonitorSchedule(input))
    assert.throws(() => balancePolicy({ ...policy, balanceSchedule: input }), { code: 'invalid_monitor_schedule' })
  }
  assert.throws(() => balancePolicy({ ...policy, feishuReminderMinutes: 60, feishuSchedule: cron('0 * * * *') }), { status: 400 })
})

test('simple controls and cron round-trip without misrepresenting nonuniform steps', () => {
  for (const minutes of [1, 2, 5, 10, 15, 20, 30, 60, 120, 180, 240, 360, 720]) {
    const schedule = scheduleEveryMinutes(minutes)
    assert.equal(schedule.mode, 'cron')
    assert.equal(scheduleControls(schedule).minutes, minutes)
    const dates = previewMonitorRuns(schedule, new Date('2026-09-23T00:11:11Z'), 30)
    for (let i = 1; i < dates.length; i++) assert.equal(new Date(dates[i]) - new Date(dates[i - 1]), minutes * 60_000)
  }
  for (const minutes of [7, 45, 90, 100]) {
    const schedule = scheduleEveryMinutes(minutes)
    assert.deepEqual(schedule, { mode: 'interval', minutes })
    const dates = previewMonitorRuns(schedule, new Date('2026-09-23T00:10:00Z'))
    assert.equal(new Date(dates[1]) - new Date(dates[0]), minutes * 60_000)
  }
  assert.deepEqual(scheduleControls(cron('0 9 * * *')), { mode: 'daily', time: '09:00' })
  for (const expression of ['0,30 * * * *', '0/30 * * * *']) assert.deepEqual(scheduleControls(cron(expression)), { mode: 'every', minutes: 30 })
  assert.deepEqual(scheduleControls(cron('0 0,6,12,18 * * *')), { mode: 'every', minutes: 360 })
  assert.equal(scheduleControls(cron('*/45 * * * *')).mode, 'custom')
  assert.deepEqual(previewMonitorRuns(cron('*/45 * * * *'), new Date('2026-09-23T00:10:00Z')),
    ['2026-09-23T00:45:00.000Z', '2026-09-23T01:00:00.000Z', '2026-09-23T01:45:00.000Z'])
})

test('daily, weekly, leap-day and interval schedules preserve Beijing boundaries and phase', () => {
  for (const [expression, after, expected] of [
    ['*/30 * * * *', '2026-09-23T01:29:59.999Z', '2026-09-23T01:30:00.000Z'],
    ['*/30 * * * *', '2026-09-23T01:30:00Z', '2026-09-23T02:00:00.000Z'],
    ['0 9 * * *', '2026-09-23T01:00:00Z', '2026-09-24T01:00:00.000Z'],
    ['0 0 * * *', '2026-12-31T15:59:59Z', '2026-12-31T16:00:00.000Z'],
    ['0 9 * * MON-FRI', '2026-09-25T01:00:00Z', '2026-09-28T01:00:00.000Z'],
    ['0 9 29 2 *', '2026-09-23T01:00:00Z', '2028-02-29T01:00:00.000Z'],
  ]) assert.equal(nextMonitorRun(cron(expression), after).toISOString(), expected)
  assert.equal(nextMonitorRun({ mode: 'interval', minutes: 45 }, '2026-09-23T02:02:00Z', '2026-09-23T00:00:00Z').toISOString(), '2026-09-23T02:15:00.000Z')
})

test('Croner deadline timer re-arms exact stored times, notices policy changes and closes safely', async () => {
  const jobs = [], now = Date.parse('2026-09-23T01:29:50Z')
  let deadline = '2026-09-23T01:30:00Z', runs = 0
  const timer = new MonitorCronTimer({ now: () => now, run: async () => { runs++ }, nextAt: async () => deadline,
    createCron: (pattern, options, callback) => { const job = { pattern, options, callback, stopped: false, stop() { this.stopped = true } }; jobs.push(job); return job } })
  timer.start(); await timer.running
  assert.equal(jobs[0].pattern, '*/30 * * * * *')
  assert.equal(jobs[1].pattern.toISOString(), '2026-09-23T01:30:00.000Z')
  deadline = '2026-09-23T01:45:00.100Z'
  await jobs[0].callback()
  assert.equal(jobs[1].stopped, true)
  assert.equal(jobs[2].pattern.toISOString(), '2026-09-23T01:45:01.000Z')
  deadline = null
  await jobs[2].callback()
  assert.equal(jobs[2].stopped, true)
  await timer.close()
  await timer.refresh()
  assert.equal(runs, 3)
  assert.ok(jobs.every(job => job.stopped))
})

test('Croner Date alarm actually invokes the task at the deadline', async () => {
  const deadline = Math.ceil((Date.now() + 300) / 1000) * 1000
  await new Promise((resolve, reject) => {
    const guard = setTimeout(() => reject(new Error('Croner alarm did not fire')), 4000)
    const job = new Cron(new Date(deadline), () => {
      clearTimeout(guard); job.stop()
      try { assert.ok(Date.now() >= deadline); resolve() } catch (error) { reject(error) }
    })
  })
})

test('durable schedules hot-update, skip missed cron slots, preserve retries and first/escalation alerts',
  { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  let sends = 0, rejectSend = false
  const notifier = new FeishuAlertNotifier({ pool, fetchImpl: async () => { sends++; return new Response(JSON.stringify({ code: rejectSend ? 1 : 0 })) } })
  const monitor = new SupplierBalanceMonitor({ pool })
  try {
    await db.exec('CREATE SCHEMA external_platform')
    for (const file of ['085_admin_notifications.sql','090_supplier_balance_monitor.sql','097_hourly_balance_check.sql','098_feishu_balance_alerts.sql',
      '099_balance_feishu_webhook.sql','100_probe_failure_and_recovery_alerts.sql','108_balance_schedule_and_reminders.sql']) {
      await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
    }
    await db.query("UPDATE external_platform.balance_monitors SET feishu_reminder_minutes=45 WHERE provider_key='justone'")
    const before = (await db.query('SELECT * FROM external_platform.balance_monitors ORDER BY provider_key')).rows
    await db.exec(await readFile(new URL('../../migrations/109_monitor_cron_schedules.sql', import.meta.url), 'utf8'))
    const after = (await db.query('SELECT * FROM external_platform.balance_monitors ORDER BY provider_key')).rows
    for (let i = 0; i < after.length; i++) {
      const { balance_schedule, feishu_schedule, ...preserved } = after[i]
      assert.deepEqual(preserved, before[i])
      assert.deepEqual(balance_schedule, cron('*/30 * * * *'))
      assert.deepEqual(feishu_schedule, { mode: 'interval', minutes: before[i].feishu_reminder_minutes })
    }
    let saved = await monitor.update('tikhub', { ...policy, balanceSchedule: cron('0 9 * * *'), feishuSchedule: cron('0 9,18 * * *') })
    assert.equal(new Date(saved.nextCheckAt).getUTCHours(), 1)
    assert.deepEqual(saved.feishuSchedule, cron('0 9,18 * * *'))
    const justone = (await monitor.list()).items.find(item => item.provider === 'justone')
    assert.deepEqual(justone.feishuSchedule, { mode: 'interval', minutes: 45 })
    await assert.rejects(monitor.update('tikhub', { ...policy, balanceSchedule: cron('invalid') }), { code: 'invalid_monitor_schedule' })
    await assert.rejects(monitor.update('tikhub', policy), { code: 'balance_policy_conflict' })
    const incident = (await db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,first_occurred_at,last_occurred_at)
      VALUES ('supplier.cost','warning','tikhub','test','supplier_balance_low','test',now(),now()) RETURNING id`)).rows[0].id
    const evidence = { balance: '4', currency: 'USD', level: 'warning', warningThreshold: '5', criticalThreshold: '3' }
    await db.query(`INSERT INTO notifications.events(incident_id,kind,actor,evidence,occurred_at)
      VALUES($1,'balance_observed','monitor:balance',$2::jsonb,now())`, [incident, JSON.stringify(evidence)])
    await notifier.deliverBatch()
    assert.equal(sends, 1, 'first alert does not wait for the calendar slot')
    const row = async () => (await db.query('SELECT * FROM notifications.incidents WHERE id=$1', [incident])).rows[0]
    const first = await row()
    assert.equal(new Date(first.next_reminder_at).toISOString(), nextMonitorRun(saved.feishuSchedule, first.notified_at).toISOString())
    await notifier.deliverBatch()
    assert.equal(sends, 1)
    await db.query("UPDATE notifications.incidents SET next_reminder_at=now()-interval '6 minutes' WHERE id=$1", [incident])
    await notifier.deliverBatch()
    assert.equal(sends, 1, 'an old cron slot is skipped after downtime')
    assert.ok(new Date((await row()).next_reminder_at) > new Date())
    await db.query("UPDATE notifications.incidents SET next_reminder_at=now()-interval '1 second' WHERE id=$1", [incident])
    rejectSend = true
    const beforeFailure = await row()
    await notifier.deliverBatch()
    assert.equal(sends, 2)
    assert.deepEqual((await row()).notified_at, beforeFailure.notified_at, 'rejection never consumes the delivery')
    assert.deepEqual((await row()).next_reminder_at, beforeFailure.next_reminder_at)
    rejectSend = false
    await notifier.deliverBatch()
    assert.equal(sends, 3, 'the missed-within-grace delivery retries')
    assert.equal(await notifier.claim(incident), false, 'a replica with stale candidates cannot repeat a send')
    await db.query("UPDATE notifications.incidents SET severity='critical' WHERE id=$1", [incident])
    await notifier.deliverBatch()
    assert.equal(sends, 4, 'critical escalation bypasses the calendar')
    saved = await monitor.update('tikhub', { ...policy, expectedRevision: 1, balanceSchedule: { mode: 'interval', minutes: 45 }, feishuSchedule: cron('0 10 * * *') })
    assert.equal(new Date((await row()).next_reminder_at).getUTCHours(), 2)
    const next = saved.nextCheckAt
    assert.ok(new Date(next) - Date.now() > 44 * 60_000)
    saved = await monitor.update('tikhub', { ...policy, expectedRevision: 2 })
    assert.equal(saved.nextCheckAt, next, 'saving other fields does not shift the interval phase')
    assert.deepEqual(saved.feishuSchedule, cron('0 10 * * *'), 'omitted schedules preserve current settings')
    const reloaded = new SupplierBalanceMonitor({ pool })
    assert.equal((await reloaded.list()).items.find(item => item.provider === 'tikhub').nextCheckAt, next)
  } finally { await db.close() }
})
