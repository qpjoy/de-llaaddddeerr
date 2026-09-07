import { AppError } from './core/errors.mjs'

function boundedPositiveInteger(value, fallback, name, maximum) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maximum) {
    throw new AppError(500, 'invalid_configuration', `${name} must be an integer between 1 and ${maximum}`)
  }
  return parsed
}

function boundedNonNegativeInteger(value, fallback, name, maximum) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > maximum) {
    throw new AppError(500, 'invalid_configuration', `${name} must be an integer between 0 and ${maximum}`)
  }
  return parsed
}

// Standalone by design: deployment preflight runs from a clean checkout before
// host-side npm dependencies exist.
export function parseExternalMediaConfig(environment = {}) {
  const config = {
    maxRequests: boundedPositiveInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_MAX_REQUESTS,
      1_200,
      'MX_INSIGHT_EXTERNAL_MEDIA_MAX_REQUESTS',
      100_000,
    ),
    windowMs: boundedPositiveInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_WINDOW_MS,
      60_000,
      'MX_INSIGHT_EXTERNAL_MEDIA_WINDOW_MS',
      86_400_000,
    ),
    maxConsumerConcurrency: boundedPositiveInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_CONSUMER_CONCURRENCY,
      16,
      'MX_INSIGHT_EXTERNAL_MEDIA_CONSUMER_CONCURRENCY',
      64,
    ),
    maxConcurrency: boundedPositiveInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_GLOBAL_CONCURRENCY,
      32,
      'MX_INSIGHT_EXTERNAL_MEDIA_GLOBAL_CONCURRENCY',
      256,
    ),
    cacheBytes: boundedNonNegativeInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_CACHE_BYTES,
      128 * 1024 * 1024,
      'MX_INSIGHT_EXTERNAL_MEDIA_CACHE_BYTES',
      512 * 1024 * 1024,
    ),
    cacheEntries: boundedNonNegativeInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_CACHE_ENTRIES,
      2_048,
      'MX_INSIGHT_EXTERNAL_MEDIA_CACHE_ENTRIES',
      10_000,
    ),
    cacheTtlMs: boundedNonNegativeInteger(
      environment.MX_INSIGHT_EXTERNAL_MEDIA_CACHE_TTL_MS,
      60 * 60_000,
      'MX_INSIGHT_EXTERNAL_MEDIA_CACHE_TTL_MS',
      7 * 86_400_000,
    ),
  }
  if (config.maxConsumerConcurrency > config.maxConcurrency) {
    throw new AppError(
      500,
      'invalid_configuration',
      'MX_INSIGHT_EXTERNAL_MEDIA_CONSUMER_CONCURRENCY must not exceed MX_INSIGHT_EXTERNAL_MEDIA_GLOBAL_CONCURRENCY',
    )
  }
  return config
}
