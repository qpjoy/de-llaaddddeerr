import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, cpSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { render } from '../scripts/render.mjs'
import { selectContext } from '../scripts/runtime.mjs'
import { selectStorageClass, assertStorageIdentity, assertDiskIdentity, databaseResources } from '../scripts/postgres.mjs'

const image = `registry.example.test/mx-pay@sha256:${'a'.repeat(64)}`
const fsDirectory=root=>readdirSync(join(root,'backups')).filter(n=>!n.startsWith('.'))
export function fixture(t, overrides = {}) {
  const workspace = mkdtempSync(join(tmpdir(),'mx-pay-deploy-test-'))
  const root = join(workspace, 'mx-base/mx-pay')
  mkdirSync(root, { recursive: true })
  mkdirSync(join(workspace, 'mx-common/src/identity'), { recursive: true })
  cpSync(new URL('../../../mx-common/src/identity/profile.mjs',import.meta.url), join(workspace, 'mx-common/src/identity/profile.mjs'))
  t.after(() => rmSync(workspace, { recursive: true, force: true }))
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
else if(s.includes('get nodes')) console.log(JSON.stringify({items:process.env.MOCK_NODES ? JSON.parse(process.env.MOCK_NODES) : Array.from({length:Number(process.env.MOCK_WORKERS||2)},(_,i)=>({metadata:{name:'worker-'+i,labels:{}},spec:{},status:{nodeInfo:{architecture:'amd64',containerRuntimeVersion:'containerd:1.7'},addresses:[{type:'InternalIP',address:'192.0.2.'+(i+1)}],conditions:[{type:'Ready',status:'True'}]}}))}));
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
    MX_PAY_RUNTIME_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_MIGRATION_ENV_FILE:join(root,'secrets/runtime.env'),MX_PAY_CREDENTIALS_SOURCE:join(root,'secrets/credentials.json'),
    MX_PAY_LAUNCHER_IDENTITY_DIR:join(workspace,'launcher-identity'), MX_PAY_BUILD_PROXY:'', ...overrides }
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
test('channel secrets are versioned, mounted, retained and restored; invalid config prevents rollout',t=>{
  const f=fresh(t),keys=generateKeyPairSync('rsa',{modulusLength:2048,privateKeyEncoding:{type:'pkcs8',format:'pem'},publicKeyEncoding:{type:'spki',format:'pem'}})
  mkdirSync(join(f.root,'secrets'))
  const filename=join(f.root,'secrets/channels.json'),channel={id:'alipay-test',provider:'alipay',environment:'test',enabled:false,
    appId:'2021000000000001',sellerId:'2088000000000001',allowedApps:['demo'],keyType:'PKCS8',privateKey:keys.privateKey,alipayPublicKey:keys.publicKey,
    notifyUrl:'https://pay.example.test/v1/notifications/alipay/alipay-test',returnUrl:'https://app.example.test/result'}
  writeFileSync(filename,JSON.stringify([channel]))
  let r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  const state=()=>JSON.parse(readFileSync(f.env.MOCK_STATE)),deployment=state()['deployment/mx-pay']
  assert.ok(deployment.spec.template.spec.volumes[0].secret.items.some(i=>i.key==='channels.json'))
  assert.ok(deployment.spec.template.spec.containers[0].env.some(e=>e.name==='MX_PAY_CHANNELS_FILE'))
  const first=deployment.spec.template.spec.volumes[0].secret.secretName
  assert.equal(Buffer.from(state()[`secret/${first}`].data['channels.json'],'base64').toString(),JSON.stringify([channel]))
  rmSync(join(f.root,'secrets'),{recursive:true})
  r=f.run('deploy');assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(readFileSync(filename)),[channel])
  assert.equal(state()['deployment/mx-pay'].spec.template.spec.volumes[0].secret.secretName,first)
  writeFileSync(filename,JSON.stringify([{...channel,enabled:true}]))
  const upgradeStart=f.calls().length
  r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  assert.notEqual(state()['deployment/mx-pay'].spec.template.spec.volumes[0].secret.secretName,first)
  assert.ok(state()[`secret/${first}`],'old replicas keep their immutable configuration')
  const applied=calls=>calls.flatMap((c,index)=>(c.document?.items||[]).filter(i=>i.kind==='Deployment').map(d=>({index,d})))
  const channelEnabled=d=>JSON.parse(Buffer.from(state()[`secret/${d.spec.template.spec.volumes[0].secret.secretName}`].data['channels.json'],'base64').toString())[0].enabled
  const upgrade=f.calls().slice(upgradeStart),stages=applied(upgrade)
  assert.deepEqual(stages.map(({d})=>channelEnabled(d)),[false,true])
  assert.ok(upgrade.slice(stages[0].index+1,stages[1].index).some(c=>c.args.includes('rollout')&&c.args.includes('status')),'all channel readers upgraded before enabling new identities')
  const failureStart=f.calls().length
  f.env.MOCK_ROLLOUT_FAIL='1';r=f.run('deploy');delete f.env.MOCK_ROLLOUT_FAIL
  assert.notEqual(r.status,0);assert.match(r.stderr,/checkout was not re-enabled/)
  assert.deepEqual(applied(f.calls().slice(failureStart)).map(({d})=>channelEnabled(d)),[false])
  assert.equal(JSON.parse(readFileSync(filename))[0].enabled,true,'desired private channel configuration must survive interrupted rollout')
  const retryStart=f.calls().length
  r=f.run('deploy');assert.equal(r.status,0,r.stderr)
  assert.deepEqual(applied(f.calls().slice(retryStart)).map(({d})=>channelEnabled(d)),[false,true],'retry must complete the barrier again')
  const before=f.calls().length
  writeFileSync(filename,JSON.stringify([{...channel,privateKey:'invalid'}]))
  r=f.run('deploy');assert.notEqual(r.status,0)
  assert.ok(!f.calls().slice(before).some(c=>c.document?.items?.some(i=>i.kind==='Deployment')))
  assert.doesNotMatch(r.stdout+r.stderr,/BEGIN PRIVATE KEY|invalid"/)
  rmSync(filename)
  const missing=state(),active=missing['deployment/mx-pay'].spec.template.spec.volumes[0].secret.secretName
  delete missing[`secret/${active}`].data['channels.json'];writeFileSync(f.env.MOCK_STATE,JSON.stringify(missing))
  r=f.run('deploy');assert.notEqual(r.status,0);assert.match(r.stderr,/refusing empty channel configuration/)
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

test('optional SSO console is isolated from API and migration secrets and retains its identity after local config loss', t => {
  const f = fixture(t)
  const dir = join(f.root, 'secrets/console'); mkdirSync(dir)
  const profile = { appId: 'mx-pay', origin: 'https://pay.example.test', issuer: 'https://auth.example.test/identity',
    clientId: 'mx-pay-web', clientSecret: 'test-private-client', audience: 'mx-pay', scope: 'openid mx:identity', sessionKey: 'a'.repeat(43) }
  writeFileSync(join(dir, 'profile.json'), JSON.stringify(profile), { mode: 0o600 })
  writeFileSync(join(dir, 'access.json'), '[]', { mode: 0o600 })
  const result = f.run('deploy'); assert.equal(result.status, 0, result.stderr)
  const calls = f.calls(), secrets = calls.find(c => c.document?.items?.some(item => item.metadata.name.startsWith('mx-pay-console-'))).document.items
  const consoleSecret = secrets.find(item => item.metadata.name.startsWith('mx-pay-console-'))
  assert.equal(Buffer.from(consoleSecret.data['profile.json'], 'base64').toString(), JSON.stringify(profile))
  assert.equal(consoleSecret.data['credentials.json'], undefined); assert.equal(consoleSecret.data['channels.json'], undefined)
  assert.ok(secrets.filter(item => item !== consoleSecret).every(item => !item.data['profile.json'] && !item.data['access.json']))
  const consoleDoc = calls.find(c => c.document?.items?.some(item => item.kind === 'Deployment' && item.metadata.name === 'mx-pay-console')).document
  const consolePod = consoleDoc.items.find(item => item.kind === 'Deployment').spec.template.spec
  assert.equal(consolePod.volumes[0].secret.defaultMode, 0o440)
  assert.deepEqual(consolePod.containers[0].command, ['node', 'server/console-index.mjs'])
  const apiReady = calls.findIndex(c => c.args.includes('deployment/mx-pay') && c.args.includes('status'))
  const consoleApply = calls.findIndex(c => c.document === consoleDoc)
  assert.ok(consoleApply > apiReady, 'console rollout cannot gate payment API rollout')
  rmSync(dir, { recursive: true })
  const retry = f.run('deploy'); assert.equal(retry.status, 0, retry.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'profile.json'))), profile)
  assert.deepEqual(JSON.parse(readFileSync(join(dir, 'access.json'))), [])
})

test('deploy starts without SSO, later imports Launcher registration and restores grants from its own Secret before discovery',t=>{
  const f=fresh(t)
  let result=f.run('deploy');assert.equal(result.status,0,result.stderr)
  const state=()=>JSON.parse(readFileSync(f.env.MOCK_STATE))
  assert.ok(state()['deployment/mx-pay'])
  assert.equal(state()['deployment/mx-pay-console'],undefined)
  assert.equal(existsSync(join(f.root,'secrets/console/profile.json')),false)
  const machine=readFileSync(join(f.root,'secrets/credentials.json'),'utf8')
  const profile={appId:'mx-pay',origin:'https://pay.example.test',issuer:'https://auth.example.test/identity',
    clientId:'mx-pay-web',clientSecret:'registered-original-client',audience:'mx-pay',scope:'openid mx:identity',sessionKey:'s'.repeat(43)}
  const launcher=join(f.env.MX_PAY_LAUNCHER_IDENTITY_DIR,'applications/public/mx-pay.json')
  mkdirSync(join(launcher,'..'),{recursive:true,mode:0o700});writeFileSync(launcher,JSON.stringify(profile),{mode:0o600})
  result=f.run('discover');assert.equal(result.status,0,result.stderr)
  assert.equal(existsSync(join(f.root,'secrets/console/profile.json')),false,'read-only discovery cannot copy profiles')
  result=f.run('deploy');assert.equal(result.status,0,result.stderr)
  assert.ok(state()['deployment/mx-pay-console'])
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'secrets/console/profile.json'))),profile)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'secrets/console/access.json'))),[])
  const grants=[{issuer:profile.issuer,subject:'original-user',clientId:profile.clientId,appId:'mx-insight-hub',environment:'test',role:'viewer'}]
  writeFileSync(join(f.root,'secrets/console/access.json'),JSON.stringify(grants))
  result=f.run('deploy');assert.equal(result.status,0,result.stderr)
  const retainedName=state()['deployment/mx-pay-console'].spec.template.spec.volumes[0].secret.secretName
  rmSync(join(f.root,'secrets/console'),{recursive:true})
  writeFileSync(launcher,JSON.stringify({...profile,clientSecret:'different-launcher-secret',sessionKey:'n'.repeat(43)}))
  result=f.run('deploy');assert.equal(result.status,0,result.stderr)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'secrets/console/profile.json'))),profile)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'secrets/console/access.json'))),grants)
  assert.equal(state()['deployment/mx-pay-console'].spec.template.spec.volumes[0].secret.secretName,retainedName)
  assert.equal(readFileSync(join(f.root,'secrets/credentials.json'),'utf8'),machine)
  assert.doesNotMatch(result.stdout+result.stderr,/registered-original-client|different-launcher-secret|ssssssss/)
  const lost=state();delete lost[`secret/${retainedName}`].data['access.json']
  writeFileSync(f.env.MOCK_STATE,JSON.stringify(lost));rmSync(join(f.root,'secrets/console/access.json'))
  const before=f.calls().length
  result=f.run('deploy');assert.notEqual(result.status,0)
  assert.match(result.stderr,/Retained payment console identity\/access missing/)
  assert.equal(existsSync(join(f.root,'secrets/console/access.json')),false)
  assert.ok(!f.calls().slice(before).some(c=>c.document?.kind==='Job' || c.args.includes('buildx')))
})

test('Compose also discovers a first registration under its local lock and preserves it on repeat',t=>{
  const f=fixture(t,{MX_PAY_DEPLOY_DRIVER:'compose'})
  const launcher=join(f.env.MX_PAY_LAUNCHER_IDENTITY_DIR,'applications/private/mx-pay.json')
  const profile={appId:'mx-pay',origin:'https://pay.example.test',issuer:'https://auth.example.test/identity',
    clientId:'mx-pay-web',clientSecret:'registered-original-client',audience:'mx-pay',scope:'openid mx:identity',sessionKey:'s'.repeat(43)}
  mkdirSync(join(launcher,'..'),{recursive:true,mode:0o700});writeFileSync(launcher,JSON.stringify(profile),{mode:0o600})
  for(let i=0;i<2;i++){const r=f.run('deploy');assert.equal(r.status,0,r.stderr)}
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'secrets/console/profile.json'))),profile)
  assert.ok(f.calls().some(c=>c.args.includes('up') && c.args.at(-1)==='console'))
  rmSync(join(f.root,'secrets/console/access.json'))
  const before=f.calls().length,result=f.run('deploy');assert.notEqual(result.status,0)
  assert.match(result.stderr,/restore original grants/)
  assert.ok(!f.calls().slice(before).some(c=>c.args.includes('up') || c.args.includes('migrate')))
})

test('invalid discovered SSO stops before image build, database bootstrap or migration without exposing secrets',t=>{
  const f=fresh(t,{MX_PAY_BUILD:'1'})
  const launcher=join(f.env.MX_PAY_LAUNCHER_IDENTITY_DIR,'applications/public/mx-pay.json')
  mkdirSync(join(launcher,'..'),{recursive:true,mode:0o700});writeFileSync(launcher,'{"clientSecret":"do-not-print-this-secret",',{mode:0o600})
  const result=f.run('deploy');assert.notEqual(result.status,0)
  assert.doesNotMatch(result.stdout+result.stderr,/do-not-print-this-secret/)
  assert.ok(!f.calls().some(c=>c.document?.kind==='Job' || c.args.includes('buildx')))
})

test('a configured but not-yet-generated SSO profile does not block first internal API startup',t=>{
  const f=fixture(t)
  f.env.MX_PAY_SSO_SOURCE=join(f.root,'future-registration/mx-pay.json')
  const result=f.run('deploy');assert.equal(result.status,0,result.stderr)
  assert.match(result.stdout,/SSO profile not available yet/)
  const state=JSON.parse(readFileSync(f.env.MOCK_STATE))
  assert.ok(state['deployment/mx-pay'])
  assert.equal(state['deployment/mx-pay-console'],undefined)
  assert.equal(existsSync(f.env.MX_PAY_SSO_SOURCE),false)
})

test('fresh control-plane-only install deploys all Pay workloads, pins its node and never relaxes cluster taints',t=>{
  const n={metadata:{name:'mx-internal-server',labels:{'node-role.kubernetes.io/control-plane':''}},
    spec:{taints:[{key:'node-role.kubernetes.io/control-plane',effect:'NoSchedule'}]},status:{nodeInfo:{architecture:'amd64',containerRuntimeVersion:'containerd:1.7'},
      addresses:[{type:'InternalIP',address:'192.0.2.1'}],conditions:[{type:'Ready',status:'True'}]}}
  const f=fresh(t,{MOCK_NODES:JSON.stringify([n]),MX_PAY_MIN_READY_WORKERS:'',MX_PAY_BUILD:'1',MX_PAY_IMAGE:''})
  const dir=join(f.env.MX_PAY_LAUNCHER_IDENTITY_DIR,'applications/public');mkdirSync(dir,{recursive:true,mode:0o700})
  writeFileSync(join(dir,'mx-pay.json'),JSON.stringify({appId:'mx-pay',origin:'https://pay.example.test',issuer:'https://auth.example.test/identity',
    clientId:'mx-pay-web',clientSecret:'original-client',audience:'mx-pay',scope:'openid mx:identity',sessionKey:'a'.repeat(43)}),{mode:0o600})
  for(let i=0;i<2;i++){const r=f.run('deploy');assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/topology=single-node/)}
  const state=JSON.parse(readFileSync(f.env.MOCK_STATE))
  for(const name of ['deployment/mx-pay','deployment/mx-pay-console','statefulset/mx-pay-postgres','job/mx-pay-postgres-init',
    ...Object.keys(state).filter(k=>k.startsWith('job/mx-pay-migrate-'))]) {
    const p=state[name].spec.template.spec
    assert.ok(p.tolerations.some(t=>t.key==='node-role.kubernetes.io/control-plane' && t.effect==='NoSchedule'))
    assert.deepEqual(p.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchFields[0].values,['mx-internal-server'])
  }
  assert.equal(state['deployment/mx-pay'].spec.replicas,2)
  assert.equal(state['configmap/mx-pay-installation'].data.topologyMode,'single-node')
  assert.equal(JSON.parse(readFileSync(join(f.root,'.deploy/topology.json'))).node,n.metadata.name)
  assert.deepEqual(JSON.parse(readFileSync(join(f.root,'.deploy/image-nodes.json'))),[n.metadata.name])
  rmSync(join(f.root,'.deploy/topology.json'))
  const restored=f.run('deploy');assert.equal(restored.status,0,restored.stderr)
  assert.equal(JSON.parse(readFileSync(join(f.root,'.deploy/topology.json'))).node,n.metadata.name)
  const discovered=f.run('discover');assert.equal(discovered.status,0,discovered.stderr)
  assert.deepEqual(JSON.parse(discovered.stdout).topology,{mode:'single-node',node:n.metadata.name})
  assert.ok(!f.calls().some(c=>c.args.includes('taint') || (c.args.includes('patch') && c.args.includes('node'))))
  f.env.MOCK_NODES=JSON.stringify([{...n,metadata:{...n.metadata,name:'replacement'}}])
  const before=f.calls().length,r=f.run('deploy');assert.notEqual(r.status,0);assert.match(r.stderr,/discovered 0/)
  assert.ok(!f.calls().slice(before).some(c=>c.document?.kind==='Job' || c.args.includes('buildx')))
})

test('an old multi-node installation never auto-downgrades when only one node remains',t=>{
  const f=fixture(t);assert.equal(f.run('deploy').status,0)
  const state=JSON.parse(readFileSync(f.env.MOCK_STATE));delete state['configmap/mx-pay-installation'].data.topologyMode;delete state['configmap/mx-pay-installation'].data.topologyNode
  writeFileSync(f.env.MOCK_STATE,JSON.stringify(state));rmSync(join(f.root,'.deploy/topology.json'))
  f.env.MOCK_WORKERS='1';f.env.MX_PAY_MIN_READY_WORKERS=''
  const r=f.run('deploy');assert.notEqual(r.status,0);assert.match(r.stderr,/multi-node requires 2/)
})

test('deploy proxy overrides .env, supports explicit empty override and rejects invalid proxy before migration',t=>{
  const direct=fixture(t,{MX_PAY_BUILD:'1',MX_PAY_IMAGE_REPOSITORY:'registry.example.test/mx-pay',MX_PAY_BUILD_PROXY:''})
  writeFileSync(join(direct.root,'.env'),'MX_PAY_BUILD_PROXY=http://127.0.0.1:7789\n')
  const r=direct.run('deploy');assert.equal(r.status,0,r.stderr)
  assert.ok(direct.calls().some(c=>c.args[0]==='buildx' && c.args[1]==='build'))
  assert.ok(!direct.calls().some(c=>c.args.includes('--builder')))
  const invalid=fixture(t,{MX_PAY_BUILD:'1',MX_PAY_IMAGE_REPOSITORY:'registry.example.test/mx-pay',MX_PAY_BUILD_PROXY:'socks5://PRIVATE@localhost:7789'})
  writeFileSync(join(invalid.root,'.env'),'MX_PAY_BUILD_PROXY=http://127.0.0.1:7789\n')
  const failed=invalid.run('deploy');assert.notEqual(failed.status,0);assert.match(failed.stderr,/HTTP\(S\) proxy URL/)
  assert.doesNotMatch(failed.stderr+failed.stdout,/PRIVATE/)
  assert.ok(!invalid.calls().some(c=>c.document?.kind==='Job' || c.args.includes('buildx')))
})
