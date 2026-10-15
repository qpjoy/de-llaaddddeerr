import { pathToFileURL } from 'node:url'
import { WEB_SEARCH_PROVIDERS } from '../shared/web-search.mjs'
import { readPrivateJson } from './migrate-tikhub-credential.mjs'
import { normalizeWebSearchAdminBase, readNightAllWebSearchCredentials } from './migrate-web-search-credentials.mjs'

const SCALAR_PROVIDERS = Object.freeze({ rapidapi: 'rapidapi', tikhub: 'tikhub', justone: 'justOne' })
const WEB_PROVIDERS = new Set(WEB_SEARCH_PROVIDERS.map(({ key }) => key))
const PROVIDERS = new Set([...Object.keys(SCALAR_PROVIDERS), ...WEB_PROVIDERS])
const SKIP_STATUSES = new Set(['source_missing', 'source_disabled', 'source_enabled_unknown'])
const SOURCE_STATUSES = new Set([...SKIP_STATUSES, 'source_invalid'])
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
function fail(code) { throw new Error(`night_all_credential_migration_${code}`) }

function requestedProviders(providers) {
  if (!Array.isArray(providers) || !providers.length || providers.some(provider => !PROVIDERS.has(provider))
    || new Set(providers).size !== providers.length) fail('providers_required')
  return [...providers]
}

export function migrationArguments(args = []) {
  let providers, dryRun
  let allowReadableConfig = false
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--providers' && providers === undefined) providers = args[++index]?.split(',')
    else if (['--dry-run', '--apply'].includes(args[index]) && dryRun === undefined) dryRun = args[index] === '--dry-run'
    else if (args[index] === '--allow-readable-config' && !allowReadableConfig) allowReadableConfig = true
    else fail('arguments_invalid')
  }
  requestedProviders(providers)
  if (dryRun === undefined) fail('explicit_mode_required')
  return { providers, dryRun, allowReadableConfig }
}

// This explicit snapshot import never reads environment keys, legacy news JSON
// or Night-All's database. Keep the deployed SQL importer independent.
export async function readNightAllJsonCredentials(configPath, { providers, allowReadableConfig = false } = {}) {
  providers = requestedProviders(providers)
  if (typeof configPath !== 'string' || !configPath.trim()) fail('config_path_required')
  const result = {}, scalar = providers.filter(provider => Object.hasOwn(SCALAR_PROVIDERS, provider))
  if (scalar.length) {
    let config
    try { config = await readPrivateJson(configPath, { allowReadableConfig }) } catch { fail('source_unavailable') }
    if (!object(config) || (config.crawlerProviders != null && !object(config.crawlerProviders))) fail('source_invalid')
    for (const provider of scalar) {
      const entry = config.crawlerProviders?.[SCALAR_PROVIDERS[provider]]
      const sourceEnabled = typeof entry?.enabled === 'boolean' ? entry.enabled : null
      const value = entry?.apiKey
      if (value == null || value === '' || typeof value === 'string' && !value.trim()) {
        result[provider] = { status: 'source_missing', sourceEnabled }
      } else if (typeof value !== 'string' || !/^[\x21-\x7e]{1,4096}$/.test(value.trim())) {
        result[provider] = { status: 'source_invalid', sourceEnabled }
      } else result[provider] = { status: 'available', sourceEnabled, apiKey: value.trim() }
    }
  }
  const web = providers.filter(provider => WEB_PROVIDERS.has(provider))
  if (web.length) {
    try { Object.assign(result, await readNightAllWebSearchCredentials(configPath, { providers: web, allowReadableConfig })) }
    catch { fail('source_unavailable') }
  }
  return result
}

export async function migrateNightAllCredentials(environment = process.env, {
  providers, dryRun = true, allowReadableConfig = false, fetchImpl = fetch, readCredentials = readNightAllJsonCredentials,
} = {}) {
  providers = requestedProviders(providers)
  if (typeof dryRun !== 'boolean' || typeof allowReadableConfig !== 'boolean') fail('mode_invalid')
  const base = normalizeWebSearchAdminBase(environment.MX_INSIGHT_ADMIN_BASE_URL)
  const token = environment.MX_INSIGHT_ADMIN_TOKEN
  if (typeof token !== 'string' || token.length < 32 || /[\r\n]/.test(token)) fail('admin_token_required')
  const request = async (provider, method, body) => {
    let response
    try {
      response = await fetchImpl(`${base}/internal/v1/admin/external-platforms/${provider}${method === 'PUT' ? '/credential' : '?range=24h'}`, {
        method, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15000),
        headers: { 'x-mx-insight-admin-token': token, ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch { return { status: method === 'PUT' ? 'write_unknown' : 'target_unavailable' } }
    if (!response.ok) return { httpStatus: response.status,
      status: method === 'GET' ? 'target_unavailable' : response.status === 409 ? 'conflict' : response.status >= 500 ? 'write_unknown' : 'write_rejected' }
    try { return { data: (await response.json())?.data } }
    catch { return { status: method === 'PUT' ? 'write_unconfirmed' : 'target_invalid' } }
  }

  // Inspect every target before opening the source or performing any write.
  const results = []
  for (const provider of providers) {
    const row = { provider, source: 'night-all-config', sourceEnabled: null }
    const target = await request(provider, 'GET')
    if (target.status) { results.push({ ...row, ...target }); continue }
    const credential = target.data?.credential
    if (!credential || !Number.isSafeInteger(credential.revision) || credential.revision < 0
      || typeof credential.credentialConfigured !== 'boolean' || !['database', 'environment'].includes(credential.source)
      || (target.data?.provider?.key !== undefined && target.data.provider.key !== provider)) {
      results.push({ ...row, status: 'target_invalid' }); continue
    }
    results.push({ ...row, revision: credential.revision,
      status: credential.credentialConfigured || credential.revision > 0 ? 'preserved' : 'missing' })
  }
  const missing = results.filter(row => row.status === 'missing')
  let source = {}
  if (missing.length) {
    try { source = await readCredentials(environment.NIGHT_ALL_CONFIG_PATH, { providers: missing.map(row => row.provider), allowReadableConfig }) }
    catch { source = {} }
  }
  for (const row of missing) {
    const entry = source?.[row.provider]
    row.sourceEnabled = typeof entry?.sourceEnabled === 'boolean' ? entry.sourceEnabled : null
    if (entry?.status !== 'available') {
      row.status = SOURCE_STATUSES.has(entry?.status) ? entry.status : 'source_unavailable'
      continue
    }
    if (dryRun) { row.status = 'would_migrate'; continue }
    const body = Object.hasOwn(SCALAR_PROVIDERS, row.provider) ? { apiKey: entry.apiKey } : { credentials: entry.credentials }
    const updated = await request(row.provider, 'PUT', { ...body, expectedRevision: row.revision })
    if (updated.status) { Object.assign(row, updated); continue }
    if (updated.data?.source !== 'database' || updated.data?.credentialConfigured !== true || updated.data?.revision !== row.revision + 1) {
      row.status = 'write_unconfirmed'; continue
    }
    row.status = 'migrated'
    row.revision = updated.data.revision
  }
  return { dryRun, source: 'night-all-config', providers: results,
    complete: results.every(row => ['preserved', 'would_migrate', 'migrated'].includes(row.status) || SKIP_STATUSES.has(row.status)) }
}

export function formatMigrationResults(result) {
  return result.providers.map(row => `provider=${row.provider} status=${row.status} source=${row.source} sourceEnabled=${row.sourceEnabled ?? 'unknown'}${row.revision == null ? '' : ` revision=${row.revision}`}${row.httpStatus == null ? '' : ` httpStatus=${row.httpStatus}`}`).join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  Promise.resolve().then(() => migrateNightAllCredentials(process.env, migrationArguments(process.argv.slice(2)))).then(result => {
    process.stdout.write(`${formatMigrationResults(result)}\n`)
    if (!result.complete) process.exitCode = 1
  }).catch(() => {
    process.stderr.write('Night-All JSON credential import failed. Set NIGHT_ALL_CONFIG_PATH and Hub Admin credentials; use --providers rapidapi,tikhub,justone,exa,... with --dry-run or --apply. Existing credentials and deliberate clears are preserved. No automatic retry; inspect Hub state before rerunning.\n')
    process.exitCode = 1
  })
}
