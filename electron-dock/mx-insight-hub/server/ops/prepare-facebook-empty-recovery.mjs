import { pathToFileURL } from 'node:url'

// This incident-only dry run reads metadata; it cannot recover, settle or dispatch.
export const FACEBOOK_EMPTY_RECOVERY_CASE = Object.freeze({
  requestId: '274d119a-27df-48de-a193-56211e926137',
  callId: '5152ab7f-20c5-40f6-a094-b43e67c41341',
  sha256: 'b2875f43b9e11fd43ec68d5c64fbc7c8bcc38864694e51b6f5e330fced0cb27c',
})
const UUID_TEXT = '[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}'
const UUID = new RegExp(`^${UUID_TEXT}$`, 'iu')
const DELTA_PAGE = new RegExp(`^delta-page-(${UUID_TEXT})-r(0|[1-9]\\d*)-p([1-9]\\d*)-[0-9a-f]{16}$`, 'u')
const LIMIT = 20
const FAILURES = ['invalid_arguments', 'database_url_required', 'bound_incident_not_found']
const choice = (value, allowed) => value == null ? null : allowed.includes(value) ? value : 'other'
const uuid = value => typeof value === 'string' && UUID.test(value) ? value.toLowerCase() : null
const integer = value => /^-?(0|[1-9]\d*)$/u.test(String(value)) ? String(value) : null
const count = value => integer(value) !== null && Number.isSafeInteger(Number(value)) && Number(value) >= 0 ? Number(value) : null
const currency = value => typeof value === 'string' && /^[A-Z]{3}$/u.test(value) ? value : null
const time = value => {
  if (!(value instanceof Date) && !(typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T[\d:.+-]+Z?$/u.test(value))) return null
  const date = new Date(value)
  return Number.isFinite(date.getTime()) ? date.toISOString() : null
}
const failure = error => new Error(FAILURES.includes(error?.message) ? error.message : 'recovery_precheck_failed')
function boundCase(input) {
  if (!input || Object.keys(input).length !== 3 || Object.keys(FACEBOOK_EMPTY_RECOVERY_CASE).some(key =>
    typeof input[key] !== 'string' || input[key].toLowerCase() !== FACEBOOK_EMPTY_RECOVERY_CASE[key])) throw new Error('invalid_arguments')
  return FACEBOOK_EMPTY_RECOVERY_CASE
}
function deltaStep(key) {
  const match = typeof key === 'string' && key.length <= 256 ? DELTA_PAGE.exec(key) : null
  if (!match || count(match[2]) === null || count(match[3]) === null) return { matched: false }
  return { matched: true, stepUuid: match[1], cursorRestarts: count(match[2]), pageNumber: count(match[3]) }
}
function financialPrediction(charge, ledger, total) {
  const blockers = []
  if (!charge) {
    if (ledger.length) blockers.push('ledger_without_customer_charge_requires_review')
    if (total > LIMIT) blockers.push('ledger_truncated')
    return { state: 'no_customer_charge_needs_review', blockers, currency: null, additionalCaptureMinor: '0',
      basis: 'The current settlement trigger returns without a charge row. Original billing eligibility and complete recovery conditions are not verified; do not create a replacement quote.' }
  }
  const quote = integer(charge.quoted_minor), charged = integer(charge.charged_minor)
  if (quote === null || BigInt(quote) < 0n || charged === null || !currency(charge.currency)) blockers.push('invalid_original_amount')
  if (!charge.scope_matches) blockers.push('customer_charge_scope_mismatch')
  if (!['enforced', 'shadow'].includes(charge.enforcement_mode)) blockers.push('unsupported_billing_mode')
  if (charge.status === 'released') blockers.push('customer_charge_already_released')
  else if (!['unknown', 'reserved', 'captured'].includes(charge.status)) blockers.push('unsupported_charge_status')
  if (total > LIMIT) blockers.push('ledger_truncated')
  if (ledger.some(row => !row.scope_matches)) blockers.push('ledger_scope_mismatch')
  if (ledger.some(row => !['hold', 'capture', 'release', 'refund'].includes(row.kind))) blockers.push('unexpected_ledger_kind_requires_review')
  if (ledger.some(row => row.kind === 'refund')) blockers.push('existing_refund_requires_review')
  const holds = ledger.filter(row => row.kind === 'hold'), captures = ledger.filter(row => row.kind === 'capture')
  const releases = ledger.filter(row => row.kind === 'release')
  const enforcedPositive = charge.enforcement_mode === 'enforced' && quote !== null && BigInt(quote) > 0n
  const amountMatches = (row, available, held) => integer(row.amount_minor) === quote
    && integer(row.available_delta_minor) === available && integer(row.held_delta_minor) === held
  if (enforcedPositive) {
    if (holds.length !== 1 || !amountMatches(holds[0], `-${quote}`, quote)) blockers.push('original_hold_not_proven')
    if (charge.status === 'captured') {
      if (captures.length !== 1 || !amountMatches(captures[0], '0', `-${quote}`) || releases.length || charged !== quote) {
        blockers.push('original_capture_not_proven')
      }
    } else if (charge.status !== 'released') {
      if (captures.length || releases.length || charged !== '0' || charge.settled_at != null) blockers.push('unexpected_financial_settlement')
      if (!charge.account_scope_matches || charge.account_status === 'closed' || charge.account_status == null
        || integer(charge.account_held_minor) === null || BigInt(charge.account_held_minor) < BigInt(quote)) {
        blockers.push('original_hold_account_unavailable')
      }
    }
  } else if (holds.length || captures.length || releases.length || charged !== '0') blockers.push('unexpected_wallet_movement')
  if (blockers.length) return { state: 'blocked', blockers, currency: currency(charge.currency), additionalCaptureMinor: null }
  return { state: charge.status === 'captured' ? 'already_captured_no_new_wallet_movement'
    : enforcedPositive ? 'would_capture_original_quote' : 'would_record_zero_charge', blockers: [],
  currency: currency(charge.currency), additionalCaptureMinor: charge.status === 'captured' || !enforcedPositive ? '0' : quote,
  resultingChargeStatus: 'captured', basis: 'Original immutable request quote; never current prices or returned item count.' }
}

export async function prepareFacebookEmptyRecovery(pool, input = FACEBOOK_EMPTY_RECOVERY_CASE) {
  const { requestId, callId, sha256 } = boundCase(input)
  let client
  try {
    client = await pool.connect()
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '5s'")
    await client.query("SET LOCAL lock_timeout = '1s'")
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '10s'")
    const { rows: [target] } = await client.query(`SELECT /* facebook-empty-recovery:target */
      u.id,u.status,u.response_status,u.response_body IS NOT NULL AS saved_response_present,
      u.reserved_at,u.completed_at,u.idempotency_key,now() AS checked_at,
      c.outcome,c.http_status,c.business_code,c.billed,c.cost_minor,c.cost_kind,c.currency,
      c.started_at,c.completed_at AS call_completed_at,
      (SELECT count(*) FROM external_platform.provider_calls own WHERE own.usage_request_id=u.id) AS own_call_count,
      a.contract_state,a.http_status AS archive_http_status,a.business_code AS archive_business_code,
      r.body_size,r.json_parsed,r.captured_at,
      b.current_request_id,b.updated_at AS binding_updated_at,
      b.tenant_id=u.tenant_id AND b.api_key_id=u.api_key_id AND b.fingerprint=u.fingerprint AS binding_scope_matches
      FROM public.usage_requests u JOIN external_platform.provider_calls c ON c.usage_request_id=u.id
      JOIN control.external_platform_restricted_raw_responses r ON r.provider_call_id=c.id
      LEFT JOIN external_platform.response_archives a ON a.provider_call_id=c.id
      LEFT JOIN public.usage_idempotency_bindings b ON b.consumer_id=u.consumer_id AND b.idempotency_key=u.idempotency_key
      WHERE u.id=$1::uuid AND c.id=$2::uuid AND r.body_sha256=$3
        AND u.platform='facebook' AND u.acquisition_request->>'path'='/api/v1/data/search'
        AND c.provider_key='justone' AND c.operation='native.j.facebook_post_search_v1'
        AND c.endpoint_key='native.j.facebook_post_search_v1' AND c.marketplace='facebook'
        AND c.tenant_id=u.tenant_id AND c.consumer_id=u.consumer_id AND c.api_key_id=u.api_key_id
        AND c.request_fingerprint=u.fingerprint`, [requestId, callId, sha256])
    if (!target) throw new Error('bound_incident_not_found')
    const { rows: [charge] } = await client.query(`SELECT /* facebook-empty-recovery:charge */
      c.id,c.account_id,c.enforcement_mode,c.status,c.currency,c.quoted_minor,c.charged_minor,c.settled_at,
      c.tenant_id=u.tenant_id AND c.consumer_id=u.consumer_id AND c.api_key_id=u.api_key_id AS scope_matches,
      a.status AS account_status,a.held_minor AS account_held_minor,
      a.tenant_id=c.tenant_id AND a.currency=c.currency AS account_scope_matches
      FROM public.usage_requests u JOIN billing.customer_charges c ON c.usage_request_id=u.id
      LEFT JOIN billing.credit_accounts a ON a.id=c.account_id WHERE u.id=$1::uuid`, [requestId])
    const { rows: ledger } = await client.query(`SELECT /* facebook-empty-recovery:ledger */
      l.id,l.kind,l.amount_minor,l.available_delta_minor,l.held_delta_minor,l.currency,l.created_at,
      l.usage_request_id=u.id AND l.charge_id=c.id AND l.tenant_id=c.tenant_id
        AND l.account_id=c.account_id AND l.currency=c.currency AS scope_matches,count(*) OVER () AS total_count
      FROM public.usage_requests u LEFT JOIN billing.customer_charges c ON c.usage_request_id=u.id
      JOIN billing.credit_ledger_entries l ON l.usage_request_id=u.id OR l.charge_id=c.id
      WHERE u.id=$1::uuid ORDER BY l.created_at,l.id LIMIT 21`, [requestId])
    const { rows: reservations } = await client.query(`SELECT /* facebook-empty-recovery:cost-reservations */
      id,provider_key,status,currency,base_cost_minor,reserved_cost_minor,reserved_subsidy_minor,
      created_at,released_at,count(*) OVER () AS total_count
      FROM external_platform.provider_cost_reservations WHERE usage_request_id=$1::uuid
      ORDER BY created_at,id LIMIT 21`, [requestId])
    const ledgerTotal = ledger.length ? count(ledger[0].total_count) : 0
    const reservationTotal = reservations.length ? count(reservations[0].total_count) : 0
    const prediction = financialPrediction(charge, ledger, ledgerTotal)
    const blockers = [...prediction.blockers]
    if (target.status !== 'unknown' || target.outcome !== 'unknown') blockers.push('original_unknown_state_changed')
    if (target.saved_response_present || target.response_status != null) blockers.push('existing_delivery_requires_review')
    if (count(target.own_call_count) !== 1) blockers.push('not_single_original_call')
    if (target.contract_state !== 'accepted' || target.archive_http_status !== 200 || target.archive_business_code !== 0
      || target.body_size !== 153 || target.json_parsed !== true) blockers.push('verified_archive_metadata_changed')
    if (target.current_request_id !== requestId || target.binding_scope_matches !== true) blockers.push('original_idempotency_binding_changed')
    if (reservationTotal > LIMIT) blockers.push('cost_reservations_truncated')
    return { diagnosticRevision: 'facebook-empty-recovery-precheck.v1', mode: 'dry-run', currentStateOnly: true,
      checkedAt: time(target.checked_at), requestId, callId, restrictedSha256: sha256,
      supplierCallsMade: 0, databaseWritesMade: 0, blockers,
      request: { status: choice(target.status, ['reserved', 'committed', 'released', 'unknown']),
        savedHttpStatus: target.response_status, savedResponsePresent: target.saved_response_present,
        reservedAt: time(target.reserved_at), completedAt: time(target.completed_at), ownProviderCallCount: count(target.own_call_count) },
      call: { outcome: choice(target.outcome, ['pending', 'succeeded', 'succeeded_unusable', 'rejected', 'unknown']),
        httpStatus: target.http_status, businessCode: target.business_code, billed: target.billed,
        costMinor: integer(target.cost_minor), costKind: choice(target.cost_kind, ['unknown', 'estimated', 'provider_reported']),
        currency: currency(target.currency), startedAt: time(target.started_at), completedAt: time(target.call_completed_at) },
      archive: { bodySize: count(target.body_size), capturedAt: time(target.captured_at), jsonParsed: target.json_parsed,
        contractState: choice(target.contract_state, ['accepted', 'rejected', 'unknown', 'succeeded_unusable', 'not_dispatched']),
        httpStatus: target.archive_http_status, businessCode: target.archive_business_code,
        evidence: 'Metadata binding only; raw bytes and empty-terminal semantics are not reverified by this script.' },
      idempotencyBinding: { present: target.current_request_id != null, currentRequestId: uuid(target.current_request_id),
        stillPointsToOriginal: target.current_request_id === requestId, scopeMatches: target.binding_scope_matches === true,
        updatedAt: time(target.binding_updated_at) }, deltaPage: deltaStep(target.idempotency_key),
      customerCharge: charge ? { id: uuid(charge.id), accountId: uuid(charge.account_id),
        mode: choice(charge.enforcement_mode, ['enforced', 'shadow']), status: choice(charge.status, ['reserved', 'unknown', 'captured', 'released']),
        currency: currency(charge.currency), quotedMinor: integer(charge.quoted_minor), chargedMinor: integer(charge.charged_minor),
        settledAt: time(charge.settled_at), accountStatus: choice(charge.account_status, ['active', 'suspended', 'closed']),
        accountScopeMatches: charge.account_scope_matches === true } : null,
      financialPrediction: prediction, ledgerTotal, ledgerTruncated: ledgerTotal > LIMIT,
      ledger: ledger.slice(0, LIMIT).map(row => ({ id: uuid(row.id), kind: choice(row.kind, ['hold', 'capture', 'release', 'refund']),
        currency: currency(row.currency), amountMinor: integer(row.amount_minor), availableDeltaMinor: integer(row.available_delta_minor),
        heldDeltaMinor: integer(row.held_delta_minor), scopeMatches: row.scope_matches === true, createdAt: time(row.created_at) })),
      procurementReservationTotal: reservationTotal, procurementReservationsTruncated: reservationTotal > LIMIT,
      procurementReservations: reservations.slice(0, LIMIT).map(row => ({ id: uuid(row.id),
        provider: choice(row.provider_key, ['justone', 'rapidapi']), status: choice(row.status, ['active', 'released']),
        currency: currency(row.currency), baseCostMinor: integer(row.base_cost_minor), reservedCostMinor: integer(row.reserved_cost_minor),
        reservedSubsidyMinor: integer(row.reserved_subsidy_minor), createdAt: time(row.created_at), releasedAt: time(row.released_at) })),
      interpretation: 'Current financial precheck only, not permission or a completed recovery. An empty successful delivery is still one request. Cost reservations are budget holds, not supplier invoices or customer refunds. Keep original archives, prices and ledger entries unchanged.' }
  } catch (error) { throw failure(error) }
  finally {
    if (client) {
      let error
      try { await client.query('ROLLBACK') } catch (cause) { error = cause }
      client.release(error)
      if (error) throw new Error('recovery_precheck_failed')
    }
  }
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  let pool
  try {
    const args = process.argv.slice(2)
    if (args.length !== 0 && args.length !== 3) throw new Error('invalid_arguments')
    const input = args.length ? { requestId: args[0], callId: args[1], sha256: args[2] } : FACEBOOK_EMPTY_RECOVERY_CASE
    boundCase(input)
    if (!process.env.DATABASE_URL) throw new Error('database_url_required')
    const { default: pg } = await import('pg')
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 6000 })
    console.log(JSON.stringify(await prepareFacebookEmptyRecovery(pool, input), null, 2))
  } catch (error) {
    console.error(JSON.stringify({ error: failure(error).message }))
    process.exitCode = 1
  } finally { await pool?.end() }
}
