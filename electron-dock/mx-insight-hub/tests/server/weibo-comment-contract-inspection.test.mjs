import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { inspectPostCommentArchive, inspectPostCommentContract } from '../../server/ops/inspect-post-comment-contract.mjs'
import { parseTikHubWeiboCommentPage } from '../../server/contracts/weibo-comment-page.mjs'
import { parseTikHubKuaishouCommentPage } from '../../server/contracts/kuaishou-comment-page.mjs'
import { parseTikHubTwitterCommentPage } from '../../server/contracts/twitter-comment-page.mjs'
import { parseTikHubRedditCommentPage } from '../../server/contracts/reddit-comment-page.mjs'

const requestId = 'fedbc7e0-e9fa-4fe3-a3e3-5107fcb13849'
const callId = 'ea5de54f-5e5d-4310-8932-1077d5e6b7c9'
const postId = '8123456789012345'
const nativePath = '/api/v1/data/native/t.api_631f7f6fd007cba9'
const nativeOperation = 'native.t.api_631f7f6fd007cba9'
const timestamp = 'Mon Nov 02 12:00:00 +0800 2026'
const archive = payload => {
  const body_bytes = Buffer.from(JSON.stringify(payload))
  return { body_bytes, body_size: body_bytes.length, actual_body_size: body_bytes.length,
    body_sha256: createHash('sha256').update(body_bytes).digest('hex') }
}
const snapshot = (overrides = {}) => ({ method: 'POST', path: nativePath,
  body: { params: { id: postId, count: 20 }, deliveryMode: 'live_only' }, ...overrides })
const payload = () => ({ code: 200, params: { id: postId, count: '20', max_id: '' }, data: {
  ok: 1, data: Array.from({ length: 22 }, (_, index) => {
    const idstr = String(987654321012340000n + BigInt(index))
    return { idstr, mid: idstr, id: Number(idstr), rootidstr: idstr, rootid: Number(idstr),
      text_raw: `private-comment-${index}`, text: `<span>private-html-${index}</span>`, created_at: timestamp,
      user: { idstr: String(43123000 + index), id: 43123000 + index, screen_name: `private-author-${index}`,
        profile_url: 'https://weibo.com/private-profile', avatar_hd: 'https://private.example/avatar.jpg' },
      like_counts: index, total_number: index < 2 ? 1 : 0,
      comments: index < 2 ? [{ idstr: `123456${index}`, text_raw: `private-preview-${index}` }] : [],
    }
  }), rootComment: [], total_number: 221, max_id: 9007199254740992,
} })

function harness({ usage = {}, call = {}, raw = archive(payload()), count = 1,
  snapshots = [{ acquisition_request: snapshot() }] } = {}) {
  const queries = []; let releases = 0
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes(':usage')) return { rows: [{ platform: 'social', status: 'committed', response_status: 200, ...usage }] }
    if (sql.includes(':calls')) return { rows: Array.from({ length: count }, () => ({ id: callId,
      provider_key: 'tikhub', marketplace: 'weibo', endpoint_key: nativeOperation,
      operation: nativeOperation, contract_version: 'mx-insight-hub.native-forwarding.v1',
      outcome: 'succeeded', http_status: 200, business_code: 200, billed: true, ...call })) }
    if (sql.includes(':weibo-request')) return { rows: snapshots }
    if (sql.includes(':archive')) return { rows: raw ? [raw] : [] }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, get releases() { return releases } }
}
const verify = pool => inspectPostCommentContract(pool, requestId, { weiboProjectionValidator: parseTikHubWeiboCommentPage })

test('Weibo verifies all 22 roots from saved request and archive without emitting values or fetching data', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('no supplier HTTP') })
  const h = harness(); let parserCalls = 0
  const result = await inspectPostCommentContract(h.pool, requestId, { weiboProjectionValidator(saved, target, continuation) {
    parserCalls++
    assert.equal(target, postId)
    assert.equal(saved.data.data.length, 22)
    return parseTikHubWeiboCommentPage(saved, target, continuation)
  } })
  assert.equal(parserCalls, 1)
  assert.equal(fetch.mock.callCount(), 0)
  assert.equal(result.revision, 'weibo-comment-projection-verification.v1')
  assert.equal(result.verified, true)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.equal(result.archive.hashVerified, true)
  const projection = result.archive.projection
  assert.equal(projection.state, 'parser_verified')
  assert.equal(projection.targetSource, 'saved_request_snapshot')
  assert.equal(projection.requestedPostMatched, true)
  for (const field of ['inputRootCount', 'projectedCount', 'distinctCommentCount', 'textCount',
    'authorIdCount', 'publishedAtCount', 'likeCount', 'replyCount', 'unknownParentCount']) {
    assert.equal(projection[field], 22, field)
  }
  assert.equal(projection.previewCommentCount, 2)
  assert.equal(projection.pagination.hasMore, null)
  assert.equal(projection.pagination.continuationAvailable, false)
  assert.equal(projection.pagination.stopReason, 'continuation_unproven')
  assert.ok(Object.values(projection.identityFields).some(field => field.string === 22))
  assert.ok(Object.values(projection.identityFields).some(field => field.unsafe_number === 22))
  const output = JSON.stringify(result)
  assert.ok(output.length < 6000)
  for (const value of [postId, 'private-', '987654321012340000', '43123000', '9007199254740992', timestamp]) {
    assert.equal(output.includes(value), false, value)
  }
  const requestQuery = h.queries.find(row => row.sql.includes(':weibo-request'))
  assert.deepEqual(requestQuery.values, [requestId, 32768])
  assert.match(requestQuery.sql, /CASE WHEN octet_length\(acquisition_request::text\) <= \$2::integer/u)
  assert.match(requestQuery.sql, /WHERE id=\$1::uuid/u)
  assert.match(h.queries[0].sql, /READ ONLY/u)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('Weibo projection checks malformed final rows beyond the structural sample and hides parser failures', async () => {
  const saved = payload()
  saved.data.data[21].text_raw = null
  saved.data.data[21].text = null
  const result = await verify(harness({ raw: archive(saved) }).pool)
  assert.equal(result.verified, false)
  assert.equal(result.archive.projection.state, 'contract_rejected')
  assert.equal(result.archive.projection.requestedPostMatched, true)
  assert.equal(result.archive.projection.reason, 'comment_text')
  const rejected = inspectPostCommentArchive(archive(payload()), { weiboPostId: postId,
    weiboProjectionValidator() { throw Object.assign(new Error('private-error'), { reason: 'private-reason' }) } })
  assert.equal(rejected.projection.state, 'contract_rejected')
  assert.equal(rejected.projection.reason, 'other')
  assert.equal(JSON.stringify(rejected).includes('private-'), false)
})

test('Weibo exact string identities remain usable while unsafe numeric-only or conflicting aliases are rejected', async () => {
  assert.equal((await verify(harness().pool)).verified, true)
  for (const change of [
    raw => { delete raw.idstr; delete raw.mid },
    raw => { raw.mid = '123456789012345678' },
    raw => { delete raw.user.idstr; raw.user.id = 9007199254740992 },
    raw => { raw.user.idstr = '43123999' },
  ]) {
    const saved = payload()
    change(saved.data.data[21])
    const result = await verify(harness({ raw: archive(saved) }).pool)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection.state, 'contract_rejected')
    assert.equal(JSON.stringify(result).includes('private-'), false)
    assert.equal(JSON.stringify(result).includes('9007199254740992'), false)
  }
})

test('Weibo target comparison binds the saved request instead of accepting a different response echo', async () => {
  const otherId = '7123456789012345'
  const h = harness({ snapshots: [{ acquisition_request: snapshot({ body: { params: { id: otherId, count: 20 } } }) }] })
  let targetSeen
  const result = await inspectPostCommentContract(h.pool, requestId, { weiboProjectionValidator(saved, target, continuation) {
    targetSeen = target
    return parseTikHubWeiboCommentPage(saved, target, continuation)
  } })
  assert.equal(targetSeen, otherId)
  assert.equal(result.verified, false)
  assert.equal(result.archive.projection.requestedPostMatched, false)
  assert.equal(result.archive.projection.state, 'contract_rejected')
  assert.equal(JSON.stringify(result).includes(otherId), false)
})

test('Weibo missing or incompatible request snapshots cannot fall back to the response target', async () => {
  for (const snapshots of [[], [{ acquisition_request: null }],
    [{ acquisition_request: snapshot({ method: 'GET' }) }],
    [{ acquisition_request: snapshot({ path: '/api/v1/data/native/t.api_ac75edddcf5bb304' }) }],
    [{ acquisition_request: snapshot({ body: { params: { id: 12345 } } }) }],
    [{ acquisition_request: snapshot({ body: { params: { id: 'base62' } } }) }],
    [{ acquisition_request: snapshot({ body: { postId } }) }],
    [{ acquisition_request: snapshot() }, { acquisition_request: snapshot() }],
  ]) {
    let parserCalls = 0
    const h = harness({ snapshots })
    const result = await inspectPostCommentContract(h.pool, requestId, { weiboProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.hashVerified, true)
    assert.equal(result.archive.projection.state, 'request_snapshot_unavailable')
    assert.equal(result.archive.projection.targetSource, 'saved_request_snapshot')
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('Weibo archive integrity is checked before invoking any candidate parser', async () => {
  const valid = archive(payload())
  for (const raw of [null, { ...valid, body_sha256: '0'.repeat(64) },
    { ...valid, actual_body_size: valid.body_size + 1 }, { ...valid, body_size: 4194305 }]) {
    let parserCalls = 0
    const h = harness({ raw })
    const result = await inspectPostCommentContract(h.pool, requestId, { weiboProjectionValidator() { parserCalls++; throw new Error('must not parse') } })
    assert.equal(parserCalls, 0)
    assert.equal(result.verified, false)
    assert.equal(result.archive.projection, undefined)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('Weibo verification requires exactly one successful billed matching native call before archive reads', async () => {
  for (const changes of [
    { usage: { platform: 'twitter' } }, { usage: { status: 'released' } }, { usage: { response_status: 502 } },
    { count: 0 }, { count: 2 }, { call: { billed: null } }, { call: { billed: false } },
    { call: { outcome: 'unknown' } }, { call: { http_status: 400 } }, { call: { business_code: 400 } },
    { call: { endpoint_key: 'native.t.api_ac75edddcf5bb304' } },
    { call: { operation: 'native.t.api_ac75edddcf5bb304' } },
    { call: { contract_version: 'mx-insight-hub.post-comments.v1' } },
    { call: { marketplace: 'twitter' } },
    { call: { provider_key: 'justone', endpoint_key: 'native.j.api_19390f4ea0fef847' } },
  ]) {
    const h = harness(changes)
    await assert.rejects(verify(h.pool), /weibo_projection_source_unavailable/u)
    assert.equal(h.queries.some(row => row.sql.includes(':weibo-request') || row.sql.includes(':archive')), false)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
  assert.equal((await verify(harness({ usage: { platform: 'weibo' } }).pool)).verified, true)
})

test('Weibo saved continuation is compared without emitting or reusing a repeated token', async () => {
  const token = '987654321012345670'
  const saved = payload()
  saved.params.max_id = token
  saved.data.max_id = token
  const h = harness({ raw: archive(saved), snapshots: [{ acquisition_request: snapshot({
    body: { params: { id: postId, count: 20, max_id: token }, deliveryMode: 'live_only' },
  }) }] })
  let continuationSeen
  const result = await inspectPostCommentContract(h.pool, requestId, { weiboProjectionValidator(raw, target, continuation) {
    continuationSeen = continuation
    return parseTikHubWeiboCommentPage(raw, target, continuation)
  } })
  assert.deepEqual(continuationSeen, { max_id: token })
  assert.equal(result.verified, true)
  assert.equal(result.archive.projection.pagination.hasMore, null)
  assert.equal(result.archive.projection.pagination.continuationAvailable, false)
  assert.equal(result.archive.projection.pagination.stopReason, 'continuation_unproven')
  assert.equal(result.archive.projection.pagination.cursorState, 'repeated')
  assert.equal(JSON.stringify(result).includes(token), false)
})

test('Weibo pagination distinguishes empty terminal text from zero, missing and unsafe numeric values', async () => {
  for (const cursor of [0, '0', null, undefined, 9007199254740992]) {
    const saved = payload()
    if (cursor === undefined) delete saved.data.max_id
    else saved.data.max_id = cursor
    const result = await verify(harness({ raw: archive(saved) }).pool)
    assert.equal(result.verified, true)
    assert.equal(result.archive.projection.pagination.hasMore, null)
    assert.equal(result.archive.projection.pagination.continuationAvailable, false)
    assert.equal(result.archive.projection.pagination.stopReason, 'continuation_unproven')
    assert.equal(typeof result.archive.projection.pagination.cursorState, 'string')
  }
  const saved = payload(); saved.data.max_id = ''
  const ended = await verify(harness({ raw: archive(saved) }).pool)
  assert.equal(ended.verified, true)
  assert.equal(ended.archive.projection.pagination.hasMore, false)
  assert.equal(ended.archive.projection.pagination.continuationAvailable, false)
})

test('Weibo projection rejects mixed modes and invalid validators before connecting', async () => {
  for (const options of [{ weiboProjectionValidator: true },
    { weiboProjectionValidator: parseTikHubWeiboCommentPage, twitterProjectionValidator: parseTikHubTwitterCommentPage },
    { weiboProjectionValidator: parseTikHubWeiboCommentPage, redditProjectionValidator: parseTikHubRedditCommentPage },
    { weiboProjectionValidator: parseTikHubWeiboCommentPage, kuaishouProjectionValidator: parseTikHubKuaishouCommentPage },
    { weiboProjectionValidator: parseTikHubWeiboCommentPage, twitterPostId: '2117082385997250767' },
    { weiboProjectionValidator: parseTikHubWeiboCommentPage, twitterPostId: '2117082385997250767', prepareTwitterConversation: true }]) {
    await assert.rejects(inspectPostCommentContract({ connect() { throw new Error('must not connect') } }, requestId, options), /invalid_arguments/u)
  }
})

test('standalone Weibo inspection requires its parser and validates modes before any database connection', async () => {
  const inspector = await readFile(new URL('../../server/ops/inspect-post-comment-contract.mjs', import.meta.url), 'utf8')
  const parser = await readFile(new URL('../../server/contracts/weibo-comment-page.mjs', import.meta.url), 'utf8')
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
  assert.deepEqual(invoke(inspector, ['--verify-weibo-projection']), { error: 'weibo_projection_parser_required' })
  assert.deepEqual(invoke(`${redditParser}\n${inspector}`, ['--verify-weibo-projection']), { error: 'weibo_projection_parser_required' })
  const combined = `${parser}\n${inspector}`
  assert.deepEqual(invoke(combined, ['--verify-weibo-projection']), { error: 'database_url_required' })
  assert.deepEqual(invoke(`${redditParser}\n${combined}`, ['--verify-reddit-projection']), { error: 'database_url_required' })
  for (const args of [['--verify-weibo-projection', postId],
    ['--verify-weibo-projection', '--verify-reddit-projection'],
    ['--twitter-post-id', '2117082385997250767', '--verify-weibo-projection']]) {
    assert.deepEqual(invoke(combined, args), { error: 'invalid_arguments' })
  }
})
