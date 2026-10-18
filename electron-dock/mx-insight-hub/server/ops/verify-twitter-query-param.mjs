// Fixed, one-page comparison of the supplier's documented query-param alias.
// Dry run by default. Execute only after review: this can consume supplier
// quota. No deployment, Delta mutation, retry, cursor follow or unknown reset.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'twitter-query-param-check.v7'
// Receipt keys issued by v1 are immutable even as this diagnostic grows.
const QUERY_PARAM_KEY_REVISION = 'twitter-query-param-check.v1'
export const ORIGINAL_REQUEST_ID = 'b5906846-8564-4791-8b83-ef3ce97789bc'
export const QUERY_PARAM_REQUEST_ID = '22e3c544-db09-461f-be46-550bda290c73'
const QUERY_PARAM_CALL_ID = '38e539e4-eeb8-497a-bbee-b5f6c681a2bf'
export const CANDIDATE_REQUEST_IDS = Object.freeze(['e5c6fddf-eb56-4d9b-afef-38727910a072', '9faad699-5178-4d00-8af5-bcab5d2867ba'])
export const PROBE_CASES = Object.freeze(Object.fromEntries(Object.entries({
  control: 'OpenAI',
  candidate: '("外交" OR "外交部" OR "外交政策" OR "外交关系" OR "外交动态" OR "外交表态" OR "外交事件" OR "外交议题" OR "外交回应" OR "外交澄清") -"广告" -"营销" -"重复搬运" ("diplomacy" OR "foreign policy" OR "diplomatic relations") ("statement" OR "response" OR "clarification" OR "update") -ad -marketing -repost',
}).map(([name, query]) => [name, Object.freeze({ query, idempotencyKey: 'ops-twitter-queryparam-' + createHash('sha256')
  .update(JSON.stringify([QUERY_PARAM_KEY_REVISION, ORIGINAL_REQUEST_ID, name, query, 20, 'Top'])).digest('hex').slice(0, 48) })])))
const halfBoundary = PROBE_CASES.candidate.query.indexOf(' ("diplomacy"')
export const HALF_CASES = Object.freeze(Object.fromEntries(Object.entries({
  chinese_half: PROBE_CASES.candidate.query.slice(0, halfBoundary),
  english_half: PROBE_CASES.candidate.query.slice(halfBoundary + 1),
}).map(([name, query]) => [name, Object.freeze({ query, idempotencyKey: 'ops-twitter-half-' + createHash('sha256')
  .update(JSON.stringify(['twitter-subexpression-path-check.v1', ORIGINAL_REQUEST_ID, QUERY_PARAM_REQUEST_ID,
    name, query, 20, 'Top'])).digest('hex').slice(0, 48) })])))
export const HALF_RECEIPTS = Object.freeze([
  Object.freeze({ caseName: 'chinese_half', requestId: '94cf23d2-fc3d-4d67-8eac-e55f6b9e8805',
    callId: 'ecd75717-1aa5-4f0d-9e24-32f69dab009d', outcome: 'success' }),
  Object.freeze({ caseName: 'english_half', requestId: '030c9a71-a749-4870-8511-f2df1fc19132',
    callId: 'e1524a1a-e427-4389-9fb1-697558e526ad', outcome: 'rejected400' }),
])
const chineseNegations = ' -"广告" -"营销" -"重复搬运"', englishNegations = ' -ad -marketing -repost'
const englishAnd = HALF_CASES.english_half.query.replace(') (', ') AND (')
export const AND_CASES = Object.freeze(Object.fromEntries(Object.entries({
  english_and: { query: HALF_CASES.english_half.query, providerQuery: englishAnd },
  candidate_and: { query: PROBE_CASES.candidate.query, providerQuery:
    HALF_CASES.chinese_half.query.slice(0, -chineseNegations.length) + ' AND '
    + englishAnd.slice(0, -englishNegations.length) + chineseNegations + englishNegations },
}).map(([name, value]) => [name, Object.freeze({ ...value, idempotencyKey: 'ops-twitter-and-' + createHash('sha256')
  .update(JSON.stringify(['twitter-explicit-and-path-check.v1', ORIGINAL_REQUEST_ID,
    HALF_RECEIPTS.map(row => row.requestId), name, value.query, value.providerQuery, 20, 'Top'])).digest('hex').slice(0, 48) })])))
export const ENGLISH_AND_RECEIPT = Object.freeze({ requestId: '9b15c0e6-5ca7-4ff9-9a3f-5c418e3afa06',
  callId: '4fa2fa1c-2889-4238-9370-25802866c877' })
const englishGroupBoundary = HALF_CASES.english_half.query.indexOf(') (') + 1
export const GROUP_CASES = Object.freeze(Object.fromEntries(Object.entries({
  english_topics: HALF_CASES.english_half.query.slice(0, englishGroupBoundary) + englishNegations,
  english_events: HALF_CASES.english_half.query.slice(englishGroupBoundary + 1),
}).map(([name, query]) => [name, Object.freeze({ query, idempotencyKey: 'ops-twitter-group-' + createHash('sha256')
  .update(JSON.stringify(['twitter-english-groups-path-check.v1', ORIGINAL_REQUEST_ID, ENGLISH_AND_RECEIPT.requestId,
    name, query, 20, 'Top'])).digest('hex').slice(0, 48) })])))
export const EVENT_RECEIPT = Object.freeze({ requestId: '6f52fed6-ccfa-4f87-82b0-cb530d94363d',
  callId: 'bde0fce4-bb51-49a6-8977-bc6e4dfac71a' })
// Fixed Boolean-equivalent comparison, not a production canonicalization rule.
// Keep every atom, quote, exclusion and conjunction; only permute one OR group.
const reorderedEvents = '("update" OR "clarification" OR "response" OR "statement")' + englishNegations
export const ORDER_CASES = Object.freeze(Object.fromEntries(Object.entries({
  events_order: { query: GROUP_CASES.english_events.query, providerQuery: reorderedEvents },
  candidate_order: { query: PROBE_CASES.candidate.query,
    providerQuery: PROBE_CASES.candidate.query.replace(GROUP_CASES.english_events.query, reorderedEvents) },
}).map(([name, value]) => [name, Object.freeze({ ...value, idempotencyKey: 'ops-twitter-order-' + createHash('sha256')
  .update(JSON.stringify(['twitter-event-order-path-check.v1', ORIGINAL_REQUEST_ID, EVENT_RECEIPT.requestId,
    name, value.query, value.providerQuery, 20, 'Top'])).digest('hex').slice(0, 48) })])))
export const ORDER_RECEIPT = Object.freeze({ requestId: '019601cf-dc6d-42ad-b2b5-e30f46935816',
  callId: 'd4edacaa-6068-434e-bfe7-1020de91dfe8' })
// Adaptive bisection of the rejected event group. Each probe keeps its exact
// quoted atoms and all exclusions; no result replaces the business predicate.
export const TERM_CASES = Object.freeze(Object.fromEntries(Object.entries({
  events_pair_a: '("statement" OR "response")',
  events_pair_b: '("clarification" OR "update")',
  event_statement: '"statement"', event_response: '"response"',
  event_clarification: '"clarification"', event_update: '"update"',
}).map(([name, expression]) => {
  const query = expression + englishNegations
  return [name, Object.freeze({ query, idempotencyKey: 'ops-twitter-terms-' + createHash('sha256')
    .update(JSON.stringify(['twitter-event-terms-whole-page.v1', ORIGINAL_REQUEST_ID, ORDER_RECEIPT.requestId,
      name, query, 20, 'Top'])).digest('hex').slice(0, 48) })]
})))
const ORIGINAL_QUERY_SHA256 = 'f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ERRORS = new Set(['original_rejection_unverified', 'original_provider_evidence_unverified', 'original_request_changed',
  'original_owner_unavailable', 'known_candidate_rejection_unverified', 'known_candidate_provider_evidence_unverified', 'known_candidate_changed',
  'known_half_outcome_unverified', 'known_half_changed', 'known_english_and_unverified', 'known_english_and_changed',
  'known_event_unverified', 'known_event_changed',
  'known_order_unverified', 'known_order_changed',
  'probe_request_mismatch', 'probe_call_limit', 'invalid_arguments', 'database_url_required',
  'api_key_required', 'platform_not_granted', 'capability_not_granted', 'test_key_not_supported', 'idempotency_conflict',
  'request_outcome_unknown', 'request_in_progress', 'search_admission_blocked', 'social_upstream_rejected',
  'social_upstream_outcome_unknown', 'social_upstream_response_unusable', 'external_platform_not_configured',
  'external_platform_unavailable', 'external_platform_contract_unverified', 'external_platform_circuit_open',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_response_unusable'])
const requireValue = (condition, code) => { if (!condition) throw new Error(code) }
const safeId = value => typeof value === 'string' && UUID.test(value) ? value : null
const safeCode = error => ERRORS.has(error?.code) ? error.code : ERRORS.has(error?.message) ? error.message : 'probe_unavailable'
const integer = value => Number.isSafeInteger(value) ? value : null
const choice = (value, allowed) => allowed.includes(value) ? value : value == null ? null : 'other'
const digest = value => createHash('sha256').update(value).digest('hex')

function isOwnedProbeReceipt(saved, calls, query, expectedCallId) {
  const ownedCall = calls.length === 1 && calls.every(call => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => call[key] === saved[key])
    && call.provider_key === 'rapidapi' && call.operation === 'social.content.search' && call.endpoint_key === 'twitter-aio.search'
    && call.endpoint_version === 'twitter-aio.hub.v1' && call.contract_version === 'mx-insight-hub.social-data.v1'
    && call.call_ordinal === 0 && call.call_role === 'primary' && (!expectedCallId || call.id === expectedCallId))
  const body = saved.acquisition_request?.body
  const verifiedInput = saved.platform === 'twitter' && saved.acquisition_request?.method === 'POST'
    && saved.acquisition_request?.path === '/api/v1/night-all/search/raw' && body?.platform === 'twitter'
    && body.query === query && body.pageSize === 20 && !body.cursor
  return saved.status === 'committed' && ownedCall && verifiedInput
}

function savedOutcome(saved, calls, query, expectedCallId) {
  if (!isOwnedProbeReceipt(saved, calls, query, expectedCallId)) return null
  const error = saved.response_body?.error
  if (saved.response_status === 200 && calls[0].outcome === 'succeeded' && calls[0].http_status === 200) return 'success'
  if (saved.response_status === 502 && error?.code === 'social_upstream_rejected' && error?.details?.upstreamStatus === 400
    && error.details.outcome === 'rejected' && error.details.retryable === false
    && calls[0].outcome === 'rejected' && calls[0].http_status === 400) return 'rejected400'
  return null
}

// Diagnose an already-paid probe page without changing its failed raw receipt
// or fetching it again. This is a parser observation, never a delivery repair.
async function inspectProbeOverflowArchive(archive, query) {
  const maxBytes = 4 * 1024 * 1024
  const bytes = archive?.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  const date = archive?.captured_at == null ? null : new Date(archive.captured_at)
  const unverified = { state: 'archive_unverified', deliveryEstablished: false }
  if (!bytes || !bytes.length || bytes.length > maxBytes || bytes.length !== archive.body_size
    || digest(bytes) !== archive.body_sha256 || !date || !Number.isFinite(date.getTime())) return unverified
  const sourceRoot = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
  const [{ normalizeHubSocialRequest, normalizeTwitterResponse }, { isPostgresSafeJsonValue }] = await Promise.all([
    import(new URL('contracts/hub-social.mjs', sourceRoot)), import(new URL('core/postgres-json.mjs', sourceRoot)),
  ])
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''))
    if (!isPostgresSafeJsonValue(payload)) return unverified
    const request = normalizeHubSocialRequest('search', { platform: 'twitter', query, count: 20, sort: 'top' })
    const options = { capturedAt: date.toISOString(), encodeCursor: () => 'offline-not-a-cursor' }
    let strictReason
    try { normalizeTwitterResponse(payload, request, options) } catch (error) { strictReason = error.message }
    if (strictReason !== 'upstream_page_exceeds_requested_count') return unverified
    const result = normalizeTwitterResponse(payload, request, { ...options, allowOverflow: true })
    const acquiredCount = result.data.items.length
    if (acquiredCount <= 20) return unverified
    return { state: 'valid_overflow_response', hashVerified: true, bodySize: bytes.length, bodySha256: archive.body_sha256,
      strictReason, acquiredCount, overflowCount: acquiredCount - 20,
      hasMore: result.data.page.hasMore, deliveryEstablished: false,
      evidence: 'Offline installed-parser observation of the saved probe archive; original raw 502 remains unchanged. No delivery or full-query coverage is established.' }
  } catch { return unverified }
}

async function readSnapshot(pool, idempotencyKey, caseName) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    const row = (await client.query(`SELECT /* twitter-query-param:original */ id,tenant_id,consumer_id,api_key_id,
      platform,status,response_status,response_body,acquisition_request,fingerprint
      FROM usage_requests WHERE id=$1`, [ORIGINAL_REQUEST_ID])).rows[0]
    const body = row?.acquisition_request?.body, error = row?.response_body?.error
    requireValue(row?.id === ORIGINAL_REQUEST_ID && row.platform === 'twitter' && row.status === 'committed'
      && row.response_status === 502 && error?.code === 'social_upstream_rejected'
      && error?.details?.upstreamStatus === 400 && error.details.outcome === 'rejected' && error.details.retryable === false
      && row.acquisition_request.method === 'POST' && row.acquisition_request.path === '/api/v1/data/search'
      && body?.platform === 'twitter' && body.pageSize === 20 && !body.cursor
      && typeof body.query === 'string' && digest(body.query) === ORIGINAL_QUERY_SHA256
      && [row.tenant_id, row.consumer_id, row.api_key_id].every(safeId), 'original_rejection_unverified')
    const calls = (await client.query(`SELECT /* twitter-query-param:original-calls */ tenant_id,consumer_id,api_key_id,
      provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
      FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [ORIGINAL_REQUEST_ID])).rows
    requireValue(calls.length === 1 && calls.every(call => call.tenant_id === row.tenant_id
      && call.consumer_id === row.consumer_id && call.api_key_id === row.api_key_id && call.provider_key === 'rapidapi'
      && call.operation === 'social.content.search' && call.endpoint_key === 'twitter-aio.search'
      && call.endpoint_version === 'twitter-aio.hub.v1' && call.contract_version === 'mx-insight-hub.social-data.v1'
      && call.outcome === 'rejected' && call.http_status === 400 && call.call_ordinal === 0 && call.call_role === 'primary'),
    'original_provider_evidence_unverified')
    const knownCandidates = []
    const explicitAnd = Object.hasOwn(AND_CASES, caseName), ordered = Object.hasOwn(ORDER_CASES, caseName)
    const term = Object.hasOwn(TERM_CASES, caseName)
    const englishGroup = Object.hasOwn(GROUP_CASES, caseName) || ordered || term
    if (caseName === 'candidate' || Object.hasOwn(HALF_CASES, caseName) || explicitAnd || englishGroup) {
      // This fixed comparison has two known earlier path-form attempts. Check
      // their saved refusals explicitly; never use a new endpoint alias to
      // get around a pending/unknown outcome. This is not a general v1 scan.
      for (const requestId of [...CANDIDATE_REQUEST_IDS, ...(Object.hasOwn(HALF_CASES, caseName) || explicitAnd || englishGroup ? [QUERY_PARAM_REQUEST_ID] : [])]) {
        const expectedPath = requestId === QUERY_PARAM_REQUEST_ID ? '/api/v1/night-all/search/raw' : '/api/v1/data/search'
        const known = (await client.query(`SELECT /* twitter-query-param:known-candidate */ id,tenant_id,consumer_id,api_key_id,
          platform,status,response_status,response_body,acquisition_request,fingerprint
          FROM usage_requests WHERE id=$1`, [requestId])).rows[0]
        const saved = known?.acquisition_request?.body, failure = known?.response_body?.error
        requireValue(known?.id === requestId && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => known[key] === row[key])
          && known.platform === 'twitter' && known.status === 'committed' && known.response_status === 502
          && failure?.code === 'social_upstream_rejected' && failure?.details?.upstreamStatus === 400
          && failure.details.outcome === 'rejected' && failure.details.retryable === false
          && known.acquisition_request.method === 'POST' && known.acquisition_request.path === expectedPath
          && saved?.platform === 'twitter' && saved.pageSize === 20 && !saved.cursor
          && typeof saved.query === 'string' && saved.query === PROBE_CASES.candidate.query,
        'known_candidate_rejection_unverified')
        const knownCalls = (await client.query(`SELECT /* twitter-query-param:known-candidate-calls */ id,tenant_id,consumer_id,api_key_id,
          provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
          FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [requestId])).rows
        requireValue(knownCalls.length === 1 && knownCalls.every(call => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => call[key] === row[key])
          && call.provider_key === 'rapidapi' && call.operation === 'social.content.search' && call.endpoint_key === 'twitter-aio.search'
          && call.endpoint_version === 'twitter-aio.hub.v1' && call.contract_version === 'mx-insight-hub.social-data.v1'
          && call.outcome === 'rejected' && call.http_status === 400 && call.call_ordinal === 0 && call.call_role === 'primary'
          && (requestId !== QUERY_PARAM_REQUEST_ID || call.id === QUERY_PARAM_CALL_ID)),
        'known_candidate_provider_evidence_unverified')
        knownCandidates.push({ requestId, querySha256: digest(saved.query), status: known.status,
          httpStatus: known.response_status, upstreamStatus: 400 })
      }
    }
    const knownHalves = []
    if (explicitAnd || englishGroup) for (const receipt of HALF_RECEIPTS) {
      const known = (await client.query(`SELECT /* twitter-query-param:known-half */ id,tenant_id,consumer_id,api_key_id,
        platform,status,response_status,response_body,acquisition_request FROM usage_requests WHERE id=$1`, [receipt.requestId])).rows[0]
      const calls = (await client.query(`SELECT /* twitter-query-param:known-half-calls */ id,tenant_id,consumer_id,api_key_id,
        provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
        FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [receipt.requestId])).rows
      requireValue(known?.id === receipt.requestId && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => known[key] === row[key])
        && savedOutcome(known, calls, HALF_CASES[receipt.caseName].query, receipt.callId) === receipt.outcome,
      'known_half_outcome_unverified')
      knownHalves.push({ requestId: receipt.requestId, callId: receipt.callId, case: receipt.caseName,
        querySha256: digest(HALF_CASES[receipt.caseName].query), savedOutcomeVerified: receipt.outcome })
    }
    let knownEnglishAnd = null
    if (englishGroup) {
      const known = (await client.query(`SELECT /* twitter-query-param:known-english-and */ id,tenant_id,consumer_id,api_key_id,
        idempotency_key,platform,status,response_status,response_body,acquisition_request
        FROM usage_requests WHERE id=$1`, [ENGLISH_AND_RECEIPT.requestId])).rows[0]
      const calls = (await client.query(`SELECT /* twitter-query-param:known-english-and-calls */ id,tenant_id,consumer_id,api_key_id,
        provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
        FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [ENGLISH_AND_RECEIPT.requestId])).rows
      requireValue(known?.id === ENGLISH_AND_RECEIPT.requestId && known.idempotency_key === AND_CASES.english_and.idempotencyKey
        && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => known[key] === row[key])
        && savedOutcome(known, calls, AND_CASES.english_and.query, ENGLISH_AND_RECEIPT.callId) === 'rejected400',
      'known_english_and_unverified')
      knownEnglishAnd = { ...ENGLISH_AND_RECEIPT, querySha256: digest(AND_CASES.english_and.query), savedOutcomeVerified: 'rejected400',
        evidence: 'Exact fixed probe key, native saved input and sole owned refusal; no historical wire text retained.' }
    }
    let knownEvent = null
    if (ordered || term) {
      const known = (await client.query(`SELECT /* twitter-query-param:known-event */ id,tenant_id,consumer_id,api_key_id,
        idempotency_key,platform,status,response_status,response_body,acquisition_request
        FROM usage_requests WHERE id=$1`, [EVENT_RECEIPT.requestId])).rows[0]
      const calls = (await client.query(`SELECT /* twitter-query-param:known-event-calls */ id,tenant_id,consumer_id,api_key_id,
        provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
        FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [EVENT_RECEIPT.requestId])).rows
      requireValue(known?.id === EVENT_RECEIPT.requestId && known.idempotency_key === GROUP_CASES.english_events.idempotencyKey
        && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => known[key] === row[key])
        && savedOutcome(known, calls, GROUP_CASES.english_events.query, EVENT_RECEIPT.callId) === 'rejected400',
      'known_event_unverified')
      knownEvent = { ...EVENT_RECEIPT, querySha256: digest(GROUP_CASES.english_events.query), savedOutcomeVerified: 'rejected400' }
    }
    let knownOrder = null
    if (term) {
      const known = (await client.query(`SELECT /* twitter-query-param:known-order */ id,tenant_id,consumer_id,api_key_id,
        idempotency_key,platform,status,response_status,response_body,acquisition_request
        FROM usage_requests WHERE id=$1`, [ORDER_RECEIPT.requestId])).rows[0]
      const calls = (await client.query(`SELECT /* twitter-query-param:known-order-calls */ id,tenant_id,consumer_id,api_key_id,
        provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,call_ordinal,call_role
        FROM external_platform.provider_calls WHERE usage_request_id=$1 LIMIT 2`, [ORDER_RECEIPT.requestId])).rows
      requireValue(known?.id === ORDER_RECEIPT.requestId && known.idempotency_key === ORDER_CASES.events_order.idempotencyKey
        && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => known[key] === row[key])
        && savedOutcome(known, calls, ORDER_CASES.events_order.query, ORDER_RECEIPT.callId) === 'rejected400',
      'known_order_unverified')
      knownOrder = { ...ORDER_RECEIPT, querySha256: digest(ORDER_CASES.events_order.query), savedOutcomeVerified: 'rejected400' }
    }
    const existing = (await client.query(`SELECT /* twitter-query-param:existing */ id,tenant_id,consumer_id,api_key_id,
      platform,status,response_status,response_body,acquisition_request FROM usage_requests WHERE consumer_id=$1 AND idempotency_key=$2 ORDER BY reserved_at LIMIT 2`,
    [row.consumer_id, idempotencyKey])).rows
    requireValue(existing.length <= 1 && existing.every(entry => ['tenant_id', 'consumer_id', 'api_key_id']
      .every(key => entry[key] === row[key])), 'original_owner_unavailable')
    return { original: row, existing: existing[0] || null, knownCandidates, knownHalves, knownEnglishAnd, knownEvent, knownOrder,
      originalDigest: digest(JSON.stringify([row.status, row.response_status, row.response_body, row.acquisition_request, row.fingerprint])) }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

// The raw route supplies a single page without standard-search auto-fill.
// Its default category is Latest, so this fixed diagnostic pins Top to match
// the original failed request while comparing the documented transport alias.
// The original adapter still sends, parses and archives the HTTP response.
export function queryParamAdapter(adapter, caseName, onDispatch = () => {}) {
  const selected = PROBE_CASES[caseName] || HALF_CASES[caseName] || AND_CASES[caseName] || GROUP_CASES[caseName] || ORDER_CASES[caseName] || TERM_CASES[caseName]
  requireValue(Object.hasOwn(PROBE_CASES, caseName) || Object.hasOwn(HALF_CASES, caseName)
    || Object.hasOwn(AND_CASES, caseName) || Object.hasOwn(GROUP_CASES, caseName) || Object.hasOwn(ORDER_CASES, caseName)
    || Object.hasOwn(TERM_CASES, caseName), 'invalid_arguments')
  let calls = 0
  return {
    resolveCredential: () => adapter.resolveCredential(),
    execute: async (request, options) => {
      requireValue(calls === 0, 'probe_call_limit')
      requireValue(request.operation === 'search' && request.platform === 'twitter'
        && request.endpointKey === 'twitter-aio.search' && request.endpointVersion === 'twitter-aio.hub.v1'
        && request.query === selected.query && request.endpointPath.startsWith('/search/')
        && decodeURIComponent(request.endpointPath.slice('/search/'.length)) === selected.query
        && request.page === 1 && request.providerCursor == null
        && JSON.stringify(request.upstreamQuery) === JSON.stringify({ count: 20, category: 'Latest', includeTimestamp: 'false' }),
      'probe_request_mismatch')
      // Half expressions use the same path transport as the proven OpenAI
      // control. They are diagnostics, never replacement business queries.
      const pathForm = Object.hasOwn(HALF_CASES, caseName) || Object.hasOwn(AND_CASES, caseName)
        || Object.hasOwn(GROUP_CASES, caseName) || Object.hasOwn(ORDER_CASES, caseName) || Object.hasOwn(TERM_CASES, caseName)
      // Keep the acquisition/guard identity on the original native query. Only
      // this private adapter changes the wire text, after validating the exact
      // normalized request; production compilation could erase explicit AND.
      const wireQuery = selected.providerQuery || selected.query
      calls++; onDispatch({ querySha256: digest(wireQuery), queryLength: wireQuery.length,
        evidence: 'Current adapter handoff only; not proof of HTTP dispatch, supplier receipt or historical wire text.' })
      return adapter.execute({ ...request, query: wireQuery,
        // New diagnostic identities acquire the complete single provider page.
        // count=20 is a supplier hint. No auto-fill, truncation or pagination;
        // existing raw cases keep their original strict-count interpretation.
        ...(Object.hasOwn(TERM_CASES, caseName) ? { standardSearch: true, allowOverflow: true } : {}),
        endpointPath: pathForm ? `/search/${encodeURIComponent(wireQuery).replace(/[!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)}` : '/search',
        upstreamQuery: { ...request.upstreamQuery, category: 'Top', ...(!pathForm ? { searchItem: wireQuery } : {}) } }, options)
    },
  }
}

async function appendSavedEvidence(report, pool, saved, selected) {
  report.saved = { requestId: safeId(saved.id), status: choice(saved.status, ['reserved', 'committed', 'released', 'unknown']),
    httpStatus: integer(saved.response_status) }
  const calls = (await pool.query(`SELECT /* twitter-query-param:probe-calls */ id,tenant_id,consumer_id,api_key_id,
    provider_key,operation,endpoint_key,endpoint_version,contract_version,call_ordinal,call_role,outcome,http_status,
    upstream_request_id,completed_at,now() AS observed_at FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY started_at LIMIT 2`,
  [saved.id])).rows
  report.providerCalls = calls.map(call => ({ callId: safeId(call.id),
    outcome: choice(call.outcome, ['succeeded', 'rejected', 'unknown', 'succeeded_unusable', 'pending']),
    httpStatus: integer(call.http_status), upstreamRequestId: typeof call.upstream_request_id === 'string'
      && /^[A-Za-z0-9_.:-]{1,128}$/u.test(call.upstream_request_id) ? call.upstream_request_id : null }))
  report.savedOutcomeVerified = savedOutcome(saved, calls, selected.query)
  if (Object.values(TERM_CASES).includes(selected) && report.savedOutcomeVerified === 'success') {
    report.acquiredCount = Array.isArray(saved.response_body?.data?.items) ? saved.response_body.data.items.length : null
  }
  const error = saved.response_body?.error
  if ((Object.values(GROUP_CASES).includes(selected) || Object.values(ORDER_CASES).includes(selected))
    && isOwnedProbeReceipt(saved, calls, selected.query)
    && Object.keys(saved.acquisition_request.body).sort().join(',') === 'pageSize,platform,query'
    && saved.response_status === 502 && error?.code === 'social_upstream_response_unusable'
    && error.details?.upstreamStatus === 200 && error.details.outcome === 'succeeded_unusable'
    && error.details.retryable === false && calls[0].outcome === 'succeeded_unusable' && calls[0].http_status === 200) {
    const { rows } = await pool.query(`SELECT /* twitter-query-param:probe-archive */ body_size,body_sha256,captured_at,
      CASE WHEN body_size <= $2 AND octet_length(body_bytes) <= $2 THEN body_bytes END AS body_bytes
      FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1 LIMIT 2`, [calls[0].id, 4 * 1024 * 1024])
    report.archiveObservation = await inspectProbeOverflowArchive(rows.length === 1 ? rows[0] : null, selected.query)
    if (Object.values(ORDER_CASES).includes(selected) && report.archiveObservation.state === 'valid_overflow_response') {
      // This diagnostic runtime leaves responseQuarantineCooldownMs at its
      // default min(uncertainCooldownMs, 5 minutes). Wait conservatively using
      // database timestamps before reserving a full-query identity; the normal
      // gateway still checks all live admission/unknown/circuit state afterward.
      const completed = calls[0].completed_at == null ? NaN : new Date(calls[0].completed_at).getTime()
      const observed = calls[0].observed_at == null ? NaN : new Date(calls[0].observed_at).getTime()
      const until = completed + 5 * 60_000
      report.archiveObservation.overflowCooldownUntil = Number.isFinite(until) ? new Date(until).toISOString() : null
      report.archiveObservation.overflowCooldownElapsed = Number.isFinite(observed) && Number.isFinite(until) && observed >= until
    }
  }
}

async function runSingleProbe({ pool, execute = false, caseName, createGatewayRuntime }) {
  const selected = PROBE_CASES[caseName] || HALF_CASES[caseName] || AND_CASES[caseName] || GROUP_CASES[caseName] || ORDER_CASES[caseName] || TERM_CASES[caseName]
  const half = Object.hasOwn(HALF_CASES, caseName), explicitAnd = Object.hasOwn(AND_CASES, caseName), englishGroup = Object.hasOwn(GROUP_CASES, caseName)
  const ordered = Object.hasOwn(ORDER_CASES, caseName), term = Object.hasOwn(TERM_CASES, caseName)
  const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID,
    case: caseName, querySha256: digest(selected.query), queryLength: selected.query.length,
    endpointVariant: half || explicitAnd || englishGroup || ordered || term ? 'GET /search/{searchItem}' : 'GET /search?searchItem', category: 'Top', count: 20,
    ...(explicitAnd || ordered ? { providerQuerySha256: digest(selected.providerQuery), providerQueryLength: selected.providerQuery.length,
      providerQueryEvidence: 'Fixed expected diagnostic wire text; saved usage retains the native query. This is not historical outgoing URL evidence.',
      wireSyntax: ordered ? 'Only the four event OR atoms are permuted; every original atom, quote, negation and conjunction is retained.'
        : 'Explicit AND between positive OR groups; every original atom and negation retained.',
      queryScope: caseName === 'events_order' ? 'Same complete event-group predicate with a different OR order; not the full business query.'
        : caseName === 'english_and' ? 'English subexpression only; not the full business query.'
        : 'Semantically equivalent full candidate; diagnostic page only, not a cold-start delivery.' } : {}),
    ...(half ? { queryScope: 'Proper subexpression of the original AND; diagnostic only, not equivalent to the full business query.' } : {}),
    ...(englishGroup ? { queryScope: 'One original English OR group with every original English exclusion; diagnostic only, not a full business result.' } : {}),
    ...(term ? { queryScope: 'Fixed event pair or quoted atom with all original English exclusions; diagnostic only.',
      acquisitionScope: 'diagnostic_provider_page', deliveryEstablished: false,
      requestCountMeaning: 'Supplier count hint; the entire acquired page may contain more than 20 items.' } : {}),
    idempotencyKey: selected.idempotencyKey, mode: execute ? 'execute' : 'read_only', adapterCalls: 0,
    countMeaning: 'Adapter attempts only; not proof of HTTP dispatch, supplier charge or billed calls.',
    deliveryScope: 'Independent raw single-page diagnostic; not a standard search delivery or cold-start recovery.',
    automaticRetryAllowed: false }
  let initial
  try {
    initial = await readSnapshot(pool, selected.idempotencyKey, caseName)
    report.originalRejectionVerified = true
    report.knownCandidateRejections = initial.knownCandidates
    if (explicitAnd || englishGroup || ordered || term) report.knownHalfOutcomes = initial.knownHalves
    if (englishGroup || ordered || term) report.knownEnglishAnd = initial.knownEnglishAnd
    if (ordered || term) report.knownEvent = initial.knownEvent
    if (term) report.knownOrder = initial.knownOrder
    report.evidenceScope = 'Fixed original receipt, listed candidate refusals, this probe key and standard v2 query guard; not an exhaustive historical v1 scan.'
    if (initial.existing) report.existing = { requestId: safeId(initial.existing.id),
      status: choice(initial.existing.status, ['reserved', 'committed', 'released', 'unknown']),
      httpStatus: integer(initial.existing.response_status) }
    // An already recorded probe is inspected only. In particular, rerunning
    // this script can never reclaim a released usage or redispatch an unknown.
    if (!execute || initial.existing) {
      if (initial.existing) await appendSavedEvidence(report, pool, initial.existing, selected)
      return report
    }
    const runtime = await createGatewayRuntime(prepared => {
      report.adapterCalls++
      if (explicitAnd || englishGroup || ordered || term) report.preparedProviderQuery = prepared
    }, caseName)
    const context = await runtime.store.findApiKeyById(initial.original.api_key_id)
    requireValue(context?.tenant?.id === initial.original.tenant_id && context.consumer?.id === initial.original.consumer_id
      && context.apiKey?.id === initial.original.api_key_id, 'original_owner_unavailable')
    const body = { platform: 'twitter', query: selected.query, pageSize: 20 }
    // Keep the standard-search protocol guard around this diagnostic raw
    // call. Selecting another endpoint is never permission to cross an active
    // standard v2 lease or unresolved binding for the same query and identity.
    const result = await runtime.guardDataSearchV1({ store: runtime.store, context,
      body: { platform: 'twitter', query: selected.query, pageSize: 20, type: 'stable' }, idempotencyKey: selected.idempotencyKey,
      execute: () => runtime.gateway.searchRaw(context, { body,
        normalized: { platform: 'twitter', upstreamBody: body, pageSize: 20 },
        idempotencyKey: selected.idempotencyKey }) })
    report.httpStatus = integer(result.status)
    report.requestId = safeId(result.requestId)
    if (term) report.acquiredCount = Array.isArray(result.body?.data?.items) ? result.body.data.items.length : null
    else {
      report.itemCount = Array.isArray(result.body?.data?.items) ? result.body.data.items.length : null
      report.hasMore = typeof result.body?.data?.page?.hasMore === 'boolean' ? result.body.data.page.hasMore : null
    }
  } catch (error) {
    report.errorCode = safeCode(error)
    report.httpStatus = integer(error?.status)
    report.requestId = safeId(error?.details?.requestId)
    report.upstreamStatus = integer(error?.details?.upstreamStatus)
    report.outcome = choice(error?.details?.outcome, ['rejected', 'unknown', 'succeeded_unusable'])
  }
  if (initial) {
    try {
      const after = await readSnapshot(pool, selected.idempotencyKey, caseName)
      requireValue(after.originalDigest === initial.originalDigest, 'original_request_changed')
      requireValue(JSON.stringify(after.knownCandidates) === JSON.stringify(initial.knownCandidates), 'known_candidate_changed')
      requireValue(JSON.stringify(after.knownHalves) === JSON.stringify(initial.knownHalves), 'known_half_changed')
      requireValue(JSON.stringify(after.knownEnglishAnd) === JSON.stringify(initial.knownEnglishAnd), 'known_english_and_changed')
      requireValue(JSON.stringify(after.knownEvent) === JSON.stringify(initial.knownEvent), 'known_event_changed')
      requireValue(JSON.stringify(after.knownOrder) === JSON.stringify(initial.knownOrder), 'known_order_changed')
      report.originalUnchanged = true
      if (after.existing) await appendSavedEvidence(report, pool, after.existing, selected)
    } catch (error) { report.verificationError = safeCode(error) }
  }
  return report
}

export async function runTwitterQueryParamProbe({ pool, execute = false, caseName, createGatewayRuntime }) {
  requireValue((!execute && caseName == null) || ['halves', 'english-and', 'english-groups', 'event-order', 'event-terms'].includes(caseName) || Object.hasOwn(PROBE_CASES, caseName), 'invalid_arguments')
  caseName ??= 'control'
  if (caseName === 'event-terms') {
    const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, case: caseName,
      mode: execute ? 'execute' : 'read_only', adapterCalls: 0, maxAdapterCalls: 6, automaticRetryAllowed: false,
      acquisitionScope: 'diagnostic_provider_page', deliveryEstablished: false, fullQueryAttempted: false,
      deliveryScope: 'Adaptive event-predicate diagnosis only; no Delta mutation or cold-start delivery.',
      continuation: 'Two fixed pairs first; split only a pair with an owned saved 400. Stop on any unconfirmed outcome. Never send the full query.',
      reports: [], rejectedCases: [], acceptedCases: [] }
    const pairs = { events_pair_a: ['event_statement', 'event_response'], events_pair_b: ['event_clarification', 'event_update'] }
    const queue = Object.keys(pairs)
    for (const part of queue) {
      const result = await runSingleProbe({ pool, execute, caseName: part, createGatewayRuntime })
      report.reports.push(result)
      report.adapterCalls += result.adapterCalls
      const outcome = result.savedOutcomeVerified
      if (result.verificationError || execute && !['success', 'rejected400'].includes(outcome) || !execute && result.errorCode) {
        report.stoppedAfter = part
        report.errorCode = result.verificationError || result.errorCode || 'event_terms_outcome_unverified'
        break
      }
      if (outcome === 'success') report.acceptedCases.push(part)
      if (outcome === 'rejected400') {
        report.rejectedCases.push(part)
        if (execute && pairs[part]) queue.push(...pairs[part])
      }
    }
    report.interpretation = 'These are saved outcomes for exact subexpressions, not proof of a permanent word restriction or a repaired full query. No business condition is removed.'
    return report
  }
  if (caseName === 'event-order') {
    const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, case: caseName,
      mode: execute ? 'execute' : 'read_only', adapterCalls: 0, maxAdapterCalls: 2, automaticRetryAllowed: false,
      deliveryScope: 'Fixed OR-order compatibility diagnosis; no Delta mutation or cold-start delivery.',
      continuation: 'Inspect the equivalent event expression first; only a saved success or verified overflow archive permits the full equivalent query. Normal admission still applies.', reports: [] }
    for (const part of ['events_order', 'candidate_order']) {
      const result = await runSingleProbe({ pool, execute, caseName: part, createGatewayRuntime })
      report.reports.push(result)
      report.adapterCalls += result.adapterCalls
      const observed = result.savedOutcomeVerified === 'success' || result.archiveObservation?.state === 'valid_overflow_response'
      if (result.verificationError || execute && !observed || !execute && result.errorCode) {
        report.stoppedAfter = part
        report.errorCode = result.errorCode || result.verificationError || 'event_order_outcome_unverified'
        break
      }
      if (execute && part === 'events_order' && result.archiveObservation?.state === 'valid_overflow_response'
        && !result.archiveObservation.overflowCooldownElapsed) {
        report.stoppedAfter = part
        report.errorCode = 'event_order_full_query_deferred'
        report.continuationNotBefore = result.archiveObservation.overflowCooldownUntil
        report.fullQueryAttempted = false
        break
      }
    }
    report.interpretation = 'Even a full-query first page does not establish cold-start delivery or full-window coverage. An order comparison alone does not prove the supplier rejection mechanism.'
    return report
  }
  if (caseName === 'english-and') {
    const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, case: caseName,
      mode: execute ? 'execute' : 'read_only', adapterCalls: 0, maxAdapterCalls: 2, automaticRetryAllowed: false,
      deliveryScope: 'Explicit-AND compatibility diagnosis only; no Delta mutation or cold-start delivery.',
      continuation: 'The complete query runs only after the English probe has one owned saved 200/succeeded receipt.', reports: [] }
    for (const part of ['english_and', 'candidate_and']) {
      const result = await runSingleProbe({ pool, execute, caseName: part, createGatewayRuntime })
      report.reports.push(result)
      report.adapterCalls += result.adapterCalls
      if (result.verificationError || result.errorCode || execute && result.savedOutcomeVerified !== 'success') {
        report.stoppedAfter = part
        report.errorCode = result.errorCode || result.verificationError || 'explicit_and_outcome_unverified'
        break
      }
    }
    return report
  }
  if (!['halves', 'english-groups'].includes(caseName)) return runSingleProbe({ pool, execute, caseName, createGatewayRuntime })
  const groups = caseName === 'english-groups'
  const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, queryParamRequestId: QUERY_PARAM_REQUEST_ID,
    case: caseName, mode: execute ? 'execute' : 'read_only', adapterCalls: 0, maxAdapterCalls: groups ? 1 : 2,
    countMeaning: 'Adapter attempts only; not proof of HTTP dispatch, supplier charge or billed calls.',
    deliveryScope: 'Two proper subexpressions for diagnosis only. Neither result is a full-query result or cold-start recovery.',
    combination: groups ? 'english_topics AND english_events equals the English half; original English exclusions occur in both. Pages are not merged or delivered to Delta.'
      : 'chinese_half AND english_half equals the full candidate; the two result pages are not merged or delivered to Delta.',
    fullQuerySha256: digest(PROBE_CASES.candidate.query), automaticRetryAllowed: false,
    ...(groups ? { continuation: 'Read the existing topic receipt and archive only; at most one new event-group request. Never reacquire the topic group.' } : {}), reports: [] }
  for (const part of groups ? ['english_topics', 'english_events'] : ['chinese_half', 'english_half']) {
    const result = await runSingleProbe({ pool, execute: execute && !(groups && part === 'english_topics'), caseName: part, createGatewayRuntime })
    report.reports.push(result)
    report.adapterCalls += result.adapterCalls
    // Do not move to another query after an unresolved dispatch, failed proof
    // or an unconfirmed refusal. Re-running inspects each existing fixed key.
    const verifiedOverflow = groups && result.archiveObservation?.state === 'valid_overflow_response'
    if (result.verificationError || execute && !['success', 'rejected400'].includes(result.savedOutcomeVerified) && !verifiedOverflow
      || !execute && result.errorCode) {
      report.stoppedAfter = part
      report.errorCode = result.errorCode || result.verificationError || 'subexpression_outcome_unverified'
      break
    }
  }
  if (groups) {
    report.rejectedGroups = report.reports.filter(row => row.savedOutcomeVerified === 'rejected400').map(row => row.case)
    report.succeededGroups = report.reports.filter(row => row.savedOutcomeVerified === 'success').map(row => row.case)
    report.archiveValidatedGroups = report.reports.filter(row => row.archiveObservation?.state === 'valid_overflow_response').map(row => row.case)
    report.interpretation = 'Only these saved group outcomes are established. The reason the combined query was rejected remains unproven; no cold-start recovery is implied.'
  }
  return report
}

async function runtimeFromInstalledSources(pool, onDispatch, caseName) {
  // Resolve from the Hub project cwd so this exact file also runs over stdin.
  const root = pathToFileURL(`${process.cwd()}/`)
  const source = path => import(new URL(path, root))
  const [configModule, usageModule, platformModule, credentialModule, controlModule, proxyModule,
    adapterModule, gatewayModule, admissionModule, limitsModule, protocolModule] = await Promise.all([
    source('server/config.mjs'), source('server/stores/postgres-store.mjs'), source('server/external-platforms/store.mjs'),
    source('server/external-platforms/credentials-store.mjs'), source('server/external-platforms/control-store.mjs'),
    source('server/external-platforms/proxy.mjs'), source('server/adapters/rapidapi.mjs'),
    source('server/external-platforms/gateway.mjs'), source('server/external-platforms/admission-policy.mjs'),
    source('server/external-platforms/admission-runtime.mjs'), source('server/data/search-protocol.mjs'),
  ])
  const config = configModule.loadConfig(), rapid = config.rapidApi
  requireValue(config.storeDriver === 'postgres' && !rapid.configurationError, 'database_url_required')
  const store = new usageModule.PostgresStore(pool, { internalTraffic: config.internalTraffic })
  const credentialStore = credentialModule.createExternalPlatformCredentialStore({ pool, providerKey: 'rapidapi', environmentConfigured: rapid.configured })
  const proxyStore = new proxyModule.ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: 'rapidapi' })
  const adapter = queryParamAdapter(new adapterModule.RapidApiAdapter({ apiKey: rapid.apiKey,
    fetchImpl: proxyModule.createRapidApiProxyFetch(proxyStore), timeoutMs: rapid.timeoutMs }), caseName, onDispatch)
  const gateway = new gatewayModule.ExternalPlatformGateway({ usageStore: store,
    platformStore: platformModule.createExternalPlatformStore({ pool, usageStore: store, providerKey: 'rapidapi',
      authorizationPlatform: 'twitter', circuitFailureThreshold: rapid.circuitFailureThreshold,
      circuitOpenMs: rapid.circuitOpenMs, uncertainCooldownMs: rapid.unknownFingerprintCooldownMs }),
    adapter, config: rapid, providerKey: 'rapidapi', credentialStore,
    operationControlStore: controlModule.createExternalPlatformControlStore({ pool }),
    admissionPolicies: new admissionModule.ExternalAdmissionPolicyStore({ pool,
      defaultsByProvider: { rapidapi: limitsModule.deploymentAdmissionLimits(rapid) } }),
    apiKeyPepper: config.apiKeyPepper, reservationLeaseMs: Math.max(60000, config.reservationLeaseMs),
    logger: { warn() {} },
  })
  return { store, gateway, guardDataSearchV1: protocolModule.guardDataSearchV1 }
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    const cases = args.filter(arg => arg.startsWith('--case=')), executeFlags = args.filter(arg => arg === '--execute')
    requireValue(cases.length <= 1 && executeFlags.length <= 1 && args.length === cases.length + executeFlags.length, 'invalid_arguments')
    const caseName = cases[0]?.slice('--case='.length), execute = executeFlags.length === 1 || env.MX_TWITTER_QUERY_PARAM_VERIFY === '1'
    requireValue((!execute && caseName == null) || ['halves', 'english-and', 'english-groups', 'event-order', 'event-terms'].includes(caseName) || Object.hasOwn(PROBE_CASES, caseName), 'invalid_arguments')
    requireValue(typeof env.DATABASE_URL === 'string' && env.DATABASE_URL.trim(), 'database_url_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 4, application_name: REVISION })
    const report = await runTwitterQueryParamProbe({ pool,
      execute, caseName,
      createGatewayRuntime: (onDispatch, selectedCase) => runtimeFromInstalledSources(pool, onDispatch, selectedCase) })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.errorCode || report.verificationError) process.exitCode = 1
  } catch (error) { process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: safeCode(error) })}\n`); process.exitCode = 1 }
  finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
