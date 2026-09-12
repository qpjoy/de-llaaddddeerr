// Xianyu's search response is a render tree, not a product list.
//
// The element is a view node; the product's own fields sit at
// `data.item.main`, with most under `exContent` and the detail link one level
// above. Prices arrive as styled text runs because the payload describes how to
// draw a price rather than what it is.
//
// The fixture reproduces the key names of a live response captured on
// 2026-09-12 (values are synthetic), which is what the contract requires before
// a new upstream shape is accepted.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import {
  extractJustOneProductSearchItems,
  normalizeJustOneProductItem,
} from '../../server/contracts/justone.mjs'

const fixture = JSON.parse(readFileSync(
  new URL('../fixtures/justone/xianyu-product-search-v1.success.json', import.meta.url),
  'utf8',
))

test('the item list is found where Xianyu actually puts it', () => {
  const extracted = extractJustOneProductSearchItems(fixture, 'xianyu')
  assert.deepEqual([...extracted.path], ['data', 'resultList'])
  assert.equal(extracted.items.length, 3)
})

test('a render-tree element is projected into a product', () => {
  const [element] = extractJustOneProductSearchItems(fixture, 'xianyu').items
  const item = normalizeJustOneProductItem(element, 'xianyu')

  assert.equal(item.id, '880001')
  assert.equal(item.title, '便携相机 九成新')
  assert.equal(item.marketplace, 'xianyu')
  // The link lives a level above exContent, so a projection that only reached
  // exContent would silently drop it.
  assert.equal(item.url, 'https://www.goofish.com/item?id=880001')
  assert.deepEqual([...item.images], ['https://img.example.invalid/880001.jpg'])
  assert.equal(item.shop.name, '相机小铺')
  assert.equal(item.signals.location, '浙江 杭州')
})

test('a styled price is reduced to its amount', () => {
  const [element] = extractJustOneProductSearchItems(fixture, 'xianyu').items
  const item = normalizeJustOneProductItem(element, 'xianyu')

  // "¥" + "1999" across two styled segments.
  assert.equal(item.pricing.current, '1999')
  assert.equal(item.pricing.original, '2999')
  assert.equal(item.pricing.currency, 'CNY')
})

test('the amount survives however the vendor splits the segments', async () => {
  const { normalizeJustOneProductItem: normalize } = await import('../../server/contracts/justone.mjs')
  const withPrice = (price) => normalize({
    data: { item: { main: { exContent: { itemId: '1', title: 't', price } } } },
  }, 'xianyu').pricing.current

  // Splitting is a rendering decision, so the rule must not depend on it.
  assert.equal(withPrice([{ text: '¥' }, { text: '1999' }]), '1999')
  assert.equal(withPrice([{ text: '1999' }, { text: '.00' }]), '1999.00')
  assert.equal(withPrice([{ text: '¥1999' }, { text: '起' }]), '1999')
  assert.equal(withPrice([{ text: '面议' }]), null, 'a price with no amount stays absent')
  assert.equal(withPrice('¥1999'), '1999', 'a plain string is accepted too')
})

test('a wishlist count is never reported as sales', () => {
  const [element] = extractJustOneProductSearchItems(fixture, 'xianyu').items
  const item = normalizeJustOneProductItem(element, 'xianyu')
  // Xianyu reports "想要" (wants), which is not a sales figure. A number under
  // the wrong name would be worse than no number.
  assert.equal(item.signals.sales, null)
})

test('a non-product node in the list is discarded rather than half-mapped', () => {
  const items = extractJustOneProductSearchItems(fixture, 'xianyu').items
  // The third element is a banner: a view node with no product beneath it.
  assert.equal(normalizeJustOneProductItem(items[2], 'xianyu'), null)
  assert.equal(normalizeJustOneProductItem(items[1], 'xianyu').id, '880002')
})

test('the other marketplaces keep their flat mapping untouched', () => {
  const flat = { itemId: 'tb-1', title: '面霜', price: 99, picUrl: 'https://img.example.invalid/a.jpg' }
  const item = normalizeJustOneProductItem(flat, 'taobao')
  assert.equal(item.id, 'tb-1')
  assert.equal(item.title, '面霜')
  // No projection is declared for taobao, so the element is mapped directly.
  // Scalars are stringified for every marketplace, which is why Xianyu's
  // recovered amount is a string too rather than an inconsistent number.
  assert.equal(item.pricing.current, '99')
})
