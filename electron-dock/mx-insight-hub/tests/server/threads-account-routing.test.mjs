import assert from 'node:assert/strict'
import test from 'node:test'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'
import { nativeForwardingEndpoint } from '../../server/contracts/native-forwarding.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, threadsAccountRecipe } from '../../server/contracts/hub-social-compat.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { withSinglePage } from '../../server/contracts/single-page-delivery.mjs'
import { createDataSearchCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { normalizeSocialAccountDelivery, socialAccountPlan } from '../../server/external-platforms/social-account-delivery.mjs'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'

const pepper = 'offline-threads-routing-fixture-at-least-32-bytes'
const context = { tenant: { id: 'tenant' }, consumer: { id: 'consumer', businessId: 'example' }, apiKey: { id: 'key' } }
const recent = '/api/user/replies', reposts = '/api/user/reposts', lookup = '/api/search/profiles'
const tik = '/api/v1/threads/web/'

async function harness(t, disabled = [], legacyOperation = null) {
  const runtime = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public', MX_INSIGHT_API_KEY_PEPPER: pepper }))
  t.after(async () => { runtime.agent.close(); await runtime.store.close() })
  if (legacyOperation) await runtime.strategySearchRoutingStore.update(legacyOperation, 'threads', {
    mode: 'priority', primaryProvider: 'rapidapi', fallbackProvider: 'tikhub', expectedRevision: 1, reason: 'Exercise original account routing',
  })
  const checks = []
  for (const [provider, gateway] of Object.entries(runtime.threadsGateways)) {
    gateway.nativeReadiness = async ({ consumerId, operationKeys }) => {
      assert.equal(consumerId, context.consumer.id)
      const paths = operationKeys.map(key => nativeForwardingEndpoint(key.slice('native.'.length)).path)
      checks.push({ provider, paths })
      return Object.fromEntries(operationKeys.map((key, index) => [key, !disabled.includes(paths[index])]))
    }
    gateway.socialAccountData = async (_, input) => input.routing?.provider ?? provider
  }
  const send = (operation, body, idempotencyKey) => runtime.socialDataGateway.socialData(context, {
    operation, body: { platform: 'threads', ...body }, path: `/api/v1/data/social/${operation}`, idempotencyKey,
  })
  return { checks, runtime, send }
}

test('account routing checks requested activities and handle lookup for the whole batch', async t => {
  const h = await harness(t, [reposts], 'crawl')
  assert.equal(await h.send('crawl', { username: 'alice', userId: '42', activityTypes: ['replies', 'reposts'] }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths.sort()), [
    [lookup, recent, reposts].sort(),
    ['fetch_user_replies', 'fetch_user_reposts', 'fetch_user_info'].map(name => tik + name).sort(),
  ])
  h.checks.length = 0
  assert.equal(await h.send('crawl', { userId: '42', activityTypes: ['replies'] }), 'rapidapi')
  assert.deepEqual(h.checks, [{ provider: 'rapidapi', paths: [recent] }])
})

test('Threads Scraper checks one direct username endpoint and falls back before dispatch for unsupported batches', async t => {
  const h = await harness(t)
  for (const operation of ['crawl', 'user-info']) {
    await h.runtime.strategySearchRoutingStore.update(operation, 'threads', { mode: 'priority',
      primaryProvider: THREADS_SCRAPER_ROUTE, fallbackProvider: 'rapidapi', expectedRevision: 1, reason: 'Offline listing test' })
    h.checks.length = 0
    assert.equal(await h.send(operation, { profileUrl: 'https://www.threads.net/@Alice' }), THREADS_SCRAPER_ROUTE)
    assert.deepEqual(h.checks, [{ provider: 'rapidapi', paths: [operation === 'crawl' ? '/api/v1/users/posts' : '/api/v1/users/detail'] }])
    h.checks.length = 0
    assert.equal(await h.send(operation, { username: 'alice', userId: '42' }), 'rapidapi')
    assert.equal(h.checks.length, 1)
    assert.ok(h.checks[0].paths.every(path => !path.startsWith('/api/v1/users/')))
  }
  for (const activity of ['replies', 'reposts']) {
    h.checks.length = 0
    assert.equal(await h.send('crawl', { username: 'alice', activityTypes: ['posts', activity] }), 'rapidapi')
    assert.equal(h.checks.length, 1)
    assert.ok(!h.checks[0].paths.includes('/api/v1/users/posts'))
  }
})

test('a fixed Threads Scraper source rejects unsupported inputs before a reservation or profile lookup', () => {
  for (const [operation, fields] of [
    ['user-info', { userId: '42' }], ['crawl', { userId: '42' }],
    ['crawl', { username: 'alice', activityTypes: ['posts', 'reposts'] }],
    ['crawl', { username: 'alice', activityTypes: ['replies'] }],
  ]) {
    const body = { platform: 'threads', ...fields }
    const normalized = normalizeHubSocialCompatRequest(operation, body)
    assert.equal(threadsAccountRecipe('threads', THREADS_SCRAPER_ROUTE, normalized).available, false)
    assert.throws(() => socialAccountPlan({ gateway: { providerKey: 'rapidapi' }, context, input: {
      operation, body, path: `/api/v1/data/social/${operation}`, routing: { provider: THREADS_SCRAPER_ROUTE },
    } }), { code: 'threads_account_input_unsupported', details: { platform: 'threads', upstreamDispatched: false } })
  }
})

test('Threads Scraper account continuations and receipt replay stay on the purchased listing after a route change', async t => {
  const h = await harness(t), path = '/api/v1/data/social/crawl'
  const body = { platform: 'threads', username: 'Alice', count: 1 }
  const codec = createDataSearchCursorCodec(pepper, 'consumer:key:social:crawl')
  const normalize = (provider, input) => normalizeSocialAccountDelivery('crawl', input, { provider, codec, context, maxPageSize: 10 })
  const first = normalize(THREADS_SCRAPER_ROUTE, body)
  const saved = { platform: 'threads', tenantId: 'tenant', apiKeyId: 'key', acquisitionRequest: { path },
    fingerprint: requestFingerprint({ method: 'POST', path, body: withSinglePage(first, true).fingerprintBody }) }
  t.mock.method(h.runtime.store, 'getUsageRequestByIdempotencyKey', async () => saved)
  assert.equal(await h.send('crawl', body, 'scraper-receipt'), THREADS_SCRAPER_ROUTE)
  const cursor = first.encodeNext('7fad7d72-15b0-4a18-abce-a8081eadad22')
  assert.equal(await h.send('crawl', { ...body, cursor }, 'scraper-continuation'), THREADS_SCRAPER_ROUTE)
  const second = normalize(THREADS_SCRAPER_ROUTE, { ...body, cursor })
  assert.equal(second.scopeHash, first.scopeHash)
  assert.equal(second.jobs[0].provider, 'rapidapi')
  assert.deepEqual(buildHubSocialCompatDispatch(second.jobs[0], { nextParams: { cursor: 'supplier-page' } }).upstreamQuery,
    { username: 'alice', cursor: 'supplier-page' })
  assert.throws(() => normalize('rapidapi', { ...body, cursor }), { code: 'invalid_cursor' })
  assert.deepEqual(h.checks, [])
})

test('numeric profile and handle resolution use their own readiness controls on both suppliers', async t => {
  const h = await harness(t, [lookup, '/api/user/info'], 'user-info')
  assert.equal(await h.send('user-info', { userId: '42' }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths), [['/api/user/info'], [tik + 'fetch_user_info_by_id']])
  h.checks.length = 0
  assert.equal(await h.send('user-info', { profileUrl: 'https://www.threads.com/@alice' }), 'tikhub')
  assert.deepEqual(h.checks.map(row => row.paths), [[lookup, '/api/user/info'], [tik + 'fetch_user_info']])
})

test('a signed continuation and a saved first-page receipt stay on the original supplier', async t => {
  const h = await harness(t)
  const codec = createDataSearchCursorCodec(pepper, 'consumer:key:social:crawl')
  const cursor = codec.encode({ provider: 'tikhub' })
  assert.equal(await h.send('crawl', { userId: '42', params: { cursor } }), 'tikhub')
  const body = { platform: 'threads', userId: '42' }, path = '/api/v1/data/social/crawl'
  const original = normalizeHubSocialCompatRequest('crawl', body, { businessId: 'example', provider: 'tikhub' })
  const saved = { platform: 'threads', tenantId: 'tenant', apiKeyId: 'key', acquisitionRequest: { path },
    fingerprint: requestFingerprint({ method: 'POST', path, body: withSinglePage(original, true).fingerprintBody }) }
  t.mock.method(h.runtime.store, 'getUsageRequestByIdempotencyKey', async () => saved)
  assert.equal(await h.send('crawl', body, 'existing-account-delivery'), 'tikhub')
  assert.deepEqual(h.checks, [], 'replay and continuations are independent of current provider readiness')
})
