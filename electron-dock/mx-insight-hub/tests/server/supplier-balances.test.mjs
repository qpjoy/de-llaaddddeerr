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

// Reuse the notification suite's optional local PostgreSQL/WASM runtime.
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
    for (const file of ['085_admin_notifications.sql', '090_supplier_balance_monitor.sql']) {
      await db.exec(await readFile(new URL(`../../migrations/${file}`, import.meta.url), 'utf8'))
    }
    // Wall-clock times remain in Asia/Shanghai even on a differently zoned DB.
    await db.exec("SET TIME ZONE 'America/Los_Angeles'")
    for (const [input, expected] of [
      ['2026-09-17T01:59:59.999Z', '2026-09-17T02:00:00.000Z'],
      ['2026-09-17T02:00:00.000Z', '2026-09-17T14:00:00.000Z'],
      ['2026-09-17T13:59:59.999Z', '2026-09-17T14:00:00.000Z'],
      ['2026-09-17T14:00:00.000Z', '2026-09-18T02:00:00.000Z'],
      ['2026-12-31T14:00:00.000Z', '2027-01-01T02:00:00.000Z'],
      ['2028-02-28T14:00:00.000Z', '2028-02-29T02:00:00.000Z'],
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
    assert.deepEqual(dto.schedule, { timeZone: 'Asia/Shanghai', times: ['10:00', '22:00'] })
    assert.ok([2, 14].includes(new Date(dto.nextCheckAt).getUTCHours()))
    assert.equal(new Date(dto.nextCheckAt).getUTCMinutes(), 0)
    assert.doesNotMatch(JSON.stringify(dto), /secret-1|credential_scope/)
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
    const failedCalls = calls
    await replica.checkProvider('justone')
    assert.equal(calls, failedCalls, 'failure waits for the next fixed slot')
    fail = false
    amount = '30'
    await check()
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
    await monitor.update('justone', { ...policy, expectedRevision: 1 })
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
