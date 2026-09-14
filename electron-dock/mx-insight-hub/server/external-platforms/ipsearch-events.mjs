import { randomUUID } from 'node:crypto'

// Counts authenticated HTTP attempts separately from logical usage and dispatch.
// No credential or input address is retained here.
export class IpSearchEvents {
  constructor(pool = null) { this.pool = pool; this.rows = new Map() }
  async begin(context) {
    const id = randomUUID()
    if (this.pool) await this.pool.query(`INSERT INTO external_platform.ipsearch_request_events
      (id, tenant_id, consumer_id, api_key_id) VALUES ($1,$2,$3,$4)`, [id, context.tenant.id, context.consumer.id, context.apiKey.id])
    else this.rows.set(id, { id, tenantId: context.tenant.id, consumerId: context.consumer.id, startedAt: new Date(), status: null })
    return id
  }
  async finish(id, status, errorCode, requestId, replay, latencyMs, batchId = null) {
    if (this.pool) await this.pool.query(`UPDATE external_platform.ipsearch_request_events SET
      status=$2, error_code=$3, usage_request_id=$4, replay=$5, latency_ms=$6, completed_at=now(), batch_id=$7 WHERE id=$1`,
    [id, status, errorCode, requestId || null, replay, latencyMs, batchId])
    else Object.assign(this.rows.get(id), { status, errorCode, requestId, replay, latencyMs, batchId })
  }
  async summary(from) {
    const rows = this.pool ? (await this.pool.query(`SELECT status, count(*)::integer AS count
      FROM external_platform.ipsearch_request_events WHERE started_at >= $1 GROUP BY status`, [from])).rows
      : Object.entries([...this.rows.values()].filter(row => row.startedAt >= from).reduce((counts, row) => {
        const key = row.status ?? 'pending'; counts[key] = (counts[key] || 0) + 1; return counts
      }, {})).map(([status, count]) => ({ status: status === 'pending' ? null : Number(status), count }))
    return { authenticatedHttpRequests: rows.reduce((sum, row) => sum + row.count, 0), byStatus: rows }
  }
}
