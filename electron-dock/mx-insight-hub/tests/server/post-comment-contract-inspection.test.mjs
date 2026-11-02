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

test('unknown containers expose comment structure through anonymous aliases without values or original names', () => {
  const result = summarizePostCommentPayload({ data: {
    privateContainer: { comments: [{ id: 'private-comment-id', text: 'private-comment-body',
      privateMap: { author: { name: 'private-author-name' } } }] },
    '[unknown1]': { comments: [] },
  } })
  const output = JSON.stringify(result)
  for (const value of ['privateContainer', 'privateMap', 'private-comment', 'private-author']) {
    assert.equal(output.includes(value), false)
  }
  const hiddenLists = result.fields.filter(row => /^\$\.data\[unknown\d+\]\.comments$/u.test(row.path))
  assert.equal(hiddenLists.length, 2)
  assert.notEqual(hiddenLists[0].path, hiddenLists[1].path)
  assert.deepEqual(hiddenLists.map(row => row.arrayLength), [{ min: 1, max: 1 }, { min: 0, max: 0 }])
  assert.deepEqual(result.fields.find(row => /\.comments\[\]\.id$/u.test(row.path)).types, { string: 1 })
  assert.ok(result.fields.some(row => /\.comments\[\]\[unknown\d+\]\.author\.name$/u.test(row.path)))
  assert.equal(result.observedArrays, 2)
  assert.equal(result.sampledArrays, 0)
  assert.equal(result.truncated, false)
})

test('unknown subtree sampling reports arrays and respects traversal depth and node bounds', () => {
  const sampled = summarizePostCommentPayload({ hiddenContainer: {
    hiddenList: Array.from({ length: 20 }, () => ({ comments: [] })),
  } })
  assert.equal(sampled.observedArrays, 4)
  assert.equal(sampled.sampledArrays, 1)
  assert.equal(sampled.fields.find(row => row.path === '$[unknown1][unknown2]').arrayLength.max, 20)
  assert.equal(sampled.fields.find(row => row.path === '$[unknown1][unknown2][].comments').observations, 3)
  const deep = {}; let current = deep
  for (let index = 0; index < 30; index++) current = current.hiddenContainer = {}
  current.comments = [{ text: 'unvisited-private-text' }]
  const deepResult = summarizePostCommentPayload(deep)
  assert.equal(deepResult.truncated, true)
  assert.equal(deepResult.fields.some(row => row.path.endsWith('.comments')), false)
  const wide = summarizePostCommentPayload({ hiddenContainer: Object.fromEntries(
    Array.from({ length: 3000 }, (_, index) => [`private-field-${index}`, { comments: [] }])) })
  assert.equal(wide.truncated, true)
  assert.ok(wide.fields.length <= 2048)
  assert.equal(JSON.stringify(wide).includes('private-field'), false)
})

const twitterPostId = '2117082385997250767'
const twitterTweet = (overrides = {}) => ({ id: twitterPostId, text: 'private-root-body',
  author: { rest_id: 'private-author-id', name: 'private-author-name' }, ...overrides })

test('Twitter ID comparisons preserve 64-bit strings and do not mistake rounded numbers for matches', () => {
  const result = inspectPostCommentArchive(archive({ data: twitterTweet({
    conversation_id: twitterPostId, replies: 1,
    comments: [
      { id: '2117082385997250768', in_reply_to_status_id_str: twitterPostId },
      { id: Number(twitterPostId), in_reply_to_status_id_str: null },
      { id: {}, in_reply_to_status_id_str: 'another-private-id' },
    ],
  }) }), { twitterPostId })
  assert.equal(result.twitterShape.rootIdRelation, 'same')
  assert.equal(result.twitterShape.conversationIdRelation, 'same')
  assert.equal(result.twitterShape.repliesCountState, 'positive')
  assert.deepEqual(result.fields.find(row => row.path === '$.data.comments[].id').requestedPostRelation,
    { different: 1, unsafe_number: 1, not_an_id: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.comments[].in_reply_to_status_id_str').requestedPostRelation,
    { same: 1, null: 1, different: 1 })
  const output = JSON.stringify(result)
  for (const value of [twitterPostId, '2117082385997250768', String(Number(twitterPostId)), 'private-root-body', 'private-author']) {
    assert.equal(output.includes(value), false)
  }
  const roundedRoot = summarizePostCommentPayload({ data: twitterTweet({ id: Number(twitterPostId), replies: 0 }) }, { twitterPostId })
  assert.equal(roundedRoot.twitterShape.rootIdRelation, 'unsafe_number')
  assert.equal(roundedRoot.twitterShape.conversationIdRelation, 'missing')
  assert.equal(roundedRoot.twitterShape.repliesCountState, 'zero')
  assert.equal(summarizePostCommentPayload({ data: twitterTweet({ id: 123 }) }, { twitterPostId: '123' }).twitterShape.rootIdRelation, 'same')
  for (const invalid of [Number(twitterPostId), '', '1e20', '-1', '1'.repeat(31)]) {
    assert.throws(() => summarizePostCommentPayload({ data: twitterTweet() }, { twitterPostId: invalid }), /invalid_twitter_post_id/)
  }
})

test('explicit Twitter schema names are limited to recognized direct data fields and identifier-shaped names', () => {
  const payload = { privateEnvelopeName: 'private-envelope-value', data: twitterTweet({
    replyThreads: [{ nestedPrivateMap: { comments: [{ id: 'private-reply-id', text: 'private-reply-text' }] } }],
    'not-an-identifier': { text: 'private-invalid-name-value' },
    'https://private.example/id': 'private-url-value',
    ['a'.repeat(65)]: null,
  }) }
  const ordinary = summarizePostCommentPayload(payload)
  assert.equal(ordinary.twitterShape, undefined)
  assert.equal(JSON.stringify(ordinary).includes('replyThreads'), false)
  const explicit = summarizePostCommentPayload(payload, { twitterPostId })
  assert.equal(explicit.twitterShape.envelopeState, 'tweet_object')
  assert.deepEqual(explicit.twitterShape.unlistedEnvelopeKeys.map(row => row.name), ['replyThreads', '[redacted]', '[redacted]', '[redacted]'])
  const listPath = explicit.twitterShape.unlistedEnvelopeKeys[0].path
  assert.deepEqual(explicit.fields.find(row => row.path === listPath).arrayLength, { min: 1, max: 1 })
  const output = JSON.stringify(explicit)
  for (const value of ['privateEnvelopeName', 'nestedPrivateMap', 'not-an-identifier', 'https://private.example', 'a'.repeat(65), 'private-reply']) {
    assert.equal(output.includes(value), false)
  }
  for (const unrecognized of [{ replyThreads: [] }, { id: twitterPostId, text: 'private-text', author: [] }]) {
    const result = summarizePostCommentPayload({ data: unrecognized }, { twitterPostId })
    assert.equal(result.twitterShape.envelopeState, 'unrecognized')
    assert.deepEqual(result.twitterShape.unlistedEnvelopeKeys, [])
  }
  const wide = summarizePostCommentPayload({ data: twitterTweet(Object.fromEntries(
    Array.from({ length: 3000 }, (_, index) => [`extraField${index}`, null]))) }, { twitterPostId })
  assert.equal(wide.truncated, true)
  assert.ok(wide.twitterShape.unlistedEnvelopeKeys.length < 2048)
})

test('Twitter shape mode is restricted to the exact native endpoint while usage preserves the social scope', async () => {
  const definitions = [
    { provider_key: 'tikhub', endpoint_key: 'native.t.api_3cd88a6621a01120' },
    { provider_key: 'tikhub', endpoint_key: 'native.t.api_e85913faa8a9029b' },
    { provider_key: 'justone', endpoint_key: 'native.j.api_bcedccd1a73cc8f2' },
  ]
  const client = { async query(sql) {
    if (sql.includes(':usage')) return { rows: [{ platform: 'social', status: 'committed', response_status: 200 }] }
    if (sql.includes(':calls')) return { rows: definitions.map(row => ({ id: callId, marketplace: 'twitter', ...row })) }
    if (sql.includes(':archive')) return { rows: [archive({ data: twitterTweet({ replyThreads: [] }) })] }
    return { rows: [] }
  }, release() {} }
  const result = await inspectPostCommentContract({ connect: async () => client }, requestId, { twitterPostId })
  assert.equal(result.revision, 'post-comment-contract-inspection.v2')
  assert.equal(result.usage.platform, 'social')
  assert.equal(result.calls.every(row => row.platform === 'twitter'), true)
  assert.equal(result.calls[0].archive.twitterShape.rootIdRelation, 'same')
  assert.equal(result.calls[1].archive.twitterShape, undefined)
  assert.equal(result.calls[2].archive.twitterShape, undefined)
  for (const call of result.calls.slice(1)) assert.equal(JSON.stringify(call.archive).includes('replyThreads'), false)
  await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, requestId,
    { twitterPostId: Number(twitterPostId) }), /invalid_twitter_post_id/)
})
