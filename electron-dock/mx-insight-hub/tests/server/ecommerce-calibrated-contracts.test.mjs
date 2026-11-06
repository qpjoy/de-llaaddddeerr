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
} }], has_more: true, total: 500, extra: { search_id: 'fixture-search' },
  // Same-index 精选联盟 card, field layout of the 2026-11-06 live page (values synthetic).
  summary_promotions: [{ product_id: '3841000000000000001', promotion_id: '3842000000000000002', base_model: {
    product_info: { name: 'Synthetic phone', month_sale: { origin: 310 }, month_sale_text: '月销',
      category: { first_category: { category_id: 1, category_name: '3C数码及配件' }, second_category: { category_id: 2, category_name: '二手手机' },
        third_category: { category_id: 0, category_name: '' }, fourth_category: { category_id: 0, category_name: '' }, leaf_layer: 2 } },
    marketing_info: { price_desc: { price: { origin: 518850, integer: '5,188', decimal: '5', suffix: '' }, price_text: '到手价' } },
    shop_info: { shop_id: 286119112, shop_name: 'Synthetic shop' },
    extend_info: { data_report: { shop_id: '286119112', product_id: '3841000000000000001' } },
  } }] } }
const xhs = { code: 0, message: null, recordTime: null, data: { code: 0, success: true, search_id: 'fixture-xhs-search', page: 1, next_page: 2, data: {
  hierarchy: { common: { load_more: true } }, module: { data: [{ card_type: 'dsl', card_name: 'cosmos_search_goods_card', id: 'render-card-id', content: {
    id: 'fixture-product', title: 'Synthetic product', price_info: { price: 85, origin_price: 90, rds_price: 12.85, symbol: '$', foreign_price: '≈$12.85' },
    link: 'xhsdiscover://goods_detail/fixture-product?searchId=fixture-xhs-search', image: [{ url: 'https://example.invalid/xhs.jpg' }],
    vendor: { seller_id: 'fixture-seller', vendor_id: 'https://example.invalid/avatar.jpg', vendor_name: 'Synthetic shop' },
  } }] },
} } }

test('Douyin produces the same product contract with summary price/shop/sales and serves only its first page', () => {
  const options = { capturedAt, encodeCursor: () => assert.fail('Douyin must not issue a continuation') }
  const result = normalizeJustOneProductSearchPayload(douyin, request({ marketplace: 'douyin_ec', query: '手机' }), options)
  assert.equal(result.items.length, 1)
  const product = result.items[0]
  assert.equal(product.id, douyin.data.promotions[0].product_id)
  assert.equal(product.url, douyin.data.promotions[0].base_info.detail_url)
  assert.equal(product.urlSource, 'upstream')
  assert.deepEqual(product.pricing, { current: '5188.5', original: null, currency: 'CNY' })
  assert.deepEqual(product.shop, { id: '286119112', name: 'Synthetic shop' })
  assert.deepEqual([product.signals.sales, product.attributes.category], ['310', '二手手机'])
  assert.deepEqual(product.images, douyin.data.promotions[0].base_info.main_img.url_list)
  assert.equal(result.records[0].platform, 'ecommerce')
  assert.equal(result.archiveObjects[0].sourceKey, 'source-catalog-0062')
  assert.ok(result.archiveObjects.every(o => o.capturedDate === '2026-10-11'))
  // The item archive keeps the original promotion element; the summary card stays in the call archive.
  assert.deepEqual(result.archiveObjects[1].rawItem, douyin.data.promotions[0])
  // Live page 2 was a billed empty page with or without searchId: no cursor, unknown hasMore.
  assert.deepEqual([result.page.hasMore, result.page.nextCursor], [null, null])
  const issued = { version: 1, adapterId: request({ marketplace: 'douyin_ec', query: '手机' }).adapterId, marketplace: 'douyin_ec',
    page: 2, scope: request({ marketplace: 'douyin_ec', query: '手机' }).cursorScope, continuation: 'fixture-search' }
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', cursor: 'issued-before' }, { decodeCursor: () => issued }), { code: 'pagination_unavailable' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', page: 2 }), { code: 'pagination_unavailable' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', sort: 'sales_desc' }), { code: 'unsupported_sort' })
  assert.throws(() => request({ marketplace: 'douyin_ec', query: '手机', price: { min: '1' } }), { code: 'unsupported_price_filter' })
  const noSession = structuredClone(douyin); delete noSession.data.extra.search_id
  assert.equal(response(noSession, request({ marketplace: 'douyin_ec', query: '手机' }), options).page.nextCursor, null)
  const last = structuredClone(douyin); last.data.has_more = false
  assert.equal(response(last, request({ marketplace: 'douyin_ec', query: '手机' }), options).page.hasMore, false)
})

test('Douyin summary fields are used only for the exact same product and a verified fen price', () => {
  const project = mutate => {
    const raw = structuredClone(douyin); mutate(raw.data.summary_promotions[0], raw); raw.data.has_more = false
    return response(raw, request({ marketplace: 'douyin_ec', query: '手机' }), { capturedAt }).items[0]
  }
  for (const mismatch of [s => { s.product_id = '3841000000000000009' }, s => { s.promotion_id = 'other' },
    (_s, raw) => { raw.data.summary_promotions = [] }, (_s, raw) => { delete raw.data.summary_promotions }]) {
    const item = project(mismatch)
    assert.deepEqual([item.id, item.pricing.current, item.shop.id, item.signals.sales, item.attributes.category],
      ['3841000000000000001', null, null, null, null])
  }
  // Unit or display disagreement leaves the price unknown, never rescaled.
  assert.equal(project(s => { s.base_model.marketing_info.price_desc.price.origin = 5188 }).pricing.current, null)
  assert.equal(project(s => { s.base_model.marketing_info.price_desc.price.origin = 5188.5 }).pricing.current, null)
  assert.equal(project(s => { s.base_model.marketing_info.price_desc.price = { origin: 518800, integer: '5,188', decimal: '' } }).pricing.current, '5188')
  assert.equal(project(s => { s.base_model.marketing_info.price_desc.price = { origin: 518805, integer: '5,188', decimal: '05' } }).pricing.current, '5188.05')
  // An unsafe numeric shop ID is published only through its exact text twin.
  assert.equal(project(s => { s.base_model.shop_info.shop_id = Number('7311111111111111111'); s.base_model.extend_info.data_report.shop_id = '7311111111111111111' }).shop.id, '7311111111111111111')
  assert.equal(project(s => { s.base_model.shop_info.shop_id = Number('7311111111111111111'); delete s.base_model.extend_info }).shop.id, null)
  assert.equal(project(s => { s.base_model.product_info.month_sale.origin = -1 }).signals.sales, null)
  assert.equal(project(s => { s.base_model.product_info.category.third_category.category_name = '折叠屏' }).attributes.category, '折叠屏')
})

test('Douyin rejects lossy or non-identity product IDs without losing the raw item evidence', () => {
  for (const productId of [Number('3841000000000000001'), true, false, 1.5, 0, -1]) {
    const raw = structuredClone(douyin)
    raw.data.promotions[0].product_id = productId
    raw.data.has_more = false
    const result = response(raw, request({ marketplace: 'douyin_ec', query: '手机' }), { capturedAt })
    assert.deepEqual(result.items, [])
    assert.equal(result.page.discardedCount, 1)
    assert.equal(result.archiveObjects[1].normalizedItem, null)
    assert.deepEqual(result.archiveObjects[1].rawItem, raw.data.promotions[0])
  }
  const raw = structuredClone(douyin)
  raw.data.promotions[0].product_id = 12345
  raw.data.has_more = false
  const result = response(raw, request({ marketplace: 'douyin_ec', query: '手机' }), { capturedAt })
  assert.equal(result.items[0].id, '12345')
  assert.equal(result.page.discardedCount, 0)
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
