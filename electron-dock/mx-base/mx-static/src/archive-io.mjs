// This module runs only in a disposable archive child, NEVER in the HTTP process.
import { readFile, mkdir, open, rename, unlink, stat, statfs } from 'node:fs/promises'
import { createReadStream, createWriteStream, unlinkSync } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Transform } from 'node:stream'
import { filesystemAt } from './mounts.mjs'
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
async function copyVerified(source,target,meta) {
  await durableDirectory(dirname(target))
  const temp=target+'.'+randomUUID()+'.tmp'
  try {
    const hash=createHash('sha256'); let bytes=0
    await pipeline(createReadStream(source),new Transform({transform(chunk,_,cb){bytes+=chunk.length;hash.update(chunk);progress();cb(null,chunk)}}),createWriteStream(temp,{flags:'wx',mode:0o640}))
    if (bytes!==meta.size || hash.digest('hex')!==meta.sha256) throw Error('source_checksum_mismatch')
    const file=await open(temp,'r+');try{await file.sync()}finally{await file.close()}
    await verifyFile(temp,meta)
    await rename(temp,target)
    const dir=await open(dirname(target),'r');try{await dir.sync()}finally{await dir.close()}
  } finally { await unlink(temp).catch(()=>{}) }
}
export async function runArchiveIO({nasRoot,localRoot,stateDir,volumeId,requireNfs=true,job}) {
  if (requireNfs) {
    const type=filesystemAt(nasRoot,await readFile('/proc/self/mountinfo','utf8'))
    if (!['nfs','nfs4'].includes(type)) throw Error('nas_not_mounted')
  }
  if ((await readFile(join(nasRoot,'.mx-static-volume-id'),'utf8')).trim()!==volumeId) throw Error('nas_identity_mismatch')
  if (!job) return
  const {meta,key}=job
  if (!/^[a-z0-9][a-z0-9-]{0,63}\/\d{4}\/\d{2}\/\d{2}\/[a-f0-9-]{36}$/.test(key) || meta.key!==key) throw Error('invalid_archive_key')
  const local=join(localRoot,'objects',key),remote=join(nasRoot,'objects',key)
  if (job.action==='sync') {
    try { await verifyFile(remote,meta) } catch { await copyVerified(local,remote,meta) }
    // Keep metadata alongside the archive; no tenant credentials are copied.
    const body=Buffer.from(JSON.stringify(meta)), path=join(nasRoot,'metadata',key+'.json')
    await durableDirectory(dirname(path))
    const temp=path+'.'+randomUUID()+'.tmp'
    try { const fd=await open(temp,'wx',0o640);try{await fd.writeFile(body);await fd.sync()}finally{await fd.close()};await rename(temp,path);const dir=await open(dirname(path),'r');try{await dir.sync()}finally{await dir.close()} }
    finally { await unlink(temp).catch(()=>{}) }
  } else if(job.action==='restore') {
    const disk=await statfs(localRoot)
    if(disk.bavail*disk.bsize < 512*1024*1024+meta.size) throw Error('local_storage_full')
    await copyVerified(remote,local,meta)
  } else if(job.action==='evict') {
    await verifyFile(remote,meta) // Never evict on stale "mirrored" metadata alone.
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
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2]) {
  try { await runArchiveIO(JSON.parse(process.argv[2]));process.exit(0) }
  catch(error) { console.error(error.code || error.message);process.exit(1) }
}
