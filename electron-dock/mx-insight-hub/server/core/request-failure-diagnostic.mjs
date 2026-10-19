// Private, bounded evidence only. Never persist error messages, SQL, stacks,
// request bodies, credentials or arbitrary error properties.
export const REQUEST_FAILURE_PHASES = Object.freeze([
  'admission', 'begin_call', 'provider_request', 'supplier_handoff',
  'project_response', 'stage_evidence', 'finish_step', 'finish_failure',
  'assemble_page', 'build_delivery', 'commit_delivery',
])

export const REQUEST_FAILURE_ERROR_CLASSES = Object.freeze([
  'Error', 'TypeError', 'RangeError', 'SyntaxError', 'AppError', 'RapidApiUpstreamError',
])

export function normalizeRequestFailureId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new TypeError('Invalid request failure identifier')
  }
  return value.toLowerCase()
}

export function normalizeRequestFailureDiagnostic(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || !REQUEST_FAILURE_PHASES.includes(value.phase)
    || !REQUEST_FAILURE_ERROR_CLASSES.includes(value.errorClass)) {
    throw new TypeError('Invalid request failure diagnostic')
  }
  const sqlState = value.sqlState ?? null
  if (sqlState !== null && (typeof sqlState !== 'string' || !/^[0-9A-Z]{5}$/u.test(sqlState))) {
    throw new TypeError('Invalid request failure SQLSTATE')
  }
  return {
    phase: value.phase,
    sqlState,
    callId: value.callId == null ? null : normalizeRequestFailureId(value.callId),
    errorClass: value.errorClass,
  }
}
