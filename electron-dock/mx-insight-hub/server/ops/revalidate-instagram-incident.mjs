// Incident-specific one-shot verification. See docs/operations/instagram-search-rejection-2026-10-14.md.
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'

export const ORIGINAL = 'ddecf6fe-c6e9-4632-9fb6-67014bdf261a'
export const IDEMPOTENCY = 'instagram-one-shot-059572f9-bdf3-4b64-96b9-c7eebd530338'
const CALL = '9618f10d-be5f-49ea-a529-0974de5109f7'
const OPERATION = 'native.t.instagram_v3_general_search'
const PATH = '/api/v1/data/search'
const ADMIN = 'http://127.0.0.1:18151'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const kind = v => v == null ? String(v) : Array.isArray(v) ? 'array' : typeof v
const safeId = v => typeof v === 'string' && UUID.test(v) ? v : null
const count = v => Array.isArray(v) ? v.length : null
const assert = (ok, code) => { if (!ok) throw new Error(code) }
const STATES = new Set(['reserved', 'committed', 'released', 'unknown'])
const ERRORS = new Set(['original_scope_unavailable', 'original_provider_evidence_mismatch', 'original_snapshot_incomplete',
  'public_origin_invalid', 'admin_credential_unavailable', 'admin_request_failed', 'history_identity_or_snapshot_mismatch',
  'demo_identity_mismatch', 'new_request_identity_mismatch', 'invalid_arguments', 'database_url_required'])
const errorCode = error => ERRORS.has(error?.message) ? error.message : 'one_shot_unexpected_failure'
const state = row => row ? { requestId: safeId(row.id), status: STATES.has(row.status) ? row.status : 'other',
  httpStatus: Number.isInteger(row.response_status) ? row.response_status : null } : null

export async function runOneShot({ pool, fetchImpl = fetch, diagnose, env = process.env, execute = false }) {
  const report = { originalRequestId: ORIGINAL, idempotencyKey: IDEMPOTENCY, attempted: false, doNotRetry: true }
  let phase = 'read_original', original
  const read = async fn => {
    const db = await pool.connect()
    try { await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'); return await fn(db) }
    finally { await db.query('ROLLBACK').catch(() => {}); db.release() }
  }
  const existing = db => db.query(`SELECT id, api_key_id, status, response_status FROM public.usage_requests
    WHERE consumer_id=$1 AND idempotency_key=$2`, [original.consumer_id, IDEMPOTENCY]).then(r => r.rows[0])
  try {
    await read(async db => {
      original = (await db.query(`SELECT id, api_key_id, consumer_id, tenant_id, platform, status, acquisition_request
        FROM public.usage_requests WHERE id=$1`, [ORIGINAL])).rows[0]
      assert(original?.platform === 'instagram' && original.status === 'committed' && safeId(original.api_key_id), 'original_scope_unavailable')
      const prior = await existing(db)
      if (prior) { report.existing = state(prior); report.sameOriginalKey = prior.api_key_id === original.api_key_id; return }
      const call = (await db.query(`SELECT id FROM external_platform.provider_calls WHERE id=$1 AND usage_request_id=$2
        AND provider_key='tikhub' AND operation=$3 AND endpoint_key=$3
        AND contract_version='mx-insight-hub.native-forwarding.v1' AND http_status=400 AND business_code=400
        AND upstream_request_id='1843e295-eaf0-4f7b-9d8a-7d6439a12a9b'`, [CALL, ORIGINAL, OPERATION])).rows[0]
      assert(call, 'original_provider_evidence_mismatch')
    })
    if (report.existing || !execute) { report.mode = 'read_only'; return report }
    const snapshot = original.acquisition_request, body = snapshot?.body
    assert(snapshot?.method === 'POST' && snapshot.path === PATH && !snapshot.bodyOmitted && kind(body) === 'object'
      && body.platform === 'instagram' && typeof body.query === 'string' && body.query.trim()
      && Buffer.byteLength(JSON.stringify(body)) <= 16384 && !JSON.stringify(body).includes('[redacted]'), 'original_snapshot_incomplete')
    // Keep the original object intact, including type, pageSize, cursor and omitted defaults.
    let publicUrl
    try { publicUrl = new URL(env.MX_INSIGHT_PUBLIC_URL || '') } catch { throw new Error('public_origin_invalid') }
    assert(publicUrl.protocol === 'https:' && !publicUrl.username && !publicUrl.password
      && !publicUrl.search && !publicUrl.hash && publicUrl.pathname === '/', 'public_origin_invalid')
    assert(typeof env.MX_INSIGHT_ADMIN_TOKEN === 'string' && env.MX_INSIGHT_ADMIN_TOKEN.length >= 32, 'admin_credential_unavailable')
    const adminJson = async (path, data) => {
      const response = await fetchImpl(`${ADMIN}${path}`, { method: data ? 'POST' : 'GET', redirect: 'error',
        signal: AbortSignal.timeout(15000), headers: { 'x-mx-insight-admin-token': env.MX_INSIGHT_ADMIN_TOKEN,
          ...(data ? { 'content-type': 'application/json' } : {}) }, ...(data ? { body: JSON.stringify(data) } : {}) })
      assert(response.ok, 'admin_request_failed'); return (await response.json()).data
    }
    phase = 'read_history'
    const history = await adminJson(`/internal/v1/admin/acquisitions/${ORIGINAL}`)
    assert(history?.requestId === ORIGINAL && history.scope?.platform === 'instagram'
      && history.owner?.apiKeyId === original.api_key_id && history.owner?.consumerId === original.consumer_id
      && history.owner?.tenantId === original.tenant_id
      && isDeepStrictEqual(history.requestEvidence?.request, snapshot), 'history_identity_or_snapshot_mismatch')
    phase = 'mint_original_key'
    const demo = await adminJson('/internal/v1/admin/demo-credentials', { keyId: original.api_key_id })
    assert(demo?.keyId === original.api_key_id && demo.consumerId === original.consumer_id
      && typeof demo.secret === 'string' && demo.secret.startsWith('mih_demo_'), 'demo_identity_mismatch')
    // Recheck after Admin reads, including expired fresh deliveries. Run only one
    // operator invocation; the Public API's fresh replay window is not permanent.
    const prior = await read(existing)
    if (prior) { report.existing = state(prior); report.sameOriginalKey = prior.api_key_id === original.api_key_id; return report }
    phase = 'public_request'
    report.attempted = true
    try {
      const response = await fetchImpl(`${publicUrl.origin}${PATH}`, { method: 'POST', redirect: 'error',
        signal: AbortSignal.timeout(120000), headers: { authorization: `Bearer ${demo.secret}`,
          'content-type': 'application/json', 'idempotency-key': IDEMPOTENCY }, body: JSON.stringify(body) })
      report.httpStatus = response.status
      const payload = await response.json()
      report.httpRequestId = safeId(payload?.requestId)
      report.responseShape = { data: kind(payload?.data), items: kind(payload?.data?.items),
        itemCount: count(payload?.data?.items), rawData: kind(payload?.data?.raw_data),
        pageInfo: kind(payload?.data?.pageInfo), error: kind(payload?.error) }
    } catch { report.outcome = 'unknown_http_result' }
    phase = 'read_result'
    const saved = await read(existing)
    report.saved = state(saved)
    if (saved) {
      assert(saved.api_key_id === original.api_key_id && (!report.httpRequestId || saved.id === report.httpRequestId), 'new_request_identity_mismatch')
      const calls = await read(db => db.query(`SELECT id, provider_key, operation, endpoint_key, http_status, business_code,
        upstream_request_id, billed FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY started_at LIMIT 10`, [saved.id]).then(r => r.rows))
      report.calls = calls.map(c => ({ callId: safeId(c.id), provider: c.provider_key === 'tikhub' ? 'tikhub' : 'other',
        expectedInstagramEndpoint: c.operation === OPERATION && c.endpoint_key === OPERATION,
        httpStatus: Number.isInteger(c.http_status) ? c.http_status : null,
        businessCode: Number.isInteger(c.business_code) ? c.business_code : null,
        upstreamRequestId: safeId(c.upstream_request_id), billed: typeof c.billed === 'boolean' ? c.billed : null }))
      if (diagnose) {
        try { const d = await diagnose(pool, saved.id)
          report.archives = d.evidence.filter(e => e.relation === 'same_request').map(e => ({ callId: safeId(e.callId), projection: e.projection }))
        } catch { report.archiveDiagnostic = 'unavailable' }
      }
    }
    return report
  } catch (error) { return { ...report, stoppedAt: phase, error: errorCode(error) } }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    assert(process.argv.length === 3 && ['--execute-once', '--inspect'].includes(process.argv[2]), 'invalid_arguments')
    assert(process.env.DATABASE_URL, 'database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000,
      options: '-c default_transaction_read_only=on -c statement_timeout=5000 -c lock_timeout=1000' })
    let diagnose
    try { ({ diagnoseInstagramSearch: diagnose } = await import('file:///app/server/ops/diagnose-instagram-search.mjs')) } catch {}
    console.log(JSON.stringify(await runOneShot({ pool, diagnose, execute: process.argv[2] === '--execute-once' }), null, 2))
  } catch (error) { console.error(JSON.stringify({ error: errorCode(error), doNotRetry: true })); process.exitCode = 1 }
  finally { await pool?.end() }
}
