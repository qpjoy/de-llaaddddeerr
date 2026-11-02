import { pathToFileURL } from 'node:url'

export const INCIDENT_REQUEST_ID = 'af456ad4-2523-4f73-a1fc-c95104b329a4'
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value)
const allowed = (value, values) => value == null ? null : values.includes(value) ? value : 'other'
const platforms = ['twitter', 'reddit', 'xiaohongshu', 'instagram', 'weibo', 'kuaishou']
const codes = ['night_all_rejected', 'night_all_http_404', 'invalid_upstream_content_type', 'platform_operation_unsupported']
const status = value => Number.isInteger(value) && value >= 100 && value <= 599 ? value : null

// Standalone, suitable for stdin in an existing Admin image. No HTTP calls,
// request bodies, raw archives, credentials, or mutation of historical receipts.
export async function diagnosePostComments(pool, requestId = INCIDENT_REQUEST_ID) {
  if (!uuid(requestId)) throw new Error('invalid_request_id')
  const client = await pool.connect()
  try {
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    const usage = await client.query(`SELECT id,platform,status,error_code,response_status,
      acquisition_request->>'path' AS path FROM public.usage_requests WHERE id=$1::uuid`, [requestId])
    const calls = await client.query(`SELECT operation,platform,outcome,http_status,error_code
      FROM serving.connector_calls WHERE usage_request_id=$1::uuid ORDER BY started_at,id LIMIT 21`, [requestId])
    return {
      requestId, revision: 'post-comments-diagnostic.v1',
      usage: usage.rows.map(row => ({ platform: allowed(row.platform, platforms),
        status: allowed(row.status, ['reserved', 'committed', 'released', 'unknown']),
        errorCode: allowed(row.error_code, codes), httpStatus: status(row.response_status),
        path: allowed(row.path, ['/api/v1/search/post-comments', '/api/v1/night-all/search/post-comments']) })),
      calls: calls.rows.slice(0, 20).map(row => ({ operation: allowed(row.operation, ['post-comments']),
        platform: allowed(row.platform, platforms), outcome: allowed(row.outcome, ['failed', 'unknown', 'complete', 'partial']),
        httpStatus: status(row.http_status), errorCode: allowed(row.error_code, codes) })),
      truncated: calls.rows.length > 20,
      boundary: 'Saved Hub evidence only; no HTTP. Missing rows do not prove absence of upstream dispatch. Current runtime target and deployed Night-All routes require separate inspection.',
    }
  } finally {
    try { await client.query('ROLLBACK') } finally { client.release() }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length && (args.length !== 2 || args[0] !== '--request-id' || !uuid(args[1]))) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 4000, options: '-c default_transaction_read_only=on -c statement_timeout=3000 -c lock_timeout=1000' })
    console.log(JSON.stringify(await diagnosePostComments(pool, args[1]), null, 2))
  } catch {
    console.error('{"error":"post_comments_diagnostic_failed"}')
    process.exitCode = 1
  } finally { await pool?.end() }
}
