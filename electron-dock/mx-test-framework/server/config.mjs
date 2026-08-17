import { AppError } from './core/errors.mjs'

export const PRODUCT_ID = 'mx-test-framework'

function positiveInteger(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a positive integer`)
  }
  return parsed
}

// Port 0 is meaningful — it asks the OS for a free port, which is how the test
// suite binds without colliding with a developer's running server.
function portNumber(value, fallback, name) {
  if (value == null || value === '') return fallback
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 65_535) {
    throw new AppError(500, 'invalid_configuration', `${name} must be a port between 0 and 65535`)
  }
  return parsed
}

export function loadConfig(environment = process.env) {
  const databaseUrl = environment.MXT_DATABASE_URL?.trim() || null
  const storeDriver = environment.MXT_STORE || (databaseUrl ? 'postgres' : 'memory')
  if (!['memory', 'postgres'].includes(storeDriver)) {
    throw new AppError(500, 'invalid_configuration', 'MXT_STORE must be memory or postgres')
  }
  if (storeDriver === 'postgres' && !databaseUrl) {
    throw new AppError(500, 'invalid_configuration', 'MXT_DATABASE_URL is required for postgres storage')
  }

  const adminToken = environment.MXT_ADMIN_TOKEN?.trim() || null
  // Refusing to start without a token beats starting wide open: an unauthenticated
  // control plane that can schedule jobs on real machines is not a safe default.
  if (storeDriver === 'postgres' && !adminToken) {
    throw new AppError(500, 'invalid_configuration', 'MXT_ADMIN_TOKEN is required outside memory mode')
  }

  return {
    productId: PRODUCT_ID,
    host: environment.MXT_HOST?.trim() || '0.0.0.0',
    port: portNumber(environment.MXT_PORT, 8790, 'MXT_PORT'),
    storeDriver,
    databaseUrl,
    adminToken,
    artifactsDir: environment.MXT_ARTIFACTS_DIR?.trim() || '/data/artifacts',
    // Where the platform reaches itself. Runner containers report their result
    // back here, so it must be resolvable from inside the cluster.
    selfUrl: (environment.MXT_SELF_URL?.trim() || 'http://mx-test-framework').replace(/\/$/u, ''),
    namespace: environment.MXT_NAMESPACE?.trim() || 'mx-test-framework',
    // Session cookies get the Secure flag unless explicitly told otherwise, so
    // the default is the safe one and plain-HTTP local dev is the exception.
    secureCookies: environment.MXT_INSECURE_COOKIES !== 'true',
    // First login provisions this role. `viewer` means a new account can look
    // but not act until an admin raises it.
    defaultMemberRole: environment.MXT_DEFAULT_ROLE?.trim() || 'viewer',
    artifactRetainDays: positiveInteger(environment.MXT_ARTIFACT_RETAIN_DAYS, 30, 'MXT_ARTIFACT_RETAIN_DAYS'),
    // The scheduler ticks on a timer; the lease bounds how long a claimed run may
    // go silent before it is reclaimed as `timeout`.
    schedulerIntervalMs: positiveInteger(environment.MXT_SCHEDULER_INTERVAL_MS, 60_000, 'MXT_SCHEDULER_INTERVAL_MS'),
    runLeaseMs: positiveInteger(environment.MXT_RUN_LEASE_MS, 1_800_000, 'MXT_RUN_LEASE_MS'),
    defaultTimezone: environment.MXT_DEFAULT_TIMEZONE?.trim() || 'Asia/Shanghai',
    launcher: {
      baseUrl: environment.MXT_LAUNCHER_URL?.trim() || null,
      audience: environment.MXT_LAUNCHER_AUDIENCE?.trim() || 'mx-test-framework',
    },
    runnerImages: {
      cypress: environment.MXT_RUNNER_IMAGE_CYPRESS?.trim() || 'cypress/included:15.0.0',
      playwright:
        environment.MXT_RUNNER_IMAGE_PLAYWRIGHT?.trim() ||
        'mcr.microsoft.com/playwright:v1.56.0-noble',
    },
  }
}
