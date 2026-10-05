import test from 'node:test'
import assert from 'node:assert/strict'
import pg from 'pg'
import { randomBytes, randomUUID, createHash, generateKeyPairSync } from 'node:crypto'
import { createServer } from 'node:http'
import { PaymentManagement } from '../server/management.mjs'
import { PaymentCenter } from '../server/service.mjs'
import { createPaymentConsole } from '../server/console.mjs'
import { createApp } from '../server/app.mjs'
import { migrate } from '../server/migrate.mjs'
const url=process.env.MX_PAY_TEST_DATABASE_URL
const adminGrant={role:'administrator',scope:'center'}
const user=subject=>({issuer:'https://auth.example/identity',clientId:'mx-pay-web',subject,displayName:subject})
const root=user('root-immutable-id'), viewer=user('viewer-id')
const query=(values={})=>new URLSearchParams(values)

test('management encrypts channels, scopes roles, consumes invitations and retains revocations on deploy', {skip:!url,timeout:60000}, async t=>{
 const adminPool=new pg.Pool({connectionString:url}),db=`pay_control_${randomUUID().replaceAll('-','')}`
 await adminPool.query(`CREATE DATABASE ${db}`)
 const target=new URL(url);target.pathname=`/${db}`
 await migrate(target.href,{log(){}})
 const pool=new pg.Pool({connectionString:target.href}),readPool=new pg.Pool({connectionString:target.href,options:'-c default_transaction_read_only=on'}),key=randomBytes(32),management=new PaymentManagement(pool,key,{readPool}),service=new PaymentCenter(pool),servers=[]
 t.after(async()=>{for(const s of servers)await new Promise(r=>{s.close(r);s.closeAllConnections()});await readPool.end();await pool.end();await adminPool.query(`DROP DATABASE ${db} WITH (FORCE)`);await adminPool.end()})
 const secret=randomBytes(32).toString('base64url'),credential={id:'hub-test',appId:'hub',environment:'test',scopes:['orders.read','orders.write','events.read','events.ack'],hash:createHash('sha256').update(secret).digest()}
 const access={issuer:root.issuer,subject:root.subject,clientId:root.clientId,...adminGrant}
 await management.bootstrap({access:[access],credentials:[credential]})
 const p=await management.principal(root)
 assert.deepEqual(p.grants,[adminGrant]);assert.deepEqual((await management.principal(user('root'))).grants,[])
 const delegatedIdentity={...user('delegated'),mxIdentity:{subject:'user:delegated',audience:'mx-pay',principal:{kind:'user',userId:'delegated',scopes:['mx:pay:admin']}}}
 const settings={issuer:root.issuer,clientId:root.clientId,audience:'mx-pay'}
 const central=await management.ssoPrincipal(delegatedIdentity,settings)
 assert.deepEqual(central.grants,[adminGrant]);assert.deepEqual(central.localGrants,[])
 assert.deepEqual((await management.principal(JSON.parse(JSON.stringify(central)))).grants,[],'serialized grants have no trusted provenance')
 assert.deepEqual((await management.ssoPrincipal({...delegatedIdentity,clientId:'other'},settings)).grants,[])
 assert.deepEqual((await management.ssoPrincipal({...delegatedIdentity,mxIdentity:{...delegatedIdentity.mxIdentity,audience:'hub'}},settings)).grants,[])

 await assert.rejects(new PaymentManagement(pool,randomBytes(32)).bootstrap(),{code:'payment_control_key_changed'})
 const route=(path,method='GET',body,actor=p,q=query())=>management.route(actor,method,path,q,body)
 await route('members','POST',{subject:viewer.subject,grants:[{role:'viewer',scope:'application',appId:'hub',environment:'test'}]})
 const vp=await management.principal(viewer)
 for(const path of ['channels','audit','finance']) await assert.rejects(route(path,'GET',{},vp),{status:403})
 await assert.rejects(route('members','POST',{subject:'bad',grants:[adminGrant]},vp),{status:403})
 const order=await service.create(credential,{businessOrderId:'business-1',customerRef:'customer-1',amountMinor:1200},randomUUID())
 const hidden=await service.create({...credential,appId:'other'},{businessOrderId:'hidden',customerRef:'secret-other-user',amountMinor:99900},randomUUID())
 assert.equal((await route('orders','GET',{},vp)).items.length,1)
 assert.equal((await route('orders','GET',{},vp,query({appId:'other'}))).items.length,0)
 assert.equal((await route('customers','GET',{},vp)).items[0].customerRef,'customer-1')
 await assert.rejects(route(`orders/${hidden.id}`,'GET',{},vp),{status:404})
 assert.equal((await route(`orders/${order.id}`,'GET',{},vp)).audits.length,1)
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),alipay=generateKeyPairSync('rsa',{modulusLength:2048})
 const channel={id:'alipay-test',provider:'alipay',environment:'test',enabled:false,appId:'2026000000000001',sellerId:'',allowedApps:['hub'],keyType:'PKCS8',privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),alipayPublicKey:alipay.publicKey.export({format:'pem',type:'spki'}).toString(),notifyUrl:'https://pay.example/v1/notifications/alipay/alipay-test',returnUrl:'https://hub.example/admin/'}
 let ch=await route('channels/alipay-test','PUT',{revision:0,channel})
 assert.equal(ch.valid,false);assert.equal(ch.privateKeyConfigured,true);assert.equal(ch.privateKey,undefined)
 assert.deepEqual(ch.validationIssues.map(i=>i.field),['sellerId'])
 await assert.rejects(route('channels/alipay-test/publish','POST',{revision:ch.revision}),{code:'invalid_payment_channel'})
 ch=await route('channels/alipay-test','PUT',{revision:ch.revision,channel:{...channel,enabled:true,notifyUrl:'https://pay.example/v1/notifications/alipay/'}})
 assert.equal(ch.enabled,true);assert.equal(ch.published,false);assert.equal(ch.valid,false,'enabling a draft does not bypass validation')
 assert.deepEqual(ch.validationIssues.map(i=>i.field),['sellerId','notifyUrl'])
 ch=await route('channels/alipay-test','PUT',{revision:ch.revision,channel:{...channel,sellerId:'2088000000000001',privateKey:'',alipayPublicKey:'',enabled:true}})
 assert.equal(ch.valid,true)
 ch=await route('channels/alipay-test/publish','POST',{revision:ch.revision})
 assert.equal(ch.publishedEnabled,true)
 assert.deepEqual(ch.validationIssues,[]);assert.equal(ch.pendingChanges,false)
 await management.syncChannels(service);assert.equal(service.channelPayments.available(credential)[0].enabled,true)
 service.channelPayments.queriesInFlight=3
 await management.syncChannels(service,true);assert.equal(service.channelPayments.available(credential)[0].enabled,false)
 assert.equal(service.channelPayments.queriesInFlight,3,'configuration reload preserves the query concurrency budget');service.channelPayments.queriesInFlight=0
 await management.syncChannels(service,false)
 assert.ok(!JSON.stringify((await pool.query('SELECT draft,published FROM pay_control.channels')).rows).includes('PRIVATE KEY'))
 assert.ok(!JSON.stringify(await route('channels')).includes(channel.privateKey))
 await assert.rejects(route('channels/alipay-test','PUT',{revision:0,channel}),{code:'payment_revision_conflict'})
 ch=await route('channels/alipay-test','PUT',{revision:ch.revision,channel:{...channel,sellerId:'2088000000000002'}})
 assert.equal(ch.valid,false);assert.ok(ch.validationIssues.some(i=>i.field==='sellerId'))
 await assert.rejects(route('channels/alipay-test/publish','POST',{revision:ch.revision}),{code:'payment_channel_identity_changed'})
 assert.equal(service.channelPayments.available(credential)[0].enabled,true)
 await management.bootstrap({drafts:[channel]});assert.equal((await route('channels')).items[0].sellerId,'2088000000000002')
 const duplicate={...channel,id:'alipay-duplicate',sellerId:'2088000000000001',notifyUrl:'https://pay.example/v1/notifications/alipay/alipay-duplicate'}
 const duplicateView=await route('channels/alipay-duplicate','PUT',{revision:0,channel:duplicate})
 assert.equal(duplicateView.valid,false);assert.ok(duplicateView.validationIssues.some(i=>i.field==='appId'))
 await assert.rejects(route('channels/alipay-duplicate/publish','POST',{revision:duplicateView.revision}),{code:'invalid_payment_channel'})
 assert.equal((await route('channels')).items.find(i=>i.id==='alipay-duplicate').valid,false)
 const inv=await route('invitations','POST',{grants:[{role:'finance_viewer',scope:'application',appId:'hub',environment:'live'}]})
 await assert.rejects(route('invitations','POST',{grants:[adminGrant]}),{code:'invalid_invitation_role'})
 const invitee=await management.principal(user('invited'))
 assert.deepEqual(invitee.grants,[])
 const centralInvite=await route('invitations','POST',{grants:[{role:'auditor',scope:'center'}]})
 await route('invitations/accept','POST',{token:centralInvite.token},central)
 assert.deepEqual((await management.principal(user('delegated'))).grants,[{role:'auditor',scope:'center'}],'invitation never turns delegated administrator into a permanent local grant')
 await route('invitations/accept','POST',{token:inv.token},invitee)
 await route('invitations/accept','POST',{token:inv.token},invitee)
 await assert.rejects(route('invitations/accept','POST',{token:inv.token},vp),{code:'invalid_payment_invitation'})
 assert.equal((await management.principal(user('invited'))).grants.length,1)
 const expired=await route('invitations','POST',{grants:[{role:'viewer',scope:'application',appId:'hub',environment:'test'}]})
 await route(`invitations/${expired.id}/revoke`,'POST',{})
 await assert.rejects(route('invitations/accept','POST',{token:expired.token},vp),{code:'invalid_payment_invitation'})
 await assert.rejects(route(`members/${p.id}`,'PUT',{revision:p.revision,grants:[]}),{code:'payment_last_administrator'})
 await route(`members/${vp.id}`,'PUT',{revision:vp.revision,grants:[]})
 assert.deepEqual((await management.principal(viewer)).grants,[])
 await assert.rejects(route('members','POST',{subject:'another',grants:[adminGrant]},vp),{status:403})
 await route('applications','POST',{id:'hub',name:'Hub'})
 const generated=await route('credentials','POST',{appId:'hub',environment:'test',purpose:'payments'})
 assert.equal((await management.authenticate(`Bearer ${generated.secret}`)).appId,'hub')
 assert.ok(!JSON.stringify(await route('applications')).includes(generated.secret))
 await route(`credentials/${generated.id}/revoke`,'POST',{})
 await assert.rejects(management.authenticate(`Bearer ${generated.secret}`),{status:401})
 await route('credentials/hub-test/revoke','POST',{})
 await management.bootstrap({credentials:[credential],access:[access]})
 await assert.rejects(management.authenticate(`Bearer ${secret}`),{status:401})
 await route('applications','POST',{id:'mx-launcher',name:'Launcher'})
 const permissions=await route('credentials','POST',{appId:'mx-launcher',environment:'live',purpose:'launcher-permissions'})
 const api=createServer(createApp({service,credentials:[],management,logger:{error(){}}}));servers.push(api);await new Promise(r=>api.listen(0,'127.0.0.1',r))
 const origin=`http://127.0.0.1:${api.address().port}`
 assert.equal((await fetch(origin+'/v1/permissions/catalog',{headers:{authorization:`Bearer ${permissions.secret}`}})).status,200)
 assert.equal((await fetch(origin+'/v1/orders',{headers:{authorization:`Bearer ${permissions.secret}`}})).status,403)
 let actor=p
 const consoleServer=createServer(createPaymentConsole({settings:{origin:'https://pay.example'},sessionPool:pool,service,management,sso:{handle:async()=>false,principal:async()=>actor},logger:{error(){}}}))
 servers.push(consoleServer);await new Promise(r=>consoleServer.listen(0,'127.0.0.1',r))
 const base=`http://127.0.0.1:${consoleServer.address().port}`
 assert.equal((await fetch(base+'/console/v1/channels')).status,200)
 actor=vp;assert.equal((await fetch(base+'/console/v1/orders')).status,403)
 actor=null;assert.equal((await fetch(base+'/console/v1/me',{headers:{authorization:`Bearer ${permissions.secret}`}})).status,401)
 const audit=JSON.stringify(await route('audit'))
 assert.doesNotMatch(audit,/PRIVATE KEY|BEGIN PUBLIC KEY|token_hash/)
 assert.ok(!audit.includes(generated.secret) && !audit.includes(inv.token))
 await assert.rejects(pool.query('UPDATE pay_control.audit SET action=action'),/append-only/)
 await route('members','POST',{subject:'second-admin',grants:[adminGrant]})
 await route(`members/${p.id}`,'PUT',{revision:p.revision,grants:[]})
 await management.bootstrap({access:[{role:access.role,scope:access.scope,clientId:access.clientId,subject:access.subject,issuer:access.issuer}]})
 assert.deepEqual((await management.principal(root)).grants,[],'JSON field ordering cannot resurrect a revoked bootstrap grant')
})
