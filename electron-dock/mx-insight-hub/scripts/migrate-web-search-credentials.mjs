import { pathToFileURL } from 'node:url'
import { readFile } from 'node:fs/promises'
import { WEB_SEARCH_PROVIDERS } from '../shared/web-search.mjs'
import { searchUpstream } from '../server/web-search/providers.mjs'
import { readPrivateJson } from './migrate-tikhub-credential.mjs'
import { discoverNightAllConfig } from './migrate-facebook-credentials.mjs'

const PROVIDERS = new Set(WEB_SEARCH_PROVIDERS.map(({ key }) => key))
const SOURCES = { database: 'night-all-database', json: 'night-all-config' }
const SUCCESS_STATUSES = new Set(['preserved', 'would_migrate', 'migrated', 'source_missing', 'source_disabled', 'source_enabled_unknown'])

function fail(code) {
  // Never include source values, server response bodies or transport errors.
  throw new Error(`web_search_migration_${code}`)
}

function requestedProviders(providers) {
  if (!Array.isArray(providers) || providers.length === 0
    || providers.some(provider => !PROVIDERS.has(provider))
    || new Set(providers).size !== providers.length) fail('providers_required')
  return [...providers]
}

export function normalizeWebSearchAdminBase(value = 'http://127.0.0.1:18151') {
  let url
  try { url = new URL(value) } catch { fail('admin_origin_required') }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') fail('admin_origin_required')
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) fail('secure_admin_origin_required')
  return url.origin
}

export function migrationArguments(args = []) {
  let providers, dryRun, source
  let allowReadableConfig = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--providers' && providers === undefined) {
      providers = args[++index]?.split(',')
    } else if (['--dry-run', '--apply'].includes(args[index]) && dryRun === undefined) {
      dryRun = args[index] === '--dry-run'
    } else if (args[index] === '--allow-readable-config' && !allowReadableConfig) {
      allowReadableConfig = true
    } else if (args[index] === '--source' && source === undefined) {
      source = args[++index]
      if (!source) fail('source_invalid')
    } else fail('arguments_invalid')
  }
  requestedProviders(providers)
  if (dryRun === undefined) fail('explicit_mode_required')
  source ??= 'database'
  if (!Object.hasOwn(SOURCES, source) || (source !== 'json' && allowReadableConfig)) fail('source_invalid')
  return { providers, dryRun, source, allowReadableConfig }
}

export async function readNightAllWebSearchCredentials(configPath, { providers, allowReadableConfig = false } = {}) {
  requestedProviders(providers)
  let config
  try { config = await readPrivateJson(configPath, { allowReadableConfig }) } catch { fail('source_unavailable') }
  if (!config || typeof config !== 'object' || Array.isArray(config)
    || (config.searchApis != null && (typeof config.searchApis !== 'object' || Array.isArray(config.searchApis)))) fail('source_invalid')
  return Object.fromEntries(providers.map(provider => {
    const entry = config.searchApis?.[provider]
    const sourceEnabled = typeof entry?.enabled === 'boolean' ? entry.enabled : null
    const value = entry?.apiKey
    if (sourceEnabled === false) return [provider, { status: 'source_disabled', sourceEnabled }]
    if (value == null || value === '') return [provider, { status: 'source_missing', sourceEnabled }]
    if (sourceEnabled !== true) return [provider, { status: 'source_enabled_unknown', sourceEnabled }]
    // Match the structured credential API exactly. Do not rewrite source keys.
    if (typeof value !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(value)) return [provider, { status: 'source_invalid', sourceEnabled }]
    return [provider, { status: 'available', sourceEnabled, credentials: { apiKey: value } }]
  }))
}

export function normalizeNightAllWebSearchBindings(value, providers) {
  requestedProviders(providers)
  if (value == null || value === '') return []
  if (typeof value !== 'string' || value.length > 8192) fail('source_bindings_invalid')
  let mappings
  try { mappings = JSON.parse(value) } catch { fail('source_bindings_invalid') }
  if (!mappings || typeof mappings !== 'object' || Array.isArray(mappings)) fail('source_bindings_invalid')
  return Object.entries(mappings).map(([hubProvider, binding]) => {
    if (!providers.includes(hubProvider) || !binding || typeof binding !== 'object' || Array.isArray(binding)
      || Object.keys(binding).length === 0
      || Object.keys(binding).some(key => !['credentialProvider', 'credentialModule'].includes(key))
      || Object.values(binding).some(item => typeof item !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,99}$/.test(item))) fail('source_bindings_invalid')
    const credentialProvider = binding.credentialProvider ?? hubProvider
    // Match Night-All runtimeForConfig: provider-only bindings select that
    // provider's same-name module; module-only bindings retain the platform.
    return { hub_provider: hubProvider, credential_provider: credentialProvider, module_code: binding.credentialModule ?? credentialProvider }
  })
}

export async function readNightAllDatabaseWebSearchCredentials(databaseUrl, {
  providers, bindings, clientFactory,
} = {}) {
  requestedProviders(providers)
  const selectedBindings = normalizeNightAllWebSearchBindings(bindings, providers)
  let url
  try { url = new URL(databaseUrl) } catch { fail('source_database_required') }
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash || url.pathname.length < 2) fail('source_database_required')
  let client
  try {
    const sql = await readFile(new URL('./sql/night-all-web-search-credentials.sql', import.meta.url), 'utf8')
    // Production deploy runs this reader in the built Hub image. Keep argument
    // validation and explicit JSON imports usable on a dependency-free checkout.
    const pg = clientFactory ? null : (await import('pg')).default
    const createClient = clientFactory ?? (options => new pg.Client(options))
    client = createClient({
      connectionString: databaseUrl, connectionTimeoutMillis: 5000,
      query_timeout: 10000, statement_timeout: 9500, idle_in_transaction_session_timeout: 15000,
      application_name: 'mx-hub-web-search-migration',
    })
    client.on?.('error', () => {})
    await client.connect()
    await client.query('BEGIN READ ONLY')
    const { rows } = await client.query(sql, [providers, JSON.stringify(selectedBindings)])
    await client.query('COMMIT')
    return Object.fromEntries(providers.map(provider => {
      const row = rows.find(item => item.hub_provider === provider)
      if (!row?.module_code) return [provider, { status: 'source_missing', sourceEnabled: null }]
      const sourceEnabled = true
      if (typeof row.secret !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(row.secret)) return [provider, { status: 'source_invalid', sourceEnabled }]
      // Hub dispatches to fixed reviewed origins; do not silently redirect a key
      // that belonged to a different Night-All gateway or host override.
      const upstream = new URL(searchUpstream(provider).url)
      try {
        if (row.base_url) {
          const sourceUrl = new URL(row.base_url)
          if (sourceUrl.origin !== upstream.origin || sourceUrl.username || sourceUrl.password) throw Error()
        }
        if (row.host && row.host !== upstream.host) throw Error()
      } catch { return [provider, { status: 'source_endpoint_mismatch', sourceEnabled }] }
      return [provider, { status: 'available', sourceEnabled, credentials: { apiKey: row.secret } }]
    }))
  } catch { fail('source_unavailable') }
  finally { if (client) await client.end().catch(() => {}) }
}

// Database is authoritative by default. Never fall back to config.json or to
// Hub's own DATABASE_URL when the dedicated source connection is unavailable.
// Explicit JSON snapshots remain supported only with --source json.
export async function migrateWebSearchCredentials(environment = process.env, {
  providers, dryRun = true, source = 'database', allowReadableConfig = false, fetchImpl = fetch,
  readCredentials = readNightAllWebSearchCredentials, readDatabaseCredentials = readNightAllDatabaseWebSearchCredentials,
} = {}) {
  providers = requestedProviders(providers)
  if (typeof dryRun !== 'boolean') fail('mode_invalid')
  if (typeof allowReadableConfig !== 'boolean') fail('source_permission_mode_invalid')
  if (!Object.hasOwn(SOURCES, source) || (source !== 'json' && allowReadableConfig)) fail('source_invalid')
  if (source === 'database') normalizeNightAllWebSearchBindings(environment.NIGHT_ALL_WEB_SEARCH_BINDINGS, providers)
  const base = normalizeWebSearchAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL)
  const token = environment.MX_INSIGHT_ADMIN_TOKEN
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) fail('admin_token_required')

  const request = async (provider, method = 'GET', body) => {
    let response
    try {
      response = await fetchImpl(`${base}/internal/v1/admin/external-platforms/${provider}${method === 'PUT' ? '/credential' : '?range=24h'}`, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: { 'x-mx-insight-admin-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch { return { status: method === 'PUT' ? 'write_unknown' : 'target_unavailable' } }
    if (!response.ok) return {
      status: method === 'GET' ? 'target_unavailable' : response.status === 409 ? 'conflict' : response.status >= 500 ? 'write_unknown' : 'write_rejected',
      httpStatus: response.status,
    }
    try { return { data: (await response.json())?.data } } catch {
      return { status: method === 'PUT' ? 'write_unconfirmed' : 'target_invalid' }
    }
  }

  let sourceCredentials
  const results = []
  for (const provider of providers) {
    const row = { provider, source: SOURCES[source], sourceEnabled: null }
    const target = await request(provider)
    if (target.status) { results.push({ ...row, ...target }); continue }
    const credential = target.data?.credential
    if (!credential || !Number.isSafeInteger(credential.revision) || credential.revision < 0
      || typeof credential.credentialConfigured !== 'boolean'
      || !['database', 'environment'].includes(credential.source)) {
      results.push({ ...row, status: 'target_invalid' }); continue
    }
    row.revision = credential.revision
    // Existing environment/database keys and deliberate clears are authoritative.
    if (credential.credentialConfigured || credential.revision > 0) {
      results.push({ ...row, status: 'preserved' }); continue
    }
    if (!sourceCredentials) {
      try {
        sourceCredentials = source === 'database'
          ? await readDatabaseCredentials(environment.NIGHT_ALL_DATABASE_URL, { providers, bindings: environment.NIGHT_ALL_WEB_SEARCH_BINDINGS })
          : await readCredentials(await discoverNightAllConfig(environment), { providers, allowReadableConfig })
      } catch {
        sourceCredentials = Object.fromEntries(providers.map(key => [key, { status: 'source_unavailable' }]))
      }
    }
    const entry = sourceCredentials?.[provider]
    row.sourceEnabled = typeof entry?.sourceEnabled === 'boolean' ? entry.sourceEnabled : null
    if (!entry || entry.status !== 'available') {
      results.push({ ...row, status: ['source_missing', 'source_invalid', 'source_disabled', 'source_enabled_unknown', 'source_endpoint_mismatch'].includes(entry?.status) ? entry.status : 'source_unavailable' }); continue
    }
    if (dryRun) { results.push({ ...row, status: 'would_migrate' }); continue }
    const updated = await request(provider, 'PUT', { credentials: entry.credentials, expectedRevision: credential.revision })
    if (updated.status) { results.push({ ...row, ...updated }); continue }
    if (updated.data?.source !== 'database' || updated.data?.credentialConfigured !== true
      || updated.data?.revision !== credential.revision + 1) {
      results.push({ ...row, status: 'write_unconfirmed' }); continue
    }
    results.push({ ...row, status: 'migrated', revision: updated.data.revision })
  }
  return { dryRun, source: SOURCES[source], providers: results, complete: results.every(row => SUCCESS_STATUSES.has(row.status)) }
}

export function formatWebSearchMigrationResults(result) {
  return result.providers.map(row => `provider=${row.provider} status=${row.status} source=${row.source} sourceEnabled=${row.sourceEnabled ?? 'unknown'}${row.revision == null ? '' : ` revision=${row.revision}`}${row.httpStatus == null ? '' : ` httpStatus=${row.httpStatus}`}`).join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => migrateWebSearchCredentials(process.env, migrationArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${formatWebSearchMigrationResults(result)}\n`)
    if (!result.complete) process.exitCode = 1
  }).catch(() => {
    process.stderr.write('Web Search credential migration failed. Use --providers baidu,exa,... with --dry-run or --apply; set NIGHT_ALL_DATABASE_URL and HTTPS or loopback Hub Admin credentials. Database is the default source; JSON snapshots require --source json. No automatic retry; inspect Hub Admin state before rerunning.\n')
    process.exitCode = 1
  })
}
