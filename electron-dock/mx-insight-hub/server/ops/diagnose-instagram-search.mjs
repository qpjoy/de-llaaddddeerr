import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { projectInstagramSearch, INSTAGRAM_SEARCH_KEY } from '../contracts/instagram-search.mjs'
import { NATIVE_FORWARDING_VERSION, nativeForwardingEndpoint } from '../contracts/native-forwarding.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ROUTES = new Set(['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw'])
const REASONS = new Set(['invalid_instagram_search_shape', 'invalid_instagram_media_grid',
  'invalid_instagram_post_identity', 'instagram_page_exceeds_requested_count', 'invalid_instagram_continuation',
  'invalid_instagram_pagination', 'missing_instagram_continuation'])
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const count = value => Array.isArray(value) ? value.length : null
const paginationFlag = value => value == null ? kind(value)
  : [true, false, 0, 1, '0', '1', 'true', 'false'].includes(value) ? value : 'invalid'
const continuation = value => ({ type: kind(value), length: typeof value === 'string' ? value.length : null })
const pagination = value => ({ nextMaxId: continuation(value?.next_max_id), rankToken: continuation(value?.rank_token),
  moreAvailable: paginationFlag(value?.more_available), hasMore: paginationFlag(value?.has_more),
  hasNextPage: paginationFlag(value?.has_next_page) })
const listFields = value => Object.fromEntries(['position', 'id', 'pk', 'code', 'shortcode', 'user',
  'username', 'full_name', 'media', 'caption', 'media_type', 'hashtag', 'place'].map(key => [key, kind(value?.[key])]))

// Only fixed field names, types and counts leave restricted storage. Never emit
// query/body/cursor values, arbitrary upstream keys or exception messages.
export function inspectInstagramArchive(archive, snapshot) {
  if (!archive) return { state: 'archive_missing' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) {
    return { state: 'archive_integrity_failed' }
  }
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) }
  catch { return { state: 'archive_not_json' } }
  const root = payload?.data
  const data = object(root?.data) ? root.data : root
  const grid = data?.media_grid || data?.mediaGrid
  const sections = grid?.sections
  const sectionShapes = Array.isArray(sections) ? sections.slice(0, 20).map((section, index) => {
    const layout = section?.layout_content || section?.layoutContent
    return { index, section: kind(section), layout: kind(layout), medias: kind(layout?.medias),
      mediasCount: count(layout?.medias), media: kind(layout?.media), mediaCount: count(layout?.media) }
  }) : []
  const shape = {
    data: kind(root), nestedData: kind(root?.data), parsedData: kind(data),
    status: data?.status === 'ok' ? 'ok' : data?.status == null ? kind(data?.status) : 'other',
    mediaGrid: kind(grid), sections: kind(sections), sectionCount: count(sections), sectionShapes,
    sectionsTruncated: Array.isArray(sections) && sections.length > 20,
    items: kind(data?.items), itemCount: count(data?.items),
    list: kind(data?.list), listCount: count(data?.list), users: kind(data?.users),
    listEntries: Array.isArray(data?.list) ? data.list.slice(0, 20).map((entry, index) => ({ index,
      fields: listFields(entry), user: listFields(entry?.user), media: listFields(entry?.media) })) : [],
    listEntriesTruncated: Array.isArray(data?.list) && data.list.length > 20,
    hashtags: kind(data?.hashtags), places: kind(data?.places),
    keywords: kind(data?.other_results?.keyword_recommendations?.keywords),
    keywordCount: count(data?.other_results?.keyword_recommendations?.keywords),
    pagination: pagination(data), gridPagination: pagination(grid),
  }
  if (payload?.code !== 200) return { state: 'not_success_envelope', shape }
  const body = snapshot?.body
  if (!ROUTES.has(snapshot?.path) || body?.platform !== 'instagram' || body.cursor || (body.page ?? 1) !== 1) {
    return { state: 'replay_requires_original_first_page_request', shape }
  }
  const pageSize = Number(snapshot.path === '/api/v1/data/search'
    ? body.pageSize ?? 20 : body.count ?? body.pageSize ?? body.limit ?? 20)
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100) return { state: 'invalid_saved_page_size', shape }
  const timestamp = new Date(archive.captured_at)
  if (!Number.isFinite(timestamp.getTime())) return { state: 'invalid_archive_timestamp', shape }
  const capturedAt = timestamp.toISOString()
  const request = { query: '', page: 1, pageSize, encodeNext: () => 'offline-not-a-cursor' }
  // Independently inspect identities even if the full page fails another guard.
  const values = Array.isArray(sections) ? sections.flatMap(section => {
    const layout = section?.layout_content || section?.layoutContent
    const entries = layout?.medias || layout?.media || []
    return Array.isArray(entries) ? entries.map(entry => entry?.media || entry) : []
  }) : Array.isArray(data?.items) ? data.items.map(entry => entry?.media || entry)
    : grid == null && data?.items == null && Array.isArray(data?.list) ? data.list.flatMap(entry =>
      object(entry?.media) ? [entry.media] : entry?.code || entry?.shortcode ? [entry] : []) : []
  const invalidRows = [], identities = new Set()
  let invalidRowCount = 0
  for (const [index, value] of values.entries()) {
    try {
      const one = projectInstagramSearch({ publicBody: { data: { items: [value] }, meta: { capturedAt } } }, request)
      identities.add(one.items[0].content_id)
    } catch (error) {
      invalidRowCount += 1
      if (invalidRows.length < 20) invalidRows.push({ index,
        reason: REASONS.has(error.message) ? error.message : 'unexpected_projection_error',
        fields: { row: kind(value), id: kind(value?.id), pk: kind(value?.pk),
          code: kind(value?.code), shortcode: kind(value?.shortcode) },
        unsafeNumericId: [value?.id, value?.pk].some(id => typeof id === 'number' && !Number.isSafeInteger(id)) })
    }
  }
  const rows = { resultCount: values.length, uniqueValidIdentityCount: identities.size, invalidRowCount,
    invalidRowIndexes: invalidRows.map(row => row.index), invalidRows, invalidRowsTruncated: invalidRowCount > 20 }
  try {
    const result = projectInstagramSearch({ publicBody: { data: payload.data, meta: { capturedAt } } }, request)
    return { state: 'current_projection_accepts', pageSize, shape, ...rows,
      returnedCount: result.items.length, hasMore: result.publicBody.data.page.hasMore }
  } catch (error) {
    return { state: 'current_projection_rejects', pageSize, shape, ...rows,
      reason: REASONS.has(error.message) ? error.message : 'unexpected_projection_error' }
  }
}

export async function diagnoseInstagramSearch(pool, requestId, { blockedUntil = null, cooldownMs = 15 * 60_000 } = {}) {
  if (!UUID.test(requestId)) throw new Error('invalid_request_id')
  if (!Number.isSafeInteger(cooldownMs) || cooldownMs <= 0) throw new Error('invalid_cooldown')
  if (blockedUntil !== null && !Number.isFinite(Date.parse(blockedUntil))) throw new Error('invalid_blocked_until')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const { rows: [request] } = await client.query(`SELECT id, platform, status, error_code, reserved_at, completed_at,
      acquisition_request->>'path' AS path FROM public.usage_requests WHERE id = $1`, [requestId])
    if (!request || request.platform !== 'instagram') throw new Error('instagram_request_not_found')
    const endpoint = nativeForwardingEndpoint(INSTAGRAM_SEARCH_KEY)
    // Contract quarantine is endpoint-wide, including calls from other consumers.
    // These are candidates, not proven causal links: older releases did not save
    // the blocker call ID on the suppressed delivery.
    const { rows: calls } = await client.query(`SELECT p.id, p.usage_request_id, p.outcome,
      p.http_status, p.business_code, p.error_code, p.completed_at, p.upstream_request_id,
      p.billed, u.acquisition_request
      FROM external_platform.provider_calls p
      JOIN public.usage_requests u ON u.id = p.usage_request_id
      WHERE p.provider_key = 'tikhub' AND p.operation = $2 AND p.endpoint_key = $2
        AND p.contract_version = $3 AND (p.usage_request_id = $1 OR (
          p.outcome = 'succeeded_unusable' AND p.error_code IS DISTINCT FROM 'upstream_note_unavailable'
          AND p.completed_at <= $4::timestamptz
          AND p.completed_at > $4::timestamptz - make_interval(secs => $5)))
      ORDER BY p.started_at DESC LIMIT 11`, [requestId, endpoint.operation, NATIVE_FORWARDING_VERSION,
      request.completed_at || request.reserved_at, cooldownMs / 1000])
    const evidence = []
    for (const call of calls.slice(0, 10)) {
      const { rows: [archive] } = await client.query(`SELECT body_bytes, body_sha256, captured_at
        FROM control.external_platform_restricted_raw_responses
        WHERE provider_call_id = $1 AND body_size <= 8388608`, [call.id])
      evidence.push({ callId: call.id, requestId: call.usage_request_id,
        relation: call.usage_request_id === requestId ? 'same_request' : 'endpoint_quarantine_candidate',
        matchesReportedDeadline: blockedUntil === null ? null
          : new Date(call.completed_at).getTime() + cooldownMs === Date.parse(blockedUntil),
        completedAt: call.completed_at, outcome: call.outcome,
        httpStatus: call.http_status, businessCode: call.business_code, billed: call.billed,
        storedErrorCode: REASONS.has(call.error_code) || call.error_code === 'invalid_instagram_search_contract'
          ? call.error_code : 'other_or_missing',
        upstreamRequestId: UUID.test(call.upstream_request_id || '') ? call.upstream_request_id : null,
        projection: inspectInstagramArchive(archive, call.acquisition_request) })
    }
    await client.query('COMMIT')
    return { requestId, status: request.status, path: ROUTES.has(request.path) ? request.path : 'other_or_missing',
      requestedAt: request.reserved_at, completedAt: request.completed_at, cooldownMs,
      blockedUntil, candidatesTruncated: calls.length > 10, evidence }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, flag, blockedUntil, extra] = process.argv.slice(2)
    if (!requestId || (flag && (flag !== '--blocked-until' || !blockedUntil)) || extra) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
    const report = await diagnoseInstagramSearch(pool, requestId, { blockedUntil: blockedUntil || null,
      cooldownMs: Number(process.env.MX_INSIGHT_TIKHUB_UNKNOWN_FINGERPRINT_COOLDOWN_MS || 900000) })
    console.log(JSON.stringify(report, null, 2))
  } catch (error) {
    // Never echo connection strings, SQL, provider values or stacks in failures.
    const known = new Set(['invalid_arguments', 'database_url_required', 'invalid_request_id', 'invalid_cooldown',
      'invalid_blocked_until', 'instagram_request_not_found'])
    console.error(JSON.stringify({ error: known.has(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
