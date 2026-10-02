import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { render } from '../scripts/render.mjs'

const image = `registry.example.test/mx-pay@sha256:${'a'.repeat(64)}`
function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(),'mx-pay-deploy-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['scripts','server','src','deploy']) cpSync(new URL(`../${dir}/`,import.meta.url),join(root,dir),{ recursive: true })
  mkdirSync(join(root,'secrets')); mkdirSync(join(root,'bin'))
  writeFileSync(join(root,'secrets/runtime.env'),'MX_PAY_DATABASE_URL=postgresql://payment:private@db.example.test/mx_pay\n')
  writeFileSync(join(root,'secrets/credentials.json'),JSON.stringify([{ id:'test-app',appId:'demo',environment:'test',secret:'test-only-secret-'.repeat(3),scopes:['orders.read','orders.write'] }]))
  writeFileSync(join(root,'bin/kubectl'), `#!${process.execPath}
const fs=require('fs'); const a=process.argv.slice(2), s=a.join(' '), log={args:a};
const fi=a.indexOf('-f'); if(fi>=0 && a[fi+1]!=='-') log.document=JSON.parse(fs.readFileSync(a[fi+1],'utf8'));
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify(log)+'\\n');
if(s.includes('get nodes')) console.log(JSON.stringify({items:Array.from({length:Number(process.env.MOCK_WORKERS||2)},(_,i)=>({metadata:{labels:{}},spec:{},status:{conditions:[{type:'Ready',status:'True'}]}}))}));
else if(s.includes('create namespace')) console.log('{}');
else if(s.includes('create configmap mx-pay-deploy-lock')) {if(process.env.MOCK_LOCKED)process.exit(1);console.log('lock-uid-123');}
else if(s.includes('get configmap mx-pay-installation') && process.env.MOCK_DB_DRIFT) console.log(JSON.stringify({data:{databaseIdentity:'different'}}));
else if(s.includes('wait --for=condition=complete') && process.env.MOCK_MIGRATE_FAIL) process.exit(1);
else if(s.includes('delete job') && process.env.MOCK_TERMINATE_FAIL) process.exit(1);
else if(s.includes('rollout status') && process.env.MOCK_ROLLOUT_FAIL) process.exit(1);
`,{ mode: 0o755 })
  writeFileSync(join(root,'bin/docker'),`#!${process.execPath}
const fs=require('fs'), a=process.argv.slice(2), s=a.join(' ');
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args:a})+'\\n');
if(s==='context show')console.log('test-compose');
if(s.includes('run --rm --no-deps -T migrate') && process.env.MOCK_MIGRATE_FAIL)process.exit(1);
`,{ mode: 0o755 })
  const env = { ...process.env, PATH:`${join(root,'bin')}:${process.env.PATH}`, MOCK_LOG:join(root,'calls'), MX_PAY_DEPLOY_DRIVER:'k8s', MX_PAY_KUBE_CONTEXT:'test-cluster', MX_PAY_NAMESPACE:'mx-pay-test', MX_PAY_REPLICAS:'2', MX_PAY_MIN_READY_WORKERS:'2', MX_PAY_BUILD:'0', MX_PAY_IMAGE:image,
    MX_PAY_RUNTIME_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_MIGRATION_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_CREDENTIALS_SOURCE:join(root,'secrets/credentials.json'), ...overrides }
  return { root, env, run: action => spawnSync('bash',[join(root,'scripts/manage.sh'),action],{env,encoding:'utf8',timeout:15000}), calls: () => readFileSync(env.MOCK_LOG,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
}
test('one-command deploy migrates before rollout, repeats safely and releases only its lock UID',t => {
  const f=fixture(t)
  for(let i=0;i<2;i++) { const r=f.run('deploy');assert.equal(r.status,0,r.stderr) }
  const calls=f.calls(), create=calls.findIndex(c=>c.document?.kind==='Job'), rollout=calls.findIndex(c=>c.document?.items?.some(i=>i.kind==='Deployment'))
  assert.ok(create>=0 && rollout>create)
  assert.ok(calls.slice(create,rollout).some(c=>c.args.includes('--for=condition=complete')))
  assert.equal(calls.filter(c=>c.document?.kind==='Job').length,2)
  assert.equal(new Set(calls.filter(c=>c.document?.kind==='Job').map(c=>c.document.metadata.name)).size,2)
  assert.equal(calls.filter(c=>c.document?.kind==='DeleteOptions').length,2)
  for(const c of calls.filter(c=>c.document?.kind==='DeleteOptions'))assert.equal(c.document.preconditions.uid,'lock-uid-123')
  assert.doesNotMatch(JSON.stringify(calls),/mx-launcher|mx-insight-hub|delete.*pvc|cluster-admin/)
  assert.equal(JSON.parse(readFileSync(join(f.root,'.deploy/last-result.json'))).phase,'complete')
})
test('migration failure never applies API, terminates migration before unlocking',t=>{
  const f=fixture(t,{MOCK_MIGRATE_FAIL:'1'}),r=f.run('deploy');assert.notEqual(r.status,0)
  const calls=f.calls();assert.ok(!calls.some(c=>c.document?.items?.some(i=>i.kind==='Deployment')))
  const stop=calls.findIndex(c=>c.args.includes('delete')&&c.args.includes('job')),unlock=calls.findIndex(c=>c.document?.kind==='DeleteOptions')
  assert.ok(stop>=0 && unlock>stop)
})
test('unconfirmed migration termination retains the deployment lock',t=>{
  const f=fixture(t,{MOCK_MIGRATE_FAIL:'1',MOCK_TERMINATE_FAIL:'1'}),r=f.run('deploy');assert.notEqual(r.status,0)
  assert.ok(!f.calls().some(c=>c.document?.kind==='DeleteOptions'))
  assert.match(r.stderr,/retained mx-pay-deploy-lock/)
})
test('concurrent deploy, insufficient nodes and database retargeting fail before DDL',t=>{
  for(const override of [{MOCK_LOCKED:'1'},{MOCK_WORKERS:'1'},{MOCK_DB_DRIFT:'1'}]) {
    const f=fixture(t,override);assert.notEqual(f.run('deploy').status,0)
    assert.ok(!f.calls().some(c=>c.document?.kind==='Job'))
  }
})
test('rollout failure reports failure; schema and payments are never rolled back',t=>{
  const f=fixture(t,{MOCK_ROLLOUT_FAIL:'1'}),r=f.run('deploy');assert.notEqual(r.status,0)
  assert.doesNotMatch(f.calls().map(c=>c.args.join(' ')).join('\n'),/rollout undo|DROP|delete deployment/)
  assert.equal(JSON.parse(readFileSync(join(f.root,'.deploy/last-result.json'))).phase,'rollout')
})
test('Compose migrates before up; failed migration leaves old API untouched',t=>{
  const f=fixture(t,{MX_PAY_DEPLOY_DRIVER:'compose'})
  let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const calls=f.calls().map(c=>c.args.join(' '));assert.ok(calls.findIndex(c=>c.includes('run --rm --no-deps -T migrate'))<calls.findIndex(c=>c.includes('up -d --no-deps --wait')))
  const broken=fixture(t,{MX_PAY_DEPLOY_DRIVER:'compose',MOCK_MIGRATE_FAIL:'1'});r=broken.run('deploy');assert.notEqual(r.status,0)
  assert.ok(!broken.calls().some(c=>c.args.includes('up')))
})
test('manifest isolates generations, drains API and allows two-node rolling surge',t=>{
  const f=fixture(t), output=render({...f.env,MX_PAY_JOB_NAME:'mx-pay-migrate-test'})
  const deployment=output.workload.items.find(i=>i.kind==='Deployment')
  assert.deepEqual(deployment.spec.strategy.rollingUpdate,{maxUnavailable:0,maxSurge:1})
  assert.equal(deployment.spec.replicas,2)
  assert.equal(deployment.spec.template.spec.hostNetwork,undefined)
  assert.equal(deployment.spec.template.spec.automountServiceAccountToken,false)
  assert.equal(deployment.spec.template.spec.terminationGracePeriodSeconds,35)
  assert.equal(output.job.spec.backoffLimit,0)
  assert.ok(output.secrets.items.every(s=>s.immutable))
  writeFileSync(f.env.MX_PAY_RUNTIME_ENV_FILE,'MX_PAY_DATABASE_URL=postgresql://payment:new-password@db.example.test/mx_pay\n')
  const updated=render({...f.env,MX_PAY_JOB_NAME:'mx-pay-migrate-test'})
  assert.notEqual(updated.secrets.items[0].metadata.name,output.secrets.items[0].metadata.name)
  assert.equal(updated.installation.data.databaseIdentity,output.installation.data.databaseIdentity)
})
