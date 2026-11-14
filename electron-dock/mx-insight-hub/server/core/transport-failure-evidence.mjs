// Project stored operational metadata only. Exception text, URLs and arbitrary
// codes must never cross the Admin diagnostic boundary.
const CODES = new Set([
  'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT',
  'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ERR_TLS_CERT_ALTNAME_INVALID',
  'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET', 'UND_ERR_ABORTED', 'ABORT_ERR',
  'proxy_route_unavailable', 'proxy_routes_unreachable',
  '08000', '08001', '08003', '08004', '08006', '08007', '08P01',
  '42501', '42703', '42P01', '53300', '53400', '57P01', '57P02', '57P03',
])
const integer = value => Number.isSafeInteger(value) && value >= 0 ? value : null

export function projectTransportFailure(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const codes = Array.isArray(value.codes) ? value.codes.slice(0, 32) : []
  return {
    phase: value.phase == null ? null : ['request', 'body'].includes(value.phase) ? value.phase : 'other',
    codes: [...new Set(codes.filter(code => CODES.has(code)))],
    unrecognizedCodes: codes.some(code => !CODES.has(code)),
    codesTruncated: Array.isArray(value.codes) && value.codes.length > 32,
    deadlineExceeded: typeof value.deadlineExceeded === 'boolean' ? value.deadlineExceeded : null,
    elapsedMs: integer(value.elapsedMs),
    timeoutMs: integer(value.timeoutMs),
  }
}
