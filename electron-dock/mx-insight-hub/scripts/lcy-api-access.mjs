#!/usr/bin/env node
// Original LCY identity only. Default: one read-only snapshot, no Admin HTTP or
// supplier call. --apply reuses the audited catalog sync in one transaction.
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import pg from 'pg'

export const REVISION = 'lcy-api-access.v1'
export const LCY_API_IDENTITY = Object.freeze({
  tenantId: '277bf8a4-5ed5-414d-b429-d72fcd7d36b6',
  consumerId: 'be7d07fe-3d98-4db3-b00d-e5cbe5a76190',
  apiKeyId: 'fd2f8cc9-0ff1-4052-a538-8cc8150bde83',
})
const root = process.argv[1] === '-' ? pathToFileURL(`${process.cwd()}/server/`) : new URL('../server/', import.meta.url)
const source = path => import(new URL(path, root))
const fail = code => Object.assign(new Error(code), { diagnosticCode: code })
const SAFE_ERRORS = new Set(['invalid_arguments', 'database_configuration_missing', 'original_identity_missing',
  'original_identity_mismatch', 'identity_unavailable', 'managed_profile_required', 'snapshot_key_required',
  'managed_catalog_sync_unavailable', 'installed_runtime_upgrade_required', 'catalog_sync_incomplete'])

export function lcyAccessArguments(args) {
  if (args.length === 0) return { apply: false }
  if (args.length === 1 && args[0] === '--apply') return { apply: true }
  throw fail('invalid_arguments')
}

export async function inspectLcyApiAccess(client) {
  const { tenantId, consumerId, apiKeyId } = LCY_API_IDENTITY
  const key = (await client.query(`SELECT k.id,k.tenant_id,k.consumer_id,k.status,k.environment,k.scope_mode,
    k.expires_at,k.expires_at>now() AS unexpired,
    to_jsonb(k)->>'access_profile' AS access_profile,
    c.status AS consumer_status,t.status AS tenant_status
    FROM api_keys k JOIN consumers c ON c.id=k.consumer_id JOIN tenants t ON t.id=k.tenant_id
    WHERE k.id=$1`, [apiKeyId])).rows[0]
  if (!key) throw fail('original_identity_missing')
  if (key.tenant_id !== tenantId || key.consumer_id !== consumerId) throw fail('original_identity_mismatch')
  const [{ lcyFullApiScopes }, { listCrawlerSpecs }, { WEB_SEARCH_PROVIDERS }, { COLLECT_CAPABILITIES }, syncModule] = await Promise.all([
    source('hub-service.mjs'), source('ingest/crawler/source-contract.mjs'), source('../shared/web-search.mjs'),
    source('../shared/collect-engines.mjs'), source('stores/managed-api-access.mjs'),
  ])
  if (typeof lcyFullApiScopes !== 'function') throw fail('managed_catalog_sync_unavailable')
  const specs = await listCrawlerSpecs({ listExternalSources: async () =>
    (await client.query('SELECT source_key AS "sourceKey" FROM catalog.external_sources')).rows })
  const expected = lcyFullApiScopes(specs.map(row => row.platform))
  const catalogCoverage = {
    missingCollectionPlatforms: [...new Set(COLLECT_CAPABILITIES.map(row => row.platform))].filter(name => !expected.platforms.includes(name)),
    missingCollectionCapabilities: COLLECT_CAPABILITIES.map(row => row.key).filter(name => !expected.capabilities.includes(name)),
  }
  const catalogComplete = Object.values(catalogCoverage).every(missing => missing.length === 0)
  const layers = {}
  for (const [kind, names, column, grants, entitlements] of [
    ['platforms', expected.platforms, 'platform', 'platform_grants', 'api_key_platform_entitlements'],
    ['capabilities', expected.capabilities, 'capability', 'capability_grants', 'api_key_capability_entitlements'],
  ]) {
    const consumer = new Set((await client.query(`SELECT ${column} FROM ${grants} WHERE consumer_id=$1`, [consumerId])).rows.map(row => row[column]))
    const snapshot = new Set((await client.query(`SELECT ${column} FROM ${entitlements} WHERE api_key_id=$1`, [apiKeyId])).rows.map(row => row[column]))
    const effective = new Set([...consumer].filter(name => key.scope_mode === 'legacy_dynamic' || snapshot.has(name)))
    layers[kind] = { expectedCount: names.length, effectiveCount: effective.size,
      missingConsumerGrants: names.filter(name => !consumer.has(name)),
      missingKeyEntitlements: names.filter(name => !snapshot.has(name)),
      missingEffectiveGrants: names.filter(name => !effective.has(name)) }
  }
  const order = (await client.query('SELECT web_search_order FROM api_keys WHERE id=$1', [apiKeyId])).rows[0]?.web_search_order || []
  const missingWebSearchProviders = WEB_SEARCH_PROVIDERS.map(row => row.key).filter(name => !order.includes(name))
  const identityUsable = key.status === 'active' && key.environment === 'live' && key.unexpired === true
    && key.consumer_status === 'active' && key.tenant_status === 'active'
  return { diagnosticRevision: REVISION, ...LCY_API_IDENTITY, observedAt: new Date().toISOString(),
    catalogFingerprint: createHash('sha256').update(JSON.stringify(expected)).digest('hex'),
    catalogSource: 'installed_code_and_registered_sources', catalogCoverage,
    targetedSyncAvailable: syncModule.MANAGED_API_ACCESS_SYNC_VERSION === 2, identityUsable,
    lifecycle: { keyStatus: key.status, environment: key.environment, consumerStatus: key.consumer_status,
      tenantStatus: key.tenant_status, expiresAt: key.expires_at },
    accessProfile: key.access_profile || 'standard', scopeMode: key.scope_mode, ...layers, missingWebSearchProviders,
    complete: catalogComplete && identityUsable && key.access_profile === 'managed_full' && key.scope_mode === 'snapshot'
      && Object.values(layers).every(layer => layer.missingEffectiveGrants.length === 0) && missingWebSearchProviders.length === 0,
    supplierHttpCallsMade: 0, readinessVerified: false }
}

export function assertLcyRepairable(report) {
  if (!report.targetedSyncAvailable || Object.values(report.catalogCoverage).some(missing => missing.length)) {
    throw fail('installed_runtime_upgrade_required')
  }
  if (!report.identityUsable) throw fail('identity_unavailable')
  if (report.scopeMode !== 'snapshot') throw fail('snapshot_key_required')
  if (report.accessProfile !== 'managed_full') throw fail('managed_profile_required')
}

export async function runLcyApiAccess(client, { apply = false } = {}) {
  await client.query(apply ? 'BEGIN' : 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
  let committed = false
  try {
    await client.query("SET LOCAL statement_timeout='30s'")
    await client.query("SET LOCAL lock_timeout='5s'")
    const before = await inspectLcyApiAccess(client)
    if (!apply) return { ...before, mode: 'read_only', writes: 0 }
    assertLcyRepairable(before)
    const { syncManagedApiAccess } = await source('stores/managed-api-access.mjs')
    const result = await syncManagedApiAccess(client, undefined, { apiKeyId: LCY_API_IDENTITY.apiKeyId })
    const after = await inspectLcyApiAccess(client)
    if (result.keys !== 1 || !after.complete) throw fail('catalog_sync_incomplete')
    await client.query('COMMIT')
    committed = true
    return { ...after, mode: 'applied', changedKeys: result.changed,
      previousMissing: { platforms: before.platforms.missingEffectiveGrants,
        capabilities: before.capabilities.missingEffectiveGrants, webSearchProviders: before.missingWebSearchProviders } }
  } finally {
    // A read-only check and every failed apply end here; committed writes are
    // already durable. No retry, secret rotation, lifecycle or price change.
    if (!committed) await client.query('ROLLBACK')
  }
}

export async function main(args = process.argv.slice(2)) {
  let client
  try {
    const options = lcyAccessArguments(args)
    if (!process.env.DATABASE_URL) throw fail('database_configuration_missing')
    client = new pg.Client({ connectionString: process.env.DATABASE_URL, connectionTimeoutMillis: 10000,
      application_name: REVISION })
    await client.connect()
    const report = await runLcyApiAccess(client, options)
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    if (!report.complete) process.exitCode = 2
  } catch (error) {
    const sibling = error?.message === 'Managed API access refused: sibling dynamic Key could inherit access'
      ? 'sibling_dynamic_conflict' : error?.message === 'Managed API access refused: sibling snapshot Key could regain access'
        ? 'sibling_snapshot_conflict' : null
    process.stdout.write(`${JSON.stringify({ diagnosticRevision: REVISION, supplierHttpCallsMade: 0,
      errorCode: sibling || (SAFE_ERRORS.has(error?.diagnosticCode) ? error.diagnosticCode : 'access_check_failed'),
      databaseErrorCode: /^[0-9A-Z]{5}$/u.test(error?.code || '') ? error.code : null })}\n`)
    process.exitCode = 1
  } finally { await client?.end().catch(() => {}) }
}
const stdinEntry = process.argv[1] === '-' && fileURLToPath(import.meta.url) === `${process.cwd()}/[eval1]`
if (stdinEntry || process.argv[1] && process.argv[1] !== '-' && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
