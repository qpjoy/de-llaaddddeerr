import { AppError } from '../core/errors.mjs'
import { tenantAccessPreview, assertTenantAccessReview } from '../tenant-access-sync.mjs'
import { authorizationScopeLockKey } from './usage-authorization.mjs'

export async function readTenantAccess(db, tenantId) {
  const { rows } = await db.query('SELECT configuration, revision FROM tenant_service_access WHERE tenant_id=$1', [tenantId])
  return rows[0] ? { ...rows[0].configuration, revision: rows[0].revision } : { platforms: [], capabilities: [], revision: 0, maxRequests: 1000, windowSeconds: 3600, maxPageSize: 100, maxCrawlWork: 100 }
}
export async function applyTenantAccess(db, tenantId, consumerId, before, after) {
  for (const [type, field, table, column] of [['platform','platforms','platform_grants','platform'],['capability','capabilities','capability_grants','capability']]) {
    for (const scope of [...new Set([...before[field], ...after[field]])].sort()) {
      await db.query('SELECT pg_advisory_xact_lock(hashtext($1))', [authorizationScopeLockKey(consumerId,{type,key:scope})])
      if (!after[field].includes(scope)) {
        await db.query(`DELETE FROM ${table} WHERE consumer_id=$1 AND ${column}=$2`, [consumerId,scope])
        continue
      }
      await db.query(`INSERT INTO ${table}(consumer_id,${column}) VALUES($1,$2) ON CONFLICT DO NOTHING`,[consumerId,scope])
      if (type === 'platform') await db.query(`INSERT INTO consumer_platform_policies(tenant_id,consumer_id,platform,max_requests,window_seconds,max_page_size,max_crawl_work) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(consumer_id,platform) DO UPDATE SET max_requests=EXCLUDED.max_requests,window_seconds=EXCLUDED.window_seconds,max_page_size=EXCLUDED.max_page_size,max_crawl_work=EXCLUDED.max_crawl_work,updated_at=now()`,[tenantId,consumerId,scope,after.maxRequests,after.windowSeconds,after.maxPageSize,after.maxCrawlWork])
      else await db.query(`INSERT INTO consumer_capability_policies(tenant_id,consumer_id,capability,max_requests,window_seconds) VALUES($1,$2,$3,$4,$5) ON CONFLICT(consumer_id,capability) DO UPDATE SET max_requests=EXCLUDED.max_requests,window_seconds=EXCLUDED.window_seconds,updated_at=now()`,[tenantId,consumerId,scope,after.maxRequests,after.windowSeconds])
    }
  }
}
async function tenantKeySnapshot(db, tenantId) {
  const { rows: keys } = await db.query(`SELECT k.id, k.consumer_id, k.name, k.status, k.expires_at, k.scope_mode, k.web_search_order,
    c.name AS consumer_name FROM api_keys k JOIN consumers c ON c.id=k.consumer_id
    WHERE k.tenant_id=$1 ORDER BY k.id`, [tenantId])
  const snapshots = keys.map(key => ({ id: key.id, consumerId: key.consumer_id, consumerName: key.consumer_name,
    name: key.name, status: key.status, expiresAt: key.expires_at, scopeMode: key.scope_mode,
    webSearchOrder: key.web_search_order || [], platforms: [], capabilities: [], entitlements: {} }))
  const byId = new Map(snapshots.map(key => [key.id, key]))
  for (const [field, column, table, grants, policies] of [
    ['platforms', 'platform', 'api_key_platform_entitlements', 'platform_grants', 'consumer_platform_policies'],
    ['capabilities', 'capability', 'api_key_capability_entitlements', 'capability_grants', 'consumer_capability_policies'],
  ]) {
    const page = column === 'platform' ? ', e.max_page_size' : ''
    const dynamicPage = column === 'platform' ? ', coalesce(p.max_page_size,100) AS max_page_size' : ''
    const { rows } = await db.query(`SELECT e.api_key_id, e.${column}, e.max_requests, e.window_seconds${page}
      FROM ${table} e JOIN api_keys k ON k.id=e.api_key_id WHERE k.tenant_id=$1 AND k.scope_mode='snapshot'
      UNION ALL SELECT k.id AS api_key_id, g.${column}, coalesce(p.max_requests,1000), coalesce(p.window_seconds,3600)${dynamicPage}
      FROM api_keys k JOIN ${grants} g ON g.consumer_id=k.consumer_id
      LEFT JOIN ${policies} p ON p.consumer_id=g.consumer_id AND p.${column}=g.${column}
      WHERE k.tenant_id=$1 AND k.scope_mode='legacy_dynamic' ORDER BY api_key_id, ${column}`, [tenantId])
    for (const row of rows) {
      const key = byId.get(row.api_key_id)
      key[field].push(row[column])
      ;(key.entitlements[field] ||= []).push(row)
    }
  }
  return snapshots
}

export async function previewTenantAccess(pool, tenantId, input) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    const before = await readTenantAccess(db, tenantId)
    const keys = await tenantKeySnapshot(db, tenantId)
    const { rows } = await db.query('SELECT id FROM consumers WHERE tenant_id=$1 ORDER BY id', [tenantId])
    const preview = tenantAccessPreview(tenantId, before, input, keys, rows.length)
    await db.query('COMMIT')
    return preview
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}

export async function writeTenantAccess(pool, tenantId, input, actor, review) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tenant-access:${tenantId}`])
    await db.query('SELECT id FROM api_keys WHERE tenant_id=$1 ORDER BY id FOR UPDATE', [tenantId])
    const before = await readTenantAccess(db,tenantId)
    if (before.revision !== input.revision) throw new AppError(409,'revision_conflict','Tenant access changed; reload before saving')
    const after = { ...input, revision: before.revision + 1 }
    const { rows } = await db.query('SELECT id FROM consumers WHERE tenant_id=$1 ORDER BY id',[tenantId])
    const keys = await tenantKeySnapshot(db, tenantId)
    const preview = tenantAccessPreview(tenantId, before, input, keys, rows.length)
    assertTenantAccessReview(preview, review)
    for (const row of rows) await applyTenantAccess(db,tenantId,row.id,before,after)
    const byId = new Map(keys.map(key => [key.id, key]))
    for (const change of preview.keys.filter(key => key.changed)) {
      const key = byId.get(change.id)
      for (const [field, column, table] of [
        ['platforms', 'platform', 'api_key_platform_entitlements'],
        ['capabilities', 'capability', 'api_key_capability_entitlements'],
      ]) {
        await db.query(`DELETE FROM ${table} WHERE api_key_id=$1 AND ${column}=ANY($2::text[])`, [key.id, preview.removed[field]])
        const additions = key.scopeMode === 'legacy_dynamic' ? change.next[field] : change.added[field]
        for (const scope of additions) {
          const old = (key.entitlements[field] || []).find(row => row[column] === scope)
          const values = [key.id, scope, old?.max_requests ?? input.maxRequests, old?.window_seconds ?? input.windowSeconds]
          if (column === 'platform') values.push(old?.max_page_size ?? input.maxPageSize)
          await db.query(`INSERT INTO ${table}(api_key_id,${column},max_requests,window_seconds${column === 'platform' ? ',max_page_size' : ''})
            VALUES(${values.map((_, i) => '$' + (i + 1)).join(',')}) ON CONFLICT DO NOTHING`, values)
        }
      }
      await db.query("UPDATE api_keys SET scope_mode='snapshot',web_search_order=$2 WHERE id=$1", [key.id, change.next.webSearchOrder])
      await db.query('INSERT INTO api_key_scope_events(api_key_id,actor,previous_scopes,next_scopes) VALUES($1,$2,$3,$4)',
        [key.id, actor, JSON.stringify(change.previous), JSON.stringify(change.next)])
    }
    await db.query('INSERT INTO tenant_service_access(tenant_id,revision,configuration) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,configuration=EXCLUDED.configuration,updated_at=now()',[tenantId,after.revision,after])
    await db.query('INSERT INTO tenant_service_access_events(tenant_id,revision,actor,reason,configuration) VALUES($1,$2,$3,$4,$5)',[tenantId,after.revision,actor,input.reason,after])
    await db.query('COMMIT')
    return after
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}
