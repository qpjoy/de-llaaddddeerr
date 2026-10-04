import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, statSync, chmodSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareConsole } from '../scripts/runtime.mjs'

const profile={version:1,appId:'mx-pay',origin:'https://pay.example.test',issuer:'https://auth.example.test/identity',
  clientId:'mx-pay-web',clientSecret:'original-client-secret',audience:'mx-pay',scope:'openid mx:identity',sessionKey:'s'.repeat(43)}
const grant={issuer:profile.issuer,subject:'original-user',clientId:profile.clientId,appId:'mx-insight-hub',environment:'test',role:'viewer'}
function fixture(t) {
  const root=mkdtempSync(join(tmpdir(),'mx-pay-console-bootstrap-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const env={MX_PAY_SSO_SOURCE:join(root,'secrets/console/profile.json'),MX_PAY_CONSOLE_ACCESS_SOURCE:join(root,'secrets/console/access.json'),
    MX_PAY_LAUNCHER_IDENTITY_DIR:join(root,'launcher-identity')}
  const write=(file,value)=>{mkdirSync(join(file,'..'),{recursive:true,mode:0o700});writeFileSync(file,JSON.stringify(value),{mode:0o600});return file}
  const register=(entry='public',value=profile)=>write(join(env.MX_PAY_LAUNCHER_IDENTITY_DIR,'applications',entry,'mx-pay.json'),value)
  const logs=[]
  return {root,env,write,register,logs,prepare:options=>prepareConsole(root,{env,log:line=>logs.push(line),...options})}
}

for (const entry of ['public','private']) test(`first ${entry} registration imports original keys and initializes private empty access exactly once`,t=>{
  const f=fixture(t), source=f.register(entry), original=readFileSync(source,'utf8')
  f.prepare()
  assert.deepEqual(JSON.parse(readFileSync(f.env.MX_PAY_SSO_SOURCE)),profile)
  assert.deepEqual(JSON.parse(readFileSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE)),[])
  assert.equal(statSync(f.env.MX_PAY_SSO_SOURCE).mode & 0o777,0o600)
  assert.equal(statSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE).mode & 0o777,0o600)
  assert.equal(statSync(join(f.root,'secrets/console')).mode & 0o777,0o700)
  assert.equal(readFileSync(source,'utf8'),original,'Launcher remains read-only')
  f.write(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE,[grant])
  const saved=readFileSync(f.env.MX_PAY_SSO_SOURCE,'utf8')
  f.register(entry,{...profile,clientSecret:'changed-launcher-secret',sessionKey:'n'.repeat(43)})
  f.prepare()
  assert.equal(readFileSync(f.env.MX_PAY_SSO_SOURCE,'utf8'),saved)
  assert.deepEqual(JSON.parse(readFileSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE)),[grant])
  assert.doesNotMatch(f.logs.join('\n'),/original-client-secret|changed-launcher-secret|ssssssss/)
})

test('without SSO deploy stays API-only; a later registration is discovered on the next deploy',t=>{
  const f=fixture(t)
  f.prepare();f.prepare()
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
  assert.equal(existsSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE),false)
  assert.equal(existsSync(join(f.root,'.deploy/console-enrolled.json')),false)
  assert.match(f.logs.join('\n'),/payment API only/)
  f.register();f.prepare()
  assert.deepEqual(JSON.parse(readFileSync(f.env.MX_PAY_SSO_SOURCE)),profile)
})

test('an explicit profile may arrive later; deploy stays API-only instead of adopting another source',t=>{
  const f=fixture(t)
  f.register();f.register('private')
  f.env.MX_PAY_SSO_SOURCE_EXPLICIT='1'
  f.prepare()
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
  assert.equal(existsSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE),false)
  const custom={...profile,origin:'https://custom.example.test',clientSecret:'custom-original-secret'}
  f.write(f.env.MX_PAY_SSO_SOURCE,custom)
  f.prepare()
  assert.deepEqual(JSON.parse(readFileSync(f.env.MX_PAY_SSO_SOURCE)),custom)
})

test('ambiguous registrations stop without selecting an entry, while explicit API-only discovery remains available',t=>{
  const f=fixture(t);f.register();f.register('private')
  assert.throws(()=>f.prepare(),/Multiple Launcher mx-pay profiles/)
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
  f.env.MX_PAY_SSO_AUTO_DISCOVER='0';f.prepare()
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
})

test('wrong application, missing session key, invalid JSON and unsafe source files cannot bootstrap the console',async t=>{
  for (const failure of ['application','session','json','permissions','symlink']) await t.test(failure,t=>{
    const f=fixture(t), source=f.register()
    if(failure==='application')f.register('public',{...profile,appId:'mx-insight-hub'})
    if(failure==='session')f.register('public',{...profile,sessionKey:undefined})
    if(failure==='json')writeFileSync(source,'invalid-json')
    if(failure==='permissions')chmodSync(source,0o644)
    if(failure==='symlink'){rmSync(source);symlinkSync(f.write(join(f.root,'linked.json'),profile),source)}
    assert.throws(()=>f.prepare())
    assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
    assert.equal(existsSync(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE),false)
  })
})

test('loss of an enrolled profile or access requires recovery, never another identity or empty grants',async t=>{
  for (const field of ['MX_PAY_SSO_SOURCE','MX_PAY_CONSOLE_ACCESS_SOURCE']) await t.test(field,t=>{
    const f=fixture(t);f.register();f.prepare()
    f.write(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE,[grant])
    rmSync(f.env[field]);f.register('public',{...profile,sessionKey:'n'.repeat(43)})
    assert.throws(()=>f.prepare(),/Previously configured payment console/)
    assert.equal(existsSync(f.env[field]),false)
  })
})

test('pre-existing access must match the discovered provider before any profile is imported',t=>{
  const f=fixture(t);f.register()
  f.write(f.env.MX_PAY_CONSOLE_ACCESS_SOURCE,[{...grant,issuer:'https://other.example.test/identity'}])
  assert.throws(()=>f.prepare(),/does not match/)
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
})
