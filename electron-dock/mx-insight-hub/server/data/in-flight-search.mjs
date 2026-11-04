// Another request is held back only while an equal search is actually in
// flight. An ended attempt, even with an unknown outcome, never blocks other
// keys: waiting cannot resolve it and the supplier may be serving normally.
// Same-key replay protection is separate and unchanged.
// A reservation without a recorded lease is treated as in flight for at most
// the protocol lease, so no row can hold indefinitely.
export const IN_FLIGHT_FALLBACK_MS = 5 * 60_000
export const IN_FLIGHT_FALLBACK_SQL = `make_interval(secs=>${IN_FLIGHT_FALLBACK_MS / 1000})`
// The existing 409 hint stays the upper bound.
const MAX_RETRY_AFTER_SECONDS = 300

const time = value => typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value)

export function inFlightUntil({ leaseExpiresAt, reservedAt } = {}) {
  const lease = time(leaseExpiresAt)
  if (Number.isFinite(lease)) return lease
  const reserved = time(reservedAt)
  return Number.isFinite(reserved) ? reserved + IN_FLIGHT_FALLBACK_MS : NaN
}

export function searchInFlight(row, now = Date.now()) {
  const until = inFlightUntil(row)
  return Number.isFinite(until) && until > now
}

export function inFlightRetryAfterSeconds(until, now = Date.now()) {
  const at = time(until)
  if (!Number.isFinite(at)) return MAX_RETRY_AFTER_SECONDS
  return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil((at - now) / 1000)))
}
