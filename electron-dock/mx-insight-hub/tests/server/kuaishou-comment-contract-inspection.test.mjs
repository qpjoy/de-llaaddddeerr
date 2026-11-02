import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { inspectPostCommentArchive, inspectPostCommentContract } from '../../server/ops/inspect-post-comment-contract.mjs'
import { parseTikHubKuaishouCommentPage } from '../../server/contracts/kuaishou-comment-page.mjs'
import { parseTikHubTwitterCommentPage } from '../../server/contracts/twitter-comment-page.mjs'
import { parseTikHubRedditCommentPage } from '../../server/contracts/reddit-comment-page.mjs'

const requestId = '16eb4f8e-7d1d-40e2-8593-02570ee3fd37'
const callId = 'b5dabf17-a23d-4e1b-8bf2-c71aa30617b0'
const postId = 'fixturePhoto123'
const nativePath = '/api/v1/data/native/t.api_bc64c9d98dbf724c'
const nativeOperation = 'native.t.api_bc64c9d98dbf724c'
const timestamp = 1793577600000
const archive = payload => {
  const body_bytes = Buffer.from(JSON.stringify(payload))
  return { body_bytes, body_size: body_bytes.length, actual_body_size: body_bytes.length,
    body_sha256: createHash('sha256').update(body_bytes).digest('hex') }
}
const snapshot = (overrides = {}) => ({ method: 'POST', path: nativePath,
  body: { params: { photo_id: postId }, deliveryMode: 'live_only' }, ...overrides })
const payload = () => ({ code: 200, params: { photo_id: postId }, data: {
  result: 1, rootComments: Array.from({ length: 11 }, (_, index) => ({
    comment_id: 80412000 + index, author_id: 50912000 + index, user_id: 60912000 + index,
    author_name: `private-author-${index}`, content: `private-comment-${index}`, timestamp,
    likedCount: index, subCommentCount: index < 2 ? 1 : 0,
    headurl: 'https://private.example/avatar.jpg', photo_id: 9007199254740992, reply_to: 0,
  })),
  subCommentsMap: {
    80412000: { pcursor: 'private-preview-cursor-a', subComments: [{ comment_id: 91412000, content: 'private-preview-a' }] },
    80412001: { pcursor: 'private-preview-cursor-b', subComments: [{ comment_id: 91412001, content: 'private-preview-b' }] },
  },
  pcursor: 'private-next-root-page', commentCount: 31,
} })

function harness({ usage = {}, call = {}, raw = archive(payload()), count = 1,
  snapshots = [{ acquisition_request: snapshot() }] } = {}) {
  const queries = []; let releases = 0
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes(':usage')) return { rows: [{ platform: 'social', status: 'committed', response_status: 200, ...usage }] }
    if (sql.includes(':calls')) return { rows: Array.from({ length: count }, () => ({ id: callId,
      provider_key: 'tikhub', marketplace: 'kuaishou', endpoint_key: nativeOperation,
      operation: nativeOperation, contract_version: 'mx-insight-hub.native-forwarding.v1',
      outcome: 'succeeded', http_status: 200, business_code: 200, billed: true, ...call })) }
    if (sql.includes(':kuaishou-request')) return { rows: snapshots }
    if (sql.includes(':archive')) return { rows: raw ? [raw] : [] }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, get releases() { return releases } }
}
const verify = pool => inspectPostCommentContract(pool, requestId, { kuaishouProjectionValidator: parseTikHubKuaishouCommentPage })

test('Kuaishou verifies all saved root comments against the saved App request without exposing payload values', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('no supplier HTTP') })
  const h = harness(); let parserCalls = 0
  const result = await inspectPostCommentContract(h.pool, requestId, { kuaishouProjectionValidator: (saved, target) => {
    parserCalls++
    assert.equal(target, postId)
    assert.equal(saved.data.rootComments.length, 11)
    return parseTikHubKuaishouCommentPage(saved, target)
  } })
  assert.equal(parserCalls, 1)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(result.revision, 'kuaishou-comment-projection-verification.v1')
  assert.equal(result.verified, true)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.equal(result.archive.hashVerified, true)
  const projection = result.archive.projection
  assert.equal(projection.state, 'parser_verified')
  assert.equal(projection.targetSource, 'saved_request_snapshot')
  assert.equal(projection.requestedPostMatched, true)
  assert.equal(projection.inputRootCount, 11)
  assert.equal(projection.projectedCount, 11)
  assert.equal(projection.distinctCommentCount, 11)
  assert.equal(projection.textCount, 11)
  assert.equal(projection.authorIdCount, 11)
  assert.equal(projection.publishedAtCount, 11)
  assert.equal(projection.likeCount, 11)
  assert.equal(projection.replyCount, 11)
  assert.equal(projection.parentPostCount, 11)
  assert.equal(projection.previewCommentCount, 2)
  assert.deepEqual(projection.identityFields, {
    commentId: { safe_integer: 11, unsafe_number: 0, string: 0, missing: 0, other: 0 },
    authorId: { safe_integer: 11, unsafe_number: 0, string: 0, missing: 0, other: 0 },
    photoId: { safe_integer: 0, unsafe_number: 11, string: 0, missing: 0, other: 0 },
  })
  assert.deepEqual(projection.pagination.hasMore, null)
  assert.equal(projection.pagination.continuationAvailable, true)
  assert.equal(projection.pagination.cursorState, 'opaque')
  const output = JSON.stringify(result)
  assert.ok(output.length < 4000)
  for (const value of [postId, 'private-', '80412000', '50912000', '60912000', '9007199254740992', String(timestamp)]) {
    assert.equal(output.includes(value), false, value)
  }
  const requestQuery = h.queries.find(row => row.sql.includes(':kuaishou-request'))
  assert.deepEqual(requestQuery.values, [requestId, 32768])
  assert.match(requestQuery.sql, /CASE WHEN octet_length\(acquisition_request::text\) <= \$2::integer/u)
  assert.match(requestQuery.sql, /WHERE id=\$1::uuid/u)
  assert.match(h.queries[0].sql, /READ ONLY/u)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('Kuaishou verification rejects a malformed last row after the three-row structure sample', async () => {
  const saved = payload()
  saved.data.rootComments[10].content = null
  const result = await verify(harness({ raw: archive(saved) }).pool)
  assert.equal(result.verified, false)
  assert.equal(result.archive.projection.state, 'contract_rejected')
  assert.equal(result.archive.projection.requestedPostMatched, true)
  assert.equal(result.archive.projection.reason, 'comment_text')
  const rejected = inspectPostCommentArchive(archive(payload()), { kuaishouPostId: postId,
    kuaishouProjectionValidator() { throw Object.assign(new Error('private-error'), { reason: 'private-reason' }) } })
  assert.equal(rejected.projection.state, 'contract_rejected')
  assert.equal(rejected.projection.reason, 'other')
  assert.equal(JSON.stringify(rejected).includes('private-'), false)
})

test('unsafe comment or author identities fail closed while internal photo metadata is not the requested ID', async () => {
  assert.equal((await verify(harness().pool)).verified, true)
  for (const field of ['comment_id', 'author_id']) {
    const saved = payload()
    saved.data.rootComments[10][field] = 9007199254740992
    const result = await verify(harness({ raw: archive(saved) }).pool)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection.state, 'contract_rejected')
    assert.equal(JSON.stringify(result).includes('9007199254740992'), false)
    const identity = result.archive.projection.identityFields[field === 'comment_id' ? 'commentId' : 'authorId']
    assert.equal(identity.unsafe_number, 1)
    assert.equal(identity.safe_integer, 10)
  }
})

test('all identity fields are classified without exposing unsafe numbers or invalid scalar values', async () => {
  const saved = payload()
  saved.data.rootComments[0].comment_id = '80412000'
  saved.data.rootComments[1].author_id = null
  saved.data.rootComments[2].author_id = { secret: 'private-invalid-author' }
  saved.data.rootComments[3].photo_id = 'private-internal-photo'
  saved.data.rootComments[4].photo_id = null
  saved.data.rootComments[5].photo_id = 0
  const result = await verify(harness({ raw: archive(saved) }).pool)
  assert.equal(result.verified, false)
  assert.deepEqual(result.archive.projection.identityFields, {
    commentId: { safe_integer: 10, unsafe_number: 0, string: 1, missing: 0, other: 0 },
    authorId: { safe_integer: 9, unsafe_number: 0, string: 0, missing: 1, other: 1 },
    photoId: { safe_integer: 1, unsafe_number: 8, string: 1, missing: 1, other: 0 },
  })
  assert.equal(JSON.stringify(result).includes('private-'), false)
})

test('request target comparison never accepts a self-consistent but different saved response echo', async () => {
  const h = harness({ snapshots: [{ acquisition_request: snapshot({ body: { params: { photo_id: 'otherPhoto456' } } }) }] })
  let targetSeen
  const result = await inspectPostCommentContract(h.pool, requestId, { kuaishouProjectionValidator(saved, target) {
    targetSeen = target
    return parseTikHubKuaishouCommentPage(saved, target)
  } })
  assert.equal(targetSeen, 'otherPhoto456')
  assert.equal(result.verified, false)
  assert.equal(result.archive.projection.requestedPostMatched, false)
  assert.equal(result.archive.projection.state, 'contract_rejected')
  assert.equal(JSON.stringify(result).includes('otherPhoto456'), false)
})

test('missing or incompatible saved App requests are unavailable without response-root fallback', async () => {
  for (const snapshots of [[], [{ acquisition_request: null }],
    [{ acquisition_request: snapshot({ method: 'GET' }) }],
    [{ acquisition_request: snapshot({ path: '/api/v1/data/native/t.api_3cb972ba91c8fe44' }) }],
    [{ acquisition_request: snapshot({ body: { params: { photo_id: 12345 } } }) }],
    [{ acquisition_request: snapshot({ body: { params: { photo_id: '' } } }) }],
    [{ acquisition_request: snapshot({ body: { postId } }) }],
    [{ acquisition_request: snapshot() }, { acquisition_request: snapshot() }],
  ]) {
    let parserCalls = 0
    const h = harness({ snapshots })
    const result = await inspectPostCommentContract(h.pool, requestId, { kuaishouProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.hashVerified, true)
    assert.equal(result.archive.projection.state, 'request_snapshot_unavailable')
    assert.equal(result.archive.projection.targetSource, 'saved_request_snapshot')
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('archive integrity is checked before any Kuaishou parsing', async () => {
  const valid = archive(payload())
  for (const raw of [null, { ...valid, body_sha256: '0'.repeat(64) },
    { ...valid, actual_body_size: valid.body_size + 1 }, { ...valid, body_size: 4194305 }]) {
    let parserCalls = 0
    const h = harness({ raw })
    const result = await inspectPostCommentContract(h.pool, requestId, { kuaishouProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection, undefined)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('Kuaishou mode requires a single successful billed App call before reading snapshots or archives', async () => {
  for (const changes of [
    { usage: { platform: 'twitter' } }, { usage: { status: 'released' } }, { usage: { response_status: 502 } },
    { count: 0 }, { count: 2 }, { call: { billed: null } }, { call: { billed: false } },
    { call: { outcome: 'unknown' } }, { call: { http_status: 400 } }, { call: { business_code: 400 } },
    { call: { endpoint_key: 'native.t.api_3cb972ba91c8fe44' } },
    { call: { operation: 'native.t.api_3cb972ba91c8fe44' } },
    { call: { contract_version: 'mx-insight-hub.post-comments.v1' } },
    { call: { marketplace: 'twitter' } },
    { call: { provider_key: 'justone', endpoint_key: 'native.j.api_e0c0bbd6b8e0784c' } },
  ]) {
    const h = harness(changes)
    await assert.rejects(verify(h.pool), /kuaishou_projection_source_unavailable/u)
    assert.equal(h.queries.some(row => row.sql.includes(':kuaishou-request') || row.sql.includes(':archive')), false)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
  assert.equal((await verify(harness({ usage: { platform: 'kuaishou' } }).pool)).verified, true)
})

test('saved provider continuation is compared without exposing or repeating its token', async () => {
  const token = 'private-next-root-page'
  const h = harness({ snapshots: [{ acquisition_request: snapshot({
    body: { params: { photo_id: postId, pcursor: token }, deliveryMode: 'live_only' },
  }) }] })
  let continuationSeen
  const result = await inspectPostCommentContract(h.pool, requestId, { kuaishouProjectionValidator(saved, target, continuation) {
    continuationSeen = continuation
    return parseTikHubKuaishouCommentPage(saved, target, continuation)
  } })
  assert.deepEqual(continuationSeen, { pcursor: token })
  assert.equal(result.verified, true)
  assert.deepEqual(result.archive.projection.pagination, {
    hasMore: null, continuationAvailable: false, stopReason: 'continuation_unproven', cursorState: 'repeated',
  })
  assert.equal(JSON.stringify(result).includes(token), false)
})

test('unproven sentinel and absent cursors remain unknown while only fixed pagination classes are returned', async () => {
  for (const [cursor, cursorState] of [[undefined, 'missing'], [null, 'missing'], ['', 'empty'], ['no_more', 'no_more']]) {
    const saved = payload()
    if (cursor === undefined) delete saved.data.pcursor
    else saved.data.pcursor = cursor
    const result = await verify(harness({ raw: archive(saved) }).pool)
    assert.equal(result.verified, true)
    assert.deepEqual(result.archive.projection.pagination, {
      hasMore: null, continuationAvailable: false, stopReason: 'continuation_unproven', cursorState,
    })
  }
})

test('Kuaishou projection mode cannot be combined with other modes or invalid validators', async () => {
  for (const options of [{ kuaishouProjectionValidator: true },
    { kuaishouProjectionValidator: parseTikHubKuaishouCommentPage, twitterProjectionValidator: parseTikHubTwitterCommentPage },
    { kuaishouProjectionValidator: parseTikHubKuaishouCommentPage, redditProjectionValidator: parseTikHubRedditCommentPage },
    { kuaishouProjectionValidator: parseTikHubKuaishouCommentPage, twitterPostId: '2117082385997250767' },
    { kuaishouProjectionValidator: parseTikHubKuaishouCommentPage, twitterPostId: '2117082385997250767', prepareTwitterConversation: true }]) {
    await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, requestId, options), /invalid_arguments/u)
  }
})

test('standalone Kuaishou verification requires its own parser and rejects incompatible arguments before connecting', async () => {
  const inspector = await readFile(new URL('../../server/ops/inspect-post-comment-contract.mjs', import.meta.url), 'utf8')
  const parser = await readFile(new URL('../../server/contracts/kuaishou-comment-page.mjs', import.meta.url), 'utf8')
  const redditParser = await readFile(new URL('../../server/contracts/reddit-comment-page.mjs', import.meta.url), 'utf8')
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
  assert.deepEqual(invoke(inspector, ['--verify-kuaishou-projection']), { error: 'kuaishou_projection_parser_required' })
  assert.deepEqual(invoke(`${redditParser}\n${inspector}`, ['--verify-kuaishou-projection']), { error: 'kuaishou_projection_parser_required' })
  const combined = `${parser}\n${inspector}`
  assert.deepEqual(invoke(combined, ['--verify-kuaishou-projection']), { error: 'database_url_required' })
  assert.deepEqual(invoke(`${redditParser}\n${combined}`, ['--verify-reddit-projection']), { error: 'database_url_required' })
  for (const args of [['--verify-kuaishou-projection', postId],
    ['--verify-kuaishou-projection', '--verify-reddit-projection'],
    ['--twitter-post-id', '2117082385997250767', '--verify-kuaishou-projection']]) {
    assert.deepEqual(invoke(combined, args), { error: 'invalid_arguments' })
  }
})
