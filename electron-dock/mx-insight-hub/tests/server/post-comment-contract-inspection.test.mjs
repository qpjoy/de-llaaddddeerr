import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { inspectPostCommentArchive, inspectPostCommentContract, summarizePostCommentPayload } from '../../server/ops/inspect-post-comment-contract.mjs'

const requestId = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
const callId = 'bf456ad4-2523-4f73-a1fc-c95104b329a4'
const archive = payload => {
  const body_bytes = Buffer.from(JSON.stringify(payload))
  return { body_bytes, body_size: body_bytes.length, actual_body_size: body_bytes.length,
    body_sha256: createHash('sha256').update(body_bytes).digest('hex') }
}

test('comment contract inspection returns field structure without scalars or arbitrary property names', () => {
  const payload = { code: 200, data: { comments: [{ id: 'private-platform-id', text: 'private-comment',
    user: { nickname: 'private-author', 'secret-property-name': 'private-secret' }, create_time: 1777777777, like_count: 36 }],
  cursor: 'private-cursor', has_more: true, 'another-private-key': { comments: ['private-hidden'] } } }
  const result = inspectPostCommentArchive(archive(payload)), output = JSON.stringify(result)
  assert.equal(result.state, 'archive_verified'); assert.equal(result.hashVerified, true)
  assert.equal(result.unknownKeys, 2)
  for (const value of ['private', '1777777777', '36']) assert.equal(output.includes(value), false)
  assert.deepEqual(result.fields.find(row => row.path === '$.data.comments[].id').types, { string: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.comments').arrayLength, { min: 1, max: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.cursor').continuation, { nonempty_string: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.has_more').signals, { true: 1 })
})

test('all raw byte parsing requires matching size and SHA and remains bounded', () => {
  const row = archive({ data: { comments: [] } })
  for (const changed of [{ body_size: row.body_size + 1 }, { actual_body_size: row.body_size + 1 }, { body_sha256: '0'.repeat(64) }]) {
    assert.equal(inspectPostCommentArchive({ ...row, ...changed }).state, 'archive_integrity_failed')
  }
  assert.equal(inspectPostCommentArchive({ ...row, body_size: 4194305 }).state, 'archive_too_large')
  assert.equal(inspectPostCommentArchive(null).state, 'archive_missing')
  const invalid = Buffer.from('<html>private-secret</html>')
  assert.deepEqual(inspectPostCommentArchive({ body_bytes: invalid, body_size: invalid.length, actual_body_size: invalid.length,
    body_sha256: createHash('sha256').update(invalid).digest('hex') }), { state: 'archive_not_json', hashVerified: true, byteLength: invalid.length })
  const deep = { data: {} }; let cursor = deep.data
  for (let index = 0; index < 30; index++) cursor = cursor.data = {}
  assert.equal(summarizePostCommentPayload(deep).truncated, true)
  const sampled = summarizePostCommentPayload({ comments: Array.from({ length: 25 }, (_, index) => ({ id: String(index) })) })
  assert.equal(sampled.sampledArrays, 1)
  assert.equal(sampled.fields.find(row => row.path === '$.comments[].id').observations, 3)
  assert.equal(summarizePostCommentPayload(Object.fromEntries(Array.from({ length: 3000 }, (_, i) => [`unknown-${i}`, 'x']))).truncated, true)
})

test('inspection binds calls and raw archives to one request, caps rows, and never mutates state', async () => {
  const queries = []; let released = false
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes('post-comment-contract:usage')) return { rows: [{ platform: 'twitter', status: 'committed', response_status: 200 }] }
    if (sql.includes('post-comment-contract:calls')) return { rows: Array.from({ length: 4 }, () => ({ id: callId,
      provider_key: 'tikhub', marketplace: 'twitter', endpoint_key: 'native.t.api_3cd88a6621a01120', outcome: 'succeeded', http_status: 200, billed: true })) }
    if (sql.includes('post-comment-contract:archive')) return { rows: [archive({ data: { comments: [] } })] }
    return { rows: [] }
  }, release() { released = true } }
  const result = await inspectPostCommentContract({ connect: async () => client }, requestId)
  assert.equal(result.calls.length, 3); assert.equal(result.callsTruncated, true)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.calls[0].archive.state, 'archive_verified')
  assert.match(queries[0].sql, /READ ONLY/)
  const rawQueries = queries.filter(row => row.sql.includes('post-comment-contract:archive'))
  assert.equal(rawQueries.length, 3)
  for (const row of rawQueries) {
    assert.deepEqual(row.values, [requestId, callId, 4194304])
    assert.match(row.sql, /CASE WHEN r.body_size <= \$3::integer AND octet_length\(r.body_bytes\) <= \$3::integer/)
    assert.match(row.sql, /c.usage_request_id=\$1::uuid AND c.id=\$2::uuid/)
  }
  assert.equal(queries.at(-1).sql, 'ROLLBACK'); assert.equal(released, true)
})

test('unknown endpoints and provider mismatches never read raw archives', async () => {
  const client = { async query(sql) {
    if (sql.includes(':usage')) return { rows: [{ platform: 'private-platform', status: 'private-status' }] }
    if (sql.includes(':calls')) return { rows: [{ id: callId, endpoint_key: 'private-endpoint', provider_key: 'private-provider', marketplace: 'private-marketplace', outcome: 'private-outcome' },
      { id: callId, endpoint_key: 'native.t.api_3cd88a6621a01120', provider_key: 'justone', marketplace: 'twitter' }] }
    if (sql.includes(':archive')) throw new Error('must not read raw bytes')
    return { rows: [] }
  }, release() {} }
  const result = await inspectPostCommentContract({ connect: async () => client }, requestId)
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(result.calls.every(row => row.archive.state === 'unrecognized_comment_endpoint'), true)
})

test('legacy requests with no supplier rows are not mistaken for an empty comment response', async () => {
  const client = { async query(sql) { return { rows: sql.includes(':usage') ? [{ platform: 'twitter', status: 'released', response_status: 404 }] : [] } }, release() {} }
  const result = await inspectPostCommentContract({ connect: async () => client }, requestId)
  assert.deepEqual(result.calls, []); assert.equal(result.nativeCallEvidencePresent, false)
  assert.match(result.boundary, /Missing rows do not prove absence/)
  await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, 'not-a-uuid'), /invalid_request_id/)
})
