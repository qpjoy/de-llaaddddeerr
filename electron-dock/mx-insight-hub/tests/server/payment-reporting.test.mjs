import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp,writeFile,rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import pg from 'pg'
import { PaymentClient } from '@qpjoy/mx-pay/client'
import { PaymentReportingStore,PaymentReportingWorker,parseReportingSources } from '@qpjoy/mx-pay/reporting'
import { createPaymentReporting,migratePaymentReporting } from '../../server/payments/reporting.mjs'
import { createApp } from '../../server/app.mjs'
import { MemoryStore } from '../../server/stores/memory-store.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { capabilitiesForRole } from '../../server/identity/index.mjs'
import { createApp as paymentApp } from '../../../mx-base/mx-pay/server/app.mjs'
import { migrate } from '../../../mx-base/mx-pay/server/migrate.mjs'
import { PaymentCenter } from '../../../mx-base/mx-pay/server/service.mjs'
import { readCredentials } from '../../../mx-base/mx-pay/server/config.mjs'

const log={log(){},error(){}}
async function listen(t,handler) {
  const server=createServer(handler)
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  return `http://127.0.0.1:${server.address().port}`
}
async function hub(t,reporting,listenerMode='combined') {
  const store=new MemoryStore(),service=new HubService({store,adapter:{},apiKeyPepper:'reporting-test-pepper-with-at-least-32-bytes'})
  const owner={kind:'launcher',memberId:randomUUID(),platformAdmin:false,tenantIds:[],capabilities:capabilitiesForRole('owner'),memberships:[]}
  return listen(t,createApp({store,service,adapter:{},paymentReporting:reporting,listenerMode,adminToken:'test-admin',
    identity:{enabled:true,resolve:async token=>token==='owner'?owner:null},logger:log}))
}
const request=(base,path,token='test-admin',method='GET')=>fetch(`${base}/internal/v1/admin/payment-reports${path}`,{method,headers:{authorization:`Bearer ${token}`}})

test('reporting configuration and HTTP reads preserve admin/public/tenant boundaries and isolate dependency failure',async t=>{
  assert.deepEqual(parseReportingSources(''),[])
  assert.throws(()=>parseReportingSources('not-json'))
  assert.equal(createPaymentReporting({sourcesJson:'bad'},{logger:log}).available,false)
  assert.equal(createPaymentReporting({sourcesJson:''}),null)
  const disabled=await hub(t,null)
  assert.equal((await request(disabled,'/sources','')).status,401)
  assert.equal((await request(disabled,'/sources','owner')).status,403)
  assert.deepEqual((await (await request(disabled,'/sources')).json()).data,{available:false,error:null,items:[]})
  assert.equal((await request(disabled,'/sources','test-admin','POST')).status,405)
  const broken=await hub(t,{available:true,sources:[{id:'hub'}],store:{status:async()=>{throw Error('postgres://private:SECRET@host')}}})
  const failed=await request(broken,'/sources');assert.equal(failed.status,503);assert.doesNotMatch(await failed.text(),/SECRET|postgres/)
  assert.equal((await fetch(`${broken}/internal/v1/admin/session`,{headers:{authorization:'Bearer test-admin'}})).status,200)
  const publicBase=await hub(t,{available:true,sources:[]},'public')
  assert.equal((await request(publicBase,'/sources')).status,404)
})

test('worker closes between pages and a failing source does not block another source',async()=>{
  const calls=[],store={sync:async source=>{calls.push(source.id);if(source.id==='broken')throw Error('SECRET');return {committed:true,hasMore:false}}}
  const errors=[],worker=new PaymentReportingWorker(store,[{id:'broken'},{id:'healthy'}],{logger:{error:text=>errors.push(text)}})
  worker.start();await worker.running;await worker.close()
  assert.deepEqual(calls,['broken','healthy']);assert.equal(errors.length,1);assert.doesNotMatch(errors[0],/SECRET/)
})

test('real payment HTTP -> separate report PostgreSQL -> Hub reads: replay, fencing, rollback, summaries and identity guards',
  {skip:!process.env.MX_PAY_TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.MX_PAY_TEST_DATABASE_URL,max:1}),names=[]
  const pools=[]
  t.after(async()=>{for(const p of pools)await p.end();for(const n of names)await admin.query(`DROP DATABASE ${n} WITH (FORCE)`);await admin.end()})
  async function database(prefix) {
    const name=`${prefix}_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE ${name}`);names.push(name)
    const url=new URL(process.env.MX_PAY_TEST_DATABASE_URL);url.pathname=`/${name}`
    const pool=new pg.Pool({connectionString:url.href,max:6});pools.push(pool);return {url:url.href,pool}
  }
  const pay=await database('pay_source'),reports=await database('hub_reports')
  await migrate(pay.url,log)
  const dir=await mkdtemp(join(tmpdir(),'hub-reporting-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const entries=[{id:'business',appId:'hub',environment:'test',secret:randomUUID(),scopes:['orders.read','orders.write','receipts.confirm','events.read']},
    {id:'reports',appId:'hub',environment:'test',secret:randomUUID(),scopes:['reports.read']}]
  const file=join(dir,'credentials.json');await writeFile(file,JSON.stringify(entries))
  const credentials=readCredentials(file),center=new PaymentCenter(pay.pool)
  const base=await listen(t,paymentApp({service:center,credentials,logger:log})),business=new PaymentClient({baseUrl:base,token:entries[0].secret})
  const source={id:'hub-test',appId:'hub',environment:'test',baseUrl:base,token:entries[1].secret}
  const sourcesJson=JSON.stringify([source])
  await migratePaymentReporting({sourcesJson,databaseUrl:reports.url},log)
  await migratePaymentReporting({sourcesJson,databaseUrl:reports.url},log)
  await assert.rejects(migrate(reports.url,log),/dedicated/)
  await assert.rejects(migratePaymentReporting({sourcesJson,databaseUrl:pay.url},log),/consumer-owned/)
  assert.equal((await pay.pool.query("SELECT to_regclass('pay_reporting.orders') AS t")).rows[0].t,null)
  const projection=new PaymentReportingStore(reports.pool),client=new PaymentClient(source)
  async function order(feeMinor) {
    let row=await business.create({businessOrderId:randomUUID(),customerRef:'existing-tenant-reference',amountMinor:1200},randomUUID())
    row=await business.act(row.id,'submit',{expectedRevision:0,payerName:'PRIVATE PAYER',tradeNo:randomUUID()},randomUUID())
    return business.act(row.id,'confirm',{expectedRevision:1,tradeNo:randomUUID(),receivedAmountMinor:1200,feeMinor,paidAt:new Date().toISOString(),note:'PRIVATE NOTE'},randomUUID())
  }
  const first=await order(null)
  const reportDay=new Date(Date.parse(first.settlement.paidAt)+8*3600000).toISOString().slice(0,10)
  // Both workers fetch against exactly the same checkpoint before either writes.
  let fetched=0,release
  const barrier=new Promise(resolve=>{release=resolve})
  const concurrent={syncReportingPage:(commit,checkpoint)=>client.syncReportingPage(async page=>{if(++fetched===2)release();await barrier;await commit(page)},checkpoint)}
  const races=await Promise.all([projection.sync(source,concurrent),projection.sync(source,concurrent)])
  assert.equal(races.filter(r=>r.committed).length,1)
  assert.equal((await projection.status([source.id]))[0].caughtUpAt,null,'baseline alone is provisional')
  await projection.sync(source)
  assert.equal((await projection.status([source.id]))[0].caughtUp,true)
  assert.equal((await projection.orders(source.id)).items.length,1)
  const second=await order(50)
  const prior=(await projection.stream(source)).checkpoint
  await reports.pool.query("CREATE FUNCTION pay_reporting.fail_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated disk transaction failure'; END $$; CREATE TRIGGER fail_commit BEFORE UPDATE ON pay_reporting.streams FOR EACH ROW EXECUTE FUNCTION pay_reporting.fail_commit()")
  await assert.rejects(projection.sync(source),/simulated disk/)
  assert.deepEqual((await projection.stream(source)).checkpoint,prior)
  assert.equal((await projection.orders(source.id)).items.length,1,'order and checkpoint roll back together')
  await reports.pool.query('DROP TRIGGER fail_commit ON pay_reporting.streams; DROP FUNCTION pay_reporting.fail_commit()')
  const paged={syncReportingPage:(commit,checkpoint)=>client.syncReportingPage(commit,checkpoint,{limit:1})}
  const restarted=new PaymentReportingStore(reports.pool)
  assert.equal((await restarted.sync(source,paged)).hasMore,true)
  assert.equal((await restarted.status([source.id]))[0].caughtUp,false,'successful partial catch-up is not fully current')
  for(let page=0;page<4;page++)if(!(await restarted.sync(source,paged)).hasMore)break
  await projection.sync(source) // an empty replay never adds another row
  const daily=await projection.daily(source.id,reportDay,reportDay)
  assert.deepEqual(daily.items,[{day:reportDay,currency:'CNY',paidCount:'2',receivedMinor:'2400',knownFeeMinor:'50',unknownFeeCount:'1'}])
  assert.equal((await business.events()).items.length,2,'report consumers never ACK or deliver money')
  const all=(await projection.orders(source.id)).items
  assert.deepEqual(new Set(all.map(r=>r.id)),new Set([first.id,second.id]))
  assert.doesNotMatch(JSON.stringify(all),/PRIVATE|tradeNo|payerName|checkout/)
  await assert.rejects(projection.daily(source.id,'2026-02-30','2026-03-01'),{code:'invalid_reporting_query'})
  await assert.rejects(projection.stream({...source,environment:'live'}),{code:'reporting_binding_changed'})
  // Same revision but different contents is corruption, not a harmless replay.
  const corrupt={syncReportingPage:(commit,checkpoint)=>client.syncReportingPage(page=>commit({...page,items:[{...all[0],customerRef:'another-tenant'}]}),checkpoint)}
  const saved=(await projection.stream(source)).checkpoint
  await assert.rejects(projection.sync(source,corrupt),{code:'reporting_revision_conflict'})
  assert.deepEqual((await projection.stream(source)).checkpoint,saved)
  assert.equal((await projection.status([source.id]))[0].lastError,'reporting_revision_conflict')
  assert.equal((await projection.sync(source)).deferred,true,'failure backoff does not move progress')
  await reports.pool.query("UPDATE pay_reporting.streams SET next_attempt_at=now() WHERE id=$1",[source.id])
  await assert.rejects(projection.sync({...source,expectedSourceId:randomUUID()}),{code:'reporting_source_changed'})
  assert.deepEqual((await projection.stream(source)).checkpoint,saved)
  await reports.pool.query("UPDATE pay_reporting.streams SET next_attempt_at=now() WHERE id=$1",[source.id])
  await projection.sync(source)
  const hubBase=await hub(t,{available:true,sources:[source],store:projection})
  const summary=(await (await request(hubBase,`/${source.id}/daily?from=${reportDay}&to=${reportDay}`)).json()).data
  assert.equal(summary.provisional,false);assert.equal(summary.source.environment,'test');assert.deepEqual(summary.items,daily.items)
  const statusText=await (await request(hubBase,'/sources')).text();assert.ok(!statusText.includes(source.token));assert.ok(!statusText.includes(source.baseUrl))
  assert.equal((await request(hubBase,`/${source.id}/orders?environment=live`)).status,400)
  const page=(await (await request(hubBase,`/${source.id}/orders?limit=1`)).json()).data
  assert.equal(page.items.length,1);assert.ok(page.nextAfter)
  const page2=(await (await request(hubBase,`/${source.id}/orders?after=${page.nextAfter}`)).json()).data
  assert.equal(page2.items.length,1);assert.notEqual(page.items[0].id,page2.items[0].id)
})
