import test from 'node:test'
import assert from 'node:assert/strict'
import { PRODUCT_ACCESS, productAllowed } from '../../shared/product-access.mjs'
import { aggregateSourceCatalog } from '../../server/data/aggregate-search.mjs'
import { NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS } from '../../server/contracts/night-all-legacy.mjs'

const search = '/data-products/search'
const news = '/data-products/news'
const scopes = platforms => [{ platforms, capabilities: [] }]

test('search and news participate in the same menu and direct-route authorization gate', () => {
  for (const path of [search, news]) {
    assert.ok(PRODUCT_ACCESS[path])
    assert.equal(productAllowed(path), false)
    assert.equal(productAllowed(path, [{ platforms: ['ip_risk'], capabilities: ['ip.risk.query'] }]), false)
    for (const platform of ['source_catalog', 'enterprise', 'topic_reports', 'virtual_supermarket', 'unknown']) {
      assert.equal(productAllowed(path, scopes([platform])), false)
    }
  }
  assert.equal(productAllowed('/data-products/ip-risk', [{ platforms: ['ip_risk'], capabilities: ['ip.risk.query'] }]), true)
})

test('stored-search users keep access without invented live-operation requirements', () => {
  for (const platform of [...NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw,
    'telegram', 'public_opinion', 'ecommerce', 'social', 'mobile_commerce']) {
    assert.ok(aggregateSourceCatalog([platform], []).length)
    assert.equal(productAllowed(search, scopes([platform])), true, platform)
    assert.equal(productAllowed(news, scopes([platform])), false, platform)
  }
})

test('saved-record categories grant both products, including future category names', () => {
  for (const platform of ['data_center_saved_records_news', 'data_center_saved_records_finance', 'data_center_saved_records_new_category']) {
    assert.equal(productAllowed(search, scopes([platform])), true)
    assert.equal(productAllowed(news, scopes([platform])), true)
  }
  for (const platform of ['data_center_saved_records_', 'data_center_saved_records', 'data_center_saved_records_*']) {
    assert.equal(productAllowed(news, scopes([platform])), false)
  }
})
