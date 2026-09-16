import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { NotificationService, notificationAction, notificationQuery } from '../../server/notifications.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

test('notification inputs reject unsupported filters, forged actors and empty closure reasons', () => {
  assert.equal(notificationQuery().status, 'active')
  for (const input of [{ status: 'deleted' }, { before: '-1' }, { category: 'tenant.balance' }, { token: 'secret' }]) {
    assert.throws(() => notificationQuery(input), { status: 400 })
  }
  for (const input of [null, [], { action: 'close', reason: '' }, { action: 'close', reason: 'done', actor: 'another-user' }]) {
    assert.throws(() => notificationAction(input), { status: 400 })
  }
  assert.deepEqual(notificationAction({ action: 'close', reason: ' checked ' }), { action: 'close', reason: 'checked' })
})

test('notification collection is optional, isolated from availability, and single-flight', async () => {
  const disabled = new NotificationService(null)
  disabled.start()
  assert.equal((await disabled.list({})).available, false)
  await disabled.close()
  let calls = 0
  let release
  const service = new NotificationService({}, { logger: { warn() {} } })
  service.collectBatch = async () => { calls++; await new Promise(resolve => { release = resolve }); throw Error('database unavailable') }
  const first = service.collect()
  assert.equal(service.collect(), first)
  release()
  await first
  assert.equal(calls, 1)
  assert.equal(service.collection.state, 'error')
})

test('notifications are Admin-token-only and never invoke upstream or Launcher for Admin calls', async () => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'notification-test-pepper-at-least-32-bytes' })
  let reads = 0
  let writes = 0
  const notifications = {
    list: async () => { reads++; return { items: [] } },
    detail: async () => { reads++; return { incident: {} } },
    act: async () => { writes++; return {} },
  }
  const identity = { enabled: true, resolve: async () => ({ kind: 'launcher-session', platformAdmin: true, capabilities: ['membership.write', 'usage.read'] }) }
  const server = createServer(createApp({ service, store, adminToken: 'notification-test-admin', notifications, identity }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}/internal/v1/admin/notifications`
  try {
    for (const credential of [null, 'mih_live_not-an-admin', 'launcher-session']) {
      for (const [path, method] of [['', 'GET'], ['/1', 'GET'], ['/1/actions', 'POST']]) {
        const response = await fetch(base + path, { method, headers: credential ? { 'x-mx-insight-admin-token': credential } : {}, ...(method === 'POST' ? { body: '{}' } : {}) })
        assert.ok([401, 403].includes(response.status))
      }
    }
    assert.equal(reads, 0); assert.equal(writes, 0)
    const headers = { 'x-mx-insight-admin-token': 'notification-test-admin' }
    assert.equal((await fetch(base, { headers })).status, 200)
    assert.equal((await fetch(base + '/1', { headers })).status, 200)
    assert.equal((await fetch(base + '/1/actions', { headers, method: 'POST', body: '{"action":"close","reason":"reviewed"}' })).status, 200)
    assert.equal(reads, 2); assert.equal(writes, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

// Optional embedded PostgreSQL, installed only in an isolated QA directory.
// Set MX_NOTIFICATION_PGLITE_MODULE to its absolute dist/index.js to exercise
// the real migration and SQL without a production database or project dependency.
test('notification PostgreSQL persistence, deduplication, categories, history and lifecycle', { skip: !process.env.MX_NOTIFICATION_PGLITE_MODULE }, async () => {
  const { PGlite } = await import(process.env.MX_NOTIFICATION_PGLITE_MODULE)
  const db = new PGlite()
  const pool = { query: (...args) => db.query(...args), connect: async () => ({ query: (...args) => db.query(...args), release() {} }) }
  try {
    await db.exec(`CREATE SCHEMA external_platform; CREATE TABLE external_platform.provider_calls (
      id uuid PRIMARY KEY, usage_request_id uuid, provider_key text, provider_credential_revision bigint,
      marketplace text, error_code text, started_at timestamptz, completed_at timestamptz)`)
    await db.exec(await readFile(new URL('../../migrations/085_admin_notifications.sql', import.meta.url), 'utf8'))
    const insert = async (code = 'upstream_balance_exhausted', revision = 1, daysAgo = 0) => {
      const id = randomUUID()
      await db.query(`INSERT INTO external_platform.provider_calls VALUES ($1,$2,'justone',$3,'jd',$4,
        now() - make_interval(days => $5), now() - make_interval(days => $5))`, [id, randomUUID(), revision, code, daysAgo])
      return id
    }
    const service = new NotificationService(pool)
    const firstCall = await insert()
    await insert()
    await insert('upstream_token_limit_exceeded')
    await insert('upstream_balance_exhausted', 2)
    await insert('upstream_transport_error')
    await insert('upstream_balance_exhausted', 1, 8)
    await service.collectBatch()
    let list = await service.list({})
    assert.equal(list.items.length, 3)
    const balance = list.items.find(item => item.category === 'upstream.balance' && item.source_scope === 'credential:1')
    assert.equal(Number(balance.occurrence_count), 2)
    await new NotificationService(pool).collectBatch()
    assert.equal(Number((await service.detail(balance.id)).incident.occurrence_count), 2)
    const detail = await service.detail(balance.id)
    assert.equal(detail.events.length, 2)
    assert.ok(detail.events.some(event => event.source_event_id === firstCall))
    await service.act(balance.id, { action: 'acknowledge', reason: '核对供应商账户' })
    await service.act(balance.id, { action: 'acknowledge', reason: '重试' })
    assert.equal((await service.detail(balance.id)).events.length, 3)
    await insert()
    await service.collectBatch()
    assert.equal((await service.detail(balance.id)).incident.status, 'acknowledged')
    await service.act(balance.id, { action: 'close', reason: '人工核查完成，未宣称余额恢复' })
    await service.act(balance.id, { action: 'close', reason: '重试' })
    await assert.rejects(service.act(balance.id, { action: 'acknowledge', reason: 'invalid' }), { status: 409 })
    assert.equal((await service.list({ status: 'closed' })).items.length, 1)
    await insert()
    await service.collectBatch()
    list = await service.list({ category: 'upstream.balance' })
    assert.equal(list.items.length, 2)
    assert.ok(list.items.every(item => String(item.id) !== String(balance.id)))
    const events = (await service.detail(balance.id)).events
    assert.equal(events.length, 5)
    assert.equal(events[0].actor, 'admin-token')
    assert.equal(events[0].kind, 'closed')
    assert.equal((await service.list({ before: '1', status: 'all' })).items.length, 0)
    await assert.rejects(service.detail('9999'), { status: 404 })
  } finally { await db.close() }
})
