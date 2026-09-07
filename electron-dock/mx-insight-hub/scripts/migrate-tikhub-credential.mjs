import { lstat, readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'

const DEFAULT_NIGHT_ALL_CONFIG = '/Users/qpjoy/workspace/mingxi/Night-All/config.json'
const DEFAULT_ADMIN_BASE = 'http://127.0.0.1:18151'
const MAX_CONFIG_BYTES = 1024 * 1024
const MAX_API_KEY_BYTES = 4_096

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

export async function readNightAllTikHubCredential(configPath, {
  allowInsecurePermissions = false,
} = {}) {
  const info = await lstat(configPath).catch(() => null)
  if (!info?.isFile() || info.isSymbolicLink()) {
    throw migrationError('Night-All config must be an existing regular file, not a symlink')
  }
  if (!allowInsecurePermissions && (info.mode & 0o077) !== 0) {
    throw migrationError('Night-All config permissions must exclude group and other access (for example chmod 600)')
  }
  if (info.size <= 0 || info.size > MAX_CONFIG_BYTES) {
    throw migrationError(`Night-All config must be between 1 and ${MAX_CONFIG_BYTES} bytes`)
  }
  let parsed
  try { parsed = JSON.parse(await readFile(configPath, 'utf8')) } catch {
    throw migrationError('Night-All config is not valid JSON')
  }
  const apiKey = parsed?.crawlerProviders?.tikhub?.apiKey
  if (typeof apiKey !== 'string' || !apiKey.trim() || Buffer.byteLength(apiKey.trim()) > MAX_API_KEY_BYTES) {
    throw migrationError('Night-All crawlerProviders.tikhub.apiKey is missing or invalid')
  }
  return apiKey.trim()
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
  const configPath = environment.NIGHT_ALL_CONFIG_PATH || DEFAULT_NIGHT_ALL_CONFIG
  const adminToken = environment.MX_INSIGHT_ADMIN_TOKEN
  if (typeof adminToken !== 'string' || adminToken.length < 32 || /[\r\n]/u.test(adminToken)) {
    throw migrationError('MX_INSIGHT_ADMIN_TOKEN must be present and at least 32 characters')
  }
  const base = normalizeAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL)
  const apiKey = await readNightAllTikHubCredential(configPath, {
    allowInsecurePermissions: environment.MX_INSIGHT_ALLOW_INSECURE_NIGHT_ALL_CONFIG === '1',
  })
  const detail = await adminRequest(
    base,
    adminToken,
    'GET',
    '/internal/v1/admin/external-platforms/tikhub?range=24h',
  )
  const expectedRevision = detail?.credential?.revision
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw migrationError('Hub Admin did not return a valid TikHub credential revision')
  }
  if (environment.MX_INSIGHT_TIKHUB_MIGRATION_DRY_RUN === '1') {
    return { dryRun: true, source: 'night-all-config', expectedRevision }
  }
  const updated = await adminRequest(
    base,
    adminToken,
    'PUT',
    '/internal/v1/admin/external-platforms/tikhub/credential',
    { apiKey, expectedRevision },
  )
  if (updated?.source !== 'database'
    || updated?.credentialConfigured !== true
    || updated?.revision !== expectedRevision + 1) {
    throw migrationError('Hub Admin did not confirm the expected database credential revision')
  }
  return { dryRun: false, source: updated.source, revision: updated.revision }
}

async function main() {
  const result = await migrateTikHubCredential()
  if (result.dryRun) {
    process.stdout.write(`TikHub credential migration preflight passed at revision ${result.expectedRevision}; plaintext withheld.\n`)
    return
  }
  process.stdout.write(`TikHub credential migrated into the Hub database at revision ${result.revision}; plaintext withheld.\n`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.code || 'tikhub_credential_migration_failed'}: ${error?.message || 'migration failed'}\n`)
    process.exitCode = 1
  })
}
