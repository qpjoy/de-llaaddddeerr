import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Incident-specific, read-only preflight. Run in the updated Public container.
// It verifies one snapshot, not a reservation or permission to bypass admission.
// The Delta consumer must reject receipts older than 30 minutes and keep its
// original page key/body; normal Hub guards still run on any resumed request.
export const RECOVERY = Object.freeze({
  revision: 'delta-raw-admission-recovery.v1',
  planKey: '6905bd48-7324-4602-9c06-4b77994f93d9',
  runKey: '65a9f174-e611-4032-a759-fb64efcb540e',
  blockerRequestId: '8ebd9f58-f6b6-4f8a-b8fe-db94c1068c09',
  idempotencyKeySha256: 'c7ef520abe008e7c8ba0555bdddd496a0b055e37bc37dd97bd0323884afa1c00',
  payloadSha256: '40ba477e6e7b6bbb5c58bdf40c978daa6d03d9bd3931a5637c78f7d2ad5ff43b',
})
const EXPECTED_PROTOCOL_STORE_SHA256 = '439490f908a1caf65211cd7e1562c719e05cbe667141cc1d83c164923389713b'
const FAILURES = ['invalid_arguments', 'database_url_required', 'runtime_source_unavailable',
  'runtime_source_mismatch', 'blocker_not_found', 'preflight_read_failed']
const safeFailure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'preflight_read_failed')
const runtimeRoot = () => process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/`) : new URL('../../', import.meta.url)

function protocolStoreSha256(root) {
  let bytes
  try {
    const file = new URL('server/data/search-protocol-store.mjs', root)
    const stat = statSync(file)
    if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error()
    bytes = readFileSync(file)
  } catch { throw new Error('runtime_source_unavailable') }
  const hash = createHash('sha256').update(bytes).digest('hex')
  if (hash !== EXPECTED_PROTOCOL_STORE_SHA256) throw new Error('runtime_source_mismatch')
  return hash
}

export async function verifyDeltaRawAdmissionRecovery(pool, { root = runtimeRoot() } = {}) {
  const codeHash = protocolStoreSha256(root)
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    // Every connector is considered. An extra matching or contradictory call
    // defeats this narrow proof. JSON null is not a missing SQL snapshot.
    // Key absence is checked across the consumer, regardless of platform,
    // API Key, status or date; neither a sample nor a response UUID can prove it.
    const { rows: [row] } = await client.query(`SELECT /* delta-raw-admission-recovery:proof */
      clock_timestamp() AS database_now,
      COALESCE(request.platform='twitter' AND request.status='unknown'
        AND request.acquisition_request IS NULL
        AND (request.capability IS NULL OR request.capability='')
        AND request.billing_meter_key='raw' AND request.fingerprint ~ '^[0-9a-f]{64}$'
        AND EXISTS (SELECT 1 FROM serving.connector_calls call WHERE call.usage_request_id=request.id
          AND call.consumer_id=request.consumer_id AND call.platform=request.platform
          AND call.request_fingerprint=request.fingerprint AND call.operation='raw' AND call.outcome='unknown'
          AND NOT EXISTS (SELECT 1 FROM serving.connector_calls other
            WHERE other.usage_request_id=request.id AND other.id<>call.id)), false) AS legacy_raw_verified,
      NOT EXISTS (SELECT 1 FROM public.usage_requests candidate
        WHERE candidate.consumer_id=request.consumer_id
          AND encode(sha256(convert_to(candidate.idempotency_key,'UTF8')),'hex')=$2::text)
      AND NOT EXISTS (SELECT 1 FROM public.usage_idempotency_bindings candidate
        WHERE candidate.consumer_id=request.consumer_id
          AND encode(sha256(convert_to(candidate.idempotency_key,'UTF8')),'hex')=$2::text)
      AND NOT EXISTS (SELECT 1 FROM control.data_search_protocol_bindings candidate
        WHERE candidate.consumer_id=request.consumer_id
          AND encode(sha256(convert_to(candidate.idempotency_key,'UTF8')),'hex')=$2::text)
      AND NOT EXISTS (SELECT 1 FROM control.data_search_protocol_leases candidate
        WHERE candidate.consumer_id=request.consumer_id
          AND encode(sha256(convert_to(candidate.idempotency_key,'UTF8')),'hex')=$2::text) AS page_identity_absent
      FROM public.usage_requests request WHERE request.id=$1::uuid`,
    [RECOVERY.blockerRequestId, RECOVERY.idempotencyKeySha256])
    if (!row) throw new Error('blocker_not_found')
    const checkedAt = row.database_now instanceof Date ? row.database_now : new Date(
      typeof row.database_now === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(row.database_now) ? row.database_now : NaN)
    if (!Number.isFinite(checkedAt.getTime())) throw new Error('preflight_read_failed')
    protocolStoreSha256(root)
    const legacyRawVerified = row.legacy_raw_verified === true
    const pageIdentityAbsent = row.page_identity_absent === true
    return { ...RECOVERY, checkedAt: checkedAt.toISOString(), protocolStoreSha256: codeHash,
      legacyRawVerified, pageIdentityAbsent, ready: legacyRawVerified && pageIdentityAbsent }
  } catch (error) { throw safeFailure(error) }
  finally {
    if (client) {
      let rollbackError
      try { await client.query('ROLLBACK') } catch (error) { rollbackError = error }
      try { client.release(rollbackError) } catch { throw new Error('preflight_read_failed') }
      if (rollbackError) throw new Error('preflight_read_failed')
    }
  }
}

if (process.argv[1] === '-' || process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    if (process.argv.slice(2).length) throw new Error('invalid_arguments')
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    protocolStoreSha256(runtimeRoot())
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      query_timeout: 6000, options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
    const receipt = await verifyDeltaRawAdmissionRecovery(pool)
    await pool.end(); pool = null
    console.log(JSON.stringify(receipt, null, 2))
    if (!receipt.ready) process.exitCode = 1
  } catch (error) {
    console.error(JSON.stringify({ error: safeFailure(error).message }))
    process.exitCode = 1
  } finally {
    await pool?.end().catch(() => {
      console.error('{"error":"preflight_read_failed"}')
      process.exitCode = 1
    })
  }
}
