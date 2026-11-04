import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, lstat, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { normalizeNativeForwardingRequest } from '../../server/contracts/native-forwarding.mjs'
import { WEIBO_SEARCH_NATIVE_KEY, WEIBO_COMMENT_NATIVE_KEY, WEIBO_SEARCH_BODY,
  selectWeiboCommentTarget, prepareWeiboCommentSample, runWeiboSearchProbe, runWeiboCommentProbe,
  inspectWeiboCommentSearch, summarizeWeiboSearchCandidates, prepareWeiboZeroCountCommentSample }
  from '../../server/ops/probe-weibo-comments.mjs'

const sourceId = 'cb500094-3a50-4945-9a0e-cc753f48a210'
const commentId = 'ce82b784-6627-437b-8a60-dd8fd491f709'
const correlationId = '861ee7b2-58a4-4844-9857-c1290ff774f0'
const callId = '2d39fb28-67c5-4e11-9199-1503ab65042a'
const sourceKey = 'weibo-comment-search-v1-29aa1017-6bf2-4dd6-b53b-b84330c216ff'
const postId = '12345678901234567890'
const apiKey = `mih_live_012345abcdef_${'a'.repeat(43)}`
const origin = 'http://127.0.0.1:18150'
const searchPath = `/api/v1/data/native/${WEIBO_SEARCH_NATIVE_KEY}`
const commentPath = `/api/v1/data/native/${WEIBO_COMMENT_NATIVE_KEY}`
const searchOperation = `native.${WEIBO_SEARCH_NATIVE_KEY}`
const commentOperation = `native.${WEIBO_COMMENT_NATIVE_KEY}`
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const searchBodySha = sha(JSON.stringify(WEIBO_SEARCH_BODY))
const capabilities = () => ({ data: { platforms: [{ platform: 'weibo' }], capabilities: [
  { capability: searchOperation, ready: true }, { capability: commentOperation, ready: true },
] } })
const noHttp = () => assert.fail('No HTTP is permitted in this test')
const searchPayload = (rows = [{ weibo_id: postId, comments_count: 12, content: 'private source text' }]) =>
  ({ code: 200, data: { parsed_data: { results: rows, parse_success: true, pagination: { has_next_page: true } } } })
const response = (body = searchPayload(), { status = 200, requestId = sourceId, headers = {} } = {}) =>
  Response.json(body, { status, headers: { ...(requestId ? { 'x-mx-insight-request-id': requestId } : {}), ...headers } })
const originalReceipt = () => ({ revision: 'weibo-comment-search-probe.v1', provider: 'tikhub', platform: 'weibo',
  path: searchPath, state: 'http_response', httpStatus: 200, hubRequestsMade: 1, requestIdSource: 'usage_header',
  requestId: sourceId, idempotencyKey: sourceKey, bodySha256: searchBodySha })
const sample = () => ({ revision: 'weibo-comment-target-sample.v1', platform: 'weibo', provider: 'tikhub',
  sourceRequestId: sourceId, sourceIdempotencyKey: sourceKey, sourceBodySha256: searchBodySha,
  postId, commentCount: 12, searchItemCount: 1, candidateCount: 1 })
const zeroSample = () => ({ ...sample(), revision: 'weibo-comment-target-sample.v2', commentCount: 0,
  selectionBasis: 'verified_zero_count_search' })

async function fixture(t, { withSearch = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'weibo-comment-probe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const receipts = join(directory, '.hub-comment-contract-probes-v1')
  await mkdir(receipts)
  const originals = ['twitter.json', 'twitter.unified-acceptance.json', 'reddit.json',
    'reddit.unified-acceptance.json', 'kuaishou.json', 'kuaishou.app.json', 'kuaishou.unified-acceptance.json']
  for (const name of originals) await writeFile(join(receipts, name), `immutable-${name}`)
  const searchMarker = join(receipts, 'weibo.search.json'), commentMarker = join(receipts, 'weibo.comments.json')
  if (withSearch) await writeFile(searchMarker, JSON.stringify(originalReceipt()), { mode: 0o600 })
  return { directory, receipts, searchMarker, commentMarker, originals,
    searchInput: { sampleDirectory: directory, apiKey, apply: true },
    commentInput: { sample: sample(), sampleDirectory: directory, apiKey, apply: true } }
}

function database({ usages, calls, archives, payload = searchPayload(), failAt, rollbackFail = false } = {}) {
  const bytes = Buffer.from(JSON.stringify(payload))
  const usage = { id: sourceId, idempotency_key: sourceKey, platform: 'social', status: 'committed', response_status: 200,
    acquisition_request: { method: 'POST', path: searchPath, body: structuredClone(WEIBO_SEARCH_BODY) } }
  const call = { id: callId, provider_key: 'tikhub', marketplace: 'weibo', operation: searchOperation,
    endpoint_key: searchOperation, contract_version: 'mx-insight-hub.native-forwarding.v1',
    outcome: 'succeeded', http_status: 200, business_code: 200, billed: true }
  const archive = { body_size: bytes.length, actual_body_size: bytes.length,
    body_sha256: sha(bytes), body_bytes: bytes }
  const statements = []; let releases = 0
  return { usage, call, archive, statements, get releases() { return releases }, pool: { async connect() { return {
    async query(sql, values) {
      statements.push({ sql, values })
      if (failAt && sql.includes(failAt)) throw new Error(`private database failure ${apiKey}`)
      if (sql === 'ROLLBACK' && rollbackFail) throw new Error('rollback failed')
      if (sql.includes('weibo-comment-sample:usage')) return { rows: usages ?? [usage] }
      if (sql.includes('weibo-comment-sample:calls')) return { rows: calls ?? [call] }
      if (sql.includes('weibo-comment-sample:archive')) return { rows: archives ?? [archive] }
      return { rows: [] }
    }, release() { releases++ },
  } } } }
}

test('fixed first-page search and comment requests are accepted by the registered native contracts', () => {
  const search = normalizeNativeForwardingRequest(WEIBO_SEARCH_NATIVE_KEY, WEIBO_SEARCH_BODY)
  assert.equal(search.endpointPath, '/api/v1/weibo/web_v2/fetch_advanced_search')
  assert.deepEqual(WEIBO_SEARCH_BODY, { params: { q: '科技', search_type: 'hot', include_type: 'all', page: 1 }, deliveryMode: 'live_only' })
  const comment = normalizeNativeForwardingRequest(WEIBO_COMMENT_NATIVE_KEY,
    { params: { id: postId, count: 20 }, deliveryMode: 'live_only' })
  assert.equal(comment.endpointPath, '/api/v1/weibo/web_v2/fetch_post_comments')
  assert.equal(comment.upstreamQuery.id, postId)
})

test('search target selection uses observed positive comments and preserves long string IDs exactly', () => {
  const rows = [
    { weibo_id: '100', comments_count: 0 },
    { idstr: '101', comment_count: '5' },
    { id: 102, interaction: { comment_count: 3 } },
    { weibo_id: postId, comments_count: 12, comments: [{ text: 'preview is not a comment acquisition' }] },
    { id: 10000000000000000, comments_count: 100 },
  ]
  const chosen = selectWeiboCommentTarget(searchPayload(rows))
  assert.equal(chosen.postId, postId)
  assert.equal(chosen.commentCount, 12)
  assert.equal(chosen.searchItemCount, rows.length)
  assert.equal(chosen.candidateCount, 3)
})

test('empty, zero, invalid and unsafe identities never become targets; nested reply previews are not searched', () => {
  for (const rows of [[], [{ weibo_id: postId, comments_count: 0 }],
    [{ weibo_id: postId, comments_count: -1 }], [{ weibo_id: postId, comments_count: true }],
    [{ weibo_id: postId, comments_count: '1万' }], [{ weibo_id: postId, comments_count: Number.POSITIVE_INFINITY }],
    [{ id: 10000000000000000, comments_count: 12 }], [{ weibo_id: 'base62X', comments_count: 12 }],
    [{ weibo_id: postId, comments_count: 0, comments: [{ id: '900', comments_count: 10 }] }]]) {
    assert.throws(() => selectWeiboCommentTarget(searchPayload(rows)), /no_positive_comment_target/u)
  }
  for (const payload of [null, { code: 400, data: { parsed_data: { results: [] } } },
    { code: 200, data: { results: [] } }, searchPayload({}), searchPayload(Array(1001).fill({ weibo_id: postId, comments_count: 1 }))]) {
    assert.throws(() => selectWeiboCommentTarget(payload), /invalid_search_response/u)
  }
})

test('an explicitly failed search parse cannot contribute residual positive targets, and explicit zero wins over later aliases', () => {
  const failed = searchPayload([{ weibo_id: postId, comments_count: 12 }])
  failed.data.parsed_data.parse_success = false
  assert.throws(() => selectWeiboCommentTarget(failed), /invalid_search_response/u)
  assert.throws(() => selectWeiboCommentTarget(searchPayload([
    { weibo_id: postId, comments_count: 0, comment_count: 900, interaction: { comment_count: 900 } },
    { weibo_id: '101', comment_count: '0', interaction: { comment_count: 500 } },
    { weibo_id: 10000000000000000, idstr: postId, comments_count: 100 },
  ])), /no_positive_comment_target/u)
})

test('search diagnostics distinguish an empty page from zero, missing and unrecognized comment counts', () => {
  const empty = summarizeWeiboSearchCandidates(searchPayload([]))
  assert.equal(empty.inputRowCount, 0)
  assert.equal(empty.eligibleCandidateCount, 0)
  assert.deepEqual(empty.selectedMetricStates, { positive: 0, zero: 0, missing: 0, unrecognized: 0 })
  const result = summarizeWeiboSearchCandidates(searchPayload([
    { weibo_id: postId, comments_count: 0 },
    { weibo_id: '101' },
    { weibo_id: '102', comments_count: '1.2万' },
    { weibo_id: '103', comments_count: '1,200' },
    { weibo_id: '104', comments_count: '评论' },
    null,
  ]))
  assert.equal(result.inputRowCount, 6)
  assert.equal(result.objectRowCount, 5)
  assert.equal(result.validIdentityCount, 5)
  assert.equal(result.eligibleCandidateCount, 0)
  assert.deepEqual(result.selectedMetricStates, { positive: 0, zero: 1, missing: 1, unrecognized: 3 })
  assert.deepEqual(result.fields.find(row => row.path === 'comments_count').states,
    { zero: 1, missing: 1, compact_numeric_text: 1, grouped_integer_text: 1, count_label: 1 })
})

test('diagnostics preserve selector identity and zero precedence rather than promoting alternate fields', () => {
  const rows = [
    { weibo_id: 10000000000000000, idstr: postId, comments_count: 37 },
    { weibo_id: 'base62X', comments_count: 12 },
    { weibo_id: '101', comments_count: 0, comment_count: 37 },
    { weibo_id: '102', comment_count: '0', interaction: { comments: 37 } },
    { weibo_id: postId, interaction: { comment_count: '5' } },
  ]
  const result = summarizeWeiboSearchCandidates(searchPayload(rows))
  assert.equal(result.validIdentityCount, 3)
  assert.equal(result.positiveMetricInvalidIdentityCount, 2)
  assert.equal(result.eligibleCandidateCount, 1)
  assert.deepEqual(result.selectedMetricStates, { positive: 3, zero: 2, missing: 0, unrecognized: 0 })
  assert.equal(result.eligibleCandidateCount, selectWeiboCommentTarget(searchPayload(rows)).candidateCount)
})

test('search diagnostic fields expose only allowlisted types and fixed classifications', () => {
  const privateText = 'PRIVATE_SEARCH_TEXT_27501'
  const privateKey = 'PRIVATE_SEARCH_KEY_27502'
  const result = summarizeWeiboSearchCandidates(searchPayload([
    { weibo_id: postId, comments_count: '1.2万', content: privateText,
      url: 'https://weibo.com/private-account/private-post', [privateKey]: apiKey,
      user: { name: 'PRIVATE_AUTHOR_27503' }, interaction: { comments: 0 } },
    { id: 10000000000000000, comments_count: 0, comments: [{ text: privateText }] },
  ]))
  const field = path => result.fields.find(row => row.path === path)
  assert.equal(field('weibo_id').types.string, 1)
  assert.equal(field('id').types.unsafe_number, 1)
  assert.equal(field('comments_count').types.string, 1)
  assert.equal(field('comments_count').types.safe_integer, 1)
  assert.deepEqual(field('comments_count').states, { compact_numeric_text: 1, zero: 1 })
  assert.equal(field('interaction.comments').types.safe_integer, 1)
  const output = JSON.stringify(result)
  for (const value of [postId, privateText, privateKey, apiKey, 'PRIVATE_AUTHOR_27503',
    'private-account', 'private-post', '10000000000000000', '1.2万']) assert.equal(output.includes(value), false)
})

test('search diagnostics reject failed, oversized and non-array result envelopes', () => {
  const failed = searchPayload([{ weibo_id: postId, comments_count: 12 }])
  failed.data.parsed_data.parse_success = false
  for (const payload of [null, failed, { code: 500, data: { parsed_data: { results: [] } } },
    { code: 200, data: { results: [] } }, searchPayload({}), searchPayload(Array(1001).fill({}))]) {
    assert.throws(() => summarizeWeiboSearchCandidates(payload), /invalid_search_response/u)
  }
})

test('saved search inspection verifies the paid archive even when no positive target exists and never calls HTTP', async t => {
  const fetched = t.mock.method(globalThis, 'fetch', noHttp)
  const db = database({ payload: searchPayload([{ weibo_id: postId, comments_count: 0 }]) })
  const result = await inspectWeiboCommentSearch(db.pool, originalReceipt())
  assert.equal(result.revision, 'weibo-comment-search-inspection.v1')
  assert.equal(result.requestId, sourceId)
  assert.equal(result.verified, true)
  assert.deepEqual(result.archive, { state: 'archive_verified', hashVerified: true, byteLength: db.archive.body_size })
  assert.equal(result.selection.eligibleCandidateCount, 0)
  assert.equal(result.selection.selectedMetricStates.zero, 1)
  assert.equal(result.supplierHttpCallsMade, 0)
  assert.equal(result.databaseWritesMade, 0)
  assert.equal(fetched.mock.callCount(), 0)
  assert.match(db.statements[0].sql, /READ ONLY/u)
  assert.ok(db.statements.every(({ sql }) => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(sql)))
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(db.releases, 1)
  assert.equal(JSON.stringify(result).includes(postId), false)
})

test('saved search inspection cannot bypass exact receipt, successful-call or archive integrity gates', async () => {
  const base = database()
  await assert.rejects(inspectWeiboCommentSearch(database().pool,
    { ...originalReceipt(), idempotencyKey: 'weibo-comment-search-v1-00000000-0000-4000-8000-000000000000' }))
  for (const patch of [
    { usages: [{ ...base.usage, acquisition_request: { method: 'POST', path: commentPath, body: WEIBO_SEARCH_BODY } }] },
    { calls: [{ ...base.call, billed: null }] },
    { calls: [base.call, base.call] },
    { archives: [{ ...base.archive, body_sha256: '0'.repeat(64) }] },
    { archives: [{ ...base.archive, body_size: base.archive.body_size + 1 }] },
    { failAt: 'weibo-comment-sample:archive' },
    { rollbackFail: true },
  ]) {
    const db = database(patch)
    await assert.rejects(inspectWeiboCommentSearch(db.pool, originalReceipt()))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.releases, 1)
  }
})

test('read-only search inspection leaves successful and previous platform receipts intact', async t => {
  const f = await fixture(t, { withSearch: true })
  const before = await readFile(f.searchMarker)
  await inspectWeiboCommentSearch(database().pool, JSON.parse(before.toString('utf8')))
  assert.deepEqual(await readFile(f.searchMarker), before)
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
  for (const name of f.originals) assert.equal(await readFile(join(f.receipts, name), 'utf8'), `immutable-${name}`)
})

test('source preparation binds the successful paid search request, call and full verified archive without HTTP or writes', async t => {
  const fetched = t.mock.method(globalThis, 'fetch', noHttp)
  const db = database()
  assert.deepEqual(await prepareWeiboCommentSample(db.pool, originalReceipt()), sample())
  assert.equal(fetched.mock.callCount(), 0)
  assert.match(db.statements[0].sql, /READ ONLY/u)
  assert.ok(db.statements.some(({ sql }) => /statement_timeout/u.test(sql)))
  assert.ok(db.statements.every(({ sql }) => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(sql)))
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(db.releases, 1)
  for (const name of ['usage', 'calls', 'archive']) {
    const read = db.statements.find(({ sql }) => sql.includes(`weibo-comment-sample:${name}`))
    assert.ok(read, name)
    assert.ok(read.values.includes(name === 'archive' ? callId : sourceId), name)
  }
})

test('preparation refuses receipt substitution, mutable snapshots, ambiguous calls and corrupted or missing bytes', async () => {
  const base = database()
  for (const patch of [{ revision: 'other' }, { provider: 'justone' }, { platform: 'twitter' }, { path: commentPath },
    { state: 'outcome_unknown' }, { httpStatus: 401 }, { hubRequestsMade: 0 }, { requestIdSource: 'error_details' },
    { requestId: 'not-uuid' }, { idempotencyKey: 'other' }, { bodySha256: '0'.repeat(64) }]) {
    await assert.rejects(prepareWeiboCommentSample(database().pool, { ...originalReceipt(), ...patch }))
  }
  for (const changes of [
    { usages: [] }, { usages: [base.usage, base.usage] }, { calls: [] }, { calls: [base.call, base.call] },
    ...[{ id: commentId }, { idempotency_key: 'other' }, { platform: 'weibo' }, { status: 'released' },
      { response_status: 502 }, { acquisition_request: null },
      { acquisition_request: { method: 'POST', path: commentPath, body: WEIBO_SEARCH_BODY } },
      { acquisition_request: { method: 'POST', path: searchPath,
        body: { ...WEIBO_SEARCH_BODY, params: { ...WEIBO_SEARCH_BODY.params, page: 2 } } } },
    ].map(patch => ({ usages: [{ ...base.usage, ...patch }] })),
    ...[{ provider_key: 'justone' }, { marketplace: 'twitter' }, { operation: commentOperation },
      { endpoint_key: commentOperation }, { contract_version: 'other' }, { outcome: 'unknown' },
      { http_status: 502 }, { business_code: 400 }, { billed: false }, { billed: null }]
      .map(patch => ({ calls: [{ ...base.call, ...patch }] })),
    { archives: [] }, { archives: [base.archive, base.archive] },
    ...[{ body_sha256: '0'.repeat(64) }, { body_size: 4194305 }, { actual_body_size: 1 }, { body_bytes: null }]
      .map(patch => ({ archives: [{ ...base.archive, ...patch }] })),
    { failAt: 'weibo-comment-sample:archive' }, { rollbackFail: true },
  ]) {
    const db = database(changes)
    await assert.rejects(prepareWeiboCommentSample(db.pool, originalReceipt()))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.releases, 1)
  }
})

test('a verified but empty search archive stops preparation rather than manufacturing a positive comment target', async () => {
  const db = database({ payload: searchPayload([{ weibo_id: postId, comments_count: 0 }]) })
  await assert.rejects(prepareWeiboCommentSample(db.pool, originalReceipt()), /no_positive_comment_target/u)
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
})

test('explicit zero-count preparation preserves the first verified search identity and all saved zero metrics', async t => {
  const fetched = t.mock.method(globalThis, 'fetch', noHttp)
  const rows = [postId, '999', '101', '998', '102', '997', '103', '996']
    .map(weibo_id => ({ weibo_id, interaction: { comment_count: 0 }, content: 'private source text' }))
  const db = database({ payload: searchPayload(rows) })
  const result = await prepareWeiboZeroCountCommentSample(db.pool, originalReceipt())
  assert.deepEqual(result, { ...zeroSample(), searchItemCount: 8, candidateCount: 8 })
  assert.equal(result.postId, rows[0].weibo_id)
  assert.equal(result.commentCount, 0)
  assert.equal(fetched.mock.callCount(), 0)
  assert.match(db.statements[0].sql, /READ ONLY/u)
  assert.ok(db.statements.every(({ sql }) => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(sql)))
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(db.releases, 1)
})

test('zero-count preparation requires every saved row to have a valid selected identity and an actual selected zero', async () => {
  const valid = { weibo_id: postId, interaction: { comment_count: 0 } }
  const cases = [[], [valid, null], [valid, {}], [valid, { weibo_id: 'base62X', comments_count: 0 }],
    [valid, { weibo_id: 10000000000000000, idstr: postId, comments_count: 0 }],
    [valid, { weibo_id: '101' }], [valid, { weibo_id: '101', comments_count: '评论' }],
    [valid, { weibo_id: '101', comments_count: -1 }], [valid, { weibo_id: '101', comments_count: 1 }],
    Array(1001).fill(valid)]
  for (const rows of cases) {
    const db = database({ payload: searchPayload(rows) })
    await assert.rejects(prepareWeiboZeroCountCommentSample(db.pool, originalReceipt()))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  }
  const failed = searchPayload([valid])
  failed.data.parsed_data.parse_success = false
  await assert.rejects(prepareWeiboZeroCountCommentSample(database({ payload: failed }).pool, originalReceipt()))
})

test('explicit zero-count selection retains the exact successful-call and full archive evidence gates', async () => {
  const payload = searchPayload([{ weibo_id: postId, interaction: { comment_count: 0 } }])
  const base = database({ payload })
  await assert.rejects(prepareWeiboZeroCountCommentSample(base.pool, { ...originalReceipt(), bodySha256: '0'.repeat(64) }))
  assert.equal(base.statements.length, 0)
  for (const patch of [
    { usages: [{ ...base.usage, idempotency_key: 'different' }] },
    { calls: [{ ...base.call, billed: null }] },
    { calls: [base.call, base.call] },
    { archives: [{ ...base.archive, body_sha256: '0'.repeat(64) }] },
    { archives: [{ ...base.archive, actual_body_size: base.archive.body_size + 1 }] },
    { failAt: 'weibo-comment-sample:archive' }, { rollbackFail: true },
  ]) {
    const db = database({ payload, ...patch })
    await assert.rejects(prepareWeiboZeroCountCommentSample(db.pool, originalReceipt()))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.releases, 1)
  }
})

test('the existing positive-count preparation and v1 probe cannot silently opt into the zero-count mode', async t => {
  const db = database({ payload: searchPayload([{ weibo_id: postId, interaction: { comment_count: 0 } }]) })
  await assert.rejects(prepareWeiboCommentSample(db.pool, originalReceipt()), /no_positive_comment_target/u)
  const f = await fixture(t, { withSearch: true })
  for (const value of [{ ...sample(), commentCount: 0 },
    { ...zeroSample(), revision: 'weibo-comment-target-sample.v1' },
    { ...sample(), selectionBasis: 'verified_zero_count_search' }]) {
    await assert.rejects(runWeiboCommentProbe({ ...f.commentInput, sample: value }, { fetchImpl: noHttp }))
  }
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
})

test('v2 zero-count samples reject altered basis, count, identities, cardinality and receipt lineage before HTTP', async t => {
  const f = await fixture(t, { withSearch: true })
  for (const patch of [{ selectionBasis: undefined }, { selectionBasis: 'identity_only' },
    { commentCount: 1 }, { commentCount: null }, { commentCount: '0' }, { postId: 123 },
    { searchItemCount: 0 }, { searchItemCount: 1001 }, { searchItemCount: 2, candidateCount: 1 },
    { candidateCount: 0 }, { sourceRequestId: commentId }, { sourceIdempotencyKey: 'different' },
    { sourceBodySha256: '0'.repeat(64) }, { cursor: 'private-cursor' }]) {
    await assert.rejects(runWeiboCommentProbe({ ...f.commentInput, sample: { ...zeroSample(), ...patch } }, { fetchImpl: noHttp }))
  }
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
})

test('zero-count comments use the same remaining one-page slot without resending search or supplier metric fields', async t => {
  const f = await fixture(t, { withSearch: true }), originalBytes = await readFile(f.searchMarker)
  const input = { ...f.commentInput, sample: zeroSample() }
  const preview = await runWeiboCommentProbe({ ...input, apiKey: null, apply: false }, { fetchImpl: noHttp })
  assert.equal(preview.state, 'preview')
  assert.equal(preview.selectionBasis, 'verified_zero_count_search')
  let gets = 0, posts = 0
  const result = await runWeiboCommentProbe(input, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') { gets++; return response(capabilities()) }
    posts++
    assert.equal(url, `${origin}${commentPath}`)
    assert.deepEqual(JSON.parse(options.body), { params: { id: postId, count: 20 }, deliveryMode: 'live_only' })
    const marker = JSON.parse(await readFile(f.commentMarker, 'utf8'))
    assert.equal(marker.state, 'dispatch_started')
    assert.equal(marker.sourceRequestId, sourceId)
    assert.equal(marker.selectionBasis, 'verified_zero_count_search')
    return response({ code: 200, data: { comments: [] } }, { requestId: commentId })
  } })
  assert.equal(gets, 1); assert.equal(posts, 1)
  assert.equal(result.selectionBasis, 'verified_zero_count_search')
  assert.equal(result.hubRequestsMade, 1)
  assert.equal(result.requestId, commentId)
  assert.deepEqual(await readFile(f.searchMarker), originalBytes)
  for (const old of f.originals) assert.equal(await readFile(join(f.receipts, old), 'utf8'), `immutable-${old}`)
  for (const output of [JSON.stringify(result), await readFile(f.commentMarker, 'utf8')]) {
    for (const value of [postId, apiKey, 'private source text']) assert.equal(output.includes(value), false)
  }
  for (const next of [input, f.commentInput]) {
    assert.equal((await runWeiboCommentProbe(next, { fetchImpl: noHttp })).state, 'already_attempted')
  }
  assert.equal((await runWeiboSearchProbe(f.searchInput, { fetchImpl: noHttp })).state, 'already_attempted')
})

test('concurrent v1 and zero-count v2 probes share the same exclusive comment marker', async t => {
  const f = await fixture(t, { withSearch: true })
  let posts = 0
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response(capabilities())
    assert.equal(url, `${origin}${commentPath}`)
    posts++
    return response({}, { requestId: commentId })
  }
  const results = await Promise.all([
    runWeiboCommentProbe(f.commentInput, { fetchImpl }),
    runWeiboCommentProbe({ ...f.commentInput, sample: zeroSample() }, { fetchImpl }),
  ])
  assert.equal(posts, 1)
  assert.equal(results.filter(row => row.state === 'http_response').length, 1)
  assert.equal(results.filter(row => row.state === 'already_attempted').length, 1)
})

test('verified archive bytes still require valid UTF-8, JSON, successful parsing and a bounded response', async () => {
  const failedParse = searchPayload()
  failedParse.data.parsed_data.parse_success = false
  for (const bytes of [Buffer.from('{'), Buffer.from([0xff, 0xfe]), Buffer.from(JSON.stringify(failedParse)),
    Buffer.alloc(4194305, 32)]) {
    const db = database({ archives: [{ body_bytes: bytes, body_size: bytes.length,
      actual_body_size: bytes.length, body_sha256: sha(bytes) }] })
    await assert.rejects(prepareWeiboCommentSample(db.pool, originalReceipt()))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.releases, 1)
  }
})

test('previews make no HTTP or new markers and comment preview requires the successful source receipt', async t => {
  const f = await fixture(t, { withSearch: true })
  const search = await fixture(t)
  const a = await runWeiboSearchProbe({ ...search.searchInput, apiKey: null, apply: false }, { fetchImpl: noHttp })
  const b = await runWeiboCommentProbe({ ...f.commentInput, apiKey: null, apply: false }, { fetchImpl: noHttp })
  for (const result of [a, b]) { assert.equal(result.state, 'preview'); assert.equal(result.hubRequestsMade, 0) }
  await assert.rejects(lstat(search.searchMarker), { code: 'ENOENT' })
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
  await rm(f.searchMarker)
  await assert.rejects(runWeiboCommentProbe({ ...f.commentInput, apply: false }, { fetchImpl: noHttp }))
})

test('every existing stage marker, including malformed files and dangling symlinks, blocks all HTTP', async t => {
  for (const stage of ['search', 'comments']) for (const kind of ['empty', 'malformed', 'directory', 'dangling_symlink']) {
    const f = await fixture(t, { withSearch: stage === 'comments' })
    const marker = stage === 'search' ? f.searchMarker : f.commentMarker
    if (kind === 'directory') await mkdir(marker)
    else if (kind === 'dangling_symlink') await symlink(join(f.directory, 'absent'), marker)
    else await writeFile(marker, kind === 'empty' ? '' : '{')
    const run = stage === 'search' ? runWeiboSearchProbe : runWeiboCommentProbe
    const input = stage === 'search' ? f.searchInput : f.commentInput
    const result = await run({ ...input, apiKey: null, sample: null }, { fetchImpl: noHttp })
    assert.equal(result.state, 'already_attempted')
    assert.equal(result.hubRequestsMade, 0)
    assert.equal(result.preflightRequestsMade, 0)
  }
})

test('an existing comment-stage marker cannot be bypassed by losing or changing the search receipt', async t => {
  const f = await fixture(t)
  await writeFile(f.commentMarker, JSON.stringify({ state: 'dispatch_started' }))
  const result = await runWeiboSearchProbe(f.searchInput, { fetchImpl: noHttp })
  assert.equal(result.state, 'already_attempted')
  assert.equal(result.hubRequestsMade, 0)
})

test('invalid Live Keys and unavailable authorization stop before any paid marker', async t => {
  for (const stage of ['search', 'comments']) {
    const f = await fixture(t, { withSearch: stage === 'comments' })
    const run = stage === 'search' ? runWeiboSearchProbe : runWeiboCommentProbe
    const input = stage === 'search' ? f.searchInput : f.commentInput
    const marker = stage === 'search' ? f.searchMarker : f.commentMarker
    for (const key of ['', 'provider-secret', apiKey.replace('live', 'test'), `${apiKey}\n`]) {
      await assert.rejects(run({ ...input, apiKey: key }, { fetchImpl: noHttp }))
    }
    for (const mutate of [data => { data.capabilities.shift() }, data => { data.capabilities.pop() },
      data => { data.capabilities[0].ready = false }, data => { data.capabilities[1].ready = false }]) {
      const body = capabilities(); mutate(body.data); let gets = 0
      const result = await run(input, { fetchImpl: async (url, options) => {
        gets++; assert.equal(url, `${origin}/api/v1/data/capabilities`); assert.equal(options.method, 'GET')
        return response(body)
      } })
      assert.equal(result.state, 'preflight_rejected'); assert.equal(result.hubRequestsMade, 0); assert.equal(gets, 1)
      await assert.rejects(lstat(marker), { code: 'ENOENT' })
    }
    const unavailable = await run(input, { fetchImpl: async () => { throw new Error(apiKey) } })
    assert.equal(unavailable.state, 'preflight_unavailable')
    assert.equal(JSON.stringify(unavailable).includes(apiKey), false)
  }
})

test('search buys exactly one fixed native page after durable marker and does not autonomously collect comments', async t => {
  const f = await fixture(t); let gets = 0, posts = 0
  const result = await runWeiboSearchProbe(f.searchInput, { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`)
    if (options.method === 'GET') { gets++; return response(capabilities()) }
    posts++; assert.equal(url, `${origin}${searchPath}`)
    assert.deepEqual(JSON.parse(options.body), WEIBO_SEARCH_BODY)
    const before = JSON.parse(await readFile(f.searchMarker, 'utf8'))
    assert.equal(before.state, 'dispatch_started')
    assert.equal(before.bodySha256, searchBodySha)
    assert.equal(before.idempotencyKey, options.headers['idempotency-key'])
    assert.match(before.idempotencyKey, /^weibo-comment-search-v1-[0-9a-f-]{36}$/u)
    assert.equal((await stat(f.searchMarker)).mode & 0o777, 0o600)
    return response()
  } })
  assert.equal(gets, 1); assert.equal(posts, 1)
  assert.equal(result.state, 'http_response'); assert.equal(result.httpStatus, 200)
  assert.equal(result.requestId, sourceId); assert.equal(result.requestIdSource, 'usage_header')
  assert.equal(result.hubRequestsMade, 1)
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
  for (const name of f.originals) assert.equal(await readFile(join(f.receipts, name), 'utf8'), `immutable-${name}`)
  for (const output of [JSON.stringify(result), await readFile(f.searchMarker, 'utf8')]) {
    for (const secret of [apiKey, postId, 'private source text']) assert.equal(output.includes(secret), false)
  }
})

test('comment source substitutions and symlinked receipts fail before HTTP or procurement', async t => {
  const f = await fixture(t, { withSearch: true }), original = originalReceipt()
  for (const patch of [{ revision: 'other' }, { provider: 'justone' }, { platform: 'twitter' },
    { sourceRequestId: commentId }, { sourceIdempotencyKey: 'other' }, { sourceBodySha256: '0'.repeat(64) },
    { postId: 123 }, { postId: 'base62X' }, { commentCount: 0 }, { cursor: 'private-cursor' }]) {
    await assert.rejects(runWeiboCommentProbe({ ...f.commentInput, sample: { ...sample(), ...patch } }, { fetchImpl: noHttp }))
  }
  for (const patch of [{ requestId: commentId }, { idempotencyKey: 'other' }, { bodySha256: '0'.repeat(64) },
    { state: 'outcome_unknown' }, { httpStatus: 401 }, { requestIdSource: 'error_details' }]) {
    await writeFile(f.searchMarker, JSON.stringify({ ...original, ...patch }))
    await assert.rejects(runWeiboCommentProbe(f.commentInput, { fetchImpl: noHttp }))
  }
  const target = join(f.directory, 'private-receipt.json')
  await writeFile(target, JSON.stringify(original)); await rm(f.searchMarker); await symlink(target, f.searchMarker)
  await assert.rejects(runWeiboCommentProbe(f.commentInput, { fetchImpl: noHttp }))
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
})

test('comment probe binds the purchased search target and makes only one explicit first-page native request', async t => {
  const f = await fixture(t, { withSearch: true }), originalBytes = await readFile(f.searchMarker)
  let gets = 0, posts = 0
  const result = await runWeiboCommentProbe(f.commentInput, { fetchImpl: async (url, options) => {
    if (options.method === 'GET') { gets++; return response(capabilities()) }
    posts++; assert.equal(url, `${origin}${commentPath}`)
    const body = JSON.parse(options.body)
    assert.equal(body.deliveryMode, 'live_only'); assert.equal(body.params.id, postId)
    assert.equal(body.params.count, 20); assert.ok(!body.params.max_id)
    const before = JSON.parse(await readFile(f.commentMarker, 'utf8'))
    assert.equal(before.state, 'dispatch_started'); assert.equal(before.sourceRequestId, sourceId)
    assert.equal(before.bodySha256, sha(options.body))
    assert.equal(before.idempotencyKey, options.headers['idempotency-key'])
    assert.match(before.idempotencyKey, /^weibo-comment-native-v1-[0-9a-f-]{36}$/u)
    assert.equal((await stat(f.commentMarker)).mode & 0o777, 0o600)
    return response({ code: 200, data: { comments: [{ text: 'private-comment' }], max_id: 'private-cursor' } }, { requestId: commentId })
  } })
  assert.equal(gets, 1); assert.equal(posts, 1); assert.equal(result.hubRequestsMade, 1)
  assert.equal(result.requestId, commentId); assert.equal(result.requestIdSource, 'usage_header')
  assert.deepEqual(await readFile(f.searchMarker), originalBytes)
  for (const output of [JSON.stringify(result), await readFile(f.commentMarker, 'utf8')]) {
    for (const secret of [apiKey, postId, 'private-comment', 'private-cursor']) assert.equal(output.includes(secret), false)
  }
  assert.equal((await runWeiboCommentProbe(f.commentInput, { fetchImpl: noHttp })).state, 'already_attempted')
})

test('the two-stage flow consumes its own fresh search receipt and verified archive before buying one comment page', async t => {
  const f = await fixture(t)
  const posts = []
  const fetchImpl = async (url, options) => {
    if (options.method === 'GET') return response(capabilities())
    posts.push({ url, body: JSON.parse(options.body) })
    return response({}, { requestId: posts.length === 1 ? sourceId : commentId })
  }
  const searched = await runWeiboSearchProbe(f.searchInput, { fetchImpl })
  const baseline = database()
  const db = database({ usages: [{ ...baseline.usage, idempotency_key: searched.idempotencyKey }] })
  const prepared = await prepareWeiboCommentSample(db.pool, searched)
  assert.equal(prepared.postId, postId)
  assert.equal(prepared.sourceIdempotencyKey, searched.idempotencyKey)
  const comments = await runWeiboCommentProbe({ ...f.commentInput, sample: prepared }, { fetchImpl })
  assert.equal(comments.httpStatus, 200)
  assert.equal(comments.sourceRequestId, searched.requestId)
  assert.equal(posts.length, 2)
  assert.equal(posts[0].url, `${origin}${searchPath}`)
  assert.equal(posts[1].url, `${origin}${commentPath}`)
  assert.equal(posts[1].body.params.id, postId)
  assert.notEqual(comments.idempotencyKey, searched.idempotencyKey)
})

test('successful HTTP without a usage header cannot authorize archive preparation or another paid attempt', async t => {
  const f = await fixture(t)
  let posts = 0
  const result = await runWeiboSearchProbe(f.searchInput, { fetchImpl: async (_url, options) => {
    if (options.method === 'GET') return response(capabilities())
    posts++
    return response({ requestId: correlationId, code: 200, data: searchPayload().data }, { requestId: null })
  } })
  assert.equal(result.httpStatus, 200)
  assert.equal(result.requestId, null)
  const db = database()
  await assert.rejects(prepareWeiboCommentSample(db.pool, result))
  assert.equal(db.statements.length, 0)
  assert.equal((await runWeiboSearchProbe(f.searchInput, { fetchImpl: noHttp })).state, 'already_attempted')
  assert.equal(posts, 1)
  await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
})

test('rejections preserve durable usage identity and unknown outcomes keep the spent marker without retry', async t => {
  for (const stage of ['search', 'comments']) for (const outcome of ['rejected', 'header_priority', 'unknown']) {
    const f = await fixture(t, { withSearch: stage === 'comments' })
    const run = stage === 'search' ? runWeiboSearchProbe : runWeiboCommentProbe
    const input = stage === 'search' ? f.searchInput : f.commentInput
    const marker = stage === 'search' ? f.searchMarker : f.commentMarker
    let posts = 0
    const result = await run(input, { fetchImpl: async (_url, options) => {
      if (options.method === 'GET') return response(capabilities())
      posts++
      if (outcome === 'unknown') throw new Error(`private transport failure ${apiKey}`)
      return response({ requestId: correlationId,
        error: { code: 'external_platform_rejected', details: { requestId: commentId } } },
      { status: 502, requestId: outcome === 'header_priority' ? sourceId : null })
    } })
    assert.equal(posts, 1); assert.equal(result.hubRequestsMade, 1)
    assert.equal(result.state, outcome === 'unknown' ? 'outcome_unknown' : 'http_response')
    if (outcome !== 'unknown') {
      assert.equal(result.requestId, outcome === 'header_priority' ? sourceId : commentId)
      assert.equal(result.requestIdSource, outcome === 'header_priority' ? 'usage_header' : 'error_details')
      assert.notEqual(result.requestId, correlationId)
    }
    assert.equal(JSON.stringify(result).includes(apiKey), false)
    assert.equal(JSON.parse(await readFile(marker, 'utf8')).state, result.state)
    assert.equal((await run(input, { fetchImpl: noHttp })).state, 'already_attempted')
    if (stage === 'search') await assert.rejects(lstat(f.commentMarker), { code: 'ENOENT' })
  }
})

test('concurrent invocations purchase at most one page for either stage', async t => {
  for (const stage of ['search', 'comments']) {
    const f = await fixture(t, { withSearch: stage === 'comments' })
    const run = stage === 'search' ? runWeiboSearchProbe : runWeiboCommentProbe
    const input = stage === 'search' ? f.searchInput : f.commentInput
    let posts = 0
    const fetchImpl = async (_url, options) => {
      if (options.method === 'GET') return response(capabilities())
      posts++
      return response()
    }
    const results = await Promise.all([run(input, { fetchImpl }), run(input, { fetchImpl })])
    assert.equal(posts, 1)
    assert.equal(results.filter(r => r.state === 'http_response').length, 1)
    assert.equal(results.filter(r => r.state === 'already_attempted').length, 1)
  }
})
