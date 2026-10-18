// Fixed, one-page comparison of the supplier's documented query-param alias.
// Dry run by default. Execute only after review: this can consume supplier
// quota. No deployment, Delta mutation, retry, cursor follow or unknown reset.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'twitter-query-param-check.v3'
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
const ORIGINAL_QUERY_SHA256 = 'f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ERRORS = new Set(['original_rejection_unverified', 'original_provider_evidence_unverified', 'original_request_changed',
  'original_owner_unavailable', 'known_candidate_rejection_unverified', 'known_candidate_provider_evidence_unverified', 'known_candidate_changed',
  'known_half_outcome_unverified', 'known_half_changed', 'probe_request_mismatch', 'probe_call_limit', 'invalid_arguments', 'database_url_required',
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

function savedOutcome(saved, calls, query, expectedCallId) {
  const ownedCall = calls.length === 1 && calls.every(call => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => call[key] === saved[key])
    && call.provider_key === 'rapidapi' && call.operation === 'social.content.search' && call.endpoint_key === 'twitter-aio.search'
    && call.endpoint_version === 'twitter-aio.hub.v1' && call.contract_version === 'mx-insight-hub.social-data.v1'
    && call.call_ordinal === 0 && call.call_role === 'primary' && (!expectedCallId || call.id === expectedCallId))
  const body = saved.acquisition_request?.body, error = saved.response_body?.error
  const verifiedInput = saved.platform === 'twitter' && saved.acquisition_request?.method === 'POST'
    && saved.acquisition_request?.path === '/api/v1/night-all/search/raw' && body?.platform === 'twitter'
    && body.query === query && body.pageSize === 20 && !body.cursor
  if (saved.status !== 'committed' || !ownedCall || !verifiedInput) return null
  if (saved.response_status === 200 && calls[0].outcome === 'succeeded' && calls[0].http_status === 200) return 'success'
  if (saved.response_status === 502 && error?.code === 'social_upstream_rejected' && error?.details?.upstreamStatus === 400
    && error.details.outcome === 'rejected' && error.details.retryable === false
    && calls[0].outcome === 'rejected' && calls[0].http_status === 400) return 'rejected400'
  return null
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
    const explicitAnd = Object.hasOwn(AND_CASES, caseName)
    if (caseName === 'candidate' || Object.hasOwn(HALF_CASES, caseName) || explicitAnd) {
      // This fixed comparison has two known earlier path-form attempts. Check
      // their saved refusals explicitly; never use a new endpoint alias to
      // get around a pending/unknown outcome. This is not a general v1 scan.
      for (const requestId of [...CANDIDATE_REQUEST_IDS, ...(Object.hasOwn(HALF_CASES, caseName) || explicitAnd ? [QUERY_PARAM_REQUEST_ID] : [])]) {
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
    if (explicitAnd) for (const receipt of HALF_RECEIPTS) {
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
    const existing = (await client.query(`SELECT /* twitter-query-param:existing */ id,tenant_id,consumer_id,api_key_id,
      platform,status,response_status,response_body,acquisition_request FROM usage_requests WHERE consumer_id=$1 AND idempotency_key=$2 ORDER BY reserved_at LIMIT 2`,
    [row.consumer_id, idempotencyKey])).rows
    requireValue(existing.length <= 1 && existing.every(entry => ['tenant_id', 'consumer_id', 'api_key_id']
      .every(key => entry[key] === row[key])), 'original_owner_unavailable')
    return { original: row, existing: existing[0] || null, knownCandidates, knownHalves,
      originalDigest: digest(JSON.stringify([row.status, row.response_status, row.response_body, row.acquisition_request, row.fingerprint])) }
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

// The raw route supplies a single page without standard-search auto-fill.
// Its default category is Latest, so this fixed diagnostic pins Top to match
// the original failed request while comparing the documented transport alias.
// The original adapter still sends, parses and archives the HTTP response.
export function queryParamAdapter(adapter, caseName, onDispatch = () => {}) {
  const selected = PROBE_CASES[caseName] || HALF_CASES[caseName] || AND_CASES[caseName]
  requireValue(Object.hasOwn(PROBE_CASES, caseName) || Object.hasOwn(HALF_CASES, caseName) || Object.hasOwn(AND_CASES, caseName), 'invalid_arguments')
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
      // Keep the acquisition/guard identity on the original native query. Only
      // this private adapter changes the wire text, after validating the exact
      // normalized request; production compilation could erase explicit AND.
      const wireQuery = selected.providerQuery || selected.query
      calls++; onDispatch({ querySha256: digest(wireQuery), queryLength: wireQuery.length,
        evidence: 'Current adapter handoff only; not proof of HTTP dispatch, supplier receipt or historical wire text.' })
      return adapter.execute({ ...request, query: wireQuery,
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
    upstream_request_id FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY started_at LIMIT 2`,
  [saved.id])).rows
  report.providerCalls = calls.map(call => ({ callId: safeId(call.id),
    outcome: choice(call.outcome, ['succeeded', 'rejected', 'unknown', 'succeeded_unusable', 'pending']),
    httpStatus: integer(call.http_status), upstreamRequestId: typeof call.upstream_request_id === 'string'
      && /^[A-Za-z0-9_.:-]{1,128}$/u.test(call.upstream_request_id) ? call.upstream_request_id : null }))
  report.savedOutcomeVerified = savedOutcome(saved, calls, selected.query)
}

async function runSingleProbe({ pool, execute = false, caseName, createGatewayRuntime }) {
  const selected = PROBE_CASES[caseName] || HALF_CASES[caseName] || AND_CASES[caseName]
  const half = Object.hasOwn(HALF_CASES, caseName), explicitAnd = Object.hasOwn(AND_CASES, caseName)
  const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID,
    case: caseName, querySha256: digest(selected.query), queryLength: selected.query.length,
    endpointVariant: half || explicitAnd ? 'GET /search/{searchItem}' : 'GET /search?searchItem', category: 'Top', count: 20,
    ...(explicitAnd ? { providerQuerySha256: digest(selected.providerQuery), providerQueryLength: selected.providerQuery.length,
      providerQueryEvidence: 'Fixed expected diagnostic wire text; saved usage retains the native query. This is not historical outgoing URL evidence.',
      wireSyntax: 'Explicit AND between positive OR groups; every original atom and negation retained.',
      queryScope: caseName === 'english_and' ? 'English subexpression only; not the full business query.'
        : 'Semantically equivalent full candidate; diagnostic page only, not a cold-start delivery.' } : {}),
    ...(half ? { queryScope: 'Proper subexpression of the original AND; diagnostic only, not equivalent to the full business query.' } : {}),
    idempotencyKey: selected.idempotencyKey, mode: execute ? 'execute' : 'read_only', adapterCalls: 0,
    countMeaning: 'Adapter attempts only; not proof of HTTP dispatch, supplier charge or billed calls.',
    deliveryScope: 'Independent raw single-page diagnostic; not a standard search delivery or cold-start recovery.',
    automaticRetryAllowed: false }
  let initial
  try {
    initial = await readSnapshot(pool, selected.idempotencyKey, caseName)
    report.originalRejectionVerified = true
    report.knownCandidateRejections = initial.knownCandidates
    if (explicitAnd) report.knownHalfOutcomes = initial.knownHalves
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
      if (explicitAnd) report.preparedProviderQuery = prepared
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
    report.itemCount = Array.isArray(result.body?.data?.items) ? result.body.data.items.length : null
    report.hasMore = typeof result.body?.data?.page?.hasMore === 'boolean' ? result.body.data.page.hasMore : null
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
      report.originalUnchanged = true
      if (after.existing) await appendSavedEvidence(report, pool, after.existing, selected)
    } catch (error) { report.verificationError = safeCode(error) }
  }
  return report
}

export async function runTwitterQueryParamProbe({ pool, execute = false, caseName, createGatewayRuntime }) {
  requireValue((!execute && caseName == null) || ['halves', 'english-and'].includes(caseName) || Object.hasOwn(PROBE_CASES, caseName), 'invalid_arguments')
  caseName ??= 'control'
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
  if (caseName !== 'halves') return runSingleProbe({ pool, execute, caseName, createGatewayRuntime })
  const report = { diagnosticRevision: REVISION, originalRequestId: ORIGINAL_REQUEST_ID, queryParamRequestId: QUERY_PARAM_REQUEST_ID,
    case: 'halves', mode: execute ? 'execute' : 'read_only', adapterCalls: 0, maxAdapterCalls: 2,
    countMeaning: 'Adapter attempts only; not proof of HTTP dispatch, supplier charge or billed calls.',
    deliveryScope: 'Two proper subexpressions for diagnosis only. Neither result is a full-query result or cold-start recovery.',
    combination: 'chinese_half AND english_half equals the full candidate; the two result pages are not merged or delivered to Delta.',
    fullQuerySha256: digest(PROBE_CASES.candidate.query), automaticRetryAllowed: false, reports: [] }
  for (const part of ['chinese_half', 'english_half']) {
    const result = await runSingleProbe({ pool, execute, caseName: part, createGatewayRuntime })
    report.reports.push(result)
    report.adapterCalls += result.adapterCalls
    // Do not move to another query after an unresolved dispatch, failed proof
    // or an unconfirmed refusal. Re-running inspects each existing fixed key.
    if (result.verificationError || execute && !['success', 'rejected400'].includes(result.savedOutcomeVerified)
      || !execute && result.errorCode) {
      report.stoppedAfter = part
      report.errorCode = result.errorCode || result.verificationError || 'subexpression_outcome_unverified'
      break
    }
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
    requireValue((!execute && caseName == null) || ['halves', 'english-and'].includes(caseName) || Object.hasOwn(PROBE_CASES, caseName), 'invalid_arguments')
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
