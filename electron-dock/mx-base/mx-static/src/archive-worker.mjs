import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { ArchiveCatalog } from './archive-catalog.mjs'

// One child maximum. A hard-NFS D-state child may not exit even after SIGKILL:
// do not start replacements and exhaust host tasks/file descriptors.
export class ArchiveWorker {
  constructor({stateDir,localRoot,nasRoot,volumeId,requireNfs=true,verify='always',concurrency=4,leaseMs=60000,renewEveryMs=20000,timeoutMs=15000,maxDurationMs=900000,probeIntervalMs=30000,spawnImpl=spawn}) {
    if(![timeoutMs,maxDurationMs,probeIntervalMs,leaseMs,renewEveryMs].every(n=>Number.isSafeInteger(n)&&n>0)) throw Error('Invalid archive deadlines')
    if(!Number.isInteger(concurrency)||concurrency<1||concurrency>64) throw Error('Invalid archive concurrency')
    if(!['always','sample','never'].includes(verify)) throw Error('Invalid archive verify mode')
    this.catalog=new ArchiveCatalog(stateDir)
    this.config={stateDir,localRoot,nasRoot,volumeId,requireNfs,verify}
    Object.assign(this,{concurrency,leaseMs,renewEveryMs,timeoutMs,maxDurationMs,probeIntervalMs,spawnImpl})
    this.child=null;this.stopped=false;this.closed=false;this.nextRun=0;this.health='starting';this.lastError=null
  }
  tick() {
    if(this.stopped) return
    if(!this.catalog.backend().enabled) {this.health='detached';this.catalog.heartbeat(this.health);return}
    this.catalog.heartbeat(this.health,this.lastError)
    if(this.child || Date.now()<this.nextRun) return
    const work=this.catalog.claimMany(this.concurrency)
    // Deletions ride in the same batch; they are the cheapest NFS operation
    // here and must not wait behind a queue of transfers.
    const jobs=[...work,...this.catalog.claimPurges(Math.max(0,this.concurrency-work.length))]
    const child=this.spawnImpl(process.execPath,[fileURLToPath(new URL('./archive-io.mjs',import.meta.url)),JSON.stringify({...this.config,jobs,concurrency:this.concurrency})],{stdio:['ignore','ignore','pipe','ipc']})
    this.child=child
    // Outcomes arrive per object; whatever is still in here when the child ends
    // has no evidence of success and goes back on the queue.
    const outstanding=new Map(jobs.map(job=>[job.key,job]))
    let error='',finished=false,renewedAt=Date.now()
    child.stderr?.on('data',chunk=>{error=(error+chunk).slice(0,200)})
    const finish=(ok,reason)=>{
      // The catalog can already be gone: stop() kills the child, and its exit
      // callback lands afterwards.
      if(finished||this.closed) return
      finished=true;clearTimeout(timer);clearTimeout(absoluteTimer)
      for(const job of outstanding.values()) {
        const why=ok?'archive_result_missing':(reason||'archive_incomplete')
        if(job.action==='purge') this.catalog.failPurge(job,why); else this.catalog.fail(job,why)
      }
      outstanding.clear()
      this.health=ok?'online':'backoff';this.lastError=ok?null:reason
      this.catalog.heartbeat(this.health,ok?null:reason)
      this.nextRun=Date.now()+(ok?(jobs.length?0:this.probeIntervalMs):Math.min(300000,Math.max(5000,this.probeIntervalMs)))
    }
    const expire=()=>{finish(false,'nas_io_timeout');this.health='stalled';this.catalog.heartbeat('stalled','nas_io_timeout');child.kill('SIGKILL')}
    let timer=setTimeout(expire,this.timeoutMs)
    const absoluteTimer=setTimeout(expire,this.maxDurationMs)
    const alive=()=>{
      if(finished||this.closed) return
      clearTimeout(timer);timer=setTimeout(expire,this.timeoutMs)
      if(Date.now()-renewedAt<this.renewEveryMs) return
      renewedAt=Date.now()
      for(const job of outstanding.values()) if(job.action!=='purge') this.catalog.renew(job,this.leaseMs)
    }
    child.on('message',message=>{
      if(finished) return
      if(message?.done) {
        const job=outstanding.get(message.done.key)
        if(job) {
          outstanding.delete(message.done.key)
          if(message.done.ok) {
            if(job.action==='purge') this.catalog.completePurge(job); else this.catalog.complete(job)
            // An archived object is proof the backend is reachable. Outcomes
            // now land before the child exits, so health must not wait for it:
            // eviction and other transitions require an online backend.
            if(this.health!=='online') {this.health='online';this.lastError=null;this.catalog.heartbeat('online')}
          }
          else if(job.action==='purge') this.catalog.failPurge(job,message.done.error||'archive_io_failed')
          else this.catalog.fail(job,message.done.error||'archive_io_failed')
        }
      }
      // A finished object proves liveness just as much as a transferred byte.
      if(message?.progress||message?.done) alive()
    })
    child.on('error',()=>{finish(false,'archive_child_failed');this.child=null;this.release()})
    child.on('exit',code=>{finish(code===0,error.trim()||'archive_io_failed');this.child=null;this.release()})
  }
  start() { this.timer=setInterval(()=>{try{this.tick()}catch{this.health='control_error'}},1000);this.tick();return this }
  release() { if(this.stopped && !this.child && !this.closed) { this.closed=true; this.catalog.close() } }
  async stop() {
    this.stopped=true;clearInterval(this.timer)
    const child=this.child
    if(child) {
      child.kill('SIGKILL')
      // Give the exit callback a chance to record outcomes before the catalog
      // goes away, but never block shutdown on a child the kernel will not
      // reap: a hard-NFS D state can outlive SIGKILL indefinitely.
      await Promise.race([once(child,'exit'),new Promise(resolve=>setTimeout(resolve,250).unref())]).catch(()=>{})
    }
    this.release()
  }
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const worker=new ArchiveWorker({stateDir:process.env.MX_STATIC_STATE_DIR||'/state',localRoot:'/data',nasRoot:'/nas',volumeId:process.env.MX_STATIC_NAS_VOLUME_ID,timeoutMs:Number(process.env.MX_STATIC_NAS_IDLE_TIMEOUT_MS||15000),maxDurationMs:Number(process.env.MX_STATIC_NAS_MAX_JOB_MS||900000),concurrency:Number(process.env.MX_STATIC_NAS_CONCURRENCY||4),verify:process.env.MX_STATIC_NAS_VERIFY||'always',requireNfs:process.env.MX_STATIC_NAS_REQUIRE_NFS!=='false'}).start()
  for(const signal of ['SIGTERM','SIGINT']) process.on(signal,()=>{worker.stop();setTimeout(()=>process.exit(0),100).unref()})
}
