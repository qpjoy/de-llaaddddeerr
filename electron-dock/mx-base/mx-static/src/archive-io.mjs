// This module runs only in a disposable archive child, NEVER in the HTTP process.
import { readFile, link, mkdir, open, rename, unlink, stat, statfs } from 'node:fs/promises'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { filesystemAt } from './mounts.mjs'
import { isObjectKey } from './keys.mjs'
import { fileURLToPath } from 'node:url'
import { ArchiveCatalog } from './archive-catalog.mjs'

let lastProgress=0
function progress() {
  if(process.connected && Date.now()-lastProgress>500) {lastProgress=Date.now();process.send({progress:true},()=>{})}
}
export async function verifyFile(file, meta) {
  if ((await stat(file)).size !== meta.size) throw Error('archive_size_mismatch')
  const hash=createHash('sha256')
  for await (const chunk of createReadStream(file)) {hash.update(chunk);progress()}
  if (hash.digest('hex') !== meta.sha256) throw Error('archive_checksum_mismatch')
}
async function durableDirectory(path) {
  const first=await mkdir(path,{recursive:true,mode:0o750})
  if (first) for (let current=path;;current=dirname(current)) {
    const fd=await open(current,'r'); try { await fd.sync() } finally { await fd.close() }
    if (current===dirname(first)) break
  }
}
// The copy already hashes every byte on the way through, so the bytes we sent
// are verified either way. readback additionally re-reads what landed, which
// catches corruption on the far side -- and doubles the traffic to get it.
async function copyVerified(source,target,meta,{readback=true}={}) {
  await durableDirectory(dirname(target))
  const temp=target+'.'+randomUUID()+'.tmp'
  try {
    const hash=createHash('sha256'); let bytes=0
    await pipeline(createReadStream(source),new Transform({transform(chunk,_,cb){bytes+=chunk.length;hash.update(chunk);progress();cb(null,chunk)}}),createWriteStream(temp,{flags:'wx',mode:0o640}))
    if (bytes!==meta.size || hash.digest('hex')!==meta.sha256) throw Error('source_checksum_mismatch')
    const file=await open(temp,'r+');try{await file.sync()}finally{await file.close()}
    if (readback) await verifyFile(temp,meta)
    await rename(temp,target)
    const dir=await open(dirname(target),'r');try{await dir.sync()}finally{await dir.close()}
  } finally { await unlink(temp).catch(()=>{}) }
}
// 'sample' verifies a deterministic slice of objects rather than all of them,
// so a bulk migration keeps some far-side coverage without paying for it twice
// on every file. The choice is stable per object, not random per attempt.
const readbackFor=(verify,meta)=>verify==='always'||(verify==='sample'&&parseInt(meta.sha256.slice(0,2),16)<16)
async function alreadyMirrored(remote,meta,verify) {
  // Under 'always' the skip decision is itself a full verification; otherwise a
  // size check is enough to decide whether a re-copy is needed.
  try {
    if (verify==='always') { await verifyFile(remote,meta); return true }
    return (await stat(remote)).size===meta.size
  } catch { return false }
}
async function archiveOne({nasRoot,localRoot,stateDir,verify},job) {
  const {meta,key}=job
  if (!isObjectKey(key) || meta.key!==key) throw Error('invalid_archive_key')
  const local=join(localRoot,'objects',key),remote=join(nasRoot,'objects',key)
  if (job.action==='sync') {
    if (!await alreadyMirrored(remote,meta,verify)) {
      // Identical content already on the NAS becomes another link to the same
      // remote inode: no transfer, no second copy of the bytes.
      let linked=false
      if (job.twin) {
        const twin=join(nasRoot,'objects',job.twin)
        try {
          if ((await stat(twin)).size===meta.size) { await durableDirectory(dirname(remote));await link(twin,remote);await (async()=>{const d=await open(dirname(remote),'r');try{await d.sync()}finally{await d.close()}})();linked=true }
        } catch(error) { if(!['ENOENT','EXDEV','EPERM','EMLINK','ENOTSUP','EEXIST'].includes(error.code)) throw error }
      }
      if (!linked) await copyVerified(local,remote,meta,{readback:readbackFor(verify,meta)})
    }
    // Keep metadata alongside the archive; no tenant credentials are copied.
    const body=Buffer.from(JSON.stringify(meta)), path=join(nasRoot,'metadata',key+'.json')
    await durableDirectory(dirname(path))
    const temp=path+'.'+randomUUID()+'.tmp'
    try { const fd=await open(temp,'wx',0o640);try{await fd.writeFile(body);await fd.sync()}finally{await fd.close()};await rename(temp,path);const dir=await open(dirname(path),'r');try{await dir.sync()}finally{await dir.close()} }
    finally { await unlink(temp).catch(()=>{}) }
  } else if(job.action==='purge') {
    // Removes this key's own remote path only. Content shared with other keys
    // survives, because each of those keys still links to the same inode.
    const gone=error=>{ if(error.code!=='ENOENT') throw error }
    await unlink(remote).catch(gone)
    await unlink(join(nasRoot,'metadata',key+'.json')).catch(gone)
    progress()
  } else if(job.action==='restore') {
    const disk=await statfs(localRoot)
    if(disk.bavail*disk.bsize < 512*1024*1024+meta.size) throw Error('local_storage_full')
    await copyVerified(remote,local,meta) // Read-back is local disk here, not NFS.
  } else if(job.action==='evict') {
    // Never skipped, whatever the verify mode: this is the one place we delete
    // the only other copy, and it must not act on stale "mirrored" state.
    await verifyFile(remote,meta)
    const catalog=new ArchiveCatalog(stateDir)
    try {
      catalog.db.exec('BEGIN IMMEDIATE')
      const current=catalog.get(key)
      if(current?.owner!==job.owner || !catalog.backend().enabled) throw Error('archive_lease_lost')
      // Only local disk operations under this short transaction. Never NFS I/O.
      try { unlinkSync(local) } catch(error) { if(error.code!=='ENOENT') throw error }
      catalog.complete(job)
      catalog.db.exec('COMMIT')
    } catch(error) { catalog.db.exec('ROLLBACK');throw error } finally {catalog.close()}
  } else throw Error('invalid_archive_action')
}
function report(key,ok,error) {
  if (process.connected) process.send({done:{key,ok,error}},()=>{})
  else if (!ok) console.error(`${key}: ${error}`)
}
export async function runArchiveIO({nasRoot,localRoot,stateDir,volumeId,requireNfs=true,verify='always',concurrency=1,jobs=[],job=null}) {
  // Preflight once for the whole batch: a wrong mount or identity fails every
  // job in it, and must never write a byte into an unconfirmed directory.
  if (requireNfs) {
    const type=filesystemAt(nasRoot,await readFile('/proc/self/mountinfo','utf8'))
    if (!['nfs','nfs4'].includes(type)) throw Error('nas_not_mounted')
  }
  if ((await readFile(join(nasRoot,'.mx-static-volume-id'),'utf8')).trim()!==volumeId) throw Error('nas_identity_mismatch')
  const queue=(job?[job]:jobs).filter(Boolean)
  if (!queue.length) return
  const context={nasRoot,localRoot,stateDir,verify}
  // Identical content inside one batch crosses the wire once: the first job
  // for a hash writes the bytes, the rest link to the key it produced. Without
  // this, a batch claimed before anything was mirrored would copy every twin.
  const leaders=new Map(), leading=[], following=[]
  for (const item of queue) {
    const sha=item.action==='sync'?item.meta?.sha256:null
    if (!sha) { leading.push(item);continue }
    if (leaders.has(sha)) { following.push({item,sha});continue }
    leaders.set(sha,item.key);leading.push(item)
  }
  const done=new Set()
  // Small-file NFS writes are latency bound, not bandwidth bound: one job at a
  // time leaves the link almost idle. Per-job outcomes are reported as they
  // land, so one bad object never stalls or re-runs the rest of the batch.
  async function runAll(items) {
    if (!items.length) return
    const pending=items.slice()
    const lanes=Math.max(1,Math.min(concurrency,pending.length))
    await Promise.all(Array.from({length:lanes},async()=>{
      for(let next=pending.shift();next;next=pending.shift()) {
        try { await archiveOne(context,next);done.add(next.key);report(next.key,true) }
        catch(error) { report(next.key,false,String(error.code||error.message).slice(0,100)) }
      }
    }))
  }
  await runAll(leading)
  await runAll(following.map(({item,sha})=>{
    const leader=leaders.get(sha)
    return done.has(leader)?{...item,twin:item.twin||leader}:item
  }))
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  try { await runArchiveIO(JSON.parse(process.argv[2]));process.exit(0) }
  catch(error) { console.error(error.code || error.message);process.exit(1) }
}
