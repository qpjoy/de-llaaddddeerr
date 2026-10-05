import test from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { channelValidationIssues, validateChannels } from '../server/channel-config.mjs'
import { consoleAssets } from '../server/console-assets.mjs'

const pair=generateKeyPairSync('rsa',{modulusLength:2048})
const valid={id:'alipay-live',provider:'alipay',environment:'live',enabled:true,appId:'2026000000000001',sellerId:'2088000000000001',allowedApps:['mx-insight-hub'],keyType:'PKCS8',
 privateKey:pair.privateKey.export({format:'pem',type:'pkcs8'}).toString(),alipayPublicKey:pair.publicKey.export({format:'pem',type:'spki'}).toString(),
 notifyUrl:'https://pay.example/v1/notifications/alipay/alipay-live',returnUrl:'https://hub.example/admin/'}

test('enabled channel drafts report exact blockers without weakening publication or exposing keys',()=>{
 assert.deepEqual(channelValidationIssues(valid),[])
 for(const [field,value] of [['id','bad/id'],['provider','other'],['environment','production'],['enabled','true'],['appId',''],['sellerId',''],['allowedApps',[]],['keyType','other'],
  ['privateKey','private-secret-not-a-key'],['alipayPublicKey','public-secret-not-a-key'],['notifyUrl','https://pay.example/v1/notifications/alipay/'],['returnUrl','http://hub.example/']]){
  const config={...valid,[field]:value},issues=channelValidationIssues(config)
  assert.ok(issues.some(issue=>issue.field===field),field)
  assert.throws(()=>validateChannels([config]),/values hidden/)
  assert.doesNotMatch(JSON.stringify(issues),/secret-not-a-key|BEGIN|2026000000000001|2088000000000001/)
 }
 const incomplete={...valid,appId:'',sellerId:'',privateKey:'',alipayPublicKey:'',notifyUrl:'https://pay.example/v1/notifications/alipay/'}
 assert.deepEqual(channelValidationIssues(incomplete).map(i=>i.field),['appId','sellerId','privateKey','alipayPublicKey','notifyUrl'])
 const raw=valid.privateKey.split('\n').slice(1,-2).join('')
 assert.ok(channelValidationIssues({...valid,privateKey:raw}).some(i=>i.field==='privateKey'))
 const weak=generateKeyPairSync('rsa',{modulusLength:1024})
 assert.throws(()=>validateChannels([{...valid,privateKey:weak.privateKey.export({format:'pem',type:'pkcs8'}).toString()}]))
 assert.throws(()=>validateChannels([valid,{...valid,id:'other',notifyUrl:'https://pay.example/v1/notifications/alipay/other'}]))
 assert.throws(()=>validateChannels([{...valid,unrecognized:'value'}]))
 const pkcs1={...valid,keyType:'PKCS1',privateKey:pair.privateKey.export({format:'pem',type:'pkcs1'}).toString()}
 assert.deepEqual(validateChannels([pkcs1]),[pkcs1])
})

test('Pay serves canonical design components through existing gateway asset paths',()=>{
 assert.deepEqual([...consoleAssets.keys()],['/','/console.js','/console.css'])
 const css=consoleAssets.get('/console.css')[1],js=consoleAssets.get('/console.js')[1]
 assert.match(css,/--qp-primary: #2bf6d2/)
 assert.match(css,/\.qp-select-popup/)
 assert.doesNotMatch(css,/@import/)
 assert.match(js,/export function installNeonSelects/)
 assert.match(consoleAssets.get('/')[1],/qp-modal__footer/)
})
