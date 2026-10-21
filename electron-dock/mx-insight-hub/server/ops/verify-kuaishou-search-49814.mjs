import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { TikHubAdapter } from '../adapters/tikhub.mjs'
import { normalizeTikHubContentSearchRequest, contentSearchDataItem, kuaishouRelatedSearchesCardCoverage } from '../contracts/tikhub-content-search.mjs'
import { isPostgresSafeJsonValue } from '../core/postgres-json.mjs'
import { projectContentPage } from '../external-platforms/content-search-workflow.mjs'

export const KUAISHOU_VERIFICATION_SOURCE = Object.freeze({
  requestId: '49814f8b-0297-4d53-ac45-ef187784d8ab', callId: '96762ff5-1e1a-4579-a052-1d2b44a804fe',
  bodySize: 207474, bodySha256: '43d5d1899e62b528b3549b1b42f5a9413580f571f1f7091bc30a5ac603b72d06',
  operation: 'native.t.kuaishou_app_search_comprehensive', endpointKey: 'native.t.kuaishou_app_search_comprehensive',
  endpointVersion: 'night-all-source-snapshot.2026-09-26', contractVersion: 'mx-insight-hub.native-forwarding.v1',
})
const BUILD = typeof __KUAISHOU_VERIFICATION_BUILD__ === 'object' ? __KUAISHOU_VERIFICATION_BUILD__ : { implementation: 'installed_candidate' }
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(code), { verificationCode: code })
const reasons = new Set(['invalid_content_search_shape', 'invalid_content_search_entry', 'invalid_content_search_identity',
  'invalid_content_search_pagination', 'missing_content_search_continuation', 'invalid_content_search_capture_time',
  'invalid_content_search_projection', 'content_search_page_too_large', 'upstream_payload_unrepresentable',
  'invalid_upstream_contract', 'invalid_upstream_json', 'invalid_upstream_encoding', 'invalid_upstream_content_type'])
const safeReason = error => reasons.has(error?.evidence?.errorCode) ? error.evidence.errorCode
  : reasons.has(error?.message) ? error.message : 'candidate_rejected'
const fieldSafe = record => Object.entries(record).every(([name, value]) => isPostgresSafeJsonValue(
  ['eventTime', 'collectedAt', 'editedAt', 'deletedAt'].includes(name) && value instanceof Date ? value.toISOString() : value,
))

export function isPinnedKuaishouSource(row) {
  const pin = KUAISHOU_VERIFICATION_SOURCE
  return row?.request_id === pin.requestId && row.call_id === pin.callId && row.usage_request_id === pin.requestId
    && row.platform === 'kuaishou' && row.provider_key === 'tikhub'
    && row.operation === pin.operation && row.endpoint_key === pin.endpointKey
    && row.endpoint_version === pin.endpointVersion && row.contract_version === pin.contractVersion
    && row.status === 'committed' && row.response_status === 502 && row.outcome === 'succeeded_unusable'
    && row.http_status === 200 && row.business_code === 200 && row.billed === true
    && row.body_size === pin.bodySize && row.body_sha256 === pin.bodySha256
    && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => typeof row[key] === 'string' && row[key] === row[`call_${key}`])
    && row.acquisition_request?.path === '/api/v1/data/search' && row.acquisition_request.body?.platform === 'kuaishou'
    && !row.acquisition_request.body.cursor
}

// This pure replay uses an in-memory response, never a supplier transport or
// production credential. The live workflow's projection guard is reused intact.
export async function inspectKuaishouCandidate({ bodyBytes, capturedAt, acquisitionRequest }) {
  let syntheticAdapterInvocations = 0, stage = 'decode_archive'
  const report = { mode: 'offline_original_bytes_replay', upstreamCallCount: 0,
    credentialValidation: 'synthetic_placeholder_only' }
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes).replace(/^\uFEFF/u, ''))
    report.fullRawPostgresSafe = isPostgresSafeJsonValue(payload)
    const cards = Array.isArray(payload?.data?.mixFeeds) ? payload.data.mixFeeds.filter(entry => entry?.itemType === 9) : []
    report.relatedSearchCards = cards.slice(0, 3).map(kuaishouRelatedSearchesCardCoverage)
    report.relatedSearchCardCount = cards.length
    report.relatedSearchCoverageTruncated = cards.length > 3
    const body = acquisitionRequest?.body || {}
    stage = 'normalize_saved_request'
    const request = normalizeTikHubContentSearchRequest({ platform: 'kuaishou', query: body.query,
      pageSize: body.pageSize ?? 20, params: body.params || {}, page: body.page ?? 1 })
    const adapter = new TikHubAdapter({ apiKey: 'offline-verification-placeholder-credential', fetchImpl: async () => {
      syntheticAdapterInvocations++
      return new Response(bodyBytes, { status: 200, headers: { 'content-type': 'application/json' } })
    } })
    stage = 'adapter'
    const result = await adapter.forwardNative('t.kuaishou_app_search_comprehensive', { params: request.upstreamQuery },
      { capturedAt, contentSearchProjection: true })
    report.adapterCandidate = { state: 'candidate_accepts' }
    const receipt = result.restrictedResponseArchive
    report.candidateArchive = { bodySize: receipt?.bodySize ?? null,
      originalByteHashMatches: receipt?.bodySha256 === sha(bodyBytes) && receipt?.bodySize === bodyBytes.length,
      originalBytesMatch: receipt?.bodyBytes instanceof Uint8Array && Buffer.from(receipt.bodyBytes).equals(Buffer.from(bodyBytes)),
      parsedPayloadState: receipt?.parsedPayload === null ? 'null' : receipt?.parsedPayload ? 'present' : 'missing' }
    stage = 'projection'
    const { projected, records } = projectContentPage(result, request)
    const modern = projected.acquiredItems.map(contentSearchDataItem)
    report.projection = { state: 'candidate_accepts', acquiredCount: projected.acquiredItems.length,
      nonPostCount: projected.nonPostCount, duplicateCount: projected.duplicateCount,
      uniqueIdentityCount: new Set(projected.acquiredItems.map(row => row.content_id)).size,
      hasMore: projected.providerPage.hasMore,
      postgresSafe: { rows: isPostgresSafeJsonValue(projected.acquiredItems), modern: isPostgresSafeJsonValue(modern),
        providerPage: isPostgresSafeJsonValue(projected.providerPage), ingestFields: records.every(fieldSafe) },
      ingestRecordCount: records.length }
    return { ...report, syntheticAdapterInvocations }
  } catch (error) {
    return { ...report, syntheticAdapterInvocations,
      ...(stage === 'adapter' ? { adapterCandidate: { state: 'candidate_rejects', reason: safeReason(error) } } : {}),
      projection: { state: 'candidate_rejects', stage, reason: safeReason(error) } }
  }
}

const sourceQuery = `SELECT request.id AS request_id,request.tenant_id,request.consumer_id,request.api_key_id,
  request.platform,request.status,request.response_status,request.acquisition_request,
  call.id AS call_id,call.usage_request_id,call.tenant_id AS call_tenant_id,call.consumer_id AS call_consumer_id,
  call.api_key_id AS call_api_key_id,call.provider_key,call.operation,call.endpoint_key,call.endpoint_version,
  call.contract_version,call.outcome,call.http_status,call.business_code,call.billed,
  raw.body_bytes,raw.body_size,raw.body_sha256,raw.captured_at,raw.parsed_payload IS NULL AS parsed_payload_is_null,
  (SELECT count(*)::int FROM external_platform.response_archives WHERE provider_call_id=call.id) AS response_archives,
  (SELECT count(*)::int FROM external_platform.archive_objects WHERE provider_call_id=call.id) AS archive_objects,
  (EXISTS(SELECT 1 FROM mxq.jobs WHERE queue='mx-insight-hub:ingest' AND dedupe_key='external-platform:tikhub:'||call.id::text)
    -- Done jobs are deleted after 14 days; an ingest run for the call proves the job ran.
    OR EXISTS(SELECT 1 FROM ingest.ingest_runs WHERE external_platform_call_id=call.id)) AS ingest_job
  FROM public.usage_requests request JOIN external_platform.provider_calls call ON call.usage_request_id=request.id
  JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id=call.id
  WHERE request.id=$1 AND call.id=$2 AND raw.body_size=$3 LIMIT 1`
const historical = row => ({ status: row.status, responseStatus: row.response_status, outcome: row.outcome,
  httpStatus: row.http_status, businessCode: row.business_code, billed: row.billed,
  responseArchives: row.response_archives, archiveObjects: row.archive_objects, ingestJob: row.ingest_job })
export async function verifySavedKuaishouSearch(pool) {
  const pin = KUAISHOU_VERIFICATION_SOURCE, args = [pin.requestId, pin.callId, pin.bodySize]
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='8s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    const { rows } = await client.query(sourceQuery, args)
    const row = rows[0]
    if (rows.length !== 1 || !isPinnedKuaishouSource(row)) throw fail('source_identity_mismatch')
    if (!(row.body_bytes instanceof Uint8Array) || row.body_bytes.length !== pin.bodySize || sha(row.body_bytes) !== pin.bodySha256) throw fail('archive_integrity_failed')
    if (row.captured_at == null || !Number.isFinite(new Date(row.captured_at).getTime())) throw fail('invalid_capture_time')
    const capturedAt = new Date(row.captured_at).toISOString()
    const before = historical(row)
    const candidate = await inspectKuaishouCandidate({ bodyBytes: row.body_bytes, capturedAt, acquisitionRequest: row.acquisition_request })
    const after = (await client.query(sourceQuery, args)).rows[0]
    if (!isPinnedKuaishouSource(after) || JSON.stringify(before) !== JSON.stringify(historical(after))) throw fail('historical_snapshot_changed')
    await client.query('ROLLBACK')
    return { verificationRevision: 'kuaishou-search-49814-verification.v1', ...BUILD,
      requestId: pin.requestId, callId: pin.callId, readOnlyTransaction: true,
      archive: { hashVerified: true, bodySize: pin.bodySize, bodySha256: pin.bodySha256,
        parsedPayloadState: row.parsed_payload_is_null === true ? 'null' : 'present' },
      historical: { ...before, unchangedWithinReadOnlySnapshot: true }, candidate }
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}

export function kuaishouVerificationFailure(error) {
  return { error: 'kuaishou_verification_failed', reason: ['source_identity_mismatch', 'archive_integrity_failed',
    'historical_snapshot_changed', 'invalid_verification_arguments', 'invalid_capture_time', 'database_url_required'].includes(error?.verificationCode) ? error.verificationCode : 'read_or_verification_failed',
    sqlState: typeof error?.code === 'string' && /^[0-9A-Z]{5}$/u.test(error.code) ? error.code : null }
}
if (process.argv[1] && (process.argv[1] === '-' || import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length > 1 || args.length === 1 && args[0] !== KUAISHOU_VERIFICATION_SOURCE.requestId) throw fail('invalid_verification_arguments')
    if (!process.env.DATABASE_URL) throw fail('database_url_required')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
    console.log(JSON.stringify(await verifySavedKuaishouSearch(pool), null, 2))
  } catch (error) { console.error(JSON.stringify(kuaishouVerificationFailure(error))); process.exitCode = 1 }
  finally { await pool?.end() }
}
