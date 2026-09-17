import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  ACQUISITION_REQUEST_MAX_BYTES,
  acquisitionRequestSnapshot,
} from '../../server/acquisitions/request-snapshot.mjs'
import {
  nightAllCompatibilityRequestFingerprint,
  nightAllCompatibilityRoute,
  verifyAcquisitionRequestCandidate,
} from '../../server/acquisitions/request-verification.mjs'
import { canonicalPlatform } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'

const RAW_PATH = '/api/v1/night-all/search/raw'
const BUSINESS_ID = 'consumer-a'

function fingerprintOf(body, path = RAW_PATH) {
  return nightAllCompatibilityRequestFingerprint({
    path, body, businessId: BUSINESS_ID, canonicalizePlatform: canonicalPlatform,
  }).fingerprint
}

test('a snapshot keeps the route and parsed body and nothing else', () => {
  assert.deepEqual(
    acquisitionRequestSnapshot({ method: 'POST', path: RAW_PATH, body: { platform: 'xiaohongshu', keyword: '旅游', count: 20 } }),
    { method: 'POST', path: RAW_PATH, body: { platform: 'xiaohongshu', keyword: '旅游', count: 20 } },
  )
  // Nothing to reproduce, so nothing is stored.
  for (const input of [undefined, {}, { method: 'POST', path: RAW_PATH }, { method: 'POST', path: RAW_PATH, body: [] },
    { method: 'POST', path: RAW_PATH, body: 'text' }, { method: '', path: RAW_PATH, body: {} }]) {
    assert.equal(acquisitionRequestSnapshot(input), null)
  }
})

test('credential-shaped fields are redacted and the rest stays reproducible', () => {
  const snapshot = acquisitionRequestSnapshot({
    method: 'POST',
    path: RAW_PATH,
    body: {
      platform: 'xiaohongshu',
      keyword: '旅游',
      apiKey: 'mih_live_should_not_persist',
      nested: { access_key: 'also-secret', page: 1 },
      list: [{ token: 'secret', keep: true }],
    },
  })
  assert.deepEqual(snapshot.body, {
    platform: 'xiaohongshu',
    keyword: '旅游',
    apiKey: '[redacted]',
    nested: { access_key: '[redacted]', page: 1 },
    list: [{ token: '[redacted]', keep: true }],
  })
  assert.equal(JSON.stringify(snapshot).includes('should_not_persist'), false)
})

test('an oversized body is a measured omission, never a truncated lie', () => {
  const snapshot = acquisitionRequestSnapshot({
    method: 'POST', path: RAW_PATH, body: { keyword: 'x'.repeat(ACQUISITION_REQUEST_MAX_BYTES + 1) },
  })
  assert.equal(snapshot.body, undefined)
  assert.equal(snapshot.bodyOmitted, 'oversize')
  assert.ok(snapshot.bodyBytes > ACQUISITION_REQUEST_MAX_BYTES)
})

test('a reservation stores the request parameters and a replay cannot rewrite them', async () => {
  const store = new MemoryStore()
  const tenant = await store.createTenant({ name: 'Tenant A' })
  const consumer = await store.createConsumer({ tenantId: tenant.id, name: 'Consumer A', businessId: BUSINESS_ID })
  const apiKey = await store.createApiKey({ consumerId: consumer.id, name: 'key', hash: 'h'.repeat(64), prefix: 'mih_live', lastFour: 'abcd' })
  await store.replaceGrants(consumer.id, ['xiaohongshu'])
  const acquisitionRequest = acquisitionRequestSnapshot({
    method: 'POST', path: RAW_PATH, body: { platform: 'xiaohongshu', keyword: '旅游' },
  })
  const reservation = {
    idempotencyKey: 'stored-parameters-1',
    fingerprint: 'f'.repeat(64),
    tenantId: tenant.id,
    consumerId: consumer.id,
    apiKeyId: apiKey.id,
    platform: 'xiaohongshu',
    unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000),
    windowStart: new Date(Date.now() - 60_000),
    maxRequests: 100,
  }
  const first = await store.reserve({ ...reservation, requestId: crypto.randomUUID(), acquisitionRequest })
  assert.equal(first.kind, 'reserved')
  assert.deepEqual(store.requests.get(first.request.id).acquisitionRequest, acquisitionRequest)
  // The same key with the same fingerprint is the same paid request; its
  // recorded parameters must stay exactly what the first reservation stored.
  const replayed = await store.reserve({
    ...reservation,
    requestId: crypto.randomUUID(),
    acquisitionRequest: acquisitionRequestSnapshot({ method: 'POST', path: RAW_PATH, body: { platform: 'xiaohongshu', keyword: '改过的关键词' } }),
  })
  assert.notEqual(replayed.kind, 'reserved')
  assert.equal(store.requests.get(first.request.id).acquisitionRequest.body.keyword, '旅游')
})

test('a candidate body is confirmed only when it reproduces the stored fingerprint', () => {
  const body = { platform: 'xiaohongshu', keyword: '旅游', page: 1, count: 20 }
  const storedFingerprint = fingerprintOf(body)
  const verify = (candidate) => verifyAcquisitionRequestCandidate({
    storedFingerprint, path: RAW_PATH, body: candidate,
    businessId: BUSINESS_ID, canonicalizePlatform: canonicalPlatform,
  })
  assert.equal(verify(body).match, true)
  // Platform aliases canonicalize exactly as the dispatch path did.
  assert.equal(verify({ ...body, platform: 'xhs' }).match, true)
  assert.equal(verify({ ...body, keyword: '不同关键词' }).match, false)
  assert.equal(verify({ ...body, count: 10 }).match, false)
  // A mismatch never discloses the original parameters.
  assert.equal(JSON.stringify(verify({ ...body, keyword: '不同关键词' })).includes('旅游'), false)
})

test('verification refuses routes and cursors it cannot canonicalize', () => {
  assert.equal(nightAllCompatibilityRoute('/api/v1/night-all/search/raw').operation, 'raw')
  assert.equal(nightAllCompatibilityRoute('/api/v1/search/crawl').canonicalPath, '/api/v1/night-all/search/crawl')
  assert.equal(nightAllCompatibilityRoute('/api/v1/data/ecommerce/products/search'), null)
  const rejected = verifyAcquisitionRequestCandidate({
    storedFingerprint: 'a'.repeat(64),
    path: '/api/v1/data/ecommerce/products/search',
    body: { platform: 'xiaohongshu' },
    businessId: BUSINESS_ID,
    canonicalizePlatform: canonicalPlatform,
  })
  assert.equal(rejected.match, false)
  assert.equal(rejected.rejected.code, 'unsupported_verification_route')
  const cursored = verifyAcquisitionRequestCandidate({
    storedFingerprint: 'a'.repeat(64),
    path: RAW_PATH,
    body: { platform: 'xiaohongshu', keyword: '旅游', cursor: 'mxnac1.something' },
    businessId: BUSINESS_ID,
    canonicalizePlatform: canonicalPlatform,
  })
  assert.equal(cursored.match, false)
  assert.equal(typeof cursored.rejected.code, 'string')
})

test('the public alias and the night-all spelling share one request identity', () => {
  const body = { platform: 'xiaohongshu', keyword: '旅游' }
  assert.equal(fingerprintOf(body, '/api/v1/search/raw'), fingerprintOf(body, RAW_PATH))
})
