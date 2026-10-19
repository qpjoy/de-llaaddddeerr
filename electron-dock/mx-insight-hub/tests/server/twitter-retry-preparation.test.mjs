import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PostgresAcquisitionHistoryStore } from '../../server/acquisitions/history-store.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { DATA_SEARCH_V2_PATH, DATA_SEARCH_V2_VERSION, dataSearchV2Scope, normalizeDataSearchV2, prepareDataSearchV2 } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'

const PATH = '/api/v1/data/search', PEPPER = 'twitter-retry-test-pepper-at-least-32-bytes'
function fixture({ status = 'unknown', body = { platform: 'twitter', query: 'SMIC #chipban', pageSize: 20 }, snapshot, successor = null, contract = {}, fail = null,
  v2 = null, bindingPatch = {}, intent = null, intentSchema = true, resumeProof = true } = {}) {
  const root = { id: randomUUID(), tenant_id: randomUUID(), consumer_id: randomUUID(), api_key_id: randomUUID(),
    platform: 'twitter', status, idempotency_key: 'original-idempotency',
    acquisition_request: snapshot === undefined ? { method: 'POST', path: PATH, body } : snapshot,
    fingerprint: requestFingerprint({ method: 'POST', path: PATH, body: { ...body, type: body.type ?? 'fresh' } }),
    api_key_prefix: 'mih_live_', api_key_last_four: '4321' }
  const protocolBody = v2 && normalizeDataSearchV2(v2)
  let binding = null
  if (protocolBody) {
    const codec = createDataSearchV2CursorCodec(PEPPER, `${root.consumer_id}:${root.api_key_id}`)
    root.acquisition_request = { method: 'POST', path: PATH, body: prepareDataSearchV2(protocolBody, codec).upstream }
    root.fingerprint = requestFingerprint(root.acquisition_request)
    binding = { usage_request_id: root.id, tenant_id: root.tenant_id, consumer_id: root.consumer_id,
      api_key_id: root.api_key_id, platform: 'twitter', state: 'unknown', idempotency_key: root.idempotency_key,
      request_body: protocolBody, fingerprint: requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body: protocolBody }), ...bindingPatch }
  }
  const call = { provider_key: 'rapidapi', operation: 'social.content.search', contract_version: 'mx-insight-hub.social-data.v1',
    endpoint_key: 'twitter-aio.search', endpoint_version: 'twitter-aio.hub.v1', tenant_id: root.tenant_id,
    consumer_id: root.consumer_id, api_key_id: root.api_key_id, outcome: 'unknown', ...contract }
  const queries = [], client = { release() {}, async query(sql, values = []) {
    queries.push({ sql, values })
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u)
    if (sql.includes('twitter-retry:root')) return { rows: [root] }
    if (sql.includes('twitter-v2-retry:resume-proof')) return { rows: [{ allowed: resumeProof }] }
    if (sql.includes("to_regclass('control.data_search_protocol_bindings')")) return { rows: [{ present: Boolean(binding) }] }
    if (sql.includes("to_regclass('control.data_search_protocol_retries')")) return { rows: [{ present: intentSchema }] }
    if (sql.includes('FROM control.data_search_protocol_retries')) return { rows: intent ? [{
      successor_idempotency_key: 'new-v2-retry-key', api_key_id: root.api_key_id, state: 'running', usage_request_id: null, ...intent,
    }] : [] }
    if (sql.includes('FROM control.data_search_protocol_bindings')) return { rows: binding ? [binding] : [] }
    if (sql.includes('twitter_manual_retries')) {
      if (fail) throw Object.assign(new Error('private database connection detail'), { code: fail })
      return { rows: sql.includes('original_usage_request_id=$1') && successor ? [{ successor_usage_request_id: successor.id }] : [] }
    }
    if (sql.includes('twitter-retry:successor')) return { rows: successor ? [successor] : [] }
    if (sql.includes('FROM usage_requests WHERE id=$1')) return { rows: [root] }
    if (sql.includes('provider_calls WHERE retry_of_usage_request_id')) return { rows: [] }
    if (sql.includes('provider_calls WHERE usage_request_id')) return { rows: [call] }
    if (/^(BEGIN|COMMIT|ROLLBACK|SET LOCAL)\b/u.test(sql)) return { rows: [] }
    assert.fail(`Unexpected SQL: ${sql}`)
  } }
  const pool = { query: (...args) => client.query(...args), connect: async () => client }
  return { root, binding, queries, history: new PostgresAcquisitionHistoryStore(pool, { apiKeyPepper: PEPPER }) }
}

const v2Body = { platform: 'twitter', query: 'SMIC #chipban', pageSize: 20, type: 'fresh',
  timeWindow: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } }

test('v2 preparation returns only the validated original public window/body and original API Key', async () => {
  const f = fixture({ v2: v2Body }), before = structuredClone(f.root)
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, true)
  assert.equal(result.requestEvidence.contractVersion, 'mx-insight-hub.data-search.v2')
  assert.deepEqual(result.requestEvidence.request, { method: 'POST', path: DATA_SEARCH_V2_PATH, body: normalizeDataSearchV2(v2Body) })
  assert.equal(result.owner.apiKeyId, f.root.api_key_id)
  assert.deepEqual(f.root, before)
  assert.equal(result.retryIntent, null)
  assert.match(f.queries[0].sql, /READ ONLY/u)
})

test('v2 preparation rejects mismatched binding, projection-only unknown and missing original evidence', async () => {
  for (const overrides of [{ status: 'committed' }, { bindingPatch: { state: 'complete' } },
    { bindingPatch: { api_key_id: randomUUID() } }, { bindingPatch: { usage_request_id: randomUUID() } },
    { bindingPatch: { fingerprint: 'a'.repeat(64) } }, { bindingPatch: { request_body: { ...v2Body, timeWindow: null } } }]) {
    const f = fixture({ v2: v2Body, ...overrides })
    const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
    assert.equal(result.eligibility.allowed, false)
    assert.equal(result.requestEvidence.request, null)
  }
})

test('a v2 intent before procurement blocks another retry and retains its stable key for read-only checks', async () => {
  const f = fixture({ v2: v2Body, intent: {} })
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.successor, null)
  assert.deepEqual(result.retryIntent, { idempotencyKey: 'new-v2-retry-key', apiKeyId: f.root.api_key_id,
    state: 'running', requestId: null, usageStatus: null, resumeAllowed: false })
  assert.equal(result.requestEvidence.request.path, DATA_SEARCH_V2_PATH)
  assert.equal(f.queries.some(({ sql }) => /\b(INSERT|UPDATE|DELETE)\b/u.test(sql)), false)
})

test('v2 preparation exposes protocol outcome separately from a committed successor usage', async () => {
  const successor = { id: randomUUID(), status: 'committed', idempotency_key: 'new-v2-retry-key', api_key_id: null, response_status: 200 }
  const f = fixture({ v2: v2Body, successor, intent: { state: 'unknown', usage_request_id: successor.id } })
  successor.api_key_id = f.root.api_key_id
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.retryIntent.state, 'unknown')
  assert.equal(result.successor.status, 'committed')
  assert.equal(result.retryIntent.requestId, result.successor.requestId)
})

test('v2 preparation requires the permanent retry-intent migration before offering another paid request', async () => {
  const f = fixture({ v2: v2Body, intentSchema: false })
  await assert.rejects(f.history.getAdminTwitterRetryPreparation(f.root.id), error => error.status === 503)
})

test('v2 same-key resume requires a retryable intent and positive no-procurement evidence', async () => {
  for (const [intent, resumeProof, expected] of [
    [{ state: 'retryable' }, true, true],
    [{ state: 'retryable' }, false, false],
    [{ state: 'retryable', usage_request_id: randomUUID(), usage_status: 'released' }, true, true],
    ...['running', 'unknown', 'complete', 'failed'].map(state => [{ state }, true, false]),
    ...['reserved', 'unknown', 'committed'].map(usage_status => [{ state: 'retryable', usage_request_id: randomUUID(), usage_status }, true, false]),
  ]) {
    const f = fixture({ v2: v2Body, intent, resumeProof })
    const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
    assert.equal(result.eligibility.allowed, false)
    assert.equal(result.retryIntent.resumeAllowed, expected)
  }
})

test('an expired original v2 cursor still permits read-only inspection of its existing retry intent', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() })
  const f = fixture({ v2: v2Body, intent: { state: 'retryable' } })
  const scope = `${f.root.consumer_id}:${f.root.api_key_id}`
  const innerCodec = createDataSearchCursorCodec(PEPPER, scope)
  const inner = normalizeHubDataSearch({ platform: 'twitter', query: v2Body.query, pageSize: v2Body.pageSize }, innerCodec, 'stable')
  const cursor = inner.encodeNext({ page: 2, providerCursor: 'original-next-cursor' })
  const outerCodec = createDataSearchV2CursorCodec(PEPPER, scope)
  const originalBody = { ...normalizeDataSearchV2(v2Body), cursor: outerCodec.encode({ version: DATA_SEARCH_V2_VERSION,
    scope: dataSearchV2Scope(v2Body), expiresAt: Date.now() + 60_000, page: 2, cursor }) }
  f.binding.request_body = originalBody
  f.binding.fingerprint = requestFingerprint({ method: 'POST', path: DATA_SEARCH_V2_PATH, body: originalBody })
  f.root.acquisition_request.body = prepareDataSearchV2(originalBody, outerCodec).upstream
  f.root.fingerprint = requestFingerprint(f.root.acquisition_request)
  t.mock.timers.tick(61_000)
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.retryIntent.idempotencyKey, 'new-v2-retry-key')
  assert.equal(result.retryIntent.resumeAllowed, false)
  assert.deepEqual(result.requestEvidence.request.body, originalBody)
})

test('Twitter retry preparation is READ ONLY, accepts missing transport evidence and returns original parameters without secrets', async () => {
  const f = fixture(), before = structuredClone(f.root)
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, true)
  assert.deepEqual(result.requestEvidence.request, f.root.acquisition_request)
  assert.equal(result.owner.apiKeyId, f.root.api_key_id)
  assert.equal(result.successor, null)
  assert.deepEqual(f.root, before)
  assert.equal(f.queries[0].sql, 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(f.queries.at(-1).sql, 'COMMIT')
  assert.doesNotMatch(JSON.stringify(result), /response_body|raw_payload|secret|headers/u)
  await assert.rejects(f.history.getAdminTwitterRetryPreparation('not-a-uuid'), { code: 'invalid_request_id' })
})

test('missing snapshot, different route, mismatched identity, old contract and non-unknown state cannot authorize retry', async () => {
  for (const overrides of [
    { snapshot: null }, { snapshot: { method: 'POST', path: PATH, bodyOmitted: 'oversize' } },
    { snapshot: { method: 'POST', path: '/api/v1/search/raw', body: { platform: 'twitter', query: 'SMIC' } } },
    { status: 'reserved' }, { status: 'committed' }, { contract: { api_key_id: randomUUID() } },
    { contract: { endpoint_version: 'old' } }, { contract: { provider_key: 'night-all' } },
  ]) {
    const f = fixture(overrides), result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
    assert.equal(result.eligibility.allowed, false)
    assert.equal(result.successor, null)
  }
  const f = fixture()
  f.root.fingerprint = 'b'.repeat(64)
  assert.equal((await f.history.getAdminTwitterRetryPreparation(f.root.id)).eligibility.allowed, false)
})

test('claimed successor is a read-only receipt, including an unknown result and an expired original cursor', async () => {
  const successor = { id: randomUUID(), status: 'unknown', idempotency_key: 'new-manual-idem', api_key_id: null, response_status: null }
  const f = fixture({ body: { platform: 'twitter', query: 'SMIC', pageSize: 20, cursor: 'mxds1.expired' }, successor })
  successor.api_key_id = f.root.api_key_id
  const result = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(result.eligibility.allowed, false)
  assert.equal(result.eligibility.reasonCode, 'twitter_retry_already_claimed')
  assert.deepEqual(result.successor, { requestId: successor.id, status: 'unknown', idempotencyKey: 'new-manual-idem', apiKeyId: f.root.api_key_id, responseStatus: null })
  const query = f.queries.find(entry => entry.sql.includes('twitter-retry:successor'))
  assert.deepEqual(query.values, [successor.id, f.root.tenant_id, f.root.consumer_id, f.root.api_key_id, f.root.fingerprint])
})

test('valid original continuation is authenticated under original Key; corrupt and expired cursors cannot prepare', async () => {
  const f = fixture(), body = f.root.acquisition_request.body
  const codec = createDataSearchCursorCodec(PEPPER, `${f.root.consumer_id}:${f.root.api_key_id}`)
  const request = normalizeHubDataSearch(body, codec, 'fresh')
  body.cursor = request.encodeNext({ page: 2, providerCursor: 'supplier-next' })
  f.root.fingerprint = requestFingerprint({ method: 'POST', path: PATH, body: { ...body, type: 'fresh' } })
  assert.equal((await f.history.getAdminTwitterRetryPreparation(f.root.id)).eligibility.allowed, true)
  const state = codec.decode(body.cursor)
  body.cursor = codec.encode({ ...state, expiresAt: Date.now() - 1 })
  const denied = await f.history.getAdminTwitterRetryPreparation(f.root.id)
  assert.equal(denied.eligibility.allowed, false)
  assert.equal(denied.eligibility.reasonCode, 'invalid_cursor')
})

test('missing migration and query timeout fail safely without returning database messages', async () => {
  for (const [code, expected] of [['42P01', 'twitter_retry_schema_unavailable'], ['57014', 'twitter_retry_lookup_busy']]) {
    const f = fixture({ fail: code })
    await assert.rejects(f.history.getAdminTwitterRetryPreparation(f.root.id), error => error.status === 503
      && error.code === expected && !/private database/u.test(error.message))
    assert.equal(f.queries.at(-1).sql, 'ROLLBACK')
  }
})

test('service routes Retry-Of only to Twitter standard search and still enforces current grants and page limits', async () => {
  const store = new MemoryStore(), sent = []
  const service = new HubService({ store, apiKeyPepper: PEPPER,
    adapter: { search: async () => assert.fail('must not call Night-All') },
    externalDataSearch: async (...args) => { sent.push(args); return { status: 200 } } })
  try {
    const tenant = await service.createTenant({ name: 'Retry test' })
    const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Retry caller' })
    await service.putPlatformConfiguration('twitter', { tenantId: tenant.id, consumerId: consumer.id,
      enabled: true, maxRequests: 100, windowSeconds: 60, maxPageSize: 20 })
    const key = await service.createApiKey({ consumerId: consumer.id, name: 'Retry Key', platforms: ['twitter'], capabilities: [] })
    const context = await service.authenticate(key.secret)
    const input = { path: PATH, idempotencyKey: 'new-manual-idem', retryOfRequestId: randomUUID(), body: { platform: 'twitter', query: 'SMIC', pageSize: 20 } }
    await service.search(context, input)
    assert.equal(sent[0][1].retryOfRequestId, input.retryOfRequestId)
    assert.deepEqual(sent[0][1].body, input.body)
    for (const changed of [{ body: { platform: 'facebook', query: 'SMIC' } }, { path: '/api/v1/search/raw' }, { responseFormat: 'raw' }]) {
      await assert.rejects(service.search(context, { ...input, ...changed }), { code: 'uncertain_retry_not_supported' })
    }
    await assert.rejects(service.search(context, { ...input, body: { ...input.body, pageSize: 21 } }), { code: 'page_size_exceeded' })
    await service.putPlatformConfiguration('twitter', { tenantId: tenant.id, consumerId: consumer.id,
      enabled: false, maxRequests: 100, windowSeconds: 60, maxPageSize: 20 })
    await assert.rejects(service.search(context, input), { code: 'platform_not_granted' })
    assert.equal(sent.length, 1)
  } finally { await store.close() }
})
