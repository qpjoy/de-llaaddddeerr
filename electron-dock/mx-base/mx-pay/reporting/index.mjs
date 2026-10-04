// Optional server-side consumer. The caller supplies its own PostgreSQL pool;
// neither this package nor the read API has access to the consumer's wallet.
import { fileURLToPath } from 'node:url'
import { PaymentClient } from '../src/client.mjs'
import { requirePayment, fingerprint } from '../src/index.mjs'

export const reportingMigrationsDir=fileURLToPath(new URL('./migrations/',import.meta.url))
const validId=s=>typeof s==='string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(s)
const validName=s=>typeof s==='string' && /^[a-zA-Z0-9._-]{1,80}$/.test(s)
const validText=s=>typeof s==='string' && s.length>0 && s.length<=128
const validTime=s=>typeof s==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(s) && Number.isFinite(Date.parse(s))
const validCursor=s=>typeof s==='string' && s.length>0 && s.length<=2048 && /^[A-Za-z0-9_-]+$/.test(s)
const minor=n=>Number.isSafeInteger(n) && n>=0 && n<=10_000_000
const fields=['id','appId','environment','businessOrderId','customerRef','revision','status','provider','merchantAccountId','currency','amountMinor','receivedAmountMinor','feeMinor','paidAt','confirmedAt','createdAt','updatedAt']
const check=(ok,code='reporting_contract_invalid')=>requirePayment(ok,code,'Payment reporting data requires verification',409)
export function parseReportingSources(raw) {
  if(!raw)return []
  let sources
  try {sources=JSON.parse(raw)} catch {throw Error('Invalid payment reporting configuration')}
  if(!Array.isArray(sources) || sources.length>16)throw Error('Invalid payment reporting configuration')
  const ids=new Set()
  return sources.map(source=>{
    if(!source || !validName(source.id) || ids.has(source.id) || !validName(source.appId) || !['test','live'].includes(source.environment)
      || Object.keys(source).some(k=>!['id','appId','environment','baseUrl','token','expectedSourceId'].includes(k))
      || (source.expectedSourceId!=null && !validId(source.expectedSourceId)))throw Error('Invalid payment reporting configuration')
    ids.add(source.id)
    // Validate fixed origins and secrets once; requests cannot choose a target.
    new PaymentClient(source)
    return {...source}
  })
}
function validatePage(page,source,stream,phase) {
  check(page?.version===1 && validId(page.source?.id) && page.source.appId===source.appId && page.source.environment===source.environment)
  check(!source.expectedSourceId || source.expectedSourceId===page.source.id,'reporting_source_changed')
  check(!stream.source_id || stream.source_id===page.source.id,'reporting_source_changed')
  check(page.phase===phase && typeof page.hasMore==='boolean' && Array.isArray(page.items) && page.items.length<=100
    && validTime(page.observedAt) && validCursor(page.highWaterCursor) && validCursor(page.changesCursor))
  check(page.nextCheckpoint?.phase===(phase==='snapshot' && page.hasMore ? 'snapshot':'changes') && validCursor(page.nextCheckpoint.cursor))
  check(!page.hasMore || (page.items.length>0 && page.nextCheckpoint.cursor!==stream.checkpoint?.cursor))
  return page.items.map(order=>{
    check(order && fields.every(k=>Object.hasOwn(order,k)) && Object.keys(order).every(k=>fields.includes(k)))
    check(validId(order.id) && order.appId===source.appId && order.environment===source.environment
      && validText(order.businessOrderId) && validText(order.customerRef) && validText(order.merchantAccountId)
      && Number.isSafeInteger(order.revision) && order.revision>=0 && ['pending','submitted','paid','cancelled'].includes(order.status)
      && [source.environment==='test'?'mock':'manual_alipay','alipay'].includes(order.provider) && order.currency==='CNY'
      && minor(order.amountMinor) && order.amountMinor>=500 && validTime(order.createdAt) && validTime(order.updatedAt))
    check(order.status==='paid' ? order.receivedAmountMinor===order.amountMinor && (order.feeMinor===null || minor(order.feeMinor) && order.feeMinor<=order.receivedAmountMinor)
      && validTime(order.paidAt) && validTime(order.confirmedAt)
      : order.receivedAmountMinor===null && order.feeMinor===null && order.paidAt===null && order.confirmedAt===null)
    return order
  })
}
const safeError=error=>new Set(['reporting_source_changed','reporting_source_rewound','reporting_contract_invalid','reporting_revision_conflict','reporting_binding_changed',
  'payment_auth_required','payment_scope_required','reporting_busy','invalid_reporting_cursor']).has(error?.code) ? error.code : 'reporting_unavailable'

export class PaymentReportingStore {
  constructor(pool) {this.pool=pool}
  async stream(source) {
    await this.pool.query('INSERT INTO pay_reporting.streams(id,app_id,environment) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING',[source.id,source.appId,source.environment])
    const row=(await this.pool.query('SELECT * FROM pay_reporting.streams WHERE id=$1',[source.id])).rows[0]
    check(row.app_id===source.appId && row.environment===source.environment,'reporting_binding_changed')
    return row
  }
  async sync(source,client=new PaymentClient({...source,timeoutMs:5000})) {
    const before=await this.stream(source)
    if(before.next_attempt_at>new Date())return {deferred:true}
    let committed=false
    try {
      const result=await client.syncReportingPage(async page=>{
        const orders=validatePage(page,source,before,before.checkpoint?.phase || 'snapshot')
        const db=await this.pool.connect()
        try {
          await db.query('BEGIN')
          const current=(await db.query('SELECT version FROM pay_reporting.streams WHERE id=$1 FOR UPDATE',[source.id])).rows[0]
          // HTTP calls hold no database locks. Multiple workers may fetch the
          // same page, but only one version can commit its data and checkpoint.
          if(current.version!==before.version){await db.query('ROLLBACK');return}
          const existingRows=orders.length ? (await db.query('SELECT payment_id,revision,document FROM pay_reporting.orders WHERE stream_id=$1 AND payment_id=ANY($2::uuid[])',[source.id,orders.map(o=>o.id)])).rows : []
          const versions=new Map(existingRows.map(row=>[row.payment_id,row])),updates=new Map()
          for(const order of orders) {
            const existing=versions.get(order.id)
            if(existing)check(['id','appId','environment','businessOrderId','customerRef','provider','merchantAccountId','currency','amountMinor','createdAt'].every(k=>existing.document[k]===order[k]),'reporting_revision_conflict')
            if(existing && Number(existing.revision)===order.revision)check(fingerprint(existing.document)===fingerprint(order),'reporting_revision_conflict')
            if(existing && Number(existing.revision)>=order.revision)continue
            if(existing)check(!['paid','cancelled'].includes(existing.document.status),'reporting_revision_conflict')
            versions.set(order.id,{revision:order.revision,document:order})
            updates.set(order.id,{id:order.id,revision:order.revision,document:order,paid_at:order.paidAt})
          }
          // One bulk write per page, including when a changes page contains
          // several revisions of one order. No network round trip per row.
          if(updates.size)await db.query(`INSERT INTO pay_reporting.orders(stream_id,payment_id,revision,document,paid_at)
            SELECT $1,x.id,x.revision,x.document,x.paid_at FROM jsonb_to_recordset($2::jsonb) AS x(id uuid,revision bigint,document jsonb,paid_at timestamptz)
            ON CONFLICT(stream_id,payment_id) DO UPDATE SET revision=excluded.revision,document=excluded.document,paid_at=excluded.paid_at`,
          [source.id,JSON.stringify([...updates.values()])])
          await db.query(`UPDATE pay_reporting.streams SET source_id=$2,checkpoint=$3,version=version+1,last_attempt_at=now(),last_success_at=now(),observed_at=$4,
            high_water_cursor=$5,caught_up_at=CASE WHEN $6 THEN now() ELSE caught_up_at END,last_error=NULL,failures=0,next_attempt_at=now() WHERE id=$1`,
          [source.id,page.source.id,page.nextCheckpoint,page.observedAt,page.highWaterCursor,page.phase==='changes' && !page.hasMore])
          await db.query('COMMIT');committed=true
        } catch(error){await db.query('ROLLBACK').catch(()=>{});throw error}
        finally {db.release()}
      },before.checkpoint)
      return {committed,hasMore:result.hasMore || result.initialCatchupRequired}
    } catch(error) {
      // Only fixed error codes are persisted; upstream bodies/URLs/secrets are
      // never copied into a status endpoint. A stale failure cannot overwrite
      // a newer worker's success, nor can it clear the saved checkpoint.
      await this.pool.query(`UPDATE pay_reporting.streams SET last_attempt_at=now(),last_error=$3,failures=LEAST(failures+1,20),
        next_attempt_at=now()+LEAST(300,5*power(2,LEAST(failures,6))) * interval '1 second' WHERE id=$1 AND version=$2`,[source.id,before.version,safeError(error)]).catch(()=>{})
      throw error
    }
  }
  async status(ids) {
    const {rows}=await this.pool.query(`SELECT id,app_id AS "appId",environment,source_id AS "sourceId",checkpoint->>'phase' AS phase,
      version::text,last_attempt_at AS "lastAttemptAt",last_success_at AS "lastSuccessAt",observed_at AS "sourceObservedAt",
      caught_up_at AS "caughtUpAt",last_error AS "lastError",failures,next_attempt_at AS "nextAttemptAt",
      (checkpoint->>'phase'='changes' AND checkpoint->>'cursor'=high_water_cursor AND caught_up_at IS NOT NULL) AS "caughtUp",
      (caught_up_at IS NULL OR caught_up_at<now()-interval '2 minutes' OR last_error IS NOT NULL) AS stale
      FROM pay_reporting.streams WHERE id=ANY($1::text[]) ORDER BY id`,[ids])
    return rows
  }
  async orders(id,{after,limit=50}={}) {
    requirePayment((after==null || validId(after)) && Number.isInteger(limit) && limit>=1 && limit<=100,'invalid_reporting_query','Invalid pagination')
    const {rows}=await this.pool.query('SELECT payment_id,document FROM pay_reporting.orders WHERE stream_id=$1 AND payment_id>$2 ORDER BY payment_id LIMIT $3',[id,after || '00000000-0000-0000-0000-000000000000',limit+1])
    return {items:rows.slice(0,limit).map(r=>r.document),nextAfter:rows.length>limit?rows[limit-1].payment_id:null}
  }
  async daily(id,from,to) {
    const date=s=>typeof s==='string' && /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(Date.parse(s)) && new Date(s).toISOString().slice(0,10)===s
    requirePayment(date(from) && date(to) && Date.parse(to)>=Date.parse(from) && Date.parse(to)-Date.parse(from)<366*86400000,'invalid_reporting_query','Use a date range of at most 366 days')
    const {rows}=await this.pool.query(`SELECT (paid_at AT TIME ZONE 'Asia/Shanghai')::date::text AS day,currency,count(*)::text AS "paidCount",
      sum(received_minor)::text AS "receivedMinor",sum(fee_minor)::text AS "knownFeeMinor",count(*) FILTER(WHERE fee_minor IS NULL)::text AS "unknownFeeCount"
      FROM pay_reporting.orders WHERE stream_id=$1 AND status='paid' AND paid_at>=($2::date::timestamp AT TIME ZONE 'Asia/Shanghai')
      AND paid_at<(($3::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') GROUP BY 1,2 ORDER BY 1,2`,[id,from,to])
    return {timezone:'Asia/Shanghai',from,to,items:rows}
  }
}

// Only read endpoints are called. Catch-up runs in bounded batches and failures
// back off independently per source; no work is performed by query endpoints.
export class PaymentReportingWorker {
  constructor(store,sources,{intervalMs=15000,logger=console}={}) {this.store=store;this.sources=sources;this.intervalMs=intervalMs;this.logger=logger;this.stopped=true}
  async runOnce() {
    for(const source of this.sources) {
      for(let page=0;page<10;page++) {
        if(this.stopped)break
        try {const result=await this.store.sync(source);if(!result.committed || !result.hasMore)break}
        catch(error){this.logger.error?.(JSON.stringify({service:'payment-reporting',source:source.id,code:safeError(error)}));break}
      }
    }
  }
  start() {
    if(!this.stopped)return
    this.stopped=false
    const tick=()=>{this.running=this.runOnce().catch(()=>{}).finally(()=>{if(!this.stopped){this.timer=setTimeout(tick,this.intervalMs);this.timer.unref?.()}})}
    tick()
  }
  async close() {this.stopped=true;clearTimeout(this.timer);await this.running}
}
