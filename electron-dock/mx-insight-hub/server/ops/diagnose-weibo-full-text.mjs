import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import pg from 'pg'
import { weiboRow, weiboText, isWeiboPreview, mergeWeiboDetail,
  WEIBO_SEARCH_KEY, WEIBO_DETAIL_KEY } from '../contracts/raw-search.mjs'
import { NATIVE_FORWARDING_VERSION } from '../contracts/native-forwarding.mjs'
import * as weiboContracts from '../contracts/raw-search.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SEARCH = `native.${WEIBO_SEARCH_KEY}`, DETAIL = `native.${WEIBO_DETAIL_KEY}`
const ROUTES = new Set(['/api/v1/data/search', '/api/v1/search/raw', '/api/v1/night-all/search/raw'])
const OUTCOMES = new Set(['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown'])
const ERRORS = new Set(['upstream_rate_limited', 'upstream_authentication_failed', 'upstream_rejected',
  'upstream_deadline_exceeded', 'upstream_transport_error', 'invalid_upstream_json', 'invalid_upstream_contract',
  'invalid_upstream_content_type', 'upstream_payload_unrepresentable', 'upstream_identity_mismatch',
  'upstream_note_unavailable', 'raw_search_detail_unknown'])
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const detailFingerprint = id => createHash('sha256').update(JSON.stringify({ version: 'weibo-full-text.v1', id })).digest('hex')

// Opt-in, bounded content comparison for an operator investigating a mismatch.
// These are excerpts of two post fields, never arbitrary response keys or HTML.
function compareText(prefix, value) {
  const normalized = weiboText(value).replace(/[\s\u200b\ufeff]/gu, '')
  const expected = Array.from(prefix), actual = Array.from(normalized)
  let shared = 0
  while (shared < expected.length && shared < actual.length && expected[shared] === actual[shared]) shared++
  const start = Math.max(0, shared - 16), end = shared + 48
  const codePoint = char => char ? `U+${char.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` : null
  return { prefixMatches: normalized.startsWith(prefix), commonPrefixCodePoints: shared,
    previewCodePoint: codePoint(expected[shared]), detailCodePoint: codePoint(actual[shared]),
    previewExcerpt: expected.slice(start, end).join(''), detailExcerpt: actual.slice(start, end).join('') }
}

function decodeArchive(archive) {
  if (!archive) return { state: 'archive_missing' }
  if (archive.body_size > 8388608) return { state: 'archive_too_large' }
  const bytes = archive.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) return { state: 'archive_integrity_failed' }
  let payload
  try { payload = JSON.parse(bytes.toString('utf8')) } catch { return { state: 'archive_not_json' } }
  if (payload?.code !== 200) return { state: 'not_success_envelope' }
  return { state: 'verified', payload, capturedAt: new Date(archive.captured_at).toISOString() }
}

// By default only fixed reason codes, numeric post IDs, types and lengths leave.
// Run the deployed merge implementation on a clone; never mutate source evidence.
export function inspectWeiboFullText(row, archive, { textDiff = false } = {}) {
  const decoded = decodeArchive(archive)
  if (decoded.state !== 'verified') return { state: decoded.state }
  const raw = decoded.payload.data
  const full = weiboText(raw?.longText?.content || raw?.text_raw)
  const facts = {
    fields: { data: kind(raw), idstr: kind(raw?.idstr), id: kind(raw?.id),
      longText: kind(raw?.longText), longTextContent: kind(raw?.longText?.content),
      textRaw: kind(raw?.text_raw), text: kind(raw?.text) },
    isLongText: typeof raw?.isLongText === 'boolean' ? raw.isLongText : null,
    previewLength: row.text.length, fullTextLength: full.length,
    detailTextLength: weiboText(raw?.text).length,
    fullTextStillPreview: isWeiboPreview(full),
  }
  let detail
  try { detail = weiboRow(raw, decoded.capturedAt) }
  catch { return { state: 'current_merge_rejects', reasons: ['invalid_detail_identity'], ...facts } }
  const prefix = row.text.replace(/(?:展开(?:全文)?\s*[cＣ]?|…|\.{3})[\s\u200b\ufeff]*$/iu, '')
    .trim().replace(/[\s\u200b\ufeff]/gu, '')
  // This script can also be piped into an older Pod before the API is deployed.
  const prefixMatches = weiboContracts.weiboTextPrefixMatches
    ? weiboContracts.weiboTextPrefixMatches(row.text, full)
    : full.replace(/[\s\u200b\ufeff]/gu, '').startsWith(prefix)
  facts.prefixComparison = { policy: weiboContracts.weiboTextPrefixMatches
    ? weiboContracts.WEIBO_TEXT_COMPARISON_POLICY || 'weibo_display_v1' : 'strict', matches: prefixMatches }
  if (weiboContracts.validateWeiboDetail) {
    facts.mergePolicy = weiboContracts.WEIBO_DETAIL_POLICY
    facts.prefixComparison.blocking = false
    facts.fullTextLonger = full.length > row.text.length
  }
  if (textDiff) facts.textComparison = {
    fullText: compareText(prefix, raw?.longText?.content || raw?.text_raw),
    renderedText: compareText(prefix, raw?.text),
  }
  const reasons = []
  if (detail.content_id !== row.content_id) reasons.push('post_id_mismatch')
  if (row.author_id && detail.author_id !== row.author_id) reasons.push('author_id_mismatch')
  if (!full) reasons.push('full_text_missing')
  else {
    if (full.length <= row.text.length) reasons.push('full_text_not_longer')
    if (isWeiboPreview(full)) reasons.push('full_text_still_preview')
    if (!prefixMatches) reasons.push('prefix_mismatch')
  }
  const accepted = mergeWeiboDetail(structuredClone(row), { publicBody: { data: raw, meta: { capturedAt: decoded.capturedAt } } })
  const currentReasons = weiboContracts.validateWeiboDetail?.(row,
    { publicBody: { data: raw, meta: { capturedAt: decoded.capturedAt } } }).reasons || reasons
  if (weiboContracts.validateWeiboDetail) facts.fullTextStillPreview = currentReasons.includes('full_text_still_preview')
  return { state: accepted ? 'current_merge_accepts' : 'current_merge_rejects',
    reasons: accepted ? [] : currentReasons.length ? currentReasons : ['other_merge_rule'], returnedPostId: detail.content_id, ...facts }
}

export async function diagnoseWeiboFullText(pool, requestId, { textDiff = false } = {}) {
  if (!UUID.test(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const { rows: [request] } = await client.query(`SELECT id, platform, status, reserved_at, completed_at,
      acquisition_request->>'path' AS path, response_body #>> '{data,status}' AS response_status
      FROM public.usage_requests WHERE id = $1`, [requestId])
    if (!request || request.platform !== 'weibo') throw new Error('weibo_request_not_found')
    const { rows: calls } = await client.query(`SELECT id, operation, call_ordinal, dispatch_fingerprint,
      outcome, http_status, business_code, error_code, billed, upstream_request_id, completed_at
      FROM external_platform.provider_calls
      WHERE usage_request_id = $1 AND provider_key = 'tikhub'
        AND operation IN ($2, $3) AND endpoint_key = operation AND contract_version = $4
      ORDER BY call_ordinal LIMIT 102`, [requestId, SEARCH, DETAIL, NATIVE_FORWARDING_VERSION])
    const readArchive = async callId => (await client.query(`SELECT body_size, body_sha256, captured_at,
      CASE WHEN body_size <= 8388608 THEN body_bytes END AS body_bytes
      FROM control.external_platform_restricted_raw_responses WHERE provider_call_id = $1`, [callId])).rows[0]
    const searchCalls = calls.filter(call => call.operation === SEARCH)
    const candidates = [], invalidRowIndexes = []
    let search = { state: searchCalls.length ? 'multiple_search_calls' : 'search_call_missing' }
    if (searchCalls.length === 1) {
      const decoded = decodeArchive(await readArchive(searchCalls[0].id))
      search = { callId: searchCalls[0].id, state: decoded.state }
      if (decoded.state === 'verified') {
        const results = decoded.payload.data?.parsed_data?.results
        search.state = Array.isArray(results) && results.length <= 100 ? 'verified' : 'invalid_search_results'
        if (search.state === 'verified') {
          search.resultCount = results.length
          for (const [rowIndex, value] of results.entries()) {
            try {
              const row = weiboRow(value, decoded.capturedAt)
              candidates.push({ rowIndex, row, fingerprint: detailFingerprint(row.content_id), detailCallIds: [] })
            } catch { invalidRowIndexes.push(rowIndex) }
          }
          search.invalidRowIndexes = invalidRowIndexes
        }
      }
    }
    const details = []
    for (const call of calls.slice(0, 101).filter(call => call.operation === DETAIL)) {
      const matched = candidates.filter(candidate => candidate.fingerprint === call.dispatch_fingerprint)
      for (const candidate of matched) candidate.detailCallIds.push(call.id)
      const evidence = { callId: call.id, ordinal: call.call_ordinal,
        outcome: OUTCOMES.has(call.outcome) ? call.outcome : 'other',
        httpStatus: call.http_status, businessCode: call.business_code, billed: call.billed,
        errorCode: call.error_code == null ? null : ERRORS.has(call.error_code) ? call.error_code : 'other_error',
        upstreamRequestId: UUID.test(call.upstream_request_id || '') ? call.upstream_request_id : null,
        completedAt: call.completed_at, matchedPostIds: [...new Set(matched.map(candidate => candidate.row.content_id))] }
      if (call.outcome !== 'succeeded') evidence.validation = { state: 'detail_call_not_successful' }
      else if (!matched.length) evidence.validation = { state: 'search_row_not_correlated' }
      else {
        const archive = await readArchive(call.id)
        evidence.validation = matched.map(candidate => ({ rowIndex: candidate.rowIndex,
          ...inspectWeiboFullText(candidate.row, archive, { textDiff }) }))
      }
      details.push(evidence)
    }
    await client.query('COMMIT')
    return { requestId, requestStatus: request.status,
      responseStatus: ['ok', 'partial'].includes(request.response_status) ? request.response_status : 'other_or_missing',
      path: ROUTES.has(request.path) ? request.path : 'other_or_missing', completedAt: request.completed_at,
      callsTruncated: calls.length > 101, search,
      previews: candidates.filter(candidate => candidate.row.body_completeness === 'provider_preview').map(candidate => ({
        rowIndex: candidate.rowIndex, postId: candidate.row.content_id, searchTextLength: candidate.row.text.length,
        detailCallIds: candidate.detailCallIds,
        detailEvidence: candidate.detailCallIds.length ? 'call_recorded'
          : calls.length > 101 ? 'calls_truncated' : 'no_correlated_call_recorded',
      })), details }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally { client.release() }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, flag, extra] = process.argv.slice(2)
    if (!requestId || (flag && flag !== '--text-diff') || extra) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000 })
    console.log(JSON.stringify(await diagnoseWeiboFullText(pool, requestId, { textDiff: flag === '--text-diff' }), null, 2))
  } catch (error) {
    const known = new Set(['invalid_arguments', 'invalid_request_id', 'database_url_required', 'weibo_request_not_found'])
    console.error(JSON.stringify({ error: known.has(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
