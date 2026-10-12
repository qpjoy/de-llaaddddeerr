import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeJustOneProductSearchRequest as request, normalizeJustOneProductSearchResponse as response } from '../../server/contracts/justone.mjs'
import { normalizeJustOneProductSearchPayload } from '../../server/ingest/justone.mjs'
import { JustOneAdapter } from '../../server/adapters/justone.mjs'
import { EXTERNAL_PLATFORM_OPERATION_CATALOG, MemoryExternalPlatformControlStore } from '../../server/external-platforms/control-store.mjs'

// Anonymous fixtures preserve only the shapes observed on 2026-10-12. They
// contain no live product IDs, signed links, search sessions or credentials.
const capturedAt = '2026-10-12T00:30:00+08:00'
const douyin = { code: 0, message: null, recordTime: null, data: { promotions: [{ product_id: '3841000000000000001', promotion_id: '3842000000000000002', base_info: {
  title: 'Synthetic phone', price: null, main_img: { url_list: ['https://example.invalid/phone.jpg'] },
  detail_url: 'https://haohuo.jinritemai.com/ecommerce/trade/detail/index.html?id=3841000000000000001&origin_type=2631',
} }], has_more: true, extra: { search_id: 'fixture-search' } } }
const xhs = { code: 0, message: null, recordTime: null, data: { code: 0, success: true, search_id: 'fixture-xhs-search', page: 1, next_page: 2, data: {
  hierarchy: { common: { load_more: true } }, module: { data: [{ card_type: 'dsl', card_name: 'cosmos_search_goods_card', id: 'render-card-id', content: {
    id: 'fixture-product', title: 'Synthetic product', price_info: { price: 85, origin_price: 90, rds_price: 12.85, symbol: '$', foreign_price: '≈$12.85' },
    link: 'xhsdiscover://goods_detail/fixture-product?searchId=fixture-xhs-search', image: [{ url: 'https://example.invalid/xhs.jpg' }],
    vendor: { seller_id: 'fixture-seller', vendor_id: 'https://example.invalid/avatar.jpg', vendor_name: 'Synthetic shop' },
  } }] },
} } }

test('Douyin produces the same product contract, exact IDs/web links and a scoped continuation', () => {
  const states = new Map()
  const options = { capturedAt, encodeCursor: state => { states.set('opaque', state); return 'opaque' } }
  const result = normalizeJustOneProductSearchPayload(douyin, request({ marketplace: 'douyin_ec', query: '手机' }), options)
  assert.equal(result.items.length, 1)
  const product = result.items[0]
  assert.equal(product.id, douyin.data.promotions[0].product_id)
  assert.equal(product.url, douyin.data.promotions[0].base_info.detail_url)
  assert.equal(product.urlSource, 'upstream')
  assert.equal(product.pricing.current, null)
  assert.deepEqual(product.images, douyin.data.promotions[0].base_info.main_img.url_list)
  assert.equal(result.records[0].platform, 'ecommerce')
  assert.equal(result.archiveObjects[0].sourceKey, 'source-catalog-0062')
  assert.ok(result.archiveObjects.every(o => o.capturedDate === '2026-10-11'))
  assert.equal(result.page.hasMore, true)
  assert.equal(result.page.nextCursor, 'opaque')
  const next = request({ marketplace: 'douyin_ec', query: '手机', cursor: 'opaque' }, { decodeCursor: token => states.get(token) })
  assert.deepEqual(next.upstreamQuery, { keyword: '手机', page: '2', searchId: 'fixture-search' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', page: 2 }), { code: 'continuation_required' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', sort: 'sales_desc' }), { code: 'unsupported_sort' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', price: { min: '1' } }), { code: 'unsupported_price_filter' })
  const missing = structuredClone(douyin); delete missing.data.extra.search_id
  assert.throws(() => response(missing, request({ marketplace: 'douyin_ec', query: '手机' }), options), { code: 'missing_upstream_continuation' })
  const last = structuredClone(douyin); last.data.has_more = false
  assert.equal(response(last, next, options).page.nextCursor, null)
})

test('Xiaohongshu render cards retain product/App identity, source price and seller identity', () => {
  let state
  const result = normalizeJustOneProductSearchPayload(xhs, request({ marketplace: 'xiaohongshu_ec', query: '小米' }), {
    capturedAt, encodeCursor: value => { state = value; return 'opaque-xhs' },
  })
  const product = result.items[0]
  assert.equal(product.id, 'fixture-product')
  assert.equal(product.url, null)
  assert.equal(product.urlSource, null)
  assert.equal(product.appUrl, xhs.data.data.module.data[0].content.link)
  assert.deepEqual(product.pricing, { current: '85', original: '90', currency: 'CNY' })
  assert.deepEqual(product.shop, { id: 'fixture-seller', name: 'Synthetic shop' })
  assert.equal(state.continuation, 'fixture-xhs-search')
  assert.equal(result.page.discardedCount, 0)
  assert.deepEqual(result.archiveObjects[1].rawItem, xhs.data.data.module.data[0])
  for (const invalid of [{ code: 1, success: false }, { code: 0, success: false }]) {
    const raw = structuredClone(xhs); Object.assign(raw.data, invalid)
    assert.throws(() => response(raw, request({ marketplace: 'xiaohongshu_ec', query: '小米' })), { code: 'invalid_xiaohongshu_product_response' })
  }
  const unrelated = structuredClone(xhs); unrelated.data.data.module.data[0].card_name = 'ad-banner'; unrelated.data.data.hierarchy.common.load_more = false
  const excluded = response(unrelated, request({ marketplace: 'xiaohongshu_ec', query: '小米' }), { capturedAt })
  assert.equal(excluded.page.returnedCount, 0)
  assert.equal(excluded.page.discardedCount, 1)
})

test('native ecommerce success and rejection carry UTC partition and complete persistence metadata', async () => {
  for (const code of [0, 301]) {
    const adapter = new JustOneAdapter({ token: 'fixture-secret', fetchImpl: async () => Response.json({ code, message: null, recordTime: null, data: xhs.data }) })
    let result
    try { result = await adapter.forwardNative('j.api_615b215c08c1d291', { params: { keyword: '小米' } }, { capturedAt }) }
    catch (error) { assert.equal(code, 301); result = error }
    const archive = result.archiveObjects[0]
    assert.equal(archive.capturedDate, '2026-10-11')
    assert.equal(archive.marketplace, 'xiaohongshu-ec')
    assert.equal(archive.endpointVersion, 'hub-provider-docs.2026-09-27')
    assert.equal(archive.sourceKey, 'native:j.api_615b215c08c1d291')
    assert.match(archive.archivePath, /\/2026-10-11\/responses\/[a-f0-9]{64}\.json$/)
    assert.equal(archive.payloadSha256, archive.rawPayloadSha256)
    assert.equal(result.restrictedResponseArchive.capturedAt.slice(0, 10), archive.capturedDate)
    await adapter.close()
  }
})

test('adding Douyin never blocks a reviewed existing-marketplace price book or fabricates its price', async () => {
  const definition = EXTERNAL_PLATFORM_OPERATION_CATALOG.justone.find(row => row.operationKey === 'ecommerce.products.search')
  assert.ok(!definition.endpointKeys.includes('douyin-ec.product-search.v1'))
  assert.ok(definition.optionalEndpointKeys.includes('douyin-ec.product-search.v1'))
  const store = new MemoryExternalPlatformControlStore()
  const runtime = { config: { configured: true, contractVerified: true, dispatchEnabled: true }, credentialConfigured: true }
  await store.updatePolicy('justone', definition.operationKey, { expectedRevision: 0, desiredState: 'active', reason: 'fixture',
    priceBook: { currency: 'CNY', pricingAsOf: '2026-10-12', monthlyBudgetMinor: 100000, monthlySubsidyBudgetMinor: 100000,
      unitCostMinorByEndpoint: Object.fromEntries(definition.endpointKeys.map(key => [key, 1])) } }, { runtime })
  const rows = await store.describeProvider('justone', runtime)
  const operation = rows.find(row => row.operationKey === definition.operationKey)
  assert.equal(operation.effectiveState, 'active')
  assert.ok(!Number.isSafeInteger(operation.priceBook.endpointPrices['douyin-ec.product-search.v1']))
})
