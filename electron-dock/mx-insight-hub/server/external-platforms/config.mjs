import { AppError } from '../core/errors.mjs'

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a positive integer`)
  }
  return parsed
}

function optionalNonNegativeInteger(value, name) {
  if (value == null || value === '') return null
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a non-negative safe integer`)
  }
  return parsed
}

function binaryFlag(value, name) {
  if (value == null || value === '') return false
  if (value !== '0' && value !== '1') {
    throw new AppError(500, 'invalid_configuration', `${name} must be 0 or 1`)
  }
  return value === '1'
}

function unknownJustOneBilling() {
  return {
    source: 'unknown',
    currency: null,
    pricingAsOf: null,
    freeDailyCalls: null,
    monthlyBudgetMinor: null,
    unitCostMinorByEndpoint: {},
  }
}

function parseJustOneBilling(raw) {
  if (raw == null || String(raw).trim() === '') {
    return unknownJustOneBilling()
  }
  let value
  try { value = JSON.parse(raw) } catch {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_JUSTONE_BILLING_JSON must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_JUSTONE_BILLING_JSON must be an object')
  }
  const supported = new Set([
    'source', 'currency', 'pricingAsOf', 'freeDailyCalls',
    'monthlyBudgetMinor', 'unitCostMinorByEndpoint',
  ])
  const unknown = Object.keys(value).filter((key) => !supported.has(key))
  if (unknown.length > 0) {
    throw new AppError(500, 'invalid_configuration', `MX_INSIGHT_JUSTONE_BILLING_JSON contains unsupported field ${unknown[0]}`)
  }
  if (value.source != null && value.source !== 'manual') {
    throw new AppError(500, 'invalid_configuration', 'JustOne billing source must be manual until a provider API is verified')
  }
  const currency = value.currency == null ? null : String(value.currency).toUpperCase()
  if (currency != null && !/^[A-Z]{3}$/.test(currency)) {
    throw new AppError(500, 'invalid_configuration', 'JustOne billing currency must be a three-letter code')
  }
  let pricingAsOf = null
  if (value.pricingAsOf != null) {
    pricingAsOf = new Date(value.pricingAsOf)
    if (Number.isNaN(pricingAsOf.getTime())) {
      throw new AppError(500, 'invalid_configuration', 'JustOne pricingAsOf must be an ISO date')
    }
    pricingAsOf = pricingAsOf.toISOString()
  }
  const costs = value.unitCostMinorByEndpoint ?? {}
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    throw new AppError(500, 'invalid_configuration', 'JustOne unitCostMinorByEndpoint must be an object')
  }
  const unitCostMinorByEndpoint = {}
  for (const [endpoint, cost] of Object.entries(costs)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/.test(endpoint)) {
      throw new AppError(500, 'invalid_configuration', 'JustOne billing endpoint keys must be stable identifiers')
    }
    unitCostMinorByEndpoint[endpoint] = optionalNonNegativeInteger(
      cost,
      `JustOne unit cost for ${endpoint}`,
    )
  }
  if (Object.keys(unitCostMinorByEndpoint).length > 0 && (!currency || !pricingAsOf)) {
    throw new AppError(
      500,
      'invalid_configuration',
      'JustOne estimated prices require currency and pricingAsOf',
    )
  }
  return {
    source: 'manual',
    currency,
    pricingAsOf,
    freeDailyCalls: optionalNonNegativeInteger(value.freeDailyCalls, 'JustOne freeDailyCalls'),
    monthlyBudgetMinor: optionalNonNegativeInteger(
      value.monthlyBudgetMinor,
      'JustOne monthlyBudgetMinor',
    ),
    unitCostMinorByEndpoint,
  }
}

export function parseJustOneConfig(environment = process.env, {
  reservationLeaseMs = positiveInteger(
    environment.MX_INSIGHT_RESERVATION_LEASE_MS,
    150_000,
    'MX_INSIGHT_RESERVATION_LEASE_MS',
  ),
} = {}) {
  const token = environment.MX_INSIGHT_JUSTONE_TOKEN?.trim() || null
  if (token && token.length > 4_096) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_TOKEN must not exceed 4096 characters',
    )
  }
  const configuredSignal = binaryFlag(
    environment.MX_INSIGHT_JUSTONE_CONFIGURED,
    'MX_INSIGHT_JUSTONE_CONFIGURED',
  )
  const contractVerified = binaryFlag(
    environment.MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED,
    'MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED',
  )
  const timeoutMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_TIMEOUT_MS,
    120_000,
    'MX_INSIGHT_JUSTONE_TIMEOUT_MS',
  )
  if (timeoutMs > 120_000) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_TIMEOUT_MS must not exceed 120000',
    )
  }
  const freshTtlMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_FRESH_TTL_MS,
    60_000,
    'MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
  )
  const staleTtlMs = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_STALE_TTL_MS,
    7 * 86_400_000,
    'MX_INSIGHT_JUSTONE_STALE_TTL_MS',
  )
  if (staleTtlMs < freshTtlMs) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_STALE_TTL_MS must be greater than or equal to MX_INSIGHT_JUSTONE_FRESH_TTL_MS',
    )
  }
  if (contractVerified && reservationLeaseMs < timeoutMs + 30_000) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_RESERVATION_LEASE_MS must be at least MX_INSIGHT_JUSTONE_TIMEOUT_MS plus 30000 when the JustOne contract is verified',
    )
  }
  const configured = Boolean(token) || configuredSignal
  return {
    // The provider host and endpoint paths are compiled into the adapter.
    // Keeping them out of env prevents this paid connector from becoming an
    // arbitrary URL proxy. Absence of a token disables only this provider.
    token,
    // Split listeners keep the paid credential on the public data plane. The
    // admin plane receives only these non-secret deployment facts.
    configured,
    contractVerified,
    dispatchEnabled: Boolean(token && contractVerified),
    configurationError: null,
    timeoutMs,
    freshTtlMs,
    staleTtlMs,
    unknownFingerprintCooldownMs: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_UNKNOWN_FINGERPRINT_COOLDOWN_MS,
      15 * 60_000,
      'MX_INSIGHT_JUSTONE_UNKNOWN_FINGERPRINT_COOLDOWN_MS',
    ),
    maxConcurrency: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_MAX_CONCURRENCY,
      8,
      'MX_INSIGHT_JUSTONE_MAX_CONCURRENCY',
    ),
    maxConsumerConcurrency: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY,
      2,
      'MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY',
    ),
    circuitFailureThreshold: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES,
      3,
      'MX_INSIGHT_JUSTONE_CIRCUIT_FAILURES',
    ),
    circuitOpenMs: positiveInteger(
      environment.MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS,
      60_000,
      'MX_INSIGHT_JUSTONE_CIRCUIT_OPEN_MS',
    ),
    billing: parseJustOneBilling(environment.MX_INSIGHT_JUSTONE_BILLING_JSON),
  }
}

function safeJustOneConfigurationError(error) {
  return {
    code: 'invalid_configuration',
    message: error instanceof AppError && error.code === 'invalid_configuration'
      ? error.message
      : 'JustOne configuration is invalid',
  }
}

export function disabledJustOneConfig(environment, error) {
  return {
    token: null,
    configured: Boolean(environment.MX_INSIGHT_JUSTONE_TOKEN?.trim())
      || environment.MX_INSIGHT_JUSTONE_CONFIGURED === '1',
    contractVerified: environment.MX_INSIGHT_JUSTONE_CONTRACT_VERIFIED === '1',
    dispatchEnabled: false,
    configurationError: safeJustOneConfigurationError(error),
    timeoutMs: 120_000,
    freshTtlMs: 60_000,
    staleTtlMs: 7 * 86_400_000,
    unknownFingerprintCooldownMs: 15 * 60_000,
    maxConcurrency: 8,
    maxConsumerConcurrency: 2,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
    billing: unknownJustOneBilling(),
  }
}

// Deployment scripts call this strict entry point before changing ConfigMaps.
// Unlike loadConfig(), it deliberately rejects a bad optional-provider config.
export function preflightJustOneConfig(environment = process.env) {
  const config = parseJustOneConfig(environment)
  return {
    configured: config.configured,
    contractVerified: config.contractVerified,
    dispatchEnabled: config.dispatchEnabled,
  }
}
