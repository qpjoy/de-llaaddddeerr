import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeIpRiskRequest, IP_RISK_VERSION } from '../contracts/ip-risk.mjs'

// Durable batch envelope: a crashed/unfinished batch is never automatically redispatched.
// Child requests use the normal authorization, quota, archival and dispatch boundary.
export class IpRiskBatch {
  constructor(gateway) { this.gateway = gateway; this.pool = gateway.platformStore.pool; this.rows = new Map() }
  async claim(context, key, fingerprint) {
    const identity = JSON.stringify([context.consumer.id, key])
    if (!this.pool) {
      if (this.rows.has(identity)) return { row: this.rows.get(identity), owned: false }
      const row = { id: randomUUID(), fingerprint, response: null }
      this.rows.set(identity, row)
      return { row, owned: true }
    }
    const inserted = await this.pool.query(`INSERT INTO external_platform.ipsearch_batches
      (id, tenant_id, consumer_id, api_key_id, idempotency_key, fingerprint)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (consumer_id,idempotency_key) DO NOTHING RETURNING id,fingerprint,response`,
    [randomUUID(), context.tenant.id, context.consumer.id, context.apiKey.id, key, fingerprint])
    if (inserted.rows.length) return { row: inserted.rows[0], owned: true }
    const existing = await this.pool.query('SELECT id,fingerprint,response FROM external_platform.ipsearch_batches WHERE consumer_id=$1 AND idempotency_key=$2', [context.consumer.id, key])
    return { row: existing.rows[0], owned: false }
  }
  async query(context, input) {
    const started = Date.now(), eventId = await this.gateway.events.begin(context)
    let result, failure
    try { result = await this.execute(context, input); return result }
    catch (error) { failure = error; throw error }
    finally { await this.gateway.events.finish(eventId, result?.status || failure?.status || 503,
      failure?.code || null, null, !!result?.replay, Date.now() - started, result?.batchId || failure?.details?.batchId).catch(() => {}) }
  }
  async execute(context, { body, idempotencyKey, path }) {
    const grants = await this.gateway.usageStore.listEffectiveGrants(context.consumer.id, context.apiKey.id)
    const capabilities = await this.gateway.usageStore.listEffectiveCapabilityGrants(context.consumer.id, context.apiKey.id)
    if (!grants.includes('ip_risk') || !capabilities.includes('ip.risk.query')) throw new AppError(403, 'capability_not_granted', 'IP risk queries are not granted')
    if (context.apiKey.environment === 'test' || context.apiKey.prefix?.startsWith('mih_test_')) throw new AppError(403, 'test_key_not_supported', 'Use a Live Hub key')
    if (!body || Array.isArray(body) || Object.keys(body).length !== 1 || !Array.isArray(body.ips) || body.ips.length < 1 || body.ips.length > 100) throw new AppError(400, 'invalid_ip_batch', 'Provide 1–100 IPv4 addresses in ips')
    idempotencyKey ??= `ip-batch-auto-${randomUUID()}`
    const ips = body.ips.map(ip => normalizeIpRiskRequest({ ip }).ip)
    if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(idempotencyKey)) throw new AppError(400, 'invalid_idempotency_key', 'Idempotency-Key requires 8–128 safe characters')
    const fingerprint = createHash('sha256').update(JSON.stringify({ path, ips, version: IP_RISK_VERSION })).digest('hex')
    const { row, owned } = await this.claim(context, idempotencyKey, fingerprint)
    if (!row || row.fingerprint !== fingerprint) throw new AppError(409, 'request_conflict', 'Idempotency-Key identifies a different batch')
    if (!owned) {
      if (!row.response) throw new AppError(409, 'batch_pending_or_unknown', 'Retain the batch identity for reconciliation', { batchId: row.id })
      return { status: 200, body: { ...structuredClone(row.response), meta: { ...row.response.meta, sourceMode: 'idempotent_replay' } }, batchId: row.id, replay: true }
    }
    const deadline = Date.now() + 60000
    const results = new Array(ips.length)
    // Serialize equal IPs even across workers so duplicate successful inputs remain distinct calls.
    const chains = new Map()
    let next = 0
    const worker = async () => {
      while (next < ips.length) {
        const index = next++, ip = ips[index]
        const previous = chains.get(ip) || Promise.resolve()
        let release
        chains.set(ip, new Promise(resolve => { release = resolve }))
        await previous
        try {
          // Do not launch work that cannot finish within the batch budget.
          if (Date.now() + 15000 > deadline) { results[index] = { index, ip, status: 504, error: { code: 'batch_deadline_not_dispatched', message: 'Item was not dispatched before the batch deadline' } }; continue }
          try {
            const result = await this.gateway.execute(context, { body: { ip }, path: '/api/v1/data/ip/risk', idempotencyKey: `ip-batch-${row.id}-${index}` })
            results[index] = { index, ip, status: result.status, response: result.body }
          } catch (error) { results[index] = { index, ip, status: error.status || 503, error: { code: error.code || 'ip_risk_unavailable', message: 'Item could not be completed' }, requestId: error.details?.requestId } }
        } finally { release() }
      }
    }
    await Promise.all(Array.from({ length: Math.min(3, ips.length) }, worker))
    const response = { contractVersion: IP_RISK_VERSION, batchId: row.id, data: results,
      meta: { sourceMode: 'live', pricingStatus: 'plan_based', chargeStatus: 'see_usage', requestedItems: ips.length, succeededItems: results.filter(item => item.status === 200).length } }
    if (this.pool) await this.pool.query('UPDATE external_platform.ipsearch_batches SET response=$2::jsonb,completed_at=now() WHERE id=$1', [row.id, JSON.stringify(response)])
    else row.response = structuredClone(response)
    return { status: 200, body: response, batchId: row.id, replay: false }
  }
}
