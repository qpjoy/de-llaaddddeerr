// Who changed what.
//
// This exists because ADR-0007 removed the command allowlist. The argument for
// removing it was sound — it constrained honest use while `runnerImage`
// accepted any image, so it stopped nobody determined — but it named "admin
// role + sandboxed container + audit" as the replacement, and audit was the one
// of the three that did not exist.
//
// Scope is deliberately narrow. An audit log that records every read and every
// catalog sync is one nobody reads, and an unread log is not a control. Only
// two kinds of change are recorded:
//
//   1. things that decide **what code runs on a real machine**
//      (suite command / image / repo, published packages, registered runners)
//   2. things that decide **who can do that**
//      (member roles, notification channels — redirecting alerts is how a
//       change stays unnoticed)
//
// Catalog syncs, run results and report views are deliberately absent: they are
// high volume, and git already records the first while the run tables record
// the second.

/** Keys whose values must never be written to the audit log. */
const SECRET_KEY = /token|secret|password|passwd|credential|apikey|api_key|authorization|cookie/iu

/**
 * Remove anything credential-shaped, at any depth.
 *
 * Callers are expected to pass already-safe objects — a notification channel
 * goes through `redactChannel` first, and the runner registration handler never
 * passes the token it just minted. This is the second line: an audit table that
 * accumulates secrets is a credential store with no access control and a very
 * long retention period, and the cost of being wrong once is high enough to
 * justify scrubbing generically rather than trusting every call site forever.
 */
export function scrub(value, depth = 0) {
  if (value == null || depth > 6) return null
  if (Array.isArray(value)) return value.slice(0, 100).map((entry) => scrub(entry, depth + 1))
  if (typeof value !== 'object') {
    return typeof value === 'string' ? value.slice(0, 2000) : value
  }
  const output = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_KEY.test(key)) {
      // Recorded as present rather than dropped: "a secret was set here" is
      // itself part of the change someone may need to see.
      output[key] = entry == null || entry === '' ? null : '[redacted]'
      continue
    }
    output[key] = scrub(entry, depth + 1)
  }
  return output
}

/** The client address, for the cases where the account alone is not enough. */
export function sourceIp(request) {
  // Trusting X-Forwarded-For blindly lets a caller write whatever it likes into
  // the audit trail, so the socket address is preferred and the header is only
  // a fallback for the reverse-proxy deployment.
  const direct = request?.socket?.remoteAddress
  if (direct) return String(direct).slice(0, 64)
  const forwarded = request?.headers?.['x-forwarded-for']
  return forwarded ? String(forwarded).split(',')[0].trim().slice(0, 64) : null
}

/**
 * Record one change.
 *
 * Awaited by its callers, and its failure is allowed to propagate. Both writes
 * go to the same database, so "the audit write failed but the mutation
 * succeeded" is a narrow window; and when a security control cannot be
 * recorded, failing loudly is the correct default. The alternative —
 * best-effort audit — degrades to no audit at exactly the moment it matters.
 */
export async function recordAudit(
  store,
  { principal, request, action, resourceType, resourceId, appId = null, before = null, after = null },
) {
  return store.createAuditEvent({
    actorId: principal?.id ?? null,
    actorName: principal?.displayName ?? principal?.id ?? null,
    action,
    resourceType,
    resourceId: resourceId ?? null,
    appId,
    before: before ? scrub(before) : null,
    after: after ? scrub(after) : null,
    sourceIp: sourceIp(request),
  })
}
