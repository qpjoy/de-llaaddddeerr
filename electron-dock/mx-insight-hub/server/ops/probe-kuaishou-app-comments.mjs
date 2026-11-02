import { createHash, randomUUID } from 'node:crypto'
import { lstat, open, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// This incident-specific App sample is separate from the failed Web request.
// Never reopen the original marker or make an automatic retry/continuation.
const SOURCE_REQUEST = 'ce942beb-a379-4e18-b62f-ee69cc24b3d3'
const SOURCE_KEY = 'comment-calibration-v1-0513a892-81fb-47b7-9cc2-363d45db9e6d'
const WEB_PATH = '/api/v1/data/native/t.api_3cb972ba91c8fe44'
const WEB_OPERATION = 'native.t.api_3cb972ba91c8fe44'
const APP_PATH = '/api/v1/data/native/t.api_bc64c9d98dbf724c'
const APP_OPERATION = 'native.t.api_bc64c9d98dbf724c'
const NATIVE_CONTRACT = 'mx-insight-hub.native-forwarding.v1'
const ORIGIN = 'http://127.0.0.1:18150'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SAFE_ERRORS = new Set(['invalid_arguments', 'invalid_sample', 'source_receipt_unverified',
  'source_request_unverified', 'database_url_required', 'api_key_required', 'invalid_api_key'])
const RESPONSE_ERRORS = new Set(['invalid_api_key', 'api_key_required', 'test_key_not_supported', 'platform_not_granted',
  'capability_not_granted', 'request_outcome_unknown', 'request_in_progress', 'idempotency_conflict',
  'external_platform_operation_disabled', 'external_platform_operation_paused', 'external_platform_contract_unverified',
  'external_platform_not_configured', 'external_platform_cost_control_unavailable', 'external_platform_circuit_open',
  'external_platform_rate_limited', 'external_platform_busy', 'external_platform_rejected',
  'upstream_balance_exhausted', 'upstream_rate_limited', 'native_endpoint_not_found', 'invalid_parameter', 'missing_parameter'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const photoId = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/u.test(value)
const uuid = value => typeof value === 'string' && UUID.test(value)
const sha = value => createHash('sha256').update(value).digest('hex')

function validateSample(sample) {
  if (!object(sample) || Object.keys(sample).length !== 4 || sample.revision !== 'kuaishou-app-comment-sample.v1'
    || sample.platform !== 'kuaishou' || sample.sourceRequestId !== SOURCE_REQUEST || !photoId(sample.postId)) {
    throw new Error('invalid_sample')
  }
  return sample
}

// Private stdout only: capture this result in the host wrapper, never print it
// to the terminal. The immutable failed request supplies the exact target; no
// rescan, mutable canonical lookup, response-derived instruction or HTTP.
export async function prepareKuaishouAppCommentSample(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: usages } = await client.query(`SELECT /* kuaishou-app-probe:source-usage */
      id,platform,status,response_status,error_code,acquisition_request->>'method' AS method,
      acquisition_request->>'path' AS path,
      CASE WHEN octet_length(acquisition_request::text)<=16384 THEN acquisition_request->'body' END AS body
      FROM public.usage_requests WHERE id=$1::uuid`, [SOURCE_REQUEST])
    const usage = usages.length === 1 ? usages[0] : null, body = usage?.body
    if (!usage || usage.id !== SOURCE_REQUEST || usage.platform !== 'social' || usage.status !== 'committed'
      || usage.response_status !== 502 || usage.error_code !== 'upstream_request_rejected'
      || usage.method !== 'POST' || usage.path !== WEB_PATH || !object(body)
      || Object.keys(body).length !== 2 || body.deliveryMode !== 'live_only' || !object(body.params)
      || Object.keys(body.params).length !== 1 || !photoId(body.params.photo_id)) throw new Error('source_request_unverified')
    const { rows: calls } = await client.query(`SELECT /* kuaishou-app-probe:source-calls */
      provider_key,marketplace,operation,endpoint_key,contract_version,outcome,http_status,business_code,error_code,billed
      FROM external_platform.provider_calls WHERE usage_request_id=$1::uuid
      ORDER BY started_at,id LIMIT 2`, [SOURCE_REQUEST])
    const call = calls.length === 1 ? calls[0] : null
    if (!call || call.provider_key !== 'tikhub' || call.marketplace !== 'kuaishou'
      || call.operation !== WEB_OPERATION || call.endpoint_key !== WEB_OPERATION || call.contract_version !== NATIVE_CONTRACT
      || call.outcome !== 'rejected' || call.http_status !== 400 || call.business_code !== 400
      || call.error_code !== 'upstream_request_rejected' || call.billed !== null) throw new Error('source_request_unverified')
    // billed=null remains unknown. Preparing another endpoint never changes it.
    return { revision: 'kuaishou-app-comment-sample.v1', platform: 'kuaishou',
      sourceRequestId: SOURCE_REQUEST, postId: body.params.photo_id }
  } finally {
    let rollbackError
    try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
    client.release(rollbackError)
    if (rollbackError) throw new Error('source_request_unverified')
  }
}

async function savedJson(file, maxBytes = 16384) {
  const info = await lstat(file)
  if (!info.isFile() || info.size > maxBytes) throw new Error('invalid_sample')
  const bytes = await readFile(file)
  if (bytes.length > maxBytes) throw new Error('invalid_sample')
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
}

export async function loadKuaishouAppCommentSample(file) {
  try { return validateSample(await savedJson(file, 8192)) }
  catch { throw new Error('invalid_sample') }
}

async function verifySourceReceipt(directory) {
  try {
    const source = await savedJson(join(directory, 'kuaishou.json'))
    if (source.revision !== 'post-comment-contract-probe.v2' || source.provider !== 'tikhub'
      || source.platform !== 'kuaishou' || source.path !== WEB_PATH || source.state !== 'http_response'
      || source.httpStatus !== 502 || source.errorCode !== 'external_platform_rejected'
      || source.requestId !== SOURCE_REQUEST || source.requestIdSource !== 'usage_header'
      || source.hubRequestsMade !== 1 || source.idempotencyKey !== SOURCE_KEY
      || source.samplePurpose != null || source.authenticationRetry != null) throw new Error('source_receipt_unverified')
  } catch { throw new Error('source_receipt_unverified') }
}

async function responseJson(response, maxBytes) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('invalid_response')
  const chunks = []; let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.length
      if (size > maxBytes) throw new Error('invalid_response')
      chunks.push(value)
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

export async function runKuaishouAppCommentProbe({ sample, sampleDirectory, apiKey, apply = false }, { fetchImpl = fetch } = {}) {
  validateSample(sample)
  if (typeof sampleDirectory !== 'string' || !sampleDirectory || typeof apply !== 'boolean') throw new Error('invalid_arguments')
  const directory = join(resolve(sampleDirectory), '.hub-comment-contract-probes-v1')
  await verifySourceReceipt(directory)
  const preview = { revision: 'kuaishou-app-comment-probe.v1', provider: 'tikhub', platform: 'kuaishou', path: APP_PATH,
    sourceRequestId: SOURCE_REQUEST, hubRequestLimit: 1, automaticRetry: false, automaticContinuation: false }
  const marker = join(directory, 'kuaishou.app.json')
  const attempted = () => ({ ...preview, state: 'already_attempted', hubRequestsMade: 0, preflightRequestsMade: 0,
    boundary: 'Preserve the existing App and Web markers; do not delete, move or recreate them to retry.' })
  // lstat also blocks malformed files, directories and dangling symlinks.
  try { await lstat(marker); return attempted() }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  if (!apply) return { ...preview, state: 'preview', hubRequestsMade: 0, preflightRequestsMade: 0 }
  if (!apiKey) throw new Error('api_key_required')
  if (typeof apiKey !== 'string' || !/^mih_live_[0-9a-f]{12}_[A-Za-z0-9_-]{43}$/u.test(apiKey)) throw new Error('invalid_api_key')
  let preflight
  try {
    const response = await fetchImpl(`${ORIGIN}/api/v1/data/capabilities`, { method: 'GET', redirect: 'error',
      signal: AbortSignal.timeout(15000), headers: { authorization: `Bearer ${apiKey}` } })
    const rows = (await responseJson(response, 2 * 1024 * 1024))?.data?.capabilities
    const entry = Array.isArray(rows) ? rows.find(row => row?.capability === APP_OPERATION) : null
    preflight = { httpStatus: response.status, capability: APP_OPERATION, granted: Boolean(entry), ready: entry?.ready === true }
  } catch { return { ...preview, state: 'preflight_unavailable', hubRequestsMade: 0, preflightRequestsMade: 1 } }
  if (preflight.httpStatus !== 200 || !preflight.granted || !preflight.ready) {
    return { ...preview, state: 'preflight_rejected', preflight, hubRequestsMade: 0, preflightRequestsMade: 1 }
  }
  const body = JSON.stringify({ params: { photo_id: sample.postId }, deliveryMode: 'live_only' })
  const before = { ...preview, state: 'dispatch_started', idempotencyKey: `kuaishou-app-comment-calibration-v1-${randomUUID()}`,
    bodySha256: sha(body), preflight, preflightRequestsMade: 1, hubRequestsMade: null, requestId: null }
  let handle
  try { handle = await open(marker, 'wx', 0o600) }
  catch (error) {
    if (error.code !== 'EEXIST') throw error
    return { ...attempted(), preflightRequestsMade: 1 }
  }
  try { await handle.writeFile(JSON.stringify(before)); await handle.sync() }
  finally { await handle.close() }
  let result
  try {
    const response = await fetchImpl(`${ORIGIN}${APP_PATH}`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(55000),
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', 'idempotency-key': before.idempotencyKey }, body })
    const header = response.headers.get('x-mx-insight-request-id')
    result = { ...before, state: 'http_response', httpStatus: response.status, hubRequestsMade: 1,
      requestId: uuid(header) ? header : null, requestIdSource: uuid(header) ? 'usage_header' : null }
    if (response.status >= 400) {
      try {
        const payload = await responseJson(response, 16384), durableId = payload?.error?.details?.requestId
        result.errorCode = RESPONSE_ERRORS.has(payload?.error?.code) ? payload.error.code : 'other'
        if (result.requestId === null && uuid(durableId)) { result.requestId = durableId; result.requestIdSource = 'error_details' }
      } catch { result.errorCode = 'response_unverified' }
    } else await response.body?.cancel()
  } catch {
    result = { ...before, state: 'outcome_unknown', hubRequestsMade: 1,
      boundary: 'The App request may have dispatched and charged. Keep both markers; no retry or continuation was made.' }
  }
  // A failed final write leaves the exclusive marker in place. Only summaries
  // are saved; post IDs, comments, cursors and API credentials stay out of receipts.
  await writeFile(marker, JSON.stringify(result, null, 2), { mode: 0o600 })
  return result
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length === 1 && args[0] === '--prepare-private') {
      if (!process.env.DATABASE_URL) throw new Error('database_url_required')
      const { default: pg } = await import('pg')
      pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000,
        options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
      console.log(JSON.stringify(await prepareKuaishouAppCommentSample(pool)))
    } else {
      const apply = args.at(-1) === '--apply'
      if (apply) args.pop()
      if (args.length !== 4 || args[0] !== '--sample-dir' || args[2] !== '--prepared-sample') throw new Error('invalid_arguments')
      const result = await runKuaishouAppCommentProbe({ sample: await loadKuaishouAppCommentSample(args[3]),
        sampleDirectory: args[1], apiKey: process.env.MX_HUB_PROBE_API_KEY, apply })
      console.log(JSON.stringify(result, null, 2))
      if (apply && result.state !== 'already_attempted' && (result.state !== 'http_response' || result.httpStatus !== 200)) process.exitCode = 1
    }
  } catch (error) {
    console.error(JSON.stringify({ error: SAFE_ERRORS.has(error?.message) ? error.message : 'kuaishou_app_comment_probe_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
