import { createHash,randomUUID } from 'node:crypto'
import { AppError } from '../core/errors.mjs'
import { normalizeIpRiskRequest } from '../contracts/ip-risk.mjs'

// Explicit fan-out only. A durable batch fixes every selected channel before dispatch.
export class IpRiskChannels {
  constructor(v1,v2) { this.v1=v1; this.v2=v2; this.channels={'legacy-v1':v1,'baidu-v2':v2} }
  async query(context,{body,idempotencyKey,path}) {
    if(!body || Array.isArray(body) || Object.keys(body).some(k=>!['ip','ips','channels'].includes(k)) || (!!body.ip === !!body.ips)) throw new AppError(400,'invalid_ip_request','Provide ip or ips and optional channels')
    const channels=body.channels ?? ['baidu-v2']
    const ips=body.ips ?? [body.ip]
    if(!Array.isArray(channels) || channels.length<1 || channels.length>2 || new Set(channels).size!==channels.length || channels.some(c=>!Object.hasOwn(this.channels,c))
      || !Array.isArray(ips) || ips.length<1 || ips.length*channels.length>100) throw new AppError(400,'invalid_ip_request','Select 1–2 channels and at most 100 IP × channel items')
    const values=ips.map(ip=>normalizeIpRiskRequest({ip}).ip)
    const grants=await this.v2.usageStore.listEffectiveGrants(context.consumer.id,context.apiKey.id),capabilities=await this.v2.usageStore.listEffectiveCapabilityGrants(context.consumer.id,context.apiKey.id)
    if(!grants.includes('ip_risk') || channels.some(c=>!capabilities.includes(this.channels[c].operation))) throw new AppError(403,'capability_not_granted','Every selected channel must be granted')
    if(context.apiKey.environment==='test' || context.apiKey.prefix?.startsWith('mih_test_')) throw new AppError(403,'test_key_not_supported','Use a Live Hub key')
    idempotencyKey??=`ip-v2-auto-${randomUUID()}`
    if(typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) throw new AppError(400,'invalid_idempotency_key','Invalid Idempotency-Key')
    const fingerprint=createHash('sha256').update(JSON.stringify({path,ips:values,channels,key:context.apiKey.id})).digest('hex')
    const {row,owned}=await this.v2.batch.claim(context,idempotencyKey,fingerprint)
    if(row.fingerprint!==fingerprint)throw new AppError(409,'request_conflict','Idempotency-Key identifies another query')
    if(!owned){
      if(!row.response)throw new AppError(409,'batch_pending_or_unknown','Retain the batch identity',{batchId:row.id})
      return {status:200,body:{...structuredClone(row.response),meta:{...row.response.meta,sourceMode:'idempotent_replay'}},batchId:row.id,replay:true}
    }
    const deadline=Date.now()+60000,data=[]
    for(const ip of values)for(const channel of channels){
      const index=data.length,gateway=this.channels[channel]
      if(Date.now()+22000>deadline){data.push({index,ip,channel,status:504,error:{code:'batch_deadline_not_dispatched',message:'Item was not dispatched'}});continue}
      try{
        const result=await gateway.execute(context,{body:{ip},path:channel==='legacy-v1'?'/api/v1/data/ip/risk':'/api/v1/data/ip/risk/v2',idempotencyKey:`ip-batch-${row.id}-${index}`})
        data.push({index,ip,channel,status:result.status,response:result.body})
      }catch(error){data.push({index,ip,channel,status:error.status||503,error:{code:error instanceof AppError ? error.code : 'ip_risk_unavailable',message:error instanceof AppError ? error.message : 'IP query could not be completed'},requestId:error.details?.requestId})}
    }
    const response={contractVersion:'mx-insight-hub.ip-risk.v2',batchId:row.id,data,meta:{sourceMode:'live',requestedItems:data.length,succeededItems:data.filter(x=>x.status===200).length}}
    if(this.v2.batch.pool)await this.v2.batch.pool.query('UPDATE external_platform.ipsearch_batches SET response=$2::jsonb,completed_at=now() WHERE id=$1',[row.id,JSON.stringify(response)])
    else row.response=structuredClone(response)
    return {status:200,body:response,batchId:row.id,replay:false}
  }
}
