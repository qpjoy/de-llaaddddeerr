import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { advanceDailySpend, dailySpendExceeded, dailySpendWindow } from '../../server/external-platforms/daily-spend.mjs'
import { SupplierBalanceMonitor, balancePolicy } from '../../server/external-platforms/balance-monitor.mjs'
import { BALANCE_INCIDENT_CODE, PROBE_INCIDENT_CODE, DAILY_SPEND_INCIDENT_CODE } from '../../server/notifications-feishu.mjs'

const policy = { enabled: true, warningThreshold: '5', criticalThreshold: '3', expectedRevision: 0 }
const step = (previous, at, balance, dayStartHour = 0) => advanceDailySpend(previous, { at, balance, dayStartHour })

test('daily spending exceeds 30 only above the exact decimal boundary', () => {
  assert.equal(dailySpendExceeded('29.999999999999', '30'), false)
  assert.equal(dailySpendExceeded('30', '30'), false)
  assert.equal(dailySpendExceeded('30.000000000001', '30'), true)
  let state = step(null, '2026-11-18T16:00:00Z', '100')
  state = step(state, '2026-11-18T16:30:00Z', '70')
  assert.equal(dailySpendExceeded(state.amount, '30'), false)
  state = step(state, '2026-11-18T17:00:00Z', '69.999999999999')
  assert.equal(state.amount, '30.000000000001')
  assert.equal(dailySpendExceeded(state.amount, '30'), true)
})

test('daily windows use Beijing midnight or 10am independently of host timezone', () => {
  assert.deepEqual(dailySpendWindow('2026-11-18T15:59:59.999Z'), {
    windowStart: '2026-11-17T16:00:00.000Z', windowEnd: '2026-11-18T16:00:00.000Z',
  })
  assert.deepEqual(dailySpendWindow('2026-11-18T16:00:00Z'), {
    windowStart: '2026-11-18T16:00:00.000Z', windowEnd: '2026-11-19T16:00:00.000Z',
  })
  assert.deepEqual(dailySpendWindow('2026-11-19T01:59:59.999Z', 10), {
    windowStart: '2026-11-18T02:00:00.000Z', windowEnd: '2026-11-19T02:00:00.000Z',
  })
  assert.deepEqual(dailySpendWindow('2026-11-19T02:00:00Z', 10), {
    windowStart: '2026-11-19T02:00:00.000Z', windowEnd: '2026-11-20T02:00:00.000Z',
  })
})

test('recharge preserves earlier decreases and subsequent decreases use the new balance', () => {
  let state = step(null, '2026-11-18T16:00:00Z', '100')
  state = step(state, '2026-11-18T16:30:00Z', '80')
  state = step(state, '2026-11-18T17:00:00Z', '200')
  assert.equal(state.amount, '20.000000000000')
  state = step(state, '2026-11-18T17:30:00Z', '189.9999')
  assert.equal(state.amount, '30.000100000000')
  assert.equal(state.lastBalance, '189.9999')
})

test('the midnight observation closes the preceding day and starts a fresh baseline', () => {
  let state = step(null, '2026-11-18T16:00:00Z', '100')
  state = step(state, '2026-11-19T15:30:00Z', '70')
  state = step(state, '2026-11-19T16:00:00Z', '69')
  assert.equal(state.amount, '0')
  assert.equal(state.partial, false)
  assert.equal(state.previousWindow.amount, '31.000000000000')
  assert.equal(state.previousWindow.windowEnd, state.windowStart)
  assert.equal(state.previousWindow.observedAt, '2026-11-19T16:00:00.000Z')
  state = step(state, '2026-11-19T16:30:00Z', '68')
  assert.equal(state.amount, '1.000000000000')
  assert.equal(state.previousWindow, undefined, 'at most one boundary snapshot survives')
})

test('late initial samples and missing boundaries remain partial without assigning cross-day loss', () => {
  const previous = step(null, '2026-11-18T16:00:00Z', '100')
  let state = step(previous, '2026-11-19T16:05:00.001Z', '20')
  assert.equal(state.partial, true)
  assert.equal(state.previousWindow, undefined)
  assert.equal(state.amount, '0')
  state = step(state, '2026-11-19T16:30:00Z', '10')
  assert.equal(state.partial, true)
  assert.equal(state.amount, '10.000000000000')
  const skippedDay = step(previous, '2026-11-20T16:00:00Z', '10')
  assert.equal(skippedDay.previousWindow, undefined)
  assert.equal(skippedDay.amount, '0')
  const changed = step(previous, '2026-11-19T02:00:00Z', '10', 10)
  assert.equal(changed.amount, '0')
  assert.equal(changed.dayStartHour, 10)
  assert.equal(changed.previousWindow, undefined)
})

test('daily policy validates positive thresholds and only the supported day boundaries', () => {
  for (const hour of [0, 10]) assert.equal(balancePolicy({ ...policy, dailySpendDayStartHour: hour }).dailySpendDayStartHour, hour)
  for (const value of [0, '-1', null, true, '', '1e2', '0.0000000000001']) {
    assert.throws(() => balancePolicy({ ...policy, dailySpendThreshold: value }), { code: 'invalid_balance_policy' })
  }
  for (const value of [1, 24, -1, '10', null]) {
    assert.throws(() => balancePolicy({ ...policy, dailySpendDayStartHour: value }), { code: 'invalid_balance_policy' })
  }
  for (const value of ['true', 1, null]) {
    assert.throws(() => balancePolicy({ ...policy, dailySpendEnabled: value }), { code: 'invalid_balance_policy' })
  }
})

const pgOptions = { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }
async function fixture() {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  await db.exec('CREATE SCHEMA external_platform')
  for (const file of ['085_admin_notifications.sql', '090_supplier_balance_monitor.sql',
    '097_hourly_balance_check.sql', '098_feishu_balance_alerts.sql', '099_balance_feishu_webhook.sql',
    '100_probe_failure_and_recovery_alerts.sql', '108_balance_schedule_and_reminders.sql',
    '109_monitor_cron_schedules.sql', '194_tikhub_daily_spend_alert.sql']) {
    await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
  }
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  let now = '2026-11-18T16:00:00Z', amount = '100', key = 'test-key-1', revision = 1, fail = false, calls = 0
  const credentials = { tikhub: { store: { readCredentialSnapshot: async () => ({ source: 'database', revision, apiKey: key }) } } }
  const fetchers = { tikhub: async () => {
    calls++
    if (fail) throw new Error('test query failure')
    return new Response(JSON.stringify({ code: 200, user_data: { balance: amount } }))
  } }
  const createMonitor = () => new SupplierBalanceMonitor({ pool, credentials, fetchers, now: () => new Date(now).getTime() })
  const monitor = createMonitor()
  return { db, pool, monitor, createMonitor, calls: () => calls,
    rotate() { key = `test-key-${++revision}` },
    async sample(at, balance, failure = false, target = monitor) {
      now = at; amount = balance; fail = failure
      // Keep scheduling/leases on the real DB clock; only the observation's
      // default time is controlled so cross-day accounting is deterministic.
      await db.exec(`ALTER TABLE external_platform.balance_observations ALTER COLUMN observed_at SET DEFAULT '${new Date(at).toISOString()}'::timestamptz`)
      await db.exec("UPDATE external_platform.balance_monitors SET next_check_at=now()-interval '1 minute' WHERE provider_key='tikhub'")
      await target.checkProvider('tikhub')
    },
    async dto(target = monitor) { return (await target.list()).items.find(item => item.provider === 'tikhub') },
    async incidents(code = DAILY_SPEND_INCIDENT_CODE) { return (await db.query('SELECT * FROM notifications.incidents WHERE code=$1 ORDER BY id', [code])).rows },
    async dailyEvents() { return (await db.query("SELECT * FROM notifications.events WHERE kind='daily_spend_observed' ORDER BY id")).rows },
  }
}

test('daily estimates survive restart, use existing reads, merge evidence and keep balance/probe alerts independent', pgOptions, async () => {
  const f = await fixture()
  try {
    await f.sample('2026-11-18T16:00:00Z', '100')
    await f.sample('2026-11-18T16:30:00Z', '70')
    assert.equal((await f.incidents()).length, 0)
    await f.sample('2026-11-18T17:00:00Z', '69.999999999999')
    assert.equal((await f.incidents()).length, 1)
    assert.equal((await f.dto()).dailySpend.amount, '30.000000000001')
    assert.equal(f.calls(), 3, 'daily monitoring adds no supplier request')
    const replica = f.createMonitor()
    assert.equal((await f.dto(replica)).dailySpend.amount, '30.000000000001')
    await replica.checkProvider('tikhub')
    assert.equal(f.calls(), 3, 'restart honors the consumed schedule slot')
    await f.sample('2026-11-18T17:30:00Z', '50', false, replica)
    await f.sample('2026-11-18T18:00:00Z', '200')
    await f.sample('2026-11-18T18:30:00Z', '180')
    assert.equal((await f.dto()).dailySpend.amount, '70.000000000000')
    assert.equal((await f.incidents()).length, 1)
    assert.equal((await f.dailyEvents()).length, 1, 'half-hour samples update one daily evidence event')
    await f.sample('2026-11-18T19:00:00Z', null, true)
    assert.equal((await f.dto()).dailySpend.state, 'stale')
    assert.equal((await f.dto()).dailySpend.amount, '70.000000000000')
    await f.sample('2026-11-18T19:30:00Z', null, true)
    assert.equal((await f.incidents(PROBE_INCIDENT_CODE)).length, 1)
    assert.equal((await f.incidents())[0].status, 'open')
    await f.sample('2026-11-18T20:00:00Z', '2')
    assert.equal((await f.incidents(PROBE_INCIDENT_CODE))[0].status, 'closed')
    assert.equal((await f.incidents(BALANCE_INCIDENT_CODE))[0].severity, 'critical')
    assert.equal((await f.incidents())[0].status, 'open')
    assert.doesNotMatch(JSON.stringify(await f.dto()), /test-key|credential_scope/)
  } finally { await f.db.close() }
})

test('credential rotation followed by failure never attributes the old account balance to the new day estimate', pgOptions, async () => {
  const f = await fixture()
  try {
    await f.sample('2026-11-18T16:00:00Z', '100')
    await f.sample('2026-11-18T16:30:00Z', '60')
    f.rotate()
    assert.equal((await f.dto()).dailySpend.amount, null)
    await f.sample('2026-11-18T17:00:00Z', null, true)
    assert.equal((await f.dto()).dailySpend.amount, null)
    await f.sample('2026-11-18T17:30:00Z', '20')
    assert.equal(Number((await f.dto()).dailySpend.amount), 0)
    assert.equal((await f.dto()).dailySpend.partial, true)
    const old = (await f.incidents())[0]
    assert.equal(old.status, 'closed')
    assert.equal(old.recovered_at, null, 'account rotation is not a refund/recovery')
    await f.sample('2026-11-18T18:00:00Z', '-11')
    assert.equal((await f.dto()).dailySpend.amount, '31.000000000000')
    assert.equal((await f.incidents()).filter(item => item.status === 'open').length, 1)
  } finally { await f.db.close() }
})

test('midnight crossing can first exceed the prior day threshold and the next observation retires it', pgOptions, async () => {
  const f = await fixture()
  try {
    await f.sample('2026-11-18T16:00:00Z', '100')
    await f.sample('2026-11-19T15:30:00Z', '70')
    await f.sample('2026-11-19T16:00:00Z', '69')
    assert.equal(Number((await f.dto()).dailySpend.amount), 0)
    assert.equal((await f.dailyEvents())[0].evidence.amount, '31.000000000000')
    assert.equal((await f.dailyEvents())[0].evidence.windowEnd, '2026-11-19T16:00:00.000Z')
    await f.sample('2026-11-19T16:30:00Z', '68')
    assert.equal((await f.incidents())[0].status, 'closed')
    assert.equal((await f.incidents())[0].recovered_at, null)
    assert.equal((await f.dto()).dailySpend.amount, '1.000000000000')
  } finally { await f.db.close() }
})

test('daily policy uses revision CAS, preserves omitted settings and resets only changed day/pause state', pgOptions, async () => {
  const f = await fixture()
  try {
    await f.sample('2026-11-18T16:00:00Z', '100')
    await f.sample('2026-11-18T16:30:00Z', '60')
    let dto = await f.monitor.update('tikhub', { ...policy, dailySpendThreshold: '50' })
    assert.equal(Number(dto.dailySpend.threshold), 50)
    assert.equal(dto.dailySpend.amount, '40.000000000000')
    assert.equal((await f.incidents())[0].status, 'closed')
    await assert.rejects(f.monitor.update('tikhub', { ...policy, dailySpendDayStartHour: 10 }), { code: 'balance_policy_conflict' })
    assert.equal((await f.dto()).dailySpend.dayStartHour, 0)
    dto = await f.monitor.update('tikhub', { ...policy, expectedRevision: 1 })
    assert.equal(Number(dto.dailySpend.threshold), 50, 'old clients do not overwrite daily configuration')
    assert.equal(dto.dailySpend.amount, '40.000000000000')
    dto = await f.monitor.update('tikhub', { ...policy, expectedRevision: 2, dailySpendDayStartHour: 10 })
    assert.equal(dto.dailySpend.dayStartHour, 10)
    assert.equal(dto.dailySpend.amount, null)
    await f.sample('2026-11-19T02:00:00Z', '60')
    assert.equal((await f.dto()).dailySpend.partial, false)
    dto = await f.monitor.update('tikhub', { ...policy, expectedRevision: 3, dailySpendEnabled: false })
    assert.equal(dto.dailySpend.state, 'paused')
    assert.equal(dto.dailySpend.amount, null)
    await assert.rejects(f.monitor.update('justone', { ...policy, dailySpendEnabled: true }), { code: 'invalid_balance_policy' })
    const justone = (await f.db.query("SELECT * FROM external_platform.balance_monitors WHERE provider_key='justone'")).rows[0]
    assert.equal(justone.daily_spend_enabled, false)
    assert.equal(justone.revision, 0)
  } finally { await f.db.close() }
})

test('retention uses bounded batches and preserves current evidence, manual audit and paid-call incidents', pgOptions, async () => {
  const f = await fixture()
  try {
    await f.db.exec(`INSERT INTO external_platform.balance_observations(id,provider_key,credential_scope,currency,balance,observed_at)
      SELECT md5('old-'||n)::uuid,'tikhub','test','USD',100,now()-interval '100 days' FROM generate_series(1,600) n;
      INSERT INTO external_platform.balance_observations(id,provider_key,credential_scope,currency,balance)
      VALUES (md5('recent')::uuid,'tikhub','test','USD',100);
      INSERT INTO external_platform.balance_monitor_settings_events(provider_key,revision,settings,occurred_at)
      VALUES ('tikhub',0,'{}',now()-interval '100 days')`)
    const insertIncident = async (code, status = 'open') => (await f.db.query(`INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,status,first_occurred_at,last_occurred_at,updated_at)
      VALUES ('supplier.cost','warning','tikhub',$1,$2,'retention test',$3,now()-interval '100 days',now()-interval '100 days',now()-interval '100 days') RETURNING id`,
    [`${code}-${status}`, code, status])).rows[0].id
    const active = await insertIncident(DAILY_SPEND_INCIDENT_CODE)
    const closed = await insertIncident(DAILY_SPEND_INCIDENT_CODE, 'closed')
    const paid = await insertIncident('upstream_balance_exhausted', 'closed')
    await f.db.query(`INSERT INTO notifications.events(incident_id,kind,actor,occurred_at,evidence,balance_observation_id)
      VALUES ($1,'daily_spend_observed','monitor:daily-spend',now()-interval '100 days','{"amount":"40"}',md5('old-1')::uuid),
        ($2,'daily_spend_observed','monitor:daily-spend',now()-interval '100 days','{}',NULL),
        ($3,'observed','collector:justone',now()-interval '100 days','{}',NULL),
        ($1,'acknowledged','admin-token',now()-interval '100 days','{}',NULL),
        ($2,'closed','admin-token',now()-interval '100 days','{}',NULL)`, [active, closed, paid])
    await f.db.query(`WITH expired AS (INSERT INTO notifications.incidents
      (category,severity,source,source_scope,code,title,status,first_occurred_at,last_occurred_at,updated_at)
      SELECT 'supplier.cost','warning','tikhub','expired-'||n,$1,'expired daily history','closed',
        now()-interval '100 days',now()-interval '100 days',now()-interval '100 days'
      FROM generate_series(1,51) n RETURNING id)
      INSERT INTO notifications.events(incident_id,kind,actor,note,occurred_at)
      SELECT id,'closed','admin-token','old handling note',now()-interval '100 days' FROM expired`, [DAILY_SPEND_INCIDENT_CODE])
    await f.monitor.pruneMonitoringHistory()
    assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM external_platform.balance_observations')).rows[0].n, 101)
    assert.equal((await f.incidents()).filter(item => item.status === 'closed').length, 2, 'only 50 expired daily histories are removed per pass')
    await f.monitor.pruneMonitoringHistory()
    assert.equal((await f.db.query('SELECT count(*)::integer AS n FROM external_platform.balance_observations')).rows[0].n, 1)
    assert.equal((await f.incidents()).filter(item => item.status === 'closed').length, 0, 'daily handling notes expire with their incidents')
    const retained = (await f.db.query('SELECT * FROM notifications.events WHERE incident_id=$1 ORDER BY id', [active])).rows
    assert.equal(retained.length, 2)
    assert.equal(retained[0].evidence.amount, '40')
    assert.equal(retained[0].balance_observation_id, null, 'old sample removal retains self-contained incident evidence')
    assert.equal((await f.db.query('SELECT id FROM notifications.incidents WHERE id=$1', [closed])).rows.length, 0)
    assert.equal((await f.db.query('SELECT id FROM notifications.incidents WHERE id=$1', [paid])).rows.length, 1)
    assert.equal((await f.db.query('SELECT id FROM notifications.events WHERE incident_id=$1', [paid])).rows.length, 1)
    assert.equal((await f.db.query('SELECT id FROM external_platform.balance_monitor_settings_events')).rows.length, 1)
  } finally { await f.db.close() }
})
