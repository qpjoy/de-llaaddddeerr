import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { balanceLevel, decimalAmount, queryProviderBalance } from '../../server/external-platforms/balance-adapters.mjs'
import { SupplierBalanceMonitor, balancePolicy } from '../../server/external-platforms/balance-monitor.mjs'
import { NotificationService, notificationQuery } from '../../server/notifications.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const envelope = balance => new Response(JSON.stringify({ code: 0, data: { balance, currency: 'CNY' } }))
const policy = { enabled: true, warningThreshold: '30', criticalThreshold: '20', expectedRevision: 0 }

test('native currency thresholds are strict and preserve decimal boundaries', () => {
  for (const [value, expected] of [['30', 'healthy'], ['29.999999999999', 'warning'], ['20', 'warning'], ['19.999999999999', 'critical'], ['0', 'critical'], ['-0.1', 'critical']]) {
    assert.equal(balanceLevel(value, '30', '20'), expected)
  }
  for (const value of [null, true, NaN, Infinity, '', '1e99', {}, '0.0000000000001']) assert.throws(() => decimalAmount(value))
  assert.equal(notificationQuery({ category: 'supplier.cost' }).category, 'supplier.cost')
  assert.equal(balancePolicy(policy).warningThreshold, '30')
  for (const minutes of [1, 30, 60, 1440]) assert.equal(balancePolicy({ ...policy, feishuReminderMinutes: minutes }).feishuReminderMinutes, minutes)
  for (const minutes of [0, -1, 1441, 1.5, '30', null, true]) {
    assert.throws(() => balancePolicy({ ...policy, feishuReminderMinutes: minutes }), { status: 400 })
  }
  for (const body of [null, { ...policy, warningThreshold: '20' }, { ...policy, criticalThreshold: '-1' }, { ...policy, intervalMinutes: 1 }, { ...policy, url: 'https://evil.invalid' }, { ...policy, actor: 'owner' }]) {
    assert.throws(() => balancePolicy(body), { status: 400 })
  }
})

test('balance adapters use pinned endpoints, original currency and only the cash field', async () => {
  let calls = 0
  assert.deepEqual(await queryProviderBalance('justone', 'query-secret', { fetchImpl: async (url, options) => {
    const target = new URL(url)
    assert.equal(target.origin + target.pathname, 'https://api.justoneapi.com/user/get-balance')
    assert.equal(target.searchParams.get('token'), 'query-secret')
    assert.equal(options.redirect, 'error')
    calls++
    return envelope('75.0000')
  } }), { balance: '75.0000', currency: 'CNY' })
  assert.deepEqual(await queryProviderBalance('tikhub', 'bearer-secret', { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api.tikhub.io/api/v1/tikhub/user/get_user_info')
    assert.equal(options.headers.Authorization, 'Bearer bearer-secret')
    assert.equal(new URL(url).search, '')
    calls++
    return new Response(JSON.stringify({ code: 200, user_data: { balance: '2.25', free_credit: 999999 } }))
  } }), { balance: '2.25', currency: 'USD' })
  assert.equal(calls, 2)
})

test('query failures never become zero and credentials never enter errors', async () => {
  const responses = [
    () => new Response('query-secret', { status: 403 }),
    () => new Response('not-json query-secret'),
    () => new Response(JSON.stringify({ code: 601, message: 'query-secret' })),
    () => new Response(JSON.stringify({ code: 0, data: { balance: '20', currency: 'USD' } })),
    () => envelope(null),
    () => envelope(true),
    () => new Response('a'.repeat(65_537)),
    () => { throw Error('failed https://api.justoneapi.com/user/get-balance?token=query-secret') },
  ]
  for (const response of responses) await assert.rejects(
    queryProviderBalance('justone', 'query-secret', { fetchImpl: async () => response() }),
    error => { assert.doesNotMatch(error.message, /query-secret/); return true },
  )
  let called = false
  await assert.rejects(queryProviderBalance('tikhub', '', { fetchImpl: () => { called = true } }), { code: 'balance_credential_missing' })
  assert.equal(called, false)
})

test('balance APIs are Admin-only and cache reads never schedule a supplier call', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'balance-test-pepper-at-least-32-bytes' })
  let reads = 0
  let writes = 0
  const monitor = { list: async () => { reads++; return { items: [] } }, update: async () => { writes++; return {} }, collect: () => { throw Error('unexpected probe') } }
  const server = createServer(createApp({ store, service, adminToken: 'balance-test', balanceMonitor: monitor }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${server.address().port}/internal/v1/admin/supplier-balances`
  try {
    assert.equal((await fetch(url)).status, 401)
    assert.equal((await fetch(url, { headers: { 'x-mx-insight-admin-token': 'wrong' } })).status, 401)
    const headers = { 'x-mx-insight-admin-token': 'balance-test', 'Content-Type': 'application/json' }
    assert.equal((await fetch(url, { headers })).status, 200)
    assert.equal((await fetch(`${url}?refresh=true`, { headers })).status, 400)
    assert.equal((await fetch(`${url}/justone`, { headers, method: 'PUT', body: JSON.stringify(policy) })).status, 200)
    assert.equal(reads, 1)
    assert.equal(writes, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('monitor without PostgreSQL is unavailable and never starts polling', async () => {
  const monitor = new SupplierBalanceMonitor({ pool: null })
  monitor.start()
  assert.equal(monitor.timer, null)
  assert.deepEqual(await monitor.list(), { available: false, items: [] })
  await monitor.close()
})

test('webhook reveal requires both Admin authentication and explicit reauthentication, with no cache', async () => {
  let reads = 0
  const secret = 'https://open.feishu.cn/open-apis/bot/v2/hook/test-only-secret'
  const appOptions = {
    service: {}, store: { ping: async () => true }, adminToken: 'test-admin',
    balanceMonitor: { revealWebhook: async provider => { reads++; return { provider, feishuWebhook: secret } } },
    identity: { enabled: true, resolve: async () => ({ kind: 'launcher-user', memberId: 'test', platformAdmin: true, tenantIds: null, capabilities: [], memberships: [] }) },
    logger: { error() {}, warn() {} },
  }
  for (const listenerMode of ['combined', 'public']) {
    const server = createServer(createApp({ ...appOptions, listenerMode }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/internal/v1/admin/supplier-balances/justone/feishu-webhook/reveal`
    const headers = { 'Content-Type': 'application/json', 'x-mx-insight-admin-token': 'test-admin' }
    const post = (body, override = headers, target = url) => fetch(target, { method: 'POST', headers: override, body: JSON.stringify(body) })
    try {
      if (listenerMode === 'public') {
        assert.equal((await post({ adminToken: 'test-admin' })).status, 404)
        continue
      }
      assert.equal((await post({ adminToken: 'test-admin' }, { 'Content-Type': 'application/json' })).status, 401)
      assert.equal((await post({ adminToken: 'test-admin' }, { 'Content-Type': 'application/json', authorization: 'Bearer launcher-admin' })).status, 403)
      for (const body of [{}, { adminToken: 'wrong' }, { adminToken: 123 }]) assert.equal((await post(body)).status, 403)
      for (const body of [null, [], { adminToken: 'test-admin', extra: secret }]) {
        const response = await post(body)
        assert.equal(response.status, 400)
        assert.ok(!(await response.text()).includes(secret))
      }
      assert.equal((await post({ adminToken: 'test-admin' }, headers, `${url}?adminToken=test-admin`)).status, 400)
      assert.equal(reads, 0, 'denied reads never reach secret storage')
      const response = await post({ adminToken: 'test-admin' })
      assert.equal(response.status, 200)
      assert.match(response.headers.get('cache-control'), /no-store/)
      assert.deepEqual((await response.json()).data, { provider: 'justone', feishuWebhook: secret })
    } finally { await new Promise(resolve => server.close(resolve)) }
  }
  assert.equal(reads, 1)
})

// Reuse the notification suite's optional local PostgreSQL/WASM runtime.
test('half-hour migration preserves operator policy, due slots, observations and in-flight leases', { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  try {
    await db.exec('CREATE SCHEMA external_platform')
    for (const file of ['085_admin_notifications.sql', '090_supplier_balance_monitor.sql', '097_hourly_balance_check.sql', '099_balance_feishu_webhook.sql']) {
      await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
    }
    await db.exec(`UPDATE external_platform.balance_monitors SET enabled=false,warning_threshold=42,critical_threshold=7,
      revision=9,feishu_webhook='https://open.feishu.cn/open-apis/bot/v2/hook/test-policy',last_balance=21,
      next_check_at=now()+interval '2 hours' WHERE provider_key='justone';
      UPDATE external_platform.balance_monitors SET next_check_at=now()-interval '1 minute',
        lease_token='00000000-0000-4000-8000-000000000001',lease_until=now()+interval '2 minutes' WHERE provider_key='tikhub'`)
    const before = (await db.query('SELECT * FROM external_platform.balance_monitors ORDER BY provider_key')).rows
    await db.exec(await readFile(new URL('../../migrations/108_balance_schedule_and_reminders.sql', import.meta.url), 'utf8'))
    const after = (await db.query('SELECT * FROM external_platform.balance_monitors ORDER BY provider_key')).rows
    for (let i = 0; i < before.length; i++) {
      const { next_check_at: oldNext, ...oldPolicy } = before[i]
      const { next_check_at: next, feishu_reminder_minutes: reminder, ...newPolicy } = after[i]
      assert.deepEqual(newPolicy, oldPolicy)
      assert.equal(reminder, 60)
      if (newPolicy.provider_key === 'justone') {
        assert.ok(new Date(next) < new Date(oldNext))
        assert.ok([0, 30].includes(new Date(next).getUTCMinutes()))
      } else assert.equal(new Date(next).toISOString(), new Date(oldNext).toISOString())
    }
  } finally { await db.close() }
})

test('durable balance polling, alerts, recovery, leases, policy audit and credential rotation', { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  let key = 'secret-1'
  let revision = 1
  let amount = '25'
  let fail = false
  let calls = 0
  const credentials = { justone: { store: { readCredentialSnapshot: async () => ({ source: 'database', revision, apiKey: key }) } } }
  const fetchers = { justone: async () => { calls++; if (fail) throw Error(key); return envelope(amount) } }
  const monitor = new SupplierBalanceMonitor({ pool, credentials, fetchers })
  const notices = new NotificationService(pool)
  const due = async () => db.exec("UPDATE external_platform.balance_monitors SET next_check_at=now()-interval '1 minute' WHERE provider_key='justone'")
  const check = async () => { await due(); await monitor.checkProvider('justone') }
  try {
    await db.exec('CREATE SCHEMA external_platform')
    for (const file of ['085_admin_notifications.sql', '090_supplier_balance_monitor.sql',
      '097_hourly_balance_check.sql', '098_feishu_balance_alerts.sql', '099_balance_feishu_webhook.sql',
      '100_probe_failure_and_recovery_alerts.sql', '108_balance_schedule_and_reminders.sql', '109_monitor_cron_schedules.sql']) {
      await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
    }
    // 097 lowers the JustOne seed to 5/3; this case exercises threshold
    // behaviour itself, so pin the policy it asserts against, revision intact.
    await db.exec("UPDATE external_platform.balance_monitors SET warning_threshold=30, critical_threshold=20 WHERE provider_key='justone'")
    // Half-hour slots remain in Asia/Shanghai even on a differently zoned DB.
    await db.exec("SET TIME ZONE 'America/Los_Angeles'")
    for (const [input, expected] of [
      ['2026-09-17T01:59:59.999Z', '2026-09-17T02:00:00.000Z'],
      ['2026-09-17T02:00:00.000Z', '2026-09-17T02:30:00.000Z'],
      ['2026-09-17T02:29:59.999Z', '2026-09-17T02:30:00.000Z'],
      ['2026-09-17T02:30:00.000Z', '2026-09-17T03:00:00.000Z'],
      ['2026-09-17T13:59:59.999Z', '2026-09-17T14:00:00.000Z'],
      ['2026-09-17T14:00:00.000Z', '2026-09-17T14:30:00.000Z'],
      ['2026-12-31T15:59:59.999Z', '2026-12-31T16:00:00.000Z'],
      ['2028-02-28T15:59:59.999Z', '2028-02-28T16:00:00.000Z'],
    ]) {
      const next = (await db.query('SELECT external_platform.next_balance_check($1::timestamptz) AS next', [input])).rows[0].next
      assert.equal(new Date(next).toISOString(), expected)
    }
    await monitor.checkProvider('justone')
    assert.equal(calls, 0, 'initial startup waits for the next fixed slot')
    await db.exec("UPDATE external_platform.balance_monitors SET next_check_at=now()-interval '1 hour' WHERE provider_key='justone'")
    await monitor.checkProvider('justone')
    assert.equal(calls, 0, 'missed slots are not replayed after downtime')
    await check()
    let items = (await notices.list({ category: 'supplier.cost' })).items
    assert.equal(items.length, 1)
    const incidentId = items[0].id
    assert.equal(items[0].severity, 'warning')
    let dto = (await monitor.list()).items.find(item => item.provider === 'justone')
    assert.equal(dto.state, 'ready')
    assert.equal(Number(dto.balance), 25)
    assert.deepEqual(dto.schedule, { timeZone: 'Asia/Shanghai', mode: 'cron', expression: '*/30 * * * *' })
    assert.equal(dto.feishuReminderMinutes, 60)
    const nextCheck = new Date(dto.nextCheckAt)
    assert.ok([0, 30].includes(nextCheck.getUTCMinutes()))
    assert.equal(nextCheck.getUTCSeconds(), 0)
    assert.ok(nextCheck > new Date() && nextCheck - Date.now() <= 30 * 60 * 1000, 'the next slot is within half an hour')
    assert.doesNotMatch(JSON.stringify(dto), /secret-1|credential_scope/)
    // The seeded bot hook is policy, but it is still a credential: the DTO says
    // only that one is set, plus a tail short enough to tell two bots apart.
    assert.equal(dto.feishu.configured, true)
    assert.equal(dto.feishu.hint, '…0c2fb1')
    assert.doesNotMatch(JSON.stringify(dto), /open\.feishu\.cn|1790e6fa/, 'the hook never leaves the service')
    const replica = new SupplierBalanceMonitor({ pool, credentials, fetchers })
    await replica.checkProvider('justone')
    assert.equal(calls, 1, 'restart respects the persisted next check')
    await check()
    assert.equal((await notices.list({})).items.length, 1, 'repeat observations merge')
    await notices.act(incidentId, { action: 'acknowledge', reason: '已接手' })
    amount = '19.99'
    await check()
    let detail = await notices.detail(incidentId)
    assert.equal(detail.incident.severity, 'critical')
    assert.equal(detail.incident.status, 'open', 'escalation needs renewed attention')
    assert.equal(detail.events[0].evidence.currency, 'CNY')
    fail = true
    await check()
    dto = (await monitor.list()).items.find(item => item.provider === 'justone')
    assert.equal(Number(dto.balance), 19.99)
    assert.equal(dto.state, 'stale')
    assert.equal((await notices.detail(incidentId)).incident.status, 'open', 'failure is not recovery')
    // One failed probe can be a blip and stays quiet; a second in a row means
    // the monitor is blind, which is itself worth waking someone for.
    const unreadable = async () => (await db.query(
      "SELECT * FROM notifications.incidents WHERE code='supplier_balance_unreadable' ORDER BY id")).rows
    assert.equal((await unreadable()).length, 0, 'a single failed probe is not an incident')
    await check()
    let blind = await unreadable()
    assert.equal(blind.length, 1, 'two consecutive failures open an unreadable incident')
    assert.equal(blind[0].severity, 'warning')
    assert.equal(blind[0].source, 'justone')
    assert.match(blind[0].title, /查询失败/)
    const blindEvents = await notices.detail(blind[0].id)
    assert.equal(blindEvents.events[0].kind, 'probe_failed')
    assert.equal(blindEvents.events[0].evidence.errorCode, 'balance_network_error')
    assert.doesNotMatch(JSON.stringify(blindEvents.events), /secret-1/, 'a failure never carries the credential')
    await check()
    blind = await unreadable()
    assert.equal(blind.length, 1, 'further failures merge into the open incident')
    assert.equal(Number(blind[0].occurrence_count), 2)
    const failedCalls = calls
    await replica.checkProvider('justone')
    assert.equal(calls, failedCalls, 'failure waits for the next fixed slot')
    fail = false
    amount = '30'
    await check()
    blind = await unreadable()
    assert.equal(blind[0].status, 'closed', 'a successful read closes the unreadable incident')
    assert.ok(blind[0].recovered_at, 'closure records a recovery time so it can be announced')
    assert.equal((await notices.detail(blind[0].id)).events[0].kind, 'probe_recovered')
    detail = await notices.detail(incidentId)
    assert.equal(detail.incident.status, 'closed')
    assert.ok(detail.incident.recovered_at)
    assert.equal(detail.events[0].kind, 'balance_recovered')
    amount = '10'
    await check()
    items = (await notices.list({})).items
    assert.equal(items.length, 1)
    assert.notEqual(items[0].id, incidentId)
    await notices.act(items[0].id, { action: 'close', reason: '人工处理' })
    assert.equal((await notices.detail(items[0].id)).incident.recovered_at, null)
    await check()
    assert.equal((await notices.list({})).items.length, 1, 'persistent low balance reopens as a new incident')
    key = 'secret-2'; revision++
    assert.equal((await monitor.list()).items.find(item => item.provider === 'justone').balance, null)
    fail = true
    await check()
    dto = (await monitor.list()).items.find(item => item.provider === 'justone')
    assert.equal(dto.balance, null, 'old account balance must not survive a failed new-account probe')
    assert.equal(dto.state, 'error')
    fail = false
    await monitor.update('justone', { ...policy, enabled: false })
    const before = calls
    await check()
    assert.equal(calls, before, 'paused schedules do not probe')
    await assert.rejects(monitor.update('justone', policy), { status: 409 })
    assert.equal((await db.query('SELECT actor FROM external_platform.balance_monitor_settings_events')).rows[0].actor, 'admin-token')
    // Saving thresholds without naming the hook must not disturb it; an explicit
    // value replaces it and an explicit empty string stops notifying that group.
    const storedHook = async () => (await db.query(
      "SELECT feishu_webhook FROM external_platform.balance_monitors WHERE provider_key='justone'")).rows[0].feishu_webhook
    const seededHook = await storedHook()
    assert.ok(seededHook)
    await monitor.update('justone', { ...policy, expectedRevision: 1 })
    assert.equal(await storedHook(), seededHook, 'an ordinary save leaves the hook alone')
    for (const bad of ['http://open.feishu.cn/open-apis/bot/v2/hook/x', 'https://evil.invalid/x', 'https://open.feishu.cn/open-apis/bot/v2/hook/x?y=1']) {
      await assert.rejects(monitor.update('justone', { ...policy, expectedRevision: 2, feishuWebhook: bad }),
        { status: 400, code: 'invalid_feishu_webhook' })
    }
    assert.equal(await storedHook(), seededHook, 'a rejected hook never reaches the row')
    const replacement = 'https://open.feishu.cn/open-apis/bot/v2/hook/11111111-2222-3333-4444-555555555555'
    let saved = await monitor.update('justone', { ...policy, expectedRevision: 2, feishuWebhook: replacement, feishuReminderMinutes: 30 })
    assert.equal(await storedHook(), replacement)
    assert.equal(saved.feishu.hint, '…555555')
    assert.equal(saved.feishuReminderMinutes, 30)
    assert.equal((await monitor.list()).items.find(item => item.provider === 'tikhub').feishuReminderMinutes, 60, 'provider policies are independent')
    assert.deepEqual(await monitor.revealWebhook('justone'), { provider: 'justone', feishuWebhook: replacement })
    await assert.rejects(monitor.revealWebhook('unknown'), { status: 404 })
    saved = await monitor.update('justone', { ...policy, expectedRevision: 3, feishuWebhook: '' })
    assert.equal(saved.feishuReminderMinutes, 30, 'older clients preserve the configured interval when omitting it')
    assert.equal(await storedHook(), null, 'an explicit empty value clears the hook')
    await assert.rejects(monitor.revealWebhook('justone'), { code: 'feishu_webhook_unconfigured' })
    assert.deepEqual(saved.feishu, { configured: false, hint: null })
    const audit = JSON.stringify((await db.query('SELECT settings FROM external_platform.balance_monitor_settings_events')).rows)
    assert.doesNotMatch(audit, /open\.feishu\.cn|11111111/, 'the audit trail records what changed, not the hook')
    assert.match(audit, /"feishuWebhook":"unchanged"/)
    assert.match(audit, /"feishuWebhook":"cleared"/)
    assert.match(audit, /"action":"feishu_webhook_revealed"/)
    // Restore the seeded hook and the revision the rest of this case expects.
    await db.exec(`UPDATE external_platform.balance_monitors SET feishu_webhook='${seededHook}', revision=2 WHERE provider_key='justone'`)
    await monitor.checkProvider('justone')
    assert.equal(calls, before, 'saving/enabling does not add an off-schedule call')
    await due()
    let release
    const delayed = new SupplierBalanceMonitor({ pool, credentials, fetchers: { justone: async () => { calls++; await new Promise(resolve => { release = resolve }); return envelope('1') } } })
    const pending = delayed.checkProvider('justone')
    while (!release) await new Promise(resolve => setTimeout(resolve, 1))
    const inFlightCalls = calls
    await replica.checkProvider('justone')
    assert.equal(calls, inFlightCalls, 'only one replica consumes a due slot')
    await db.exec("UPDATE external_platform.balance_monitors SET lease_until=now()-interval '1 second' WHERE provider_key='justone'")
    await replica.checkProvider('justone')
    assert.equal(calls, inFlightCalls, 'a consumed slot cannot run again even after a lease expires')
    await db.exec("UPDATE external_platform.balance_monitors SET lease_until=now()+interval '2 minutes' WHERE provider_key='justone'")
    await monitor.update('justone', { ...policy, enabled: false, expectedRevision: 2 })
    release()
    await pending
    assert.equal((await monitor.list()).items.find(item => item.provider === 'justone').balance, null, 'settings invalidate in-flight results')
  } finally { await db.close() }
})
