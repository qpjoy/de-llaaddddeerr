// Bounded supplier probe for WeChat search rejection 877297ae. At most two
// direct TikHub calls with the deployed adapter: the supplier's documented demo
// keyword, then the saved keyword only when the demo is accepted. No Hub usage,
// customer charge, replay, retry, circuit or policy change. Output carries
// shapes, fixed enum values and UUIDs only, never keyword text or result content.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'wechat-search-877297ae-probe.v1'
export const SOURCE = Object.freeze({
  requestId: '877297ae-5992-4c5a-aeb7-346b2a0f9942', callId: '3d5dd170-243d-4ee4-99d6-64ce0f7fd38a',
  upstreamRequestId: '6a6d493a-fbe6-4805-8dc9-9fbe16846e1f', operation: 'native.wechat.search.search',
  bodySize: 917, bodySha256: '66c9125f960f66c383c631b6e9852d21722ae1fb1ce61784b985b0a16f6fda7c', keywordLength: 8,
})
export const NATIVE_KEY = 'wechat.search.search'
export const ENDPOINT_PATH = '/api/v1/wechat_search/v2/fetch_search'
// TikHub's own OpenAPI example; its rejection text asks callers to test with it.
export const CONTROL_KEYWORD = '人民日报'
export const MAX_CALLS = 2

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const NO_CHARGE_CLAIM = "Request failed. Please retry. Check the docs below to verify your parameters, test with the default demo parameters, and send the response JSON to support. You won't be charged for this request."
const BUSINESS_TYPES = new Set(['all', 'account', 'article', 'video', 'sticker', 'underline', 'encyclopedia', 'live_stream',
  'comment', 'listen', 'news', 'photos', 'book', 'moments', 'image', 'mini_game', 'weixin_index', 'ai_search'])
const SORTS = new Set([0, 1, 2, 'default', 'latest', 'hot'])
const PUBLISH_TIMES = new Set([0, 1, 2, 3, 'all', 'day', 'week', 'half_year'])
const SAFE_CODES = new Set(['invalid_arguments', 'database_url_required', 'source_identity_mismatch',
  'archive_integrity_failed', 'saved_keyword_unverified', 'credential_missing', 'probe_call_limit', 'probe_request_mismatch'])
const kind = value => value === undefined ? 'missing' : value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
const object = value => kind(value) === 'object'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value : null
const integer = value => Number.isSafeInteger(value) ? value : null
const pick = (value, values) => value === undefined ? 'missing' : values.has(value) ? value : 'other'
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const fail = code => Object.assign(new Error(code), { probeCode: code })
const safeCode = error => SAFE_CODES.has(error?.probeCode) ? error.probeCode : 'probe_unavailable'
const message = value => ({ type: kind(value), length: typeof value === 'string' ? value.length : null,
  classification: value === NO_CHARGE_CLAIM ? 'request_failed_no_charge_claim' : typeof value === 'string' ? 'other_text' : 'not_text' })

export function isPinnedSource(row) {
  return row?.request_id === SOURCE.requestId && row.call_id === SOURCE.callId && row.usage_request_id === SOURCE.requestId
    && row.status === 'committed' && row.response_status === 502 && row.provider_key === 'tikhub'
    && row.operation === SOURCE.operation && row.outcome === 'rejected' && row.http_status === 400
    && row.upstream_request_id === SOURCE.upstreamRequestId && row.body_size === SOURCE.bodySize && row.body_sha256 === SOURCE.bodySha256
}

// The saved keyword is accepted only when the verified archive echoes it back
// unchanged, so the probe resends exactly what TikHub received on 10-28.
export function savedKeyword(row, pin = SOURCE) {
  if (!(row.body_bytes instanceof Uint8Array) || row.body_bytes.length !== pin.bodySize || sha(row.body_bytes) !== pin.bodySha256) {
    throw fail('archive_integrity_failed')
  }
  const params = row.acquisition_request?.body?.params
  const keyword = object(params) ? params.keyword : undefined
  let echoed
  try {
    const payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.body_bytes))
    echoed = (object(payload?.detail?.params) ? payload.detail.params : payload?.params)?.keyword
  } catch { echoed = undefined }
  if (typeof keyword !== 'string' || keyword.length !== pin.keywordLength || echoed !== keyword
    || Object.keys(params).some(name => name !== 'keyword')) throw fail('saved_keyword_unverified')
  return keyword
}

function echoedShape(params, keyword) {
  if (!object(params)) return { type: kind(params) }
  return { keywordMatches: params.keyword === keyword, business_type: pick(params.business_type, BUSINESS_TYPES),
    sort: pick(params.sort, SORTS), publish_time: pick(params.publish_time, PUBLISH_TIMES), offset: integer(params.offset),
    cursor: kind(params.cursor), raw: typeof params.raw === 'boolean' ? params.raw : kind(params.raw) }
}

function dataShape(data, keyword) {
  if (!object(data)) return { type: kind(data) }
  const boxes = Array.isArray(data.results?.data) ? data.results.data : null
  const count = list => Array.isArray(list) ? list.length : 0
  return { keywordMatches: data.keyword === keyword, total: integer(data.total) ?? kind(data.total), boxes: boxes?.length ?? null,
    items: boxes?.reduce((sum, box) => sum + count(box?.items)
      + (Array.isArray(box?.subBoxes) ? box.subBoxes.reduce((inner, sub) => inner + count(sub?.items), 0) : 0), 0) ?? null,
    continueFlag: [true, 1, '1'].includes(data.continue_flag), cursorPresent: typeof data.cursor === 'string' && data.cursor.length > 0,
    noMore: typeof data.no_more === 'string' && data.no_more ? 'present' : kind(data.no_more),
    categories: Array.isArray(data.categories) ? data.categories.length : kind(data.categories) }
}

export function summarizeProbeCall({ label, keyword, result, error, durationMs }) {
  const archive = (error || result)?.restrictedResponseArchive || null
  let payload = archive?.parsedPayload ?? null
  if (payload == null && archive?.bodyBytes) try { payload = JSON.parse(Buffer.from(archive.bodyBytes).toString('utf8')) } catch { payload = null }
  const envelope = object(payload?.detail) ? payload.detail : payload
  return { label, keyword: { source: label === 'control' ? 'tikhub_documented_example' : 'saved_request', length: keyword.length },
    durationMs, httpStatus: integer(archive?.httpStatus ?? error?.evidence?.httpStatus) ?? (result ? 200 : null),
    outcome: result ? 'accepted' : ['rejected', 'unknown', 'succeeded_unusable'].includes(error?.evidence?.outcome) ? error.evidence.outcome : 'other',
    errorCode: result ? null : typeof error?.evidence?.errorCode === 'string' ? error.evidence.errorCode : null,
    billedClaim: result ? null : typeof error?.evidence?.billed === 'boolean' ? error.evidence.billed : null,
    archive: archive ? { bodySize: integer(archive.bodySize), bodySha256: typeof archive.bodySha256 === 'string' ? archive.bodySha256 : null } : null,
    envelope: { location: object(payload?.detail) ? 'detail' : object(payload) ? 'root' : kind(payload), code: integer(envelope?.code),
      requestId: uuid(envelope?.request_id), routerMatches: envelope?.router === ENDPOINT_PATH, message: message(envelope?.message) },
    echoed: echoedShape(envelope?.params, keyword),
    data: result ? dataShape(payload ? payload.data : result.publicBody?.data, keyword) : null }
}

export function conclude(control, original) {
  if (control.outcome !== 'accepted') {
    return control.httpStatus === 400 && control.envelope.message.classification === 'request_failed_no_charge_claim'
      ? 'demo_also_rejected_supplier_side' : 'demo_not_accepted_other'
  }
  if (!original) return 'original_not_sent'
  if (original.outcome === 'accepted') return 'saved_keyword_now_accepted'
  return original.httpStatus === 400 && original.envelope.message.classification === 'request_failed_no_charge_claim'
    ? 'saved_keyword_rejected_demo_accepted' : 'saved_keyword_other_failure'
}

// One process can never send more than MAX_CALLS, and only the fixed body shape.
export function boundedAdapter(adapter) {
  let calls = 0
  return { get calls() { return calls }, forwardNative: async (key, body, options) => {
    if (calls >= MAX_CALLS) throw fail('probe_call_limit')
    if (key !== NATIVE_KEY || !object(body) || Object.keys(body).join(',') !== 'params' || !object(body.params)
      || Object.keys(body.params).join(',') !== 'keyword' || typeof body.params.keyword !== 'string') throw fail('probe_request_mismatch')
    calls++
    return adapter.forwardNative(key, body, options)
  } }
}

export async function runWechatProbe({ keyword, adapter, execute, clock = () => performance.now() }) {
  const report = { diagnosticRevision: REVISION, requestId: SOURCE.requestId, sourceVerified: true,
    endpoint: ENDPOINT_PATH, maxCalls: MAX_CALLS, mode: execute ? 'execute' : 'dry_run', supplierCalls: 0 }
  if (!execute) return { ...report, plan: ['control: documented demo keyword', 'original: saved keyword, only if control is accepted'] }
  const bounded = boundedAdapter(adapter)
  const call = async (label, value) => {
    const started = clock()
    try {
      const result = await bounded.forwardNative(NATIVE_KEY, { params: { keyword: value } })
      return summarizeProbeCall({ label, keyword: value, result, durationMs: Math.round(clock() - started) })
    } catch (error) {
      if (error?.probeCode) throw error
      return summarizeProbeCall({ label, keyword: value, error, durationMs: Math.round(clock() - started) })
    } finally { report.supplierCalls = bounded.calls }
  }
  report.control = await call('control', CONTROL_KEYWORD)
  report.original = report.control.outcome === 'accepted' ? await call('original', keyword) : { skipped: 'control_not_accepted' }
  report.conclusion = conclude(report.control, report.original.skipped ? null : report.original)
  return report
}

const sourceQuery = `SELECT /* wechat-search-877297ae:source */ request.id AS request_id,request.status,request.response_status,
  request.acquisition_request,call.id AS call_id,call.usage_request_id,call.provider_key,call.operation,call.outcome,
  call.http_status,call.upstream_request_id,raw.body_bytes,raw.body_size,raw.body_sha256
  FROM public.usage_requests request JOIN external_platform.provider_calls call ON call.usage_request_id=request.id
  JOIN control.external_platform_restricted_raw_responses raw ON raw.provider_call_id=call.id
  WHERE request.id=$1 AND call.id=$2 LIMIT 2`

export async function readSource(pool) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='5s'")
    const { rows } = await client.query(sourceQuery, [SOURCE.requestId, SOURCE.callId])
    if (rows.length !== 1 || !isPinnedSource(rows[0])) throw fail('source_identity_mismatch')
    return savedKeyword(rows[0])
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

// Mirrors production adapter wiring: same credential store, base URL, timeout
// and TikHub egress binding. The Admin listener does not build one itself.
async function adapterFromInstalledSources(pool) {
  const source = path => import(new URL(path, pathToFileURL(`${process.cwd()}/`)))
  const [configModule, credentials, proxy, adapterModule] = await Promise.all([source('server/config.mjs'),
    source('server/external-platforms/credentials-store.mjs'), source('server/external-platforms/proxy.mjs'), source('server/adapters/tikhub.mjs')])
  const config = configModule.loadConfig(), provider = config.tikHub
  const credentialStore = credentials.createExternalPlatformCredentialStore({ pool, providerKey: 'tikhub', environmentConfigured: Boolean(provider.configured) })
  if ((await credentialStore.describeCredential('tikhub')).credentialConfigured !== true) throw fail('credential_missing')
  return new adapterModule.TikHubAdapter({ apiKey: provider.apiKey, credentialResolver: () => credentialStore.readCredential('tikhub'),
    baseUrl: provider.baseUrl, timeoutMs: provider.timeoutMs,
    fetchImpl: proxy.createTikHubProxyFetch(new proxy.ExternalPlatformProxyStore(pool, config.deploymentEgress, { providerKey: 'tikhub' })) })
}

export async function main(args = process.argv.slice(2), env = process.env) {
  let pool
  try {
    if (args.length > 1 || (args.length === 1 && args[0] !== '--execute')) throw fail('invalid_arguments')
    if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw fail('database_url_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: env.DATABASE_URL, max: 2, application_name: REVISION, connectionTimeoutMillis: 5000 })
    const keyword = await readSource(pool)
    const execute = args[0] === '--execute'
    const report = await runWechatProbe({ keyword, execute, adapter: execute ? await adapterFromInstalledSources(pool) : null })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: safeCode(error) })}\n`)
    process.exitCode = 1
  } finally { await pool?.end().catch(() => {}) }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
