import { AppError } from './core/errors.mjs'

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a positive integer`)
  }
  return parsed
}

function required(environment, name) {
  const value = environment[name]?.trim()
  if (!value) throw new AppError(500, 'invalid_configuration', `${name} is required`)
  return value
}

export function loadConfig(environment = process.env) {
  const listenerMode = environment.MX_INSIGHT_LISTENER_MODE || 'combined'
  if (!['combined', 'public', 'admin'].includes(listenerMode)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_LISTENER_MODE must be combined, public, or admin')
  }
  const readyMode = environment.NIGHT_ALL_READY_MODE || 'ready_only'
  if (readyMode !== 'ready_only') {
    throw new AppError(500, 'invalid_configuration', 'NIGHT_ALL_READY_MODE must remain ready_only')
  }
  const databaseUrl = environment.DATABASE_URL?.trim() || null
  const storeDriver = environment.MX_INSIGHT_STORE || (databaseUrl ? 'postgres' : 'memory')
  if (!['memory', 'postgres'].includes(storeDriver)) {
    throw new AppError(500, 'invalid_configuration', 'MX_INSIGHT_STORE must be memory or postgres')
  }
  if (storeDriver === 'postgres' && !databaseUrl) {
    throw new AppError(500, 'invalid_configuration', 'DATABASE_URL is required for postgres storage')
  }
  const nightAllTimeoutMs = positiveInteger(environment.NIGHT_ALL_TIMEOUT_MS, 30_000, 'NIGHT_ALL_TIMEOUT_MS')
  return {
    host: environment.MX_INSIGHT_HOST || '0.0.0.0',
    port: positiveInteger(environment.MX_INSIGHT_PORT, 18_180, 'MX_INSIGHT_PORT'),
    listenerMode,
    adminToken: listenerMode === 'public'
      ? environment.MX_INSIGHT_ADMIN_TOKEN?.trim() || null
      : required(environment, 'MX_INSIGHT_ADMIN_TOKEN'),
    apiKeyPepper: required(environment, 'MX_INSIGHT_API_KEY_PEPPER'),
    reservationLeaseMs: positiveInteger(
      environment.MX_INSIGHT_RESERVATION_LEASE_MS,
      Math.max(120_000, nightAllTimeoutMs + 30_000),
      'MX_INSIGHT_RESERVATION_LEASE_MS',
    ),
    storeDriver,
    databaseUrl,
    nightAll: {
      baseUrl: environment.NIGHT_ALL_BASE_URL || 'http://127.0.0.1:13141',
      timeoutMs: nightAllTimeoutMs,
      readyMode,
      serviceToken: environment.NIGHT_ALL_SERVICE_TOKEN || null,
    },
  }
}
