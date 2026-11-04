// Run in the Hub source tree with its normal DATABASE_URL and installed dependencies:
// node server/ops/diagnose-weibo-account.mjs REQUEST_UUID
// Or, from a checkout on Internal, use the existing Pod's contracts without a rollout:
// kubectl -n mx-insight-hub exec -i deployment/mx-insight-hub-admin -c admin -- sh -c 'cd /app/server/ops && exec node --input-type=module - "$1"' sh REQUEST_UUID < server/ops/diagnose-weibo-account.mjs
import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { normalizeHubSocialCompatRequest, buildHubSocialCompatDispatch, projectHubSocialCompatResponse } from '../contracts/hub-social-compat.mjs'
import * as workflow from '../external-platforms/social-account-workflow.mjs'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const MAX_BYTES = 8 * 1024 * 1024
const STAGES = new Map([
  ['native.t.api_e43a6f70154fa0ee', 'profile'],
  ['native.t.api_030d62ecb55232dc', 'posts'],
  ['native.t.api_f1a9d61336f0cd57', 'original_posts'],
])
const REASONS = new Map([
  ['Account response contains no recognized collection', 'unrecognized_collection'],
  ['Account item is not an object', 'non_object_row'],
  ['Account identity was not represented losslessly', 'unsafe_numeric_identity'],
  ['Account content has no stable upstream identity', 'missing_content_identity'],
  ['Account profile has no stable identity', 'missing_profile_identity'],
  ['Account profile identity does not match the requested account', 'profile_identity_mismatch'],
  ['Account profile username does not match the requested account', 'profile_username_mismatch'],
  ['Account profile identity is invalid', 'invalid_profile_identity'],
  ['Account content identity is invalid', 'invalid_content_identity'],
  ['Account row is unavailable', 'unusable_row'],
  ['invalid_social_projection', 'invalid_social_projection'],
  ['Invalid upstream continuation token', 'invalid_continuation_token'],
  ['Invalid upstream continuation flag', 'invalid_continuation_flag'],
  ['Conflicting upstream continuation flags', 'conflicting_continuation_flags'],
  ['Upstream announced more rows with a terminal continuation token', 'contradictory_end'],
  ['Upstream announced more rows without a continuation token', 'missing_continuation'],
])

// Describe reviewed paths only. Neither scalar values nor dynamic JSON keys may
// leave the archive boundary, including credentials echoed by an upstream.
function structure(payload) {
  const result = []
  let node = payload
  for (let depth = 0; depth <= 4 && node != null; depth++, node = node.data) {
    const kind = Array.isArray(node) ? 'array' : typeof node
    const shape = { depth, kind, collections: {} }
    for (const key of ['list', 'statuses', 'cards', 'items']) {
      const rows = node[key]
      if (!Array.isArray(rows)) continue
      let nonObjects = 0, wrappedPosts = 0, unsafeIds = 0, stringIds = 0, unsafeWithStringId = 0
      for (const row of rows) {
        if (!row || typeof row !== 'object' || Array.isArray(row)) { nonObjects++; continue }
        if (row.mblog && typeof row.mblog === 'object') wrappedPosts++
        const item = row.mblog || row.node || row
        const unsafe = ['id', 'mid', 'idstr'].some(k => typeof item[k] === 'number' && !Number.isSafeInteger(item[k]))
        const hasStringId = ['id', 'mid', 'idstr'].some(k => typeof item[k] === 'string' && item[k].length > 0)
        unsafeIds += Number(unsafe)
        stringIds += Number(hasStringId)
        unsafeWithStringId += Number(unsafe && hasStringId)
      }
      shape.collections[key] = { count: rows.length, nonObjects, wrappedPosts, unsafeIds, stringIds, unsafeWithStringId }
    }
    if (kind === 'array') shape.count = node.length
    result.push(shape)
  }
  return result
}

function decodeArchive(row) {
  if (!row) return { state: 'missing' }
  if (row.body_size > MAX_BYTES) return { state: 'too_large' }
  const bytes = row.body_bytes
  if (!(bytes instanceof Uint8Array) || bytes.length !== row.body_size
    || createHash('sha256').update(bytes).digest('hex') !== row.body_sha256?.trim()) return { state: 'integrity_failed' }
  try { return { state: 'verified', payload: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } }
  catch { return { state: 'invalid_utf8_or_json' } }
}

export async function diagnoseWeiboAccount(pool, requestId) {
  if (!UUID.test(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout='20s'")
    const { rows: [request] } = await client.query(`SELECT /* weibo-account:target */ platform, acquisition_request
      FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
    if (!request) return { state: 'request_not_found' }
    const snapshot = request.acquisition_request
    if (request.platform !== 'weibo' || snapshot?.path !== '/api/v1/data/social/crawl' || snapshot.method !== 'POST') return { state: 'not_weibo_account_crawl' }

    let normalized
    try { normalized = normalizeHubSocialCompatRequest('crawl', snapshot.body) }
    catch { /* A missing, truncated or historical snapshot does not identify any one job. */ }
    let chain = normalized?.platform === 'weibo' && normalized.jobs.length === 1 && normalized.page === 1 && !normalized.cursor
      ? { page: 1, pageSize: normalized.pageSize } : null
    const { rows: calls } = await client.query(`SELECT /* weibo-account:calls */ c.id, c.call_ordinal, c.outcome, c.operation,
        c.endpoint_key, c.endpoint_version, c.contract_version, c.provider_key, c.marketplace, c.error_code, c.http_status,
        c.item_count, c.billed, r.body_size
      FROM public.usage_requests u JOIN external_platform.provider_calls c ON c.usage_request_id=u.id
        AND (c.tenant_id,c.consumer_id,c.api_key_id)=(u.tenant_id,u.consumer_id,u.api_key_id)
      LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      WHERE u.id=$1::uuid ORDER BY c.call_ordinal LIMIT 51`, [requestId])
    let remainingBytes = 24 * 1024 * 1024
    const results = []
    for (const [index, call] of calls.slice(0, 50).entries()) {
      const stage = STAGES.get(call.endpoint_key)
      if (!stage || call.operation !== call.endpoint_key || call.provider_key !== 'tikhub' || call.marketplace !== 'weibo') {
        chain = null
        results.push({ ordinal: call.call_ordinal, state: 'unsupported_call' })
        continue
      }
      let step
      if (chain && index === call.call_ordinal) {
        try { step = buildHubSocialCompatDispatch(normalized.jobs[0], chain) } catch { /* Incompatible historical input. */ }
      }
      if (step?.endpointKey !== call.endpoint_key || step.endpointVersion !== call.endpoint_version || step.endpointContractVersion !== call.contract_version) {
        chain = null
        step = null
      }
      const out = { ordinal: call.call_ordinal, stage, page: stage !== 'profile' && chain ? chain.page : null,
        pageEvidence: stage === 'profile' ? 'not_applicable' : chain ? 'inferred_from_single_job_and_verified_preceding_calls' : 'undetermined',
        outcome: ['succeeded', 'succeeded_unusable', 'rejected', 'unknown', 'pending'].includes(call.outcome) ? call.outcome : 'other',
        httpStatus: call.http_status, billed: call.billed, recordedItemCount: call.item_count,
        recordedError: call.error_code == null ? null : call.error_code === 'invalid_social_contract' ? 'invalid_social_contract' : 'other' }
      results.push(out)
      if (call.body_size == null || call.body_size > MAX_BYTES || call.body_size > remainingBytes) {
        out.archive = call.body_size == null ? 'missing' : 'size_limit'
        chain = null
        continue
      }
      remainingBytes -= call.body_size
      const { rows: [row] } = await client.query(`SELECT /* weibo-account:archive */ r.body_size,r.body_sha256,r.captured_at,
          CASE WHEN r.body_size <= $3 AND octet_length(r.body_bytes) <= $3 THEN r.body_bytes END AS body_bytes
        FROM public.usage_requests u JOIN external_platform.provider_calls c ON c.usage_request_id=u.id
          AND (c.tenant_id,c.consumer_id,c.api_key_id)=(u.tenant_id,u.consumer_id,u.api_key_id)
        JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
        WHERE u.id=$1::uuid AND c.id=$2::uuid AND c.provider_key='tikhub' AND c.marketplace='weibo'
          AND c.endpoint_key=$4 AND c.operation=c.endpoint_key`, [requestId, call.id, MAX_BYTES, call.endpoint_key])
      const decoded = decodeArchive(row)
      out.archive = decoded.state
      if (decoded.state !== 'verified') { chain = null; continue }
      out.structure = structure(decoded.payload)
      if (!step || !['succeeded', 'succeeded_unusable'].includes(call.outcome)) { chain = null; out.projection = 'not_replayed'; continue }
      try {
        const capturedAt = new Date(row.captured_at).toISOString()
        const projected = typeof workflow.projectPage === 'function'
          ? workflow.projectPage(decoded.payload, step, 'crawl', capturedAt).projected
          : projectHubSocialCompatResponse(decoded.payload, step, { capturedAt })
        out.projection = 'accepted'
        out.projectedCount = projected.acquiredItems.length
        if (projected.resolvedIdentity) chain.resolvedIdentity = projected.resolvedIdentity
        else if (projected.providerPage.nextParams) Object.assign(chain, { page: projected.providerPage.nextPage, nextParams: projected.providerPage.nextParams })
        else chain = null
      } catch (error) {
        out.projection = REASONS.get(error.message) || 'other_projection_failure'
        chain = null
      }
      if (call.outcome !== 'succeeded') chain = null
    }
    return { state: 'found', replayScope: typeof workflow.projectPage === 'function' ? 'account_workflow_projection' : 'account_response_projection_only', jobCount: normalized?.jobs.length ?? null,
      callsTruncated: calls.length > 50, calls: results }
  } finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('rollback_failed')
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const [requestId, extra] = process.argv.slice(2)
    if (!UUID.test(requestId) || extra || !process.env.DATABASE_URL) throw new Error('invalid_arguments_or_database_url')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await diagnoseWeiboAccount(pool, requestId), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: error.message === 'invalid_arguments_or_database_url' ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
