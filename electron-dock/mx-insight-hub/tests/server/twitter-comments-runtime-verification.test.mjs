import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { runTwitterCommentsRuntimeVerification } from '../../server/ops/verify-twitter-comments-runtime.mjs'
import { normalizePostCommentsDelivery, postCommentsDeliveryBody } from '../../server/external-platforms/post-comments-workflow.mjs'
import { buildPostCommentsDispatch } from '../../server/contracts/post-comments.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'

const sourceId = '7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b'
const usageId = 'e96391f1-584b-4bc0-99d7-6f97c62da574'
const apiKey = `mih_live_012345abcdef_${'a'.repeat(43)}`
const sample = { revision: 'twitter-conversation-comment-sample.v1', platform: 'twitter',
  sourceRequestId: 'f33e6d06-97f0-46c2-a049-c69ccfabf41d', sourcePostId: '2117082385997250767', postId: '2117082385997250123' }
const nativePath = '/api/v1/data/native/t.api_3cd88a6621a01120'
const publicPath = 'http://127.0.0.1:18150/api/v1/search/post-comments'
const capabilities = () => ({ data: { platforms: [{ platform: 'twitter', ready: false, search: { ready: false } }],
  capabilities: [{ capability: 'social.comments.list', ready: false }, { capability: 'native.t.api_3cd88a6621a01120', ready: true }] } })

async function fixture(t, { authRetry = false } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'twitter-comments-acceptance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const receipts = join(directory, '.hub-comment-contract-probes-v1')
  await mkdir(receipts)
  const base = { revision: 'post-comment-contract-probe.v2', provider: 'tikhub', platform: 'twitter', path: nativePath,
    state: 'http_response', httpStatus: 200, hubRequestsMade: 1, requestIdSource: 'usage_header' }
  const original = { ...base, requestId: sample.sourceRequestId, idempotencyKey: 'comment-calibration-v1-22dabde8-689e-44da-8d91-3b9fbfb574df' }
  const conversation = { ...base, requestId: sourceId, samplePurpose: 'conversation_comments', sourceRequestId: sample.sourceRequestId,
    idempotencyKey: 'comment-calibration-v1-f295c520-f0eb-4eaa-ac11-c4ccdd3358fd' }
  await writeFile(join(receipts, 'twitter.json'), JSON.stringify(authRetry ? { state: 'http_response', httpStatus: 401 } : original))
  if (authRetry) await writeFile(join(receipts, 'twitter.auth-retry.json'), JSON.stringify(original))
  await writeFile(join(receipts, 'twitter.conversation.json'), JSON.stringify(conversation))
  return { receipts, original, conversation, marker: join(receipts, 'twitter.unified-acceptance.json'),
    input: { sampleDirectory: directory, conversationSample: sample, sourceRequestId: sourceId, apiKey, apply: true } }
}

function delivered({ empty = false, buffered = false, cursor = true } = {}) {
  const request = normalizePostCommentsDelivery({ platform: 'twitter', contentId: sample.postId, count: 20, includeRaw: false },
    { context: { consumer: { businessId: 'test' } }, maxPageSize: 100, codec: { encode: () => 'mxds1.private-cursor' } })
  const raw = { code: 200, data: { id: sample.postId, conversation_id: sample.postId,
    cursor: cursor ? 'private-supplier-cursor' : null,
    thread: empty ? [] : [1, 2].map(value => ({ id: String(2117082385997250990n + BigInt(value)),
      conversation_id: sample.postId, text: `private comment ${value}`, created_at: '2026-11-02T01:00:00Z',
      author: { rest_id: '1899000000000000001', name: 'private author' }, likes: 0, replies: 2 })) } }
  const { projected } = projectPostCommentPage(raw, buildPostCommentsDispatch(request), { capturedAt: '2026-11-02T02:00:00Z' })
  return postCommentsDeliveryBody(request, { rowsByJob: [projected.acquiredItems],
    state: { jobs: [{ buffer: buffered ? {} : null, done: !cursor, upstreamPages: 1, duplicateCount: 0 }] }, calls: 1,
    warnings: buffered ? [] : [{ code: 'pagination_completeness_unknown', message: 'upstream does not prove more' }], deliveryId: usageId })
}

function http(body = delivered(), headers = { 'x-mx-insight-request-id': usageId }, status = 200) {
  return Response.json(body, { status, headers })
}

test('preview validates the saved source chain without a Key, HTTP, or acceptance marker', async t => {
  const { input, marker } = await fixture(t, { authRetry: true })
  const result = await runTwitterCommentsRuntimeVerification({ ...input, apiKey: null, apply: false },
    { fetchImpl: () => { throw new Error('HTTP must not run') } })
  assert.equal(result.state, 'preview')
  assert.equal(result.hubRequestsMade, 0)
  assert.equal(result.preflightRequestsMade, 0)
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

test('rejects malformed or unrelated sources before any HTTP', async t => {
  const { input, receipts, conversation } = await fixture(t)
  const fetchImpl = () => assert.fail('HTTP must not run')
  for (const patch of [{ requestId: usageId }, { sourceRequestId: usageId }, { state: 'outcome_unknown' },
    { httpStatus: 401 }, { errorCode: 'private error' }, { provider: 'justone' }, { requestIdSource: 'error_details' },
    { samplePurpose: null }, { idempotencyKey: 'arbitrary' }]) {
    await writeFile(join(receipts, 'twitter.conversation.json'), JSON.stringify({ ...conversation, ...patch }))
    await assert.rejects(runTwitterCommentsRuntimeVerification(input, { fetchImpl }), /source_receipt_unverified/)
  }
  await writeFile(join(receipts, 'twitter.conversation.json'), JSON.stringify(conversation))
  await assert.rejects(runTwitterCommentsRuntimeVerification({ ...input, conversationSample: { ...sample, cursor: 'private' } }, { fetchImpl }), /invalid_sample/)
  await writeFile(join(receipts, 'twitter.auth-retry.json'), '{')
  await assert.rejects(runTwitterCommentsRuntimeVerification(input, { fetchImpl }), /source_receipt_unverified/)
})

test('only issued-format Live Keys pass local validation', async t => {
  const { input } = await fixture(t)
  for (const key of ['', apiKey.replace('live', 'test'), 'supplier-secret', `${apiKey}\n`, 'mih_live_private']) {
    await assert.rejects(runTwitterCommentsRuntimeVerification({ ...input, apiKey: key },
      { fetchImpl: () => assert.fail('HTTP must not run') }), /api_key_required|invalid_api_key/)
  }
})

test('all free readiness refusals stop before POST and do not create a paid marker', async t => {
  const { input, marker } = await fixture(t)
  for (const change of [data => { data.platforms = [] }, data => { data.capabilities.shift() },
    data => { data.capabilities[1].ready = false }, data => { data.capabilities.pop() }]) {
    const body = capabilities(); change(body.data); let calls = 0
    const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.method, 'GET'); return http(body)
    } })
    assert.equal(result.state, 'preflight_rejected'); assert.equal(result.hubRequestsMade, 0); assert.equal(calls, 1)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  }
  const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async () => { throw new Error(apiKey) } })
  assert.equal(result.state, 'preflight_unavailable'); assert.equal(result.hubRequestsMade, 0)
  assert.equal(JSON.stringify(result).includes(apiKey), false)
})

test('one legacy POST uses contentId, a durable new key, and a private redacted receipt', async t => {
  const { input, marker, receipts } = await fixture(t, { authRetry: true })
  const originalBytes = await readFile(join(receipts, 'twitter.auth-retry.json'))
  let calls = 0
  const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`)
    if (calls === 1) { assert.equal(options.method, 'GET'); return http(capabilities()) }
    assert.equal(url, publicPath); assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { platform: 'twitter', contentId: sample.postId, count: 20, includeRaw: false })
    const saved = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(saved.state, 'dispatch_started')
    assert.equal(saved.idempotencyKey, options.headers['idempotency-key'])
    assert.equal(saved.bodySha256, createHash('sha256').update(options.body).digest('hex'))
    assert.equal((await stat(marker)).mode & 0o777, 0o600)
    return http()
  } })
  assert.equal(calls, 2); assert.equal(result.verified, true); assert.equal(result.returnedCount, 2)
  assert.equal(result.requestId, usageId); assert.equal(result.requestIdSource, 'usage_header')
  assert.deepEqual(result.pagination, { hasMore: null, continuationAvailable: true, paginationStatus: 'unknown' })
  assert.deepEqual(await readFile(join(receipts, 'twitter.auth-retry.json')), originalBytes)
  const saved = await readFile(marker, 'utf8')
  for (const value of [apiKey, sample.postId, sample.sourcePostId, 'private comment', 'private author', 'private-cursor']) {
    assert.equal(saved.includes(value), false); assert.equal(JSON.stringify(result).includes(value), false)
  }
  assert.equal((await runTwitterCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no repeat HTTP') })).state, 'already_attempted')
})

test('empty pages remain valid but do not verify positive fields; buffered and short pages are accepted', async t => {
  for (const options of [{ empty: true }, { buffered: true }, { cursor: false }]) {
    const { input } = await fixture(t); let calls = 0
    const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1
      ? http(capabilities()) : http(delivered(options)) })
    assert.equal(result.verified, !options.empty)
    assert.equal(result.contractValid, true)
    assert.equal(result.commentsObserved, !options.empty)
    assert.equal(calls, 2)
  }
})

test('bad delivered fields or pagination fail verification without following a cursor or retrying', async t => {
  for (const change of [body => { body.data.items[0].commentId = sample.postId },
    body => { body.data.items[0].publishedAt = 'not-a-date' }, body => { body.data.items[0].raw = { secret: apiKey } },
    body => { body.data.meta.upstreamCallCount = 2 }, body => { body.data.page.hasMore = false },
    body => { body.requestId = sourceId }, body => { body.data.comments = [] }]) {
    const { input } = await fixture(t), body = delivered(); change(body); let calls = 0
    const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : http(body) })
    assert.equal(result.verified, false); assert.equal(calls, 2)
    assert.equal(JSON.stringify(result).includes(apiKey), false)
  }
})

test('only the durable usage header identifies success; correlation UUIDs are not receipt IDs', async t => {
  const { input } = await fixture(t); let calls = 0
  const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1
    ? http(capabilities()) : http(delivered(), {}) })
  assert.equal(result.verified, false); assert.equal(result.requestId, null); assert.equal(result.requestIdSource, null)
})

test('errors, malformed and oversized bodies remain locked and never expose body values', async t => {
  for (const response of [() => http({ error: { code: apiKey, message: sample.postId }, requestId: usageId }, {}, 502),
    () => new Response(`private ${apiKey}`), () => new Response('x'.repeat(4194305))]) {
    const { input, marker } = await fixture(t); let calls = 0
    const fetchImpl = async () => ++calls === 1 ? http(capabilities()) : response()
    const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl })
    assert.equal(result.verified, false); assert.equal(result.state, 'http_response'); assert.equal(calls, 2)
    assert.equal((await runTwitterCommentsRuntimeVerification(input, { fetchImpl })).state, 'already_attempted')
    assert.equal(calls, 2); assert.equal((await readFile(marker, 'utf8')).includes(apiKey), false)
  }
})

test('transport uncertainty preserves the attempt and blocks all later HTTP', async t => {
  const { input, marker } = await fixture(t); let calls = 0
  const result = await runTwitterCommentsRuntimeVerification(input, { fetchImpl: async () => {
    if (++calls === 1) return http(capabilities())
    throw new Error(`private ${apiKey}`)
  } })
  assert.equal(result.state, 'outcome_unknown'); assert.equal(result.hubRequestsMade, 1)
  assert.equal((JSON.parse(await readFile(marker, 'utf8'))).state, 'outcome_unknown')
  assert.equal((await runTwitterCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no HTTP') })).state, 'already_attempted')
})

test('concurrent operators can record only one POST attempt', async t => {
  const { input } = await fixture(t); let gets = 0, posts = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const fetchImpl = async (_url, options) => {
    if (options.method === 'GET') { if (++gets === 2) release(); await barrier; return http(capabilities()) }
    posts++; return http()
  }
  const results = await Promise.all([runTwitterCommentsRuntimeVerification(input, { fetchImpl }), runTwitterCommentsRuntimeVerification(input, { fetchImpl })])
  assert.equal(posts, 1)
  assert.deepEqual(results.map(row => row.state).sort(), ['already_attempted', 'http_response'])
})
