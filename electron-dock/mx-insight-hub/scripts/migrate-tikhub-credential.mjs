import { createHash } from 'node:crypto'
import { constants as fsConstants } from 'node:fs'
import { lstat, open } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DEFAULT_NIGHT_ALL_CONFIG = '/Users/qpjoy/workspace/mingxi/Night-All/config.json'
const DEFAULT_ADMIN_BASE = 'http://127.0.0.1:18151'
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_API_KEY_BYTES = 4_096
const PROVIDERS = Object.freeze([
  { provider: 'tikhub', configKey: 'tikhub' },
  { provider: 'justone', configKey: 'justOne' },
])

function migrationError(message) {
  const error = new Error(message)
  error.code = 'tikhub_credential_migration_failed'
  return error
}

export function normalizeAdminBase(value) {
  let parsed
  try { parsed = new URL(value || DEFAULT_ADMIN_BASE) } catch {
    throw migrationError('MX_INSIGHT_ADMIN_BASE_URL must be a loopback HTTP origin')
  }
  const loopback = parsed.hostname === '127.0.0.1'
    || parsed.hostname === '[::1]'
    || parsed.hostname === '::1'
    || parsed.hostname === 'localhost'
  if (parsed.protocol !== 'http:' || !loopback || parsed.username || parsed.password
    || parsed.search || parsed.hash || (parsed.pathname !== '' && parsed.pathname !== '/')) {
    throw migrationError('MX_INSIGHT_ADMIN_BASE_URL must be a loopback HTTP origin')
  }
  return parsed.origin
}

async function readPrivateJson(configPath) {
  const pathInfo = await lstat(configPath).catch(() => null)
  if (!pathInfo?.isFile() || pathInfo.isSymbolicLink()) {
    throw migrationError('Night-All config must be an existing regular file, not a symlink')
  }

  if (!Number.isInteger(fsConstants.O_NOFOLLOW)) {
    throw migrationError('This runtime cannot safely open the Night-All config without following symlinks')
  }

  let handle
  try {
    handle = await open(configPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
  } catch {
    throw migrationError('Night-All config could not be opened safely without following symlinks')
  }

  try {
    const info = await handle.stat()
    if (!info.isFile() || info.dev !== pathInfo.dev || info.ino !== pathInfo.ino) {
      throw migrationError('Night-All config changed during security validation')
    }
    if ((info.mode & 0o077) !== 0) {
      throw migrationError('Night-All config permissions must exclude group and other access (for example chmod 600)')
    }
    if (typeof process.getuid === 'function' && info.uid !== process.getuid()) {
      throw migrationError('Night-All config must be owned by the current operating-system user')
    }
    if (info.size <= 0 || info.size > MAX_CONFIG_BYTES) {
      throw migrationError(`Night-All config must be between 1 and ${MAX_CONFIG_BYTES} bytes`)
    }

    const raw = await handle.readFile()
    const afterRead = await handle.stat()
    if (raw.byteLength !== info.size || afterRead.size !== info.size) {
      throw migrationError('Night-All config changed while it was being read')
    }
    try {
      return JSON.parse(raw.toString('utf8'))
    } catch {
      throw migrationError('Night-All config is not valid JSON')
    }
  } finally {
    await handle.close()
  }
}

function readProviderApiKey(parsed, { configKey }) {
  const apiKey = parsed?.crawlerProviders?.[configKey]?.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim() || Buffer.byteLength(apiKey.trim()) > MAX_API_KEY_BYTES) {
    throw migrationError(`Night-All crawlerProviders.${configKey}.apiKey is missing or invalid`)
  }
  return apiKey.trim()
}

export async function readNightAllExternalPlatformCredentials(configPath, {
  providers = PROVIDERS.map(({ provider }) => provider),
} = {}) {
  const requested = providers.map((provider) => {
    const definition = PROVIDERS.find((candidate) => candidate.provider === provider)
    if (!definition) throw migrationError(`Unsupported external-platform credential ${provider}`)
    return definition
  })
  const parsed = await readPrivateJson(configPath)
  return Object.fromEntries(requested.map((definition) => [
    definition.provider,
    readProviderApiKey(parsed, definition),
  ]))
}

export async function readNightAllTikHubCredential(configPath, options = {}) {
  const credentials = await readNightAllExternalPlatformCredentials(configPath, {
    ...options,
    providers: ['tikhub'],
  })
  return credentials.tikhub
}

export function credentialFingerprintTail(apiKey) {
  return createHash('sha256').update(apiKey, 'utf8').digest('hex').slice(-8)
}

async function adminRequest(base, adminToken, method, path, body) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      'x-mx-insight-admin-token': adminToken,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok) {
    throw migrationError(`Hub Admin ${method} ${path} returned HTTP ${response.status}`)
  }
  return payload?.data
}

export async function migrateTikHubCredential(environment = process.env) {
  const result = await migrateExternalPlatformCredentials(environment, { providers: ['tikhub'] })
  const tikhub = result.providers[0]
  if (result.dryRun) {
    return { dryRun: true, source: 'night-all-config', expectedRevision: tikhub.expectedRevision }
  }
  return { dryRun: false, source: tikhub.source, revision: tikhub.revision }
}

export async function migrateExternalPlatformCredentials(environment = process.env, {
  providers = PROVIDERS.map(({ provider }) => provider),
} = {}) {
  const configPath = environment.NIGHT_ALL_CONFIG_PATH || DEFAULT_NIGHT_ALL_CONFIG
  const adminToken = environment.MX_INSIGHT_ADMIN_TOKEN
  if (typeof adminToken !== 'string' || adminToken.length < 32 || /[\r\n]/u.test(adminToken)) {
    throw migrationError('MX_INSIGHT_ADMIN_TOKEN must be present and at least 32 characters')
  }
  const base = normalizeAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL)
  const credentials = await readNightAllExternalPlatformCredentials(configPath, {
    providers,
  })

  // Resolve every target revision before the first write so invalid source or
  // target configuration cannot produce an avoidable partial migration.
  const targets = await Promise.all(providers.map(async (provider) => {
    const detail = await adminRequest(
      base,
      adminToken,
      'GET',
      `/internal/v1/admin/external-platforms/${provider}?range=24h`,
    )
    const expectedRevision = detail?.credential?.revision
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
      throw migrationError(`Hub Admin did not return a valid ${provider} credential revision`)
    }
    return {
      provider,
      apiKey: credentials[provider],
      expectedRevision,
      fingerprintTail: credentialFingerprintTail(credentials[provider]),
    }
  }))

  const dryRun = environment.MX_INSIGHT_EXTERNAL_CREDENTIAL_MIGRATION_DRY_RUN === '1'
    || environment.MX_INSIGHT_TIKHUB_MIGRATION_DRY_RUN === '1'
  if (dryRun) {
    return {
      dryRun: true,
      providers: targets.map(({ provider, expectedRevision, fingerprintTail }) => ({
        provider,
        status: 'validated',
        source: 'night-all-config',
        expectedRevision,
        fingerprintTail,
      })),
    }
  }

  const migrated = []
  for (const target of targets) {
    const updated = await adminRequest(
      base,
      adminToken,
      'PUT',
      `/internal/v1/admin/external-platforms/${target.provider}/credential`,
      { apiKey: target.apiKey, expectedRevision: target.expectedRevision },
    )
    if (updated?.source !== 'database'
      || updated?.credentialConfigured !== true
      || updated?.revision !== target.expectedRevision + 1) {
      throw migrationError(`Hub Admin did not confirm the expected ${target.provider} database credential revision`)
    }
    migrated.push({
      provider: target.provider,
      status: 'migrated',
      source: updated.source,
      revision: updated.revision,
      fingerprintTail: target.fingerprintTail,
    })
  }
  return { dryRun: false, providers: migrated }
}

export function formatMigrationResults(result) {
  return result.providers.map((provider) => {
    const revision = result.dryRun ? provider.expectedRevision : provider.revision
    return `provider=${provider.provider} status=${provider.status} fingerprintTail=${provider.fingerprintTail} source=${provider.source} revision=${revision}`
  }).join('\n')
}

async function main() {
  const providers = process.argv.includes('--all')
    ? PROVIDERS.map(({ provider }) => provider)
    : ['tikhub']
  const result = await migrateExternalPlatformCredentials(process.env, { providers })
  process.stdout.write(`${formatMigrationResults(result)}\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'tikhub_credential_migration_failed'}: ${error?.message || 'migration failed'}\n`)
    process.exitCode = 1
  })
}
