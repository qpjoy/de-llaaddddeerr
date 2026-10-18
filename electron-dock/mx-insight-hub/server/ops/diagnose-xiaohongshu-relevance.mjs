import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Incident-specific, standalone stdin tool. Only retained evidence is read;
// there are no adapter imports, paid requests, replays, repairs or log dumps.
export const CASES = Object.freeze([
  { id: 'b42243d1-0dfd-45e5-99a5-9aebf3216dae', query: '杨小幂 AI合成 投诉' },
  { id: 'c4dcec7a-8d2e-4aef-89a2-e93dfab10fae', query: '杨幂 论文 引用规范' },
  { id: 'a330ca1e-cfd2-467e-9525-3d9dc31d69bd', query: '杨幂 造谣 抹黑 维权声明' },
])
const MAX_BYTES = 8 * 1024 * 1024
const MAX_ROWS = 100
const MAX_TEXT = 100_000
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const PATHS = ['/api/v1/search/raw', '/api/v1/night-all/search/raw', '/api/v1/data/search']
const ENDPOINT = 'xiaohongshu.app-v2.search-notes.v1'
const TERMS = ['杨幂', '杨小幂']
const object = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value)
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const choice = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const hash = value => createHash('sha256').update(value).digest('hex')
const iso = value => (value instanceof Date || typeof value === 'string') && Number.isFinite(new Date(value).getTime())
  ? new Date(value).toISOString() : null
const queryEvidence = (value, expected) => ({ present: typeof value === 'string',
  length: typeof value === 'string' ? value.length : null,
  sha256: typeof value === 'string' ? hash(value) : null,
  matchesExpected: typeof value === 'string' ? value === expected : null,
  trimmedMatchesExpected: typeof value === 'string' ? value.trim() === expected : null })

export function summarizeRelevanceRequest(snapshot, expected) {
  const body = object(snapshot?.body) ? snapshot.body : null
  return { available: Boolean(body), method: choice(snapshot?.method, ['POST']), path: choice(snapshot?.path, PATHS),
    platform: choice(body?.platform, ['xiaohongshu']), bodyOmitted: snapshot?.bodyOmitted === 'oversize',
    query: queryEvidence(body?.query, expected), keyword: queryEvidence(body?.keyword, expected),
    count: integer(body?.count), limit: integer(body?.limit), pageSize: integer(body?.pageSize), page: integer(body?.page),
    cursorPresent: body?.cursor != null, paramsPresent: body?.params != null,
    batchPresent: body?.queries != null || body?.keywords != null }
}

// These are literal substring row counts, not a relevance classifier. Count
// fields independently: combining title/body must not invent a cross-field hit.
export function countEntityRows(rows, { source = 'delivery' } = {}) {
  if (!Array.isArray(rows)) return { state: 'unsupported_rows' }
  const fields = source === 'provider' ? ['desc', 'description', 'content'] : ['text', 'full_text', 'content', 'body']
  let recognized = 0, missingTitle = 0, missingBody = 0, textTruncated = false
  const terms = Object.fromEntries(TERMS.map(term => [term, { titleRows: 0, bodyRows: 0, eitherRows: 0 }]))
  let anyEntityRows = 0
  for (const row of rows.slice(0, MAX_ROWS)) {
    if (!object(row)) continue
    recognized++
    const titles = typeof row.title === 'string' ? [row.title] : []
    const bodies = fields.flatMap(field => typeof row[field] === 'string' ? [row[field]] : [])
    missingTitle += titles.length === 0 ? 1 : 0
    missingBody += bodies.length === 0 ? 1 : 0
    textTruncated ||= [...titles, ...bodies].some(text => text.length > MAX_TEXT)
    let any = false
    for (const term of TERMS) {
      const title = titles.some(text => text.slice(0, MAX_TEXT).includes(term))
      const body = bodies.some(text => text.slice(0, MAX_TEXT).includes(term))
      terms[term].titleRows += title ? 1 : 0
      terms[term].bodyRows += body ? 1 : 0
      terms[term].eitherRows += title || body ? 1 : 0
      any ||= title || body
    }
    anyEntityRows += any ? 1 : 0
  }
  return { state: 'counted', totalRows: rows.length, inspectedRows: Math.min(rows.length, MAX_ROWS), recognizedRows: recognized,
    unsupportedRows: Math.min(rows.length, MAX_ROWS) - recognized, rowsTruncated: rows.length > MAX_ROWS,
    textTruncated, missingTitleRows: missingTitle, missingBodyRows: missingBody, terms, anyEntityRows,
    noEntityInInspectedTextRows: recognized - anyEntityRows }
}

export function inspectRelevanceDelivery(body, expected) {
  const data = object(body?.data) ? body.data : null
  if (!data) return { state: 'missing_or_unsupported_delivery' }
  if (data.raw_data != null) {
    let rows = data.raw_data
    if (typeof rows === 'string') {
      if (Buffer.byteLength(rows) > MAX_BYTES) return { state: 'delivery_too_large' }
      try { rows = JSON.parse(rows) } catch { return { state: 'invalid_raw_json' } }
    }
    return { format: 'raw', query: queryEvidence(data.query, expected), ...countEntityRows(rows) }
  }
  if (Array.isArray(data.items)) return { format: 'data', query: queryEvidence(data.query, expected), ...countEntityRows(data.items) }
  return { state: 'unsupported_delivery_shape' }
}

export function inspectRelevanceArchive(archive, expected, call) {
  if (call?.provider_key !== 'tikhub' || call.operation !== 'social.posts.search' || call.endpoint_key !== ENDPOINT
    || call.contract_version !== 'night-all.data-search.v1') return { state: 'unreviewed_endpoint' }
  if (!archive) return { state: 'archive_missing' }
  if (archive.body_size > MAX_BYTES) return { state: 'archive_too_large' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || bytes.length > MAX_BYTES || bytes.length !== archive.body_size || hash(bytes) !== archive.body_sha256) {
    return { state: 'archive_integrity_failed' }
  }
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { return { state: 'archive_not_json', hashVerified: true } }
  const rootId = uuid(payload?.request_id)
  const savedId = uuid(call.upstream_request_id)
  const correlation = rootId && savedId ? rootId === savedId : null
  const base = { state: 'archive_verified', hashVerified: true, byteLength: bytes.length, sha256: archive.body_sha256,
    businessCode: integer(payload?.code), upstreamRequestId: rootId, matchesSavedUpstreamId: correlation }
  if (correlation === false) return { ...base, state: 'archive_correlation_mismatch' }
  // Only the fixed optional supplier echo locations; never recurse into notes.
  const params = object(payload?.params) ? payload.params : null
  const detailParams = object(payload?.detail?.params) ? payload.detail.params : null
  const echo = value => ({ present: Boolean(value), keyword: queryEvidence(value?.keyword, expected),
    query: queryEvidence(value?.query, expected), sortType: choice(value?.sort_type,
      ['general', 'time_descending', 'popularity_descending', 'comment_descending', 'collect_descending', 'english_preferred']),
    aiMode: choice(value?.ai_mode, [0, 1, '0', '1']) })
  const wrappers = payload?.data?.data?.items
  const rows = Array.isArray(wrappers) ? wrappers.slice(0, MAX_ROWS).map(wrapper => (
    object(wrapper) && wrapper.model_type === 'note' && object(wrapper.note) ? wrapper.note : null
  )) : null
  const counts = countEntityRows(rows, { source: 'provider' })
  if (Array.isArray(wrappers)) { counts.totalRows = wrappers.length; counts.rowsTruncated = wrappers.length > MAX_ROWS }
  return { ...base, echoedParams: { root: echo(params), detail: echo(detailParams) },
    page: integer(payload?.data?.page), rows: counts }
}

async function inspectRequest(client, requestId, expected) {
  const { rows: [request] } = await client.query(`SELECT id,platform,status,response_status,error_code,reserved_at,completed_at,response_captured_at,
    CASE WHEN octet_length(acquisition_request::text)<=32768 THEN acquisition_request ELSE NULL END AS acquisition_request,
    octet_length(response_body::text) AS delivery_bytes,
    CASE WHEN octet_length(response_body::text)<=8388608 THEN response_body ELSE NULL END AS response_body
    FROM public.usage_requests WHERE id=$1`, [requestId])
  if (!request) return { requestId, state: 'request_not_found' }
  if (request.platform !== 'xiaohongshu') return { requestId, state: 'not_xiaohongshu' }
  // Cache delivery records snapshot_id without a provider_call_id. The snapshot
  // row is mutable: show current metadata but never use its current pointer as
  // historical call provenance or load that call's archive through this join.
  const { rows: gateways } = await client.query(`SELECT g.source_mode,g.provider_call_id,g.snapshot_id,g.created_at,
    s.id AS current_snapshot_id,s.captured_at AS current_snapshot_captured_at,s.updated_at AS current_snapshot_updated_at,
    s.last_success_call_id AS current_last_success_call_id,
    s.captured_at=u.response_captured_at AS snapshot_capture_matches_delivery,
    s.updated_at<=g.created_at AS snapshot_not_updated_after_gateway
    FROM external_platform.gateway_requests g JOIN public.usage_requests u ON u.id=g.usage_request_id
    LEFT JOIN external_platform.response_snapshots s ON s.id=g.snapshot_id AND s.consumer_id=u.consumer_id
      AND g.consumer_id=u.consumer_id AND g.provider_key='tikhub' AND s.provider_key='tikhub' AND s.operation='social.posts.search'
    WHERE g.usage_request_id=$1 ORDER BY g.created_at,g.id LIMIT 21`, [requestId])
  const { rows: calls } = await client.query(`SELECT c.id,c.usage_request_id,c.provider_key,c.operation,c.endpoint_key,c.contract_version,
    c.outcome,c.http_status,c.business_code,c.upstream_request_id,c.billed,c.item_count,c.started_at,c.completed_at
    FROM external_platform.provider_calls c WHERE c.usage_request_id=$1 OR c.id IN (
      SELECT provider_call_id FROM external_platform.gateway_requests WHERE usage_request_id=$1 AND provider_call_id IS NOT NULL
      ORDER BY created_at,id LIMIT 20
    ) ORDER BY c.started_at,c.id LIMIT 21`, [requestId])
  const evidence = []
  for (const call of calls.slice(0, 20)) {
    const reviewed = call.provider_key === 'tikhub' && call.operation === 'social.posts.search'
      && call.endpoint_key === ENDPOINT && call.contract_version === 'night-all.data-search.v1'
    let archive = null
    if (reviewed) {
      const { rows: [saved] } = await client.query(`SELECT body_size,body_sha256,
        CASE WHEN body_size<=8388608 AND octet_length(body_bytes)<=8388608 THEN body_bytes ELSE NULL END AS body_bytes
        FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1`, [call.id])
      archive = inspectRelevanceArchive(saved, expected, call)
    }
    evidence.push({ callId: uuid(call.id), ownerRequestId: uuid(call.usage_request_id), ownCall: call.usage_request_id === requestId,
      provider: choice(call.provider_key, ['tikhub', 'justone', 'rapidapi']),
      operation: choice(call.operation, ['social.posts.search', 'social.posts.resolve']), endpoint: choice(call.endpoint_key, [ENDPOINT]),
      outcome: choice(call.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
      httpStatus: integer(call.http_status), businessCode: integer(call.business_code), upstreamRequestId: uuid(call.upstream_request_id),
      billed: typeof call.billed === 'boolean' ? call.billed : null, itemCount: integer(call.item_count),
      startedAt: iso(call.started_at), completedAt: iso(call.completed_at), archive })
  }
  return { requestId, state: 'found', status: choice(request.status, ['reserved', 'committed', 'released', 'unknown']),
    responseStatus: integer(request.response_status), errorPresent: Boolean(request.error_code),
    reservedAt: iso(request.reserved_at), completedAt: iso(request.completed_at), responseCapturedAt: iso(request.response_captured_at),
    request: summarizeRelevanceRequest(request.acquisition_request, expected),
    delivery: request.delivery_bytes > MAX_BYTES ? { state: 'delivery_too_large' } : inspectRelevanceDelivery(request.response_body, expected),
    gateways: gateways.slice(0, 20).map(row => ({ sourceMode: choice(row.source_mode, ['live', 'fresh_cache', 'stored_fallback',
      'idempotent_replay', 'duplicate_suppressed', 'circuit_rejected', 'unavailable']), callId: uuid(row.provider_call_id), createdAt: iso(row.created_at),
      snapshotId: uuid(row.snapshot_id), currentSnapshot: row.current_snapshot_id ? {
        state: 'mutable_current_snapshot', capturedAt: iso(row.current_snapshot_captured_at), updatedAt: iso(row.current_snapshot_updated_at),
        lastSuccessCallId: uuid(row.current_last_success_call_id), historicalOriginConfirmed: false,
        captureMatchesDelivery: typeof row.snapshot_capture_matches_delivery === 'boolean' ? row.snapshot_capture_matches_delivery : null,
        notUpdatedAfterGateway: typeof row.snapshot_not_updated_after_gateway === 'boolean' ? row.snapshot_not_updated_after_gateway : null,
      } : { state: row.snapshot_id ? 'snapshot_missing_or_scope_mismatch' : 'no_snapshot_link' } })),
    gatewaysTruncated: gateways.length > 20, callsTruncated: calls.length > 20, evidence }
}

export async function diagnoseXiaohongshuRelevance(pool, lookupId) {
  const incident = CASES.find(entry => entry.id === lookupId)
  if (!incident) throw new Error('unsupported_incident_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: direct } = await client.query('SELECT id FROM public.usage_requests WHERE id=$1', [lookupId])
    let requestIds = direct.map(row => row.id), matchedBy = 'hub_request_id', lookupTruncated = false
    if (!requestIds.length) {
      const { rows } = await client.query(`SELECT DISTINCT c.usage_request_id AS id
        FROM external_platform.provider_calls c JOIN public.usage_requests u ON u.id=c.usage_request_id
        WHERE c.upstream_request_id=$1 AND c.provider_key='tikhub' AND c.operation='social.posts.search'
          AND c.endpoint_key='xiaohongshu.app-v2.search-notes.v1' AND u.platform='xiaohongshu'
        ORDER BY c.usage_request_id LIMIT 4`, [lookupId])
      requestIds = rows.slice(0, 3).map(row => row.id); lookupTruncated = rows.length > 3; matchedBy = 'provider_upstream_request_id'
    }
    const requests = []
    for (const requestId of requestIds) requests.push(await inspectRequest(client, requestId, incident.query))
    return { diagnosticRevision: 'xiaohongshu-relevance.v2', lookupId, expectedQuerySha256: hash(incident.query),
      matchedBy: requests.length ? matchedBy : null, lookupTruncated, requests,
      limits: { archiveBytes: MAX_BYTES, rows: MAX_ROWS, textCodeUnitsPerField: MAX_TEXT, calls: 20, gateways: 20, linkedRequests: 3 },
      interpretation: 'Literal entity absence is not proof of irrelevance; no inference about image/video text, provider ranking or full-text completeness. Missing echo is not proof of a wrong keyword. Current snapshot pointers are mutable, not confirmed historical origins, and are never followed to archives. Unmatched IDs may belong to historical connectors not inspected here.' }
  } catch { throw new Error('diagnostic_read_failed') }
  finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('diagnostic_read_failed')
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const requested = process.argv.slice(2)
    if (requested.some(id => !CASES.some(entry => entry.id === id)) || new Set(requested).size !== requested.length) {
      throw new Error('unsupported_incident_id')
    }
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    for (const id of requested.length ? requested : CASES.map(entry => entry.id)) {
      console.log(JSON.stringify(await diagnoseXiaohongshuRelevance(pool, id)))
    }
  } catch (error) {
    console.error(JSON.stringify({ error: ['unsupported_incident_id', 'database_url_required'].includes(error.message)
      ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
