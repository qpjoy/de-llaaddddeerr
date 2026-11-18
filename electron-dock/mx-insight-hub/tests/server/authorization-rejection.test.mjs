import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { AUTHORIZATION_REJECTION_PLATFORMS, assertSearchPlatformGranted,
  authorizationRejectionEvidence, normalizeAuthorizationRejection,
  recordAuthorizationRejection } from '../../server/core/authorization-rejection.mjs'

const uuid = 'ab00ef17-1e2e-4085-8254-eb6a13729966'
const context = () => ({ tenant: { id: randomUUID() }, consumer: { id: randomUUID() },
  apiKey: { id: randomUUID(), scopeMode: 'snapshot' } })
const record = (overrides = {}) => {
  const owner = context()
  return { eventId: randomUUID(), requestId: uuid, requestIdSource: 'client',
    tenantId: owner.tenant.id, consumerId: owner.consumer.id, apiKeyId: owner.apiKey.id,
    platform: 'tieba', scopeMode: 'snapshot', errorCode: 'platform_not_granted', httpStatus: 403, ...overrides }
}

test('only explicit pre-reservation platform checks create private, closed evidence', () => {
  const owner = context()
  assert.equal(assertSearchPlatformGranted(true, owner, 'tieba'), undefined)
  let error
  try { assertSearchPlatformGranted(false, owner, 'tieba') } catch (caught) { error = caught }
  assert.equal(error.status, 403)
  assert.equal(error.message, 'Platform is not granted')
  assert.deepEqual(authorizationRejectionEvidence(error), { tenantId: owner.tenant.id, consumerId: owner.consumer.id,
    apiKeyId: owner.apiKey.id, platform: 'tieba', scopeMode: 'snapshot', routePath: null })
  assert.equal(error.details, undefined)
  assert.doesNotMatch(JSON.stringify(error), new RegExp(owner.apiKey.id))
  const forged = Object.assign(new AppError(403, 'platform_not_granted', 'Platform is not granted'), {
    authorizationRejection: authorizationRejectionEvidence(error) })
  assert.equal(authorizationRejectionEvidence(forged), null)
  assert.throws(() => assertSearchPlatformGranted(false, owner, 'arbitrary-private-platform'), caught =>
    caught.code === 'platform_not_granted' && authorizationRejectionEvidence(caught) === null)
  const normalized = normalizeAuthorizationRejection({ ...record(), body: 'PRIVATE', headers: 'PRIVATE' })
  assert.doesNotMatch(JSON.stringify(normalized), /PRIVATE/)
  for (const changes of [{ requestId: 'bad request id' }, { requestId: 'x'.repeat(192) }, { eventId: 'bad' },
    { requestIdSource: 'unknown' }, { platform: 'private-input' }, { errorCode: 'internal_error' },
    { httpStatus: 200 }, { scopeMode: 'other' }]) assert.throws(() => normalizeAuthorizationRejection(record(changes)), TypeError)
})

async function fixture(t, { writerFails = false } = {}) {
  const store = new MemoryStore(), logs = [], service = new HubService({ store, apiKeyPepper: 'rejection-test-pepper' })
  const tenant = await service.createTenant({ name: 'Rejection tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Rejection caller' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'twitter', maxRequests: 100,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Rejection key', platforms: ['twitter'], capabilities: [] })
  let reservations = 0, calls = 0
  store.reserve = async () => { reservations++; throw new Error('must not reserve') }
  const adapter = { async search() { calls++; throw new Error('must not dispatch') } }
  if (writerFails) store.recordAuthorizationRejection = async () => { throw new Error('PRIVATE database credential') }
  const server = createServer(createApp({ service, store, adapter, listenerMode: 'public', adminToken: 'rejection-admin',
    logger: { warn: value => logs.push(value), error: value => logs.push(value) } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const send = async (path, body, extra = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
      headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json',
        'idempotency-key': `rejection-${randomUUID()}`, ...extra }, body: JSON.stringify(body) })
    return { status: response.status, body: await response.json() }
  }
  return { store, service, key, tenant, consumer, send, logs, count: () => ({ reservations, calls }) }
}

test('real public search 403 is diagnosable without usage, supplier calls or altered response fields', async t => {
  const f = await fixture(t)
  const output = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'PRIVATE search text', pageSize: 20 }, { 'x-request-id': uuid })
  assert.deepEqual(output, { status: 403, body: { error: { code: 'platform_not_granted', message: 'Platform is not granted' }, requestId: uuid } })
  const saved = [...f.store.authorizationRejections.values()]
  assert.equal(saved.length, 1)
  assert.equal(saved[0].requestId, uuid)
  assert.equal(saved[0].requestIdSource, 'client')
  assert.equal(saved[0].platform, 'tieba')
  assert.equal(saved[0].routePath, '/api/v1/data/search')
  assert.equal(saved[0].apiKeyId, f.key.id)
  assert.deepEqual(f.count(), { reservations: 0, calls: 0 })
  assert.equal(f.store.requests.size, 0)
  assert.equal(f.store.customerCharges.size, 0)
  assert.doesNotMatch(JSON.stringify({ saved, logs: f.logs }), /PRIVATE|Bearer|mih_live_/)
  assert.equal(f.logs[0].event, 'hub_authorization_rejected')
})

test('snapshot intersection, compatibility search and v2 retain original authorization priority', async t => {
  const f = await fixture(t)
  await f.store.setPlatformGrant(f.consumer.id, 'tieba', true)
  // The old snapshot still lacks tieba; a consumer-only grant is insufficient.
  const first = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' })
  assert.equal(first.status, 403)
  assert.equal([...f.store.authorizationRejections.values()][0].requestId, first.body.requestId)
  assert.equal([...f.store.authorizationRejections.values()][0].requestIdSource, 'server')
  const second = await f.send('/api/v1/night-all/search/raw', { platform: 'tieba', query: 'q' })
  assert.equal(second.status, 403)
  await f.store.setPlatformGrant(f.consumer.id, 'twitter', false)
  const third = await f.send('/api/v2/data/search', { platform: 'twitter', query: 'q', pageSize: 20,
    timeWindow: { from: '2026-11-16T00:00:00Z', to: '2026-11-17T00:00:00Z', timezone: 'UTC', boundary: '[from,to)' } })
  assert.equal(third.status, 403)
  assert.equal(third.body.error.code, 'platform_not_granted')
  assert.equal(f.store.authorizationRejections.size, 3)
  assert.deepEqual([...f.store.authorizationRejections.values()].map(row => row.routePath),
    ['/api/v1/data/search', '/api/v1/night-all/search/raw', '/api/v2/data/search'])
  assert.deepEqual(f.count(), { reservations: 0, calls: 0 })
})

test('repeated client IDs never overwrite independent refusals; invalid ID and unmarked errors are not persisted', async t => {
  const f = await fixture(t)
  for (let i = 0; i < 2; i++) await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' }, { 'x-request-id': uuid })
  assert.equal(f.store.authorizationRejections.size, 2)
  assert.equal(new Set([...f.store.authorizationRejections.values()].map(row => row.eventId)).size, 2)
  const invalid = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' }, { 'x-request-id': 'private header value' })
  assert.equal(invalid.status, 403)
  assert.equal(invalid.body.requestId, 'private header value')
  const unauthorized = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' }, { authorization: 'Bearer invalid' })
  assert.equal(unauthorized.status, 401)
  f.service.search = async () => { throw new AppError(403, 'platform_not_granted', 'Platform is not granted') }
  const unmarked = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' })
  assert.equal(unmarked.status, 403)
  assert.equal(f.store.authorizationRejections.size, 2)
})

test('diagnostic store and logging failures cannot replace the original HTTP 403', async t => {
  const f = await fixture(t, { writerFails: true })
  const output = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' })
  assert.equal(output.status, 403)
  assert.equal(output.body.error.code, 'platform_not_granted')
  assert.equal(f.store.authorizationRejections.size, 0)
  assert.deepEqual(f.logs.map(row => row.event), ['hub_authorization_rejection_persistence_unconfirmed', 'hub_authorization_rejected'])
  assert.doesNotMatch(JSON.stringify(f.logs), /PRIVATE|credential/)
  let error
  try { assertSearchPlatformGranted(false, context(), 'tieba') } catch (caught) { error = caught }
  await recordAuthorizationRejection({ error, requestId: uuid, store: { recordAuthorizationRejection: async () => { throw new Error('private') } },
    logger: { warn() { throw new Error('logger unavailable') } } })
})

test('PostgreSQL diagnostic checkout expires and a late connection is released without SQL', async () => {
  let resolve, released = false, queries = 0
  const store = new PostgresStore({ connect: () => new Promise(done => { resolve = done }) })
  await assert.rejects(store.recordAuthorizationRejection(record()), /Diagnostic checkout deadline/)
  resolve({ query() { queries++ }, release() { released = true } })
  await new Promise(done => setImmediate(done))
  assert.equal(released, true)
  assert.equal(queries, 0)
})

test('a stalled diagnostic write cannot indefinitely delay the original HTTP refusal', { timeout: 4000 }, async t => {
  const f = await fixture(t)
  f.store.recordAuthorizationRejection = () => new Promise(() => {})
  const response = await f.send('/api/v1/data/search', { platform: 'tieba', query: 'q' })
  assert.equal(response.status, 403)
  assert.equal(response.body.error.code, 'platform_not_granted')
  assert.ok(f.logs.some(row => row.event === 'hub_authorization_rejection_persistence_unconfirmed'))
})

test('actual PostgreSQL refusals are independent of usage and collision-safe across owners', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite(); t.after(() => db.close())
  await db.exec('CREATE SCHEMA control')
  const store = new PostgresStore({ connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) })
  await assert.rejects(store.recordAuthorizationRejection(record()), { code: '42P01' })
  const migration = await readFile(new URL('../../migrations/193_request_authorization_rejections.sql', import.meta.url), 'utf8')
  await db.exec(migration)
  const a = record(), b = record()
  assert.deepEqual(await store.recordAuthorizationRejection(a), { recorded: true })
  assert.deepEqual(await store.recordAuthorizationRejection(b), { recorded: true })
  assert.deepEqual(await store.recordAuthorizationRejection({ ...b, eventId: a.eventId }), { recorded: false })
  const saved = (await db.query('SELECT * FROM control.request_authorization_rejections ORDER BY event_id')).rows
  assert.equal(saved.length, 2)
  assert.deepEqual(new Set(saved.map(row => row.consumer_id)), new Set([a.consumerId, b.consumerId]))
  assert.ok(saved.every(row => row.request_id === uuid && row.error_code === 'platform_not_granted' && row.http_status === 403))
  await db.exec(migration)
  assert.deepEqual((await db.query('SELECT * FROM control.request_authorization_rejections ORDER BY event_id')).rows, saved)
  assert.equal((await db.query("SELECT to_regclass('public.usage_requests') AS table_name")).rows[0].table_name, null)
  const definition = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='control.request_authorization_rejections'::regclass AND conname LIKE '%platform%'")).rows[0].definition
  for (const platform of AUTHORIZATION_REJECTION_PLATFORMS) assert.ok(definition.includes(`'${platform}'`))
})
