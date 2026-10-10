import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  normalizeJustOneProductItem,
  normalizeJustOneProductSearchRequest,
} from '../../server/contracts/justone.mjs'
import { normalizeJustOneProductSearchPayload } from '../../server/ingest/justone.mjs'

const webUrls = {
  taobao: 'https://item.taobao.com/item.htm?id=880001',
  tmall: 'https://detail.tmall.com/item.htm?id=880001',
  jd: 'https://item.jd.com/880001.html',
  xianyu: 'https://www.goofish.com/item?id=880001',
}

function product(marketplace, id = '880001', url = undefined) {
  const item = { itemId: id, title: 'Synthetic product' }
  return marketplace === 'xianyu'
    ? { data: { item: { main: { targetUrl: url, exContent: item } } } }
    : { ...item, itemUrl: url }
}

test('known marketplaces derive a labelled web link from an exact numeric product ID', () => {
  for (const [marketplace, url] of Object.entries(webUrls)) {
    for (const id of ['880001', 880001]) {
      const raw = product(marketplace, id)
      const before = structuredClone(raw)
      const item = normalizeJustOneProductItem(raw, marketplace)
      assert.equal(item.url, url)
      assert.equal(item.urlSource, 'derived_from_id')
      assert.deepEqual(raw, before, 'derived URLs must not be written into source evidence')
    }
  }
})

test('source web links retain their exact signed business URL and take priority over derivation', () => {
  const url = 'https://example.invalid/product?token=business-token&signature=signed%2Fvalue#variant=2'
  for (const marketplace of Object.keys(webUrls)) {
    const item = normalizeJustOneProductItem(product(marketplace, '880001', url), marketplace)
    assert.equal(item.url, url)
    assert.equal(item.urlSource, 'upstream')
  }
})

test('Xianyu app links produce a labelled web URL without replacing the archived app link', () => {
  // Protocol/field nesting verified from the 2026-10-11 production archive;
  // host, ID and tracking values are synthetic, not a copied source URL.
  const appUrl = 'fleamarket://item_detail?itemId=880001&spm=synthetic'
  const raw = { code: 0, message: null, recordTime: null,
    data: { resultList: [product('xianyu', '880001', appUrl)] } }
  const result = normalizeJustOneProductSearchPayload(raw,
    normalizeJustOneProductSearchRequest({ marketplace: 'xianyu', query: '相机' }),
    { capturedAt: '2026-10-10T16:23:24Z' })
  assert.equal(result.items[0].url, webUrls.xianyu)
  assert.equal(result.items[0].urlSource, 'derived_from_id')
  assert.equal(result.records[0].url, webUrls.xianyu)
  assert.equal(result.records[0].stableFields.commerce.product.urlSource, 'derived_from_id')
  assert.equal(result.archiveObjects[1].rawItem.data.item.main.targetUrl, appUrl)
  assert.equal(result.records[0].extensions.sourceItem.data.item.main.targetUrl, appUrl)
  assert.equal(result.page.returnedCount, 1)
  assert.equal(result.page.discardedCount, 0)
})

test('unverified or lossy IDs never produce a fabricated product link', () => {
  for (const marketplace of Object.keys(webUrls)) {
    for (const id of ['sku-1', '１２３４', ' 880001 ', '001', '0', '-1', '1.2', '1e5',
      '1?other=2', '1/2', '9'.repeat(33), Number.MAX_SAFE_INTEGER + 1, -1, 1.2, true]) {
      const item = normalizeJustOneProductItem(product(marketplace, id), marketplace)
      assert.equal(item.url, null, `${marketplace}: ${id}`)
      assert.equal(item.urlSource, null)
    }
  }
  const unsupported = normalizeJustOneProductItem(product('xiaohongshu_ec'), 'xiaohongshu_ec')
  assert.equal(unsupported.url, null)
  assert.equal(unsupported.urlSource, null)
})

test('fallback follows the selected ID field, never a different alias, title or app-link parameter', () => {
  const item = normalizeJustOneProductItem({ skuId: 'opaque-id', itemId: '880001' }, 'jd')
  assert.equal(item.url, null)
  const raw = product('xianyu', '880001', 'fleamarket://item_detail?itemId=999999')
  assert.equal(normalizeJustOneProductItem(raw, 'xianyu').url, webUrls.xianyu)
  assert.equal(normalizeJustOneProductItem({ title: '880001' }, 'taobao'), null)
})
