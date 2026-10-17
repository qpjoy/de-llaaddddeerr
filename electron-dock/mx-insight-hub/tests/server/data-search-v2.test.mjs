import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createApp } from '../../server/app.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { createDataSearchCursorCodec, createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { executeDataSearchV2, guardDataSearchV1 } from '../../server/data/search-protocol.mjs'
import { normalizeDataSearchV2, prepareDataSearchV2, projectDataSearchV2, DATA_SEARCH_V2_PATH,
  DATA_SEARCH_V1_PATH, DATA_SEARCH_V2_VERSION } from '../../server/contracts/data-search-v2.mjs'

const pepper = 'offline-search-protocol-pepper-at-least-32-characters'
const context = () => ({ tenant: { id: randomUUID() }, consumer: { id: randomUUID() }, apiKey: { id: randomUUID() } })
const body = (platform = 'facebook') => ({ platform, query: 'window fixture', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-16T16:00:00.000Z', to: '2026-10-17T16:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } })
const result = (items = [], nextCursor = null) => ({ status: 200, requestId: randomUUID(), replay: false, sourceMode: 'live',
  capturedAt: '2026-10-17T15:00:00.000Z', body: { data: { platform: 'facebook', query: 'window fixture', contractVersion: 'night-all.data-search.v1',
    items, status: 'ok', warnings: [], pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: items.length,
      hasMore: Boolean(nextCursor), nextCursor, cursorType: nextCursor ? 'opaque' : 'none' }, meta: { providerCalls: 1 } } } })
const code = expected => error => error.code === expected

test('v2 validates explicit bounded timezone instants and never accepts provider parameters or v1 cursors', () => {
  const canonical = normalizeDataSearchV2(body())
  assert.equal(canonical.timeWindow.from, '2026-10-16T16:00:00.000Z')
  for (const patch of [{ timeWindow: { ...body().timeWindow, from: '2026-10-17' } },
    { timeWindow: { ...body().timeWindow, to: body().timeWindow.from } },
    { timeWindow: { ...body().timeWindow, boundary: 'inclusive' } },
    { timeWindow: { ...body().timeWindow, timezone: 'Mars/Base' } },
    { timeWindow: { ...body().timeWindow, from: '2026-02-30T12:00:00Z' } },
    { timeWindow: { ...body().timeWindow, from: '2026-10-17T24:00:00Z' } }]) assert.throws(() => normalizeDataSearchV2({ ...body(), ...patch }), code('invalid_time_window'))
  assert.throws(() => normalizeDataSearchV2({ ...body(), params: {} }), code('unsupported_fields'))
  assert.throws(() => normalizeDataSearchV2({ ...body(), cursor: 'mxds1.old' }), code('invalid_cursor'))
  assert.throws(() => normalizeDataSearchV2(body('wechat_mp')), code('search_v2_platform_unsupported'))
})

test('v2 Shanghai date conversion covers the to date and source boundary semantics stay explicitly unverified', () => {
  const normalized = normalizeDataSearchV2(body()), codec = createDataSearchV2CursorCodec(pepper, 'caller'), prepared = prepareDataSearchV2(normalized, codec)
  assert.deepEqual(prepared.upstream.params, { startDate: '2026-10-17', endDate: '2026-10-18' })
  assert.equal(prepared.upstream.type, 'stable')
  const projected = projectDataSearchV2(result(), normalized, prepared, codec)
  assert.equal(projected.body.data.meta.capabilities.coverageComplete, false)
  assert.ok(projected.body.data.meta.limitations.some(value => value.code === 'upstream_date_boundary_unverified'))
})

for (const platform of ['facebook', 'twitter', 'reddit', 'instagram']) test(`v2 ${platform} exact half-open delivery filter retains original acquisition and empty-page cursor`, () => {
  const request = normalizeDataSearchV2(body(platform)), codec = createDataSearchV2CursorCodec(pepper, 'caller')
  const prepared = prepareDataSearchV2(request, codec), source = result([
    { id: 'before', publishedAt: '2026-10-16T15:59:59.999Z' }, { id: 'from', publishedAt: request.timeWindow.from },
    { id: 'to', publishedAt: request.timeWindow.to }, { id: 'missing', publishedAt: null }], 'mxds1.synthetic-inner')
  source.body.data.platform = platform
  const before = structuredClone(source), projected = projectDataSearchV2(source, request, prepared, codec)
  assert.deepEqual(source, before)
  assert.deepEqual(projected.body.data.items.map(value => value.id), ['from'])
  assert.equal(projected.body.data.contractVersion, DATA_SEARCH_V2_VERSION)
  assert.equal(projected.body.data.pageInfo.returnedCount, 1)
  assert.ok(projected.body.data.pageInfo.nextCursor.startsWith('mxds2.'))
  assert.equal(projected.body.data.meta.effectiveWindow.deliveryFiltering, 'exact')
  assert.equal(projected.body.data.meta.capabilities.upstreamFiltering, platform === 'facebook' ? 'calendar_date' : 'unsupported')
  const continuation = { ...request, cursor: projected.body.data.pageInfo.nextCursor }
  assert.equal(prepareDataSearchV2(continuation, codec).upstream.cursor, 'mxds1.synthetic-inner')
  assert.throws(() => prepareDataSearchV2({ ...continuation, timeWindow: { ...request.timeWindow, from: '2026-10-16T17:00:00.000Z' } }, codec), code('invalid_cursor'))
  assert.throws(() => prepareDataSearchV2(continuation, createDataSearchV2CursorCodec(pepper, 'other')), code('invalid_cursor'))
  assert.throws(() => createDataSearchCursorCodec(pepper, 'caller').decode(continuation.cursor))
  const emptySource = result([{ id: 'too-old', publishedAt: '2026-09-01T00:00:00Z' }], 'mxds1.next')
  emptySource.body.data.platform = platform
  const empty = projectDataSearchV2(emptySource, request, prepared, codec)
  assert.equal(empty.body.data.items.length, 0)
  assert.equal(empty.body.data.pageInfo.hasMore, true)
})

test('v2 retains exact response and cursor across retries without reacquiring the inner page', async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body())
  let calls = 0
  const invoke = value => executeDataSearchV2({ store, context: ctx, body: value, idempotencyKey: 'permanent-fixture-key', pepper,
    execute: async () => { calls++; return result([{ id: 'hit', publishedAt: request.timeWindow.from }], 'mxds1.fixture') } })
  const first = await invoke(request), second = await invoke(request)
  assert.deepEqual(second.body, first.body)
  assert.equal(second.replay, true)
  assert.equal(calls, 1)
  await assert.rejects(() => invoke({ ...request, timeWindow: { ...request.timeWindow, to: '2026-10-17T17:00:00.000Z' } }), code('idempotency_conflict'))
  await assert.rejects(() => guardDataSearchV1({ store, context: ctx, body: { platform: 'facebook', query: request.query },
    idempotencyKey: 'permanent-fixture-key', execute: async () => { calls++ } }), code('idempotency_conflict'))
  assert.equal(calls, 1)
})

test('projection failure keeps the original request guarded despite a successfully acquired raw page', async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body())
  let calls = 0
  const invoke = () => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: 'projection-failure-key', pepper,
    execute: async () => { calls++; return { ...result(), body: { data: { invalid: true } } } } })
  await assert.rejects(invoke, code('request_outcome_unknown'))
  await assert.rejects(invoke, code('request_outcome_unknown'))
  await assert.rejects(() => guardDataSearchV1({ store, context: ctx, body: { platform: 'facebook', query: request.query },
    idempotencyKey: 'downgrade-new-key', execute: async () => { calls++ } }), code('request_outcome_unknown'))
  assert.equal(calls, 1)
})

for (const scenario of ['unexpected_exception', 'usage_lookup_failed']) test(`v2 ${scenario} returns unknown on the first failure and cannot downgrade`, async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body())
  const lookup = store.getUsageRequestByIdempotencyKey.bind(store)
  let lookupCalls = 0, dispatches = 0
  if (scenario === 'usage_lookup_failed') store.getUsageRequestByIdempotencyKey = async (...args) => {
    if (++lookupCalls > 1) throw new Error('synthetic database read failure')
    return lookup(...args)
  }
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: 'unexpected-failure-key', pepper,
    execute: async () => { dispatches++; if (scenario === 'unexpected_exception') throw new Error('synthetic dispatch failure')
      throw new AppError(503, 'external_platform_unavailable', 'synthetic capability failure') } }), code('request_outcome_unknown'))
  store.getUsageRequestByIdempotencyKey = lookup
  await assert.rejects(() => guardDataSearchV1({ store, context: ctx, body: { platform: 'facebook', query: request.query },
    idempotencyKey: 'unsafe-downgrade-key', execute: async () => { dispatches++ } }), code('request_outcome_unknown'))
  assert.equal(dispatches, 1)
})

async function protocolFixture(t, postgres) {
  const ctx = context()
  if (!postgres) {
    const usage = new MemoryStore()
    return { ctx, protocol: new SearchProtocolStore(usage), addUsage: async row => {
      usage.requests.set(row.id, row); usage.requestsByScope.set(`${row.consumerId}:${row.idempotencyKey}`, row.id)
    }, expire: async () => {} }
  }
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY);
    CREATE TABLE api_keys(id uuid PRIMARY KEY); CREATE TABLE usage_requests(id uuid PRIMARY KEY,consumer_id uuid,api_key_id uuid,
      tenant_id uuid,platform text,idempotency_key text,status text,acquisition_request jsonb,reserved_at timestamptz);
    CREATE TABLE usage_idempotency_bindings(consumer_id uuid,idempotency_key text,current_request_id uuid);`)
  for (const [table, id] of [['tenants', ctx.tenant.id], ['consumers', ctx.consumer.id], ['api_keys', ctx.apiKey.id]]) await db.query(`INSERT INTO ${table}(id) VALUES($1)`, [id])
  await db.exec(await readFile(new URL('../../migrations/158_data_search_v2_protocol.sql', import.meta.url), 'utf8'))
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  return { ctx, db, protocol: new SearchProtocolStore({ pool }), addUsage: async row => {
    await db.query(`INSERT INTO usage_requests(id,consumer_id,api_key_id,tenant_id,platform,idempotency_key,status,acquisition_request,reserved_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [row.id,row.consumerId,row.apiKeyId,row.tenantId,row.platform,row.idempotencyKey,row.status,JSON.stringify(row.acquisitionRequest),row.reservedAt])
    await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [row.consumerId,row.idempotencyKey,row.id])
  }, expire: async () => {
    await db.exec("UPDATE control.data_search_protocol_leases SET expires_at=now()-interval '1 day'; UPDATE control.data_search_protocol_bindings SET lease_expires_at=now()-interval '1 day'")
  } }
}

for (const postgres of [false, true]) {
  const options = { skip: postgres && !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} preserves v1 concurrency and blocks cross-version/different-query key races`, options, async t => {
    const { ctx, protocol } = await protocolFixture(t, postgres)
    const first = await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'old-page-one-key' })
    const second = await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'old-page-two-key' })
    assert.equal(second.kind, 'acquired')
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-page-key' }), code('request_in_progress'))
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: { ...body(), query: 'different' }, idempotencyKey: 'old-page-one-key' }), code('request_in_progress'))
    await protocol.finish(first.input); await protocol.finish(second.input)
    const v2 = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-page-key' })
    await assert.rejects(() => protocol.begin(ctx, { version: 1, body: { ...body(), query: 'different' }, idempotencyKey: 'new-page-key' }), code('idempotency_conflict'))
    await protocol.finish(v2.input, { state: 'unknown' })
    for (const version of [1, 2]) await assert.rejects(() => protocol.begin(ctx, { version, body: { ...body(), timeWindow: { ...body().timeWindow, from: '2026-10-01T00:00:00Z' } },
      idempotencyKey: `changed-key-${version}` }), code('request_outcome_unknown'))
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} sees historical unknown beyond 24h and rejects old key migration`, options, async t => {
    const { ctx, protocol, addUsage } = await protocolFixture(t, postgres)
    const id = randomUUID()
    await addUsage({ id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id, platform: 'facebook',
      idempotencyKey: 'legacy-unknown-key', status: 'unknown', acquisitionRequest: { path: DATA_SEARCH_V1_PATH,
        body: { platform: 'facebook', query: `\n\u00a0${body().query}\ufeff\t` } }, reservedAt: '2026-01-01T00:00:00Z' })
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-unknown-key' }), error => error.code === 'request_outcome_unknown' && error.details.requestId === id)
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'legacy-unknown-key' }), code('idempotency_conflict'))
    assert.equal((await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'legacy-unknown-key' })).kind, 'legacy')
    await addUsage({ id: randomUUID(), consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id, platform: 'facebook',
      idempotencyKey: 'legacy-missing-query', status: 'unknown', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'facebook' } }, reservedAt: '2026-01-01T00:00:00Z' })
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: { ...body(), query: 'cannot prove this is unrelated' }, idempotencyKey: 'missing-query-bypass' }), code('request_outcome_unknown'))
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} stores exact delivery and rejects another API Key`, options, async t => {
    const { ctx, protocol } = await protocolFixture(t, postgres), response = result()
    const first = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' })
    await protocol.finish(first.input, { state: 'complete', result: response })
    const replay = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' })
    assert.deepEqual(replay.result, response)
    await assert.rejects(() => protocol.begin({ ...ctx, apiKey: { id: randomUUID() } }, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' }), code('idempotency_conflict'))
  })
  if (postgres) test('expired PostgreSQL protocol lease stays unknown and is never an automatic dispatch permit', options, async t => {
    const { ctx, protocol, expire, addUsage } = await protocolFixture(t, true)
    await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-v2-lease-key' })
    const requestId = randomUUID()
    await addUsage({ id: requestId, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id,
      platform: 'facebook', idempotencyKey: 'expired-v2-lease-key', status: 'committed',
      acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'facebook', query: body().query } }, reservedAt: '2026-10-17T00:00:00Z' })
    // Simulate a crash after underlying commit but before saving its UUID to
    // the protocol binding. Lookup by that UUID still finds protocol ownership.
    assert.equal((await protocol.bindingForUsage(ctx, requestId)).state, 'running')
    await expire()
    for (const version of [1, 2]) await assert.rejects(() => protocol.begin(ctx, { version, body: body(), idempotencyKey: 'expired-new-key' }), code('request_outcome_unknown'))
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-v2-lease-key' }), code('request_outcome_unknown'))
  })
}

test('v2 revalidates grants before returning its saved delivery and request lookup exposes projection state', async () => {
  const store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'Protocol fixture' }), consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Fixture' })
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture', platforms: ['facebook'], capabilities: [] }), ctx = await service.authenticate(key.secret)
  let calls = 0
  service.externalDataSearch = async () => { calls++; return result() }
  await service.search(ctx, { path: DATA_SEARCH_V2_PATH, body: body(), idempotencyKey: 'public-state-key' })
  const status = await service.requestStatusByIdempotencyKey(ctx, 'public-state-key')
  assert.equal(status.searchProtocol.deliveryConfirmed, true)
  await service.putPlatformConfiguration('facebook', { tenantId: tenant.id, consumerId: consumer.id, enabled: false, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  await assert.rejects(() => service.search(ctx, { path: DATA_SEARCH_V2_PATH, body: body(), idempotencyKey: 'public-state-key' }), code('platform_not_granted'))
  assert.equal(calls, 1)
})

test('v2 public HTTP routes all four Luopan platforms, rejects unauthenticated calls and stays isolated from Admin', async t => {
  const store = new MemoryStore(), service = new HubService({ store, apiKeyPepper: pepper })
  const tenant = await service.createTenant({ name: 'HTTP protocol fixture' }), consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Fixture' })
  const platforms = ['facebook', 'twitter', 'instagram', 'reddit']
  for (const platform of platforms) await service.putPlatformConfiguration(platform, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 100, windowSeconds: 3600, maxPageSize: 100 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'HTTP fixture', platforms, capabilities: [] })
  const acquired = []
  service.externalDataSearch = async (_context, input) => {
    acquired.push(structuredClone(input.normalized))
    const output = result([{ id: 'one', publishedAt: body().timeWindow.from }])
    output.body.data.platform = input.normalized.platform
    return output
  }
  const listen = async listenerMode => {
    const server = createServer(createApp({ store, service, adapter: {}, listenerMode, logger: { error() {} } }))
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections() }))
    return `http://127.0.0.1:${server.address().port}`
  }
  const origin = await listen('public'), admin = await listen('admin')
  const deploymentProbe = await fetch(`${origin}${DATA_SEARCH_V2_PATH}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', redirect: 'manual',
  })
  assert.equal(deploymentProbe.status, 401)
  assert.equal((await deploymentProbe.json()).error.code, 'api_key_required')
  assert.equal(acquired.length, 0)
  assert.equal(store.requests.size, 0, 'deployment route probe must not reserve usage')
  const send = (base, platform, authorized = true) => fetch(`${base}${DATA_SEARCH_V2_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `http-${platform}-v2-key`, ...(authorized ? { authorization: `Bearer ${key.secret}` } : {}) }, body: JSON.stringify(body(platform)) })
  assert.equal((await send(origin, 'facebook', false)).status, 401)
  assert.equal((await send(admin, 'facebook')).status, 404)
  assert.equal((await fetch(`${origin}${DATA_SEARCH_V2_PATH}?query=ignored`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}`, 'idempotency-key': 'http-reject-query-key' },
    body: JSON.stringify(body()) })).status, 400)
  for (const platform of platforms) {
    const response = await send(origin, platform), json = await response.json()
    assert.equal(response.status, 200, JSON.stringify(json))
    assert.equal(json.data.platform, platform)
    assert.equal(json.data.contractVersion, DATA_SEARCH_V2_VERSION)
    assert.equal(json.data.items.length, 1)
    assert.equal(json.data.meta.requestedWindow.boundary, '[from,to)')
    assert.equal(response.headers.get('access-control-allow-origin'), '*')
  }
  assert.equal(acquired.length, 4)
  assert.ok(acquired.every(request => request.type === undefined))
  assert.deepEqual(acquired.find(request => request.platform === 'facebook').params, { startDate: '2026-10-17', endDate: '2026-10-18' })
  assert.ok(acquired.filter(request => request.platform !== 'facebook').every(request => request.params === undefined))
})

test('v2 machine documentation uses the explicit v2 server path and respects existing platform visibility', () => {
  const operation = PUBLIC_OPENAPI_DOCUMENT.paths[DATA_SEARCH_V2_PATH]
  assert.equal(operation.servers[0].url, '/')
  assert.equal(operation.post.operationId, 'searchDataV2')
  assert.ok(tenantOpenApiDocument([{ platforms: ['facebook'], capabilities: [] }]).paths[DATA_SEARCH_V2_PATH])
  assert.equal(tenantOpenApiDocument([{ platforms: ['ip_risk'], capabilities: [] }]).paths[DATA_SEARCH_V2_PATH], undefined)
})
