import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { plan, apply } from '../scripts/postgres-permissions.mjs'
import { databaseResources } from '../scripts/postgres.mjs'

const chmod=' chmod -- 00700 "$PGDATA";'
function fixture(t,{local=false,current=false,podCurrent=current}={}) {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'mx-pay-permissions-test-')))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(path.join(root,'.deploy'))
  const target={context:'test-cluster',namespace:'mx-pay-test',clusterUID:'cluster-uid'}
  fs.writeFileSync(path.join(root,'.deploy/target.json'),JSON.stringify(target))
  const identity={...target,phase:'ready',image:'postgres:16-bookworm',installationID:'a'.repeat(32),systemIdentifier:'7390000000000000001',pvcUID:'pvc-uid',pvUID:'pv-uid',pvName:'payment-pv',storageClass:local ? '' : 'test-storage'}
  let mount
  if (local) {
    const directory=path.join(root,'pg-volume'); fs.mkdirSync(directory)
    mount={target:root,uuid:'original-filesystem-uuid',fsroot:'/'}
    Object.assign(identity,{localPath:directory,node:'node-1',mountTarget:root,filesystemUUID:mount.uuid,volumeMountRoot:'/pg-volume'})
  }
  const sts=databaseResources(identity,{installationID:identity.installationID}).items.find(i=>i.kind==='StatefulSet')
  Object.assign(sts.metadata,{namespace:target.namespace,uid:'statefulset-uid',resourceVersion:'7'})
  sts.status={readyReplicas:1}
  const pod={apiVersion:'v1',kind:'Pod',metadata:{name:'mx-pay-postgres-0',namespace:target.namespace,uid:'pod-uid',ownerReferences:[{kind:'StatefulSet',name:'mx-pay-postgres',uid:sts.metadata.uid,controller:true}]},spec:{...structuredClone(sts.spec.template.spec),nodeName:'node-1'},status:{phase:'Running',conditions:[{type:'Ready',status:'True'}],containerStatuses:[{name:'postgres',ready:true}]}}
  if (!current) sts.spec.template.spec.containers[0].command[2]=sts.spec.template.spec.containers[0].command[2].replace(chmod,'')
  if (!podCurrent) pod.spec.containers[0].command[2]=pod.spec.containers[0].command[2].replace(chmod,'')
  const state={sts,pod,identity,mount,receipt:structuredClone(identity),owner:'999:999',clusterUID:target.clusterUID,bootstrap:identity.installationID,lock:{metadata:{uid:'lock-uid'},data:{action:'postgres-permissions-apply'}},patches:[],calls:[],databaseChecks:0}
  const io={platform:'linux',env:{MX_PAY_KUBE_CONTEXT:target.context,MX_PAY_NAMESPACE:target.namespace,MX_PAY_PERMISSIONS_LOCK_UID:'lock-uid'},
    readJSON(filename) {
      if (filename.startsWith('/var/lib/mx-pay/')) { assert.ok(state.receipt,'missing host receipt'); return structuredClone(state.receipt) }
      return JSON.parse(fs.readFileSync(filename,'utf8'))
    },
    checkDatabase() { state.databaseChecks++; if(state.databaseError) throw new Error(state.databaseError); return {data:{identity:JSON.stringify(state.identity)}} },
    localNode:()=>({metadata:{name:'node-1'}}),
    run(command,args) { assert.equal(command,'findmnt'); assert.ok(args.includes(state.identity.localPath)); return JSON.stringify({filesystems:[state.mount]}) },
    get(kind,name) {
      state.calls.push(['get',kind,name])
      if(kind==='pod') { if(state.patches.length && state.podReadFailure) throw new Error('read failed'); return structuredClone(state.pod) }
      if(kind==='secret') return {data:{installationID:Buffer.from(state.bootstrap).toString('base64')}}
      if(kind==='configmap' && name==='mx-pay-deploy-lock') return structuredClone(state.lock)
      throw new Error('Unexpected read')
    },
    kube(...args) {
      state.calls.push(args)
      if(args[0]==='get' && args[1]==='namespace') return state.clusterUID
      if(args[0]==='get' && args[1]==='nodes') return JSON.stringify({items:[{metadata:{name:'node-1'}}]})
      if(args[0]==='get' && args[1]==='statefulset') {
        if(state.patches.length && state.stateReadFailure) throw new Error('read failed')
        return JSON.stringify(state.sts)
      }
      if(args[0]==='exec') { assert.ok(args.at(-1).includes('stat -c')); return state.owner }
      assert.deepEqual(args.slice(0,4),['patch','statefulset','mx-pay-postgres','--type=json'])
      const patch=JSON.parse(fs.readFileSync(args[args.indexOf('--patch-file')+1],'utf8')); state.patches.push(patch)
      if(state.concurrentChange) state.sts.metadata.resourceVersion='8'
      if(state.patchFailure==='before') throw new Error('API failed')
      for(const item of patch) {
        const keys=item.path.slice(1).split('/'),parent=keys.slice(0,-1).reduce((v,k)=>v[k],state.sts),key=keys.at(-1)
        if(item.op==='test') assert.deepEqual(parent[key],item.value)
        else { assert.equal(item.op,'replace'); assert.equal(item.path,'/spec/template/spec/containers/0/command'); parent[key]=structuredClone(item.value) }
      }
      if(state.replacePod) state.pod.metadata.uid='other-pod-uid'
      if(state.patchFailure==='after') throw new Error('response lost')
      return JSON.stringify(state.sts)
    },
  }
  return {root,state,io}
}

test('plan recognizes the historical command without writes or exposing command/identity values',t=>{
  const f=fixture(t), before=structuredClone(f.state.sts), result=plan(f.root,f.io)
  assert.equal(result.templateGuard,'known-legacy'); assert.equal(result.podGuard,'known-legacy')
  assert.equal(result.templateChangeNeeded,true); assert.equal(result.restartsPod,false)
  assert.equal(f.state.databaseChecks,1)
  assert.deepEqual(f.state.sts,before); assert.deepEqual(fs.readdirSync(path.join(f.root,'.deploy')),['target.json'])
  assert.equal(f.state.patches.length,0)
  assert.doesNotMatch(JSON.stringify(result),/PGDATA|7390000000000000001|aaaaaaaa/)
})

test('apply changes only the known command, privately backs up the exact original, and preserves the running Pod',t=>{
  const f=fixture(t), before=structuredClone(f.state.sts), oldPod=structuredClone(f.state.pod), result=apply(f.root,f.io)
  const expected=structuredClone(before)
  // Insert exactly the source guard, retaining every original argument.
  expected.spec.template.spec.containers[0].command[2]=before.spec.template.spec.containers[0].command[2].replace(' exec postgres',`${chmod} exec postgres`)
  assert.deepEqual(f.state.sts,expected)
  assert.deepEqual(f.state.pod,oldPod)
  assert.equal(result.templateGuard,'known-current'); assert.equal(result.podGuard,'known-legacy')
  assert.equal(result.podRecreationNeededForGuard,true); assert.equal(result.originalPodStillPresent,true)
  assert.equal(fs.statSync(result.backup).mode & 0o777,0o700)
  for(const file of ['statefulset.json','patch.json']) assert.equal(fs.statSync(path.join(result.backup,file)).mode & 0o777,0o600)
  assert.equal(fs.readFileSync(path.join(result.backup,'statefulset.json'),'utf8'),JSON.stringify(before))
  assert.equal(f.state.patches[0].filter(p=>p.op==='replace').length,1)
  for(const field of ['/metadata/uid','/metadata/resourceVersion','/spec/updateStrategy/type','/spec/template/spec/containers/0/command']) assert.ok(f.state.patches[0].some(p=>p.op==='test' && p.path===field))
  assert.equal(f.state.calls.some(args=>['delete','create','apply'].includes(args[0])),false)
  const repeated=apply(f.root,f.io)
  assert.equal(repeated.result,'already-current'); assert.equal(repeated.backup,null)
  assert.equal(f.state.patches.length,1)
})

test('an updated template with the original Pod remains a pending OnDelete change',t=>{
  const f=fixture(t,{current:true,podCurrent:false}), result=plan(f.root,f.io)
  assert.equal(result.templateChangeNeeded,false); assert.equal(result.podRecreationNeededForGuard,true)
  assert.equal(apply(f.root,f.io).result,'already-current'); assert.equal(f.state.patches.length,0)
})

test('unknown or apparently equivalent commands require review rather than automatic mutation',t=>{
  const f=fixture(t)
  f.state.sts.spec.template.spec.containers[0].command[2]+=' # another implementation'
  assert.throws(()=>apply(f.root,f.io),/Unknown PostgreSQL startup command/)
  assert.equal(f.state.patches.length,0)
})

test('unsafe targets, workload state, credentials and pending configuration changes fail before patch',async t=>{
  const changes={
    cluster:s=>{s.clusterUID='replacement-cluster'},
    bootstrap:s=>{s.bootstrap='b'.repeat(32)},
    database:s=>{s.identity.clusterUID='replacement-cluster'},
    external:s=>{s.identity.phase='provisioning'},
    strategy:s=>{s.sts.spec.updateStrategy.type='RollingUpdate'},
    replicas:s=>{s.sts.spec.replicas=2},
    notReady:s=>{s.sts.status.readyReplicas=0},
    podOwner:s=>{s.pod.metadata.ownerReferences[0].uid='another-statefulset'},
    podReady:s=>{s.pod.status.conditions[0].status='False'},
    arguments:s=>{s.sts.spec.template.spec.containers[0].args=['-D','other']},
    image:s=>{s.sts.spec.template.spec.containers[0].image='postgres:17'},
    uid:s=>{s.pod.spec.securityContext.runAsUser=0},
    pgdata:s=>{s.pod.spec.containers[0].env[0].value='/other'},
    subpath:s=>{s.sts.spec.template.spec.containers[0].volumeMounts[0].subPath='old-data'},
    initialization:s=>{s.sts.spec.template.spec.initContainers=[{name:'unexpected',image:'busybox'}]},
    sidecar:s=>{s.pod.spec.containers.push({name:'sidecar',image:'busybox'})},
    volume:s=>{s.sts.spec.template.spec.volumes[1].secret.defaultMode=420},
    affinity:s=>{s.sts.spec.template.spec.affinity={nodeAffinity:{}}},
    owner:s=>{s.owner='0:0'},
    lock:s=>{s.lock.metadata.uid='other-lock'},
    storage:s=>{s.databaseError='Payment volume identity changed'},
  }
  for(const [label,change] of Object.entries(changes)) await t.test(label,t=>{
    const f=fixture(t); change(f.state)
    assert.throws(()=>apply(f.root,f.io)); assert.equal(f.state.patches.length,0)
    assert.deepEqual(fs.readdirSync(path.join(f.root,'.deploy')),['target.json'])
  })
})

test('local storage requires the original filesystem UUID and retained host receipt',async t=>{
  const f=fixture(t,{local:true}); assert.equal(plan(f.root,f.io).templateGuard,'known-legacy')
  await t.test('filesystem changed',t=>{const f=fixture(t,{local:true}); f.state.mount.uuid='another-disk'; assert.throws(()=>apply(f.root,f.io),/disk identity changed/); assert.equal(f.state.patches.length,0)})
  await t.test('host receipt missing',t=>{const f=fixture(t,{local:true}); f.state.receipt=null; assert.throws(()=>apply(f.root,f.io),/missing host receipt/); assert.equal(f.state.patches.length,0)})
})

test('admission default service account and eviction tolerations do not become false pending changes',t=>{
  const f=fixture(t)
  f.state.pod.spec.serviceAccountName='default'
  f.state.pod.spec.tolerations.push(...['node.kubernetes.io/not-ready','node.kubernetes.io/unreachable'].map(key=>({key,operator:'Exists',effect:'NoExecute',tolerationSeconds:300})))
  assert.equal(plan(f.root,f.io).templateGuard,'known-legacy')
})

test('resourceVersion conflict retains the backup and never retries or rolls back',t=>{
  const f=fixture(t), before=structuredClone(f.state.sts.spec); f.state.concurrentChange=true
  assert.throws(()=>apply(f.root,f.io),/Template update not confirmed/)
  assert.deepEqual(f.state.sts.spec,before); assert.equal(f.state.patches.length,1)
  assert.equal(fs.readdirSync(path.join(f.root,'.deploy')).length,2)
})

test('lost patch response is resolved only by a read; unknown outcomes retain evidence',async t=>{
  await t.test('patch succeeded but response was lost',t=>{const f=fixture(t); f.state.patchFailure='after'; const result=apply(f.root,f.io); assert.equal(result.patchResponseConfirmed,false); assert.equal(result.result,'template-updated'); assert.equal(f.state.patches.length,1)})
  await t.test('patch failed before applying',t=>{const f=fixture(t); f.state.patchFailure='before'; assert.throws(()=>apply(f.root,f.io),/Template update not confirmed/); assert.equal(f.state.patches.length,1)})
  await t.test('read after patch failed',t=>{const f=fixture(t); f.state.patchFailure='after'; f.state.stateReadFailure=true; assert.throws(()=>apply(f.root,f.io),/outcome unknown/); assert.equal(f.state.patches.length,1)})
  await t.test('Pod replaced concurrently',t=>{const f=fixture(t); f.state.replacePod=true; assert.throws(()=>apply(f.root,f.io),/original Pod changed independently/); assert.equal(f.state.patches.length,1)})
  await t.test('Pod read failed',t=>{const f=fixture(t); f.state.podReadFailure=true; assert.throws(()=>apply(f.root,f.io),/Template update verified, but current Pod recheck failed/); assert.equal(f.state.patches.length,1)})
})

function entryFixture(t,driver='k8s') {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'mx-pay-permissions-entry-'))
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  fs.mkdirSync(path.join(root,'scripts')); fs.mkdirSync(path.join(root,'bin'))
  for(const file of ['manage.sh','build-proxy.sh']) fs.copyFileSync(new URL(`../scripts/${file}`,import.meta.url),path.join(root,'scripts',file))
  const log=path.join(root,'calls.jsonl')
  const stub=`#!${process.execPath}
const fs=require('fs'),path=require('path'),a=process.argv.slice(2),tool=path.basename(process.argv[1]);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify({tool,args:a,lock:process.env.MX_PAY_PERMISSIONS_LOCK_UID||null})+'\\n');
if(tool==='node') {
 if(a[0].endsWith('/runtime.mjs') && a[1]==='target')process.stdout.write('test-cluster');
 else if(a[0].endsWith('/postgres-permissions.mjs')) { if(process.env.TEST_REPAIR_FAIL==='1')process.exit(1); process.stdout.write('{}'); }
 else process.exit(2);
} else if(tool==='kubectl') {
 if(a.includes('create'))process.stdout.write('lock-uid');
 else if(a.includes('--raw')) {const obj=JSON.parse(fs.readFileSync(a[a.indexOf('-f')+1])); if(obj.preconditions.uid!=='lock-uid')process.exit(2);}
 else process.exit(2);
} else if(tool==='docker' && a.join(' ')==='context show')process.stdout.write('test-context');
else process.exit(2);
`
  for(const file of ['node','kubectl','docker']) fs.writeFileSync(path.join(root,'bin',file),stub,{mode:0o755})
  return {root,run:(action,failRepair=false)=>spawnSync('bash',[path.join(root,'scripts/manage.sh'),action],{encoding:'utf8',timeout:10000,env:{...process.env,PATH:`${path.join(root,'bin')}:${process.env.PATH}`,TEST_LOG:log,TEST_REPAIR_FAIL:failRepair ? '1' : '0',MX_PAY_DEPLOY_DRIVER:driver,MX_PAY_BUILD_PROXY:'',MX_PAY_PERMISSIONS_LOCK_UID:''}}),calls:()=>fs.existsSync(log) ? fs.readFileSync(log,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : []}
}

test('Bash plan exits before locks, configuration preparation, build and migrations',t=>{
  const f=entryFixture(t), result=f.run('postgres-permissions-plan')
  assert.equal(result.status,0,result.stderr)
  assert.deepEqual(f.calls().map(c=>[c.tool,path.basename(c.args[0]),c.args[1]]),[['node','runtime.mjs','target'],['node','postgres-permissions.mjs','plan']])
  assert.equal(fs.existsSync(path.join(f.root,'.deploy')),false)
})

test('Bash apply holds and releases only the existing Pay lock without deployment phases',t=>{
  const f=entryFixture(t), result=f.run('postgres-permissions-apply')
  assert.equal(result.status,0,result.stderr)
  const calls=f.calls(),repair=calls.findIndex(c=>c.tool==='node' && c.args[0].endsWith('/postgres-permissions.mjs'))
  assert.equal(calls[repair].args[1],'apply'); assert.equal(calls[repair].lock,'lock-uid')
  assert.ok(calls.findIndex(c=>c.args.includes('create'))<repair)
  assert.ok(calls.findIndex(c=>c.args.includes('--raw'))>repair)
  assert.equal(calls.filter(c=>c.tool==='node').length,2)
  assert.equal(calls.some(c=>c.tool==='docker'),false)
})

test('Bash repair failure still releases only its lock and never falls into deployment',t=>{
  const f=entryFixture(t),result=f.run('postgres-permissions-apply',true)
  assert.notEqual(result.status,0)
  const calls=f.calls(),repair=calls.findIndex(c=>c.tool==='node' && c.args[0].endsWith('/postgres-permissions.mjs'))
  assert.equal(calls[repair].lock,'lock-uid')
  assert.ok(calls.findIndex(c=>c.args.includes('--raw'))>repair)
  assert.equal(calls.filter(c=>c.tool==='node').length,2)
  assert.equal(calls.some(c=>c.tool==='docker'),false)
})

test('Bash rejects both permission actions for Compose before any workload changes',t=>{
  for(const action of ['postgres-permissions-plan','postgres-permissions-apply']) {
    const f=entryFixture(t,'compose'),result=f.run(action)
    assert.notEqual(result.status,0); assert.match(result.stderr,/requires Kubernetes/)
    assert.deepEqual(f.calls().map(c=>[c.tool,...c.args]),[['docker','context','show']])
  }
})
