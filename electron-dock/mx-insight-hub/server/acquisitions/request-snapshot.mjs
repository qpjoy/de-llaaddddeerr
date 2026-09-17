// The validated Hub request body kept alongside a paid acquisition so a
// delivered run can be reproduced and compared later.
//
// This snapshot is evidence, not a second copy of the request: it holds only
// the caller's parsed JSON body and the route it was sent to. Transport
// headers, the Idempotency-Key, the API Key and every provider credential stay
// out by construction, because they are never passed in.

export const ACQUISITION_REQUEST_MAX_BYTES = 16 * 1024

// Defence in depth for contracts that may grow a credential-shaped field
// later. A body that legitimately carries one of these names loses only that
// value; the rest of the parameters stay reproducible.
const REDACTED_KEY_PATTERN = /(^|[_-])(password|passwd|secret|token|credential|authorization|auth|apikey|api_key|access_key|private_key|signature|sign)($|[_-])/iu

const REDACTED = '[redacted]'

function redact(value, depth = 0) {
  if (Array.isArray(value)) {
    return depth >= 8 ? [] : value.map((entry) => redact(entry, depth + 1))
  }
  if (!value || typeof value !== 'object') return value
  if (depth >= 8) return {}
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
    key,
    REDACTED_KEY_PATTERN.test(key) ? REDACTED : redact(entry, depth + 1),
  ]))
}

/**
 * Build the stored envelope, or null when there is nothing safe to store.
 *
 * An oversized body is recorded as a measured omission rather than silently
 * truncated into JSON that would no longer parse or, worse, look like a
 * complete set of parameters that it is not.
 */
export function acquisitionRequestSnapshot({ method, path, body } = {}) {
  if (typeof method !== 'string' || !method) return null
  if (typeof path !== 'string' || !path) return null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  let redacted
  let serialized
  try {
    redacted = redact(structuredClone(body))
    serialized = JSON.stringify(redacted)
  } catch {
    return null
  }
  if (typeof serialized !== 'string') return null
  const bodyBytes = Buffer.byteLength(serialized, 'utf8')
  if (bodyBytes > ACQUISITION_REQUEST_MAX_BYTES) {
    return { method, path, bodyOmitted: 'oversize', bodyBytes }
  }
  return { method, path, body: redacted }
}
