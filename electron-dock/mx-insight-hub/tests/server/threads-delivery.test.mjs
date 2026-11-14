import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import test from 'node:test'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { createRapidApiProxyFetch } from '../../server/external-platforms/proxy.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { loadConfig } from '../../server/config.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { THREADS_RAPIDAPI_HOST } from '../../server/contracts/threads-rapidapi-endpoints.mjs'
import { createRuntime } from '../../server/index.mjs'

const samples = JSON.parse(readFileSync(new URL('../fixtures/threads-rapidapi-samples.json', import.meta.url), 'utf8'))
const postId = '3390920896561588969', commentId = '3390930071274677885', replyId = '3390930071274677999'
const apiKey = 'synthetic-threads-delivery-credential'

// Reply pages use the same endpoint as comments. Start with the sampled comment
// as the context edge, then add one synthetic reply to exercise the returned replyRef.
function replyPage() {
  const page = structuredClone(samples.postComments)
  const edges = page.data.data.edges
  edges[0] = structuredClone(edges[1])
  edges[1].node.id = replyId
  const reply = edges[1].node.thread_items[0].post
  reply.pk = replyId
  reply.id = `${replyId}_${reply.user.pk}`
  reply.code = 'C8PAO8UhGbv'
  reply.text_post_app_info.reply_to_author.username = edges[0].node.thread_items[0].post.user.username
  reply.replied_to = { id: commentId }
  reply.root_post = { id: postId }
  reply.caption.text = 'reply to sampled comment'
  return page
}

test('public Threads routes deliver five original listing interfaces and replay each purchase from its ledger', async t => {
  const fetchLocal = globalThis.fetch
  t.mock.method(globalThis, 'fetch', (url, options) => {
    assert.equal(new URL(url).hostname, '127.0.0.1', 'Only the local Hub listener may use the network')
    return fetchLocal(url, options)
  })
  const runtime = await createRuntime(loadConfig({
    MX_INSIGHT_STORE: 'memory', MX_INSIGHT_LISTENER_MODE: 'public',
    MX_INSIGHT_API_KEY_PEPPER: 'threads-delivery-fixture-pepper-at-least-32-characters', MX_INSIGHT_RAPIDAPI_API_KEY: apiKey,
    MX_INSIGHT_TIKHUB_API_KEY: 'synthetic-threads-fallback-credential',
  }))
  const { store, service } = runtime
  t.after(async () => { runtime.agent.close(); await store.close() })
  for (const operation of ['search', 'crawl', 'user-info']) {
    await runtime.strategySearchRoutingStore.update(operation, 'threads', { mode: 'priority', primaryProvider: 'rapidapi',
      fallbackProvider: 'tikhub', expectedRevision: 1, reason: 'Exercise the original Threads API fixtures and readiness' })
  }
  const fixtures = {
    '/api/search/recent': samples.searchRecent, '/api/user/posts': samples.userPosts, '/api/user/info': samples.userInfo,
    '/api/v1/posts/search': null, // Generated below so page two can assert cursor ownership.
    '/api/post/comments': samples.postComments, '/api/search/profiles': samples.searchProfiles,
  }
  const calls = []
  const fixtureFetch = async (input, options) => {
    const url = new URL(input)
    calls.push(url.pathname + url.search)
    if (url.pathname === '/api/v1/posts/search') {
      assert.equal(url.hostname, 'threads-scraper.p.rapidapi.com')
      assert.equal(options.headers['x-rapidapi-host'], url.hostname)
      if (url.searchParams.get('query') === 'rejected') return Response.json({ message: 'You are not subscribed to this API.' },
        { status: 403, headers: { 'x-rapidapi-proxy-response': 'true' } })
      if (url.searchParams.get('query') === 'declined') return Response.json({ status: 'error', data: { results: [] } })
      const cursor = url.searchParams.get('cursor')
      assert.ok(cursor === null || cursor === 'opaque +/=', 'Scraper cursor must round-trip unchanged')
      return Response.json({ status: 'ok', data: { results: [samples.searchRecent.data.searchResults.edges[cursor ? 1 : 0]],
        cursor: cursor ? null : 'opaque +/=' } })
    }
    assert.equal(url.hostname, THREADS_RAPIDAPI_HOST)
    assert.ok(Object.hasOwn(fixtures, url.pathname), url.pathname)
    return Response.json(url.pathname === '/api/post/comments' && url.searchParams.get('post_id') === commentId
      ? replyPage() : fixtures[url.pathname])
  }
  const adapter = new RapidApiAdapter({ apiKey, fetchImpl: createRapidApiProxyFetch({
    route: async () => ({ proxyUrls: [], directFallback: true }),
  }, { fetchImpl: fixtureFetch }) })
  // The memory runtime omits credentialed transports. Use the real adapter and
  // injected response fixtures on the same gateways as the production router.
  const accountGateway = runtime.threadsGateways.rapidapi
  const fallbackGateway = runtime.threadsGateways.tikhub
  fallbackGateway.adapter = new TikHubAdapter({ apiKey: 'synthetic-threads-fallback-credential', fetchImpl: async input => {
    calls.push(new URL(input).pathname)
    throw new Error('An unavailable fallback must not be called')
  } })
  const commentsGateway = runtime.postCommentProviderGateways.threads.rapidapi
  for (const gateway of [accountGateway, commentsGateway, runtime.commentReplyGateways.threads.rapidapi]) gateway.adapter = adapter
  const active = NATIVE_FORWARDING_ENDPOINTS.filter(row => row.platform === 'threads' && (
    row.provider === 'rapidapi' ? Object.hasOwn(fixtures, row.path) : ['/api/v1/threads/web/fetch_user_info', '/api/v1/threads/web/fetch_user_posts'].includes(row.path)))
  for (const endpoint of active) {
    await runtime.externalPlatformControlStore.updatePolicy(endpoint.provider, endpoint.operation, {
      expectedRevision: 1, desiredState: 'active', reason: 'Offline Threads fixture',
      priceBook: { currency: 'USD', pricingAsOf: '2026-11-11T00:00:00Z', monthlyBudgetMinor: 1000, monthlySubsidyBudgetMinor: 1000,
        unitCostMinorByEndpoint: { [endpoint.endpointKey]: endpoint.key === 'r.threads_scraper_search_posts' ? 2 : 1 } },
    }, { runtime: { config: runtime.threadsGateways[endpoint.provider].config, credentialConfigured: true } })
  }
  const tenant = await service.createTenant({ name: 'Threads fixture' })
  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 1, defaultCurrency: 'CNY' }, 'fixture')
  await service.addTenantCredit(tenant.id, { amountMinor: 10, currency: 'CNY', reason: 'Keep credit available through the refusal test' },
    { idempotencyKey: 'threads-fixture-credit', actor: 'fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Threads delivery' })
  await store.setPlatformGrant(consumer.id, 'threads', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'threads', maxRequests: 1000,
    windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  const capabilities = ['social.content.crawl', 'social.profile.get', 'social.comments.list']
  for (const capability of capabilities) {
    await service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  }
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Fixture Key', platforms: ['threads'], capabilities })
  const server = createServer(runtime.app)
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}/api/v1/data/`

  const send = (route, input, idempotencyKey = `fixture-threads-${route.replace('/', '-')}`) => fetch(base + route, {
    method: 'POST', headers: { authorization: `Bearer ${key.secret}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify({ platform: 'threads', ...input }),
  })
  async function deliver(route, input, expectedCall, gateway = accountGateway) {
    const before = calls.length
    const response = await send(route, input)
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.deepEqual(calls.slice(before), [expectedCall])
    const usage = store.requests.get(body.requestId)
    assert.equal(usage.platform, 'threads')
    assert.equal(usage.status, 'committed')
    const ownCalls = [...gateway.platformStore.calls.values()].filter(call => call.usageRequestId === usage.id)
    assert.equal(ownCalls.length, 1)
    assert.equal(ownCalls[0].outcome, 'succeeded')
    assert.equal(ownCalls[0].providerKey, 'rapidapi')
    assert.ok(gateway.platformStore.restrictedResponseArchives.has(ownCalls[0].id))
    const charge = structuredClone(store.customerCharges.get(usage.id))
    assert.equal(charge.status, 'captured')
    assert.equal(charge.chargedMinor, 1)
    const replay = await send(route, input)
    assert.equal(replay.headers.get('idempotent-replay'), 'true')
    assert.deepEqual(await replay.json(), body)
    assert.deepEqual(calls.slice(before), [expectedCall])
    assert.deepEqual(store.customerCharges.get(usage.id), charge)
    return body
  }

  const search = await deliver('search', { query: 'bitcoin', pageSize: 20 }, '/api/search/recent?query=bitcoin')
  assert.deepEqual(search.data.items.map(item => item.text), ['bitcoin sample post', 'fragment text'])
  const accountInput = { userId: '60762270900', count: 20 }
  const posts = await deliver('social/crawl', accountInput, '/api/user/posts?user_id=60762270900')
  assert.deepEqual(posts.data.items.map(item => item.externalId), ['3423248872904765000'])
  const profiles = await deliver('social/user-info', { userId: '63625256886' }, '/api/user/info?id=63625256886')
  assert.deepEqual(profiles.data.items.map(item => [item.userId, item.username]), [['63625256886', 'sample_news']])
  const comments = await deliver('social/post-comments', { contentId: postId, count: 20 }, `/api/post/comments?post_id=${postId}`, commentsGateway)
  assert.deepEqual(comments.data.items.map(item => [item.commentId, item.text]), [[commentId, 'first level comment']])
  const replies = await deliver('social/comment-replies', { replyRef: comments.data.items[0].replyRef, count: 20 },
    `/api/post/comments?post_id=${commentId}`, runtime.commentReplyGateways.threads.rapidapi)
  assert.deepEqual(replies.data.items.map(item => [item.commentId, item.parentCommentId, item.text]), [[replyId, commentId, 'reply to sampled comment']])
  assert.equal(store.customerCharges.size, 5)

  await t.test('a batch with a disabled later activity buys neither account lookup nor an earlier ready activity', async () => {
    for (const [provider, lookupPath, repostPath] of [
      ['rapidapi', '/api/search/profiles', '/api/user/reposts'],
      ['tikhub', '/api/v1/threads/web/fetch_user_info', '/api/v1/threads/web/fetch_user_reposts'],
    ]) {
      const routes = [lookupPath, repostPath].map(path => NATIVE_FORWARDING_ENDPOINTS.find(row => row.provider === provider && row.path === path).operation)
      const readiness = await runtime.threadsGateways[provider].nativeReadiness({ consumerId: consumer.id, operationKeys: routes })
      assert.deepEqual(routes.map(route => readiness[route]), [true, false])
    }
    const before = calls.length
    const rejected = await send('social/crawl', { usernames: ['sample_news', 'owner_account'], activityTypes: ['posts', 'reposts'] }, 'fixture-unavailable-reposts')
    const { error } = await rejected.json()
    assert.equal(rejected.status, 503, JSON.stringify(error))
    assert.equal(error.code, 'external_platform_operation_unavailable')
    assert.equal(calls.length, before)
    assert.equal([...store.customerCharges.values()].reduce((sum, charge) => sum + charge.chargedMinor, 0), 5)
  })

  await t.test('changing the configured provider and pausing an account route still replays its original receipt', async () => {
    const charges = structuredClone(store.customerCharges)
    const before = calls.length
    for (const [index, mode] of ['fixed', 'paused'].entries()) {
      await runtime.strategySearchRoutingStore.update('crawl', 'threads', {
        mode, primaryProvider: 'tikhub', fallbackProvider: null, expectedRevision: index + 2, reason: 'Offline replay regression',
      })
      const replay = await send('social/crawl', accountInput)
      assert.equal(replay.status, 200)
      assert.equal(replay.headers.get('idempotent-replay'), 'true')
      assert.deepEqual(await replay.json(), posts)
      assert.equal(calls.length, before)
      assert.deepEqual(store.customerCharges, charges)
    }
  })

  await t.test('switching search listings preserves receipts, cursor ownership and separate procurement costs', async () => {
    const select = (primaryProvider, expectedRevision, fallbackProvider = null) => runtime.strategySearchRoutingStore.update('search', 'threads', {
      mode: fallbackProvider ? 'priority' : 'fixed', primaryProvider, fallbackProvider, expectedRevision, reason: 'Compare Threads listings',
    })
    const scraper = 'rapidapi-threads-scraper'
    const query = { query: 'bitcoin', pageSize: 20 }
    const before = calls.length
    await select(scraper, 2, 'rapidapi')
    const old = await send('search', query)
    assert.equal(old.headers.get('idempotent-replay'), 'true')
    assert.deepEqual(await old.json(), search)
    assert.equal(calls.length, before)
    const refused = await send('search', { query: 'rejected' }, 'fixture-threads-refusal')
    assert.equal(refused.status, 502, JSON.stringify(await refused.json()))
    assert.deepEqual(calls.slice(before), ['/api/v1/posts/search?query=rejected'], 'no second purchase after a 403')
    const failed = await send('search', { query: 'declined' }, 'fixture-threads-inner-error')
    const failure = await failed.json()
    assert.equal(failed.status, 502, JSON.stringify(failure))
    assert.equal(failure.error.code, 'external_platform_rejected')
    const decline = [...accountGateway.platformStore.calls.values()].find(call => call.usageRequestId === failure.requestId)
    assert.deepEqual([decline.outcome, decline.httpStatus, decline.errorCode], ['rejected', 200, 'social_upstream_rejected'])
    const replayFailure = await send('search', { query: 'declined' }, 'fixture-threads-inner-error')
    assert.deepEqual(await replayFailure.json(), failure)
    assert.deepEqual(calls.slice(before + 1), ['/api/v1/posts/search?query=declined'])
    const read = async (body, key) => {
      const response = await send('search', body, key), result = await response.json()
      assert.equal(response.status, 200, JSON.stringify(result))
      return result
    }
    const first = await read(query, 'fixture-scraper-first')
    assert.equal(first.data.items[0].text, 'bitcoin sample post')
    const own = id => [...accountGateway.platformStore.calls.values()].find(call => call.usageRequestId === id)
    assert.deepEqual([own(first.requestId).operation, own(search.requestId).operation],
      ['native.r.threads_scraper_search_posts', 'native.r.threads_search_recent'])
    assert.deepEqual([own(first.requestId).marketplace, own(first.requestId).costMinor, own(search.requestId).costMinor], ['threads-scraper', 2, 1])
    assert.equal(own(first.requestId).archiveObjects[0].marketplace, 'threads-scraper')
    const ingested = accountGateway.platformStore.ingestJobs.find(job => job.payload.providerCallId === own(first.requestId).id)
    assert.deepEqual([ingested.payload.providerKey, ingested.payload.platform], ['rapidapi', 'threads'])
    await select('rapidapi', 3)
    assert.match(first.data.pageInfo.nextCursor, /^mxds1\./u)
    const next = await read({ ...query, cursor: first.data.pageInfo.nextCursor }, 'fixture-scraper-next')
    assert.equal(next.data.items[0].text, 'fragment text')
    assert.equal(next.data.pageInfo.hasMore, false)
    await read(query, 'fixture-legacy-again')
    assert.deepEqual(calls.slice(before + 2), ['/api/v1/posts/search?query=bitcoin',
      '/api/v1/posts/search?query=bitcoin&cursor=opaque+%2B%2F%3D', '/api/search/recent?query=bitcoin'])
  })
})
