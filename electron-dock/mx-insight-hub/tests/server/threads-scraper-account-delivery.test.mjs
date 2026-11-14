import assert from 'node:assert/strict'
import test from 'node:test'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
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
  const edge = pk => ({ node: { thread_items: [{ post: { pk, user, caption: { text: `Post ${pk}` }, like_count: 0 } }] } })
  gateway.adapter = new RapidApiAdapter({ apiKey: credential, fetchImpl: async url => {
    const parsed = new URL(url)
    assert.equal(parsed.host, 'threads-scraper.p.rapidapi.com')
    calls.push(parsed.pathname + parsed.search)
    if (parsed.searchParams.get('username') === 'denied') return Response.json({ message: 'Forbidden' }, { status: 403 })
    if (parsed.pathname === '/api/v1/users/detail') {
      const username = parsed.searchParams.get('username')
      if (username === 'missing') return Response.json({ status: 'ok', data: { user: null } })
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
  const missing = await send('user-info', { username: 'missing' }, 'scraper-missing')
  assert.equal(missing.status, 200)
  assert.equal(missing.body.data.status, 'ok')
  assert.deepEqual(missing.body.data.items, [])
  assert.deepEqual(JSON.parse(missing.body.data.raw_info), [])
  assert.equal(missing.body.data.pageInfo.hasMore, false)
  assert.equal([...gateway.platformStore.calls.values()].at(-1).outcome, 'succeeded')
  const batch = await send('user-info', { usernames: ['missing', 'alice'] }, 'scraper-mixed-profiles')
  assert.equal(batch.body.data.status, 'ok')
  assert.deepEqual(batch.body.data.items.map(item => item.username), ['alice'])
  assert.deepEqual(batch.body.data.results.map(row => [row.value, row.success, row.items.length]), [
    ['missing', true, 0], ['alice', true, 1],
  ])
  const before = calls.length
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(send('user-info', { username: 'declined' }, 'scraper-declined'), { status: 502, code: 'external_platform_rejected' })
  }
  assert.equal(calls.length, before + 1)
  const declined = [...gateway.platformStore.calls.values()].at(-1)
  assert.deepEqual([declined.outcome, declined.httpStatus, declined.billed, declined.errorCode], ['rejected', 200, null, 'social_upstream_rejected'])
  assert.equal(gateway.platformStore.responseArchives.get(declined.id).contractState, 'rejected')
  assert.deepEqual(gateway.platformStore.restrictedResponseArchives.get(declined.id).parsedPayload, { status: 'error', data: { user: null } })
  await assert.rejects(send('user-info', { username: 'malformed' }, 'scraper-malformed'), { status: 502, code: 'external_platform_response_unusable' })
  assert.equal([...gateway.platformStore.calls.values()].at(-1).outcome, 'succeeded_unusable')
})
