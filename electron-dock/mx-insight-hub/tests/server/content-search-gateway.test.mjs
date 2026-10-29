import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { test } from 'node:test'
import { HubService } from '../../server/hub-service.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { TikHubAdapter } from '../../server/adapters/tikhub.mjs'
import { ExternalPlatformGateway } from '../../server/external-platforms/gateway.mjs'
import { TikHubGateway } from '../../server/external-platforms/tikhub-gateway.mjs'
import { xiaohongshuSearchOperation } from '../../server/contracts/remaining-content-search.mjs'
import { MemoryExternalPlatformStore } from '../../server/external-platforms/store.mjs'
import { MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'
import { nativeForwardingEndpoint, NATIVE_FORWARDING_VERSION } from '../../server/contracts/native-forwarding.mjs'
import { TIKHUB_CONTENT_SEARCH_RECIPES } from '../../server/contracts/tikhub-content-search.mjs'
import { RAW_SEARCH_VERSION } from '../../server/contracts/raw-search.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'
import { createNightAllCompatibilityCursorCodec } from '../../server/external-platforms/cursor.mjs'
import { capNightAllDataSearchTraversal, prepareNightAllCompatibilityTraversal } from '../../server/data/night-all-pagination.mjs'

const fixtures = JSON.parse(await readFile(new URL('../fixtures/tikhub-content-search.json', import.meta.url), 'utf8'))
const PEPPER = 'offline-tikhub-content-search-with-sufficient-entropy'
const terminal = platform => {
  const data = structuredClone(fixtures[platform])
  if (platform === 'bilibili') data.data.numPages = 1
  if (platform === 'douyin') data.has_more = false
  if (platform === 'kuaishou') data.has_more = false
  if (platform === 'zhihu') data.paging.is_end = true
  return data
}
const biliPage = (ids, page = 1, total = page) => ({ code: 0, data: { page, numPages: total,
  result: ids.map(id => ({ id, title: `真实标题 ${id}`, description: `内容 ${id}`, review: 7, play: 0 })) } })
const internationalPage = (platform, ids, next = null) => platform === 'reddit'
  ? { search: { dynamic: { components: { main: { edges: ids.map(id => ({ node: { post: {
    id: `t3_${id}`, postTitle: `标题 ${id}`, content: { markdown: `完整正文 ${id}` }, score: 0,
  } } })), pageInfo: { hasNextPage: Boolean(next), endCursor: next } } } } } }
  : { videos: ids.map(id => ({ video_id: id, title: `标题 ${id}`, description: `完整正文 ${id}`, view_count: 0 })),
    has_more: Boolean(next), continuation_token: next }
// Names/types follow the hash-verified v6 single-card schema. Every value is
// synthetic; this does not copy private suggestions, IDs or media from it.
const douyinRelatedWordsCard = () => ({
  data: { card_tags: null, rs_extra_info: { hide_related_words: null, impr_extra: '{}', hide_related_words_id: null,
    query_id: 'synthetic-query-id' }, hotspot_tab_config: null, common_tab_config: null },
  type: 6, related_word_list: Array.from({ length: 6 }, (_, index) => ({ related_word: `fixture suggestion ${index}`,
    word_record: { group_id: `synthetic-group-${index}`, words_position: index, words_content: `fixture suggestion ${index}`,
      words_source: 'synthetic-source', words_image: { url_list: [`https://example.test/suggestion-${index}.jpg?signature=a%2Fb`] },
      force_update_rank: false, product_id: `synthetic-product-${index}` }, related_img: `https://example.test/suggestion-${index}.jpg`,
    rand_num: index, extra_info: { words_type: 'synthetic-type' } })),
  words_query_record: { info: '{}', words_source: 'synthetic-source', query_id: 'synthetic-query-id' },
  card_info: { index: 4, fingerprint: 'synthetic-fingerprint', double_n: 0, pos: 4, first_pos: 4 }, doc_type: 0,
  sub_card_list: null, ui_info: { quality_style_corner_type: 0, is_waterfall_layout: 0 },
  provider_doc_id: 0, provider_doc_id_str: 'synthetic-provider-doc-id', tab: null, show_tab: null, debug_diff_info: {}, aweme_list: null,
  send_back: 'synthetic-send-back', card_type: 9, card_style_type: 0, ecom_goods_list: null, music_info_list: null,
  debug_data: { filter_debug_info_list: null }, card_type_name: 'synthetic-type-name', ops: null, card_id: 'synthetic-card-id',
  qishui_music_list: null, shoot_position_list: null,
})
function douyinMixedPage(number = 1, hasMore = true) {
  const data = Array.from({ length: 7 }, (_, index) => ({ type: 1, aweme_info: {
    aweme_id: String(7535855189035991000n + BigInt(number * 10 + index)), desc: `完整正文 ${number}/${index}`,
    video: { play_addr: { url_list: [`https://example.test/video-${number}-${index}.mp4?signature=a%2Fb`] } },
    statistics: { digg_count: 0, comment_count: index },
  } }))
  data.splice(4, 0, douyinRelatedWordsCard())
  return { data, has_more: hasMore, cursor: number * 20, log_pb: { impr_id: 'fixture-session' }, backtrace: 'fixture-backtrace' }
}

async function harness({ platform = 'bilibili', payload, fetchImpl, leaseMs = 120000, store = new MemoryStore() } = {}) {
  const calls = [], historical = []
  const service = new HubService({ store, apiKeyPepper: PEPPER, adapter: {
    async legacySearch(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
    async search(input) { historical.push(input); throw new Error('Unexpected Night-All dispatch') },
  } })
  const tenant = await service.createTenant({ name: 'Offline content-search fixture' })
  const consumer = await service.createConsumer({ tenantId: tenant.id, name: 'Synthetic caller' })
  await store.setPlatformGrant(consumer.id, platform, true)
  const capabilities = platform === 'xiaohongshu' ? ['social.posts.search', 'social.posts.resolve'] : []
  store.capabilityGrants.set(consumer.id, capabilities)
  const key = await service.createApiKey({ consumerId: consumer.id, name: 'Synthetic live identity', platforms: [platform], capabilities })
  const context = await service.authenticate(key.secret)
  const recipe = TIKHUB_CONTENT_SEARCH_RECIPES[platform], endpoint = platform === 'xiaohongshu' ? xiaohongshuSearchOperation : nativeForwardingEndpoint(recipe.key)
  const config = { configured: true, contractVerified: true, dispatchEnabled: true, timeoutMs: 100,
    freshTtlMs: 60000, staleTtlMs: 86400000, maxConcurrency: 3, maxConsumerConcurrency: 3, maxRequestsPerMinute: 100, billing: {} }
  const controls = new MemoryExternalPlatformControlStore()
  await controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: platform === 'xiaohongshu' ? 0 : 1, desiredState: 'active', reason: 'Offline regression',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
  { runtime: { config, credentialConfigured: true } })
  const adapter = new TikHubAdapter({ apiKey: 'fixture-secret', timeoutMs: 100, fetchImpl: async (url, options) => {
    const parsed = new URL(url)
    calls.push({ url: parsed, options, params: options.method === 'POST' ? JSON.parse(options.body) : Object.fromEntries(parsed.searchParams) })
    if (fetchImpl) return fetchImpl(calls.at(-1), calls.length)
    return Response.json({ code: 200, request_id: `synthetic-${calls.length}`, data: typeof payload === 'function' ? payload(calls.at(-1), calls.length) : payload ?? terminal(platform) })
  } })
  const platformStore = new MemoryExternalPlatformStore({ usageStore: store, providerKey: 'tikhub', authorizationPlatform: platform })
  const gateway = new ExternalPlatformGateway({ usageStore: store, platformStore, adapter, config, providerKey: 'tikhub',
    apiKeyPepper: PEPPER, reservationLeaseMs: leaseMs, operationControlStore: controls, logger: { warn() {} } })
  service.externalRawSearch = (context, input) => gateway.searchContent(context, input)
  const socialGateway = new TikHubGateway({ usageStore: store, platformStore, adapter, config,
    apiKeyPepper: PEPPER, reservationLeaseMs: leaseMs, operationControlStore: controls, logger: { warn() {} } })
  service.externalSocialSearch = (context, input) => socialGateway.searchNotes(context, input)
  service.externalDataSearch = (context, input) => platform === 'weibo' && input.normalized.pageSize >= 20 && !input.normalized.cursor?.startsWith('mxnc1.')
    ? gateway.searchRaw(context, input) : gateway.searchContent(context, input,
      { finalizeXiaohongshu: values => socialGateway.enrichStandardSearchPage(values) })
  const invoke = (body = { platform, keyword: '城市', count: 20 }, idempotencyKey = 'content-raw-first', path = '/api/v1/night-all/search/raw') => service.nightAllCompatibilitySearch(context, { operation: 'raw', body, idempotencyKey,
    // app.mjs canonicalizes both public aliases before invoking the service.
    path: path.replace('/api/v1/search/', '/api/v1/night-all/search/') })
  const invokeData = (body = { platform, query: '城市', pageSize: 20 }, idempotencyKey = 'content-data-first') => service.search(context, { body, idempotencyKey, path: '/api/v1/data/search' })
  return { store, service, platformStore, gateway, socialGateway, adapter, context, config, controls, recipe, calls, historical, invoke, invokeData }
}

test('all four platforms use fixed TikHub keyword endpoints for standard and both raw aliases, with immutable replay', async () => {
  for (const platform of Object.keys(TIKHUB_CONTENT_SEARCH_RECIPES).filter(key => TIKHUB_CONTENT_SEARCH_RECIPES[key].rawCompatibility !== false)) {
    const h = await harness({ platform })
    const first = await h.invokeData()
    assert.equal(first.body.data.contractVersion, 'night-all.data-search.v1')
    assert.ok(first.body.data.items.length)
    assert.ok(first.body.data.items[0].title)
    assert.equal(first.body.data.items[0].metrics.comments, platform === 'bilibili' ? 4 : platform === 'kuaishou' ? 3 : 2)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0].url.pathname, h.recipe.path)
    assert.equal(h.calls[0].options.method, h.recipe.method)
    assert.deepEqual((await h.invokeData()).body, first.body)
    const rawBody = { platform, keyword: '城市', count: 20 }
    const raw = await h.invoke(rawBody, 'content-raw-alias')
    assert.equal(raw.body.contractVersion, RAW_SEARCH_VERSION)
    assert.ok(JSON.parse(raw.body.data.raw_data).length)
    assert.deepEqual((await h.invoke(rawBody, 'content-raw-alias', '/api/v1/search/raw')).body, raw.body)
    assert.equal(h.calls.length, 2)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.ok([...h.store.requests.values()].every(row => row.platform === platform))
  }
})

for (const standard of [true, false]) {
  const contract = standard ? 'standard' : 'raw'
  test(`Bilibili ${contract} accepts a verified empty page without result and replays its one settled purchase`, async () => {
    const bytes = Buffer.from(JSON.stringify({ code: 200, request_id: 'synthetic-empty-bilibili',
      data: { code: 0, data: { page: 1, pagesize: 20, numResults: 0, numPages: 0 } } }, null, 2))
    const h = await harness({ fetchImpl: () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) })
    await h.service.setTenantBillingProfile(h.context.tenant.id,
      { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline empty-page fixture' },
      { idempotencyKey: 'bilibili-empty-credit', actor: 'offline-admin' })
    const body = standard ? { platform: 'bilibili', query: '城市', pageSize: 20 }
      : { platform: 'bilibili', keyword: '城市', count: 20 }
    const invoke = path => standard ? h.invokeData(body) : h.invoke(body, 'content-raw-first', path)
    const first = await invoke()
    assert.equal(first.status, 200)
    assert.deepEqual(standard ? first.body.data.items : JSON.parse(first.body.data.raw_data), [])
    const page = standard ? first.body.data.pageInfo : first.body.data.page
    assert.equal(page.returnedCount, 0)
    assert.equal(page.hasMore, false)
    assert.equal(page.nextCursor, null)
    assert.equal(first.body.data.status, 'ok')
    assert.deepEqual(first.body.data.warnings, [])
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
    const call = [...h.platformStore.calls.values()][0], usage = h.store.requests.get(first.requestId)
    assert.equal(call.outcome, 'succeeded')
    assert.equal(call.itemCount, 0)
    assert.equal(call.billed, true)
    assert.equal(usage.status, 'committed')
    assert.equal(usage.responseStatus, 200)
    const archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.deepEqual(Buffer.from(archive.bodyBytes), bytes)
    assert.equal(archive.bodySize, bytes.length)
    assert.equal(archive.bodySha256, createHash('sha256').update(bytes).digest('hex'))
    assert.equal(Object.hasOwn(JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')).data.data, 'result'), false)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.deepEqual(h.platformStore.ingestJobs[0].payload.records, [])
    const charges = [...h.store.customerCharges.values()]
    assert.equal(charges.length, 1)
    assert.equal(charges[0].status, 'captured')
    assert.equal(charges[0].chargedMinor, 3)
    const saved = structuredClone({ usage, call, charges, ledger: h.store.creditLedgerEntries })
    const replay = await invoke(standard ? undefined : '/api/v1/search/raw')
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
    assert.deepEqual(structuredClone({ usage: h.store.requests.get(first.requestId), call: h.platformStore.calls.get(call.id),
      charges: [...h.store.customerCharges.values()], ledger: h.store.creditLedgerEntries }), saved)
  })

  test(`Bilibili ${contract} retains a paid 502 when nonzero counts have no result`, async () => {
    const bytes = Buffer.from(JSON.stringify({ code: 200,
      data: { code: 0, data: { page: 1, pagesize: 20, numResults: 1, numPages: 1 } } }, null, 2))
    const h = await harness({ fetchImpl: () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) })
    const invoke = path => standard ? h.invokeData() : h.invoke(undefined, 'content-raw-first', path)
    await assert.rejects(invoke(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
    const call = [...h.platformStore.calls.values()][0], usage = [...h.store.requests.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable')
    assert.equal(call.errorCode, 'invalid_content_search_contract')
    assert.equal(call.billed, true)
    assert.equal(usage.status, 'committed')
    assert.equal(usage.responseStatus, 502)
    // Hub could not read this page; that is not a TikHub outage for other platforms.
    assert.equal(h.platformStore.state.consecutiveFailures, 0)
    assert.equal(h.platformStore.state.circuitOpenUntil ?? null, null)
    assert.equal(h.platformStore.ingestJobs.length, 0)
    const archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.deepEqual(Buffer.from(archive.bodyBytes), bytes)
    assert.equal(archive.bodySha256, createHash('sha256').update(bytes).digest('hex'))
    const saved = structuredClone(usage)
    await assert.rejects(invoke(standard ? undefined : '/api/v1/search/raw'),
      error => error.code === 'external_platform_response_unusable' && error.status === 502)
    assert.deepEqual(h.store.requests.get(usage.id), saved)
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  })
}

test('saved admission RPM is reread between standard content-search pages', async () => {
  const { attachAdmissionPolicy } = await import('../fixtures/admission-policy.mjs')
  let save
  const h = await harness({ fetchImpl: async (_call, index) => {
    if (index === 1) await save({ maxRequestsPerMinute: 39 })
    return Response.json({ code: 200, data: biliPage([String(index)], index, 2) })
  } })
  ;({ save } = attachAdmissionPolicy(h.gateway))
  await save({ maxRequestsPerMinute: 27 })
  const rates = []
  h.platformStore.acquireProviderRateLimit = async input => { rates.push(input.limit); return { allowed: true } }
  const result = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 2 })
  assert.equal(result.body.data.items.length, 2)
  assert.deepEqual(rates, [27, 39])
  assert.equal(h.calls.length, 2)
  assert.equal(h.gateway.config.maxRequestsPerMinute, 100)
})

test('Douyin data.awemeId inside a type-6 wrapper remains a real video on standard and raw contracts', async () => {
  const payload = { data: [{ type: 6, card_type: 9, aweme_list: null, data: { awemeId: '7535855189035991057', desc: '完整视频正文'.repeat(300),
    author: { uid: 'author-1', nickname: 'fixture author' }, statistics: { digg_count: 0, comment_count: 2 },
    video: { play_addr: { url_list: ['https://example.test/video.mp4?signature=a%2Fb'] },
      cover: { url_list: ['https://example.test/cover.jpg'] } } } }], has_more: false, cursor: 20 }
  for (const standard of [true, false]) {
    const h = await harness({ platform: 'douyin', payload })
    const body = standard ? { platform: 'douyin', query: '城市', pageSize: 20 } : { platform: 'douyin', keyword: '城市', count: 20 }
    const first = await (standard ? h.invokeData(body) : h.invoke(body))
    const item = standard ? first.body.data.items[0] : JSON.parse(first.body.data.raw_data)[0]
    assert.equal(standard ? item.externalId : item.content_id, payload.data[0].data.awemeId)
    assert.equal(item.text, payload.data[0].data.desc)
    assert.equal(standard ? item.metrics.likes : item.like_count, 0)
    assert.deepEqual(standard ? item.media.videos : JSON.parse(item.video_urls), payload.data[0].data.video.play_addr.url_list)
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.outcome, 'succeeded')
    assert.equal(call.itemCount, 1)
    const archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.deepEqual(JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')).data, payload)
    const replay = await (standard ? h.invokeData(body) : h.invoke(body, 'content-raw-first', '/api/v1/search/raw'))
    assert.equal(replay.replay, true)
    assert.deepEqual(replay.body, first.body)
    assert.equal(h.calls.length, 1)
  }
})

test('Douyin unknown type-6 data cards still fail closed with the complete paid archive and immutable error replay', async () => {
  const payload = { data: [{ type: 6, data: { unrecognized_schema: { private_value: 'fixture opaque card' } } }],
    has_more: false, cursor: 20 }
  for (const standard of [true, false]) {
    const h = await harness({ platform: 'douyin', payload })
    const body = standard ? { platform: 'douyin', query: '城市', pageSize: 20 } : { platform: 'douyin', keyword: '城市', count: 20 }
    const invoke = (idem = standard ? 'content-data-first' : 'content-raw-first', path) => standard
      ? h.invokeData(body, idem) : h.invoke(body, idem, path)
    await assert.rejects(invoke(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
    assert.equal(h.calls.length, 1)
    const call = [...h.platformStore.calls.values()][0], usage = [...h.store.requests.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable')
    assert.equal(call.billed, true)
    assert.equal(usage.status, 'committed')
    assert.equal(usage.responseStatus, 502)
    assert.equal(h.platformStore.ingestJobs.length, 0)
    const archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.deepEqual(JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')).data, payload)
    const original = structuredClone(usage)
    await assert.rejects(invoke(undefined, standard ? undefined : '/api/v1/search/raw'),
      error => error.code === 'external_platform_response_unusable' && error.status === 502)
    assert.deepEqual(h.store.requests.get(usage.id), original)
    await assert.rejects(invoke('douyin-card-new-idem'), error => error.code === 'external_platform_response_unusable')
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  }
})

test('Douyin fixed related-word schema preserves all eight source entries and delivers seven posts once on both contracts', async () => {
  for (const standard of [true, false]) {
    const h = await harness({ platform: 'douyin', payload: (_call, n) => douyinMixedPage(n) })
    const body = standard ? { platform: 'douyin', query: '城市', pageSize: 7 }
      : { platform: 'douyin', keyword: '城市', count: 7 }
    const first = await (standard ? h.invokeData(body) : h.invoke(body))
    const data = first.body.data, items = standard ? data.items : JSON.parse(data.raw_data)
    const page = standard ? data.pageInfo : data.page
    assert.equal(items.length, 7)
    assert.equal(page.hasMore, true)
    assert.ok(page.nextCursor)
    assert.ok(data.warnings.some(row => row.code === 'non_post_items_excluded'))
    assert.equal(h.calls.length, 1)
    const saved = h.store.requests.get(first.requestId), manifest = saved.acquisitionRequest.contentSearch
    assert.deepEqual(manifest.state.jobs[0].providerCursor,
      { cursor: '20', search_id: 'fixture-session', backtrace: 'fixture-backtrace' })
    const call = [...h.platformStore.calls.values()][0], raw = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.equal(call.outcome, 'succeeded')
    assert.equal(call.itemCount, 7)
    assert.deepEqual(JSON.parse(Buffer.from(raw.bodyBytes).toString('utf8')).data, douyinMixedPage(1))
    assert.equal(JSON.parse(Buffer.from(raw.bodyBytes).toString('utf8')).data.data.length, 8)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.platformStore.ingestJobs[0].payload.records.length, 7)
    assert.ok(h.platformStore.ingestJobs[0].payload.records.every(record =>
      record.body.startsWith('完整正文') && !record.externalId.startsWith('synthetic-group-')))
    assert.equal(JSON.parse(Buffer.from(raw.bodyBytes).toString('utf8')).data.data[4].related_word_list.length, 6)
    assert.deepEqual(standard ? items[0].media.videos : JSON.parse(items[0].video_urls),
      douyinMixedPage(1).data[0].aweme_info.video.play_addr.url_list)
    const replay = await (standard ? h.invokeData(body) : h.invoke(body, 'content-raw-first', '/api/v1/search/raw'))
    assert.deepEqual(replay.body, first.body)
    assert.equal(h.calls.length, 1)
    const secondBody = { ...body, cursor: page.nextCursor }
    const second = await (standard ? h.invokeData(secondBody, 'douyin-second-page') : h.invoke(secondBody, 'douyin-second-page'))
    const secondItems = standard ? second.body.data.items : JSON.parse(second.body.data.raw_data)
    assert.equal(secondItems.length, 7)
    assert.equal(h.calls.length, 2)
    assert.equal(Number(h.calls[1].params.cursor), 20)
    assert.equal(h.calls[1].params.search_id, 'fixture-session')
    assert.equal(h.calls[1].params.backtrace, 'fixture-backtrace')
    assert.ok(h.calls.every(call => call.url.pathname === h.recipe.path))
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.equal(new Set([...items, ...secondItems].map(item => standard ? item.externalId : item.content_id)).size, 14)
  }
})

test('Douyin fills beyond three pages while retaining every filtered source and provider-pinned continuation scope', async () => {
  const h = await harness({ platform: 'douyin', payload: (_call, n) => douyinMixedPage(n) })
  const body = { platform: 'douyin', query: '城市', pageSize: 30, params: { sort_type: '2' } }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items.length, 30)
  assert.equal(h.calls.length, 5)
  assert.equal(first.body.data.status, 'partial')
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.equal(first.body.data.warnings.some(row => row.code === 'content_search_fill_stopped'), false)
  assert.deepEqual(h.calls.map(call => Number(call.params.cursor)), [0, 20, 40, 60, 80])
  assert.ok([...h.platformStore.calls.values()].every(call => call.providerKey === 'tikhub' && call.itemCount === 7))
  assert.equal(h.platformStore.ingestJobs.length, 5)
  assert.ok([...h.platformStore.restrictedResponseArchives.values()].every(archive =>
    JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')).data.data.length === 8))
  const cursor = first.body.data.pageInfo.nextCursor
  const manifest = h.store.requests.get(first.requestId).acquisitionRequest.contentSearch
  assert.equal(manifest.state.jobs[0].upstreamPages, 5)
  assert.equal(manifest.state.jobs[0].buffer.offset, 2)
  assert.deepEqual(manifest.state.jobs[0].providerCursor, { cursor: '80', search_id: 'fixture-session', backtrace: 'fixture-backtrace' })
  assert.equal(manifest.sources.length, 5)
  await assert.rejects(h.invokeData({ ...body, query: 'changed', cursor }, 'douyin-changed-query'), error => error.code === 'invalid_cursor')
  await assert.rejects(h.invokeData({ ...body, params: { sort_type: '1' }, cursor }, 'douyin-changed-filter'), error => error.code === 'invalid_cursor')
  const otherKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Other synthetic Key', platforms: ['douyin'], capabilities: [] })
  const otherContext = await h.service.authenticate(otherKey.secret)
  await assert.rejects(h.service.search(otherContext, { body: { ...body, cursor }, idempotencyKey: 'douyin-other-key', path: '/api/v1/data/search' }),
    error => error.code === 'invalid_cursor')
  assert.equal(h.calls.length, 5)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  assert.equal(h.calls.length, 5)
})

test('Douyin related-word schema never hides content markers or unknown nested containers', async () => {
  for (const inner of [false, true]) for (const extra of [
    { video: { play_addr: { url_list: ['https://example.test/real.mp4'] } } },
    { title: 'possible real post' }, { statistics: { digg_count: 0 } },
    { items: [{ aweme_id: 'real-post', desc: 'real body' }] },
    { unrecognized_container: { aweme_id: 'real-post', desc: 'real body' } },
  ]) {
    const card = douyinRelatedWordsCard()
    Object.assign(inner ? card.data : card, extra)
    const payload = { data: [card], has_more: false, cursor: 20 }, h = await harness({ platform: 'douyin', payload })
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
    assert.equal(h.calls.length, 1)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable')
    assert.equal(h.platformStore.ingestJobs.length, 0)
    assert.deepEqual(JSON.parse(Buffer.from(h.platformStore.restrictedResponseArchives.get(call.id).bodyBytes).toString('utf8')).data, payload)
  }
})

test('Douyin validates every related-word item, including third and sixth entries after diagnostic samples', async () => {
  for (const index of [2, 5]) for (const malformed of [
    word => { word.related_word = 123 },
    word => { word.word_record.unrecognized_container = { aweme_id: 'real-post', desc: 'possible real body' } },
  ]) {
    const card = douyinRelatedWordsCard()
    malformed(card.related_word_list[index])
    const payload = { data: [card], has_more: false, cursor: 20 }, h = await harness({ platform: 'douyin', payload })
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable')
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.ingestJobs.length, 0)
    const archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.deepEqual(JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')).data, payload)
  }
})

test('a historical Douyin unusable mixed-card receipt replays its original paid error after parser changes', async () => {
  for (const standard of [true, false]) {
    const payload = douyinMixedPage(1), h = await harness({ platform: 'douyin', payload })
    const body = standard ? { platform: 'douyin', query: '城市', pageSize: 20 } : { platform: 'douyin', keyword: '城市', count: 20 }
    const path = standard ? '/api/v1/data/search' : '/api/v1/night-all/search/raw', id = randomUUID()
    const fingerprint = requestFingerprint({ method: 'POST', path, body: standard ? { ...body, type: 'fresh' }
      : { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } })
    const delivery = { usageRequestId: id, tenantId: h.context.tenant.id, consumerId: h.context.consumer.id,
      apiKeyId: h.context.apiKey.id, fingerprint, operation: nativeForwardingEndpoint(h.recipe.key).operation }
    await h.store.reserve({ ...delivery, requestId: id, platform: 'douyin', idempotencyKey: 'historical-douyin-card',
      leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100,
      acquisitionRequest: { path, body }, unitsReserved: 1 })
    const endpoint = nativeForwardingEndpoint(h.recipe.key)
    const call = await h.platformStore.beginProviderCall({ ...delivery, endpointKey: endpoint.endpointKey,
      endpointVersion: endpoint.endpointVersion, contractVersion: NATIVE_FORWARDING_VERSION })
    const result = await h.gateway.adapter.forwardNative(h.recipe.key, { params: { ...h.recipe.defaults, keyword: '城市' } })
    const responseBody = { error: { code: 'external_platform_response_unusable', message: 'Original saved failure' }, requestId: id }
    await h.platformStore.finishFailure({ ...result, callId: call.id, delivery, outcome: 'succeeded_unusable',
      billed: true, httpStatus: 200, businessCode: 200, errorCode: 'invalid_content_search_contract', latencyMs: 1,
      restrictedResponseArchive: result.restrictedResponseArchive, failureResponseStatus: 502, failureResponseBody: responseBody })
    const original = structuredClone(h.store.requests.get(id)), originalArchive = structuredClone(h.platformStore.restrictedResponseArchives.get(call.id))
    await assert.rejects(standard ? h.invokeData(body, 'historical-douyin-card')
      : h.invoke(body, 'historical-douyin-card', '/api/v1/search/raw'),
    error => error.code === 'external_platform_response_unusable' && error.status === 502 && error.message === 'Original saved failure')
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.store.requests.get(id), original)
    assert.deepEqual(structuredClone(h.platformStore.restrictedResponseArchives.get(call.id)), originalArchive)
    assert.equal(h.platformStore.calls.get(call.id).outcome, 'succeeded_unusable')
  }
})

test('standard carries overflow, deduplicates delivered IDs and ingests each full archive only once', async () => {
  const h = await harness({ payload: (_call, n) => n === 1 ? biliPage(['a', 'b', 'c'], 1, 3) : n === 2 ? biliPage(['b', 'd'], 2, 3) : biliPage(['e'], 3, 3) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 2 }
  const first = await h.invokeData(body, 'content-fill-first')
  assert.deepEqual(first.body.data.items.map(row => row.externalId), ['a', 'b'])
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 3)
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'content-fill-second')
  assert.deepEqual(second.body.data.items.map(row => row.externalId), ['c', 'd'])
  assert.equal(h.calls.length, 2)
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'content-fill-third')
  assert.deepEqual(third.body.data.items.map(row => row.externalId), ['e'])
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.ingestJobs.length, 3)
  assert.deepEqual(h.calls.map(call => Number(call.params.page)), [1, 2, 3])
  assert.equal(h.platformStore.requests.filter(row => row.sourceMode === 'live').length, 3)
})

test('Zhihu 18 plus 18 acquired rows deliver 20 and persist the second-page 16-row carry as a JSON tree', async () => {
  const page = number => ({ data: Array.from({ length: 18 }, (_, index) => ({ type: 'search_result', object: {
    id: String(number * 100 + index), type: 'article', title: `fixture ${number}/${index}`, content: `<p>完整正文 ${number}/${index}</p>`,
  } })), paging: { is_end: false, next: `https://api.zhihu.com/search_v3?offset=${number * 20}&search_hash_id=fixture-session` } })
  const h = await harness({ platform: 'zhihu', payload: (_call, n) => page(n) })
  const first = await h.invokeData({ platform: 'zhihu', query: '城市', pageSize: 20 })
  assert.equal(first.body.data.items.length, 20)
  assert.equal(h.calls.length, 2)
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.deepEqual([...h.platformStore.calls.values()].map(call => [call.outcome, call.itemCount]), [['succeeded', 18], ['succeeded', 18]])
  const saved = [...h.store.requests.values()][0]
  assert.equal(saved.status, 'committed')
  const manifest = saved.acquisitionRequest.contentSearch, job = manifest.state.jobs[0]
  assert.equal(job.buffer.offset, 2)
  assert.notEqual(job.buffer.providerCursor, job.providerCursor)
  assert.deepEqual(job.buffer.providerCursor, job.providerCursor)
  assert.equal(isPostgresSafeJsonValue(manifest), true)
  assert.deepEqual((await h.invokeData({ platform: 'zhihu', query: '城市', pageSize: 20 })).body, first.body)
  assert.equal(h.calls.length, 2)
  const second = await h.invokeData({ platform: 'zhihu', query: '城市', pageSize: 20,
    cursor: first.body.data.pageInfo.nextCursor }, 'zhihu-second-delivery')
  assert.deepEqual(second.body.data.items.map(row => row.id), [
    ...Array.from({ length: 16 }, (_, index) => String(202 + index)),
    ...Array.from({ length: 4 }, (_, index) => String(300 + index)),
  ])
  assert.equal(h.calls.length, 3)
  assert.equal(h.platformStore.ingestJobs.length, 3)
})

test('all four standard platforms fill beyond three real calls with complete archives and one public usage settlement', async () => {
  const pages = {
    bilibili: n => biliPage([String(n)], n, 10),
    douyin: n => ({ ...douyinMixedPage(n), data: [douyinMixedPage(n).data[0]] }),
    kuaishou: n => ({ mixFeeds: [{ itemType: 'feed_photo', feed: { photoId: `photo-${n}`, caption: `完整正文 ${n}` } }],
      pcursor: `next-${n}`, has_more: true }),
    zhihu: n => ({ data: [{ type: 'search_result', object: { id: String(n), type: 'article', title: `标题 ${n}`, content: `<p>完整正文 ${n}</p>` } }],
      paging: { is_end: false, next: `https://api.zhihu.com/search_v3?offset=${n * 20}&search_hash_id=fixture-session` } }),
  }
  for (const [platform, page] of Object.entries(pages)) {
    const h = await harness({ platform, payload: (_call, n) => page(n) })
    const body = { platform, query: '城市', pageSize: 5 }
    const first = await h.invokeData(body)
    assert.equal(h.calls.length, 5, platform)
    assert.equal(first.body.data.items.length, 5)
    assert.equal(new Set(first.body.data.items.map(row => row.id)).size, 5)
    assert.equal(first.body.data.status, 'ok')
    assert.equal(first.body.data.pageInfo.hasMore, true)
    assert.equal(first.body.data.warnings.some(row => row.code === 'content_search_fill_stopped'), false)
    assert.equal(h.platformStore.restrictedResponseArchives.size, 5)
    assert.equal(h.platformStore.ingestJobs.length, 5)
    assert.equal([...h.store.requests.values()][0].acquisitionRequest.contentSearch.sources.length, 5)
    assert.deepEqual((await h.invokeData(body)).body, first.body)
    assert.equal(h.calls.length, 5)
    assert.equal(h.store.requests.size, 1)
    assert.equal([...h.store.requests.values()][0].status, 'committed')
  }
})

test('raw batch preserves plural keyword precedence, per-query count, fixed filters and bounded direct calls', async () => {
  const h = await harness({ payload: call => biliPage([`${call.params.keyword}-1`]) })
  const result = await h.invoke({ platform: 'bilibili', keyword: 'ignored', queries: ['one', 'two'], count: 2,
    params: { order: 'click', duration: 2 } })
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls.map(call => call.params.keyword), ['one', 'two'])
  assert.ok(h.calls.every(call => call.params.order === 'click' && call.params.duration === '2'))
  assert.equal(result.body.data.mode, 'batch')
  assert.deepEqual(result.body.data.results.map(row => row.query), ['one', 'two'])
  assert.equal(h.store.requests.size, 1)
  assert.equal([...h.store.requests.values()][0].billingMeterKey, 'raw')
})

test('new unsupported paid options and unsigned continuation reject before receipt while exact old raw replay precedes validation', async () => {
  for (const extra of [{ includeDetails: true }, { includeComments: true }, { commentLimit: 5 }, { commentCursor: 'native' }, { cacheMaxAgeHours: 2 }]) {
    const h = await harness()
    const body = { platform: 'bilibili', keyword: '城市', count: 20, ...extra }
    const code = 'content_search_option_unsupported'
    await assert.rejects(h.invoke(body), error => error.code === code)
    assert.equal(h.calls.length, 0)
    assert.equal(h.platformStore.calls.size, 0)
    const original = await h.service.store.reserve({ requestId: randomUUID(), idempotencyKey: 'historical-raw-replay',
      fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/night-all/search/raw', body: { contractVersion: 'mx-insight-hub.night-all-compat.v1', ...body } }),
      tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform: 'bilibili',
      unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100 })
    const archived = { data: { raw_info: '[]', raw_data: '[{"content_id":"old"}]' }, oldFormat: true }
    await h.store.commitRequest(original.request.id, { responseStatus: 200, responseBody: archived, unitsActual: 1 })
    assert.deepEqual((await h.invoke(body, 'historical-raw-replay')).body, archived)
    assert.equal(h.calls.length, 0)
  }
})

test('standard native pagination cannot bypass the signed cursor or declared page size', async () => {
  for (const params of [{ page: 3 }, { page_size: 2 }, { offset: 10 }]) {
    const h = await harness()
    await assert.rejects(h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 20, params }), error => error.code === 'content_search_pagination_unsupported')
    assert.equal(h.calls.length, 0)
  }
})

test('standard stable delivery retains its route, dataset and platform meter', async () => {
  const h = await harness()
  const result = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 20, type: 'stable' })
  assert.ok(result.body.data.items.length)
  const usage = [...h.store.requests.values()][0]
  assert.equal(usage.acquisitionRequest.path, '/api/v1/data/search')
  assert.equal(usage.billingMeterKey, 'bilibili')
  assert.equal(h.platformStore.ingestJobs[0].payload.datasetId, 'night-all.search.v1')
})

test('historical standard signed cursor replays original committed body before restart and retains old stable failure', async () => {
  for (const platform of ['bilibili', 'reddit', 'youtube', 'tiktok', 'weibo', 'xiaohongshu']) for (const type of ['fresh', 'stable']) {
    for (const responseStatus of [200, 400, 502]) {
      const h = await harness({ platform })
      const body = { platform, query: platform === 'bilibili' ? '城市' : '城'.repeat(500), pageSize: 20 }
      const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
      const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform, upstreamBody: body, codec })
      const wrapped = capNightAllDataSearchTraversal({ data: { pageInfo: { pageIndex: 1, pageSize: 20, returnedCount: 0,
        hasMore: true, nextCursor: 'old-native-token', cursorType: 'opaque' }, warnings: [] } }, { platform, page: 1, scope: traversal.scope, codec })
      const cursor = wrapped.data.pageInfo.nextCursor
      const id = randomUUID(), saved = responseStatus === 200 ? { original: true, requestId: id }
        : { error: { code: 'old_upstream_failure', message: 'Original saved error' }, requestId: id }
      await h.store.reserve({ requestId: id, idempotencyKey: 'historical-standard-page',
        fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body: { ...body, cursor: 'old-native-token', type } }),
        tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform,
        unitsReserved: 1, leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100 })
      await h.store.commitRequest(id, { responseStatus, responseBody: saved, unitsActual: 1 })
      if (responseStatus === 200) assert.deepEqual((await h.invokeData({ ...body, type, cursor }, 'historical-standard-page')).body, saved)
      else await assert.rejects(h.invokeData({ ...body, type, cursor }, 'historical-standard-page'), error => error.code === 'old_upstream_failure' && error.status === responseStatus)
      await assert.rejects(h.invokeData({ ...body, type, cursor }, 'historical-standard-new'), error => error.code === 'search_restart_required')
      assert.equal(h.calls.length, 0)
      assert.equal(h.historical.length, 0)
    }
  }
})

test('a filled standard delivery settles one existing customer quote across all provider receipts', async () => {
  const h = await harness({ payload: (_call, n) => biliPage([String(n)], n, 3) })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'content-search-credit', actor: 'offline-admin' })
  const result = await h.invokeData({ platform: 'bilibili', query: '城市', pageSize: 3 })
  assert.equal(result.body.data.items.length, 3)
  assert.equal(h.calls.length, 3)
  const charges = [...h.store.customerCharges.values()]
  assert.equal(charges.length, 1)
  assert.equal(charges[0].status, 'captured')
  assert.equal(charges[0].chargedMinor, 3)
})

test('transport uncertainty never returns acquired partial results under its own key; a new key searches again', async () => {
  const h = await harness({ fetchImpl: (_call, n) => {
    if (n === 2) throw new Error('synthetic transport lost after dispatch')
    return Response.json({ code: 200, data: biliPage(['a'], 1, 5) })
  } })
  const body = { platform: 'bilibili', query: '城市', pageSize: 2 }
  await assert.rejects(h.invokeData(body), error => ['upstream_outcome_unknown', 'request_outcome_unknown'].includes(error.code))
  assert.equal(h.calls.length, 2)
  assert.equal([...h.store.requests.values()][0].status, 'unknown')
  await assert.rejects(h.invokeData(body), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 2)
  const next = await h.invokeData(body, 'content-data-new-idem')
  assert.equal(next.status, 200)
  assert.equal(h.calls.length, 4)
})

test('paid persistence uncertainty logs only fixed phase/class/SQLState and durable IDs without changing safe unknown handling', async () => {
  for (const [method, phase, cause] of [
    ['stageProviderEvidence', 'stage_evidence', new TypeError('private credential/body/query')],
    ['finishProviderStep', 'finish_step', Object.assign(new Error('private SQL and parameters'), { code: '23514',
      detail: 'private detail', table: 'private table', constraint: 'private constraint' })],
  ]) {
    const h = await harness({ platform: 'kuaishou' }), logs = []
    h.gateway.logger = { warn(...values) { logs.push(values) } }
    h.platformStore[method] = async () => { throw cause }
    await assert.rejects(h.invokeData(), error => error.code === 'request_outcome_unknown')
    const usage = [...h.store.requests.values()][0], call = [...h.platformStore.calls.values()][0]
    assert.equal(usage.status, 'unknown')
    assert.equal(h.calls.length, 1)
    assert.deepEqual(logs, [[{ requestId: usage.id, callId: call.id, phase,
      errorClass: cause.name, sqlState: cause.code || null }, 'content search outcome is unknown']])
    assert.doesNotMatch(JSON.stringify(logs), /private|fixture-secret|城市/)
    // A new key is not held; it purchases again and meets the same synthetic persistence failure.
    await assert.rejects(h.invokeData(undefined, 'kuaishou-persistence-new-idem'), error => error.code === 'request_outcome_unknown')
    assert.equal(h.calls.length, 2)
  }
})

test('a failed uncertainty logger cannot release the original hold or retry the same key', async () => {
  const h = await harness({ platform: 'kuaishou' })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'kuaishou-logger-credit', actor: 'offline-admin' })
  h.gateway.logger = { warn() { throw new Error('private logger failure') } }
  h.platformStore.stageProviderEvidence = async () => { throw new TypeError('private stage failure') }
  await assert.rejects(h.invokeData(), error => error.code === 'request_outcome_unknown')
  assert.equal([...h.store.requests.values()][0].status, 'unknown')
  await assert.rejects(h.invokeData(), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 1)
  let charges = [...h.store.customerCharges.values()]
  assert.equal(charges.filter(row => row.status === 'unknown').length, 1)
  assert.equal(h.store.creditAccounts.get(h.context.tenant.id).heldMinor, 3)
  assert.equal(h.store.creditAccounts.get(h.context.tenant.id).availableMinor, 97)
  // A new key is a separate purchase with its own hold; the first hold stays unchanged.
  await assert.rejects(h.invokeData(undefined, 'kuaishou-logger-new-idem'), error => error.code === 'request_outcome_unknown')
  assert.equal(h.calls.length, 2)
  charges = [...h.store.customerCharges.values()]
  assert.equal(charges.filter(row => row.status === 'unknown').length, 2)
  assert.equal(h.store.creditAccounts.get(h.context.tenant.id).heldMinor, 6)
  assert.equal(h.store.creditAccounts.get(h.context.tenant.id).availableMinor, 94)
})

test('provider preview is visible partial content and missing modern metrics stay null', async () => {
  const h = await harness({ platform: 'zhihu' })
  const result = await h.invokeData()
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(row => row.code === 'body_completeness_unknown'))
  const preview = result.body.data.items.find(row => row.externalId === '117200001')
  assert.equal(preview.text, '仅提供摘要…')
  assert.equal(preview.metrics.likes, null)
  assert.equal(h.calls.length, 1)
})

test('buffer projection checks original archive hash before delivery and cannot echo credentials', async () => {
  const payload = biliPage(['a', 'b'])
  payload.data.result[1].description = 'fixture-secret'
  const h = await harness({ payload })
  // The first projection is credential scrubbed by the native adapter. Its full
  // restricted archive is retained unchanged for later integrity validation.
  const body = { platform: 'bilibili', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items.length, 1)
  assert.equal(JSON.stringify(first.body).includes('fixture-secret'), false)
  await assert.rejects(h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'content-buffer-hash'), error => error.code === 'search_page_unavailable')
  assert.equal(h.calls.length, 1)
})

test('Zhihu numeric surrogate entities preserve paid raw evidence while full Unicode text and the committed manifest remain JSON-safe', async () => {
  const rawContent = '<p>完整正文😀 &#128512; &#x1F642; &#xD800; &#57343; ' + '尾段'.repeat(1200) + '</p>'
  const payload = { data: [{ type: 'search_result', object: { id: 'unicode-article', type: 'article',
    title: '真实标题 &#xDFFF; &#128512;', content: rawContent } }], paging: { is_end: true } }
  const h = await harness({ platform: 'zhihu', payload })
  const result = await h.invokeData({ platform: 'zhihu', query: '城市', pageSize: 20, type: 'stable' }, 'content-unicode-projection')
  const item = result.body.data.items[0], saved = h.store.requests.get(result.requestId)
  assert.equal(saved.status, 'committed')
  assert.equal(item.title, '真实标题 &#xDFFF; 😀')
  assert.equal(item.text, rawContent.replace('<p>', '').replace('</p>', '').replace('&#128512;', '😀').replace('&#x1F642;', '🙂'))
  assert.ok(item.text.length > 2000)
  assert.ok(isPostgresSafeJsonValue(result.body))
  assert.ok(isPostgresSafeJsonValue(saved.acquisitionRequest.contentSearch))
  assert.ok(isPostgresSafeJsonValue(JSON.parse(JSON.stringify(h.platformStore.ingestJobs[0].payload))))
  assert.equal(h.platformStore.ingestJobs[0].payload.records[0].body, item.text)
  const raw = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.deepEqual(JSON.parse(Buffer.from(raw.bodyBytes).toString('utf8')).data, payload)
  assert.deepEqual((await h.invokeData({ platform: 'zhihu', query: '城市', pageSize: 20, type: 'stable' }, 'content-unicode-projection')).body, result.body)
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.ingestJobs.length, 1)
})

test('filter key ordering is canonical in cursor scope, while changed filters and Key remain invalid', async () => {
  const h = await harness({ payload: biliPage(['a', 'b']) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 1, params: { order: 'click', duration: 2 } }
  const first = await h.invokeData(body)
  const cursor = first.body.data.pageInfo.nextCursor
  await assert.rejects(h.invokeData({ ...body, cursor, params: { duration: 3, order: 'click' } }, 'content-filter-change'), error => error.code === 'invalid_cursor')
  const second = await h.invokeData({ ...body, cursor, params: { duration: 2, order: 'click' } }, 'content-filter-reorder')
  assert.deepEqual(second.body.data.items.map(row => row.externalId), ['b'])
  assert.equal(h.calls.length, 1)
  const newKey = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Different synthetic identity', platforms: ['bilibili'], capabilities: [] })
  const otherContext = await h.service.authenticate(newKey.secret)
  await assert.rejects(h.service.search(otherContext, { body: { ...body, cursor }, idempotencyKey: 'content-key-change', path: '/api/v1/data/search' }), error => error.code === 'invalid_cursor')
  assert.equal(h.calls.length, 1)
})

test('unknown durable mark failure retains cache-only parent reservation and lease until stale reaping', async () => {
  const h = await harness({ payload: biliPage(['a', 'b']), leaseMs: 120000 })
  await h.service.setTenantBillingProfile(h.context.tenant.id,
    { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
  await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
    { idempotencyKey: 'content-buffer-credit', actor: 'offline-admin' })
  const body = { platform: 'bilibili', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  const next = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const commit = h.store.commitRequest.bind(h.store), mark = h.store.markRequestUnknown.bind(h.store), get = h.store.getRequest.bind(h.store)
  h.store.commitRequest = async () => { throw new Error('Synthetic commit unavailable') }
  h.store.markRequestUnknown = async () => { throw new Error('Synthetic unknown mark unavailable') }
  h.store.getRequest = async () => { throw new Error('Synthetic read unavailable') }
  await assert.rejects(h.invokeData(next, 'content-buffer-uncertain'), error => error.code === 'request_outcome_unknown')
  h.store.commitRequest = commit; h.store.markRequestUnknown = mark; h.store.getRequest = get
  const pending = [...h.store.requests.values()].find(row => row.idempotencyKey === 'content-buffer-uncertain')
  assert.equal(pending.status, 'reserved')
  assert.equal([...h.store.customerCharges.values()].find(row => row.usageRequestId === pending.id).status, 'reserved')
  assert.ok([...h.platformStore.leases.values()].some(row => row.ownerRequestId === pending.id))
  await assert.rejects(h.invokeData(next, 'content-buffer-other-idem'), error => error.code === 'request_in_progress')
  pending.leaseExpiresAt = new Date(Date.now() - 1).toISOString()
  await h.store.reapStaleReservations()
  assert.equal(pending.status, 'unknown')
  // The reaped request no longer holds other keys; its live parent delivery lease still does.
  await assert.rejects(h.invokeData(next, 'content-buffer-after-reap'), error => error.code === 'request_in_progress')
  assert.equal(h.calls.length, 1)
})

test('standard traversal never purchases a sixteenth upstream page and reports its bounded stop', async () => {
  const h = await harness({ payload: (_call, n) => biliPage([String(n)], n, 100) })
  const body = { platform: 'bilibili', query: '城市', pageSize: 3 }
  let cursor, result
  for (let page = 1; page <= 5; page++) {
    result = await h.invokeData({ ...body, ...(cursor ? { cursor } : {}) }, `content-upstream-limit-${page}`)
    cursor = result.body.data.pageInfo.nextCursor
  }
  assert.equal(h.calls.length, 15)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(row => row.code === 'upstream_page_limit_reached'))
})

test('fifty raw keyword jobs retain the existing work bound with fifty independently recorded receipts', async () => {
  const queries = Array.from({ length: 50 }, (_, index) => `query-${index}`)
  const h = await harness({ payload: call => biliPage([`${call.params.keyword}-1`]) })
  const result = await h.invoke({ platform: 'bilibili', queries, count: 1 })
  assert.equal(h.calls.length, 50)
  assert.equal(h.platformStore.calls.size, 50)
  assert.equal(h.platformStore.ingestJobs.length, 50)
  assert.equal(result.body.data.results.length, 50)
  assert.ok(result.body.data.results.every(row => row.success && row.items.length === 1))
  assert.equal(h.store.requests.size, 1)
  await assert.rejects(h.invoke({ platform: 'bilibili', queries: [...queries, 'fifty-one'], count: 1 }, 'content-raw-too-many'), error => error.code === 'work_budget_exceeded')
  assert.equal(h.calls.length, 50)
})

test('assembly errors identify the durable usage request for readonly lookup, including post-dispatch uncertainty', async () => {
  const h = await harness({fetchImpl:()=>{throw new Error('synthetic transport uncertainty')}})
  let failure
  try {await h.invokeData()} catch(error){failure=error}
  const request=[...h.store.requests.values()][0]
  assert.ok(request)
  assert.equal(request.status,'unknown')
  assert.equal(failure.details.requestId,request.id)
  assert.equal(h.calls.length,1)
  await assert.rejects(h.invokeData(),error=>error.details.requestId===request.id&&error.code==='request_outcome_unknown')
  assert.equal(h.calls.length,1)
})


const kuaishouRelatedCard = () => ({ itemType: 9, position: 5, atmosphereType: 0,
  relatedSearches: Array.from({ length: 8 }, (_, i) => ({ expTag: 'fixture-tag', keyword: `fixture-word-${i}`,
    iconText: '', subtagType: 0, type: 'fixture-type', iconColor: 'fixture-color',
    extParams: JSON.stringify({ reco_reason: 'fixture-reason', sever_path: 'fixture-path', module: 'fixture-module', request_source: 'fixture-source' }) })),
  itemTransferInfo: JSON.stringify({ refer_single_double_type: 0 }), rank: 5,
  extInfo: { styleType: 0, screenItemKey: 'fixture-screen', lines: 2, rsType: 0 }, isSingleColumnMode: true })
const kuaishouMixedPage = (page = 1, hasMore = false) => {
  const mixFeeds = Array.from({ length: 10 }, (_, i) => ({ itemType: 5, feed: {
    photo_id: Number.MAX_SAFE_INTEGER + 2, caption: `完整内容 ${page}/${i}`, like_count: i, comment_count: 0,
    share_info: `https://example.test/share?photoId=photo-${page}-${i}&userId=author-${i}`,
    main_mv_url: `https://example.test/video-${page}-${i}.mp4`, timestamp: 1760000000000 } }))
  mixFeeds.splice(5, 0, kuaishouRelatedCard())
  return { mixFeeds, has_more: hasMore, pcursor: hasMore ? `native-${page + 1}` : 'no_more' }
}

for (const [name, marker] of [['NUL', '"\\u0000"'], ['lone surrogate', '"\\ud800"'], ['negative zero', '-0'], ['nonfinite numeric parse', '1e400']]) {
  test(`Kuaishou standard search accepts safe posts from exact receipts with unused ${name} metadata`, async () => {
    const rawText = `{"code":200,"data":${JSON.stringify(kuaishouMixedPage())},"unused":${marker}}`
    const bytes = Buffer.from(rawText), sha = createHash('sha256').update(bytes).digest('hex')
    assert.equal(isPostgresSafeJsonValue(JSON.parse(rawText)), false)
    const h = await harness({ platform: 'kuaishou', fetchImpl: () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) })
    const first = await h.invokeData({ platform: 'kuaishou', query: '城市', pageSize: 20 })
    assert.equal(first.status, 200)
    assert.equal(first.body.data.items.length, 10)
    assert.deepEqual(first.body.data.items.map(item => item.externalId), Array.from({ length: 10 }, (_, i) => `photo-1-${i}`), 'use exact public string identities rather than rounded numeric IDs')
    assert.equal(first.body.data.pageInfo.hasMore, false)
    assert.equal(h.calls.length, 1)
    assert.equal(h.platformStore.ingestJobs.length, 1)
    assert.equal(h.platformStore.ingestJobs[0].payload.records.filter(row => row.objectType === 'post').length, 10)
    assert.ok(isPostgresSafeJsonValue(first.body))
    assert.ok(isPostgresSafeJsonValue(JSON.parse(JSON.stringify(h.platformStore.ingestJobs[0].payload))))
    const call = [...h.platformStore.calls.values()][0], archive = h.platformStore.restrictedResponseArchives.get(call.id)
    assert.equal(call.outcome, 'succeeded'); assert.equal(call.itemCount, 10); assert.equal(call.billed, true)
    assert.equal(archive.bodySize, bytes.length); assert.equal(archive.bodySha256, sha)
    assert.deepEqual(Buffer.from(archive.bodyBytes), bytes)
    assert.equal(archive.parsedPayload, null)
    const snapshot = structuredClone(h.store.requests.get(first.requestId))
    assert.deepEqual((await h.invokeData({ platform: 'kuaishou', query: '城市', pageSize: 20 })).body, first.body)
    assert.equal(h.calls.length, 1)
    assert.deepEqual(h.store.requests.get(first.requestId), snapshot)
  })
}

test('Kuaishou standard overflow reprojects exact unsafe-root bytes without new calls or duplicate ingestion', async () => {
  const rawText = JSON.stringify({ code: 200, data: kuaishouMixedPage(), unused: '\u0000' })
  const bytes = Buffer.from(rawText)
  const h = await harness({ platform: 'kuaishou', fetchImpl: () => new Response(bytes, { headers: { 'content-type': 'application/json' } }) })
  const body = { platform: 'kuaishou', query: '城市', pageSize: 3 }, seen = []
  let cursor
  for (let page = 1; page <= 4; page++) {
    const result = await h.invokeData({ ...body, ...(cursor ? { cursor } : {}) }, `kuaishou-unsafe-buffer-${page}`)
    seen.push(...result.body.data.items.map(item => item.externalId))
    cursor = result.body.data.pageInfo.nextCursor
    assert.equal(result.body.data.items.length, page < 4 ? 3 : 1)
    assert.equal(result.body.data.meta.providerCalls, page === 1 ? 1 : 0)
  }
  assert.equal(cursor, null)
  assert.deepEqual(seen, Array.from({ length: 10 }, (_, i) => `photo-1-${i}`))
  assert.equal(h.calls.length, 1); assert.equal(h.platformStore.ingestJobs.length, 1)
})

test('Kuaishou standard filling preserves full safe-post receipts while raw and native APIs keep full JSONB validation', async () => {
  const h = await harness({ platform: 'kuaishou', payload: (_call, n) => ({ ...kuaishouMixedPage(n, n === 1), unused: '\u0000' }) })
  const result = await h.invokeData({ platform: 'kuaishou', query: '城市', pageSize: 20 })
  assert.equal(result.body.data.items.length, 20); assert.equal(h.calls.length, 2)
  assert.equal(new Set(result.body.data.items.map(item => item.externalId)).size, 20)
  assert.equal(h.platformStore.ingestJobs.length, 2)
  const raw = await harness({ platform: 'kuaishou', payload: { ...kuaishouMixedPage(), unused: '\u0000' } })
  await assert.rejects(raw.invoke(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
  assert.equal([...raw.platformStore.calls.values()][0].errorCode, 'upstream_payload_unrepresentable')
  assert.equal(raw.platformStore.ingestJobs.length, 0)
  const native = await harness({ platform: 'kuaishou', payload: { ...kuaishouMixedPage(), unused: '\u0000' } })
  await assert.rejects(native.gateway.adapter.forwardNative(native.recipe.key, { params: { keyword: 'fixture' } }), error => error.evidence?.errorCode === 'upstream_payload_unrepresentable')
  assert.equal(native.calls.length, 1)
  const other = await harness()
  await assert.rejects(other.gateway.adapter.forwardNative(other.recipe.key, { params: { keyword: 'fixture' } }, { contentSearchProjection: true }), /Unsupported content projection endpoint/)
  assert.equal(other.calls.length, 0)
})

for (const field of ['caption', 'image', 'cursor']) {
  test(`Kuaishou unsafe served ${field} is archived as a definite unusable result before ingest`, async () => {
    const payload = kuaishouMixedPage()
    if (field === 'caption') payload.mixFeeds[0].feed.caption = 'body\u0000unsafe'
    if (field === 'image') payload.mixFeeds[0].feed.images = ['https://example.test/unsafe\u0000image.jpg']
    if (field === 'cursor') { payload.has_more = true; payload.pcursor = '\ud800' }
    const h = await harness({ platform: 'kuaishou', payload })
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable' && error.status === 502)
    const call = [...h.platformStore.calls.values()][0], request = [...h.store.requests.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable'); assert.equal(call.billed, true)
    assert.equal(call.errorCode, 'invalid_content_search_contract')
    assert.equal(request.status, 'committed'); assert.equal(request.responseStatus, 502)
    assert.equal(h.calls.length, 1); assert.equal(h.platformStore.ingestJobs.length, 0)
    assert.ok(h.platformStore.restrictedResponseArchives.has(call.id))
    const before = structuredClone(request)
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable')
    assert.equal(h.calls.length, 1); assert.deepEqual([...h.store.requests.values()][0], before)
  })
}

for (const platform of ['reddit', 'youtube']) {
  test(`${platform} standard search fills 19+5, buffers all paid overflow and replays without Night-All`, async () => {
    const firstIds = Array.from({ length: 19 }, (_, i) => `first-${i}`)
    const secondIds = Array.from({ length: 5 }, (_, i) => `second-${i}`)
    const h = await harness({ platform, payload: (_call, n) => n === 1
      ? internationalPage(platform, firstIds, 'next-page-token') : internationalPage(platform, secondIds) })
    await h.service.setTenantBillingProfile(h.context.tenant.id,
      { mode: 'enforced', multiplierPpm: 1000000, defaultUnitPriceMinor: 3, defaultCurrency: 'CNY' }, 'offline-admin')
    await h.service.addTenantCredit(h.context.tenant.id, { amountMinor: 100, currency: 'CNY', reason: 'Offline fixture' },
      { idempotencyKey: 'international-content-credit', actor: 'offline-admin' })
    const body = { platform, query: 'Zhejiang public incident', pageSize: 20 }
    const first = await h.invokeData(body)
    assert.equal(first.body.data.contractVersion, 'night-all.data-search.v1')
    assert.equal(first.body.data.platform, platform)
    assert.equal(first.body.data.query, body.query)
    assert.deepEqual(first.body.data.items.map(row => row.externalId), [...firstIds, secondIds[0]])
    assert.equal(first.body.data.items[0].id, `${platform}:${firstIds[0]}`)
    assert.equal(first.body.data.items[0].metrics[platform === 'reddit' ? 'likes' : 'views'], 0)
    assert.equal(first.body.data.items[0].metrics.comments, null)
    assert.equal(first.body.data.pageInfo.returnedCount, 20)
    assert.match(first.body.data.pageInfo.nextCursor, /^mxds1\./)
    assert.equal(h.calls.length, 2)
    assert.ok(h.calls.every(call => call.url.pathname === h.recipe.path && call.options.method === 'GET'))
    assert.equal(h.calls[0].params[platform === 'reddit' ? 'query' : 'keyword'], body.query)
    assert.equal(h.calls[1].params[platform === 'reddit' ? 'after' : 'continuation_token'], 'next-page-token')
    assert.ok(h.calls.every(call => !Object.hasOwn(call.params, 'page_size') && !Object.hasOwn(call.params, 'count')))
    assert.deepEqual([...h.platformStore.calls.values()].map(call => call.itemCount), [19, 5])
    assert.equal(h.platformStore.restrictedResponseArchives.size, 2)
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.ok(h.platformStore.ingestJobs.every(job => job.payload.datasetId === 'night-all.search.v1'))
    const saved = h.store.requests.get(first.requestId)
    assert.equal(saved.billingMeterKey, platform)
    assert.ok(isPostgresSafeJsonValue(saved.acquisitionRequest.contentSearch))
    assert.equal([...h.store.customerCharges.values()].filter(row => row.status === 'captured').length, 1)
    assert.deepEqual((await h.invokeData(body)).body, first.body)
    assert.equal(h.calls.length, 2)
    const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'international-content-second')
    assert.deepEqual(second.body.data.items.map(row => row.externalId), secondIds.slice(1))
    assert.equal(second.body.data.pageInfo.hasMore, false)
    assert.equal(second.body.data.pageInfo.nextCursor, null)
    assert.equal(h.calls.length, 2, 'a terminal archived remainder needs no additional supplier purchase')
    assert.equal(h.platformStore.ingestJobs.length, 2)
    assert.equal(h.historical.length, 0)
  })

  test(`${platform} raw aliases retain their original forwarding and parameter contract`, async () => {
    const h = await harness({ platform })
    const payload = { data: { platform, raw_info: '[]', raw_data: '[]', page: { page: 1, hasMore: false },
      status: 'ok', warnings: [], meta: { original: true } } }
    h.service.adapter.legacySearch = async input => { h.historical.push(input); return { payload, raw: payload } }
    const body = { platform, keyword: 'original raw query', count: 20, includeDetails: true, params: { fixture: 'original-filter' } }
    const first = await h.invoke(body, 'international-original-raw')
    assert.equal(h.historical.length, 1)
    assert.equal(h.historical[0].operation, 'raw')
    assert.equal(h.historical[0].body.includeDetails, true)
    assert.deepEqual(h.historical[0].body.params, body.params)
    assert.deepEqual((await h.invoke(body, 'international-original-raw', '/api/v1/search/raw')).body, first.body)
    assert.equal(h.historical.length, 1)
    assert.equal(h.calls.length, 0)
  })

  test(`${platform} public contract rejects supplier options and never falls back when native execution is unavailable`, async () => {
    const h = await harness({ platform })
    const body = { platform, query: 'same query', pageSize: 20 }
    for (const extra of [{ params: {} }, { provider: 'tikhub' }, { includeDetails: true }]) {
      await assert.rejects(h.invokeData({ ...body, ...extra }), error => error.status === 400 && error.code === 'unsupported_fields')
    }
    await assert.rejects(h.invokeData({ ...body, cursor: 'unwrapped-provider-token' }),
      error => error.status === 400 && error.code === 'content_search_pagination_unsupported')
    h.service.externalDataSearch = null
    await assert.rejects(h.invokeData(body), error => error.status === 503 && error.code === 'content_search_unavailable')
    assert.equal(h.calls.length, 0)
    assert.equal(h.historical.length, 0)
  })

  test(`${platform} direct cursors remain bound to query, page size and API Key`, async () => {
    const h = await harness({ platform, payload: internationalPage(platform, ['one', 'two']) })
    const body = { platform, query: 'cursor query', pageSize: 1 }
    const first = await h.invokeData(body)
    const cursor = first.body.data.pageInfo.nextCursor
    for (const change of [{ query: 'another' }, { pageSize: 2 }]) {
      await assert.rejects(h.invokeData({ ...body, cursor, ...change }, 'international-invalid-cursor'), error => error.code === 'invalid_cursor')
    }
    const issued = await h.service.createApiKey({ consumerId: h.context.consumer.id, name: 'Another Key', platforms: [platform], capabilities: [] })
    const context = await h.service.authenticate(issued.secret)
    await assert.rejects(h.service.search(context, { body: { ...body, cursor }, idempotencyKey: 'international-another-key', path: '/api/v1/data/search' }),
      error => error.code === 'invalid_cursor')
    assert.equal(h.calls.length, 1)
    assert.equal(h.historical.length, 0)
  })

  test(`${platform} uncertain second supplier call holds its own key without automatic retry or historical fallback`, async () => {
    const h = await harness({ platform, fetchImpl: (_call, n) => {
      if (n === 2) throw new TypeError('synthetic transport uncertainty')
      return Response.json({ code: 200, data: internationalPage(platform, ['one'], 'next-page-token') })
    } })
    const body = { platform, query: 'uncertain query', pageSize: 20 }
    await assert.rejects(h.invokeData(body), error => ['upstream_outcome_unknown', 'request_outcome_unknown'].includes(error.code))
    assert.equal([...h.store.requests.values()][0].status, 'unknown')
    await assert.rejects(h.invokeData(body), error => error.code === 'request_outcome_unknown')
    assert.equal(h.calls.length, 2)
    const next = await h.invokeData(body, 'international-uncertain-new-key')
    assert.equal(next.status, 200)
    assert.equal(h.calls.length, 4)
    assert.equal(h.historical.length, 0)
  })
}

for (const platform of ['reddit', 'youtube']) test(`${platform} a repeated continuation retains paid content with an explicit partial stop`, async () => {
  const h = await harness({ platform, payload: (_call, n) => internationalPage(platform, [String(n)], 'same-token') })
  const result = await h.invokeData({ platform, query: 'repeat query', pageSize: 20 })
  assert.deepEqual(result.body.data.items.map(row => row.externalId), ['1', '2'])
  assert.equal(result.body.data.status, 'partial')
  assert.ok(result.body.data.warnings.some(row => row.code === 'content_search_repeated_cursor'))
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.equal(result.body.data.pageInfo.nextCursor, null)
  assert.equal(h.calls.length, 2)
  assert.equal(h.historical.length, 0)
  assert.ok([...h.platformStore.calls.values()].every(call => call.outcome === 'succeeded'))
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.deepEqual((await h.invokeData({ platform, query: 'repeat query', pageSize: 20 })).body, result.body)
  assert.equal(h.calls.length, 2)
})

test('LCY content-search uses refreshed switch and excludes exempt work from ordinary counters', async () => {
  const { LcyHubLimitStore } = await import('../fixtures/lcy-hub-limit-store.mjs')
  const f = await harness({ store: new LcyHubLimitStore() })
  f.gateway.active = f.config.maxConcurrency
  f.gateway.activeByConsumer.set(f.context.consumer.id, 1)
  f.platformStore.acquireProviderRateLimit = async () => assert.fail('exempt content must not consume provider tokens')
  const result = await f.invokeData()
  assert.equal(result.status, 200); assert.equal(f.calls.length, 1)
  assert.equal(f.gateway.active, f.config.maxConcurrency)
  assert.equal(f.gateway.activeByConsumer.get(f.context.consumer.id), 1)
  f.store.apiKeys.get(f.context.apiKey.id).hubRateLimitExempt = false
  // Caller holds the earlier authenticated snapshot; acquisition revalidation
  // must still see the administrator's current setting before admission.
  await assert.rejects(f.invokeData({ platform: 'bilibili', query: '已关闭', pageSize: 20 }, 'content-switch-disabled'),
    { code: 'external_platform_busy' })
  assert.equal(f.calls.length, 1)
  assert.equal(f.gateway.active, f.config.maxConcurrency)
})

test('turning LCY exemption off between acquired pages restores capacity before the next paid dispatch', async () => {
  const { LcyHubLimitStore } = await import('../fixtures/lcy-hub-limit-store.mjs')
  const store = new LcyHubLimitStore()
  const f = await harness({ store, payload: () => {
    store.apiKeys.get('fd2f8cc9-0ff1-4052-a538-8cc8150bde83').hubRateLimitExempt = false
    return biliPage(['first-paid-row'], 1, 2)
  } })
  f.gateway.active = f.config.maxConcurrency
  f.gateway.activeByConsumer.set(f.context.consumer.id, 2)
  f.platformStore.acquireProviderRateLimit = async () => assert.fail('the second page must fail concurrency before taking a rate token')
  const result = await f.invokeData()
  assert.equal(result.status, 200, 'already acquired records remain deliverable')
  assert.equal(result.body.data.status, 'partial')
  assert.deepEqual(result.body.data.items.map(row => row.externalId), ['first-paid-row'])
  assert.equal(f.calls.length, 1, 'the second page must not dispatch after the switch turns off')
  assert.equal(f.gateway.active, f.config.maxConcurrency)
  assert.equal(f.gateway.activeByConsumer.get(f.context.consumer.id), 2)
  assert.equal([...f.platformStore.calls.values()].length, 1)
  assert.equal([...f.store.requests.values()][0].status, 'committed')
})

const tiktokPage = (ids, next = null) => ({ data: ids.map(id => ({ type: 1, item: {
  id, desc: '完整文本'.repeat(200), author: { id: '7111111111111111111', uniqueId: 'fixture', nickname: '作者' },
  stats: { diggCount: 0, commentCount: 3 }, video: { playAddr: 'https://example.test/video.mp4?sig=a%2Fb', cover: 'https://example.test/cover.jpg' },
} })), has_more: next != null ? 1 : 0, cursor: next ?? 0, search_id: 'fixture-session' })
const xhsPage = (ids, page = 1, hasMore = false) => ({ page, next_page: hasMore ? page + 1 : null, data: {
  items: ids.map(id => ({ model_type: 'note', note: { id, title: `标题${id}`, desc: '真实完整正文',
    user: { user_id: 'fixture-author', nickname: '作者' }, interact_info: { liked_count: 0, comment_count: 4 } } })),
} })
const weiboPage = (ids, hasMore = false) => ({ parsed_data: { results: ids.map(id => ({ weibo_id: id,
  content: '已获取的完整正文', user_id: '1234567890', interaction: { comment_count: 4, like_count: 0 } })),
  pagination: { has_next_page: hasMore }, parse_success: true } })

for (const platform of ['tiktok', 'weibo', 'xiaohongshu']) test(`${platform} standard small pages retain full acquired overflow and replay without another purchase`, async () => {
  const ids = platform === 'xiaohongshu' ? ['675d277d000000000600e655', '675d277d000000000600e658', '675d277d000000000600e659']
    : ['7111111111111111111', '7111111111111111112', '7111111111111111113']
  const payload = platform === 'tiktok' ? tiktokPage(ids) : platform === 'weibo' ? weiboPage(ids) : xhsPage(ids)
  const h = await harness({ platform, payload }), body = { platform, query: '城'.repeat(500), pageSize: 1 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items.length, 1)
  assert.equal(first.body.data.items[0].externalId, ids[0])
  assert.equal(first.body.data.items[0].metrics.likes, 0)
  assert.equal(first.body.data.items[0].metrics.comments, platform === 'tiktok' ? 3 : 4)
  assert.equal(h.calls.length, 1)
  assert.equal(h.calls[0].options.method, 'GET')
  assert.equal(h.calls[0].url.pathname, h.recipe.path)
  assert.equal([...h.platformStore.calls.values()][0].itemCount, 3)
  const archive = [...h.platformStore.restrictedResponseArchives.values()][0]
  assert.deepEqual(JSON.parse(Buffer.from(archive.bodyBytes).toString()).data, payload)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  let last = first
  for (let page = 2; page <= 3; page++) {
    last = await h.invokeData({ ...body, cursor: last.body.data.pageInfo.nextCursor }, `remaining-buffer-page-${page}`)
    assert.equal(last.body.data.items[0].externalId, ids[page - 1])
    assert.equal(last.body.data.meta.providerCalls, 0)
    assert.equal(h.calls.length, 1)
  }
  assert.equal(last.body.data.pageInfo.hasMore, false)
  assert.equal(h.platformStore.ingestJobs.length, 1)
  assert.equal(h.historical.length, 0)
  if (platform === 'xiaohongshu') {
    assert.equal([...h.platformStore.calls.values()][0].operation, 'social.posts.search')
    assert.equal([...h.platformStore.calls.values()][0].endpointKey, xiaohongshuSearchOperation.endpointKey)
    assert.equal([...h.store.requests.values()][0].billingMeterKey, 'social.posts.search')
  }
})

test('TikTok fills advancing source pages and keeps video covers out of image media', async () => {
  const h = await harness({ platform: 'tiktok', payload: (_call, n) => tiktokPage([`711111111111111111${n}`], n < 3 ? n * 10 : null) })
  const result = await h.invokeData({ platform: 'tiktok', query: '城市', pageSize: 3 })
  assert.equal(result.body.data.items.length, 3)
  assert.deepEqual(h.calls.map(call => call.params.offset), ['0', '10', '20'])
  assert.equal(h.calls[1].params.search_id, 'fixture-session')
  assert.equal(result.body.data.items[0].text.length, 800)
  assert.deepEqual(result.body.data.items[0].media.images, [])
  assert.equal(result.body.data.items[0].media.coverUrl, 'https://example.test/cover.jpg')
  assert.equal(result.body.data.items[0].metrics.views, null)
  assert.equal([...h.store.requests.values()].length, 1)
})

test('Xiaohongshu non20 pages cannot bypass paused existing search operation or require native grant', async () => {
  const h = await harness({ platform: 'xiaohongshu', payload: xhsPage([]) })
  await h.controls.updatePolicy('tikhub', 'social.posts.search', { expectedRevision: 1, desiredState: 'paused', reason: 'Offline pause' },
    { runtime: { config: h.config, credentialConfigured: true } })
  await assert.rejects(h.invokeData({ platform: 'xiaohongshu', query: '城市', pageSize: 5 }), error => /operation_/.test(error.code))
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
})

for (const platform of ['tiktok', 'weibo', 'xiaohongshu']) test(`${platform} a historical unknown does not hide the retired-cursor restart for a new idempotency key`, async () => {
  const h = await harness({ platform }), body = { platform, query: '城市', pageSize: 1 }
  const codec = createNightAllCompatibilityCursorCodec(PEPPER, h.context.consumer.id)
  const traversal = prepareNightAllCompatibilityTraversal({ operation: 'data-search', platform, upstreamBody: body, codec })
  const wrapped = capNightAllDataSearchTraversal({ data: { pageInfo: { pageIndex: 1, pageSize: 1, returnedCount: 0,
    hasMore: true, nextCursor: 'old-native-token', cursorType: 'opaque' }, warnings: [] } }, { platform, page: 1, scope: traversal.scope, codec })
  const id = randomUUID()
  await h.store.reserve({ requestId: id, idempotencyKey: 'historical-unknown-page',
    fingerprint: requestFingerprint({ method: 'POST', path: '/api/v1/data/search', body: { ...body, cursor: 'old-native-token', type: 'fresh' } }),
    tenantId: h.context.tenant.id, consumerId: h.context.consumer.id, apiKeyId: h.context.apiKey.id, platform,
    acquisitionRequest: { path: '/api/v1/data/search', body }, unitsReserved: 1,
    leaseExpiresAt: new Date(Date.now() + 120000), windowStart: new Date(Date.now() - 60000), maxRequests: 100 })
  await h.store.markRequestUnknown(id, 'offline_unknown')
  await assert.rejects(h.invokeData({ ...body, cursor: wrapped.data.pageInfo.nextCursor }, 'historical-unknown-new'), error => error.code === 'search_restart_required')
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
})

test('Weibo buffered delivery enriches only delivered IDs, archives full text separately and never repurchases it on replay or buffer-only delivery', async () => {
  const ids = ['7111111111111111111', '7111111111111111111', '7111111111111111112']
  const source = weiboPage(ids)
  source.parsed_data.results[0].content = source.parsed_data.results[1].content = '需要展开全文…'
  const full = '详情完整正文'.repeat(100)
  const h = await harness({ platform: 'weibo', payload: call => call.url.pathname.endsWith('/fetch_realtime_search') ? source
    : { idstr: ids[0], user: { idstr: '1234567890' }, longText: { content: full } } })
  const actualEndpoint = nativeForwardingEndpoint((await import('../../server/contracts/raw-search.mjs')).WEIBO_DETAIL_KEY)
  assert.ok(actualEndpoint)
  await h.controls.updatePolicy('tikhub', actualEndpoint.operation, { expectedRevision: 1, desiredState: 'active', reason: 'Offline detail',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [actualEndpoint.endpointKey]: 12 } } },
  { runtime: { config: h.config, credentialConfigured: true } })
  const body = { platform: 'weibo', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items[0].text, full)
  assert.equal(first.body.data.meta.providerCalls, 2)
  assert.equal(h.calls.length, 2)
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.equal(h.platformStore.ingestJobs[1].payload.kind, 'external-platform-result')
  assert.equal(h.platformStore.ingestJobs[1].payload.records[0].body, full)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  const next = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'weibo-detail-buffer-next')
  assert.equal(next.body.data.items[0].externalId, ids[2])
  assert.equal(next.body.data.meta.providerCalls, 0)
  assert.equal(h.calls.length, 2)
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.equal(next.body.data.pageInfo.hasMore, false)
})

test('Xiaohongshu buffered preview uses existing detail workflow once and preserves enriched immutable replay', async () => {
  const ids = ['675d277d000000000600e655', '675d277d000000000600e655', '675d277d000000000600e658']
  const source = xhsPage(ids)
  source.data.items[0].note.desc = source.data.items[1].note.desc = '文'.repeat(60)
  const h = await harness({ platform: 'xiaohongshu', payload: source })
  const { TIKHUB_XIAOHONGSHU_ENDPOINT_KEY } = await import('../../server/contracts/tikhub-xiaohongshu.mjs')
  await h.controls.updatePolicy('tikhub', 'social.posts.resolve', { expectedRevision: 0, desiredState: 'active', reason: 'Offline detail',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [TIKHUB_XIAOHONGSHU_ENDPOINT_KEY]: 12 } } },
  { runtime: { config: h.config, credentialConfigured: true } })
  let detailCalls = 0
  const full = '完整详情正文'.repeat(100)
  h.adapter.getXiaohongshuPost = async () => {
    detailCalls++
    const capturedAt = new Date().toISOString()
    return { publicBody: { contractVersion: 'mx-insight-hub.social-post.v1', data: { item: {
      id: `xiaohongshu:${ids[0]}`, externalId: ids[0], platform: 'xiaohongshu', contentType: 'post',
      url: `https://www.xiaohongshu.com/explore/${ids[0]}`, title: '详情标题', text: full, tags: [],
      author: { id: 'fixture-author', name: '作者', avatarUrl: null },
      metrics: { liked: 0, collected: null, comments: 4, shared: null }, media: [], publishedAt: null, collectedAt: capturedAt,
    } }, meta: { capturedAt } }, records: [], archiveObjects: [],
      responseArchive: { capturedAt, httpStatus: 200, businessCode: 200, contractState: 'accepted', payloadSha256: '2'.repeat(64), bodySize: 128, rawPayload: {} } }
  }
  const body = { platform: 'xiaohongshu', query: '城市', pageSize: 1 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items[0].text, full)
  assert.equal(first.body.data.meta.providerCalls, 2)
  assert.equal(detailCalls, 1)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  const next = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'xiaohongshu-detail-buffer-next')
  assert.equal(next.body.data.items[0].externalId, ids[2])
  assert.equal(next.body.data.meta.providerCalls, 0)
  assert.equal(detailCalls, 1)
  assert.equal(h.calls.length, 1)
})

test('Xiaohongshu larger standard pages preserve provider session and buffer the final acquired remainder', async () => {
  const h = await harness({ platform: 'xiaohongshu', payload: (_call, n) => ({ ...xhsPage(
    Array.from({ length: 20 }, (_, i) => (0x675d277d000000000600e600n + BigInt(n * 20 + i)).toString(16)), n, n < 3),
    search_id: 'fixture-search-id', search_session_id: 'fixture-search-session' }) })
  const body = { platform: 'xiaohongshu', query: '城市', pageSize: 25 }
  const first = await h.invokeData(body)
  assert.equal(first.body.data.items.length, 25)
  assert.equal(h.calls.length, 2)
  assert.deepEqual(h.calls.map(call => call.params.page), ['1', '2'])
  assert.equal(h.calls[1].params.search_id, 'fixture-search-id')
  assert.equal(h.calls[1].params.search_session_id, 'fixture-search-session')
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'xhs-large-second')
  assert.equal(second.body.data.items.length, 25)
  assert.equal(h.calls.length, 3)
  const third = await h.invokeData({ ...body, cursor: second.body.data.pageInfo.nextCursor }, 'xhs-large-third')
  assert.equal(third.body.data.items.length, 10)
  assert.equal(third.body.data.meta.providerCalls, 0)
  assert.equal(third.body.data.pageInfo.hasMore, false)
  assert.equal(h.calls.length, 3)
  assert.equal(new Set([...first.body.data.items, ...second.body.data.items, ...third.body.data.items].map(item => item.externalId)).size, 60)
})

test('Xiaohongshu standard20 always uses existing gateway, whose pause never falls back to Night-All', async () => {
  const h = await harness({ platform: 'xiaohongshu', payload: xhsPage([]) })
  h.service.externalSocialSearchEnabled = false
  await h.controls.updatePolicy('tikhub', 'social.posts.search', { expectedRevision: 1, desiredState: 'paused', reason: 'Offline pause' },
    { runtime: { config: h.config, credentialConfigured: true } })
  await assert.rejects(h.invokeData({ platform: 'xiaohongshu', query: '城市', pageSize: 20 }), error => /operation_/.test(error.code))
  assert.equal(h.calls.length, 0)
  assert.equal(h.historical.length, 0)
})

test('TikTok malformed content and unproven advancing continuation preserve paid failure without automatic repeat', async () => {
  for (const payload of [
    { data: [{ unrecognized: { secret: 'synthetic-field' } }], has_more: false },
    { data: [{ item: { id: '7111111111111111111', desc: '正文' } }], has_more: true },
    { data: [], status_code: 10000, has_more: false },
  ]) {
    const h = await harness({ platform: 'tiktok', payload })
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable')
    const call = [...h.platformStore.calls.values()][0]
    assert.equal(call.outcome, 'succeeded_unusable')
    assert.equal(call.billed, true)
    assert.deepEqual(JSON.parse(Buffer.from(h.platformStore.restrictedResponseArchives.get(call.id).bodyBytes).toString()).data, payload)
    await assert.rejects(h.invokeData(), error => error.code === 'external_platform_response_unusable')
    await assert.rejects(h.invokeData(undefined, 'tiktok-malformed-new-key'), error => error.code === 'external_platform_response_unusable')
    assert.equal(h.calls.length, 1)
  }
})

for (const [pageSize, finalCount] of [[100, 1], [15, 3]]) test(`Xiaohongshu source-page limit remains partial and survives the ${pageSize}-item delivery buffer`, async () => {
  const h = await harness({ platform: 'xiaohongshu', payload: (_call, n) => xhsPage(
    Array.from({ length: n === 15 ? finalCount : 1 }, (_, i) => (0x675d277d000000000600e600n + BigInt(n * 100 + i)).toString(16)), n, true) })
  const body = { platform: 'xiaohongshu', query: '城市', pageSize }
  const first = await h.invokeData(body)
  assert.equal(h.calls.length, 15)
  assert.equal(h.calls.at(-1).params.page, '15')
  assert.equal(first.body.data.items.length, 15)
  assert.equal(first.body.data.status, 'partial')
  assert.ok(first.body.data.warnings.some(warning => warning.code === 'page_limit_reached'))
  assert.equal(first.body.data.pageInfo.hasMore, finalCount > 1)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  if (finalCount > 1) {
    const nextBody = { ...body, cursor: first.body.data.pageInfo.nextCursor }
    const next = await h.invokeData(nextBody, 'xhs-limit-buffer-next')
    assert.equal(next.body.data.items.length, 2)
    assert.equal(next.body.data.status, 'partial')
    assert.ok(next.body.data.warnings.some(warning => warning.code === 'page_limit_reached'))
    assert.equal(next.body.data.pageInfo.hasMore, false)
    assert.equal(next.body.data.meta.providerCalls, 0)
    assert.deepEqual((await h.invokeData(nextBody, 'xhs-limit-buffer-next')).body, next.body)
  }
  assert.equal(h.calls.length, 15)
  assert.equal(h.historical.length, 0)
})

for (const finalCount of [1, 6]) test(`Weibo source-page limit retains truncation evidence with ${finalCount} final source rows`, async () => {
  const h = await harness({ platform: 'weibo', payload: (_call, n) => weiboPage(
    Array.from({ length: n === 15 ? finalCount : 1 }, (_, i) => String(7111111111111111100n + BigInt(n * 100 + i))), true) })
  const body = { platform: 'weibo', query: '城市', pageSize: 19 }
  const first = await h.invokeData(body)
  assert.equal(h.calls.length, 15)
  assert.equal(h.calls.at(-1).params.page, '15')
  assert.equal(first.body.data.items.length, finalCount === 1 ? 15 : 19)
  assert.equal(first.body.data.status, 'partial')
  assert.ok(first.body.data.warnings.some(warning => warning.code === 'page_limit_reached'))
  assert.equal(first.body.data.pageInfo.hasMore, finalCount > 1)
  assert.deepEqual((await h.invokeData(body)).body, first.body)
  if (finalCount > 1) {
    const next = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'weibo-limit-buffer-next')
    assert.equal(next.body.data.items.length, 1)
    assert.equal(next.body.data.status, 'partial')
    assert.ok(next.body.data.warnings.some(warning => warning.code === 'page_limit_reached'))
    assert.equal(next.body.data.pageInfo.hasMore, false)
    assert.equal(next.body.data.meta.providerCalls, 0)
  }
  assert.equal(h.calls.length, 15)
  assert.equal(h.historical.length, 0)
})

async function enableRemainingSearchDetail(h, platform) {
  const endpoint = platform === 'weibo'
    ? nativeForwardingEndpoint((await import('../../server/contracts/raw-search.mjs')).WEIBO_DETAIL_KEY)
    : { operation: 'social.posts.resolve', endpointKey: (await import('../../server/contracts/tikhub-xiaohongshu.mjs')).TIKHUB_XIAOHONGSHU_ENDPOINT_KEY }
  await h.controls.updatePolicy('tikhub', endpoint.operation, { expectedRevision: platform === 'weibo' ? 1 : 0,
    desiredState: 'active', reason: 'Offline detail authorization boundary',
    priceBook: { currency: 'USD', pricingAsOf: '2026-10-08T00:00:00Z', monthlyBudgetMinor: 100000,
      monthlySubsidyBudgetMinor: 100000, unitCostMinorByEndpoint: { [endpoint.endpointKey]: 12 } } },
  { runtime: { config: h.config, credentialConfigured: true } })
}
function revokeRemainingSearch(h, kind) {
  if (kind === 'platform') h.store.grants.set(h.context.consumer.id, [])
  else if (kind === 'key') h.store.apiKeys.get(h.context.apiKey.id).status = 'revoked'
  else if (kind === 'capability') h.store.capabilityGrants.set(h.context.consumer.id, [])
  else if (kind === 'plan') h.store.getConsumerPlan = async () => null
  else if (kind === 'plan_version') h.store.getConsumerPlan = async () => ({ status: 'active', versionStatus: 'retired' })
}
function previewRemainingPage(platform) {
  if (platform === 'weibo') {
    const source = weiboPage(['7111111111111111111'])
    source.parsed_data.results[0].content = '需要展开全文…'
    return source
  }
  const source = xhsPage(['675d277d000000000600e655'])
  source.data.items[0].note.desc = '文'.repeat(60)
  return source
}
for (const platform of ['weibo', 'xiaohongshu']) test(`${platform} buffered finalization rechecks revoked Key, grants and active published plan after the paid search`, async () => {
  for (const kind of ['platform', 'key', 'plan', 'plan_version', ...(platform === 'xiaohongshu' ? ['capability'] : [])]) {
    let h
    h = await harness({ platform, payload: () => { revokeRemainingSearch(h, kind); return previewRemainingPage(platform) } })
    await enableRemainingSearchDetail(h, platform)
    let detailCalls = 0
    h.adapter.getXiaohongshuPost = async () => { detailCalls++; assert.fail('Revoked search cannot buy a detail') }
    await assert.rejects(h.invokeData({ platform, query: '城市', pageSize: 1 }), error => error.code === 'request_outcome_unknown')
    assert.equal(h.calls.length, 1)
    assert.equal(detailCalls, 0)
    assert.equal([...h.platformStore.calls.values()].length, 1)
    assert.equal([...h.platformStore.calls.values()][0].outcome, 'succeeded')
    assert.equal([...h.store.requests.values()][0].status, 'unknown')
    assert.equal(h.historical.length, 0)
  }
})
for (const platform of ['weibo', 'xiaohongshu']) test(`${platform} detail rechecks access after asynchronous admission immediately before another paid dispatch`, async () => {
  const h = await harness({ platform, payload: previewRemainingPage(platform) })
  await enableRemainingSearchDetail(h, platform)
  const rate = h.platformStore.acquireProviderRateLimit.bind(h.platformStore)
  let rateCalls = 0, detailCalls = 0
  h.platformStore.acquireProviderRateLimit = async input => {
    const result = await rate(input)
    if (++rateCalls === 2) revokeRemainingSearch(h, 'key')
    return result
  }
  h.adapter.getXiaohongshuPost = async () => { detailCalls++; assert.fail('Revoked key cannot buy a detail') }
  await assert.rejects(h.invokeData({ platform, query: '城市', pageSize: 1 }), error => error.code === 'request_outcome_unknown')
  assert.equal(rateCalls, 2)
  assert.equal(h.calls.length, 1)
  assert.equal(detailCalls, 0)
  assert.equal([...h.platformStore.calls.values()].length, 1)
  assert.equal([...h.store.requests.values()][0].status, 'unknown')
})

// Synthetic values follow the 19-item saved TikHub timeline schema; they are
// not a copy of the private receipt or evidence of live cold-start delivery.
const twitterPage = (ids, cursor = '', date = '2026-10-17T10:00:00Z') => ({
  timeline: ids.map(id => ({ tweet_id: String(id), text: `完整正文 ${id} <literal>`, created_at: date,
    user_info: { rest_id: '123456789012345678', name: 'Fixture', screen_name: 'fixture', avatar: 'https://example.test/avatar.jpg' },
    favorites: 0, replies: 3, retweets: 2, views: null, quotes: 1, bookmarks: 0,
    media: { photo: [{ media_url_https: 'https://example.test/photo.jpg?signature=a%2Fb' }] } })), next_cursor: cursor,
})

test('Twitter standard keeps original Boolean query, fills 19+8 and buffers every paid overflow item', async () => {
  const ids = Array.from({ length: 27 }, (_, i) => String(8000000000000000000n + BigInt(i)))
  const h = await harness({ platform: 'twitter', payload: (_call, index) => index === 1
    ? twitterPage(ids.slice(0, 19), 'native-opaque+token=') : twitterPage(ids.slice(19)) })
  const body = { platform: 'twitter', query: '("diplomacy" OR "foreign policy") AND ("statement" OR "update") AND NOT ("ad" OR "marketing")', pageSize: 20, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-first')
  assert.equal(first.body.data.query, body.query)
  assert.equal(first.body.data.contractVersion, 'night-all.data-search.v1')
  assert.deepEqual(first.body.data.items.map(row => row.id), ids.slice(0, 20))
  assert.equal(first.body.data.items[0].text, `完整正文 ${ids[0]} <literal>`)
  assert.deepEqual(first.body.data.items[0].metrics, { likes: 0, comments: 3, shares: 2, views: null, bookmarks: 0 })
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[0].params.keyword, '("diplomacy" OR "foreign policy") ("statement" OR "update") -"ad" -"marketing"')
  assert.equal(h.calls[1].params.cursor, 'native-opaque+token=')
  assert.ok(h.calls.every(call => call.params.search_type === 'Latest' && !('count' in call.params) && !('page_size' in call.params)))
  assert.deepEqual([...h.platformStore.calls.values()].map(call => call.itemCount), [19, 8])
  assert.equal(h.platformStore.ingestJobs.length, 2)
  assert.equal(h.store.requests.get(first.requestId).acquisitionRequest.searchProvider, 'tikhub')
  assert.deepEqual((await h.invokeData(body, 'twitter-first')).body, first.body)
  assert.equal(h.calls.length, 2)
  const secondBody = { ...body, cursor: first.body.data.pageInfo.nextCursor }
  const second = await h.invokeData(secondBody, 'twitter-next')
  assert.deepEqual(second.body.data.items.map(row => row.id), ids.slice(20))
  assert.equal(second.body.data.pageInfo.hasMore, false)
  assert.deepEqual((await h.invokeData(secondBody, 'twitter-next')).body, second.body)
  assert.equal(h.calls.length, 2)
  assert.equal(h.historical.length, 0)
  assert.deepEqual(h.context.apiKey.platforms, ['twitter'])
})

test('Twitter v2 filters exact time locally and continues an empty filtered page without losing native overflow', async () => {
  const h = await harness({ platform: 'twitter', payload: (_call, index) => index === 1
    ? twitterPage(['8000000000000000001'], 'second', '2026-10-16T15:59:59Z')
    : twitterPage(['8000000000000000002'], '', '2026-10-17T10:00:00Z') })
  const body = { platform: 'twitter', query: 'fixture', pageSize: 1, timeWindow: {
    from: '2026-10-16T16:00:00Z', to: '2026-10-17T16:00:00Z', timezone: 'Asia/Shanghai', boundary: '[from,to)' } }
  const invoke = (body, key) => h.service.search(h.context, { path: '/api/v2/data/search', body, idempotencyKey: key })
  const first = await invoke(body, 'twitter-v2-first')
  assert.equal(first.body.data.items.length, 0)
  assert.equal(first.body.data.pageInfo.hasMore, true)
  assert.match(first.body.data.pageInfo.nextCursor, /^mxds2\./)
  assert.equal(first.body.data.meta.effectiveWindow.deliveryFiltering, 'exact')
  assert.equal(first.body.data.meta.capabilities.coverageComplete, false)
  assert.deepEqual((await invoke(body, 'twitter-v2-first')).body, first.body)
  assert.equal(h.calls.length, 1)
  const second = await invoke({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-v2-next')
  assert.deepEqual(second.body.data.items.map(row => row.id), ['8000000000000000002'])
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].params.cursor, 'second')
  await assert.rejects(h.invokeData({ platform: 'twitter', query: 'fixture', pageSize: 1 }, 'twitter-v2-first'), { code: 'idempotency_conflict' })
  assert.equal(h.calls.length, 2)
})

test('Twitter keeps empty native cursor pages and repeated-cursor results without inventing exhaustion from count', async () => {
  const h = await harness({ platform: 'twitter', payload: (_call, n) => n === 1
    ? twitterPage([], 'opaque') : twitterPage(['8000000000000000003'], 'opaque') })
  const result = await h.invokeData({ platform: 'twitter', query: 'empty-first-page', pageSize: 20 })
  assert.equal(h.calls.length, 2)
  assert.equal(result.body.data.items.length, 1)
  assert.equal(result.body.data.pageInfo.hasMore, false)
  assert.ok(result.body.data.warnings.some(row => row.code === 'content_search_repeated_cursor'))
})

test('Twitter standard persists exact unrelated unsafe metadata while delivering safe posts and replaying overflow', async () => {
  const payload = twitterPage(['8000000000000000005', '8000000000000000006'])
  payload.unused_metadata = { nul: '\u0000', lone_surrogate: '\ud800' }
  payload.timeline[0].unused_nested = '\u0000'
  const h = await harness({ platform: 'twitter', payload })
  const body = { platform: 'twitter', query: 'safe projection', pageSize: 1, type: 'stable' }
  const first = await h.invokeData(body, 'twitter-safe-projection')
  assert.equal(first.body.data.items[0].id, '8000000000000000005')
  assert.equal(h.calls.length, 1)
  assert.equal(h.platformStore.restrictedResponseArchives.size, 1)
  const second = await h.invokeData({ ...body, cursor: first.body.data.pageInfo.nextCursor }, 'twitter-safe-buffer')
  assert.equal(second.body.data.items[0].id, '8000000000000000006')
  assert.equal(h.calls.length, 1)
  assert.ok(isPostgresSafeJsonValue(first.body))
  assert.ok(isPostgresSafeJsonValue(second.body))
})
