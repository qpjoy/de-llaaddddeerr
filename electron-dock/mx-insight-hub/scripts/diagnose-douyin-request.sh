#!/usr/bin/env bash
# Historical evidence only. No acquisition, health probe, retry or settlement.
set -euo pipefail
kubectl -n "${HUB_NAMESPACE:-mx-insight-hub}" exec -i \
  "${HUB_TARGET:-deployment/mx-insight-hub-public}" -c "${HUB_CONTAINER:-api}" \
  -- node --input-type=module - "$@" <<'NODE'
import pg from 'pg'
import { createHash } from 'node:crypto'
import { createNightAllCompatibilityCursorCodec } from './server/external-platforms/cursor.mjs'
import { prepareNightAllCompatibilityTraversal, capNightAllCompatibilityTraversal } from './server/data/night-all-pagination.mjs'
const ids = process.argv.slice(2)
if (!ids.length) ids.push('37bf1066-508d-47c9-9c54-2d572e03a0a5')
if (ids.length > 10 || ids.some(id => !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))) {
  throw new Error('Pass 1-10 Hub request UUIDs')
}
const report = { diagnosticVersion: 3, requestId: ids[0], requestIds: ids, checkedAt: new Date().toISOString(),
  configuredNightAllTimeoutMs: /^\d+$/.test(process.env.NIGHT_ALL_TIMEOUT_MS || '') ? Number(process.env.NIGHT_ALL_TIMEOUT_MS) : null,
  runtimeHost: process.env.HOSTNAME || null }
// Exercise this running instance's code using synthetic data; never dispatch.
const probeCodec = createNightAllCompatibilityCursorCodec('offline-pagination-probe-only', 'offline-probe')
const probeOptions = { operation: 'raw', platform: 'douyin', codec: probeCodec }
const probeRequest = { platform: 'douyin', query: 'offline-probe', count: 20 }
const first = prepareNightAllCompatibilityTraversal({ ...probeOptions, upstreamBody: probeRequest })
const wrapped = capNightAllCompatibilityTraversal({ data: { page: {
  hasMore: true, paginationMode: 'compound', nextCursor: '8',
  nextParams: { search_id: 'offline-search', backtrace: 'offline-backtrace' },
} } }, { ...probeOptions, page: first.page, scope: first.scope, upstreamBody: first.upstreamBody })
const next = prepareNightAllCompatibilityTraversal({ ...probeOptions,
  upstreamBody: { ...probeRequest, cursor: wrapped.data.page.nextCursor } })
report.runtimeCompoundProbe = {
  preservesCursor: next.upstreamBody.cursor === '8',
  preservesSearchId: next.upstreamBody.params?.search_id === 'offline-search',
  preservesBacktrace: next.upstreamBody.params?.backtrace === 'offline-backtrace',
  paidCalls: 0,
}
const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
try {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' })
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const rows = (await client.query(`SELECT id, consumer_id, status, platform, error_code, response_status,
    delivery_source_mode, units_actual, reserved_at, completed_at,
    response_body IS NOT NULL AS has_response_body, acquisition_request
    FROM public.usage_requests WHERE id = ANY($1::uuid[]) ORDER BY reserved_at`, [ids])).rows
  report.missingRequestIds = ids.filter(id => !rows.some(row => row.id === id))
  report.requests = rows.map(({ acquisition_request: snapshot, consumer_id: consumerId, ...row }) => {
    const body = snapshot?.body || {}
    const params = body.params || {}
    const summary = {}
    for (const key of ['platform', 'count', 'limit', 'page', 'pageSize']) {
      const value = body[key]
      if (typeof value === 'number' || (typeof value === 'string' && /^[a-z0-9_-]{1,40}$/i.test(value))) summary[key] = value
    }
    for (const key of ['count', 'limit', 'page', 'pageSize', 'offset', 'sort_type', 'publish_time']) {
      if (typeof params[key] === 'number' || (typeof params[key] === 'string' && /^-?\d{1,16}$/.test(params[key]))) summary[`params.${key}`] = params[key]
    }
    const tokens = {}
    for (const [label, value] of [['cursor', body.cursor], ['params.cursor', params.cursor], ['params.search_id', params.search_id]]) {
      if (value != null) tokens[label] = { type: typeof value, length: String(value).length,
        sha256: createHash('sha256').update(String(value)).digest('hex') }
    }
    let cursorState = { status: 'absent' }
    const token = body.cursor || params.cursor
    if (token) {
      cursorState = { status: 'not_hub_compatibility_cursor' }
      if (typeof token === 'string' && token.startsWith('mxnc1.')) {
        cursorState = { status: 'secret_unavailable' }
        if (process.env.MX_INSIGHT_API_KEY_PEPPER) {
          try {
            const codec = createNightAllCompatibilityCursorCodec(process.env.MX_INSIGHT_API_KEY_PEPPER, consumerId)
            const state = codec.decode(token)
            const continuation = state.continuation || {}
            const group = continuation.type === 'params' ? continuation.value : continuation.params
            const primary = continuation.type === 'cursor' ? continuation.value : continuation.cursor
            cursorState = {
              status: 'authenticated',
              platformMatchesRequest: state.platform === row.platform,
              operationIsRaw: state.operation === 'raw',
              operation: ['raw', 'crawl', 'user-info', 'data-search'].includes(state.operation) ? state.operation : 'unknown',
              page: Number.isInteger(state.page) ? state.page : null,
              type: ['cursor', 'params', 'page'].includes(continuation.type) ? continuation.type : 'unknown',
              hasPrimaryCursor: primary != null && primary !== '',
              numericCursor: /^\d{1,16}$/.test(String(primary ?? '')) ? String(primary) : null,
              hasSearchId: group?.search_id != null && group.search_id !== '',
              hasBacktrace: group?.backtrace != null && group.backtrace !== '',
            }
          } catch { cursorState = { status: 'decode_failed_key_rotation_or_invalid_token' } }
        }
      }
    }
    const path = typeof snapshot?.path === 'string' && /^\/api\/v1\/[\w/-]{1,160}$/.test(snapshot.path) ? snapshot.path : null
    return { ...row, requestPath: path,
      durationMs: row.completed_at && row.reserved_at ? new Date(row.completed_at) - new Date(row.reserved_at) : null,
      querySha256: typeof body.query === 'string' ? createHash('sha256').update(body.query.trim()).digest('hex') : null,
      requestSnapshotPresent: !!snapshot, parameters: summary, paginationTokens: tokens, cursorState,
      requestBodyOmitted: snapshot?.bodyOmitted || null }
  })
  // Each optional ledger is independent: missing permissions/schema must not look like no calls.
  async function section(name, sql, project = row => row) {
    await client.query('SAVEPOINT diagnostic_section')
    try {
      const result = (await client.query(sql, [ids])).rows
      report[name] = result.slice(0, 150).map(project)
      report[`${name}Truncated`] = result.length > 150
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT diagnostic_section')
      report[`${name}Error`] = { code: error.code || 'query_failed' }
    }
    await client.query('RELEASE SAVEPOINT diagnostic_section')
  }
  let projectEvidence = () => null
  try {
    const module = await import('./server/data/night-all-failure-evidence.mjs')
    projectEvidence = module.projectNightAllFailureEvidence
    report.failureEvidenceReaderAvailable = true
  } catch { report.failureEvidenceReaderAvailable = false }
  await section('connectorCalls', `SELECT id, usage_request_id, operation, platform,
    outcome, http_status, failure_kind, error_code, upstream_request_id, upstream_trace_id,
    upstream_latency_ms, started_at, completed_at,
    NULLIF(to_jsonb(c)->'failure_evidence', 'null'::jsonb) IS NOT NULL AS has_failure_evidence,
    to_jsonb(c)->'failure_evidence' AS failure_evidence
    FROM serving.connector_calls c WHERE usage_request_id = ANY($1::uuid[])
    ORDER BY started_at LIMIT 151`, row => ({ ...row, failure_evidence: projectEvidence(row.failure_evidence) }))
  await section('providerCalls', `SELECT id, usage_request_id, provider_key, operation, endpoint_key,
    outcome, http_status, business_code, error_code, upstream_request_id,
    billed, latency_ms, started_at, completed_at
    FROM external_platform.provider_calls WHERE usage_request_id = ANY($1::uuid[])
    ORDER BY started_at LIMIT 151`)
  await section('customerCharges', `SELECT usage_request_id, status, enforcement_mode,
    quoted_minor::text, charged_minor::text, currency, created_at, settled_at
    FROM billing.customer_charges WHERE usage_request_id = ANY($1::uuid[]) LIMIT 151`)
  await section('deliveredPageSummaries', `SELECT id, response_body #> '{data,pageInfo}' AS page_info,
    response_body #> '{data,page}' AS page, response_body #>> '{data,status}' AS status,
    response_body #> '{data,warnings}' AS warnings, response_body #> '{data,meta}' AS meta
    FROM public.usage_requests WHERE id = ANY($1::uuid[]) AND response_body IS NOT NULL`, row => {
      const page = row.page_info || row.page || {}
      return { requestId: row.id,
        envelope: row.page_info ? 'pageInfo' : row.page ? 'page' : 'absent',
        status: ['ok', 'partial', 'failed'].includes(row.status) ? row.status : null,
        returnedCount: Number.isInteger(page.returnedCount) ? page.returnedCount : null,
        hasMore: typeof page.hasMore === 'boolean' ? page.hasMore : null,
        hasNextCursor: typeof page.nextCursor === 'string' && !!page.nextCursor,
        warningCodes: (Array.isArray(row.warnings) ? row.warnings : [])
          .map(w => w?.code).filter(code => typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(code)).slice(0, 20),
        providerCalls: Number.isInteger(row.meta?.providerCalls) ? row.meta.providerCalls : null,
        errorCode: typeof row.meta?.error?.code === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(row.meta.error.code) ? row.meta.error.code : null,
      }
    })
  await client.query('ROLLBACK')
} catch (error) {
  report.error = { name: error.name, code: error.code || 'diagnostic_failed' }
  process.exitCode = 1
} finally { await client.end().catch(() => {}) }
console.log(JSON.stringify(report, null, 2))
NODE
