import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../../server/contracts/hub-social-compat.mjs'

const PEPPER = 'offline-social-account-workflow-sufficiently-long-pepper'
const SECRET = 'synthetic-social-account-provider-key'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const user = (username = 'ui_batch_019', id = '42') => ({ rest_id: id,
  legacy: { screen_name: username, name: `Fixture ${username}`, followers_count: 0, friends_count: 5,
    profile_image_url_https: 'https://example.test/avatar.png', created_at: '2020-01-01T00:00:00Z' } })
const profile = (username, id) => ({ data: { user: { result: user(username, id) } } })
const timeline = (ids, cursor = null, username = 'ui_batch_019', userId = '42') => ({ data: { user: { result: {
  ...user(username, userId), timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    ...ids.map(id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
      rest_id: id, legacy: { full_text: `完整正文 ${id}`, favorite_count: 0, reply_count: 2,
        created_at: '2026-10-15T00:00:00Z', entities: { hashtags: [] } },
      core: { user_results: { result: user(username, userId) } },
    } } } } })), ...(cursor ? [{ entryId: 'cursor-bottom-0', content: { cursorType: 'Bottom', value: cursor } }] : []),
  ] }] },
} } } })

async function harness(t, { platform = 'twitter', fetchImpl, maxPageSize = 500, grant = true, enabled = true, store = new MemoryStore() } = {}) {
  const calls = [], historical = []
  // Exercise the historical caller's page_size=500 only under an explicitly
  // entitled fixture plan; the production Launch plan remains capped at 100.
  store.plans[0].limits.maxPageSize = maxPageSize
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
    async search(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
  } })
  const tenant = await service.createTenant({ name: 'Offline social-account regression' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic account caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform,
    maxRequests: 100000, windowSeconds: 3600, maxPageSize, maxCrawlWork: 1000 })
  const capabilities = ['social.content.crawl', 'social.profile.get']
  for (const capability of capabilities) await service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic live Key', platforms: [platform], capabilities: grant ? capabilities : [] })
  const context = await service.authenticate(key.secret)
  const provider = platform === 'twitter' ? 'rapidapi' : platform === 'facebook' ? 'justone' : 'tikhub'
  const config = { ...rapidApiConfig(), configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const initial = normalizeHubSocialCompatRequest('crawl', { platform, userId: '42', count: 20 })
  const steps = [buildHubSocialCompatDispatch(initial.jobs[0]), buildHubSocialCompatDispatch(initial.jobs[0], {
    resolvedIdentity: { kind: 'id', value: '42', username: 'ui_batch_019', lookupComplete: true, profileReady: true },
  })]
  for (const step of steps) if (enabled) await controls.updatePolicy(provider, step.operationKey || step.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic account regression', priceBook: {
      currency: 'USD', pricingAsOf: '2026-10-15T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [step.endpointKey]: 2 },
    },
  }, { runtime: { config, credentialConfigured: true } })
  const mockFetch = async (url, options) => {
    const parsed = new URL(url)
    const call = { url: parsed, options, params: options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams) }
    calls.push(call)
    if (fetchImpl) return fetchImpl(call, calls.length)
    if (provider === 'rapidapi') return Response.json(parsed.pathname.includes('/tweets') ? timeline(['1']) : profile())
    if (provider === 'justone') return Response.json({ code: 0, message: 'success', recordTime: '2026-10-15T00:00:00Z', data: parsed.pathname.includes('profile-id')
      ? { profile_id: '42', name: 'Fixture' } : { posts: [{ id: '1', text: '完整正文', user: { id: '42', name: 'Fixture' } }], has_more: false } })
    return Response.json({ code: 200, data: parsed.pathname.includes('user_info')
      ? { user: { id: '42', screen_name: 'ui_batch_019', name: 'Fixture', followers_count: 0 } }
      : { list: [{ id: '1', text: '完整正文', user: { id: '42', screen_name: 'Fixture' } }], has_more: false } })
  }
  const adapter = provider === 'rapidapi' ? new RapidApiAdapter({ apiKey: SECRET, fetchImpl: mockFetch, timeoutMs: 100 })
    : provider === 'tikhub' ? new TikHubAdapter({ apiKey: SECRET, fetchImpl: mockFetch, timeoutMs: 100 })
      : new JustOneAdapter({ token: SECRET, fetchImpl: mockFetch, timeoutMs: 100 })
  if (provider === 'justone') t.after(() => adapter.close())
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: provider,
    authorizationPlatform: platform, uncertainCooldownMs: 900000 })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: provider,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  const invoke = (body = { platform, userId: platform === 'twitter' ? 'ui_batch_019' : '42', count: 20 },
    idempotencyKey = 'social-account-first-page', operation = 'crawl', activeContext = context) => gateway.socialAccountData(activeContext,
    { operation, body, idempotencyKey, path: `/api/v1/data/social/${operation}` })
  return { store, service, platformStore, gateway, context, key, controls, calls, historical, invoke, provider, config }
}

test('Twitter screenshot-shaped nonnumeric ID and page_size=500 follows short pages and retains one immutable delivery', async t => {
  let page = 0
  const h = await harness(t, { fetchImpl: call => {
    if (!call.url.pathname.includes('/tweets')) return Response.json(profile())
    page++
    return Response.json(timeline([String(page)], page < 10 ? `cursor-${page}` : null))
  } })
  const body = { platform: 'twitter', user_id: 'ui_batch_019', page_size: 500 }
  const result = await h.invoke(body)
  assert.equal(result.body.data.items.length, 10)
  assert.equal(result.body.data.page.returnedCount, 10)
  assert.equal(result.body.data.page.nextCursor, null)
  assert.equal(h.calls.length, 11)
  assert.equal(h.calls[0].url.pathname, '/user/by/username/ui_batch_019')
  assert.ok(h.calls.slice(1).every(call => call.url.pathname === '/user/42/tweets' && call.params.count === '50'))
  assert.deepEqual(h.calls.slice(2).map(call => call.params.cursor), Array.from({ length: 9 }, (_, i) => `cursor-${i + 1}`))
  assert.equal(JSON.parse(result.body.data.raw_data).length, 10)
  assert.equal(JSON.parse(result.body.data.raw_info)[0].user_id, '42')
  assert.equal(h.historical.length, 0)
  assert.deepEqual((await h.invoke(body)).body, result.body)
  assert.equal(h.calls.length, 11)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 11)
})

test('Twitter paid overflow yields all 24 rows across pages without repurchase or lost IDs', async t => {
  const h = await harness(t, { fetchImpl: call => Response.json(call.url.pathname.includes('/tweets')
    ? timeline(Array.from({ length: 24 }, (_, i) => String(i + 1))) : profile()) })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 10 }
  const first = await h.invoke(body), all = [...first.body.data.items]
  assert.equal(first.body.data.items.length, 10)
  assert.equal(first.body.data.page.hasMore, true)
  assert.equal(h.calls.length, 2)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-overflow-second')
  assert.equal(second.body.data.items.length, 10)
  assert.equal(second.body.data.meta.providerCalls, 0)
  all.push(...second.body.data.items)
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'social-overflow-third')
  all.push(...third.body.data.items)
  assert.equal(third.body.data.items.length, 4)
  assert.equal(third.body.data.page.hasMore, false)
  assert.equal(h.calls.length, 2)
  assert.deepEqual(all.map(row => row.content_id), Array.from({ length: 24 }, (_, i) => String(i + 1)))
  assert.equal(new Set(all.map(row => row.content_id)).size, 24)
  const archive = [...h.platformStore.restrictedResponseArchives.values()].at(-1)
  assert.equal(archive.bodySha256, digest(archive.bodyBytes))
  assert.equal(JSON.parse(Buffer.from(archive.bodyBytes).toString()).data.user.result.timeline.instructions[0].entries.length, 24)
})

test('account cursors bind account, Key, operation and page size before another provider dispatch', async t => {
  const h = await harness(t, { fetchImpl: call => Response.json(call.url.pathname.includes('/tweets') ? timeline(['1', '2', '3'], 'next') : profile()) })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 2 }, first = await h.invoke(body)
  const cursor = first.body.data.page.nextCursor
  for (const changes of [{ username: 'changed' }, { count: 3 }, { page: 3 }]) {
    await assert.rejects(h.invoke({ ...body, cursor, ...changes }, `social-scope-${Object.keys(changes)[0]}`), { code: 'invalid_cursor' })
  }
  await assert.rejects(h.invoke({ ...body, cursor }, 'social-profile-wrong-scope', 'user-info'), { code: 'invalid_cursor' })
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Other fixture Key', platforms: ['twitter'], capabilities: ['social.content.crawl', 'social.profile.get'] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.invoke({ ...body, cursor }, 'social-key-wrong-scope', 'crawl', otherContext), { code: 'invalid_cursor' })
  assert.equal(h.calls.length, 2)
})

test('account traversal stops after page 15 without dropping the source receipt or issuing page 16', async t => {
  let page = 0
  const h = await harness(t, { fetchImpl: call => Response.json(call.url.pathname.includes('/tweets')
    ? timeline([String(++page)], `cursor-${page}`) : profile()) })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 1 }
  let cursor, result
  for (let page = 1; page <= 15; page++) {
    result = await h.invoke({ ...body, ...(cursor ? { cursor } : {}) }, `social-limit-page-${page}`)
    assert.equal(result.body.data.page.page, page)
    assert.equal(result.body.data.items[0].content_id, String(page))
    cursor = result.body.data.page.nextCursor
  }
  assert.equal(cursor, null)
  assert.equal(h.calls.length, 16)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 16)
  assert.ok(result.body.data.warnings.some(row => /page_limit/.test(row.code)))
})

test('multiple accounts preserve independent continuation and consume each archived remainder', async t => {
  const h = await harness(t, { fetchImpl: call => {
    if (call.url.pathname.includes('/by/username/')) {
      const name = call.url.pathname.split('/').at(-1)
      return Response.json(profile(name, name === 'account_one' ? '41' : '42'))
    }
    const id = call.url.pathname.split('/')[2], name = id === '41' ? 'account_one' : 'account_two'
    if (!call.params.cursor) return Response.json(timeline([`${id}1`, `${id}2`, `${id}3`], `next-${id}`, name, id))
    assert.equal(call.params.cursor, `next-${id}`)
    return Response.json(timeline([`${id}4`], null, name, id))
  } })
  const body = { platform: 'twitter', usernames: ['account_one', 'account_two'], count: 2 }
  const first = await h.invoke(body)
  assert.equal(first.body.data.results.length, 2)
  assert.deepEqual(first.body.data.results.map(row => row.items.map(item => item.content_id)), [['411', '412'], ['421', '422']])
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-multi-second')
  assert.deepEqual(second.body.data.results.map(row => row.items.map(item => item.content_id)), [['413', '414'], ['423', '424']])
  assert.equal(second.body.data.page.hasMore, false)
  assert.equal(h.calls.length, 6)
  assert.equal(JSON.parse(second.body.data.raw_info).length, 2)
})

test('unknown transport outcome keeps acquired evidence and never retries or falls back automatically', async t => {
  const h = await harness(t, { fetchImpl: call => {
    if (!call.url.pathname.includes('/tweets')) return Response.json(profile())
    throw new Error('Synthetic connection lost after dispatch')
  } })
  const body = { platform: 'twitter', user_id: 'ui_batch_019', count: 10 }
  await assert.rejects(h.invoke(body), error => ['upstream_outcome_unknown', 'request_outcome_unknown'].includes(error.code))
  assert.equal(h.calls.length, 2)
  await assert.rejects(h.invoke(body))
  await assert.rejects(h.invoke(body, 'social-unknown-new-idem'))
  assert.equal(h.calls.length, 2)
  assert.equal(h.historical.length, 0)
  assert.ok([...h.platformStore.calls.values()].some(call => call.outcome === 'unknown'))
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
})

test('a lost evidence acknowledgement preserves the receipt and prevents automatic reacquisition', async t => {
  const h = await harness(t)
  const original = h.platformStore.stageProviderEvidence.bind(h.platformStore)
  h.platformStore.stageProviderEvidence = async input => {
    await original(input)
    throw new Error('Synthetic acknowledgement lost after durable staging')
  }
  await assert.rejects(h.invoke(), { code: 'request_outcome_unknown' })
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  h.platformStore.stageProviderEvidence = original
  await assert.rejects(h.invoke())
  await assert.rejects(h.invoke(undefined, 'social-persistence-new-idem'))
  assert.equal(h.calls.length, 1)
  assert.equal(h.historical.length, 0)
})

test('rate admission after acquired content returns partial and a continuation, then resumes without repeating profile lookup', async t => {
  let page = 0
  const h = await harness(t, { fetchImpl: call => Response.json(call.url.pathname.includes('/tweets')
    ? timeline([String(++page)], page === 1 ? 'page-two' : null) : profile()) })
  let admissions = 0
  h.platformStore.acquireProviderRateLimit = async () => ({ allowed: ++admissions <= 2 })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 2 }
  const first = await h.invoke(body)
  assert.equal(first.body.data.items.length, 1)
  assert.equal(first.body.data.status, 'partial')
  assert.ok(first.body.data.page.nextCursor)
  assert.equal(h.calls.length, 2)
  h.platformStore.acquireProviderRateLimit = async () => ({ allowed: true })
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-resume-rate')
  assert.deepEqual(second.body.data.items.map(row => row.content_id), ['2'])
  assert.equal(h.calls.length, 3)
  assert.equal(h.calls[2].params.cursor, 'page-two')
  assert.equal(h.calls.filter(call => !call.url.pathname.includes('/tweets')).length, 1)
})

for (const platform of ['weibo', 'facebook']) {
  test(`${platform} real adapter keeps profile and posts receipts, bills once and never invokes Night-All`, async t => {
    const h = await harness(t, { platform })
    await h.service.setTenantBillingProfile(h.context.tenant.id, { mode: 'enforced', multiplierPpm: 1000000,
      defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
      { idempotencyKey: `social-${platform}-credit`, actor: 'offline-admin' })
    const result = await h.invoke()
    assert.equal(result.body.data.items.length, 1)
    assert.equal(h.calls.length, 2)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.ok([...h.platformStore.calls.values()].every(call => call.outcome === 'succeeded' && call.billed === true))
    const charges = [...h.store.customerCharges.values()]
    assert.equal(charges.length, 1)
    assert.equal(charges[0].status, 'captured')
    assert.equal(charges[0].chargedMinor, 3)
    assert.deepEqual((await h.invoke()).body, result.body)
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
  })
}

test('social profile operation returns raw_info and forbids crawl-cursor reuse', async t => {
  const h = await harness(t)
  const result = await h.invoke({ platform: 'twitter', userId: 'ui_batch_019' }, 'social-profile-first', 'user-info')
  assert.equal(result.body.data.items.length, 1)
  assert.equal(JSON.parse(result.body.data.raw_data).length, 0)
  assert.equal(JSON.parse(result.body.data.raw_info)[0].user_id, '42')
  assert.equal(result.body.data.page.hasMore, false)
  assert.equal(h.calls.length, 1)
  assert.deepEqual((await h.invoke({ platform: 'twitter', userId: 'ui_batch_019' }, 'social-profile-first', 'user-info')).body, result.body)
  assert.equal(h.calls.length, 1)
})

test('social account grants, runtime controls and entitlement limits reject before paid acquisition', async t => {
  for (const options of [{ grant: false }, { enabled: false }, { maxPageSize: 10 }]) {
    const h = await harness(t, options)
    await assert.rejects(h.invoke())
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  }
})

test('an immutable replay still requires the current platform grant', async t => {
  const h = await harness(t)
  const first = await h.invoke()
  assert.equal(first.status, 200)
  assert.equal(h.calls.length, 2)
  await h.store.setPlatformGrant(h.context.consumer.id, 'twitter', false)
  await assert.rejects(h.invoke(), { code: 'platform_not_granted' })
  assert.equal(h.calls.length, 2)
})

test('an empty advancing provider page continues, while a repeated token stops without losing a paid row', async t => {
  let page = 0
  const h = await harness(t, { fetchImpl: call => {
    if (!call.url.pathname.includes('/tweets')) return Response.json(profile())
    page++
    return Response.json(page === 1 ? timeline([], 'advance') : timeline([String(page)], 'advance'))
  } })
  const result = await h.invoke({ platform: 'twitter', username: 'ui_batch_019', count: 10 })
  assert.deepEqual(result.body.data.items.map(row => row.content_id), ['2'])
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 3)
  assert.equal(result.body.data.page.hasMore, false)
  assert.ok(result.body.data.warnings.some(warning => warning.code === 'upstream_pagination_stopped'))
})

test('provider credential echoes never enter public deliveries, canonical records or replayed overflow', async t => {
  const h = await harness(t, { fetchImpl: call => {
    if (!call.url.pathname.includes('/tweets')) return Response.json(profile())
    const payload = timeline(['1', '2', '3'])
    for (const entry of payload.data.user.result.timeline.instructions[0].entries) {
      entry.content.itemContent.tweet_results.result.legacy.full_text += ` ${SECRET}`
    }
    return Response.json(payload)
  } })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 2 }
  const first = await h.invoke(body)
  assert.equal(JSON.stringify(first.body).includes(SECRET), false)
  assert.equal(JSON.stringify(h.platformStore.ingestJobs).includes(SECRET), false)
  assert.ok([...h.platformStore.restrictedResponseArchives.values()].some(archive => Buffer.from(archive.bodyBytes).includes(SECRET)))
  assert.deepEqual((await h.invoke(body)).body, first.body)
  await assert.rejects(h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-credential-echo-continuation'), { code: 'search_page_unavailable' })
  assert.equal(h.calls.length, 2)
})

test('public HTTP social routes use the Hub workflow while legacy route aliases retain their handler', async t => {
  const h = await harness(t)
  const compatibility = []
  h.service.nightAllCompatibilitySearch = async (_context, input) => {
    compatibility.push(input)
    return { status: 200, body: { data: { legacy: true } }, requestId: 'legacy-fixture', sourceMode: 'live', replay: false }
  }
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {}, adminToken: null,
    listenerMode: 'public', logger: { error() {} }, hubSocialGateway: { socialData: (context, input) => h.gateway.socialAccountData(context, input) } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  const send = (path, operation) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method: 'POST',
    headers: { Authorization: `Bearer ${h.key.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': `http-social-${operation}` },
    body: JSON.stringify({ platform: 'twitter', user_id: 'ui_batch_019', count: 2 }) })
  for (const operation of ['crawl', 'user-info']) {
    const response = await send(`/api/v1/data/social/${operation}`, operation), body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(body.data.meta.implementation, 'hub')
    assert.equal(response.headers.get('x-mx-insight-request-id'), body.requestId)
    assert.equal(response.headers.get('idempotent-replay'), 'false')
    const replay = await send(`/api/v1/data/social/${operation}`, operation)
    assert.equal(replay.headers.get('idempotent-replay'), 'true')
    assert.deepEqual(await replay.json(), body)
  }
  assert.equal(compatibility.length, 0)
  assert.equal(h.calls.length, 3)
  for (const route of ['/api/v1/night-all/search/crawl', '/api/v1/search/crawl']) {
    const response = await send(route, 'legacy')
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { data: { legacy: true } })
  }
  assert.equal(compatibility.length, 2)
  assert.ok(compatibility.every(input => input.path === '/api/v1/night-all/search/crawl'))
  assert.equal(h.calls.length, 3)
})

test('already-issued Twitter mxec2 cursors and exact historical replay keep the original contract', async t => {
  const h = await harness(t, { fetchImpl: call => Response.json(timeline(call.params.cursor ? ['2'] : ['1'], call.params.cursor ? null : 'old-next')) })
  const input = { operation: 'crawl', path: '/api/v1/data/social/crawl', body: { platform: 'twitter', userId: '42', count: 2 }, idempotencyKey: 'historical-twitter-page' }
  const original = await h.gateway.socialData(h.context, input)
  assert.match(original.body.data.page.nextCursor, /^mxec2\./)
  assert.equal(h.calls.length, 1)
  const replay = await h.gateway.socialAccountData(h.context, input)
  assert.deepEqual(replay.body, original.body)
  assert.equal(replay.replay, true)
  assert.equal(h.calls.length, 1)
  const next = await h.gateway.socialAccountData(h.context, { ...input, body: { ...input.body, cursor: original.body.data.page.nextCursor }, idempotencyKey: 'historical-twitter-second' })
  assert.equal(next.body.data.items[0].id, '2')
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].params.cursor, 'old-next')
  assert.equal(h.calls.filter(call => !call.url.pathname.includes('/tweets')).length, 0)
  assert.equal(h.historical.length, 0)
})

async function reviewStep(h, step) {
  await h.controls.updatePolicy(h.provider, step.operationKey || step.operation, {
    expectedRevision: 1, desiredState: 'active', reason: 'Synthetic account workflow regression', priceBook: {
      currency: 'USD', pricingAsOf: '2026-10-15T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: { [step.endpointKey]: 2 },
    },
  }, { runtime: { config: h.config, credentialConfigured: true } })
}

test('user-info lookup can pause before profile acquisition and resume once with its saved resolved account', async t => {
  const h = await harness(t, { platform: 'youtube', fetchImpl: call => Response.json({ code: 200, data: call.url.pathname.endsWith('get_channel_id')
    ? { channel_id: '42' } : { channel: { channel_id: '42', channel_name: 'Fixture Channel', subscribers: 12 } } }) })
  const body = { platform: 'youtube', username: 'fixture_channel' }
  const job = normalizeHubSocialCompatRequest('user-info', body).jobs[0]
  await reviewStep(h, buildHubSocialCompatDispatch(job))
  let admissions = 0
  h.platformStore.acquireProviderRateLimit = async () => ({ allowed: ++admissions === 1 })
  const first = await h.invoke(body, 'social-profile-resolution', 'user-info')
  assert.equal(first.body.data.items.length, 0)
  assert.equal(first.body.data.status, 'partial')
  assert.ok(first.body.data.page.nextCursor)
  assert.equal(h.calls.length, 1)
  h.platformStore.acquireProviderRateLimit = async () => ({ allowed: true })
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-profile-resolved', 'user-info')
  assert.equal(second.body.data.items[0].user_id, '42')
  assert.equal(second.body.data.items[0].name, 'Fixture Channel')
  assert.equal(second.body.data.page.nextCursor, null)
  assert.equal(h.calls.length, 2)
  assert.ok(h.calls[0].url.pathname.endsWith('get_channel_id'))
  assert.ok(h.calls[1].url.pathname.endsWith('get_channel_info'))
  assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
})

test('Instagram followers are profile rows and archived overflow drains without manufacturing content IDs', async t => {
  const h = await harness(t, { platform: 'instagram', fetchImpl: call => Response.json({ code: 200, data: call.url.pathname.endsWith('fetch_user_info')
    ? { user: { id: '42', username: 'fixture_account' } }
    : { users: ['51', '52', '53'].map(id => ({ id, username: `follower_${id}` })), has_more: false } }) })
  const body = { platform: 'instagram', userId: '42', activityTypes: ['followers'], count: 2 }
  const job = normalizeHubSocialCompatRequest('crawl', body).jobs[0]
  await reviewStep(h, buildHubSocialCompatDispatch(job, { resolvedIdentity: { kind: 'id', value: '42', username: 'fixture_account', profileReady: true } }))
  const first = await h.invoke(body)
  assert.deepEqual(first.body.data.items.map(row => row.user_id), ['51', '52'])
  assert.ok(first.body.data.items.every(row => !Object.hasOwn(row, 'content_id')))
  assert.deepEqual(JSON.parse(first.body.data.raw_info).map(row => row.user_id), ['42', '51', '52'])
  assert.equal(JSON.parse(first.body.data.raw_info).some(row => row.user_id === '53'), false)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-followers-next')
  assert.deepEqual(second.body.data.items.map(row => row.user_id), ['53'])
  assert.deepEqual(JSON.parse(second.body.data.raw_info).map(row => row.user_id), ['42', '53'])
  assert.equal(JSON.parse(second.body.data.raw_info).some(row => ['51', '52'].includes(row.user_id)), false)
  assert.equal(second.body.data.page.hasMore, false)
  assert.equal(h.calls.length, 2)
  const records = h.platformStore.ingestJobs.flatMap(job => job.payload.records)
  assert.ok(records.some(record => record.objectType === 'profile' && record.externalId === '51'))
  assert.ok(records.some(record => record.objectType === 'profile' && record.externalId === '53'))
  assert.equal(records.filter(record => record.objectType === 'post').length, 0)
})

test('mixed account activities do not deduplicate a post and a follower that share the same native ID', async t => {
  const h = await harness(t, { platform: 'instagram', fetchImpl: call => Response.json({ code: 200, data: call.url.pathname.endsWith('fetch_user_info')
    ? { user: { id: '42', username: 'fixture_account' } }
    : call.url.pathname.endsWith('fetch_user_followers') ? { users: [{ id: '51', username: 'follower_51' }], has_more: false }
      : { items: [{ id: '51', caption: { text: 'Post fifty-one' }, user: { id: '42', username: 'fixture_account' } }], has_more: false } }) })
  const body = { platform: 'instagram', userId: '42', activityTypes: ['posts', 'followers'], count: 1 }
  const job = normalizeHubSocialCompatRequest('crawl', body).jobs[1]
  await reviewStep(h, buildHubSocialCompatDispatch(job, { resolvedIdentity: { kind: 'id', value: '42', username: 'fixture_account', profileReady: true } }))
  const result = await h.invoke(body)
  assert.equal(result.body.data.items.length, 2)
  assert.deepEqual(result.body.data.items.map(row => row.objectType), ['post', 'user'])
  assert.equal(result.body.data.page.duplicateCount, 0)
  assert.equal(h.calls.length, 4)
})

test('a supplier cursor cycle across public pages is detected before repurchasing the same page', async t => {
  let page = 0
  const h = await harness(t, { fetchImpl: call => Response.json(call.url.pathname.includes('/tweets')
    ? timeline([String(++page)], page === 1 ? 'cycle-a' : page === 2 ? 'cycle-b' : 'cycle-a') : profile()) })
  const body = { platform: 'twitter', username: 'ui_batch_019', count: 1 }
  const first = await h.invoke(body)
  const second = await h.invoke({ ...body, cursor: first.body.data.page.nextCursor }, 'social-cycle-second')
  const third = await h.invoke({ ...body, cursor: second.body.data.page.nextCursor }, 'social-cycle-third')
  assert.deepEqual([first, second, third].map(result => result.body.data.items[0].content_id), ['1', '2', '3'])
  assert.equal(third.body.data.page.nextCursor, null)
  assert.ok(third.body.data.warnings.some(warning => warning.code === 'repeated_cursor'))
  assert.equal(h.calls.length, 4)
})

for (const platform of ['twitter', 'facebook', 'weibo']) test(`LCY ${platform} account workflow bypasses Hub capacity/rate with unchanged ordinary slots`, async t => {
  const { LcyHubLimitStore } = await import('../fixtures/lcy-hub-limit-store.mjs')
  const f = await harness(t, { platform, store: new LcyHubLimitStore() })
  f.gateway.active = f.config.maxConcurrency
  f.gateway.activeByConsumer.set(f.context.consumer.id, 2)
  f.platformStore.acquireProviderRateLimit = async () => assert.fail('exempt account must not consume provider tokens')
  Object.assign(f.platformStore.state, { lastErrorCode: 'upstream_rate_limited', circuitOpenUntil: new Date(Date.now() + 60000).toISOString() })
  const result = await f.invoke()
  assert.equal(result.status, 200)
  assert.ok(f.calls.length >= 1)
  assert.equal(f.gateway.active, f.config.maxConcurrency)
  assert.equal(f.gateway.activeByConsumer.get(f.context.consumer.id), 2)
  const before = f.calls.length
  f.store.apiKeys.get(f.context.apiKey.id).hubRateLimitExempt = false
  await assert.rejects(f.invoke({ platform, userId: '55', count: 20 }, 'account-switch-disabled'), error =>
    ['external_platform_busy', 'external_platform_circuit_open'].includes(error.code))
  assert.equal(f.calls.length, before)
})
