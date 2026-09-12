import test from 'node:test'
import assert from 'node:assert/strict'
import { ecommerceFeedExample } from '../../server/examples/ecommerce-feed.mjs'

test('published feed example separates history, display queue and paid continuation', async () => {
  const calls = [], rendered = []
  let number = 0
  const fetch = async (url, options) => {
    calls.push({ url, options })
    if (options.method !== 'POST') return { ok: true, json: async () => ({ data: { items: [], pageInfo: { nextCursor: null } } }) }
    number++
    return { ok: true, json: async () => ({ requestId: `request-${number}`, meta: { capturedAt: '2026-01-01T00:00:00Z' }, data: {
      items: Array.from({ length: 12 }, (_, index) => ({ id: index })), page: { page: number, nextCursor: `cursor-${number}`, hasMore: true },
    } }) }
  }
  const create = new Function('fetch', ecommerceFeedExample + '; return createEcommerceFeed')(fetch)
  const feed = create('https://hub.example', 'test-key', (rows, edge) => rendered.push({ rows, edge }))
  await feed.reset({ marketplace: 'taobao', query: '相机', minPrice: '10', sort: 'price_asc' })
  assert.match(calls[0].url, /pageSize=10/)
  await feed.pull(); await feed.pull()
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 1)
  assert.deepEqual(rendered.slice(-2).map(item => [item.edge, item.rows.length]), [['top',10],['top',2]])
  await feed.pull()
  const posts = calls.filter(call => call.options.method === 'POST')
  const body = JSON.parse(posts[1].options.body)
  assert.equal(body.cursor, 'cursor-1'); assert.equal(body.sort, 'price_asc'); assert.equal(body.price.min, '10')
  assert.notEqual(posts[0].options.headers['Idempotency-Key'], posts[1].options.headers['Idempotency-Key'])
  await feed.reset({ marketplace: 'all' }); await assert.rejects(feed.pull(), /Choose one marketplace/)
})
