import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { createApp } from '../../server/app.mjs'
import { XHS_DISCOVERY_ENDPOINTS as endpoints, normalizeXhsDiscoveryRequest, projectXhsDiscovery } from '../../server/contracts/xiaohongshu-discovery.mjs'
import { createExternalPlatformCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, publicDocsHtmlForPath, tenantOpenApiDocument } from '../../server/public-docs.mjs'
import { capabilityCatalog } from '../../server/data/capability-catalog.mjs'

const PEPPER = 'test-discovery-pepper-more-than-32-bytes'
const SECRET = 'synthetic-provider-secret'
const stamp = '2026-09-23T01:00:00.000Z'
const json = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
// Deliberately synthetic shapes exercise native-field delivery, not live schema attestation.
const envelope = (id, data = { items: [{ title: '模拟内容', premium_imp_num: 0 }], cursor: 'private-next', has_more: true }) => id === 'hot_notes'
  ? { code: 0, data, message: 'success', requestId: 'provider-request', recordTime: stamp }
  : { code: 200, data: { code: 0, success: true, data }, router: 'https://api.tikhub.io/private', params: {}, request_id: 'provider-request' }

async function fixture(id, fetchImpl = async () => json(envelope(id)), { granted = true, active = true } = {}) {
  const endpoint = endpoints[id], store = new MemoryStore(), control = new MemoryExternalPlatformControlStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Discovery tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Discovery caller' })
  await service.putPlatformConfiguration('xiaohongshu', { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  for (const item of Object.values(endpoints)) await service.putCapabilityConfiguration(item.operation, { tenantId: tenant.id, consumerId: consumer.id, enabled: true })
  const key = await service.createApiKey({ name: 'Live discovery', consumerId: consumer.id, platforms: ['xiaohongshu'], capabilities: granted ? [endpoint.operation] : [] })
  const context = await service.authenticate(key.secret)
  const config = { configured: true, contractVerified: true, searchContractVerified: true, userActivityContractVerified: true,
    timeoutMs: 1000, reservationLeaseMs: 150000, maxConcurrency: 4, maxConsumerConcurrency: 4, maxRequestsPerMinute: 120,
    freshTtlMs: 60000, staleTtlMs: 86400000, billing: {} }
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: endpoint.provider, authorizationPlatform: 'xiaohongshu' })
  const adapter = id === 'hot_notes' ? new JustOneAdapter({ token: SECRET, fetchImpl }) : new TikHubAdapter({ apiKey: SECRET, fetchImpl })
  const Gateway = id === 'hot_notes' ? ExternalPlatformGateway : TikHubGateway
  const gateway = new Gateway({ usageStore: store, platformStore, adapter, config, operationControlStore: control,
    apiKeyPepper: PEPPER, reservationLeaseMs: 150000, logger: { warn() {}, error() {} } })
  if (active) await control.updatePolicy(endpoint.provider, endpoint.operation, { expectedRevision: 0, desiredState: 'active', reason: 'Synthetic test only', priceBook: {
    currency: id === 'hot_notes' ? 'CNY' : 'USD', pricingAsOf: stamp, monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 1 },
  } }, { runtime: { config, credentialConfigured: true } })
  const call = (body = {}, idempotencyKey = 'discovery-first-001', ctx = context) => id === 'hot_notes'
    ? gateway.hotXiaohongshuNotes(ctx, { body, idempotencyKey, path: endpoint.path })
    : gateway.officialXiaohongshu(ctx, { endpointName: id, query: body, idempotencyKey, method: 'POST', path: endpoint.path })
  return { endpoint, store, service, tenant, consumer, key, context, config, control, gateway, platformStore, call }
}

for (const id of Object.keys(endpoints)) {
  test(`${id}: fixed provider, one dispatch/page, immutable replay and provider-separated evidence`, async () => {
    const requests = []
    const state = await fixture(id, async (url, options) => {
      const parsed = new URL(url); requests.push(parsed)
      assert.equal(parsed.pathname, endpoints[id].providerPath)
      assert.equal(options.method, 'GET')
      if (id === 'hot_notes') assert.equal(parsed.searchParams.get('token'), SECRET)
      else assert.equal(options.headers.authorization, `Bearer ${SECRET}`)
      return json(envelope(id))
    })
    const first = await state.call()
    assert.equal(first.status, 200)
    assert.equal(first.body.data.result.items[0].premium_imp_num, 0)
    assert.doesNotMatch(JSON.stringify(first.body), /synthetic-provider-secret|private-next|provider-request|api.tikhub/)
    const replay = await state.call()
    assert.equal(replay.replay, true); assert.deepEqual(replay.body, first.body); assert.equal(requests.length, 1)
    const next = first.body.data.pageInfo.nextCursor
    assert.match(next, /^mxec2\./)
    await assert.rejects(state.call({ cursor: next }), { code: 'idempotency_conflict' })
    await state.call({ cursor: next }, 'discovery-page2-002')
    assert.equal(requests.length, 2)
    assert.equal(requests[0].searchParams.get(id === 'hot_notes' ? 'pageNum' : 'cursor'), id === 'hot_notes' ? '1' : '')
    assert.equal(requests[1].searchParams.get(id === 'hot_notes' ? 'pageNum' : 'cursor'), id === 'hot_notes' ? '2' : 'private-next')
    const calls = [...state.platformStore.calls.values()]
    assert.equal(calls.length, 2); assert.equal(calls[0].providerKey, state.endpoint.provider)
    assert.equal(calls[0].operation, state.endpoint.operation)
    assert.equal(calls[0].endpointKey, state.endpoint.endpointKey)
    assert.ok(state.platformStore.restrictedResponseArchives.size > 0)
    assert.equal(state.platformStore.ingestJobs.length, 0, 'unreviewed native rows are not canonical notes')
  })

  test(`${id}: new capabilities never inherit old grants, controls, or an absent idempotency key`, async () => {
    const denied = await fixture(id, async () => assert.fail('must not dispatch'), { granted: false })
    await assert.rejects(denied.call(), { status: 403 })
    const disabled = await fixture(id, async () => assert.fail('must not dispatch'), { active: false })
    await assert.rejects(disabled.call(), { code: 'external_platform_operation_disabled' })
    const state = await fixture(id, async () => assert.fail('must not dispatch'))
    await assert.rejects(state.call({}, null), { code: 'idempotency_key_required' })
    for (const body of [{ token: 'forbidden' }, { provider: 'other' }, { pageNum: 2 }, { url: 'https://evil.example' }, { cursor: '2' }]) await assert.rejects(state.call(body), { status: 400 })
  })

  test(`${id}: cursors bind Key and consumer before dispatch; revocation also blocks replay`, async () => {
    let calls = 0
    const state = await fixture(id, async () => { calls++; return json(envelope(id)) })
    const first = await state.call()
    const key2 = await state.service.createApiKey({ name: 'Second key', consumerId: state.consumer.id, platforms: ['xiaohongshu'], capabilities: [state.endpoint.operation] })
    const context2 = await state.service.authenticate(key2.secret)
    await assert.rejects(state.call({ cursor: first.body.data.pageInfo.nextCursor }, 'discovery-other-key', context2), { status: 400 })
    assert.equal(calls, 1)
    await state.service.putCapabilityConfiguration(state.endpoint.operation, { tenantId: state.tenant.id, consumerId: state.consumer.id, enabled: false })
    await assert.rejects(state.call(), { status: 403 })
    assert.equal(calls, 1)
  })

  test(`${id}: ambiguous transport never silently retries, successful empty result bills exactly once`, async () => {
    let attempts = 0
    const failed = await fixture(id, async () => { attempts++; throw new Error('transport lost') })
    await assert.rejects(failed.call())
    await assert.rejects(failed.call())
    assert.equal(attempts, 1)
    const state = await fixture(id, async () => json(envelope(id, [])))
    await state.service.setTenantBillingProfile(state.tenant.id, { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 7, defaultCurrency: 'CNY' }, 'test')
    await state.service.addTenantCredit(state.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Synthetic credit' }, { idempotencyKey: `credit-${id}-001`, actor: 'test' })
    const first = await state.call(); await state.call()
    assert.equal(first.body.meta.status, 'no_data'); assert.equal(first.body.data.pageInfo.nextCursor, null)
    const billing = await state.service.getTenantBilling(state.tenant.id)
    assert.equal(billing.account.availableMinor, 93)
    assert.equal(billing.ledger.filter(row => row.kind === 'capture').length, 1)
  })
}

test('hot notes retains filters; unconfirmed next page remains unknown and malformed data is not an empty result', () => {
  const codec = createExternalPlatformCursorCodec(PEPPER, 'test-consumer')
  const body = { searchWord: '护肤', orderBy: 'premium_read_num', nd: 'DAY_3', noteContentCategory: '内容类目#护肤' }
  const request = normalizeXhsDiscoveryRequest('hot_notes', body)
  const first = projectXhsDiscovery(envelope('hot_notes', { items: [{ title: '模拟笔记' }] }), request, stamp, { encodeCursor: codec.encode })
  assert.equal(first.data.pageInfo.hasMore, null)
  assert.equal(first.data.pageInfo.paginationStatus, 'next_page_probe')
  const next = normalizeXhsDiscoveryRequest('hot_notes', { ...body, cursor: first.data.pageInfo.nextCursor }, { decodeCursor: codec.decode })
  assert.deepEqual(next.providerQuery, { ...body, pageNum: 2 })
  assert.throws(() => normalizeXhsDiscoveryRequest('hot_notes', { ...body, nd: 'DAY_7', cursor: first.data.pageInfo.nextCursor }, { decodeCursor: codec.decode }), { status: 400 })
  assert.equal(projectXhsDiscovery(envelope('hot_notes', null), request, stamp).meta.status, 'unknown')
  assert.equal(projectXhsDiscovery(envelope('hot_notes', {}), request, stamp).meta.status, 'unknown')
  assert.throws(() => projectXhsDiscovery(envelope('hot_notes', { success: false, data: [] }), request, stamp), { status: 502 })
  const unknown = projectXhsDiscovery(envelope('hot_notes', { unreviewed: { completeText: '完整内容'.repeat(1000) } }), request, stamp)
  assert.equal(unknown.meta.returnedCount, null)
  assert.equal(unknown.data.result.unreviewed.completeText.length, 4000)
  assert.equal(unknown.data.pageInfo.nextCursor, null)
})

test('inspiration stops at repeated cursor, explicit end, empty page, and fifteen-page limit', () => {
  const codec = createExternalPlatformCursorCodec(PEPPER, 'test-consumer')
  let request = normalizeXhsDiscoveryRequest('creator_inspiration', {})
  for (let page = 1; page <= 15; page++) {
    const projected = projectXhsDiscovery(envelope('creator_inspiration', { items: [{}], cursor: String(page), has_more: true }), request, stamp, { encodeCursor: codec.encode })
    if (page < 15) request = normalizeXhsDiscoveryRequest('creator_inspiration', { cursor: projected.data.pageInfo.nextCursor }, { decodeCursor: codec.decode })
    else { assert.equal(projected.data.pageInfo.nextCursor, null); assert.equal(projected.data.pageInfo.paginationStatus, 'limit_reached') }
  }
  for (const data of [{ items: [], cursor: 'new', has_more: true }, { items: [{}], cursor: 'new', has_more: false }, { items: [{}], cursor: request.providerCursor }]) {
    const projected = projectXhsDiscovery(envelope('creator_inspiration', data), { ...request, page: 2 }, stamp, { encodeCursor: codec.encode })
    assert.equal(projected.data.pageInfo.nextCursor, null)
  }
})

test('HTTP, OpenAPI, tenant docs and generated product inventory agree on independent products', async t => {
  const hot = await fixture('hot_notes'), inspiration = await fixture('creator_inspiration')
  for (const state of [hot, inspiration]) {
    const server = createServer(createApp({ service: state.service, store: state.store, adapter: {},
      xiaohongshuHotNotesGateway: state.endpoint.id === 'hot_notes' ? state.gateway : null,
      tikHubGateway: state.endpoint.id === 'creator_inspiration' ? state.gateway : null,
      listenerMode: 'public', logger: { error() {}, warn() {} } }))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    t.after(() => new Promise(resolve => server.close(resolve)))
    const url = `http://127.0.0.1:${server.address().port}${state.endpoint.path}`
    const headers = { authorization: `Bearer ${state.key.secret}`, 'content-type': 'application/json', 'idempotency-key': 'discovery-http-001' }
    assert.equal((await fetch(url, { method: 'POST', body: '{}' })).status, 401)
    assert.equal((await fetch(url, { headers })).status, 405)
    assert.equal((await fetch(url + '?provider=other', { method: 'POST', headers, body: '{}' })).status, 400)
    const response = await fetch(url, { method: 'POST', headers, body: '{}' })
    assert.equal(response.status, 200); assert.ok(response.headers.get('x-mx-insight-request-id'))
    const path = state.endpoint.path.slice('/api/v1'.length)
    assert.deepEqual(PUBLIC_OPENAPI_DOCUMENT.paths[path].post['x-mx-required-capabilities'], [state.endpoint.operation])
    assert.equal(tenantOpenApiDocument([{ platforms: ['xiaohongshu'], capabilities: ['social.posts.resolve'] }]).paths[path], undefined)
    const html = publicDocsHtmlForPath(`/docs/${state.endpoint.key}`, { tenant: true, scopes: [{ platforms: ['xiaohongshu'], capabilities: [state.endpoint.operation] }] })
    assert.match(html, /pageInfo.nextCursor/)
    assert.doesNotMatch(html, /api.justoneapi|api.tikhub|synthetic-provider-secret/)
  }
  assert.deepEqual(capabilityCatalog().issues, [])
})
