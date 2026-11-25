import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { createApp } from '../../server/app.mjs'
import { AppError } from '../../server/core/errors.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { SHARE_LINK_RESOLVER as product } from '../../shared/share-link-resolver.mjs'

test('share link HTTP requires explicit grants, meters one batch, and keeps share text and tokens out of usage', async t => {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'local-share-link-integration-test-pepper' })
  const tenant = await service.createTenant({ name: 'Link test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Link consumer' })
  const grant = { tenantId: tenant.id, consumerId: consumer.id, enabled: true }
  await service.putPlatformConfiguration(product.platform, grant)
  await service.putCapabilityConfiguration(product.capability, { ...grant, maxRequests: 1 })
  const issue = (overrides = {}) => service.createApiKey({ consumerId: consumer.id, name: 'Link key',
    platforms: [product.platform], capabilities: [product.capability], ...overrides })
  const server = createServer(createApp({ service, store, adapter: {}, listenerMode: 'combined', logger: { error() {} } }))
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = 'http://127.0.0.1:' + server.address().port
  const post = (key, body, suffix = '') => fetch(base + product.apiPath + suffix, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(key && { authorization: 'Bearer ' + key.secret }) },
    body: JSON.stringify(body),
  })
  const noteId = '6afedd3200000000260272af', awemeId = '7711088087472025201'
  const body = { text: '私有分享文案 https://www.xiaohongshu.com/explore/' + noteId
    + '?xsec_token=temporary-sample-token 抖音 https://www.iesdouyin.com/share/note/' + awemeId }
  assert.equal((await post(null, body)).status, 401)
  assert.equal((await post(await issue({ capabilities: [] }), body)).status, 403)
  assert.equal((await post(await issue({ platforms: [] }), body)).status, 403)
  assert.equal((await post(await issue({ environment: 'test' }), body)).status, 403)
  const key = await issue()
  assert.equal((await post(key, { text: 'a', unknown: true })).status, 400)
  assert.equal((await post(key, body, '?unexpected=1')).status, 400)
  const capabilities = await (await fetch(base + '/api/v1/data/capabilities', {
    headers: { authorization: 'Bearer ' + key.secret },
  })).json()
  assert.deepEqual(capabilities.data.capabilities.find(row => row.capability === product.capability),
    { capability: product.capability, ready: true })
  const response = await post(key, body)
  const { data, requestId } = await response.json()
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('x-mx-insight-request-id'), requestId)
  assert.match(response.headers.get('cache-control'), /no-store/)
  assert.deepEqual(data.results.map(row => [row.platform, row.postId]), [['xiaohongshu', noteId], ['douyin', awemeId]])
  assert.equal(data.results[0].xsec_token, 'temporary-sample-token')
  const usage = store.requests.get(requestId)
  assert.equal(usage.status, 'committed')
  assert.equal(usage.unitsActual, 1)
  assert.equal(usage.capability, product.capability)
  assert.equal(usage.acquisitionRequest, null)
  assert.equal(usage.responseBody, null)
  assert.doesNotMatch(JSON.stringify(usage), /私有分享文案|temporary-sample-token|xiaohongshu\.com/)
  assert.equal((await post(key, body)).status, 429)
  await service.putCapabilityConfiguration(product.capability, { ...grant, enabled: false })
  assert.equal((await post(key, body)).status, 403)
})

async function billedShareLinkFixture() {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: 'local-share-link-integration-test-pepper' })
  const tenant = await service.createTenant({ name: 'Link billing test' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Link consumer' })
  const grant = { tenantId: tenant.id, consumerId: consumer.id, enabled: true }
  await service.putPlatformConfiguration(product.platform, grant)
  await service.putCapabilityConfiguration(product.capability, { ...grant, maxRequests: 1 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Link key',
    platforms: [product.platform], capabilities: [product.capability] })
  await service.setTenantBillingProfile(tenant.id, { mode: 'enforced', defaultUnitPriceMinor: 5 }, 'test-admin')
  await service.addTenantCredit(tenant.id, { amountMinor: 20, currency: 'CNY', reason: 'Test credit' },
    { idempotencyKey: 'share-link-test-credit', actor: 'test-admin' })
  return { store, service, context: await service.authenticate(key.secret) }
}

test('share link retries the same reservation after a plan burst, resolves once, and captures one charge', async t => {
  const { store, service, context } = await billedShareLinkFixture()
  // Keep test-runner scheduling from consuming the service's wait budget.
  t.mock.method(performance, 'now', () => 0)
  const originalReserve = store.reserve.bind(store)
  const attempts = []
  t.mock.method(store, 'reserve', async input => {
    attempts.push(input)
    if (attempts.length === 1) {
      assert.equal(store.requests.size, 0)
      throw new AppError(429, 'plan_burst_exceeded', 'Plan burst quota exceeded', { retryAfterMs: 1 })
    }
    return originalReserve(input)
  })
  const link = 'https://v.douyin.com/test/'
  const awemeId = '7711088087472025201'
  const fetchLink = t.mock.method(globalThis, 'fetch', async () =>
    Response.redirect('https://www.douyin.com/video/' + awemeId))

  const { data, requestId } = await service.resolveShareLinks(context, { text: link })
  assert.equal(attempts.length, 2)
  const row = store.requests.get(requestId)
  assert.equal(row.status, 'committed')
  assert.equal(row.unitsActual, 1)
  assert.ok(row.idempotencyKey)
  assert.ok(row.fingerprint)
  for (const attempt of attempts) {
    assert.equal(attempt.requestId, requestId)
    assert.equal(attempt.idempotencyKey, row.idempotencyKey)
    assert.equal(attempt.fingerprint, row.fingerprint)
    assert.equal(attempt.includePlanBurstRetryAfter, true)
  }
  assert.deepEqual(fetchLink.mock.calls.map(call => call.arguments[0]), [link])
  assert.equal(data.results[0].aweme_id, awemeId)
  assert.equal(store.requests.size, 1)
  assert.equal(store.customerCharges.size, 1)
  const { account, ledger } = await service.getTenantBilling(context.tenant.id)
  assert.equal(account.availableMinor, 15)
  assert.equal(account.heldMinor, 0)
  assert.equal(ledger.filter(entry => entry.kind === 'capture').length, 1)
})

test('share link cancellation between reservation and resolution releases the hold without a charge', async t => {
  const { store, service, context } = await billedShareLinkFixture()
  const controller = new AbortController()
  const originalReserve = store.reserve.bind(store)
  t.mock.method(store, 'reserve', async input => {
    const reservation = await originalReserve(input)
    assert.equal(reservation.kind, 'reserved')
    assert.equal((await service.getTenantBilling(context.tenant.id)).account.heldMinor, 5)
    controller.abort()
    return reservation
  })
  const fetchLink = t.mock.method(globalThis, 'fetch', () => assert.fail('A cancelled request cannot fetch the short link'))

  await assert.rejects(service.resolveShareLinks(context, { text: 'https://v.douyin.com/test/' }, controller.signal),
    { status: 499, code: 'request_cancelled' })
  assert.equal(fetchLink.mock.callCount(), 0)
  const [row] = store.requests.values()
  assert.equal(store.requests.size, 1)
  assert.equal(row.status, 'released')
  assert.equal(store.customerCharges.get(row.id).chargedMinor, 0)
  const { account, ledger } = await service.getTenantBilling(context.tenant.id)
  assert.equal(account.availableMinor, 20)
  assert.equal(account.heldMinor, 0)
  assert.equal(ledger.filter(entry => entry.kind === 'capture').length, 0)
  assert.equal(ledger.filter(entry => entry.kind === 'release').length, 1)
})

test('a key exempt from the plan burst uses ordinary share-link reservation and still meters the read', async t => {
  const { store, service, context } = await billedShareLinkFixture()
  store.apiKeys.get(context.apiKey.id).accessProfile = 'managed_full'
  const exemptContext = await store.findApiKeyById(context.apiKey.id)
  const originalReserve = store.reserve.bind(store)
  const reserve = t.mock.method(store, 'reserve', input => {
    assert.equal(input.includePlanBurstRetryAfter, undefined)
    return originalReserve(input)
  })
  const { requestId } = await service.resolveShareLinks(exemptContext, { text: 'https://www.douyin.com/note/7711088087472025201' })
  assert.equal(reserve.mock.callCount(), 1)
  assert.equal(store.requests.get(requestId).status, 'committed')
})
