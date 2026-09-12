// Diagnosing an upstream response shape the contract does not accept yet.
//
// The accepted item paths are deliberately a closed set: "a new upstream shape
// must arrive with a reviewed fixture and an explicit addition here". That
// policy is only followable if the shape can actually be seen -- and the
// response body of an unusable call is never archived. So the failure carries a
// keys-and-types outline for the dispatcher to log.
//
// Values must never appear in it: on some marketplaces they are product data,
// and the question being answered ("where does the item array live") is purely
// structural.

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  describeResponseShape,
  extractJustOneProductSearchItems,
} from '../../server/contracts/justone.mjs'

test('the outline reports structure and never values', () => {
  const shape = describeResponseShape({
    code: 0,
    message: null,
    recordTime: null,
    data: {
      model: { itemList: [{ itemId: '123456', title: '便携相机', price: 1999 }] },
      page: { pageNo: 1, totalPages: 7 },
    },
  })

  assert.equal(shape.code, 'number')
  assert.equal(shape.data.model.itemList.__array, 1)
  assert.equal(shape.data.model.itemList.__item.itemId, 'string')
  assert.equal(shape.data.page.pageNo, 'number')

  const serialized = JSON.stringify(shape)
  for (const value of ['123456', '便携相机', '1999']) {
    assert.doesNotMatch(serialized, new RegExp(value, 'u'), `no value leaks: ${value}`)
  }
})

test('an empty array reports its emptiness rather than inventing an item', () => {
  const shape = describeResponseShape({ data: { items: [] } })
  assert.equal(shape.data.items.__array, 0)
  assert.equal(shape.data.items.__item, null)
})

test('the outline is bounded in depth and width', () => {
  let deep = 'leaf'
  for (let level = 0; level < 12; level += 1) deep = { nested: deep }
  // Depth stops rather than walking an arbitrarily nested payload.
  assert.equal(JSON.stringify(describeResponseShape(deep)).includes('"leaf"'), false)

  const wide = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, index]))
  assert.ok(Object.keys(describeResponseShape(wide)).length <= 40, 'width is capped')
})

test('an unaccepted shape names both what was tried and what arrived', () => {
  // A successful envelope whose items sit somewhere the contract does not
  // declare -- exactly the case that produced invalid_upstream_items in
  // production for one marketplace.
  const raw = { code: 0, message: null, recordTime: null, data: { model: { itemList: [{ itemId: '1' }] } } }

  assert.throws(
    () => extractJustOneProductSearchItems(raw, 'xianyu'),
    (error) => {
      assert.equal(error.code, 'invalid_upstream_items')
      // What the contract looked for, so the gap is obvious at a glance.
      assert.deepEqual(error.triedPaths, ['data.resultList'])
      // And where the array actually was.
      assert.equal(error.observedShape.data.model.itemList.__array, 1)
      return true
    },
  )
})

test('an accepted shape still extracts without any diagnostic', () => {
  const raw = { code: 0, message: null, recordTime: null, data: { items: [{ itemId: '1' }, { itemId: '2' }] } }
  const extracted = extractJustOneProductSearchItems(raw, 'taobao')
  assert.equal(extracted.items.length, 2)
  assert.deepEqual([...extracted.path], ['data', 'items'])
})

// The outline is only useful if it actually reaches the log when a real
// dispatch hits an unaccepted shape. This drives the adapter end to end.
test('the adapter reports the shape when an upstream response cannot be normalized', async () => {
  const { JustOneAdapter, JustOneSucceededUnusableError } = await import('../../server/adapters/justone.mjs')
  const warnings = []
  const adapter = new JustOneAdapter({
    token: 'token-value',
    logger: { warn: (line) => warnings.push(line) },
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0,
      message: null,
      recordTime: '2026-09-12T00:00:00Z',
      requestId: 'request-1',
      // A successful envelope whose items are somewhere this marketplace does
      // not declare.
      data: { model: { itemList: [{ itemId: 'xy-1', title: '相机' }] } },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })

  await assert.rejects(
    () => adapter.searchProducts({ marketplace: 'xianyu', query: '便携相机' }, {
      capturedAt: '2026-09-12T00:00:00Z',
    }),
    (error) => error instanceof JustOneSucceededUnusableError,
  )

  assert.equal(warnings.length, 1, 'exactly one diagnostic, on the failure path only')
  const line = warnings[0]

  // One line: this gets grepped out of a pod log, and a payload split across
  // lines by a pretty-printer cannot be extracted with grep.
  assert.equal(typeof line, 'string')
  assert.equal(line.split('\n').length, 1, 'the diagnostic is a single line')
  // And complete: console's inspector renders nested objects as "[Object]"
  // beyond depth 2, which would hide exactly the nesting being reported.
  assert.doesNotMatch(line, /\[Object\]/u)

  const reported = JSON.parse(line.slice(line.indexOf('{')))
  assert.equal(reported.marketplace, 'xianyu')
  assert.equal(reported.errorCode, 'invalid_upstream_items')
  assert.deepEqual(reported.triedPaths, ['data.resultList'])
  // The whole point: the path where the array actually sits is legible.
  assert.equal(reported.observedShape.data.model.itemList.__array, 1)
  assert.equal(reported.observedShape.data.model.itemList.__item.itemId, 'string')
  // Item values are product data and never belong in a log line.
  assert.doesNotMatch(line, /相机|xy-1/u)
})

test('a normal dispatch logs nothing', async () => {
  const { JustOneAdapter } = await import('../../server/adapters/justone.mjs')
  const warnings = []
  const adapter = new JustOneAdapter({
    token: 'token-value',
    logger: { warn: () => warnings.push(1) },
    fetchImpl: async () => new Response(JSON.stringify({
      code: 0,
      message: null,
      recordTime: '2026-09-12T00:00:00Z',
      requestId: 'request-1',
      data: {
        resultList: [{
          data: { item: { main: { targetUrl: 'https://example.invalid/1', exContent: { itemId: 'xy-1', title: '相机' } } } },
        }],
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } }),
  })

  await adapter.searchProducts({ marketplace: 'xianyu', query: '便携相机' }, {
    capturedAt: '2026-09-12T00:00:00Z',
  })
  assert.deepEqual(warnings, [], 'the diagnostic is not noise on the happy path')
})
