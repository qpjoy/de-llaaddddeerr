import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import test from 'node:test'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'
import { buildThreadsSearchDispatch, THREADS_SEARCH_VERSION } from '../../server/contracts/threads-search.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { normalizeThreadsSearchDelivery, threadsSearchCursorProvider, threadsSearchPlan } from '../../server/external-platforms/threads-search-workflow.mjs'

const context = { apiKey: { id: 'key' }, consumer: { id: 'consumer' } }
const gateway = { providerKey: 'rapidapi', apiKeyPepper: 'local-threads-listing-unit-test-pepper', operationControlStore: {} }
const codec = createDataSearchCursorCodec(gateway.apiKeyPepper, 'consumer:key:threads-search')
const body = { platform: 'threads', query: 'test', pageSize: 1 }
const options = { resultType: 'stable', provider: 'rapidapi', codec }

test('saved Threads cursor and purchase scope from the original release still resolve to threads-api4', () => {
  const scopeHash = createHash('sha256').update(JSON.stringify({
    version: THREADS_SEARCH_VERSION, provider: 'rapidapi', query: body.query, pageSize: body.pageSize, type: 'stable',
  })).digest('hex')
  const previousDeliveryId = randomUUID()
  const cursor = codec.encode({ version: THREADS_SEARCH_VERSION, scopeHash, provider: 'rapidapi',
    page: 2, expiresAt: Date.now() + 60000, previousDeliveryId })
  assert.equal(threadsSearchCursorProvider({ cursor }, { gateway, context }), 'rapidapi')
  const continued = normalizeThreadsSearchDelivery({ ...body, cursor }, options)
  assert.equal(continued.previousDeliveryId, previousDeliveryId)
  assert.equal(continued.jobs[0].id, scopeHash)
  const step = buildThreadsSearchDispatch(continued, {}, { providerCursor: { end_cursor: 'saved-end-cursor' } })
  assert.equal(step.key, 'r.threads_search_recent')
  assert.deepEqual(step.upstreamQuery, { query: body.query, end_cursor: 'saved-end-cursor' })
  assert.throws(() => normalizeThreadsSearchDelivery({ ...body, cursor }, { ...options, routeProvider: THREADS_SCRAPER_ROUTE }),
    { code: 'invalid_cursor' })
})

test('Threads Scraper pins the listing for cursor and saved overflow while preserving the customer request fingerprint', () => {
  const input = { normalized: body, body, dataSearch: { resultType: 'stable' }, routing: { provider: THREADS_SCRAPER_ROUTE } }
  const { plan } = threadsSearchPlan({ gateway, context, input })
  const first = plan.normalize({ policy: { maxPageSize: 20 } })
  const original = normalizeThreadsSearchDelivery(body, options)
  assert.equal(plan.operation, 'native.r.threads_scraper_search_posts')
  assert.equal(first.provider, 'rapidapi')
  assert.deepEqual(first.fingerprintBody, original.fingerprintBody)
  assert.notEqual(first.scopeHash, original.scopeHash)
  const cursor = first.encodeNext(randomUUID())
  assert.equal(threadsSearchCursorProvider({ cursor }, { gateway, context }), THREADS_SCRAPER_ROUTE)
  const next = normalizeThreadsSearchDelivery({ ...body, cursor }, { ...options, routeProvider: THREADS_SCRAPER_ROUTE })
  const step = buildThreadsSearchDispatch(next, { providerCursor: { cursor: 'next-live' } },
    { providerCursor: { cursor: 'saved-page' } })
  assert.equal(step.provider, 'rapidapi')
  assert.equal(step.platform, 'threads')
  assert.equal(step.marketplace, 'threads-scraper')
  assert.deepEqual(step.upstreamQuery, { query: body.query, cursor: 'saved-page' })
  assert.equal(step.endpointKey, plan.operation)
  assert.throws(() => normalizeThreadsSearchDelivery({ ...body, cursor }, options), { code: 'invalid_cursor' })
  assert.throws(() => threadsSearchPlan({ gateway: { ...gateway, providerKey: 'tikhub' }, context, input }),
    { code: 'content_search_unavailable' })
})
