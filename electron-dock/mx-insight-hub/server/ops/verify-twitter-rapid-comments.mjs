// Installed Public runtime only. Preview and old --execute read existing receipts.
// Only --resume-thread can spend the remaining two calls after the known failure;
// normal Hub controls remain active and recovered TikHub routes are never changed.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const REVISION = 'twitter-rapid-comments-check.v1'
export const SOURCE_REQUEST_ID = '7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b'
export const OPERATION = 'native.r.twitter_aio_tweet_replies'
export const KEYS = Object.freeze(['first', 'next', 'replies'].map(stage => `ops-twitter-rapid-comments-7e7cd2d0-v1-${stage}`))
export const THREAD_OPERATION = 'native.r.twitter_aio_tweet_thread'
export const THREAD_KEYS = Object.freeze(['first', 'replies'].map(stage => `ops-twitter-rapid-comments-7e7cd2d0-v1-thread-${stage}`))
export const RESUME_SOURCE = Object.freeze({ requestId: 'e813c900-44b2-45e8-bf84-6eb8786b1a5e',
  callId: 'dc07998d-21c6-44cd-8f48-5f99f7e7918c', bodySize: 77,
  sha256: 'a8f881027fc841cd737652640dbc864c94af4fe55f612ace64236059ed25a9a2' })
const ALL_KEYS = [...KEYS, ...THREAD_KEYS]
const STAGES = [{ stage: 'first', kind: 'first', key: KEYS[0] }, { stage: 'next', kind: 'next', key: KEYS[1] },
  { stage: 'replies', kind: 'replies', key: KEYS[2] }, { stage: 'thread-first', kind: 'first', key: THREAD_KEYS[0] },
  { stage: 'thread-replies', kind: 'replies', key: THREAD_KEYS[1] }]
const OLD_OPERATION = 'native.t.api_3cd88a6621a01120'
const COMMENTS = '/api/v1/data/social/post-comments', REPLIES = '/api/v1/data/social/comment-replies'
const MAX_BYTES = 4 * 1024 * 1024, MAX_CALLS = 3, PAGE_SIZE = 100
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const id = value => typeof value === 'string' && /^\d{1,30}$/u.test(value)
const uuid = value => typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0
const owned = (row, source) => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => row?.[key] === source?.[key])
const requireValue = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const SAFE_ERRORS = new Set(['needs_deploy', 'invalid_arguments', 'public_postgres_container_required', 'source_unverified',
  'archive_unverified', 'original_owner_unavailable', 'original_grants_unavailable', 'operation_not_ready',
  'verification_in_progress', 'receipt_owner_mismatch', 'saved_call_budget_exceeded', 'unexpected_diagnostic_operation',
  'unexpected_diagnostic_request', 'stage_already_dispatched', 'saved_receipt_unverified', 'compatibility_unverified',
  'source_changed', 'saved_outcome_not_successful', 'request_outcome_unknown', 'request_in_progress', 'insufficient_balance',
  'external_platform_outcome_unknown', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'external_platform_rejected', 'external_platform_operation_blocked', 'external_platform_operation_disabled',
  'external_platform_operation_paused', 'external_platform_operation_canary', 'external_platform_rate_limited',
  'external_platform_busy', 'invalid_social_contract', 'invalid_upstream_contract', 'page_size_exceeded',
  'platform_not_granted', 'capability_not_granted', 'comment_acquisition_paused', 'resume_source_unverified', 'recovered_routes_required'])
const safeCode = error => SAFE_ERRORS.has(error?.code) ? error.code : 'verification_unavailable'

// Classify only fixed error phrases from hash-verified archives. Never return
// arbitrary supplier messages, echoed credentials, target IDs or URLs.
export function inspectRapidCommentError(payload, subjectId) {
  const candidates = [['message', payload?.message], ['detail', payload?.detail], ['error', payload?.error],
    ['error.message', payload?.error?.message], ['errors[0].message', payload?.errors?.[0]?.message]]
    .filter(([, value]) => typeof value === 'string' && value.length <= 1024)
  const signals = []
  for (const [field, value] of candidates) {
    const message = value.trim()
    const missing = /^Endpoint ["']([^"'\r\n]+)["'] does not exist[.!]?$/iu.exec(message)
    if (missing) {
      const route = /^\/tweet\/([0-9]{1,30})(\/replies)?$/u.exec(missing[1])
      signals.push({ field, category: 'endpoint_path_not_found',
        pathTemplate: route ? `/tweet/{tweetId}${route[2] || ''}` : 'unrecognized',
        matchesRequestedRepliesPath: Boolean(route && route[1] === subjectId && route[2] === '/replies') })
    } else if (/^(?:Tweet|Post)(?: with (?:ID|id) [0-9]{1,30})? (?:not found|does not exist|is unavailable)[.!]?$/iu.test(message)) {
      signals.push({ field, category: 'tweet_unavailable' })
    } else if (/^You are not subscribed to this API[.!]?$/iu.test(message)) {
      signals.push({ field, category: 'subscription_required' })
    }
  }
  const categories = [...new Set(signals.map(row => row.category))]
  return { category: categories.length === 1 ? categories[0] : categories.length ? 'conflicting_signals' : 'unclassified',
    messageFields: candidates.map(([field]) => field), signals }
}

async function archive(executor, callId, { optional = false } = {}) {
  const { rows } = await executor.query(`SELECT /* twitter-rapid-check:archive */ body_size,body_sha256,
    CASE WHEN body_size <= $2 AND octet_length(body_bytes) <= $2 THEN body_bytes END AS body_bytes
    FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1`, [callId, MAX_BYTES])
  const row = rows[0], bytes = row?.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  if (optional && !rows.length) return { summary: { archiveState: 'not_available' } }
  requireValue(rows.length === 1 && Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES
    && row.body_size === bytes.length && row.body_sha256 === sha(bytes), 'archive_unverified')
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { requireValue(false, 'archive_unverified') }
  return { payload, summary: { archiveState: 'verified', bodySize: bytes.length, sha256: row.body_sha256, hashVerified: true } }
}

async function sourceReceipt(executor) {
  const { rows } = await executor.query(`SELECT /* twitter-rapid-check:source */ id,tenant_id,consumer_id,api_key_id,
    platform,status,response_status,CASE WHEN octet_length(acquisition_request::text)<=32768
    THEN acquisition_request END AS acquisition_request FROM public.usage_requests WHERE id=$1`, [SOURCE_REQUEST_ID])
  const source = rows[0], request = source?.acquisition_request, postId = request?.body?.params?.tweet_id
  requireValue(rows.length === 1 && source.status === 'committed' && source.response_status === 200
    && ['social','twitter'].includes(source.platform) && [source.tenant_id,source.consumer_id,source.api_key_id].every(uuid)
    && request?.method === 'POST' && request.path === `/api/v1/data/native/${OLD_OPERATION.slice(7)}` && id(postId), 'source_unverified')
  const { rows: calls } = await executor.query(`SELECT /* twitter-rapid-check:source-calls */ id,tenant_id,consumer_id,
    api_key_id,provider_key,operation,endpoint_key,marketplace,outcome,http_status,billed,contract_version
    FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY call_ordinal LIMIT 2`, [SOURCE_REQUEST_ID])
  const call = calls[0]
  requireValue(calls.length === 1 && owned(call, source) && call.provider_key === 'tikhub'
    && call.operation === OLD_OPERATION && call.endpoint_key === OLD_OPERATION && call.marketplace === 'twitter'
    && call.contract_version === 'mx-insight-hub.native-forwarding.v1'
    && call.outcome === 'succeeded' && call.http_status === 200 && call.billed === true, 'source_unverified')
  const saved = await archive(executor, call.id), data = saved.payload?.data
  requireValue(saved.payload?.code === 200 && data?.id === postId && data.conversation_id === postId
    && Array.isArray(data.thread) && data.thread.length > 0 && data.thread.length <= 1000, 'source_unverified')
  const candidate = data.thread.find(row => id(row?.id) && row.id !== postId && row.conversation_id === postId
    && Number.isSafeInteger(row.replies) && row.replies > 0)
  return { source, postId, fallbackReply: candidate ? { platform: 'twitter', commentId: candidate.id, contentId: postId } : null,
    digest: sha(JSON.stringify([source, calls, saved.summary])),
    summary: { requestId: SOURCE_REQUEST_ID, ...saved.summary, commentCount: data.thread.length, replyCandidateAvailable: Boolean(candidate) } }
}

async function readOwner(executor, source) {
  const { rows } = await executor.query(`SELECT /* twitter-rapid-check:owner */ k.id AS api_key_id,k.tenant_id,k.consumer_id,
    k.environment,k.status AS key_status,k.expires_at,c.status AS consumer_status,t.status AS tenant_status,
    EXISTS(SELECT 1 FROM platform_grants g WHERE g.consumer_id=k.consumer_id AND g.platform='twitter')
      AND (k.scope_mode='legacy_dynamic' OR e.api_key_id IS NOT NULL) AS twitter_granted,
    EXISTS(SELECT 1 FROM capability_grants g WHERE g.consumer_id=k.consumer_id AND g.capability='social.comments.list')
      AND (k.scope_mode='legacy_dynamic' OR EXISTS(SELECT 1 FROM api_key_capability_entitlements ce
        WHERE ce.api_key_id=k.id AND ce.capability='social.comments.list')) AS comments_granted,
    LEAST(100,coalesce(p.max_page_size,100),coalesce(e.max_page_size,p.max_page_size,100)) AS page_size
    FROM api_keys k JOIN consumers c ON c.id=k.consumer_id JOIN tenants t ON t.id=k.tenant_id
    LEFT JOIN consumer_platform_policies p ON p.consumer_id=k.consumer_id AND p.platform='twitter'
    LEFT JOIN api_key_platform_entitlements e ON e.api_key_id=k.id AND e.platform='twitter' WHERE k.id=$1`, [source.api_key_id])
  const row = rows[0]
  requireValue(rows.length === 1 && owned(row, source) && row.environment === 'live'
    && [row.key_status,row.consumer_status,row.tenant_status].every(value => value === 'active')
    && new Date(row.expires_at).getTime() > Date.now(), 'original_owner_unavailable')
  requireValue(row.twitter_granted && row.comments_granted, 'original_grants_unavailable')
  requireValue(Number.isSafeInteger(row.page_size) && row.page_size >= 1 && row.page_size <= PAGE_SIZE, 'page_size_exceeded')
  return row.page_size
}

async function savedAttempts(executor, source) {
  const { rows } = await executor.query(`SELECT /* twitter-rapid-check:saved */ id,tenant_id,consumer_id,api_key_id,
    idempotency_key,platform,status,response_status,
    CASE WHEN octet_length(response_body::text)<=$3 THEN response_body END AS response_body,
    CASE WHEN octet_length(acquisition_request::text)<=32768 THEN acquisition_request END AS acquisition_request
    FROM public.usage_requests WHERE consumer_id=$1 AND idempotency_key=ANY($2::text[]) ORDER BY idempotency_key LIMIT 6`,
  [source.consumer_id, ALL_KEYS, MAX_BYTES])
  requireValue(rows.length <= ALL_KEYS.length && rows.every(row => owned(row, source) && ALL_KEYS.includes(row.idempotency_key))
    && new Set(rows.map(row => row.idempotency_key)).size === rows.length, 'receipt_owner_mismatch')
  const { rows: calls } = await executor.query(`SELECT /* twitter-rapid-check:budget */ call.id,call.usage_request_id,
    call.tenant_id,call.consumer_id,call.api_key_id,call.provider_key,call.operation,call.endpoint_key,call.outcome,call.http_status,call.billed,
    request.tenant_id AS request_tenant_id,request.api_key_id AS request_api_key_id
    FROM external_platform.provider_calls call JOIN public.usage_requests request ON request.id=call.usage_request_id
    WHERE request.consumer_id=$1 AND request.idempotency_key=ANY($2::text[]) LIMIT 4`, [source.consumer_id, ALL_KEYS])
  requireValue(calls.length <= MAX_CALLS, 'saved_call_budget_exceeded')
  requireValue(calls.every(call => {
    const request = rows.find(row => row.id === call.usage_request_id)
    const operation = THREAD_KEYS.includes(request?.idempotency_key) ? THREAD_OPERATION : OPERATION
    return request && owned(call, source) && call.request_tenant_id === source.tenant_id
      && call.request_api_key_id === source.api_key_id && call.provider_key === 'rapidapi'
      && call.operation === operation && call.endpoint_key === operation
  }), 'receipt_owner_mismatch')
  return { rows, calls }
}

function pageSummary(body, request, stage) {
  const data = body?.data, items = data?.items, page = data?.page, replies = stage === 'replies'
  requireValue(body?.contractVersion === `mx-insight-hub.${replies ? 'comment-replies' : 'post-comments'}.v1`
    && data?.platform === 'twitter' && Array.isArray(items) && items.length <= PAGE_SIZE
    && isDeepStrictEqual(items, data[replies ? 'replies' : 'comments']) && data.raw_info === '[]'
    && typeof data.raw_data === 'string', 'compatibility_unverified')
  let raw
  try { raw = JSON.parse(data.raw_data) } catch { requireValue(false, 'compatibility_unverified') }
  const target = replies ? request.replyRef?.commentId : request.postId
  requireValue(isDeepStrictEqual(raw, items) && (replies ? data.commentId : data.postId) === target
    && new Set(items.map(row => row.commentId)).size === items.length
    && items.every(row => id(row.commentId) && row.commentId !== target && row.content_id === row.commentId
      && row.platform === 'twitter' && row.objectType === 'comment' && typeof row.text === 'string'
      && row.content === row.text && row.full_text === row.text && object(row.author)
      && row.author_id === (row.author.id ?? null) && (row.publishedAt === null || Number.isFinite(Date.parse(row.publishedAt)))
      && (row.likeCount === null || integer(row.likeCount)) && row.like_count === row.likeCount
      && (row.replyCount === null || integer(row.replyCount)) && row.reply_count === row.replyCount
      && (replies ? row.rootCommentId === target : row.postId === target && row.replyRef?.commentId === row.commentId
        && row.replyRef.platform === 'twitter' && row.replyRef.contentId === (row.conversationId ?? row.contentId)))
    && object(page) && [true,false,null].includes(page.hasMore) && page.returnedCount === items.length
    && (page.nextCursor === null || typeof page.nextCursor === 'string' && /^mxds1\./u.test(page.nextCursor))
    && Object.entries(page).every(([key, value]) => isDeepStrictEqual(data.pageInfo?.[key], value)), 'compatibility_unverified')
  return { publicContractValid: true, positiveRowsObserved: items.length > 0,
    resultCount: items.length, textCount: items.filter(row => row.text.length).length,
    authorIdCount: items.filter(row => id(row.author_id)).length, publishedAtCount: items.filter(row => row.publishedAt !== null).length,
    aliasesVerified: true, rawStringWrapperVerified: true, referencesVerified: true,
    hasMore: page.hasMore, nextCursorPresent: Boolean(page.nextCursor),
    paginationStatus: ['continuable','exhausted','unknown','limit_reached'].includes(page.paginationStatus) ? page.paginationStatus : 'other' }
}

async function summarizeSaved(executor, saved, source) {
  const stages = []
  for (const { stage, kind, key } of STAGES) {
    const row = saved.rows.find(row => row.idempotency_key === key)
    if (!row) { stages.push({ stage, state: 'not_attempted' }); continue }
    const request = row.acquisition_request, expectedPath = kind === 'replies' ? REPLIES : COMMENTS
    requireValue(row.platform === 'twitter' && request?.method === 'POST' && request.path === expectedPath
      && request.body?.platform === 'twitter' && (kind === 'replies' ? id(request.body.replyRef?.commentId)
        && request.body.replyRef.contentId === source.postId : request.body.postId === source.postId), 'saved_receipt_unverified')
    const calls = saved.calls.filter(call => call.usage_request_id === row.id)
    requireValue(calls.length <= 1, 'saved_call_budget_exceeded')
    const summaries = []
    for (const call of calls) {
      let evidence
      try {
        const savedArchive = await archive(executor, call.id, { optional: call.outcome !== 'succeeded' })
        evidence = { ...savedArchive.summary,
          ...(call.outcome === 'rejected' && savedArchive.summary.hashVerified
            ? { errorInspection: inspectRapidCommentError(savedArchive.payload,
              kind === 'replies' ? request.body.replyRef.commentId : source.postId) } : {}) }
      }
      catch (error) {
        if (call.outcome === 'succeeded') throw error
        evidence = { archiveState: 'integrity_unverified', hashVerified: false }
      }
      summaries.push({ callId: call.id, outcome: ['succeeded','succeeded_unusable','rejected','unknown','pending'].includes(call.outcome) ? call.outcome : 'other',
        httpStatus: Number.isInteger(call.http_status) ? call.http_status : null,
        billed: typeof call.billed === 'boolean' ? call.billed : null, ...evidence })
    }
    const successful = row.status === 'committed' && row.response_status === 200
      && (calls.length === 1 || kind === 'next') && calls.every(call => call.outcome === 'succeeded' && call.http_status === 200)
    stages.push({ stage, state: successful ? 'saved_success' : 'saved_failure_or_pending', requestId: row.id,
      httpStatus: Number.isInteger(row.response_status) ? row.response_status : null, providerCalls: summaries,
      ...(kind === 'next' ? { upstreamContinuationVerified: successful && calls.length === 1 } : {}),
      ...(successful ? pageSummary(row.response_body, request.body, kind) : {}) })
  }
  return stages
}

// This guard consumes only summaries produced after archive integrity checks.
// The one rejected HTTP attempt still consumes one of the original three calls.
export function assertThreadResumeEvidence(saved, stages) {
  const rows = saved.rows.filter(row => KEYS.includes(row.idempotency_key))
  const calls = saved.calls.filter(call => rows.some(row => row.id === call.usage_request_id))
  const first = stages.find(row => row.stage === 'first'), evidence = first?.providerCalls?.[0]
  requireValue(rows.length === 1 && rows[0].id === RESUME_SOURCE.requestId && rows[0].idempotency_key === KEYS[0]
    && rows[0].status === 'released' && rows[0].response_status === 502
    && calls.length === 1 && calls[0].id === RESUME_SOURCE.callId && calls[0].operation === OPERATION
    && calls[0].endpoint_key === OPERATION && calls[0].outcome === 'rejected'
    && calls[0].http_status === 404 && calls[0].billed === false
    && first?.requestId === RESUME_SOURCE.requestId && evidence?.callId === RESUME_SOURCE.callId
    && evidence.hashVerified === true && evidence.bodySize === RESUME_SOURCE.bodySize && evidence.sha256 === RESUME_SOURCE.sha256
    && evidence.errorInspection?.category === 'endpoint_path_not_found'
    && evidence.errorInspection.signals.some(row => row.matchesRequestedRepliesPath === true), 'resume_source_unverified')
}

async function readRoutes(executor) {
  return (await executor.query(`SELECT /* twitter-rapid-check:routes */ interface_key,mode,
    primary_provider,fallback_provider,revision FROM control.strategy_search_routes
    WHERE platform='twitter' AND interface_key IN ('post-comments','comment-replies') ORDER BY interface_key`)).rows
}
const safeRoutes = rows => rows.map(row => ({ interface: row.interface_key, mode: row.mode,
  primaryProvider: row.primary_provider, fallbackProvider: row.fallback_provider, revision: row.revision }))
const requireRecoveredRoutes = rows => requireValue(rows.length === 2 && rows.every(row => row.mode === 'fixed'
  && row.primary_provider === 'tikhub' && row.fallback_provider === null), 'recovered_routes_required')
const originalAttemptDigest = (saved, stages) => sha(JSON.stringify([
  saved.rows.filter(row => KEYS.includes(row.idempotency_key)), saved.calls.filter(call => call.operation === OPERATION), stages.slice(0, 3),
]))

export async function previewRapidComments({ pool, installed = true, readiness = async () => ({ ready: false }),
  resumeThread = false, resumeEvidenceCheck = assertThreadResumeEvidence }) {
  const report = { diagnosticRevision: REVISION, mode: 'preview', installedContract: installed,
    savedErrorInspectionVersion: 1, maxSupplierCalls: MAX_CALLS, supplierHttpCallsMade: 0 }
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    const source = await sourceReceipt(client); report.source = source.summary
    const routes = await readRoutes(client); report.routes = safeRoutes(routes)
    const saved = await savedAttempts(client, source.source)
    report.savedProviderCalls = saved.calls.length
    if (saved.rows.length || saved.calls.length) {
      report.mode = 'read_saved_only'; report.stages = await summarizeSaved(client, saved, source)
      if (!resumeThread || saved.rows.some(row => THREAD_KEYS.includes(row.idempotency_key))) return report
    }
    if (resumeThread) {
      resumeEvidenceCheck(saved, report.stages || []); requireRecoveredRoutes(routes)
      report.mode = 'resume_thread_preview'; report.remainingSupplierCalls = MAX_CALLS - saved.calls.length
      report.upstreamContinuationVerified = false
    }
    report.pageSize = await readOwner(client, source.source); report.ownerVerified = true
    requireValue(installed, 'needs_deploy')
    report.readiness = await readiness(client, source.source)
    requireValue(report.readiness.ready === true, 'operation_not_ready')
    report.readyForExecute = true
  } catch (error) { report.errorCode = safeCode(error) }
  finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
  return report
}

export async function runRapidCommentVerification({ runtime, AppError, resumeThread = false,
  resumeEvidenceCheck = assertThreadResumeEvidence }) {
  const operation = resumeThread ? THREAD_OPERATION : OPERATION
  const stageSpecs = resumeThread ? STAGES.slice(3) : STAGES.slice(0, 3)
  const report = { diagnosticRevision: REVISION, mode: resumeThread ? 'resume_thread' : 'execute', maxSupplierCalls: MAX_CALLS,
    savedErrorInspectionVersion: 1, scope: 'installed_public_gateways_not_http_ingress', globalPolicyWrites: 0, stages: [] }
  let lock, locked = false, source, currentStage = null, attempts = 0, originalFailureDigest
  const restores = []
  try {
    lock = await runtime.pool.connect()
    locked = (await lock.query("SELECT /* twitter-rapid-check:lock */ pg_try_advisory_lock(hashtext('twitter-rapid-comments-check.v1')) AS acquired")).rows[0]?.acquired === true
    requireValue(locked, 'verification_in_progress')
    source = await sourceReceipt(lock); report.source = source.summary
    const before = await savedAttempts(lock, source.source); report.supplierCallsBefore = before.calls.length
    if (before.rows.length || before.calls.length) {
      const summaries = await summarizeSaved(lock, before, source)
      if (!resumeThread || before.rows.some(row => THREAD_KEYS.includes(row.idempotency_key))) {
        report.mode = 'read_saved_only'; report.stages = summaries; return report
      }
      report.originalStages = summaries.slice(0, 3)
    }
    const routes = await readRoutes(lock); report.routes = safeRoutes(routes)
    if (resumeThread) {
      resumeEvidenceCheck(before, report.originalStages || []); requireRecoveredRoutes(routes)
      originalFailureDigest = originalAttemptDigest(before, report.originalStages)
      report.remainingSupplierCalls = MAX_CALLS - before.calls.length
      report.upstreamContinuationVerified = false
      report.continuationState = 'not_covered_original_budget_reserved_for_reply_contract'
    }
    const pageSize = await readOwner(lock, source.source); report.pageSize = pageSize
    const context = await runtime.store.findApiKeyById(source.source.api_key_id)
    requireValue(context?.tenant?.id === source.source.tenant_id && context?.consumer?.id === source.source.consumer_id
      && context?.apiKey?.id === source.source.api_key_id && context.apiKey.environment === 'live', 'original_owner_unavailable')
    const comments = runtime.postCommentProviderGateways?.twitter?.rapidapi, replies = runtime.commentReplyGateways?.twitter?.rapidapi
    requireValue(comments?.providerKey === 'rapidapi' && replies?.providerKey === 'rapidapi'
      && typeof comments.adapter?.fetch === 'function' && typeof replies.adapter?.fetch === 'function', 'needs_deploy')
    const metadata = await runtime.rapidApiCredentialStore.describeCredential('rapidapi')
    const ready = await comments.nativeReadiness({ consumerId: context.consumer.id, operationKeys: [operation], credentialConfigured: metadata.credentialConfigured })
    requireValue(ready[operation] === true, 'operation_not_ready')
    const controls = runtime.externalPlatformControlStore, authorize = controls.authorizeDispatch
    controls.authorizeDispatch = async function (provider, operation, options) {
      requireValue(currentStage && provider === 'rapidapi' && operation === (resumeThread ? THREAD_OPERATION : OPERATION)
        && options?.consumerId === source.source.consumer_id, 'unexpected_diagnostic_operation')
      if (currentStage.sent || (await savedAttempts(runtime.pool, source.source)).calls.length >= MAX_CALLS) {
        throw new AppError(409, 'external_platform_operation_blocked', 'Diagnostic call budget exhausted')
      }
      return authorize.call(this, provider, operation, options)
    }
    restores.push(() => { controls.authorizeDispatch = authorize })
    for (const adapter of new Set([comments.adapter, replies.adapter])) {
      const original = adapter.fetch
      adapter.fetch = async function (url, options) {
        const target = new URL(url)
        requireValue(currentStage && target.origin === 'https://twitter-aio.p.rapidapi.com'
          && target.pathname === `/tweet/${currentStage.subject}${resumeThread ? '' : '/replies'}` && options?.method === 'GET', 'unexpected_diagnostic_request')
        if (resumeThread) requireRecoveredRoutes(await readRoutes(runtime.pool))
        requireValue(!currentStage.sent && attempts < MAX_CALLS
          && attempts < MAX_CALLS - before.calls.length
          && (await savedAttempts(runtime.pool, source.source)).calls.length <= MAX_CALLS, 'stage_already_dispatched')
        currentStage.sent = true; attempts++
        return original.call(this, url, options)
      }
      restores.push(() => { adapter.fetch = original })
    }
    const firstBody = { platform: 'twitter', postId: source.postId, count: pageSize, includeRaw: false }
    let first
    for (const { stage, kind, key } of stageSpecs) {
      let body = firstBody
      if (kind === 'next') {
        const cursor = first.body.data.page.nextCursor
        if (!cursor) { report.stages.push({ stage, state: 'not_covered_no_cursor' }); continue }
        body = { ...firstBody, cursor }
      }
      if (kind === 'replies') {
        const candidate = first.body.data.items.find(row => row.replyCount > 0 && id(row.replyRef?.commentId))
        const replyRef = candidate?.replyRef ?? source.fallbackReply
        if (!replyRef) { report.stages.push({ stage, state: 'not_covered_no_reply_candidate' }); continue }
        body = { platform: 'twitter', replyRef, count: pageSize, includeRaw: false }
      }
      currentStage = { subject: kind === 'replies' ? body.replyRef.commentId : body.postId, sent: false }
      const input = { body, platform: 'twitter', path: kind === 'replies' ? REPLIES : COMMENTS, idempotencyKey: key }
      const result = await (kind === 'replies' ? replies.commentReplies(context, input) : comments.postComments(context, input))
      requireValue(result.status === 200, 'saved_outcome_not_successful')
      pageSummary(result.body, body, kind)
      const saved = await savedAttempts(runtime.pool, source.source), summary = (await summarizeSaved(runtime.pool, saved, source)).find(row => row.stage === stage)
      requireValue(summary.state === 'saved_success' && summary.requestId === result.requestId, 'saved_receipt_unverified')
      report.stages.push(summary)
      if (kind === 'first') first = result
    }
    report.publicContractValid = report.stages.filter(row => row.state === 'saved_success').every(row => row.publicContractValid)
    report.upstreamContinuationVerified = !resumeThread && report.stages.find(row => row.stage === 'next')?.upstreamContinuationVerified === true
    report.positiveSamplesComplete = report.stages.every(row => row.state === 'saved_success' && row.positiveRowsObserved)
    report.coverageComplete = report.positiveSamplesComplete && report.upstreamContinuationVerified
  } catch (error) { report.errorCode = safeCode(error) }
  finally {
    restores.reverse().forEach(restore => restore())
    report.supplierHttpCallsMade = attempts
    if (source) {
      try {
        const saved = await savedAttempts(runtime.pool, source.source)
        report.supplierCallsAfter = saved.calls.length
        report.savedStages = await summarizeSaved(runtime.pool, saved, source)
        if (originalFailureDigest) {
          report.originalFailureUnchanged = originalAttemptDigest(saved, report.savedStages) === originalFailureDigest
          if (!report.originalFailureUnchanged) report.errorCode ||= 'resume_source_unverified'
        }
        report.sourceUnchanged = (await sourceReceipt(runtime.pool)).digest === source.digest
        if (!report.sourceUnchanged) report.errorCode ||= 'source_changed'
      } catch (error) { report.errorCode ||= safeCode(error) }
      try { report.routesAfter = safeRoutes(await readRoutes(runtime.pool)) }
      catch { report.errorCode ||= 'recovered_routes_required' }
    }
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtext('twitter-rapid-comments-check.v1'))").catch(() => {})
    lock?.release()
  }
  return report
}

export async function main(args = process.argv.slice(2)) {
  let pool, runtime
  try {
    requireValue(args.length === 0 || args.length === 1 && ['--execute', '--resume-thread'].includes(args[0]), 'invalid_arguments')
    const resumeThread = args[0] === '--resume-thread', operation = resumeThread ? THREAD_OPERATION : OPERATION
    const nativeKey = operation.slice(7)
    const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
    const { loadConfig } = await import(new URL('config.mjs', root)), config = loadConfig()
    requireValue(config.listenerMode === 'public' && config.storeDriver === 'postgres', 'public_postgres_container_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 10000 })
    let installed = false
    try {
      const { nativeForwardingEndpoint } = await import(new URL('contracts/native-forwarding.mjs', root))
      const { postCommentRecipe } = await import(new URL('contracts/post-comments.mjs', root))
      const { commentReplyRecipe } = await import(new URL('contracts/comment-replies.mjs', root))
      installed = nativeForwardingEndpoint(nativeKey)?.operation === operation
        && postCommentRecipe('twitter', 'rapidapi')?.key === nativeKey && commentReplyRecipe('twitter', 'rapidapi')?.key === nativeKey
    } catch { /* Older images still support the source-only preview. */ }
    const readiness = async (executor, source) => {
      const { PostgresExternalPlatformControlStore } = await import(new URL('external-platforms/control-store.mjs', root))
      const { PostgresExternalPlatformCredentialStore } = await import(new URL('external-platforms/credentials-store.mjs', root))
      const { rapidApiConfig } = await import(new URL('external-platforms/rapidapi-config.mjs', root))
      const rapid = config.rapidApi || rapidApiConfig()
      const credentials = new PostgresExternalPlatformCredentialStore({ pool: executor, providerKey: 'rapidapi', environmentConfigured: rapid.configured })
      const credential = await credentials.describeCredential('rapidapi')
      const controls = new PostgresExternalPlatformControlStore({ pool: executor })
      const rows = await controls.describeProvider('rapidapi', { config: { ...rapid, reservationLeaseMs: Math.max(60000, config.reservationLeaseMs) },
        credentialConfigured: credential.credentialConfigured })
      const state = rows.find(row => row.operationKey === operation)
      return { ready: credential.credentialConfigured && (state?.effectiveState === 'active'
        || state?.effectiveState === 'canary' && state.canaryConsumerIds.includes(source.consumer_id)),
        state: state?.effectiveState ?? 'not_registered', priceReady: state?.priceBook?.ready === true,
        blockers: (state?.blockers || []).map(row => row.code) }
    }
    let report = await previewRapidComments({ pool, installed, readiness, resumeThread })
    await pool.end(); pool = null
    if (args.length && report.readyForExecute && !report.errorCode && report.mode !== 'read_saved_only') {
      const { createRuntime } = await import(new URL('index.mjs', root)), { AppError } = await import(new URL('core/errors.mjs', root))
      runtime = await createRuntime(config)
      report = await runRapidCommentVerification({ runtime, AppError, resumeThread })
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.errorCode) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: safeCode(error), supplierHttpCallsMade: 0 })}\n`)
    process.exitCode = 1
  } finally {
    runtime?.agent?.close()
    await runtime?.justOneAdapter?.close()
    await runtime?.ecommerceRapidApiAdapter?.close()
    await runtime?.store?.close()
    await runtime?.retrievalPool?.end()
    await runtime?.pool?.end()
    await pool?.end()
  }
}
const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
