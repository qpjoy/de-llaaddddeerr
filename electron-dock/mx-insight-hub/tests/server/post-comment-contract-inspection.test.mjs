import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { inspectPostCommentArchive, inspectPostCommentContract, prepareTwitterConversationCommentSample, summarizePostCommentPayload } from '../../server/ops/inspect-post-comment-contract.mjs'
import { parseTikHubTwitterCommentPage } from '../../server/contracts/twitter-comment-page.mjs'
import { parseTikHubRedditCommentPage } from '../../server/contracts/reddit-comment-page.mjs'

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

test('Weibo identity and interaction field names remain visible without their values', () => {
  const result = inspectPostCommentArchive(archive({ data: { data: [{ idstr: '9876543210123456',
    user: { idstr: 'private-author' }, like_counts: 7654321, total_number: 7654322 }] } }))
  assert.deepEqual(result.fields.find(row => row.path === '$.data.data[].idstr').types, { string: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.data[].user.idstr').types, { string: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.data[].like_counts').types, { number: 1 })
  assert.deepEqual(result.fields.find(row => row.path === '$.data.data[].total_number').types, { number: 1 })
  const output = JSON.stringify(result)
  for (const value of ['9876543210123456', 'private-author', '7654321', '7654322']) assert.equal(output.includes(value), false)
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

const conversationId = '2117000000000000123'
const emptyTwitterPayload = (overrides = {}) => ({ code: 200, data: twitterTweet({
  replies: 0, thread: [], conversation_id: conversationId, cursor: 'private-unused-cursor', ...overrides,
}) })

test('conversation preparation selects a different exact string ID only from the verified empty-tweet shape', () => {
  assert.deepEqual(prepareTwitterConversationCommentSample(emptyTwitterPayload(), twitterPostId),
    { platform: 'twitter', postId: conversationId })
  for (const overrides of [
    { id: '2117082385997250768' }, { id: Number(twitterPostId) },
    { conversation_id: twitterPostId }, { conversation_id: Number(conversationId) },
    { conversation_id: '' }, { conversation_id: '1e20' }, { conversation_id: '1'.repeat(31) },
    { thread: [{ id: '2117082385997250768' }] }, { thread: null }, { replies: 1 }, { replies: '0' },
    { text: null }, { author: [] },
  ]) {
    assert.throws(() => prepareTwitterConversationCommentSample(emptyTwitterPayload(overrides), twitterPostId),
      /twitter_conversation_sample_unavailable/)
  }
  for (const source of [Number(twitterPostId), null, '', 'not-a-post-id']) {
    assert.throws(() => prepareTwitterConversationCommentSample(emptyTwitterPayload(), source), /twitter_conversation_sample_unavailable/)
  }
  assert.throws(() => prepareTwitterConversationCommentSample({ ...emptyTwitterPayload(), code: 400 }, twitterPostId),
    /twitter_conversation_sample_unavailable/)
})

function conversationInspectionHarness({ usage = {}, call = {}, raw = archive(emptyTwitterPayload()), count = 1 } = {}) {
  const queries = []
  let releases = 0
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes(':usage')) return { rows: [{ platform: 'social', status: 'committed', response_status: 200, ...usage }] }
    if (sql.includes(':calls')) return { rows: Array.from({ length: count }, () => ({ id: callId,
      provider_key: 'tikhub', marketplace: 'twitter', endpoint_key: 'native.t.api_3cd88a6621a01120',
      outcome: 'succeeded', http_status: 200, business_code: 200, billed: true, ...call })) }
    if (sql.includes(':archive')) return { rows: raw ? [raw] : [] }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, get releases() { return releases } }
}

test('ordinary archive and request inspection never expose the private conversation sample target', async () => {
  for (const options of [{}, { twitterPostId }]) {
    const direct = inspectPostCommentArchive(archive(emptyTwitterPayload()), options)
    assert.equal(direct.conversationSample, undefined)
    const h = conversationInspectionHarness()
    const saved = await inspectPostCommentContract(h.pool, requestId, options)
    for (const value of [twitterPostId, conversationId, 'private-unused-cursor', 'private-root-body', 'private-author']) {
      assert.equal(JSON.stringify(direct).includes(value), false)
      assert.equal(JSON.stringify(saved).includes(value), false)
    }
    assert.equal(saved.calls[0].archive.conversationSample, undefined)
    assert.equal(saved.supplierHttpCallsMade, 0)
  }
})

test('explicit conversation preparation returns only a private plan from one committed billed call in a read-only transaction', async () => {
  const h = conversationInspectionHarness()
  const result = await inspectPostCommentContract(h.pool, requestId, { twitterPostId, prepareTwitterConversation: true })
  assert.deepEqual(result, { revision: 'twitter-conversation-comment-sample.v1', sourceRequestId: requestId,
    sourcePostId: twitterPostId, platform: 'twitter', postId: conversationId })
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.match(h.queries[0].sql, /ISOLATION LEVEL REPEATABLE READ READ ONLY/)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.deepEqual(h.queries.find(row => row.sql.includes(':archive')).values, [requestId, callId, 4194304])
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('conversation preparation rejects missing or contradictory billing lineage and corrupt archives, always rolling back', async () => {
  const validRaw = archive(emptyTwitterPayload())
  for (const changes of [
    { usage: { status: 'reserved' } }, { usage: { status: 'released' } }, { usage: { response_status: 404 } },
    { call: { billed: false } }, { call: { billed: null } }, { call: { outcome: 'unknown' } },
    { call: { http_status: 404 } }, { call: { business_code: 400 } },
    { call: { endpoint_key: 'native.t.api_e85913faa8a9029b' } },
    { call: { provider_key: 'justone', endpoint_key: 'native.j.api_bcedccd1a73cc8f2' } },
    { call: { marketplace: 'reddit' } }, { count: 0 }, { count: 2 }, { count: 4 },
    { raw: null }, { raw: { ...validRaw, body_sha256: '0'.repeat(64) } },
    { raw: { ...validRaw, actual_body_size: validRaw.body_size + 1 } },
    { raw: archive(emptyTwitterPayload({ id: '2117082385997250768' })) },
    { raw: archive(emptyTwitterPayload({ thread: [{ id: '2117082385997250768' }] })) },
  ]) {
    const h = conversationInspectionHarness(changes)
    await assert.rejects(inspectPostCommentContract(h.pool, requestId, { twitterPostId, prepareTwitterConversation: true }),
      /twitter_conversation_sample_unavailable/)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
    assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  }
  await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, requestId,
    { prepareTwitterConversation: true }), /invalid_twitter_post_id/)
})

const twitterThreadPayload = () => ({ code: 200, data: twitterTweet({
  conversation_id: twitterPostId, cursor: 'private-continuation-token', replies: 36,
  thread: Array.from({ length: 36 }, (_, index) => ({
    id: String(BigInt(twitterPostId) + BigInt(index + 1)), conversation_id: twitterPostId,
    text: `private-comment-body-${index}`, created_at: 'Mon Nov 02 03:08:00 +0000 2026',
    likes: 17, replies: 0, retweets: 2, bookmarks: 1, quotes: 0, views: '12345',
    author: { rest_id: '1222333444555666777', name: 'private-comment-author', screen_name: 'private-author-handle' },
  })),
}) })

test('Twitter projection verification runs the runtime parser against all 36 archived thread rows and returns compact counts only', async () => {
  const payload = twitterThreadPayload()
  const h = conversationInspectionHarness({ raw: archive(payload) })
  let parserCalls = 0
  const result = await inspectPostCommentContract(h.pool, requestId, { twitterProjectionValidator: (saved, target) => {
    parserCalls++
    assert.equal(saved.data.thread.length, 36)
    assert.equal(target, twitterPostId)
    return parseTikHubTwitterCommentPage(saved, target)
  } })
  assert.equal(parserCalls, 1)
  assert.equal(result.revision, 'twitter-comment-projection-verification.v1')
  assert.equal(result.verified, true)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.equal(result.archive.hashVerified, true)
  const { boundary, ...projection } = result.archive.projection
  assert.deepEqual(projection, { state: 'parser_verified', verified: true, targetSource: 'saved_response_root',
    inputThreadCount: 36, projectedCount: 36, distinctCommentCount: 36, excludedContextCount: 0, rootIncluded: false,
    textCount: 36, authorIdCount: 36, publishedAtCount: 36, unknownParentCount: 36,
    pagination: { hasMore: null, continuationAvailable: true, stopReason: null } })
  assert.match(boundary, /All saved thread entries/)
  assert.equal(result.archive.fields, undefined)
  const output = JSON.stringify(result)
  assert.ok(output.length < 2000)
  for (const scalar of [twitterPostId, payload.data.thread[35].id, '1222333444555666777', 'private-', '12345',
    'Mon Nov 02', '2026-11-02T03:08:00.000Z', 'https://x.com/']) assert.equal(output.includes(scalar), false)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.match(h.queries[0].sql, /READ ONLY/)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('Twitter projection verification rejects a malformed last row beyond the structural sampler limit without leaking parser errors', async () => {
  const payload = twitterThreadPayload()
  payload.data.thread[35].author.rest_id = 'private-invalid-author'
  const h = conversationInspectionHarness({ raw: archive(payload) })
  const result = await inspectPostCommentContract(h.pool, requestId, { twitterProjectionValidator: parseTikHubTwitterCommentPage })
  assert.equal(result.verified, false)
  assert.deepEqual(result.archive.projection, { state: 'contract_rejected', verified: false })
  assert.equal(JSON.stringify(result).includes('private'), false)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  const rejected = inspectPostCommentArchive(archive(twitterThreadPayload()), {
    twitterProjectionValidator() { throw new Error('private-parser-error-with-credentials') },
  })
  assert.deepEqual(rejected.projection, { state: 'contract_rejected', verified: false })
  assert.equal(JSON.stringify(rejected).includes('private'), false)
})

test('Twitter projection verification never invokes the parser before archive integrity succeeds', async () => {
  const valid = archive(twitterThreadPayload())
  for (const changed of [null, { ...valid, body_sha256: '0'.repeat(64) },
    { ...valid, actual_body_size: valid.body_size + 1 }, { ...valid, body_size: 4194305 }]) {
    let parserCalls = 0
    const h = conversationInspectionHarness({ raw: changed })
    const result = await inspectPostCommentContract(h.pool, requestId, {
      twitterProjectionValidator() { parserCalls++; throw new Error('must not parse') },
    })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection, undefined)
    assert.equal(result.supplierHttpCallsMade, 0)
    assert.equal(result.databaseWritesMade, 0)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  }
})

test('Twitter projection verification requires one successful committed billed native Twitter source and rejects incompatible options', async () => {
  const raw = archive(twitterThreadPayload())
  for (const changes of [
    { usage: { status: 'released' } }, { usage: { status: 'reserved' } }, { usage: { response_status: 404 } },
    { call: { billed: false } }, { call: { billed: null } }, { call: { outcome: 'unknown' } },
    { call: { http_status: 404 } }, { call: { business_code: 400 } },
    { call: { endpoint_key: 'native.t.api_e85913faa8a9029b' } },
    { call: { provider_key: 'justone', endpoint_key: 'native.j.api_bcedccd1a73cc8f2' } },
    { call: { marketplace: 'reddit' } }, { count: 0 }, { count: 2 }, { count: 4 },
  ]) {
    const h = conversationInspectionHarness({ raw, ...changes })
    await assert.rejects(inspectPostCommentContract(h.pool, requestId, { twitterProjectionValidator: parseTikHubTwitterCommentPage }),
      /twitter_projection_source_unavailable/)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
    assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  }
  for (const options of [{ twitterProjectionValidator: true },
    { twitterPostId, prepareTwitterConversation: true, twitterProjectionValidator: parseTikHubTwitterCommentPage }]) {
    await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, requestId, options), /invalid_arguments/)
  }
})

test('standalone stdin verification requires the prepended pure parser and retains existing inspection argument forms without connecting', async () => {
  const inspector = await readFile(new URL('../../server/ops/inspect-post-comment-contract.mjs', import.meta.url), 'utf8')
  const parser = await readFile(new URL('../../server/contracts/twitter-comment-page.mjs', import.meta.url), 'utf8')
  const env = { ...process.env }
  delete env.DATABASE_URL
  const invoke = (source, args) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', '--request-id', requestId, ...args], {
      input: source, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    return JSON.parse(result.stderr)
  }
  assert.deepEqual(invoke(inspector, ['--verify-twitter-projection']), { error: 'twitter_projection_parser_required' })
  const combined = `${parser}\n${inspector}`
  assert.deepEqual(invoke(combined, ['--verify-twitter-projection']), { error: 'database_url_required' })
  for (const args of [[], ['--twitter-post-id', twitterPostId],
    ['--twitter-post-id', twitterPostId, '--prepare-twitter-conversation']]) {
    assert.deepEqual(invoke(inspector, args), { error: 'database_url_required' })
  }
  for (const args of [['--verify-twitter-projection', twitterPostId],
    ['--verify-twitter-projection', '--prepare-twitter-conversation'], ['--verify-twitter-projection', '--extra'],
    ['--twitter-post-id', twitterPostId, '--verify-twitter-projection']]) {
    assert.deepEqual(invoke(combined, args), { error: 'invalid_arguments' })
  }
})

const redditRequestId = '7eb265f4-5c2c-4d15-91d5-7dc7fed83b61'
const redditPostId = 't3_post123'
const redditNativePath = '/api/v1/data/native/t.api_c7f50cf300d63960'
const redditSnapshot = (overrides = {}) => ({ method: 'POST', path: redditNativePath,
  body: { params: { post_id: redditPostId, need_format: false }, deliveryMode: 'live_only' }, ...overrides })
const redditThreadPayload = () => ({ code: 200, data: { postInfoById: { id: redditPostId,
  commentForest: { pageInfo: { commentCount: 7, hasNextPage: false }, trees: Array.from({ length: 7 }, (_, index) => ({
    childCount: 0, depth: 0, more: null, parentId: null,
    node: { __typename: 'Comment', id: `t1_reply${index}`, content: { markdown: `private-reddit-body-${index}` },
      createdAt: '2026-11-02T00:00:00.000Z', score: -23, isScoreHidden: false, isRemoved: false,
      authorInfo: { id: 't2_privateuser', name: 'private-reddit-author', iconSmall: { url: 'https://private.example/avatar' } },
      permalink: `/r/test/comments/post123/private-title/reply${index}/` },
  })) },
} } })

function redditInspectionHarness({ usage = {}, call = {}, raw = archive(redditThreadPayload()), count = 1,
  snapshots = [{ acquisition_request: redditSnapshot() }] } = {}) {
  const queries = []
  let releases = 0
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes(':usage')) return { rows: [{ platform: 'social', status: 'committed', response_status: 200, ...usage }] }
    if (sql.includes(':calls')) return { rows: Array.from({ length: count }, () => ({ id: callId,
      provider_key: 'tikhub', marketplace: 'reddit', endpoint_key: 'native.t.api_c7f50cf300d63960',
      outcome: 'succeeded', http_status: 200, business_code: 200, billed: true, ...call })) }
    if (sql.includes(':reddit-request')) return { rows: snapshots }
    if (sql.includes(':archive')) return { rows: raw ? [raw] : [] }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, get releases() { return releases } }
}

test('Reddit verification validates every saved tree against the bounded saved request snapshot and returns no payload values', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('no supplier HTTP') })
  const h = redditInspectionHarness()
  let parserCalls = 0
  const result = await inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator: (payload, target) => {
    parserCalls++
    assert.equal(target, redditPostId)
    assert.equal(payload.data.postInfoById.commentForest.trees.length, 7)
    return parseTikHubRedditCommentPage(payload, target)
  } })
  assert.equal(parserCalls, 1)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(result.revision, 'reddit-comment-projection-verification.v1')
  assert.equal(result.verified, true)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.equal(result.archive.hashVerified, true)
  const { boundary, ...projection } = result.archive.projection
  assert.deepEqual(projection, { state: 'parser_verified', verified: true, targetSource: 'saved_request_snapshot',
    requestedPostMatched: true, inputTreeCount: 7, projectedCount: 7, distinctCommentCount: 7,
    rootIncluded: false, rootExcluded: true, textCount: 7, authorIdCount: 7, publishedAtCount: 7,
    scoreCount: 7, unknownParentCount: 7,
    pagination: { hasMore: false, continuationAvailable: false, stopReason: null } })
  assert.match(boundary, /same pure parser used by the runtime projector/u)
  assert.match(boundary, /does not activate runtime routing/u)
  const output = JSON.stringify(result)
  assert.ok(output.length < 2000)
  for (const value of [redditPostId, 'reply6', 'private', '-23', '2026-11-02T00:00:00.000Z', 'need_format']) {
    assert.equal(output.includes(value), false)
  }
  const snapshotQuery = h.queries.find(row => row.sql.includes(':reddit-request'))
  assert.deepEqual(snapshotQuery.values, [redditRequestId, 32768])
  assert.match(snapshotQuery.sql, /CASE WHEN octet_length\(acquisition_request::text\) <= \$2::integer/u)
  assert.match(snapshotQuery.sql, /WHERE id=\$1::uuid/u)
  assert.match(h.queries[0].sql, /READ ONLY/u)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('Reddit verification rejects an invalid final tree after the structural sample limit and hides parser errors', async () => {
  const payload = redditThreadPayload()
  payload.data.postInfoById.commentForest.trees[6].node.content.markdown = null
  const h = redditInspectionHarness({ raw: archive(payload) })
  const result = await inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator: parseTikHubRedditCommentPage })
  assert.equal(result.verified, false)
  assert.deepEqual(result.archive.projection, { state: 'contract_rejected', verified: false,
    targetSource: 'saved_request_snapshot', requestedPostMatched: true, reason: 'comment_text' })
  const rejected = inspectPostCommentArchive(archive(redditThreadPayload()), { redditPostId,
    redditProjectionValidator() { throw Object.assign(new Error('private-parser-error'), { reason: 'private-parser-reason' }) } })
  assert.equal(rejected.projection.state, 'contract_rejected')
  assert.equal(rejected.projection.reason, 'other')
  assert.equal(JSON.stringify(rejected).includes('private'), false)
})

test('Reddit verification uses the request target rather than accepting a self-consistent different response post', async () => {
  const h = redditInspectionHarness({ snapshots: [{ acquisition_request: redditSnapshot({
    body: { params: { post_id: 't3_otherpost', need_format: false } },
  }) }] })
  let parserTarget
  const result = await inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator: (payload, target) => {
    parserTarget = target
    return parseTikHubRedditCommentPage(payload, target)
  } })
  assert.equal(parserTarget, 't3_otherpost')
  assert.equal(result.verified, false)
  assert.deepEqual(result.archive.projection, { state: 'contract_rejected', verified: false,
    targetSource: 'saved_request_snapshot', requestedPostMatched: false, reason: 'root_id_mismatch' })
  assert.equal(JSON.stringify(result).includes('otherpost'), false)
})

test('missing or incompatible Reddit request snapshots explicitly remain unavailable with no response-root fallback', async () => {
  for (const snapshots of [[], [{ acquisition_request: null }], [{ acquisition_request: redditSnapshot({ bodyOmitted: 'oversize', body: undefined }) }],
    [{ acquisition_request: redditSnapshot({ method: 'GET' }) }],
    [{ acquisition_request: redditSnapshot({ path: '/api/v1/data/native/t.api_e0a2654e9c191a80' }) }],
    [{ acquisition_request: redditSnapshot({ body: { params: { post_id: 12345 } } }) }],
    [{ acquisition_request: redditSnapshot({ body: { params: { post_id: 't1_comment' } } }) }],
    [{ acquisition_request: redditSnapshot({ body: { postId: redditPostId } }) }],
    [{ acquisition_request: redditSnapshot() }, { acquisition_request: redditSnapshot() }],
  ]) {
    let parserCalls = 0
    const h = redditInspectionHarness({ snapshots })
    const result = await inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.hashVerified, true)
    assert.deepEqual(result.archive.projection, { state: 'request_snapshot_unavailable', verified: false, targetSource: 'saved_request_snapshot' })
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('Reddit projection verification requires archive integrity and the exact committed billed native source', async () => {
  const valid = archive(redditThreadPayload())
  for (const raw of [null, { ...valid, body_sha256: '0'.repeat(64) },
    { ...valid, actual_body_size: valid.body_size + 1 }, { ...valid, body_size: 4194305 }]) {
    let parserCalls = 0
    const h = redditInspectionHarness({ raw })
    const result = await inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection, undefined)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  }
  for (const changes of [
    { usage: { status: 'released' } }, { usage: { response_status: 404 } }, { count: 0 }, { count: 2 },
    { call: { billed: false } }, { call: { outcome: 'unknown' } }, { call: { http_status: 404 } }, { call: { business_code: 400 } },
    { call: { endpoint_key: 'native.t.api_e0a2654e9c191a80' } }, { call: { marketplace: 'twitter' } },
    { call: { provider_key: 'justone', endpoint_key: 'native.j.api_9f1806a48fde0794' } },
  ]) {
    const h = redditInspectionHarness(changes)
    await assert.rejects(inspectPostCommentContract(h.pool, redditRequestId, { redditProjectionValidator: parseTikHubRedditCommentPage }),
      /reddit_projection_source_unavailable/u)
    assert.equal(h.queries.some(row => row.sql.includes(':reddit-request') || row.sql.includes(':archive')), false)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
  for (const options of [{ redditProjectionValidator: true },
    { redditProjectionValidator: parseTikHubRedditCommentPage, twitterProjectionValidator: parseTikHubTwitterCommentPage },
    { redditProjectionValidator: parseTikHubRedditCommentPage, twitterPostId },
    { redditProjectionValidator: parseTikHubRedditCommentPage, twitterPostId, prepareTwitterConversation: true }]) {
    await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, redditRequestId, options), /invalid_arguments/u)
  }
})

test('standalone Reddit verification requires its own prepended parser and validates mode arguments before connecting', async () => {
  const inspector = await readFile(new URL('../../server/ops/inspect-post-comment-contract.mjs', import.meta.url), 'utf8')
  const parser = await readFile(new URL('../../server/contracts/reddit-comment-page.mjs', import.meta.url), 'utf8')
  const twitterParser = await readFile(new URL('../../server/contracts/twitter-comment-page.mjs', import.meta.url), 'utf8')
  const env = { ...process.env }
  delete env.DATABASE_URL
  const invoke = (source, args) => {
    const result = spawnSync(process.execPath, ['--input-type=module', '-', '--request-id', redditRequestId, ...args], {
      input: source, env, encoding: 'utf8', timeout: 5000, maxBuffer: 65536,
    })
    assert.equal(result.error, undefined)
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    return JSON.parse(result.stderr)
  }
  assert.deepEqual(invoke(inspector, ['--verify-reddit-projection']), { error: 'reddit_projection_parser_required' })
  assert.deepEqual(invoke(`${twitterParser}\n${inspector}`, ['--verify-reddit-projection']), { error: 'reddit_projection_parser_required' })
  const combined = `${parser}\n${inspector}`
  assert.deepEqual(invoke(combined, ['--verify-reddit-projection']), { error: 'database_url_required' })
  assert.deepEqual(invoke(`${twitterParser}\n${combined}`, ['--verify-twitter-projection']), { error: 'database_url_required' })
  for (const args of [['--verify-reddit-projection', redditPostId],
    ['--verify-reddit-projection', '--verify-twitter-projection'],
    ['--twitter-post-id', twitterPostId, '--verify-reddit-projection']]) {
    assert.deepEqual(invoke(combined, args), { error: 'invalid_arguments' })
  }
})
