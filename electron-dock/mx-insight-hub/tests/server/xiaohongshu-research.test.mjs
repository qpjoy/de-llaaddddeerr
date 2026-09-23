import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import test from 'node:test'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { XHS_RESEARCH_ENDPOINTS as endpoints, XHS_RESEARCH_OPERATIONS, normalizeXhsResearchRequest, projectXhsResearch } from '../../server/contracts/xiaohongshu-research.mjs'
import { createExternalPlatformCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { compileBillingComponents } from '../../shared/billing-composition.mjs'
import { PUBLIC_OPENAPI_DOCUMENT, tenantOpenApiDocument, publicDocsHtmlForPath } from '../../server/public-docs.mjs'

const ID = '6a20edfa0000000021020951'
const OTHER = '6a20edfa0000000021020952'
const PEPPER = 'research-test-pepper-32-characters-of-entropy'
const SECRET = 'provider-secret-never-in-a-public-response'
const stamp = new Date('2026-09-23T01:00:00Z')
const response = payload => new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } })
const detail = (data = {}) => ({ code: 200, router: 'https://api.tikhub.io/private', cache_url: 'https://api.tikhub.io/cache', support: 'TikHub support', docs: 'https://docs.tikhub.io', request_id: 'provider-id', data: { code: 0, success: true, data: { noteId: ID, title: '热门笔记', content: '完整正文'.repeat(100), readNum: 0, impNum: 200, likeNum: 10, favNum: 2, cmtNum: 3, imagesList: [{ url: 'https://images.example/note.jpg?signature=preserved' }], ...data } } })
const comments = () => ({ code: 200, data: { code: 0, data: { comments: [{ id: 'comment-1', content: '评论正文', like_count: 2, user_info: { user_id: 'user-1', nickname: '读者' }, sub_comment_count: 1, sub_comments: [{ id: 'reply-1', content: '回复', like_count: 0 }] }], cursor: 'private-next', index: 10, pageArea: 'FOLDED', has_more: true } } })

async function fixture(fetchImpl = async () => response(detail()), { capabilities = XHS_RESEARCH_OPERATIONS, platforms = ['xiaohongshu'] } = {}) {
  const store = new MemoryStore()
  const service = new HubService({ store, adapter: {}, apiKeyPepper: PEPPER })
  const tenant = await service.createTenant({ name: 'Research tenant' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Research caller' })
  await service.putPlatformConfiguration('xiaohongshu', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  for (const capability of XHS_RESEARCH_OPERATIONS) await service.putCapabilityConfiguration(capability, { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600 })
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Research key', platforms, capabilities })
  const context = await service.authenticate(key.secret)
  const adapter = new TikHubAdapter({ apiKey: SECRET, fetchImpl })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'xiaohongshu' })
  const config = { detailQueue: { intervalMs: 5, jitterMs: 0 }, configured: true, contractVerified: true, researchContractVerified: true, searchContractVerified: true, userActivityContractVerified: true, maxConcurrency: 4, maxConsumerConcurrency: 4, maxRequestsPerMinute: 120, freshTtlMs: 60000, staleTtlMs: 86400000, billing: { currency: 'USD', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: Object.fromEntries(Object.values(endpoints).map(endpoint => [endpoint.endpointKey, 1])) } }
  const gateway = new TikHubGateway({ usageStore: store, platformStore, adapter, config, apiKeyPepper: PEPPER, reservationLeaseMs: 150000, logger: { warn() {}, error() {} } })
  const call = (name = 'note_detail', query = { note_id: ID }, key = 'research-request-001', path = endpoints[name].path, ctx = context) => gateway.officialXiaohongshu(ctx, { endpointName: name, query, method: 'POST', idempotencyKey: key, path })
  return { store, service, tenant, consumer, key, context, adapter, platformStore, config, gateway, call }
}

test('detail maps independent metrics, full content/media, missing tags and unknown values', () => {
  const request = normalizeXhsResearchRequest(endpoints.note_detail, { note_id: ID.toUpperCase() })
  const projected = projectXhsResearch(detail({ favNum: undefined }), request, stamp)
  assert.equal(projected.data.item.metrics.views, 0)
  assert.equal(projected.data.item.metrics.impressions, 200)
  assert.equal(projected.data.item.metrics.collected, null)
  assert.equal(projected.data.item.text.length, 400)
  assert.match(projected.data.item.media[0].url, /signature=preserved/)
  assert.equal(projected.meta.tagsAvailable, false)
  assert.doesNotMatch(JSON.stringify(projected), /tikhub|router|cache_url|provider-id/i)
  assert.throws(() => projectXhsResearch(detail({ noteId: OTHER }), request, stamp))
  assert.throws(() => normalizeXhsResearchRequest(endpoints.note_detail, { note_id: ID, url: 'https://evil.test' }))
})

test('detail projects HTTP image CDN addresses as usable HTTPS and retains explicit zero evidence', () => {
  const request = normalizeXhsResearchRequest(endpoints.note_detail, { note_id: ID })
  const raw = detail({ readNum: 0, impNum: 0, likeNum: 0, favNum: 0, cmtNum: 0, imagesList: [
    { url: 'http://ci.xiaohongshu.com/spectrum/test?imageView2/2/w/1080/format/jpg', width: 1080, height: 1440 },
    { url: '', url_size_large: 'https://images.example/second?signature=a%2Fb' },
    { url: 'javascript:invalid', infoList: [{ url: 'https://images.example/third' }] },
    { info_list: 'invalid' },
  ] })
  const projected = projectXhsResearch(raw, request, stamp)
  assert.equal(projected.data.item.media.length, 3)
  assert.deepEqual(projected.data.item.media[0], { type: 'image', url: 'https://ci.xiaohongshu.com/spectrum/test?imageView2/2/w/1080/format/jpg', width: 1080, height: 1440 })
  assert.match(projected.data.item.media[1].url, /signature=a%2Fb$/)
  assert.equal(projected.data.item.metrics.views, 0)
  assert.equal(raw.data.data.imagesList[0].url.startsWith('http:'), true, 'raw acquisition is unchanged')
})

test('detail uses fixed POST JSON; aliases replay once, explicit refresh bypasses shared snapshots, full raw evidence and views ingest persist', async () => {
  let calls = 0
  const state = await fixture(async (url, options) => {
    calls++
    assert.equal(new URL(url).pathname, '/api/v1/xiaohongshu/pgy/get_note_detail')
    assert.equal(new URL(url).search, '')
    assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { note_id: ID })
    assert.equal(options.headers.authorization, `Bearer ${SECRET}`)
    return response(detail())
  })
  const first = await state.call()
  const replay = await state.call('note_detail', { note_id: ID }, 'research-request-001', endpoints.note_detail.aliases[0])
  assert.equal(replay.replay, true)
  assert.deepEqual(replay.body, first.body)
  assert.equal(calls, 1)
  await state.call('note_detail', { note_id: ID, deliveryMode: 'refresh' }, 'research-request-002')
  assert.equal(calls, 2, 'explicit refresh is live')
  assert.match([...state.platformStore.restrictedResponseArchives.values()][0].bodyText, /tikhub/)
  assert.equal(state.platformStore.ingestJobs[0].payload.records[0].metrics.views, 0)
  assert.equal(state.platformStore.ingestJobs[0].payload.records[0].metrics.impressions, 200)
})

test('research detail and comments admit CNY costs alongside existing USD provider history', async () => {
  let dispatched = 0
  const state = await fixture(async url => {
    dispatched += 1
    return response(new URL(url).pathname.endsWith('/get_note_comments') ? comments() : detail())
  })
  state.config.billing.currency = 'CNY'
  state.platformStore.calls.set('previous-usd-search', {
    id: 'previous-usd-search', providerKey: 'tikhub', usageRequestId: 'previous-search',
    startedAt: new Date().toISOString(), currency: 'USD', costMinor: 500,
    costKind: 'estimated', outcome: 'succeeded',
  })
  const note = await state.call()
  const page = await state.call('note_comments', { note_id: ID }, 'mixed-currency-comments')
  assert.equal(note.body.data.item.title, '热门笔记')
  assert.equal(page.body.data.items[0].text, '评论正文')
  assert.equal(dispatched, 2)
  assert.equal(state.platformStore.calls.get('previous-usd-search').currency, 'USD')
  const budget = await state.platformStore.describeCostBudget({ ...state.config.billing, costMinor: 1 })
  assert.equal(budget.spentMinor, 2, 'CNY budget excludes USD history without conversion')
})

test('new operations require explicit current platform AND Key scopes, never inherit old detail access', async () => {
  for (const options of [{ capabilities: [] }, { platforms: [] }]) {
    const state = await fixture(async () => { assert.fail('must not dispatch') }, options)
    await assert.rejects(state.call(), { status: 403 })
    assert.equal(state.store.requests.size, 0)
  }
  const state = await fixture()
  await state.call()
  await state.service.putCapabilityConfiguration('social.posts.analytics', { tenantId: state.tenant.id, consumerId: state.consumer.id, enabled: false, maxRequests: 1000, windowSeconds: 3600 })
  await assert.rejects(state.call(), { status: 403 }, 'revocation applies before replay')
})

test('new template retains v1 prices; no-data charges once and replay never double bills', async () => {
  assert.equal(compileBillingComponents([{ type: 'feature', key: 'xiaohongshu', version: 1 }], [], 'CNY').entries.length, 4)
  const state = await fixture(async () => response({ code: 200, data: { code: 0, success: true, data: null } }))
  const oldPlan = (await state.service.getConsumerPlan(state.consumer.id)).versionId
  const plan = await state.service.publishPlanVersion({ key: 'research-v2', name: 'Research v2', components: [{ type: 'feature', key: 'xiaohongshu', version: 2 }], limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 }, priceBook: { key: 'research-v2', currency: 'CNY', defaultMultiplierPpm: 1000000 } }, 'test-admin')
  assert.equal(plan.priceBook.entries.length, 6)
  assert.equal((await state.service.getConsumerPlan(state.consumer.id)).versionId, oldPlan)
  const current = await state.service.getConsumerPlan(state.consumer.id)
  await state.service.assignConsumerPlan(state.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
  await state.service.setTenantBillingProfile(state.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
  await state.service.addTenantCredit(state.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Test' }, { idempotencyKey: 'research-credit-001', actor: 'test-admin' })
  const result = await state.call()
  assert.equal(result.body.meta.status, 'no_data')
  assert.equal(result.body.data.item, null)
  assert.equal(state.platformStore.ingestJobs.length, 0)
  await state.call()
  const billing = await state.service.getTenantBilling(state.tenant.id)
  assert.equal(billing.account.availableMinor, 90)
  assert.equal(billing.ledger.filter(entry => entry.kind === 'capture').length, 1)
})

test('comments hide traversal coordinates, preserve sort/index/pageArea and bind cursor to Key, note and sort', async () => {
  const queries = []
  const state = await fixture(async (url, options) => { assert.equal(options.method, 'GET'); queries.push(new URL(url).searchParams); return response(comments()) })
  const first = await state.call('note_comments', { note_id: ID, sort: 'hot' })
  const cursor = first.body.data.nextCursor
  assert.match(cursor, /^mxec2\./)
  assert.doesNotMatch(JSON.stringify(first.body), /private-next|pageArea|tikhub/i)
  const second = await state.call('note_comments', { note_id: ID, sort: 'hot', cursor }, 'research-page-002')
  assert.equal(queries[1].get('cursor'), 'private-next')
  assert.equal(queries[1].get('index'), '10')
  assert.equal(queries[1].get('pageArea'), 'FOLDED')
  assert.equal(queries[1].get('sort_strategy'), 'like_count')
  assert.equal(second.body.data.nextCursor, null, 'same cursor is never followed in a loop')
  assert.equal(state.platformStore.ingestJobs[0].payload.datasetId, 'social.comments.v1')
  assert.equal(state.platformStore.ingestJobs[0].payload.records[1].objectType, 'comment')
  assert.equal(state.platformStore.ingestJobs[0].payload.records[1].stableFields.attributes.parentCommentId, 'comment-1')
  for (const body of [{ note_id: OTHER, sort: 'hot', cursor }, { note_id: ID, sort: 'latest', cursor }, { note_id: ID, sort: 'hot', cursor: 'private-next' }]) await assert.rejects(state.call('note_comments', body, 'research-invalid-page'), { status: 400 })
  const anotherKey = await state.service.createApiKey({ consumerId: state.consumer.id, name: 'Other key', platforms: ['xiaohongshu'], capabilities: XHS_RESEARCH_OPERATIONS })
  await assert.rejects(state.call('note_comments', { note_id: ID, sort: 'hot', cursor }, 'research-another-key', endpoints.note_comments.path, await state.service.authenticate(anotherKey.secret)), { status: 400 })
  assert.equal(queries.length, 2)
})

test('comments stop at page 15 and do not infer an end from missing pagination', () => {
  const codec = createExternalPlatformCursorCodec(PEPPER, 'consumer')
  const request = normalizeXhsResearchRequest(endpoints.note_comments, { note_id: ID })
  const page15 = projectXhsResearch(comments(), { ...request, page: 15 }, stamp, { encodeCursor: codec.encode })
  assert.equal(page15.data.nextCursor, null)
  assert.equal(page15.meta.paginationStatus, 'limit_reached')
  const incomplete = comments(); delete incomplete.data.data.index
  assert.equal(projectXhsResearch(incomplete, request, stamp, { encodeCursor: codec.encode }).meta.paginationStatus, 'unknown')
})

test('PGY HTTP billing evidence and ambiguous dispatch never trigger automatic retries', async () => {
  for (const [status, text, billed] of [[200, '{broken', true], [200, JSON.stringify({ code: 500 }), true], [400, 'unavailable', false]]) {
    const adapter = new TikHubAdapter({ apiKey: SECRET, fetchImpl: async () => new Response(text, { status, headers: { 'content-type': 'application/json' } }) })
    await assert.rejects(adapter.getXiaohongshuAppV2(endpoints.note_detail.endpointKey, { note_id: ID }), error => error.evidence.billed === billed)
  }
  let calls = 0
  const state = await fixture(async () => { calls++; throw new Error('network dropped after send') })
  await assert.rejects(state.call())
  await assert.rejects(state.call())
  assert.equal(calls, 1)
})

test('unreviewed procurement price blocks only the new operation and does not expose endpoint metadata', async () => {
  const state = await fixture(async () => { assert.fail('must not dispatch') })
  state.config.billing.unitCostMinorByEndpoint = {}
  const capabilities = await state.gateway.capabilities()
  assert.equal(capabilities.ready, true, 'old readiness remains independent')
  assert.equal(capabilities.operations['social.posts.analytics'].ready, false)
  await assert.rejects(state.call(), error => error.status === 503 && !/tikhub|pgy|endpointKey/i.test(JSON.stringify(error)))
})

test('HTTP routes and published tenant docs enforce the same independent scopes', async t => {
  const state = await fixture()
  const server = createServer(createApp({ service: state.service, store: state.store, adapter: {}, tikHubGateway: state.gateway, adminToken: null, listenerMode: 'public', logger: { warn() {}, error() {} } }))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => server.close(resolve)))
  const base = `http://127.0.0.1:${server.address().port}`
  const path = endpoints.note_detail.path
  const headers = { authorization: `Bearer ${state.key.secret}`, 'content-type': 'application/json' }
  assert.equal((await fetch(base + path, { method: 'POST', body: JSON.stringify({ note_id: ID }) })).status, 401)
  assert.equal((await fetch(base + path, { headers })).status, 405)
  assert.equal((await fetch(base + path + '?note_id=' + ID, { method: 'POST', headers, body: JSON.stringify({ note_id: ID }) })).status, 400)
  const result = await fetch(base + path, { method: 'POST', headers, body: JSON.stringify({ note_id: ID }) })
  assert.equal(result.status, 200)
  assert.ok(result.headers.get('x-mx-insight-request-id'))
  assert.doesNotMatch(await result.text(), /tikhub|provider-id|cache_url/)
  for (const endpoint of Object.values(endpoints)) {
    const publicPath = endpoint.path.replace('/api/v1', '')
    assert.deepEqual(PUBLIC_OPENAPI_DOCUMENT.paths[publicPath].post['x-mx-required-capabilities'], [endpoint.operation])
    assert.ok(!tenantOpenApiDocument([{ platforms: ['xiaohongshu'], capabilities: ['social.posts.resolve'] }]).paths[publicPath])
    assert.ok(tenantOpenApiDocument([{ platforms: ['xiaohongshu'], capabilities: [endpoint.operation] }]).paths[publicPath])
  }
  const scopedHtml = publicDocsHtmlForPath('/docs/xiaohongshu-note', { tenant: true, scopes: [{ platforms: ['xiaohongshu'], capabilities: ['social.posts.analytics'] }] })
  assert.match(scopedHtml, /notes\/detail/)
  assert.doesNotMatch(scopedHtml, /notes\/comments|TikHub|tikhub/)
})

test('reviewed operation policy activates only its endpoint and pause still rejects new requests', async () => {
  const state = await fixture()
  delete state.config.researchContractVerified
  state.config.billing = {}
  const control = new MemoryExternalPlatformControlStore()
  state.gateway.operationControlStore = control
  await assert.rejects(state.call(), { code: 'external_platform_operation_disabled' })
  const runtime = { config: state.config, credentialConfigured: true }
  await assert.rejects(control.updatePolicy('tikhub', 'social.posts.analytics', { desiredState: 'active', expectedRevision: 0, reason: 'Testing explicit activation' }, { runtime }), { code: 'external_platform_reviewed_price_book_required' })
  const activated = await control.updatePolicy('tikhub', 'social.posts.analytics', { desiredState: 'active', expectedRevision: 0, reason: 'Test reviewed procurement price', priceBook: { currency: 'USD', pricingAsOf: stamp.toISOString(), monthlyBudgetMinor: 10000, monthlySubsidyBudgetMinor: 10000, unitCostMinorByEndpoint: { [endpoints.note_detail.endpointKey]: 1 } } }, { runtime })
  await state.call('note_detail', { note_id: ID }, 'research-policy-live')
  await assert.rejects(state.call('note_comments', { note_id: ID }, 'research-policy-comments'), { code: 'external_platform_operation_disabled' })
  await control.updatePolicy('tikhub', 'social.posts.analytics', { desiredState: 'paused', expectedRevision: activated.revision, reason: 'Pause test' }, { runtime })
  await assert.rejects(state.call('note_detail', { note_id: ID, deliveryMode: 'refresh' }, 'research-policy-paused'), { code: 'external_platform_operation_paused' })
})


test('queued detail retries a known unbilled 400 once with one customer capture and separate provider evidence', async () => {
  let calls = 0
  const state = await fixture(async () => ++calls === 1
    ? new Response(JSON.stringify({ code: 400, message: 'temporary service error' }), { status: 400 }) : response(detail()))
  const plan = await state.service.publishPlanVersion({ key: 'queue-plan', name: 'Queue', components: [{ type: 'feature', key: 'xiaohongshu', version: 2 }], limits: { monthlyRequests: 10000, maxPageSize: 100, burstRps: 100 }, priceBook: { key: 'queue-plan', currency: 'CNY', defaultMultiplierPpm: 1000000 } }, 'test-admin')
  const current = await state.service.getConsumerPlan(state.consumer.id)
  await state.service.assignConsumerPlan(state.consumer.id, { planVersionId: plan.versionId, expectedRevision: current.revision }, 'test-admin')
  await state.service.setTenantBillingProfile(state.tenant.id, { mode: 'enforced', multiplierPpm: 1000000 }, 'test-admin')
  await state.service.addTenantCredit(state.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Test' }, { idempotencyKey: 'queue-credit-001', actor: 'test-admin' })
  const result = await state.call()
  assert.equal(result.status, 200)
  assert.equal(calls, 2)
  const providerCalls = [...state.platformStore.calls.values()]
  assert.equal(providerCalls[0].billed, false)
  assert.equal(providerCalls[1].callRole, 'retry')
  assert.equal(providerCalls[1].callOrdinal, 1)
  assert.equal(state.platformStore.restrictedResponseArchives.size, 2)
  assert.equal(state.platformStore.ingestJobs.length, 1)
  await state.call()
  assert.equal(calls, 2)
  const bill = await state.service.getTenantBilling(state.tenant.id)
  assert.equal(bill.account.availableMinor, 90)
  assert.equal(bill.ledger.filter(row => row.kind === 'capture').length, 1)
})

test('same public note shares canonical-backed acquisition across tenants, with independent authorization and usage', async () => {
  let calls = 0, release, begun
  const started = new Promise(resolve => { begun = resolve })
  const gate = new Promise(resolve => { release = resolve })
  const state = await fixture(async () => { calls++; begun(); await gate; return response(detail()) })
  const tenant = await state.service.createTenant({ name: 'Other tenant' })
  const consumer = await state.service.createConsumer({ tenantId: tenant.id, name: 'Other caller' })
  await state.service.putPlatformConfiguration('xiaohongshu', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100 })
  await state.service.putCapabilityConfiguration('social.posts.analytics', { tenantId: tenant.id, consumerId: consumer.id, enabled: true, maxRequests: 1000, windowSeconds: 3600 })
  const key = await state.service.createApiKey({ consumerId: consumer.id, name: 'Other key', platforms: ['xiaohongshu'], capabilities: ['social.posts.analytics'] })
  const context = await state.service.authenticate(key.secret)
  const first = state.call()
  await started
  const second = state.call('note_detail', { note_id: ID }, 'other-note-request', endpoints.note_detail.path, context)
  await new Promise(resolve => setTimeout(resolve, 30))
  release()
  const [a, b] = await Promise.all([first, second])
  assert.equal(a.sourceMode, 'live')
  assert.equal(b.sourceMode, 'fresh_cache')
  assert.notEqual(a.requestId, b.requestId)
  assert.equal(calls, 1)
  assert.equal(state.platformStore.ingestJobs.length, 1)
  assert.equal([...state.store.requests.values()].filter(row => row.status === 'committed').length, 2)
  assert.doesNotMatch(JSON.stringify(b.body), new RegExp(state.consumer.id + '|' + SECRET))
  await state.service.putCapabilityConfiguration('social.posts.analytics', { tenantId: tenant.id, consumerId: consumer.id, enabled: false, maxRequests: 1000, windowSeconds: 3600 })
  await assert.rejects(state.call('note_detail', { note_id: ID }, 'other-denied-request', endpoints.note_detail.path, context), { status: 403 })
  assert.equal(calls, 1)
})

test('retry limit remains one; busy admission makes no upstream call or committed usage', async () => {
  let calls = 0
  const state = await fixture(async () => { calls++; return new Response(JSON.stringify({ code: 400 }), { status: 400 }) })
  await assert.rejects(state.call(), { code: 'external_platform_rejected' })
  assert.equal(calls, 2)
  const blocked = await fixture(async () => { assert.fail('queue rejection must not dispatch') })
  blocked.gateway.detailQueue.enter = async () => { throw Object.assign(new Error('busy'), { status: 429, code: 'external_platform_busy' }) }
  await assert.rejects(blocked.call())
  assert.equal([...blocked.store.requests.values()].filter(row => row.status === 'committed').length, 0)
  assert.equal(blocked.platformStore.costReservations.size, 0)
})

test('a grant revoked during queue wait prevents dispatch and releases the waiting usage reservation', async () => {
  let count = 0, unblock, started
  const began = new Promise(resolve => { started = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const state = await fixture(async () => { count++; started(); await gate; return response(detail()) })
  const first = state.call()
  await began
  const pending = state.call('note_detail', { note_id: OTHER }, 'queued-revoked-request')
  const rejected = assert.rejects(pending, { status: 403 })
  await new Promise(resolve => setTimeout(resolve, 20))
  await state.service.putCapabilityConfiguration('social.posts.analytics', { tenantId: state.tenant.id, consumerId: state.consumer.id, enabled: false, maxRequests: 1000, windowSeconds: 3600 })
  unblock()
  await first
  await rejected
  assert.equal(count, 1)
  const request = [...state.store.requests.values()].find(row => row.idempotencyKey === 'queued-revoked-request')
  assert.equal(request.status, 'released')
})

test('an unknown acquisition is suppressed across tenants and a new idempotency identity', async () => {
  let count = 0
  const state = await fixture(async () => { count++; throw new Error('ambiguous network failure') })
  await assert.rejects(state.call(), { code: 'external_platform_outcome_unknown' })
  await assert.rejects(state.call('note_detail', { note_id: ID, deliveryMode: 'refresh' }, 'new-unknown-request'), { code: 'request_outcome_unknown' })
  assert.equal(count, 1)
})

test('queue rejection serves explicitly stale shared cache only in cache_first mode', async () => {
  let count = 0
  const state = await fixture(async () => { count++; return response(detail()) })
  await state.call()
  for (const row of state.platformStore.snapshots.values()) row.freshUntil = new Date(Date.now() - 1000).toISOString()
  state.gateway.detailQueue.enter = async () => { throw Object.assign(new Error('busy'), { status: 429, code: 'external_platform_busy' }) }
  const cached = await state.call('note_detail', { note_id: ID }, 'stale-cache-request')
  assert.equal(cached.sourceMode, 'stored_fallback')
  await assert.rejects(state.call('note_detail', { note_id: ID, deliveryMode: 'refresh' }, 'busy-refresh-request'))
  assert.equal(count, 1)
})

test('explicit refresh never degrades to stored data when local concurrency is exhausted', async () => {
  let count = 0
  const state = await fixture(async () => { count++; return response(detail()) })
  await state.call()
  for (const row of state.platformStore.snapshots.values()) row.freshUntil = new Date(Date.now() - 1000).toISOString()
  state.gateway.active = state.config.maxConcurrency
  const cached = await state.call('note_detail', { note_id: ID }, 'concurrency-cache-request')
  assert.equal(cached.sourceMode, 'stored_fallback')
  await assert.rejects(state.call('note_detail', { note_id: ID, deliveryMode: 'refresh' }, 'concurrency-refresh-request'), { code: 'external_platform_busy' })
  assert.equal(count, 1)
})

test('cancelling after attempt reservation but before dispatch releases holds as known unbilled', async () => {
  const state = await fixture(async () => { assert.fail('cancelled request must not dispatch') })
  const controller = new AbortController()
  const begin = state.platformStore.beginProviderCall.bind(state.platformStore)
  state.platformStore.beginProviderCall = async input => {
    const call = await begin(input)
    controller.abort()
    return call
  }
  await assert.rejects(state.gateway.officialXiaohongshu(state.context, {
    endpointName: 'note_detail', query: { note_id: ID }, method: 'POST',
    idempotencyKey: 'cancel-before-dispatch', path: endpoints.note_detail.path, signal: controller.signal,
  }), { code: 'request_cancelled' })
  assert.equal([...state.store.requests.values()][0].status, 'released')
  const call = [...state.platformStore.calls.values()][0]
  assert.equal(call.outcome, 'rejected')
  assert.equal(call.billed, false)
  assert.equal(state.platformStore.ingestJobs.length, 0)
  assert.equal([...state.platformStore.costReservations.values()].some(row => row.status === 'reserved'), false)
})
