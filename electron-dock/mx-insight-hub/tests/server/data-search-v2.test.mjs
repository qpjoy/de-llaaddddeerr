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
import { AppError, SearchAdmissionNotStartedError } from '../../server/core/errors.mjs'
import { createDataSearchCursorCodec, createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'
import { SearchProtocolStore } from '../../server/data/search-protocol-store.mjs'
import { executeDataSearchV2, guardDataSearchV1 } from '../../server/data/search-protocol.mjs'
import { createTwitterSearchRouter } from '../../server/data/twitter-search-routing.mjs'
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

test('projection failure keeps the original key guarded while an ended unknown does not block a new key', async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body())
  let calls = 0
  const invoke = () => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: 'projection-failure-key', pepper,
    execute: async () => { calls++; return { ...result(), body: { data: { invalid: true } } } } })
  await assert.rejects(invoke, code('request_outcome_unknown'))
  await assert.rejects(invoke, code('request_outcome_unknown'))
  assert.equal(calls, 1)
  await guardDataSearchV1({ store, context: ctx, body: { platform: 'facebook', query: request.query },
    idempotencyKey: 'downgrade-new-key', execute: async () => { calls++ } })
  assert.equal(calls, 2)
})

for (const scenario of ['unexpected_exception', 'usage_lookup_failed']) test(`v2 ${scenario} returns unknown on the first failure while a new v1 key is not held by it`, async () => {
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
  assert.equal(dispatches, 1)
  await guardDataSearchV1({ store, context: ctx, body: { platform: 'facebook', query: request.query },
    idempotencyKey: 'new-v1-key', execute: async () => { dispatches++ } })
  assert.equal(dispatches, 2)
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: 'unexpected-failure-key', pepper,
    execute: async () => { dispatches++ } }), code('request_outcome_unknown'))
  assert.equal(dispatches, 2)
})

test('public not-started fields cannot relabel an unproven v2 unknown as safe admission', async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body('twitter'))
  const key = 'untrusted-admission-fields'
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: key, pepper,
    execute: async () => { throw new AppError(409, 'request_outcome_unknown', 'synthetic unknown',
      { dispatchState: 'not_started', automaticRetryAllowed: true, blockingRequestId: randomUUID() }) } }),
  error => error.code === 'request_outcome_unknown' && error.details.automaticRetryAllowed === false)
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'unknown')
})

for (const status of ['reserved', 'unknown', 'committed']) test(`an owned ${status} usage prevents trusted admission evidence from relaxing v2 uncertainty`, async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body('twitter'))
  const key = `owned-admission-${status}`, id = randomUUID()
  const original = { id, tenantId: ctx.tenant.id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id,
    platform: 'twitter', idempotencyKey: key, status }
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: key, pepper,
    execute: async () => {
      store.requests.set(id, structuredClone(original)); store.requestsByScope.set(`${ctx.consumer.id}:${key}`, id)
      throw new SearchAdmissionNotStartedError(409, 'request_outcome_unknown', 'synthetic conflicting evidence', { requestId: randomUUID() })
    } }), error => error.code === 'request_outcome_unknown' && error.details.requestId === id
      && error.details.automaticRetryAllowed === false)
  const binding = await new SearchProtocolStore(store).binding(ctx, key)
  assert.equal(binding.state, 'unknown'); assert.equal(binding.usageRequestId, id)
  assert.deepEqual(store.requests.get(id), original)
})

test('a failed own-usage lookup retains v2 uncertainty despite trusted pre-reserve evidence', async () => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2(body('twitter'))
  const key = 'admission-with-lookup-failure', lookup = store.getUsageRequestByIdempotencyKey.bind(store)
  let lookups = 0
  store.getUsageRequestByIdempotencyKey = async (...args) => {
    if (++lookups > 1) throw new Error('synthetic own-usage lookup failure')
    return lookup(...args)
  }
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: key, pepper,
    execute: async () => { throw new SearchAdmissionNotStartedError(409, 'request_outcome_unknown', 'synthetic prior blocker', { requestId: randomUUID() }) } }),
  error => error.code === 'request_outcome_unknown' && error.details.automaticRetryAllowed === false)
  assert.equal((await new SearchProtocolStore(store).binding(ctx, key)).state, 'unknown')
})

test('failed pre-reserve protocol cleanup never reports the old blocker as the new page receipt', async t => {
  const store = new MemoryStore(), ctx = context(), request = normalizeDataSearchV2({ ...body('twitter'), query: 'synthetic protocol fixture' })
  const key = 'admission-finish-failure', id = randomUUID()
  const blocker = { id, tenantId: ctx.tenant.id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id,
    platform: 'twitter', idempotencyKey: 'old-running-blocker', status: 'reserved', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: 'synthetic AND protocol AND fixture' } } }
  store.requests.set(id, structuredClone(blocker))
  let procurements = 0
  const route = createTwitterSearchRouter({ usageStore: store, apiKeyPepper: pepper, provider: 'rapidapi',
    rapidGateway: { platformStore: { calls: new Map() }, searchRaw: async () => { procurements++ } },
    tikHubGateway: { platformStore: { calls: new Map() }, searchContent: async () => { procurements++ } } })
  const finish = SearchProtocolStore.prototype.finish
  t.mock.method(SearchProtocolStore.prototype, 'finish', async function (input, ...args) {
    if (input.idempotencyKey === key) throw new Error('synthetic protocol cleanup failure')
    return finish.call(this, input, ...args)
  })
  await assert.rejects(() => executeDataSearchV2({ store, context: ctx, body: request, idempotencyKey: key, pepper,
    execute: upstream => route(ctx, { normalized: upstream, body: upstream, idempotencyKey: key }) }), error => {
    assert.equal(error.code, 'request_outcome_unknown')
    assert.equal(error.details.automaticRetryAllowed, false)
    assert.equal(Object.hasOwn(error.details, 'requestId'), false)
    return true
  })
  assert.equal(procurements, 0)
  assert.equal(store.requests.size, 1)
  assert.deepEqual(store.requests.get(id), blocker)
  const binding = await new SearchProtocolStore(store).binding(ctx, key)
  assert.equal(binding.state, 'running'); assert.equal(binding.usageRequestId, null)
})

async function protocolFixture(t, postgres) {
  const ctx = context()
  if (!postgres) {
    const usage = new MemoryStore()
    return { ctx, protocol: new SearchProtocolStore(usage), addUsage: async row => {
      usage.requests.set(row.id, row); usage.requestsByScope.set(`${row.consumerId}:${row.idempotencyKey}`, row.id)
    }, addConnector: async row => { usage.connectorCalls.set(row.id, row) },
    savedUsage: async id => structuredClone(usage.requests.get(id)), expire: async () => {},
    setUsageStatus: async (id, status) => { usage.requests.get(id).status = status },
    forgetUsageBinding: async key => { usage.requestsByScope.delete(`${ctx.consumer.id}:${key}`) },
    danglingUsageBinding: async key => { usage.requestsByScope.set(`${ctx.consumer.id}:${key}`, randomUUID()) } }
  }
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec(`CREATE SCHEMA control; CREATE TABLE tenants(id uuid PRIMARY KEY); CREATE TABLE consumers(id uuid PRIMARY KEY);
    CREATE TABLE api_keys(id uuid PRIMARY KEY); CREATE TABLE usage_requests(id uuid PRIMARY KEY,consumer_id uuid,api_key_id uuid,
      tenant_id uuid,platform text,idempotency_key text,status text,acquisition_request jsonb,reserved_at timestamptz,lease_expires_at timestamptz,
      fingerprint text,capability text,billing_meter_key text);
    CREATE SCHEMA serving; CREATE TABLE serving.connector_calls(id uuid PRIMARY KEY,usage_request_id uuid,
      consumer_id uuid,platform text,request_fingerprint text,operation text,outcome text);
    CREATE TABLE usage_idempotency_bindings(consumer_id uuid,idempotency_key text,current_request_id uuid);`)
  for (const [table, id] of [['tenants', ctx.tenant.id], ['consumers', ctx.consumer.id], ['api_keys', ctx.apiKey.id]]) await db.query(`INSERT INTO ${table}(id) VALUES($1)`, [id])
  await db.exec(await readFile(new URL('../../migrations/158_data_search_v2_protocol.sql', import.meta.url), 'utf8'))
  const pool = { query: (sql, args) => db.query(sql, args), connect: async () => ({ query: (sql, args) => db.query(sql, args), release() {} }) }
  return { ctx, db, protocol: new SearchProtocolStore({ pool }), addUsage: async row => {
    await db.query(`INSERT INTO usage_requests(id,consumer_id,api_key_id,tenant_id,platform,idempotency_key,status,acquisition_request,reserved_at,
      fingerprint,capability,billing_meter_key,lease_expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.id,row.consumerId,row.apiKeyId,row.tenantId,row.platform,row.idempotencyKey,row.status,
      row.acquisitionRequest == null ? null : JSON.stringify(row.acquisitionRequest),row.reservedAt ?? new Date().toISOString(),
      row.fingerprint ?? null,row.capability ?? null,row.billingMeterKey ?? null,row.leaseExpiresAt ?? null])
    await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [row.consumerId,row.idempotencyKey,row.id])
  }, addConnector: async row => {
    await db.query(`INSERT INTO serving.connector_calls(id,usage_request_id,consumer_id,platform,request_fingerprint,operation,outcome)
      VALUES($1,$2,$3,$4,$5,$6,$7)`, [row.id,row.requestId,row.consumerId,row.platform,row.fingerprint,row.operation,row.outcome])
  }, savedUsage: async id => (await db.query('SELECT * FROM usage_requests WHERE id=$1', [id])).rows[0], expire: async () => {
    await db.exec("UPDATE control.data_search_protocol_leases SET expires_at=now()-interval '1 minute'; UPDATE control.data_search_protocol_bindings SET lease_expires_at=now()-interval '1 minute'")
  }, setUsageStatus: async (id, status) => { await db.query('UPDATE usage_requests SET status=$2 WHERE id=$1', [id, status]) },
  forgetUsageBinding: async key => { await db.query('DELETE FROM usage_idempotency_bindings WHERE consumer_id=$1 AND idempotency_key=$2', [ctx.consumer.id, key]) },
  danglingUsageBinding: async key => { await db.query('INSERT INTO usage_idempotency_bindings VALUES($1,$2,$3)', [ctx.consumer.id, key, randomUUID()]) } }
}

const legacyRawUsage = (ctx, patch = {}) => ({ id: randomUUID(), tenantId: ctx.tenant.id,
  consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, platform: 'twitter', idempotencyKey: randomUUID(),
  status: 'unknown', acquisitionRequest: null, capability: null, billingMeterKey: 'raw', fingerprint: 'a'.repeat(64),
  reservedAt: new Date(Date.now() - 60_000).toISOString(), leaseExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), ...patch })
const legacyRawConnector = (usage, patch = {}) => ({ id: randomUUID(), requestId: usage.id,
  consumerId: usage.consumerId, platform: usage.platform, fingerprint: usage.fingerprint,
  operation: 'raw', outcome: 'unknown', ...patch })

for (const postgres of [false, true]) {
  const options = { skip: postgres && !process.env.MX_INSIGHT_TEST_PGLITE_MODULE }
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} compiled-equivalent Twitter in-flight blockers keep the new page retryable; an ended unknown does not block`, options, async t => {
    for (const blockerStatus of ['unknown', 'reserved']) await t.test(blockerStatus, async t => {
      const { ctx, protocol, db, addUsage, setUsageStatus, savedUsage } = await protocolFixture(t, postgres)
      const usage = protocol.usage
      if (postgres) usage.getUsageRequestByIdempotencyKey = async (consumerId, key) => {
        const row = (await db.query(`SELECT request.* FROM usage_idempotency_bindings binding
          JOIN usage_requests request ON request.id=binding.current_request_id
          WHERE binding.consumer_id=$1 AND binding.idempotency_key=$2`, [consumerId, key])).rows[0]
        return row ? { id: row.id, tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id,
          platform: row.platform, status: row.status, acquisitionRequest: row.acquisition_request } : null
      }
      const request = normalizeDataSearchV2({ ...body('twitter'), query: 'synthetic protocol fixture' })
      const blocker = legacyRawUsage(ctx, { status: blockerStatus, billingMeterKey: 'twitter',
        acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: 'synthetic AND protocol AND fixture' } } })
      await addUsage(blocker)
      const before = await savedUsage(blocker.id), key = `compiled-blocker-${blockerStatus}`
      let procurements = 0
      const acquire = async () => {
        procurements++
        const value = result()
        value.body.data.platform = 'twitter'; value.body.data.query = request.query
        await addUsage(legacyRawUsage(ctx, { id: value.requestId, idempotencyKey: key, status: 'committed',
          acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: request.query } } }))
        return value
      }
      const route = createTwitterSearchRouter({ usageStore: usage, apiKeyPepper: pepper, provider: 'rapidapi',
        rapidGateway: { platformStore: { calls: new Map() }, searchRaw: acquire },
        tikHubGateway: { platformStore: { calls: new Map() }, searchContent: acquire } })
      const invoke = () => executeDataSearchV2({ store: usage, context: ctx, body: request, idempotencyKey: key, pepper,
        execute: upstream => route(ctx, { normalized: upstream, body: upstream, idempotencyKey: key }) })
      if (blockerStatus === 'unknown') {
        const delivered = await invoke()
        assert.equal(delivered.status, 200)
        assert.equal(procurements, 1)
        assert.deepEqual(await savedUsage(blocker.id), before)
        assert.deepEqual((await invoke()).body, delivered.body)
        assert.equal(procurements, 1)
        return
      }
      for (let attempt = 0; attempt < 3; attempt++) {
        await assert.rejects(invoke, error => {
          assert.equal(error.status, 409); assert.equal(error.code, 'search_admission_blocked')
          assert.deepEqual(error.details, { dispatchState: 'not_started', automaticRetryAllowed: true,
            retrySameRequest: true, retryAfterSeconds: 300, blockingRequestId: blocker.id })
          return true
        })
        const binding = await protocol.binding(ctx, key)
        assert.equal(binding.state, 'retryable')
        assert.equal(binding.usageRequestId, null)
        assert.equal(await usage.getUsageRequestByIdempotencyKey(ctx.consumer.id, key), null)
        assert.equal(procurements, 0)
        assert.deepEqual(await savedUsage(blocker.id), before)
      }
      // Synthetic independent resolution of the blocker, never an automatic
      // change made by retrying the unstarted page.
      await setUsageStatus(blocker.id, 'released')
      const delivered = await invoke()
      assert.equal(delivered.status, 200)
      assert.equal(procurements, 1)
      assert.equal((await protocol.binding(ctx, key)).state, 'complete')
      assert.deepEqual((await invoke()).body, delivered.body)
      assert.equal(procurements, 1)
    })
  })

  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} admission rejection owns no page and exact retries execute once after the blocker resolves`, options, async t => {
    const { ctx, protocol, addUsage, setUsageStatus, savedUsage } = await protocolFixture(t, postgres)
    const request = normalizeDataSearchV2(body('twitter')), key = 'unowned-page-retry'
    const blocker = legacyRawUsage(ctx, { status: 'reserved', billingMeterKey: 'twitter', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: request.query } } })
    await addUsage(blocker)
    const before = await savedUsage(blocker.id), snapshot = structuredClone(request)
    let dispatches = 0
    const invoke = () => executeDataSearchV2({ store: protocol.usage, context: ctx, body: request, idempotencyKey: key, pepper,
      execute: async () => {
        dispatches++; const value = result(); value.body.data.platform = 'twitter'
        await addUsage(legacyRawUsage(ctx, { id: value.requestId, idempotencyKey: key, status: 'committed',
          acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: request.query } } }))
        return value
      } })
    for (let attempt = 0; attempt < 3; attempt++) {
      await assert.rejects(invoke, error => {
        assert.equal(error.status, 409); assert.equal(error.code, 'search_admission_blocked')
        assert.deepEqual(error.details, { dispatchState: 'not_started', automaticRetryAllowed: true, retrySameRequest: true,
          retryAfterSeconds: 300, blockingRequestId: blocker.id })
        return true
      })
      assert.equal(await protocol.binding(ctx, key) ?? null, null)
    }
    assert.equal(dispatches, 0); assert.deepEqual(request, snapshot); assert.deepEqual(await savedUsage(blocker.id), before)
    // A separate reconciliation, not the retry, resolves the historical usage.
    await setUsageStatus(blocker.id, 'committed')
    const first = await invoke(), replay = await invoke()
    assert.deepEqual(first.body, replay.body); assert.equal(replay.replay, true); assert.equal(dispatches, 1)
    await assert.rejects(() => protocol.begin(ctx, { version: 1, body: request, idempotencyKey: key }), code('idempotency_conflict'))
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} owned retryable pages and orphan key records never advertise unsent admission`, options, async t => {
    const fixture = await protocolFixture(t, postgres), { ctx, protocol } = fixture
    const request = body('twitter'), retryKey = 'previously-owned-retryable-page'
    const retryable = await protocol.begin(ctx, { version: 2, body: request, idempotencyKey: retryKey })
    await protocol.finish(retryable.input, { state: 'retryable' })
    const blocker = legacyRawUsage(ctx, { status: 'reserved', billingMeterKey: 'twitter', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: request.query } } })
    await fixture.addUsage(blocker)
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey: retryKey }), code('request_in_progress'))
    const orphan = legacyRawUsage(ctx, { idempotencyKey: 'orphan-owned-key', status: 'committed', acquisitionRequest: { path: DATA_SEARCH_V1_PATH } })
    await fixture.addUsage(orphan); await fixture.forgetUsageBinding(orphan.idempotencyKey)
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey: orphan.idempotencyKey }), code('idempotency_conflict'))
    await fixture.danglingUsageBinding('dangling-binding-key')
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey: 'dangling-binding-key' }), code('idempotency_conflict'))
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} orphan legacy ownership blocks key reuse without blocking unrelated new searches`, options, async t => {
    const fixture = await protocolFixture(t, postgres), { ctx, protocol } = fixture
    const request = body('twitter'), orphan = legacyRawUsage(ctx, { idempotencyKey: 'orphan-unknown-without-query' })
    await fixture.addUsage(orphan); await fixture.forgetUsageBinding(orphan.idempotencyKey)
    await fixture.danglingUsageBinding('dangling-without-request')
    const before = await fixture.savedUsage(orphan.id)
    for (const idempotencyKey of [orphan.idempotencyKey, 'dangling-without-request']) {
      await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey }), code('idempotency_conflict'))
      assert.equal(await protocol.binding(ctx, idempotencyKey) ?? null, null)
    }
    const admitted = await protocol.begin(ctx, { version: 2, body: request, idempotencyKey: 'fresh-unrelated-key' })
    assert.equal(admitted.kind, 'acquired')
    await protocol.finish(admitted.input, { state: 'complete', result: result() })
    assert.deepEqual(await fixture.savedUsage(orphan.id), before)
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} isolates old raw requests without clearing their outcome or key ownership`, options, async t => {
    const { ctx, protocol, addUsage, addConnector, savedUsage } = await protocolFixture(t, postgres)
    const request = body('twitter')
    for (const path of [null, '/api/v1/night-all/search/raw', '/api/v1/search/raw']) {
      const usage = legacyRawUsage(ctx, { acquisitionRequest: path ? { path } : null })
      await addUsage(usage)
      // A connector row may exist, but new searches do not need one to isolate
      // a historical receipt whose standard-search identity is not known.
      if (!path) await addConnector(legacyRawConnector(usage))
      const before = await savedUsage(usage.id)
      await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey: usage.idempotencyKey }), code('idempotency_conflict'))
      assert.equal((await protocol.begin(ctx, { version: 1, body: request, idempotencyKey: usage.idempotencyKey })).kind, 'legacy')
      const admitted = await protocol.begin(ctx, { version: 2, body: request, idempotencyKey: randomUUID() })
      assert.equal(admitted.kind, 'acquired')
      await protocol.finish(admitted.input, { state: 'complete', result: result() })
      assert.deepEqual(await savedUsage(usage.id), before, 'classification must not settle or rewrite the raw request')
    }
    const acquired = await protocol.begin(ctx, { version: 2, body: request, idempotencyKey: 'new-standard-unknown' })
    await assert.rejects(() => protocol.begin(ctx, { version: 1, body: request, idempotencyKey: 'v1-running-bypass' }), code('request_in_progress'))
    await protocol.finish(acquired.input, { state: 'unknown' })
    // The ended unknown keeps its own key; it no longer holds other keys back.
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: request, idempotencyKey: 'new-standard-unknown' }), code('request_outcome_unknown'))
    for (const version of [1, 2]) {
      const admitted = await protocol.begin(ctx, { version, body: { ...request, cursor: 'changed-cursor',
        timeWindow: { ...request.timeWindow, from: '2026-09-01T00:00:00.000Z' } }, idempotencyKey: `new-key-${version}` })
      assert.equal(admitted.kind, 'acquired')
      await protocol.finish(admitted.input, version === 2 ? { state: 'complete', result: result() } : undefined)
    }
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} incomplete legacy identities do not block new searches or release old keys`, options, async t => {
    const fixture = await protocolFixture(t, postgres)
    const cases = [
      { name: 'no connector', calls: [] },
      { name: 'no meter', usage: { billingMeterKey: null } },
      { name: 'another capability', usage: { capability: 'social.content.search' } },
      { name: 'invalid fingerprint', usage: { fingerprint: 'not-a-sha256' } },
      { name: 'missing fingerprint', usage: { fingerprint: null } },
      { name: 'reserved raw', usage: { status: 'reserved' } },
      { name: 'incomplete snapshot', usage: { acquisitionRequest: {} } },
      { name: 'null snapshot path', usage: { acquisitionRequest: { path: null } } },
      { name: 'missing path with known query', usage: { acquisitionRequest: { body: { query: body().query } } } },
      { name: 'standard path missing query', usage: { acquisitionRequest: { path: DATA_SEARCH_V1_PATH } } },
      ...[null, 123, [], {}, '', ' \n\u00a0\ufeff\t'].map(query => ({ name: `non-identifying query ${JSON.stringify(query)}`,
        usage: { acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query } } } })),
      { name: 'different consumer', calls: [{ consumerId: randomUUID() }] },
      { name: 'different platform', calls: [{ platform: 'facebook' }] },
      { name: 'missing platform', calls: [{ platform: null }] },
      { name: 'different fingerprint', calls: [{ fingerprint: 'b'.repeat(64) }] },
      { name: 'different operation', calls: [{ operation: 'data-search' }] },
      { name: 'unfinished connector', calls: [{ outcome: null }] },
      { name: 'different connector outcome', calls: [{ outcome: 'complete' }] },
      { name: 'unrelated connector', calls: [{ requestId: randomUUID() }] },
      { name: 'multiple consistent connectors', calls: [{}, {}] },
      { name: 'mixed operations', calls: [{}, { operation: 'data-search' }] },
      { name: 'unidentified crawl', usage: { billingMeterKey: 'crawl' }, calls: [{ operation: 'crawl' }] },
      { name: 'unidentified user-info', usage: { billingMeterKey: 'user-info' }, calls: [{ operation: 'user-info' }] },
    ]
    for (const scenario of cases) {
      const ctx = fixture.ctx
      const usage = legacyRawUsage(ctx, scenario.usage)
      await fixture.addUsage(usage)
      for (const patch of scenario.calls ?? [{}]) await fixture.addConnector(legacyRawConnector(usage, patch))
      const before = await fixture.savedUsage(usage.id), idempotencyKey = randomUUID()
      const admitted = await fixture.protocol.begin(ctx, { version: 2, body: body('twitter'), idempotencyKey })
      assert.equal(admitted.kind, 'acquired', scenario.name)
      await fixture.protocol.finish(admitted.input, { state: 'complete', result: result() })
      await assert.rejects(() => fixture.protocol.begin(ctx, { version: 2, body: body('twitter'), idempotencyKey: usage.idempotencyKey }),
        code('idempotency_conflict'), scenario.name)
      assert.equal((await fixture.protocol.begin(ctx, { version: 1, body: body('twitter'), idempotencyKey: usage.idempotencyKey })).kind, 'legacy', scenario.name)
      assert.deepEqual(await fixture.savedUsage(usage.id), before, scenario.name)
    }
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} still finds a matching in-flight standard search among unidentified receipts`, options, async t => {
    const { ctx, protocol, addUsage, addConnector, savedUsage } = await protocolFixture(t, postgres)
    const raw = legacyRawUsage(ctx), standard = legacyRawUsage(ctx, { status: 'reserved', billingMeterKey: 'twitter',
      acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'twitter', query: body().query } } })
    await addUsage(raw); await addConnector(legacyRawConnector(raw)); await addUsage(standard)
    const before = await savedUsage(raw.id)
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body('twitter'), idempotencyKey: randomUUID() }),
      error => error.code === 'search_admission_blocked' && error.details?.blockingRequestId === standard.id)
    assert.deepEqual(await savedUsage(raw.id), before)
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} known legacy query protection matches its owner and exact trimmed text`, options, async t => {
    const { ctx, protocol, addUsage, savedUsage } = await protocolFixture(t, postgres)
    const request = body('twitter')
    for (const patch of [{ tenantId: randomUUID() }, { consumerId: randomUUID() }, { apiKeyId: randomUUID() }, { platform: 'facebook' },
      { acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: `${request.query} another term` } } },
      { acquisitionRequest: { path: '/api/v1/night-all/search/raw', body: { query: request.query } } }]) {
      await addUsage(legacyRawUsage(ctx, { status: 'reserved', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: request.query } }, ...patch }))
    }
    const unrelated = await protocol.begin(ctx, { version: 2, body: request, idempotencyKey: randomUUID() })
    assert.equal(unrelated.kind, 'acquired')
    await protocol.finish(unrelated.input, { state: 'complete', result: result() })
    for (const status of ['unknown', 'reserved']) {
      const query = `${request.query} ${status}`, legacy = legacyRawUsage(ctx, { status,
        acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: `\n\u00a0${query}\ufeff\t` } } })
      await addUsage(legacy)
      const before = await savedUsage(legacy.id), idempotencyKey = randomUUID()
      if (status === 'unknown') {
        // An ended attempt with an unknown outcome does not hold a new key.
        const admitted = await protocol.begin(ctx, { version: 2, body: { ...request, query }, idempotencyKey })
        assert.equal(admitted.kind, 'acquired')
        await protocol.finish(admitted.input, { state: 'complete', result: result() })
        assert.deepEqual(await savedUsage(legacy.id), before)
        continue
      }
      await assert.rejects(() => protocol.begin(ctx, { version: 2, body: { ...request, query }, idempotencyKey }), error => {
        assert.equal(error.code, 'search_admission_blocked')
        assert.equal(error.details.blockingRequestId, legacy.id)
        assert.equal(error.details.dispatchState, 'not_started')
        return true
      })
      assert.equal(await protocol.binding(ctx, idempotencyKey) ?? null, null)
      assert.deepEqual(await savedUsage(legacy.id), before)
    }
  })
  if (postgres) test('legacy search admission does not depend on the PostgreSQL connector evidence table', options, async t => {
    const { ctx, db, protocol, addUsage, savedUsage } = await protocolFixture(t, true)
    const usage = legacyRawUsage(ctx), idempotencyKey = randomUUID()
    await addUsage(usage)
    const before = await savedUsage(usage.id)
    await db.exec('DROP TABLE serving.connector_calls')
    const admitted = await protocol.begin(ctx, { version: 2, body: body('twitter'), idempotencyKey })
    assert.equal(admitted.kind, 'acquired')
    await protocol.finish(admitted.input, { state: 'complete', result: result() })
    const standard = legacyRawUsage(ctx, { status: 'reserved', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: body().query } } })
    await addUsage(standard)
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body('twitter'), idempotencyKey: randomUUID() }),
      error => error.code === 'search_admission_blocked' && error.details.blockingRequestId === standard.id)
    assert.deepEqual(await savedUsage(usage.id), before)
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} preserves v1 concurrency and blocks cross-version/different-query key races`, options, async t => {
    const { ctx, protocol } = await protocolFixture(t, postgres)
    const first = await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'old-page-one-key' })
    const second = await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'old-page-two-key' })
    assert.equal(second.kind, 'acquired')
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-page-key' }), code('search_admission_blocked'))
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: { ...body(), query: 'different' }, idempotencyKey: 'old-page-one-key' }), code('request_in_progress'))
    await protocol.finish(first.input); await protocol.finish(second.input)
    const v2 = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-page-key' })
    await assert.rejects(() => protocol.begin(ctx, { version: 1, body: { ...body(), query: 'different' }, idempotencyKey: 'new-page-key' }), code('idempotency_conflict'))
    await protocol.finish(v2.input, { state: 'unknown' })
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-page-key' }), code('request_outcome_unknown'))
    for (const version of [1, 2]) {
      const admitted = await protocol.begin(ctx, { version, body: { ...body(), timeWindow: { ...body().timeWindow, from: '2026-10-01T00:00:00Z' } },
        idempotencyKey: `changed-key-${version}` })
      assert.equal(admitted.kind, 'acquired')
      await protocol.finish(admitted.input, version === 2 ? { state: 'complete', result: result() } : undefined)
    }
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} a legacy unknown does not hold other keys and rejects old key migration`, options, async t => {
    const { ctx, protocol, addUsage } = await protocolFixture(t, postgres)
    const id = randomUUID()
    await addUsage({ id, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id, platform: 'facebook',
      idempotencyKey: 'legacy-unknown-key', status: 'unknown', acquisitionRequest: { path: DATA_SEARCH_V1_PATH,
        body: { platform: 'facebook', query: `\n\u00a0${body().query}\ufeff\t` } }, reservedAt: new Date(Date.now() - 60_000).toISOString() })
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'legacy-unknown-key' }), code('idempotency_conflict'))
    assert.equal((await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'legacy-unknown-key' })).kind, 'legacy')
    const released = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'new-unknown-key' })
    assert.equal(released.kind, 'acquired')
    await protocol.finish(released.input, { state: 'complete', result: result() })
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'legacy-unknown-key' }), code('idempotency_conflict'))
    assert.equal((await protocol.begin(ctx, { version: 1, body: body(), idempotencyKey: 'legacy-unknown-key' })).kind, 'legacy')
    await addUsage({ id: randomUUID(), consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id, platform: 'facebook',
      idempotencyKey: 'legacy-missing-query', status: 'unknown', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'facebook' } }, reservedAt: '2026-01-01T00:00:00Z' })
    const unrelated = await protocol.begin(ctx, { version: 2, body: { ...body(), query: 'a different search' }, idempotencyKey: 'new-unrelated-query' })
    assert.equal(unrelated.kind, 'acquired')
    await protocol.finish(unrelated.input, { state: 'complete', result: result() })
  })
  test(`protocol ${postgres ? 'actual PGlite' : 'memory'} stores exact delivery and rejects another API Key`, options, async t => {
    const { ctx, protocol } = await protocolFixture(t, postgres), response = result()
    const first = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' })
    await protocol.finish(first.input, { state: 'complete', result: response })
    const replay = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' })
    assert.deepEqual(replay.result, response)
    await assert.rejects(() => protocol.begin({ ...ctx, apiKey: { id: randomUUID() } }, { version: 2, body: body(), idempotencyKey: 'saved-v2-key' }), code('idempotency_conflict'))
  })
  if (postgres) test('expired PostgreSQL protocol lease keeps its own key unknown without holding other keys', options, async t => {
    const { ctx, protocol, expire, addUsage } = await protocolFixture(t, true)
    await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-v2-lease-key' })
    const requestId = randomUUID()
    await addUsage({ id: requestId, consumerId: ctx.consumer.id, apiKeyId: ctx.apiKey.id, tenantId: ctx.tenant.id,
      platform: 'facebook', idempotencyKey: 'expired-v2-lease-key', status: 'committed',
      acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { platform: 'facebook', query: body().query } }, reservedAt: '2026-10-17T00:00:00Z' })
    // Simulate a crash after underlying commit but before saving its UUID to
    // the protocol binding. Lookup by that UUID still finds protocol ownership.
    assert.equal((await protocol.bindingForUsage(ctx, requestId)).state, 'running')
    // A live lease still holds another key; an expired one is no longer in flight.
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-new-key' }), code('search_admission_blocked'))
    await expire()
    await assert.rejects(() => protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-v2-lease-key' }), code('request_outcome_unknown'))
    const later = await protocol.begin(ctx, { version: 2, body: body(), idempotencyKey: 'expired-new-key' })
    assert.equal(later.kind, 'acquired')
    await protocol.finish(later.input, { state: 'retryable' })
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
  const ctx = await service.authenticate(key.secret)
  const blocker = legacyRawUsage(ctx, { status: 'reserved', acquisitionRequest: { path: DATA_SEARCH_V1_PATH, body: { query: body().query } }, billingMeterKey: 'twitter' })
  store.requests.set(blocker.id, blocker); store.requestsByScope.set(`${ctx.consumer.id}:${blocker.idempotencyKey}`, blocker.id)
  // With no wait budget the caller sees the documented refusal itself.
  service.searchAdmissionWaitMs = 0
  const rejected = await fetch(`${origin}${DATA_SEARCH_V2_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}`, 'idempotency-key': 'http-admission-blocked-key' },
    body: JSON.stringify(body('twitter')) })
  const rejection = await rejected.json()
  assert.equal(rejected.status, 409); assert.equal(rejection.error.code, 'search_admission_blocked')
  assert.deepEqual(rejection.error.details, { dispatchState: 'not_started', automaticRetryAllowed: true,
    retrySameRequest: true, retryAfterSeconds: 300, blockingRequestId: blocker.id })
  assert.notEqual(rejection.requestId, blocker.id, 'the blocker is not this unstarted page request')
  assert.equal(rejected.headers.get('x-mx-insight-request-id'), null, 'no durable acquisition request was allocated')
  assert.equal(acquired.length, 4, 'admission rejection cannot call a supplier')
  // By default Hub waits for the equal search itself and then admits the page.
  service.searchAdmissionWaitMs = 10_000
  const ended = setTimeout(() => { blocker.status = 'committed' }, 300)
  t.after(() => clearTimeout(ended))
  const admitted = await fetch(`${origin}${DATA_SEARCH_V2_PATH}`, { method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key.secret}`, 'idempotency-key': 'http-admission-waits-key' },
    body: JSON.stringify(body('twitter')) })
  assert.equal(admitted.status, 200, JSON.stringify(await admitted.clone().json()))
  assert.equal(acquired.length, 5)
})

test('v2 machine documentation uses the explicit v2 server path and respects existing platform visibility', () => {
  const operation = PUBLIC_OPENAPI_DOCUMENT.paths[DATA_SEARCH_V2_PATH]
  assert.equal(operation.servers[0].url, '/')
  assert.equal(operation.post.operationId, 'searchDataV2')
  assert.ok(tenantOpenApiDocument([{ platforms: ['facebook'], capabilities: [] }]).paths[DATA_SEARCH_V2_PATH])
  assert.equal(tenantOpenApiDocument([{ platforms: ['ip_risk'], capabilities: [] }]).paths[DATA_SEARCH_V2_PATH], undefined)
})
