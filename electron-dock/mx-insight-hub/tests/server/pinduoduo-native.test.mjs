import test from 'node:test'
import assert from 'node:assert/strict'
import { RapidApiAdapter } from '../../server/adapters/rapidapi.mjs'
import { PINDUODUO_RAPIDAPI_SEARCH_ENDPOINT, isPinduoduoProductSearchPage } from '../../server/contracts/pinduoduo-rapidapi-endpoint.mjs'

const key = PINDUODUO_RAPIDAPI_SEARCH_ENDPOINT.key
const product = { goods_id: 1023414381156, goods_name: '双层玻璃杯加厚大容量高档隔热茶杯杯子男女便携茶水泡茶家用水杯',
  market_price: 1800, default_price: 1498, product_url: 'https://mobile.yangkeduo.com/goods.html?goods_id=1023414381156' }
const page = (items, current = 1) => ({ success: true, code: 0, data: { items, pagination: { current, page_size: 10 } } })

test('Pinduoduo accepts complete cards, short and empty pages matched to the explicit page number', () => {
  assert.ok(isPinduoduoProductSearchPage(page([product]), 1))
  assert.ok(isPinduoduoProductSearchPage(page([{ ...product, goods_id: '9007199254740993' }]), 1))
  assert.ok(isPinduoduoProductSearchPage(page([], 2), 2))
  for (const invalid of [null, { ...page([]), success: false }, { ...page([]), code: 500 },
    { success: true, code: 0, data: {} }, page([null]), page([{ ...product, goods_name: '  ' }]),
    page([{ ...product, goods_id: Number.MAX_SAFE_INTEGER + 1 }]), page([], 2)]) {
    assert.equal(isPinduoduoProductSearchPage(invalid, 1), false)
  }
})

test('normal RapidAPI dispatch sends only declared parameters to Pinduoduo and rejects business errors', async () => {
  const calls = []
  let upstream = page([product])
  const adapter = new RapidApiAdapter({ apiKey: 'synthetic-pinduoduo-key', fetchImpl: async (url, options) => {
    calls.push({ url, options })
    return Response.json(upstream)
  } })
  for (const params of [{}, { keyword: ' ' }, { keyword: '茶杯', page: 0 }, { keyword: '茶杯', page: 1.2 },
    { keyword: '茶杯', host: 'example.com' }]) {
    await assert.rejects(adapter.forwardNative(key, { params }), { status: 400 })
  }
  assert.equal(calls.length, 0)
  const params = { keyword: '茶杯' }
  const delivery = await adapter.forwardNative(key, { params })
  assert.equal(calls.length, 1)
  const [{ url, options }] = calls
  assert.equal(url.origin + url.pathname, 'https://pinduoduo1.p.rapidapi.com/pinduoduo/search')
  assert.deepEqual(Object.fromEntries(url.searchParams), { keyword: params.keyword, page: '1' })
  assert.equal(options.headers['x-rapidapi-host'], url.host)
  assert.equal(options.redirect, 'error')
  assert.equal(delivery.publicBody.endpoint, key)
  assert.deepEqual(delivery.publicBody.data, upstream)
  upstream = { success: false, code: 1, data: null }
  await assert.rejects(adapter.forwardNative(key, { params }), error => error.evidence?.outcome === 'succeeded_unusable')
})
