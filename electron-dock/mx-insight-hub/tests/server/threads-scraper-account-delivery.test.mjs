import assert from 'node:assert/strict'
import test from 'node:test'
import { RapidApiAdapter, RapidApiUpstreamError } from '../../server/adapters/rapidapi.mjs'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { loadConfig } from '../../server/config.mjs'
import { createRuntime } from '../../server/index.mjs'
import { THREADS_SCRAPER_ROUTE } from '../../shared/threads-search-routing.mjs'

test('Threads Scraper delivers profiles and posts under business grants, replays purchases, and drains bought overflow', async t => {
  const credential = 'offline-threads-account-credential'
  const hub = await createRuntime(loadConfig({ MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'offline-threads-account-integration-pepper', MX_INSIGHT_RAPIDAPI_API_KEY: credential }))
  t.after(async () => { hub.agent.close(); await hub.store.close() })
  const gateway = hub.threadsGateways.rapidapi, calls = []
  const user = { pk: '42', username: 'alice', full_name: 'Alice', follower_count: 0 }
  const missingWire = JSON.stringify({ status: 'ok', data: { user: null } })
  const edge = pk => ({ node: { thread_items: [{ post: { pk, user, caption: { text: `Post ${pk}` }, like_count: 0 } }] } })
  gateway.adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async url => {
    const parsed = new URL(url)
    assert.equal(parsed.host, 'threads-scraper.p.rapidapi.com')
    calls.push(parsed.pathname + parsed.search)
    if (parsed.searchParams.get('username') === 'denied') return Response.json({ message: 'Forbidden' }, { status: 403 })
    if (parsed.searchParams.get('username') === 'missing') return new Response(missingWire, { headers: { 'content-type': 'application/json' } })
    if (parsed.searchParams.get('username') === 'empty' && parsed.pathname === '/api/v1/users/posts') return Response.json({ status: 'ok', data: { posts: [], cursor: null } })
    if (parsed.pathname === '/api/v1/users/detail') {
      const username = parsed.searchParams.get('username')
      if (username === 'declined') return Response.json({ status: 'error', data: { user: null } })
      if (username === 'malformed') return Response.json({ status: 'ok', data: {} })
    }
    assert.equal(parsed.searchParams.get('username'), 'alice')
    if (parsed.pathname === '/api/v1/users/detail') return Response.json({ status: 'ok', data: { user } })
    assert.equal(parsed.pathname, '/api/v1/users/posts')
    const next = parsed.searchParams.get('cursor') === 'page2'
    return Response.json({ status: 'ok', data: { posts: next ? [edge('333')] : [edge('111'), edge('222')], cursor: next ? null : 'page2' } })
  } })
  const route = (operation, primaryProvider, expectedRevision, mode = 'fixed') => hub.strategySearchRoutingStore.update(operation, 'threads',
    { primaryProvider, mode, fallbackProvider: mode === 'priority' ? 'rapidapi' : null, expectedRevision, reason: 'Offline account delivery fixture' })
  for (const [operation, endpoint] of [['user-info', 'user_detail'], ['crawl', 'user_posts']]) {
    const key = `native.r.threads_scraper_${endpoint}`
    await hub.externalPlatformControlStore.updatePolicy('rapidapi', key, {
      expectedRevision: 1, desiredState: 'active', reason: 'Offline account acceptance',
      priceBook: { currency: 'USD', pricingAsOf: '2026-11-13T00:00:00Z', monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000,
        unitCostMinorByEndpoint: { [key]: 2 } },
    }, { runtime: { config: gateway.config, credentialConfigured: true } })
    await route(operation, THREADS_SCRAPER_ROUTE, 1, 'priority')
  }
  const tenant = await hub.service.createTenant({ name: 'Threads account listing' })
  const consumer = await hub.service.createConsumer({ tenantId: tenant.id, name: 'Account fixture' })
  await hub.store.setPlatformGrant(consumer.id, 'threads', true)
  await hub.store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'threads', maxRequests: 1000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  const capabilities = ['social.profile.get', 'social.content.crawl']
  for (const capability of capabilities) await hub.service.putCapabilityConfiguration(capability,
    { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await hub.service.createApiKey({ consumerId: consumer.id, name: 'Fixture principal', platforms: ['threads'], capabilities })
  const context = await hub.service.authenticate(key.secret)
  const send = (operation, fields, idempotencyKey, caller = context) => hub.socialDataGateway.socialData(caller,
    { operation, body: { platform: 'threads', ...fields }, path: `/api/v1/data/social/${operation}`, idempotencyKey })
  const limited = await hub.service.createApiKey({ consumerId: consumer.id, name: 'Missing business grant', platforms: ['threads'], capabilities: [] })
  await assert.rejects(send('user-info', { username: 'alice' }, 'scraper-scope-test', await hub.service.authenticate(limited.secret)),
    { status: 403 })
  assert.deepEqual(calls, [])
  const profile = await send('user-info', { username: '@ALICE' }, 'scraper-profile-saved')
  assert.equal(profile.body.data.items[0].userId, '42')
  const input = { profileUrl: 'https://www.threads.com/@Alice', count: 1 }
  const first = await send('crawl', input, 'scraper-posts-saved')
  assert.equal(first.body.data.items[0].externalId, '111')
  assert.deepEqual(calls, ['/api/v1/users/detail?username=alice', '/api/v1/users/posts?username=alice'])
  const paid = [...gateway.platformStore.calls.values()]
  assert.deepEqual(paid.map(call => [call.providerKey, call.marketplace, call.operation, call.costMinor]), [
    ['rapidapi', 'threads-scraper', 'native.r.threads_scraper_user_detail', 2],
    ['rapidapi', 'threads-scraper', 'native.r.threads_scraper_user_posts', 2],
  ])
  await route('crawl', 'tikhub', 2)
  await route('user-info', 'tikhub', 2)
  for (const [operation, fields, idempotencyKey, purchase] of [
    ['user-info', { username: '@ALICE' }, 'scraper-profile-saved', profile], ['crawl', input, 'scraper-posts-saved', first],
  ]) {
    const replay = await send(operation, fields, idempotencyKey)
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, purchase.body)
  }
  const second = await send('crawl', { ...input, cursor: first.body.data.pageInfo.nextCursor }, 'scraper-carry-only')
  assert.equal(second.body.data.items[0].externalId, '222')
  assert.equal(second.body.data.meta.providerCalls, 0)
  assert.equal(calls.length, 2)
  const third = await send('crawl', { ...input, cursor: second.body.data.pageInfo.nextCursor }, 'scraper-continue')
  assert.equal(third.body.data.items[0].externalId, '333')
  assert.equal(calls.at(-1), '/api/v1/users/posts?username=alice&cursor=page2')
  assert.ok(gateway.platformStore.ingestJobs.every(job => job.payload.platform === 'threads'))
  await route('user-info', THREADS_SCRAPER_ROUTE, 3, 'priority')
  await assert.rejects(send('user-info', { username: 'denied' }, 'scraper-denied'), { status: 502, code: 'external_platform_rejected' })
  assert.equal(calls.length, 4)
  const rejected = [...gateway.platformStore.calls.values()].at(-1)
  assert.equal(rejected.outcome, 'rejected')
  assert.equal(rejected.marketplace, 'threads-scraper')
  await assert.rejects(send('user-info', { username: 'denied' }, 'scraper-denied'), { status: 502, code: 'external_platform_rejected' })
  assert.equal(calls.length, 4)
  await route('crawl', THREADS_SCRAPER_ROUTE, 3, 'priority')
  const server = createServer(hub.app)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const origin = `http://127.0.0.1:${server.address().port}`
  for (const operation of ['user-info', 'crawl']) {
    const start = calls.length, idempotencyKey = `scraper-missing-${operation}`
    const headers = { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey }
    const request = { method: 'POST', headers, body: JSON.stringify({ platform: 'threads', username: 'missing' }) }
    const response = await fetch(`${origin}/api/v1/data/social/${operation}`, request)
    assert.equal(response.status, 404)
    const body = await response.json()
    assert.equal(body.error.code, 'social_account_not_found')
    assert.equal(body.error.details.platform, 'threads')
    assert.equal(body.error.details.stage, 'account_lookup')
    assert.equal(body.error.details.outcome, 'rejected')
    assert.equal(body.error.details.retryable, false)
    assert.equal(calls.length, start + 1, 'no fallback purchase or profile enrichment')
    const call = [...gateway.platformStore.calls.values()].at(-1)
    assert.equal(call.endpointKey, `native.r.threads_scraper_${operation === 'crawl' ? 'user_posts' : 'user_detail'}`)
    assert.deepEqual([call.outcome, call.httpStatus, call.billed, call.errorCode], ['rejected', 200, null, 'social_account_not_found'])
    const archive = gateway.platformStore.restrictedResponseArchives.get(call.id)
    assert.equal(Buffer.from(archive.bodyBytes).toString(), missingWire)
    assert.equal(archive.bodySha256, createHash('sha256').update(missingWire).digest('hex'))
    assert.equal(gateway.platformStore.responseArchives.get(call.id).contractState, 'rejected')
    const saved = structuredClone({ usage: hub.store.requests.get(call.usageRequestId),
      charge: hub.store.customerCharges.get(call.usageRequestId), call, archive })
    const replay = await fetch(`${origin}/api/v1/data/social/${operation}`, request)
    assert.equal(replay.status, 404)
    const replayBody = await replay.json()
    assert.equal(replayBody.requestId, body.requestId)
    assert.equal(replayBody.error.code, body.error.code)
    assert.deepEqual(structuredClone({ usage: hub.store.requests.get(call.usageRequestId),
      charge: hub.store.customerCharges.get(call.usageRequestId), call: gateway.platformStore.calls.get(call.id),
      archive: gateway.platformStore.restrictedResponseArchives.get(call.id) }), saved)
    assert.equal(calls.length, start + 1)
    await assert.rejects(send(operation, { usernames: ['missing', 'alice'] }, `scraper-mixed-${operation}`),
      { status: 404, code: 'social_account_not_found' })
    assert.equal(calls.length, start + 2, 'the first missing account stops the batch')
  }
  await assert.rejects(send('crawl', { username: 'empty' }, 'scraper-empty-posts'), error => {
    assert.equal(error.status, 404)
    assert.equal(error.code, 'social_account_not_found')
    assert.equal(error.details.reason, 'social_data_not_found')
    return true
  })

  const forwardNative = gateway.adapter.forwardNative.bind(gateway.adapter)
  gateway.adapter.forwardNative = async (...args) => {
    const result = await forwardNative(...args)
    throw new RapidApiUpstreamError({ outcome: 'succeeded_unusable', billed: null, httpStatus: 200,
      businessCode: null, errorCode: 'invalid_social_contract', affectsCircuit: false }, result)
  }
  await assert.rejects(send('crawl', { username: 'missing' }, 'scraper-historical-502'), { status: 404 })
  gateway.adapter.forwardNative = forwardNative
  const original = [...gateway.platformStore.calls.values()].at(-1)
  // Seed the public receipt as saved before the no-data policy. Replaying it
  // must preserve the old 502 instead of applying today's classification.
  const legacyUsage = hub.store.requests.get(original.usageRequestId)
  legacyUsage.responseStatus = 502
  legacyUsage.responseBody = { error: { code: 'external_platform_response_unusable',
    message: 'Account acquisition failed; inspect its saved outcome',
    details: { outcome: 'succeeded_unusable', retryable: false } }, requestId: original.usageRequestId }
  const legacyGateway = gateway.platformStore.requests.find(row => row.usageRequestId === original.usageRequestId)
  legacyGateway.responseStatus = 502
  const historical = structuredClone({ usage: hub.store.requests.get(original.usageRequestId),
    charge: hub.store.customerCharges.get(original.usageRequestId), call: original,
    archive: gateway.platformStore.restrictedResponseArchives.get(original.id) })
  const purchaseCount = calls.length
  await assert.rejects(send('crawl', { username: 'missing' }, 'scraper-historical-502'),
    { status: 502, code: 'external_platform_response_unusable' })
  assert.equal(calls.length, purchaseCount)
  assert.deepEqual(structuredClone({ usage: hub.store.requests.get(original.usageRequestId),
    charge: hub.store.customerCharges.get(original.usageRequestId), call: gateway.platformStore.calls.get(original.id),
    archive: gateway.platformStore.restrictedResponseArchives.get(original.id) }), historical)
  const before = calls.length
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(send('user-info', { username: 'declined' }, 'scraper-declined'), { status: 502, code: 'external_platform_rejected' })
  }
  assert.equal(calls.length, before + 1)
  const declined = [...gateway.platformStore.calls.values()].at(-1)
  assert.deepEqual([declined.outcome, declined.httpStatus, declined.billed, declined.errorCode], ['rejected', 200, null, 'social_upstream_rejected'])
  assert.equal(gateway.platformStore.responseArchives.get(declined.id).contractState, 'rejected')
  assert.deepEqual(gateway.platformStore.restrictedResponseArchives.get(declined.id).parsedPayload, { status: 'error', data: { user: null } })
  await assert.rejects(send('user-info', { username: 'malformed' }, 'scraper-malformed'), error => {
    assert.equal(error.status, 404)
    assert.equal(error.code, 'social_account_not_found')
    assert.equal(error.details.reason, 'social_data_not_found')
    return true
  })
  assert.equal([...gateway.platformStore.calls.values()].at(-1).outcome, 'succeeded_unusable')
})
