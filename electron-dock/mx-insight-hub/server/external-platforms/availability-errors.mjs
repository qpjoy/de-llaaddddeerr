import { AppError } from '../core/errors.mjs'

const ECOMMERCE_CAPACITY = Object.freeze({
  upstream_balance_exhausted: {
    reasonCode: 'ecommerce_service_credit_exhausted',
    message: 'Hub 电商采集额度不足，暂时无法更新商品，请联系管理员处理服务额度。',
  },
  upstream_token_limit_exceeded: {
    reasonCode: 'ecommerce_service_quota_exhausted',
    message: 'Hub 电商采集配额已用完，暂时无法更新商品，请联系管理员处理服务配额。',
  },
  upstream_daily_quota_exceeded: {
    reasonCode: 'ecommerce_service_daily_quota_exhausted',
    message: 'Hub 电商今日采集配额已用完，暂时无法更新商品，请联系管理员核对配额恢复时间。',
  },
})

function circuitTiming(state, config) {
  const until = Date.parse(state?.circuitOpenUntil)
  return {
    ...(Number.isFinite(until) ? {
      circuitOpenUntil: new Date(until).toISOString(),
      retryAfterMs: Math.max(0, until - Date.now()),
    } : {}),
    ...(Number.isSafeInteger(config?.circuitFailureThreshold)
      ? { failureThreshold: config.circuitFailureThreshold } : {}),
  }
}

// Only governed ecommerce callers use this public projection. Provider codes,
// messages and account balances remain in restricted operational evidence.
export function ecommerceCapacityError(errorCode, {
  status = 503, code = 'external_platform_capacity_unavailable', requestDispatched = false,
  state = null, config = null,
} = {}) {
  if (!Object.hasOwn(ECOMMERCE_CAPACITY, errorCode)) return null
  const reason = ECOMMERCE_CAPACITY[errorCode]
  return new AppError(status, code, reason.message, {
    reasonCode: reason.reasonCode, service: 'ecommerce', action: 'contact_administrator',
    requestDispatched, retryable: false,
    ...(state ? circuitTiming(state, config) : {}),
    ...(state && Number.isSafeInteger(config?.circuitOpenMs) && config.circuitOpenMs > 0
      ? { circuitDurationMs: config.circuitOpenMs } : {}),
  })
}

export function upstreamCapacityError(evidence) {
  return new AppError(429, 'external_platform_capacity_exceeded', 'External data capacity is temporarily exhausted', {
    layer: 'upstream',
    reason: 'upstream_rate_limited',
    upstreamDispatched: true,
    upstreamStatus: Number.isInteger(evidence.httpStatus) ? evidence.httpStatus : null,
    // The supplier's account/endpoint threshold is not a Hub quota. Do not
    // misrepresent our configured RPM as the limit that rejected this call.
    limit: null,
    ...(typeof evidence.outcome === 'string' ? { outcome: evidence.outcome } : {}),
    retryable: false,
  })
}

// Circuits open for about a minute after consecutive failures; this window
// comfortably covers the failure that explains a current refusal.
export const FAILURE_EVIDENCE_WINDOW_MS = 15 * 60_000

// Only Hub's normalized upstream classifications are published, never
// supplier messages or arbitrary stored text.
const UPSTREAM_REASON = /^(upstream|invalid_upstream)_[a-z0-9_]{2,60}$/u
const integerOrNull = value => Number.isSafeInteger(value) ? value : null

// The latest settled failure of the protected supplier, as recorded in the
// call ledger. It explains a refusal; it is not proof of a single trigger.
export function failureEvidence(row) {
  if (!row) return null
  const failedAt = Date.parse(row.completedAt ?? row.completed_at ?? row.startedAt ?? row.started_at)
  const errorCode = row.errorCode ?? row.error_code
  return {
    callId: typeof (row.id ?? row.callId) === 'string' ? (row.id ?? row.callId) : null,
    outcome: ['rejected', 'unknown', 'succeeded_unusable'].includes(row.outcome) ? row.outcome : null,
    httpStatus: integerOrNull(row.httpStatus ?? row.http_status),
    businessCode: integerOrNull(row.businessCode ?? row.business_code),
    errorCode: UPSTREAM_REASON.test(errorCode || '') ? errorCode : null,
    billed: typeof row.billed === 'boolean' ? row.billed : null,
    marketplace: typeof row.marketplace === 'string' ? row.marketplace.slice(0, 40) : null,
    failedAt: Number.isFinite(failedAt) ? new Date(failedAt).toISOString() : null,
  }
}

export function circuitOpenError(state, config, message, { scope = null, evidence = null } = {}) {
  const contractScoped = scope === 'platform_contract'
  const internal = !contractScoped && state?.internalCooldown === true
  return new AppError(503, 'external_platform_circuit_open', message, {
    upstreamDispatched: false,
    scope: contractScoped ? 'platform_contract' : internal ? 'internal_caller' : 'shared_upstream',
    // Whose condition this protects against: a failing supplier, or Hub being
    // unable to read a paid supplier response.
    cause: contractScoped ? 'hub_response_parsing' : internal ? 'hub_internal_cooldown' : 'upstream',
    reason: contractScoped ? 'response_contract_unusable'
      : UPSTREAM_REASON.test(state?.lastErrorCode || '') ? state.lastErrorCode : 'upstream_failure',
    ...(evidence ? { upstream: { errorCode: evidence.errorCode, httpStatus: evidence.httpStatus,
      businessCode: evidence.businessCode, outcome: evidence.outcome, billed: evidence.billed, failedAt: evidence.failedAt } } : {}),
    ...circuitTiming(state, config),
    // This is an admission deadline, not proof of supplier recovery or
    // permission to replay a previously dispatched paid request.
    retryable: false,
  })
}

// Shared by every dispatch path that refuses because a circuit is open: the
// platform contract circuit wins, and the recorded failure travels with it.
export async function openCircuitError({ store, state, contract = null, now = Date.now(), config = null, message, marketplace = null }) {
  const open = row => Boolean(row?.circuitOpenUntil && Date.parse(row.circuitOpenUntil) > now)
  const contractOpen = open(contract)
  if (!contractOpen && !open(state)) return null
  let evidence = null
  try {
    evidence = await store?.latestFailureEvidence?.(contractOpen ? { marketplace, unusableOnly: true } : {}) ?? null
  } catch { evidence = null }
  return circuitOpenError(contractOpen ? contract : state, config, message,
    { scope: contractOpen ? 'platform_contract' : null, evidence })
}
