import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { migrate, assertSchema, assertPaymentDatabase } from '../server/migrate.mjs'
import { PaymentCenter } from '../server/service.mjs'
import { createApp } from '../server/app.mjs'
import { readCredentials } from '../server/config.mjs'
import { PaymentClient } from '../src/client.mjs'

const databaseUrl=process.env.MX_PAY_TEST_DATABASE_URL
const qrImage='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIUkAAAAASUVORK5CYII='
test('dedicated PostgreSQL and HTTP: scopes, concurrent receipts, transactional outbox and replay', { skip: databaseUrl ? false : 'Set disposable MX_PAY_TEST_DATABASE_URL' }, async t=>{
  await Promise.all([migrate(databaseUrl,{log(){}}),migrate(databaseUrl,{log(){}})])
  assert.deepEqual((await migrate(databaseUrl,{log(){}})).applied,[])
  const pool=new pg.Pool({connectionString:databaseUrl,max:12}), service=new PaymentCenter(pool)
  t.after(()=>pool.end());await assertSchema(pool)
  const migrationRow=(await pool.query('SELECT filename,checksum FROM schema_migrations ORDER BY filename LIMIT 1')).rows[0]
  await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE filename=$1',[migrationRow.filename,'0'.repeat(64)])
  try {await assert.rejects(migrate(databaseUrl,{log(){}}),/migration changed/i);await assert.rejects(assertSchema(pool),/incompatible/)}
  finally {await pool.query('UPDATE schema_migrations SET checksum=$2 WHERE filename=$1',[migrationRow.filename,migrationRow.checksum])}
  const dir=await mkdtemp(join(tmpdir(),'mx-pay-api-test-'));t.after(()=>rm(dir,{recursive:true,force:true}))
  const app=`app-${randomUUID()}`, otherApp=`app-${randomUUID()}`
  const entries=[
    {id:'app-test',appId:app,environment:'test',secret:randomUUID(),scopes:['orders.read','orders.write','events.read','events.ack']},
    {id:'finance-test',appId:app,environment:'test',secret:randomUUID(),scopes:['orders.read','receipts.confirm','settings.write']},
    {id:'app-live',appId:app,environment:'live',secret:randomUUID(),scopes:['orders.read','orders.write','events.read','events.ack']},
    {id:'finance-live',appId:app,environment:'live',secret:randomUUID(),scopes:['orders.read','orders.write','receipts.confirm','settings.write','events.read','events.ack']},
    {id:'other-live',appId:otherApp,environment:'live',secret:randomUUID(),scopes:['orders.read','orders.write','receipts.confirm']},
  ]
  await writeFile(join(dir,'credentials.json'),JSON.stringify(entries))
  const credentials=readCredentials(join(dir,'credentials.json')), state={draining:false}
  const runtimeRole=`pay_runtime_${randomUUID().replaceAll('-','')}`
  await pool.query(`CREATE ROLE ${runtimeRole} LOGIN`)
  const runtimeUrl=new URL(databaseUrl);runtimeUrl.username=runtimeRole
  const runtimePool=new pg.Pool({connectionString:runtimeUrl.href,max:2})
  try {
    await migrate(databaseUrl,{log(){}},{runtimeRole})
    await assertSchema(runtimePool)
    const restricted=new PaymentCenter(runtimePool)
    assert.equal((await restricted.create(credentials[0],{businessOrderId:randomUUID(),customerRef:'runtime-role-test',amountMinor:500},randomUUID())).status,'pending')
    await assert.rejects(runtimePool.query('DELETE FROM pay.orders'),{code:'42501'})
    await assert.rejects(runtimePool.query('UPDATE pay.audit SET document=document'),{code:'42501'})
    assert.ok((await runtimePool.query('SELECT document FROM pay.reporting_changes WHERE app_id=$1',[app])).rowCount>0)
    await assert.rejects(runtimePool.query('UPDATE pay.reporting_changes SET document=document'),{code:'42501'})
    await assert.rejects(runtimePool.query('DELETE FROM pay.reporting_heads'),{code:'42501'})
  } finally {
    await runtimePool.end()
    await pool.query(`DROP OWNED BY ${runtimeRole}`)
    await pool.query(`DROP ROLE ${runtimeRole}`)
  }
  const server=createServer(createApp({service,credentials,state,logger:{error(){}}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const baseUrl=`http://127.0.0.1:${server.address().port}`, clients=entries.map(e=>new PaymentClient({baseUrl,token:e.secret}))
  const [client,finance,live,liveFinance,other]=clients
  await assert.rejects(finance.request('/v1/settings'),{code:'payment_environment_mismatch'})
  const body=()=>({businessOrderId:randomUUID(),customerRef:'tenant-opaque-reference',amountMinor:1200})
  const cfg=await service.settings()
  if(!cfg.enabled)await assert.rejects(live.create(body(),randomUUID()),{code:'payment_channel_disabled'})
  await liveFinance.request('/v1/settings',{method:'PUT',body:{expectedRevision:cfg.revision,enabled:true,merchantAccountId:cfg.merchantAccountId||'fixture-account',payeeName:'Fixture only',qrImage,instructions:'Not a real payment code'}})
  const input=body(),key=randomUUID()
  const created=await Promise.all(Array.from({length:6},()=>client.create(input,key)))
  assert.equal(new Set(created.map(o=>o.id)).size,1)
  await assert.rejects(client.create({...input,amountMinor:600},key),{code:'payment_idempotency_conflict'})
  await assert.rejects(client.create(input,randomUUID()),{code:'payment_idempotency_conflict'})
  await assert.rejects(live.order(created[0].id),{status:404})
  await assert.rejects(other.order(created[0].id),{status:404})
  let order=await client.act(created[0].id,'submit',{expectedRevision:0,payerName:'Test payer',tradeNo:'TEST-123'},randomUUID())
  assert.equal(order.status,'submitted');assert.equal((await client.events()).items.length,0)
  const receipt=randomUUID(),confirm={expectedRevision:1,tradeNo:receipt,receivedAmountMinor:1200,feeMinor:0,paidAt:new Date().toISOString(),note:'Fixture verified'}
  await assert.rejects(client.act(order.id,'confirm',confirm,randomUUID()),{status:403})
  const confirmKey=randomUUID(),paid=await Promise.all(Array.from({length:5},()=>finance.act(order.id,'confirm',confirm,confirmKey)))
  assert.ok(paid.every(o=>o.status==='paid'))
  assert.equal((await pool.query('SELECT id FROM pay.outbox WHERE order_id=$1',[order.id])).rowCount,1)
  assert.equal((await pool.query('SELECT id FROM pay.audit WHERE order_id=$1',[order.id])).rowCount,3)
  await assert.rejects(pool.query('DELETE FROM pay.audit WHERE order_id=$1',[order.id]),/append-only/)
  await assert.rejects(pool.query("UPDATE pay.orders SET document=jsonb_set(document,'{amountMinor}','600') WHERE id=$1",[order.id]),/immutable|rewritten/)
  const delivered=new Map();let lostAck=true
  const unreliable=new PaymentClient({baseUrl,token:entries[0].secret,fetchImplementation:async(url,options)=>{
    const response=await fetch(url,options)
    if(url.endsWith('/ack')&&lostAck){lostAck=false;throw Error('Ack response lost after commit')}
    return response
  }})
  const commit=async event=>{if(!delivered.has(event.id))delivered.set(event.id,`journal:${event.id}`);return delivered.get(event.id)}
  const batch=await unreliable.consumeBatch(commit)
  assert.equal(batch.failed.length,1);assert.equal(delivered.size,1)
  const event=(await pool.query('SELECT document FROM pay.outbox WHERE order_id=$1',[order.id])).rows[0].document
  await client.acknowledge(event.id,await commit(event));assert.equal(delivered.size,1)
  assert.equal((await client.events(event.id)).items.length,0)
  await assert.rejects(live.events(event.id),{status:404})
  await assert.rejects(client.acknowledge(event.id,'different-journal'),{code:'payment_ack_conflict'})
  assert.equal((await client.events()).items.length,0)
  await assert.rejects(live.acknowledge(event.id,'wrong-environment'),{status:404})
  async function submitted(c) {let o=await c.create(body(),randomUUID());return c.act(o.id,'submit',{expectedRevision:0,payerName:'Fixture',tradeNo:'SOURCE-123'},randomUUID())}
  const a=await submitted(live),b=await submitted(other)
  // The same provider receipt is isolated between test and live, but unique across live apps.
  await liveFinance.act(a.id,'confirm',confirm,randomUUID())
  await assert.rejects(other.act(b.id,'confirm',confirm,randomUUID()),{code:'payment_identity_conflict'})
  assert.equal((await other.order(b.id)).status,'submitted')
  const original=service.audit.bind(service)
  service.audit=async()=>{throw Error('audit failure after order update')}
  await assert.rejects(other.act(b.id,'confirm',{...confirm,tradeNo:randomUUID()},randomUUID()),{status:503})
  service.audit=original
  assert.equal((await other.order(b.id)).status,'submitted')
  assert.equal((await pool.query('SELECT id FROM pay.outbox WHERE order_id=$1',[b.id])).rowCount,0)
  assert.equal((await fetch(`${baseUrl}/v1/orders`)).status,401)
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status,200)
  state.draining=true
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status,503)
  assert.equal((await fetch(`${baseUrl}/health/live`)).status,200)
  await assert.rejects(client.create(body(),randomUUID()),{status:503})
  state.draining=false
  // Readiness never consults Hub or Launcher, and a reconstructed API sees committed facts.
  assert.equal((await new PaymentCenter(pool).order(credentials[0],order.id)).status,'paid')
  await pool.query('CREATE TABLE public.tenants (id uuid)')
  try {await assert.rejects(assertPaymentDatabase(pool),/dedicated/);await assert.rejects(migrate(databaseUrl),/dedicated/)}
  finally {await pool.query('DROP TABLE public.tenants')}
  const port=server.address().port
  await new Promise(resolve=>server.close(resolve))
  const child=spawn(process.execPath,[fileURLToPath(new URL('../server/index.mjs',import.meta.url))],{
    env:{...process.env,MX_PAY_DATABASE_URL:databaseUrl,MX_PAY_CREDENTIALS_FILE:join(dir,'credentials.json'),MX_PAY_HOST:'127.0.0.1',MX_PAY_PORT:String(port),MX_PAY_DRAIN_MS:'1000'},stdio:'ignore',
  })
  const exit=once(child,'exit');t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL')})
  let ready=false
  for(let i=0;i<60;i++) {
    ready=await fetch(`${baseUrl}/health/ready`).then(r=>r.ok).catch(()=>false)
    if(ready)break
    await delay(50)
  }
  assert.ok(ready,'standalone entrypoint starts from migrated storage')
  assert.equal((await client.order(order.id)).status,'paid')
  child.kill('SIGTERM')
  await delay(100)
  assert.equal((await fetch(`${baseUrl}/health/ready`)).status,503)
  assert.equal((await fetch(`${baseUrl}/health/live`)).status,200)
  assert.deepEqual(await exit,[0,null])
})
