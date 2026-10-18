import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Read one operator-selected request, or compare three. No business API,
// status reaper, credential read, provider dispatch or history mutation.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PATHS = ['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/social/search']
const BODY_LIMIT = 16 * 1024, CALL_LIMIT = 15
const sha = value => createHash('sha256').update(value).digest('hex')
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const integer = value => value != null && /^\d+$/u.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : null
const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) ? value : null
const date = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toISOString() : null
const failures = new Set(['invalid_arguments', 'database_url_required', 'twitter_request_not_found', 'invalid_request_id'])
const safeFailure = error => failures.has(error?.message) ? error.message : 'diagnostic_read_failed'

export function projectTwitterSavedInput(snapshot) {
  if (!object(snapshot) || !PATHS.includes(snapshot.path) || snapshot.method !== 'POST'
    || snapshot.bodyOmitted || !object(snapshot.body)) return { state: 'saved_request_unavailable' }
  const body = snapshot.body, fields = {}, unsupported = Object.keys(body).filter(key => ![
    'platform', 'query', 'keyword', 'pageSize', 'count', 'limit', 'type', 'sort', 'cursor', 'page', 'params',
  ].includes(key))
  const queries = ['query', 'keyword']
  for (const key of queries) {
    if (!Object.hasOwn(body, key)) continue
    const value = body[key]
    fields[key] = typeof value === 'string' && value.length <= 500 && value !== '[redacted]'
      ? { value, length: value.length, sha256: sha(value) } : { state: 'unavailable_or_oversize' }
  }
  for (const key of ['platform', 'type', 'sort']) {
    if (Object.hasOwn(body, key)) fields[key] = typeof body[key] === 'string'
      && ['twitter', 'x', 'fresh', 'stable', 'top', 'latest'].includes(body[key].trim().toLowerCase()) ? body[key] : 'other_or_invalid'
  }
  for (const key of ['pageSize', 'count', 'limit', 'page']) if (Object.hasOwn(body, key)) {
    fields[key] = typeof body[key] === 'number' ? integer(body[key])
      : typeof body[key] === 'string' && /^\d{1,6}$/u.test(body[key]) ? { type: 'string', value: body[key] } : { state: 'invalid_type' }
  }
  fields.cursor = body.cursor == null ? { present: false } : typeof body.cursor === 'string'
    ? { present: true, length: body.cursor.length, sha256: sha(body.cursor) } : { present: true, state: 'invalid_type' }
  // Legacy/raw extras can influence routing. Report bounded field presence,
  // never arbitrary nested params or an opaque continuation token.
  fields.params = body.params === undefined ? { present: false } : { present: true,
    state: object(body.params) ? 'values_withheld' : 'invalid_type',
    fieldCount: object(body.params) ? Object.keys(body.params).length : null }
  return { state: 'saved_request', method: snapshot.method, path: snapshot.path, fields,
    unsupportedFieldCount: unsupported.length, scope: 'saved Hub parameters; cursor and arbitrary params values are withheld' }
}

function errorText(value) {
  if (typeof value !== 'string') return null
  if (value.length > 1024) return { state: 'oversize_text_withheld', length: value.length, sha256: sha(value) }
  // Never echo fields discussing credentials, even when their syntax is not
  // key=value. Other error text is bounded, treated as data and URL/opaque scrubbed.
  if (/(?:api[\s_-]?key|authorization|bearer|cookie|credential|password|secret|token)/iu.test(value)) {
    return { state: 'credential_related_text_withheld', length: value.length, sha256: sha(value) }
  }
  const text = value.replace(/https?:\/\/[^\s"'<>]+/giu, '[URL redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{12,})*\b/gu, '[opaque value redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
  return { state: 'projected_error_text', text, redacted: text !== value, length: value.length }
}

export function inspectTwitterRejectedArchive(row) {
  if (!row) return { state: 'archive_missing' }
  if (row.body_size > BODY_LIMIT) return { state: 'archive_too_large', bodySize: integer(row.body_size), sha256: row.body_sha256 }
  const bytes = row.body_bytes instanceof Uint8Array ? Buffer.from(row.body_bytes) : null
  if (!bytes || bytes.length > BODY_LIMIT || bytes.length !== row.body_size || sha(bytes) !== row.body_sha256) return { state: 'archive_integrity_failed' }
  const evidence = { hashVerified: true, bodySize: bytes.length, sha256: row.body_sha256 }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '')) }
  catch { return { state: 'archive_not_json', ...evidence } }
  if (!object(payload)) return { state: 'archive_not_error_object', ...evidence }
  const messages = {}
  for (const [key, value] of [ ['message', payload.message], ['msg', payload.msg], ['detail', payload.detail],
    ['error', typeof payload.error === 'string' ? payload.error : null], ['error.message', payload.error?.message], ['error.msg', payload.error?.msg] ]) {
    const projected = errorText(value)
    if (projected) messages[key] = projected
  }
  for (const field of ['errors', 'detail']) {
    if (!Array.isArray(payload[field])) continue
    for (const [index, entry] of payload[field].slice(0, 5).entries()) {
      for (const key of ['message', 'msg']) {
        const projected = errorText(entry?.[key])
        if (projected) messages[`${field}[${index}].${key}`] = projected
      }
    }
  }
  const code = value => typeof value === 'number' ? integer(value)
    : typeof value !== 'string' ? null
      : ['BAD_REQUEST', 'INVALID_REQUEST', 'INVALID_QUERY', 'VALIDATION_ERROR', 'QUERY_TOO_LONG', 'INVALID_ARGUMENT',
        'BAD_USER_INPUT', 'bad_request', 'invalid_request', 'invalid_query', 'validation_error'].includes(value)
        ? value : { state: 'unreviewed_code_withheld', length: value.length, sha256: sha(value) }
  return { state: 'verified_http400_error_fields', ...evidence,
    code: code(payload.code), errorCode: code(payload.error?.code),
    messages, arraysTruncated: ['errors','detail'].some(key => Array.isArray(payload[key]) && payload[key].length > 5),
    scope: 'supplier error statement only, not an independently verified cause; no full body or business data returned' }
}

function reconstructedInput(snapshot, { normalizeStandard, normalizeSocial }) {
  if (!object(snapshot?.body) || snapshot.bodyOmitted || snapshot.method !== 'POST' || !PATHS.includes(snapshot.path)
    || typeof snapshot.body.platform !== 'string' || !['twitter','x'].includes(snapshot.body.platform.trim().toLowerCase())) return { state: 'saved_request_unavailable' }
  const body = snapshot.body
  if (body.cursor != null || body.params != null || (body.page ?? 1) !== 1) return { state: 'first_page_without_params_required' }
  try {
    let request
    if (snapshot.path === '/api/v1/data/search' && normalizeStandard) {
      if (Object.keys(body).some(key => !['platform','query','pageSize','type'].includes(key))) return { state: 'unsupported_saved_fields' }
      request = normalizeStandard({ platform: 'twitter', query: body.query.trim(), pageSize: body.pageSize ?? 20 },
        { decode() { throw new Error('unexpected_cursor') } }, body.type ?? 'fresh').providerRequest
    } else if (PATHS.includes(snapshot.path) && normalizeSocial) {
      request = normalizeSocial('search', body)
    } else return { state: 'installed_normalizer_unavailable' }
    return { state: 'current_contract_reconstruction', evidence: 'installed diagnostic-container code, not historical outgoing URL capture',
      method: 'GET', endpointPath: request.endpointPath, queryParameters: request.upstreamQuery }
  } catch { return { state: 'current_contract_rejects_saved_input' } }
}

function compare(left, right) {
  const a = left.savedInput, b = right.savedInput
  if (a.state !== 'saved_request' || b.state !== 'saved_request') return { state: 'saved_parameters_incomplete' }
  const fields = [...new Set([...Object.keys(a.fields), ...Object.keys(b.fields)])]
  return { sameTenant: left.owner.tenantId === right.owner.tenantId,
    sameConsumer: left.owner.consumerId === right.owner.consumerId, sameApiKey: left.owner.apiKeyId === right.owner.apiKeyId,
    samePath: a.path === b.path, sameFingerprint: left.fingerprint === right.fingerprint,
    differentSavedFields: fields.filter(key => JSON.stringify(a.fields[key]) !== JSON.stringify(b.fields[key])),
    comparisonCoverage: 'allowlisted fields only; arbitrary params and unsupported field values are not compared',
    sameReconstructedFirstCall: left.currentFirstCall.state === 'current_contract_reconstruction'
      && right.currentFirstCall.state === 'current_contract_reconstruction'
      ? JSON.stringify(left.currentFirstCall) === JSON.stringify(right.currentFirstCall) : null }
}

async function readTwitterRequests(pool, selected, normalizers) {
  if (!Object.values(selected).every(id => typeof id === 'string' && UUID.test(id))) throw new Error('invalid_request_id')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const requests = {}
    for (const [role, requestId] of Object.entries(selected)) {
      const { rows: [row] } = await client.query(`SELECT /* twitter-compare:usage */
        id,tenant_id,consumer_id,api_key_id,platform,status,response_status,error_code,fingerprint,
        reserved_at,completed_at,delivery_source_mode,
        CASE WHEN octet_length(acquisition_request::text) <= 16384 THEN acquisition_request END AS acquisition_request,
        response_body->'data'->'pageInfo'->'returnedCount' AS returned_count,
        response_body->'data'->'pageInfo'->'hasMore' AS has_more
        FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
      if (!row || row.platform !== 'twitter') throw new Error('twitter_request_not_found')
      const { rows: calls } = await client.query(`SELECT /* twitter-compare:calls */
        id,provider_key,operation,endpoint_key,endpoint_version,contract_version,outcome,http_status,business_code,
        billed,error_code,item_count,latency_ms,started_at,completed_at,call_ordinal,call_role,
        provider_credential_revision,operation_policy_revision,upstream_request_id
        FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid
        ORDER BY started_at,id LIMIT 16`, [requestId])
      const ownCalls = []
      for (const call of calls.slice(0, CALL_LIMIT)) {
        let archive = { state: 'not_rejected_http400' }
        if (call.provider_key === 'rapidapi' && call.operation === 'social.content.search'
          && call.endpoint_key === 'twitter-aio.search' && call.endpoint_version === 'twitter-aio.hub.v1'
          && call.contract_version === 'mx-insight-hub.social-data.v1' && call.outcome === 'rejected' && call.http_status === 400) {
          const { rows: [raw] } = await client.query(`SELECT /* twitter-compare:rejected-archive */ body_size,body_sha256,
            CASE WHEN body_size<=$2 AND octet_length(body_bytes)<=$2 THEN body_bytes END AS body_bytes
            FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1::uuid`, [call.id, BODY_LIMIT])
          archive = inspectTwitterRejectedArchive(raw)
        }
        ownCalls.push({ callId: call.id, provider: identifier(call.provider_key), operation: identifier(call.operation),
          endpoint: identifier(call.endpoint_key), endpointVersion: identifier(call.endpoint_version), contractVersion: identifier(call.contract_version),
          ordinal: integer(call.call_ordinal), role: identifier(call.call_role), outcome: identifier(call.outcome),
          httpStatus: integer(call.http_status), businessCode: integer(call.business_code), errorCode: identifier(call.error_code),
          billed: typeof call.billed === 'boolean' ? call.billed : null, itemCount: integer(call.item_count), latencyMs: integer(call.latency_ms),
          providerCredentialRevision: integer(call.provider_credential_revision), operationPolicyRevision: integer(call.operation_policy_revision),
          upstreamRequestId: identifier(call.upstream_request_id), startedAt: date(call.started_at), completedAt: date(call.completed_at), rejectedArchive: archive })
      }
      requests[role] = { requestId, status: identifier(row.status), httpStatus: integer(row.response_status), errorCode: identifier(row.error_code),
        owner: { tenantId: row.tenant_id, consumerId: row.consumer_id, apiKeyId: row.api_key_id }, fingerprint: row.fingerprint,
        requestedAt: date(row.reserved_at), completedAt: date(row.completed_at), deliverySourceMode: identifier(row.delivery_source_mode),
        returnedCount: integer(row.returned_count), hasMore: typeof row.has_more === 'boolean' ? row.has_more : null,
        savedInput: projectTwitterSavedInput(row.acquisition_request), currentFirstCall: reconstructedInput(row.acquisition_request, normalizers),
        ownCalls, callsTruncated: calls.length > CALL_LIMIT }
    }
    return requests
  } catch (error) { throw new Error(safeFailure(error)) }
  finally {
    if (client) {
      let rollbackError
      try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
      client.release(rollbackError)
      if (rollbackError) throw new Error('diagnostic_read_failed')
    }
  }
}

export async function compareTwitterRequests(pool, { originalRequestId, failedRequestId, successRequestId }, normalizers = {}) {
  const requests = await readTwitterRequests(pool,
    { original: originalRequestId, failed: failedRequestId, success: successRequestId }, normalizers)
  return { diagnosticRevision: 'twitter-request-comparison.v1', requests,
    comparisons: { originalVsRetry: compare(requests.original, requests.failed), retryVsSuccess: compare(requests.failed, requests.success) },
    interpretation: 'Exact operator-selected requests. HTTP 400 is a saved upstream refusal, unlike an unknown transport outcome. Query differences or current-code reconstruction alone do not prove its cause. No dispatch, credential read or settlement change.' }
}

export async function diagnoseTwitterRequest(pool, requestId, normalizers = {}) {
  const { request } = await readTwitterRequests(pool, { request: requestId }, normalizers)
  return { diagnosticRevision: 'twitter-request-diagnostic.v1', readOnly: true, businessCalls: 0, request,
    interpretation: 'One exact operator-selected request and its own calls only. HTTP 400 is a saved upstream refusal; projected error text is the supplier statement, not independent proof of its cause. Current-code reconstruction is not the historical outgoing URL. No dispatch, credential read or settlement change.' }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const requestIds = process.argv.slice(2)
    if (![1, 3].includes(requestIds.length) || !requestIds.every(id => UUID.test(id))) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/`) : new URL('../../', import.meta.url)
    let normalizers = {}
    try {
      const { normalizeHubDataSearch } = await import(new URL('server/contracts/hub-data-search.mjs', root))
      const { normalizeHubSocialRequest } = await import(new URL('server/contracts/hub-social.mjs', root))
      normalizers = { normalizeStandard: normalizeHubDataSearch, normalizeSocial: normalizeHubSocialRequest }
    } catch { /* Actual saved evidence is still useful when installed reconstruction is unavailable. */ }
    const files = ['server/adapters/rapidapi.mjs','server/contracts/hub-social.mjs','server/contracts/hub-data-search.mjs','server/contracts/raw-search.mjs']
    const sources = files.map(file => { try { return { file, sha256: sha(readFileSync(new URL(file, root))) } } catch { return { file, sha256: null } } })
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    const [originalRequestId, failedRequestId, successRequestId] = requestIds
    const report = requestIds.length === 1 ? await diagnoseTwitterRequest(pool, originalRequestId, normalizers)
      : await compareTwitterRequests(pool, { originalRequestId, failedRequestId, successRequestId }, normalizers)
    console.log(JSON.stringify({ ...report,
      runtime: { scope: 'diagnostic_container_only_not_public_serving_version', installedSources: sources } }, null, 2))
  } catch (error) { console.error(JSON.stringify({ error: safeFailure(error) })); process.exitCode = 1 }
  finally { await pool?.end() }
}
