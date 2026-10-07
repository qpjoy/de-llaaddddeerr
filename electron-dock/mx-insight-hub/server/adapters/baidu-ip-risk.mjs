import { createHash, randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { withPgTransaction } from '../stores/postgres-store.mjs'

export const BAIDU_IP_ORIGIN = 'https://cloud.baidu.com/api/afd-ip-threat/act/v1/ipage'
const text = value => typeof value === 'string' && value.length <= 512 ? value || null : null
const number = value => typeof value === 'number' && Number.isFinite(value) ? value : null
export function normalizeBaiduIpRisk(base, overall) {
  if (!overall || typeof overall !== 'object' || Array.isArray(overall)) return {status:'unknown',data:null,warnings:[]}
  const warnings = []
  const level = text(overall.overall?.risk_score_new)
  const groups = overall.security_risks
  const tags = []
  if (groups && typeof groups === 'object' && !Array.isArray(groups)) {
    for (const [category,items] of Object.entries(groups)) {
      if (!Array.isArray(items)) { warnings.push('FIELD_INVALID:risk_tags'); continue }
      for (const item of items.slice(0,200)) {
        const children = Array.isArray(item?.subItems) && item.subItems.length ? item.subItems : [{name:item?.label,risk_level:item?.risk_level,update_day:item?.update_day}]
        for (const child of children.slice(0,200)) {
          if (text(child?.name)) tags.push({category:text(category),name:text(child.name),code:null,parent:text(item.label),risk_level:text(child.risk_level),last_seen:text(child.update_day)})
        }
      }
    }
  }
  if (!base || !Object.keys(base).length) warnings.push('FIELD_MISSING:location')
  if (!level) warnings.push('FIELD_MISSING:risk_level')
  const data = {risk_level:level,risk_score:null,proxy_type:null,rapid_rotation_probability_percent:null,human_probability_percent:null,risk_tags:tags,
    country:text(base?.country),province:text(base?.province),city:text(base?.city),district:text(base?.district),isp:text(base?.isp),scene:text(base?.scene),
    longitude:number(base?.lng),latitude:number(base?.lat),data_date:text(overall.update_day),data_available:typeof overall.available === 'boolean' ? overall.available : null}
  const meaningful = level || tags.length || [data.country,data.province,data.city,data.district,data.isp,data.scene,data.longitude,data.latitude].some(v => v != null && v !== '')
  return {status:meaningful ? warnings.length ? 'partial' : 'success' : overall.available === false ? 'no_data' : 'unknown',data,warnings}
}

export class BaiduIpRiskAdapter {
  constructor({pool,fetchImpl=fetch,timeoutMs=10000,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}) {
    Object.assign(this,{pool,fetch:fetchImpl,timeoutMs,sleep}); this.configured=true
  }
  async policy() {
    if (!this.pool) return {enabled:false,revision:0,daily_limit:1200,spacing_ms:2000,calls:0}
    return (await this.pool.query("SELECT * FROM hub_commerce.ip_channel WHERE id='baidu-v2'")).rows[0]
  }
  async capabilities() {
    const policy = await this.policy()
    const ready = policy?.enabled === true && (!policy.cooldown_until || new Date(policy.cooldown_until) <= new Date())
    return {platform:'ip_risk',ready,operations:{'ip.risk.query.v2':{ready,effectiveState:ready?'active':'paused'}}}
  }
  async claim(requestId,endpoint) {
    return withPgTransaction(this.pool,async client=>{
      const policy = (await client.query("SELECT *,now() AS current_time,(now() AT TIME ZONE 'Asia/Shanghai')::date AS today FROM hub_commerce.ip_channel WHERE id='baidu-v2' FOR UPDATE")).rows[0]
      if (!policy?.enabled) throw new AppError(503,'ip_channel_paused','IP v2 渠道暂停')
      const now = new Date(policy.current_time).getTime()
      if (policy.cooldown_until && new Date(policy.cooldown_until).getTime() > now) throw new AppError(429,'ip_channel_cooling','IP v2 渠道限流冷却中')
      const tokens = Math.min(10, Number(policy.tokens) + Math.max(0,now-new Date(policy.refill_at).getTime())/60000)
      if(tokens < 1) throw new AppError(429,'ip_channel_busy','IP v2 上游令牌不足，每分钟恢复 1 次请求')
      const used = String(policy.day) === String(policy.today) ? policy.calls : 0
      if (used >= policy.daily_limit) throw new AppError(429,'ip_channel_daily_limit','IP v2 上游日配额已用尽')
      const slot = Math.max(now,new Date(policy.next_at || now).getTime())
      if (slot-now > 10000) throw new AppError(429,'ip_channel_busy','IP v2 渠道繁忙，请稍后查询')
      const id = randomUUID()
      await client.query("UPDATE hub_commerce.ip_channel SET day=(now() AT TIME ZONE 'Asia/Shanghai')::date,calls=$1,next_at=$2,tokens=$3,refill_at=now() WHERE id='baidu-v2'",[used+1,new Date(slot+policy.spacing_ms),tokens-1])
      await client.query('INSERT INTO hub_commerce.ip_upstream_calls(id,request_id,endpoint) VALUES($1,$2,$3)',[id,requestId,endpoint])
      return {id,wait:slot-now}
    })
  }
  async query(ip,{requestId}={}) {
    const started=Date.now(), evidence=[], values={}
    const result={outcome:'unknown',errorCode:'ip_query_outcome_unknown',httpStatus:null,businessCode:null}
    try {
      for (const endpoint of ['base','overall']) {
        const slot=await this.claim(requestId,endpoint)
        if(slot.wait>0)await this.sleep(slot.wait)
        let bytes=null,status=null,outcome='unknown'
        try {
          const response=await this.fetch(`${BAIDU_IP_ORIGIN}/${endpoint}/${ip}`,{redirect:'error',signal:AbortSignal.timeout(this.timeoutMs),headers:{accept:'application/json',referer:'https://cloud.baidu.com/product-s/afd_s/ip-threat.html'}})
          status=response.status;result.httpStatus=status
          const chunks=[];let size=0
          for await(const chunk of response.body){size+=chunk.length;if(size>1048576)throw new Error('oversized');chunks.push(chunk)}
          bytes=Buffer.concat(chunks)
          evidence.push({endpoint,httpStatus:status,bodyBase64:bytes.toString('base64')})
          if(status===429){
            await this.pool.query("UPDATE hub_commerce.ip_channel SET cooldown_until=now()+interval '30 minutes',last_status='rate_limited',last_observed_at=now() WHERE id='baidu-v2'")
            outcome='rejected';result.outcome='rejected';result.errorCode='ip_channel_rate_limited';return result
          }
          const payload=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes)), ret=payload?.ret_data
          const code=ret?.code;result.businessCode=Number.isSafeInteger(Number(code))?Number(code):null
          if(code===601 || code==='601' || status===429){
            await this.pool.query("UPDATE hub_commerce.ip_channel SET cooldown_until=now()+interval '30 minutes',last_status='rate_limited',last_observed_at=now() WHERE id='baidu-v2'")
            outcome='rejected';result.outcome='rejected';result.errorCode='ip_channel_rate_limited';return result
          }
          if(status!==200 || code!=null && ![0,200,'0','200'].includes(code)) {
            result.outcome=status>=500?'unknown':'rejected';outcome=result.outcome;result.errorCode='ip_query_rejected';return result
          }
          if(!ret?.data || typeof ret.data!=='object' || Array.isArray(ret.data)) {result.errorCode='ip_response_unusable';return result}
          if(ret.data.ip != null && ret.data.ip !== ip){result.errorCode='ip_response_unusable';return result}
          values[endpoint]=ret.data;outcome='succeeded'
        } finally {
          await this.pool.query('UPDATE hub_commerce.ip_upstream_calls SET status=$2,body=$3,outcome=$4,completed_at=now() WHERE id=$1',[slot.id,status,bytes,outcome])
        }
      }
      result.normalized=normalizeBaiduIpRisk(values.base,values.overall)
      result.outcome=result.normalized.status==='unknown'?'succeeded_unusable':'succeeded'
      result.errorCode=result.outcome==='succeeded'?null:'ip_response_unusable'
      await this.pool.query("UPDATE hub_commerce.ip_channel SET last_status=$1,last_observed_at=now() WHERE id='baidu-v2'",[result.outcome])
      return result
    } catch(error) {
      if(error instanceof AppError && error.code.startsWith('ip_channel_')){result.outcome='rejected';result.errorCode=error.code}
      return result
    } finally {
      // Composite archive is explicitly a container of exact subresponse bytes.
      const bodyBytes=Buffer.from(JSON.stringify({format:'baidu-ip-subresponses.v1',responses:evidence})),bodySha256=createHash('sha256').update(bodyBytes).digest('hex')
      result.restrictedResponseArchive={bodyBytes,bodySize:bodyBytes.length,bodySha256,bodyText:bodyBytes.toString(),jsonParsed:true,parsedPayload:JSON.parse(bodyBytes),capturedAt:new Date()}
      result.responseArchive={httpStatus:result.httpStatus,businessCode:result.businessCode,contractState:'reference',payloadSha256:bodySha256,bodySize:bodyBytes.length,capturedAt:new Date(),rawPayload:null}
      result.latencyMs=Date.now()-started
    }
  }
}
