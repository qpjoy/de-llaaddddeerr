import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { rapidApiConfig } from '../../server/external-platforms/rapidapi-config.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch } from '../../server/contracts/hub-social-compat.mjs'
import { twitterAccountFailure, twitterLookupFoundNoAccount } from '../../server/contracts/twitter-account-failure.mjs'

const PEPPER = 'offline-twitter-numeric-fallback-sufficiently-long-pepper'
const ID = '1952056883877212160'
const user = (username, id) => ({ rest_id: id, legacy: { screen_name: username, name: `Fixture ${username}`,
  followers_count: 0, friends_count: 5, created_at: '2020-01-01T00:00:00Z' } })
const profile = (username, id) => ({ data: { user: { result: user(username, id) } } })
const timeline = (ids, username, userId) => ({ data: { user: { result: { ...user(username, userId), timeline: { instructions: [{
  type: 'TimelineAddEntries', entries: ids.map(id => ({ entryId: `tweet-${id}`, content: { itemContent: { tweet_results: { result: {
    rest_id: id, legacy: { full_text: `正文 ${id}`, favorite_count: 0, created_at: '2026-10-15T00:00:00Z', entities: { hashtags: [] } },
    core: { user_results: { result: user(username, userId) } } } } } } })),
}] } } } } })
const MISSING = '{"data":{},"userExists":false}'
const NOT_FOUND_BY_ID = JSON.stringify({ data: { users: [{ result: { __typename: 'UserUnavailable', reason: 'NotFound', message: 'User not found' } }] } })
const fixedResponse = body => new Response(body, { headers: { 'content-type': 'application/json' } })

async function harness(t, fetchImpl, platformOptions = {}) {
  const calls = [], store = new MemoryStore()
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch() { throw new Error('Unexpected Night-All dispatch') },
    async search() { throw new Error('Unexpected Night-All dispatch') },
  } })
  const tenant = await service.createTenant({ name: 'Offline numeric account fallback' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic account caller' })
  await store.setPlatformGrant(consumer.id, 'twitter', true)
  await store.putPolicy({ tenantId: tenant.id, consumerId: consumer.id, platform: 'twitter',
    maxRequests: 100000, windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 1000 })
  const capabilities = ['social.content.crawl', 'social.profile.get']
  for (const capability of capabilities) await service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic live Key', platforms: ['twitter'], capabilities })
  const context = await service.authenticate(key.secret)
  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', multiplierPpm: 1000000,
    defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await service.addTenantCredit(tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline account fixture' },
    { idempotencyKey: 'numeric-fallback-credit', actor: 'offline-admin' })
  const config = { ...rapidApiConfig(), configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  const job = normalizeHubSocialCompatRequest('crawl', { platform: 'twitter', userId: '42', count: 20 }).jobs[0]
  for (const step of [buildHubSocialCompatDispatch(job), buildHubSocialCompatDispatch(job, {
    resolvedIdentity: { kind: 'id', value: '42', username: 'fixture', lookupComplete: true, profileReady: true } })]) {
    await controls.updatePolicy('rapidapi', step.operationKey, { expectedRevision: 1, desiredState: 'active', reason: 'Synthetic numeric fallback',
      priceBook: { currency: 'USD', pricingAsOf: '2026-10-15T00:00:00Z', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
        unitCostMinorByEndpoint: { [step.endpointKey]: 2 } } }, { runtime: { config, credentialConfigured: true } })
  }
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-rapidapi-key', timeoutMs: 100, fetchImpl: async (url, options) => {
    const parsed = new URL(url)
    calls.push({ url: parsed, params: Object.fromEntries(parsed.searchParams) })
    return fetchImpl(parsed, options)
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'rapidapi',
    authorizationPlatform: 'twitter', uncertainCooldownMs: 900000, ...platformOptions })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'rapidapi',
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, operationControlStore: controls, logger: { warn() {} } })
  const invoke = (operation, body, idempotencyKey) => gateway.socialAccountData(context,
    { operation, body: { platform: 'twitter', ...body }, idempotencyKey, path: `/api/v1/data/social/${operation}` })
  const providerCalls = () => [...platformStore.calls.values()].sort((a, b) => a.callOrdinal - b.callOrdinal)
  return { store, service, platformStore, gateway, key, calls, invoke, providerCalls }
}

test('an explicit historical quarantine fixture is not reported as an in-flight request', async t => {
  const wire = '{"data":{"users":[{}]}}'
  assert.equal(Buffer.byteLength(wire), 23)
  assert.equal(createHash('sha256').update(wire).digest('hex'),
    '5fa2d36df254afe1af3d16f5752a63928faf7d2264429d6060197295587715e4')
  const h = await harness(t, () => fixedResponse(wire), { responseQuarantineCooldownMs: 300000 })
  const body = { usernames: ['11'], count: 50, activityTypes: ['posts'] }
  await assert.rejects(h.invoke('crawl', body, 'empty-user-original'), {
    status: 502, code: 'external_platform_response_unusable',
  })
  const [call] = h.providerCalls()
  assert.equal(call.outcome, 'succeeded_unusable')
  assert.equal(call.billed, null)
  assert.equal(h.calls[0].url.pathname, '/user/users/by/ids')
  assert.equal(h.calls[0].params.ids, '11')
  assert.equal(Buffer.from(h.platformStore.restrictedResponseArchives.get(call.id).bodyBytes).toString(), wire)
  assert.equal(h.platformStore.leases.size, 0)
  const original = structuredClone(h.store.requests.get(call.usageRequestId))
  for (const key of ['empty-user-blocked', 'empty-user-blocked']) {
    await assert.rejects(h.invoke('crawl', body, key), error => {
      assert.equal(error.status, 409)
      assert.equal(error.code, 'external_platform_response_unusable')
      assert.equal(error.details.upstreamDispatched, false)
      assert.equal(error.details.blockedUntil, new Date(Date.parse(call.completedAt) + 300000).toISOString())
      assert.doesNotMatch(error.message, /in progress|pending/iu)
      return true
    })
  }
  await assert.rejects(h.invoke('crawl', body, 'empty-user-original'), {
    status: 502, code: 'external_platform_response_unusable',
  })
  assert.equal(h.calls.length, 1) // No username fallback, tweets or retry purchase.
  assert.equal(h.platformStore.calls.size, 1)
  assert.equal(h.platformStore.leases.size, 0)
  assert.deepEqual(h.store.requests.get(call.usageRequestId), original)
  for (const usage of h.store.requests.values()) {
    if (usage.idempotencyKey !== 'empty-user-blocked') continue
    assert.equal(usage.status, 'released')
    assert.equal(h.store.customerCharges.get(usage.id).status, 'released')
  }
})

test('empty Twitter profile does not cool down a new request; original failure and new success remain idempotent', async t => {
  const wire = '{"data":{"users":[{}]}}'
  let attempts = 0
  const h = await harness(t, url => ++attempts === 1 ? fixedResponse(wire)
    : url.pathname === '/user/users/by/ids' ? Response.json(profile('fixture11', '11'))
      : Response.json(timeline(['111'], 'fixture11', '11')))
  const body = { usernames: ['11'], count: 50, activityTypes: ['posts'] }
  assert.equal(h.platformStore.responseQuarantineCooldownMs, 0)
  await assert.rejects(h.invoke('crawl', body, 'empty-user-first'), {
    status: 502, code: 'external_platform_response_unusable',
  })
  const [firstCall] = h.providerCalls()
  const firstUsage = h.store.requests.get(firstCall.usageRequestId)
  const before = structuredClone({ call: firstCall, usage: firstUsage,
    archive: h.platformStore.restrictedResponseArchives.get(firstCall.id),
    charge: h.store.customerCharges.get(firstUsage.id) })
  await assert.rejects(h.invoke('crawl', body, 'empty-user-first'), {
    status: 502, code: 'external_platform_response_unusable',
  })
  assert.equal(h.calls.length, 1)
  const result = await h.invoke('crawl', body, 'empty-user-new-intent')
  assert.equal(result.status, 200)
  assert.deepEqual(result.body.data.items.map(item => item.id), ['twitter:111'])
  assert.deepEqual(h.calls.map(call => call.url.pathname),
    ['/user/users/by/ids', '/user/users/by/ids', '/user/11/tweets'])
  assert.deepEqual((await h.invoke('crawl', body, 'empty-user-new-intent')).body, result.body)
  await assert.rejects(h.invoke('crawl', body, 'empty-user-first'), {
    status: 502, code: 'external_platform_response_unusable',
  })
  assert.equal(h.calls.length, 3)
  assert.equal(h.store.customerCharges.size, 2)
  assert.equal(h.platformStore.leases.size, 0)
  assert.deepEqual(structuredClone({ call: h.platformStore.calls.get(firstCall.id), usage: h.store.requests.get(firstUsage.id),
    archive: h.platformStore.restrictedResponseArchives.get(firstCall.id),
    charge: h.store.customerCharges.get(firstUsage.id) }), before)
})

test('only an explicit no-account answer to an ID lookup permits a username lookup', () => {
  assert.deepEqual(twitterAccountFailure(JSON.parse(NOT_FOUND_BY_ID)), { code: 'social_account_unavailable', reason: 'not_found' })
  for (const [evidence, expected] of [
    [{ outcome: 'rejected', errorCode: 'social_account_not_found' }, true],
    [{ outcome: 'rejected', errorCode: 'social_account_unavailable', accountReason: 'not_found' }, true],
    [{ outcome: 'rejected', errorCode: 'social_account_unavailable', accountReason: 'deleted' }, true],
    ...['suspended', 'deactivated', 'protected', 'unavailable', undefined].map(accountReason =>
      [{ outcome: 'rejected', errorCode: 'social_account_unavailable', accountReason }, false]),
    [{ outcome: 'unknown', errorCode: 'social_account_not_found' }, false],
    [{ outcome: 'unknown', errorCode: 'social_upstream_timeout_or_size_limit' }, false],
    [{ outcome: 'succeeded_unusable', errorCode: 'social_upstream_response_unusable' }, false],
    [{ outcome: 'rejected', errorCode: 'social_upstream_rejected' }, false],
    [null, false],
  ]) assert.equal(twitterLookupFoundNoAccount(evidence), expected, JSON.stringify(evidence))
})

for (const operation of ['crawl', 'user-info']) {
  test(`Twitter ${operation}: bare digits with no account behind the ID are looked up once as a username`, async t => {
    for (const [label, idAnswer] of [['userExists:false', MISSING], ['UserUnavailable NotFound', NOT_FOUND_BY_ID]]) await t.test(label, async t => {
      const h = await harness(t, url => url.pathname === '/user/users/by/ids' ? fixedResponse(idAnswer)
        : url.pathname === '/user/by/username/12345' ? Response.json(profile('12345', '99'))
          : url.pathname === '/user/99/tweets' ? Response.json(timeline(['991'], '12345', '99'))
            : Response.json({ error: 'unexpected path' }, { status: 500 }))
      const body = { userId: '12345', ...(operation === 'crawl' ? { count: 5 } : {}) }
      const result = await h.invoke(operation, body, `numeric-fallback-${operation}`)
      assert.equal(result.status, 200)
      assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids', '/user/by/username/12345',
        ...(operation === 'crawl' ? ['/user/99/tweets'] : [])])
      assert.equal(h.calls[0].params.ids, '12345')
      const account = JSON.parse(result.body.data.raw_info)[0]
      assert.equal(account.user_id, '99')
      assert.equal(account.username, '12345')
      if (operation === 'crawl') assert.deepEqual(result.body.data.items.map(item => item.id), ['twitter:991'])
      assert.equal(result.body.data.meta.providerCalls, h.calls.length)
      assert.deepEqual(result.body.data.warnings.filter(row => ['repeated_cursor', 'social_page_fill_stopped'].includes(row.code)), [])
      // The ID refusal stays on record as its own settled call, with its receipt,
      // and is not a supplier fault.
      const [byId, byName] = h.providerCalls()
      assert.equal(byId.outcome, 'rejected')
      assert.equal(byId.errorCode, idAnswer === MISSING ? 'social_account_not_found' : 'social_account_unavailable')
      assert.equal(byId.endpointKey, 'twitter-aio.user-info')
      assert.equal(byId.billed, null)
      assert.equal(byId.costMinor, 2)
      assert.equal(Buffer.from(h.platformStore.restrictedResponseArchives.get(byId.id).bodyBytes).toString(), idAnswer)
      assert.equal(byName.outcome, 'succeeded')
      assert.equal(byName.callOrdinal, 1)
      assert.equal(h.platformStore.state.consecutiveFailures, 0)
      assert.equal(await h.platformStore.contractCircuitState('rapidapi', 'twitter'), null)
      // One customer request, one charge, however many lookups it took.
      const usage = h.store.requests.get(byId.usageRequestId)
      assert.equal(usage.status, 'committed')
      assert.equal(usage.responseStatus, 200)
      assert.equal(h.store.customerCharges.size, 1)
      assert.equal(h.store.customerCharges.get(usage.id).chargedMinor, 3)
      const replay = await h.invoke(operation, body, `numeric-fallback-${operation}`)
      assert.equal(replay.replay, true)
      assert.deepEqual(replay.body, result.body)
      assert.equal(h.calls.length, operation === 'crawl' ? 3 : 2)
    })
  })

  test(`Twitter ${operation}: when neither the ID nor the handle exists, the username answer is the 404`, async t => {
    const h = await harness(t, () => fixedResponse(MISSING))
    const body = { username: ID, ...(operation === 'crawl' ? { page_size: 30 } : {}) }
    const check = error => {
      assert.equal(error.status, 404)
      assert.equal(error.code, 'social_account_not_found')
      assert.deepEqual(Object.keys(error.details).filter(name => name !== 'requestId').sort(), ['outcome', 'platform', 'retryable', 'stage'])
      assert.equal(error.details.stage, 'account_lookup')
      return true
    }
    await assert.rejects(h.invoke(operation, body, `neither-${operation}`), check)
    assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids', `/user/by/username/${ID}`])
    assert.deepEqual(h.providerCalls().map(call => [call.outcome, call.errorCode]),
      [['rejected', 'social_account_not_found'], ['rejected', 'social_account_not_found']])
    const usage = h.store.requests.get(h.providerCalls()[0].usageRequestId)
    assert.equal(usage.status, 'committed')
    assert.equal(usage.responseStatus, 404)
    assert.equal(h.store.customerCharges.size, 1)
    assert.equal(h.platformStore.state.consecutiveFailures, 0)
    await assert.rejects(h.invoke(operation, body, `neither-${operation}`), check)
    assert.equal(h.calls.length, 2)
  })
}

test('withheld, unknown or unusable ID lookups never buy a username lookup', async t => {
  for (const [label, answer, expected] of [
    ['suspended account', () => fixedResponse(JSON.stringify({ data: { users: [{ result: { __typename: 'UserUnavailable', reason: 'Suspended' } }] } })),
      { status: 422, code: 'social_account_unavailable' }],
    ['unavailable without a reason', () => fixedResponse(JSON.stringify({ data: { users: [{ __typename: 'UserUnavailable' }] } })),
      { status: 422, code: 'social_account_unavailable' }],
    ['empty user list', () => fixedResponse('{"data":{"users":[]}}'), { status: 502, code: 'external_platform_response_unusable' }],
    ['upstream 500', () => Response.json({ message: 'boom' }, { status: 500 }), { status: 502, code: 'upstream_outcome_unknown', usage: 'unknown' }],
    ['timeout', (url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason))),
      { status: 502, code: 'upstream_outcome_unknown', usage: 'unknown' }],
  ]) await t.test(label, async t => {
    const h = await harness(t, answer)
    await assert.rejects(h.invoke('user-info', { userId: '12345' }, `no-fallback-${label.replaceAll(' ', '-')}`), error => {
      assert.equal(error.status, expected.status)
      assert.equal(error.code, expected.code)
      return true
    })
    assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids'])
    assert.equal(h.platformStore.calls.size, 1)
    assert.equal(h.store.requests.get(h.providerCalls()[0].usageRequestId).status, expected.usage ?? 'committed')
  })
})

test('handles named as handles, URLs and over-long digit strings go straight to one username lookup', async t => {
  for (const [body, handle] of [[{ username: '@12345' }, '12345'], [{ url: 'https://x.com/12345' }, '12345'],
    [{ userId: '12345678901234567890' }, '12345678901234567890']]) {
    const h = await harness(t, () => fixedResponse(MISSING))
    await assert.rejects(h.invoke('user-info', body, 'handle-only'), { status: 404, code: 'social_account_not_found' })
    assert.deepEqual(h.calls.map(call => call.url.pathname), [`/user/by/username/${handle}`])
  }
})

test('a username lookup refused before dispatch leaves the ID refusal as the committed answer', async t => {
  const h = await harness(t, url => url.pathname === '/user/users/by/ids' ? fixedResponse(MISSING) : Response.json(profile('12345', '99')))
  const reserve = h.platformStore.reserveProviderCostWorkflow.bind(h.platformStore)
  let reservations = 0
  h.platformStore.reserveProviderCostWorkflow = async input => {
    if (++reservations === 2) throw new AppError(429, 'external_platform_rate_limited', 'Synthetic refusal of the second lookup')
    return reserve(input)
  }
  const check = error => {
    assert.equal(error.status, 404)
    assert.equal(error.code, 'social_account_not_found')
    assert.equal(error.details.stage, 'account_lookup')
    return true
  }
  await assert.rejects(h.invoke('crawl', { userId: '12345', count: 5 }, 'undispatched-username-lookup'), check)
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids'])
  const [call] = h.providerCalls()
  assert.equal(h.platformStore.calls.size, 1)
  assert.equal(call.outcome, 'rejected')
  assert.equal(call.errorCode, 'social_account_not_found')
  const usage = h.store.requests.get(call.usageRequestId)
  assert.equal(usage.status, 'committed')
  assert.equal(usage.responseStatus, 404)
  assert.equal(usage.unitsActual, 0)
  assert.equal(usage.responseBody.error.code, 'social_account_not_found')
  assert.equal(h.store.customerCharges.size, 1)
  await assert.rejects(h.invoke('crawl', { userId: '12345', count: 5 }, 'undispatched-username-lookup'), check)
  assert.equal(h.calls.length, 1)
})

test('an ID refusal whose settlement cannot be written stays unknown and buys nothing more', async t => {
  const h = await harness(t, url => url.pathname === '/user/users/by/ids' ? fixedResponse(MISSING) : Response.json(profile('12345', '99')))
  h.platformStore.finishProviderStep = async () => { throw new Error('Synthetic settlement write failure') }
  await assert.rejects(h.invoke('user-info', { userId: '12345' }, 'unsettled-id-lookup'), { status: 503, code: 'request_outcome_unknown' })
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids'])
  const [call] = h.providerCalls()
  assert.equal(h.store.requests.get(call.usageRequestId).status, 'unknown')
})

test('the reported 19-digit identifier falls back over HTTP on both account routes', async t => {
  const h = await harness(t, url => url.pathname === '/user/users/by/ids' ? fixedResponse(MISSING)
    : Response.json(url.pathname === `/user/by/username/${ID}` ? profile(ID, '7') : timeline(['71'], ID, '7')))
  const server = createServer(createApp({ service: h.service, store: h.store, adapter: {}, adminToken: null,
    listenerMode: 'public', logger: { error() {} }, hubSocialGateway: { socialData: (context, input) => h.gateway.socialAccountData(context, input) } }))
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  t.after(() => new Promise(resolve => server.close(resolve)))
  for (const operation of ['user-info', 'crawl']) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/v1/data/social/${operation}`, { method: 'POST',
      headers: { Authorization: `Bearer ${h.key.secret}`, 'Content-Type': 'application/json', 'Idempotency-Key': `http-numeric-fallback-${operation}` },
      body: JSON.stringify({ platform: 'twitter', userId: ID, ...(operation === 'crawl' ? { count: 1 } : {}) }) })
    const body = await response.json()
    assert.equal(response.status, 200, JSON.stringify(body))
    assert.equal(JSON.parse(body.data.raw_info)[0].user_id, '7')
    if (operation === 'crawl') assert.deepEqual(body.data.items.map(item => item.id), ['twitter:71'])
  }
  assert.deepEqual(h.calls.map(call => call.url.pathname), ['/user/users/by/ids', `/user/by/username/${ID}`,
    '/user/users/by/ids', `/user/by/username/${ID}`, '/user/7/tweets'])
})
