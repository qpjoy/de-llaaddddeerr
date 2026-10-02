import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { render } from '../scripts/render.mjs'
import { selectContext } from '../scripts/runtime.mjs'
import { selectStorageClass, assertStorageIdentity, assertDiskIdentity, databaseResources } from '../scripts/postgres.mjs'

const image = `registry.example.test/mx-pay@sha256:${'a'.repeat(64)}`
const fsDirectory=root=>readdirSync(join(root,'backups')).filter(n=>!n.startsWith('.'))
export function fixture(t, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(),'mx-pay-deploy-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const dir of ['scripts','server','src','deploy']) cpSync(new URL(`../${dir}/`,import.meta.url),join(root,dir),{ recursive: true })
  mkdirSync(join(root,'secrets')); mkdirSync(join(root,'bin'))
  writeFileSync(join(root,'secrets/runtime.env'),'MX_PAY_DATABASE_URL=postgresql://payment:private@db.example.test/mx_pay\n')
  writeFileSync(join(root,'secrets/credentials.json'),JSON.stringify([{ id:'test-app',appId:'demo',environment:'test',secret:'test-only-secret-'.repeat(3),scopes:['orders.read','orders.write'] }]))
  writeFileSync(join(root,'bin/kubectl'), `#!${process.execPath}
const fs=require('fs'); const a=process.argv.slice(2), s=a.join(' '), log={args:a};
const state=fs.existsSync(process.env.MOCK_STATE)?JSON.parse(fs.readFileSync(process.env.MOCK_STATE)):{};
const save=()=>fs.writeFileSync(process.env.MOCK_STATE,JSON.stringify(state));
const fi=a.indexOf('-f'); if(fi>=0) log.document=JSON.parse(fs.readFileSync(a[fi+1]==='-'?0:a[fi+1],'utf8'));
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify(log)+'\\n');
const aliases={ConfigMap:'configmap',Secret:'secret',StatefulSet:'statefulset',Deployment:'deployment',Job:'job',PersistentVolumeClaim:'pvc',PersistentVolume:'pv'};
if(log.document && !s.includes('delete --raw')) {
 for(const obj of (log.document.items || [log.document])) {
  if(!obj.metadata?.name)continue;
  obj.metadata.uid ||= obj.metadata.name+'-uid';
  if(obj.kind==='PersistentVolumeClaim') {
   obj.spec.volumeName='payment-test-volume'; obj.status={phase:'Bound'};
   state['pv/payment-test-volume']={metadata:{name:'payment-test-volume',uid:'volume-uid'},spec:{claimRef:{uid:obj.metadata.uid},persistentVolumeReclaimPolicy:'Retain'},status:{phase:'Bound'}};
  }
  if(obj.kind==='Job')obj.status=obj.metadata.name==='mx-pay-postgres-init' && process.env.MOCK_INIT_FAIL ? {active:1} : {succeeded:1};
  state[(aliases[obj.kind]||obj.kind)+'/'+obj.metadata.name]=obj;
 }
 save();
}
if(s==='config view -o json') console.log(JSON.stringify({contexts:[{name:'test-cluster'},{name:'other-cluster'}],'current-context':process.env.MOCK_CURRENT_CONTEXT||'test-cluster'}));
else if(s.includes('get namespace kube-system'))console.log(process.env.MOCK_CLUSTER_UID||'cluster-uid');
else if(s.includes('get nodes')) console.log(JSON.stringify({items:Array.from({length:Number(process.env.MOCK_WORKERS||2)},(_,i)=>({metadata:{name:'worker-'+i,labels:{}},spec:{},status:{nodeInfo:{architecture:'amd64',containerRuntimeVersion:'containerd:1.7'},addresses:[{type:'InternalIP',address:'192.0.2.'+(i+1)}],conditions:[{type:'Ready',status:'True'}]}}))}));
else if(s.includes('get storageclass'))console.log(JSON.stringify({items:[{metadata:{name:'test-storage',annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}]}));
else if(s.includes('get replicasets'))console.log(JSON.stringify({items:[]}));
else if(s.includes('create namespace')) console.log('{}');
else if(s.includes('create configmap mx-pay-deploy-lock')) {if(process.env.MOCK_LOCKED)process.exit(1);console.log('lock-uid-123');}
else if(s.includes('get configmap mx-pay-installation') && process.env.MOCK_DB_DRIFT) console.log(JSON.stringify({data:{databaseIdentity:'different'}}));
else if(s.includes('get configmap mx-pay-database') && process.env.MOCK_LOST_ANCHOR) {}
else if(s.includes('get pvc mx-pay-postgres-data') && process.env.MOCK_VOLUME_DRIFT) console.log(JSON.stringify({...state['pvc/mx-pay-postgres-data'],metadata:{uid:'replacement-uid'}}));
else if(a.includes('get')){const i=a.indexOf('get'),obj=state[a[i+1]+'/'+a[i+2]];if(obj)console.log(JSON.stringify(obj));}
else if(s.includes('wait --for=condition=complete job/mx-pay-postgres-init') && process.env.MOCK_INIT_FAIL) process.exit(1);
else if(s.includes('wait --for=condition=complete') && process.env.MOCK_MIGRATE_FAIL) process.exit(1);
else if(s.includes('logs job/mx-pay-postgres-init'))console.log('7390000000000000001');
else if(s.includes('SELECT system_identifier'))console.log(process.env.MOCK_PG_DRIFT?'7390000000000000002':'7390000000000000001');
else if(a.includes('pg_dump')){if(process.env.MOCK_BACKUP_FAIL)process.exit(1);process.stdout.write('PGDMP-test-only-archive');}
else if(a.includes('pg_restore')){fs.readFileSync(0);if(process.env.MOCK_ARCHIVE_FAIL)process.exit(1);console.log('test archive contents');}
else if(s.includes('delete job') && process.env.MOCK_TERMINATE_FAIL) process.exit(1);
else if(s.includes('rollout status') && process.env.MOCK_ROLLOUT_FAIL) process.exit(1);
`,{ mode: 0o755 })
  writeFileSync(join(root,'bin/docker'),`#!${process.execPath}
const fs=require('fs'), a=process.argv.slice(2), s=a.join(' ');
fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args:a})+'\\n');
if(s==='context show')console.log('test-compose');
if(a.includes('--metadata-file'))fs.writeFileSync(a[a.indexOf('--metadata-file')+1],JSON.stringify({'containerimage.digest':'sha256:'+'b'.repeat(64)}));
if(s.startsWith('image inspect'))console.log('sha256:'+'b'.repeat(64));
if(s.startsWith('image save'))fs.writeFileSync(a[a.indexOf('--output')+1],'test archive');
if(s.includes('run --rm --no-deps -T migrate') && process.env.MOCK_MIGRATE_FAIL)process.exit(1);
`,{ mode: 0o755 })
  writeFileSync(join(root,'bin/ssh'),`#!${process.execPath}
const fs=require('fs'),a=process.argv.slice(2),s=a.join(' ');fs.appendFileSync(process.env.MOCK_LOG,JSON.stringify({args:['ssh',...a]})+'\\n');
if(process.env.MOCK_SSH_FAIL)process.exit(1);
if(s.includes('images import'))fs.readFileSync(0);
else if(s.includes('images ls'))console.log('local.mx/mx-pay:'+'b'.repeat(64));
else console.log('containerd');
`,{mode:0o755})
  const env = { ...process.env, PATH:`${join(root,'bin')}:${process.env.PATH}`, MOCK_LOG:join(root,'calls'), MOCK_STATE:join(root,'cluster-state.json'), MX_PAY_DEPLOY_DRIVER:'k8s', MX_PAY_KUBE_CONTEXT:'test-cluster', MX_PAY_NAMESPACE:'mx-pay-test', MX_PAY_REPLICAS:'2', MX_PAY_MIN_READY_WORKERS:'2', MX_PAY_BUILD:'0', MX_PAY_IMAGE:image,
    MX_PAY_RUNTIME_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_MIGRATION_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_CREDENTIALS_SOURCE:join(root,'secrets/credentials.json'), ...overrides }
  return { root, env, run: action => spawnSync('bash',[join(root,'scripts/manage.sh'),action],{env,encoding:'utf8',timeout:30000}), calls: () => readFileSync(env.MOCK_LOG,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
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
  for (const call of calls) {
    assert.doesNotMatch(JSON.stringify(call),/mx-launcher|mx-insight-hub|cluster-admin/)
    // Scope deletion detection to one command: a preceding lock release must
    // not match a subsequent read-only PVC check on the next deploy.
    assert.doesNotMatch(call.args.join(' '),/delete.*(?:pvc|persistentvolume)/)
  }
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

function fresh(t, overrides={}) {
  const f=fixture(t,overrides)
  rmSync(join(f.root,'secrets'),{recursive:true})
  delete f.env.MX_PAY_MIGRATION_ENV_FILE
  delete f.env.MX_PAY_KUBE_CONTEXT
  return f
}
test('fresh one-command deploy discovers context, bootstraps dedicated PG and repeats without replacing data or secrets',t=>{
  const f=fresh(t)
  let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const files=['credentials.json','runtime.env','migration.env'].map(p=>readFileSync(join(f.root,'secrets',p),'utf8'))
  assert.match(files[1],/mx_pay_runtime:/);assert.match(files[2],/mx_pay_owner:/)
  r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  assert.deepEqual(['credentials.json','runtime.env','migration.env'].map(p=>readFileSync(join(f.root,'secrets',p),'utf8')),files)
  const docs=f.calls().map(c=>c.document).filter(Boolean)
  assert.equal(docs.filter(d=>d.kind==='Job'&&d.metadata.name==='mx-pay-postgres-init').length,1)
  assert.equal(docs.filter(d=>d.kind==='Secret'&&d.metadata.name==='mx-pay-postgres-bootstrap').length,1)
  assert.equal(docs.filter(d=>d.items?.some(i=>i.kind==='StatefulSet')).length,1)
  assert.equal(docs.filter(d=>d.kind==='Job'&&d.metadata.name.startsWith('mx-pay-migrate-')).length,2)
  assert.ok(docs.findIndex(d=>d.kind==='Job'&&d.metadata.name==='mx-pay-postgres-init')<docs.findIndex(d=>d.kind==='Job'&&d.metadata.name.startsWith('mx-pay-migrate-')))
  assert.doesNotMatch(r.stdout,/postgresql:\/\/|ownerPassword|runtimePassword/)
})
test('lost local config restores currently deployed credentials and target from cluster without rotation',t=>{
  const f=fresh(t);let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const original=['credentials.json','runtime.env','migration.env'].map(p=>readFileSync(join(f.root,'secrets',p),'utf8'))
  rmSync(join(f.root,'secrets'),{recursive:true})
  r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  assert.deepEqual(['credentials.json','runtime.env','migration.env'].map(p=>readFileSync(join(f.root,'secrets',p),'utf8')),original)
})
test('deploy refuses changed cluster, replacement PVC, wrong PG and lost database anchor',t=>{
  for(const [key,value] of [['MOCK_CLUSTER_UID','another-cluster'],['MOCK_VOLUME_DRIFT','1'],['MOCK_PG_DRIFT','1'],['MOCK_LOST_ANCHOR','1']]) {
    const f=fresh(t);let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
    if(key==='MOCK_LOST_ANCHOR')rmSync(join(f.root,'.deploy/database.json')) // Another operator host has no local checkpoint.
    const before=f.calls().length;f.env[key]=value;r=f.run('deploy');assert.notEqual(r.status,0)
    assert.ok(!f.calls().slice(before).some(c=>c.document?.kind==='Job' || c.document?.items?.some(i=>i.kind==='Deployment')))
    assert.doesNotMatch(JSON.stringify(f.calls().slice(before)),/delete.*pvc|DROP DATABASE|initdb/)
  }
})
test('restart verifies storage identity without replacing PostgreSQL or its credentials',t=>{
  const f=fresh(t);assert.equal(f.run('deploy').status,0)
  const before=f.calls().length
  let r=f.run('restart');assert.equal(r.status,0,r.stderr)
  assert.ok(!f.calls().slice(before).some(c=>c.document?.items?.some(i=>i.kind==='StatefulSet') || c.document?.kind==='Secret'))
  f.env.MOCK_VOLUME_DRIFT='1';const start=f.calls().length;r=f.run('restart');assert.notEqual(r.status,0)
  assert.ok(!f.calls().slice(start).some(c=>c.args.includes('rollout')))
  delete f.env.MOCK_VOLUME_DRIFT;f.env.MOCK_LOST_ANCHOR='1'
  r=f.run('restart');assert.notEqual(r.status,0);assert.match(r.stderr,/anchor missing/)
})
test('initialization timeout holds the deployment lock and never starts API migration',t=>{
  const f=fresh(t,{MOCK_INIT_FAIL:'1'}),r=f.run('deploy');assert.notEqual(r.status,0)
  assert.match(r.stderr,/initialization unresolved/)
  assert.ok(!f.calls().some(c=>c.document?.kind==='DeleteOptions' || c.document?.metadata?.name?.startsWith('mx-pay-migrate-')))
})
test('registryless deploy imports to every worker before migration and pins scheduling to imported nodes',t=>{
  const f=fixture(t,{MX_PAY_BUILD:'1',MX_PAY_IMAGE_REPOSITORY:'',MX_PAY_IMAGE:''}),r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const calls=f.calls(),imports=calls.filter(c=>c.args[0]==='ssh' && c.args.join(' ').includes('images import'))
  assert.equal(imports.length,2)
  const d=calls.find(c=>c.document?.items?.some(i=>i.kind==='Deployment')).document.items.find(i=>i.kind==='Deployment')
  const spec=d.spec.template.spec
  assert.equal(spec.containers[0].image,`local.mx/mx-pay:${'b'.repeat(64)}`)
  assert.equal(spec.containers[0].imagePullPolicy,'Never')
  assert.deepEqual(spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields[0].values,['worker-0','worker-1'])
  const blocked=fixture(t,{MX_PAY_BUILD:'1',MOCK_SSH_FAIL:'1',MX_PAY_IMAGE:''});const result=blocked.run('deploy');assert.notEqual(result.status,0)
  assert.match(result.stderr,/trusted SSH\/containerd/)
  assert.ok(!blocked.calls().some(c=>c.document?.kind==='Job'))
})
test('discover is read-only JSON and backup publishes only a complete verified archive',t=>{
  const f=fresh(t);let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const before=f.calls().length;r=f.run('discover');assert.equal(r.status,0,r.stderr)
  const info=JSON.parse(r.stdout);assert.equal(info.database.mode,'managed');assert.equal(info.authenticationDependency,null)
  assert.ok(f.calls().slice(before).every(c=>c.args.includes('get') || c.args.includes('config')))
  r=f.run('backup');assert.equal(r.status,0,r.stderr)
  const entries=fsDirectory(f.root)
  assert.equal(entries.length,1)
  const manifest=JSON.parse(readFileSync(join(f.root,'backups',entries[0],'manifest.json')))
  assert.equal(manifest.archiveVerified,true);assert.equal(manifest.restoreDrillCompleted,false)
  f.env.MOCK_ARCHIVE_FAIL='1';r=f.run('backup');assert.notEqual(r.status,0)
  assert.equal(fsDirectory(f.root).length,1)
})
test('discovery and storage identity fail closed on ambiguous/replaced resources',()=>{
  assert.equal(selectContext({contexts:[{name:'sole'}]},null,null),'sole')
  assert.throws(()=>selectContext({contexts:[{name:'a'},{name:'b'}]},null,null),/unambiguous/)
  assert.throws(()=>selectContext({contexts:[{name:'a'}]},'a',{context:'old'}),/target differs/)
  assert.throws(()=>selectStorageClass(['a','b'].map(name=>({metadata:{name,annotations:{'storageclass.kubernetes.io/is-default-class':'true'}}}))),/Multiple/)
  assert.throws(()=>assertStorageIdentity({pvcUID:'expected'},{metadata:{uid:'backup'}},{metadata:{}}),/identity changed/)
  assert.throws(()=>assertDiskIdentity({filesystemUUID:'original'},{filesystemUUID:'backup'}),/filesystemUUID/)
  const normal=databaseResources({systemIdentifier:'7390000000000000001'},{installationID:'a'.repeat(32)})
  const command=normal.items.find(i=>i.kind==='StatefulSet').spec.template.spec.containers[0].command.join(' ')
  assert.match(command,/7390000000000000001/);assert.doesNotMatch(command,/initdb|docker-entrypoint/)
})
