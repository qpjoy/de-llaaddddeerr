import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

const validId = value => typeof value === 'string' && /^[1-9]\d{0,17}$/.test(value)
export class CustomerMessages {
  constructor(pool, { logger = console } = {}) {
    this.pool = pool
    this.logger = logger
    this.running = null
    this.timer = null
  }

  // This worker reads only local delivered entitlements. It never queries Pay/suppliers,
  // alters an entitlement, or shares the Admin-only supplier incident stream.
  async collectBatch() {
    return withPgTransaction(this.pool, async client => {
      await client.query("SET LOCAL statement_timeout = '5s'")
      const lock = await client.query("SELECT pg_try_advisory_xact_lock(hashtext('commerce-customer-messages')) AS acquired")
      if (!lock.rows[0].acquired) return 0
      const result = await client.query(`WITH candidates AS (
        SELECT s.*, o.intent #>> '{product,name}' AS product_name,
          CASE WHEN s.ends_at<=now() THEN 'expired'
            WHEN s.starts_at>now() THEN 'scheduled'
            WHEN s.ends_at<=now()+interval '1 day' THEN 'expiring_1d'
            WHEN s.ends_at<=now()+interval '7 days' THEN 'expiring_7d'
            ELSE 'active' END AS kind
        FROM hub_commerce.subscriptions s JOIN hub_commerce.orders o ON o.id=s.order_id
        WHERE o.environment='live' AND o.delivered_at IS NOT NULL
      ) INSERT INTO hub_commerce.messages(tenant_id,subscription_id,kind,document)
        SELECT c.tenant_id,c.id,c.kind,jsonb_build_object('productName',c.product_name,
          'orderId',c.order_id,'startsAt',c.starts_at,'endsAt',c.ends_at,'quota',c.quota,
          'scope',CASE WHEN c.consumer_id IS NULL THEN 'tenant' ELSE 'consumer' END)
        FROM candidates c WHERE NOT EXISTS (
          SELECT 1 FROM hub_commerce.messages m WHERE m.subscription_id=c.id AND m.kind=c.kind)
        ORDER BY c.ends_at,c.id LIMIT 200
        ON CONFLICT(subscription_id,kind) DO NOTHING`)
      return result.rowCount
    })
  }
  collect() {
    if (!this.pool) return Promise.resolve()
    if (this.running) return this.running
    this.running = this.collectBatch().catch(() => {
      this.logger.warn('[customer-messages] Collection failed; saved messages remain available')
    }).finally(() => { this.running = null })
    return this.running
  }
  start() {
    if (!this.pool || this.timer) return
    void this.collect()
    this.timer = setInterval(() => { void this.collect() }, 60_000)
    this.timer.unref?.()
  }
  async close() { clearInterval(this.timer); this.timer = null; await this.running }
  requireStorage() {
    if (!this.pool) throw new AppError(503,'customer_messages_unavailable','消息服务暂不可用')
  }
  async list(tenantId, memberId, query = {}) {
    if (Object.keys(query).some(key => !['before','status'].includes(key)) ||
      (query.before !== undefined && !validId(query.before)) ||
      (query.status !== undefined && !['all','unread'].includes(query.status))) {
      throw new AppError(400,'invalid_message_filter','消息筛选条件不正确')
    }
    this.requireStorage()
    const values = [tenantId,memberId,query.before || null,query.status || 'all']
    const [rows, count] = await Promise.all([
      this.pool.query(`SELECT m.id,m.kind,m.document,m.created_at AS "createdAt",r.read_at AS "readAt"
        FROM hub_commerce.messages m LEFT JOIN hub_commerce.message_reads r ON r.message_id=m.id AND r.member_id=$2
        WHERE m.tenant_id=$1 AND (m.recipient_id IS NULL OR m.recipient_id=$2) AND ($3::bigint IS NULL OR m.id<$3) AND ($4='all' OR r.message_id IS NULL)
        ORDER BY m.id DESC LIMIT 21`,values),
      this.pool.query(`SELECT count(*)::integer AS unread FROM hub_commerce.messages m
        WHERE m.tenant_id=$1 AND (m.recipient_id IS NULL OR m.recipient_id=$2) AND NOT EXISTS (
          SELECT 1 FROM hub_commerce.message_reads r WHERE r.message_id=m.id AND r.member_id=$2)`,values.slice(0,2)),
    ])
    const items = rows.rows.slice(0,20)
    return { items, unread: count.rows[0].unread, nextBefore: rows.rows.length>20 ? items.at(-1).id : null }
  }
  async readAll(tenantId,memberId) {
    this.requireStorage();
    const result=await this.pool.query(`INSERT INTO hub_commerce.message_reads(message_id,member_id)
      SELECT id,$2 FROM hub_commerce.messages WHERE tenant_id=$1 AND (recipient_id IS NULL OR recipient_id=$2)
      ON CONFLICT(message_id,member_id) DO NOTHING`,[tenantId,memberId]);
    return {read:result.rowCount};
  }
  async read(tenantId, memberId, id) {
    if (!validId(id)) throw new AppError(400,'invalid_message_id','消息编号不正确')
    this.requireStorage()
    // Even a guessed message ID cannot create a read receipt in another space.
    const result = await this.pool.query(`INSERT INTO hub_commerce.message_reads(message_id,member_id)
      SELECT id,$2 FROM hub_commerce.messages WHERE tenant_id=$1 AND id=$3 AND (recipient_id IS NULL OR recipient_id=$2)
      ON CONFLICT(message_id,member_id) DO UPDATE SET read_at=hub_commerce.message_reads.read_at
      RETURNING read_at AS "readAt"`,[tenantId,memberId,id])
    if (!result.rowCount) throw new AppError(404,'message_not_found','消息不存在')
    return {id,...result.rows[0]}
  }
}
