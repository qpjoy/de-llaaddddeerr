// One vocabulary for "why did this response look like this".
//
// The Hub sits between several paid upstream providers and many tenants, so a
// degraded delivery can originate at the delivery policy, the operation-control
// plane, a credential, a circuit, a concurrency guard or the upstream call
// itself. Without a stable name for that origin, a tenant sees only a stale
// body and an operator has to reconstruct the decision from logs.
//
// Every public delivery therefore carries meta.reason, including the healthy
// ones: `live`, `fresh_cache_hit` and `idempotent_replay` are reasons too, so a
// caller never has to infer "nothing went wrong" from the absence of a field.
//
// `scope` says which subsystem made the decision, `degraded` says whether the
// caller received less than a live upstream read, and `liveAttempted` says
// whether Hub actually spent (or tried to spend) an upstream call. These three
// are what triage needs first; `detail` carries the machine-readable evidence.

const REASONS = Object.freeze({
  // Healthy deliveries.
  live: {
    scope: 'upstream',
    summary: 'Served from a fresh upstream call.',
    degraded: false,
    liveAttempted: true,
  },
  fresh_cache_hit: {
    scope: 'delivery_policy',
    summary: 'Served from a snapshot still inside its freshness window; no upstream call was needed.',
    degraded: false,
    liveAttempted: false,
  },
  idempotent_replay: {
    scope: 'idempotency',
    summary: 'Replayed the exact body already delivered for this Idempotency-Key.',
    degraded: false,
    liveAttempted: false,
  },

  // The caller's own delivery policy chose stored data.
  cache_only: {
    scope: 'delivery_policy',
    summary: 'The requested delivery mode allowed stored data, so a stale snapshot was served instead of an upstream call.',
    degraded: true,
    liveAttempted: false,
  },

  // Provider deployment state.
  provider_not_configured: {
    scope: 'provider_credential',
    summary: 'No usable provider credential is configured, so no upstream call could start.',
    degraded: true,
    liveAttempted: false,
  },
  provider_circuit_open: {
    scope: 'circuit_breaker',
    summary: 'The provider circuit is open after repeated failures, so upstream calls are suspended.',
    degraded: true,
    liveAttempted: false,
  },

  // Operation-control plane. These mirror the 503 codes one-to-one so a
  // fallback and a hard rejection are recognisably the same decision.
  external_platform_operation_disabled: {
    scope: 'operation_control',
    summary: 'This operation is disabled in the control plane.',
    degraded: true,
    liveAttempted: false,
  },
  external_platform_operation_shadow: {
    scope: 'operation_control',
    summary: 'This operation is in validation-only shadow mode; customer dispatch is not performed.',
    degraded: true,
    liveAttempted: false,
  },
  external_platform_operation_paused: {
    scope: 'operation_control',
    summary: 'This operation is paused for an incident; stored snapshots remain readable.',
    degraded: true,
    liveAttempted: false,
  },
  external_platform_operation_canary: {
    scope: 'operation_control',
    summary: 'This operation is limited to its canary consumers and this consumer is not on the allowlist.',
    degraded: true,
    liveAttempted: false,
  },
  external_platform_operation_blocked: {
    scope: 'operation_control',
    summary: 'A deployment prerequisite (release, contract gate, credential or reviewed cost evidence) blocks dispatch. See detail.blockers.',
    degraded: true,
    liveAttempted: false,
  },

  // Dispatch de-duplication and in-flight safety.
  previous_outcome_unknown: {
    scope: 'dispatch_dedup',
    summary: 'An equal earlier request has an unknown outcome, so a new upstream call was withheld to avoid double billing.',
    degraded: true,
    liveAttempted: false,
  },
  previous_response_unusable: {
    scope: 'dispatch_dedup',
    summary: 'An equal earlier request was accepted upstream but could not be normalized, so it is not retried automatically.',
    degraded: true,
    liveAttempted: false,
  },
  duplicate_dispatch_suppressed: {
    scope: 'dispatch_dedup',
    summary: 'An equal request is already in flight; this delivery reused its stored snapshot instead of starting a second paid call.',
    degraded: true,
    liveAttempted: false,
  },
  concurrency_guard: {
    scope: 'concurrency',
    summary: 'The global or per-consumer concurrency ceiling was reached, so this delivery fell back to stored data.',
    degraded: true,
    liveAttempted: false,
  },
  provider_rate_limit: {
    scope: 'rate_limit',
    summary: 'The shared provider rate limit was reached, so this delivery fell back to stored data.',
    degraded: true,
    liveAttempted: false,
  },
})

// Upstream failures reuse the provider's own classification. They are the one
// family where the call really was dispatched, so liveAttempted stays true and
// the money may already be spent.
const UPSTREAM_FALLBACK = Object.freeze({
  scope: 'upstream',
  summary: 'The upstream call was attempted and did not yield a usable response, so stored data was served.',
  degraded: true,
  liveAttempted: true,
})

export const DELIVERY_REASON_CODES = Object.freeze(Object.keys(REASONS))

// Rejections reuse this catalog, so the failure path can annotate only the
// codes it really understands instead of defaulting every unrelated error to
// the upstream family.
export const KNOWN_DELIVERY_REASON_CODES = Object.freeze(new Set(DELIVERY_REASON_CODES))

function plainDetail(detail) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return null
  const entries = Object.entries(detail).filter(([, value]) => value !== undefined && value !== null)
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

// A reason is derived, never author-supplied: callers pass the same sourceMode
// and fallbackReason they already record as durable evidence, so the public
// field and the stored delivery row can never disagree.
export function describeDeliveryReason({ sourceMode, fallbackReason = null, detail = null } = {}) {
  const code = fallbackReason
    || (sourceMode === 'live' ? 'live'
      : sourceMode === 'fresh_cache' ? 'fresh_cache_hit'
        : sourceMode === 'idempotent_replay' ? 'idempotent_replay'
          : null)
  if (!code) return null
  const known = REASONS[code] || UPSTREAM_FALLBACK
  const extra = plainDetail(detail)
  return Object.freeze({
    code,
    scope: known.scope,
    summary: known.summary,
    degraded: known.degraded,
    liveAttempted: known.liveAttempted,
    ...(extra ? { detail: Object.freeze(extra) } : {}),
  })
}
