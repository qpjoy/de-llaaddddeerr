import { createHash } from 'node:crypto'
import { pathToFileURL } from 'node:url'

// Explicit operator read of one known archive's root error message. The caller
// must supply the exact request, call and previously verified archive SHA-256.
// No generic diagnostic, runtime error or public response gains arbitrary text.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
const SHA = /^[0-9a-f]{64}$/u
const FAILURES = new Set(['invalid_arguments', 'invalid_archive_identity', 'database_url_required',
  'archive_missing_or_scope_mismatch', 'archive_integrity_failed', 'archive_body_invalid', 'archive_message_unavailable'])

export function redactFacebookErrorMessage(value) {
  let text = value
  text = text.replace(/https?:\/\/[^\s"'<>]+/giu, '[URL redacted]')
    .replace(/\bBearer\s+[^\s,;]+/giu, 'Bearer [redacted]')
    .replace(/\b(authorization|cookie|set-cookie|api[-_ ]?key|token|secret|password)\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1=[redacted]')
    .replace(/\b[A-Za-z0-9_-]{24,}(?:\.[A-Za-z0-9_-]{12,})*\b/gu, '[opaque value redacted]')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/gu, ' ')
  return { text, redacted: text !== value }
}

export function projectFacebookFailureMessage(archive) {
  const bytes = archive?.body_bytes instanceof Uint8Array ? Buffer.from(archive.body_bytes) : null
  if (!bytes || bytes.length > 4096 || bytes.length !== archive.body_size
    || createHash('sha256').update(bytes).digest('hex') !== archive.body_sha256) throw new Error('archive_integrity_failed')
  let payload
  try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new Error('archive_body_invalid') }
  if (!payload || Array.isArray(payload) || typeof payload !== 'object' || payload.code !== 301
    || (payload.requestId ?? payload.request_id) !== archive.upstream_request_id) throw new Error('archive_body_invalid')
  if (typeof payload.message !== 'string' || !payload.message.length || payload.message.length > 512) throw new Error('archive_message_unavailable')
  const message = redactFacebookErrorMessage(payload.message)
  return { hashVerified: true, byteLength: bytes.length, sha256: archive.body_sha256,
    businessCode: 301, message: message.text, originalMessageLength: payload.message.length, redacted: message.redacted }
}

export async function readFacebookFailureMessage(pool, { requestId, callId, sha256 }) {
  if (!UUID.test(requestId || '') || !UUID.test(callId || '') || !SHA.test(sha256 || '')) throw new Error('invalid_archive_identity')
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '3s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [archive] } = await client.query(`SELECT r.body_size,r.body_sha256,c.upstream_request_id,
      CASE WHEN r.body_size<=4096 AND octet_length(r.body_bytes)<=4096 THEN r.body_bytes ELSE NULL END AS body_bytes
      FROM control.external_platform_restricted_raw_responses r
      JOIN external_platform.provider_calls c ON c.id=r.provider_call_id
      JOIN public.usage_requests u ON u.id=c.usage_request_id
      WHERE u.id=$1 AND u.platform='facebook' AND c.id=$2 AND r.body_sha256=$3
        AND c.provider_key='justone' AND c.operation='native.j.facebook_post_search_v1'
        AND c.endpoint_key='native.j.facebook_post_search_v1' AND c.outcome='rejected'
        AND c.http_status=200 AND c.business_code=301 AND c.error_code='upstream_collection_failed'`, [requestId, callId, sha256])
    if (!archive) throw new Error('archive_missing_or_scope_mismatch')
    return { diagnosticRevision: 'facebook-failure-message.v1', requestId, callId, ...projectFacebookFailureMessage(archive),
      scope: 'explicit single-archive root message only; supplier statement, not an independently verified internal cause' }
  } catch (error) { throw new Error(FAILURES.has(error.message) ? error.message : 'diagnostic_read_failed') }
  finally {
    if (client) {
      let error
      try { await client.query('ROLLBACK') } catch (cause) { error = cause }
      client.release(error)
      if (error) throw new Error('diagnostic_read_failed')
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const [requestId, callId, sha256, extra] = process.argv.slice(2)
    if (!requestId || !callId || !sha256 || extra) throw new Error('invalid_arguments')
    if (!UUID.test(requestId) || !UUID.test(callId) || !SHA.test(sha256)) throw new Error('invalid_archive_identity')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 4000 })
    console.log(JSON.stringify(await readFacebookFailureMessage(pool, { requestId, callId, sha256 }), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: FAILURES.has(error.message) ? error.message : 'diagnostic_read_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
