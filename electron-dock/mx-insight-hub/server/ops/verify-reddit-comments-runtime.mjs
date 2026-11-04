import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// Standalone Admin preparation and host acceptance. Imports never initialize a
// Hub service, grant permissions, fetch supplier data or change old receipts.
export const REDDIT_RUNTIME_SOURCE_REQUEST_ID = '7eb265f4-5c2c-4d15-91d5-7dc7fed83b61'
export const REDDIT_RUNTIME_SOURCE_IDEMPOTENCY_KEY = 'comment-calibration-v1-34a1dc86-2fc6-4de7-9818-56c987cd3c8b'
const ORIGIN = 'http://127.0.0.1:18150'
const PATH = '/api/v1/search/post-comments'
const NATIVE = 'native.t.api_c7f50cf300d63960'
const NATIVE_PATH = '/api/v1/data/native/t.api_c7f50cf300d63960'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const POST_ID = /^t3_[a-z0-9]{1,17}$/u
const COMMENT_ID = /^t1_[a-z0-9]{1,17}$/u
const SAFE_ERRORS = new Set(['invalid_arguments', 'invalid_sample', 'source_receipt_unverified', 'source_read_failed',
  'api_key_required', 'invalid_api_key', 'database_url_required'])
const RESPONSE_ERRORS = new Set(['invalid_api_key', 'test_key_not_supported', 'platform_not_granted', 'capability_not_granted',
  'request_outcome_unknown', 'request_in_progress', 'idempotency_conflict', 'post_comments_unavailable', 'invalid_cursor',
  'page_size_exceeded', 'plan_assignment_unavailable', 'insufficient_balance', 'resource_admission_limited',
  'external_platform_operation_disabled', 'external_platform_operation_paused', 'external_platform_contract_unverified',
  'external_platform_not_configured', 'external_platform_cost_control_unavailable', 'external_platform_circuit_open',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_rejected', 'social_upstream_rejected',
  'upstream_balance_exhausted', 'upstream_rate_limited', 'invalid_upstream_contract'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && UUID.test(value)
const count = value => Number.isSafeInteger(value) && value >= 0
const sha = value => createHash('sha256').update(value).digest('hex')
const sampleKeys = ['revision', 'platform', 'provider', 'sourceRequestId', 'postId']

function validateSample(sample) {
  if (!object(sample) || Object.keys(sample).length !== sampleKeys.length || Object.keys(sample).some(key => !sampleKeys.includes(key))
    || sample.revision !== 'reddit-comments-runtime-sample.v1' || sample.platform !== 'reddit' || sample.provider !== 'tikhub'
    || sample.sourceRequestId !== REDDIT_RUNTIME_SOURCE_REQUEST_ID || typeof sample.postId !== 'string' || !POST_ID.test(sample.postId)) {
    throw new Error('invalid_sample')
  }
  return sample
}

// Uses the already verified native acquisition, never the earlier discovery
// usage or a rescan. The private target is returned only in this explicit mode.
export async function prepareRedditCommentsRuntimeSample(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: usages } = await client.query(`SELECT /* reddit-runtime-sample:usage */
      id,idempotency_key,platform,status,response_status,
      CASE WHEN octet_length(acquisition_request::text) <= $2::integer THEN acquisition_request ELSE NULL END AS acquisition_request
      FROM public.usage_requests WHERE id=$1::uuid`, [REDDIT_RUNTIME_SOURCE_REQUEST_ID, 32768])
    const usage = usages.length === 1 ? usages[0] : null
    const snapshot = usage?.acquisition_request, params = snapshot?.body?.params
    if (!usage || usage.id !== REDDIT_RUNTIME_SOURCE_REQUEST_ID || usage.idempotency_key !== REDDIT_RUNTIME_SOURCE_IDEMPOTENCY_KEY
      || usage.platform !== 'social' || usage.status !== 'committed' || usage.response_status !== 200
      || !object(snapshot) || snapshot.method !== 'POST' || snapshot.path !== NATIVE_PATH || !object(snapshot.body)
      || !object(params) || typeof params.post_id !== 'string' || !POST_ID.test(params.post_id)
      || params.need_format !== false || params.after != null && params.after !== '') throw new Error('source_receipt_unverified')
    const { rows: calls } = await client.query(`SELECT /* reddit-runtime-sample:calls */
      provider_key,marketplace,endpoint_key,operation,contract_version,outcome,http_status,business_code,billed
      FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid ORDER BY started_at,id LIMIT 2`, [REDDIT_RUNTIME_SOURCE_REQUEST_ID])
    const call = calls.length === 1 ? calls[0] : null
    if (!call || call.provider_key !== 'tikhub' || call.marketplace !== 'reddit' || call.endpoint_key !== NATIVE
      || call.operation !== NATIVE || call.contract_version !== 'mx-insight-hub.native-forwarding.v1'
      || call.outcome !== 'succeeded' || call.http_status !== 200 || call.business_code !== 200 || call.billed !== true) {
      throw new Error('source_receipt_unverified')
    }
    return { revision: 'reddit-comments-runtime-sample.v1', platform: 'reddit', provider: 'tikhub',
      sourceRequestId: REDDIT_RUNTIME_SOURCE_REQUEST_ID, postId: params.post_id }
  } catch { throw new Error('source_receipt_unverified') }
  finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('source_read_failed')
  }
}

async function savedJson(file) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16384) throw new Error('invalid_sample')
    const bytes = await handle.readFile()
    if (bytes.length > 16384) throw new Error('invalid_sample')
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}

export async function loadRedditCommentsRuntimeSample(file) {
  try { return validateSample(await savedJson(file)) } catch { throw new Error('invalid_sample') }
}

async function verifyOriginal(directory) {
  try {
    const source = await savedJson(join(directory, 'reddit.json'))
    if (!object(source) || source.revision !== 'post-comment-contract-probe.v2' || source.provider !== 'tikhub'
      || source.platform !== 'reddit' || source.path !== NATIVE_PATH || source.state !== 'http_response'
      || source.httpStatus !== 200 || source.errorCode != null || source.hubRequestsMade !== 1
      || source.requestId !== REDDIT_RUNTIME_SOURCE_REQUEST_ID || source.requestIdSource !== 'usage_header'
      || source.idempotencyKey !== REDDIT_RUNTIME_SOURCE_IDEMPOTENCY_KEY || source.samplePurpose != null) {
      throw new Error('source_receipt_unverified')
    }
  } catch { throw new Error('source_receipt_unverified') }
}

async function responseJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid_response')
  const chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > 4194304) throw new Error('invalid_response')
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

function parentMatches(row, postId) {
  if (row.parentRelationship === 'unknown') return row.parentExternalId === null && row.parentCommentId === null && row.repliesIncluded === null
  if (row.parentRelationship === 'post') return row.parentExternalId === postId && row.parentCommentId === null && row.repliesIncluded === false
  return row.parentRelationship === 'comment' && typeof row.parentCommentId === 'string' && COMMENT_ID.test(row.parentCommentId)
    && row.parentExternalId === row.parentCommentId && row.parentCommentId !== row.commentId && row.repliesIncluded === true
}

function responseChecks(payload, postId, requestId) {
  const data = payload?.data, rows = data?.items, page = data?.page, info = data?.pageInfo, meta = data?.meta
  const items = Array.isArray(rows) && rows.length <= 20
  const nullableCount = value => value === null || count(value)
  const nullableCursor = value => value === null || typeof value === 'string' && value.startsWith('mxds1.')
    && value.length > 6 && value.length <= 16384 && !value.includes('\0')
  const checks = {
    contract: payload?.contractVersion === 'mx-insight-hub.post-comments.v1' && data?.platform === 'reddit'
      && data?.postId === postId && uuid(requestId) && payload?.requestId === requestId,
    items: items && isDeepStrictEqual(rows, data.comments) && data.raw_info === '[]' && data.raw_data === JSON.stringify(rows)
      && ['ok', 'partial'].includes(data.status) && Array.isArray(data.warnings),
    identities: items && new Set(rows.map(row => row?.commentId)).size === rows.length && rows.every(row => object(row)
      && typeof row.commentId === 'string' && COMMENT_ID.test(row.commentId)
      && row.id === `reddit:comment:${row.commentId}` && row.externalId === row.commentId && row.content_id === row.commentId
      && row.postId === postId && row.contentId === postId && row.rootExternalId === postId
      && row.platform === 'reddit' && row.objectType === 'comment' && row.type === 'comment'),
    fields: items && rows.every(row => object(row) && typeof row.text === 'string' && row.content === row.text
      && row.full_text === row.text && object(row.author) && typeof row.author.id === 'string' && row.author.id.length > 0
      && row.author.id.length <= 256 && !row.author.id.includes('\0') && row.author_id === row.author.id
      && typeof row.author.name === 'string' && row.author_name === row.author.name
      && typeof row.publishedAt === 'string' && Number.isFinite(Date.parse(row.publishedAt))
      && object(row.metrics) && (row.metrics.score === null || Number.isSafeInteger(row.metrics.score))
      && row.likeCount === null && row.like_count === null && row.metrics.likes === null
      && nullableCount(row.metrics.replies) && row.replyCount === row.metrics.replies && row.reply_count === row.metrics.replies
      && parentMatches(row, postId) && !Object.hasOwn(row, 'raw')),
    acquisition: object(meta) && meta.implementation === 'hub' && meta.scope === 'single_post'
      && meta.providerCalls === 1 && meta.upstreamCallCount === 1 && meta.upstreamPages === 1
      && meta.resultCount === rows?.length && meta.repliesFetched === false
      && items && meta.repliesIncluded === rows.some(row => row?.parentCommentId != null),
    pagination: object(page) && object(info) && page.page === 1 && page.pageSize === 20 && page.returnedCount === rows?.length
      && count(page.duplicateCount) && [true, false, null].includes(page.hasMore) && nullableCursor(page.nextCursor)
      && page.paginationMode === 'cursor' && ['exhausted', 'unknown', 'continuable'].includes(page.paginationStatus)
      && page.continuationAvailable === Boolean(page.nextCursor) && page.providerCursor === page.nextCursor && page.nextPage === null
      && isDeepStrictEqual(page.nextParams, page.nextCursor ? { cursor: page.nextCursor } : null)
      && (page.paginationStatus === 'exhausted' ? page.hasMore === false && page.nextCursor === null
        : page.paginationStatus === 'unknown' ? page.hasMore === null && page.nextCursor === null
          : page.hasMore === true && Boolean(page.nextCursor) && rows?.length === 20)
      && Object.entries(page).every(([key, value]) => isDeepStrictEqual(info[key], value))
      && info.pageIndex === 1 && info.cursorType === (page.nextCursor ? 'opaque' : 'none'),
  }
  const contractValid = Object.values(checks).every(Boolean), commentsObserved = items && rows.length > 0
  return { verified: contractValid && commentsObserved, contractValid, checks,
    returnedCount: items ? rows.length : null, commentsObserved,
    pagination: checks.pagination ? { hasMore: page.hasMore, continuationAvailable: page.continuationAvailable,
      paginationStatus: page.paginationStatus } : null }
}

async function writeSummary(handle, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2))
  let written = 0
  while (written < bytes.length) {
    const result = await handle.write(bytes, written, bytes.length - written, written)
    if (!result.bytesWritten) throw new Error('receipt_write_failed')
    written += result.bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

export async function runRedditCommentsRuntimeVerification({ sample, sampleDirectory, apiKey, apply = false }, { fetchImpl = fetch } = {}) {
  if (typeof sampleDirectory !== 'string' || !sampleDirectory || typeof apply !== 'boolean') throw new Error('invalid_arguments')
  const directory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  const marker = join(directory, 'reddit.unified-acceptance.json')
  const preview = { revision: 'reddit-comments-runtime-verification.v1', platform: 'reddit', provider: 'tikhub', path: PATH,
    sourceRequestId: REDDIT_RUNTIME_SOURCE_REQUEST_ID, hubRequestLimit: 1, automaticRetry: false, automaticContinuation: false }
  const attempted = preflightRequestsMade => ({ ...preview, state: 'already_attempted', hubRequestsMade: 0, preflightRequestsMade,
    boundary: 'The acceptance marker exists. Preserve it; do not delete it or change directories to repeat this acceptance.' })
  // lstat catches every existing object, including a dangling symlink. This
  // happens before source/Key validation and before even a free preflight GET.
  try { await lstat(marker); return attempted(0) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  validateSample(sample)
  await verifyOriginal(directory)
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0, preflightRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  if (typeof apiKey !== 'string' || !/^mih_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u.test(apiKey)) throw new Error('invalid_api_key')
  let preflight
  try {
    const response = await fetchImpl(`${ORIGIN}/api/v1/data/capabilities`, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${apiKey}` } })
    const payload = await responseJson(response), data = payload?.data
    preflight = { httpStatus: response.status,
      redditGranted: Array.isArray(data?.platforms) && data.platforms.some(row => (row?.platform ?? row) === 'reddit'),
      commentsGranted: Array.isArray(data?.capabilities) && data.capabilities.some(row => row?.capability === 'social.comments.list'),
      redditNativeReady: Array.isArray(data?.capabilities) && data.capabilities.some(row => row?.capability === NATIVE && row.ready === true) }
  } catch { return { ...preview, state: 'preflight_unavailable', hubRequestsMade: 0, preflightRequestsMade: 1 } }
  if (preflight.httpStatus !== 200 || !preflight.redditGranted || !preflight.commentsGranted || !preflight.redditNativeReady) {
    return { ...preview, state: 'preflight_rejected', preflight, hubRequestsMade: 0, preflightRequestsMade: 1 }
  }
  const body = JSON.stringify({ platform: 'reddit', contentId: sample.postId, count: 20, includeRaw: false })
  const before = { ...preview, state: 'dispatch_started', idempotencyKey: `reddit-comments-acceptance-v1-${randomUUID()}`,
    bodySha256: sha(body), preflight, preflightRequestsMade: 1, hubRequestsMade: null, requestId: null }
  let handle
  try { handle = await open(marker, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') return attempted(1); throw error }
  try {
    await writeSummary(handle, before)
    let result
    try {
      const response = await fetchImpl(`${ORIGIN}${PATH}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55000),
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': before.idempotencyKey }, body })
      const header = response.headers.get('x-mx-insight-request-id'), headerId = uuid(header) ? header : null
      result = { ...before, state: 'http_response', httpStatus: response.status, requestId: headerId,
        requestIdSource: headerId ? 'usage_header' : null, httpRequestId: null, hubRequestsMade: 1, verified: false }
      try {
        const payload = await responseJson(response)
        if (response.status === 200) Object.assign(result, responseChecks(payload, sample.postId, headerId))
        else {
          const durableErrorId = payload?.error?.details?.requestId
          if (!headerId && uuid(durableErrorId)) { result.requestId = durableErrorId; result.requestIdSource = 'error_details' }
          result.httpRequestId = uuid(payload?.requestId) ? payload.requestId : null
          result.errorCode = RESPONSE_ERRORS.has(payload?.error?.code) ? payload.error.code : 'other'
        }
      } catch { result.errorCode = 'response_unverified' }
    } catch {
      result = { ...before, state: 'outcome_unknown', hubRequestsMade: 1, verified: false,
        boundary: 'The request may have dispatched and charged. Keep this marker; no retry or continuation was made.' }
    }
    // Retain the exclusive file handle through settlement so a path replacement
    // cannot redirect this write. Failure still consumes the pre-dispatch slot.
    await writeSummary(handle, result)
    return result
  } finally { await handle.close() }
}

const stdinMain = process.argv[1] === '-' && import.meta.url.endsWith('/[eval1]')
if (stdinMain || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--prepare') {
      if (!process.env.DATABASE_URL) throw new Error('database_url_required')
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
        query_timeout: 6000, options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
      console.log(JSON.stringify(await prepareRedditCommentsRuntimeSample(pool)))
    } else {
      const apply = args.at(-1) === '--apply'
      if (apply) args.pop()
      if (args.length !== 4 || args[0] !== '--sample-dir' || args[2] !== '--sample') throw new Error('invalid_arguments')
      const result = await runRedditCommentsRuntimeVerification({ sampleDirectory: args[1],
        sample: await loadRedditCommentsRuntimeSample(args[3]), apiKey: process.env.MX_HUB_PROBE_API_KEY, apply })
      console.log(JSON.stringify(result, null, 2))
      if (apply && result.state !== 'already_attempted' && result.verified !== true) process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'reddit_comments_verification_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
