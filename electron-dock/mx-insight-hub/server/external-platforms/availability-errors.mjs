import { AppError } from '../core/errors.mjs'

export function upstreamCapacityError(evidence) {
  return new AppError(429, 'external_platform_capacity_exceeded', 'External data capacity is temporarily exhausted', {
    reason: 'upstream_rate_limited',
    upstreamDispatched: true,
    upstreamStatus: Number.isInteger(evidence.httpStatus) ? evidence.httpStatus : null,
    // The supplier's account/endpoint threshold is not a Hub quota. Do not
    // misrepresent our configured RPM as the limit that rejected this call.
    limit: null,
    retryable: false,
  })
}

export function circuitOpenError(state, config, message) {
  const until = Date.parse(state?.circuitOpenUntil)
  const reasons = new Set(['upstream_rate_limited', 'upstream_auth_or_balance_unavailable',
    'upstream_endpoint_unavailable', 'upstream_http_error'])
  return new AppError(503, 'external_platform_circuit_open', message, {
    upstreamDispatched: false,
    scope: state?.internalCooldown === true ? 'internal_caller' : 'shared_upstream',
    reason: reasons.has(state?.lastErrorCode) ? state.lastErrorCode : 'upstream_failure',
    ...(Number.isFinite(until) ? {
      circuitOpenUntil: new Date(until).toISOString(),
      retryAfterMs: Math.max(0, until - Date.now()),
    } : {}),
    ...(Number.isSafeInteger(config?.circuitFailureThreshold)
      ? { failureThreshold: config.circuitFailureThreshold } : {}),
    // This is an admission deadline, not proof of supplier recovery or
    // permission to replay a previously dispatched paid request.
    retryable: false,
  })
}
