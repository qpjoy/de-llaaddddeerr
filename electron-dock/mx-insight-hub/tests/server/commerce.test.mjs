import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {readFile,readdir,mkdtemp,writeFile,rm} from 'node:fs/promises'
import pg from 'pg'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {runMigrations} from '../../server/migrate.mjs'
import {CommerceService,INITIAL_PRODUCT,addCalendarMonths,IP_V2_METER} from '../../server/commerce/service.mjs'
import {IpRiskGateway} from '../../server/external-platforms/ip-risk-gateway.mjs'
import {IpRiskChannels} from '../../server/external-platforms/ip-risk-channels.mjs'
import {PostgresExternalPlatformStore} from '../../server/external-platforms/store.mjs'
import {PostgresStore} from '../../server/stores/postgres-store.mjs'
import {BaiduIpRiskAdapter,normalizeBaiduIpRisk} from '../../server/adapters/baidu-ip-risk.mjs'
import {tenantOpenApiDocument,publicDocsHtmlForPath} from '../../server/public-docs.mjs'

test('calendar subscriptions preserve month-end and leap years',()=>{
  assert.equal(addCalendarMonths('2024-02-29T13:22:00Z',12).toISOString(),'2025-02-28T13:22:00.000Z')
  assert.equal(addCalendarMonths('2026-01-31T00:00:00Z',1).toISOString(),'2026-02-28T00:00:00.000Z')
})
test('Baidu projection preserves grouped sublabels and missing fields, never fabricates a score',async()=>{
  const sample=JSON.parse(await readFile(new URL('../fixtures/baidu-ip-v2.json',import.meta.url),'utf8'))
  const result=normalizeBaiduIpRisk({country:'中国',province:'山东',isp:'中国移动',lng:0,lat:0},{overall:{risk_score_new:sample.risk_level},security_risks:sample.risk_tags,available:true,update_day:sample.data_date})
  assert.equal(result.data.risk_score,null);assert.equal(result.data.longitude,0)
  assert.equal(result.data.risk_tags[1].category,'关联设备风险');assert.equal(result.data.risk_tags[1].name,'疑似黑ROM设备IP')
  assert.equal(normalizeBaiduIpRisk({},{}).status,'unknown')
  assert.equal(normalizeBaiduIpRisk({},{available:false}).status,'no_data')
})
test('v2 docs require the purchased capability and keep v1 access independent',()=>{
  const scopes=[{platforms:['ip_risk'],capabilities:['ip.risk.query.v2']}]
  const doc=tenantOpenApiDocument(scopes)
  assert.ok(doc.paths['/data/ip/risk/v2']);assert.equal(doc.paths['/data/ip/risk'],undefined)
  assert.match(publicDocsHtmlForPath('/docs/ip-risk-v2',{tenant:true,scopes}),/100 个 IP/)
  assert.equal(publicDocsHtmlForPath('/docs/ip-risk-v2',{tenant:true,scopes:[]}),null)
  assert.match(publicDocsHtmlForPath('/docs/ip-risk-v2'),/共用|逐|逐项/)
})

const connectionString=process.env.MX_PAY_TEST_DATABASE_URL
async function fixture(t){
  const admin=new pg.Pool({connectionString,max:1}),name=`commerce_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url=new URL(connectionString);url.pathname=`/${name}`
  const pool=new pg.Pool({connectionString:url.href,max:8}),migrationDir=await mkdtemp(join(tmpdir(),'hub-commerce-migration-'))
  t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${name}`);await admin.end();await rm(migrationDir,{recursive:true,force:true})})
  const selected=['001','002','003','004','005','007','016','018','031','051','052','053','054','055','056','057','058','060','063','065','081','082','083','094','122','123','126','127','128','129'],dir=new URL('../../migrations/',import.meta.url)
  for(const file of (await readdir(dir)).sort().filter(f=>selected.includes(f.slice(0,3)))){
    if(file.startsWith('129')){await writeFile(join(migrationDir,file),await readFile(new URL(file,dir)));continue}
    const client=await pool.connect();try{await client.query('BEGIN');await client.query(await readFile(new URL(file,dir),'utf8'));await client.query('COMMIT')}catch(e){await client.query('ROLLBACK');e.message=`${file}: ${e.message}`;throw e}finally{client.release()}
  }
  await runMigrations({connectionString:url.href,migrationsDir:migrationDir})
  const tenant=randomUUID(),consumer=randomUUID(),keyId=randomUUID(),sourceId=randomUUID(),payments=new Map()
  await pool.query("INSERT INTO tenants(id,name) VALUES($1,'commerce fixture')",[tenant])
  await pool.query("INSERT INTO consumers(id,tenant_id,name,business_id) VALUES($1,$2,'buyer','fixture-buyer')",[consumer,tenant])
  await pool.query("INSERT INTO api_keys(id,tenant_id,consumer_id,name,key_digest,key_prefix,last_four) VALUES($1,$2,$3,'existing',repeat('a',64),'mih_live_fixture','test')",[keyId,tenant,consumer])
  const source={identity:{sourceId},appId:'hub',environment:'live',client:{
    async create(input){const prior=[...payments.values()].find(p=>p.businessOrderId===input.businessOrderId);if(prior)return prior
      const row={...input,id:randomUUID(),revision:0,status:'pending',appId:'hub',environment:source.environment,currency:'CNY',provider:source.environment==='test'?'mock':'alipay',checkout:{channelId:'alipay-live'}};payments.set(row.id,row);return row},
    async order(id){return payments.get(id)},async checkout(){return {payUrl:'https://openapi.alipay.com/gateway.do?fixture=true'}},
  }}
  const recharge={route:async env=>({source_id:sourceId,app_id:'hub',channel_id:env==='test'?'mock':'alipay-live'}),remote:async env=>{source.environment=env;return source},network:fn=>fn()}
  const service=new CommerceService(new PostgresStore(pool),recharge)
  const create=(environment='live',idempotencyKey=randomUUID())=>service.create(tenant,{sku:INITIAL_PRODUCT.sku,revision:1,consumerId:consumer,environment},idempotencyKey,'fixture-owner')
  async function eventFor(order){const row=await service.row(order.id,tenant),payment=payments.get(row.payment_id);payment.status='paid';payment.revision=1;payment.settlement={amountMinor:payment.amountMinor}
    const event={id:randomUUID(),type:'payment.paid',version:1,paymentId:payment.id,appId:'hub',environment:row.environment,businessOrderId:payment.businessOrderId,customerRef:tenant,amountMinor:payment.amountMinor,currency:'CNY'}
    return {event,payment,source:{...source,environment:row.environment}}
  }
  async function reserve(){const id=randomUUID();await pool.query(`INSERT INTO usage_requests(id,tenant_id,consumer_id,api_key_id,idempotency_key,fingerprint,platform,billing_meter_key,status,units_reserved,lease_expires_at)
    VALUES($1,$2,$3,$4,$6,repeat('b',64),'ip_risk',$5,'reserved',1,now()+interval '1 minute')`,[id,tenant,consumer,keyId,IP_V2_METER,id]);return id}
  return {pool,service,tenant,consumer,keyId,source,payments,create,eventFor,reserve,rerunMigrations:()=>runMigrations({connectionString:url.href,migrationsDir:migrationDir})}
}
const database={skip:!connectionString}
test('purchase snapshots, duplicate delivery, renewals, test isolation and no wallet writes',database,async t=>{
  const f=await fixture(t),key=randomUUID(),first=await f.create('live',key)
  assert.equal(first.product.amountMinor,3399900);assert.equal((await f.create('live',key)).id,first.id);assert.equal(f.payments.size,1)
  await assert.rejects(f.service.create(f.tenant,{sku:INITIAL_PRODUCT.sku,revision:1,consumerId:randomUUID(),environment:'live'},key,'buyer'),{code:'commerce_idempotency_conflict'})
  const {event,payment,source}=await f.eventFor(first)
  await assert.rejects(f.service.commit(source,{...event,amountMinor:1},payment),{code:'commerce_event_mismatch'})
  const receipts=await Promise.all([f.service.commit(source,event,payment),f.service.commit(source,event,payment)])
  assert.equal(receipts[0],receipts[1]);assert.equal((await f.pool.query('SELECT * FROM hub_commerce.subscriptions')).rowCount,1)
  assert.equal((await f.pool.query("SELECT * FROM capability_grants WHERE capability='ip.risk.query.v2'")).rowCount,1)
  assert.equal((await f.pool.query("SELECT * FROM capability_grants WHERE capability='ip.risk.query'")).rowCount,0)
  const second=await f.create(),renewal=await f.eventFor(second);await f.service.commit(renewal.source,renewal.event,renewal.payment)
  const periods=(await f.pool.query('SELECT * FROM hub_commerce.subscriptions ORDER BY starts_at')).rows
  assert.equal(periods[0].ends_at.toISOString(),periods[1].starts_at.toISOString());assert.equal(periods[0].quota,100000)
  const mock=await f.create('test'),mockEvent=await f.eventFor(mock);await f.service.commit(mockEvent.source,mockEvent.event,mockEvent.payment)
  assert.equal((await f.pool.query('SELECT * FROM hub_commerce.subscriptions')).rowCount,2)
  assert.equal((await f.pool.query('SELECT * FROM billing.credit_ledger_entries')).rowCount,0)
  await assert.rejects(f.pool.query("UPDATE hub_commerce.orders SET intent='{}' WHERE id=$1",[first.id]),/commerce_order_immutable/)
  await assert.rejects(f.pool.query('DELETE FROM hub_commerce.inbox'),/commerce_evidence_immutable/)
  const edited={revision:1,name:'新版',description:'example',status:'retired',amountMinor:4000000,months:12,quota:100000}
  await f.service.save(INITIAL_PRODUCT.sku,edited,'admin-token')
  assert.equal((await f.service.list(f.tenant)).orders.find(o=>o.id===first.id).product.amountMinor,3399900)
  await f.rerunMigrations()
  assert.equal((await f.service.catalog(true)).items[0].status,'retired','migration reruns preserve administrator changes')
  assert.equal((await f.service.catalog(true)).items[0].amountMinor,4000000)
  await assert.rejects(f.create(),{code:'commerce_product_changed'})
})
test('atomic shared subscription limit: last unit, failure release, unknown hold, expiry',database,async t=>{
  const f=await fixture(t)
  await assert.rejects(f.reserve(),/commerce_subscription_required/)
  const order=await f.create(),e=await f.eventFor(order);await f.service.commit(e.source,e.event,e.payment)
  await f.pool.query('UPDATE hub_commerce.subscriptions SET quota=1')
  const attempts=await Promise.allSettled([f.reserve(),f.reserve()]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1)
  const id=attempts.find(x=>x.status==='fulfilled').value
  await f.pool.query("UPDATE usage_requests SET status='unknown' WHERE id=$1",[id]);await assert.rejects(f.reserve(),/commerce_quota_exhausted/)
  await f.pool.query("UPDATE usage_requests SET status='released',units_actual=0,completed_at=now() WHERE id=$1",[id])
  const next=await f.reserve();await f.pool.query("UPDATE usage_requests SET status='committed',units_actual=1,completed_at=now() WHERE id=$1",[next])
  assert.deepEqual((await f.pool.query('SELECT used,held FROM hub_commerce.subscriptions')).rows[0],{used:1,held:0})
  await assert.rejects(f.reserve(),/commerce_quota_exhausted/)
  await f.pool.query("UPDATE hub_commerce.subscriptions SET starts_at=now()-interval '2 years',ends_at=now()-interval '1 year'")
  await assert.rejects(f.reserve(),/commerce_subscription_required/)
  assert.equal((await f.pool.query('SELECT * FROM billing.customer_charges')).rowCount,0)
})
test('Baidu actual calls retain exact evidence, rate-limit never retries or falls back',database,async t=>{
  const f=await fixture(t),order=await f.create(),e=await f.eventFor(order);await f.service.commit(e.source,e.event,e.payment)
  const id=await f.reserve();let calls=0
  const adapter=new BaiduIpRiskAdapter({pool:f.pool,sleep:async()=>{},fetchImpl:async url=>{
    calls++;assert.match(url,/^https:\/\/cloud\.baidu\.com\/api\/afd-ip-threat/)
    return new Response(JSON.stringify({ret_data:{code:0,data:url.includes('/base/')?{country:'中国'}:{overall:{risk_score_new:'高'},available:true,security_risks:{}}}}),{status:200})
  }})
  const result=await adapter.query('223.160.165.241',{requestId:id});assert.equal(result.outcome,'succeeded');assert.equal(calls,2)
  assert.equal((await f.pool.query('SELECT * FROM hub_commerce.ip_upstream_calls')).rowCount,2)
  adapter.fetch=async()=>{calls++;return new Response('{"ret_data":{"code":601}}',{status:200})}
  assert.equal((await adapter.query('8.8.8.8',{requestId:id})).errorCode,'ip_channel_rate_limited');assert.equal(calls,3)
  assert.equal((await adapter.query('1.1.1.1',{requestId:id})).outcome,'rejected');assert.equal(calls,3)
  await f.pool.query('UPDATE hub_commerce.ip_channel SET cooldown_until=NULL')
  adapter.fetch=async()=>{calls++;return new Response('too many requests',{status:429})}
  assert.equal((await adapter.query('1.1.1.1',{requestId:id})).errorCode,'ip_channel_rate_limited');assert.equal(calls,4)
  assert.equal((await adapter.query('1.1.1.1',{requestId:id})).outcome,'rejected');assert.equal(calls,4)
})


test('purchased v2 uses the real gateway, quota transaction, replay and channel-scoped history',database,async t=>{
  const f=await fixture(t),order=await f.create(),event=await f.eventFor(order)
  await f.service.commit(event.source,event.event,event.payment)
  let calls=0
  const adapter=new BaiduIpRiskAdapter({pool:f.pool,sleep:async()=>{},fetchImpl:async url=>{
    calls++;return Response.json({ret_data:{code:0,data:url.includes('/base/')?{country:'中国'}:{overall:{risk_score_new:'高'},available:true}}})
  }})
  const store=new PostgresStore(f.pool),platformStore=new PostgresExternalPlatformStore({pool:f.pool,providerKey:'baidu-ip',authorizationPlatform:'ip_risk'})
  const gateway=new IpRiskGateway({usageStore:store,platformStore,adapter,enabled:true,providerKey:'baidu-ip',operation:'ip.risk.query.v2',version:'mx-insight-hub.ip-risk.v2',meterKey:IP_V2_METER})
  const context={tenant:{id:f.tenant},consumer:{id:f.consumer},apiKey:{id:f.keyId,environment:'live'}}
  const input={body:{ip:'223.160.165.241'},path:'/api/v1/data/ip/risk/v2',idempotencyKey:randomUUID()}
  const channels=new IpRiskChannels({operation:'ip.risk.query',execute(){throw Error('must not fall back')}},gateway)
  const result=await channels.query(context,input)
  assert.equal(result.body.data[0].status,200,JSON.stringify(result.body));assert.equal(calls,2)
  assert.deepEqual((await f.pool.query('SELECT held,used FROM hub_commerce.subscriptions')).rows[0],{held:0,used:1})
  assert.equal((await channels.query(context,input)).replay,true);assert.equal(calls,2)
  const history=await gateway.history.list(context,{})
  assert.equal(history.items.length,1)
  assert.equal((await gateway.history.detail(context,'batch',result.batchId)).payload.data[0].channel,'baidu-v2')
  await assert.rejects(channels.query(context,{...input,idempotencyKey:randomUUID(),body:{ip:'1.1.1.1',channels:['legacy-v1','baidu-v2']}}),{status:403})
  assert.equal(calls,2,'unauthorized multi-channel selection dispatches nothing')
  await f.pool.query("INSERT INTO capability_grants(consumer_id,capability) VALUES($1,'ip.risk.query')",[f.consumer])
  await f.pool.query("INSERT INTO api_key_capability_entitlements(api_key_id,capability,max_requests,window_seconds) VALUES($1,'ip.risk.query',1000,3600)",[f.keyId])
  await store.putCapabilityConfiguration({tenantId:f.tenant,consumerId:f.consumer,capability:'ip.risk.query.v2',enabled:false,maxRequests:1000,windowSeconds:3600})
  assert.equal((await gateway.history.list(context,{})).items.length,0)
  await assert.rejects(gateway.history.detail(context,'batch',result.batchId),{status:404})
  await assert.rejects(gateway.history.detail(context,'single',result.body.data[0].response.requestId),{status:404})
  assert.equal((await f.pool.query('SELECT * FROM billing.customer_charges')).rowCount,0)
})
