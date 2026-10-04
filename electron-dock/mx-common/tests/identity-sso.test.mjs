import test from 'node:test'
import assert from 'node:assert/strict'
import { createCipheriv, randomBytes, createHash } from 'node:crypto'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplicationSso } from '../src/identity/sso.mjs'
import { PostgresSsoStore } from '../src/identity/postgres-store.mjs'
import { readApplicationSsoProfile, validateApplicationSsoSettings } from '../src/identity/profile.mjs'

const settings = { appId:'mx-example', origin:'https://app.example.test', issuer:'https://auth.example.test/identity',
  clientId:'example-web', clientSecret:'server-only', audience:'mx-example', sessionKey:randomBytes(32).toString('base64url') }

test('application profiles pin callback/origin, require private persistent keys and do not require Hub legacy fields', t => {
  const dir=mkdtempSync(join(tmpdir(),'sso-profile-')), file=join(dir,'profile.json')
  t.after(()=>rmSync(dir,{recursive:true,force:true}))
  writeFileSync(file,JSON.stringify(settings),{mode:0o600})
  assert.deepEqual(readApplicationSsoProfile(file),settings)
  assert.equal(readApplicationSsoProfile(),null)
  for (const invalid of [{origin:'http://app.test'},{origin:'https://app.test/admin/'},{issuer:'https://secret@auth.test/identity'},
    {callbackUrl:'https://evil.test/callback'},{interactionUrl:'https://evil.test/interaction'},{scope:'openid admin'},
    {previousProviders:[{issuer:settings.issuer,clientId:'old',clientSecret:'old'}]}]) {
    assert.throws(()=>validateApplicationSsoSettings({...settings,...invalid}))
  }
  writeFileSync(file,JSON.stringify({...settings,sessionKey:undefined}))
  assert.throws(()=>readApplicationSsoProfile(file),/persistent/)
  chmodSync(file,0o644); assert.throws(()=>readApplicationSsoProfile(file),/private/)
})

test('new store decrypts pre-refactor Hub ciphertext and rejects tampering, wrong keys and record relocation', () => {
  const id=randomBytes(32).toString('base64url'), hash=createHash('sha256').update(id).digest('hex')
  const value={subject:'original-user',accessToken:'old-token',csrf:'old-csrf'}
  // Independent fixture in the original Hub format, not produced by the new store.
  const iv=randomBytes(12), cipher=createCipheriv('aes-256-gcm',Buffer.from(settings.sessionKey,'base64url'),iv)
  cipher.setAAD(Buffer.from(`session:${hash}`))
  const encrypted=Buffer.concat([cipher.update(JSON.stringify(value)),cipher.final()])
  const bytes=Buffer.concat([iv,cipher.getAuthTag(),encrypted]), encoded=bytes.toString('base64url')
  const store=new PostgresSsoStore({},settings.sessionKey,{table:'iam.browser_sso_records'})
  assert.deepEqual(store.open('session',hash,encoded),value)
  assert.throws(()=>store.open('login',hash,encoded))
  assert.throws(()=>store.open('session','another-record',encoded))
  assert.throws(()=>new PostgresSsoStore({},randomBytes(32).toString('base64url')).open('session',hash,encoded))
  bytes[bytes.length-1]^=1; assert.throws(()=>store.open('session',hash,bytes.toString('base64url')))
  assert.throws(()=>new PostgresSsoStore({},settings.sessionKey,{table:'app_auth.records; DROP TABLE records'}))
})

test('consumer supplies durable storage; only local UI mounts and distinct host cookies are accepted', () => {
  assert.equal(createApplicationSso({settings:null}),null)
  assert.throws(()=>createApplicationSso({settings}),/store/)
  const store=Object.fromEntries(['get','put','remove','update'].map(key=>[key,async()=>null]))
  assert.throws(()=>createApplicationSso({settings,store,cookieNames:{login:'__Host-same',session:'__Host-same'}}))
  for (const path of ['//evil.test/','/../','https://evil.test/','/admin/?next=evil'])
    assert.throws(()=>createApplicationSso({settings,store,navigation:{mounts:[path]}}))
  assert.ok(createApplicationSso({settings,store,navigation:{mounts:['/','/console/']}}))
})
