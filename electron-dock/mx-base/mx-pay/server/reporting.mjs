import { authorize } from './config.mjs'
import { requirePayment } from '../src/index.mjs'

const idPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const validId=value=>typeof value==='string' && idPattern.test(value)
const encode=value=>Buffer.from(JSON.stringify(value)).toString('base64url')
const validSequence=s=>typeof s==='string' && /^(0|[1-9][0-9]{0,18})$/.test(s) && BigInt(s)<=9223372036854775807n
function decode(raw,kind,principal) {
  let value
  try {
    if(typeof raw!=='string' || raw.length>2048 || !/^[a-zA-Z0-9_-]+$/.test(raw))throw Error()
    value=JSON.parse(Buffer.from(raw,'base64url').toString('utf8'))
  } catch { requirePayment(false,'invalid_reporting_cursor','Invalid reporting cursor') }
  requirePayment(value?.v===1 && value.kind===kind && validId(value.source) && validSequence(value.position)
    && value.appId===principal.appId && value.environment===principal.environment
    && (kind!=='snapshot' || (validId(value.lastId) && validId(value.upperId) && value.lastId<=value.upperId)),'invalid_reporting_cursor','Cursor does not match this stream')
  return value
}
export class ReportingReader {
  constructor(pool) { this.pool=pool }
  async page(principal,query,kind) {
    authorize(principal,'reports.read')
    requirePayment([...query.keys()].every(k=>['after','limit'].includes(k) && query.getAll(k).length===1),'invalid_reporting_query','Only after and limit are supported')
    const limitText=query.get('limit') ?? '100', limit=Number(limitText)
    requirePayment(/^[1-9][0-9]{0,2}$/.test(limitText) && limit<=200,'invalid_reporting_query','Limit must be 1–200')
    const raw=query.get('after')
    requirePayment(kind==='snapshot' || Boolean(raw),'reporting_snapshot_required','Bootstrap from snapshot before consuming changes',409)
    const cursor=raw===null ? null : decode(raw,kind,principal)
    const client=await this.pool.connect()
    try {
      // Each page has a bounded consistent view. No transaction spans HTTP calls.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
      await client.query("SET LOCAL statement_timeout='2s'")
      const source=(await client.query('SELECT id,transaction_timestamp() AS observed_at FROM pay.reporting_source WHERE singleton')).rows[0]
      requirePayment(source,'reporting_unavailable','Reporting schema is not initialized',503)
      const head=(await client.query('SELECT position::text FROM pay.reporting_heads WHERE app_id=$1 AND environment=$2',[principal.appId,principal.environment])).rows[0]?.position || '0'
      if (cursor) {
        requirePayment(cursor.source===source.id,'reporting_source_changed','Source identity changed; reconcile before rebuilding',409)
        requirePayment(BigInt(cursor.position)<=BigInt(head),'reporting_source_rewound','Source is behind the saved checkpoint; do not reset it automatically',409)
      }
      const observedAt=source.observed_at.toISOString()
      const base={v:1,kind:'changes',source:source.id,appId:principal.appId,environment:principal.environment,position:cursor?.position || head}
      let rows, nextCursor, hasMore
      if(kind==='snapshot') {
        // Bound the scan by identity, not timestamps: a restored server's clock
        // may be behind an already committed order's creation timestamp.
        const upperId=cursor?.upperId || (await client.query('SELECT id FROM pay.orders WHERE app_id=$1 AND environment=$2 ORDER BY id DESC LIMIT 1',[principal.appId,principal.environment])).rows[0]?.id || '00000000-0000-0000-0000-000000000000'
        const args=[principal.appId,principal.environment,upperId,cursor?.lastId || '00000000-0000-0000-0000-000000000000',limit+1]
        rows=(await client.query('SELECT id,pay.reporting_document(document) AS document FROM pay.orders WHERE app_id=$1 AND environment=$2 AND id<=$3 AND id>$4 ORDER BY id LIMIT $5',args)).rows
        hasMore=rows.length>limit
        nextCursor=hasMore ? encode({...base,kind:'snapshot',upperId,lastId:rows[limit-1].id}) : null
      } else {
        rows=(await client.query('SELECT position::text,document FROM pay.reporting_changes WHERE app_id=$1 AND environment=$2 AND position>$3 AND position<=$4 ORDER BY position LIMIT $5',[principal.appId,principal.environment,cursor.position,head,limit+1])).rows
        hasMore=rows.length>limit
        nextCursor=encode({...base,position:rows.slice(0,limit).at(-1)?.position || cursor.position})
      }
      await client.query('COMMIT')
      return {version:1,source:{id:source.id,appId:principal.appId,environment:principal.environment},observedAt,limit,hasMore,
        items:rows.slice(0,limit).map(row=>row.document),nextCursor,
        // Snapshot pages can observe newer revisions; always replay from the
        // FIRST page's watermark and only upsert increasing order revisions.
        changesCursor:kind==='snapshot' ? encode(base) : nextCursor,
        highWaterCursor:encode({...base,position:head}),
      }
    } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error}
    finally {client.release()}
  }
  snapshot(principal,query=new URLSearchParams()) {return this.page(principal,query,'snapshot')}
  changes(principal,query=new URLSearchParams()) {return this.page(principal,query,'changes')}
}
