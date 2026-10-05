import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,statSync,rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {generateKeyPairSync} from 'node:crypto'
import {spawnSync} from 'node:child_process'
import {validateConsoleAccess} from '../server/console-config.mjs'

test('Luopan import converts keys privately, preserves other drafts and repeats without overwriting',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pay-import-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const pair=generateKeyPairSync('rsa',{modulusLength:2048}),priv=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64'),pub=pair.publicKey.export({format:'der',type:'spki'}).toString('base64')
 const source=join(dir,'application.yml'),output=join(dir,'private/drafts.json')
 writeFileSync(source,`alipay:\n  app-id: \${ALIPAY_APP_ID:2026000000000001}\n  merchant-private-key: \${ALIPAY_MERCHANT_PRIVATE_KEY:${priv}}\n  public-key: \${ALIPAY_PUBLIC_KEY:${pub}}\n  seller-id: \${ALIPAY_SELLER_ID:}\n`)
 mkdirSync(join(dir,'private'));writeFileSync(output,'[]',{mode:0o600})
 const run=()=>spawnSync(process.execPath,[new URL('../scripts/import-luopan-alipay.mjs',import.meta.url).pathname,'--source',source,'--output',output],{encoding:'utf8'})
 let result=run();assert.equal(result.status,0,result.stderr)
 const entries=JSON.parse(readFileSync(output,'utf8'));assert.equal(entries[0].enabled,false);assert.equal(entries[0].sellerId,'');assert.match(entries[0].privateKey,/BEGIN PRIVATE KEY/)
 assert.equal(statSync(output).mode & 0o777,0o600);assert.ok(!result.stdout.includes(priv))
 entries[0].sellerId='2088000000000001';writeFileSync(output,JSON.stringify(entries));result=run();assert.equal(result.status,0,result.stderr)
 assert.equal(JSON.parse(readFileSync(output))[0].sellerId,'2088000000000001')
 assert.equal(validateConsoleAccess([{issuer:'https://auth.example/identity',subject:'root-id',clientId:'pay',role:'administrator',scope:'center'}])[0].role,'administrator')
})

test('root bootstrap binds exact registered identity once and rejects the username shortcut',t=>{
 const dir=mkdtempSync(join(tmpdir(),'pay-admin-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const profile=join(dir,'profile.json'),access=join(dir,'access.json')
 writeFileSync(profile,JSON.stringify({version:1,appId:'mx-pay',origin:'https://pay.example.test',issuer:'https://auth.example.test/identity',clientId:'mx-pay-web',clientSecret:'fixture-client-secret',audience:'mx-pay',scope:'openid mx:identity',sessionKey:'s'.repeat(43)}),{mode:0o600})
 const run=subject=>spawnSync(process.execPath,[new URL('../scripts/bootstrap-admin.mjs',import.meta.url).pathname,'--subject',subject,'--profile',profile,'--access',access],{encoding:'utf8'})
 assert.notEqual(run('root').status,0)
 for(let i=0;i<2;i++){const result=run('root-actual-id');assert.equal(result.status,0,result.stderr);assert.doesNotMatch(result.stdout,/fixture-client-secret/)}
 const entries=JSON.parse(readFileSync(access));assert.equal(entries.length,1);assert.equal(entries[0].subject,'root-actual-id');assert.equal(entries[0].role,'administrator');assert.equal(statSync(access).mode & 0o777,0o600)
})
