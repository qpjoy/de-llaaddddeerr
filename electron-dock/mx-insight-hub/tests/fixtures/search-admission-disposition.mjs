import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import { SearchAdmissionDispositionService } from '../../server/operations/search-admission-disposition.mjs'
import { requestFingerprint } from '../../server/core/crypto.mjs'
import { dataSearchQueryHash, normalizeDataSearchV2, prepareDataSearchV2, DATA_SEARCH_V2_PATH } from '../../server/contracts/data-search-v2.mjs'
import { createDataSearchV2CursorCodec } from '../../server/external-platforms/cursor.mjs'

export const modulePath = process.env.MX_INSIGHT_TEST_PGLITE_MODULE
export const pgOptions = { skip: !modulePath && 'Set MX_INSIGHT_TEST_PGLITE_MODULE for real PostgreSQL SQL' }
export const pepper = 'search-admission-disposition-test-pepper-at-least-32-bytes'
export const searchBody = query => normalizeDataSearchV2({ platform:'twitter',query,pageSize:20,type:'fresh',
  timeWindow:{from:'2026-10-01T00:00:00.000Z',to:'2026-10-28T00:00:00.000Z',timezone:'Asia/Shanghai',boundary:'[from,to)'} })

export async function searchAdmissionDispositionFixture(t, { v2 = true, withMigration = true } = {}) {
  const { PGlite } = await import(pathToFileURL(modulePath).href)
  const db = new PGlite()
  t.after(() => db.close())
  await db.exec('CREATE SCHEMA control; CREATE SCHEMA ingest; CREATE TABLE ingest.ingest_runs(id uuid PRIMARY KEY)')
  const migrations = ['001_initial.sql','004_reservation_lease.sql','051_external_platform_gateway.sql',
    '052_external_platform_credentials.sql',
    '053_external_platform_uncertain_retry.sql','054_api_key_entitlements_plans_and_tikhub.sql',
    '055_external_platform_multi_call_rate_limit.sql','094_acquisition_request_snapshot.sql',
    '152_twitter_manual_retry.sql','158_data_search_v2_protocol.sql','162_twitter_v2_retry_intents.sql',
    ...(withMigration ? ['166_search_admission_dispositions.sql'] : [])]
  for (const name of migrations) await db.exec(await readFile(new URL(`../../migrations/${name}`,import.meta.url),'utf8'))
  await db.exec(`CREATE SCHEMA billing;
    CREATE TABLE billing.customer_charges(usage_request_id uuid PRIMARY KEY,status text,quoted_minor int,charged_minor int);
    CREATE TABLE billing.credit_ledger_entries(id uuid PRIMARY KEY,usage_request_id uuid,kind text,amount_minor int)`)
  const tenantId=randomUUID(),consumerId=randomUUID(),apiKeyId=randomUUID()
  const ctx={tenant:{id:tenantId},consumer:{id:consumerId},apiKey:{id:apiKeyId}}
  await db.query("INSERT INTO tenants(id,name) VALUES($1,'Disposition fixture')",[tenantId])
  await db.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'Disposition fixture',$3)",[consumerId,tenantId,consumerId])
  await db.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'Fixture',$4,'fixture','0000')",
    [apiKeyId,tenantId,consumerId,'a'.repeat(64)])
  const codec=createDataSearchV2CursorCodec(pepper,`${consumerId}:${apiKeyId}`)
  const addBinding = async ({ id,key,body,state='unknown' }) => {
    const ownerId=randomUUID()
    await db.query(`INSERT INTO control.data_search_protocol_bindings
      (consumer_id,idempotency_key,tenant_id,api_key_id,platform,query_hash,fingerprint,request_body,state,owner_id,lease_expires_at,usage_request_id)
      VALUES($1,$2,$3,$4,'twitter',$5,$6,$7,$8,$9,now()-interval '1 hour',$10)`,
    [consumerId,key,tenantId,apiKeyId,dataSearchQueryHash(body.query),requestFingerprint({method:'POST',path:DATA_SEARCH_V2_PATH,body}),
      JSON.stringify(body),state,ownerId,id])
    return ownerId
  }
  const addCall = async ({ id, fingerprint,provider='rapidapi',outcome='unknown' }) => {
    const callId=randomUUID()
    const ordinal=(await db.query('SELECT count(*)::int AS n FROM external_platform.provider_calls WHERE usage_request_id=$1',[id])).rows[0].n
    await db.query(`INSERT INTO external_platform.provider_calls
      (id,provider_key,tenant_id,consumer_id,api_key_id,usage_request_id,operation,contract_version,endpoint_key,endpoint_version,
        marketplace,request_fingerprint,outcome,started_at,completed_at,call_ordinal)
      VALUES($1,$2,$3,$4,$5,$6,$7,'mx-insight-hub.social-data.v1',$8,'fixture.v1','twitter',$9,$10,
        now()-interval '1 hour',CASE WHEN $10='pending' THEN NULL ELSE now()-interval '59 minutes' END,$11)`,
    [callId,provider,tenantId,consumerId,apiKeyId,id,provider==='tikhub'?'native.t.twitter_web_fetch_search_timeline':'social.content.search',
      provider==='tikhub'?'t.twitter_web_fetch_search_timeline':'twitter-aio.search',fingerprint,outcome,ordinal])
    return callId
  }
  const addUnknown = async ({ id=randomUUID(),key=randomUUID(),query='offline disposition fixture',body=searchBody(query),
    protocol=v2,provider='rapidapi',status='unknown',withCall=true } = {}) => {
    const snapshot={method:'POST',path:'/api/v1/data/search',body:prepareDataSearchV2(body,codec,0).upstream}
    const fingerprint=requestFingerprint(snapshot)
    await db.query(`INSERT INTO usage_requests
      (id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,status,acquisition_request,lease_expires_at,reserved_at,completed_at)
      VALUES($1,$2,$3,$4,$5,$6,'twitter',$7,$8,now()-interval '58 minutes',now()-interval '1 hour',now()-interval '59 minutes')`,
    [id,tenantId,consumerId,apiKeyId,key,fingerprint,status,JSON.stringify(snapshot)])
    await db.query(`INSERT INTO usage_idempotency_bindings
      (tenant_id,consumer_id,idempotency_key,api_key_id,fingerprint,current_request_id)
      VALUES($1,$2,$3,$4,$5,$6)`,[tenantId,consumerId,key,apiKeyId,fingerprint,id])
    const ownerId=protocol?await addBinding({id,key,body}):null
    const callId=withCall?await addCall({id,fingerprint,provider}):null
    await db.query("INSERT INTO billing.customer_charges VALUES($1,'unknown',1,0)",[id])
    await db.query("INSERT INTO billing.credit_ledger_entries VALUES($1,$2,'reserve',1)",[randomUUID(),id])
    return {id,key,fingerprint,snapshot,body,ownerId,callId}
  }
  const original=await addUnknown()
  const statements=[]
  const query=async (sql,args) => {statements.push(sql);const result=await db.query(sql,args);return {...result,rowCount:result.affectedRows??result.rows.length}}
  // One PGlite session cannot exercise PostgreSQL multi-session locking.
  // Serialize clients so concurrent idempotency tests use real transactions.
  let tail=Promise.resolve()
  const pool={query,async connect(){const previous=tail;let unlock;tail=new Promise(resolve=>{unlock=resolve});await previous
    return {query,release(){unlock()}}}}
  const service=new SearchAdmissionDispositionService({pool,apiKeyPepper:pepper})
  const scope={tenantId,consumerId,apiKeyId,platform:'twitter',query:original.body.query}
  const resolve=async (id=original.id,patch={},actor='fixture-admin') => {
    const prepared=await service.prepare(id)
    return service.resolve(id,{revision:prepared.revision,reason:'Accept this historical unknown for future search',acceptUnknownRisk:true,...patch},
      {actor,requestId:randomUUID()})
  }
  return {db,pool,service,statements,ctx,context:ctx,scope,tenantId,consumerId,apiKeyId,pepper,codec,
    ...original,originalId:original.id,original,addUnknown,addBinding,addCall,resolve}
}
