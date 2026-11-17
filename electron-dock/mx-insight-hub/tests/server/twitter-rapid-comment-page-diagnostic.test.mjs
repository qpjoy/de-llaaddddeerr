import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SOURCE, RECEIPT_SQL, safeFailure, summarizeTwitterRawShape, replayTwitterRawPage,
  diagnoseSavedTwitterPage } from '../../server/ops/diagnose-twitter-rapid-comment-page.mjs'
import { parseRapidApiTwitterCommentPage } from '../../server/contracts/twitter-rapid-comment-page.mjs'
import { projectPostCommentPage } from '../../server/contracts/post-comment-projection.mjs'
import { normalizePostCommentsRequest, buildPostCommentsDispatch, POST_COMMENTS_TRAVERSAL } from '../../server/contracts/post-comments.mjs'
import { projectPage } from '../../server/external-platforms/social-account-workflow.mjs'
import { isPostgresSafeJsonValue } from '../../server/core/postgres-json.mjs'

const rootId = '8888888888888888800', replyId = '8888888888888888801'
const sensitive = ['PRIVATE BODY SENTINEL', 'PRIVATE AUTHOR SENTINEL', 'PRIVATE CURSOR SENTINEL',
  'PRIVATE UNKNOWN FIELD', 'PRIVATE UNKNOWN TYPE', rootId, replyId, 'https://private.example/secret']
const raw = { __typename: 'Tweet', rest_id: replyId, legacy: { id_str: replyId, conversation_id_str: rootId,
  in_reply_to_status_id_str: rootId, full_text: sensitive[0], created_at: 'Sat Feb 07 04:39:56 +0000 2026' },
  core: { user_results: { result: { rest_id: '8888888888888888842', legacy: { name: sensitive[1],
    profile_image_url_https: sensitive[7] } } } }, [sensitive[3]]: sensitive[4] }
const payload = () => ({ data: { threaded_conversation_with_injections_v2: { instructions: [{ type: 'TimelineAddEntries', entries: [
  { entryId: `conversationthread-${replyId}`, content: { entryType: 'TimelineTimelineModule', items: [
    { item: { itemContent: { itemType: 'TimelineTweet', tweet_results: { result: structuredClone(raw) } } } }] } },
  { entryId: 'cursor-bottom-private', content: { cursorType: 'Bottom', value: sensitive[2] } },
] }] } } })
function replay(value, overrides = {}) {
  const request = normalizePostCommentsRequest({ platform: 'twitter', postId: rootId }, { provider: 'rapidapi' })
  return replayTwitterRawPage(value, { request, step: buildPostCommentsDispatch(request), capturedAt: '2026-11-17T00:00:00Z',
    parse: parseRapidApiTwitterCommentPage, project: projectPostCommentPage, workflowProject: projectPage,
    traversal: POST_COMMENTS_TRAVERSAL, isJsonSafe: isPostgresSafeJsonValue, ...overrides })
}
const privateFree = report => { const output = JSON.stringify(report); for (const value of sensitive) assert(!output.includes(value), value) }

test('offline replay reports three stages and fixed shape counts without content, IDs, URLs, cursors or arbitrary keys', () => {
  const result = replay(payload())
  assert.equal(result.jsonSafe, true)
  assert.deepEqual(result.parser, { ok: true, commentCount: 1, continuationPresent: true })
  assert.equal(result.projection.itemCount, 1)
  assert.equal(result.projection.recordFieldsJsonSafe, true)
  assert.deepEqual(result.workflow, { ok: true, itemCount: 1, recordCount: 1 })
  assert.deepEqual(result.shape.instructionTypes, { TimelineAddEntries: 1 })
  assert.deepEqual(result.shape.entryKinds, { conversationthread: 1, cursor: 1 })
  assert.deepEqual(result.shape.bottomValueStates, { nonempty: 1 })
  privateFree(result)
})

test('the actual standalone parser guard is located by reviewed stack frames, never by printing error text', () => {
  const value = payload()
  value.data.threaded_conversation_with_injections_v2.instructions.push({ type: 'TimelineAddToModule', moduleItems: [] })
  const result = replay(value)
  assert.equal(result.parser.ok, false)
  assert.equal(result.parser.code, 'invalid_upstream_contract')
  assert(result.parser.frames.some(frame => frame.file === 'contracts/twitter-rapid-comment-page.mjs' && frame.line > 12))
  assert.equal(result.projection.ok, false)
  assert.equal(result.workflow.ok, false)
  assert.equal(result.shape.instructionTypes.TimelineAddToModule, 1)
  privateFree(result)
  const arbitrary = new Error(sensitive.join('\n'))
  arbitrary.code = sensitive[0]
  arbitrary.stack = `Error: ${sensitive[0]}\n    at untrusted (/private/other.mjs:2:3)\n    at append (file:///app/server/contracts/twitter-rapid-comment-page.mjs:89:25)`
  assert.deepEqual(safeFailure(arbitrary), { code: 'diagnostic_unavailable', frames: [
    { file: 'contracts/twitter-rapid-comment-page.mjs', line: 89, column: 25 }] })
})

test('unknown schema values stay other and full bounded inspection records anomalies and explicit truncation', () => {
  const value = payload(), instruction = value.data.threaded_conversation_with_injections_v2.instructions[0]
  instruction.type = sensitive[4]
  instruction.entries[0].content.items[0].item.itemContent.tweet_results.result.legacy.full_text = null
  instruction.entries[0].content.items.push({ item: {} })
  instruction.entries.push({ entryId: sensitive[3], content: { entryType: sensitive[4] } })
  const result = summarizeTwitterRawShape(value)
  assert.equal(result.instructionTypes.other, 1)
  assert.equal(result.contentTypes.other, 2)
  assert.equal(result.anomalies.text_not_string, 1)
  assert.equal(result.anomalies.itemContent_not_object, 1)
  privateFree(result)
  instruction.entries[0].content.items = Array.from({ length: 2001 }, () => ({ item: {} }))
  const bounded = summarizeTwitterRawShape(value)
  assert.equal(bounded.itemsInspected, 2000)
  assert.equal(bounded.truncated, true)
})

test('workflow validation can fail separately after a successful parser and projection', () => {
  const value = payload()
  value.data.threaded_conversation_with_injections_v2.instructions[0].entries[0].content.items[0]
    .item.itemContent.tweet_results.result.legacy.full_text = 'text\u0000not-jsonb-safe'
  const result = replay(value)
  assert.equal(result.jsonSafe, false)
  assert.equal(result.parser.ok, true)
  assert.equal(result.projection.ok, true)
  assert.equal(result.projection.jsonSafe, false)
  assert.equal(result.workflow.ok, false)
  assert(result.workflow.frames.some(frame => frame.file === 'external-platforms/social-account-workflow.mjs'))
  privateFree(result)
})

test('fixed receipt query verifies owners, operation, endpoint and archive before any offline projection', async () => {
  const queries = [], client = { async query(sql, params) {
    queries.push({ sql, params })
    return { rows: sql === RECEIPT_SQL ? [{ body_bytes: Buffer.alloc(SOURCE.size), body_size: SOURCE.size, body_sha256: SOURCE.sha256 }] : [] }
  } }
  await assert.rejects(diagnoseSavedTwitterPage(client, {}), { code: 'archive_unverified' })
  assert.equal(queries[0].sql, 'BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
  assert.equal(queries.at(-1).sql, 'ROLLBACK')
  const read = queries.find(row => row.sql === RECEIPT_SQL)
  assert.deepEqual(read.params, [SOURCE.usageId, SOURCE.callId, 'native.r.twitter_aio_tweet_thread', SOURCE.size, SOURCE.sha256])
  for (const clause of ['c.tenant_id=u.tenant_id', 'c.consumer_id=u.consumer_id', 'c.api_key_id=u.api_key_id',
    'r.provider_call_id=c.id', 'c.operation=$3', 'c.endpoint_key=$3', "c.marketplace='twitter'", 'octet_length(r.body_bytes)=$4']) {
    assert(RECEIPT_SQL.includes(clause), clause)
  }
  assert(queries.every(row => /^(BEGIN|SET LOCAL|SELECT|ROLLBACK)/u.test(row.sql)))
  await assert.rejects(diagnoseSavedTwitterPage({ async query() { return { rows: [] } } }, {}), { code: 'source_unverified' })
})

test('CLI has no bypass option and the same standalone source executes through stdin without requiring deployed diagnostic code', () => {
  const url = new URL('../../server/ops/diagnose-twitter-rapid-comment-page.mjs', import.meta.url)
  const rejected = spawnSync(process.execPath, [fileURLToPath(url), '--skip-sha'], { encoding: 'utf8' })
  assert.equal(rejected.status, 1)
  assert.equal(JSON.parse(rejected.stdout).error.code, 'invalid_arguments')
  const stdin = spawnSync(process.execPath, ['--input-type=module', '-'], { encoding: 'utf8', input: readFileSync(url, 'utf8'),
    env: { ...process.env, DATABASE_URL: '', MX_INSIGHT_LISTENER_MODE: 'public' } })
  assert.equal(stdin.status, 1)
  assert.equal(JSON.parse(stdin.stdout).error.code, 'public_postgres_container_required')
  assert.equal(JSON.parse(stdin.stdout).supplierHttpCallsMade, 0)
  assert.equal(stdin.stderr, '')
})

test('fixed diagnostic SQL executes against the real 001/051/058/094 schemas and hash guard rejects fabricated bytes', {
  skip: !process.env.MX_INSIGHT_TEST_PGLITE_MODULE,
}, async t => {
  const { PGlite } = await import(pathToFileURL(process.env.MX_INSIGHT_TEST_PGLITE_MODULE).href)
  const db = new PGlite()
  t.after(() => db.close())
  const migration = name => readFileSync(new URL(`../../migrations/${name}.sql`, import.meta.url), 'utf8')
  await db.exec(migration('001_initial'))
  // All actual gateway tables/constraints, excluding only the unrelated
  // ingest_runs alteration whose schema belongs to another migration chain.
  await db.exec(migration('051_external_platform_gateway').split('-- Canonical ingest runs retain')[0])
  await db.exec(migration('058_external_platform_restricted_raw_responses'))
  await db.exec(migration('094_acquisition_request_snapshot'))
  const tenant = '10000000-0000-4000-8000-000000000001', consumer = '10000000-0000-4000-8000-000000000002'
  const apiKey = '10000000-0000-4000-8000-000000000003', fingerprint = 'a'.repeat(64)
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'synthetic')", [tenant])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'synthetic','diagnostic-fixture')", [consumer, tenant])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'synthetic',$4,'test','0000')",
    [apiKey, tenant, consumer, 'b'.repeat(64)])
  await db.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,response_status,acquisition_request)
    VALUES($1,$2,$3,$4,'synthetic',$5,'twitter','committed',502,$6::jsonb)`,
  [SOURCE.usageId, tenant, consumer, apiKey, fingerprint, JSON.stringify({ method: 'POST', path: '/api/v1/data/social/post-comments', body: { platform: 'twitter', postId: rootId } })])
  await db.query(`INSERT INTO external_platform.provider_calls(id,tenant_id,consumer_id,api_key_id,usage_request_id,request_fingerprint,
    provider_key,operation,endpoint_key,contract_version,endpoint_version,marketplace,outcome,http_status,completed_at)
    VALUES($1,$2,$3,$4,$5,$6,'rapidapi','native.r.twitter_aio_tweet_thread','native.r.twitter_aio_tweet_thread',
      'mx-insight-hub.native-forwarding.v1','twitter-aio.tweet-thread.2026-11-17','twitter','succeeded_unusable',200,now())`,
  [SOURCE.callId, tenant, consumer, apiKey, SOURCE.usageId, fingerprint])
  await db.query(`INSERT INTO control.external_platform_restricted_raw_responses
    (id,provider_call_id,body_size,body_sha256,body_bytes,json_parsed,captured_at) VALUES($1,$2,$3,$4,$5,false,now())`,
  ['10000000-0000-4000-8000-000000000004', SOURCE.callId, SOURCE.size, SOURCE.sha256, Buffer.alloc(SOURCE.size)])
  const params = [SOURCE.usageId, SOURCE.callId, 'native.r.twitter_aio_tweet_thread', SOURCE.size, SOURCE.sha256]
  assert.equal((await db.query(RECEIPT_SQL, params)).rows.length, 1)
  await assert.rejects(diagnoseSavedTwitterPage(db, {}), { code: 'archive_unverified' })
  await db.query("UPDATE external_platform.provider_calls SET operation='native.r.twitter_aio_tweet_replies' WHERE id=$1", [SOURCE.callId])
  assert.equal((await db.query(RECEIPT_SQL, params)).rows.length, 0)
  const columns = (await db.query("SELECT column_name FROM information_schema.columns WHERE table_schema='control' AND table_name='external_platform_restricted_raw_responses'")).rows
  assert.equal(columns.some(row => row.column_name === 'http_status'), false, 'only provider_calls has the status column')
})
