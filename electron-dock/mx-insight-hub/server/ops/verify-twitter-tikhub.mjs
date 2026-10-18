// Explicit, bounded alternative-provider diagnosis. No production routing change,
// credential/grant enablement, Delta mutation, retry, pagination or delivery repair.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'twitter-tikhub-check.v4'
const IDENTITY_REVISION = 'twitter-tikhub-check.v1'
export const ORIGINAL_REQUEST_ID = 'b5906846-8564-4791-8b83-ef3ce97789bc'
export const PROXY_RECEIPT = Object.freeze({ requestId: 'd6ffc7e8-d736-4b7e-999b-a8af15755ee0',
  callId: '87e933ba-85fd-47da-9717-77acb61482ff' })
export const SUCCESS_RECEIPT = Object.freeze({ requestId: 'dcc086fa-469a-4237-a435-e427b7e70f3a',
  callId: '6c6177d6-4065-499c-aabb-50217f355780' })
export const NATIVE_KEY = 't.twitter_web_fetch_search_timeline'
export const NATIVE_PATH = `/api/v1/data/native/${NATIVE_KEY}`
export const OPERATION = `native.${NATIVE_KEY}`
export const QUERY = '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") -"广告" -"营销" -"重复搬运" ("diplomacy" OR "foreign policy" OR "diplomatic relations") ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost'
const ORIGINAL_SHA = 'f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386'
const PROXY_QUERY = '"update" -ad -marketing -repost'
const PROXY_KEY = 'ops-twitter-proxy-3a7cdb0328df2c647b90dbebe67b464389decda1b9a7e056'
const digest = value => createHash('sha256').update(value).digest('hex')
export const IDEMPOTENCY_KEY = 'ops-twitter-tikhub-' + digest(JSON.stringify([
  IDENTITY_REVISION, ORIGINAL_REQUEST_ID, PROXY_RECEIPT.requestId, NATIVE_KEY, QUERY, 'Top', 'single_native_page',
])).slice(0, 48)
export const PROTOCOL_KEYS = Object.freeze({ original: `${IDEMPOTENCY_KEY}-original-guard`, native: `${IDEMPOTENCY_KEY}-native-guard` })
const BODY = Object.freeze({ params: Object.freeze({ keyword: QUERY, search_type: 'Top' }), deliveryMode: 'live_only' })
const matchesBody = body => body && Object.keys(body).sort().join(',') === 'deliveryMode,params'
  && body.deliveryMode === 'live_only' && body.params && Object.keys(body.params).sort().join(',') === 'keyword,search_type'
  && body.params.keyword === QUERY && body.params.search_type === 'Top'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const safeId = value => typeof value === 'string' && UUID.test(value) ? value : null
const integer = value => Number.isSafeInteger(value) ? value : null
const requireValue = (condition, code) => { if (!condition) throw new Error(code) }
const SAFE_CODES = new Set(['invalid_arguments', 'database_url_required', 'original_rejection_unverified',
  'proxy_rejection_unverified', 'historical_receipt_changed', 'original_owner_unavailable', 'probe_identity_conflict',
  'probe_call_limit', 'probe_request_mismatch', 'readiness_blocked', 'api_key_required', 'platform_not_granted',
  'capability_not_granted', 'test_key_not_supported', 'idempotency_conflict', 'request_outcome_unknown',
  'request_in_progress', 'search_admission_blocked', 'external_platform_not_configured', 'external_platform_unavailable',
  'external_platform_contract_unverified', 'external_platform_circuit_open', 'external_platform_rate_limited',
  'external_platform_busy', 'external_platform_response_unusable', 'external_platform_outcome_unknown',
  'external_platform_upstream_rejected', 'external_platform_operation_blocked', 'external_platform_operation_disabled',
  'external_platform_operation_shadow', 'external_platform_operation_paused', 'external_platform_operation_canary',
  'external_platform_control_unavailable', 'external_platform_credential_store_unavailable', 'diagnostic_identity_already_used',
  'diagnostic_guard_persistence_unknown', 'saved_receipt_unavailable', 'saved_success_unverified'])
const safeCode = error => SAFE_CODES.has(error?.code) ? error.code : SAFE_CODES.has(error?.message) ? error.message : 'probe_unavailable'
const owned = (a, b) => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => a?.[key] === b?.[key])
const state = value => ['reserved', 'committed', 'released', 'unknown'].includes(value) ? value : 'other'
const receiptSummary = row => ({ requestId: safeId(row.id), status: state(row.status), httpStatus: integer(row.response_status) })
const fields = 'id,tenant_id,consumer_id,api_key_id,idempotency_key,platform,status,response_status,response_body,acquisition_request,fingerprint'
const callFields = 'id,tenant_id,consumer_id,api_key_id,provider_key,operation,endpoint_key,endpoint_version,contract_version,call_ordinal,call_role,outcome,http_status,business_code'

function rejectedRapid(row, calls, expectedPath, query, callId) {
  const error = row?.response_body?.error, body = row?.acquisition_request?.body
  return row?.status === 'committed' && row.platform === 'twitter' && row.response_status === 502
    && error?.code === 'social_upstream_rejected' && error?.details?.upstreamStatus === 400
    && error.details.outcome === 'rejected' && error.details.retryable === false
    && row.acquisition_request?.method === 'POST' && row.acquisition_request.path === expectedPath
    && body?.platform === 'twitter' && body.query === query && body.pageSize === 20 && !body.cursor
    && calls.length === 1 && owned(calls[0], row) && (!callId || calls[0].id === callId)
    && calls[0].provider_key === 'rapidapi' && calls[0].operation === 'social.content.search'
    && calls[0].endpoint_key === 'twitter-aio.search' && calls[0].endpoint_version === 'twitter-aio.hub.v1'
    && calls[0].contract_version === 'mx-insight-hub.social-data.v1' && calls[0].call_ordinal === 0
    && calls[0].call_role === 'primary' && calls[0].outcome === 'rejected' && calls[0].http_status === 400
}

async function readSnapshot(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const original = (await client.query(`SELECT /* twitter-tikhub:original */ ${fields} FROM usage_requests WHERE id=$1`, [ORIGINAL_REQUEST_ID])).rows[0]
    const calls = (await client.query(`SELECT /* twitter-tikhub:original-calls */ ${callFields} FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [ORIGINAL_REQUEST_ID])).rows
    const query = original?.acquisition_request?.body?.query
    requireValue(typeof query === 'string' && digest(query) === ORIGINAL_SHA
      && [original.tenant_id, original.consumer_id, original.api_key_id].every(safeId)
      && rejectedRapid(original, calls, '/api/v1/data/search', query), 'original_rejection_unverified')
    const proxy = (await client.query(`SELECT /* twitter-tikhub:proxy */ ${fields} FROM usage_requests WHERE id=$1`, [PROXY_RECEIPT.requestId])).rows[0]
    const proxyCalls = (await client.query(`SELECT /* twitter-tikhub:proxy-calls */ ${callFields} FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [PROXY_RECEIPT.requestId])).rows
    requireValue(proxy?.idempotency_key === PROXY_KEY && owned(proxy, original)
      && rejectedRapid(proxy, proxyCalls, '/api/v1/night-all/search/raw', PROXY_QUERY, PROXY_RECEIPT.callId), 'proxy_rejection_unverified')
    const existing = (await client.query(`SELECT /* twitter-tikhub:existing */ ${fields} FROM usage_requests WHERE consumer_id=$1 AND idempotency_key=$2 ORDER BY reserved_at LIMIT 2`,
      [original.consumer_id, IDEMPOTENCY_KEY])).rows
    requireValue(existing.length <= 1 && existing.every(row => owned(row, original)), 'probe_identity_conflict')
    return { original, existing: existing[0] || null, historyDigest: digest(JSON.stringify([original, calls, proxy, proxyCalls])) }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

// Metadata and reviewed controls only: no secret read, key telemetry update,
// reservation, provider probe or policy mutation belongs in readiness.
export async function inspectTikHubReadiness({ owner, credentialStore, controlStore, config }) {
  const blockers = []
  if (!owner?.active) blockers.push('original_owner_unavailable')
  if (owner?.testKey) blockers.push('test_key_not_supported')
  if (!owner?.platformGranted) blockers.push('platform_not_granted')
  if (!owner?.capabilityGranted) blockers.push('capability_not_granted')
  const metadata = await credentialStore.describeCredential('tikhub')
  const credential = { configured: metadata.credentialConfigured === true,
    source: ['database', 'environment'].includes(metadata.source) ? metadata.source : 'other', revision: integer(metadata.revision) }
  if (!credential.configured) blockers.push('credential_missing')
  let operation = null
  try {
    const policy = await controlStore.authorizeDispatch('tikhub', OPERATION, { config, consumerId: owner?.consumerId,
      credentialConfigured: credential.configured, credentialRevision: credential.revision })
    operation = { authorized: true, policyRevision: integer(policy.policyRevision), releaseRevision: integer(policy.releaseRevision),
      priceBookVersion: integer(policy.priceBookVersion), state: ['active', 'canary'].includes(policy.desiredState) ? policy.desiredState : 'other' }
  } catch (error) {
    const code = safeCode(error)
    blockers.push(code)
    const known = new Set(['provider_configuration_invalid', 'deployment_gate_closed', 'reservation_lease_too_short',
      'credential_missing', 'release_not_active', 'price_control_incomplete', 'database_price_book_required', 'canary_allowlist_empty'])
    operation = { authorized: false, errorCode: code,
      blockers: (error?.details?.blockers || []).map(row => known.has(row.code) ? row.code : 'other') }
  }
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)], credential, operation,
    requiredPlatform: 'social', requiredCapability: OPERATION,
    scope: 'Read-only current credential metadata, owner grants and operation policy; budget, circuit and concurrency are rechecked at dispatch.' }
}

export function oneShotTikHubAdapter(adapter, onDispatch = () => {}) {
  let calls = 0
  return { resolveCredential: () => adapter.resolveCredential(), forwardNative: async (key, body, options) => {
    requireValue(calls === 0, 'probe_call_limit')
    requireValue(key === NATIVE_KEY && matchesBody(body), 'probe_request_mismatch')
    calls++; onDispatch()
    return adapter.forwardNative(key, body, options)
  } }
}

// Structural evidence only. No field values, IDs, text, media URLs or cursor
// tokens leave this projection; unknown field names are represented by a hash.
const IDENTITY_FIELDS = new Set(['id', 'id_str', 'rest_id', 'tweet_id', 'tweetId', 'status_id', 'content_id', 'user_id', 'userId', 'author_id', 'conversation_id'])
const TIME_FIELDS = new Set(['created_at', 'createdAt', 'published_at', 'publishedAt', 'timestamp', 'timestamp_ms', 'date', 'created_time', 'created'])
const CONTAINERS = new Set(['data', 'result', 'tweet', 'tweet_results', 'legacy', 'core', 'user', 'author', 'user_info',
  'user_results', 'content', 'itemContent', 'item', 'entities', 'extended_entities', 'media', 'photos', 'videos', 'variants',
  'video_info', 'note_tweet', 'note_tweet_results', 'hashtags', 'urls', 'items', 'photo', 'video', 'images',
  'profile', 'retweet', 'quoted_tweet', 'retweeted_status', 'quoted_status'])
const KNOWN_FIELDS = new Set([...IDENTITY_FIELDS, ...TIME_FIELDS, ...CONTAINERS, 'type', '__typename', 'text', 'full_text',
  'note_text', 'description', 'name', 'screen_name', 'username', 'lang', 'url', 'expanded_url', 'display_url',
  'media_url', 'media_url_https', 'profile_image_url', 'profile_image_url_https', 'avatar', 'avatar_url',
  'favorite_count', 'favourites_count', 'like_count', 'reply_count', 'retweet_count', 'quote_count', 'bookmark_count',
  'view_count', 'views', 'count', 'favorites', 'bookmarks', 'quotes', 'replies', 'retweets', 'bitrate', 'content_type',
  'next_cursor', 'cursor', 'possibly_sensitive', 'verified', 'is_blue_verified', 'tweet_url', 'video_url',
  'thumbnail_url', 'thumb', 'preview_image_url', 'width', 'height', 'duration', 'source'])
const valueType = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value

export function summarizeTikHubTimeline(payload) {
  const rows = payload?.timeline
  if (!Array.isArray(rows)) return { state: 'timeline_array_missing', entryCount: null, inspectedCount: 0, groups: [], truncated: false }
  let nodes = 0, truncated = false
  const group = (values, depth, limit = 24) => {
    const grouped = new Map()
    let inspectedCount = 0
    for (let index = 0; index < values.length; index++) {
      if (nodes >= 10000) { truncated = true; break }
      const shape = describe(values[index], depth), signature = JSON.stringify(shape)
      let found = grouped.get(signature)
      if (!found && grouped.size >= limit) { truncated = true; continue }
      if (!found) { found = { count: 0, sampleIndexes: [], shape }; grouped.set(signature, found) }
      found.count++; if (found.sampleIndexes.length < 3) found.sampleIndexes.push(index)
      inspectedCount++
    }
    return { inspectedCount, groups: [...grouped.values()] }
  }
  const describe = (value, depth) => {
    nodes++
    const type = valueType(value)
    if (type !== 'object' && type !== 'array') return { type }
    if (depth >= 10) { truncated = true; return { type, depthLimited: true } }
    if (type === 'array') return { type, length: value.length, ...group(value, depth + 1, 8) }
    const fields = {}, keys = Object.keys(value).sort(), unknownKeys = keys.filter(key => !KNOWN_FIELDS.has(key))
    for (const name of keys.filter(key => KNOWN_FIELDS.has(key))) {
      if (nodes >= 10000) { truncated = true; break }
      const field = value[name]
      const description = CONTAINERS.has(name) ? describe(field, depth + 1) : { type: valueType(field) }
      if (IDENTITY_FIELDS.has(name)) {
        description.nonemptyBoundedString = typeof field === 'string' && !!field.trim() && field.length <= 256 && !field.includes('\u0000')
        description.positiveDecimalString = typeof field === 'string' && /^[1-9][0-9]*$/.test(field)
        description.positiveSafeInteger = Number.isSafeInteger(field) && field > 0
      }
      if (TIME_FIELDS.has(name)) {
        const numeric = typeof field === 'number' || typeof field === 'string' && /^\d+(?:\.\d+)?$/.test(field)
        const candidate = numeric ? Number(field) * (Number(field) < 1e12 ? 1000 : 1) : typeof field === 'string' && field.trim() ? field : NaN
        description.parseable = Number.isFinite(new Date(candidate).getTime())
        description.representation = numeric ? Number(field) < 1e12 ? 'epoch_seconds' : 'epoch_milliseconds' : typeof field === 'string' ? 'date_string' : 'other'
      }
      fields[name] = description
    }
    return { type, fields, unknownKeyCount: unknownKeys.length, ...(unknownKeys.length ? { unknownKeysSha256: digest(JSON.stringify(unknownKeys)) } : {}) }
  }
  const summary = group(rows, 0)
  return { state: 'structural_evidence_only', entryCount: rows.length, ...summary, nodesInspected: nodes, truncated,
    limits: { maxNodes: 10000, maxDepth: 10, maxRootGroups: 24, maxNestedGroups: 8, maxSampleIndexes: 3 },
    interpretation: 'Array elements and field shapes only; no post mapping, content validation or standard-search delivery is established.' }
}

async function installedSavedMapping() {
  const sourceRoot = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
  const [workflow, contract, twitter] = await Promise.all([
    import(new URL('external-platforms/content-search-workflow.mjs', sourceRoot)),
    import(new URL('contracts/tikhub-content-search.mjs', sourceRoot)),
    import(new URL('contracts/tikhub-twitter-search.mjs', sourceRoot)),
  ])
  requireValue(typeof workflow.projectContentPage === 'function' && typeof twitter.projectTikHubTwitterSearch === 'function'
    && contract.TIKHUB_CONTENT_SEARCH_RECIPES?.twitter?.key === NATIVE_KEY, 'installed_twitter_mapping_unavailable')
  return { projectContentPage: workflow.projectContentPage, contentSearchDataItem: contract.contentSearchDataItem }
}

export async function inspectSavedTikHubMapping(saved, loadMapping = installedSavedMapping) {
  const base = { source: 'saved_native_payload', implementation: 'installed_hub_content_search',
    deliveryEstablished: false, procurementCalls: 0 }
  let mapping
  try { mapping = await loadMapping() }
  catch {
    return { ...base, state: 'needs_deploy', reason: 'installed_twitter_mapping_unavailable',
      action: 'Deploy the updated Hub Admin/Public image; syncing the stdin diagnostic alone does not install the mapper. No procurement was attempted.' }
  }
  try {
    const { projected, records } = mapping.projectContentPage({ publicBody: { data: saved.response_body.data,
      meta: { capturedAt: saved.response_body.meta?.capturedAt } } }, {
      platform: 'twitter', query: QUERY, page: 1, pageSize: 20, upstreamQuery: { keyword: QUERY, search_type: 'Top' } })
    const items = projected.acquiredItems.map(mapping.contentSearchDataItem)
    return { ...base, state: 'mapped_saved_native_page', acquiredCount: projected.acquiredItems.length,
      standardItemCount: items.length, canonicalRecordCount: records.length,
      duplicateCount: projected.duplicateCount, nonPostCount: projected.nonPostCount,
      hasMore: projected.providerPage.hasMore, nextCursorPresent: Boolean(projected.providerPage.nextParams?.cursor),
      postgresProjectionSafe: true,
      identity: { externalIdPresentCount: items.filter(item => item.externalId).length,
        authorIdPresentCount: items.filter(item => item.author?.id).length },
      content: { textPresentCount: items.filter(item => item.text).length,
        publishedAtPresentCount: items.filter(item => item.publishedAt).length },
      metrics: Object.fromEntries(['likes', 'comments', 'shares', 'views', 'bookmarks'].map(name => [name, {
        knownCount: items.filter(item => item.metrics?.[name] != null).length,
        zeroCount: items.filter(item => item.metrics?.[name] === 0).length,
        unknownCount: items.filter(item => item.metrics?.[name] == null).length,
      }])),
      media: { imagePostCount: items.filter(item => item.media.images.length).length,
        videoPostCount: items.filter(item => item.media.videos.length).length,
        coverPostCount: items.filter(item => item.media.coverUrl).length },
      interpretation: 'Offline mapping of one owned saved page only; no standard delivery, cursor follow, historical-window coverage or Delta ingestion is established.' }
  } catch (error) {
    const known = new Set(['invalid_content_search_shape', 'invalid_content_search_identity', 'invalid_content_search_capture_time',
      'invalid_content_search_projection', 'invalid_content_search_continuation', 'content_search_page_too_large', 'content_search_business_rejected'])
    return { ...base, state: 'saved_native_mapping_failed', reason: known.has(error?.message) ? error.message : 'mapping_unavailable' }
  }
}

async function appendSavedEvidence(pool, report, saved, expectedReceipt = null, loadMapping) {
  report.saved = receiptSummary(saved)
  const calls = (await pool.query(`SELECT /* twitter-tikhub:probe-calls */ ${callFields} FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY started_at LIMIT 2`, [saved.id])).rows
  report.providerCalls = calls.map(call => ({ callId: safeId(call.id), httpStatus: integer(call.http_status),
    businessCode: integer(call.business_code), outcome: ['succeeded', 'rejected', 'unknown', 'succeeded_unusable', 'pending'].includes(call.outcome) ? call.outcome : 'other' }))
  const verified = saved.platform === 'social' && saved.idempotency_key === IDEMPOTENCY_KEY
    && saved.acquisition_request?.method === 'POST' && saved.acquisition_request.path === NATIVE_PATH
    && matchesBody(saved.acquisition_request.body)
    && calls.length === 1 && owned(calls[0], saved) && calls[0].provider_key === 'tikhub'
    && calls[0].operation === OPERATION && calls[0].endpoint_key === OPERATION
    && calls[0].endpoint_version === 'night-all-source-snapshot.2026-09-26'
    && calls[0].contract_version === 'mx-insight-hub.native-forwarding.v1'
    && calls[0].call_ordinal === 0 && calls[0].call_role === 'primary'
  if (expectedReceipt) requireValue(saved.id === expectedReceipt.requestId && calls.length === 1
    && calls[0].id === expectedReceipt.callId && verified, 'saved_success_unverified')
  report.ownedNativeReceiptVerified = verified
  report.definitiveNativeOutcome = verified && ['committed', 'released'].includes(saved.status)
    && (calls[0].outcome === 'rejected' && Number.isInteger(calls[0].http_status)
      || ['succeeded', 'succeeded_unusable'].includes(calls[0].outcome) && calls[0].http_status === 200 && calls[0].business_code === 200)
  report.savedOutcomeVerified = verified && saved.status === 'committed' && saved.response_status === 200
    && calls[0].http_status === 200 && calls[0].business_code === 200 && calls[0].outcome === 'succeeded'
    && saved.response_body?.contractVersion === 'mx-insight-hub.native-forwarding.v1'
    && saved.response_body.endpoint === NATIVE_KEY && saved.response_body.requestId === saved.id
    && Object.hasOwn(saved.response_body, 'data') ? 'native_success' : null
  if (expectedReceipt) requireValue(report.savedOutcomeVerified === 'native_success', 'saved_success_unverified')
  if (report.savedOutcomeVerified !== 'native_success') return
  report.projection = await inspectSavedTikHubMapping(saved, loadMapping)
}

// Admission is not an acquisition. Identify only the owned blocker and never
// expose its query, body or credentials, or turn missing evidence into a retry.
async function appendBlockingEvidence(pool, report, original) {
  if (!report.blockingRequestId) return
  try {
    const { rows } = await pool.query(`SELECT /* twitter-tikhub:blocker */ id,status,platform,acquisition_request,
      reserved_at,completed_at FROM usage_requests
      WHERE id=$1 AND tenant_id=$2 AND consumer_id=$3 AND api_key_id=$4 LIMIT 1`,
    [report.blockingRequestId, original.tenant_id, original.consumer_id, original.api_key_id])
    const row = rows[0]
    if (!row) { report.blockingRequest = { state: 'not_found_or_unavailable' }; return }
    const path = row.acquisition_request?.path
    const query = path === NATIVE_PATH ? row.acquisition_request?.body?.params?.keyword : row.acquisition_request?.body?.query
    const date = value => value != null && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
    report.blockingRequest = { state: 'owned_saved_request', requestId: safeId(row.id), status: state(row.status),
      platform: row.platform === 'twitter' ? 'twitter' : 'other',
      pathKind: path === '/api/v1/data/search' ? 'standard_v1' : path === '/api/v1/night-all/search/raw' ? 'legacy_raw'
        : path === NATIVE_PATH ? 'tikhub_native' : path == null ? 'missing' : 'other',
      queryPresent: typeof query === 'string' && Boolean(query.trim()),
      queryEqualsOriginal: typeof query === 'string' ? query.trim() === original.acquisition_request.body.query.trim() : null,
      queryEqualsNative: typeof query === 'string' ? query.trim() === QUERY : null,
      reservedAt: date(row.reserved_at), completedAt: date(row.completed_at) }
  } catch { report.blockingRequest = { state: 'not_found_or_unavailable' } }
}

export async function runTwitterTikHubProbe({ pool, execute = false, readSavedOnly = false, createRuntime, loadMapping }) {
  const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, proxyRequestId: PROXY_RECEIPT.requestId,
    case: 'full-query-tikhub', mode: readSavedOnly ? 'read_saved_only' : execute ? 'execute' : 'read_only', querySha256: digest(QUERY), queryLength: QUERY.length,
    provider: 'tikhub', endpoint: NATIVE_KEY, category: 'Top', idempotencyKey: IDEMPOTENCY_KEY,
    adapterCalls: 0, maxAdapterCalls: readSavedOnly ? 0 : 1, automaticRetryAllowed: false, deliveryEstablished: false,
    countMeaning: 'Adapter attempts, not all HTTP requests; normal provider routing may make an unauthenticated connectivity probe.',
    acquisitionScope: 'diagnostic_provider_page', fullQueryAttempted: false,
    interpretation: 'One complete original native predicate, without dropping terms. Native acceptance is not standard-search delivery or full-window cold-start coverage. No cursor follow or automatic provider fallback.' }
  let initial, runtime
  const leases = []
  if (readSavedOnly) Object.assign(report, { readOnly: true, businessCalls: 0, savedRequestId: SUCCESS_RECEIPT.requestId,
    countMeaning: 'No HTTP or adapter invocation; only saved database evidence is inspected.' })
  try {
    requireValue(!(execute && readSavedOnly), 'invalid_arguments')
    initial = await readSnapshot(pool)
    report.historicalRejectionsVerified = true
    if (readSavedOnly) {
      requireValue(initial.existing?.id === SUCCESS_RECEIPT.requestId, 'saved_receipt_unavailable')
      report.existing = receiptSummary(initial.existing)
      await appendSavedEvidence(pool, report, initial.existing, SUCCESS_RECEIPT, loadMapping)
      report.originalUnchanged = true
      return report
    }
    if (initial.existing) {
      report.existing = receiptSummary(initial.existing)
      await appendSavedEvidence(pool, report, initial.existing, null, loadMapping)
      return report
    }
    runtime = await createRuntime()
    report.admissionPolicyRevision = runtime.admissionPolicyRevision || 'not_reported_by_installed_code'
    report.readiness = await runtime.inspectReadiness(initial.original)
    if (!execute) return report
    if (!report.readiness.ready) { report.errorCode = 'readiness_blocked'; return report }
    const context = await runtime.store.findApiKeyById(initial.original.api_key_id)
    requireValue(context?.tenant?.id === initial.original.tenant_id && context.consumer?.id === initial.original.consumer_id
      && context.apiKey?.id === initial.original.api_key_id, 'original_owner_unavailable')
    const gateway = await runtime.createGateway(() => { report.adapterCalls++; report.fullQueryAttempted = true })
    // Durable v2 guards cover both historical SQL-like and compiled native
    // spellings. A native/social unknown must remain visible to future v1/v2
    // Twitter search, even though it lives outside their usage-path scan.
    for (const [name, query] of [['original', initial.original.acquisition_request.body.query], ['native', QUERY]]) {
      report.stage = `guard_${name}`
      const lease = await runtime.protocol.begin(context, { version: 2, body: { platform: 'twitter', query, pageSize: 20, type: 'stable' },
        idempotencyKey: PROTOCOL_KEYS[name] })
      requireValue(lease.kind === 'acquired', 'diagnostic_identity_already_used')
      leases.push(lease)
    }
    report.stage = 'native_dispatch'
    const result = await gateway.forwardNative(context,
      { key: NATIVE_KEY, body: BODY, path: NATIVE_PATH, idempotencyKey: IDEMPOTENCY_KEY })
    report.httpStatus = integer(result.status)
    report.requestId = safeId(result.requestId)
  } catch (error) {
    report.errorCode = safeCode(error)
    report.httpStatus = integer(error?.status)
    const guarding = report.stage === 'guard_original' || report.stage === 'guard_native'
    report.requestId = guarding ? null : safeId(error?.details?.requestId)
    if (guarding) {
      report.blockingRequestId = safeId(error?.details?.blockingRequestId || error?.details?.requestId)
      report.admission = {
        dispatchState: error?.details?.dispatchState === 'not_started' ? 'not_started' : 'not_started_by_this_probe',
        retrySameRequest: error?.details?.retrySameRequest === true,
        retryAfterSeconds: integer(error?.details?.retryAfterSeconds),
      }
      if (initial) await appendBlockingEvidence(pool, report, initial.original)
    }
  }
  if (readSavedOnly) return report
  if (initial) try {
    const after = await readSnapshot(pool)
    requireValue(after.historyDigest === initial.historyDigest, 'historical_receipt_changed')
    report.originalUnchanged = true
    if (after.existing) await appendSavedEvidence(pool, report, after.existing, null, loadMapping)
  } catch (error) { report.verificationError = safeCode(error) }
  if (leases.length) {
    const unsent = report.adapterCalls === 0 && !report.verificationError
      && !['unknown', 'reserved'].includes(report.saved?.status)
    const definitive = report.definitiveNativeOutcome === true && !report.verificationError
    const finalState = definitive ? 'failed' : unsent ? 'retryable' : 'unknown'
    report.protocolGuardState = finalState
    report.protocolGuardReason = definitive ? 'diagnostic_not_standard_delivery' : unsent ? 'no_supplier_dispatch' : 'request_outcome_unknown'
    report.protocolGuardMeaning = definitive ? 'This private diagnostic guard is closed; failed does not describe the supplier outcome.'
      : 'This private diagnostic guard does not represent a standard-search delivery.'
    // Never mark native bytes as a completed standard v2 delivery. Definitive
    // diagnostic outcomes stop owning the query; uncertain calls keep blocking.
    for (const lease of leases) try {
      await runtime.protocol.finish(lease.input, { state: finalState, usageRequestId: report.saved?.requestId || null,
        error: { status: finalState === 'unknown' ? 409 : 422,
          code: finalState === 'unknown' ? 'request_outcome_unknown' : 'diagnostic_not_standard_delivery',
          message: 'This private diagnostic is not a standard-search delivery', details: { automaticRetryAllowed: false } } })
    } catch { report.verificationError = 'diagnostic_guard_persistence_unknown' }
  }
  return report
}

async function runtimeFromInstalledSources(pool) {
  const source = path => import(new URL(path, pathToFileURL(`${process.cwd()}/`)))
  const [configModule, usageModule, platformModule, credentials, controls, proxy, adapterModule, gatewayModule, admission, limits, protocol] = await Promise.all([
    source('server/config.mjs'), source('server/stores/postgres-store.mjs'), source('server/external-platforms/store.mjs'),
    source('server/external-platforms/credentials-store.mjs'), source('server/external-platforms/control-store.mjs'),
    source('server/external-platforms/proxy.mjs'), source('server/adapters/tikhub.mjs'), source('server/external-platforms/gateway.mjs'),
    source('server/external-platforms/admission-policy.mjs'), source('server/external-platforms/admission-runtime.mjs'), source('server/data/search-protocol-store.mjs'),
  ])
  const config = configModule.loadConfig(), provider = config.tikHub
  requireValue(config.storeDriver === 'postgres', 'database_url_required')
  const store = new usageModule.PostgresStore(pool, { internalTraffic: config.internalTraffic })
  const credentialStore = credentials.createExternalPlatformCredentialStore({ pool, providerKey: 'tikhub', environmentConfigured: provider.configured })
  const controlStore = controls.createExternalPlatformControlStore({ pool })
  const reservationLeaseMs = Math.max(60000, config.reservationLeaseMs)
  return { store, protocol: new protocol.SearchProtocolStore(store),
    admissionPolicyRevision: protocol.SEARCH_ADMISSION_POLICY_REVISION,
    inspectReadiness: async original => {
      const row = (await pool.query(`SELECT /* twitter-tikhub:owner */ k.id,
        (k.status='active' AND k.expires_at>now() AND c.status='active' AND t.status='active') AS active,
        (k.environment='test' OR k.key_prefix LIKE 'mih_test_%') AS test_key
        FROM api_keys k JOIN consumers c ON c.id=k.consumer_id JOIN tenants t ON t.id=k.tenant_id
        WHERE k.id=$1 AND k.consumer_id=$2 AND k.tenant_id=$3`, [original.api_key_id, original.consumer_id, original.tenant_id])).rows[0]
      const [platforms, capabilities] = await Promise.all([store.listEffectiveGrants(original.consumer_id, original.api_key_id),
        store.listEffectiveCapabilityGrants(original.consumer_id, original.api_key_id)])
      return inspectTikHubReadiness({ owner: { active: row?.active === true, testKey: row?.test_key === true,
        consumerId: original.consumer_id, platformGranted: platforms.includes('social'), capabilityGranted: capabilities.includes(OPERATION) },
      credentialStore, controlStore, config: { ...provider, reservationLeaseMs } })
    },
    createGateway: onDispatch => new gatewayModule.ExternalPlatformGateway({ usageStore: store, providerKey: 'tikhub', config: provider,
      credentialStore, operationControlStore: controlStore, apiKeyPepper: config.apiKeyPepper, reservationLeaseMs,
      platformStore: platformModule.createExternalPlatformStore({ pool, usageStore: store, providerKey: 'tikhub', authorizationPlatform: 'social',
        rateLimitBurst: provider.rateLimitBurst, circuitFailureThreshold: provider.circuitFailureThreshold,
        circuitOpenMs: provider.circuitOpenMs, uncertainCooldownMs: provider.unknownFingerprintCooldownMs,
        responseQuarantineCooldownMs: provider.responseQuarantineCooldownMs }),
      adapter: oneShotTikHubAdapter(new adapterModule.TikHubAdapter({ apiKey: provider.apiKey,
        credentialResolver: () => credentialStore.readCredential('tikhub'), baseUrl: provider.baseUrl, timeoutMs: provider.timeoutMs,
        fetchImpl: proxy.createTikHubProxyFetch(new proxy.ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: 'tikhub' })) }), onDispatch),
      admissionPolicies: new admission.ExternalAdmissionPolicyStore({ pool, defaultsByProvider: { tikhub: limits.deploymentAdmissionLimits(provider) } }),
      logger: { warn() {} },
    }),
  }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    requireValue(args.length === 0 || args.length === 1 && ['--execute', '--read-saved-only'].includes(args[0]), 'invalid_arguments')
    requireValue(typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim(), 'database_url_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 4, application_name: REVISION })
    const report = await runTwitterTikHubProbe({ pool, execute: args[0] === '--execute', readSavedOnly: args[0] === '--read-saved-only', createRuntime: () => runtimeFromInstalledSources(pool) })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.errorCode || report.verificationError || ['needs_deploy', 'saved_native_mapping_failed'].includes(report.projection?.state)) process.exitCode = 1
  } catch (error) { process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: safeCode(error) })}\n`); process.exitCode = 1 }
  finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
