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
  return store.internalTrafficPolicy?.matches({
    apiKeyId: context?.apiKey?.id,
    tenantId: context?.tenant?.id,
  }) === true
}

// Retain the stored shared circuit. Only the explicitly allowed caller sees a
// shorter admission deadline, and only for an observed upstream rate rejection.
export function internalCircuitState(store, context, state) {
  if (!isInternalTraffic(store, context) || state?.lastErrorCode !== 'upstream_rate_limited') return state
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
