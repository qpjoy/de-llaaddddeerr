import { businessApiScopes } from '../hub-service.mjs'
import { listCrawlerSpecs } from '../ingest/crawler/source-contract.mjs'
import { WEB_SEARCH_PROVIDERS } from '../../shared/web-search.mjs'

// Caller owns the migration transaction/lock. Grants stay materialized and
// auditable, so all existing authorization intersections continue to apply.
export async function syncManagedApiAccess(client, scopes) {
  const managed = await client.query("SELECT id,tenant_id,consumer_id FROM api_keys WHERE access_profile='managed_full' ORDER BY tenant_id,id")
  if (!managed.rowCount) return { keys: 0, changed: 0 }
  if (!scopes) {
    const specs = await listCrawlerSpecs({ listExternalSources: async () =>
      (await client.query('SELECT source_key AS "sourceKey" FROM catalog.external_sources')).rows })
    scopes = businessApiScopes(specs.map(row => row.platform))
  }
  let changed = 0
  for (const identity of managed.rows) {
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`tenant-access:${identity.tenant_id}`])
    for (const [kind, names] of [['platform', scopes.platforms], ['capability', scopes.capabilities]]) {
      for (const name of [...names].sort()) await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`${identity.consumer_id}:authorization:${kind}:${name}`])
    }
    const siblings = await client.query('SELECT * FROM api_keys WHERE consumer_id=$1 ORDER BY id FOR UPDATE', [identity.consumer_id])
    const key = siblings.rows.find(row => row.id === identity.id)
    if (key?.access_profile !== 'managed_full' || key.status !== 'active' || key.environment !== 'live'
      || key.scope_mode !== 'snapshot' || !key.expires_at || new Date(key.expires_at) <= new Date()) continue
    const active = await client.query(`SELECT 1 FROM tenants t JOIN consumers c ON c.tenant_id=t.id
      WHERE t.id=$1 AND c.id=$2 AND t.status='active' AND c.status='active' FOR SHARE OF t,c`, [key.tenant_id, key.consumer_id])
    if (!active.rowCount) continue
    if (siblings.rows.some(row => row.id !== key.id && row.status === 'active' && row.scope_mode === 'legacy_dynamic')) {
      throw new Error('Managed API access refused: sibling dynamic Key could inherit access')
    }
    const snapshot = async () => ({ accessProfile: 'managed_full', scopeMode: 'snapshot',
      platforms: (await client.query('SELECT platform FROM api_key_platform_entitlements WHERE api_key_id=$1 ORDER BY platform', [key.id])).rows.map(row => row.platform),
      capabilities: (await client.query('SELECT capability FROM api_key_capability_entitlements WHERE api_key_id=$1 ORDER BY capability', [key.id])).rows.map(row => row.capability),
      webSearchOrder: (await client.query('SELECT web_search_order FROM api_keys WHERE id=$1', [key.id])).rows[0].web_search_order })
    const before = await snapshot()
    let grants = 0
    for (const [column, names, grantTable, policyTable, entitlementTable] of [
      ['platform', scopes.platforms, 'platform_grants', 'consumer_platform_policies', 'api_key_platform_entitlements'],
      ['capability', scopes.capabilities, 'capability_grants', 'consumer_capability_policies', 'api_key_capability_entitlements'],
    ]) {
      grants += (await client.query(`INSERT INTO ${grantTable}(consumer_id,${column}) SELECT $1,unnest($2::text[]) ON CONFLICT DO NOTHING`, [key.consumer_id, names])).rowCount
      const pageColumn = column === 'platform' ? ',max_page_size' : ''
      const pageValue = column === 'platform' ? ',1000' : ''
      await client.query(`INSERT INTO ${policyTable}(tenant_id,consumer_id,${column},max_requests,window_seconds${pageColumn})
        SELECT $1,$2,unnest($3::text[]),1000,3600${pageValue} ON CONFLICT DO NOTHING`, [key.tenant_id, key.consumer_id, names])
      await client.query(`INSERT INTO ${entitlementTable}(api_key_id,${column},max_requests,window_seconds${pageColumn})
        SELECT $1,${column},max_requests,window_seconds${pageColumn} FROM ${policyTable}
        WHERE consumer_id=$2 AND ${column}=ANY($3::text[]) ON CONFLICT DO NOTHING`, [key.id, key.consumer_id, names])
    }
    const order = [...new Set([...(key.web_search_order || []), ...WEB_SEARCH_PROVIDERS.map(row => row.key)])]
    if (JSON.stringify(order) !== JSON.stringify(key.web_search_order)) await client.query('UPDATE api_keys SET web_search_order=$2 WHERE id=$1', [key.id, order])
    const after = await snapshot()
    if (grants || JSON.stringify(before) !== JSON.stringify(after)) {
      await client.query(`INSERT INTO api_key_scope_events(api_key_id,actor,previous_scopes,next_scopes)
        VALUES($1,'managed-full:catalog-sync',$2,$3)`, [key.id, JSON.stringify(before), JSON.stringify(after)])
      changed++
    }
  }
  return { keys: managed.rowCount, changed }
}
