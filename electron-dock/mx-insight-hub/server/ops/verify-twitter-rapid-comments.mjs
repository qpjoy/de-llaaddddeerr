// Installed Public runtime only. Preview and old --execute read existing receipts.
// --resume-thread covers the old failure; --resume-replies can spend only the
// last call after revalidating the exact saved thread page with installed code.
// --resume-next alone has the separately authorized fourth call, using the
// archived supplier cursor. Earlier commands retain their original allowance.
// normal Hub controls remain active and recovered TikHub routes are never changed.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const REVISION = 'twitter-rapid-comments-check.v1'
export const RESUME_GUARD_REVISION = 'twitter-rapid-thread-guard.v2'
export const SOURCE_REQUEST_ID = '7e7cd2d0-aa97-4aa5-a113-5a92f8b3143b'
export const OPERATION = 'native.r.twitter_aio_tweet_replies'
export const KEYS = Object.freeze(['first', 'next', 'replies'].map(stage => `ops-twitter-rapid-comments-7e7cd2d0-v1-${stage}`))
export const THREAD_OPERATION = 'native.r.twitter_aio_tweet_thread'
export const THREAD_KEYS = Object.freeze(['first', 'replies'].map(stage => `ops-twitter-rapid-comments-7e7cd2d0-v1-thread-${stage}`))
export const THREAD_NEXT_KEY = 'ops-twitter-rapid-comments-7e7cd2d0-v1-thread-next'
export const RESUME_SOURCE = Object.freeze({ requestId: 'e813c900-44b2-45e8-bf84-6eb8786b1a5e',
  callId: 'dc07998d-21c6-44cd-8f48-5f99f7e7918c', bodySize: 77,
  sha256: 'a8f881027fc841cd737652640dbc864c94af4fe55f612ace64236059ed25a9a2' })
export const REPLY_SOURCE = Object.freeze({ requestId: 'e531d032-0bfa-463e-9e0f-ff10e2457a5d',
  callId: '783683dc-0dde-45ac-9c9c-76753f9c8949', bodySize: 200594,
  sha256: '34747817708f7dd6e4ab1b8dd9f4b92f20f2fd5c8f96165e347532d3a35fa2a6' })
export const NEXT_SOURCE = Object.freeze({ requestId: 'c352b401-4351-407e-9a1d-aaff849c6394',
  callId: '0b053805-603a-4bc8-b228-23e6d370d548', bodySize: 26874,
  sha256: '818bf762557a59853959fc63162562e4ef13e9b0876b5bf4dddb0e163b3bf47e' })
const ALL_KEYS = [...KEYS, ...THREAD_KEYS, THREAD_NEXT_KEY]
const STAGES = [{ stage: 'first', kind: 'first', key: KEYS[0] }, { stage: 'next', kind: 'next', key: KEYS[1] },
  { stage: 'replies', kind: 'replies', key: KEYS[2] }, { stage: 'thread-first', kind: 'first', key: THREAD_KEYS[0] },
  { stage: 'thread-replies', kind: 'replies', key: THREAD_KEYS[1] }, { stage: 'thread-next', kind: 'next', key: THREAD_NEXT_KEY }]
const OLD_OPERATION = 'native.t.api_3cd88a6621a01120'
const COMMENTS = '/api/v1/data/social/post-comments', REPLIES = '/api/v1/data/social/comment-replies'
const MAX_BYTES = 4 * 1024 * 1024, MAX_CALLS = 3, NEXT_MAX_CALLS = 4, PAGE_SIZE = 100
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
  'external_platform_outcome_unknown', 'upstream_outcome_unknown', 'social_upstream_outcome_unknown',
  'external_platform_response_unusable', 'social_upstream_response_unusable', 'social_upstream_rejected',
  'social_upstream_timeout_or_size_limit', 'social_egress_unavailable', 'upstream_rate_limited',
  'external_platform_rejected', 'external_platform_operation_blocked', 'external_platform_operation_disabled',
  'external_platform_operation_paused', 'external_platform_operation_canary', 'external_platform_rate_limited',
  'external_platform_busy', 'invalid_social_contract', 'invalid_upstream_contract', 'page_size_exceeded',
  'platform_not_granted', 'capability_not_granted', 'comment_acquisition_paused', 'resume_source_unverified', 'recovered_routes_required',
  'reply_source_unverified', 'first_archive_revalidation_failed', 'reply_candidate_unavailable',
  'next_source_unverified', 'supplier_cursor_unavailable'])
const safeCode = error => SAFE_ERRORS.has(error?.code) ? error.code : 'verification_unavailable'
const savedErrorCode = value => ({ code: SAFE_ERRORS.has(value) ? value : null, known: SAFE_ERRORS.has(value) })
const savedFailurePhase = call => {
  if (call.outcome !== 'succeeded_unusable' || call.http_status !== 200) return 'unclassified'
  if (call.error_code === 'invalid_social_contract') return 'projection_contract_failed'
  if (call.error_code === 'social_upstream_response_unusable') return 'response_decode_or_envelope_failed'
  return 'unclassified'
}

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
  const { rows } = await executor.query(`SELECT /* twitter-rapid-check:archive */ body_size,body_sha256,captured_at,
    CASE WHEN body_size <= $2 AND octet_length(body_bytes) <= $2 THEN body_bytes END AS body_bytes
    FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1`, [callId, MAX_BYTES])
  const row = rows[0], bytes = row?.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  if (optional && !rows.length) return { summary: { archiveState: 'not_available' } }
  requireValue(rows.length === 1 && Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES
    && row.body_size === bytes.length && row.body_sha256 === sha(bytes), 'archive_unverified')
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { requireValue(false, 'archive_unverified') }
  return { payload, capturedAt: row.captured_at,
    summary: { archiveState: 'verified', bodySize: bytes.length, sha256: row.body_sha256, hashVerified: true } }
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
    idempotency_key,platform,status,response_status,error_code,
    CASE WHEN octet_length(response_body::text)<=$3 THEN response_body END AS response_body,
    CASE WHEN octet_length(acquisition_request::text)<=32768 THEN acquisition_request END AS acquisition_request
    FROM public.usage_requests WHERE consumer_id=$1 AND idempotency_key=ANY($2::text[]) ORDER BY idempotency_key LIMIT 7`,
  [source.consumer_id, ALL_KEYS, MAX_BYTES])
  requireValue(rows.length <= ALL_KEYS.length && rows.every(row => owned(row, source) && ALL_KEYS.includes(row.idempotency_key))
    && new Set(rows.map(row => row.idempotency_key)).size === rows.length, 'receipt_owner_mismatch')
  const { rows: calls } = await executor.query(`SELECT /* twitter-rapid-check:budget */ call.id,call.usage_request_id,
    call.tenant_id,call.consumer_id,call.api_key_id,call.provider_key,call.operation,call.endpoint_key,call.outcome,call.http_status,call.billed,call.error_code,
    call.marketplace,call.contract_version,call.endpoint_version,call.completed_at,
    request.tenant_id AS request_tenant_id,request.api_key_id AS request_api_key_id
    FROM external_platform.provider_calls call JOIN public.usage_requests request ON request.id=call.usage_request_id
    WHERE request.consumer_id=$1 AND request.idempotency_key=ANY($2::text[]) LIMIT 5`, [source.consumer_id, ALL_KEYS])
  requireValue(calls.length <= NEXT_MAX_CALLS, 'saved_call_budget_exceeded')
  requireValue(calls.every(call => {
    const request = rows.find(row => row.id === call.usage_request_id)
    const operation = [...THREAD_KEYS, THREAD_NEXT_KEY].includes(request?.idempotency_key) ? THREAD_OPERATION : OPERATION
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
      const error = savedErrorCode(call.error_code)
      summaries.push({ callId: call.id, outcome: ['succeeded','succeeded_unusable','rejected','unknown','pending'].includes(call.outcome) ? call.outcome : 'other',
        httpStatus: Number.isInteger(call.http_status) ? call.http_status : null,
        billed: typeof call.billed === 'boolean' ? call.billed : null,
        errorCode: error.code, errorCodeKnown: error.known, failurePhase: savedFailurePhase(call), ...evidence })
    }
    const successful = row.status === 'committed' && row.response_status === 200
      && (calls.length === 1 || kind === 'next') && calls.every(call => call.outcome === 'succeeded' && call.http_status === 200)
    const usageError = savedErrorCode(row.error_code), publicError = savedErrorCode(row.response_body?.error?.code)
    stages.push({ stage, state: successful ? 'saved_success' : 'saved_failure_or_pending', requestId: row.id,
      usageStatus: ['reserved', 'committed', 'released', 'unknown'].includes(row.status) ? row.status : 'other',
      usageErrorCode: usageError.code, usageErrorCodeKnown: usageError.known,
      publicErrorCode: publicError.code, publicErrorCodeKnown: publicError.known,
      httpStatus: Number.isInteger(row.response_status) ? row.response_status : null, providerCalls: summaries,
      ...(kind === 'next' ? { upstreamContinuationVerified: successful && calls.length === 1 } : {}),
      ...(successful ? pageSummary(row.response_body, request.body, kind) : {}) })
  }
  return stages
}

// This guard consumes only summaries produced after archive integrity checks.
// RapidAPI finishFailure commits a saved HTTP 502 with zero delivered units;
// "committed" describes persistence, not a successful supplier response. It
// does not use the released state of the separate IP/Qixin failure branches.
// The rejected HTTP attempt still consumes one of the original three calls.
export function inspectThreadResumeEvidence(saved, stages) {
  const rows = saved.rows.filter(row => KEYS.includes(row.idempotency_key))
  const calls = saved.calls.filter(call => rows.some(row => row.id === call.usage_request_id))
  const first = stages.find(row => row.stage === 'first'), evidence = first?.providerCalls?.[0]
  const checks = {
    singleLegacyUsage: rows.length === 1,
    knownUsageId: rows[0]?.id === RESUME_SOURCE.requestId,
    knownFirstKey: rows[0]?.idempotency_key === KEYS[0],
    usageCommitted: rows[0]?.status === 'committed',
    hubHttp502: rows[0]?.response_status === 502,
    singleLegacyCall: calls.length === 1,
    knownCallId: calls[0]?.id === RESUME_SOURCE.callId,
    legacyOperation: calls[0]?.operation === OPERATION,
    legacyEndpoint: calls[0]?.endpoint_key === OPERATION,
    rejected: calls[0]?.outcome === 'rejected',
    upstreamHttp404: calls[0]?.http_status === 404,
    explicitlyUnbilled: calls[0]?.billed === false,
    summaryRequestId: first?.requestId === RESUME_SOURCE.requestId,
    summaryCallId: evidence?.callId === RESUME_SOURCE.callId,
    hashVerified: evidence?.hashVerified === true,
    expectedBodySize: evidence?.bodySize === RESUME_SOURCE.bodySize,
    expectedSha256: evidence?.sha256 === RESUME_SOURCE.sha256,
    endpointPathNotFound: evidence?.errorInspection?.category === 'endpoint_path_not_found',
    requestedRepliesPathMatched: Array.isArray(evidence?.errorInspection?.signals)
      && evidence.errorInspection.signals.some(row => row.matchesRequestedRepliesPath === true),
  }
  const failedChecks = Object.keys(checks).filter(key => !checks[key])
  return { revision: RESUME_GUARD_REVISION,
    usageStatus: ['reserved', 'committed', 'released', 'unknown'].includes(rows[0]?.status) ? rows[0].status : 'other',
    usageHttpStatus: Number.isInteger(rows[0]?.response_status) ? rows[0].response_status : null,
    legacyUsageRows: rows.length, legacyProviderCalls: calls.length,
    threadUsageRows: saved.rows.filter(row => THREAD_KEYS.includes(row.idempotency_key)).length,
    checks, failedChecks, verified: failedChecks.length === 0 }
}

export function assertThreadResumeEvidence(saved, stages) {
  requireValue(inspectThreadResumeEvidence(saved, stages).verified, 'resume_source_unverified')
}

// The internal checker can be supplied by offline tests with synthetic hashes;
// the CLI always uses these exact production fingerprints, without an override.
export function assertReplyResumeEvidence(saved, stages) {
  const row = saved.rows.find(row => row.idempotency_key === THREAD_KEYS[0])
  const call = saved.calls.find(call => call.usage_request_id === row?.id)
  const evidence = stages.find(stage => stage.stage === 'thread-first')?.providerCalls?.[0]
  const legacy = saved.calls.find(call => call.id === RESUME_SOURCE.callId)
  requireValue(saved.rows.length === 2 && saved.calls.length === 2
    && row?.id === REPLY_SOURCE.requestId && row.status === 'committed' && row.response_status === 502
    && call?.id === REPLY_SOURCE.callId && call.operation === THREAD_OPERATION && call.endpoint_key === THREAD_OPERATION
    && call.marketplace === 'twitter' && call.contract_version === 'mx-insight-hub.native-forwarding.v1'
    && call.endpoint_version === 'twitter-aio.tweet-thread.2026-11-17'
    && call.outcome === 'succeeded_unusable' && call.http_status === 200 && call.billed === null
    && call.error_code === 'invalid_social_contract' && evidence?.callId === REPLY_SOURCE.callId
    && evidence.hashVerified === true && evidence.bodySize === REPLY_SOURCE.bodySize && evidence.sha256 === REPLY_SOURCE.sha256
    && legacy?.marketplace === 'twitter' && legacy.contract_version === 'mx-insight-hub.native-forwarding.v1'
    && legacy.endpoint_version === 'twitter-aio.replies.2026-11-17',
  'reply_source_unverified')
}

export function assertNextResumeEvidence(saved, stages) {
  const row = saved.rows.find(row => row.idempotency_key === THREAD_KEYS[1])
  const call = saved.calls.find(call => call.usage_request_id === row?.id)
  const summary = stages.find(stage => stage.stage === 'thread-replies'), evidence = summary?.providerCalls?.[0]
  requireValue(saved.rows.length === 3 && saved.calls.length === 3
    && row?.id === NEXT_SOURCE.requestId && row.status === 'committed' && row.response_status === 200
    && call?.id === NEXT_SOURCE.callId && call.operation === THREAD_OPERATION && call.endpoint_key === THREAD_OPERATION
    && call.marketplace === 'twitter' && call.contract_version === 'mx-insight-hub.native-forwarding.v1'
    && call.endpoint_version === 'twitter-aio.tweet-thread.2026-11-17' && call.outcome === 'succeeded'
    && call.http_status === 200 && call.billed === null && evidence?.callId === NEXT_SOURCE.callId
    && evidence.hashVerified === true && evidence.bodySize === NEXT_SOURCE.bodySize && evidence.sha256 === NEXT_SOURCE.sha256
    && summary.state === 'saved_success' && summary.resultCount === 4 && summary.publicContractValid === true
    && summary.positiveRowsObserved === true && summary.aliasesVerified === true && summary.referencesVerified === true,
  'next_source_unverified')
}

const firstTwoAttempts = saved => {
  const rows = saved.rows.filter(row => row.idempotency_key !== THREAD_KEYS[1] && row.idempotency_key !== THREAD_NEXT_KEY)
  return { rows, calls: saved.calls.filter(call => rows.some(row => row.id === call.usage_request_id)) }
}

async function installedReplayModules(root = process.argv[1] === '-'
  ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)) {
  const [parser, projection, contract, safety, workflow, replies] = await Promise.all([
    import(new URL('contracts/twitter-rapid-comment-page.mjs', root)), import(new URL('contracts/post-comment-projection.mjs', root)),
    import(new URL('contracts/post-comments.mjs', root)), import(new URL('core/postgres-json.mjs', root)),
    import(new URL('external-platforms/social-account-workflow.mjs', root)),
    import(new URL('contracts/comment-replies.mjs', root)),
  ])
  return { parse: parser.parseRapidApiTwitterCommentPage, project: projection.projectPostCommentPage,
    normalize: contract.normalizePostCommentsRequest, dispatch: contract.buildPostCommentsDispatch,
    isJsonSafe: safety.isPostgresSafeJsonValue, workflowProject: workflow.projectPage, traversal: contract.POST_COMMENTS_TRAVERSAL,
    replyNormalize: replies.normalizeCommentRepliesRequest, replyDispatch: replies.buildCommentRepliesDispatch,
    replyTraversal: replies.COMMENT_REPLIES_TRAVERSAL }
}

async function revalidateThreadFirst(executor, saved, source, stages, replyEvidenceCheck) {
  const row = saved.rows.find(row => row.idempotency_key === THREAD_KEYS[0])
  const call = saved.calls.find(call => call.usage_request_id === row?.id)
  const raw = await archive(executor, call.id), modules = await installedReplayModules()
  const currentStages = structuredClone(stages)
  Object.assign(currentStages.find(stage => stage.stage === 'thread-first').providerCalls[0], raw.summary)
  replyEvidenceCheck(saved, currentStages)
  const request = modules.normalize(row.acquisition_request.body, { provider: 'rapidapi' }), step = modules.dispatch(request)
  requireValue(request.postId === source.postId && !request.cursor && !Object.keys(request.initialParams || {}).length
    && !request.includeRaw && step.operationKey === THREAD_OPERATION && step.endpointKey === THREAD_OPERATION
    && step.endpointPath === '/tweet/{tweetId}', 'first_archive_revalidation_failed')
  const capturedAt = new Date(raw.capturedAt ?? call.completed_at).toISOString()
  const parsed = modules.parse(raw.payload, request.postId, step.postComments.continuation)
  const projected = modules.project(raw.payload, step, { capturedAt })
  const workflow = modules.workflowProject(raw.payload, step, 'comments', capturedAt, modules.traversal)
  const recordsSafe = result => result.records.every(record => Object.entries(record).every(([key, value]) =>
    modules.isJsonSafe(['eventTime', 'collectedAt', 'editedAt', 'deletedAt'].includes(key) && value instanceof Date ? value.toISOString() : value)))
  requireValue(modules.isJsonSafe(raw.payload) && modules.isJsonSafe(projected.projected) && modules.isJsonSafe(workflow.projected)
    && recordsSafe(projected) && recordsSafe(workflow) && parsed.comments.length === 36
    && projected.projected.acquiredItems.length === 36 && projected.records.length === 36
    && workflow.projected.acquiredItems.length === 36 && workflow.records.length === 36
    && isDeepStrictEqual(projected.projected.acquiredItems, workflow.projected.acquiredItems), 'first_archive_revalidation_failed')
  const candidate = workflow.projected.acquiredItems.find(item => integer(item.replyCount) && item.replyCount > 0
    && item.postId === source.postId && id(item.commentId) && item.commentId !== source.postId
    && item.platform === 'twitter' && (item.conversationId ?? item.contentId) === source.postId)
  requireValue(candidate, 'reply_candidate_unavailable')
  return { replyRef: { platform: 'twitter', commentId: candidate.commentId, contentId: source.postId },
    items: workflow.projected.acquiredItems, cursor: parsed.providerPage.nextParams?.cursor ?? null,
    summary: { hashVerified: true, commentCount: 36, itemCount: 36, recordCount: 36, jsonSafe: true,
      recordFieldsJsonSafe: true, workflowOk: true, replyCandidateAvailable: true,
      continuationPresent: Boolean(parsed.providerPage.nextParams), historicalReceiptStillFailed: true } }
}

async function revalidateNextSource(executor, saved, source, stages, replyEvidenceCheck, nextEvidenceCheck) {
  replyEvidenceCheck(firstTwoAttempts(saved), stages); nextEvidenceCheck(saved, stages)
  const first = await revalidateThreadFirst(executor, firstTwoAttempts(saved), source, stages, replyEvidenceCheck)
  const row = saved.rows.find(row => row.idempotency_key === THREAD_KEYS[1])
  const call = saved.calls.find(call => call.usage_request_id === row.id), raw = await archive(executor, call.id)
  const currentStages = structuredClone(stages)
  Object.assign(currentStages.find(stage => stage.stage === 'thread-replies').providerCalls[0], raw.summary)
  nextEvidenceCheck(saved, currentStages)
  const modules = await installedReplayModules(), body = row.acquisition_request.body
  const request = modules.replyNormalize(body, { provider: 'rapidapi' }), step = modules.replyDispatch(request)
  requireValue(isDeepStrictEqual(body.replyRef, first.replyRef) && !request.cursor && !request.includeRaw
    && request.contentId === source.postId && step.operationKey === THREAD_OPERATION && step.endpointKey === THREAD_OPERATION
    && step.endpointPath === '/tweet/{tweetId}', 'next_source_unverified')
  const capturedAt = new Date(raw.capturedAt ?? call.completed_at).toISOString()
  const parsed = modules.parse(raw.payload, request.commentId, step.commentReplies.continuation)
  const projected = modules.replyTraversal.projectPage(raw.payload, step, { capturedAt })
  const workflow = modules.workflowProject(raw.payload, step, 'comment-replies', capturedAt, modules.replyTraversal)
  requireValue(modules.isJsonSafe(raw.payload) && modules.isJsonSafe(workflow.projected)
    && parsed.comments.length === 4 && projected.records.length === 4 && workflow.records.length === 4
    && isDeepStrictEqual(projected.projected.acquiredItems, row.response_body.data.items)
    && isDeepStrictEqual(workflow.projected.acquiredItems, row.response_body.data.items), 'next_source_unverified')
  requireValue(typeof first.cursor === 'string' && first.cursor.length > 0 && first.cursor.length <= 8192
    && !first.cursor.includes('\0'), 'supplier_cursor_unavailable')
  // Validate the imported cursor through the installed native contract, before
  // reserving anything. No signed cursor or successful first-page DTO is made.
  const next = modules.normalize({ platform: 'twitter', postId: source.postId, count: PAGE_SIZE,
    includeRaw: false, params: { cursor: first.cursor } }, { provider: 'rapidapi' })
  const nextStep = modules.dispatch(next)
  requireValue(next.initialParams.cursor === first.cursor && nextStep.operationKey === THREAD_OPERATION
    && nextStep.endpointPath === '/tweet/{tweetId}', 'supplier_cursor_unavailable')
  return { ...first, nextQuery: Object.entries(nextStep.upstreamQuery).filter(([key]) => key !== 'tweetId')
    .map(([key, value]) => [key, String(value)]).sort(([a], [b]) => a.localeCompare(b)),
    replyArchiveRevalidated: { hashVerified: true, publicContractValid: true, itemCount: 4, recordCount: 4,
    positiveRowsObserved: true, requestReferenceVerified: true, archivedItemsMatchSavedDelivery: true } }
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
const threadAttemptDigest = (saved, stages) => sha(JSON.stringify([
  saved.rows.filter(row => row.idempotency_key === THREAD_KEYS[0]),
  saved.calls.filter(call => call.usage_request_id === REPLY_SOURCE.requestId), stages.find(row => row.stage === 'thread-first'),
]))
const replyAttemptDigest = (saved, stages) => sha(JSON.stringify([
  saved.rows.filter(row => row.idempotency_key === THREAD_KEYS[1]),
  saved.calls.filter(call => call.usage_request_id === NEXT_SOURCE.requestId), stages.find(row => row.stage === 'thread-replies'),
]))
const resumeIsReadOnly = (saved, resumeThread, resumeReplies, resumeNext = false) => saved.rows.some(row => row.idempotency_key === THREAD_NEXT_KEY)
  || (resumeNext ? false : resumeReplies
  ? saved.rows.some(row => row.idempotency_key === THREAD_KEYS[1])
  : !resumeThread || saved.rows.some(row => THREAD_KEYS.includes(row.idempotency_key)))

export async function previewRapidComments({ pool, installed = true, readiness = async () => ({ ready: false }),
  resumeThread = false, resumeReplies = false, resumeNext = false, resumeEvidenceCheck = assertThreadResumeEvidence,
  replyEvidenceCheck = assertReplyResumeEvidence, nextEvidenceCheck = assertNextResumeEvidence }) {
  const maxCalls = resumeNext ? NEXT_MAX_CALLS : MAX_CALLS
  const report = { diagnosticRevision: REVISION, mode: 'preview', installedContract: installed,
    savedErrorInspectionVersion: 1, maxSupplierCalls: maxCalls, supplierHttpCallsMade: 0 }
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    const source = await sourceReceipt(client); report.source = source.summary
    const routes = await readRoutes(client); report.routes = safeRoutes(routes)
    const saved = await savedAttempts(client, source.source)
    report.savedProviderCalls = saved.calls.length
    report.remainingSupplierCalls = Math.max(0, maxCalls - saved.calls.length)
    if (saved.rows.length || saved.calls.length) {
      report.mode = 'read_saved_only'; report.stages = await summarizeSaved(client, saved, source)
      report.resumeSourceInspection = inspectThreadResumeEvidence(saved, report.stages)
      if (resumeIsReadOnly(saved, resumeThread, resumeReplies, resumeNext)) return report
    }
    if (resumeThread || resumeReplies || resumeNext) {
      resumeEvidenceCheck(saved, report.stages || []); requireRecoveredRoutes(routes)
      report.mode = resumeNext ? 'resume_next_preview' : resumeReplies ? 'resume_replies_preview' : 'resume_thread_preview'
      report.upstreamContinuationVerified = false
    }
    report.pageSize = await readOwner(client, source.source); report.ownerVerified = true
    requireValue(installed, 'needs_deploy')
    if (resumeReplies) {
      replyEvidenceCheck(saved, report.stages || [])
      report.firstArchiveRevalidated = (await revalidateThreadFirst(client, saved, source, report.stages, replyEvidenceCheck)).summary
    }
    if (resumeNext) {
      const revalidated = await revalidateNextSource(client, saved, source, report.stages || [], replyEvidenceCheck, nextEvidenceCheck)
      report.firstArchiveRevalidated = revalidated.summary; report.replyArchiveRevalidated = revalidated.replyArchiveRevalidated
      Object.assign(report, continuationLimits())
    }
    report.readiness = await readiness(client, source.source)
    requireValue(report.readiness.ready === true, 'operation_not_ready')
    report.readyForExecute = true
  } catch (error) { report.errorCode = safeCode(error) }
  finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
  return report
}

const continuationLimits = () => ({ continuationKind: 'imported_supplier_cursor', cursorTransmissionVerified: false,
  continuationAdvanceObserved: false, upstreamContinuationVerified: false, signedCursorChainVerified: false,
  crossPageDeduplicationVerified: false, httpIngressVerified: false, coverageComplete: false })

export async function runRapidCommentVerification({ runtime, AppError, resumeThread = false, resumeReplies = false, resumeNext = false,
  resumeEvidenceCheck = assertThreadResumeEvidence, replyEvidenceCheck = assertReplyResumeEvidence,
  nextEvidenceCheck = assertNextResumeEvidence }) {
  const threaded = resumeThread || resumeReplies || resumeNext, operation = threaded ? THREAD_OPERATION : OPERATION
  const maxCalls = resumeNext ? NEXT_MAX_CALLS : MAX_CALLS
  const stageSpecs = resumeNext ? STAGES.slice(5, 6) : resumeReplies ? STAGES.slice(4, 5) : resumeThread ? STAGES.slice(3, 5) : STAGES.slice(0, 3)
  const report = { diagnosticRevision: REVISION, mode: resumeNext ? 'resume_next' : resumeReplies ? 'resume_replies' : resumeThread ? 'resume_thread' : 'execute', maxSupplierCalls: maxCalls,
    savedErrorInspectionVersion: 1, scope: 'installed_public_gateways_not_http_ingress', globalPolicyWrites: 0, stages: [] }
  if (resumeNext) Object.assign(report, continuationLimits())
  let lock, locked = false, source, currentStage = null, attempts = 0, originalFailureDigest, threadFailureDigest, replySuccessDigest, revalidated
  const restores = []
  try {
    lock = await runtime.pool.connect()
    locked = (await lock.query("SELECT /* twitter-rapid-check:lock */ pg_try_advisory_lock(hashtext('twitter-rapid-comments-check.v1')) AS acquired")).rows[0]?.acquired === true
    requireValue(locked, 'verification_in_progress')
    source = await sourceReceipt(lock); report.source = source.summary
    const before = await savedAttempts(lock, source.source); report.supplierCallsBefore = before.calls.length
    if (before.rows.length || before.calls.length) {
      const summaries = await summarizeSaved(lock, before, source)
      report.resumeSourceInspection = inspectThreadResumeEvidence(before, summaries)
      if (resumeIsReadOnly(before, resumeThread, resumeReplies, resumeNext)) {
        report.mode = 'read_saved_only'; report.stages = summaries; return report
      }
      report.originalStages = summaries.slice(0, 3)
      if (resumeReplies || resumeNext) {
        replyEvidenceCheck(resumeNext ? firstTwoAttempts(before) : before, summaries)
        threadFailureDigest = threadAttemptDigest(before, summaries)
        if (resumeNext) { nextEvidenceCheck(before, summaries); replySuccessDigest = replyAttemptDigest(before, summaries) }
      }
    }
    const routes = await readRoutes(lock); report.routes = safeRoutes(routes)
    if (threaded) {
      resumeEvidenceCheck(before, report.originalStages || []); requireRecoveredRoutes(routes)
      originalFailureDigest = originalAttemptDigest(before, report.originalStages)
      report.remainingSupplierCalls = Math.max(0, maxCalls - before.calls.length)
      report.upstreamContinuationVerified = false
      report.continuationState = resumeNext ? 'single_imported_page_only' : 'not_covered_original_budget_reserved_for_reply_contract'
    }
    const pageSize = await readOwner(lock, source.source); report.pageSize = pageSize
    if (resumeReplies) {
      revalidated = await revalidateThreadFirst(lock, before, source,
        await summarizeSaved(lock, before, source), replyEvidenceCheck)
      report.firstArchiveRevalidated = revalidated.summary
    }
    if (resumeNext) {
      revalidated = await revalidateNextSource(lock, before, source,
        await summarizeSaved(lock, before, source), replyEvidenceCheck, nextEvidenceCheck)
      report.firstArchiveRevalidated = revalidated.summary; report.replyArchiveRevalidated = revalidated.replyArchiveRevalidated
    }
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
      requireValue(currentStage && provider === 'rapidapi' && operation === (threaded ? THREAD_OPERATION : OPERATION)
        && options?.consumerId === source.source.consumer_id, 'unexpected_diagnostic_operation')
      if (currentStage.sent || (await savedAttempts(runtime.pool, source.source)).calls.length >= maxCalls) {
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
          && target.pathname === `/tweet/${currentStage.subject}${threaded ? '' : '/replies'}` && options?.method === 'GET'
          && (!resumeReplies || !target.searchParams.has('cursor'))
          && (!resumeNext || target.pathname === `/tweet/${source.postId}`
            && !target.username && !target.password && !target.hash
            && target.searchParams.getAll('cursor').length === 1 && target.searchParams.get('cursor') === revalidated.cursor
            && isDeepStrictEqual([...target.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b)), revalidated.nextQuery)),
        'unexpected_diagnostic_request')
        if (threaded) requireRecoveredRoutes(await readRoutes(runtime.pool))
        if (resumeReplies || resumeNext) {
          const current = await savedAttempts(runtime.pool, source.source), summaries = await summarizeSaved(runtime.pool, current, source)
          requireValue(originalAttemptDigest(current, summaries) === originalFailureDigest
            && threadAttemptDigest(current, summaries) === threadFailureDigest
            && (!resumeNext || replyAttemptDigest(current, summaries) === replySuccessDigest), 'reply_source_unverified')
          if (resumeNext) requireValue((await sourceReceipt(runtime.pool)).digest === source.digest, 'source_changed')
        }
        requireValue(!currentStage.sent && attempts < maxCalls
          && attempts < maxCalls - before.calls.length
          && (await savedAttempts(runtime.pool, source.source)).calls.length <= maxCalls, 'stage_already_dispatched')
        currentStage.sent = true; attempts++
        if (resumeNext) report.cursorTransmissionVerified = true
        return original.call(this, url, options)
      }
      restores.push(() => { adapter.fetch = original })
    }
    const firstBody = { platform: 'twitter', postId: source.postId, count: pageSize, includeRaw: false }
    let first
    for (const { stage, kind, key } of stageSpecs) {
      let body = firstBody
      if (kind === 'next') {
        const cursor = resumeNext ? revalidated.cursor : first.body.data.page.nextCursor
        if (!cursor) { report.stages.push({ stage, state: 'not_covered_no_cursor' }); continue }
        body = resumeNext ? { ...firstBody, params: { cursor } } : { ...firstBody, cursor }
      }
      if (kind === 'replies') {
        const candidate = first?.body.data.items.find(row => row.replyCount > 0 && id(row.replyRef?.commentId))
        const replyRef = resumeReplies ? revalidated.replyRef : candidate?.replyRef ?? source.fallbackReply
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
      if (resumeNext) {
        requireValue(summary.providerCalls.length === 1 && attempts === 1, 'saved_receipt_unverified')
        const firstIds = new Set(revalidated.items.map(item => item.commentId))
        report.overlapCount = result.body.data.items.filter(item => firstIds.has(item.commentId)).length
        report.newCommentCount = result.body.data.items.length - report.overlapCount
        report.continuationAdvanceObserved = report.newCommentCount > 0
      }
      if (kind === 'first') first = result
    }
    report.publicContractValid = report.stages.filter(row => row.state === 'saved_success').every(row => row.publicContractValid)
    report.upstreamContinuationVerified = (resumeNext || !threaded)
      && report.stages.find(row => row.stage === (resumeNext ? 'thread-next' : 'next'))?.upstreamContinuationVerified === true
    report.positiveRowsObserved = report.stages.some(row => row.state === 'saved_success' && row.positiveRowsObserved)
    report.positiveSamplesComplete = report.stages.every(row => row.state === 'saved_success' && row.positiveRowsObserved)
    report.coverageComplete = !resumeNext && report.positiveSamplesComplete && report.upstreamContinuationVerified
  } catch (error) { report.errorCode = safeCode(error) }
  finally {
    restores.reverse().forEach(restore => restore())
    report.supplierHttpCallsMade = attempts
    if (source) {
      try {
        const saved = await savedAttempts(runtime.pool, source.source)
        report.supplierCallsAfter = saved.calls.length
        report.remainingSupplierCalls = Math.max(0, maxCalls - saved.calls.length)
        report.savedStages = await summarizeSaved(runtime.pool, saved, source)
        if (originalFailureDigest) {
          report.originalFailureUnchanged = originalAttemptDigest(saved, report.savedStages) === originalFailureDigest
          if (!report.originalFailureUnchanged) report.errorCode ||= 'resume_source_unverified'
        }
        if (threadFailureDigest) {
          report.threadFailureUnchanged = threadAttemptDigest(saved, report.savedStages) === threadFailureDigest
          if (!report.threadFailureUnchanged) report.errorCode ||= 'reply_source_unverified'
        }
        if (replySuccessDigest) {
          report.replySuccessUnchanged = replyAttemptDigest(saved, report.savedStages) === replySuccessDigest
          if (!report.replySuccessUnchanged) report.errorCode ||= 'next_source_unverified'
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
    requireValue(args.length === 0 || args.length === 1 && ['--execute', '--resume-thread', '--resume-replies', '--resume-next'].includes(args[0]), 'invalid_arguments')
    const resumeThread = args[0] === '--resume-thread', resumeReplies = args[0] === '--resume-replies', resumeNext = args[0] === '--resume-next'
    const operation = resumeThread || resumeReplies || resumeNext ? THREAD_OPERATION : OPERATION
    const contractOperation = args.length === 0 ? THREAD_OPERATION : operation, nativeKey = contractOperation.slice(7)
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
      installed = nativeForwardingEndpoint(nativeKey)?.operation === contractOperation
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
    let report = await previewRapidComments({ pool, installed, readiness, resumeThread, resumeReplies, resumeNext })
    await pool.end(); pool = null
    if (args.length && report.readyForExecute && !report.errorCode && report.mode !== 'read_saved_only') {
      const { createRuntime } = await import(new URL('index.mjs', root)), { AppError } = await import(new URL('core/errors.mjs', root))
      runtime = await createRuntime(config)
      report = await runRapidCommentVerification({ runtime, AppError, resumeThread, resumeReplies, resumeNext })
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
