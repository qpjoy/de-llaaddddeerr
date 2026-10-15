import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { PostgresAcquisitionHistoryStore } from '../../server/acquisitions/history-store.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { normalizeHubDataSearch } from '../../server/contracts/hub-data-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'

const PATH = '/api/v1/data/search', PEPPER = 'twitter-retry-test-pepper-at-least-32-bytes'
function fixture({ status = 'unknown', body = { platform: 'twitter', query: 'SMIC #chipban', pageSize: 20 }, snapshot, successor = null, contract = {}, fail = null } = {}) {
  const root = { id: randomUUID(), tenant_id: randomUUID(), consumer_id: randomUUID(), api_key_id: randomUUID(),
    platform: 'twitter', status, idempotency_key: 'original-idempotency',
    acquisition_request: snapshot === undefined ? { method: 'POST', path: PATH, body } : snapshot,
    fingerprint: requestFingerprint({ method: 'POST', path: PATH, body: { ...body, type: body.type ?? 'fresh' } }),
    api_key_prefix: 'mih_live_', api_key_last_four: '4321' }
  const call = { provider_key: 'rapidapi', operation: 'social.content.search', contract_version: 'mx-insight-hub.social-data.v1',
    endpoint_key: 'twitter-aio.search', endpoint_version: 'twitter-aio.hub.v1', tenant_id: root.tenant_id,
    consumer_id: root.consumer_id, api_key_id: root.api_key_id, outcome: 'unknown', ...contract }
  const queries = [], client = { release() {}, async query(sql, values = []) {
    queries.push({ sql, values })
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/u)
    if (sql.includes('twitter-retry:root')) return { rows: [root] }
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
  return { root, queries, history: new PostgresAcquisitionHistoryStore(pool, { apiKeyPepper: PEPPER }) }
}

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
