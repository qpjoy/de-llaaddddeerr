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

export function circuitOpenError(state, config, message) {
  const reasons = new Set(['upstream_rate_limited', 'upstream_auth_or_balance_unavailable',
    'upstream_endpoint_unavailable', 'upstream_http_error'])
  return new AppError(503, 'external_platform_circuit_open', message, {
    upstreamDispatched: false,
    scope: state?.internalCooldown === true ? 'internal_caller' : 'shared_upstream',
    reason: reasons.has(state?.lastErrorCode) ? state.lastErrorCode : 'upstream_failure',
    ...circuitTiming(state, config),
    // This is an admission deadline, not proof of supplier recovery or
    // permission to replay a previously dispatched paid request.
    retryable: false,
  })
}
