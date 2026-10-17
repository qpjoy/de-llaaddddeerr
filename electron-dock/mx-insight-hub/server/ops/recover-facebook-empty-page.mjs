import { createHash, randomUUID } from 'node:crypto'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { requestFingerprint } from '../core/crypto.mjs'
import { normalizeFacebookSearch, projectFacebookSearch } from '../contracts/facebook-search.mjs'
import { projectDataSearch } from '../contracts/hub-data-search.mjs'
import { deliveredResponseSemanticSha256 } from '../acquisitions/history-store.mjs'

// No supplier, credential, gateway or deployment imports. CLI binding cannot
// be overridden by arguments or environment variables.
export const FACEBOOK_EMPTY_PAGE_CASE = Object.freeze({
  requestId: '274d119a-27df-48de-a193-56211e926137',
  callId: '5152ab7f-20c5-40f6-a094-b43e67c41341',
  restrictedSha256: 'b2875f43b9e11fd43ec68d5c64fbc7c8bcc38864694e51b6f5e330fced0cb27c',
  operationalSha256: 'f8f36f5c399f96d88dd407a6ac6217395cd44f6af840aad8805c923185ffaea8',
  bodySize: 153, deltaStepUuid: 'e09fc550-e30d-4098-aa6e-512e89042579',
})
const OPERATION = 'native.j.facebook_post_search_v1', VERSION = 'facebook-empty-page-recovery.v1'
const SHA = /^[a-f0-9]{64}$/u, iso = value => new Date(value).toISOString()
const hash = value => createHash('sha256').update(value).digest('hex')
const json = value => JSON.parse(JSON.stringify(value))
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
  return JSON.stringify(value === undefined ? null : value)
}
const digest = value => hash(canonical(json(value)))
const fail = code => { throw Object.assign(new Error(code), { code }) }
const requireState = (condition, code) => { if (!condition) fail(code) }
const sameScope = (row, usage) => row && ['tenant_id', 'consumer_id', 'api_key_id'].every(key => row[key] === usage[key])
const count = rows => rows.length
const noCursor = { decode() { fail('recovery_continuation_not_allowed') }, encode() { fail('recovery_continuation_not_allowed') } }

// Parameterized only for isolated synthetic database tests. The exported
// operator entry and CLI below always close over FACEBOOK_EMPTY_PAGE_CASE.
export function createFacebookEmptyPageRecovery(binding) {
  const incident = Object.freeze({ ...binding })
  async function read(client, lock = false) {
    const suffix = lock ? ' FOR UPDATE' : ''
    const one = async (sql, args) => (await client.query(sql, args)).rows[0]
    const usage = await one(`SELECT * FROM usage_requests WHERE id=$1${suffix}`, [incident.requestId])
    requireState(usage, 'recovery_request_missing')
    const calls = (await client.query(`SELECT * FROM external_platform.provider_calls WHERE usage_request_id=$1 ORDER BY id${suffix}`,
      [incident.requestId])).rows
    const charge = await one(`SELECT * FROM billing.customer_charges WHERE usage_request_id=$1${suffix}`, [incident.requestId])
    const account = charge && await one(`SELECT * FROM billing.credit_accounts WHERE id=$1${suffix}`, [charge.account_id])
    const idem = await one(`SELECT * FROM usage_idempotency_bindings WHERE consumer_id=$1 AND idempotency_key=$2${suffix}`,
      [usage.consumer_id, usage.idempotency_key])
    const archive = await one(`SELECT * FROM external_platform.response_archives WHERE provider_call_id=$1${suffix}`, [incident.callId])
    const raw = await one(`SELECT id,provider_call_id,content_type,body_size,body_sha256,captured_at,json_parsed,
      CASE WHEN body_size<=4096 AND octet_length(body_bytes)<=4096 THEN body_bytes ELSE NULL END AS body_bytes
      FROM control.external_platform_restricted_raw_responses WHERE provider_call_id=$1${suffix}`, [incident.callId])
    const objects = (await client.query(`SELECT * FROM external_platform.archive_objects WHERE provider_call_id=$1 ORDER BY item_ordinal${suffix}`,
      [incident.callId])).rows
    const ledger = (await client.query(`SELECT * FROM billing.credit_ledger_entries WHERE usage_request_id=$1 OR charge_id=$2 ORDER BY id`,
      [incident.requestId, charge?.id ?? null])).rows
    const reservations = (await client.query(`SELECT * FROM external_platform.provider_cost_reservations WHERE usage_request_id=$1 ORDER BY id${suffix}`,
      [incident.requestId])).rows
    const receipt = await one('SELECT * FROM control.facebook_empty_page_recoveries WHERE request_id=$1', [incident.requestId])
    const activeLeases = receipt ? [] : (await client.query(`SELECT owner_request_id,expires_at FROM external_platform.dispatch_leases
      WHERE owner_request_id=$1 AND expires_at>now()${suffix}`, [incident.requestId])).rows
    return { usage, calls, charge, account, idem, archive, raw, objects, ledger, reservations, receipt, activeLeases }
  }
  function evidence(state) {
    const { usage: u, calls, archive: a, raw: r, objects, idem } = state
    requireState(count(calls) === 1 && calls[0].id === incident.callId, 'recovery_call_set_changed')
    const call = calls[0]
    requireState(u.platform === 'facebook' && u.acquisition_request?.method === 'POST'
      && u.acquisition_request.path === '/api/v1/data/search'
      && (!u.acquisition_request.facebookFill || state.receipt), 'recovery_request_scope_invalid')
    requireState(sameScope(call, u) && call.request_fingerprint === u.fingerprint && call.provider_key === 'justone'
      && call.operation === OPERATION && call.endpoint_key === OPERATION && call.marketplace === 'facebook'
      && call.contract_version === 'mx-insight-hub.native-forwarding.v1'
      && call.endpoint_version === 'night-all-source-snapshot.2026-09-26', 'recovery_call_scope_invalid')
    if (!state.receipt) requireState(idem && sameScope(idem, u) && idem.fingerprint === u.fingerprint
      && idem.current_request_id === u.id, 'recovery_idempotency_changed')
    requireState(new RegExp(`^delta-page-${incident.deltaStepUuid}-r0-p1-[a-f0-9]{16}$`, 'u').test(u.idempotency_key), 'recovery_delta_step_changed')
    const body = u.acquisition_request.body
    requireState(body?.platform === 'facebook' && ['fresh', 'stable'].includes(body.type ?? 'fresh') && body.cursor == null
      && typeof body.query === 'string' && body.query.trim().length > 0 && body.query.trim().length <= 500
      && Object.keys(body).every(key => ['platform','query','pageSize','type','params'].includes(key)), 'recovery_first_page_required')
    // HubService.search archives the caller body but fingerprints the normalized
    // input: type defaults to fresh, pageSize to 20 and query is trimmed.
    const normalized = { platform: 'facebook', query: body.query.trim(), pageSize: body.pageSize ?? 20,
      ...(body.params !== undefined ? { params: body.params } : {}) }
    const request = normalizeFacebookSearch(normalized, noCursor, { resultType: body.type ?? 'fresh' }, Date.parse(u.reserved_at))
    requireState(requestFingerprint({ method: 'POST', path: u.acquisition_request.path, body: request.fingerprintBody }) === u.fingerprint, 'recovery_request_hash_changed')
    const bytes = r?.body_bytes instanceof Uint8Array ? Buffer.from(r.body_bytes) : null
    requireState(bytes && bytes.length === incident.bodySize && r.body_size === incident.bodySize
      && r.body_sha256 === incident.restrictedSha256 && hash(bytes) === incident.restrictedSha256 && r.json_parsed,
    'recovery_restricted_archive_invalid')
    let payload
    try { payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) } catch { fail('recovery_archive_not_json') }
    requireState(payload.code === 0 && Array.isArray(payload.data?.results) && payload.data.results.length === 0
      && payload.data.business_data === undefined, 'recovery_empty_results_required')
    const projected = projectFacebookSearch(payload.data, request, 'justone', iso(r.captured_at), { allowOverflow: true })
    requireState(projected.items.length === 0 && projected.publicBody.providerPage?.nextProviderCursor === null,
      'recovery_empty_terminal_required')
    const original = a?.raw_payload
    requireState(a && a.contract_state === 'accepted' && a.http_status === 200 && a.business_code === 0
      && a.body_size === incident.bodySize && a.payload_sha256 === incident.operationalSha256
      && original?.kind === 'provider_call_evidence' && original.schemaVersion === 1
      && original.request && !Object.hasOwn(original.request, 'page'), 'recovery_operational_archive_invalid')
    const restored = { ...original, request: { ...original.request, page: null } }
    requireState(hash(canonical(restored)) === incident.operationalSha256
      && original.request.fingerprintSha256 === hash(canonical(request.forProvider('justone').fingerprintBody))
      && original.request.marketplace === 'facebook' && original.request.endpointKey === OPERATION
      && original.request.endpointVersion === call.endpoint_version
      && original.response?.httpStatus === 200 && original.response.businessCode === 0
      && original.response.billed === true && original.response.contractState === 'accepted'
      && original.response.bodySha256 === incident.restrictedSha256 && original.response.bodySize === incident.bodySize
      && iso(original.capturedAt) === iso(r.captured_at) && iso(a.captured_at) === iso(r.captured_at), 'recovery_evidence_hash_changed')
    requireState(objects.length === 1 && objects[0].object_kind === 'response'
      && objects[0].provider_key === 'justone' && objects[0].operation === OPERATION
      && objects[0].marketplace === 'facebook' && objects[0].endpoint_version === call.endpoint_version
      && objects[0].payload_sha256 === incident.operationalSha256 && objects[0].item_ordinal === 0
      && isDeepStrictEqual(objects[0].raw_payload, original), 'recovery_archive_objects_changed')
    requireState(call.billed === true && String(call.cost_minor) === '1' && call.cost_kind === 'estimated'
      && call.currency === 'CNY', 'recovery_procurement_evidence_changed')
    requireState(state.reservations.length === 1 && state.reservations.every(row => row.provider_key === 'justone'
      && row.status === 'released' && row.released_at != null && row.currency === 'CNY'
      && String(row.base_cost_minor) === '0' && String(row.reserved_cost_minor) === '1'
      && String(row.reserved_subsidy_minor) === '0'), 'recovery_procurement_reservation_changed')
    const rawDelivery = { publicBody: { data: { ...projected.publicBody.data, status: 'ok', warnings: [],
      page: { page: 1, pageSize: request.pageSize, returnedCount: 0, hasMore: false, nextCursor: null },
      meta: { upstreamCallCount: 1 } } }, items: [] }
    const response = { data: projectDataSearch(rawDelivery, request).data, requestId: u.id }
    const manifest = { version: 'facebook-fill.v1', scopeHash: request.scopeHash, previousDeliveryId: null, upstreamPages: 1,
      startDate: request.startDate, endDate: request.endDate, sources: [{ callId: incident.callId, providerKey: 'justone',
        bodySize: r.body_size, bodySha256: r.body_sha256, capturedAt: iso(r.captured_at), rowsHash: hash('[]') }] }
    if (state.receipt) requireState(isDeepStrictEqual(u.acquisition_request.facebookFill, manifest), 'recovery_source_manifest_changed')
    return { request, response, manifest, responseHash: deliveredResponseSemanticSha256(response), capturedAt: iso(r.captured_at) }
  }
  function financial(state, completed = false) {
    const { usage: u, charge: c, account: a, ledger } = state
    requireState(c && sameScope(c, u) && c.enforcement_mode === 'enforced' && c.currency === 'CNY'
      && c.billing_unit === 'request' && c.meter_key === 'facebook' && String(c.quoted_minor) === '1', 'recovery_original_price_invalid')
    requireState(a && a.tenant_id === u.tenant_id && a.currency === 'CNY' && (completed || a.status === 'active'), 'recovery_account_unavailable')
    // Later refunds do not erase a historical capture or its read-only receipt.
    const terminal = completed ? ledger.filter(l => l.kind !== 'refund') : ledger
    requireState(terminal.length === (completed ? 2 : 1) && terminal.every(l => l.tenant_id === u.tenant_id
      && l.charge_id === c.id && l.account_id === a.id && l.usage_request_id === u.id && l.currency === 'CNY'
      && String(l.amount_minor) === '1'), 'recovery_original_ledger_changed')
    const hold = terminal.find(l => l.kind === 'hold'), capture = terminal.find(l => l.kind === 'capture')
    requireState(hold && String(hold.available_delta_minor) === '-1' && String(hold.held_delta_minor) === '1', 'recovery_original_hold_missing')
    if (completed) requireState(c.status === 'captured' && String(c.charged_minor) === '1' && c.settled_at && capture
      && String(capture.available_delta_minor) === '0' && String(capture.held_delta_minor) === '-1', 'recovery_capture_receipt_changed')
    else requireState(c.status === 'unknown' && String(c.charged_minor) === '0' && c.settled_at == null
      && BigInt(a.held_minor) >= 1n, 'recovery_charge_not_pending')
  }
  function planned(state, checked) {
    requireState(state.activeLeases.length === 0, 'recovery_original_dispatch_still_active')
    requireState(state.usage.status === 'unknown' && state.usage.response_status == null && state.usage.response_body == null
      && state.usage.error_code == null && state.calls[0].outcome === 'unknown' && state.calls[0].http_status == null
      && state.calls[0].business_code == null && state.calls[0].error_code == null, 'recovery_original_state_changed')
    financial(state)
    const originalState = { usage: state.usage, call: state.calls[0], charge: state.charge, ledger: state.ledger,
      binding: state.idem, reservations: state.reservations, archive: state.archive, objects: state.objects,
      restricted: { ...state.raw, body_bytes: undefined }, account: { id: state.account.id, status: state.account.status, currency: state.account.currency } }
    const dates = state.usage.acquisition_request.body.params ?? {}
    const plan = { revision: VERSION, requestId: incident.requestId, callId: incident.callId,
      deltaStepUuid: incident.deltaStepUuid, originalStateSha256: digest(originalState),
      restrictedSha256: incident.restrictedSha256, operationalSha256: incident.operationalSha256,
      responseSha256: checked.responseHash, capturedAt: checked.capturedAt,
      previousCompletedAt: iso(state.usage.completed_at), previousCallCompletedAt: iso(state.calls[0].completed_at),
      sourceWindow: { startDate: checked.request.startDate, endDate: checked.request.endDate,
        explicitDates: [dates.start_date ?? dates.startDate ?? dates.start ?? dates.startTime,
          dates.end_date ?? dates.endDate ?? dates.end ?? dates.endTime].every(value => value != null && value !== '') },
      result: { status: 200, pageIndex: 1, returnedCount: 0, hasMore: false, nextCursor: null },
      money: { currency: 'CNY', originalQuoteMinor: '1', existingHoldMinor: '1', additionalCaptureMinor: '1', newHoldMinor: '0', refundMinor: '0' },
      supplierCallsMade: 0, historicalSupplierCalls: 1, canonicalQueued: 0,
      preserves: ['restricted_bytes','operational_archive','archive_objects','original_prices','existing_ledger','provider_cost','original_call_timestamps'],
      emptyNoIngestNeeded: true }
    return { plan, previewHash: digest(plan) }
  }
  return async function recover(pool, options = {}) {
    requireState(Object.keys(options).every(key => ['apply','previewHash','reason','show'].includes(key))
      && ['apply','show'].every(key => options[key] === undefined || typeof options[key] === 'boolean')
      && !(options.apply && options.show), 'recovery_invalid_arguments')
    if (options.apply) requireState(SHA.test(options.previewHash || '') && typeof options.reason === 'string'
      && options.reason.trim().length >= 3 && options.reason.length <= 500, 'recovery_apply_requires_hash_and_reason')
    const client = await pool.connect()
    let committing = false, releaseError
    try {
      await client.query(options.apply ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout='10s'")
      await client.query("SET LOCAL lock_timeout='2s'")
      await client.query("SET LOCAL idle_in_transaction_session_timeout='15s'")
      if (options.apply) {
        const first = (await client.query('SELECT consumer_id,idempotency_key FROM usage_requests WHERE id=$1', [incident.requestId])).rows[0]
        requireState(first, 'recovery_request_missing')
        await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${first.consumer_id}:idempotency:${first.idempotency_key}`])
        await client.query('SELECT current_request_id FROM usage_idempotency_bindings WHERE consumer_id=$1 AND idempotency_key=$2 FOR UPDATE',
          [first.consumer_id, first.idempotency_key])
      }
      const state = await read(client, Boolean(options.apply)), checked = evidence(state)
      if (state.receipt) {
        const saved = state.receipt
        requireState(saved.provider_call_id === incident.callId && saved.restricted_sha256 === incident.restrictedSha256
          && saved.operational_sha256 === incident.operationalSha256 && saved.response_sha256 === checked.responseHash
          && state.usage.status === 'committed' && state.usage.response_status === 200
          && deliveredResponseSemanticSha256(state.usage.response_body) === checked.responseHash
          && state.calls[0].outcome === 'succeeded' && state.calls[0].http_status === 200 && state.calls[0].business_code === 0,
        'recovery_completed_receipt_changed')
        financial(state, true)
        if (options.apply) requireState(options.previewHash === saved.preview_sha256, 'recovery_preview_changed')
        requireState(state.ledger.some(row => row.id === saved.receipt.customerCapture?.ledgerId
          && row.kind === 'capture'), 'recovery_capture_receipt_changed')
        await client.query('ROLLBACK')
        return { ...saved.receipt, replay: true, databaseWritesMade: 0,
          currentBindingStillOriginal: state.idem?.current_request_id === incident.requestId }
      }
      const { plan, previewHash } = planned(state, checked)
      if (!options.apply) {
        await client.query('ROLLBACK')
        return { mode: 'dry-run', canApply: true, previewHash, plan, databaseWritesMade: 0 }
      }
      requireState(options.previewHash === previewHash, 'recovery_preview_changed')
      const callUpdate = await client.query(`UPDATE external_platform.provider_calls
        SET outcome='succeeded',http_status=200,business_code=0,item_count=0,error_code=NULL
        WHERE id=$1 AND usage_request_id=$2 AND outcome='unknown' AND http_status IS NULL AND business_code IS NULL RETURNING id`,
      [incident.callId, incident.requestId])
      requireState(callUpdate.rows.length === 1, 'recovery_call_compare_failed')
      const updated = await client.query(`UPDATE usage_requests SET status='committed',response_status=200,response_body=$2,
        units_actual=1,delivery_source_mode='stale',response_captured_at=$3,completed_at=now(),error_code=NULL,
        acquisition_request=acquisition_request || jsonb_build_object('facebookFill',$4::jsonb)
        WHERE id=$1 AND status='unknown' AND response_status IS NULL AND response_body IS NULL RETURNING completed_at`,
      [incident.requestId, checked.response, checked.capturedAt, checked.manifest])
      requireState(updated.rows.length === 1, 'recovery_usage_compare_failed')
      const gatewayId = randomUUID()
      await client.query(`INSERT INTO external_platform.gateway_requests
        (id,provider_key,tenant_id,consumer_id,usage_request_id,request_fingerprint,source_mode,succeeded,response_status,provider_call_id)
        VALUES($1,'justone',$2,$3,$4,$5,'stored_fallback',true,200,$6)`,
      [gatewayId,state.usage.tenant_id,state.usage.consumer_id,incident.requestId,state.usage.fingerprint,incident.callId])
      const captures = (await client.query("SELECT id FROM billing.credit_ledger_entries WHERE usage_request_id=$1 AND kind='capture'", [incident.requestId])).rows
      requireState(captures.length === 1, 'recovery_capture_missing')
      const receipt = { revision: VERSION, mode: 'applied', requestId: incident.requestId, callId: incident.callId, gatewayId,
        previewHash, responseSha256: checked.responseHash, recoveredAt: iso(updated.rows[0].completed_at), capturedAt: checked.capturedAt,
        originalCompletedAt: plan.previousCompletedAt, deltaStepUuid: incident.deltaStepUuid, result: plan.result,
        sourceWindow: plan.sourceWindow,
        customerCapture: { currency: 'CNY', amountMinor: '1', originalQuote: true, ledgerId: captures[0].id }, supplierCallsMade: 0,
        sourceMode: 'recovered_archive',
        historicalSupplierCalls: 1, canonicalQueued: 0, emptyNoIngestNeeded: true, replay: false }
      await client.query(`INSERT INTO control.facebook_empty_page_recoveries
        (request_id,provider_call_id,preview_sha256,restricted_sha256,operational_sha256,response_sha256,previous_state,receipt,actor,reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,'facebook-empty-recovery-cli',$9)`,
      [incident.requestId,incident.callId,previewHash,incident.restrictedSha256,incident.operationalSha256,checked.responseHash,
        { originalStateSha256: plan.originalStateSha256, chargeStatus: 'unknown', money: plan.money,
          usage: Object.fromEntries(['status','units_actual','delivery_source_mode','response_captured_at','response_status','response_body','error_code','completed_at']
            .map(key => [key, state.usage[key] ?? null])),
          call: Object.fromEntries(['outcome','http_status','business_code','item_count','error_code','completed_at'].map(key => [key, state.calls[0][key] ?? null])),
          producerHashVerification: { missingProperty: 'request.page', restoredValue: null, appliedTo: 'verification_only' } },receipt,options.reason.trim()])
      committing = true
      await client.query('COMMIT')
      return receipt
    } catch (error) {
      if (committing) { releaseError = error; fail('recovery_commit_outcome_unknown_use_same_preview_hash') }
      await client.query('ROLLBACK').catch(cause => { releaseError = cause })
      if (/^recovery_[a-z_]+$/u.test(error.code || '')) throw error
      fail('recovery_failed_no_changes_committed')
    } finally { client.release(releaseError) }
  }
}
export const recoverFacebookEmptyPage = createFacebookEmptyPageRecovery(FACEBOOK_EMPTY_PAGE_CASE)
export function recoveryArguments(args) {
  if (!args.length || args.length === 1 && args[0] === '--dry-run') return {}
  if (args.length === 1 && args[0] === '--show') return { show: true }
  if (args.length === 5 && args[0] === '--apply' && args[1] === '--preview-hash' && args[3] === '--reason')
    return { apply: true, previewHash: args[2], reason: args[4] }
  fail('recovery_invalid_arguments')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let pool
  try {
    const options = recoveryArguments(process.argv.slice(2))
    requireState(process.env.DATABASE_URL, 'recovery_database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 12000 })
    console.log(JSON.stringify(await recoverFacebookEmptyPage(pool, options), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: /^recovery_[a-z_]+$/u.test(error.code || '') ? error.code : 'recovery_failed' }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
