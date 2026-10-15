import test from 'node:test'
import assert from 'node:assert/strict'
import { verifiedPriceSources, ratesByCustomerMeter } from '../../server/commercial/verified-price-sources.mjs'
import { NATIVE_FORWARDING_ENDPOINTS } from '../../server/contracts/native-forwarding.mjs'
import { QIXIN_OFFICIAL_PRICES } from '../../shared/qixin-official-prices.mjs'

test('official snapshot retains raw evidence and decimal subminor prices without claiming account charges', () => {
  const { rates, sources } = verifiedPriceSources()
  const source = sources.find(row => row.provider === 'tikhub')
  assert.equal(source.catalogRows, 1464)
  assert.equal(source.sourceHash, 'fb585f37c0b08af68cd06020faac186a1ab04d3eb1711bbb27150f8dbfffeb10')
  assert.equal(source.observedAt, '2026-10-14T12:43:15.198629+00:00')
  assert.equal(source.actualChargeVerified, false)
  const rate = rates.find(row => row.endpointKey === 'native.t.api_0097034b91a9ba38')
  assert.equal(rate.unitPrice, '0.001')
  assert.equal(rate.currency, 'USD')
  assert.equal(rate.flags.allowDiscount, true)
  assert.equal(rate.flags.allowFreeCredit, true)
  assert.equal(rate.flags.providerPath, '/api/v1/pipixia/app/fetch_post_detail')
  assert.match(rate.flags.snapshotHash, /^[a-f0-9]{64}$/)
})

test('TikHub procurement maps reviewed native, social, XHS and optional endpoints by upstream path', () => {
  const { rates } = verifiedPriceSources()
  const byEndpoint = new Map(rates.filter(row => row.provider === 'tikhub').map(row => [row.endpointKey, row]))
  assert.equal(byEndpoint.size, rates.filter(row => row.provider === 'tikhub').length)
  for (const row of NATIVE_FORWARDING_ENDPOINTS.filter(row => row.provider === 'tikhub')) {
    const rate = byEndpoint.get(row.endpointKey)
    if (rate) assert.equal(rate.flags.providerPath, row.path)
  }
  assert.equal(byEndpoint.get('weibo.account-search.v1').unitPrice, '0.001')
  assert.equal(byEndpoint.get('xiaohongshu.app-v2.search-notes.v1').flags.providerPath, '/api/v1/xiaohongshu/app_v2/search_notes')
  assert.equal(byEndpoint.get('xiaohongshu.pgy.blogger-notes.v2').unitPrice, '0.02')
})

test('Qixin keeps dated price provenance, exact cents, free entries and negotiated exclusions', () => {
  const { rates, sources, excluded } = verifiedPriceSources()
  const priced = rates.filter(row => row.provider === 'qixin')
  assert.equal(priced.length, 260)
  assert.equal(priced.filter(row => row.unitPrice === '0.00').length, 5)
  assert.equal(excluded.filter(row => row.provider === 'qixin' && row.reason === 'negotiated_price_unavailable').length, 14)
  const source = sources.find(row => row.provider === 'qixin')
  assert.equal(source.observedAt, QIXIN_OFFICIAL_PRICES.observedAt)
  assert.equal(source.refreshStatus, 'latest_refresh_http_405')
  assert.deepEqual(source.pagesSha256, QIXIN_OFFICIAL_PRICES.pagesSha256)
  for (const rate of priced) {
    const original = QIXIN_OFFICIAL_PRICES.entries.find(row => `enterprise.${row.apiId}` === rate.endpointKey)
    assert.equal(BigInt(rate.unitPrice.replace('.', '')), BigInt(original.unitPriceMinor))
  }
})

test('missing source prices remain excluded rather than inheriting old guessed defaults', () => {
  const { rates, excluded } = verifiedPriceSources()
  assert.equal(rates.some(row => row.provider === 'justone'), false)
  assert.equal(rates.some(row => row.endpointKey === 'native.t.api_37b3bbbdb7234c59'), false)
  assert.ok(excluded.some(row => row.provider === 'justone' && row.reason === 'explicit_endpoint_price_evidence_missing'))
  assert.ok(excluded.some(row => row.provider === 'rapidapi'))
})

test('customer candidates retain original currency and precision but exclude composite/shared meters', () => {
  const { rates } = verifiedPriceSources()
  const { ratesByMeter, skipped } = ratesByCustomerMeter(rates)
  assert.equal(ratesByMeter['native.t.api_0097034b91a9ba38'].unitPrice, '0.001')
  assert.equal(ratesByMeter['native.t.api_0097034b91a9ba38'].currency, 'USD')
  assert.equal(ratesByMeter['enterprise.api.2.3'].unitPrice, '0.00')
  for (const meter of ['social.accounts.search', 'social.posts.analytics', 'social.users.resolve', 'social.users.posts', 'social.posts.search']) {
    assert.equal(Object.hasOwn(ratesByMeter, meter), false)
    assert.ok(skipped.some(row => row.meterKey === meter))
  }
  assert.equal(skipped.find(row => row.meterKey === 'social.accounts.search').reason, 'shared_meter_multiple_provider_contracts')
  assert.equal(skipped.find(row => row.meterKey === 'social.posts.analytics').reason, 'multiple_or_optional_upstream_endpoints')
})

test('customer mapping rejects duplicate rate evidence and cannot price a shared meter from one available provider', () => {
  const { rates } = verifiedPriceSources()
  assert.throws(() => ratesByCustomerMeter([rates[0], rates[0]]), /Duplicate verified endpoint rate/)
  const available = rates.filter(row => row.endpointKey === 'weibo.account-search.v1')
  const result = ratesByCustomerMeter(available)
  assert.deepEqual(result.ratesByMeter, {})
  assert.equal(result.skipped[0].reason, 'shared_meter_multiple_provider_contracts')
  assert.deepEqual(ratesByCustomerMeter([]), { ratesByMeter: {}, skipped: [] })
})
