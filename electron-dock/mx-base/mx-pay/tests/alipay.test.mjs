import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, createSign, createVerify, randomUUID, createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import pg from 'pg'
import { AlipayChannel, decimalMinor, alipayTime } from '../server/alipay.mjs'
import { readChannels } from '../server/channel-config.mjs'
import { PaymentCenter } from '../server/service.mjs'
import { migrate } from '../server/migrate.mjs'
import { createApp } from '../server/app.mjs'
import { PaymentClient } from '../src/client.mjs'
import { PaymentReportingStore, reportingMigrationsDir } from '../reporting/index.mjs'
import { runMigrations } from '@qpjoy/mx-common/postgres'

const keys = () => generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type:'spki',format:'pem' }, privateKeyEncoding: { type:'pkcs8',format:'pem' } })
const merchant = keys(), upstream = keys()
const cfg = { id:'alipay-sandbox',provider:'alipay',environment:'test',enabled:true,appId:'2021000000000001',sellerId:'2088000000000001',allowedApps:['channel-fixture'],keyType:'PKCS8',
  privateKey:merchant.privateKey,alipayPublicKey:upstream.publicKey,notifyUrl:'https://pay.example.test/v1/notifications/alipay/alipay-sandbox',returnUrl:'https://app.example.test/payment/result' }
const sign = body => ({ ...body, sign:createSign('RSA-SHA256').update(Object.keys(body).filter(k=>k!=='sign'&&k!=='sign_type'&&body[k]!=='').sort().map(k=>`${k}=${body[k]}`).join('&')).sign(upstream.privateKey,'base64') })
const time = () => new Date(Date.now()+8*3600000).toISOString().slice(0,19).replace('T',' ')
const paid = (order, extra={}) => sign({ sign_type:'RSA2',app_id:cfg.appId,seller_id:cfg.sellerId,out_trade_no:order.checkout?.outTradeNo ?? order.id,trade_no:'202610030000'+String(Math.floor(Math.random()*1e12)).padStart(12,'0'),
  trade_status:'TRADE_SUCCESS',total_amount:'12.00',receipt_amount:'12.00',gmt_payment:time(),...extra })
const principal = {id:'channel-test',appId:'channel-fixture',environment:'test',scopes:['orders.read','orders.write','receipts.confirm','events.read','events.ack','reports.read']}
const body = () => ({businessOrderId:randomUUID(),customerRef:'tenant-opaque',amountMinor:1200,channelId:cfg.id,subject:'测试充值 套餐 + 100% 中文'})
const channelOrder = () => {
  const id=randomUUID()
  return {id,checkout:{outTradeNo:`MXP${id.replaceAll('-','')}`},amountMinor:1201,subject:'套餐 + 100% 中文',createdAt:new Date().toISOString()}
}

test('official SDK: local checkout RSA2 signature, strict config, notify tampering and integer money',t=>{
  const dir=mkdtempSync(join(tmpdir(),'mx-pay-channel-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
  const file=join(dir,'channels.json');writeFileSync(file,JSON.stringify([cfg]))
  assert.equal(readChannels(file)[0].id,cfg.id)
  const adapter=new AlipayChannel(cfg), order=channelOrder()
  const checkout=adapter.checkout(order), url=new URL(checkout.payUrl), params=Object.fromEntries(url.searchParams)
  assert.equal(url.origin,'https://openapi-sandbox.dl.alipaydev.com')
  const content=JSON.parse(params.biz_content)
  assert.equal(content.total_amount,'12.01');assert.equal(content.out_trade_no,order.checkout.outTradeNo)
  assert.match(content.out_trade_no,/^[A-Za-z0-9_]{1,64}$/);assert.equal(content.seller_id,undefined)
  assert.equal(content.subject,order.subject);assert.equal(params.notify_url,cfg.notifyUrl)
  assert.ok(Math.abs(Date.parse(alipayTime(params.timestamp))-Date.now())<5000,'signature timestamp uses Shanghai even when the container runs in UTC')
  const payload=Object.keys(params).filter(k=>k!=='sign'&&params[k]!=='').sort().map(k=>`${k}=${params[k]}`).join('&')
  assert.ok(createVerify('RSA-SHA256').update(payload).verify(merchant.publicKey,params.sign,'base64'))
  const notice=paid(order,{subject:'套餐 + 100% & 中文'})
  assert.deepEqual(adapter.verify(notice),notice)
  assert.throws(()=>adapter.verify({...notice,total_amount:'0.01'}),{code:'payment_notification_signature'})
  assert.throws(()=>adapter.verify(paid(order,{app_id:'2021000000000002'})),{code:'payment_notification_identity'})
  assert.throws(()=>adapter.verify(paid(order,{seller_id:'2088000000000002'})),{code:'payment_notification_identity'})
  assert.throws(()=>adapter.verify(paid(order,{sign_type:'RSA'})),{code:'payment_notification_signature'})
  assert.throws(()=>adapter.checkout({...order,createdAt:'2020-01-01T00:00:00.000Z'}),{code:'payment_checkout_expired'})
  assert.throws(()=>adapter.checkout({...order,checkout:{}}),{code:'payment_checkout_legacy_order'})
  for(const invalid of ['1e2','0.001','-1','01.00','NaN',12])assert.equal(decimalMinor(invalid),null)
  assert.equal(decimalMinor('12.1'),1210);assert.equal(alipayTime('2026-02-31 00:00:00'),null)
  for(const extra of [{privateKey:'invalid-key'},{gateway:'http://attacker.test'},{notifyUrl:'http://pay.test/a'},{sellerId:'bad'},{allowedApps:['*']},{provider:'wechat'}]) {
    writeFileSync(file,JSON.stringify([{...cfg,...extra}]))
    assert.throws(()=>readChannels(file),/values hidden/)
  }
})

test('checkout never renews its expiry and refuses the final minute',t=>{
  const now=Date.parse('2026-10-03T05:00:00.456Z'),adapter=new AlipayChannel(cfg)
  let clock=now
  t.mock.method(Date,'now',()=>clock)
  const order={...channelOrder(),createdAt:new Date(now).toISOString()}
  const first=adapter.checkout(order)
  clock=now+28*60000
  const repeated=adapter.checkout(order)
  const biz=url=>JSON.parse(new URL(url).searchParams.get('biz_content'))
  assert.equal(first.expiresAt,repeated.expiresAt)
  assert.deepEqual(biz(first.payUrl),biz(repeated.payUrl))
  clock=now+29*60000
  assert.throws(()=>adapter.checkout(order),{code:'payment_checkout_expired'})
})

test('official SDK HTTP query verifies signed requests/responses; unknown outcomes stay redacted',async t=>{
  const adapter=new AlipayChannel(cfg),order=channelOrder(),requests=[]
  const query={code:'10000',out_trade_no:order.checkout.outTradeNo,trade_no:'202610030000000000001',trade_status:'TRADE_SUCCESS',total_amount:'12.00',send_pay_date:time()}
  const envelope=value=>{
    const raw=JSON.stringify(value),signature=createSign('RSA-SHA256').update(raw).sign(upstream.privateKey,'base64')
    return `{"alipay_trade_query_response":${raw},"sign":"${signature}"}`
  }
  let response=envelope(query),status=200
  const server=createServer(async(req,res)=>{
    let data='';for await(const chunk of req)data+=chunk
    const params=Object.fromEntries(new URLSearchParams(data))
    Object.assign(params,Object.fromEntries(new URL(req.url,'http://localhost').searchParams))
    requests.push({method:req.method,params})
    res.writeHead(status,{'content-type':'application/json'});res.end(response)
  })
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  // Only this test SDK instance uses loopback; production channel config forbids custom gateways.
  adapter.sdk.config.gateway=`http://127.0.0.1:${server.address().port}/gateway.do`
  assert.equal((await adapter.query(order)).gmt_payment,query.send_pay_date)
  const {params}=requests[0]
  assert.equal(requests[0].method,'POST');assert.equal(params.method,'alipay.trade.query')
  assert.equal(params.app_id,cfg.appId);assert.equal(JSON.parse(params.biz_content).out_trade_no,order.checkout.outTradeNo)
  assert.ok(Math.abs(Date.parse(alipayTime(params.timestamp))-Date.now())<5000)
  const canonical=Object.keys(params).filter(k=>k!=='sign'&&params[k]!=='').sort().map(k=>`${k}=${params[k]}`).join('&')
  assert.ok(createVerify('RSA-SHA256').update(canonical).verify(merchant.publicKey,params.sign,'base64'))
  for(const invalid of [envelope(query).replace('12.00','99.00'),JSON.stringify({alipay_trade_query_response:query}),
    envelope({...query,code:'40004',sub_code:'ACQ.TRADE_NOT_EXIST'}),'{private credential must not appear']) {
    response=invalid
    await assert.rejects(adapter.query(order),e=>e.code==='payment_channel_query_unknown'&&!e.message.includes('credential'))
  }
  status=502;response=envelope(query)
  await assert.rejects(adapter.query(order),{code:'payment_channel_query_unknown'})
  status=200;response=envelope({...query,out_trade_no:order.id})
  await adapter.query({...order,checkout:{}})
  assert.equal(JSON.parse(requests.at(-1).params.biz_content).out_trade_no,order.id,'legacy query must retain the exact original remote identity')
  response=envelope({...query,app_id:'wrong-app',seller_id:''})
  const mismatch=await adapter.query(order)
  assert.equal(mismatch.app_id,'wrong-app');assert.equal(mismatch.seller_id,'','do not hide returned identity mismatches')
})

test('Alipay HTTP and real PostgreSQL: notification atomicity, replay, isolation and recovery', {skip:!process.env.MX_PAY_TEST_DATABASE_URL},async t=>{
  const admin=new pg.Pool({connectionString:process.env.MX_PAY_TEST_DATABASE_URL,max:1}), name=`pay_channels_${randomUUID().replaceAll('-','')}`
  await admin.query(`CREATE DATABASE ${name}`)
  const url=new URL(process.env.MX_PAY_TEST_DATABASE_URL);url.pathname=`/${name}`
  const pool=new pg.Pool({connectionString:url.href,max:10})
  t.after(async()=>{await pool.end();await admin.query(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end()})
  const oldMigrations=mkdtempSync(join(tmpdir(),'mx-pay-pre-channel-id-'))
  t.after(()=>rmSync(oldMigrations,{recursive:true,force:true}))
  for(const file of ['pay_001_transactions.sql','pay_002_reporting.sql','pay_003_channels.sql'])copyFileSync(new URL(`../migrations/${file}`,import.meta.url),join(oldMigrations,file))
  await runMigrations({connectionString:url.href,migrationsDir:oldMigrations,logger:{log(){}}})
  const configs=[cfg,{...cfg,id:'alipay-live',environment:'live',appId:'2021000000000002',sellerId:'2088000000000002',notifyUrl:'https://pay.example.test/v1/notifications/alipay/alipay-live'}]
  const service=new PaymentCenter(pool,{channels:configs});await service.channelPayments.bind()
  const originalCreate=service.channelPayments.create.bind(service.channelPayments)
  service.channelPayments.create=(...args)=>{const order=originalCreate(...args);delete order.checkout.outTradeNo;return order}
  const legacy=await service.create(principal,body(),randomUUID())
  service.channelPayments.create=originalCreate
  await migrate(url.href,{log(){}})
  assert.deepEqual(await service.order(principal,legacy.id),legacy,'migration must not rewrite an existing remote payment identity')
  const token=randomUUID(), credentials=[{...principal,hash:createHash('sha256').update(token).digest()}]
  const server=createServer(createApp({service,credentials,logger:{error(){}}}))
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)))
  const origin=`http://127.0.0.1:${server.address().port}`,client=new PaymentClient({baseUrl:origin,token})
  const post=payload=>fetch(`${origin}/v1/notifications/alipay/${cfg.id}`,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:typeof payload==='string'?payload:new URLSearchParams(payload).toString()})
  const create=()=>client.create(body(),randomUUID())
  const facts=async id=>(await pool.query(`SELECT status,(SELECT count(*)::int FROM pay.outbox WHERE order_id=o.id) AS events,
    (SELECT count(*)::int FROM pay.channel_observations WHERE order_id=o.id) AS observations,
    (SELECT count(*)::int FROM pay.reporting_changes WHERE order_id=o.id) AS reports FROM pay.orders o WHERE id=$1`,[id])).rows[0]

  await t.test('channel discovery, explicit app/environment scope, stable order and bound merchant',async()=>{
    await service.create(principal,body(),randomUUID())
    assert.deepEqual((await client.channels()).items.map(c=>c.id),['mock',cfg.id])
    const input=body(),key=randomUUID(),orders=await Promise.all(Array.from({length:5},()=>client.create(input,key)))
    assert.equal(new Set(orders.map(o=>o.id)).size,1)
    assert.equal(new Set(orders.map(o=>o.checkout.outTradeNo)).size,1)
    assert.equal((await client.checkout(orders[0].id)).provider,'alipay')
    await assert.rejects(client.create({...input,channelId:'alipay-live'},randomUUID()),{code:'payment_idempotency_conflict'})
    await assert.rejects(client.create({...body(),channelId:'alipay-live'},randomUUID()),{code:'payment_channel_forbidden'})
    await assert.rejects(service.create({...principal,appId:'another-app'},body(),randomUUID()),{code:'payment_channel_forbidden'})
    for(const action of ['submit','confirm','cancel','reject'])await assert.rejects(client.act(orders[0].id,action,{expectedRevision:0},randomUUID()),{code:'payment_channel_action'})
    await assert.rejects(pool.query("UPDATE pay.orders SET document=jsonb_set(document,'{status}','\"cancelled\"') WHERE id=$1",[orders[0].id]),{code:'23514'})
    await assert.rejects(pool.query("UPDATE pay.orders SET document=jsonb_set(document,'{status}','\"paid\"') WHERE id=$1",[orders[0].id]),{code:'23514'})
    const changed=new PaymentCenter(pool,{channels:[{...cfg,sellerId:'2088000000000099'},configs[1]]})
    await assert.rejects(changed.channelPayments.bind(),{code:'payment_channel_identity_changed'})
    await assert.rejects(new PaymentCenter(pool).channelPayments.bind(),{code:'payment_channel_configuration_missing'})
  })
  await t.test('upgrade preserves legacy receipts; new and legacy channel IDs cannot alias one another',async()=>{
    await assert.rejects(client.checkout(legacy.id),{code:'payment_checkout_legacy_order'})
    const order=await create(),alias=paid(order,{out_trade_no:order.id})
    assert.equal((await post(alias)).status,200)
    assert.equal((await facts(order.id)).status,'pending')
    const legacyAlias=paid(legacy,{out_trade_no:`MXP${legacy.id.replaceAll('-','')}`})
    assert.equal((await post(legacyAlias)).status,200)
    assert.equal((await facts(legacy.id)).status,'pending')
    const records=(await pool.query("SELECT order_id,reason FROM pay.channel_observations WHERE document->>'tradeNo'=ANY($1)",[[alias.trade_no,legacyAlias.trade_no]])).rows
    assert.equal(records.length,2)
    assert.ok(records.every(r=>r.order_id===null&&r.reason==='unmatched_order'))
    assert.equal((await post(paid(order))).status,200)
    assert.equal((await post(paid(legacy))).status,200)
    for(const id of [order.id,legacy.id])assert.equal((await facts(id)).events,1)
    await assert.rejects(pool.query("UPDATE pay.orders SET document=jsonb_set(document,'{checkout,outTradeNo}','\"MXPchanged\"') WHERE id=$1",[order.id]),/identity is immutable/)
    const invalid={...service.channelPayments.create(principal,body()),appId:principal.appId,businessOrderId:randomUUID(),customerRef:'fixture'}
    invalid.checkout.outTradeNo=`MXP${randomUUID().replaceAll('-','')}`
    await assert.rejects(pool.query('INSERT INTO pay.orders(id,app_id,environment,business_order_id,request_key,fingerprint,document) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [invalid.id,invalid.appId,invalid.environment,invalid.businessOrderId,randomUUID(),'invalid-test-only',invalid]),{code:'23514',constraint:'pay_alipay_order_identity'})
  })
  await t.test('invalid checkout titles fail before creating orders or reporting facts',async()=>{
    for(const subject of ['a/b','a=b','a&b','a\u0001b','a\u200bb']) {
      const input={...body(),subject}
      await assert.rejects(client.create(input,randomUUID()),{code:'invalid_payment_subject'})
      assert.equal((await pool.query('SELECT id FROM pay.orders WHERE business_order_id=$1',[input.businessOrderId])).rowCount,0)
    }
  })
  await t.test('reject malformed/forged callback; accept repeated success exactly once; no status regression',async()=>{
    const order=await create(),notice=paid(order,{subject:'套餐 + % & 中文'})
    assert.equal((await post({...notice,total_amount:'0.01'})).status,400)
    assert.equal((await post(new URLSearchParams(notice).toString()+'&total_amount=12.00')).status,400)
    assert.equal((await post(paid(order,{seller_id:'2088000000000099'}))).status,400)
    assert.deepEqual(await facts(order.id),{status:'pending',events:0,observations:0,reports:1})
    const results=await Promise.all(Array.from({length:6},()=>post(notice)))
    for(const result of results){assert.equal(result.status,200);assert.equal(await result.text(),'success')}
    assert.deepEqual(await facts(order.id),{status:'paid',events:1,observations:1,reports:2})
    await post(paid(order,{trade_no:notice.trade_no,trade_status:'TRADE_FINISHED'}))
    await post(paid(order,{trade_no:notice.trade_no,trade_status:'WAIT_BUYER_PAY'}))
    await post(paid(order,{trade_no:notice.trade_no,trade_status:'TRADE_CLOSED'}))
    assert.equal((await facts(order.id)).status,'paid');assert.equal((await facts(order.id)).events,1)
    await assert.rejects(client.checkout(order.id),{code:'payment_state_conflict'})
  })
  await t.test('amount, receipt, unmatched and duplicate trade anomalies are retained without credit',async()=>{
    for(const extra of [{total_amount:'13.00'},{receipt_amount:'11.00'},{gmt_payment:'2020-01-01 00:00:00'},{trade_status:'TRADE_CLOSED'}]) {
      const order=await create();assert.equal((await post(paid(order,extra))).status,200)
      assert.deepEqual(await facts(order.id),{status:'pending',events:0,observations:1,reports:1})
    }
    const unknown=paid({id:randomUUID()})
    assert.equal((await post(unknown)).status,200)
    assert.equal((await pool.query("SELECT id FROM pay.channel_observations WHERE order_id IS NULL AND reason='unmatched_order' AND document->>'outTradeNo'=$1",[unknown.out_trade_no])).rowCount,1)
    const a=await create(),b=await create(),receipt=paid(a).trade_no
    const pair=await Promise.all([post(paid(a,{trade_no:receipt})),post(paid(b,{trade_no:receipt}))])
    assert.ok(pair.every(r=>r.ok))
    assert.equal([await facts(a.id),await facts(b.id)].filter(f=>f.status==='paid').length,1)
    const reviews=await client.channelReviews();assert.ok(reviews.items.some(r=>r.reason==='receipt_used_by_another_order'))
    const other=await service.channelPayments.reviews({...principal,appId:'another-app'},new URLSearchParams());assert.equal(other.items.length,0)
    await assert.rejects(pool.query('UPDATE pay.channel_observations SET reason=reason'),/append-only/)
  })
  await t.test('deferred/unknown funding evidence cannot credit a wallet; subsequent ordinary receipt can recover',async()=>{
    for(const extra of [{additional_status:'SELLER_NOT_RECEIVED'},{additional_status:'NEW_UNKNOWN_STATE'},{credit_pay_mode:'creditAdvanceV2'}]) {
      const order=await create(),notice=paid(order,extra)
      assert.equal((await post(notice)).status,200)
      assert.deepEqual(await facts(order.id),{status:'pending',events:0,observations:1,reports:1})
      const review=(await client.channelReviews()).items.find(r=>r.paymentId===order.id)
      assert.equal(review.reason,'unsupported_channel_funding_state')
      assert.ok(review.document.additionalStatus||review.document.creditPayMode)
      assert.equal((await post(paid(order,{trade_no:notice.trade_no}))).status,200)
      assert.equal((await facts(order.id)).events,1)
    }
  })
  await t.test('outbox failure rolls back callback evidence, paid status and report; channel retry recovers',async()=>{
    const order=await create(),notice=paid(order),original=service.paidEvent.bind(service)
    service.paidEvent=async(client,order)=>{await original(client,order);throw Error('Injected failure after durable event statement')}
    assert.equal((await post(notice)).status,503)
    assert.deepEqual(await facts(order.id),{status:'pending',events:0,observations:0,reports:1})
    service.paidEvent=original
    assert.equal((await post(notice)).status,200)
    assert.deepEqual(await facts(order.id),{status:'paid',events:1,observations:1,reports:2})
    const recovered=new PaymentCenter(pool,{channels:configs});await recovered.channelPayments.bind()
    assert.equal((await recovered.order(principal,order.id)).status,'paid')
  })
  await t.test('manual and automatic Alipay cannot reuse the same seller receipt',async()=>{
    const live={...principal,environment:'live',scopes:[...principal.scopes,'settings.write']},c=configs[1]
    await service.configure(live,{expectedRevision:0,enabled:true,merchantAccountId:c.sellerId,payeeName:'Synthetic only',
      qrImage:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jIUkAAAAASUVORK5CYII=',instructions:'Fixture, no real payment'})
    const automatic=await service.create(live,{...body(),channelId:c.id},randomUUID()),notice=paid(automatic,{app_id:c.appId,seller_id:c.sellerId})
    let manual=await service.create(live,{businessOrderId:randomUUID(),customerRef:'tenant',amountMinor:1200},randomUUID())
    manual=await service.act(live,manual.id,'submit',{expectedRevision:0,payerName:'fixture',tradeNo:notice.trade_no},randomUUID())
    await service.act(live,manual.id,'confirm',{expectedRevision:1,tradeNo:notice.trade_no,receivedAmountMinor:1200,feeMinor:null,paidAt:new Date().toISOString(),note:'Synthetic receipt'},randomUUID())
    assert.equal((await service.channelPayments.notify(c.id,notice)).reason,'receipt_used_by_another_order')
    assert.equal((await service.order(live,automatic.id)).status,'pending')
  })
  await t.test('query timeout preserves pending; concurrent refresh throttled; query/notify convergence',async()=>{
    const order=await create(),adapter=service.channelPayments.adapter(cfg.id),original=adapter.query.bind(adapter)
    adapter.query=async()=>{throw Error('Injected upstream timeout')}
    await assert.rejects(client.refresh(order.id),{status:503})
    assert.equal((await client.order(order.id)).status,'pending')
    await assert.rejects(client.refresh(order.id),{code:'payment_channel_query_busy'})
    await pool.query("UPDATE pay.channel_queries SET available_at=now()-interval '1 second' WHERE order_id=$1",[order.id])
    adapter.query=async()=>paid(order,{out_trade_no:order.id})
    await assert.rejects(client.refresh(order.id),{code:'payment_channel_query_identity'})
    assert.deepEqual(await facts(order.id),{status:'pending',events:0,observations:0,reports:1})
    await pool.query("UPDATE pay.channel_queries SET available_at=now()-interval '1 second' WHERE order_id=$1",[order.id])
    const notice=paid(order);adapter.query=async()=>notice
    const [refresh,notification]=await Promise.all([client.refresh(order.id),post(notice)])
    assert.equal(refresh.order.status,'paid');assert.equal(notification.status,200)
    assert.equal((await facts(order.id)).events,1)
    adapter.query=original
  })
  await t.test('disabled channel still accepts pending receipts and queries, but cannot start checkout',async()=>{
    const order=await create(),adapter=service.channelPayments.adapter(cfg.id)
    adapter.config.enabled=false
    try {
      await assert.rejects(create(),{code:'payment_channel_disabled'})
      await assert.rejects(client.checkout(order.id),{code:'payment_channel_disabled'})
      assert.equal((await post(paid(order))).status,200)
      assert.equal((await client.order(order.id)).status,'paid')
    } finally {adapter.config.enabled=true}
  })
  await t.test('least-privilege runtime can bind, settle and query without editing evidence',async()=>{
    const role=`pay_channel_${randomUUID().replaceAll('-','')}`
    await admin.query(`CREATE ROLE ${role} LOGIN`)
    const runtimeUrl=new URL(url);runtimeUrl.username=role
    const runtimePool=new pg.Pool({connectionString:runtimeUrl.href,max:2})
    try {
      await migrate(url.href,{log(){}},{runtimeRole:role})
      const restricted=new PaymentCenter(runtimePool,{channels:configs});await restricted.channelPayments.bind()
      const order=await restricted.create(principal,body(),randomUUID()),notice=paid(order)
      restricted.channelPayments.adapter(cfg.id).query=async()=>notice
      assert.equal((await restricted.channelPayments.refresh(principal,order.id,{})).order.status,'paid')
      await assert.rejects(runtimePool.query('UPDATE pay.channel_observations SET reason=reason'),{code:'42501'})
      await assert.rejects(runtimePool.query('DELETE FROM pay.channel_bindings'),{code:'42501'})
    } finally {await runtimePool.end();await pool.query(`DROP OWNED BY ${role}`);await admin.query(`DROP ROLE ${role}`)}
  })
  await t.test('independent reporting database consumes Alipay without leaking checkout or buyer data',async()=>{
    const reportName=`pay_channel_report_${randomUUID().replaceAll('-','')}`
    await admin.query(`CREATE DATABASE ${reportName}`)
    const reportUrl=new URL(url);reportUrl.pathname=`/${reportName}`
    const reportPool=new pg.Pool({connectionString:reportUrl.href,max:2})
    try {
      await runMigrations({connectionString:reportUrl.href,migrationsDir:reportingMigrationsDir,logger:{log(){}}})
      const store=new PaymentReportingStore(reportPool),source={id:'channel-source',appId:principal.appId,environment:'test',baseUrl:origin,token}
      await store.sync(source);await store.sync(source)
      const result=await store.orders(source.id)
      assert.ok(result.items.some(o=>o.provider==='alipay'&&o.status==='paid'))
      assert.doesNotMatch(JSON.stringify(result),/payUrl|subject|checkout|tradeNo|alipayPublicKey|privateKey/)
      assert.ok(result.items.filter(o=>o.status==='paid').every(o=>o.feeMinor===null))
    } finally {await reportPool.end();await admin.query(`DROP DATABASE ${reportName} WITH (FORCE)`)}
  })
  await t.test('callback COMMIT response loss returns retryable failure and replay preserves one credit event',async()=>{
    const order=await create(),notice=paid(order)
    let armed=true
    const faultPool={query:pool.query.bind(pool),async connect(){const db=await pool.connect();return {release:()=>db.release(),async query(sql,args){
      const result=await db.query(sql,args)
      if(armed&&sql==='COMMIT'){armed=false;throw Object.assign(Error('Injected COMMIT response loss'),{code:'ECONNRESET'})}
      return result
    }}}}
    const original=service.channelPayments
    service.channelPayments=new PaymentCenter(faultPool,{channels:configs}).channelPayments
    try {assert.equal((await post(notice)).status,503)} finally {service.channelPayments=original}
    assert.equal((await client.order(order.id)).status,'paid')
    const replay=await post(notice);assert.equal(await replay.text(),'success')
    assert.deepEqual(await facts(order.id),{status:'paid',events:1,observations:1,reports:2})
  })
})
