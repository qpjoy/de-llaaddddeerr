import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID, generateKeyPairSync, createSign } from 'node:crypto'
import { mkdtemp, readFile, writeFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import pg from 'pg'
import { PaymentClient } from '@qpjoy/mx-pay/client'
import { PaymentCenter } from '../../../mx-base/mx-pay/server/service.mjs'
import { createApp as paymentApp } from '../../../mx-base/mx-pay/server/app.mjs'
import { migrate } from '../../../mx-base/mx-pay/server/migrate.mjs'
import { readCredentials } from '../../../mx-base/mx-pay/server/config.mjs'
import { PostgresStore } from '../../server/stores/postgres-store.mjs'
import { RechargeService } from '../../server/payments/recharge.mjs'
import { parseRechargeSources } from '../../server/payments/recharge-config.mjs'
import { PaymentService } from '../../server/payments/service.mjs'
import { createApp } from '../../server/app.mjs'
import { HubService } from '../../server/hub-service.mjs'
import { capabilitiesForRole } from '../../server/identity/index.mjs'

const pepper = 'payment-delivery-fixture-retained-pepper'
const log = { log(){}, error(){} }
const keys = () => generateKeyPairSync('rsa', {modulusLength:2048, publicKeyEncoding:{type:'spki',format:'pem'}, privateKeyEncoding:{type:'pkcs8',format:'pem'}})
const merchant = keys(), upstream = keys()
const connectionString = process.env.MX_PAY_TEST_DATABASE_URL
async function fixture(t) {
  const admin = new pg.Pool({connectionString,max:1}), names=[], pools=[], servers=[]
  const dir = await mkdtemp(join(tmpdir(),'hub-delivery-'))
  t.after(async()=>{
    for (const server of servers) await new Promise(resolve=>server.close(resolve))
    for (const pool of pools) await pool.end()
    for (const name of names) await admin.query(`DROP DATABASE ${name} WITH (FORCE)`)
    await admin.end();await rm(dir,{recursive:true,force:true})
  })
  async function database(prefix) {
    const name=`${prefix}_${randomUUID().replaceAll('-','')}`;await admin.query(`CREATE DATABASE ${name}`);names.push(name)
    const url=new URL(connectionString);url.pathname=`/${name}`
    const pool=new pg.Pool({connectionString:url.href,max:8});pools.push(pool);return {url:url.href,pool}
  }
  async function listen(handler) {
    const server=createServer(handler);servers.push(server)
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve)})
    return `http://127.0.0.1:${server.address().port}`
  }
  const pay=await database('pay_delivery'), hub=await database('hub_delivery')
  await migrate(pay.url,log)
  // Apply unchanged production SQL for identities, the real wallet and payment
  // tables. Unrelated search/vector/ETL migrations are outside this fixture.
  const selected=['001','002','005','007','018','051','052','054','056','122','123','126']
  const migrations=new URL('../../migrations/',import.meta.url)
  for(const file of (await readdir(migrations)).sort().filter(name=>selected.includes(name.slice(0,3)))) {
    const client=await hub.pool.connect()
    try { await client.query('BEGIN');await client.query(await readFile(new URL(file,migrations),'utf8'));await client.query('COMMIT') }
    catch(error){await client.query('ROLLBACK');error.message=`${file}: ${error.message}`;throw error} finally{client.release()}
  }
  const channel={id:'alipay-live',provider:'alipay',environment:'live',enabled:true,appId:'2021000000000001',sellerId:'2088000000000001',allowedApps:['hub'],keyType:'PKCS8',
    privateKey:merchant.privateKey,alipayPublicKey:upstream.publicKey,notifyUrl:'https://pay.example.test/v1/notifications/alipay/alipay-live',returnUrl:'https://hub.example.test/'}
  const entries=['test','live'].flatMap(environment=>[
    {id:`hub-${environment}`,appId:'hub',environment,secret:randomUUID(),scopes:['orders.read','orders.write','events.read','events.ack']},
    {id:`finance-${environment}`,appId:'hub',environment,secret:randomUUID(),scopes:['orders.read','orders.write','receipts.confirm']}])
  const file=join(dir,'credentials.json');await writeFile(file,JSON.stringify(entries))
  const center=new PaymentCenter(pay.pool,{channels:[channel]})
  await center.channelPayments.bind()
  const base=await listen(paymentApp({service:center,credentials:readCredentials(file),logger:log}))
  const sources=['test','live'].map(environment=>({environment,appId:'hub',channelId:environment==='test'?'mock':channel.id,baseUrl:base,token:entries.find(e=>e.id===`hub-${environment}`).secret}))
  const store=new PostgresStore(hub.pool),recharge=new RechargeService(store,sources,{logger:log,pepper}),legacy=new PaymentService(store)
  legacy.store.includeRecharge=true
  const tenant=randomUUID(),other=randomUUID(),member=randomUUID()
  await hub.pool.query("INSERT INTO tenants(id,name) VALUES($1,'Billing fixture'),($2,'Other tenant')",[tenant,other])
  await hub.pool.query("INSERT INTO iam.members(id,display_name) VALUES($1,'Existing Launcher member')",[member])
  await store.grantTenantMembership({memberId:member,tenantId:tenant,role:'billing',grantedBy:'fixture'})
  const finance = environment => new PaymentClient({baseUrl:base,token:entries.find(e=>e.id===`finance-${environment}`).secret})
  const source = environment => recharge.remote(environment)
  const activate = async environment => {
    const identity=await recharge.sources.get(environment).client.identity()
    return recharge.activate(environment,{sourceId:identity.sourceId,acknowledge:true},'fixture-admin')
  }
  async function settle(order) {
    const remote=await finance(order.environment).order(order.paymentId)
    if(order.environment==='test') {
      await finance('test').act(remote.id,'submit',{expectedRevision:0,payerName:'Simulated payer',tradeNo:randomUUID()},randomUUID())
      return finance('test').act(remote.id,'confirm',{expectedRevision:1,tradeNo:randomUUID(),receivedAmountMinor:remote.amountMinor,feeMinor:null,paidAt:new Date().toISOString(),note:'Test only'},randomUUID())
    }
    const body={sign_type:'RSA2',app_id:channel.appId,seller_id:channel.sellerId,out_trade_no:remote.checkout.outTradeNo,trade_no:`20261003${String(Date.now())}${String(Math.floor(Math.random()*1e9)).padStart(9,'0')}`,trade_status:'TRADE_SUCCESS',
      total_amount:(remote.amountMinor/100).toFixed(2),receipt_amount:(remote.amountMinor/100).toFixed(2),gmt_payment:new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ')}
    body.sign=createSign('RSA-SHA256').update(Object.keys(body).filter(k=>k!=='sign_type').sort().map(k=>`${k}=${body[k]}`).join('&')).sign(upstream.privateKey,'base64')
    const response=await fetch(`${base}/v1/notifications/alipay/${channel.id}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams(body)})
    assert.equal(response.status,200,await response.text())
    return finance('live').order(remote.id)
  }
  const create = (environment='test',id=tenant,key=randomUUID())=>recharge.create(id,{environment,amountMinor:1200},key,member)
  const balance = async () => Number((await hub.pool.query('SELECT available_minor FROM billing.credit_accounts WHERE tenant_id=$1',[tenant])).rows[0]?.available_minor||0)
  async function api(listenerMode='combined') {
    const memberships=[{tenantId:tenant,role:'billing',status:'active',capabilities:capabilitiesForRole('billing')}]
    const principal={kind:'launcher',platformAdmin:false,memberId:member,tenantIds:[tenant],capabilities:capabilitiesForRole('billing'),memberships}
    return listen(createApp({store,service:new HubService({store,adapter:{},apiKeyPepper:'payment-delivery-fixture-pepper-at-least-32'}),adapter:{},recharge,
      adminToken:'fixture-admin',listenerMode,logger:log,identity:{enabled:true,resolve:async token=>token==='billing'?principal:null}}))
  }
  return {pay,hub,center,recharge,legacy,store,sources,tenant,other,member,source,activate,settle,create,balance,api,finance}
}
const check = {skip:!connectionString}
test('delivery configuration hides secrets and billing authority stays separate from Key/finance administration',()=>{
  assert.deepEqual(parseRechargeSources(''),[])
  const row={environment:'test',appId:'hub',channelId:'mock',baseUrl:'https://pay.example.test',token:randomUUID()}
  assert.equal(parseRechargeSources(JSON.stringify([row]))[0].baseUrl,row.baseUrl)
  for(const invalid of [[row,row],[{...row,baseUrl:'https://secret:password@pay.example.test'}],[{...row,environment:'bad'}],[{...row,token:'secret'}]]) {
    assert.throws(()=>parseRechargeSources(JSON.stringify(invalid)),/^Error: Invalid payment delivery sources \(values hidden\)$/)
  }
  assert.deepEqual(capabilitiesForRole('billing'),['tenant.read','billing.read','recharge.create','invoice.request'])
  for(const role of ['owner','admin'])for(const cap of ['billing.read','recharge.create','invoice.request'])assert.ok(capabilitiesForRole(role).includes(cap))
})

test('two real databases: live signed notification, test isolation, concurrent/restarted consumers, invoice and immutable audit',check,async t=>{
  const f=await fixture(t);await f.activate('test');await f.activate('live')
  const mock=await f.create(),live=await f.create('live')
  assert.equal((await f.source('live')).identity.features[0],'initiatorRef')
  assert.equal((await f.finance('live').order(live.paymentId)).initiatorRef,f.member)
  await assert.rejects(f.pay.pool.query("UPDATE pay.orders SET document=document||'{\"initiatorRef\":\"other\"}' WHERE id=$1",[live.paymentId]),/immutable/)
  await f.settle(mock);await f.settle(live)
  assert.equal((await f.recharge.order(live.id)).status,'pending')
  assert.equal(await f.balance(),0,'a read cannot dispatch a payment or credit a wallet')
  const second=new RechargeService(f.store,f.sources,{logger:log})
  await Promise.all([f.recharge.sweep('live'),second.sweep('live'),f.recharge.sweep('test')])
  assert.equal(await f.balance(),1200)
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,2)
  assert.equal((await f.hub.pool.query('SELECT * FROM billing.credit_ledger_entries')).rowCount,1)
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.test_credits')).rowCount,1)
  assert.equal((await f.source('live')).client instanceof PaymentClient,true)
  assert.equal((await (await f.source('live')).client.events()).items.length,0)
  const paid=await second.order(live.id,f.tenant)
  assert.equal(paid.status,'paid');assert.equal(paid.deliveryStatus,'credited')
  const row=await second.row(live.id),key=randomUUID(),body={expectedRevision:paid.revision,companyName:'Fixture company',taxNumber:'91310000TEST000001',email:'billing@example.test'}
  const invoice=await second.action(row,'invoice-request',body,key,{actor:f.member})
  assert.equal(invoice.invoice.status,'requested')
  assert.equal((await second.action(row,'invoice-request',body,key,{actor:f.member})).revision,invoice.revision)
  await assert.rejects(second.action(row,'invoice-request',{...body,email:'other@example.test'},key,{actor:f.member}),{code:'payment_idempotency_conflict'})
  assert.equal((await f.legacy.store.list({tenantId:f.tenant,environment:'live',invoiceStatus:'requested'})).items[0].id,live.id)
  await assert.rejects(f.hub.pool.query('DELETE FROM hub_recharge.inbox'),/append-only/)
  await assert.rejects(f.hub.pool.query("UPDATE hub_recharge.orders SET intent=intent||'{\"amountMinor\":500}' WHERE id=$1",[live.id]),/immutable/)
  await assert.rejects(f.hub.pool.query("UPDATE hub_recharge.routes SET source_id=$1 WHERE environment='live'",[randomUUID()]),/immutable/)
})

test('remote create response loss retains intent; retries recover one payment and events can recover an unattached order',check,async t=>{
  const f=await fixture(t);await f.activate('test')
  const client=f.recharge.sources.get('test').client,original=client.create.bind(client)
  client.create=async(...args)=>{await original(...args);throw Error('lost create response')}
  const key=randomUUID(),order=await f.create('test',f.tenant,key)
  assert.equal(order.paymentId,null);assert.equal(order.paymentStatus,'unknown');assert.ok(order.recoveryCode)
  assert.equal((await f.create('test',f.tenant,key)).id,order.id)
  assert.equal((await f.pay.pool.query('SELECT * FROM pay.orders')).rowCount,1)
  const remote=(await f.pay.pool.query('SELECT document FROM pay.orders')).rows[0].document
  await f.settle({...order,paymentId:remote.id})
  await f.recharge.sweep('test')
  assert.equal((await f.recharge.order(order.id)).status,'paid')
  assert.equal(await f.balance(),0)
  client.create=original
  assert.equal((await f.create('test',f.tenant,key)).paymentId,remote.id)
  await assert.rejects(f.recharge.create(f.tenant,{environment:'test',amountMinor:1500},key,f.member),{code:'payment_idempotency_conflict'})
})

test('late database failure rolls back wallet/inbox together; lost ACK and lost COMMIT response replay safely',check,async t=>{
  const f=await fixture(t);await f.activate('live')
  const order=await f.create('live');await f.settle(order)
  await f.hub.pool.query("CREATE FUNCTION hub_recharge.fail_inbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'simulated disk error'; END $$; CREATE TRIGGER fail_inbox BEFORE INSERT ON hub_recharge.inbox FOR EACH ROW EXECUTE FUNCTION hub_recharge.fail_inbox()")
  await f.recharge.sweep('live')
  assert.equal(await f.balance(),0);assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,0)
  assert.equal((await (await f.source('live')).client.events()).items.length,1)
  await f.hub.pool.query('DROP TRIGGER fail_inbox ON hub_recharge.inbox; DROP FUNCTION hub_recharge.fail_inbox()')
  const client=f.recharge.sources.get('live').client,ack=client.acknowledge.bind(client)
  client.acknowledge=async()=>{throw Error('ACK unavailable')}
  await f.recharge.sweep('live');assert.equal(await f.balance(),1200)
  // Delivery has committed. A subsequent wallet suspension cannot make replay
  // create another ledger entry or suppress acknowledgement of the first one.
  await f.hub.pool.query("UPDATE billing.credit_accounts SET status='suspended',revision=revision+1 WHERE tenant_id=$1",[f.tenant])
  client.acknowledge=ack
  await f.recharge.sweep('live');assert.equal((await client.events()).items.length,0);assert.equal(await f.balance(),1200)
  await f.hub.pool.query("UPDATE billing.credit_accounts SET status='active',revision=revision+1 WHERE tenant_id=$1",[f.tenant])
  const next=await f.create('live');await f.settle(next)
  const source=await f.source('live'),event=(await client.events()).items[0],payment=await client.order(event.paymentId)
  const faultPool={query:f.hub.pool.query.bind(f.hub.pool),connect:async()=>{
    const c=await f.hub.pool.connect()
    return {release:error=>c.release(error),query:async(...args)=>{const result=await c.query(...args);if(args[0]==='COMMIT')throw Error('commit reply lost');return result}}
  }}
  const faultStore={pool:faultPool,addTenantCredit:f.store.addTenantCredit.bind(f.store)},fault=new RechargeService(faultStore,f.sources,{logger:log})
  await assert.rejects(fault.commit(source,event,payment),{code:'recharge_outcome_unknown'})
  assert.equal(await f.balance(),2400)
  await new RechargeService(f.store,f.sources,{logger:log}).sweep('live')
  assert.equal(await f.balance(),2400);assert.equal((await client.events()).items.length,0)
})

test('mismatched/unknown events remain unacknowledged; a poison event does not starve later deliveries',check,async t=>{
  const f=await fixture(t);await f.activate('test')
  const a=await f.create(),b=await f.create();await f.settle(a);await f.settle(b)
  const source=await f.source('test'),client=source.client,events=(await client.events()).items,event=events.find(e=>e.paymentId===a.paymentId),payment=await client.order(event.paymentId)
  for(const bad of [{...event,amountMinor:500},{...event,customerRef:f.other},{...event,environment:'live'},{...event,appId:'other'},{...event,businessOrderId:`hub-recharge:${randomUUID()}`}]) {
    await assert.rejects(f.recharge.commit(source,bad,payment),/付款事件/)
  }
  await assert.rejects(f.recharge.commit({...source,identity:{...source.identity,sourceId:randomUUID()}},event,payment),{code:'recharge_event_unmatched'})
  await f.hub.pool.query("UPDATE tenants SET status='suspended' WHERE id=$1",[f.tenant])
  await f.recharge.sweep('test');assert.equal((await client.events()).items.length,2)
  await f.hub.pool.query("UPDATE tenants SET status='active' WHERE id=$1",[f.tenant])
  const read=client.order.bind(client)
  client.order=async id=>id===a.paymentId?{...await read(id),amountMinor:500}:read(id)
  await f.recharge.sweep('test')
  assert.equal((await f.recharge.order(a.id)).status,'pending');assert.equal((await f.recharge.order(b.id)).status,'paid')
  assert.equal((await client.events()).items.length,1)
  client.order=read;await f.recharge.sweep('test');assert.equal((await client.events()).items.length,0)
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.delivery_errors')).rowCount,0)
})

test('an in-flight legacy insert serializes activation; one historical payment prevents live cutover',check,async t=>{
  const f=await fixture(t),client=await f.hub.pool.connect()
  const {createOrder}=await import('@qpjoy/mx-pay')
  const old=createOrder({tenantId:f.tenant,input:{environment:'live',amountMinor:1200},actor:f.member,settings:{enabled:true,merchantAccountId:'old-payee'}})
  await client.query('BEGIN')
  await client.query('INSERT INTO mx_pay.orders(id,tenant_id,request_key,fingerprint,document) VALUES($1,$2,$3,$4,$5)',[old.id,f.tenant,randomUUID(),'fixture',old])
  let finished=false
  const activating=f.activate('live').then(()=>({ok:true}),error=>({error})).finally(()=>{finished=true})
  try {
    // Wait for the actual lock conflict, rather than depending on a sleep race.
    let blocked=false
    for(let i=0;i<100;i++){
      blocked=(await f.hub.pool.query("SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%hub_recharge.routes%'")).rowCount>0
      if(blocked)break
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    assert.equal(blocked,true);assert.equal(finished,false)
    await client.query('COMMIT')
    assert.equal((await activating).error?.code,'recharge_legacy_handover_required')
    assert.equal(await f.recharge.owns('live'),false)
  } finally {await client.query('ROLLBACK');client.release();await activating}
})

test('bounded sweeps pass failed events, restart from pending outbox, and reject changed payment source identity',check,async t=>{
  const f=await fixture(t);await f.activate('test')
  const orders=[]
  for(let i=0;i<12;i++){const order=await f.create();orders.push(order);await f.settle(order)}
  const client=f.recharge.sources.get('test').client,read=client.order.bind(client)
  client.order=async id=>{if(id===orders[0].paymentId)throw Error('temporarily unavailable');return read(id)}
  await f.recharge.sweep('test');assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,9)
  await f.recharge.sweep('test');assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,11)
  await new RechargeService(f.store,f.sources,{logger:log}).sweep('test')
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,12)
  const identity=await client.identity();client.identity=async()=>({...identity,sourceId:randomUUID()})
  const uncertain=await f.create()
  assert.equal(uncertain.paymentId,null);assert.equal(uncertain.recoveryCode,'recharge_source_mismatch')
  assert.equal((await f.pay.pool.query('SELECT * FROM pay.orders')).rowCount,12)
  await assert.rejects(f.recharge.sweep('test'),{code:'recharge_source_mismatch'})
})

test('activation validates application credentials; shutdown yields between events and foreground work has an admission limit',check,async t=>{
  const f=await fixture(t),client=f.recharge.sources.get('test').client,identity=await client.identity()
  const identify=client.identity.bind(client)
  client.identity=async()=>({...identity,scopes:['orders.read','orders.write']})
  await assert.rejects(f.activate('test'),{code:'recharge_credential_scope'})
  assert.equal(await f.recharge.owns('test'),false)
  client.identity=identify;await f.activate('test')
  const order=await f.create();await f.settle(order)
  f.recharge.stopped=true;await f.recharge.sweep('test')
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.inbox')).rowCount,0)
  let release;const hold=new Promise(resolve=>{release=resolve})
  const working=Array.from({length:4},()=>f.recharge.network(()=>hold))
  await assert.rejects(f.recharge.network(()=>assert.fail('excess work dispatched')),{code:'recharge_busy'})
  release();await Promise.all(working);assert.equal(f.recharge.inFlight,0)
})

test('activation fences old replicas and refuses live history; tenant HTTP scope and login survive a payment outage',check,async t=>{
  const f=await fixture(t)
  const old=await f.legacy.create(f.tenant,{environment:'test',amountMinor:1200},randomUUID(),f.member)
  await f.activate('test')
  await assert.rejects(f.legacy.create(f.tenant,{environment:'test',amountMinor:1200},randomUUID(),f.member),/legacy_payment_writer_disabled/)
  assert.equal((await f.legacy.store.list({tenantId:f.tenant,environment:'test'})).items[0].id,old.id)
  const source=await f.recharge.remote('live',{allowUnbound:true})
  await f.hub.pool.query("INSERT INTO mx_pay.settings VALUES('manual_alipay',$1)",[{enabled:true}])
  await assert.rejects(f.activate('live'),{code:'recharge_legacy_handover_required'})
  await f.hub.pool.query("UPDATE mx_pay.settings SET document='{\"enabled\":false}'")
  // Represent a pre-existing order using the real legacy order contract.
  const {createOrder}=await import('@qpjoy/mx-pay')
  const historic=createOrder({tenantId:f.tenant,input:{environment:'live',amountMinor:1200},actor:f.member,settings:{enabled:true,merchantAccountId:'legacy',payeeName:'Legacy',qrImage:'fixture',instructions:''}})
  await f.hub.pool.query('INSERT INTO mx_pay.orders(id,tenant_id,request_key,fingerprint,document) VALUES($1,$2,$3,$4,$5)',[historic.id,f.tenant,randomUUID(),'fixture',historic])
  await assert.rejects(f.recharge.activate('live',{sourceId:source.identity.sourceId,acknowledge:true},'admin'),{code:'recharge_legacy_handover_required'})
  const base=await f.api(),publicBase=await f.api('public')
  const request=(path,{token='billing',method='GET',body}={})=>fetch(`${base}/internal/v1/admin${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json','idempotency-key':randomUUID()},...(body===undefined?{}:{body:JSON.stringify(body)})})
  assert.equal((await request('/session')).status,200)
  assert.equal((await request(`/tenants/${f.tenant}/billing`)).status,200)
  assert.equal((await request(`/payments/orders?tenantId=${f.other}&environment=test`)).status,403)
  assert.equal((await request('/payments/integration')).status,403)
  const created=await request(`/payments/tenants/${f.tenant}/orders`,{method:'POST',body:{environment:'test',amountMinor:1200}})
  assert.equal(created.status,201);const order=(await created.json()).data
  assert.equal((await request(`/payments/tenants/${f.tenant}/orders/${order.id}/confirm`,{method:'POST',body:{}})).status,403)
  assert.equal((await request(`/payments/tenants/${f.other}/orders/${order.id}`)).status,403)
  assert.equal((await fetch(`${publicBase}/internal/v1/admin/payments/integration`,{headers:{authorization:'Bearer fixture-admin'}})).status,404)
  const client=f.recharge.sources.get('test').client
  client.identity=async()=>{throw Error('secret unreachable')}
  assert.equal((await request('/session')).status,200)
  assert.equal((await request(`/payments/tenants/${f.tenant}/orders/${order.id}`)).status,200)
  const channels=await (await request(`/payments/channels?tenantId=${f.tenant}`)).json()
  assert.equal(channels.data.test.enabled,false);assert.equal(channels.data.test.backend,'center');assert.doesNotMatch(JSON.stringify(channels),/secret/)
  const uncertain=await request(`/payments/tenants/${f.tenant}/orders`,{method:'POST',body:{environment:'test',amountMinor:1200}})
  assert.equal(uncertain.status,201);assert.equal((await uncertain.json()).data.paymentId,null)
})


const connectionBody = (source, revision = 0, token = source.token) => ({revision,baseUrl:source.baseUrl,appId:source.appId,channelId:source.channelId,token})

test('connection UI migrates retained environment secrets encrypted, fences versions, and preserves activation boundary',check,async t=>{
  const f=await fixture(t),source=f.sources.find(s=>s.environment==='live'),body=connectionBody(source,0,'')
  let status=(await f.recharge.status()).items.find(row=>row.environment==='live')
  assert.equal(status.connection.origin,'environment');assert.equal(status.configured,true)
  const checked=await f.recharge.configure('live',body,'admin',{checkOnly:true})
  assert.equal(checked.channelEnabled,true)
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.connections')).rowCount,0,'checking cannot persist')
  assert.equal(await f.recharge.owns('live'),false)
  const saved=await f.recharge.configure('live',body,'admin')
  assert.equal(saved.connection.origin,'database');assert.equal(saved.connection.revision,1)
  const row=(await f.hub.pool.query("SELECT * FROM hub_recharge.connections WHERE environment='live'")).rows[0]
  assert.ok(row.sealed.startsWith('v1.'));assert.ok(!row.sealed.includes(source.token))
  assert.equal(await f.recharge.owns('live'),false,'saving a connection is not payment activation')
  status=(await f.recharge.status()).items.find(row=>row.environment==='live')
  assert.equal(status.connection.tokenConfigured,true);assert.ok(!JSON.stringify(status).includes(source.token));assert.equal(status.connection.token,undefined)
  const audit=(await f.hub.pool.query('SELECT * FROM hub_recharge.connection_audit')).rows
  assert.equal(audit.length,1);assert.ok(!JSON.stringify(audit).includes(source.token))
  await assert.rejects(f.hub.pool.query('DELETE FROM hub_recharge.connection_audit'),/append-only/)
  await assert.rejects(f.recharge.configure('live',body,'stale-admin'),{code:'recharge_connection_conflict'})
  await assert.rejects(f.recharge.configure('live',{...body,revision:1,baseUrl:'http://new-pay.invalid'},'admin'),{code:'recharge_token_required'})
  const attempts=await Promise.allSettled([f.recharge.configure('live',{...body,revision:1},'first'),f.recharge.configure('live',{...body,revision:1},'second')])
  assert.equal(attempts.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(attempts.find(r=>r.status==='rejected').reason.code,'recharge_connection_conflict')
  await f.activate('live')
  await assert.rejects(f.recharge.configure('live',{...body,revision:2,channelId:'other-channel'},'admin'),{code:'recharge_source_mismatch'})
  await assert.rejects(f.recharge.configure('live',{...body,revision:2,token:f.sources[0].token},'admin'),{code:'recharge_source_mismatch'})
  assert.equal((await f.recharge.connections.read('live')).revision,2)
  const second=new RechargeService(f.store,[],{logger:log,pepper})
  assert.equal((await second.remote('live')).identity.sourceId,checked.sourceId,'another replica reads saved source without env')
  const staleEnv=new RechargeService(f.store,[{...source,token:randomUUID()}],{logger:log,pepper})
  assert.equal((await staleEnv.remote('live')).identity.sourceId,checked.sourceId,'DB wins over old environment config')
  const wrongKey=new RechargeService(f.store,f.sources,{logger:log,pepper:pepper+'wrong'})
  await assert.rejects(wrongKey.remote('live'),{code:'recharge_connection_unavailable'})
  assert.throws(()=>f.recharge.connections.open('test',row.sealed),{code:'recharge_connection_unavailable'})
  const live=await f.create('live');await f.settle(live)
  await Promise.all([f.recharge.sweep('live'),second.sweep('live')])
  assert.equal(await f.balance(),1200)
  assert.equal((await f.hub.pool.query('SELECT * FROM billing.credit_ledger_entries')).rowCount,1)
})

test('an initially unconfigured worker discovers UI settings and delivers exactly once without restart',check,async t=>{
  const f=await fixture(t)
  const running=new RechargeService(f.store,[],{logger:log,pepper})
  running.start();await running.running
  try {
    const saved=await running.configure('live',connectionBody(f.sources[1]),'admin')
    await running.activate('live',{sourceId:saved.sourceId,acknowledge:true},'admin')
    const order=await running.create(f.tenant,{environment:'live',amountMinor:1200},randomUUID(),f.member)
    await f.settle(order)
    const deadline=Date.now()+8000
    while(Date.now()<deadline && await f.balance()===0)await new Promise(resolve=>setTimeout(resolve,100))
    assert.equal(await f.balance(),1200)
    await running.sweep('live');assert.equal(await f.balance(),1200)
  } finally {await running.close()}
})

test('payment connection management is platform-admin only, unavailable publicly, and redacts dependency errors',check,async t=>{
  const f=await fixture(t),base=await f.api(),publicBase=await f.api('public'),body=connectionBody(f.sources[1])
  const request=(origin,token,path,method='PUT')=>fetch(`${origin}/internal/v1/admin/payments/integration/live/${path}`,{method,headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify(body)})
  for(const [path,method]of [['connection','PUT'],['check','POST']]){
    assert.equal((await request(base,'billing',path,method)).status,403)
    assert.equal((await request(publicBase,'fixture-admin',path,method)).status,404)
  }
  const checkResponse=await request(base,'fixture-admin','check','POST');assert.equal(checkResponse.status,200)
  assert.equal((await f.hub.pool.query('SELECT * FROM hub_recharge.connections')).rowCount,0)
  const save=await request(base,'fixture-admin','connection');assert.equal(save.status,200)
  const data=await save.text();assert.ok(!data.includes(body.token));assert.ok(!data.includes('sealed'))
  const before=(await f.recharge.connections.read('live')).revision
  f.recharge.clientFactory=()=>({identity:async()=>{throw Object.assign(Error('secret-token-must-not-leak'),{status:401})}})
  body.revision=before
  const denied=await request(base,'fixture-admin','connection');assert.equal(denied.status,400)
  const failure=await denied.text();assert.ok(!failure.includes('secret-token-must-not-leak'));assert.match(failure,/payment_unauthorized/)
  assert.equal((await f.recharge.connections.read('live')).revision,before)
})
