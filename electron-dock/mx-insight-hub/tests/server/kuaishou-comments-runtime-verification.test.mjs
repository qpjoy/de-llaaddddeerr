import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, lstat, stat, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { KUAISHOU_RUNTIME_SOURCE_REQUEST_ID as sourceId, KUAISHOU_RUNTIME_SOURCE_IDEMPOTENCY_KEY as sourceKey,
  prepareKuaishouCommentsRuntimeSample, runKuaishouCommentsRuntimeVerification } from '../../server/ops/verify-kuaishou-comments-runtime.mjs'
import { normalizePostCommentsDelivery, postCommentsDeliveryBody } from '../../server/external-platforms/post-comments-workflow.mjs'
import { buildPostCommentsDispatch } from '../../server/contracts/post-comments.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'

const usageId = 'e96391f1-584b-4bc0-99d7-6f97c62da574'
const correlationId = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
const apiKey = `mih_live_012345abcdef_${'a'.repeat(43)}`
const sample = { revision: 'kuaishou-comments-runtime-sample.v1', platform: 'kuaishou', provider: 'tikhub', sourceRequestId: sourceId, postId: 'fixturePhoto123' }
const nativePath = '/api/v1/data/native/t.api_bc64c9d98dbf724c'
const publicPath = 'http://127.0.0.1:18150/api/v1/search/post-comments'
const capabilities = () => ({ data: { platforms: [{ platform: 'kuaishou', ready: false }],
  capabilities: [{ capability: 'social.comments.list', ready: false }, { capability: 'native.t.api_bc64c9d98dbf724c', ready: true }] } })

function sourceHarness({ usages, calls } = {}) {
  const queries = []; let releases = 0
  const sourceUsage = { id: sourceId, idempotency_key: sourceKey, platform: 'social', status: 'committed', response_status: 200,
    acquisition_request: { method: 'POST', path: nativePath, body: { params: { photo_id: sample.postId }, deliveryMode: 'live_only' } } }
  const sourceCall = { provider_key: 'tikhub', marketplace: 'kuaishou', endpoint_key: 'native.t.api_bc64c9d98dbf724c',
    operation: 'native.t.api_bc64c9d98dbf724c', contract_version: 'mx-insight-hub.native-forwarding.v1',
    outcome: 'succeeded', http_status: 200, business_code: 200, billed: true }
  const client = { async query(sql, values) {
    queries.push({ sql, values })
    if (sql.includes('kuaishou-runtime-sample:usage')) return { rows: usages ?? [sourceUsage] }
    if (sql.includes('kuaishou-runtime-sample:calls')) return { rows: calls ?? [sourceCall] }
    return { rows: [] }
  }, release() { releases++ } }
  return { pool: { connect: async () => client }, queries, sourceUsage, sourceCall, get releases() { return releases } }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kuaishou-comments-acceptance-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const receipts = join(directory, '.hub-comment-contract-probes-v1')
  await mkdir(receipts)
  const original = { revision: 'kuaishou-app-comment-probe.v1', sourceRequestId: 'ce942beb-a379-4e18-b62f-ee69cc24b3d3',
    bodySha256: createHash('sha256').update(JSON.stringify({ params: { photo_id: sample.postId }, deliveryMode: 'live_only' })).digest('hex'), provider: 'tikhub', platform: 'kuaishou', path: nativePath,
    state: 'http_response', httpStatus: 200, hubRequestsMade: 1, requestIdSource: 'usage_header', requestId: sourceId, idempotencyKey: sourceKey }
  const originalPath = join(receipts, 'kuaishou.app.json')
  await writeFile(originalPath, JSON.stringify(original), { mode: 0o600 })
  return { directory, receipts, original, originalPath, marker: join(receipts, 'kuaishou.unified-acceptance.json'),
    input: { sampleDirectory: directory, sample, apiKey, apply: true } }
}

function delivered({ size = 11, advancing = false } = {}) {
  const request = normalizePostCommentsDelivery({ platform: 'kuaishou', contentId: sample.postId, count: 20, includeRaw: false },
    { context: { consumer: { businessId: 'test' } }, maxPageSize: 100, codec: { encode: () => 'mxds1.private-cursor.signature' } })
  const raw = { code: 200, params: { photo_id: sample.postId }, data: {
    result: 1, rootComments: Array.from({ length: size }, (_, index) => ({
      comment_id: 123400 + index, content: `private Kuaishou comment ${index}\n完整正文`, timestamp: 1793577600000,
      author_id: 456700 + index, user_id: 987600 + index, author_name: 'private author',
      likedCount: index === 1 ? null : index, subCommentCount: index === 2 ? null : index % 2,
      photo_id: 9007199254740992, headurl: 'https://private.invalid/avatar',
    })), pcursor: advancing ? 'private-provider-cursor' : 'no_more',
  } }
  const { projected } = projectPostCommentPage(raw, buildPostCommentsDispatch(request), { capturedAt: '2026-11-02T02:00:00Z' })
  return postCommentsDeliveryBody(request, { rowsByJob: [projected.acquiredItems.slice(0, 20)],
    state: { jobs: [{ buffer: size > 20 ? {} : null, done: !advancing, upstreamPages: 1, duplicateCount: 0 }] }, calls: 1,
    warnings: [{ code: 'pagination_completeness_unknown', message: 'provider completeness unknown' }], deliveryId: usageId })
}
const http = (body = delivered(), headers = { 'x-mx-insight-request-id': usageId }, status = 200) => Response.json(body, { status, headers })
const syncItems = body => { body.data.comments = structuredClone(body.data.items); body.data.raw_data = JSON.stringify(body.data.items) }

test('private sample preparation reads only the fixed committed native source and its one billed call', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('no HTTP') })
  const h = sourceHarness()
  assert.deepEqual(await prepareKuaishouCommentsRuntimeSample(h.pool), sample)
  assert.equal(fetch.mock.callCount(), 0)
  const reads = h.queries.filter(row => row.sql.includes('kuaishou-runtime-sample:'))
  assert.equal(reads.length, 2)
  assert.deepEqual(reads[0].values, [sourceId, 32768])
  assert.deepEqual(reads[1].values, [sourceId])
  assert.match(reads[0].sql, /CASE WHEN octet_length\(acquisition_request::text\) <= \$2::integer/u)
  assert.match(reads[0].sql, /WHERE id=\$1::uuid/u)
  assert.match(reads[1].sql, /LIMIT 2/u)
  assert.equal(h.queries.every(row => /^(?:BEGIN|SET|SELECT|ROLLBACK)\b/u.test(row.sql)), true)
  assert.match(h.queries[0].sql, /READ ONLY/u)
  assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
  assert.equal(h.releases, 1)
})

test('preparation rejects old discovery IDs, missing snapshots and contradictory source or billing state', async () => {
  const { sourceUsage: usage, sourceCall: call } = sourceHarness()
  for (const changes of [
    { usages: [] }, { usages: [usage, usage] },
    ...[{ id: 'ce942beb-a379-4e18-b62f-ee69cc24b3d3' }, { idempotency_key: 'other-key' }, { platform: 'kuaishou' },
      { status: 'released' }, { response_status: 404 }, { acquisition_request: null },
      { acquisition_request: { method: 'POST', path: '/api/v1/search/post-comments', body: { postId: 'post123' } } },
      { acquisition_request: { ...usage.acquisition_request, body: { params: { photo_id: 123 }, deliveryMode: 'live_only' } } },
      { acquisition_request: { ...usage.acquisition_request, body: { params: { photo_id: sample.postId }, deliveryMode: 'stored_only' } } },
      { acquisition_request: { ...usage.acquisition_request, body: { params: { photo_id: sample.postId, pcursor: 'private-cursor' }, deliveryMode: 'live_only' } } },
    ].map(patch => ({ usages: [{ ...usage, ...patch }] })),
    { calls: [] }, { calls: [call, call] },
    ...[{ provider_key: 'justone' }, { marketplace: 'twitter' }, { endpoint_key: 'native.t.api_3cb972ba91c8fe44' },
      { operation: 'social.comments.list' }, { contract_version: 'other-contract' },
      { outcome: 'unknown' }, { http_status: 502 }, { business_code: 400 }, { billed: false }].map(patch => ({ calls: [{ ...call, ...patch }] })),
  ]) {
    const h = sourceHarness(changes)
    await assert.rejects(prepareKuaishouCommentsRuntimeSample(h.pool), /source_receipt_unverified/u)
    assert.equal(h.queries.at(-1).sql, 'ROLLBACK')
    assert.equal(h.releases, 1)
  }
})

test('preview validates the fixed original receipt without API Key, HTTP or a new acceptance marker', async t => {
  const { input, marker, originalPath } = await fixture(t)
  const before = await readFile(originalPath)
  const result = await runKuaishouCommentsRuntimeVerification({ ...input, apiKey: null, apply: false }, { fetchImpl: () => assert.fail('no HTTP') })
  assert.equal(result.state, 'preview')
  assert.equal(result.hubRequestsMade, 0)
  assert.equal(result.preflightRequestsMade, 0)
  assert.deepEqual(await readFile(originalPath), before)
  await assert.rejects(lstat(marker), { code: 'ENOENT' })
})

test('host sample and original receipt validation cannot substitute discovery evidence or follow a source symlink', async t => {
  const { input, original, originalPath, directory } = await fixture(t)
  const fetchImpl = () => assert.fail('no HTTP')
  for (const patch of [{ requestId: 'ce942beb-a379-4e18-b62f-ee69cc24b3d3' }, { idempotencyKey: 'other' },
    { state: 'outcome_unknown' }, { httpStatus: 401 }, { requestIdSource: 'error_details' }, { provider: 'justone' }, { bodySha256: '0'.repeat(64) }]) {
    await writeFile(originalPath, JSON.stringify({ ...original, ...patch }))
    await assert.rejects(runKuaishouCommentsRuntimeVerification(input, { fetchImpl }), /source_receipt_unverified/u)
  }
  await writeFile(originalPath, JSON.stringify(original))
  for (const patch of [{ sourceRequestId: correlationId }, { postId: '' }, { postId: 'wrong/photo' }, { cursor: 'private-cursor' }]) {
    await assert.rejects(runKuaishouCommentsRuntimeVerification({ ...input, sample: { ...sample, ...patch } }, { fetchImpl }), /invalid_sample/u)
  }
  await assert.rejects(runKuaishouCommentsRuntimeVerification({ ...input, sample: { ...sample, postId: 'otherPhoto' } }, { fetchImpl }), /source_receipt_unverified/u)
  const privateFile = join(directory, 'private-sample.json')
  await writeFile(privateFile, JSON.stringify(sample))
  await rm(originalPath)
  await symlink(privateFile, originalPath)
  await assert.rejects(runKuaishouCommentsRuntimeVerification(input, { fetchImpl }), /source_receipt_unverified/u)
})

test('any existing marker object including a dangling symlink blocks all HTTP before sample or Key validation', async t => {
  for (const kind of ['empty', 'malformed', 'directory', 'dangling_symlink']) {
    const { input, marker } = await fixture(t)
    if (kind === 'directory') await mkdir(marker)
    else if (kind === 'dangling_symlink') await symlink(join(marker, '..', 'missing-file'), marker)
    else await writeFile(marker, kind === 'empty' ? '' : 'not JSON')
    const result = await runKuaishouCommentsRuntimeVerification({ ...input, sample: null, apiKey: null }, { fetchImpl: () => assert.fail('no HTTP') })
    assert.equal(result.state, 'already_attempted')
    assert.equal(result.hubRequestsMade, 0)
    assert.equal(result.preflightRequestsMade, 0)
  }
})

test('only Live Keys and all free capability checks can advance to the paid marker', async t => {
  const { input, marker } = await fixture(t)
  for (const key of ['', 'supplier-secret', apiKey.replace('live', 'test'), `${apiKey}\n`]) {
    await assert.rejects(runKuaishouCommentsRuntimeVerification({ ...input, apiKey: key }, { fetchImpl: () => assert.fail('no HTTP') }), /api_key_required|invalid_api_key/u)
  }
  for (const change of [data => { data.platforms = [] }, data => { data.capabilities.shift() },
    data => { data.capabilities[1].ready = false }, data => { data.capabilities.pop() }]) {
    const body = capabilities(); change(body.data); let calls = 0
    const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async (_url, options) => {
      calls++; assert.equal(options.method, 'GET'); return http(body)
    } })
    assert.equal(result.state, 'preflight_rejected')
    assert.equal(result.hubRequestsMade, 0)
    assert.equal(calls, 1)
    await assert.rejects(lstat(marker), { code: 'ENOENT' })
  }
  const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => { throw new Error(apiKey) } })
  assert.equal(result.state, 'preflight_unavailable')
  assert.equal(JSON.stringify(result).includes(apiKey), false)
})

test('one legacy POST is preceded by the private durable marker and preserves the original native receipt', async t => {
  const { input, marker, originalPath } = await fixture(t)
  const originalBytes = await readFile(originalPath); let calls = 0
  const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async (url, options) => {
    calls++; assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`)
    if (calls === 1) { assert.equal(options.method, 'GET'); return http(capabilities()) }
    assert.equal(url, publicPath); assert.equal(options.method, 'POST')
    assert.deepEqual(JSON.parse(options.body), { platform: 'kuaishou', contentId: sample.postId, count: 20, includeRaw: false })
    const saved = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(saved.state, 'dispatch_started')
    assert.equal(saved.idempotencyKey, options.headers['idempotency-key'])
    assert.notEqual(saved.idempotencyKey, sourceKey)
    assert.equal(saved.bodySha256, createHash('sha256').update(options.body).digest('hex'))
    assert.equal((await stat(marker)).mode & 0o777, 0o600)
    return http()
  } })
  assert.equal(calls, 2)
  assert.equal(result.verified, true)
  assert.equal(result.returnedCount, 11)
  assert.equal(result.requestId, usageId)
  assert.equal(result.requestIdSource, 'usage_header')
  assert.deepEqual(result.pagination, { hasMore: null, continuationAvailable: false, paginationStatus: 'unknown' })
  assert.deepEqual(await readFile(originalPath), originalBytes)
  const saved = await readFile(marker, 'utf8')
  for (const value of [apiKey, sample.postId, 'private Kuaishou', 'private author', '456700', 'private-cursor', '9007199254740992']) {
    assert.equal(saved.includes(value), false)
    assert.equal(JSON.stringify(result).includes(value), false)
  }
  assert.equal((await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no retry HTTP') })).state, 'already_attempted')
})

test('unknown, explicitly continuing and buffered pages pass without assuming exactly eleven comments', async t => {
  for (const options of [{ size: 1 }, { size: 8 }, { size: 2, advancing: true }, { size: 25 }]) {
    const { input } = await fixture(t); let calls = 0
    const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : http(delivered(options)) })
    assert.equal(result.verified, true, JSON.stringify(result))
    assert.equal(result.returnedCount, Math.min(options.size, 20))
    assert.equal(calls, 2)
    assert.equal(result.pagination.paginationStatus, options.size > 20 ? 'continuable' : 'unknown')
  }
})

test('an empty but valid delivery consumes the acceptance slot without claiming positive verification', async t => {
  const { input } = await fixture(t); let calls = 0
  const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : http(delivered({ size: 0 })) })
  assert.equal(result.contractValid, true)
  assert.equal(result.commentsObserved, false)
  assert.equal(result.verified, false)
  assert.equal(result.returnedCount, 0)
  assert.equal((await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no retry') })).state, 'already_attempted')
  assert.equal(calls, 2)
})

test('malformed IDs, metrics, parent relations and pagination fail without exposing values or buying again', async t => {
  for (const change of [body => { body.data.items[0].commentId = sample.postId },
    body => { body.data.items[0].metrics.likes = 0.5 }, body => { body.data.items[0].likeCount = -1 },
    body => { body.data.items[0].parentRelationship = 'post'; body.data.items[0].parentExternalId = 'otherPhoto' },
    body => { body.data.items[0].publishedAt = 'not-a-date' }, body => { body.data.items[0].raw = { secret: apiKey } },
    body => { body.data.items[1] = structuredClone(body.data.items[0]) }, body => { body.data.meta.upstreamCallCount = 2 },
    body => { body.data.page.hasMore = true }, body => { body.requestId = correlationId },
  ]) {
    const { input } = await fixture(t), body = delivered(); change(body); syncItems(body); let calls = 0
    const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : http(body) })
    assert.equal(result.verified, false)
    assert.equal(result.contractValid, false)
    assert.equal(calls, 2)
    assert.equal(JSON.stringify(result).includes(apiKey), false)
    assert.equal((await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no retry') })).state, 'already_attempted')
  }
})

test('durable request IDs prefer the usage header then error details and never the temporary top-level correlation ID', async t => {
  for (const headers of [{}, { 'x-mx-insight-request-id': usageId }]) {
    const { input } = await fixture(t); let calls = 0
    const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities())
      : http({ requestId: correlationId, error: { code: 'external_platform_busy', details: { requestId: sourceId } } }, headers, 503) })
    assert.equal(result.requestId, headers['x-mx-insight-request-id'] ?? sourceId)
    assert.equal(result.requestIdSource, headers['x-mx-insight-request-id'] ? 'usage_header' : 'error_details')
    assert.equal(result.httpRequestId, correlationId)
    assert.equal(result.verified, false)
  }
  const { input } = await fixture(t); let calls = 0
  const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : http(delivered(), {}) })
  assert.equal(result.requestId, null)
  assert.equal(result.verified, false)
})

test('errors, malformed bodies and transport uncertainty preserve the consumed slot and leak no private data', async t => {
  for (const failure of [() => http({ requestId: correlationId, error: { code: apiKey, message: sample.postId } }, {}, 502),
    () => new Response(`private ${apiKey}`), () => new Response('x'.repeat(4194305)),
    () => { throw new Error(`private ${apiKey}`) }]) {
    const { input, marker } = await fixture(t); let calls = 0
    const result = await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: async () => ++calls === 1 ? http(capabilities()) : failure() })
    assert.equal(result.verified, false)
    assert.equal(result.hubRequestsMade, 1)
    assert.equal(calls, 2)
    assert.equal((await readFile(marker, 'utf8')).includes(apiKey), false)
    assert.equal(JSON.stringify(result).includes(sample.postId), false)
    assert.equal((await runKuaishouCommentsRuntimeVerification(input, { fetchImpl: () => assert.fail('no retry') })).state, 'already_attempted')
  }
})

test('concurrent operators can issue only one acceptance POST', async t => {
  const { input } = await fixture(t)
  let gets = 0, posts = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const fetchImpl = async (_url, options) => {
    if (options.method === 'GET') { if (++gets === 2) release(); await barrier; return http(capabilities()) }
    posts++; return http()
  }
  const results = await Promise.all([runKuaishouCommentsRuntimeVerification(input, { fetchImpl }), runKuaishouCommentsRuntimeVerification(input, { fetchImpl })])
  assert.equal(posts, 1)
  assert.deepEqual(results.map(row => row.state).sort(), ['already_attempted', 'http_response'])
})

test('standalone preparation requires no Hub imports and host stdin imports do not execute the CLI', async () => {
  const url = new URL('../../server/ops/verify-kuaishou-comments-runtime.mjs', import.meta.url)
  const source = await readFile(url, 'utf8'), env = { ...process.env }
  delete env.DATABASE_URL
  const prepare = spawnSync(process.execPath, ['--input-type=module', '-', '--prepare'], { input: source, env, encoding: 'utf8', timeout: 5000 })
  assert.equal(prepare.status, 1)
  assert.deepEqual(JSON.parse(prepare.stderr), { error: 'database_url_required' })
  const invalid = spawnSync(process.execPath, ['--input-type=module', '-', '--prepare', '--apply'], { input: source, env, encoding: 'utf8', timeout: 5000 })
  assert.equal(invalid.status, 1)
  assert.deepEqual(JSON.parse(invalid.stderr), { error: 'invalid_arguments' })
  const imported = spawnSync(process.execPath, ['--input-type=module', '-'], {
    input: `import { runKuaishouCommentsRuntimeVerification } from ${JSON.stringify(url.href)}; console.log(typeof runKuaishouCommentsRuntimeVerification)`,
    env, encoding: 'utf8', timeout: 5000,
  })
  assert.equal(imported.status, 0, imported.stderr)
  assert.equal(imported.stdout.trim(), 'function')
})
