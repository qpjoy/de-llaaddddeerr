import { AppError } from './errors.mjs'

// Deployment-owned IDs only. Names and request-supplied flags never confer an
// exemption. Empty lists preserve the existing policy for every caller.
export function parseInternalTrafficPolicy(environment) {
  const ids = name => {
    const values = (environment[name] || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean)
    if (values.some(value => !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value))) {
      throw new AppError(500, 'invalid_configuration', `${name} must contain comma-separated UUIDs`)
    }
    return [...new Set(values)]
  }
  return {
    keyIds: ids('MX_INSIGHT_INTERNAL_KEY_IDS'),
    tenantIds: ids('MX_INSIGHT_INTERNAL_TENANT_IDS'),
  }
}

export function createInternalTrafficPolicy({ keyIds = [], tenantIds = [] } = {}) {
  const keys = new Set(keyIds)
  const tenants = new Set(tenantIds)
  return Object.freeze({
    matches({ apiKeyId, tenantId } = {}) {
      return Boolean(apiKeyId && tenantId && (keys.has(apiKeyId) || tenants.has(tenantId)))
    },
  })
}

export function isInternalTraffic(store, context) {
  // accessProfile comes only from the authenticated store record, never a body.
  return context?.apiKey?.accessProfile === 'managed_full' || store.internalTrafficPolicy?.matches({
    apiKeyId: context?.apiKey?.id,
    tenantId: context?.tenant?.id,
  }) === true
}

// User-authorized exception for the original store-authenticated LCY identity.
// A mutable name, another managed Key or a request-supplied flag cannot opt in.
export function isLcyRateCircuitExempt(context) {
  return context?.apiKey?.id === 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83'
    && context.apiKey.accessProfile === 'managed_full'
    && context?.tenant?.id === '277bf8a4-5ed5-414d-b429-d72fcd7d36b6'
    && context?.consumer?.id === 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190'
}

// Retain the stored shared circuit and all non-rate failures. LCY bypasses its
// rate deadline; other internal callers retain the ten-second rate cooldown.
export function internalCircuitState(store, context, state) {
  if (state?.lastErrorCode !== 'upstream_rate_limited') return state
  if (isLcyRateCircuitExempt(context)) return { ...state, rateCircuitExempt: true, circuitOpenUntil: null }
  if (!isInternalTraffic(store, context)) return state
  const failedAt = Date.parse(state.lastFailureAt)
  const until = Date.parse(state.circuitOpenUntil)
  if (!Number.isFinite(failedAt) || !Number.isFinite(until)) return state
  return { ...state, internalCooldown: true, circuitOpenUntil: new Date(Math.min(until, failedAt + 10_000)).toISOString() }
}

export async function acquireTikHubRateLimit(store, context, platformStore, options) {
  if (isInternalTraffic(store, context) || typeof platformStore.acquireProviderRateLimit !== 'function') {
    return { allowed: true, retryAfterMs: 0 }
  }
  return platformStore.acquireProviderRateLimit(options)
}
