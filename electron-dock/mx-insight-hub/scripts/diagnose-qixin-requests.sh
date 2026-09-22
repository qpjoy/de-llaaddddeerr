#!/usr/bin/env bash
# Read-only evidence for the three reported enterprise requests. No HTTP calls.
# Run on the Hub Kubernetes host; no image update or restart is needed.
set -euo pipefail
kubectl -n "${HUB_NAMESPACE:-mx-insight-hub}" exec -i \
  "${HUB_TARGET:-deployment/mx-insight-hub-public}" \
  -c "${HUB_CONTAINER:-api}" -- node --input-type=module <<'NODE'
import pg from 'pg'

const targets = [
  { apiId: '12.1', name: '商标列表', requestId: 'a227f54a-0ac6-43f5-9d23-687fc369f2ae' },
  { apiId: '77.1', name: '企业供应商信息', requestId: 'a8ff83f0-c297-4034-acb8-5e1652518c45' },
  { apiId: '8.1', name: '专利列表', requestId: '49711b2c-766c-410c-b646-37047e4656b0' },
]
const ids = targets.map(t => t.requestId)
const report = { checkedAt: new Date().toISOString(), targets, sections: {} }
const client = new pg.Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  application_name: 'qixin-request-readonly-diagnostic',
  options: '-c default_transaction_read_only=on -c statement_timeout=10000 -c lock_timeout=2000',
})

// Stored Qixin responses already remove exact credential echoes. Also suppress
// URLs and credential-shaped text here; never export headers or full payloads.
const clean = text => typeof text !== 'string' ? text : text
  .replace(/https?:\/\/[^\s"<>]+/gi, '[url omitted]')
  .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
  .replace(/\b(appkey|api[_-]?key|secret[_-]?key|token|password|sign|authorization)\b\s*[=:：]\s*["']?[^\s,"'}]+/gi, '$1=[redacted]')
  .replace(/\b[a-f0-9]{32,}\b/gi, '[opaque value omitted]')
const safe = value => Array.isArray(value) ? value.map(safe)
  : value && typeof value === 'object' && !(value instanceof Date)
    ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, safe(v)])) : clean(value)

async function columns(table) {
  const [schema, name] = table.split('.')
  const result = await client.query(`SELECT column_name FROM information_schema.columns
    WHERE table_schema = $1 AND table_name = $2`, [schema, name])
  return new Set(result.rows.map(r => r.column_name))
}
async function section(name, run) {
  await client.query('SAVEPOINT diagnostic_section')
  try { report.sections[name] = safe(await run()) }
  catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT diagnostic_section')
    report.sections[name] = { unavailable: true, code: error.code || 'diagnostic_failed' }
  }
  await client.query('RELEASE SAVEPOINT diagnostic_section')
}
async function metadata(table, fields, key = 'usage_request_id', extras = () => []) {
  const available = await columns(table)
  if (!available.has(key)) return { unavailable: true, reason: 'table_or_key_missing_or_not_visible' }
  const projection = fields.filter(f => available.has(f)).map(f => `t."${f}"`)
  projection.push(...extras(available))
  const result = await client.query(`SELECT ${projection.join(', ')} FROM ${table} t
    WHERE t."${key}" = ANY($1::uuid[]) LIMIT 101`, [ids])
  return { rows: result.rows.slice(0, 100), truncated: result.rows.length > 100,
    missingColumns: fields.filter(f => !available.has(f)) }
}
try {
  if (!process.env.DATABASE_URL) throw Object.assign(new Error(), { code: 'DATABASE_URL_missing' })
  await client.connect()
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  await section('usage', () => metadata('public.usage_requests', [
    'id', 'platform', 'capability', 'status', 'error_code', 'response_status',
    'units_reserved', 'units_actual', 'delivery_source_mode', 'reserved_at', 'completed_at',
  ], 'id', cols => [
    ...(cols.has('response_body') ? [
      't.response_body IS NOT NULL AS has_response_body',
      "t.response_body #>> '{error,code}' AS stored_error_code",
    ] : []),
    ...(cols.has('acquisition_request') ? [
      't.acquisition_request IS NOT NULL AS has_request_snapshot',
      "t.acquisition_request->>'path' AS request_path",
      "t.acquisition_request->>'bodyOmitted' AS request_body_omitted",
      "t.acquisition_request #>> '{body,method}' AS requested_method",
      "jsonb_typeof(t.acquisition_request #> '{body,query,name}') AS name_type",
      "length(t.acquisition_request #>> '{body,query,name}') AS name_length",
      "left(t.acquisition_request #>> '{body,query,skip}', 40) AS skip",
      "left(t.acquisition_request #>> '{body,query,role_code}', 40) AS role_code",
      "left(t.acquisition_request #>> '{body,query,role_history}', 40) AS role_history",
    ] : []),
  ]))
  await section('providerCalls', () => metadata('external_platform.provider_calls', [
    'id', 'usage_request_id', 'provider_key', 'operation', 'endpoint_key', 'outcome',
    'http_status', 'business_code', 'error_code', 'upstream_request_id', 'billed',
    'cost_minor', 'cost_kind', 'currency', 'latency_ms', 'started_at', 'completed_at',
  ]))
  await section('connectorCalls', () => metadata('serving.connector_calls', [
    'id', 'usage_request_id', 'platform', 'operation', 'outcome', 'http_status',
    'failure_kind', 'error_code', 'upstream_request_id', 'upstream_trace_id',
    'upstream_latency_ms', 'started_at', 'completed_at',
  ]))
  await section('archives', async () => (await client.query(`
    SELECT p.usage_request_id, a.provider_call_id, a.http_status, a.business_code,
      a.contract_state, a.content_type, a.body_size, a.captured_at
    FROM external_platform.response_archives a
    JOIN external_platform.provider_calls p ON p.id = a.provider_call_id
    WHERE p.usage_request_id = ANY($1::uuid[]) ORDER BY a.captured_at LIMIT 100`, [ids])).rows)
  await section('qixinErrorMessages', async () => (await client.query(`
    SELECT p.usage_request_id, r.provider_call_id, r.json_parsed,
      r.content_type, r.body_size, r.captured_at,
      left(r.parsed_payload->>'status', 40) AS upstream_status,
      left(r.parsed_payload->>'message', 1500) AS upstream_message,
      length(r.parsed_payload->>'message') AS upstream_message_characters
    FROM control.external_platform_restricted_raw_responses r
    JOIN external_platform.provider_calls p ON p.id = r.provider_call_id
    WHERE p.usage_request_id = ANY($1::uuid[]) AND p.provider_key = 'qixin'
      AND p.outcome <> 'succeeded'
    ORDER BY r.captured_at LIMIT 100`, [ids])).rows)
  await section('customerCharges', () => metadata('billing.customer_charges', [
    'usage_request_id', 'status', 'enforcement_mode', 'quoted_minor', 'charged_minor',
    'currency', 'created_at', 'settled_at',
  ]))
  await client.query('ROLLBACK')
} catch (error) {
  report.fatal = { name: error.name, code: error.code || 'diagnostic_failed' }
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
console.log(JSON.stringify(report, null, 2))
NODE
