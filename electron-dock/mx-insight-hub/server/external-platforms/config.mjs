import { AppError } from '../core/errors.mjs'

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a positive integer`)
  }
  return parsed
}

function positiveInt32(value, fallback, name) {
  const parsed = positiveInteger(value, fallback, name)
  if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
    throw new AppError(500, 'invalid_configuration', `${name} must not exceed 2147483647`)
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

function commaSeparatedUuidList(value, name) {
  if (value == null || String(value).trim() === '') return []
  const entries = String(value).split(',').map((entry) => entry.trim())
  if (entries.some((entry) => !entry || !UUID_PATTERN.test(entry))) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a comma-separated list of consumer UUIDs`)
  }
  return [...new Set(entries.map((entry) => entry.toLowerCase()))]
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
  const maxConcurrency = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_MAX_CONCURRENCY,
    32,
    'MX_INSIGHT_JUSTONE_MAX_CONCURRENCY',
  )
  const maxConsumerConcurrency = positiveInteger(
    environment.MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY,
    8,
    'MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY',
  )
  if (maxConsumerConcurrency > maxConcurrency) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_JUSTONE_MAX_CONSUMER_CONCURRENCY must not exceed MX_INSIGHT_JUSTONE_MAX_CONCURRENCY',
    )
  }
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
    maxConcurrency,
    maxConsumerConcurrency,
    maxRequestsPerMinute: positiveInt32(
      environment.MX_INSIGHT_JUSTONE_MAX_REQUESTS_PER_MINUTE,
      90,
      'MX_INSIGHT_JUSTONE_MAX_REQUESTS_PER_MINUTE',
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
    maxConcurrency: 32,
    maxConsumerConcurrency: 8,
    maxRequestsPerMinute: 90,
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

function unknownTikHubBilling() {
  return {
    source: 'unknown',
    currency: null,
    pricingAsOf: null,
    unitCostMinor: null,
    unitCostMinorByEndpoint: {},
    monthlyBudgetMinor: null,
  }
}

function parseTikHubBilling(raw) {
  if (raw == null || String(raw).trim() === '') return unknownTikHubBilling()
  let value
  try { value = JSON.parse(raw) } catch {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_TIKHUB_BILLING_JSON must be valid JSON')
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_TIKHUB_BILLING_JSON must be an object')
  }
  const fields = new Set([
    'source', 'currency', 'pricingAsOf', 'unitCostMinor',
    'unitCostMinorByEndpoint', 'monthlyBudgetMinor',
  ])
  const unsupported = Object.keys(value).filter((field) => !fields.has(field))
  if (unsupported.length > 0) {
    throw new AppError(500, 'invalid_configuration', `MX_INSIGHT_TIKHUB_BILLING_JSON contains unsupported field ${unsupported[0]}`)
  }
  if (value.source !== 'manual') {
    throw new AppError(500, 'invalid_configuration', 'TikHub billing source must be manual')
  }
  const currency = String(value.currency || '').toUpperCase()
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw new AppError(500, 'invalid_configuration', 'TikHub billing currency must be a three-letter code')
  }
  const pricedAt = new Date(value.pricingAsOf)
  if (!Number.isFinite(pricedAt.getTime())) {
    throw new AppError(500, 'invalid_configuration', 'TikHub pricingAsOf must be an ISO date')
  }
  const costs = value.unitCostMinorByEndpoint ?? {}
  if (!costs || typeof costs !== 'object' || Array.isArray(costs)) {
    throw new AppError(500, 'invalid_configuration', 'TikHub unitCostMinorByEndpoint must be an object')
  }
  const unitCostMinorByEndpoint = {}
  for (const [endpoint, cost] of Object.entries(costs)) {
    if (!/^[a-z][a-z0-9._-]{0,127}$/u.test(endpoint)) {
      throw new AppError(500, 'invalid_configuration', 'TikHub billing endpoint keys must be stable identifiers')
    }
    unitCostMinorByEndpoint[endpoint] = optionalNonNegativeInteger(
      cost,
      `TikHub unit cost for ${endpoint}`,
    )
  }
  return {
    source: 'manual',
    currency,
    pricingAsOf: pricedAt.toISOString(),
    unitCostMinor: optionalNonNegativeInteger(value.unitCostMinor, 'TikHub unitCostMinor'),
    unitCostMinorByEndpoint,
    monthlyBudgetMinor: optionalNonNegativeInteger(value.monthlyBudgetMinor, 'TikHub monthlyBudgetMinor'),
  }
}

export function parseTikHubConfig(environment = process.env, {
  reservationLeaseMs = positiveInteger(
    environment.MX_INSIGHT_RESERVATION_LEASE_MS,
    150_000,
    'MX_INSIGHT_RESERVATION_LEASE_MS',
  ),
} = {}) {
  const baseUrl = environment.MX_INSIGHT_TIKHUB_BASE_URL?.trim() || 'https://api.tikhub.io'
  if (!['https://api.tikhub.io', 'https://api.tikhub.dev'].includes(baseUrl)) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_TIKHUB_BASE_URL must be https://api.tikhub.io or https://api.tikhub.dev',
    )
  }
  const apiKey = environment.MX_INSIGHT_TIKHUB_API_KEY?.trim() || null
  if (apiKey && apiKey.length > 4_096) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_TIKHUB_API_KEY must not exceed 4096 characters')
  }
  const contractVerified = binaryFlag(
    environment.MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED,
    'MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED',
  )
  const searchContractVerified = binaryFlag(
    environment.MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED,
    'MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED',
  )
  const searchCanaryConsumerIds = commaSeparatedUuidList(
    environment.MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS,
    'MX_INSIGHT_TIKHUB_SEARCH_CANARY_CONSUMER_IDS',
  )
  const configuredSignal = binaryFlag(
    environment.MX_INSIGHT_TIKHUB_CONFIGURED,
    'MX_INSIGHT_TIKHUB_CONFIGURED',
  )
  if (searchContractVerified && !contractVerified) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED requires MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED=1',
    )
  }
  const timeoutMs = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_TIMEOUT_MS,
    30_000,
    'MX_INSIGHT_TIKHUB_TIMEOUT_MS',
  )
  if (timeoutMs > 120_000) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_TIKHUB_TIMEOUT_MS must not exceed 120000')
  }
  if (contractVerified && reservationLeaseMs < timeoutMs + 30_000) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_RESERVATION_LEASE_MS must be at least MX_INSIGHT_TIKHUB_TIMEOUT_MS plus 30000 when the TikHub contract is verified',
    )
  }
  const freshTtlMs = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_FRESH_TTL_MS,
    24 * 60 * 60_000,
    'MX_INSIGHT_TIKHUB_FRESH_TTL_MS',
  )
  const staleTtlMs = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_STALE_TTL_MS,
    30 * 24 * 60 * 60_000,
    'MX_INSIGHT_TIKHUB_STALE_TTL_MS',
  )
  if (staleTtlMs < freshTtlMs) {
    throw new AppError(500, 'invalid_configuration', 'TikHub stale TTL must be greater than or equal to fresh TTL')
  }
  const searchFreshTtlMs = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_SEARCH_FRESH_TTL_MS,
    5 * 60_000,
    'MX_INSIGHT_TIKHUB_SEARCH_FRESH_TTL_MS',
  )
  const searchStaleTtlMs = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_SEARCH_STALE_TTL_MS,
    24 * 60 * 60_000,
    'MX_INSIGHT_TIKHUB_SEARCH_STALE_TTL_MS',
  )
  if (searchStaleTtlMs < searchFreshTtlMs) {
    throw new AppError(
      500,
      'invalid_configuration',
      'TikHub search stale TTL must be greater than or equal to search fresh TTL',
    )
  }
  const searchMaxEnrichItems = optionalNonNegativeInteger(
    environment.MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS,
    'MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS',
  ) ?? 20
  if (searchMaxEnrichItems > 20) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_TIKHUB_SEARCH_MAX_ENRICH_ITEMS must not exceed 20',
    )
  }
  const searchEnrichConcurrency = positiveInteger(
    environment.MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY,
    2,
    'MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY',
  )
  if (searchEnrichConcurrency > 5) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_TIKHUB_SEARCH_ENRICH_CONCURRENCY must not exceed 5',
    )
  }
  const configured = Boolean(apiKey) || configuredSignal
  return {
    baseUrl,
    apiKey,
    configured,
    contractVerified,
    searchContractVerified,
    searchCanaryConsumerIds,
    dispatchEnabled: Boolean(apiKey && contractVerified),
    configurationError: null,
    timeoutMs,
    freshTtlMs,
    staleTtlMs,
    searchFreshTtlMs,
    searchStaleTtlMs,
    searchMaxEnrichItems,
    searchEnrichConcurrency,
    unknownFingerprintCooldownMs: positiveInteger(
      environment.MX_INSIGHT_TIKHUB_UNKNOWN_FINGERPRINT_COOLDOWN_MS,
      15 * 60_000,
      'MX_INSIGHT_TIKHUB_UNKNOWN_FINGERPRINT_COOLDOWN_MS',
    ),
    maxConcurrency: positiveInteger(
      environment.MX_INSIGHT_TIKHUB_MAX_CONCURRENCY,
      8,
      'MX_INSIGHT_TIKHUB_MAX_CONCURRENCY',
    ),
    maxConsumerConcurrency: positiveInteger(
      environment.MX_INSIGHT_TIKHUB_MAX_CONSUMER_CONCURRENCY,
      8,
      'MX_INSIGHT_TIKHUB_MAX_CONSUMER_CONCURRENCY',
    ),
    maxRequestsPerMinute: positiveInt32(
      environment.MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE,
      120,
      'MX_INSIGHT_TIKHUB_MAX_REQUESTS_PER_MINUTE',
    ),
    circuitFailureThreshold: positiveInteger(
      environment.MX_INSIGHT_TIKHUB_CIRCUIT_FAILURES,
      3,
      'MX_INSIGHT_TIKHUB_CIRCUIT_FAILURES',
    ),
    circuitOpenMs: positiveInteger(
      environment.MX_INSIGHT_TIKHUB_CIRCUIT_OPEN_MS,
      60_000,
      'MX_INSIGHT_TIKHUB_CIRCUIT_OPEN_MS',
    ),
    billing: parseTikHubBilling(environment.MX_INSIGHT_TIKHUB_BILLING_JSON),
  }
}

export function disabledTikHubConfig(environment, error) {
  return {
    baseUrl: ['https://api.tikhub.io', 'https://api.tikhub.dev']
      .includes(environment.MX_INSIGHT_TIKHUB_BASE_URL?.trim())
      ? environment.MX_INSIGHT_TIKHUB_BASE_URL.trim()
      : 'https://api.tikhub.io',
    apiKey: null,
    configured: Boolean(environment.MX_INSIGHT_TIKHUB_API_KEY?.trim())
      || environment.MX_INSIGHT_TIKHUB_CONFIGURED === '1',
    contractVerified: environment.MX_INSIGHT_TIKHUB_CONTRACT_VERIFIED === '1',
    searchContractVerified: environment.MX_INSIGHT_TIKHUB_SEARCH_CONTRACT_VERIFIED === '1',
    searchCanaryConsumerIds: [],
    dispatchEnabled: false,
    configurationError: {
      code: 'invalid_configuration',
      message: error instanceof AppError && error.code === 'invalid_configuration'
        ? error.message : 'TikHub configuration is invalid',
    },
    timeoutMs: 30_000,
    freshTtlMs: 24 * 60 * 60_000,
    staleTtlMs: 30 * 24 * 60 * 60_000,
    searchFreshTtlMs: 5 * 60_000,
    searchStaleTtlMs: 24 * 60 * 60_000,
    searchMaxEnrichItems: 20,
    searchEnrichConcurrency: 2,
    unknownFingerprintCooldownMs: 15 * 60_000,
    maxConcurrency: 8,
    maxConsumerConcurrency: 8,
    maxRequestsPerMinute: 120,
    circuitFailureThreshold: 3,
    circuitOpenMs: 60_000,
    billing: unknownTikHubBilling(),
  }
}

export function preflightTikHubConfig(environment = process.env) {
  const config = parseTikHubConfig(environment)
  return {
    configured: config.configured,
    contractVerified: config.contractVerified,
    searchContractVerified: config.searchContractVerified,
    dispatchEnabled: config.dispatchEnabled,
  }
}
