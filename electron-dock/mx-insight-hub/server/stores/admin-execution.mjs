import { randomUUID } from 'node:crypto'

// One atomic, auditable creation. Later selection/renewal never repairs a
// revoked/expired key, restores removed grants, or expands its scope snapshot.
export async function ensurePostgresAdminExecution(pool, input) {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT pg_advisory_xact_lock(hashtext('hub-admin-execution-identity'))")
    const existing = await client.query('SELECT api_key_id FROM control.admin_execution_identity WHERE singleton')
    if (existing.rows[0]) { await client.query('COMMIT'); return existing.rows[0].api_key_id }
    const tenantId = randomUUID(), consumerId = randomUUID()
    await client.query("INSERT INTO tenants (id,name) VALUES ($1,'Hub Admin 执行')", [tenantId])
    await client.query("INSERT INTO consumers (id,tenant_id,name,business_id) VALUES ($1,$2,'Hub Admin 执行',$3)", [consumerId, tenantId, `mxih:admin:${consumerId}`])
    // Existing consumer trigger assigns the default published plan; billing
    // remains the normal tenant profile, and provider admission is unchanged.
    await client.query(`INSERT INTO api_keys (id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four,environment,scope_mode,expires_at)
      VALUES ($1,$2,$3,'Admin',$4,$5,$6,'live','snapshot',$7)`, [input.id, tenantId, consumerId, input.digest, input.prefix, input.lastFour, input.expiresAt])
    for (const platform of input.platforms) {
      await client.query('INSERT INTO platform_grants (consumer_id,platform) VALUES ($1,$2)', [consumerId, platform])
      await client.query('INSERT INTO api_key_platform_entitlements (api_key_id,platform,max_requests,window_seconds,max_page_size) VALUES ($1,$2,1000,3600,100)', [input.id, platform])
    }
    for (const capability of input.capabilities) {
      await client.query('INSERT INTO capability_grants (consumer_id,capability) VALUES ($1,$2)', [consumerId, capability])
      await client.query('INSERT INTO api_key_capability_entitlements (api_key_id,capability,max_requests,window_seconds) VALUES ($1,$2,1000,3600)', [input.id, capability])
    }
    await client.query(`INSERT INTO control.admin_execution_identity (api_key_id,scope_snapshot,created_by) VALUES ($1,$2,'admin-token')`, [input.id, JSON.stringify({ platforms: input.platforms, capabilities: input.capabilities })])
    await client.query('COMMIT')
    return input.id
  } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error }
  finally { client.release() }
}
