#!/usr/bin/env bash
# Read-only incident evidence. Run on a host with kubectl access.
# Optional overrides: HUB_NAMESPACE, HUB_SELECTOR, HUB_CONTAINER.
set -euo pipefail
ns="${HUB_NAMESPACE:-mx-insight-hub}"
selector="${HUB_SELECTOR:-app.kubernetes.io/name=mx-insight-hub-public}"
container="${HUB_CONTAINER:-api}"
kubectl -n "$ns" get pods -l "$selector" -o wide
pod="$(kubectl -n "$ns" get pods -l "$selector" --field-selector=status.phase=Running -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$pod" ]]; then
  echo 'No running Hub public API pod found.' >&2
  exit 1
fi
kubectl -n "$ns" get pod "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.name}{" image="}{.imageID}{" restarts="}{.restartCount}{" started="}{.state.running.startedAt}{"\n"}{end}'
kubectl -n "$ns" exec -i "$pod" -c "$container" -- node --input-type=module <<'NODE'
import pg from 'pg'
const client = new pg.Client({ connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 10000, application_name: 'raw-cursor-readonly-diagnostic' })
const ids = ['cb01dd62-05e3-4823-94af-ad9d5d6dc16e', '9290abbd-c28b-4fac-92cf-a18b10594c57']
const start = '2026-09-15T08:50:00Z'
const end = '2026-09-15T09:05:00Z'
const emit = (label, rows) => console.log(JSON.stringify({ label, rows }, null, 2))
try {
  await client.connect()
  await client.query('BEGIN READ ONLY')
  await client.query("SET LOCAL statement_timeout = '15s'")
  const tables = ['usage_requests', 'serving.connector_calls', 'external_platform.provider_calls']
  for (const table of tables) {
    const exists = await client.query('SELECT to_regclass($1) AS name', [table])
    if (!exists.rows[0].name) throw new Error('missing_diagnostic_table')
  }
  const linked = await client.query(`
    SELECT id::text FROM usage_requests WHERE id::text = ANY($1)
    UNION SELECT usage_request_id::text FROM serving.connector_calls
      WHERE upstream_request_id = ANY($1)
    UNION SELECT id::text FROM usage_requests
      WHERE created_at BETWEEN $2::timestamptz AND $3::timestamptz
        AND response_body->>'requestId' = ANY($1)
  `, [ids, start, end])
  const linkedIds = [...new Set([...ids, ...linked.rows.map(r => r.id).filter(Boolean)])]
  const usage = await client.query(`
    SELECT id, consumer_id, api_key_id, platform, status, response_status,
      error_code, created_at, completed_at,
      response_body->>'requestId' AS body_request_id,
      response_body #>> '{error,code}' AS response_error_code,
      response_body #>> '{data,page,paginationMode}' AS pagination_mode,
      response_body #>> '{data,page,hasMore}' AS has_more,
      CASE WHEN response_body #>> '{data,page,nextCursor}' LIKE 'mxec2.%' THEN 'mxec2'
           WHEN response_body #>> '{data,page,nextCursor}' LIKE 'mxnc1.%' THEN 'mxnc1'
           WHEN response_body #>> '{data,page,nextParams,cursor}' LIKE 'mxnc1.%' THEN 'mxnc1-in-nextParams'
           ELSE 'absent-or-other' END AS cursor_kind
    FROM usage_requests
    WHERE id::text = ANY($1) OR
      (platform = 'xiaohongshu' AND created_at BETWEEN $2::timestamptz AND $3::timestamptz)
    ORDER BY created_at LIMIT 150
  `, [linkedIds, start, end])
  emit('usage (window 16:50–17:05 Asia/Shanghai; max 150 rows)', usage.rows)
  for (const table of tables.slice(1)) {
    // Whitelist metadata; never print response bodies, cursors or credentials.
    const keys = ['id', 'usage_request_id', 'consumer_id', 'operation', 'provider_key',
      'endpoint_key', 'source_mode', 'outcome', 'http_status', 'business_code',
      'error_code', 'failure_kind', 'upstream_request_id', 'started_at', 'completed_at']
    const projection = keys.map(k => `to_jsonb(t)->'${k}' AS "${k}"`).join(', ')
    const result = await client.query(`SELECT ${projection} FROM ${table} t
      WHERE usage_request_id::text = ANY($1)
        OR (started_at BETWEEN $2::timestamptz AND $3::timestamptz
            AND (to_jsonb(t)->>'platform' = 'xiaohongshu' OR operation IN ('social.posts.search', 'raw')))
      ORDER BY started_at LIMIT 150`, [linkedIds, start, end])
    emit(table, result.rows)
  }
  await client.query('ROLLBACK')
} catch (error) {
  // Database error messages can contain connection details; report codes only.
  emit('diagnostic_error', [{ code: error.code || 'diagnostic_failed', name: error.name }])
  process.exitCode = 1
} finally {
  await client.end().catch(() => {})
}
NODE
