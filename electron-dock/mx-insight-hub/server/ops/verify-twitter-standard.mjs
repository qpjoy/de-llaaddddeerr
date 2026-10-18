// Operator-authorized standard-search acceptance in a Public container.
// No HTTP listener, client mutation, grant change, receipt repair or provider override.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

export const REVISION = 'twitter-standard-check.v1'
export const ORIGINAL_REQUEST_ID = 'b5906846-8564-4791-8b83-ef3ce97789bc'
export const MAX_SUPPLIER_CALLS = 2
export const KEYS = Object.freeze([1, 2].flatMap(version => [1, 2].map(page =>
  `ops-twitter-standard-b5906846-v${version}-page${page}`)))
// An explicit diagnostic window, not a reconstruction of the old request,
// which did not contain dates. It never moves when this command is repeated.
export const TIME_WINDOW = Object.freeze({ from: '2026-09-18T00:00:00.000Z', to: '2026-10-19T00:00:00.000Z',
  timezone: 'Asia/Shanghai', boundary: '[from,to)' })
const ORIGINAL_SHA = 'f8f3da5a20307fa43713d737199766faa376498fe825ea69889b171f72a37386'
const sha = value => createHash('sha256').update(value).digest('hex')
const requireValue = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }) }
const safeCode = error => typeof error?.code === 'string' && /^[a-z][a-z0-9_]{1,90}$/u.test(error.code) ? error.code : 'verification_unavailable'
const safeId = value => typeof value === 'string' && /^[0-9a-f-]{36}$/iu.test(value) ? value : null
const owned = (row, owner) => ['tenant_id', 'consumer_id', 'api_key_id'].every(key => row?.[key] === owner?.[key])

async function originalReceipt(pool) {
  const row = (await pool.query(`SELECT /* twitter-standard:original */ id,tenant_id,consumer_id,api_key_id,
    platform,status,response_status,response_body,acquisition_request FROM usage_requests WHERE id=$1`, [ORIGINAL_REQUEST_ID])).rows[0]
  requireValue(row?.status === 'committed' && row.response_status === 502 && row.platform === 'twitter'
    && row.acquisition_request?.path === '/api/v1/data/search'
    && typeof row.acquisition_request?.body?.query === 'string' && sha(row.acquisition_request.body.query) === ORIGINAL_SHA
    && row.response_body?.error?.code === 'social_upstream_rejected'
    && row.response_body.error.details?.upstreamStatus === 400, 'original_receipt_unverified')
  return row
}

export async function countSupplierCalls(pool, owner) {
  const rows = (await pool.query(`SELECT /* twitter-standard:budget */ call.id,call.tenant_id,call.consumer_id,call.api_key_id,
    request.tenant_id AS request_tenant_id,request.api_key_id AS request_api_key_id
    FROM external_platform.provider_calls call JOIN usage_requests request ON request.id=call.usage_request_id
    WHERE request.consumer_id=$1 AND request.idempotency_key=ANY($2::text[]) LIMIT 3`, [owner.consumer_id, KEYS])).rows
  requireValue(rows.every(row => owned(row, owner) && row.request_tenant_id === owner.tenant_id
    && row.request_api_key_id === owner.api_key_id), 'receipt_owner_mismatch')
  return rows.length
}

export function installCallBudget(runtime, owner, AppError) {
  const controls = runtime.externalPlatformControlStore, authorize = controls.authorizeDispatch.bind(controls)
  let attempts = 0
  const restores = []
  const wrappedAuthorize = async (...args) => {
    // This check is before beginProviderCall/HTTP, so normal partial-page and
    // reservation-release handling applies. It is local to this process.
    requireValue(args[2]?.consumerId === owner.consumer_id, 'unexpected_diagnostic_owner')
    requireValue(args[0] === 'tikhub' && args[1] === 'native.t.twitter_web_fetch_search_timeline'
      || args[0] === 'rapidapi' && args[1] === 'social.content.search', 'unexpected_diagnostic_operation')
    if (await countSupplierCalls(runtime.pool, owner) >= MAX_SUPPLIER_CALLS) {
      throw new AppError(409, 'external_platform_operation_blocked', 'Diagnostic supplier call budget exhausted')
    }
    return authorize(...args)
  }
  controls.authorizeDispatch = wrappedAuthorize
  restores.push(() => { controls.authorizeDispatch = authorize })
  for (const [adapter, method] of [[runtime.tikHubAdapter, 'forwardNative'], [runtime.hubSocialGateway?.adapter, 'execute']]) {
    if (!adapter || typeof adapter[method] !== 'function') continue
    const original = adapter[method]
    adapter[method] = async function (...args) { attempts++; return original.apply(this, args) }
    restores.push(() => { adapter[method] = original })
  }
  return { attempts: () => attempts, restore: () => restores.reverse().forEach(restore => restore()) }
}

function pageSummary(result, body, version) {
  const data = result?.body?.data, page = data?.pageInfo
  requireValue(result?.status === 200 && safeId(result.requestId) && data?.platform === 'twitter' && data.query === body.query
    && Array.isArray(data.items) && data.items.length <= 1 && typeof page?.hasMore === 'boolean'
    && (!page.hasMore || typeof page.nextCursor === 'string' && page.nextCursor.startsWith(version === 2 ? 'mxds2.' : 'mxds1.')),
  'standard_page_invalid')
  if (version === 2) requireValue(data.contractVersion === 'mx-insight-hub.data-search.v2'
    && isDeepStrictEqual(data.meta?.requestedWindow, TIME_WINDOW)
    && data.meta?.effectiveWindow?.deliveryFiltering === 'exact', 'v2_window_unverified')
  return { requestId: result.requestId, httpStatus: result.status, resultCount: data.items.length,
    hasMore: page.hasMore, nextCursorPresent: Boolean(page.nextCursor), status: data.status,
    limitationCodes: (data.meta?.limitations || []).map(row => row.code),
    effectiveWindow: data.meta?.effectiveWindow || null }
}

async function inspectReceipt(pool, owner, result, key, query) {
  const saved = (await pool.query(`SELECT /* twitter-standard:saved */ id,tenant_id,consumer_id,api_key_id,status,
    platform,response_status,acquisition_request FROM usage_requests WHERE id=$1 AND idempotency_key=$2`, [result.requestId, key])).rows[0]
  requireValue(owned(saved, owner) && saved.status === 'committed' && saved.response_status === 200 && saved.platform === 'twitter'
    && saved.acquisition_request?.path === '/api/v1/data/search' && saved.acquisition_request.body?.query === query,
  'standard_receipt_unverified')
  const calls = (await pool.query(`SELECT /* twitter-standard:calls */ id,tenant_id,consumer_id,api_key_id,provider_key,
    operation,endpoint_key,outcome,http_status FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY call_ordinal LIMIT 3`, [saved.id])).rows
  requireValue(calls.every(row => owned(row, owner)), 'receipt_owner_mismatch')
  requireValue(calls.every(row => row.outcome === 'succeeded' && row.http_status === 200
    && (!saved.acquisition_request.searchProvider || row.provider_key === saved.acquisition_request.searchProvider)
    && (row.provider_key === 'tikhub' && row.operation === 'native.t.twitter_web_fetch_search_timeline'
      && row.endpoint_key === 'native.t.twitter_web_fetch_search_timeline'
      || row.provider_key === 'rapidapi' && row.operation === 'social.content.search' && row.endpoint_key === 'twitter-aio.search')),
  'provider_receipt_unverified')
  return { supplier: saved.acquisition_request.searchProvider || (calls[0]?.provider_key ?? 'historical'),
    providerCalls: calls.map(row => ({ callId: row.id, provider: row.provider_key, outcome: row.outcome, httpStatus: row.http_status })) }
}

export async function runStandardVerification({ runtime, AppError }) {
  const report = { diagnosticRevision: REVISION, mode: 'execute', originalRequestId: ORIGINAL_REQUEST_ID,
    scope: 'installed_public_service_not_http_ingress', maxSupplierCalls: MAX_SUPPLIER_CALLS,
    budgetScope: 'All saved provider attempts under these four fixed keys, including previous executions.',
    pageSize: 1, originalTaskChanged: false, deltaWrites: 0, versions: [],
    interpretation: 'Full original query through the normal v1/v2 service. Small pages verify delivery, replay and continuation; not full-window coverage or Delta ingestion.' }
  let lock, budget, original, locked = false
  try {
    lock = await runtime.pool.connect()
    locked = (await lock.query("SELECT /* twitter-standard:lock */ pg_try_advisory_lock(hashtext('twitter-standard-check.v1')) AS acquired")).rows[0]?.acquired === true
    requireValue(locked, 'verification_in_progress')
    original = await originalReceipt(runtime.pool)
    const query = original.acquisition_request.body.query
    const context = await runtime.store.findApiKeyById(original.api_key_id)
    requireValue(context?.tenant?.id === original.tenant_id && context?.consumer?.id === original.consumer_id
      && context?.apiKey?.id === original.api_key_id && context.apiKey.environment !== 'test', 'original_owner_unavailable')
    report.querySha256 = sha(query)
    report.supplierCallsBefore = await countSupplierCalls(runtime.pool, original)
    requireValue(report.supplierCallsBefore <= MAX_SUPPLIER_CALLS, 'saved_call_budget_exceeded')
    budget = installCallBudget(runtime, original, AppError)
    for (const version of [1, 2]) {
      const versionReport = { version, pages: [] }; report.versions.push(versionReport)
      const base = { platform: 'twitter', query, pageSize: 1, type: 'stable', ...(version === 2 ? { timeWindow: TIME_WINDOW } : {}) }
      let cursor = null
      const deliveredIds = new Set()
      for (const page of [1, 2]) {
        const body = { ...base, ...(cursor ? { cursor } : {}) }, key = KEYS[(version - 1) * 2 + page - 1]
        const input = { path: `/api/v${version}/data/search`, body, idempotencyKey: key }
        const attemptsAtStart = budget.attempts()
        const first = await runtime.service.search(context, input)
        const summary = { page, ...pageSummary(first, body, version), ...await inspectReceipt(runtime.pool, original, first, key, query) }
        versionReport.pages.push(summary)
        for (const item of first.body.data.items) {
          requireValue(typeof item.id === 'string' && item.id && !deliveredIds.has(item.id), 'duplicate_or_missing_item_identity')
          deliveredIds.add(item.id)
        }
        if (page === 2) summary.bufferedContinuationVerified = summary.providerCalls.length === 0 && budget.attempts() === attemptsAtStart
        const before = await countSupplierCalls(runtime.pool, original), attemptsBefore = budget.attempts()
        const replay = await runtime.service.search(context, input)
        requireValue(replay.replay === true && replay.requestId === first.requestId
          && isDeepStrictEqual(replay.body, first.body)
          && budget.attempts() === attemptsBefore && await countSupplierCalls(runtime.pool, original) === before,
        'same_page_replay_unverified')
        summary.samePageReplayVerified = true
        cursor = first.body.data.pageInfo.nextCursor
        if (!first.body.data.pageInfo.hasMore) break
      }
      versionReport.continuationVerified = versionReport.pages.length === 2
      versionReport.deliveredDistinctCount = deliveredIds.size
    }
    report.standardDeliveryVerified = report.versions.every(row => row.pages.length && row.pages.every(page => page.samePageReplayVerified))
    report.paginationVerified = report.versions.every(row => row.continuationVerified)
  } catch (error) {
    report.errorCode = safeCode(error)
    report.httpStatus = Number.isInteger(error?.status) ? error.status : null
    report.requestId = safeId(error?.details?.blockingRequestId || error?.details?.requestId)
  } finally {
    report.adapterCalls = budget?.attempts() ?? 0
    budget?.restore()
    if (original) {
      try {
        report.supplierCallsAfter = await countSupplierCalls(runtime.pool, original)
        if (report.supplierCallsAfter > MAX_SUPPLIER_CALLS) report.errorCode = 'saved_call_budget_exceeded'
        report.originalUnchanged = isDeepStrictEqual(await originalReceipt(runtime.pool), original)
        if (!report.originalUnchanged) report.errorCode = 'original_receipt_changed'
      } catch { report.errorCode ||= 'final_evidence_unavailable' }
    }
    if (locked) await lock.query("SELECT pg_advisory_unlock(hashtext('twitter-standard-check.v1'))").catch(() => {})
    lock?.release()
  }
  return report
}

export async function main(args = process.argv.slice(2)) {
  let runtime
  try {
    requireValue(args.length === 1 && args[0] === '--execute', 'explicit_execute_required')
    const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
    const { loadConfig } = await import(new URL('config.mjs', root))
    const config = loadConfig()
    requireValue(config.listenerMode === 'public' && config.storeDriver === 'postgres', 'public_postgres_container_required')
    const { TIKHUB_CONTENT_SEARCH_RECIPES } = await import(new URL('contracts/tikhub-content-search.mjs', root))
    const router = await import(new URL('data/twitter-search-routing.mjs', root))
    requireValue(TIKHUB_CONTENT_SEARCH_RECIPES.twitter?.key === 't.twitter_web_fetch_search_timeline'
      && typeof router.createTwitterSearchRouter === 'function', 'needs_deploy')
    const { createRuntime } = await import(new URL('index.mjs', root))
    const { AppError } = await import(new URL('core/errors.mjs', root))
    runtime = await createRuntime(config)
    const report = await runStandardVerification({ runtime, AppError })
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.errorCode || !report.standardDeliveryVerified || !report.paginationVerified) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, errorCode: safeCode(error) })}\n`)
    process.exitCode = 1
  } finally {
    runtime?.agent?.close()
    await runtime?.justOneAdapter?.close()
    await runtime?.store?.close()
    await runtime?.retrievalPool?.end()
    await runtime?.pool?.end()
  }
}

const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
