// Current authorization metadata only: no authentication, search, grants or
// supplier calls. Request IDs help locate an owner, not reconstruct old grants.
import { fileURLToPath, pathToFileURL } from 'node:url'

export const REVISION = 'platform-access-check.v1'
export const INCIDENT_REQUEST_ID = 'ab00ef17-1e2e-4085-8254-eb6a13729966'
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu
const PLATFORM = /^[a-z][a-z0-9_-]{0,63}$/u
const SAFE_CODES = new Set(['invalid_arguments', 'identity_required', 'identity_ambiguous', 'identity_not_found', 'explicit_identity_mismatch', 'postgres_required'])
const fail = code => Object.assign(new Error(code), { diagnosticCode: code })
const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../', import.meta.url)
const source = path => import(new URL(path, root))

export function platformAccessArguments(args) {
  const values = new Map()
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index], value = args[index + 1]
    if (!['--key-id', '--consumer-id', '--platform', '--request-id'].includes(flag)
      || values.has(flag) || typeof value !== 'string' || !value) throw fail('invalid_arguments')
    values.set(flag, value)
  }
  const result = { keyId: values.get('--key-id') ?? null, consumerId: values.get('--consumer-id') ?? null,
    platform: values.get('--platform') ?? 'tieba', requestId: values.get('--request-id') ?? INCIDENT_REQUEST_ID }
  if (!PLATFORM.test(result.platform) || ![result.keyId, result.consumerId, result.requestId].every(value => value === null || UUID.test(value))) {
    throw fail('invalid_arguments')
  }
  for (const field of ['keyId', 'consumerId', 'requestId']) if (result[field]) result[field] = result[field].toLowerCase()
  return result
}

export async function platformContractEvidence(platform) {
  const [v2, direct, legacy] = await Promise.all([source('contracts/data-search-v2.mjs'),
    source('contracts/tikhub-content-search.mjs'), source('contracts/night-all-legacy.mjs')])
  return { source: 'installed_code_contracts', readinessVerified: false,
    standardV2Registered: v2.DATA_SEARCH_V2_PLATFORMS.includes(platform),
    tikhubContentSearchRecipeRegistered: Object.hasOwn(direct.TIKHUB_CONTENT_SEARCH_RECIPES, platform),
    legacyRawDeclared: legacy.NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.raw.includes(platform),
    legacyCrawlDeclared: legacy.NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS.crawl.includes(platform),
    legacyUserInfoDeclared: legacy.NIGHT_ALL_LEGACY_SUPPORTED_PLATFORMS['user-info'].includes(platform),
    v1GenericFallbackAvailability: 'not_verified' }
}

const ownerKey = row => `${row.tenant_id}/${row.consumer_id}/${row.api_key_id}`
const optionalDate = value => value == null ? null : new Date(value).toISOString()
const choice = (value, choices) => choices.includes(value) ? value : 'unknown'

export async function diagnosePlatformAccess(pool, options = platformAccessArguments([])) {
  // Reuse CLI validation for programmatic callers as well.
  const input = platformAccessArguments(['--platform', options.platform ?? 'tieba', '--request-id', options.requestId ?? INCIDENT_REQUEST_ID,
    ...(options.keyId ? ['--key-id', options.keyId] : []), ...(options.consumerId ? ['--consumer-id', options.consumerId] : [])])
  const report = { diagnosticRevision: REVISION, mode: 'current_state_not_historical', observedAt: new Date().toISOString(), requestId: input.requestId,
    platform: input.platform, supplierHttpCallsMade: 0, writes: 0, readOnlyTransaction: true,
    contractEvidence: await platformContractEvidence(input.platform), identitySource: 'none', keys: [] }
  const client = await pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout='10s'")
    await client.query("SET LOCAL lock_timeout='1s'")
    const usage = (await client.query(`SELECT /* platform-access:usage-owner */ tenant_id,consumer_id,api_key_id
      FROM public.usage_requests WHERE id=$1`, [input.requestId])).rows
    const rejectionTable = (await client.query("SELECT to_regclass('control.request_authorization_rejections') IS NOT NULL AS present")).rows[0]?.present === true
    // Client-supplied HTTP IDs are not unique owner identities. Two distinct
    // owners are enough to stop automatic selection; never guess by key name.
    const rejected = rejectionTable ? (await client.query(`SELECT DISTINCT /* platform-access:rejected-owners */ tenant_id,consumer_id,api_key_id
      FROM control.request_authorization_rejections WHERE request_id=$1 ORDER BY tenant_id,consumer_id,api_key_id LIMIT 2`, [input.requestId])).rows : []
    const owners = [...new Map([...usage, ...rejected].map(row => [ownerKey(row), row])).values()]
    report.requestEvidence = { usageFound: usage.length > 0, authorizationRejectionTableInstalled: rejectionTable,
      authorizationRejectionFound: rejected.length > 0, ownerAmbiguous: owners.length > 1,
      matchesExplicitIdentity: input.keyId || input.consumerId ? (owners.some(row => input.keyId
        ? row.api_key_id === input.keyId : row.consumer_id === input.consumerId) ? true : rejected.length === 2 ? null : false) : null }
    let keyId = input.keyId, consumerId = input.consumerId
    if (keyId) report.identitySource = 'explicit_key'
    else if (consumerId) report.identitySource = 'explicit_consumer'
    else if (owners.length !== 1) { report.errorCode = owners.length ? 'identity_ambiguous' : 'identity_required'; return report }
    else if (![owners[0].tenant_id, owners[0].consumer_id, owners[0].api_key_id].every(value => typeof value === 'string' && UUID.test(value))) {
      report.errorCode = 'identity_required'; return report
    } else {
      keyId = owners[0].api_key_id; consumerId = owners[0].consumer_id
      report.identitySource = usage.length ? 'saved_usage' : 'saved_authorization_rejection'
    }
    const records = (await client.query(`SELECT /* platform-access:keys */ k.id,k.tenant_id,k.consumer_id,k.status,k.environment,
      k.scope_mode,k.expires_at,c.status AS consumer_status,t.status AS tenant_status,
      k.expires_at>now() AS unexpired,
      EXISTS(SELECT 1 FROM public.platform_grants g WHERE g.consumer_id=k.consumer_id AND g.platform=$3) AS consumer_granted,
      EXISTS(SELECT 1 FROM public.api_key_platform_entitlements e WHERE e.api_key_id=k.id AND e.platform=$3) AS key_entitlement_present
      FROM public.api_keys k JOIN public.consumers c ON c.id=k.consumer_id JOIN public.tenants t ON t.id=k.tenant_id
      WHERE ($1::uuid IS NOT NULL AND k.id=$1) OR ($1::uuid IS NULL AND k.consumer_id=$2 AND k.status='active')
      ORDER BY k.id LIMIT 21`, [keyId, consumerId, input.platform])).rows
    if (keyId && !records.length) { report.errorCode = 'identity_not_found'; return report }
    if (input.keyId && input.consumerId && records[0]?.consumer_id !== input.consumerId) {
      report.errorCode = 'explicit_identity_mismatch'; return report
    }
    const selectedConsumer = records[0]?.consumer_id ?? consumerId
    const consumer = (await client.query(`SELECT /* platform-access:consumer */ c.id,c.tenant_id,c.status,t.status AS tenant_status,
      EXISTS(SELECT 1 FROM public.platform_grants g WHERE g.consumer_id=c.id AND g.platform=$2) AS platform_granted
      FROM public.consumers c JOIN public.tenants t ON t.id=c.tenant_id WHERE c.id=$1`, [selectedConsumer, input.platform])).rows[0]
    if (!consumer) { report.errorCode = 'identity_not_found'; return report }
    report.consumer = { id: consumer.id, tenantId: consumer.tenant_id,
      status: choice(consumer.status, ['active', 'suspended']), tenantStatus: choice(consumer.tenant_status, ['active', 'suspended']),
      platformGranted: consumer.platform_granted === true }
    report.truncated = records.length > 20
    report.keys = records.slice(0, 20).map(row => {
      const granted = row.consumer_granted === true && (row.scope_mode === 'legacy_dynamic' || row.key_entitlement_present === true)
      return { id: row.id, consumerId: row.consumer_id, tenantId: row.tenant_id,
        status: choice(row.status, ['active', 'revoked']), environment: choice(row.environment, ['live', 'test']),
        scopeMode: choice(row.scope_mode, ['snapshot', 'legacy_dynamic']), expiresAt: optionalDate(row.expires_at),
        identityActive: row.status === 'active' && row.consumer_status === 'active' && row.tenant_status === 'active' && row.unexpired === true,
        consumerGranted: row.consumer_granted === true, keyEntitlementPresent: row.key_entitlement_present === true,
        effectivePlatformGranted: granted }
    })
    return report
  } finally { await client.query('ROLLBACK').catch(() => {}); client.release() }
}

export async function main(args = process.argv.slice(2)) {
  let pool
  try {
    const options = platformAccessArguments(args)
    const { loadConfig } = await source('config.mjs'), config = loadConfig()
    if (config.storeDriver !== 'postgres' || !config.databaseUrl) throw fail('postgres_required')
    const { Pool } = await import('pg')
    pool = new Pool({ connectionString: config.databaseUrl, max: 1, connectionTimeoutMillis: 5000, application_name: REVISION })
    const report = await diagnosePlatformAccess(pool, options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (report.errorCode) process.exitCode = 1
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, supplierHttpCallsMade: 0, writes: 0,
      errorCode: SAFE_CODES.has(error?.diagnosticCode) ? error.diagnosticCode : 'diagnostic_unavailable' })}\n`)
    process.exitCode = 1
  } finally { await pool?.end().catch(() => {}) }
}
const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
