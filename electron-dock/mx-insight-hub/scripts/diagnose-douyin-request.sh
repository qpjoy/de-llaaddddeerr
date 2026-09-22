#!/usr/bin/env bash
# Historical evidence only. No acquisition, health probe, retry or settlement.
set -euo pipefail
kubectl -n "${HUB_NAMESPACE:-mx-insight-hub}" exec -i \
  "${HUB_TARGET:-deployment/mx-insight-hub-public}" -c "${HUB_CONTAINER:-api}" \
  -- node --input-type=module <<'NODE'
import pg from 'pg'
import { createHash } from 'node:crypto'
const id = '37bf1066-508d-47c9-9c54-2d572e03a0a5'
const report = { requestId: id, checkedAt: new Date().toISOString() }
const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
try {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' })
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  const rows = (await client.query(`SELECT id, status, platform, error_code, response_status,
    delivery_source_mode, units_actual, reserved_at, completed_at,
    response_body IS NOT NULL AS has_response_body, acquisition_request
    FROM public.usage_requests WHERE id = $1`, [id])).rows
  report.requests = rows.map(({ acquisition_request: snapshot, ...row }) => {
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
    return { ...row, requestSnapshotPresent: !!snapshot, parameters: summary, paginationTokens: tokens,
      requestBodyOmitted: snapshot?.bodyOmitted || null }
  })
  report.connectorCalls = (await client.query(`SELECT id, usage_request_id, operation, platform,
    outcome, http_status, failure_kind, error_code, upstream_request_id, upstream_trace_id,
    upstream_latency_ms, started_at, completed_at,
    NULLIF(to_jsonb(c)->'failure_evidence', 'null'::jsonb) IS NOT NULL AS has_failure_evidence
    FROM serving.connector_calls c WHERE usage_request_id = $1
    ORDER BY started_at LIMIT 50`, [id])).rows
  await client.query('ROLLBACK')
} catch (error) {
  report.error = { name: error.name, code: error.code || 'diagnostic_failed' }
  process.exitCode = 1
} finally { await client.end().catch(() => {}) }
console.log(JSON.stringify(report, null, 2))
NODE
