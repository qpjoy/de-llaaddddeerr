import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import pg from 'pg'
import { migrate } from '../server/migrate.mjs'
import { PaymentCenter } from '../server/service.mjs'
import { createApp } from '../server/app.mjs'
import { PaymentClient } from '../src/client.mjs'

// Deterministic fault injection at a real PG statement boundary. This is not
// a claim that a real network partition, node loss or HA failover was exercised.
function failAfter(pool,statement) {
  let armed=true
  return {
    query:pool.query.bind(pool),
    async connect() {
      const client=await pool.connect()
      return {
        release:()=>client.release(),
        async query(sql,args) {
          const result=await client.query(sql,args)
          if(armed && statement.test(sql)) {armed=false;throw Object.assign(Error('Injected response loss after statement'),{code:'ECONNRESET'})}
          return result
        },
      }
    },
  }
}
const principal=()=>({id:'fault-test',appId:`fault-${randomUUID()}`,environment:'test',scopes:['orders.read','orders.write','receipts.confirm','events.read','events.ack']})
const input=()=>({businessOrderId:randomUUID(),customerRef:'unchanged-tenant-reference',amountMinor:1200})
const confirm=(tradeNo=randomUUID())=>({expectedRevision:1,tradeNo,receivedAmountMinor:1200,feeMinor:null,paidAt:new Date().toISOString(),note:'Synthetic fault test only'})

test('real PostgreSQL transaction failure matrix', {skip:!process.env.MX_PAY_TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.MX_PAY_TEST_DATABASE_URL,max:1})
  const name=`pay_faults_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url=new URL(process.env.MX_PAY_TEST_DATABASE_URL);url.pathname=`/${name}`
  const pool=new pg.Pool({connectionString:url.href,max:10})
  t.after(async()=>{
    await pool.end()
    // pg-pool finishes disposal before PostgreSQL necessarily observes every
    // socket closing. Do not FORCE-kill those sockets into completed subtests.
    for(let i=0;i<100;i++) {
      const remaining=await admin.query('SELECT 1 FROM pg_stat_activity WHERE datname=$1',[name])
      if(!remaining.rowCount)break
      await new Promise(resolve=>setTimeout(resolve,10))
    }
    try {await admin.query(`DROP DATABASE ${name}`)} finally {await admin.end()}
  })
  await migrate(url.href,{log(){}})
  const service=new PaymentCenter(pool)
  async function submitted(p) {
    const order=await service.create(p,input(),randomUUID())
    return service.act(p,order.id,'submit',{expectedRevision:0,payerName:'Synthetic payer',tradeNo:randomUUID()},randomUUID())
  }
  async function facts(id) {
    const {rows}=await pool.query(`SELECT status,(document->>'revision')::int AS revision,
      (SELECT count(*)::int FROM pay.audit WHERE order_id=o.id) AS audit,
      (SELECT count(*)::int FROM pay.outbox WHERE order_id=o.id) AS outbox,
      (SELECT count(*)::int FROM pay.reporting_changes WHERE order_id=o.id) AS reporting
      FROM pay.orders o WHERE id=$1`,[id])
    return rows[0]
  }

  await t.test('F01: failure after inserting a new order leaves no partial order, audit or reporting event',async()=>{
    const p=principal(),body=input(),key=randomUUID()
    const failing=new PaymentCenter(failAfter(pool,/^INSERT INTO pay\.orders/))
    await assert.rejects(failing.create(p,body,key),{code:'ECONNRESET'})
    assert.equal((await pool.query('SELECT id FROM pay.orders WHERE app_id=$1',[p.appId])).rowCount,0)
    assert.equal((await pool.query('SELECT position FROM pay.reporting_changes WHERE app_id=$1',[p.appId])).rowCount,0)
    const order=await service.create(p,body,key)
    assert.deepEqual(await facts(order.id),{status:'pending',revision:0,audit:1,outbox:0,reporting:1})
  })

  await t.test('F02: create COMMIT succeeded but its response is lost; lookup and original-key replay recover one order',async()=>{
    const p=principal(),body=input(),key=randomUUID()
    await assert.rejects(new PaymentCenter(failAfter(pool,/^COMMIT$/)).create(p,body,key),{code:'payment_outcome_unknown'})
    const found=await service.list(p,new URLSearchParams({businessOrderId:body.businessOrderId}))
    assert.equal(found.items.length,1)
    const recovered=await Promise.all(Array.from({length:6},()=>new PaymentCenter(pool).create(p,body,key)))
    assert.ok(recovered.every(o=>o.id===found.items[0].id))
    assert.deepEqual(await facts(found.items[0].id),{status:'pending',revision:0,audit:1,outbox:0,reporting:1})
  })

  await t.test('F03: failure after outbox insertion rolls back paid status, audit, outbox and reporting together',async()=>{
    const p=principal(),order=await submitted(p),body=confirm(),key=randomUUID()
    await assert.rejects(new PaymentCenter(failAfter(pool,/^INSERT INTO pay\.outbox/)).act(p,order.id,'confirm',body,key),{code:'ECONNRESET'})
    assert.deepEqual(await facts(order.id),{status:'submitted',revision:1,audit:2,outbox:0,reporting:2})
    await service.act(p,order.id,'confirm',body,key)
    assert.deepEqual(await facts(order.id),{status:'paid',revision:2,audit:3,outbox:1,reporting:3})
  })

  await t.test('F04: confirm COMMIT response loss never turns a durable payment into a failed or duplicated payment',async()=>{
    const p=principal(),order=await submitted(p),body=confirm(),key=randomUUID()
    await assert.rejects(new PaymentCenter(failAfter(pool,/^COMMIT$/)).act(p,order.id,'confirm',body,key),{code:'payment_outcome_unknown'})
    assert.deepEqual(await facts(order.id),{status:'paid',revision:2,audit:3,outbox:1,reporting:3})
    const event=(await service.pending(p)).items[0]
    const retries=await Promise.all(Array.from({length:6},()=>new PaymentCenter(pool).act(p,order.id,'confirm',body,key)))
    assert.ok(retries.every(o=>o.status==='paid' && o.revision===2))
    assert.equal((await service.pending(p)).items[0].id,event.id)
    assert.deepEqual(await facts(order.id),{status:'paid',revision:2,audit:3,outbox:1,reporting:3})
    await assert.rejects(service.act(p,order.id,'confirm',{...body,tradeNo:randomUUID()},key),{code:'payment_idempotency_conflict'})
  })

  await t.test('F05: HTTP confirm response loss is unknown to SDK; same request recovers committed facts',async()=>{
    const p=principal(),token=randomUUID(),order=await submitted(p),body=confirm(),key=randomUUID()
    const credentials=[{...p,hash:createHash('sha256').update(token).digest()}]
    const server=createServer(createApp({service,credentials,logger:{error(){}}}))
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    try {
      let lose=true,calls=0
      const client=new PaymentClient({baseUrl:`http://127.0.0.1:${server.address().port}`,token,fetchImplementation:async(...args)=>{
        calls+=1;const response=await fetch(...args)
        if(lose){lose=false;await response.arrayBuffer();throw Error('Injected HTTP response loss')}
        return response
      }})
      await assert.rejects(client.act(order.id,'confirm',body,key),{code:'payment_outcome_unknown'})
      assert.equal(calls,1,'SDK must not issue hidden retries')
      assert.equal((await client.order(order.id)).status,'paid')
      assert.equal((await client.act(order.id,'confirm',body,key)).status,'paid')
      assert.deepEqual(await facts(order.id),{status:'paid',revision:2,audit:3,outbox:1,reporting:3})
    } finally {await new Promise(resolve=>server.close(resolve))}
  })

  await t.test('F06: competing confirmation and rejection serialize; only one revision and matching side effects commit',async()=>{
    const p=principal(),order=await submitted(p)
    const results=await Promise.allSettled([
      service.act(p,order.id,'confirm',confirm(),randomUUID()),
      service.act(p,order.id,'reject',{expectedRevision:1,reason:'Synthetic review conflict'},randomUUID()),
    ])
    assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(results.find(r=>r.status==='rejected').reason.code,'payment_revision_conflict')
    const state=await facts(order.id)
    assert.ok(['pending','paid'].includes(state.status))
    assert.deepEqual(state,{status:state.status,revision:2,audit:3,outbox:state.status==='paid'?1:0,reporting:3})
  })

  await t.test('F07: conflicting create keys and concurrent reuse of one channel receipt cannot duplicate identities',async()=>{
    const p=principal(),body=input()
    const creates=await Promise.allSettled([service.create(p,body,randomUUID()),service.create(p,body,randomUUID())])
    assert.equal(creates.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(creates.find(r=>r.status==='rejected').reason.status,409)
    assert.equal((await service.list(p,new URLSearchParams({businessOrderId:body.businessOrderId}))).items.length,1)
    const other=principal(),a=await submitted(p),b=await submitted(other),receipt=confirm()
    const confirms=await Promise.allSettled([service.act(p,a.id,'confirm',receipt,randomUUID()),service.act(other,b.id,'confirm',receipt,randomUUID())])
    assert.equal(confirms.filter(r=>r.status==='fulfilled').length,1)
    assert.equal(confirms.find(r=>r.status==='rejected').reason.code,'payment_identity_conflict')
    const states=await Promise.all([facts(a.id),facts(b.id)])
    assert.equal(states.filter(s=>s.status==='paid').length,1)
    assert.equal(states.reduce((n,s)=>n+s.outbox,0),1)
    assert.deepEqual(states.find(s=>s.status==='submitted'),{status:'submitted',revision:1,audit:2,outbox:0,reporting:2})
  })
})
