import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

// Operator-authorized new Weibo batch: one hot search, then one comment page.
// Existing Twitter/Reddit/Kuaishou receipts and the generic probe limit stay intact.
export const WEIBO_SEARCH_NATIVE_KEY = 't.api_7b07a36b82baa693'
export const WEIBO_COMMENT_NATIVE_KEY = 't.api_631f7f6fd007cba9'
export const WEIBO_SEARCH_BODY = Object.freeze({ params: Object.freeze({
  q: '科技', search_type: 'hot', include_type: 'all', page: 1,
}), deliveryMode: 'live_only' })
const ORIGIN = 'http://127.0.0.1:18150'
const SEARCH_PATH = `/api/v1/data/native/${WEIBO_SEARCH_NATIVE_KEY}`
const COMMENT_PATH = `/api/v1/data/native/${WEIBO_COMMENT_NATIVE_KEY}`
const SEARCH_OPERATION = `native.${WEIBO_SEARCH_NATIVE_KEY}`
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const ID = /^[1-9][0-9]{0,29}$/u
const SHA = /^[0-9a-f]{64}$/u
const MAX_BYTES = 4 * 1024 * 1024
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const uuid = value => typeof value === 'string' && UUID.test(value)
const sha = value => createHash('sha256').update(value).digest('hex')
const SEARCH_SHA = sha(JSON.stringify(WEIBO_SEARCH_BODY))
const SAFE_ERRORS = new Set(['invalid_arguments', 'api_key_required', 'invalid_api_key', 'database_url_required',
  'invalid_sample', 'source_receipt_unverified', 'source_read_failed', 'invalid_search_response', 'no_positive_comment_target'])
const RESPONSE_ERRORS = new Set(['invalid_api_key', 'test_key_not_supported', 'platform_not_granted', 'capability_not_granted',
  'request_outcome_unknown', 'request_in_progress', 'idempotency_conflict', 'insufficient_balance', 'plan_assignment_unavailable',
  'external_platform_operation_disabled', 'external_platform_operation_paused', 'external_platform_contract_unverified',
  'external_platform_not_configured', 'external_platform_cost_control_unavailable', 'external_platform_circuit_open',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_rejected', 'resource_admission_limited',
  'upstream_balance_exhausted', 'upstream_rate_limited', 'native_endpoint_not_found', 'invalid_parameter', 'missing_parameter'])

const postId = value => typeof value === 'string' && ID.test(value) ? value
  : Number.isSafeInteger(value) && value > 0 ? String(value) : null
const metric = value => Number.isSafeInteger(value) && value >= 0 ? value
  : typeof value === 'string' && /^[0-9]{1,16}$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : null

// Candidate structure shared with the existing Weibo realtime-search projector.
// Advanced-search documentation does not prove a concrete response schema; a
// different shape or an empty/zero-comment page stops this batch without buying more.
function searchRows(payload) {
  const rows = payload?.data?.parsed_data?.results
  if (payload?.code !== 200 || payload?.data?.parsed_data?.parse_success === false
    || !Array.isArray(rows) || rows.length > 1000) throw new Error('invalid_search_response')
  return rows
}
const metricPaths = ['comments_count', 'comment_count', 'commentCount', 'interaction.comment_count', 'interaction.comments']
const atPath = (row, path) => path.split('.').reduce((value, key) => object(value) ? value[key] : undefined, row)
const selectedMetric = row => metricPaths.map(path => metric(atPath(row, path))).find(value => value !== null)
const selectedIdentity = row => postId(row.weibo_id ?? row.idstr ?? row.id)

export function selectWeiboCommentTarget(payload) {
  const rows = searchRows(payload)
  const candidates = []
  for (const row of rows) {
    if (!object(row)) continue
    const id = selectedIdentity(row), comments = selectedMetric(row)
    if (id && comments > 0) candidates.push({ postId: id, commentCount: comments })
  }
  candidates.sort((a, b) => b.commentCount - a.commentCount)
  if (!candidates.length) throw new Error('no_positive_comment_target')
  return { ...candidates[0], searchItemCount: rows.length, candidateCount: candidates.length }
}

// Diagnostics never relax selection or expose source values/unknown key names.
export function summarizeWeiboSearchCandidates(payload) {
  const rows = searchRows(payload), objects = rows.filter(object)
  const identities = ['weibo_id', 'idstr', 'id', 'mid', 'mblogid', 'bid']
  const metrics = [...metricPaths, 'comments', 'comment', 'metrics.comments', 'statistics.comment_count', 'stats.comments']
  const paths = [...identities, ...metrics, 'interaction', 'interactions', 'metrics', 'statistics', 'mblog']
  const type = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array'
    : typeof value === 'number' ? Number.isSafeInteger(value) ? 'safe_integer'
      : Number.isInteger(value) ? 'unsafe_number' : 'number' : typeof value
  const metricState = value => {
    const count = metric(value)
    if (count !== null) return count > 0 ? 'positive' : 'zero'
    if (value == null) return value === undefined ? 'missing' : 'null'
    if (typeof value === 'string' && value.length <= 128) {
      if (/^\s+[0-9]+\s*$|^[0-9]+\s+$/u.test(value)) return 'integer_text_with_whitespace'
      if (/^[0-9]{1,3}(?:,[0-9]{3})+$/u.test(value)) return 'grouped_integer_text'
      if (/^[0-9]+(?:\.[0-9]+)?[万亿kKmM]$/u.test(value)) return 'compact_numeric_text'
      if (/^[0-9]+$/u.test(value)) return 'out_of_range_integer_text'
      if (value === '评论' || value === '评论数') return 'count_label'
    }
    return 'unrecognized'
  }
  const result = { inputRowCount: rows.length, objectRowCount: objects.length, validIdentityCount: 0,
    selectedMetricStates: { positive: 0, zero: 0, missing: 0, unrecognized: 0 },
    eligibleCandidateCount: 0, positiveMetricInvalidIdentityCount: 0, fields: [] }
  for (const row of objects) {
    const id = selectedIdentity(row), count = selectedMetric(row)
    const state = count !== undefined ? count > 0 ? 'positive' : 'zero'
      : metricPaths.every(path => atPath(row, path) == null) ? 'missing' : 'unrecognized'
    result.selectedMetricStates[state]++
    if (id) result.validIdentityCount++
    if (count > 0) { if (id) result.eligibleCandidateCount++; else result.positiveMetricInvalidIdentityCount++ }
  }
  for (const path of paths) {
    const field = { path, types: {}, states: {} }
    for (const row of objects) {
      const value = atPath(row, path), kind = type(value)
      field.types[kind] = (field.types[kind] || 0) + 1
      const state = identities.includes(path) ? postId(value) ? 'valid' : value == null ? kind
        : kind === 'unsafe_number' ? kind : 'unrecognized' : metrics.includes(path) ? metricState(value) : kind
      field.states[state] = (field.states[state] || 0) + 1
    }
    if (objects.length > (field.types.missing || 0)) result.fields.push(field)
  }
  return result
}

function validateSearchReceipt(receipt) {
  if (!object(receipt) || receipt.revision !== 'weibo-comment-search-probe.v1'
    || receipt.provider !== 'tikhub' || receipt.platform !== 'weibo' || receipt.path !== SEARCH_PATH
    || receipt.state !== 'http_response' || receipt.httpStatus !== 200 || receipt.errorCode != null
    || receipt.hubRequestsMade !== 1 || receipt.requestIdSource !== 'usage_header' || !uuid(receipt.requestId)
    || typeof receipt.idempotencyKey !== 'string' || !receipt.idempotencyKey.startsWith('weibo-comment-search-v1-')
    || !uuid(receipt.idempotencyKey.slice('weibo-comment-search-v1-'.length)) || receipt.bodySha256 !== SEARCH_SHA) {
    throw new Error('source_receipt_unverified')
  }
}

async function withVerifiedSearchArchive(pool, receipt, project) {
  validateSearchReceipt(receipt)
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: usages } = await client.query(`SELECT /* weibo-comment-sample:usage */
      id,idempotency_key,platform,status,response_status,
      CASE WHEN octet_length(acquisition_request::text)<=32768 THEN acquisition_request END AS acquisition_request
      FROM public.usage_requests WHERE id=$1::uuid`, [receipt.requestId])
    const usage = usages.length === 1 ? usages[0] : null, snapshot = usage?.acquisition_request
    if (!usage || usage.id !== receipt.requestId || usage.idempotency_key !== receipt.idempotencyKey
      || usage.platform !== 'social' || usage.status !== 'committed' || usage.response_status !== 200
      || snapshot?.method !== 'POST' || snapshot.path !== SEARCH_PATH || !isDeepStrictEqual(snapshot.body, WEIBO_SEARCH_BODY)) {
      throw new Error('source_receipt_unverified')
    }
    const { rows: calls } = await client.query(`SELECT /* weibo-comment-sample:calls */
      id,provider_key,marketplace,operation,endpoint_key,contract_version,outcome,http_status,business_code,billed
      FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid ORDER BY started_at,id LIMIT 2`, [receipt.requestId])
    const call = calls.length === 1 ? calls[0] : null
    if (!call || !uuid(call.id) || call.provider_key !== 'tikhub' || call.marketplace !== 'weibo'
      || call.operation !== SEARCH_OPERATION || call.endpoint_key !== SEARCH_OPERATION
      || call.contract_version !== 'mx-insight-hub.native-forwarding.v1' || call.outcome !== 'succeeded'
      || call.http_status !== 200 || call.business_code !== 200 || call.billed !== true) throw new Error('source_receipt_unverified')
    const { rows: archives } = await client.query(`SELECT /* weibo-comment-sample:archive */
      r.body_size,r.body_sha256,octet_length(r.body_bytes) AS actual_body_size,
      CASE WHEN r.body_size<=$3::integer AND octet_length(r.body_bytes)<=$3::integer THEN r.body_bytes END AS body_bytes
      FROM external_platform.provider_calls c
      LEFT JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      WHERE c.usage_request_id=$1::uuid AND c.id=$2::uuid`, [receipt.requestId, call.id, MAX_BYTES])
    const archive = archives.length === 1 ? archives[0] : null, bytes = archive?.body_bytes
    if (!Buffer.isBuffer(bytes) || bytes.length > MAX_BYTES || archive.body_size !== bytes.length
      || archive.actual_body_size !== bytes.length || !SHA.test(archive.body_sha256 || '')
      || sha(bytes) !== archive.body_sha256) throw new Error('source_receipt_unverified')
    let payload
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
    catch { throw new Error('invalid_search_response') }
    return project(payload, bytes.length)
  } catch (error) {
    throw new Error(SAFE_ERRORS.has(error?.message) ? error.message : 'source_read_failed')
  } finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('source_read_failed')
  }
}

export const prepareWeiboCommentSample = (pool, receipt) => withVerifiedSearchArchive(pool, receipt,
  payload => ({ revision: 'weibo-comment-target-sample.v1', platform: 'weibo', provider: 'tikhub',
    sourceRequestId: receipt.requestId, sourceIdempotencyKey: receipt.idempotencyKey, sourceBodySha256: SEARCH_SHA,
    ...selectWeiboCommentTarget(payload) }))

export const inspectWeiboCommentSearch = (pool, receipt) => withVerifiedSearchArchive(pool, receipt,
  (payload, byteLength) => ({ revision: 'weibo-comment-search-inspection.v1', requestId: receipt.requestId, verified: true,
    archive: { state: 'archive_verified', hashVerified: true, byteLength }, selection: summarizeWeiboSearchCandidates(payload),
    supplierHttpCallsMade: 0, databaseWritesMade: 0,
    boundary: 'Exact saved search request/call/archive only. Fixed field types and selection counts; no source values or unknown keys. No HTTP, marker changes, selection override or runtime routing changes.' }))

async function readReceipt(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > 16384) throw new Error('source_receipt_unverified')
    const bytes = await handle.readFile()
    if (bytes.length > 16384) throw new Error('source_receipt_unverified')
    return JSON.parse(bytes.toString('utf8'))
  } finally { await handle.close() }
}

function validateSample(sample) {
  const fields = ['revision', 'platform', 'provider', 'sourceRequestId', 'sourceIdempotencyKey', 'sourceBodySha256',
    'postId', 'commentCount', 'searchItemCount', 'candidateCount']
  if (!object(sample) || Object.keys(sample).length !== fields.length || Object.keys(sample).some(key => !fields.includes(key))
    || sample.revision !== 'weibo-comment-target-sample.v1' || sample.platform !== 'weibo' || sample.provider !== 'tikhub'
    || !uuid(sample.sourceRequestId) || sample.sourceBodySha256 !== SEARCH_SHA
    || typeof sample.postId !== 'string' || !ID.test(sample.postId) || metric(sample.commentCount) !== sample.commentCount
    || sample.commentCount < 1 || !Number.isSafeInteger(sample.searchItemCount) || sample.searchItemCount > 1000
    || !Number.isSafeInteger(sample.candidateCount) || sample.candidateCount < 1 || sample.candidateCount > sample.searchItemCount) {
    throw new Error('invalid_sample')
  }
}

async function responseJson(response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid_response')
  const chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) throw new Error('invalid_response')
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

async function save(handle, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2))
  let offset = 0
  while (offset < bytes.length) {
    const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset)
    if (!bytesWritten) throw new Error('receipt_write_failed')
    offset += bytesWritten
  }
  await handle.truncate(bytes.length)
  await handle.sync()
}

async function runProbe(stage, { sample, sampleDirectory, apiKey, apply = false }, { fetchImpl = fetch } = {}) {
  if (typeof sampleDirectory !== 'string' || !sampleDirectory || typeof apply !== 'boolean') throw new Error('invalid_arguments')
  const directory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  const search = stage === 'search', path = search ? SEARCH_PATH : COMMENT_PATH
  const marker = join(directory, search ? 'weibo.search.json' : 'weibo.comments.json')
  const preview = { revision: search ? 'weibo-comment-search-probe.v1' : 'weibo-comment-native-probe.v1',
    provider: 'tikhub', platform: 'weibo', path, hubRequestLimit: 1, batchHubRequestLimit: 2,
    automaticRetry: false, automaticContinuation: false }
  const attempted = (preflightRequestsMade = 0) => ({ ...preview, state: 'already_attempted', hubRequestsMade: 0,
    preflightRequestsMade, boundary: 'Preserve all markers. Do not delete them or change directories to repeat purchases.' })
  // Any object, including an unfinished marker or dangling symlink, consumes the slot.
  for (const file of search ? [marker, join(directory, 'weibo.comments.json')] : [marker]) {
    try { await lstat(file); return attempted() } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
  if (!search) {
    validateSample(sample)
    let receipt
    try { receipt = await readReceipt(join(directory, 'weibo.search.json')); validateSearchReceipt(receipt) }
    catch { throw new Error('source_receipt_unverified') }
    if (receipt.requestId !== sample.sourceRequestId || receipt.idempotencyKey !== sample.sourceIdempotencyKey
      || receipt.bodySha256 !== sample.sourceBodySha256) throw new Error('source_receipt_unverified')
    preview.sourceRequestId = sample.sourceRequestId
  }
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0, preflightRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  if (typeof apiKey !== 'string' || !/^mih_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u.test(apiKey)) throw new Error('invalid_api_key')
  let preflight
  try {
    const response = await fetchImpl(`${ORIGIN}/api/v1/data/capabilities`, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${apiKey}` } })
    const rows = (await responseJson(response))?.data?.capabilities
    const check = key => {
      const entry = Array.isArray(rows) ? rows.find(row => row?.capability === `native.${key}`) : null
      return { granted: Boolean(entry), ready: entry?.ready === true }
    }
    preflight = { httpStatus: response.status, search: check(WEIBO_SEARCH_NATIVE_KEY), comments: check(WEIBO_COMMENT_NATIVE_KEY) }
  } catch { return { ...preview, state: 'preflight_unavailable', hubRequestsMade: 0, preflightRequestsMade: 1 } }
  if (preflight.httpStatus !== 200 || !preflight.search.granted || !preflight.search.ready
    || !preflight.comments.granted || !preflight.comments.ready) {
    return { ...preview, state: 'preflight_rejected', preflight, hubRequestsMade: 0, preflightRequestsMade: 1 }
  }
  const body = JSON.stringify(search ? WEIBO_SEARCH_BODY : { params: { id: sample.postId, count: 20 }, deliveryMode: 'live_only' })
  const before = { ...preview, state: 'dispatch_started',
    idempotencyKey: `weibo-comment-${search ? 'search' : 'native'}-v1-${randomUUID()}`, bodySha256: sha(body),
    preflight, preflightRequestsMade: 1, hubRequestsMade: null, requestId: null }
  let handle
  try { handle = await open(marker, 'wx', 0o600) }
  catch (error) { if (error.code === 'EEXIST') return attempted(1); throw error }
  try {
    await save(handle, before)
    // Persist the newly created directory entry as well as the receipt bytes
    // before a paid dispatch, including across host restart/power loss.
    const directoryHandle = await open(directory, constants.O_RDONLY | constants.O_DIRECTORY)
    try { await directoryHandle.sync() } finally { await directoryHandle.close() }
    let result
    try {
      const response = await fetchImpl(`${ORIGIN}${path}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(55000), headers: { authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json', 'idempotency-key': before.idempotencyKey }, body })
      const header = response.headers.get('x-mx-insight-request-id'), requestId = uuid(header) ? header : null
      result = { ...before, state: 'http_response', httpStatus: response.status, hubRequestsMade: 1,
        requestId, requestIdSource: requestId ? 'usage_header' : null }
      if (response.status !== 200) {
        try {
          const payload = await responseJson(response), durableId = payload?.error?.details?.requestId
          result.errorCode = RESPONSE_ERRORS.has(payload?.error?.code) ? payload.error.code : 'other'
          if (!requestId && uuid(durableId)) { result.requestId = durableId; result.requestIdSource = 'error_details' }
        } catch { result.errorCode = 'response_unverified' }
      } else await response.body?.cancel().catch(() => {})
    } catch {
      result = { ...before, state: 'outcome_unknown', hubRequestsMade: 1,
        boundary: 'The request may have dispatched and charged. Preserve this marker; no retry or continuation was made.' }
    }
    await save(handle, result)
    return result
  } finally { await handle.close() }
}

export const runWeiboSearchProbe = (input, deps) => runProbe('search', input, deps)
export const runWeiboCommentProbe = (input, deps) => runProbe('comments', input, deps)

const stdinMain = process.argv[1] === '-' && import.meta.url.endsWith('/[eval1]')
if (stdinMain || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length !== 3 || !['--prepare', '--inspect-search'].includes(args[0]) || !uuid(args[1])) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 6000, options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
    // --prepare stdout is private; --inspect-search returns only safe aggregates.
    const receipt = { revision: 'weibo-comment-search-probe.v1', provider: 'tikhub', platform: 'weibo', path: SEARCH_PATH,
      state: 'http_response', httpStatus: 200, hubRequestsMade: 1, requestIdSource: 'usage_header',
      requestId: args[1], idempotencyKey: args[2], bodySha256: SEARCH_SHA }
    const execute = args[0] === '--inspect-search' ? inspectWeiboCommentSearch : prepareWeiboCommentSample
    console.log(JSON.stringify(await execute(pool, receipt), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'weibo_comment_probe_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
