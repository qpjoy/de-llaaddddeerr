import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { prepareKuaishouAppCommentSample, runKuaishouAppCommentProbe }
  from '../../server/ops/probe-kuaishou-app-comments.mjs'

const sourceRequestId = 'ce942beb-a379-4e18-b62f-ee69cc24b3d3'
const usageId = 'e96391f1-584b-4bc0-99d7-6f97c62da574'
const sourceKey = 'comment-calibration-v1-0513a892-81fb-47b7-9cc2-363d45db9e6d'
const webPath = '/api/v1/data/native/t.api_3cb972ba91c8fe44'
const webOperation = 'native.t.api_3cb972ba91c8fe44'
const appPath = '/api/v1/data/native/t.api_bc64c9d98dbf724c'
const appOperation = 'native.t.api_bc64c9d98dbf724c'
const origin = 'http://127.0.0.1:18150'
const apiKey = `mih_live_012345abcdef_${'a'.repeat(43)}`
const sample = { revision: 'kuaishou-app-comment-sample.v1', platform: 'kuaishou',
  sourceRequestId, postId: 'synthetic-private-id' }
const sourceUsage = { id: sourceRequestId, platform: 'social', status: 'committed',
  response_status: 502, error_code: 'upstream_request_rejected', method: 'POST', path: webPath,
  body: { params: { photo_id: sample.postId }, deliveryMode: 'live_only' } }
const sourceCall = { id: 'acbcb9fd-e90b-4612-9687-21eaaecf4a49', provider_key: 'tikhub', marketplace: 'kuaishou',
  operation: webOperation, endpoint_key: webOperation, contract_version: 'mx-insight-hub.native-forwarding.v1',
  outcome: 'rejected', http_status: 400, business_code: 400, error_code: 'upstream_request_rejected', billed: null,
  upstream_request_id: 'c5eb3eb1-b044-43ff-b2d3-8fc8892fb7b5' }

function database({ usages = [sourceUsage], calls = [sourceCall], fail = false } = {}) {
  const statements = []; let released = false
  return { statements, get released() { return released }, pool: { async connect() { return {
    async query(sql, values) {
      statements.push({ sql, values })
      if (sql.includes('kuaishou-app-probe:source-usage')) {
        if (fail) throw new Error(`private ${apiKey}`)
        return { rows: usages }
      }
      if (sql.includes('kuaishou-app-probe:source-calls')) return { rows: calls }
      return { rows: [] }
    }, release() { released = true },
  } } } }
}

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'kuaishou-app-probe-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const receipts = join(directory, '.hub-comment-contract-probes-v1')
  await mkdir(receipts)
  const original = { revision: 'post-comment-contract-probe.v2', provider: 'tikhub', platform: 'kuaishou',
    path: webPath, state: 'http_response', httpStatus: 502, errorCode: 'external_platform_rejected',
    hubRequestsMade: 1, requestIdSource: 'usage_header', requestId: sourceRequestId, idempotencyKey: sourceKey }
  const sourceFile = join(receipts, 'kuaishou.json')
  await writeFile(sourceFile, JSON.stringify(original))
  return { directory, receipts, original, sourceFile, marker: join(receipts, 'kuaishou.app.json'),
    input: { sampleDirectory: directory, sample: structuredClone(sample), apiKey, apply: true } }
}

const capabilities = () => ({ data: { platforms: [], capabilities: [{ capability: appOperation, ready: true }] } })
const response = (body = { code: 200, data: { comments: [{ text: 'private-comment' }], cursor: 'private-cursor' } },
  status = 200, headers = { 'x-mx-insight-request-id': usageId }) => Response.json(body, { status, headers })
const noHttp = () => assert.fail('HTTP must not run')

test('private preparation reads the exact saved Web request and one rejected call, then rolls back', async () => {
  const db = database()
  assert.deepEqual(await prepareKuaishouAppCommentSample(db.pool), sample)
  assert.match(db.statements[0].sql, /^BEGIN.*READ ONLY$/)
  assert.ok(db.statements.some(({ sql }) => /statement_timeout/.test(sql)))
  assert.ok(db.statements.some(({ sql }) => /lock_timeout/.test(sql)))
  for (const marker of ['kuaishou-app-probe:source-usage', 'kuaishou-app-probe:source-calls']) {
    const query = db.statements.find(({ sql }) => sql.includes(marker))
    assert.ok(query)
    assert.equal(query.values[0], sourceRequestId)
    assert.match(query.sql, /\$1/)
  }
  assert.ok(db.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
  assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
  assert.equal(db.released, true)
  assert.equal(sourceCall.billed, null)
})

test('preparation rejects missing, changed or ambiguous source evidence without falling back to another target', async () => {
  const badUsages = [{ id: usageId }, { platform: 'reddit' }, { status: 'unknown' }, { response_status: 200 },
    { error_code: 'other' }, { method: 'GET' }, { path: appPath },
    { body: { params: { photo_id: sample.postId, pcursor: 'private-cursor' }, deliveryMode: 'live_only' } },
    { body: { params: { photo_id: '' }, deliveryMode: 'live_only' } },
    { body: { params: { photo_id: sample.postId }, deliveryMode: 'cache_only' } },
    { body: { params: { photo_id: sample.postId }, deliveryMode: 'live_only', url: 'https://example.invalid/' } }]
  const badCalls = [{ provider_key: 'justone' }, { marketplace: 'reddit' }, { operation: appOperation },
    { endpoint_key: appOperation }, { contract_version: 'other' }, { outcome: 'unknown' },
    { http_status: 200 }, { business_code: 200 }, { error_code: 'upstream_timeout' }]
  for (const options of [{ usages: [] }, { usages: [sourceUsage, sourceUsage] }, { calls: [] },
    { calls: [sourceCall, sourceCall] }, { fail: true },
    ...badUsages.map(patch => ({ usages: [{ ...sourceUsage, ...patch }] })),
    ...badCalls.map(patch => ({ calls: [{ ...sourceCall, ...patch }] }))]) {
    const db = database(options)
    await assert.rejects(prepareKuaishouAppCommentSample(db.pool))
    assert.equal(db.statements.at(-1).sql, 'ROLLBACK')
    assert.equal(db.released, true)
    assert.ok(db.statements.every(({ sql }) => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\b/.test(sql)))
  }
})

test('preview requires the fixed private sample and original failed marker without a Key or HTTP', async t => {
  const { input, marker } = await fixture(t)
  const result = await runKuaishouAppCommentProbe({ ...input, apiKey: null, apply: false }, { fetchImpl: noHttp })
  assert.equal(result.state, 'preview')
  assert.equal(result.hubRequestsMade, 0)
  assert.equal(result.preflightRequestsMade, 0)
  assert.equal(result.path, appPath)
  assert.equal(result.sourceRequestId, sourceRequestId)
  assert.equal(JSON.stringify(result).includes(sample.postId), false)
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

test('saved usage rejection and public receipt rejection keep their distinct observed error codes', async t => {
  const db = database()
  const prepared = await prepareKuaishouAppCommentSample(db.pool)
  const { input, sourceFile, original } = await fixture(t)
  assert.equal(sourceUsage.error_code, 'upstream_request_rejected')
  assert.equal(original.errorCode, 'external_platform_rejected')
  assert.equal((await runKuaishouAppCommentProbe({ ...input, sample: prepared, apply: false }, { fetchImpl: noHttp })).state, 'preview')
  await assert.rejects(prepareKuaishouAppCommentSample(database({
    usages: [{ ...sourceUsage, error_code: 'external_platform_rejected' }],
  }).pool))
  await writeFile(sourceFile, JSON.stringify({ ...original, errorCode: 'upstream_request_rejected' }))
  await assert.rejects(runKuaishouAppCommentProbe({ ...input, apply: false }, { fetchImpl: noHttp }))
})

test('changed samples and Web receipts cannot open an App request slot', async t => {
  const { input, sourceFile, original, marker } = await fixture(t)
  for (const patch of [{ revision: 'other' }, { platform: 'reddit' }, { sourceRequestId: usageId },
    { postId: '' }, { postId: 'http://example.invalid/' }, { cursor: 'private-cursor' },
    { path: 'https://example.invalid/' }, { params: { pcursor: 'private-cursor' } }]) {
    await assert.rejects(runKuaishouAppCommentProbe({ ...input, sample: { ...sample, ...patch } }, { fetchImpl: noHttp }))
  }
  for (const patch of [{ revision: 'other' }, { provider: 'justone' }, { platform: 'reddit' }, { path: appPath },
    { state: 'outcome_unknown' }, { httpStatus: 401 }, { errorCode: 'invalid_api_key' }, { hubRequestsMade: 0 },
    { requestIdSource: 'error_details' }, { requestId: usageId }, { idempotencyKey: 'arbitrary' }]) {
    await writeFile(sourceFile, JSON.stringify({ ...original, ...patch }))
    await assert.rejects(runKuaishouAppCommentProbe(input, { fetchImpl: noHttp }))
  }
  await writeFile(sourceFile, '{')
  await assert.rejects(runKuaishouAppCommentProbe(input, { fetchImpl: noHttp }))
  await rm(sourceFile)
  await assert.rejects(runKuaishouAppCommentProbe(input, { fetchImpl: noHttp }))
  await assert.rejects(stat(marker), { code: 'ENOENT' })
})

test('a new directory does not reset the source chain or create receipts', async t => {
  const { input, directory } = await fixture(t)
  const unrelated = join(directory, 'unrelated')
  await assert.rejects(runKuaishouAppCommentProbe({ ...input, sampleDirectory: unrelated }, { fetchImpl: noHttp }))
  await assert.rejects(stat(unrelated), { code: 'ENOENT' })
})

test('invalid Live Keys fail locally before capabilities or procurement', async t => {
  const { input } = await fixture(t)
  for (const key of ['', apiKey.replace('live', 'test'), 'supplier-secret', `${apiKey}\n`, 'mih_live_private']) {
    await assert.rejects(runKuaishouAppCommentProbe({ ...input, apiKey: key }, { fetchImpl: noHttp }))
  }
})

test('capability refusal or unavailable preflight cannot create a paid marker', async t => {
  const { input, marker } = await fixture(t)
  for (const [body, status] of [[{ data: { capabilities: [] } }, 200],
    [{ data: { capabilities: [{ capability: appOperation, ready: false }] } }, 200],
    [{ data: { capabilities: [{ capability: webOperation, ready: true }] } }, 200], [capabilities(), 401]]) {
    let calls = 0
    const result = await runKuaishouAppCommentProbe(input, { fetchImpl: async (url, options) => {
      calls++; assert.equal(url, `${origin}/api/v1/data/capabilities`); assert.equal(options.method, 'GET')
      return response(body, status)
    } })
    assert.equal(result.state, 'preflight_rejected')
    assert.equal(result.hubRequestsMade, 0); assert.equal(calls, 1)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  }
  for (const fetchImpl of [async () => { throw new Error(apiKey) }, async () => new Response('invalid json')]) {
    const result = await runKuaishouAppCommentProbe(input, { fetchImpl })
    assert.equal(result.state, 'preflight_unavailable')
    assert.equal(result.hubRequestsMade, 0)
    assert.equal(JSON.stringify(result).includes(apiKey), false)
    await assert.rejects(stat(marker), { code: 'ENOENT' })
  }
})

test('one App POST uses the saved photo ID and a durable independent redacted marker', async t => {
  const { input, sourceFile, marker } = await fixture(t)
  const originalBytes = await readFile(sourceFile)
  let gets = 0, posts = 0
  const result = await runKuaishouAppCommentProbe(input, { fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error'); assert.ok(options.signal instanceof AbortSignal)
    assert.equal(options.headers.authorization, `Bearer ${apiKey}`)
    if (options.method === 'GET') { gets++; return response(capabilities()) }
    posts++; assert.equal(options.method, 'POST'); assert.equal(url, `${origin}${appPath}`)
    assert.deepEqual(JSON.parse(options.body), { params: { photo_id: sample.postId }, deliveryMode: 'live_only' })
    const before = JSON.parse(await readFile(marker, 'utf8'))
    assert.equal(before.state, 'dispatch_started')
    assert.equal(before.idempotencyKey, options.headers['idempotency-key'])
    assert.match(before.idempotencyKey, /^kuaishou-app-comment-calibration-v1-[0-9a-f-]{36}$/)
    assert.notEqual(before.idempotencyKey, sourceKey)
    assert.equal((await stat(marker)).mode & 0o777, 0o600)
    return response()
  } })
  assert.equal(gets, 1); assert.equal(posts, 1)
  assert.equal(result.state, 'http_response'); assert.equal(result.httpStatus, 200)
  assert.equal(result.requestId, usageId); assert.equal(result.requestIdSource, 'usage_header')
  assert.equal(result.hubRequestsMade, 1)
  assert.deepEqual(await readFile(sourceFile), originalBytes)
  for (const text of [JSON.stringify(result), await readFile(marker, 'utf8')]) {
    for (const value of [apiKey, sample.postId, 'private-comment', 'private-cursor']) assert.equal(text.includes(value), false)
  }
  assert.equal((await runKuaishouAppCommentProbe(input, { fetchImpl: noHttp })).state, 'already_attempted')
})

test('all pre-existing App markers block every HTTP request without being repaired', async t => {
  for (const contents of ['{', JSON.stringify({ state: 'dispatch_started' }), JSON.stringify({ state: 'http_response', httpStatus: 401 })]) {
    const { input, marker } = await fixture(t)
    await writeFile(marker, contents)
    assert.equal((await runKuaishouAppCommentProbe(input, { fetchImpl: noHttp })).state, 'already_attempted')
    assert.equal(await readFile(marker, 'utf8'), contents)
  }
  const { input, marker, directory } = await fixture(t)
  await symlink(join(directory, 'missing-target'), marker)
  assert.equal((await runKuaishouAppCommentProbe(input, { fetchImpl: noHttp })).state, 'already_attempted')
})

test('HTTP rejection or transport uncertainty consumes the slot without retrying or exposing error bodies', async t => {
  for (const reply of [async () => response({ error: { code: 'external_platform_rejected', message: apiKey,
    details: { photo_id: sample.postId } }, requestId: usageId }, 502),
  async () => { throw new Error(`${apiKey} ${sample.postId}`) }]) {
    const { input, marker } = await fixture(t)
    let calls = 0
    const result = await runKuaishouAppCommentProbe(input, { fetchImpl: async (_url, options) => {
      calls++; return options.method === 'GET' ? response(capabilities()) : reply()
    } })
    assert.ok(['http_response', 'outcome_unknown'].includes(result.state))
    assert.equal(result.hubRequestsMade, 1); assert.equal(calls, 2)
    for (const text of [JSON.stringify(result), await readFile(marker, 'utf8')]) {
      assert.equal(text.includes(apiKey), false); assert.equal(text.includes(sample.postId), false)
    }
    assert.equal((await runKuaishouAppCommentProbe(input, { fetchImpl: noHttp })).state, 'already_attempted')
  }
})

test('an HTTP correlation ID alone is never returned as a durable usage receipt', async t => {
  const { input } = await fixture(t)
  const result = await runKuaishouAppCommentProbe(input, { fetchImpl: async (_url, options) => options.method === 'GET'
    ? response(capabilities()) : response({ requestId: usageId, error: { code: 'invalid_api_key' } }, 401, {}) })
  assert.equal(result.requestId, null)
  assert.equal(result.requestIdSource, null)
})

test('concurrent operators can create at most one App POST', async t => {
  const { input } = await fixture(t)
  let gets = 0, posts = 0, release
  const barrier = new Promise(resolve => { release = resolve })
  const fetchImpl = async (_url, options) => {
    if (options.method === 'GET') { if (++gets === 2) release(); await barrier; return response(capabilities()) }
    posts++; return response()
  }
  const results = await Promise.all([runKuaishouAppCommentProbe(input, { fetchImpl }), runKuaishouAppCommentProbe(input, { fetchImpl })])
  assert.equal(posts, 1)
  assert.deepEqual(results.map(result => result.state).sort(), ['already_attempted', 'http_response'])
})

test('private preparation runs through stdin with only read-only offline pg access and redacts CLI failures', () => {
  const source = readFileSync(new URL('../../server/ops/probe-kuaishou-app-comments.mjs', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /from ['"]\.\.?\//)
  const pgImport = "const { default: pg } = await import('pg')"
  assert.ok(source.includes(pgImport))
  const offlinePg = `const pg = { Pool: class {
    async connect() { return { release() {}, async query(sql, values) {
      if (!/^(BEGIN|SET LOCAL|SELECT|ROLLBACK)\\b/.test(sql)) throw new Error('write_forbidden')
      if (sql.includes('kuaishou-app-probe:source-usage')) {
        if (values[0] !== ${JSON.stringify(sourceRequestId)}) throw new Error('wrong_source')
        return { rows: [${JSON.stringify(sourceUsage)}] }
      }
      if (sql.includes('kuaishou-app-probe:source-calls')) {
        if (values[0] !== ${JSON.stringify(sourceRequestId)}) throw new Error('wrong_source')
        return { rows: [${JSON.stringify(sourceCall)}] }
      }
      return { rows: [] }
    } } }
    async end() {}
  } }`
  const env = { ...process.env, DATABASE_URL: 'postgresql://private:offline-db-secret@example.invalid/test' }
  const run = (input, childEnv = env) => spawnSync(process.execPath, ['--input-type=module', '-', '--prepare-private'],
    { input, env: childEnv, encoding: 'utf8' })
  const result = run(source.replace(pgImport, offlinePg))
  assert.equal(result.status, 0, result.stderr)
  assert.equal(result.stderr, '')
  assert.deepEqual(JSON.parse(result.stdout), sample, 'private target is returned only to the capturing wrapper')
  assert.doesNotMatch(result.stdout, /offline-db-secret|postgresql:|Bearer|mih_live_/)

  const errorPg = `const pg = { Pool: class {
    async connect() { throw new Error(${JSON.stringify(env.DATABASE_URL)}) }
    async end() {}
  } }`
  const failed = run(source.replace(pgImport, errorPg))
  assert.equal(failed.status, 1)
  assert.equal(failed.stdout, '')
  assert.deepEqual(JSON.parse(failed.stderr), { error: 'kuaishou_app_comment_probe_failed' })
  assert.doesNotMatch(failed.stderr, /offline-db-secret|postgresql:|Error:|at /)
  const missingEnv = { ...env }; delete missingEnv.DATABASE_URL
  const missing = run(source, missingEnv)
  assert.equal(missing.status, 1)
  assert.equal(missing.stdout, '')
  assert.deepEqual(JSON.parse(missing.stderr), { error: 'database_url_required' })
})
