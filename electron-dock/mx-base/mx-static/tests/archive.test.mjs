import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,mkdir,writeFile,readFile,rm,rename,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {once,EventEmitter} from 'node:events'
import {createStaticService} from '../src/service.mjs'
import {ArchiveWorker} from '../src/archive-worker.mjs'
import {ArchiveCatalog} from '../src/archive-catalog.mjs'
import {filesystemAt} from '../src/mounts.mjs'
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aH1kAAAAASUVORK5CYII=','base64')
const token='t'.repeat(32), headers={authorization:`Bearer ${token}`}
async function fixture(t) {
 const root=await mkdtemp(join(tmpdir(),'static-nas-')),local=join(root,'local'),state=join(root,'state'),nas=join(root,'nas')
 await mkdir(local);await mkdir(state);await mkdir(nas);await writeFile(join(nas,'.mx-static-volume-id'),'nas-01')
 const server=createStaticService({root:local,stateDir:state,projects:{test:{read:token,write:token}},signingKey:token,minFreeBytes:0,cacheOptions:{ttlMs:0}})
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const url=`http://127.0.0.1:${server.address().port}`,catalog=new ArchiveCatalog(state)
 t.after(async()=>{await server.shutdown();await new Promise(r=>{server.close(r);server.closeAllConnections()});catalog.close();await rm(root,{recursive:true,force:true})})
 const upload=()=>fetch(url+'/static/v1/projects/test/upload',{method:'POST',headers:{...headers,'content-type':'image/png'},body:png}).then(async r=>{assert.equal(r.status,201);return r.json()})
 return {root,local,state,nas,url,catalog,upload}
}
async function until(worker,predicate) {
 for(let i=0;i<200;i++) {worker.tick();if(predicate())return;await new Promise(r=>setTimeout(r,20))}
 throw Error('timed out waiting for archive transition')
}
test('offline NAS leaves local HTTP available; reconnect mirrors, evicts only verified bytes, and restores cold reads',async t=>{
 const f=await fixture(t),meta=await f.upload()
 assert.equal(f.catalog.get(meta.key).state,'queued')
 assert.equal(f.catalog.backend().health,'detached')
 const worker=new ArchiveWorker({stateDir:f.state,localRoot:f.local,nasRoot:f.nas,volumeId:'nas-01',requireNfs:false,probeIntervalMs:20})
 t.after(()=>worker.stop())
 f.catalog.setEnabled(true,'nas-01')
 await until(worker,()=>f.catalog.get(meta.key).mirrored===1 && !worker.child)
 assert.deepEqual(await readFile(join(f.nas,'objects',meta.key)),png)
 const evict=await fetch(f.url+'/static/v1/projects/test/storage/evict',{method:'POST',headers:{...headers,'content-type':'application/json'},body:JSON.stringify({key:meta.key})})
 assert.equal(evict.status,202)
 await until(worker,()=>f.catalog.get(meta.key).local===0 && !worker.child)
 await assert.rejects(stat(join(f.local,'objects',meta.key)),{code:'ENOENT'})
 await rename(f.nas,f.nas+'-offline')
 const cold=await fetch(f.url+'/static/files/'+meta.key,{headers})
 assert.equal(cold.status,503);assert.equal((await cold.json()).error.code,'media_restore_pending')
 // No NFS operation in HTTP: accepting another object and health still work.
 const next=await f.upload()
 assert.equal((await fetch(f.url+'/static/health')).status,200)
 assert.deepEqual(Buffer.from(await fetch(f.url+'/static/files/'+next.key,{headers}).then(r=>r.arrayBuffer())),png)
 await until(worker,()=>worker.health==='backoff' && !worker.child)
 assert.equal(f.catalog.get(meta.key).local,0)
 await rename(f.nas+'-offline',f.nas)
 f.catalog.setEnabled(false);f.catalog.setEnabled(true,'nas-01');worker.nextRun=0
 await until(worker,()=>f.catalog.get(meta.key).local===1 && f.catalog.get(meta.key).state==='ready' && !worker.child)
 assert.deepEqual(Buffer.from(await fetch(f.url+'/static/files/'+meta.key,{headers}).then(r=>r.arrayBuffer())),png)
 assert.throws(()=>f.catalog.setEnabled(true,'another-nas'))
})
test('corrupt NAS copy never permits local eviction; missing identity never writes into an empty mount directory',async t=>{
 const f=await fixture(t),meta=await f.upload()
 const worker=new ArchiveWorker({stateDir:f.state,localRoot:f.local,nasRoot:f.nas,volumeId:'nas-01',requireNfs:false,probeIntervalMs:20})
 t.after(()=>worker.stop());f.catalog.setEnabled(true,'nas-01')
 await until(worker,()=>f.catalog.get(meta.key).mirrored===1 && !worker.child)
 await writeFile(join(f.nas,'objects',meta.key),'corrupt')
 assert.equal(f.catalog.request(meta.key,'evict'),true)
 await until(worker,()=>Boolean(f.catalog.get(meta.key).error) && !worker.child)
 assert.deepEqual(await readFile(join(f.local,'objects',meta.key)),png)
 await rm(join(f.nas,'.mx-static-volume-id'))
 const next=await f.upload();worker.nextRun=0
 await until(worker,()=>Boolean(f.catalog.get(next.key).error) && !worker.child)
 await assert.rejects(stat(join(f.nas,'objects',next.key)),{code:'ENOENT'})
})
test('unkillable NFS child opens circuit, keeps one slot, and cannot hang core HTTP',async t=>{
 const f=await fixture(t);await f.upload()
 let spawns=0,kills=0
 const fake=new EventEmitter();fake.stderr=new EventEmitter();fake.kill=()=>{kills++;return true}
 const worker=new ArchiveWorker({stateDir:f.state,localRoot:f.local,nasRoot:f.nas,volumeId:'nas-01',timeoutMs:30,spawnImpl:()=>{spawns++;return fake}})
 t.after(async()=>{fake.emit('exit',1);await worker.stop()})
 f.catalog.setEnabled(true,'nas-01');worker.tick()
 await new Promise(r=>setTimeout(r,50))
 for(let i=0;i<20;i++)worker.tick()
 assert.equal(spawns,1);assert.equal(kills,1);assert.equal(f.catalog.backend().health,'stalled')
 assert.equal((await fetch(f.url+'/static/health',{signal:AbortSignal.timeout(500)})).status,200)
 await f.upload()
 f.catalog.setEnabled(false);worker.tick();assert.equal(f.catalog.backend().health,'detached')
})
test('mount selection is lexical/local and detects nested NFS without touching it',()=>{
 const mounts='1 0 0:1 / / rw - ext4 /dev/root rw\n2 1 0:2 / /data rw - nfs4 server:/share rw\n3 1 0:3 / /state rw - ext4 /dev/state rw'
 assert.equal(filesystemAt('/data/objects/a',mounts),'nfs4')
 assert.equal(filesystemAt('/state/archive.sqlite',mounts),'ext4')
 assert.equal(filesystemAt('/database',mounts),'ext4')
})
test('slow transfer progress refreshes idle deadline, but total task time remains bounded',async t=>{
 const f=await fixture(t);await f.upload()
 let kills=0
 const fake=new EventEmitter();fake.stderr=new EventEmitter();fake.kill=()=>{kills++;return true}
 const worker=new ArchiveWorker({stateDir:f.state,localRoot:f.local,nasRoot:f.nas,volumeId:'nas-01',timeoutMs:40,maxDurationMs:200,spawnImpl:()=>fake})
 t.after(async()=>{fake.emit('exit',1);await worker.stop()})
 f.catalog.setEnabled(true,'nas-01');worker.tick()
 const progress=setInterval(()=>fake.emit('message',{progress:true}),10)
 try {
   await new Promise(r=>setTimeout(r,100));assert.equal(kills,0)
   await new Promise(r=>setTimeout(r,150));assert.equal(kills,1)
 } finally {clearInterval(progress)}
})
