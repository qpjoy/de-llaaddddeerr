import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import {
  diagnoseEcommerceProductLinks,
  inspectEcommerceProductLinks,
} from '../../server/ops/diagnose-ecommerce-product-links.mjs'

function archive(raw) {
  const body_bytes = Buffer.from(JSON.stringify(raw))
  return { body_bytes, body_sha256: createHash('sha256').update(body_bytes).digest('hex') }
}
const success = { code: 0, message: null, recordTime: null, data: { items: [
  { itemId: '880001', title: 'restricted-product-data' },
  { itemId: '880002', itemUrl: 'https://example.invalid/?token=restricted-business-value' },
  { itemId: 'opaque' },
  { title: 'not-a-product' },
] } }

test('offline link diagnostics report counts without source data and do not mutate archives', () => {
  const input = archive(success)
  const before = Buffer.from(input.body_bytes)
  const report = inspectEcommerceProductLinks(input, 'taobao')
  assert.deepEqual(report, { state: 'projected', itemCount: 4, productCount: 3,
    discardedCount: 1, urlCount: 2, upstreamUrlCount: 1, derivedUrlCount: 1, missingUrlCount: 1 })
  assert.doesNotMatch(JSON.stringify(report), /88000|restricted|example.invalid/u)
  assert.deepEqual(input.body_bytes, before)
})

test('offline diagnostics distinguish a JD collection failure from a successful empty page', () => {
  assert.deepEqual(inspectEcommerceProductLinks(archive({ code: 301, message: 'private-message',
    recordTime: null, data: null }), 'jd'), { state: 'upstream_rejected', businessCode: 301 })
  const empty = inspectEcommerceProductLinks(archive({ ...success, data: { products: [] } }), 'jd')
  assert.equal(empty.state, 'projected')
  assert.equal(empty.productCount, 0)
})

test('untrusted, missing or incompatible archives are never reported as verified', () => {
  assert.equal(inspectEcommerceProductLinks(null, 'jd').state, 'archive_missing_or_oversized')
  assert.equal(inspectEcommerceProductLinks({ ...archive(success), body_sha256: 'wrong' }, 'jd').state, 'archive_integrity_failed')
  assert.equal(inspectEcommerceProductLinks(archive('not an envelope'), 'jd').state, 'invalid_envelope')
  assert.equal(inspectEcommerceProductLinks(archive(success), 'unknown').state, 'unsupported_marketplace')
  assert.equal(inspectEcommerceProductLinks(archive({ ...success, data: {} }), 'jd').state, 'unrecognized_item_list')
  assert.equal(inspectEcommerceProductLinks(archive({ ...success,
    data: { items: Array(101).fill({ itemId: '1' }) } }), 'jd').state, 'item_limit_exceeded')
})

test('diagnostic database access is bounded and read-only, including cleanup on failure', async () => {
  const id = '87977322-77d9-4251-8171-31e88213c868'
  const queries = []
  let fail = false
  const client = { async query(sql, params) {
    queries.push({ sql, params })
    if (sql.startsWith('SELECT')) {
      if (fail) throw new Error('private-database-message')
      return { rows: [{ marketplace: 'taobao', ...archive(success) }] }
    }
    return { rows: [] }
  } }
  const report = await diagnoseEcommerceProductLinks(client, [id])
  assert.match(queries[0].sql, /READ ONLY$/u)
  const select = queries.find(query => query.sql.startsWith('SELECT'))
  assert.deepEqual(select.params, [id])
  assert.match(select.sql, /body_size <= 8388608/u)
  assert.match(select.sql, /LIMIT 2$/u)
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  assert.equal(report.mode, 'offline_read_only')
  assert.equal(report.results[0].projection.derivedUrlCount, 1)
  await assert.rejects(() => diagnoseEcommerceProductLinks(client, ['invalid']), /invalid_request_ids/u)
  fail = true
  await assert.rejects(() => diagnoseEcommerceProductLinks(client, [id]), /private-database-message/u)
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
})
