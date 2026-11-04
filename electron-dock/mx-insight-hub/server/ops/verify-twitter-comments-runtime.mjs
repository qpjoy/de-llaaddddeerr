import { createHash, randomUUID } from 'node:crypto'
import { open, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { loadTwitterConversationCommentProbeSample, planTwitterConversationCommentProbe } from './probe-post-comment-contract.mjs'

const ORIGIN = 'http://127.0.0.1:18150'
const PATH = '/api/v1/search/post-comments'
const NATIVE = 'native.t.api_3cd88a6621a01120'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ERRORS = new Set(['invalid_arguments', 'invalid_sample', 'source_receipt_unverified', 'api_key_required', 'invalid_api_key'])
const RESPONSE_ERRORS = new Set(['invalid_api_key', 'test_key_not_supported', 'platform_not_granted', 'capability_not_granted',
  'request_outcome_unknown', 'request_in_progress', 'idempotency_conflict', 'post_comments_unavailable',
  'page_size_exceeded', 'plan_assignment_unavailable', 'insufficient_balance', 'resource_admission_limited',
  'external_platform_operation_disabled', 'external_platform_operation_paused', 'external_platform_contract_unverified',
  'external_platform_not_configured', 'external_platform_cost_control_unavailable', 'external_platform_circuit_open',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_rejected', 'social_upstream_rejected',
  'upstream_balance_exhausted', 'upstream_rate_limited'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const uuid = value => typeof value === 'string' && UUID.test(value)
const count = value => Number.isSafeInteger(value) && value >= 0

async function savedJson(file) {
  if ((await stat(file)).size > 16384) throw new Error('source_receipt_unverified')
  const bytes = await readFile(file)
  if (bytes.length > 16384) throw new Error('source_receipt_unverified')
  return JSON.parse(bytes.toString('utf8'))
}

async function verifySources(directory, sample, sourceRequestId) {
  const plan = planTwitterConversationCommentProbe(sample)
  if (!uuid(sourceRequestId) || sourceRequestId === sample.sourceRequestId) throw new Error('invalid_arguments')
  try {
    let original
    try { original = await savedJson(join(directory, 'twitter.auth-retry.json')) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      original = await savedJson(join(directory, 'twitter.json'))
    }
    const conversation = await savedJson(join(directory, 'twitter.conversation.json'))
    const successful = row => object(row) && row.revision === 'post-comment-contract-probe.v2'
      && row.provider === 'tikhub' && row.platform === 'twitter' && row.path === plan.path
      && row.state === 'http_response' && row.httpStatus === 200 && row.errorCode == null
      && row.hubRequestsMade === 1 && row.requestIdSource === 'usage_header' && uuid(row.requestId)
      && typeof row.idempotencyKey === 'string' && row.idempotencyKey.startsWith('comment-calibration-v1-')
      && uuid(row.idempotencyKey.slice('comment-calibration-v1-'.length))
    if (!successful(original) || original.samplePurpose != null || original.requestId !== sample.sourceRequestId
      || !successful(conversation) || conversation.samplePurpose !== 'conversation_comments'
      || conversation.sourceRequestId !== original.requestId || conversation.requestId !== sourceRequestId
      || conversation.idempotencyKey === original.idempotencyKey) throw new Error('source_receipt_unverified')
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

function responseChecks(payload, postId, requestId) {
  const data = payload?.data, rows = data?.items, page = data?.page, info = data?.pageInfo, meta = data?.meta
  const items = Array.isArray(rows) && rows.length <= 20
  const nullableCount = value => value === null || count(value)
  const nullableCursor = value => value === null || typeof value === 'string' && value.startsWith('mxds1.') && value.length <= 16384
  const checks = {
    contract: payload?.contractVersion === 'mx-insight-hub.post-comments.v1' && data?.platform === 'twitter'
      && data?.postId === postId && uuid(requestId) && payload?.requestId === requestId,
    items: items && isDeepStrictEqual(rows, data.comments) && data.raw_info === '[]' && data.raw_data === JSON.stringify(rows),
    identities: items && new Set(rows.map(row => row?.commentId)).size === rows.length && rows.every(row => object(row)
      && typeof row.commentId === 'string' && /^\d{1,30}$/u.test(row.commentId) && row.commentId !== postId
      && row.content_id === row.commentId && row.postId === postId && row.contentId === postId
      && row.rootExternalId === postId && row.platform === 'twitter' && row.objectType === 'comment'),
    fields: items && rows.every(row => object(row) && typeof row.text === 'string' && row.content === row.text
      && row.full_text === row.text && typeof row.author?.id === 'string' && row.author_id === row.author.id
      && /^\d{1,30}$/u.test(row.author.id) && typeof row.author.name === 'string'
      && typeof row.publishedAt === 'string' && Number.isFinite(Date.parse(row.publishedAt))
      && object(row.metrics) && ['likes', 'replies', 'shares', 'views', 'bookmarks', 'quotes'].every(key => nullableCount(row.metrics[key]))
      && row.parentExternalId === null && row.parentCommentId === null && row.parentRelationship === 'unknown'
      && !Object.hasOwn(row, 'raw')),
    acquisition: object(meta) && meta.implementation === 'hub' && meta.scope === 'single_post'
      && meta.providerCalls === 1 && meta.upstreamCallCount === 1 && meta.upstreamPages === 1
      && meta.resultCount === rows?.length && meta.repliesFetched === false,
    pagination: object(page) && object(info) && page.page === 1 && page.pageSize === 20 && page.returnedCount === rows?.length
      && count(page.duplicateCount) && [true, null].includes(page.hasMore) && nullableCursor(page.nextCursor)
      && page.paginationMode === 'cursor' && ['continuable', 'unknown'].includes(page.paginationStatus)
      && page.continuationAvailable === Boolean(page.nextCursor) && page.providerCursor === page.nextCursor && page.nextPage === null
      && isDeepStrictEqual(page.nextParams, page.nextCursor ? { cursor: page.nextCursor } : null)
      && (page.hasMore === true ? page.paginationStatus === 'continuable' && Boolean(page.nextCursor) : page.paginationStatus === 'unknown')
      && Object.entries(page).every(([key, value]) => isDeepStrictEqual(info[key], value))
      && info.pageIndex === 1 && info.cursorType === (page.nextCursor ? 'opaque' : 'none'),
  }
  const contractValid = Object.values(checks).every(Boolean), commentsObserved = items && rows.length > 0
  // A valid empty page is possible, but cannot establish positive field
  // delivery. It consumes this acceptance slot without authorizing a retry.
  return { verified: contractValid && commentsObserved, contractValid, checks,
    returnedCount: items ? rows.length : null, commentsObserved,
    pagination: checks.pagination ? { hasMore: page.hasMore, continuationAvailable: page.continuationAvailable,
      paginationStatus: page.paginationStatus } : null }
}

// Run only with the freshly prepared private sample from the saved-archive
// inspector. Old native receipts bind its source chain, not its private target.
// This explicit acceptance has its own single durable slot in that same folder.
export async function runTwitterCommentsRuntimeVerification({ conversationSample, sourceRequestId, sampleDirectory,
  apiKey, apply = false }, { fetchImpl = fetch } = {}) {
  if (typeof sampleDirectory !== 'string' || !sampleDirectory || typeof apply !== 'boolean') throw new Error('invalid_arguments')
  const directory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  await verifySources(directory, conversationSample, sourceRequestId)
  const preview = { revision: 'twitter-comments-runtime-verification.v1', platform: 'twitter', provider: 'tikhub', path: PATH,
    sourceRequestId, originalSourceRequestId: conversationSample.sourceRequestId, hubRequestLimit: 1,
    automaticRetry: false, automaticContinuation: false }
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0, preflightRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  // Match the Live format issued by server/core/crypto.mjs, never a supplier
  // credential or the historical Test label (which is not a free sandbox).
  if (typeof apiKey !== 'string' || !/^mih_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u.test(apiKey)) throw new Error('invalid_api_key')
  const marker = join(directory, 'twitter.unified-acceptance.json')
  const attempted = () => ({ ...preview, state: 'already_attempted', hubRequestsMade: 0,
    boundary: 'The acceptance marker exists. Preserve it and inspect the saved request; do not retry in another directory.' })
  try { await stat(marker); return { ...attempted(), preflightRequestsMade: 0 } }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  let preflight
  try {
    const response = await fetchImpl(`${ORIGIN}/api/v1/data/capabilities`, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${apiKey}` } })
    const payload = await responseJson(response), data = payload?.data
    preflight = { httpStatus: response.status,
      twitterGranted: Array.isArray(data?.platforms) && data.platforms.some(row => (row?.platform ?? row) === 'twitter'),
      commentsGranted: Array.isArray(data?.capabilities) && data.capabilities.some(row => row?.capability === 'social.comments.list'),
      twitterNativeReady: Array.isArray(data?.capabilities) && data.capabilities.some(row => row?.capability === NATIVE && row.ready === true) }
    // comments.ready currently describes Xiaohongshu, not Twitter. The native
    // grant is a calibration preflight convenience, not a business requirement.
  } catch {
    return { ...preview, state: 'preflight_unavailable', hubRequestsMade: 0, preflightRequestsMade: 1 }
  }
  if (preflight.httpStatus !== 200 || !preflight.twitterGranted || !preflight.commentsGranted || !preflight.twitterNativeReady) {
    return { ...preview, state: 'preflight_rejected', preflight, hubRequestsMade: 0, preflightRequestsMade: 1 }
  }
  const body = JSON.stringify({ platform: 'twitter', contentId: conversationSample.postId, count: 20, includeRaw: false })
  const before = { ...preview, state: 'dispatch_started', idempotencyKey: `twitter-comments-acceptance-v1-${randomUUID()}`,
    bodySha256: sha(body), preflight, preflightRequestsMade: 1, hubRequestsMade: null, requestId: null }
  let handle
  try { handle = await open(marker, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return { ...attempted(), preflightRequestsMade: 1 }
  }
  try { await handle.writeFile(JSON.stringify(before)); await handle.sync() }
  finally { await handle.close() }
  let result
  try {
    const response = await fetchImpl(`${ORIGIN}${PATH}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': before.idempotencyKey }, body })
    const header = response.headers.get('x-mx-insight-request-id'), requestId = uuid(header) ? header : null
    result = { ...before, state: 'http_response', httpStatus: response.status, requestId,
      requestIdSource: requestId ? 'usage_header' : null, hubRequestsMade: 1, verified: false }
    try {
      const payload = await responseJson(response)
      if (response.status === 200) Object.assign(result, responseChecks(payload, conversationSample.postId, requestId))
      else result.errorCode = RESPONSE_ERRORS.has(payload?.error?.code) ? payload.error.code : 'other'
    } catch { result.errorCode = 'response_unverified' }
  } catch {
    result = { ...before, state: 'outcome_unknown', hubRequestsMade: 1, verified: false,
      boundary: 'The request may have dispatched and charged. Preserve this marker; no retry or continuation was made.' }
  }
  // Only safe summary fields are saved. Raw comments, root IDs and cursors stay
  // in the Hub; a failed final write still leaves the exclusive attempt marker.
  await writeFile(marker, JSON.stringify(result, null, 2), { mode: 0o600 })
  return result
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), apply = args.at(-1) === '--apply'
    if (apply) args.pop()
    if (args.length !== 6 || args[0] !== '--sample-dir' || args[2] !== '--twitter-conversation-sample'
      || args[4] !== '--source-request-id') throw new Error('invalid_arguments')
    const result = await runTwitterCommentsRuntimeVerification({ sampleDirectory: args[1],
      conversationSample: await loadTwitterConversationCommentProbeSample(args[3]), sourceRequestId: args[5],
      apiKey: process.env.MX_HUB_PROBE_API_KEY, apply })
    console.log(JSON.stringify(result, null, 2))
    if (apply && result.state !== 'already_attempted' && result.verified !== true) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'twitter_comments_verification_failed' }))
    process.exitCode = 1
  }
}
