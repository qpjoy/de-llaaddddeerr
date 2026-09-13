import { AppError } from '../core/errors.mjs'
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
export async function writeTenantAccess(pool, tenantId, input, actor) {
  const db = await pool.connect()
  try {
    await db.query('BEGIN')
    await db.query('SELECT pg_advisory_xact_lock(hashtext($1))',[`tenant-access:${tenantId}`])
    const before = await readTenantAccess(db,tenantId)
    if (before.revision !== input.revision) throw new AppError(409,'revision_conflict','Tenant access changed; reload before saving')
    const after = { ...input, revision: before.revision + 1 }
    const { rows } = await db.query('SELECT id FROM consumers WHERE tenant_id=$1 ORDER BY id',[tenantId])
    for (const row of rows) await applyTenantAccess(db,tenantId,row.id,before,after)
    await db.query('INSERT INTO tenant_service_access(tenant_id,revision,configuration) VALUES($1,$2,$3) ON CONFLICT(tenant_id) DO UPDATE SET revision=EXCLUDED.revision,configuration=EXCLUDED.configuration,updated_at=now()',[tenantId,after.revision,after])
    await db.query('INSERT INTO tenant_service_access_events(tenant_id,revision,actor,reason,configuration) VALUES($1,$2,$3,$4,$5)',[tenantId,after.revision,actor,input.reason,after])
    await db.query('COMMIT')
    return after
  } catch (error) { await db.query('ROLLBACK'); throw error } finally { db.release() }
}
