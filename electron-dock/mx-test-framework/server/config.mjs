import { AppError } from './core/errors.mjs'
import { loadSecretKey } from './secrets.mjs'

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
    // The address a person can actually open. `selfUrl` is the in-cluster name
    // and is useless in a chat message, so notifications need their own.
    // Unset means alerts carry no link — degraded but not broken.
    publicUrl: (environment.MXT_PUBLIC_URL?.trim() || '').replace(/\/$/u, ''),
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
    // Name of a k8s Secret holding a `token` key used to clone private repos.
    // Optional: without it, only public repositories can be checked out, and a
    // private one fails as `blocked` with that reason rather than hanging.
    gitTokenSecret: environment.MXT_GIT_TOKEN_SECRET?.trim() || null,
    // Encryption key for the credential store, as a 32-byte Buffer. Parsed and
    // validated here rather than at first use: a malformed key should stop the
    // deploy, not surface weeks later as a run that cannot log in.
    // Null means the platform will refuse to hold secrets at all — see
    // server/secrets.mjs for why refusing beats storing them in plaintext.
    secretKey: loadSecretKey(environment),
    // Cap on the per-run checkout + node_modules scratch space. The workspace is
    // an emptyDir, so this is what stops one runaway install from filling the
    // node's disk and taking every other Job down with it.
    workspaceSizeLimit: environment.MXT_WORKSPACE_SIZE_LIMIT?.trim() || '10Gi',
    // A server run does more than drive a browser: it installs the dependency
    // tree and, for a self-contained suite like `pnpm e2e:local`, runs a
    // production bundler first. 4Gi was sized for Chromium alone and a Quasar
    // build will exceed it — an OOMKill there reads as a mysterious `blocked`.
    // No CPU limit: the build wants every core it can get and throttling it
    // only makes the run longer without protecting anything.
    runnerResources: {
      cpuRequest: environment.MXT_RUNNER_CPU_REQUEST?.trim() || '1',
      memoryRequest: environment.MXT_RUNNER_MEMORY_REQUEST?.trim() || '2Gi',
      memoryLimit: environment.MXT_RUNNER_MEMORY_LIMIT?.trim() || '8Gi',
    },
    // One default image per engine. Pinned versions, never `latest`: the image
    // is part of what a result means, and a base image that changes underneath
    // a suite turns a green run red for reasons nobody can reconstruct.
    //
    // A suite can name its own `runnerImage` instead, which is what makes the
    // platform open-ended — `generic` exists precisely for stacks that have no
    // default here, and a `generic` suite without an image is refused rather
    // than guessed at.
    runnerImages: {
      cypress: environment.MXT_RUNNER_IMAGE_CYPRESS?.trim() || 'cypress/included:15.0.0',
      playwright:
        environment.MXT_RUNNER_IMAGE_PLAYWRIGHT?.trim() ||
        'mcr.microsoft.com/playwright:v1.56.0-noble',
      'playwright-electron':
        environment.MXT_RUNNER_IMAGE_PLAYWRIGHT?.trim() ||
        'mcr.microsoft.com/playwright:v1.56.0-noble',
      // Plain pytest. A suite that drives a browser from Python overrides this
      // with mcr.microsoft.com/playwright/python, which ships the browsers.
      pytest: environment.MXT_RUNNER_IMAGE_PYTEST?.trim() || 'python:3.12-slim',
      k6: environment.MXT_RUNNER_IMAGE_K6?.trim() || 'grafana/k6:0.58.0',
      generic: environment.MXT_RUNNER_IMAGE_GENERIC?.trim() || null,
    },
  }
}
